import type { InputState, Vec3 } from './types';
import { movePlayer, rayAabbNormal, type ArenaMap } from './map';
import {
  AIR_ACCEL,
  AIR_CONTROL,
  AIR_JUMPS,
  AIR_WISHSPEED_CAP,
  BOOST_AIRCTRL_BONUS,
  BOOST_AIRCTRL_TIME,
  BOOST_COOLDOWN,
  BOOST_FORWARD_BIAS,
  BOOST_IMPULSE,
  BOOST_RANGE,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_SPEED,
  EYE_HEIGHT,
  FRICTION,
  GRAVITY,
  GROUND_ACCEL,
  JUMP_SPEED,
  MAX_HORIZONTAL_SPEED,
  PITCH_LIMIT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STOP_SPEED,
  WALK_SPEED,
  WALL_JUMP_GRACE,
  WALL_JUMP_NORMAL,
  WALL_JUMP_UP,
} from './constants';

export class Player {
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  onGround = false;
  airJumpsLeft = AIR_JUMPS;
  dashCooldown = 0;
  dashTimer = 0;
  // Ratz-style boost jump (RMB). `boostInRange` drives the HUD range ring;
  // `didBoost` is a one-shot flag the game reads to fire SFX/FX, then clears.
  boostCooldown = 0;
  boostInRange = false;
  didBoost = false;
  boostContact: Vec3 = { x: 0, y: 0, z: 0 };
  // Post-boost window of extra air-control (the Soldier "rocket then carve").
  private boostAirCtrlTimer = 0;
  private dashDir: Vec3 = { x: 0, y: 0, z: 0 };
  private wallNormal: Vec3 | null = null;
  private wallTimer = 0;

  constructor(spawn: Vec3) {
    this.pos = { ...spawn };
  }

  step(input: InputState, dt: number, map: ArenaMap) {
    this.yaw -= input.yawDelta;
    this.pitch -= input.pitchDelta;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const sx = Math.cos(this.yaw);
    const sz = -Math.sin(this.yaw);
    let wx = 0;
    let wz = 0;
    if (input.forward) { wx += fx; wz += fz; }
    if (input.back)    { wx -= fx; wz -= fz; }
    if (input.right)   { wx += sx; wz += sz; }
    if (input.left)    { wx -= sx; wz -= sz; }
    const wlen = Math.hypot(wx, wz);
    if (wlen > 0) { wx /= wlen; wz /= wlen; }

    // Boost-jump surface probe: raycast the full 3D look direction (pitch +
    // yaw) against the map and find the nearest surface. Drives both the HUD
    // range ring and the boost impulse below. Look dir for YXZ(pitch,yaw):
    //   (-cos p·sin y, sin p, -cos p·cos y) = (fx·cos p, sin p, fz·cos p)
    const cp = Math.cos(this.pitch);
    const eye: Vec3 = { x: this.pos.x, y: this.pos.y + EYE_HEIGHT, z: this.pos.z };
    const look: Vec3 = { x: fx * cp, y: Math.sin(this.pitch), z: fz * cp };
    let boostProbe: { t: number; normal: Vec3 } | null = null;
    for (const b of map.boxes) {
      const hit = rayAabbNormal(eye, look, b);
      if (hit && hit.t > 1e-3 && (!boostProbe || hit.t < boostProbe.t)) {
        boostProbe = hit;
      }
    }
    this.boostInRange = boostProbe !== null && boostProbe.t <= BOOST_RANGE;

    // Bunny-hop preservation: when the player will jump THIS tick, skip
    // ground friction. Q3-style bhop — landing+jumping in the same frame
    // keeps your horizontal speed instead of friction-decaying it first.
    const willBhop = input.jumpPressed && this.onGround;

    if (this.dashTimer > 0) {
      this.vel.x = this.dashDir.x * DASH_SPEED;
      this.vel.z = this.dashDir.z * DASH_SPEED;
      this.vel.y = 0;
    } else {
      if (this.onGround && !willBhop) {
        const speed = Math.hypot(this.vel.x, this.vel.z);
        if (speed > 0) {
          const ctrl = speed < STOP_SPEED ? STOP_SPEED : speed;
          const drop = ctrl * FRICTION * dt;
          const newSpeed = Math.max(0, speed - drop);
          const scale = newSpeed / speed;
          this.vel.x *= scale;
          this.vel.z *= scale;
        }
      }
      const wishspeed = wlen > 0 ? WALK_SPEED : 0;
      if (this.onGround) {
        // Ground: full wishspeed is both the budget and the rate.
        this.accelerate(wx, wz, wishspeed, wishspeed, GROUND_ACCEL, dt);
      } else {
        // Air: the velocity-along-wishdir BUDGET is capped (this is what makes
        // strafe-jumping a skill), but the accel RATE uses full wishspeed so it
        // saturates the budget every tick — instant, forgiving steering (TF2).
        const capBonus = this.boostAirCtrlTimer > 0 ? BOOST_AIRCTRL_BONUS : 0;
        const cap = Math.min(wishspeed, AIR_WISHSPEED_CAP + capBonus);
        this.accelerate(wx, wz, wishspeed, cap, AIR_ACCEL, dt);
        // Magnitude-preserving carve toward wishdir — lets you steer the arc
        // by holding a direction, on top of the strafe-jump speed gain.
        this.airControl(wx, wz, dt);
      }

      this.vel.y -= GRAVITY * dt;

      // Sanity cap on horizontal speed. Real Q3 strafe-jumping peaks
      // around 25 m/s; this cap stays out of the way unless something
      // goes numerically wrong.
      const horiz = Math.hypot(this.vel.x, this.vel.z);
      if (horiz > MAX_HORIZONTAL_SPEED) {
        const scale = MAX_HORIZONTAL_SPEED / horiz;
        this.vel.x *= scale;
        this.vel.z *= scale;
      }
    }

    if (input.jumpPressed) {
      if (this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      } else if (this.wallNormal && this.wallTimer > 0) {
        this.vel.x = this.wallNormal.x * WALL_JUMP_NORMAL;
        this.vel.z = this.wallNormal.z * WALL_JUMP_NORMAL;
        this.vel.y = WALL_JUMP_UP;
        this.wallNormal = null;
        this.wallTimer = 0;
        this.airJumpsLeft = AIR_JUMPS;
      } else if (this.airJumpsLeft > 0) {
        this.vel.y = JUMP_SPEED;
        this.airJumpsLeft -= 1;
      }
    }

    // Boost jump (RMB): shove the player along the aimed surface's normal —
    // a damage-free rocket-jump. Cancel any velocity going INTO the surface
    // first so a fast approach doesn't eat the launch, then add the impulse.
    if (
      input.boostPressed &&
      this.boostCooldown <= 0 &&
      boostProbe &&
      boostProbe.t <= BOOST_RANGE
    ) {
      const n = boostProbe.normal;
      const into = this.vel.x * n.x + this.vel.y * n.y + this.vel.z * n.z;
      if (into < 0) {
        this.vel.x -= n.x * into;
        this.vel.y -= n.y * into;
        this.vel.z -= n.z * into;
      }
      // Launch dir = surface normal blended toward look-horizontal, so a floor
      // boost arcs up+forward (distance) like an at-feet rocket. Aiming straight
      // down (no look-horizontal) stays a pure straight-up launch (max height).
      const lh = Math.hypot(look.x, look.z) || 1;
      let dx = n.x + BOOST_FORWARD_BIAS * (look.x / lh);
      let dy = n.y;
      let dz = n.z + BOOST_FORWARD_BIAS * (look.z / lh);
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      this.vel.x += dx * BOOST_IMPULSE;
      this.vel.y += dy * BOOST_IMPULSE;
      this.vel.z += dz * BOOST_IMPULSE;
      this.onGround = false;
      this.airJumpsLeft = AIR_JUMPS;
      this.boostCooldown = BOOST_COOLDOWN;
      this.boostAirCtrlTimer = BOOST_AIRCTRL_TIME;
      this.didBoost = true;
      this.boostContact = {
        x: eye.x + look.x * boostProbe.t,
        y: eye.y + look.y * boostProbe.t,
        z: eye.z + look.z * boostProbe.t,
      };
    }

    // Dash is ground-only: an airborne dash zeroed vel.y and skipped gravity,
    // giving a free mid-air hover / fall-cancel. Gating on onGround keeps dash a
    // ground burst; air mobility stays the boost-jump + air-control's job.
    if (input.dashPressed && this.onGround && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      let ddx: number;
      let ddz: number;
      if (wlen > 0) {
        ddx = wx;
        ddz = wz;
      } else {
        ddx = fx;
        ddz = fz;
      }
      this.dashDir = { x: ddx, y: 0, z: ddz };
      this.dashTimer = DASH_DURATION;
      this.dashCooldown = DASH_COOLDOWN;
    }

    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.boostCooldown > 0) this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    if (this.boostAirCtrlTimer > 0) this.boostAirCtrlTimer = Math.max(0, this.boostAirCtrlTimer - dt);
    if (this.wallTimer > 0) {
      this.wallTimer = Math.max(0, this.wallTimer - dt);
      if (this.wallTimer === 0) this.wallNormal = null;
    }

    const size: Vec3 = { x: PLAYER_RADIUS * 2, y: PLAYER_HEIGHT, z: PLAYER_RADIUS * 2 };
    const delta: Vec3 = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    const result = movePlayer(this.pos, size, delta, map.boxes);
    this.pos = result.position;

    if (result.blocked.x) this.vel.x = 0;
    if (result.blocked.z) this.vel.z = 0;
    if (result.blocked.y) this.vel.y = 0;

    const wasOnGround = this.onGround;
    this.onGround = result.groundContact;
    if (this.onGround && !wasOnGround) {
      this.airJumpsLeft = AIR_JUMPS;
    }

    if (!this.onGround && (result.blocked.x || result.blocked.z) && result.wallNormal) {
      this.wallNormal = result.wallNormal;
      this.wallTimer = WALL_JUMP_GRACE;
    }
  }

  // Quake/Source PM_Accelerate. The cap target (`wishCap`) and the accel rate
  // (`wishFull`) are decoupled exactly as Source does it: only the velocity
  // component along wishdir is limited (to wishCap), but the per-tick push uses
  // the full wishspeed so it saturates that budget in one tick. Using the cap
  // for BOTH (the old bug) throttled air steering and made it feel stiff.
  private accelerate(
    wx: number,
    wz: number,
    wishFull: number,
    wishCap: number,
    accel: number,
    dt: number,
  ) {
    if (wishCap <= 0) return;
    const currentSpeed = this.vel.x * wx + this.vel.z * wz;
    const addSpeed = wishCap - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * wishFull * dt;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    this.vel.x += wx * accelSpeed;
    this.vel.z += wz * accelSpeed;
  }

  // CPM-style air control: rotate the horizontal velocity toward wishdir while
  // PRESERVING its magnitude (adds steering, not speed). `dot²` weighting makes
  // it a strong carve when you're already heading where you aim and ~nothing
  // when wishdir is perpendicular — so it stacks with strafe-jumping (which
  // gains speed via accelerate) instead of fighting it.
  private airControl(wx: number, wz: number, dt: number) {
    if (Math.hypot(wx, wz) < 1e-3) return;
    let vx = this.vel.x;
    let vz = this.vel.z;
    const speed = Math.hypot(vx, vz);
    if (speed < 1e-3) return;
    vx /= speed;
    vz /= speed;
    const dot = vx * wx + vz * wz;
    if (dot > 0) {
      const k = 32 * AIR_CONTROL * dot * dot * dt;
      vx = vx * speed + wx * k;
      vz = vz * speed + wz * k;
      const nlen = Math.hypot(vx, vz);
      if (nlen > 1e-6) {
        vx /= nlen;
        vz /= nlen;
      }
      this.vel.x = vx * speed;
      this.vel.z = vz * speed;
    }
  }
}
