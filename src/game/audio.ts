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
  | 'defeat';

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
]);

export class SoundManager {
  private ctx: AudioContext | null = null;
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
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      // Separate SFX + announcer sub-buses so each has its own volume and the
      // announcer can be muted independently.
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume;
      this.sfxBus.connect(this.master);
      this.announcerBus = this.ctx.createGain();
      this.announcerBus.gain.value = this.announcerVolume;
      this.announcerBus.connect(this.master);
      // Best-effort preload of any real audio files dropped in public/. Missing
      // files fall back to the procedural SFX / TTS announcer.
      for (const url of Object.values(SOUND_URLS)) {
        void this.loadClip(url).catch(() => {});
      }
      this.preloadPack(); // + the active announcer pack's clips, if not legacy
    } catch {
      // No audio context available — manager becomes a no-op
    }
    this.initVoice();
  }

  // Resolve a clip to its URL for the active pack. Only announcer voice lines are
  // pack-swappable; weapon SFX always use the flat SOUND_URLS files.
  private clipUrl(name: SoundClipName): string {
    if (this.pack !== 'legacy' && ANNOUNCER_CLIPS.has(name)) {
      return `/sounds/instagib/announcer/${this.pack}/${name}.mp3`;
    }
    return SOUND_URLS[name];
  }

  // Switch announcer voice pack (Settings → Audio). Preloads the new pack's clips
  // so the first line of a match isn't a TTS-fallback miss.
  setAnnouncerPack(id: AnnouncerPackId) {
    if (id === this.pack) return;
    this.pack = id;
    this.preloadPack();
  }

  private preloadPack() {
    if (!this.ctx || this.pack === 'legacy') return;
    for (const name of ANNOUNCER_CLIPS) void this.loadClip(this.clipUrl(name)).catch(() => {});
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

  play(name: SoundClipName, volume = 1) {
    if (!this.ctx || !this.master) return;
    this.resume();
    const isAnnouncer = ANNOUNCER_CLIPS.has(name);
    if (isAnnouncer && !this.announcerEnabled) return;
    const bus = (isAnnouncer ? this.announcerBus : this.sfxBus) ?? this.master;
    const url = this.clipUrl(name);
    const buf = this.buffers.get(url);
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
      }
      src.start(0);
      return;
    }
    // Not cached yet. For a non-legacy pack clip, kick off a load so the next play
    // is the real voice (covers the race right after switching packs). Legacy SFX +
    // announcer files are preloaded at init, so a miss there is genuinely absent
    // (e.g. victory/defeat have no .ogg) → straight to the procedural/TTS fallback.
    if (isAnnouncer && this.pack !== 'legacy' && !this.loading.has(url) && !this.missing.has(url)) {
      this.loading.add(url);
      void this.loadClip(url)
        .catch(() => { this.missing.add(url); })
        .finally(() => this.loading.delete(url));
    }
    switch (name) {
      case 'fire':
        playProcRail(this.ctx, bus, volume);
        return;
      case 'hit':
        playProcHit(this.ctx, bus, volume);
        return;
      case 'kill':
        playProcKill(this.ctx, bus, volume);
        return;
      case 'reload-ready':
        playProcReady(this.ctx, bus, volume);
        return;
      default:
        this.speak(SPOKEN_TEXT[name] || name, volume);
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

  // Spatialized one-shot: same clips as play(), but routed through an HRTF panner
  // at a world position so you can HEAR where another player is (their rail fire,
  // a nearby frag). `volume` is the at-source level — the panner does the
  // distance falloff. Announcer lines stay non-positional (centered UI cues).
  playAt(name: SoundClipName, x: number, y: number, z: number, volume = 1) {
    if (!this.ctx || !this.master) return;
    if (ANNOUNCER_CLIPS.has(name)) {
      this.play(name, volume);
      return;
    }
    this.resume();
    const bus = this.sfxBus ?? this.master;
    const panner = this.makePanner(x, y, z);
    panner.connect(bus);
    const buf = this.buffers.get(this.clipUrl(name));
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = clamp01(volume);
      src.connect(g).connect(panner);
      src.start(0);
      return;
    }
    switch (name) {
      case 'fire': playProcRail(this.ctx, panner, volume); return;
      case 'hit': playProcHit(this.ctx, panner, volume); return;
      case 'kill': playProcKill(this.ctx, panner, volume); return;
      case 'reload-ready': playProcReady(this.ctx, panner, volume); return;
      default: this.play(name, volume); // non-spatial clips (announcer/TTS)
    }
  }

  private makePanner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF'; // binaural cues so direction is discernible on headphones
    p.distanceModel = 'inverse';
    p.refDistance = 8; // full level within ~8m
    p.maxDistance = 100;
    p.rolloffFactor = 1;
    if ('positionX' in p && p.positionX) {
      const t = this.ctx!.currentTime;
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else {
      (p as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(x, y, z);
    }
    return p;
  }

  // Crisp confirm ping for landing a rail — pitched up for headshots. Layered
  // on top of the kill sound so hits feel snappy.
  hitConfirm(headshot: boolean, volume = 1) {
    if (!this.ctx) return;
    this.resume();
    const bus = this.sfxBus ?? this.master;
    if (!bus) return;
    playProcHit(this.ctx, bus, volume, headshot ? 1.6 : 1.0);
  }

  speak(text: string, volume = 1) {
    if (!this.announcerEnabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (!text) return;
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
    } catch {
      // ignore
    }
  }

  setVolume(v: number) {
    this.volume = clamp01(v);
    if (this.master) this.master.gain.value = this.volume;
  }

  setSfxVolume(v: number) {
    this.sfxVolume = clamp01(v);
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVolume;
  }

  setAnnouncerVolume(v: number) {
    this.announcerVolume = clamp01(v);
    if (this.announcerBus) this.announcerBus.gain.value = this.announcerVolume;
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
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.master = null;
    }
    this.buffers.clear();
    this.loading.clear();
    this.missing.clear();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
  }

  private async loadClip(url: string) {
    if (!this.ctx || this.buffers.has(url)) return;
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

function makeNoise(ctx: AudioContext, durSec: number): AudioBufferSourceNode {
  const buf = ctx.createBuffer(
    1,
    Math.max(1, Math.floor(ctx.sampleRate * durSec)),
    ctx.sampleRate,
  );
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function playProcRail(ctx: AudioContext, dest: AudioNode, vol = 1) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(180, now + 0.22);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 850;
  filter.Q.value = 1.6;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.5 * vol, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
  osc.connect(filter).connect(gain).connect(dest);
  osc.start(now);
  osc.stop(now + 0.26);
  const n = makeNoise(ctx, 0.08);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.22 * vol, now);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  n.connect(ng).connect(dest);
  n.start(now);
  n.stop(now + 0.08);
}

function playProcHit(ctx: AudioContext, dest: AudioNode, vol = 1, pitch = 1) {
  const now = ctx.currentTime;
  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  o1.frequency.value = 2400 * pitch;
  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = 3200 * pitch;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.35 * vol, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  o1.connect(g);
  o2.connect(g);
  g.connect(dest);
  o1.start(now);
  o2.start(now);
  o1.stop(now + 0.1);
  o2.stop(now + 0.1);
}

function playProcReady(ctx: AudioContext, dest: AudioNode, vol = 1) {
  // Subtle double-pip on the cooldown-to-ready transition. Two short sine
  // bursts ascending — recognizable as "ready" but not intrusive.
  const now = ctx.currentTime;
  const tones = [1750, 2300];
  for (let i = 0; i < tones.length; i++) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = tones[i];
    const g = ctx.createGain();
    const t0 = now + i * 0.045;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.18 * vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + 0.06);
  }
}

function playProcKill(ctx: AudioContext, dest: AudioNode, vol = 1) {
  const now = ctx.currentTime;
  const n = makeNoise(ctx, 0.45);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2200, now);
  f.frequency.exponentialRampToValueAtTime(160, now + 0.4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.55 * vol, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  n.connect(f).connect(g).connect(dest);
  n.start(now);
  n.stop(now + 0.48);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(140, now);
  o.frequency.exponentialRampToValueAtTime(45, now + 0.25);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.4 * vol, now);
  og.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  o.connect(og).connect(dest);
  o.start(now);
  o.stop(now + 0.35);
}
