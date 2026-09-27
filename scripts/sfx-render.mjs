#!/usr/bin/env node
// Offline SFX render + loudness table — dev tooling, no deps.
//
// Launches its own headless Chrome (own profile + debugging port), opens the
// vite dev server, imports src/game/sfx/preview.ts and renders every procedural
// sound through the real master chain in an OfflineAudioContext. Prints peak
// dBFS / RMS dBFS / duration per sound and writes WAVs so you can listen.
//
//   npx vite --port 5184 --strictPort &
//   node scripts/sfx-render.mjs --base http://localhost:5184 [--out design/sounds] [--only rail]
//
// Nothing may exceed -1 dBFS peak (the master limiter + safety clip).

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const base = flag('base', 'http://localhost:5173');
const outDir = flag('out', 'design/sounds');
const only = flag('only', null);
const noWav = flag('no-wav', false) === true;

const CHROME =
  process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function main() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'ig-sfx-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never came up');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`[error] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${base}/` });
  await sleep(2000);

  const mod = `import(${JSON.stringify(`${base}/src/game/sfx/preview.ts`)})`;
  let names = await evaluate(`${mod}.then((m) => m.listCases())`);
  if (only) names = names.filter((n) => n.toLowerCase().includes(String(only).toLowerCase()));
  if (!noWav) mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const name of names) {
    const r = await evaluate(`${mod}.then((m) => m.renderCase(${JSON.stringify(name)}, ${!noWav}))`);
    if (r.wav) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      writeFileSync(join(outDir, `${slug}.wav`), Buffer.from(r.wav, 'base64'));
    }
    rows.push(r);
  }

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  const detail = flag('detail', false) === true;
  // peak = sample peak; RMS = over the audible window (ambience: steady state);
  // LKm = loudest 100 ms K-weighted window (≈ momentary LUFS — compare these for balance).
  console.log(`${pad('sound', 34)}${lpad('peak', 7)}${lpad('RMS', 7)}${lpad('LKm', 7)}${lpad('dur s', 7)}${lpad('vox', 5)}   bands% <150/600/2.5k/8k/>8k`);
  console.log('-'.repeat(100));
  let clipped = 0;
  for (const r of rows) {
    const flagClip = r.peakDb > -1 ? '  << CLIP' : '';
    if (r.peakDb > -1) clipped++;
    console.log(`${pad(r.name, 34)}${lpad(r.peakDb.toFixed(1), 7)}${lpad(r.rmsDb.toFixed(1), 7)}${lpad(r.shortDb.toFixed(1), 7)}${lpad(r.dur.toFixed(2), 7)}${lpad(r.peakVoices, 5)}   ${r.bands.map((b) => lpad(b, 3)).join(' ')}${flagClip}`);
    if (detail) console.log(`${pad('', 34)}env/100ms: ${r.env.map((d) => d.toFixed(0)).join(' ')}`);
  }
  console.log('-'.repeat(100));
  console.log(clipped ? `${clipped} sound(s) above -1 dBFS` : 'no sound above -1 dBFS');
  if (!noWav) console.log(`WAVs → ${outDir}/`);
  if (problems.length) console.log(problems.slice(0, 20).join('\n'));
  ws.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
