// Instagib Arena — standalone server.
//
// One Node process hosts everything on a single port:
//   • the built web client (dist/, in production)
//   • the stats API           ->  /api/stats
//   • the authoritative game   ->  /ws/instagib  (WebSocket)
//
// In development this process only serves /api and /ws/instagib; the Vite dev
// server hosts the client and proxies those paths here (see vite.config.ts), so
// the browser always talks to a single origin — same as production.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer, type WebSocket } from 'ws';
import { statsRouter } from './stats';
import { leaderboardRouter } from './leaderboard';
import { rankedRouter } from './ranked';
import { challengeRouter } from './challenge';
import { authRouter, adminUsernamesFromEnv } from './auth';
import { adminApiTokenEnabled, adminRouter, setLiveCountsSource } from './admin';
import { syncAdminsFromEnv } from './db';
import { attachInstagibWs } from './instagib-game';

const INSTAGIB_WS_PATH = '/ws/instagib';

// Process-level safety net: a single uncaught throw (a `ws` internal error, a
// timer callback, an unexpected exception) must NOT take the whole server — and
// every connected player — down. Log and keep serving; the alpha favors uptime.
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection', reason));

const dev = process.env.NODE_ENV !== 'production';
const host = process.env.HOST || (dev ? 'localhost' : '0.0.0.0');
const port = parseInt(process.env.PORT || '8787', 10);

const distDir = path.join(process.cwd(), 'dist');
const indexHtml = path.join(distDir, 'index.html');
const hasBuild = fs.existsSync(indexHtml);

// A private / loopback / mDNS hostname — i.e. something only reachable from the
// same machine or LAN. In dev we trust these so `npm run dev:lan` works when a
// phone or second laptop loads the app from this machine's WiFi IP (the origin
// is then http://192.168.x.x:5173, which the localhost-only check would reject).
const isPrivateHost = (hostname: string): boolean => {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  if (hostname === '::1' || hostname.startsWith('127.')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 link-local
  );
};

// Only browsers that loaded the app from an allowed origin may open the socket.
const isAllowedWsOrigin = (
  origin: string | undefined,
  hostHeader: string,
): boolean => {
  if (!origin) return dev; // non-browser clients (curl, load tests) only in dev
  try {
    const originUrl = new URL(origin);
    const base = process.env.APP_BASE_URL;
    if (base && originUrl.origin === new URL(base).origin) return true;
    // In dev, trust loopback AND private-LAN origins so LAN testing works
    // regardless of how the dev proxy rewrites the Host header.
    if (dev && isPrivateHost(originUrl.hostname)) return true;
    // Fallback: same-origin (handles dynamic domains / no APP_BASE_URL set).
    return originUrl.host === hostHeader;
  } catch {
    return false;
  }
};

const app = express();
app.disable('x-powered-by');
// Behind the Cloudflare tunnel / reverse proxy: trust the first proxy hop so
// `req.ip` is the real client IP (used as the rate-limit fallback for
// cookie-less callers), not the proxy's socket address.
app.set('trust proxy', 1);

// Security headers on every response. The app is a single same-origin bundle —
// Vite-built JS/CSS under /assets, game assets (.glb/.ogg) and the /ws/instagib
// socket are all same-origin — so a tight CSP costs nothing: scripts and
// connections (incl. the same-origin WebSocket) are 'self'; styles allow inline
// (React style props + the Play-of-the-Match <style> tag) and Google Fonts;
// images allow data:/blob: for three.js canvas textures. frame-ancestors 'none'
// + X-Frame-Options block clickjacking. HSTS is prod-only (TLS lives at the
// platform edge); sending it in local http dev would poison the browser.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // blob:/data: are needed by three.js: GLTFLoader decodes GLB-embedded textures
  // (e.g. the character model) by creating a blob: URL and fetch()-ing it, which
  // connect-src governs — without blob: those textures silently fail to load.
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "form-action 'self'",
].join('; ');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  );
  if (!dev) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, build: hasBuild });
});
// Live concurrency for the lobby/landing "N playing now" readout (set after the
// game WS is attached below).
let liveCounts: () => { online: number; inMatch: number; rooms: number } = () => ({
  online: 0,
  inMatch: 0,
  rooms: 0,
});
app.get('/api/live', (_req, res) => res.json(liveCounts()));
app.use('/api', authRouter);
app.use('/api', statsRouter);
app.use('/api', leaderboardRouter);
app.use('/api', rankedRouter);
app.use('/api', challengeRouter);
app.use('/api/admin', adminRouter);

// Promote any configured ADMIN_USERNAMES that already have accounts (idempotent;
// new accounts are promoted at registration). Set ADMIN_USERNAMES on Railway and
// redeploy to claim your account.
{
  const admins = adminUsernamesFromEnv();
  const n = syncAdminsFromEnv(admins);
  if (admins.length) console.log(`[admin] ADMIN_USERNAMES=[${admins.join(', ')}] — ${n} synced`);
}

if (hasBuild) {
  // Long-cache fingerprinted assets; never cache the HTML shell.
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA fallback: every non-API GET serves index.html so client routes
  // (e.g. /play) deep-link and reload correctly.
  app.get(/.*/, (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
} else if (!dev) {
  console.warn(
    '[server] No dist/ build found. Run `npm run build` before `npm start`.',
  );
}

// Terminal error handler — a malformed/oversized JSON body (express.json throws)
// returns a clean 4xx instead of Express's default 500 + stack-trace leak.
app.use((err: Error & { type?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err?.status === 400) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  console.error('[http] unhandled route error', err);
  res.status(500).json({ error: 'server_error' });
});

const server = http.createServer(app);
server.on('error', (err) => console.error('[server] error', err));

// Game socket runs on the same HTTP server so it shares the port (and any TLS
// terminator / tunnel in front of it). `maxPayload` caps a single inbound frame
// (legit game messages are a few hundred bytes) so a modified client can't OOM
// the process with one giant frame; perMessageDeflate off avoids decompression
// amplification.
const instagibWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});
({ liveCounts } = attachInstagibWs(instagibWss));
// Let the token-gated metrics API report live concurrency too (one-call /report).
setLiveCountsSource(liveCounts);
instagibWss.on('error', (err) => console.error('[ws] server error', err));

// Connection caps so a flood can't exhaust slots/memory on a public alpha.
const MAX_WS_TOTAL = 600;
const MAX_WS_PER_IP = 12;
let wsTotal = 0;
const wsPerIp = new Map<string, number>();
function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const fwd = Array.isArray(xff) ? xff[0] : xff;
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim() || 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  const pathname = url ? url.split('?')[0] : '';
  if (pathname !== INSTAGIB_WS_PATH) {
    socket.destroy();
    return;
  }
  if (!isAllowedWsOrigin(req.headers.origin, req.headers.host || '')) {
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  if (wsTotal >= MAX_WS_TOTAL || (wsPerIp.get(ip) ?? 0) >= MAX_WS_PER_IP) {
    socket.destroy(); // over capacity — drop before allocating a game slot
    return;
  }
  // Disable Nagle's algorithm on the game socket. Our hot path is many small
  // frames (64Hz position upload + 64Hz snapshots, ~100 bytes each); with Nagle
  // on, the kernel can hold a small write waiting to coalesce it with the next
  // one (interacting badly with delayed-ACK), adding up to ~40ms of latency and
  // jitter to every update. A realtime game wants frames out immediately. (The
  // upgrade event types the stream as a bare Duplex; the runtime object is a
  // net/TLS Socket that has setNoDelay — guard so it's a no-op if it ever isn't.)
  (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
  instagibWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wsTotal++;
    wsPerIp.set(ip, (wsPerIp.get(ip) ?? 0) + 1);
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    ws.on('error', (err) => console.error('[ws] socket error', err));
    ws.on('close', () => {
      wsTotal = Math.max(0, wsTotal - 1);
      const n = (wsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) wsPerIp.delete(ip);
      else wsPerIp.set(ip, n);
    });
    instagibWss.emit('connection', ws, req);
  });
});

// Heartbeat: terminate sockets that stop answering pings (half-open TCP, yanked
// network) so dead peers don't hold game slots until the app-level stale sweep.
const wsHeartbeat = setInterval(() => {
  for (const ws of instagibWss.clients) {
    const w = ws as WebSocket & { isAlive?: boolean };
    if (w.isAlive === false) {
      ws.terminate();
      continue;
    }
    w.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already closing */
    }
  }
}, 15_000);
wsHeartbeat.unref();

server.listen(port, host, () => {
  console.log(`> Instagib Arena server ready on http://${host}:${port}`);
  console.log(`>   game socket:  ws://${host}:${port}${INSTAGIB_WS_PATH}`);
  console.log(`>   stats api:    http://${host}:${port}/api/stats`);
  console.log(
    `>   metrics api:  http://${host}:${port}/api/admin/metrics/report ` +
      `(token auth ${adminApiTokenEnabled ? 'ENABLED' : 'disabled — set ADMIN_API_TOKEN'})`,
  );
  if (!hasBuild && dev) {
    console.log('>   dev mode: run `npm run dev:web` (Vite) for the client.');
  }
});
