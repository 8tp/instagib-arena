import {
  DEFAULT_KEYBINDS,
  DEFAULT_RAW_INPUT,
  DEFAULT_SENSITIVITY,
  DEFAULT_VERT_SCALE,
  M_YAW_DEG,
  MAX_LOOK_DELTA_DEG,
  type KeybindAction,
} from './constants';
import type { InputState } from './types';

const MAX_LOOK_DELTA_RAD = (MAX_LOOK_DELTA_DEG * Math.PI) / 180;

// OS-adjusted Chrome/Edge report movementX/Y in PHYSICAL pixels (scale with
// devicePixelRatio / browser zoom); Firefox reports CSS pixels already. We
// divide by DPR only on OS-adjusted Chromium so the same hand motion = same
// rotation on a 1080p and a 4K/retina display. (W3C pointerlock issue #42.)
// RAW (unadjustedMovement) deltas are device counts, NOT pixels — they are
// DPR-independent — so they must NOT be divided; see normMovement.
const IS_CHROMIUM =
  typeof navigator !== 'undefined' &&
  (((navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)) ??
    false) ||
    (/Chrome\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent)));

export class InputManager {
  private state: InputState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    jumpPressed: false,
    dash: false,
    dashPressed: false,
    boost: false,
    boostPressed: false,
    fire: false,
    firePressed: false,
    zoom: false,
    scoreboard: false,
    yawDelta: 0,
    pitchDelta: 0,
  };
  // Multiplier on look sensitivity — Game sets this to currentFov/baseFov while
  // zoomed so aiming feel stays proportional as the FOV narrows.
  lookScale = 1;
  private prevJump = false;
  private prevDash = false;
  private prevBoost = false;
  private prevFire = false;
  private accumYaw = 0;
  private accumPitch = 0;
  private locked = false;
  // Source/CS2 sensitivity number (deg/count = sens · M_YAW_DEG).
  sensitivity = DEFAULT_SENSITIVITY;
  vertScale = DEFAULT_VERT_SCALE;
  wantRawInput = DEFAULT_RAW_INPUT;
  rawInputActive = false;
  private rawInputSupported: boolean | undefined = undefined;
  private justLocked = false;
  // KeyboardEvent.code → action, rebuilt by setBindings().
  private codeToAction = new Map<string, KeybindAction>(
    (Object.entries(DEFAULT_KEYBINDS) as [KeybindAction, string][]).map(([a, code]) => [code, a]),
  );

  constructor(
    private canvas: HTMLCanvasElement,
    private onLockChange: (locked: boolean) => void,
    private onLockError: () => void = () => {},
  ) {
    this.attach();
  }

  // Radians of yaw per (DPR-normalized) movement unit.
  private get radPerCount(): number {
    return this.sensitivity * M_YAW_DEG * (Math.PI / 180);
  }

  // Pointer lock with raw, OS-acceleration-free input when available, falling
  // back to plain lock if the platform rejects unadjustedMovement.
  requestLock() {
    if (!this.wantRawInput || this.rawInputSupported === false) {
      this.canvas.requestPointerLock();
      this.rawInputActive = false;
      return;
    }
    const req = this.canvas.requestPointerLock({ unadjustedMovement: true }) as
      | Promise<void>
      | undefined;
    if (!req) {
      // Older browsers: the options overload returns undefined, not a promise.
      this.rawInputSupported = false;
      this.rawInputActive = false;
      this.canvas.requestPointerLock();
      return;
    }
    req
      .then(() => {
        this.rawInputSupported = true;
        this.rawInputActive = true;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotSupportedError') {
          this.rawInputSupported = false;
          this.rawInputActive = false;
          this.canvas.requestPointerLock();
        } else {
          // No user gesture, security error, or unsupported environment — tell
          // the client so it can prompt instead of leaving a dimmed screen (#14).
          this.onLockError();
        }
      });
  }

  setSensitivity(s: number) {
    this.sensitivity = Math.max(0.01, s);
  }

  setVertScale(v: number) {
    this.vertScale = Math.max(0.05, v);
  }

  setRawInput(on: boolean) {
    this.wantRawInput = on;
    // Re-learn support next request (so toggling on after a fallback retries).
    if (on) this.rawInputSupported = undefined;
  }

  private normMovement(raw: number): number {
    // Raw (unadjustedMovement) deltas are already device counts and DPR-
    // independent — dividing them would shrink sensitivity by the DPR factor on
    // HiDPI/retina and throw cm/360 off by that same factor. Only DPR-normalize
    // OS-adjusted Chromium movement, which is reported in physical pixels.
    if (!IS_CHROMIUM || this.rawInputActive) return raw;
    const dpr = window.devicePixelRatio || 1;
    return raw / dpr;
  }

  get scoreboardHeld(): boolean {
    return this.state.scoreboard;
  }

  consume(): InputState {
    const s = { ...this.state };
    s.yawDelta = this.accumYaw;
    s.pitchDelta = this.accumPitch;
    this.accumYaw = 0;
    this.accumPitch = 0;
    s.jumpPressed = !this.prevJump && this.state.jump;
    s.dashPressed = !this.prevDash && this.state.dash;
    s.boostPressed = !this.prevBoost && this.state.boost;
    s.firePressed = !this.prevFire && this.state.fire;
    this.prevJump = this.state.jump;
    this.prevDash = this.state.dash;
    this.prevBoost = this.state.boost;
    this.prevFire = this.state.fire;
    return s;
  }

  detach() {
    window.removeEventListener('keydown', this.onKeydown);
    window.removeEventListener('keyup', this.onKeyup);
    window.removeEventListener('mousemove', this.onMousemove);
    window.removeEventListener('mousedown', this.onMousedown);
    window.removeEventListener('mouseup', this.onMouseup);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLock);
    document.removeEventListener('pointerlockerror', this.onLockErrorEvent);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private attach() {
    window.addEventListener('keydown', this.onKeydown);
    window.addEventListener('keyup', this.onKeyup);
    window.addEventListener('mousemove', this.onMousemove);
    window.addEventListener('mousedown', this.onMousedown);
    window.addEventListener('mouseup', this.onMouseup);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLock);
    document.addEventListener('pointerlockerror', this.onLockErrorEvent);
  }

  private onLockErrorEvent = () => {
    this.onLockError();
  };

  setBindings(binds: Record<KeybindAction, string>) {
    const map = new Map<string, KeybindAction>();
    (Object.entries(binds) as [KeybindAction, string][]).forEach(([action, code]) => {
      if (code) map.set(code, action);
    });
    this.codeToAction = map;
  }

  private onKeydown = (e: KeyboardEvent) => {
    const action = this.codeToAction.get(e.code);
    if (!action) return;
    // Scoreboard works regardless of lock (and always preventDefault so the
    // default Tab key never shifts focus); movement keys only while playing.
    if (action === 'scoreboard') {
      e.preventDefault();
      this.state.scoreboard = true;
      return;
    }
    if (!this.locked) return;
    this.applyAction(action, true);
    e.preventDefault();
  };

  private onKeyup = (e: KeyboardEvent) => {
    const action = this.codeToAction.get(e.code);
    if (!action) return;
    if (action === 'scoreboard') {
      e.preventDefault();
      this.state.scoreboard = false;
      return;
    }
    this.applyAction(action, false);
  };

  private applyAction(action: KeybindAction, down: boolean) {
    switch (action) {
      case 'forward': this.state.forward = down; break;
      case 'back': this.state.back = down; break;
      case 'left': this.state.left = down; break;
      case 'right': this.state.right = down; break;
      case 'jump': this.state.jump = down; break;
      case 'dash': this.state.dash = down; break;
      case 'zoom': this.state.zoom = down; break;
      case 'scoreboard': this.state.scoreboard = down; break;
    }
  }

  private onMousemove = (e: MouseEvent) => {
    if (!this.locked) return;
    // Some browsers emit one large spurious delta on the first event after
    // lock (cursor-warp leftover) — drop it.
    if (this.justLocked) {
      this.justLocked = false;
      return;
    }
    const mx = this.normMovement(e.movementX);
    const my = this.normMovement(e.movementY);
    const r = this.radPerCount * this.lookScale;
    const dyaw = mx * r;
    const dpitch = my * r * this.vertScale;
    // Per-event glitch guard on the resulting ROTATION (sensitivity-independent):
    // drop NaN/Infinity and impossible cursor-warp/driver spikes, but never a
    // real flick — even a low-sens one coalesced into a single event.
    if (!Number.isFinite(dyaw) || !Number.isFinite(dpitch)) return;
    if (Math.abs(dyaw) > MAX_LOOK_DELTA_RAD || Math.abs(dpitch) > MAX_LOOK_DELTA_RAD) return;
    this.accumYaw += dyaw;
    this.accumPitch += dpitch;
  };

  private onMousedown = (e: MouseEvent) => {
    if (!this.locked) return;
    if (e.button === 0) this.state.fire = true;
    else if (e.button === 2) this.state.boost = true; // RMB → boost jump
  };

  private onMouseup = (e: MouseEvent) => {
    if (e.button === 0) this.state.fire = false;
    else if (e.button === 2) this.state.boost = false;
  };

  // Suppress the browser context menu so RMB is a clean game input.
  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onBlur = () => {
    this.clearKeys();
  };

  private onLock = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (this.locked) this.justLocked = true; // drop the first post-lock delta
    this.onLockChange(this.locked);
    if (!this.locked) this.clearKeys();
  };

  private clearKeys() {
    this.state.forward = false;
    this.state.back = false;
    this.state.left = false;
    this.state.right = false;
    this.state.jump = false;
    this.state.dash = false;
    this.state.boost = false;
    this.state.fire = false;
    this.state.zoom = false;
    this.accumYaw = 0;
    this.accumPitch = 0;
  }
}
