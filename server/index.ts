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
import { attachInstagibWs } from './instagib-game';

const INSTAGIB_WS_PATH = '/ws/instagib';

const dev = process.env.NODE_ENV !== 'production';
const host = process.env.HOST || (dev ? 'localhost' : '0.0.0.0');
const port = parseInt(process.env.PORT || '8787', 10);

const distDir = path.join(process.cwd(), 'dist');
const indexHtml = path.join(distDir, 'index.html');
const hasBuild = fs.existsSync(indexHtml);

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
    if (dev && ['localhost', '127.0.0.1'].includes(originUrl.hostname)) {
      return true;
    }
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
app.use(cookieParser());
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, build: hasBuild });
});
app.use('/api', statsRouter);
app.use('/api', leaderboardRouter);

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

const server = http.createServer(app);

// Game socket runs on the same HTTP server so it shares the port (and any TLS
// terminator / tunnel in front of it).
const instagibWss = new WebSocketServer({ noServer: true });
attachInstagibWs(instagibWss);

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
  instagibWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    instagibWss.emit('connection', ws, req);
  });
});

server.listen(port, host, () => {
  console.log(`> Instagib Arena server ready on http://${host}:${port}`);
  console.log(`>   game socket:  ws://${host}:${port}${INSTAGIB_WS_PATH}`);
  console.log(`>   stats api:    http://${host}:${port}/api/stats`);
  if (!hasBuild && dev) {
    console.log('>   dev mode: run `npm run dev:web` (Vite) for the client.');
  }
});
