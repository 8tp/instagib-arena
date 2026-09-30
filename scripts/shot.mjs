#!/usr/bin/env node
// Headless screenshot harness for visual critique — dev tooling, no deps.
//
// Launches its own headless Chrome (own profile + debugging port, so several
// agents can capture in parallel without fighting over one browser), drives the
// page over the DevTools Protocol with Node's built-in WebSocket, and writes
// JPEGs. Solo vs Bots runs offline, so only a vite dev server is needed.
//
//   node scripts/shot.mjs --base http://localhost:5173 --out design/shots/r1 \
//     --solo reactor --shots "spawn;wide:1.57,-0.1,20,4.7,12;floor:0,-0.6"
//
// Flags
//   --base URL      dev server origin (default http://localhost:5173)
//   --path PATH     page to open (default /play?photo=1)
//   --out PREFIX    output path prefix; each shot → <PREFIX>-<name>.jpg
//   --solo MAP      click Solo vs Bots → pick MAP → Start match (photo mode)
//   --mode M        ffa | duel | tdm for --solo (default ffa)
//   --shots LIST    ';'-separated `name[:yaw,pitch[,x,y,z]]` (default "shot")
//   --wait MS       settle time after the match starts (default 5000)
//   --each MS       settle time between shots (default 900)
//   --eval JS       run JS in the page before the first shot
//   --size WxH      viewport (default 1600x900)
//   --keep-overlay  don't strip the click-to-play overlay
//   --no-hud        hide the React HUD layer (pure 3D frame)
//   --cookie N=V    set a cookie on the base origin before loading (e.g. a
//                   logged-in igsession from a curl cookie jar)
//
// Menu/front-end pages: pass --path /play (or /, /lockerlab…) and no --solo.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const base = flag('base', 'http://localhost:5173');
const path = flag('path', '/play?photo=1');
const out = flag('out', 'design/shots/shot');
const solo = flag('solo', null);
const mode = flag('mode', 'ffa');
const shotsArg = flag('shots', 'shot');
const settle = Number(flag('wait', 5000));
const each = Number(flag('each', 900));
const evalJs = flag('eval', null);
const [vw, vh] = String(flag('size', '1600x900')).split('x').map(Number);
const keepOverlay = flag('keep-overlay', false) === true;
const noHud = flag('no-hud', false) === true;
const cookie = flag('cookie', null);

const CHROME =
  process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = (value) => String(value).replace(/\x1b/g, '').replace(/\n|\r/g, '');

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
  const profile = mkdtempSync(join(tmpdir(), 'ig-shot-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${vw},${vh}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', cleanup);

  // Wait for the DevTools endpoint, then attach to the first page target.
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
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
  // Skip first-run onboarding and give the profile a name.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('instagib-onboarded','1');if(!localStorage.getItem('instagib-name'))localStorage.setItem('instagib-name','shot');}catch(e){}`,
  });
  if (cookie) {
    await send('Network.enable');
    const eq = String(cookie).indexOf('=');
    await send('Network.setCookie', { url: base, name: String(cookie).slice(0, eq), value: String(cookie).slice(eq + 1) });
  }
  await send('Page.navigate', { url: base + path });
  // Wait for the app to mount (a cold vite can take a while to serve the first
  // module graph) rather than a fixed sleep.
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const ready = await evaluate(`document.readyState === 'complete' && document.querySelectorAll('button,a,canvas').length > 0`).catch(() => false);
    if (ready) break;
  }
  await sleep(800);

  const clickByText = async (re) => {
    const ok = await evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(re)}, 'i');
      const el = [...document.querySelectorAll('button,a,[role=button]')].find((e) => re.test((e.textContent || '').trim()));
      if (!el) return false; el.click(); return true;
    })()`);
    if (!ok) throw new Error(`no clickable element matching /${re}/`);
  };

  if (solo) {
    await clickByText('^solo vs bots');
    await sleep(600);
    await evaluate(`(() => {
      const sel = document.querySelector('select');
      if (!sel) return false;
      const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(solo)});
      if (!opt) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (mode !== 'ffa') await clickByText(`^${mode === 'tdm' ? 'TDM' : 'Duel'}\\b`); // mode cards carry a blurb after the name
    await sleep(300);
    await clickByText('^start match');
    await sleep(settle);
    if (!keepOverlay) {
      await evaluate(`(() => {
        const h = [...document.querySelectorAll('h1,h2,div,p,span')].find((e) => e.childElementCount === 0 && /click to play/i.test(e.textContent || ''));
        let el = h, ov = null;
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          if ((cs.position === 'fixed' || cs.position === 'absolute') && (cs.backdropFilter !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)')) { ov = el; break; }
          el = el.parentElement;
        }
        if (ov) { ov.style.backdropFilter = 'none'; ov.style.background = 'transparent'; [...ov.children].forEach((c) => (c.style.visibility = 'hidden')); }
        return !!ov;
      })()`);
    }
    if (noHud) {
      await evaluate(`(() => { const c = document.querySelector('canvas'); if (!c) return; for (const el of c.parentElement.children) if (el !== c) el.style.visibility = 'hidden'; })()`);
    }
  } else {
    await sleep(Math.min(settle, 2500));
  }

  if (evalJs) await evaluate(String(evalJs));

  const shots = String(shotsArg).split(';').map((s) => s.trim()).filter(Boolean);
  mkdirSync(dirname(out), { recursive: true });
  for (const spec of shots) {
    const [name, view] = spec.split(':');
    if (view) {
      const n = view.split(',').map(Number);
      const pos = n.length >= 5 ? `{x:${n[2]},y:${n[3]},z:${n[4]}}` : 'undefined';
      await evaluate(`window.__ig && window.__ig.setPlayerView(${n[0]}, ${n[1]}, ${pos})`);
    }
    await sleep(each);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    const file = `${out}-${name}.jpg`;
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(logText(file));
  }
  const gl = await evaluate(`(() => { try { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : (c ? 'webgl2' : 'none'); } catch (e) { return String(e); } })()`);
  console.log(`[gl] ${logText(gl)}`);
  for (const line of consoleLines.slice(0, 20)) console.log(logText(line));
  ws.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
