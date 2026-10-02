import * as THREE from 'three';
import { playUi } from '../audio';
import { EYE_HEIGHT } from '../constants';
import type { KillEffectStyle } from '../cosmetics';
import type { ArenaMap } from '../map';
import type { AABB, TrainingChallengeHud, TrainingHud, TrainingPopHud, TrainingResultHud, Vec3 } from '../types';
import type { RailTarget } from '../weapon';
import { TrainingBests, type GhostRecord, type RunRecord } from './best';
import { GateFrames, Ghost } from './course-fx';
import type { ChallengeId, TrainingLayout } from './layout';
import { Label, PadSign, type SignText } from './signs';
import { StraferSquad } from './strafers';
import { TargetField } from './targets';

// ─────────────────────────────────────────────────────────────────────────
// The training range: free practice plus four challenges you start by
// standing on a pad in the hub (Titanfall 2 Gauntlet / Valorant range /
// Quake defrag inspired):
//   Flick     40 s, pop-up targets across the gallery, fast 0.3 s rail
//   Strafers  45 s, player models strafing + hopping along lanes, real cooldown
//   Course    time trial through the checkpoint gates, race your ghost
//   Gauntlet  the course with targets along it, +2 s per target left up
// Free practice (no challenge): static targets on the gallery anchors and
// no rail cooldown, so flicks can be drilled back to back.
// Everything is local: bests + ghosts live in localStorage (best.ts); nothing
// is reported to the server.
// ─────────────────────────────────────────────────────────────────────────

type Def = { name: string; kind: 'aim' | 'race'; duration: number; accent: string; rules: string };

export const CHALLENGES: Record<ChallengeId, Def> = {
  flick: { name: 'Flick', kind: 'aim', duration: 40, accent: '#ffb347', rules: '40 s · pop-up targets · fast rail' },
  strafers: { name: 'Strafers', kind: 'aim', duration: 45, accent: '#ff6fe0', rules: '45 s · strafing players · real rail' },
  course: { name: 'Course', kind: 'race', duration: 240, accent: '#5cf2ff', rules: 'Time trial · race your best ghost' },
  gauntlet: { name: 'Gauntlet', kind: 'race', duration: 240, accent: '#43f0a8', rules: 'Course + targets · +2 s per target left' },
};

const COUNTDOWN = 3;
const PAD_HOLD = 0.45; // seconds standing on a pad before it starts
const FLICK_UP = 2; // targets up at once in Flick
const FLICK_LIFE = 2.4;
// Flick drills the flick, not the wait: a 0.3 s rail (the real one is 1.2 s).
const FLICK_COOLDOWN = 0.3;
const STRAFERS_UP = 3;
const STRAFER_RESPAWN = 0.35;
const GAUNTLET_PENALTY = 2;
const GHOST_STEP = 0.05;
const RESULT_SECONDS = 9;
const NOTICE_SECONDS = 3.5;
const POP_SECONDS = 1.3; // the .hud-xp popup animation length

export type TrainingPlayer = { pos: Vec3; onGround: boolean };
export type TrainingTeleport = { pos: Vec3; yaw: number };

type Run = {
  id: ChallengeId;
  phase: 'countdown' | 'running';
  countdown: number;
  t: number;
  hits: number;
  shots: number;
  landed: number;
  gate: number;
  splits: number[];
  ghost: number[];
  ghostAcc: number;
  strafeQueue: number[]; // pending strafer respawns (seconds left)
  lastFlick: THREE.Vector3 | null;
  streak: number; // kills in a row without a miss (or a timed-out flick)
  bestStreak: number;
  missed: number; // flick targets that timed out
  reactSum: number; // flick: summed seconds from pop-up to kill
  reactN: number;
};

const inBox = (p: Vec3, b: AABB, pad = 0) =>
  p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.z >= b.min.z - pad && p.z <= b.max.z + pad && p.y >= b.min.y - pad && p.y <= b.max.y + pad;

export class TrainingRange {
  private readonly field: TargetField;
  private readonly strafers: StraferSquad;
  private readonly bests = new TrainingBests();
  private readonly signs = new Map<ChallengeId, PadSign>();
  private readonly labels: Label[] = [];
  private readonly gates: GateFrames;
  private readonly ghost: Ghost;
  private run: Run | null = null;
  private lastId: ChallengeId | null = null;
  private padId: ChallengeId | null = null;
  private padHold = 0;
  private padLatch = true; // you spawn next to the pads: no start until you step onto one
  private result: TrainingResultHud | null = null;
  private resultAge = 0;
  private resultKey = 0;
  private notice: string | null = null;
  private noticeAge = 0;
  private free = { shots: 0, hits: 0, destroyed: 0, streak: 0, bestStreak: 0, elapsed: 0 };
  private shotLanded = false; // the current shot has hit at least one target
  private shotKills = 0; // targets the current shot has killed
  private shotCount = 0; // bumps per landed shot (the popup's key)
  private pop: TrainingPopHud | null = null;
  private popAge = 0;
  private freeTargetsUp = false;

  constructor(
    private scene: THREE.Scene,
    _map: ArenaMap,
    private layout: TrainingLayout,
  ) {
    this.field = new TargetField(scene);
    this.strafers = new StraferSquad(scene);
    this.gates = new GateFrames(scene, layout.course.gates);
    this.ghost = new Ghost(scene);
    for (const id of Object.keys(CHALLENGES) as ChallengeId[]) {
      const pad = layout.pads[id];
      this.signs.set(id, new PadSign(scene, { x: pad.center.x, y: pad.center.y + 2.7, z: pad.center.z }, this.signText(id)));
    }
    for (const m of layout.gallery.markers) {
      // Low over the floor bar: below every target, so it never sits in a sightline.
      this.labels.push(new Label(scene, { x: m.at.x, y: m.at.y + 0.32, z: m.at.z }, `${m.metres} m`, '#ffd08a', 1.1));
    }
    this.showFreeTargets(true);
  }

  // ── signs ───────────────────────────────────────────────────────────────
  private signText(id: ChallengeId): SignText {
    const def = CHALLENGES[id];
    const best = this.bests.best(id);
    let foot: string;
    if (def.kind === 'race') {
      const par = `par ${this.layout.course.par} s`;
      foot = best ? `Best ${best.score.toFixed(2)} s · ${par}` : `No time yet · ${par}`;
    } else {
      const landed = best ? Math.min(best.hits, best.landed ?? best.hits) : 0;
      foot = best ? `Best ${best.score} hits · ${best.shots ? Math.round((landed / best.shots) * 100) : 0}%` : 'No score yet';
    }
    return { title: def.name, sub: def.rules, foot, accent: def.accent };
  }

  // ── free practice ───────────────────────────────────────────────────────
  private showFreeTargets(on: boolean) {
    if (on === this.freeTargetsUp) return;
    this.freeTargetsUp = on;
    if (!on) {
      this.field.clear(['static']);
      return;
    }
    // Every other anchor, so near and far, low and high all stay covered.
    this.layout.gallery.anchors.forEach((a, i) => {
      if (i % 2 === 0) this.field.spawnStatic(a);
    });
  }

  // ── challenge lifecycle ─────────────────────────────────────────────────
  private start(id: ChallengeId): TrainingTeleport {
    this.clearRun();
    const def = CHALLENGES[id];
    this.run = {
      id, phase: 'countdown', countdown: COUNTDOWN, t: 0, hits: 0, shots: 0, landed: 0, gate: 0,
      splits: [], ghost: [], ghostAcc: 0, strafeQueue: [], lastFlick: null,
      streak: 0, bestStreak: 0, missed: 0, reactSum: 0, reactN: 0,
    };
    this.lastId = id;
    this.padLatch = true;
    this.result = null;
    this.notice = null;
    this.pop = null;
    this.showFreeTargets(false);
    playUi('countdownTick', COUNTDOWN + 1);
    if (def.kind === 'race') {
      this.gates.progress(0);
      if (id === 'gauntlet') for (const t of this.layout.course.targets) this.field.spawnGauntlet(t);
      const g = this.bests.ghost(id);
      this.ghost.play(g);
      this.ghost.at(0, this.layout.course.start);
      return { pos: { ...this.layout.course.start }, yaw: this.layout.course.startYaw };
    }
    return { pos: { ...this.layout.gallery.start }, yaw: this.layout.gallery.startYaw };
  }

  private clearRun() {
    this.field.clear(['flick', 'gauntlet']);
    this.strafers.clear();
    this.gates.setAll('idle');
    this.ghost.stop();
    this.run = null;
  }

  private cancel(reason: string) {
    this.clearRun();
    this.say(reason);
    this.showFreeTargets(true);
  }

  private say(text: string) {
    this.notice = text;
    this.noticeAge = 0;
  }

  private finish() {
    const r = this.run;
    if (!r) return;
    const def = CHALLENGES[r.id];
    const left = r.id === 'gauntlet' ? this.field.count('gauntlet') : 0;
    const penalty = left * GAUNTLET_PENALTY;
    const score = def.kind === 'race' ? Math.round((r.t + penalty) * 100) / 100 : r.hits;
    const record: RunRecord = { score, hits: r.hits, shots: r.shots, landed: r.landed, penalty, at: Date.now() };
    const ghost: GhostRecord | undefined =
      def.kind === 'race' ? { step: GHOST_STEP, xyz: r.ghost, splits: r.splits } : undefined;
    const prev = this.bests.best(r.id);
    const newBest = this.bests.submit(r.id, record, ghost);
    this.result = {
      key: ++this.resultKey,
      id: r.id,
      name: def.name,
      kind: def.kind,
      score,
      hits: r.hits,
      shots: r.shots,
      landed: r.landed,
      penalty,
      avgMs: r.id === 'flick' && r.reactN ? Math.round((r.reactSum / r.reactN) * 1000) : null,
      missed: r.id === 'flick' ? r.missed : null,
      bestStreak: r.bestStreak,
      best: prev ? prev.score : null,
      newBest,
    };
    this.resultAge = 0;
    playUi('stamp', 1);
    if (newBest) playUi('unlock', 3);
    this.signs.get(r.id)?.set(this.signText(r.id));
    this.clearRun();
    this.showFreeTargets(true);
  }

  // Start a challenge directly (QA / dev tools; players use the pads).
  begin(id: ChallengeId): TrainingTeleport {
    return this.start(id);
  }

  // R: restart the running challenge, retry the one whose result is still on
  // screen, otherwise back to the hub.
  restart(): TrainingTeleport {
    const id = this.run?.id ?? (this.result ? this.lastId : null);
    if (id) return this.start(id);
    return { pos: { ...this.layout.hub.spawn }, yaw: this.layout.hub.yaw };
  }

  // ── per tick ────────────────────────────────────────────────────────────
  // Returns a teleport when a challenge starts from a pad.
  update(dt: number, player: TrainingPlayer): TrainingTeleport | null {
    const expired = this.field.update(dt);
    this.strafers.update(dt, { x: player.pos.x, y: player.pos.y + EYE_HEIGHT, z: player.pos.z });
    if (this.pop) {
      this.popAge += dt;
      if (this.popAge > POP_SECONDS) this.pop = null;
    }
    if (this.result) {
      this.resultAge += dt;
      if (this.resultAge > RESULT_SECONDS) this.result = null;
    }
    if (this.notice) {
      this.noticeAge += dt;
      if (this.noticeAge > NOTICE_SECONDS) this.notice = null;
    }
    const r = this.run;
    if (!r) {
      this.free.elapsed += dt;
      return this.padCheck(dt, player);
    }
    const def = CHALLENGES[r.id];
    if (r.phase === 'countdown') {
      const before = Math.ceil(r.countdown);
      r.countdown -= dt;
      const after = Math.ceil(r.countdown);
      if (after !== before && after > 0) playUi('countdownTick', after + 1);
      if (r.countdown <= 0) {
        r.phase = 'running';
        playUi('countdownTick', 1);
      }
      return null;
    }
    r.t += dt;
    if (expired && r.id === 'flick') {
      // A target that timed out is a miss: it breaks the streak.
      r.missed += expired;
      r.streak = 0;
    }
    if (def.kind === 'aim') {
      const fl = this.layout.gallery.firingLine;
      const onLine =
        player.pos.x >= fl.min.x - 1 && player.pos.x <= fl.max.x + 1 &&
        player.pos.z >= fl.min.z - 1 && player.pos.z <= fl.max.z + 1 &&
        player.pos.y >= fl.min.y - 1.5 && player.pos.y <= fl.max.y + 3;
      if (!onLine) {
        this.cancel('Left the firing line — challenge cancelled');
        return null;
      }
      if (r.id === 'flick') this.tickFlick(r);
      else this.tickStrafers(r, dt);
      if (r.t >= def.duration) this.finish();
      return null;
    }
    // Race: ghost sample + gates.
    r.ghostAcc += dt;
    while (r.ghostAcc >= GHOST_STEP) {
      r.ghostAcc -= GHOST_STEP;
      r.ghost.push(Math.round(player.pos.x * 100) / 100, Math.round(player.pos.y * 100) / 100, Math.round(player.pos.z * 100) / 100);
    }
    this.ghost.at(r.t, player.pos);
    const gates = this.layout.course.gates;
    const g = gates[r.gate];
    if (g && inBox(player.pos, g, 0.15)) {
      r.splits.push(r.t);
      r.gate += 1;
      if (r.gate >= gates.length) {
        this.finish();
        return null;
      }
      playUi('xpTick', r.gate);
      this.gates.progress(r.gate);
    }
    if (r.t >= def.duration) this.cancel('Out of time — run cancelled');
    return null;
  }

  private padCheck(dt: number, player: TrainingPlayer): TrainingTeleport | null {
    let on: ChallengeId | null = null;
    for (const id of Object.keys(CHALLENGES) as ChallengeId[]) {
      const pad = this.layout.pads[id];
      const hx = pad.size[0] / 2;
      const hz = pad.size[1] / 2;
      if (
        Math.abs(player.pos.x - pad.center.x) <= hx && Math.abs(player.pos.z - pad.center.z) <= hz &&
        Math.abs(player.pos.y - pad.center.y) < 0.6 && player.onGround
      ) {
        on = id;
        break;
      }
    }
    if (!on) {
      this.padLatch = false;
      this.padId = null;
      this.padHold = 0;
      return null;
    }
    if (this.padLatch) return null;
    if (on !== this.padId) {
      this.padId = on;
      this.padHold = 0;
    }
    this.padHold += dt;
    return this.padHold >= PAD_HOLD ? this.start(on) : null;
  }

  private tickFlick(r: Run) {
    const anchors = this.layout.gallery.anchors;
    let guard = 0;
    while (this.field.count('flick') < FLICK_UP && guard++ < 12) {
      const busy = this.field.occupied('flick');
      const a = anchors[Math.floor(Math.random() * anchors.length)];
      const p = new THREE.Vector3(a.x, a.y, a.z);
      if (busy.some((b) => b.distanceTo(p) < 3)) continue;
      // Make the next one a real flick away from the last spot.
      if (r.lastFlick && r.lastFlick.distanceTo(p) < 7 && guard < 10) continue;
      r.lastFlick = p;
      this.field.spawnFlick(a, FLICK_LIFE);
    }
  }

  private tickStrafers(r: Run, dt: number) {
    const lanes = this.layout.gallery.strafeLanes;
    r.strafeQueue = r.strafeQueue.map((s) => s - dt).filter((s) => s > 0);
    let need = Math.min(STRAFERS_UP, lanes.length) - this.strafers.count() - r.strafeQueue.length;
    while (need-- > 0) {
      // A lane nobody is on; a respawn prefers a different lane.
      const busy = new Set(this.strafers.tags());
      const free = lanes.map((_, i) => i).filter((i) => !busy.has(String(i)));
      const pool = free.length ? free : lanes.map((_, i) => i);
      const i = pool[Math.floor(Math.random() * pool.length)];
      const ln = lanes[i];
      // Faster on the far lanes, so the angular speed stays comparable.
      const dist = Math.hypot((ln.a.x + ln.b.x) / 2 - this.layout.gallery.start.x, (ln.a.z + ln.b.z) / 2 - this.layout.gallery.start.z);
      if (!this.strafers.spawn(ln.a, ln.b, 5.5 + Math.min(4, dist / 12), String(i))) break; // every body busy: next tick
    }
  }

  // ── firing ──────────────────────────────────────────────────────────────
  // No shooting during the 3-2-1.
  canFire(): boolean {
    return !this.run || this.run.phase === 'running';
  }

  // Free practice drops the rail cooldown; challenges use the real one.
  freeFire(): boolean {
    return !this.run;
  }

  // The rail cooldown for the next shot: Flick runs a fast rail, everything
  // else the real one (null).
  shotCooldown(): number | null {
    return this.run?.id === 'flick' ? FLICK_COOLDOWN : null;
  }

  targets(): RailTarget[] {
    return [...this.field.railTargets(), ...this.strafers.railTargets()];
  }

  registerShot() {
    this.shotLanded = false;
    this.shotKills = 0;
    if (this.run) this.run.shots += 1;
    else this.free.shots += 1;
  }

  registerMiss() {
    if (this.run) this.run.streak = 0;
    else this.free.streak = 0;
  }

  // A rail kill. Returns where the kill effect goes, and whether it counts as
  // a headshot (only the strafers' player-shaped bodies have a head).
  onHit(id: string, headshot: boolean, style?: KillEffectStyle): { pos: THREE.Vector3; headshot: boolean } | null {
    let pos: THREE.Vector3 | null;
    let age: number | null = null;
    let strafer = false;
    if (this.strafers.owns(id)) {
      pos = this.strafers.hit(id, style);
      strafer = true;
    } else {
      const hit = this.field.hit(id);
      pos = hit ? hit.pos : null;
      if (hit?.kind === 'flick') age = hit.age;
    }
    if (!pos) return null;
    headshot = strafer && headshot;
    const r = this.run;
    const first = !this.shotLanded; // accuracy counts shots, not targets
    this.shotLanded = true;
    this.shotKills += 1;
    if (first) this.shotCount += 1;
    let streak: number;
    if (r) {
      r.hits += 1;
      if (first) r.landed += 1;
      if (strafer) r.strafeQueue.push(STRAFER_RESPAWN);
      if (age !== null) {
        r.reactSum += age;
        r.reactN += 1;
      }
      r.streak += 1;
      if (r.streak > r.bestStreak) r.bestStreak = r.streak;
      streak = r.streak;
    } else {
      if (first) this.free.hits += 1;
      this.free.destroyed += 1;
      this.free.streak += 1;
      if (this.free.streak > this.free.bestStreak) this.free.bestStreak = this.free.streak;
      streak = this.free.streak;
    }
    // One popup per shot: a rail through two reads "+2".
    this.pop = {
      key: this.shotCount,
      label: this.shotKills > 1 ? `+${this.shotKills}` : headshot ? 'HEADSHOT' : '+1',
      ms: age !== null ? Math.round(age * 1000) : null,
      streak,
      headshot: headshot || (this.pop?.key === this.shotCount && this.pop.headshot),
    };
    this.popAge = 0;
    return { pos, headshot };
  }

  // ── HUD ─────────────────────────────────────────────────────────────────
  hud(): TrainingHud {
    const f = this.free;
    return {
      shots: f.shots,
      hits: f.hits,
      destroyed: f.destroyed,
      streak: f.streak,
      bestStreak: f.bestStreak,
      accuracy: f.shots > 0 ? f.hits / f.shots : 0,
      elapsed: f.elapsed,
      challenge: this.challengeHud(),
      result: this.result,
      notice: this.notice,
      pop: this.pop,
    };
  }

  private challengeHud(): TrainingChallengeHud | null {
    const r = this.run;
    if (!r) return null;
    const def = CHALLENGES[r.id];
    const best = this.bests.best(r.id);
    const time = def.kind === 'aim' ? Math.max(0, def.duration - r.t) : r.t;
    let split: number | null = null;
    if (def.kind === 'race' && r.splits.length) {
      const g = this.bests.ghost(r.id);
      const ref = g?.splits[r.splits.length - 1];
      if (ref !== undefined) split = Math.round((r.splits[r.splits.length - 1] - ref) * 100) / 100;
    }
    return {
      id: r.id,
      name: def.name,
      kind: def.kind,
      phase: r.phase,
      countdown: Math.max(0, Math.ceil(r.countdown)),
      time: Math.floor(time * 10) / 10,
      hits: r.hits,
      shots: r.shots,
      landed: r.landed,
      gate: r.gate,
      gates: this.layout.course.gates.length,
      split,
      targetsLeft: r.id === 'gauntlet' ? this.field.count('gauntlet') : null,
      missed: r.id === 'flick' ? r.missed : null,
      streak: r.streak,
      best: best ? best.score : null,
    };
  }

  // True while the 3-2-1 holds the player on the start mark.
  get frozen(): boolean {
    return this.run?.phase === 'countdown';
  }

  dispose(scene: THREE.Scene) {
    this.clearRun();
    this.field.dispose();
    this.strafers.dispose();
    this.gates.dispose();
    this.ghost.dispose();
    for (const s of this.signs.values()) s.dispose(scene);
    for (const l of this.labels) l.dispose(scene);
    this.signs.clear();
    this.labels.length = 0;
  }
}
