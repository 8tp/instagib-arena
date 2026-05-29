import * as THREE from 'three';

// Speed-driven locomotion blending, after three.js'
// `webgl_animation_skinning_blending` (the Soldier.glb example): idle, walk and
// run all play at once and we cross-blend them with setEffectiveWeight instead
// of hard-switching. Walk and run are cadence-locked (run is time-warped to
// walk's loop length, like the example's crossFadeTo warp) and the whole
// locomotion plays a touch faster with ground speed, so feet don't slide.

type LocoActions = {
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  run: THREE.AnimationAction | null;
};

// Movement speeds (m/s) at which each gait is "pure".
const IDLE_MAX = 0.4;
const WALK_REF = 3.5;
const RUN_REF = 8.0;
const WEIGHT_SMOOTH = 10; // per-second exponential smoothing of weights
const RATE_MIN = 0.75;
const RATE_MAX = 1.9;

export class LocomotionBlender {
  private idle: THREE.AnimationAction | null;
  private walk: THREE.AnimationAction | null;
  private run: THREE.AnimationAction | null;
  private runSync = 1; // run timeScale warp so walk + run share a cadence
  private wIdle = 1;
  private wWalk = 0;
  private wRun = 0;
  private running = false;

  constructor(actions: LocoActions) {
    this.idle = actions.idle;
    this.walk = actions.walk;
    this.run = actions.run;
    const walkDur = this.walk?.getClip().duration ?? 1;
    const runDur = this.run?.getClip().duration ?? 1;
    // run cycles/sec == walk cycles/sec  ⟺  runTimeScale = rate · (runDur/walkDur)
    this.runSync = walkDur > 1e-3 ? runDur / walkDur : 1;
    this.start();
  }

  // (Re)start all gaits playing, idle at full weight. Safe to call on respawn.
  start() {
    this.running = true;
    this.wIdle = 1;
    this.wWalk = 0;
    this.wRun = 0;
    for (const a of [this.idle, this.walk, this.run]) {
      if (!a) continue;
      a.enabled = true;
      a.setEffectiveTimeScale(1);
      a.time = 0;
      a.play();
    }
    this.idle?.setEffectiveWeight(1);
    this.walk?.setEffectiveWeight(0);
    this.run?.setEffectiveWeight(0);
  }

  // Stop locomotion so a one-shot (e.g. death) can play un-blended.
  stop() {
    this.running = false;
    this.idle?.stop();
    this.walk?.stop();
    this.run?.stop();
  }

  // Blend toward the gait(s) matching `speed` (m/s). Call once per frame; the
  // mixer.update() that actually advances the clips is the caller's job.
  update(speed: number, dt: number) {
    if (!this.running) return;

    let ti = 0;
    let tw = 0;
    let tr = 0;
    if (speed <= IDLE_MAX) {
      ti = 1;
    } else if (speed <= WALK_REF) {
      const f = (speed - IDLE_MAX) / (WALK_REF - IDLE_MAX);
      ti = 1 - f;
      tw = f;
    } else if (speed <= RUN_REF) {
      const f = (speed - WALK_REF) / (RUN_REF - WALK_REF);
      tw = 1 - f;
      tr = f;
    } else {
      tr = 1;
    }
    // Fold missing-gait weight into the nearest available clip so the model
    // still animates if a model lacks walk or run.
    if (!this.walk) {
      tr += tw;
      tw = 0;
    }
    if (!this.run) {
      tw += tr;
      tr = 0;
    }

    const k = 1 - Math.exp(-WEIGHT_SMOOTH * dt);
    this.wIdle += (ti - this.wIdle) * k;
    this.wWalk += (tw - this.wWalk) * k;
    this.wRun += (tr - this.wRun) * k;

    const rate = Math.max(RATE_MIN, Math.min(RATE_MAX, 0.75 + speed * 0.06));
    if (this.idle) {
      this.idle.setEffectiveWeight(this.wIdle);
      this.idle.setEffectiveTimeScale(1);
    }
    if (this.walk) {
      this.walk.setEffectiveWeight(this.wWalk);
      this.walk.setEffectiveTimeScale(rate);
    }
    if (this.run) {
      this.run.setEffectiveWeight(this.wRun);
      this.run.setEffectiveTimeScale(rate * this.runSync);
    }
  }
}
