# Instagib audio + credits

The game's `SoundManager` (`src/app/(tools)/arcade/instagib/_game/audio.ts`)
preloads `*.ogg` files from this folder by name and plays them in place of the
built-in procedural SFX / TTS announcer. Drop a file named exactly as below and
it's used automatically; remove it and the fallback takes over.

## Filename contract

Announcer (announcer bus): `first-blood, double-kill, triple-kill, quad-kill,
penta-kill, killing-spree, rampage, dominating, unstoppable, godlike, headshot,
humiliation`

Weapon SFX (sfx bus): `rail-fire` (the `fire` event), `hit`, `kill`,
`reload-ready` — currently **not** shipped as files; the synthesized WebAudio
SFX are used. Add same-named `.ogg` files to override.

## What's currently shipped

Real, openly-licensed announcer voice lines (converted to Ogg Vorbis,
EBU R128-normalized). **No id Software / Quake audio is used** — that's
copyrighted.

**From "Announcer Kill Sounds" by Arkhados — CC-BY 3.0:**
`first-blood, double-kill, triple-kill, killing-spree, rampage, dominating, godlike`

**From "Classic Killstreak Announcer Voices" by Salatiel — CC-BY-SA 4.0:**
`quad-kill, penta-kill, headshot`

**Still OS-generated (macOS `say`) placeholders — no free pack had these exact
lines:** `unstoppable, humiliation`. (OpenArena has a GPL `humiliation` line if
you want the ~470 MB game data; `unstoppable` isn't common in free packs.)

## Required attribution (do not remove)

- Announcer voices "Announcer Kill Sounds" by **Arkhados** — recorded by Antti
  Saari, edited by TripleSnail — **CC-BY 3.0**
  (https://creativecommons.org/licenses/by/3.0/) —
  https://opengameart.org/content/announcer-kill-sounds
- Announcer voices "Classic Killstreak Announcer Voices" by **Salatiel**,
  adapted for SauerWebUI, based on original work by **blindabuser** —
  **CC-BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/) —
  https://github.com/SalatielSauer/SauerWebUI

**CC-BY-SA note:** the Salatiel-derived files (`quad-kill`, `penta-kill`,
`headshot`) are themselves offered under CC-BY-SA 4.0 (share-alike). This does
not affect the game code — only those audio files. To avoid share-alike, delete
those three files (the announcer falls back for them).

## Regenerating / swapping

The pack WAVs convert with (native ffmpeg Vorbis encoder is stereo-only here, no
`libvorbis`):

```bash
OUT="$(git rev-parse --show-toplevel)/bespick/public/sounds/instagib"
ffmpeg -y -i SOURCE.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -ac 2 -ar 44100 -c:a vorbis -strict -2 -b:a 112k "$OUT/<name>.ogg"
```

To fill `unstoppable`/`humiliation` with real audio, the **jkerman**
"Old-School Arena FPS Announcer Voice Lines" (CC-BY 4.0,
https://freesound.org/people/jkerman/sounds/718360/) has both (one WAV to slice;
needs a Freesound account to download) — add its CC-BY 4.0 attribution here too.
