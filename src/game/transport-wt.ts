// Client side of the WebTransport datagram channel — UDP plan Phase 2.
// THREE-free; see docs/NETCODE-UDP-PLAN.md and server/transport-wt.ts for the
// protocol. The channel carries only the two hot, loss-tolerant message types
// (pos up, state down) as QUIC datagrams — no TCP head-of-line blocking. It is
// strictly additive: NetClient keeps the WebSocket as the reliable channel and
// uses this one only while `active`; any failure (blocked UDP:443, lost
// session, starvation) just reverts traffic to the WS.
//
// Handshake: connect → repeat AUTH (clientId + resumeToken from the WS
// `welcome`) until the server acks with AUTH_OK and starts sending state
// frames here. Both legs are datagrams and may be lost, so AUTH is resent on
// a timer and ANY server datagram counts as proof of binding.
import { BIN_WT_AUTH_OK, encodeWtAuth } from './netcodec';

// UDP:443 is filtered on enough networks that a short timeout + WS fallback
// beats waiting: if the channel can't open quickly, it likely never will.
const CONNECT_TIMEOUT_MS = 1500;
const AUTH_RESEND_MS = 250;
const AUTH_MAX_TRIES = 40; // ≈10s of resends before giving up on the session
// Mirror of the server's drop-don't-queue policy for datagram writes.
const MAX_PENDING_WRITES = 64;

// Structural types so this compiles regardless of the TS dom-lib version;
// matches both the browser API and @fails-components/webtransport (Node).
type WtWritable = { getWriter(): { write(b: Uint8Array): Promise<void> } };
type WtSession = {
  ready: Promise<unknown>;
  closed: Promise<unknown>;
  close(): void;
  datagrams: {
    readable: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } };
    // The spec replaced `writable` with `createWritable()`; support both so we
    // work on current browsers (createWritable) and older ones (writable).
    writable?: WtWritable;
    createWritable?(): WtWritable;
  };
};
export type WtCtor = new (
  url: string,
  opts?: { serverCertificateHashes?: { algorithm: string; value: Uint8Array }[] },
) => WtSession;

const globalWtCtor = (): WtCtor | null =>
  (globalThis as { WebTransport?: WtCtor }).WebTransport ?? null;

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class WtChannel {
  // True once the server has acked our slot claim — NetClient routes the hot
  // path here while this holds. Flips false forever when the session dies.
  active = false;
  // performance.now() of the last datagram from the server. NetClient's
  // starvation watchdog closes the channel if this goes stale while in-match
  // (a silently blackholed UDP path never fires `closed` on its own).
  lastFrameMs = 0;
  private session: WtSession | null = null;
  private writer: { write(b: Uint8Array): Promise<void> } | null = null;
  private pending = 0;
  private closedByUs = false;

  constructor(
    private events: { onFrame(data: Uint8Array): void; onDead(): void },
    // Injectable for tests/probes; browsers use the global constructor.
    private ctor: WtCtor | null = globalWtCtor(),
  ) {}

  static available(): boolean {
    return globalWtCtor() !== null;
  }

  // Resolves true once ACTIVE (bound + acked), false on any failure. Never
  // throws. Failure leaves the channel inert — the caller stays on the WS.
  async connect(url: string, certHashBase64: string | null, clientId: string, token: string): Promise<boolean> {
    if (!this.ctor) return false;
    try {
      const session = new this.ctor(
        url,
        certHashBase64
          ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: base64ToBytes(certHashBase64) }] }
          : undefined,
      );
      this.session = session;
      session.closed
        .catch(() => undefined)
        .then(() => this.die());
      const opened = await Promise.race([
        session.ready.then(() => true).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS)),
      ]);
      if (!opened || this.closedByUs) {
        this.close();
        return false;
      }
      const writable = session.datagrams.createWritable?.() ?? session.datagrams.writable;
      if (!writable) {
        this.close();
        return false;
      }
      this.writer = writable.getWriter();
      this.readLoop(session);

      // Repeat AUTH until the server proves the binding (AUTH_OK or any other
      // datagram — only a bound session is ever sent anything).
      const auth = encodeWtAuth(clientId, token);
      for (let i = 0; i < AUTH_MAX_TRIES && !this.active && !this.closedByUs; i++) {
        this.rawSend(auth);
        await new Promise((resolve) => setTimeout(resolve, AUTH_RESEND_MS));
      }
      if (!this.active) this.close();
      return this.active;
    } catch {
      this.close();
      return false;
    }
  }

  send(bytes: Uint8Array): void {
    if (!this.active) return;
    this.rawSend(bytes);
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.session?.close();
    } catch {
      // ignore
    }
    this.die();
  }

  private rawSend(bytes: Uint8Array): void {
    if (!this.writer || this.pending >= MAX_PENDING_WRITES) return; // drop, never queue latency
    this.pending += 1;
    this.writer.write(bytes).then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
  }

  private async readLoop(session: WtSession): Promise<void> {
    try {
      const reader = session.datagrams.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        this.lastFrameMs = performance.now();
        if (value[0] === BIN_WT_AUTH_OK) {
          this.active = true;
          continue;
        }
        this.active = true; // any server datagram implies the binding succeeded
        this.events.onFrame(value);
      }
    } catch {
      // fall through to die() via session.closed
    }
  }

  private dead = false;

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.session = null;
    this.writer = null;
    this.active = false;
    this.events.onDead();
  }
}
