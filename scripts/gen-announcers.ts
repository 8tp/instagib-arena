// Generate an announcer voice pack with ElevenLabs text-to-speech.
//
// Usage (run with tsx):
//   ELEVENLABS_API_KEY=sk_... npx tsx scripts/gen-announcers.ts <voiceId> <packId> [modelId]
//
// The lines come from src/game/announcer-lines.ts (the single source of truth that
// the client also reads to pick + preload variants). Each line variant N for a
// clip is written as `<clip>_<N>.mp3` under public/sounds/instagib/announcer/<packId>/.
// Stale .mp3s in that folder are cleared first so removed/renamed variants don't
// linger. Browsers decode MP3 via Web Audio, so no OGG conversion is needed.
//
// ElevenLabs notes: free tier can't use Voice Library voices via the API (HTTP
// 402) — needs a paid plan (Starter+). 1 credit ≈ 1 character.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ANNOUNCER_PACK_LINES } from '../src/game/announcer-lines';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const [, , voiceId, packId, modelId = 'eleven_multilingual_v2'] = process.argv;

if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY env var.');
  process.exit(1);
}
if (!voiceId || !packId) {
  console.error('Usage: npx tsx scripts/gen-announcers.ts <voiceId> <packId> [modelId]');
  process.exit(1);
}

const lines = ANNOUNCER_PACK_LINES[packId as keyof typeof ANNOUNCER_PACK_LINES];
if (!lines || Object.keys(lines).length === 0) {
  console.error(`No lines defined for pack "${packId}" in src/game/announcer-lines.ts`);
  process.exit(1);
}

// A touch of expressiveness for an announcer; speaker boost keeps it present.
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true };

const outDir = path.resolve('public/sounds/instagib/announcer', packId);
await mkdir(outDir, { recursive: true });
// Clear stale clips so renamed/removed variants don't linger.
for (const f of await readdir(outDir).catch(() => [] as string[])) {
  if (f.endsWith('.mp3')) await rm(path.join(outDir, f)).catch(() => {});
}

const entries = Object.entries(lines) as [string, string[]][];
const total = entries.reduce((n, [, v]) => n + v.length, 0);
console.log(`Generating "${packId}" (voice ${voiceId}, model ${modelId}) — ${total} clips → ${outDir}\n`);

let ok = 0;
let fail = 0;
for (const [clip, variants] of entries) {
  for (let i = 0; i < variants.length; i++) {
    const text = variants[i];
    const file = `${clip}_${i + 1}.mp3`;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS }),
      });
      if (!res.ok) {
        console.error(`✗ ${file}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 140)}`);
        fail++;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(outDir, file), buf);
      console.log(`✓ ${file}  ${(buf.length / 1024).toFixed(1)} KB  "${text}"`);
      ok++;
    } catch (e) {
      console.error(`✗ ${file}: ${(e as Error)?.message ?? e}`);
      fail++;
    }
    await new Promise((r) => setTimeout(r, 200)); // gentle pacing
  }
}

console.log(`\nDone: ${ok} ok, ${fail} failed.`);
process.exit(fail ? 1 : 0);
