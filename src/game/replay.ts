import * as THREE from 'three';
import { RemotePlayer } from './remote-player';
import type { BotModel } from './bots';
import type { RemotePlayerSnapshot } from './net';
import type { Vec3 } from './types';
import { EYE_HEIGHT, MULTIKILL_WINDOW_SEC, TEAM_COLORS } from './constants';

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

export type ReplayActorKind = 'local' | 'remote' | 'bot';

export type ReplayActorProfile = {
  id: string;
  name: string;
  kind: ReplayActorKind;
  hat: string;
  unusual: string;
  nameColor: string;
  team: number | null;
};

export type ReplayPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number; // look pitch (radians) — drives the first-person replay camera
  visible: boolean;
};

export type ReplayFrame = { t: number; poses: Record<string, ReplayPose> };

export type ReplayKill = {
  t: number;
  killerId: string;
  victimId: string;
  headshot: boolean;
  killerName: string;
  victimName: string;
};

export type ReplayShot = { t: number; origin: Vec3; end: Vec3; killerId: string };

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

  private clock = 0;
  private frameAccum = 0;

  get durationSec(): number {
    return this.clock;
  }

  // Capture this entity's static identity once (idempotent). Cosmetics are read
  // at first sight; they don't change mid-match.
  ensureProfile(p: ReplayActorProfile) {
    if (!this.profiles.has(p.id)) this.profiles.set(p.id, p);
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
    this.clock = 0;
    this.frameAccum = 0;
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
  spawnKillEffect: (at: THREE.Vector3, headshot: boolean) => void;
  reducedEffects: () => boolean;
  // Fired when the POV star (whose eyes we're in) scores a kill in the clip, so
  // the HUD can flash a hit-marker over the crosshair.
  onStarKill?: (headshot: boolean) => void;
};

// First-person replay camera: the clip is shown through the star's own eyes
// (like Overwatch's Play of the Game). Light exponential smoothing masks the
// 30Hz pose sampling without making the look feel laggy.
const EYE_POS_SMOOTH = 16; // exp smoothing rate for the eye position
const EYE_LOOK_SMOOTH = 20; // exp smoothing rate for yaw/pitch

// Replay playback options. `timeScale` < 1 plays the clip in slow motion;
// `freezeSec` holds on the final frame afterwards (the cinematic "pause").
export type ReplayOptions = { timeScale?: number; freezeSec?: number };

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
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

  start(clip: HighlightClip, rec: MatchRecorder, opts: ReplayOptions = {}) {
    this.clip = clip;
    this.frames = rec.frames;
    this.kills = rec.kills;
    this.shots = rec.shots;
    this.t = clip.startT;
    this.timeScale = opts.timeScale && opts.timeScale > 0 ? opts.timeScale : 1;
    this.freezeSec = Math.max(0, opts.freezeSec ?? 0);
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

    for (const [id, profile] of rec.profiles) {
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
    } else {
      this.t += dt * this.timeScale; // slow motion when timeScale < 1
      if (this.t >= this.clip.endT) {
        this.t = this.clip.endT;
        if (this.freezeSec > 0) {
          this.frozen = true;
          this.holdRemaining = this.freezeSec;
        } else {
          this.done = true;
          return;
        }
      }
    }

    // Sample poses at the current replay time and drive every actor.
    const poses = this.sampleAll();
    for (const [id, actor] of this.actors) {
      const pose = poses[id];
      actor.snap(pose ?? ZERO_POSE, dt);
    }

    // Replay rail beams (only the local player's + bots' are known client-side).
    const reduced = this.deps.reducedEffects();
    while (this.nextShotIdx < this.shots.length && this.shots[this.nextShotIdx].t <= this.t) {
      const s = this.shots[this.nextShotIdx++];
      this.deps.spawnBeam(s.origin, s.end);
      if (!reduced) this.deps.spawnMuzzleFlash(s.origin);
    }

    // Replay kill bursts at the victim's recorded position.
    while (this.nextKillIdx < this.kills.length && this.kills[this.nextKillIdx].t <= this.t) {
      const k = this.kills[this.nextKillIdx++];
      const vp = poses[k.victimId] ?? this.poseAt(k.victimId, k.t);
      if (vp) {
        this.deps.spawnKillEffect(new THREE.Vector3(vp.x, vp.y + 0.9, vp.z), k.headshot);
      }
      // A kill BY the star we're spectating → flash a hit-marker on the crosshair.
      if (k.killerId === this.clip.starId) this.deps.onStarKill?.(k.headshot);
    }

    // First-person camera riding the star's eyes.
    const star = poses[this.clip.starId] ?? this.poseAt(this.clip.starId, this.t);
    if (star) this.placeFirstPersonCam(star, false);
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
    for (const id of this.actors.keys()) {
      const a = f0.poses[id];
      const b = f1.poses[id];
      out[id] = blendPose(a, b, alpha);
    }
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
    unusual: profile.unusual,
    emote: 'emote.cheer',
    nameColor: profile.nameColor,
    spawnEffect: 'spawn.beam',
    ping: 0,
    admin: false,
    verified: false,
    receivedAt: 0,
  };
}
