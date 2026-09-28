import * as THREE from 'three';
import { RemotePlayer } from './remote-player';
import type { BotModel } from './bots';
import type { RemotePlayerSnapshot } from './net';
import type { Vec3 } from './types';
import type { KillEffectStyle } from './cosmetics';
import { EYE_HEIGHT, MULTIKILL_WINDOW_SEC, TEAM_COLORS } from './constants';
import {
  REPLAY_VERSION,
  type ReplayActorProfile,
  type ReplayData,
  type ReplayFrame,
  type ReplayKill,
  type ReplayPose,
  type ReplayShot,
  type ReplayTaunt,
} from './replay-codec';
import type { Look } from './items/types';
import { emoteClip } from './emotes';
import { emoteKindOfLook } from './look-runtime';
import { isKillEffectStyle, DEFAULT_KILL_EFFECT } from './cosmetics';
import { MotionTracker, type MotionEventKind } from './sfx/motion-tracker';

// The pure data shapes live in replay-codec (so the server can import them too);
// re-export here so existing call sites keep importing them from './replay'.
export type {
  ReplayActorKind,
  ReplayActorProfile,
  ReplayPose,
  ReplayFrame,
  ReplayKill,
  ReplayShot,
  ReplayTaunt,
} from './replay-codec';

// ── Play of the Match: record the match, pick the best moment, replay it ──────
//
// The recorder is pure data (no THREE / Game coupling) so it stays cheap and
// testable; the player (ReplayPlayer) owns the THREE actors + cinematic camera
// and is driven by Game each frame while the clip plays. Everything is captured
// CLIENT-SIDE from data the client already has every frame, so it works both
// offline-vs-bots and online with no server changes.

const RECORD_HZ = 30;
const RECORD_DT = 1 / RECORD_HZ;
// Hard caps so a pathologically long match can't grow the buffer without bound.
const MAX_FRAMES = 9000; // 300s @ 30Hz — well past the frag limit / mercy rule
const MAX_SHOTS = 2000; // FIFO; only shots inside the final clip window matter
const MAX_TAUNTS = 400;

// Clip framing around the chosen kill cluster.
const PREROLL_SEC = 2.0;
const POSTROLL_SEC = 1.8;
const CLIP_MIN_SEC = 5;
const CLIP_MAX_SEC = 8; // keep short so the online map-vote countdown isn't eaten
// Consecutive kills within this gap belong to the same "play" — reuse the
// multi-kill window so clip labels line up with the medal system.
const CLUSTER_GAP_SEC = MULTIKILL_WINDOW_SEC;

// Finale: a short clip around the match-ending kill, played in slow motion as a
// cinematic "victory" beat before the Play of the Match. Kept tight so the
// slow-mo + freeze lands fast and doesn't stall the results screen.
const FINALE_PREROLL_SEC = 0.9;
const FINALE_POSTROLL_SEC = 0.7;

export type HighlightClip = {
  starId: string;
  starName: string;
  label: string;
  subLabel?: string;
  startT: number;
  endT: number;
  kills: ReplayKill[];
};

export class MatchRecorder {
  readonly profiles = new Map<string, ReplayActorProfile>();
  readonly frames: ReplayFrame[] = [];
  readonly kills: ReplayKill[] = [];
  readonly shots: ReplayShot[] = [];
  readonly taunts: ReplayTaunt[] = [];

  private clock = 0;
  private frameAccum = 0;

  get durationSec(): number {
    return this.clock;
  }

  // Capture this entity's static identity once (idempotent). Cosmetics are read
  // at first sight; they don't change mid-match.
  // Idempotent, but a profile first seen BEFORE its looks arrived (a remote whose
  // loadout snapshot lands a beat after they appear) is upgraded in place — the
  // replay must dress everyone in what they actually wore.
  ensureProfile(p: ReplayActorProfile) {
    const cur = this.profiles.get(p.id);
    if (!cur) {
      this.profiles.set(p.id, p);
      return;
    }
    if (p.looks && (!cur.looks || Object.keys(p.looks).length > Object.keys(cur.looks).length)) {
      cur.looks = p.looks;
      cur.hat = p.hat;
      cur.unusual = p.unusual;
      cur.nameColor = p.nameColor;
    }
  }

  // A taunt started (any actor): recorded so the replay plays the emote.
  logTaunt(actorId: string, look: Look | undefined) {
    this.taunts.push({ t: this.clock, actorId, look });
    if (this.taunts.length > MAX_TAUNTS) this.taunts.shift();
  }

  // Advance the recorder clock and capture a downsampled pose frame. `sample`
  // returns the per-actor poses for "now"; the recorder owns the timeline.
  tick(dt: number, sample: () => Record<string, ReplayPose>) {
    this.clock += dt;
    this.frameAccum += dt;
    if (this.frameAccum < RECORD_DT) return;
    this.frameAccum -= RECORD_DT;
    if (this.frameAccum > RECORD_DT) this.frameAccum = 0; // big hitch → don't backlog
    if (this.frames.length >= MAX_FRAMES) return;
    this.frames.push({ t: this.clock, poses: sample() });
  }

  logKill(k: Omit<ReplayKill, 't'>) {
    this.kills.push({ ...k, t: this.clock });
  }

  logShot(s: Omit<ReplayShot, 't'>) {
    this.shots.push({ ...s, t: this.clock });
    if (this.shots.length > MAX_SHOTS) this.shots.shift();
  }

  reset() {
    this.profiles.clear();
    this.frames.length = 0;
    this.kills.length = 0;
    this.shots.length = 0;
    this.taunts.length = 0;
    this.clock = 0;
    this.frameAccum = 0;
  }

  // Snapshot the whole recording into the portable replay shape (for encoding +
  // upload). `localId` is the actor whose eyes the rewatch rides; `won`/the clock
  // summarize the run for the leaderboard + the server's score sanity-check.
  export(localId: string, mapId: string, won: boolean): ReplayData {
    return {
      version: REPLAY_VERSION,
      hz: RECORD_HZ,
      mapId,
      durationMs: Math.round(this.clock * 1000),
      localId,
      won,
      profiles: [...this.profiles.values()],
      frames: this.frames,
      kills: this.kills,
      shots: this.shots,
      taunts: this.taunts,
    };
  }

  // Pick the most impressive kill cluster of the match and frame a clip around
  // it. Returns null when there's nothing worth showing (no kills recorded).
  selectHighlight(localId: string): HighlightClip | null {
    if (this.kills.length === 0 || this.frames.length === 0) return null;

    // Group each killer's kills into clusters separated by > CLUSTER_GAP_SEC.
    const byKiller = new Map<string, ReplayKill[]>();
    for (const k of this.kills) {
      const arr = byKiller.get(k.killerId);
      if (arr) arr.push(k);
      else byKiller.set(k.killerId, [k]);
    }

    type Cluster = { killerId: string; kills: ReplayKill[]; score: number };
    const clusters: Cluster[] = [];
    for (const [killerId, list] of byKiller) {
      list.sort((a, b) => a.t - b.t);
      let cluster: ReplayKill[] = [];
      for (const k of list) {
        const prev = cluster[cluster.length - 1];
        if (prev && k.t - prev.t > CLUSTER_GAP_SEC) {
          clusters.push({ killerId, kills: cluster, score: scoreCluster(cluster) });
          cluster = [];
        }
        cluster.push(k);
      }
      if (cluster.length > 0) {
        clusters.push({ killerId, kills: cluster, score: scoreCluster(cluster) });
      }
    }

    let best: Cluster | null = null;
    for (const c of clusters) {
      if (isBetter(c, best, localId)) best = c;
    }
    if (!best) return null;

    const kills = best.kills;
    const firstT = kills[0].t;
    const lastT = kills[kills.length - 1].t;
    const duration = this.durationSec;

    let startT = Math.max(0, firstT - PREROLL_SEC);
    let endT = Math.min(duration, lastT + POSTROLL_SEC);
    // Enforce max length: trim the lead-in first so the payoff stays on screen.
    if (endT - startT > CLIP_MAX_SEC) startT = Math.max(startT, endT - CLIP_MAX_SEC);
    // Enforce min length: pad the tail, then the head, within the match bounds.
    if (endT - startT < CLIP_MIN_SEC) {
      endT = Math.min(duration, startT + CLIP_MIN_SEC);
      startT = Math.max(0, endT - CLIP_MIN_SEC);
    }

    const star = this.profiles.get(best.killerId);
    const { label, subLabel } = labelFor(kills);
    return {
      starId: best.killerId,
      starName: star?.name ?? kills[0].killerName,
      label,
      subLabel,
      startT,
      endT,
      kills,
    };
  }

  // The match-ending blow: a short clip around the very last kill, framed
  // first-person from the finisher. Played in slow motion as a victory beat
  // before the Play of the Match. Returns null when no kills were recorded.
  selectFinale(): HighlightClip | null {
    if (this.kills.length === 0 || this.frames.length === 0) return null;
    const last = this.kills[this.kills.length - 1];
    const duration = this.durationSec;
    const star = this.profiles.get(last.killerId);
    return {
      starId: last.killerId,
      starName: star?.name ?? last.killerName,
      label: 'FINAL BLOW',
      subLabel: last.victimName,
      startT: Math.max(0, last.t - FINALE_PREROLL_SEC),
      endT: Math.min(duration, last.t + FINALE_POSTROLL_SEC),
      kills: [last],
    };
  }
}

function scoreCluster(kills: ReplayKill[]): number {
  const count = kills.length;
  const headshots = kills.filter((k) => k.headshot).length;
  return count * 10 + headshots * 3 + multikillBonus(count);
}

function multikillBonus(count: number): number {
  if (count >= 5) return 35;
  if (count === 4) return 22;
  if (count === 3) return 12;
  if (count === 2) return 5;
  return 0;
}

// Higher score wins; ties favor the local player's own play, then the more
// recent cluster (its last kill is later).
function isBetter(
  c: { killerId: string; kills: ReplayKill[]; score: number },
  best: { killerId: string; kills: ReplayKill[]; score: number } | null,
  localId: string,
): boolean {
  if (!best) return true;
  if (c.score !== best.score) return c.score > best.score;
  const cLocal = c.killerId === localId ? 1 : 0;
  const bLocal = best.killerId === localId ? 1 : 0;
  if (cLocal !== bLocal) return cLocal > bLocal;
  return c.kills[c.kills.length - 1].t > best.kills[best.kills.length - 1].t;
}

function labelFor(kills: ReplayKill[]): { label: string; subLabel?: string } {
  const count = kills.length;
  if (count >= 5) return { label: 'MONSTER KILL', subLabel: `${count} KILLS` };
  if (count === 4) return { label: 'QUAD KILL', subLabel: '4 KILLS' };
  if (count === 3) return { label: 'TRIPLE KILL', subLabel: '3 KILLS' };
  if (count === 2) return { label: 'DOUBLE KILL', subLabel: '2 KILLS' };
  // Single kill — still always show *something* (Overwatch always has a PotG).
  if (kills[0].headshot) return { label: 'HEADSHOT', subLabel: kills[0].victimName };
  return { label: 'BEST PICK', subLabel: kills[0].victimName };
}

// ── Playback ─────────────────────────────────────────────────────────────────

export type ReplayDeps = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  botModel: BotModel | null;
  spawnBeam: (origin: Vec3, end: Vec3) => void;
  spawnMuzzleFlash: (at: Vec3) => void;
  // `finisher` is the killer's recorded finisher (from their looks; the caller's
  // `finisherFor` covers profiles recorded without looks).
  spawnKillEffect: (at: THREE.Vector3, headshot: boolean, killerId: string, finisher: KillEffectStyle) => void;
  // Fallback finisher lookup for a killer whose profile has no finisher Look.
  finisherFor?: (killerId: string) => KillEffectStyle;
  // A (re)spawn: the actor's own spawn-in effect (their equipped spawn id).
  spawnIn?: (at: THREE.Vector3, spawnEffectId: string) => void;
  reducedEffects: () => boolean;
  // Fired when the POV star (whose eyes we're in) scores a kill in the clip, so
  // the HUD can flash a hit-marker over the crosshair. `chain` = the star's
  // running multi-kill count (1 = a lone kill).
  onStarKill?: (headshot: boolean, chain: number) => void;
  // The star's own body events (for the first-person viewmodel: fire kick, hop,
  // landing dip).
  onStarEvent?: (kind: 'fire' | MotionEventKind, strength: number) => void;
  // Replay audio (see replay-audio.ts). Optional: the player is silent without it.
  sfx?: ReplaySfx;
};

export interface ReplaySfx {
  // A replayed rail shot; `lethal` = it killed someone (the gib carries the sound).
  shot(s: ReplayShot, star: boolean, lethal: boolean): void;
  // A replayed frag at the victim's body.
  kill(at: Vec3, k: ReplayKill, finisher: KillEffectStyle, star: boolean, chain: number): void;
  // Footsteps / jumps / lands of replay actors (feet position, strength = m/s).
  move(kind: MotionEventKind, x: number, y: number, z: number, strength: number, star: boolean): void;
}

// First-person replay camera: the clip is shown through the star's own eyes
// (like Overwatch's Play of the Game). Light exponential smoothing masks the
// 30Hz pose sampling without making the look feel laggy.
// The poses themselves are Catmull-Rom interpolated (C1-continuous through the
// 30 Hz samples), so this is only a light residual filter — it must stay well
// above the render rate's Nyquist so it never reads as lag, in slow-mo included.
const EYE_POS_SMOOTH = 34; // exp smoothing rate for the eye position
const EYE_LOOK_SMOOTH = 40; // exp smoothing rate for yaw/pitch

// Replay playback options. `timeScale` < 1 plays the clip in slow motion;
// `freezeSec` holds on the final frame afterwards (the cinematic "pause").
// `holdAtEnd` (full-run rewatch) pauses on the final frame instead of finishing,
// so the viewer can scrub back / replay rather than auto-tearing-down.
export type ReplayOptions = { timeScale?: number; freezeSec?: number; holdAtEnd?: boolean };

// The buffers ReplayPlayer reads. MatchRecorder satisfies this directly; a
// downloaded+decoded replay is adapted into it (replay-viewer). The fields match
// MatchRecorder's so either can be passed to start().
export type ReplaySource = {
  profiles: Map<string, ReplayActorProfile>;
  frames: ReplayFrame[];
  kills: ReplayKill[];
  shots: ReplayShot[];
  taunts?: ReplayTaunt[];
};

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// First index of a time-sorted event list whose `t >= time` (binary search) —
// where to point an event cursor after a seek so only forward events still fire.
function firstAtOrAfter(events: { t: number }[], time: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ReplayPlayer {
  private actors = new Map<string, RemotePlayer>();
  private frames: ReplayFrame[] = [];
  private kills: ReplayKill[] = [];
  private shots: ReplayShot[] = [];
  private clip!: HighlightClip;
  private t = 0; // replay clock (match-time seconds)
  private frameIdx = 0;
  private nextShotIdx = 0;
  private nextKillIdx = 0;
  private taunts: ReplayTaunt[] = [];
  private nextTauntIdx = 0;
  private profiles = new Map<string, ReplayActorProfile>();
  // Each actor's running killstreak this life (drives the gun's killstreak sheen).
  private streaks = new Map<string, number>();
  private wasVisible = new Map<string, boolean>();
  // Footsteps / jumps / lands from observed motion: the star's (centred, own
  // body) and everyone else's (positional).
  private starMotion = new MotionTracker((kind, x, y, z, s) => {
    this.deps.sfx?.move(kind, x, y, z, s, true);
    this.deps.onStarEvent?.(kind, s);
  });
  private otherMotion = new MotionTracker((kind, x, y, z, s) => this.deps.sfx?.move(kind, x, y, z, s, false));
  private starVel = { x: 0, z: 0 };
  private lastStar = { x: 0, z: 0 };
  private lastStarValid = false;
  private camPos = new THREE.Vector3();
  private camYaw = 0;
  private camPitch = 0;
  private tmpPose: Record<string, ReplayPose> = {};
  // Slow-mo + freeze state.
  private timeScale = 1;
  private freezeSec = 0;
  private frozen = false;
  private holdRemaining = 0;
  private wallElapsed = 0; // real (wall-clock) seconds since the clip started
  private totalWallSec = 0; // wall-clock length incl. slow-mo + the freeze hold
  // Full-run rewatch state (unused by the cinematic PoM segments).
  private holdAtEnd = false;
  private paused = false;
  private atEnd = false;
  private seekSnap = false;
  done = false;

  constructor(private deps: ReplayDeps) {}

  // Wall-clock progress (accounts for slow-mo + freeze) — drives the overlay
  // progress bar and the HUD countdown.
  get totalWall(): number {
    return this.totalWallSec;
  }
  get wallRemaining(): number {
    return Math.max(0, this.totalWallSec - this.wallElapsed);
  }
  // True once the clip has reached its end and is holding on the frozen frame
  // (the cinematic pause — used as the VICTORY/DEFEAT beat for the finale).
  get isFrozen(): boolean {
    return this.frozen;
  }

  // ── Full-run rewatch controls (the standalone ReplayViewer) ──
  get currentT(): number { return this.t; }
  get clipStartT(): number { return this.clip?.startT ?? 0; }
  get clipEndT(): number { return this.clip?.endT ?? 0; }
  get isPaused(): boolean { return this.paused; }
  get reachedEnd(): boolean { return this.atEnd; }
  get speed(): number { return this.timeScale; }
  // The star's camera orientation + horizontal speed, for the first-person
  // viewmodel's sway / bob (the game feeds these to its viewmodel motion).
  get camYawNow(): number { return this.camYaw; }
  get camPitchNow(): number { return this.camPitch; }
  get starGroundSpeed(): number { return Math.hypot(this.starVel.x, this.starVel.z); }

  pause() { this.paused = true; }
  resume() {
    // Resuming from the very end restarts the run from the top (replay button).
    if (this.atEnd) this.seek(this.clip.startT);
    this.paused = false;
  }
  togglePause() { if (this.paused) this.resume(); else this.pause(); }
  setSpeed(s: number) { this.timeScale = s > 0 ? s : 1; }

  // Jump to an absolute match-time (seconds), clamped to the clip window. Resets
  // the frame + event cursors so playback resumes cleanly from there, and snaps
  // the camera (no long slide from the old vantage).
  seek(time: number) {
    const t = Math.max(this.clip.startT, Math.min(this.clip.endT, time));
    this.t = t;
    this.atEnd = t >= this.clip.endT - 1e-4;
    this.frameIdx = 0; // sampleAll re-advances forward from 0
    this.nextShotIdx = firstAtOrAfter(this.shots, t);
    this.nextKillIdx = firstAtOrAfter(this.kills, t);
    this.nextTauntIdx = firstAtOrAfter(this.taunts, t);
    this.seekSnap = true;
    this.starMotion.clear();
    this.otherMotion.clear();
    this.wasVisible.clear();
    this.recomputeStreaks(t);
  }

  // Every actor's killstreak as of match-time `time` (kills since their last death).
  private recomputeStreaks(time: number) {
    this.streaks.clear();
    for (const k of this.kills) {
      if (k.t >= time) break;
      this.streaks.set(k.killerId, (this.streaks.get(k.killerId) ?? 0) + 1);
      this.streaks.delete(k.victimId);
    }
    for (const [id, actor] of this.actors) actor.setStreak(this.streaks.get(id) ?? 0);
  }

  // The finisher a killer's frag plays: their recorded Look, else the caller's
  // lookup (profiles recorded without looks), else the default.
  private finisherOf(killerId: string): KillEffectStyle {
    const d = this.profiles.get(killerId)?.looks?.finisher?.d;
    if (d && isKillEffectStyle(d)) return d;
    return this.deps.finisherFor?.(killerId) ?? DEFAULT_KILL_EFFECT;
  }

  // The running multi-kill count of the killer of kills[idx]: how many of their
  // kills chain back within the multi-kill window.
  private chainOf(idx: number): number {
    const id = this.kills[idx].killerId;
    let chain = 1;
    let lastT = this.kills[idx].t;
    for (let i = idx - 1; i >= 0; i--) {
      const k = this.kills[i];
      if (lastT - k.t > MULTIKILL_WINDOW_SEC) break;
      if (k.killerId !== id) continue;
      chain++;
      lastT = k.t;
    }
    return chain;
  }

  start(clip: HighlightClip, src: ReplaySource, opts: ReplayOptions = {}) {
    this.clip = clip;
    this.frames = src.frames;
    this.kills = src.kills;
    this.shots = src.shots;
    this.taunts = src.taunts ?? [];
    this.profiles = src.profiles;
    this.t = clip.startT;
    this.timeScale = opts.timeScale && opts.timeScale > 0 ? opts.timeScale : 1;
    this.freezeSec = Math.max(0, opts.freezeSec ?? 0);
    this.holdAtEnd = opts.holdAtEnd === true;
    this.totalWallSec = (clip.endT - clip.startT) / this.timeScale + this.freezeSec;

    // Only build actors that actually appear (visible) in the clip window, or
    // are kill participants — avoids spawning ghosts for players long gone. The
    // star is skipped: we ride their eyes (first person), so their own body is
    // never on camera.
    const present = new Set<string>();
    for (const f of this.frames) {
      if (f.t < clip.startT || f.t > clip.endT) continue;
      for (const id in f.poses) if (f.poses[id].visible) present.add(id);
    }
    for (const k of clip.kills) {
      present.add(k.killerId);
      present.add(k.victimId);
    }
    present.delete(clip.starId);

    for (const [id, profile] of src.profiles) {
      if (!present.has(id)) continue;
      const actor = new RemotePlayer(id, profile.name, this.deps.scene, this.deps.botModel);
      actor.team = profile.team;
      if (profile.team != null && TEAM_COLORS[profile.team]) {
        actor.setTeamColor(TEAM_COLORS[profile.team]);
      }
      // Seed cosmetics with one apply() at the actor's first pose so the hat /
      // unusual / name-color install; snap() drives every frame after that.
      const first = this.poseAt(id, clip.startT) ?? ZERO_POSE;
      actor.apply(seedSnapshot(profile, first), 0);
      actor.group.visible = false;
      this.actors.set(id, actor);
    }

    // Seek event cursors to the clip start (skip everything before it).
    while (this.nextShotIdx < this.shots.length && this.shots[this.nextShotIdx].t < clip.startT) {
      this.nextShotIdx++;
    }
    while (this.nextKillIdx < this.kills.length && this.kills[this.nextKillIdx].t < clip.startT) {
      this.nextKillIdx++;
    }
    this.nextTauntIdx = firstAtOrAfter(this.taunts, clip.startT);
    this.recomputeStreaks(clip.startT);

    // Seed the camera in the star's eyes so it doesn't snap on the first frame.
    const star = this.poseAt(clip.starId, clip.startT);
    if (star) this.placeFirstPersonCam(star, true);
  }

  update(dt: number) {
    if (this.done) return;
    this.lastDt = dt;
    this.wallElapsed += dt;
    if (this.frozen) {
      // Holding on the final frame (the cinematic pause): keep rendering the
      // last pose but stop advancing the clock and spawning events.
      this.holdRemaining -= dt;
      if (this.holdRemaining <= 0) this.done = true;
    } else if (!this.paused) {
      this.t += dt * this.timeScale; // slow motion when timeScale < 1
      if (this.t >= this.clip.endT) {
        this.t = this.clip.endT;
        if (this.holdAtEnd) {
          // Full-run rewatch: stop at the end and hold so the viewer can scrub
          // back or replay — never auto-dispose.
          this.paused = true;
          this.atEnd = true;
        } else if (this.freezeSec > 0) {
          this.frozen = true;
          this.holdRemaining = this.freezeSec;
        } else {
          this.done = true;
          return;
        }
      }
    }

    // Sample poses at the current replay time and drive every actor. This
    // frame's victims are tagged with their killer's finisher first, so the
    // snap that hides (gibs) them plays the right death.
    const advancing = !this.frozen && !this.paused && !this.seekSnap;
    const poses = this.sampleAll();
    for (let i = this.nextKillIdx; i < this.kills.length && this.kills[i].t <= this.t; i++) {
      const k = this.kills[i];
      const victim = this.actors.get(k.victimId);
      if (victim) victim.replayFinisher = this.finisherOf(k.killerId);
    }
    for (const [id, actor] of this.actors) {
      const pose = poses[id] ?? ZERO_POSE;
      // A hidden → visible flip on a live clock is a respawn: play their own
      // spawn-in effect (cosmetic; first sight / a seek never triggers it).
      const was = this.wasVisible.get(id);
      if (advancing && was === false && pose.visible) {
        this.deps.spawnIn?.(new THREE.Vector3(pose.x, pose.y, pose.z), actor.equippedSpawnEffect);
      }
      this.wasVisible.set(id, pose.visible);
      actor.snap(pose, dt);
    }

    // Taunts that started in this slice of time: the emote clip + its aura.
    while (this.nextTauntIdx < this.taunts.length && this.taunts[this.nextTauntIdx].t <= this.t) {
      const tn = this.taunts[this.nextTauntIdx++];
      const actor = this.actors.get(tn.actorId);
      if (actor && (poses[tn.actorId]?.visible ?? false)) {
        const kind = emoteKindOfLook(tn.look);
        actor.playTaunt(kind, tn.look, emoteClip(kind).duration);
      }
    }

    // Footsteps / jumps / lands from observed motion (live clock only).
    if (advancing) {
      for (const id in poses) {
        const p = poses[id];
        (id === this.clip.starId ? this.starMotion : this.otherMotion).sample(id, p.x, p.y, p.z, this.t, p.visible);
      }
    }
    // The star's ground speed (viewmodel bob), measured from the sampled poses.
    const sp = poses[this.clip.starId];
    if (sp) {
      if (advancing && this.lastStarValid && dt > 1e-4) {
        const k = 1 - Math.exp(-14 * dt);
        this.starVel.x += ((sp.x - this.lastStar.x) / (dt * this.timeScale) - this.starVel.x) * k;
        this.starVel.z += ((sp.z - this.lastStar.z) / (dt * this.timeScale) - this.starVel.z) * k;
      } else if (!advancing) {
        this.starVel.x = 0;
        this.starVel.z = 0;
      }
      this.lastStar.x = sp.x;
      this.lastStar.z = sp.z;
      this.lastStarValid = !this.seekSnap;
    }

    // Replay rail beams (only the local player's + bots' are known client-side).
    const reduced = this.deps.reducedEffects();
    while (this.nextShotIdx < this.shots.length && this.shots[this.nextShotIdx].t <= this.t) {
      const s = this.shots[this.nextShotIdx++];
      this.deps.spawnBeam(s.origin, s.end);
      if (!reduced) this.deps.spawnMuzzleFlash(s.origin);
      const star = s.killerId === this.clip.starId;
      if (star) this.deps.onStarEvent?.('fire', 0);
      // A shot that killed (a kill by the same shooter within a tick) is voiced by
      // the frag's gib; only a miss gets the wall impact.
      const lethal = this.kills.some((k) => k.killerId === s.killerId && Math.abs(k.t - s.t) < 0.12);
      this.deps.sfx?.shot(s, star, lethal);
    }

    // Replay kill bursts at the victim's recorded position.
    while (this.nextKillIdx < this.kills.length && this.kills[this.nextKillIdx].t <= this.t) {
      const idx = this.nextKillIdx++;
      const k = this.kills[idx];
      const finisher = this.finisherOf(k.killerId);
      const vp = poses[k.victimId] ?? this.poseAt(k.victimId, k.t);
      const isStarKill = k.killerId === this.clip.starId;
      const chain = isStarKill ? this.chainOf(idx) : 1;
      if (vp) {
        const at = new THREE.Vector3(vp.x, vp.y + 0.9, vp.z);
        this.deps.spawnKillEffect(at, k.headshot, k.killerId, finisher);
        this.deps.sfx?.kill({ x: at.x, y: at.y, z: at.z }, k, finisher, isStarKill, chain);
      }
      // Killstreaks: the killer's climbs, the victim's resets — on the gun sheen.
      const n = (this.streaks.get(k.killerId) ?? 0) + 1;
      this.streaks.set(k.killerId, n);
      this.streaks.delete(k.victimId);
      this.actors.get(k.killerId)?.setStreak(n);
      this.actors.get(k.victimId)?.setStreak(0);
      // A kill BY the star we're spectating → flash a hit-marker on the crosshair.
      if (isStarKill) this.deps.onStarKill?.(k.headshot, chain);
    }

    // First-person camera riding the star's eyes (snap on the frame after a seek
    // so the view jumps to the new vantage instead of sliding across the map).
    const star = poses[this.clip.starId] ?? this.poseAt(this.clip.starId, this.t);
    if (star) this.placeFirstPersonCam(star, this.seekSnap);
    this.seekSnap = false;
  }

  dispose() {
    for (const actor of this.actors.values()) actor.dispose(this.deps.scene);
    this.actors.clear();
    this.done = true;
  }

  // ── internals ──

  private placeFirstPersonCam(star: ReplayPose, immediate: boolean) {
    // Sit in the star's eyes and face exactly where they were looking — same
    // eye height and YXZ orientation the live first-person camera uses.
    const eyeX = star.x;
    const eyeY = star.y + EYE_HEIGHT;
    const eyeZ = star.z;
    if (immediate) {
      this.camPos.set(eyeX, eyeY, eyeZ);
      this.camYaw = star.yaw;
      this.camPitch = star.pitch;
    } else {
      const dt = this.lastDt;
      const ap = 1 - Math.exp(-EYE_POS_SMOOTH * dt);
      const al = 1 - Math.exp(-EYE_LOOK_SMOOTH * dt);
      this.camPos.x += (eyeX - this.camPos.x) * ap;
      this.camPos.y += (eyeY - this.camPos.y) * ap;
      this.camPos.z += (eyeZ - this.camPos.z) * ap;
      this.camYaw = lerpAngle(this.camYaw, star.yaw, al);
      this.camPitch += (star.pitch - this.camPitch) * al;
    }
    this.deps.camera.position.copy(this.camPos);
    this.deps.camera.rotation.set(this.camPitch, this.camYaw, 0, 'YXZ');
  }

  private lastDt = 1 / 60;

  // Sample every present actor's pose at the current replay time, reusing a
  // scratch object to avoid per-frame allocation.
  private sampleAll(): Record<string, ReplayPose> {
    // Advance the frame cursor to the pair straddling `t`.
    while (this.frameIdx < this.frames.length - 1 && this.frames[this.frameIdx + 1].t <= this.t) {
      this.frameIdx++;
    }
    const f0 = this.frames[this.frameIdx];
    const f1 = this.frames[Math.min(this.frameIdx + 1, this.frames.length - 1)];
    const span = f1.t - f0.t;
    const alpha = span > 1e-6 ? Math.max(0, Math.min(1, (this.t - f0.t) / span)) : 0;

    const out = this.tmpPose;
    const fm = this.frames[Math.max(0, this.frameIdx - 1)];
    const f2 = this.frames[Math.min(this.frames.length - 1, this.frameIdx + 2)];
    for (const id of this.actors.keys()) {
      out[id] = cubicPose(fm.poses[id], f0.poses[id], f1.poses[id], f2.poses[id], alpha);
    }
    // The star isn't an actor (we ride their eyes) but is sampled the same way.
    const sid = this.clip.starId;
    out[sid] = cubicPose(fm.poses[sid], f0.poses[sid], f1.poses[sid], f2.poses[sid], alpha);
    return out;
  }

  // Pose of one actor at an arbitrary match-time (binary-search the frames).
  private poseAt(id: string, time: number): ReplayPose | null {
    const fr = this.frames;
    if (fr.length === 0) return null;
    let lo = 0;
    let hi = fr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fr[mid].t < time) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const f0 = fr[i - 1];
    const f1 = fr[i];
    const span = f1.t - f0.t;
    const alpha = span > 1e-6 ? Math.max(0, Math.min(1, (time - f0.t) / span)) : 0;
    return blendPose(f0.poses[id], f1.poses[id], alpha);
  }
}

// Catmull-Rom through four consecutive 30 Hz samples (p1→p2 is the span being
// played): position and look angles are C1-continuous, so the first-person
// camera (and actors) glide instead of changing velocity at every sample. Falls
// back to the linear blend across visibility flips, respawn teleports and gaps.
function cubicPose(
  p0: ReplayPose | undefined,
  p1: ReplayPose | undefined,
  p2: ReplayPose | undefined,
  p3: ReplayPose | undefined,
  t: number,
): ReplayPose {
  if (!p0 || !p1 || !p2 || !p3 || !p0.visible || !p1.visible || !p2.visible || !p3.visible) return blendPose(p1, p2, t);
  const jump = (a: ReplayPose, b: ReplayPose) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) > 6;
  if (jump(p0, p1) || jump(p1, p2) || jump(p2, p3)) return blendPose(p1, p2, t);
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const unwrap = (a: number, ref: number) => {
    let d = a - ref;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return ref + d;
  };
  const y1 = p1.yaw;
  return {
    x: cr(p0.x, p1.x, p2.x, p3.x),
    y: cr(p0.y, p1.y, p2.y, p3.y),
    z: cr(p0.z, p1.z, p2.z, p3.z),
    yaw: cr(unwrap(p0.yaw, y1), y1, unwrap(p2.yaw, y1), unwrap(p3.yaw, y1)),
    pitch: cr(p0.pitch, p1.pitch, p2.pitch, p3.pitch),
    visible: true,
  };
}

function blendPose(a: ReplayPose | undefined, b: ReplayPose | undefined, alpha: number): ReplayPose {
  if (a && b) {
    return {
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
      z: a.z + (b.z - a.z) * alpha,
      yaw: lerpAngle(a.yaw, b.yaw, alpha),
      pitch: a.pitch + (b.pitch - a.pitch) * alpha,
      visible: alpha < 0.5 ? a.visible : b.visible,
    };
  }
  const p = b ?? a;
  if (!p) return ZERO_POSE;
  return { ...p };
}

const ZERO_POSE: ReplayPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, visible: false };

function seedSnapshot(profile: ReplayActorProfile, pose: ReplayPose): RemotePlayerSnapshot {
  return {
    id: profile.id,
    name: profile.name,
    pos: { x: pose.x, y: pose.y, z: pose.z },
    yaw: pose.yaw,
    pitch: pose.pitch,
    frags: 0,
    deaths: 0,
    invulnMs: 0,
    team: profile.team,
    hat: profile.hat,
    looks: profile.looks,
    unusual: profile.unusual,
    emote: 'emote.cheer',
    nameColor: profile.nameColor,
    spawnEffect: 'spawn.beam',
    title: 'title.none',
    railColor: 'rail.cyan',
    railgunFinish: 'gun.stock',
    crosshair: '',
    ping: 0,
    admin: false,
    verified: false,
    receivedAt: 0,
  };
}
