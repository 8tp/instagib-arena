export const TICK_HZ = 64;
export const TICK_DT = 1 / TICK_HZ;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;

// Quake III / Source-flavored. The accel formula is the Q3 standard:
//   accelSpeed = ACCEL * wishspeed * dt    (capped at addSpeed = wishspeed - current)
// so ACCEL is a per-second rate constant. These are tuned for our 64Hz sim:
//   GROUND_ACCEL 14  — ramps to walk speed in ~5 ticks (≈80ms). Snappy
//                      but you can feel the kickoff.
//   AIR_ACCEL    12  — the per-tick air-accel RATE. In Source the rate term
//                      `accel * wishspeed * dt` uses the player's FULL ground
//                      speed (not the cap), so it always saturates the cap in
//                      one tick → air steering is instant + forgiving (the TF2
//                      feel). `accelerate()` now mirrors that: rate uses full
//                      WALK_SPEED, only the BUDGET below is capped. Anything
//                      ≥~8 saturates; 12 is comfy headroom.
//   AIR_WISHSPEED_CAP 1.6 — THE air-control lever: the per-tick per-axis
//                      "veer budget" (velocity component along wishdir is
//                      capped here, never total speed). 1.0 ≈ TF2 Soldier
//                      (0.10·walk); 1.6 (0.16·walk) is noticeably MORE
//                      steerable than TF2 — what the user asked for. Strafe-
//                      jumping still gains unbounded speed by turning.
//   AIR_CONTROL  0.35 — CPM-style magnitude-preserving steering (rotates
//                      velocity toward wishdir without adding speed) so you
//                      can carve a rocket-jump arc by just holding W + mouse,
//                      not only the strafe technique. 0 = off, 0.3 = CPM,
//                      0.35–0.5 = generous. See Player.airControl().
//   STOP_SPEED   3   — matches Q3's 100 ups. Friction transitions
//                      smoothly to a stop instead of sliding forever.
export const WALK_SPEED = 10;
export const GROUND_ACCEL = 14;
export const AIR_ACCEL = 12;
export const AIR_WISHSPEED_CAP = 1.6;
export const AIR_CONTROL = 0.35;
export const FRICTION = 6;
export const STOP_SPEED = 3.0;
export const GRAVITY = 25;
export const JUMP_SPEED = 9;
// Sanity cap so numerical issues / map exploits can't produce runaway
// velocity. Q3 vanilla peaks around 25 m/s with extreme strafe-jumping,
// CPMA can hit 35-40 — 50 gives plenty of headroom.
export const MAX_HORIZONTAL_SPEED = 50;

export const AIR_JUMPS = 1;
export const DASH_SPEED = 22;
export const DASH_DURATION = 0.15;
export const DASH_COOLDOWN = 2.5;
export const WALL_JUMP_NORMAL = 8;
export const WALL_JUMP_UP = 7;
export const WALL_JUMP_GRACE = 0.18;

// Ratz-style "Boost Jump" (right mouse). A damage-free rocket-jump: raycast
// the surface you're aiming at and, if it's within BOOST_RANGE, shove the
// player along that surface's normal. Aim at the floor → launch up; aim at a
// wall → launch off it horizontally; chainable for flying around the map.
//   BOOST_RANGE    4   — must be aiming at a surface within 4m to boost.
//   BOOST_IMPULSE  20  — m/s along the launch dir. ~8m straight up (v²/2g) if
//                        you aim straight down; with forward bias a floor
//                        boost arcs up+forward like a real TF2 rocket jump
//                        (~11m single-RJ is the TF2 reference).
//   BOOST_FORWARD_BIAS 0.5 — blends your look-horizontal into the launch dir,
//                        so a floor boost goes up-AND-forward (distance) like
//                        an at-feet rocket, not a boring straight-up pop. At 0
//                        it's a pure surface-normal repel.
//   BOOST_AIRCTRL_BONUS 0.4 / BOOST_AIRCTRL_TIME 0.4 — for 0.4s after a boost,
//                        the air veer budget gets +0.4 so you can hard-carve
//                        the launch — the Soldier "rocket then steer" window.
//   BOOST_COOLDOWN 0.3 — allows ~3 boosts/sec (fast wall-to-wall chaining)
//                        without letting a click-spam stack impulses to orbit.
export const BOOST_RANGE = 4;
export const BOOST_IMPULSE = 20;
export const BOOST_FORWARD_BIAS = 0.5;
export const BOOST_AIRCTRL_BONUS = 0.4;
export const BOOST_AIRCTRL_TIME = 0.4;
export const BOOST_COOLDOWN = 0.3;

export const RAIL_COOLDOWN = 1.2;
// Longer than a stock hitscan flash so the beam lingers and "reveals
// positions" Quake/ratz-style — the trail is the primary shot indicator.
export const RAIL_BEAM_DURATION = 0.9;
export const RAIL_RANGE = 200;
// Rail trail geometry (Q3 CG_RailTrail: a bright solid core + a colored
// helix spiralling around it). Scaled to our metric world.
export const RAIL_CORE_RADIUS = 0.035; // solid inner beam thickness
export const RAIL_GLOW_RADIUS = 0.11; // soft additive glow around the core
export const RAIL_HELIX_RADIUS = 0.17; // spiral offset from the axis
export const RAIL_HELIX_TURN_LEN = 0.7; // metres of beam per full spiral turn
export const RAIL_CORE_COLOR = 0xd6f4ff; // near-white cyan core
export const RAIL_HELIX_COLOR = 0x37a6ff; // blue spiral

export const MOUSE_SENS = 0.0022;
export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const FOV_DEG = 90;

// Bots
export const NUM_BOTS = 4;
export const BOT_RADIUS = 0.45;
export const BOT_HEIGHT = 1.8;
export const BOT_EYE_FRAC = 0.85; // bot "eye" height as a fraction of BOT_HEIGHT
export const BOT_HEADSHOT_THRESHOLD = 0.72; // fraction of height above which a hit counts as headshot
export const BOT_RESPAWN_DELAY = 1.5;
export const BOT_MOVE_INTERVAL_MIN = 3.5;
export const BOT_MOVE_INTERVAL_MAX = 7.5;

// Bot combat AI. Per-difficulty knobs that scale how dangerous — and how
// human — a bot feels. The aim model tracks a SMOOTHED aim point toward the
// target, so a laggy tracker mis-leads jukes (humans don't snap), and the error
// grows with the target's lateral speed (moving targets are genuinely hard):
//   sightRange  — how far they acquire + engage a target (m)
//   reaction    — delay after first seeing a target before they can fire (s)
//   aimError    — base random aim cone half-angle vs a still target (radians)
//   moveErr     — extra cone added per m/s of the target's LATERAL speed (rad)
//   aimTrack    — how fast the aim point chases the target (1/s); low = laggy,
//                 so fast-strafing targets slip the crosshair (the human feel)
//   whiffChance — probability a given shot is thrown wide (a flubbed shot)
//   fireCooldown— seconds between a bot's shots (>= RAIL_COOLDOWN 1.2)
//   moveSpeed   — bot movement speed (m/s)
//   combatStrafe— 0..1 tendency to circle-strafe a target vs. beeline
export type BotDifficulty = 'easy' | 'medium' | 'hard';
export const BOT_DIFFICULTY: Record<
  BotDifficulty,
  {
    sightRange: number;
    reaction: number;
    aimError: number;
    moveErr: number;
    aimTrack: number;
    whiffChance: number;
    fireCooldown: number;
    moveSpeed: number;
    combatStrafe: number;
  }
> = {
  // Easy: hits still targets often, but laggy tracking (aimTrack 5 ≈ ~0.5s to
  // settle) + a big per-speed penalty + frequent whiffs make it miss movers a lot.
  easy:   { sightRange: 22, reaction: 0.75, aimError: 0.05,  moveErr: 0.022, aimTrack: 5,  whiffChance: 0.18, fireCooldown: 2.2,  moveSpeed: 4.2, combatStrafe: 0.35 },
  medium: { sightRange: 34, reaction: 0.40, aimError: 0.028, moveErr: 0.009, aimTrack: 13, whiffChance: 0.06, fireCooldown: 1.6,  moveSpeed: 5.6, combatStrafe: 0.6 },
  // Hard: near-instant tracking + tight cone, but a small whiff chance keeps it
  // from feeling robotically perfect. fireCooldown stays >= RAIL_COOLDOWN.
  hard:   { sightRange: 48, reaction: 0.18, aimError: 0.013, moveErr: 0.003, aimTrack: 30, whiffChance: 0.03, fireCooldown: 1.25, moveSpeed: 7.2, combatStrafe: 0.85 },
};
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

// Match config
export const MAX_PLAYERS = 8; // total slots (you + bots) in a match
export const MATCH_FRAG_LIMIT = 25; // FFA: first to this many frags ends the match
export const LOCAL_RESPAWN_INVULN_SEC = 1.5; // grace after you respawn vs bots

// ── Game modes ─────────────────────────────────────────────────────────────
// Shared client+server. FFA is the original mode; duel + tdm build on the same
// room/snapshot machinery (see server/instagib-game.ts).
export type GameMode = 'ffa' | 'duel' | 'tdm';
export const DEFAULT_GAME_MODE: GameMode = 'ffa';
export const GAME_MODES: ReadonlyArray<{
  id: GameMode;
  label: string;
  blurb: string;
}> = [
  { id: 'ffa', label: 'Free-for-all', blurb: 'Everyone for themselves — first to the frag limit.' },
  { id: 'duel', label: 'Duel (1v1)', blurb: 'One on one, best-of rounds.' },
  { id: 'tdm', label: 'Team Deathmatch', blurb: 'Red vs Blue — first team to the frag limit.' },
];

// Duel: each round is a race to DUEL_ROUND_FRAG_LIMIT frags; the first player to
// win DUEL_ROUNDS_TO_WIN rounds takes the match (then the map vote opens).
export const DUEL_ROUND_FRAG_LIMIT = 7;
export const DUEL_ROUNDS_TO_WIN = 3; // best of 5
export const DUEL_ROUND_BREAK_SEC = 4; // between-round freeze/reset

// TDM: two teams; first team to TDM_FRAG_LIMIT total frags wins.
export const TDM_FRAG_LIMIT = 40;
export const TEAM_COUNT = 2;
export const TEAM_NAMES = ['Red', 'Blue'] as const;
export const TEAM_COLORS = ['#ff5a5a', '#5a9bff'] as const; // index 0 = red, 1 = blue
// Highlight a friendly teammate this color in TDM (foes use their team color).
export const TDM_FRIEND_COLOR = '#43d17a';

// Total slot capacity for a room of the given mode.
export function modeCapacity(mode: GameMode): number {
  return mode === 'duel' ? 2 : MAX_PLAYERS;
}

// Screen shake (camera positional jitter, metres). Decays per render frame.
export const SHAKE_FIRE = 0.025; // recoil kick on firing the rail
export const SHAKE_DEATH = 0.12; // big jolt when you die
export const SHAKE_MAX = 0.22;

// Medals
export const MULTIKILL_WINDOW_SEC = 3.5;

// HUD timing
export const BANNER_DURATION_SEC = 2.4;
export const TOAST_DURATION_SEC = 2.6;
export const TOAST_FADE_SEC = 0.35;
export const KILLFEED_DURATION_SEC = 5.0;
export const MAX_KILLFEED_ENTRIES = 6;
export const MAX_TOASTS = 4;
export const HIT_MARKER_DURATION_SEC = 0.32;
export const HIT_MARKER_KILL_DURATION_SEC = 0.55;
export const KILL_CONFIRM_DURATION_SEC = 1.6;
export const KILLCAM_DURATION_SEC = 2.4;

// Settings defaults (user-tunable)
// Sensitivity uses the Source/CS2 convention so the number is portable: a
// "sensitivity" of N rotates N · M_YAW_DEG degrees of yaw per mouse count.
// Internal radians/count = sens · M_YAW_DEG · π/180. DPI only feeds the cm/360
// readout (feel = sens × m_yaw, DPI-independent).
export const M_YAW_DEG = 0.022;
export const DEFAULT_SENSITIVITY = 2.5;
export const MIN_SENSITIVITY = 0.1;
export const MAX_SENSITIVITY = 10;
export const SENSITIVITY_STEP = 0.01;
export const DEFAULT_DPI = 800;
export const MIN_DPI = 100;
export const MAX_DPI = 36000;
export const DEFAULT_VERT_SCALE = 1.0; // pitch multiplier
export const MIN_VERT_SCALE = 0.3;
export const MAX_VERT_SCALE = 2.0;
export const DEFAULT_RAW_INPUT = true; // pointer-lock unadjustedMovement (no OS accel)
export const MAX_LOOK_DELTA_PX = 2000; // per-event spurious-delta cap
export const DEFAULT_FOV = 90;
export const DEFAULT_VOLUME = 0.7;
export const MIN_FOV = 60;
export const MAX_FOV = 110;

// Zoom (hold a bind to narrow FOV for long-range rail shots). Sensitivity is
// scaled by currentFov/baseFov while zoomed so the feel stays consistent.
export const DEFAULT_ZOOM_FOV = 55;
export const MIN_ZOOM_FOV = 20;
export const MAX_ZOOM_FOV = 85;

// First-person railgun viewmodel. Base position sits the gun low and slightly
// to the right so its side profile reads and the crosshair / centre of the
// screen stays clear; the user offsets are added on top. VIEWMODEL_SCALE keeps
// the (third-person-sized) model from overflowing the view up close.
export const VIEWMODEL_BASE = { x: 0.12, y: -0.31, z: -0.5 } as const;
export const VIEWMODEL_SCALE = 0.8;
export const DEFAULT_VIEWMODEL_OFFSET = { x: 0, y: 0, z: 0 } as const;
export const MIN_VIEWMODEL_OFFSET = -0.5;
export const MAX_VIEWMODEL_OFFSET = 0.5;

// Source/CS2 cm-per-360 for a sensitivity + mouse DPI (for the settings readout).
export function cm360(sensitivity: number, dpi: number): number {
  if (sensitivity <= 0 || dpi <= 0) return 0;
  return (360 / (sensitivity * M_YAW_DEG * dpi)) * 2.54;
}

// Rebindable keyboard actions (fire/boost stay on the mouse). Values are
// KeyboardEvent.code strings.
export type KeybindAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'dash'
  | 'zoom'
  | 'scoreboard';

export const KEYBIND_ACTIONS: ReadonlyArray<{ id: KeybindAction; label: string }> = [
  { id: 'forward', label: 'Move forward' },
  { id: 'back', label: 'Move back' },
  { id: 'left', label: 'Strafe left' },
  { id: 'right', label: 'Strafe right' },
  { id: 'jump', label: 'Jump' },
  { id: 'dash', label: 'Dash' },
  { id: 'zoom', label: 'Zoom (hold)' },
  { id: 'scoreboard', label: 'Scoreboard' },
];

export const DEFAULT_KEYBINDS: Record<KeybindAction, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  dash: 'ShiftLeft',
  zoom: 'KeyC',
  scoreboard: 'Tab',
};
