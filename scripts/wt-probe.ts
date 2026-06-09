// E2E probe for the WebTransport datagram channel (UDP plan Phase 2).
//
// Drives the REAL client channel (src/game/transport-wt.ts WtChannel, with the
// Node lib's WebTransport injected) against a real server, and verifies the
// full contract:
//   1. WS join → welcome (clientId + resumeToken) → /api/wt-info discovery
//   2. AUTH over datagrams → AUTH_OK → channel ACTIVE
//   3. state frames arrive as datagrams at ~64Hz — and STOP arriving on the WS
//   4. pos sent as datagrams moves the player (uplink → handlePos works)
//   5. closing the channel falls the downlink back to the WS within ~2s
//
// Start the server first:
//   PORT=8799 WT_PORT=8443 DATA_DIR=/tmp/instagib-wt-probe npx tsx server/index.ts
// then:
//   npx tsx scripts/wt-probe.ts
import { WebSocket } from 'ws';
import { WebTransport as NodeWebTransport } from '@fails-components/webtransport';
import { decodeState, encodePos, toView } from '../src/game/netcodec';
import { WtChannel, type WtCtor } from '../src/game/transport-wt';

const HTTP_BASE = process.env.PROBE_HTTP ?? 'http://localhost:8799';
const WS_URL = process.env.PROBE_WS ?? 'ws://localhost:8799/ws/instagib';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  console.error(`\nPROBE FAILED: ${msg}`);
  process.exit(1);
};

let wsBinaryFrames = 0; // state frames seen on the WS (the OLD pipe)
let wtFrames = 0; // state frames seen on the WT channel (the NEW pipe)
let lastWtState: ReturnType<typeof decodeState> = null;

const main = async () => {
  // ── 1. WS join, capture identity ───────────────────────────────────────
  const ws = new WebSocket(WS_URL, { headers: { Origin: 'http://localhost:5173' } });
  let clientId = '';
  let resumeToken = '';
  let roomId = '';
  let spawn = { x: 0, y: 0.05, z: 0 };
  const welcomed = new Promise<void>((resolve) => {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        wsBinaryFrames += 1;
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        clientId = msg.clientId;
        resumeToken = msg.resumeToken;
        resolve();
      }
      if (msg.type === 'created') roomId = msg.roomId;
      if (msg.type === 'joined' && msg.spawn) spawn = msg.spawn;
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await welcomed;
  if (!clientId || !resumeToken) fail('no clientId/resumeToken in welcome');
  console.log(`ws: welcomed as ${clientId}`);

  ws.send(JSON.stringify({ type: 'create', name: 'WT Probe', mode: 'ffa', mapId: 'causeway', isPublic: false, capacity: 2 }));
  for (let i = 0; i < 40 && !roomId; i++) await sleep(50);
  if (!roomId) fail('room was not created');
  ws.send(JSON.stringify({ type: 'join', roomId, name: 'WT Probe' }));
  await sleep(300); // let join land; WS state frames should be flowing now
  if (wsBinaryFrames === 0) fail('no WS state frames after join — server not snapshotting?');

  // ── 2. discover + connect the datagram channel ─────────────────────────
  let info: { enabled: boolean; url: string | null; certHash: string | null } | null = null;
  for (let i = 0; i < 20; i++) {
    info = (await (await fetch(`${HTTP_BASE}/api/wt-info`)).json()) as typeof info;
    if (info?.enabled) break;
    await sleep(500);
  }
  if (!info?.enabled || !info.url) fail('/api/wt-info never reported enabled (is WT_PORT set?)');
  console.log(`wt-info: ${info!.url} certHash=${info!.certHash ? 'pinned' : 'CA'}`);

  const ch = new WtChannel(
    {
      onFrame: (data) => {
        wtFrames += 1;
        lastWtState = decodeState(toView(data));
      },
      onDead: () => undefined,
    },
    NodeWebTransport as unknown as WtCtor,
  );
  const active = await ch.connect(info!.url!, info!.certHash, clientId, resumeToken);
  if (!active) fail('WtChannel never went ACTIVE (auth handshake failed)');
  console.log('wt: channel ACTIVE (AUTH → AUTH_OK round-trip ok)');

  // ── 3. downlink switched: ~64Hz datagrams, WS quiet ────────────────────
  await sleep(250); // drain any in-flight WS frames from before the switch
  const wsBefore = wsBinaryFrames;
  const wtBefore = wtFrames;
  await sleep(3000);
  const wtHz = (wtFrames - wtBefore) / 3;
  const wsLeak = wsBinaryFrames - wsBefore;
  console.log(`downlink: ${wtHz.toFixed(1)}Hz over datagrams, ${wsLeak} stray WS frames in 3s`);
  if (wtHz < 50) fail(`datagram state rate too low (${wtHz.toFixed(1)}Hz, want ~64)`);
  if (wsLeak > 5) fail(`WS still carrying state (${wsLeak} frames) — downlink did not switch`);

  // ── 4. uplink: pos datagrams move the player ───────────────────────────
  // Walk within the speed clamp: 64Hz steps of 0.05m ≈ 3.2 m/s.
  let x = spawn.x;
  const targetX = spawn.x + 2.5;
  const walker = setInterval(() => {
    if (x < targetX) x += 0.05;
    ch.send(encodePos(x, spawn.y, spawn.z, 0, 0));
  }, 1000 / 64);
  await sleep(2500);
  clearInterval(walker);
  const me = lastWtState?.players.find((p) => p.id === clientId);
  if (!me) fail('own player row missing from datagram state');
  const moved = Math.abs(me!.x - spawn.x);
  console.log(`uplink: walked x ${spawn.x.toFixed(2)} → ${me!.x.toFixed(2)} (sent ${x.toFixed(2)})`);
  if (moved < 1.5) fail(`pos datagrams did not move the player (moved ${moved.toFixed(2)}m)`);
  if (Math.abs(me!.x - x) > 0.5) fail(`state x diverged from sent x by ${Math.abs(me!.x - x).toFixed(2)}m`);

  // ── 5. fallback: close the channel → WS downlink resumes ──────────────
  ch.close();
  await sleep(1000); // server notices `closed`, unbinds, falls back
  const wsResumeBefore = wsBinaryFrames;
  await sleep(2000);
  const wsResumeHz = (wsBinaryFrames - wsResumeBefore) / 2;
  console.log(`fallback: ${wsResumeHz.toFixed(1)}Hz over WS after channel close`);
  if (wsResumeHz < 50) fail(`WS downlink did not resume after WT close (${wsResumeHz.toFixed(1)}Hz)`);

  console.log('\nWEBTRANSPORT CHANNEL E2E ✅ (auth, 64Hz datagram state, uplink pos, WS fallback)');
  ws.close();
  process.exit(0);
};

main().catch((e) => fail(String(e)));
