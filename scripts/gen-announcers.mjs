// Generate an announcer voice pack with ElevenLabs text-to-speech.
//
// Usage:
//   ELEVENLABS_API_KEY=sk_... node scripts/gen-announcers.mjs <voiceId> <packId> [modelId]
//   # or, keeping the key out of your shell history (Node 20+):
//   node --env-file=.env scripts/gen-announcers.mjs <voiceId> <packId>
//
// Writes one MP3 per announcer line to public/sounds/instagib/announcer/<packId>/.
// Browsers decode MP3 via Web Audio (decodeAudioData), so no OGG conversion is
// needed. The clip keys MUST match the announcer SoundClipNames in
// src/game/audio.ts so the pack resolver finds them.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const [, , voiceId, packId, modelId = 'eleven_multilingual_v2'] = process.argv;

if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY env var.');
  process.exit(1);
}
if (!voiceId || !packId) {
  console.error('Usage: node scripts/gen-announcers.mjs <voiceId> <packId> [modelId]');
  process.exit(1);
}

// clip key -> spoken line. Punctuation shapes the delivery (! = punchy, … = somber).
const LINES = {
  'first-blood': 'First blood!',
  'double-kill': 'Double kill!',
  'triple-kill': 'Triple kill!',
  'quad-kill': 'Quad kill!',
  'penta-kill': 'Penta kill!',
  'killing-spree': 'Killing spree!',
  'rampage': 'Rampage!',
  'dominating': 'Dominating!',
  'unstoppable': 'Unstoppable!',
  'godlike': 'Godlike!',
  'headshot': 'Headshot!',
  'humiliation': 'Humiliation!',
  'comeback': 'Comeback!',
  'match-point': 'Match point!',
  'victory': 'Victory!',
  'defeat': 'Defeat…',
};

// A touch of expressiveness for an announcer; speaker boost keeps it present.
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true };

const outDir = path.resolve('public/sounds/instagib/announcer', packId);
await mkdir(outDir, { recursive: true });
console.log(`Generating "${packId}" pack (voice ${voiceId}, model ${modelId}) → ${outDir}\n`);

let ok = 0;
let fail = 0;
for (const [clip, text] of Object.entries(LINES)) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`✗ ${clip}: HTTP ${res.status} ${detail.slice(0, 160)}`);
      fail++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path.join(outDir, `${clip}.mp3`), buf);
    console.log(`✓ ${clip}.mp3  ${(buf.length / 1024).toFixed(1)} KB  "${text}"`);
    ok++;
  } catch (e) {
    console.error(`✗ ${clip}: ${e?.message ?? e}`);
    fail++;
  }
  await new Promise((r) => setTimeout(r, 250)); // gentle pacing
}

console.log(`\nDone: ${ok} ok, ${fail} failed.`);
process.exit(fail ? 1 : 0);
