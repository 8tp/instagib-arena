import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

const production = process.env.NODE_ENV === 'production';
const hops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.RAILWAY_PROJECT_ID ? '1' : '0'));
if (!Number.isInteger(hops) || hops < 0 || hops > 8) throw new Error('Invalid TRUST_PROXY_HOPS');
export const trustedProxyHops = hops;

const normalizeIp = (ip: string): string => ip.trim().replace(/^::ffff:/, '');

const header = process.env.TRUST_PROXY_HEADER ?? (process.env.RAILWAY_PROJECT_ID ? 'x-real-ip' : 'x-forwarded-for');
if (!['x-real-ip', 'x-forwarded-for'].includes(header)) throw new Error('Invalid TRUST_PROXY_HEADER');
if (header === 'x-real-ip' && hops > 1) throw new Error('X-Real-IP requires exactly one trusted ingress');
export const trustedProxyHeader = header;

// Railway overwrites X-Real-IP on both its public URL and Cloudflare custom
// domain (verified on production 2026-09-29). Its XFF chain contains extra edge
// addresses. Other proxies use an explicitly configured right-to-left XFF chain.
// Never accept CF-Connecting-IP from a publicly reachable origin.
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, proxyHops = trustedProxyHops, proxyHeader = trustedProxyHeader): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  const fallback = isIP(remote) ? remote : 'unknown';
  if (!proxyHops) return fallback;
  const forwarded = req.headers[proxyHeader];
  if (typeof forwarded !== 'string') return fallback;
  const ip = proxyHeader === 'x-real-ip' ? normalizeIp(forwarded) :
    forwarded.split(',').map(normalizeIp).at(-proxyHops);
  return ip && isIP(ip) ? ip : fallback;
}

function privateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]' || host.endsWith('.local')) return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const configuredOrigin = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : '';
if (configuredOrigin && !/^https?:\/\//.test(configuredOrigin)) throw new Error('Invalid APP_BASE_URL');

export function allowedOrigin(origin: string | undefined, host: string, websocket = false): boolean {
  if (!origin) return !websocket || !production;
  try {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || origin !== url.origin) return false;
    if (configuredOrigin) return url.origin === configuredOrigin;
    if (!production && privateHost(url.hostname)) return true;
    return url.origin === `${production ? 'https' : 'http'}://${host}`;
  } catch {
    return false;
  }
}

// Fixed windows with a hard key budget; expired keys are evicted lazily.
export class RateLimiter {
  private hits = new Map<string, { until: number; n: number }>();
  constructor(private max: number, private windowMs: number, private maxKeys = 10_000) {}
  allow(key: string, now = Date.now()): boolean {
    const hit = this.hits.get(key);
    if (hit && now < hit.until) return ++hit.n <= this.max;
    if (!hit && this.hits.size >= this.maxKeys) {
      for (const [k, h] of this.hits) if (now >= h.until) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys) return false;
    }
    this.hits.set(key, { until: now + this.windowMs, n: 1 });
    return true;
  }
}

const apiHits = new RateLimiter(120, 10_000);
export const protectApi: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/health') return next();
  if (!apiHits.allow(clientIp(req))) {
    res.setHeader('Retry-After', '10');
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.get('sec-fetch-site') === 'cross-site' || !allowedOrigin(req.get('origin'), req.get('host') ?? ''))) {
    res.status(403).json({ error: 'origin_forbidden' });
    return;
  }
  next();
};
