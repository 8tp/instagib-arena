import { B } from './character/rig';
import { PoseSpec, SIDE_L, SIDE_R } from './character/pose';

// ── Procedural, velocity-driven locomotion for the arena combatant ───────────
//
// No clips: the gait is generated from the measured ground velocity so the
// feet never skate. A gait PHASE advances with distance travelled; each foot
// is either PLANTED (moving backward under the hips at exactly ground speed)
// or SWINGING forward along the travel direction with a lift arc. Foot
// targets feed the leg IK, so the same code produces forward runs, backpedals
// and strafes — the stride simply points along the velocity.
//
// Upper/lower split: the legs (hips) turn toward the travel direction
// (Q3-style: up to ±45° for strafes/diagonals, reversed for backpedals) while
// the chest counter-rotates to keep facing the aim; standing still, the feet
// stay put until the twist passes ~60°, then the legs step around.
//
// Layers blended on top: idle breathing + weight shift, airborne tuck/reach
// by air time and vertical speed, landing compression scaled by fall speed,
// a dash lunge, and a wall-jump kick. Every rate is frame-rate independent.
//
// All positions here are in the character's model space (root = feet,
// facing −Z, right = +X). The caller rotates the root by the aim yaw.

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const ANKLE_Y = 0.095;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
function wrapPi(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export type LocoInput = {
  dt: number;
  // Ground-plane velocity in MODEL space (m/s): x = right, z = back.
  vx: number;
  vz: number;
  speed: number; // smoothed horizontal speed
  vy: number; // vertical velocity (m/s)
  grounded: boolean;
  yawRate: number; // aim yaw rate (rad/s), for turn-in-place steps
  time: number; // free-running clock (s) for idle motion
};

// Tunables (exported for the pose lab).
export // Max whole-body (feet-pivot) lean — see the fairness note at the lean.
const ROOT_LEAN_MAX = 6 * DEG;
const GAIT = {
  idleSpeed: 0.8, // below this the gait blends to idle
  freqBase: 0.95, // Hz at 0 m/s
  freqPerMps: 0.17, // Hz per m/s  (10 m/s → 2.65 Hz ≈ 5.3 steps/s)
  freqMax: 3.4,
  dutyWalk: 0.58, // stance fraction
  dutyRun: 0.26,
  liftWalk: 0.1,
  liftRun: 0.34,
  width: 0.105,
  crouchRun: 0.05,
  bobWalk: 0.018,
  bobRun: 0.045,
  leanRun: 10 * DEG,
  twistMax: 60 * DEG, // idle upper/lower twist before the legs step around
};

export type FootfallListener = (side: 0 | 1, speed: number) => void;

export class Locomotion {
  // Public state (read by the animator / lab).
  phase = 0;
  legYaw = 0; // hips yaw relative to the aim (rad, about +Y)
  move = 0; // 0 idle … 1 moving (smoothed)
  air = 0; // 0 grounded … 1 airborne (smoothed)
  airT = 0; // seconds since takeoff
  land = 0; // current landing compression 0..1
  dash = 0; // dash lunge blend
  kick = 0; // wall-kick envelope
  footfalls = 0; // monotonically increasing count of foot plants
  onFootfall: FootfallListener | null = null;

  private strideX = 0; // smoothed stride direction in the LEG frame
  private strideZ = -1;
  private backpedal = 0; // 0 forward-facing legs … 1 backpedal
  private landT = -1;
  private landAmp = 0;
  private kickT = -1;
  private kickX = 0; // kick direction (model space)
  private kickZ = 0;
  private kickSide = SIDE_R;
  private stepping = 0; // idle turn-step blend
  private contact = [true, true];
  private launch = false;
  private vySmooth = 0;
  private speedS = 0;

  reset(): void {
    this.phase = 0;
    this.legYaw = 0;
    this.move = 0;
    this.air = 0;
    this.airT = 0;
    this.land = 0;
    this.dash = 0;
    this.kick = 0;
    this.landT = -1;
    this.kickT = -1;
    this.stepping = 0;
    this.backpedal = 0;
    this.strideX = 0;
    this.strideZ = -1;
    this.contact[0] = this.contact[1] = true;
    this.vySmooth = 0;
    this.speedS = 0;
  }

  // Events from the motion tracker.
  takeoff(launch: boolean): void {
    this.airT = 0;
    this.launch = launch;
    this.landT = -1;
  }
  landed(impactSpeed: number): void {
    this.landAmp = clamp((impactSpeed - 2.5) / 10, 0.18, 1);
    this.landT = 0;
    // No footfall here: the landing thud comes from the audio motion tracker,
    // so footfalls are foot plants only (a step sound each).
  }
  // Mid-air relaunch. A big horizontal redirect reads as a wall jump: kick
  // off the wall, which lies opposite the new horizontal velocity change.
  relaunch(dvx: number, dvz: number, wall: boolean): void {
    this.airT = 0.05;
    this.launch = true;
    if (!wall) return;
    const l = Math.hypot(dvx, dvz) || 1;
    this.kickX = -dvx / l;
    this.kickZ = -dvz / l;
    this.kickSide = this.kickX >= 0 ? SIDE_R : SIDE_L;
    this.kickT = 0;
  }

  update(inp: LocoInput, spec: PoseSpec): void {
    // Self-heal: this state integrates forever, so one non-finite input would
    // otherwise stick (NaN foot targets → the leg bones collapse → no legs).
    if (!Number.isFinite(this.strideX + this.strideZ + this.legYaw + this.phase + this.speedS + this.vySmooth)) {
      this.reset();
    }
    const dt = inp.dt;
    const s = inp.speed;
    this.speedS = approach(this.speedS, s, 8, dt);
    this.vySmooth = approach(this.vySmooth, inp.vy, 14, dt);
    const moving = inp.grounded && s > GAIT.idleSpeed;
    this.move = approach(this.move, moving ? 1 : 0, moving ? 9 : 6, dt);
    this.air = approach(this.air, inp.grounded ? 0 : 1, inp.grounded ? 22 : 10, dt);
    if (!inp.grounded) this.airT += dt;

    // ── Leg yaw (hips) vs aim ──────────────────────────────────────────────
    let legTarget = this.legYaw;
    if (s > 1.2 && inp.grounded) {
      // Angle of travel relative to facing (0 fwd, +right, ±π back).
      const a = Math.atan2(inp.vx, -inp.vz);
      const back = Math.abs(a) > 100 * DEG;
      this.backpedal = approach(this.backpedal, back ? 1 : 0, 10, dt);
      const rel = back ? wrapPi(a - Math.sign(a) * Math.PI) : a;
      // Turning toward +X is a NEGATIVE rotation about +Y.
      legTarget = -clamp(rel * 0.5, -45 * DEG, 45 * DEG);
      this.stepping = approach(this.stepping, 0, 8, dt);
    } else if (!inp.grounded) {
      legTarget = this.legYaw * 0.9;
    } else {
      // Idle: keep the feet until the twist gets too big, then step around.
      if (Math.abs(this.legYaw) > GAIT.twistMax || this.stepping > 0.5) legTarget = 0;
      const turning = Math.abs(wrapPi(legTarget - this.legYaw)) > 4 * DEG || Math.abs(inp.yawRate) > 3;
      this.stepping = approach(this.stepping, turning && Math.abs(this.legYaw) > 12 * DEG ? 1 : 0, 10, dt);
    }
    // The aim yaw itself spins the model; hold the legs world-steady by
    // counter-rotating (when planted) before easing toward the target.
    if (inp.grounded && this.move < 0.5 && this.stepping < 0.5) this.legYaw -= inp.yawRate * dt;
    this.legYaw = clamp(approach(this.legYaw, legTarget, this.stepping > 0.5 ? 9 : 7, dt), -95 * DEG, 95 * DEG);

    // Stride direction in the leg frame (rotate model-space velocity by -legYaw).
    const cy = Math.cos(-this.legYaw);
    const sy = Math.sin(-this.legYaw);
    const lx = inp.vx * cy + inp.vz * sy;
    const lz = -inp.vx * sy + inp.vz * cy;
    // Gate on the INSTANTANEOUS velocity: `s` is smoothed, so a frame where the
    // body stops dead (wall hit, a repeated sim position) has s > 0.4 but
    // lx = lz = 0 — 0/0 used to poison strideX with NaN and the legs vanished.
    const l = Math.hypot(lx, lz);
    if (s > 0.4 && l > 0.05) {
      this.strideX = approach(this.strideX, lx / l, 14, dt);
      this.strideZ = approach(this.strideZ, lz / l, 14, dt);
      const n = Math.hypot(this.strideX, this.strideZ) || 1;
      this.strideX /= n;
      this.strideZ /= n;
    }

    // ── Gait phase (distance-driven) ───────────────────────────────────────
    const gs = Math.max(this.speedS, this.stepping * 1.6);
    const run = smooth(2, 8.5, gs);
    const freq = Math.min(GAIT.freqMax, GAIT.freqBase + GAIT.freqPerMps * gs);
    const duty = lerp(GAIT.dutyWalk, GAIT.dutyRun, run);
    const D = this.stepping > 0.5 && this.speedS < 1 ? 0.12 : (gs * duty) / freq; // stance length
    if (inp.grounded && (this.move > 0.02 || this.stepping > 0.02)) {
      const prev = this.phase;
      this.phase = (this.phase + freq * dt) % 1;
      // Footfall events at each stance start (p crosses 0 for L, 0.5 for R).
      const crossedL = prev > this.phase; // wrapped past 0
      const crossedR = prev < 0.5 && this.phase >= 0.5;
      if (crossedL) this.plant(SIDE_L, s);
      if (crossedR) this.plant(SIDE_R, s);
    }

    // ── Envelopes ──────────────────────────────────────────────────────────
    this.land = 0;
    if (this.landT >= 0) {
      this.landT += dt;
      const LAND_SEC = 0.38;
      const u = this.landT / LAND_SEC;
      if (u >= 1) this.landT = -1;
      else this.land = this.landAmp * (u < 0.12 ? smooth(0, 0.12, u) : 1 - smooth(0.12, 1, u));
    }
    const dashing = s > 14;
    this.dash = approach(this.dash, dashing ? 1 : 0, dashing ? 24 : 7, dt);
    this.kick = 0;
    if (this.kickT >= 0) {
      this.kickT += dt;
      const u = this.kickT / 0.4;
      if (u >= 1) this.kickT = -1;
      else this.kick = u < 0.18 ? smooth(0, 0.18, u) : 1 - smooth(0.18, 1, u);
    }

    this.write(inp, spec, D, duty, run, gs);
  }

  private plant(side: number, speed: number) {
    this.footfalls++;
    this.onFootfall?.(side as 0 | 1, speed);
  }

  // ── Pose synthesis ───────────────────────────────────────────────────────
  private write(inp: LocoInput, spec: PoseSpec, D: number, duty: number, run: number, gs: number) {
    const t = inp.time;
    const m = Math.max(this.move, this.stepping * 0.8);
    const legC = Math.cos(this.legYaw);
    const legS = Math.sin(this.legYaw);
    const lift = lerp(GAIT.liftWalk, GAIT.liftRun, run) * (this.stepping > 0.5 && this.speedS < 1 ? 0.35 : 1);
    const fwdness = -this.strideZ; // +1 forward stride, −1 backward (in the leg frame)

    // Hips height: idle knee bend, run crouch, per-step bob.
    const bobAmp = lerp(GAIT.bobWalk, GAIT.bobRun, run) * this.move;
    const bobPh = (((this.phase - duty * 0.5) % 0.5) + 0.5) % 0.5; // 0 = mid-stance
    const bob = -bobAmp * (0.5 + 0.5 * Math.cos(bobPh * 2 * TAU));
    const crouch = lerp(0.03, GAIT.crouchRun, run * this.move);
    // Idle weight shift: slow sway, occasionally settling onto one leg.
    const shift = Math.sin(t * 0.55) * 0.5 + Math.sin(t * 0.21 + 1.3) * 0.5;
    const idleW = 1 - m;
    const hipsX = shift * 0.018 * idleW;
    let hipsY = -crouch + bob;
    let hipsZ = 0;

    // ── Feet ──────────────────────────────────────────────────────────────
    for (let side = 0; side < 2; side++) {
      const sgn = side === SIDE_L ? -1 : 1;
      // Moving foot (leg frame): stance/swing along the stride direction.
      const p = (this.phase + (side === SIDE_R ? 0.5 : 0)) % 1;
      let along: number;
      let up = 0;
      let pitch = 0;
      let contact: boolean;
      if (p < duty) {
        const k = p / duty;
        along = D * (0.5 - k);
        pitch = -smooth(0.55, 1, k) * 22 * DEG * run + (1 - smooth(0, 0.2, k)) * 8 * DEG * (1 - run);
        contact = true;
      } else {
        const k = (p - duty) / (1 - duty);
        const kk = k * k * (3 - 2 * k);
        along = D * (-0.5 + kk * 1.04);
        up = lift * Math.sin(Math.PI * Math.pow(k, 0.72));
        pitch = -(1 - smooth(0, 0.45, k)) * 32 * DEG * lerp(0.6, 1, run) + smooth(0.6, 1, k) * 14 * DEG;
        contact = false;
      }
      if (contact && !this.contact[side] && this.move < 0.02) {
        /* no-op: idle contacts don't emit footfalls */
      }
      this.contact[side] = contact;
      const width = GAIT.width - 0.03 * run * Math.abs(this.strideX);
      // Leg-frame foot position (lateral + stride).
      let fx = sgn * width + this.strideX * along;
      let fz = this.strideZ * along;
      let fy = ANKLE_Y + up;
      pitch *= fwdness;

      // Idle stance (leg frame): gunner stance, left foot forward.
      const ix = sgn * 0.13;
      const iz = side === SIDE_L ? -0.07 : 0.075;
      fx = lerp(ix, fx, m);
      fz = lerp(iz, fz, m);
      fy = lerp(ANKLE_Y, fy, m);
      pitch *= m;
      let yawOut = lerp(side === SIDE_L ? 10 * DEG : -22 * DEG, sgn * -4 * DEG, m);

      // Dash lunge: lead leg driving forward, trail leg extended behind.
      if (this.dash > 0.01) {
        const lead = side === SIDE_L;
        const dAlong = lead ? 0.42 : -0.5;
        const dUp = lead ? 0.26 : 0.06;
        fx = lerp(fx, sgn * 0.08 + this.strideX * dAlong, this.dash);
        fz = lerp(fz, this.strideZ * dAlong, this.dash);
        fy = lerp(fy, ANKLE_Y + dUp, this.dash);
        pitch = lerp(pitch, lead ? 10 * DEG : -35 * DEG, this.dash);
      }

      // Leg frame → model space (rotate by legYaw about +Y).
      let mx = fx * legC + fz * legS;
      let mz = -fx * legS + fz * legC;
      let my = fy;

      // Airborne: tuck while rising, reach down while falling; a launch
      // extends both legs for the first beat.
      if (this.air > 0.01) {
        const hipY = 0.915;
        const rising = clamp(this.vySmooth / 6, -1, 1);
        const tuck = smooth(0.04, 0.22, this.airT) * clamp(0.35 + rising * 0.8, 0, 1);
        const reach = clamp(-rising, 0, 1) * smooth(0.12, 0.35, this.airT);
        const lead = side === SIDE_L;
        // Tucked: lead knee up, trail foot back.
        const tx = sgn * 0.11;
        const ty = lead ? hipY - 0.46 : hipY - 0.6;
        const tz = lead ? -0.16 : 0.2;
        // Reaching for the floor: both feet under, slightly forward.
        const rx = sgn * 0.12;
        const ry = lead ? hipY - 0.74 : hipY - 0.7;
        const rz = lead ? -0.1 : 0.04;
        // Launch push-off: legs long, toes pointed.
        const pushed = this.launch ? 1 - smooth(0, 0.14, this.airT) : 0;
        let ax = lerp(sgn * 0.1, tx, tuck);
        let ay = lerp(hipY - 0.8, ty, tuck);
        let az = lerp(0.05, tz, tuck);
        ax = lerp(ax, rx, reach);
        ay = lerp(ay, ry, reach);
        az = lerp(az, rz, reach);
        ay = lerp(ay, hipY - 0.82, pushed);
        az = lerp(az, 0.1, pushed);
        // Rotate the air pose by the leg yaw too.
        const qx = ax * legC + az * legS;
        const qz = -ax * legS + az * legC;
        mx = lerp(mx, qx, this.air);
        my = lerp(my, ay, this.air);
        mz = lerp(mz, qz, this.air);
        pitch = lerp(pitch, lerp(-35 * DEG, -8 * DEG, reach) * (lead ? 0.6 : 1), this.air);
        yawOut = lerp(yawOut, sgn * -4 * DEG, this.air);
      }

      // Wall kick: the wall-side leg shoots out toward the wall.
      if (this.kick > 0.01 && side === this.kickSide) {
        mx = lerp(mx, sgn * 0.06 + this.kickX * 0.62, this.kick);
        my = lerp(my, 0.915 - 0.42, this.kick);
        mz = lerp(mz, this.kickZ * 0.62, this.kick);
        pitch = lerp(pitch, 20 * DEG, this.kick);
      }

      spec.foot[side].set(mx, my, mz);
      // Foot orientation (root space): leg yaw + turn-out, pitch.
      spec.setR(side === SIDE_L ? B.footL : B.footR, pitch, this.legYaw + yawOut, 0);
      // Knees point along the leg frame's forward (bent toward −Z).
      spec.knee[side].set(sgn * 0.1, 0, -1); // hips frame (already leg-yawed)
    }

    // ── Hips / torso ───────────────────────────────────────────────────────
    // Pelvis swings with the stride: yaw toward the forward-swinging leg,
    // roll dropping on the swing side.
    const swingPh = Math.sin(this.phase * TAU);
    const pelvisYaw = swingPh * lerp(5, 11, run) * DEG * this.move * Math.sign(fwdness || 1);
    const pelvisRoll = -Math.sin(this.phase * TAU * 2) * 0; // (kept flat — reads cleaner at speed)
    // Landing: sink hips + fold forward.
    hipsY -= 0.2 * this.land;
    hipsZ += 0.03 * this.land;
    // Dash: low and long.
    hipsY -= 0.12 * this.dash;
    // Air: slight hip lift so tucked legs don't read as a squat.
    hipsY += 0.03 * this.air;
    // Idle: slow weight-shift roll.
    spec.hips.set(hipsX, hipsY, hipsZ);
    spec.setR(B.hips, 1.5 * DEG * idleW + 4 * DEG * this.land, this.legYaw + pelvisYaw, pelvisRoll - shift * 1.2 * DEG * idleW);

    // Whole-body lean into travel (pivot at the feet): forward/back + side.
    // CAPPED (fairness): the pivot is the feet, so the head moves ~1.7 m ×
    // sin(lean). Uncapped (run 12° + dash 14°) that put the helmet ~0.7 m
    // outside the server hitbox (r 0.4 m) at dash speed and shots at a visible
    // head missed. ≤ ROOT_LEAN_MAX keeps the head within ~0.2 m of the hitbox
    // axis (the chest's own run/dash fold adds < 0.1 m on a higher pivot).
    const vLen = Math.hypot(inp.vx, inp.vz) || 1;
    const leanAmt = clamp(this.speedS / 10, 0, 1.2) * this.move * (1 - this.air);
    const leanF = (-inp.vz / vLen) * leanAmt; // +1 = moving forward
    const leanR = (inp.vx / vLen) * leanAmt;
    const dashLean = this.dash * (1 - this.air) * 14 * DEG;
    spec.setR(
      B.root,
      clamp(
        -(leanF * GAIT.leanRun + (leanF >= 0 ? dashLean : -dashLean * 0.5) * Math.abs(-inp.vz / vLen)),
        -ROOT_LEAN_MAX,
        ROOT_LEAN_MAX,
      ),
      0,
      clamp(-(leanR * 4 * DEG + (inp.vx / vLen) * dashLean * 0.6), -ROOT_LEAN_MAX, ROOT_LEAN_MAX),
    );

    // Spine/chest: counter-rotate the pelvis twist so the chest faces the aim,
    // breathe, fold on landing, arch in the air.
    const breathe = Math.sin(t * TAU * 0.27);
    const counter = -(this.legYaw + pelvisYaw);
    const airArch = this.air * (this.vySmooth > 0 ? -4 : 5) * DEG;
    spec.setR(B.spine, 2 * DEG * run * this.move + 9 * DEG * this.land + airArch * 0.5, counter * 0.45, 0);
    spec.setR(
      B.chest,
      -0.8 * DEG * breathe * idleW + 3 * DEG * run * this.move + 10 * DEG * this.land + airArch * 0.5 + 6 * DEG * this.dash,
      counter * 0.55,
      0,
    );
    const shrug = breathe * 0.9 * DEG * idleW;
    spec.addR(B.clavicleL, 0, 0, -shrug);
    spec.addR(B.clavicleR, 0, 0, shrug);
    spec.setR(B.neck, -4 * DEG * this.land, 0, 0);
    spec.setR(B.head, -3 * DEG * this.land + Math.sin(t * 0.37) * 1.2 * DEG * idleW, Math.sin(t * 0.23) * 4 * DEG * idleW, 0);
    void gs;
  }
}
