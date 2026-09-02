import { VIEWMODEL_MOTION as T, WALK_SPEED } from './constants';

// First-person viewmodel motion: everything that makes the railgun feel held
// instead of bolted to the camera. Pure math, no three.js dependency — the Game
// feeds it per-frame player state and applies the returned pose ON TOP of the
// base position + the user's viewmodel offset.
//
// Terms (each tuned in VIEWMODEL_MOTION, constants.ts):
//   bob     — figure-8 walk/run bob, amplitude by ground speed, gone in the air
//   sway    — the gun trails mouse look (rotation + position + roll), spring-smoothed
//   land    — damped dip on landing (∝ impact speed) + a tiny cosmetic camera dip
//   lean    — roll toward strafe direction; dash adds an inertia shove + roll kick
//   recoil  — two-stage fire kick: sharp back+up, then a slower settle with roll
//   zoom    — eased tuck toward a lowered offset while zoomed; bob/sway damped
//   idle    — barely-there breathing so the gun is never frozen
//
// Every term is frame-rate independent: springs use the exact damped-oscillator
// solution, decays are exp(-k·dt), and dt is clamped to maxDt so a hitch can't
// launch anything. Nothing here touches aim — the camera pitch offset is
// cosmetic, ≤ landCamMax, and the shot origin/direction never reads this.

export type ViewmodelMotionFrame = {
  dt: number; // seconds since last frame (clamped internally)
  yaw: number; // current aim yaw (rad) — look deltas are derived frame-to-frame
  pitch: number; // current aim pitch (rad)
  groundSpeed: number; // horizontal speed, m/s
  lateralSpeed: number; // signed strafe speed in view space, m/s (+ = right)
  grounded: boolean;
  zoom: number; // 0 (hipfire) … 1 (fully zoomed), pre-eased by the FOV lerp
  reducedEffects: boolean; // accessibility: suppress the camera dip
};

export type ViewmodelPose = {
  x: number; // position offsets (camera-local units, add to base + user offset)
  y: number;
  z: number;
  rx: number; // rotation (rad): pitch, yaw, roll
  ry: number;
  rz: number;
  camPitch: number; // cosmetic camera pitch offset (rad); 0 under reducedEffects
  muzzle: number; // muzzle bloom intensity 0…1 (decays after a shot)
};

const TWO_PI = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

// Damped harmonic spring toward a target, stepped with the closed-form solution
// (exact for any dt, unconditionally stable). zeta ≥ 1 → critically damped.
class Spring {
  x = 0;
  v = 0;

  step(target: number, omega: number, zeta: number, dt: number): void {
    const d = this.x - target;
    let xp: number;
    let xv: number;
    let vp: number;
    let vv: number;
    if (zeta >= 1) {
      const e = Math.exp(-omega * dt);
      xp = e * (1 + omega * dt);
      xv = e * dt;
      vp = -e * omega * omega * dt;
      vv = e * (1 - omega * dt);
    } else {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-zeta * omega * dt);
      const c = Math.cos(wd * dt);
      const si = Math.sin(wd * dt) / wd;
      xp = e * (c + zeta * omega * si);
      xv = e * si;
      vp = -e * omega * omega * si;
      vv = e * (c - zeta * omega * si);
    }
    this.x = target + d * xp + this.v * xv;
    this.v = d * vp + this.v * vv;
  }

  kick(dv: number): void {
    this.v += dv;
  }

  reset(): void {
    this.x = 0;
    this.v = 0;
  }
}

export class ViewmodelMotion {
  // 0…1 master scale for every cosmetic term (bob/sway/land/lean/dash/idle +
  // the camera dip). The fire kick and zoom tuck are feedback/function, not
  // flourish, so they stay at full strength.
  private intensity = 1;

  private t = 0; // idle clock
  private prevYaw = 0;
  private prevPitch = 0;
  private havePrev = false;

  // Bob
  private bobPhase = 0;
  private bobEnv = 0; // smoothed 0…1 amplitude envelope

  // Look sway (critically damped)
  private readonly swayYaw = new Spring();
  private readonly swayPitch = new Spring();
  private readonly swayRoll = new Spring();
  private readonly swayX = new Spring();
  private readonly swayY = new Spring();

  // Landing / jump dip (impulse-driven)
  private readonly land = new Spring();

  // Strafe lean + dash inertia
  private readonly lean = new Spring();
  private readonly dashX = new Spring();
  private readonly dashZ = new Spring();

  // Fire kick: A is a sharp exponential, B an underdamped settle.
  private kickA = 0;
  private readonly kickB = new Spring();
  private kickSide = 1;
  private muzzle = 0;

  // Zoom tuck (own easing so the gun moves a touch slower than the FOV)
  private tuck = 0;

  private readonly pose: ViewmodelPose = {
    x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, camPitch: 0, muzzle: 0,
  };

  setIntensity(v: number): void {
    this.intensity = Number.isFinite(v) ? clamp(v, 0, 1) : 1;
  }

  getIntensity(): number {
    return this.intensity;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  onFire(): void {
    this.kickA = 1;
    this.kickB.kick(T.recoilB.kick);
    this.kickSide = -this.kickSide;
    this.muzzle = 1;
  }

  // `impactSpeed` = downward speed at touchdown (m/s, positive).
  onLand(impactSpeed: number): void {
    const s = Math.abs(impactSpeed);
    if (!(s >= T.landMinImpact)) return; // soft step-downs don't dip (NaN-safe)
    this.land.kick(-Math.min(s, T.landMaxImpact) * T.landKick * this.intensity);
  }

  // Take-off (ground jump, air jump, boost): the body accelerates up, the gun lags down a hair.
  onJump(): void {
    this.land.kick(-T.jumpKick * this.intensity);
  }

  // Dash burst; `forward`/`lateral` are the dash direction in view space (unit).
  onDash(forward: number, lateral: number): void {
    const k = this.intensity;
    this.dashZ.kick(forward * T.dashKick * k); // dash forward → gun shoves back toward the camera
    this.dashX.kick(-lateral * T.dashKick * k); // dash right → gun lags left
    this.lean.kick(-lateral * T.dashRollKick * k); // …and rolls into the movement
  }

  reset(): void {
    this.havePrev = false;
    this.bobEnv = 0;
    for (const s of [
      this.swayYaw, this.swayPitch, this.swayRoll, this.swayX, this.swayY,
      this.land, this.lean, this.dashX, this.dashZ, this.kickB,
    ]) s.reset();
    this.kickA = 0;
    this.muzzle = 0;
  }

  // ── Per-frame ───────────────────────────────────────────────────────────

  update(f: ViewmodelMotionFrame): ViewmodelPose {
    const dt = Number.isFinite(f.dt) ? clamp(f.dt, 0, T.maxDt) : 0;
    const k = this.intensity;
    const zoom = clamp(f.zoom, 0, 1);
    this.t += dt;

    // Look deltas → rates (rad/s), so the sway is independent of frame rate.
    let yawRate = 0;
    let pitchRate = 0;
    if (this.havePrev && dt > 1e-4) {
      yawRate = wrapPi(f.yaw - this.prevYaw) / dt;
      pitchRate = (f.pitch - this.prevPitch) / dt;
    }
    this.prevYaw = f.yaw;
    this.prevPitch = f.pitch;
    this.havePrev = true;

    // Sway: the gun trails the turn. Turning left (+yaw) → the gun points a
    // little right (−ry), drifts right (+x), and banks into the turn (+roll).
    const swayK = k * (1 - T.zoomSwayCut * zoom);
    const rotMax = T.swayRotMax;
    const posMax = T.swayPosMax;
    this.swayYaw.step(clamp(-yawRate * T.swayRotPerRate, -rotMax, rotMax) * swayK, T.swayOmega, 1, dt);
    this.swayPitch.step(clamp(-pitchRate * T.swayRotPerRate, -rotMax, rotMax) * swayK, T.swayOmega, 1, dt);
    this.swayX.step(clamp(yawRate * T.swayPosPerRate, -posMax, posMax) * swayK, T.swayOmega, 1, dt);
    this.swayY.step(clamp(-pitchRate * T.swayPosPerRate, -posMax, posMax) * swayK, T.swayOmega, 1, dt);
    this.swayRoll.step(
      clamp(yawRate * T.swayRollPerRate, -T.swayRollMax, T.swayRollMax) * swayK,
      T.swayOmega, 1, dt,
    );

    // Bob: amplitude envelope follows ground speed (fast fade-out in the air,
    // gentler fade-in), phase advances with distance travelled so the cadence
    // ramps with acceleration instead of ticking at a fixed rate.
    const speed = Number.isFinite(f.groundSpeed) ? Math.max(0, f.groundSpeed) : 0;
    const envTarget = f.grounded ? smoothstep01(speed / WALK_SPEED) : 0;
    const tau = envTarget > this.bobEnv ? T.bobInTau : T.bobOutTau;
    this.bobEnv += (envTarget - this.bobEnv) * (1 - Math.exp(-dt / tau));
    if (f.grounded && speed > 0.05) {
      this.bobPhase = (this.bobPhase + (speed / T.bobStrideM) * TWO_PI * dt) % TWO_PI;
    }
    const bobAmp = this.bobEnv * k * (1 - T.zoomBobCut * zoom);
    const bs = Math.sin(this.bobPhase);
    const bobX = T.bobAmpX * bobAmp * bs;
    const bobY = -T.bobAmpY * bobAmp * Math.abs(bs);
    const bobRoll = T.bobRoll * bobAmp * bs;

    // Landing dip (impulses arrive via onLand/onJump).
    this.land.step(0, T.landOmega, T.landZeta, dt);
    const landY = this.land.x;

    // Strafe lean + dash inertia. Roll toward the movement direction (moving
    // right → right side dips → −rz); the dash kicks add on top and settle.
    const lat = Number.isFinite(f.lateralSpeed) ? f.lateralSpeed : 0;
    this.lean.step(-clamp(lat / WALK_SPEED, -1, 1) * T.leanRoll * k, T.leanOmega, T.leanZeta, dt);
    this.dashX.step(0, T.dashOmega, T.dashZeta, dt);
    this.dashZ.step(0, T.dashOmega, T.dashZeta, dt);

    // Fire kick: A snaps the gun back+up and bleeds off fast; B rises over the
    // next ~60 ms and settles with a small forward overshoot + alternating roll.
    this.kickA *= Math.exp(-T.recoilA.decay * dt);
    this.kickB.step(0, T.recoilB.omega, T.recoilB.zeta, dt);
    this.muzzle *= Math.exp(-T.muzzleDecay * dt);
    const a = this.kickA;
    const b = this.kickB.x;

    // Zoom tuck.
    this.tuck += (zoom - this.tuck) * (1 - Math.exp(-T.zoomTuckRate * dt));
    const tk = this.tuck;

    // Idle breathing — two incommensurate slow sines so it never visibly loops.
    const i1 = Math.sin(this.t * TWO_PI * T.idle.hzA);
    const i2 = Math.sin(this.t * TWO_PI * T.idle.hzB + 1.7);

    const p = this.pose;
    p.x = bobX + this.swayX.x + this.dashX.x + tk * T.zoomTuck.x + T.idle.x * i2 * k;
    p.y =
      bobY + this.swayY.x + landY + a * T.recoilA.y + b * T.recoilB.y +
      tk * T.zoomTuck.y + T.idle.y * i1 * k;
    p.z = this.dashZ.x + a * T.recoilA.z + b * T.recoilB.z + tk * T.zoomTuck.z;
    p.rx =
      this.swayPitch.x + landY * T.landPitch + a * T.recoilA.pitch + b * T.recoilB.pitch +
      tk * T.zoomTuck.pitch + T.idle.pitch * i1 * k;
    p.ry = this.swayYaw.x;
    p.rz =
      bobRoll + this.swayRoll.x + this.lean.x + b * T.recoilB.roll * this.kickSide +
      T.idle.roll * i2 * k;
    p.camPitch = f.reducedEffects
      ? 0
      : clamp(landY * T.landCamPitch, -T.landCamMax, T.landCamMax);
    p.muzzle = this.muzzle < 0.01 ? 0 : this.muzzle;

    // Safety net: a NaN anywhere (corrupt input) would stick the gun off-screen.
    if (!Number.isFinite(p.x + p.y + p.z + p.rx + p.ry + p.rz + p.camPitch + p.muzzle)) {
      this.reset();
      p.x = p.y = p.z = p.rx = p.ry = p.rz = p.camPitch = p.muzzle = 0;
    }
    return p;
  }
}
