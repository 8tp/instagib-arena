// WebTransport (HTTP/3 / QUIC) datagram endpoint — UDP plan Phase 2.
// See docs/NETCODE-UDP-PLAN.md. This is the unreliable channel that carries the
// two hot message types (pos up, state down) WITHOUT TCP head-of-line blocking;
// everything else stays on the WebSocket, which remains the source of identity:
// a datagram session is inert until it presents a live WS slot's clientId +
// resumeToken (BIN_WT_AUTH), at which point it's bound via the game's wt API.
//
// Off by default. Enabled by WT_PORT (UDP). Railway has no UDP ingress, so in
// production this listener runs on a UDP-capable host (Fly.io / VPS) while the
// web app + WS stay where they are — the client dials PUBLIC_WT_URL. Local dev
// works out of the box: with no cert provided we mint a self-signed ECDSA P-256
// cert (≤14-day validity, required for serverCertificateHashes) and expose its
// hash through /api/wt-info for the browser/probe to pin.
//
// The native QUIC stack (@fails-components/webtransport, an optionalDependency)
// is imported dynamically: a host without a prebuilt binary still boots fine as
// long as WT_PORT is unset, and a failed import just disables the endpoint.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import { BIN_WT_AUTH, decodeWtAuth, encodeWtAuthOk, toView } from '../src/game/netcodec';

export type WtGameHooks = {
  bind(
    clientId: string,
    token: string,
    send: (buf: Uint8Array) => void,
    close: () => void,
  ): ((bytes: Uint8Array) => void) | null;
  unbind(clientId: string, send: (buf: Uint8Array) => void): void;
};

export type WtEndpoint = {
  port: number;
  // base64 sha-256 of the cert's DER — clients pin it via serverCertificateHashes.
  // null when running on a CA-issued cert (browsers verify it normally).
  certHashBase64: string | null;
  stop(): void;
};

// Drop-don't-queue policy for the downlink: QUIC datagrams don't retransmit,
// but the local writer can still buffer if the path stalls. Past this many
// unresolved writes we drop new frames instead of queueing latency.
const MAX_PENDING_WRITES = 64;
// A session that hasn't authenticated within this window is closed.
const AUTH_TIMEOUT_MS = 10_000;

export async function startWtEndpoint(opts: {
  port: number;
  host?: string;
  certPem?: string; // CA-issued cert/key for prod; omit both to self-sign (dev)
  keyPem?: string;
  game: WtGameHooks;
}): Promise<WtEndpoint | null> {
  let Http3Server: typeof import('@fails-components/webtransport').Http3Server;
  try {
    ({ Http3Server } = await import('@fails-components/webtransport'));
  } catch (err) {
    console.warn('[wt] @fails-components/webtransport unavailable — endpoint disabled:', String(err).split('\n')[0]);
    return null;
  }

  let cert: string;
  let privKey: string;
  let certHashBase64: string | null = null;
  if (opts.certPem && opts.keyPem) {
    cert = opts.certPem;
    privKey = opts.keyPem;
  } else {
    // Self-signed ECDSA P-256, ≤14-day validity (the serverCertificateHashes
    // rules). Dev/probe convenience only — prod should mount a real cert.
    const keyPath = join(tmpdir(), `instagib-wt-key-${opts.port}.pem`);
    const certPath = join(tmpdir(), `instagib-wt-cert-${opts.port}.pem`);
    execSync(
      'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes ' +
        `-keyout ${keyPath} -out ${certPath} -days 7 -subj "/CN=localhost"`,
      { stdio: 'ignore' },
    );
    cert = readFileSync(certPath, 'utf8');
    privKey = readFileSync(keyPath, 'utf8');
  }
  // Hash is served to clients even for CA certs only when self-signed.
  if (!opts.certPem) {
    const der = new X509Certificate(cert).raw;
    certHashBase64 = createHash('sha256').update(der).digest('base64');
  }

  const host = opts.host ?? '0.0.0.0';
  const server = new Http3Server({ port: opts.port, host, secret: 'instagib-wt', cert, privKey });
  server.startServer();

  let stopped = false;

  // Accept sessions forever; each session runs its own handshake + pump.
  (async () => {
    const sessions = server.sessionStream('/wt');
    const reader = sessions.getReader();
    for (;;) {
      const { value: session, done } = await reader.read();
      if (done || stopped) break;
      handleSession(session, opts.game).catch(() => {
        /* per-session errors are contained */
      });
    }
  })().catch((e) => {
    if (!stopped) console.warn('[wt] session accept loop ended:', String(e).split('\n')[0]);
  });

  console.log(`[wt] WebTransport datagram endpoint listening on udp:${host}:${opts.port} (path /wt)`);
  return {
    port: opts.port,
    certHashBase64,
    stop() {
      stopped = true;
      try {
        server.stopServer();
      } catch {
        // ignore
      }
    },
  };
}

type WtSession = {
  ready: Promise<void>;
  closed: Promise<unknown>;
  close(info?: { closeCode?: number; reason?: string }): void;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    // The spec replaced `writable` with `createWritable()`; the lib supports
    // both but warns on the old one. Prefer the current API, keep the fallback.
    writable: WritableStream<Uint8Array>;
    createWritable?(): WritableStream<Uint8Array>;
  };
};

async function handleSession(session: WtSession, game: WtGameHooks): Promise<void> {
  await session.ready;
  const writer = (session.datagrams.createWritable?.() ?? session.datagrams.writable).getWriter();
  const reader = session.datagrams.readable.getReader();

  let pending = 0;
  const send = (buf: Uint8Array): void => {
    if (pending >= MAX_PENDING_WRITES) return; // drop, never queue latency
    pending += 1;
    writer.write(buf).then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
  };

  let boundId: string | null = null;
  let ingest: ((bytes: Uint8Array) => void) | null = null;

  // An unauthenticated session is a held UDP socket + nothing else; reap it.
  const authTimer = setTimeout(() => {
    if (!ingest) session.close({ closeCode: 0, reason: 'auth timeout' });
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  // Whatever way the session ends, detach it from the slot so the transport
  // seam falls back to the WS for this client.
  session.closed
    .catch(() => undefined)
    .then(() => {
      clearTimeout(authTimer);
      if (boundId) game.unbind(boundId, send);
    });

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (ingest) {
      // AUTH_OK was a datagram too — it can be lost. A bound client re-sending
      // AUTH just needs the ack again; don't feed handshake frames to the game.
      if (value[0] === BIN_WT_AUTH) {
        send(encodeWtAuthOk());
        continue;
      }
      ingest(value);
      continue;
    }
    // Handshake: the only thing an unbound session can say is AUTH. The claim
    // is the client's own clientId + resumeToken from its WS `welcome` —
    // proof it owns a live slot. Datagrams can be lost, so the client repeats
    // AUTH until it sees AUTH_OK; re-auth of an already-bound id just rebinds.
    const auth = decodeWtAuth(toView(value));
    if (!auth) continue; // not AUTH and not bound → ignore
    const bound = game.bind(auth.clientId, auth.token, send, () =>
      session.close({ closeCode: 0, reason: 'slot gone' }),
    );
    if (!bound) continue; // bad claim; client keeps retrying or times out
    boundId = auth.clientId;
    ingest = bound;
    clearTimeout(authTimer);
    send(encodeWtAuthOk());
  }
}
