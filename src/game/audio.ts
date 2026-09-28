import { announcerVariantCount } from './announcer-lines';
import { SfxEngine, type LocalMoveKind } from './sfx/engine';
import type { MotionEventKind } from './sfx/motion-tracker';
import type { StingKind } from './sfx/stings';

export type SoundClipName =
  | 'fire'
  | 'hit'
  | 'kill'
  | 'reload-ready'
  | 'first-blood'
  | 'double-kill'
  | 'triple-kill'
  | 'quad-kill'
  | 'penta-kill'
  | 'killing-spree'
  | 'rampage'
  | 'dominating'
  | 'unstoppable'
  | 'godlike'
  | 'headshot'
  | 'humiliation'
  | 'comeback'
  | 'match-point'
  | 'victory'
  | 'defeat'
  | 'spawn';

// Announcer voice packs. The default ('legacy') uses the flat SOUND_URLS files
// below + the procedural/TTS fallback — unchanged behavior. Other packs are sets
// of generated clips under /sounds/instagib/announcer/<id>/<clip>.mp3 (see
// scripts/gen-announcers.mjs). Only ANNOUNCER_CLIPS are pack-swappable; weapon SFX
// (fire/hit/kill/reload-ready) always use SOUND_URLS.
export type AnnouncerPackId = 'legacy' | 'kuon';
export type AnnouncerPack = { id: AnnouncerPackId; name: string; blurb: string };
export const ANNOUNCER_PACKS: ReadonlyArray<AnnouncerPack> = [
  { id: 'legacy', name: 'Classic', blurb: 'Original deep-voice announcer' },
  { id: 'kuon', name: 'Kuon (Anime)', blurb: 'Cheerful Japanese anime VO' },
];
export const DEFAULT_ANNOUNCER_PACK: AnnouncerPackId = 'legacy';

// User-supplied .ogg files override the procedural / TTS fallback when present.
// Drop CC-licensed clips at these public/ paths. See plan §6.
export const SOUND_URLS: Record<SoundClipName, string> = {
  'fire':          '/sounds/instagib/rail-fire.ogg',
  'hit':           '/sounds/instagib/hit.ogg',
  'kill':          '/sounds/instagib/kill.ogg',
  'reload-ready':  '/sounds/instagib/reload-ready.ogg',
  'first-blood':   '/sounds/instagib/first-blood.ogg',
  'double-kill':   '/sounds/instagib/double-kill.ogg',
  'triple-kill':   '/sounds/instagib/triple-kill.ogg',
  'quad-kill':     '/sounds/instagib/quad-kill.ogg',
  'penta-kill':    '/sounds/instagib/penta-kill.ogg',
  'killing-spree': '/sounds/instagib/killing-spree.ogg',
  'rampage':       '/sounds/instagib/rampage.ogg',
  'dominating':    '/sounds/instagib/dominating.ogg',
  'unstoppable':   '/sounds/instagib/unstoppable.ogg',
  'godlike':       '/sounds/instagib/godlike.ogg',
  'headshot':      '/sounds/instagib/headshot.ogg',
  'humiliation':   '/sounds/instagib/humiliation.ogg',
  'comeback':      '/sounds/instagib/comeback.ogg',
  'match-point':   '/sounds/instagib/match-point.ogg',
  'victory':       '/sounds/instagib/victory.ogg',
  'defeat':        '/sounds/instagib/defeat.ogg',
  'spawn':         '', // deploy/encouragement — pack-only (no legacy file or TTS)
};

const SPOKEN_TEXT: Record<SoundClipName, string> = {
  'fire':          '',
  'hit':           '',
  'kill':          '',
  'reload-ready':  '',
  'first-blood':   'First Blood',
  'double-kill':   'Double Kill',
  'triple-kill':   'Triple Kill',
  'quad-kill':     'Quad Kill',
  'penta-kill':    'Penta Kill',
  'killing-spree': 'Killing Spree',
  'rampage':       'Rampage',
  'dominating':    'Dominating',
  'unstoppable':   'Unstoppable',
  'godlike':       'God like',
  'headshot':      'Headshot',
  'humiliation':   'Humiliation',
  'comeback':      'Comeback',
  'match-point':   'Match point',
  'victory':       'Victory',
  'defeat':        'Defeat',
  'spawn':         '', // no TTS fallback — only voiced by packs that define spawn lines
};

// Which clips are announcer voice lines (vs. weapon SFX). Drives the
// SFX/announcer volume split and the announcer on/off toggle.
const ANNOUNCER_CLIPS: ReadonlySet<SoundClipName> = new Set<SoundClipName>([
  'first-blood',
  'double-kill',
  'triple-kill',
  'quad-kill',
  'penta-kill',
  'killing-spree',
  'rampage',
  'dominating',
  'unstoppable',
  'godlike',
  'headshot',
  'humiliation',
  'comeback',
  'match-point',
  'victory',
  'defeat',
  'spawn',
]);

// Game audio. Weapon / movement / ambience SFX are fully procedural and live in
// ./sfx (SfxEngine: buses, reverb, limiter, voice pool, per-map ambience). This
// class owns the AudioContext, the announcer (voice packs / legacy files / TTS)
// and the optional user-dropped .ogg overrides, and routes everything through
// the engine's mixer so the master limiter + volume settings cover it all.
export class SoundManager {
  private ctx: AudioContext | null = null;
  private engine: SfxEngine | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private announcerBus: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>(); // keyed by resolved URL (pack-aware)
  private loading = new Set<string>(); // URLs with an in-flight fetch (dedupe)
  private missing = new Set<string>(); // URLs that 404'd — don't refetch (use fallback)
  private voice: SpeechSynthesisVoice | null = null;
  private volume = 0.7;
  private sfxVolume = 1;
  private announcerVolume = 1;
  private announcerEnabled = true;
  private pack: AnnouncerPackId = DEFAULT_ANNOUNCER_PACK;
  private mapId = '';
  private lowSpec = false;
  private lastVariant = new Map<SoundClipName, number>(); // avoid repeating a line back-to-back
  // The currently-playing announcer voice source — only ONE announcer line plays
  // at a time (a new line cuts the previous), so multi-kill + headshot + spree
  // never pile up into a garble.
  private announcerSrc: AudioBufferSourceNode | null = null;

  async init() {
    if (this.ctx) return;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      // The engine builds the whole mix graph (SFX + announcer buses → limiter
      // → master volume → destination) synchronously, so sounds work at once.
      this.engine = new SfxEngine(this.ctx);
      this.master = this.engine.mixer.out;
      this.sfxBus = this.engine.mixer.sfxBus;
      this.announcerBus = this.engine.mixer.announcerBus;
      this.engine.setMasterVolume(this.volume);
      this.engine.setSfxVolume(this.sfxVolume);
      this.engine.setAnnouncerVolume(this.announcerVolume);
      this.engine.setLowSpec(this.lowSpec);
      if (this.mapId) this.engine.setMap(this.mapId);
      // Best-effort preload of any real audio files dropped in public/. Missing
      // files fall back to the procedural SFX / TTS announcer.
      for (const url of Object.values(SOUND_URLS)) {
        if (url) void this.loadClip(url).catch(() => {});
      }
      this.preloadPack(); // + the active announcer pack's clips, if not legacy
    } catch {
      // No audio context available — manager becomes a no-op
    }
    this.initVoice();
  }

  // URL of one announcer line variant (1-indexed) for the active pack.
  private announcerVariantUrl(name: SoundClipName, idx: number): string {
    return `/sounds/instagib/announcer/${this.pack}/${name}_${idx}.mp3`;
  }

  // Pick a variant index (1..count) for a clip, avoiding an immediate repeat so
  // the same line doesn't fire twice in a row.
  private pickVariant(name: SoundClipName, count: number): number {
    if (count <= 1) return 1;
    let idx = 1 + Math.floor(Math.random() * count);
    if (idx === this.lastVariant.get(name)) idx = (idx % count) + 1;
    this.lastVariant.set(name, idx);
    return idx;
  }

  // Switch announcer voice pack (Settings → Audio). Preloads the new pack's clips
  // so the first line of a match isn't a fallback miss.
  setAnnouncerPack(id: AnnouncerPackId) {
    if (id === this.pack) return;
    this.pack = id;
    this.lastVariant.clear();
    this.preloadPack();
  }

  private preloadPack() {
    if (!this.ctx || this.pack === 'legacy') return;
    for (const name of ANNOUNCER_CLIPS) {
      const count = announcerVariantCount(this.pack, name);
      for (let i = 1; i <= count; i++) void this.loadClip(this.announcerVariantUrl(name, i)).catch(() => {});
    }
  }

  // Cut any announcer line currently playing (buffered clip OR browser TTS) so a
  // new one never overlaps it.
  private stopAnnouncer() {
    if (this.announcerSrc) {
      try { this.announcerSrc.stop(); } catch { /* already stopped */ }
      this.announcerSrc = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  // Returns whether something audible was started — false when the announcer is
  // off, or a clip has neither a file nor a fallback (callers can substitute a
  // procedural sting so the event never lands silently).
  play(name: SoundClipName, volume = 1): boolean {
    if (!this.ctx || !this.master || !this.engine) return false;
    this.resume();
    const isAnnouncer = ANNOUNCER_CLIPS.has(name);
    if (isAnnouncer && !this.announcerEnabled) return false;
    const bus = (isAnnouncer ? this.announcerBus : this.sfxBus) ?? this.master;
    // Pack announcer clips have N line variants → pick one (no immediate repeat);
    // everything else (legacy announcer, SFX) uses the flat SOUND_URLS file.
    const variants = isAnnouncer ? announcerVariantCount(this.pack, name) : 0;
    const url = variants > 0 ? this.announcerVariantUrl(name, this.pickVariant(name, variants)) : SOUND_URLS[name];
    const buf = url ? this.buffers.get(url) : undefined;
    if (buf) {
      if (isAnnouncer) this.stopAnnouncer(); // one announcer line at a time
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = clamp01(volume);
      src.connect(g).connect(bus);
      if (isAnnouncer) {
        this.announcerSrc = src;
        src.onended = () => { if (this.announcerSrc === src) this.announcerSrc = null; };
        this.engine.duck(buf.duration); // ambience dips under the voice
      }
      src.start(0);
      return true;
    }
    // Not cached yet. For a pack variant, kick off a load so the next play is the
    // real voice (covers the race right after switching packs). Legacy SFX +
    // announcer files are preloaded at init, so a miss there is genuinely absent
    // (e.g. victory/defeat have no .ogg) → straight to the procedural/TTS fallback.
    if (variants > 0 && url && !this.loading.has(url) && !this.missing.has(url)) {
      this.loading.add(url);
      void this.loadClip(url)
        .catch(() => { this.missing.add(url); })
        .finally(() => this.loading.delete(url));
    }
    switch (name) {
      case 'fire':
        this.engine.railShot(volume);
        return true;
      case 'hit':
        this.engine.hitTick(false, volume);
        return true;
      case 'kill':
        this.engine.kill(false, volume);
        return true;
      case 'reload-ready':
        this.engine.ready(volume);
        return true;
      default:
        // Announcer TTS fallback — but only if this clip HAS fallback text. A
        // pack-only clip (e.g. 'spawn') stays silent on the legacy pack.
        return SPOKEN_TEXT[name] ? this.speak(SPOKEN_TEXT[name], volume) : false;
    }
  }

  // Position + orient the HRTF listener at the camera each frame so spatialized
  // sounds (playAt) pan correctly — `forward` is the look direction, `up` the
  // world up. Call once per render frame from the Game with the live camera pose.
  setListenerPose(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ) {
    if (!this.ctx) return;
    this.engine?.setListenerPos(px, py, pz); // distance low-pass + culling
    const L = this.ctx.listener;
    // Modern AudioParam API where available; deprecated setters as a fallback.
    if ('positionX' in L && L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(px, t);
      L.positionY.setValueAtTime(py, t);
      L.positionZ.setValueAtTime(pz, t);
      L.forwardX.setValueAtTime(fx, t);
      L.forwardY.setValueAtTime(fy, t);
      L.forwardZ.setValueAtTime(fz, t);
      L.upX.setValueAtTime(ux, t);
      L.upY.setValueAtTime(uy, t);
      L.upZ.setValueAtTime(uz, t);
    } else {
      const legacy = L as unknown as {
        setPosition: (x: number, y: number, z: number) => void;
        setOrientation: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
      };
      legacy.setPosition(px, py, pz);
      legacy.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // Spatialized one-shot: same clips as play(), but at a world position (HRTF
  // panned, distance-attenuated + low-passed) so you can HEAR where another
  // player is (their rail fire, a nearby frag). `volume` is the at-source
  // level. Announcer lines stay non-positional (centered UI cues).
  playAt(name: SoundClipName, x: number, y: number, z: number, volume = 1) {
    if (!this.ctx || !this.engine) return;
    // Passive (other players') sounds need a running context: built while it's
    // suspended (no user gesture yet — e.g. a fresh spectate link) they'd all
    // fire at once on resume.
    if (this.ctx.state !== 'running' && !ANNOUNCER_CLIPS.has(name)) return;
    if (ANNOUNCER_CLIPS.has(name)) {
      this.play(name, volume);
      return;
    }
    this.resume();
    switch (name) {
      case 'fire': this.engine.railAt(x, y, z, volume); return;
      case 'kill': this.engine.gibAt(x, y, z, volume); return;
      case 'hit': this.engine.hitTick(false, volume); return;
      case 'reload-ready': this.engine.ready(volume); return;
      default: this.play(name, volume); // non-spatial clips (announcer/TTS)
    }
  }

  // Crisp confirm tick for landing a rail — a higher double tick for headshots.
  hitConfirm(headshot: boolean, volume = 1) {
    if (!this.engine) return;
    this.resume();
    this.engine.hitTick(headshot, volume);
  }

  // Kill confirm (your frag): the gib burst. Honors a user-dropped kill.ogg.
  killConfirm(headshot: boolean, volume = 1) {
    if (!this.engine) return;
    if (this.buffers.has(SOUND_URLS.kill)) {
      this.play('kill', volume);
      return;
    }
    this.resume();
    this.engine.kill(headshot, volume);
  }

  // Someone else's frag, heard at the body (bystander awareness).
  gibAt(x: number, y: number, z: number, volume = 1) {
    if (this.ctx?.state !== 'running') return; // see playAt
    this.engine?.gibAt(x, y, z, volume);
  }

  // You got fragged (also cuts the recharge hum).
  death(volume = 1) {
    if (!this.engine) return;
    this.resume();
    this.engine.death(volume);
  }

  // Rail recharge hum over `seconds` (the cooldown just set by a shot).
  chargeStart(seconds: number) {
    this.engine?.chargeStart(seconds);
  }

  chargeStop() {
    this.engine?.chargeStop();
  }

  // Local movement sounds (footsteps, jump, landing, dash, wall-jump, boost).
  localMove(kind: LocalMoveKind, a = 0) {
    this.engine?.localMove(kind, a);
  }

  // Other players' / bots' movement sounds, positional at their feet.
  remoteMove(kind: MotionEventKind, x: number, y: number, z: number, strength: number) {
    if (this.ctx?.state !== 'running') return; // see playAt
    this.engine?.remoteMove(kind, x, y, z, strength);
  }

  // Procedural medal cue (used when the announcer can't voice a medal).
  medalSting(kind: StingKind, level: number) {
    if (!this.engine) return;
    this.resume();
    this.engine.medalSting(kind, level);
  }

  // Map id (map.ts registry) → room reverb, floor surface, ambience flavour.
  // Crossfades the ambience if it's already running.
  setMap(id: string) {
    this.mapId = id;
    this.engine?.setMap(id);
  }

  // Start the per-map ambience bed (call when the match starts).
  startAmbience() {
    this.engine?.startAmbience();
  }

  // Fade the ambience bed out (match over / results / map vote).
  stopAmbience(fade = 1.5) {
    this.engine?.stopAmbience(fade);
  }

  // Low-spec: shorter reverb, equal-power panning, fewer concurrent voices.
  setLowSpec(on: boolean) {
    this.lowSpec = on;
    this.engine?.setLowSpec(on);
  }

  speak(text: string, volume = 1): boolean {
    if (!this.announcerEnabled) return false;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
    if (!text) return false;
    try {
      this.stopAnnouncer(); // cut any prior announcer line (TTS or buffered)
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.92;
      u.pitch = 0.55;
      // TTS volume isn't routed through the WebAudio buses, so fold in the
      // master + announcer volumes here for rough parity.
      u.volume = clamp01(volume * this.volume * this.announcerVolume);
      if (this.voice) u.voice = this.voice;
      window.speechSynthesis.speak(u);
      this.engine?.duck(1.4); // TTS length is unknown — a typical line
      return true;
    } catch {
      return false;
    }
  }

  setVolume(v: number) {
    this.volume = clamp01(v);
    this.engine?.setMasterVolume(this.volume);
  }

  setSfxVolume(v: number) {
    this.sfxVolume = clamp01(v);
    this.engine?.setSfxVolume(this.sfxVolume);
  }

  setAnnouncerVolume(v: number) {
    this.announcerVolume = clamp01(v);
    this.engine?.setAnnouncerVolume(this.announcerVolume);
  }

  setAnnouncerEnabled(on: boolean) {
    this.announcerEnabled = on;
    if (!on && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel(); // kill any in-flight TTS line
      } catch {
        // ignore
      }
    }
  }

  dispose() {
    this.announcerSrc = null;
    this.engine?.dispose();
    this.engine = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.sfxBus = null;
      this.announcerBus = null;
    }
    this.buffers.clear();
    this.loading.clear();
    this.missing.clear();
    this.lastVariant.clear();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
  }

  private async loadClip(url: string) {
    if (!this.ctx || !url || this.buffers.has(url)) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(arr);
    this.buffers.set(url, buf);
  }

  private initVoice() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const choose = () => {
      const voices = window.speechSynthesis.getVoices();
      const eng = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
      this.voice =
        eng.find((v) =>
          /daniel|alex|fred|aaron|david|male|google.*us|microsoft.*david/i.test(
            v.name,
          ),
        ) ??
        eng[0] ??
        voices[0] ??
        null;
    };
    choose();
    try {
      window.speechSynthesis.addEventListener('voiceschanged', choose);
    } catch {
      // ignore
    }
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/* ── Menu / UI sounds ───────────────────────────────────────────────────────
   The synthesized cue set for the deck chrome and the rewards reveal (buttons,
   tabs, toggles, modals, toasts, XP ticks, unlock stings…). How each cue sounds
   lives in src/game/sfx/ui-sounds.ts; this bank owns the live context + level.

   It lives on its own AudioContext (there is no Game — and so no SoundManager
   — in the lobby), but follows the same rules as gameplay audio: the context
   is only created/resumed inside a user gesture (unlockUiAudio, wired to the
   first pointerdown/keydown in src/deck-core.ts; or a click-type cue fired
   while the browser reports transient user activation), and its level is
   master × SFX from Settings (setUiVolume), so muting SFX mutes the UI too.
   Timer-driven cues (hover, the rewards reveal, case spins, modal mounts) are
   dropped until the context is actually running, so a page load never queues
   a burst of sounds that fires on the first click. */
import { isGestureUiSound, playUiCue, type UiSoundName } from './sfx/ui-sounds';

export type { UiSoundName } from './sfx/ui-sounds';

// The UI set is mixed well below the weapon SFX so it never competes with a
// match (the same settings sliders scale both).
const UI_TRIM = 0.55;

// True while the page holds transient user activation (inside a click / key
// handler). Browsers without the API are treated as "yes" (the old behaviour).
function inUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : true;
}

class UiSoundBank {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private master = 0.7;
  private sfx = 1;

  // Create the context (only call from inside a user gesture) and resume it.
  unlock() {
    if (!this.ctx) {
      try {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.bus = this.ctx.createGain();
        this.bus.gain.value = this.level();
        // A gentle bus compressor: a fast run of cues (XP ticks over a fanfare)
        // can never stack into a spike.
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 8;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.12;
        this.bus.connect(comp).connect(this.ctx.destination);
      } catch {
        this.ctx = null;
        this.bus = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(master: number, sfx: number) {
    this.master = clamp01(master);
    this.sfx = clamp01(sfx);
    if (this.bus) this.bus.gain.value = this.level();
  }

  private level(): number {
    return this.master * this.sfx * UI_TRIM;
  }

  play(name: UiSoundName, detail = 0) {
    if (typeof window === 'undefined') return;
    if (this.level() <= 0) return;
    // Only a click-type cue fired inside a gesture may create / resume the
    // context; everything else plays only once it is already running.
    if (isGestureUiSound(name) && inUserGesture()) this.unlock();
    if (!this.ctx || !this.bus || this.ctx.state !== 'running') return;
    playUiCue(this.ctx, this.bus, name, this.ctx.currentTime, detail);
  }
}

const uiSounds = new UiSoundBank();

// `detail` is a per-cue parameter: the xpTick line index, the uiToggle new
// state, the countdownTick seconds left, the unlock rarity index… (see
// UiSoundName in src/game/sfx/ui-sounds.ts).
export function playUi(name: UiSoundName, detail?: number) {
  uiSounds.play(name, detail);
}

// Mirror the Settings sliders (master + SFX) onto the UI bank.
export function setUiVolume(master: number, sfx: number) {
  uiSounds.setVolume(master, sfx);
}

// Call from a user gesture (pointerdown / keydown) so the UI context exists
// and is running before the first cue is needed.
export function unlockUiAudio() {
  uiSounds.unlock();
}
