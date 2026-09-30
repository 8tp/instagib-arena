import type { EmoteKind } from './cosmetics';
import { B, REST_ABS } from './character/rig';
import { PoseSpec, SIDE_L, SIDE_R } from './character/pose';
import { compileClip, type Clip, type ClipDef, type KeyDef, type PropKeyDef } from './character/clip';

// ── Authored emotes / taunts ─────────────────────────────────────────────────
//
// Full-body keyframe clips on the combatant's own skeleton (see
// character/clip.ts for the DSL). Conventions (model space, facing −Z,
// right = +X; angles in degrees):
//   spine/chest/neck/head  +X leans back / looks up, −X folds forward
//                          +Y turns to the character's LEFT, +Z rolls left
//   hL/hR   wrist targets in rest-model coords riding the chest
//           (shoulders at x ±0.235, y 1.415; reach ≈ 0.55 m)
//   fL/fR   ankle targets on the ground (y 0.095 = planted)
//   root    [x, y, z, yaw] whole-body hop/spin
// Every clip loops (2–4 s) with anticipation → action → overshoot → settle,
// and keeps the feet planted unless it deliberately hops.

const Y0 = REST_ABS[B.footL][1]; // planted ankle height
const HIP_DIP = -0.025;

// Base stance for every emote (the clip keys only what moves).
export function emoteStance(spec: PoseSpec): void {
  spec.reset();
  spec.handSpace = 'chest';
  spec.foot[SIDE_L].set(-0.13, Y0, 0.0);
  spec.foot[SIDE_R].set(0.13, Y0, 0.01);
  spec.setR(B.footL, 0, 8 * (Math.PI / 180), 0);
  spec.setR(B.footR, 0, -8 * (Math.PI / 180), 0);
  spec.knee[SIDE_L].set(-0.1, 0, -1);
  spec.knee[SIDE_R].set(0.1, 0, -1);
  spec.hips.set(0, HIP_DIP, 0);
  spec.hand[SIDE_L].set(-0.265, 0.9, -0.02);
  spec.hand[SIDE_R].set(0.265, 0.9, -0.02);
  spec.elbow[SIDE_L].set(-0.3, 0, 1);
  spec.elbow[SIDE_R].set(0.3, 0, 1);
}

// Relaxed arms, reused as the neutral key in several clips.
const HL_REST = [-0.265, 0.9, -0.02] as const;
const HR_REST = [0.265, 0.9, -0.02] as const;

// v3 taunt clips. Their `EmoteKind` union members live in cosmetics.ts (the
// orchestrator adds the catalog entries); until then they're addressable here.
export type ExtraEmoteKind = 'airguitar' | 'headbang' | 'robot' | 'kneel' | 'railspin' | 'laugh';
export type AnyEmoteKind = EmoteKind | ExtraEmoteKind;

// ── Meme taunts (v3.1) ───────────────────────────────────────────────────────
// Sillier, louder clips that read from across the arena. Several conjure a
// hard-light prop (emote-props.ts): the clip keys it on a bone like any other
// channel, and it only exists while the clip is playing.

type MemeKind = 'takethel' | 'tpose' | 'crab' | 'facepalm' | 'micdrop' | 'gg' | 'pushups' | 'teatime';

// Hand orientations (oL/oR, chest frame, degrees). Rest: fingers down, palms in.
const FIST_FWD_R = [90, 0, 0] as const; // fingers forward, palm in (mug / stick grip)
const PALM_OUT_UP_R = [180, -90, 0] as const; // fingers up, palm to the crowd
const PALM_UP_R = [0, -90, -90] as const;
const PALM_UP_L = [0, 90, 90] as const;
const PALM_FACE_R = [180, 90, 0] as const; // fingers up, palm back (to the visor)
// A prop gripped in a FIST_FWD hand, standing upright (+Y up) in the palm.
const GRIP_P = [0, -0.068, -0.012] as const;
const GRIP_R = [-90, 0, 0] as const;

// Take the L: right hand throws the L to the forehead (the glyph lights up
// over it), then hop-kick, hop-kick, the free arm flapping, head wagging.
function takeTheL(): ClipDef {
  const P = 0.6;
  const keys: KeyDef[] = [{ t: 0, hR: [0.06, 1.64, -0.26], eR: [0.7, -1, 0.1], oR: PALM_OUT_UP_R }];
  const glyph: PropKeyDef[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = i * P;
    const sd = i % 2 ? -1 : 1;
    keys.push(
      // land, knees soft
      { t: t0, e: 'in', root: [0, 0, 0, 0], hips: [0, -0.1, 0.01], fL: [-0.15, Y0, 0.0], fR: [0.12, Y0, 0.01], kL: [-0.2, 0, -1], hL: [-0.3, 0.98, -0.22], eL: [-0.6, -1, 0.4], r: { hips: [0, 0, 0], spine: [-6, 0, 0], chest: [-2, 0, 0], head: [-4, 0, 2 * sd] } },
      // hop + the leg kicks out
      { t: t0 + 0.22, e: 'out', root: [0, 0.075, 0, 0], hips: [0, -0.02, 0], fL: [-0.48, Y0 + 0.25, -0.06], fR: [0.12, Y0 - 0.02, 0.02], kL: [-1, 0.3, -0.5], hL: [-0.6, 1.24, -0.06], eL: [-0.3, -1, 0.3], r: { hips: [0, 0, -6], spine: [3, 0, 3], chest: [2, 0, 0], head: [6, 8 * sd, 4 * sd] } },
      { t: t0 + 0.42, e: 'in', root: [0, 0, 0, 0], fL: [-0.2, Y0 + 0.05, 0.02], fR: [0.12, Y0, 0.01] },
    );
    glyph.push({ t: t0, e: "in", s: 0.32 }, { t: t0 + 0.22, e: "out", s: 0.36 });
  }
  // On the forehead, just in front of the visor (head bone = neck top, 1.565 m),
  // proud of the fist so the whole L reads from the front.
  glyph[0].p = [0.0, 0.2, -0.36];
  return { duration: 4 * P, loop: true, keys, props: [{ kind: 'glyphL', bone: 'head', keys: glyph }] };
}

// T-pose: tuck, SNAP rigid into a T, then turn on the spot like a mannequin on
// a turntable, hovering an inch off the floor — the head staying locked on
// you as long as it can, then whipping round early to find you again.
const tpose: ClipDef = {
  duration: 4,
  loop: true,
  keys: [
    { t: 0, root: [0, 0, 0, 0], hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] } },
    { t: 0.22, oL: [0, 0, 0], oR: [0, 0, 0], e: 'inOut', hips: [0, -0.08, 0], hL: [-0.2, 0.98, -0.14], hR: [0.2, 0.98, -0.14], eL: [-1, -0.3, 0.4], eR: [1, -0.3, 0.4], r: { spine: [-8, 0, 0], chest: [-4, 0, 0], head: [-12, 0, 0] } },
    // SNAP
    { t: 0.36, e: 'outBack', hips: [0, 0.005, 0], hL: [-0.77, 1.425, 0], hR: [0.77, 1.425, 0], eL: [0, 0, 1], eR: [0, 0, 1], oL: [0, 0, -90], oR: [0, 0, 90], fL: [-0.085, Y0, 0], fR: [0.085, Y0, 0], r: { spine: [2, 0, 0], chest: [2, 0, 0], neck: [0, 0, 0], head: [3, 0, 0] } },
    { t: 0.55, root: [0, 0, 0, 0], r: { neck: [0, 0, 0], head: [3, 0, 0] } },
    // the turntable (linear, motor-driven); the head counter-turns to hold your gaze
    { t: 1.1, e: 'linear', root: [0, 0.045, 0, 70.7], r: { neck: [0, -28, 0], head: [3, -42, 0] } },
    { t: 1.45, e: 'linear', root: [0, 0.05, 0, 116] },
    { t: 1.55, e: 'out', r: { neck: [0, 0, 0], head: [3, 0, 0] } },
    { t: 2.8, e: 'linear', r: { neck: [0, 0, 0], head: [3, 0, 0] } },
    { t: 2.81, e: 'hold', r: { neck: [0, 28, 0], head: [3, 42, 0] } },
    { t: 3.35, e: 'linear', root: [0, 0.045, 0, 360], r: { neck: [0, 0, 0], head: [3, 0, 0] } },
    { t: 3.5, e: 'out', root: [0, 0, 0, 360], hL: [-0.77, 1.425, 0], hR: [0.77, 1.425, 0], oL: [0, 0, -90], oR: [0, 0, 90] },
    // a creepy head tilt, then drop it all
    { t: 3.52, e: 'hold', r: { head: [3, 0, 16] } },
    { t: 3.72, r: { head: [3, 0, 16], spine: [2, 0, 0], chest: [2, 0, 0] } },
    { t: 4, e: 'inOut', root: [0, 0, 0, 360], hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
  ],
};

// Crab walk: deep squat, knees out, claws up and snipping — four scuttling
// side-steps right, four back left.
function crab(): ClipDef {
  const S = 0.4;
  // [fL.x, fR.x, hips.x] at each step (right ×4, then back).
  const plan: [number, number, number][] = [
    [-0.25, 0.25, 0],
    [-0.25, 0.41, 0.08],
    [-0.09, 0.41, 0.16],
    [-0.09, 0.57, 0.24],
    [0.07, 0.57, 0.32],
    [-0.09, 0.57, 0.24],
    [-0.09, 0.41, 0.16],
    [-0.25, 0.41, 0.08],
  ];
  const keys: KeyDef[] = [
    { t: 0, hL: [-0.44, 1.7, -0.2], hR: [0.44, 1.7, -0.2], eL: [-1, -0.7, 0.3], eR: [1, -0.7, 0.3], oL: [150, 60, 0], oR: [150, -60, 0], kL: [-1, 0, -0.6], kR: [1, 0, -0.6] },
  ];
  const mid = (a: number, b: number) => (a + b) / 2;
  for (let i = 0; i < plan.length; i++) {
    const [lx, rx, hx] = plan[i];
    const [nlx, nrx, nhx] = plan[(i + 1) % plan.length];
    const t0 = i * S;
    const liftL = nlx !== lx; // which foot moves on this step
    const sd = nhx > hx ? 1 : -1;
    keys.push(
      { t: t0, e: 'in', fL: [lx, Y0, 0.02], fR: [rx, Y0, 0.02], hips: [hx, -0.22, 0.04], r: { hips: [0, 0, 0], spine: [-4, 0, 0], head: [-2, 0, -6 * sd] } },
      {
        t: t0 + S / 2,
        e: 'out',
        fL: liftL ? [mid(lx, nlx), Y0 + 0.09, 0.0] : [lx, Y0, 0.02],
        fR: liftL ? [rx, Y0, 0.02] : [mid(rx, nrx), Y0 + 0.09, 0.0],
        hips: [mid(hx, nhx), -0.17, 0.04],
        r: { hips: [0, 0, liftL ? 5 : -5], spine: [0, 0, 0], head: [2, 0, 6 * sd] },
      },
    );
  }
  return {
    duration: plan.length * S,
    loop: true,
    keys,
    osc: [
      { ch: 'oL', i: 2, amp: 26, hz: 5 },
      { ch: 'oR', i: 2, amp: 26, hz: 5, phase: 0.5 },
      { ch: 'hL', i: 1, amp: 0.035, hz: 2.5 },
      { ch: 'hR', i: 1, amp: 0.035, hz: 2.5, phase: 0.5 },
    ],
  };
}

// Facepalm: glance at the killfeed … SMACK, palm to visor, head shaking in
// the hand, drag it down the face, then a full-body "why are you like this".
const facepalm: ClipDef = {
  duration: 3,
  loop: true,
  keys: [
    { t: 0, hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] } },
    // wind up: the hand hangs out in front of the visor, head up at the replay
    { t: 0.34, e: 'inOut', hR: [0.16, 1.52, -0.5], eR: [0.8, -1, 0.2], oR: PALM_FACE_R, r: { head: [12, -10, 0], neck: [2, 0, 0], chest: [3, 0, 0] } },
    // SMACK
    { t: 0.46, e: 'in', hR: [0.03, 1.66, -0.25], eR: [1, -0.6, 0.3], r: { head: [14, 0, 0], neck: [4, 0, 0], chest: [4, 0, 0] } },
    // slump into the hand
    { t: 0.66, e: 'outBack', hR: [0.03, 1.65, -0.26], hL: [-0.3, 0.99, 0.03], eL: [-1, 0, -0.2], hips: [0, -0.05, 0], r: { spine: [-3, 0, 0], chest: [-3, 0, 0], neck: [-2, 0, 0], head: [-5, 0, 0] } },
    { t: 1.75, hR: [0.03, 1.64, -0.26], r: { spine: [-5, 0, 0], chest: [-4, 0, 0], neck: [-2, 0, 0], head: [-6, 0, 0] } },
    // drag it down the visor
    { t: 2.05, e: 'in', hR: [0.05, 1.4, -0.3], oR: PALM_FACE_R, r: { head: [-4, 0, 0], neck: [-2, 0, 0] } },
    // exasperated palms-up shrug
    { t: 2.3, e: 'outBack', hL: [-0.46, 1.16, -0.26], hR: [0.46, 1.16, -0.26], eL: [-1, -0.5, 0.3], eR: [1, -0.5, 0.3], oL: PALM_UP_L, oR: PALM_UP_R, hips: [0, -0.01, 0], r: { spine: [2, 0, 0], chest: [4, 0, 0], neck: [0, 0, 0], head: [6, 0, 12] } },
    { t: 2.65, hL: [-0.45, 1.18, -0.26], hR: [0.45, 1.18, -0.26], r: { head: [6, 0, 12] } },
    { t: 3, e: 'inOut', hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] } },
  ],
  osc: [
    { ch: 'r.head', i: 1, amp: 13, hz: 2.6, from: 0.7, to: 1.95, fade: 0.15 },
    { ch: 'r.chest', i: 0, amp: 1.5, hz: 1.3, from: 0.7, to: 1.95 },
  ],
};

// Mic drop: last words into the mic, arm out, a beat… let go. The mic
// clatters on the floor; chin up, hands on hips, you're done here.
const MIC_OUT = [0.66, 1.42, -0.26] as const;
const MIC_HOLD = [0.12, 1.42, -0.34] as const;
const micdrop: ClipDef = {
  duration: 3.2,
  loop: true,
  keys: [
    { t: 0, hR: MIC_HOLD, eR: [1, -0.6, 0.3], oR: FIST_FWD_R, hL: [-0.34, 1.12, -0.22], eL: [-0.8, -0.8, 0.4], oL: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [2, 0, 0], neck: [0, 0, 0], head: [-6, 0, 0] } },
    { t: 0.7, e: 'inOut', hR: [0.12, 1.44, -0.34], hL: [-0.46, 1.22, -0.26], r: { chest: [4, 6, 0], head: [-2, -6, 0] } },
    // arm out, look at it
    { t: 0.95, e: 'outBack', hR: MIC_OUT, eR: [0.3, -1, 0.3], hL: [-0.3, 0.98, -0.1], eL: [-0.4, -0.6, 0.8], r: { spine: [2, -4, 0], chest: [4, -6, 0], neck: [0, -10, 0], head: [4, -18, 0] } },
    { t: 1.35, hR: MIC_OUT, oR: FIST_FWD_R, r: { head: [2, -20, 0] } },
    // …drop (the wrist flicks open)
    { t: 1.45, e: 'out', hR: [0.67, 1.46, -0.24], oR: [40, 0, -30] },
    // turn away: chin up, hands on hips
    { t: 1.8, e: 'outBack', hR: [0.3, 1.0, 0.02], eR: [1, 0, -0.2], oR: [0, 0, 20], hL: [-0.3, 1.0, 0.02], eL: [-1, 0, -0.2], oL: [0, 0, -20], hips: [0, -0.01, 0], r: { spine: [4, 10, 0], chest: [6, 8, 0], neck: [0, 14, 0], head: [16, 22, 0] } },
    { t: 2.75, hR: [0.3, 1.0, 0.02], hL: [-0.3, 1.0, 0.02], r: { head: [14, 24, 0] } },
    { t: 3.2, e: 'inOut', hR: MIC_HOLD, eR: [1, -0.6, 0.3], oR: FIST_FWD_R, hL: [-0.34, 1.12, -0.22], eL: [-0.8, -0.8, 0.4], oL: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [2, 0, 0], neck: [0, 0, 0], head: [-6, 0, 0] } },
  ],
  osc: [{ ch: 'r.head', i: 0, amp: 5, hz: 3.2, from: 0.05, to: 0.75 }],
  props: [
    // in the hand until the release…
    { kind: 'mic', bone: 'hand.R', from: 0, to: 1.42, pop: [0.14, 0], keys: [{ t: 0, p: GRIP_P, r: GRIP_R }] },
    // …then in ground space: fall, bounce, roll, dematerialise.
    {
      kind: 'mic',
      bone: 'root',
      from: 1.42,
      to: 3.05,
      pop: [0, 0.25],
      keys: [
        { t: 1.42, p: [0.64, 1.34, -0.33], r: [0, 0, 0] },
        { t: 1.94, e: 'in', p: [0.68, 0.03, -0.36], r: [0, 0, -62] },
        { t: 2.06, e: 'out', p: [0.71, 0.11, -0.37], r: [0, 30, -80] },
        { t: 2.18, e: 'in', p: [0.74, 0.025, -0.38], r: [0, 40, -90] },
        { t: 2.5, e: 'out', p: [0.77, 0.025, -0.39], r: [0, 55, -90] },
      ],
    },
  ],
};

// GG: whip a hard-light "GG" picket sign overhead, pump it, wag it.
const gg: ClipDef = {
  duration: 2.8,
  loop: true,
  keys: [
    { t: 0, hR: [0.26, 0.98, -0.16], eR: [0.4, -0.5, 1], oR: FIST_FWD_R, hL: HL_REST, eL: [-0.3, 0, 1], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    { t: 0.16, e: 'inOut', hR: [0.24, 1.02, -0.2], hips: [0, -0.08, 0], r: { spine: [-6, 0, 0], head: [-8, 0, 0] } },
    { t: 0.4, e: 'outBack', hR: [0.3, 1.82, -0.14], eR: [1, -0.4, 0.3], hL: [-0.42, 1.34, -0.24], eL: [-0.8, -1, 0.3], hips: [0, -0.01, 0], r: { spine: [5, 0, -3], chest: [6, 0, -3], head: [10, -6, 4] } },
    { t: 1.7, hR: [0.3, 1.82, -0.14], hL: [-0.42, 1.34, -0.24], oR: FIST_FWD_R, r: { head: [10, 6, -4] } },
    // wag it
    { t: 1.9, e: 'inOut', oR: [90, 0, 18] },
    { t: 2.1, e: 'inOut', oR: [90, 0, -18] },
    { t: 2.3, e: 'inOut', oR: [90, 0, 10], hR: [0.3, 1.8, -0.14] },
    { t: 2.8, e: 'inOut', hR: [0.26, 0.98, -0.16], eR: [0.4, -0.5, 1], oR: FIST_FWD_R, hL: HL_REST, eL: [-0.3, 0, 1], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
  ],
  osc: [
    { ch: 'hR', i: 1, amp: 0.07, hz: 2.6, from: 0.45, to: 1.75, fade: 0.1 },
    { ch: 'hL', i: 1, amp: 0.06, hz: 2.6, phase: 0.5, from: 0.45, to: 1.75, fade: 0.1 },
    { ch: 'hips', i: 1, amp: 0.02, hz: 2.6, phase: 0.25, from: 0.45, to: 1.75 },
  ],
  props: [{ kind: 'ggSign', bone: 'hand.R', from: 0.12, to: 2.62, pop: 0.16, keys: [{ t: 0, p: GRIP_P, r: GRIP_R }] }],
};

// Push-ups: drop and give me… three. Two clean reps, a clap rep, spring up,
// dust off the gauntlets. (The body goes to the floor on purpose.)
const PLANK_UP = { root: [0, 0.1, 0.45, 0], hL: [-0.26, 1.237, -0.497], hR: [0.26, 1.237, -0.497], oL: [0, -90, -159], oR: [0, 90, 159] } as const;
const PLANK_DN = { root: [0, 0.1, 0.45, 0], hL: [-0.26, 1.305, -0.279], hR: [0.26, 1.305, -0.279], oL: [0, -90, -169], oR: [0, 90, 169] } as const;
const pushups: ClipDef = {
  duration: 3.6,
  loop: true,
  keys: [
    { t: 0, root: [0, 0, 0, 0], r: { root: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] }, hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01] },
    { t: 0.22, e: 'inOut', hips: [0, -0.14, 0], hL: [-0.24, 1.1, -0.3], hR: [0.24, 1.1, -0.3], eL: [-0.6, -1, 0.2], eR: [0.6, -1, 0.2], r: { root: [-8, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0] } },
    // timber — catch in the plank
    { t: 0.52, e: 'in', ...PLANK_UP, hips: [0, HIP_DIP, 0], eL: [-0.5, -0.6, 0.6], eR: [0.5, -0.6, 0.6], fL: [-0.12, Y0, 0], fR: [0.12, Y0, 0], r: { root: [-69, 0, 0], spine: [0, 0, 0], head: [16, 0, 0] } },
    { t: 0.62, e: 'out', r: { root: [-71, 0, 0], head: [14, 0, 0] } },
    { t: 0.72, e: 'inOut', ...PLANK_UP, r: { root: [-69, 0, 0], head: [16, 0, 0] } },
    // rep 1
    { t: 1.0, e: 'inOut', ...PLANK_DN, r: { root: [-79, 0, 0], head: [22, 0, 0] } },
    { t: 1.25, e: 'inOut', ...PLANK_UP, r: { root: [-69, 0, 0], head: [16, 0, 0] } },
    // rep 2
    { t: 1.5, e: 'inOut', ...PLANK_DN, r: { root: [-79, 0, 0], head: [22, 0, 0] } },
    // clap rep: explode up, hands off the floor, clap, catch
    { t: 1.72, e: 'out', root: [0, 0.14, 0.45, 0], r: { root: [-63, 0, 0], head: [12, 0, 0] }, hL: [-0.035, 1.18, -0.42], hR: [0.035, 1.18, -0.42], oL: [90, 0, 0], oR: FIST_FWD_R },
    { t: 1.92, e: 'in', ...PLANK_UP, r: { root: [-69, 0, 0], head: [16, 0, 0] } },
    { t: 2.08, e: 'out', ...PLANK_DN, r: { root: [-76, 0, 0], head: [20, 0, 0] } },
    { t: 2.3, e: 'inOut', ...PLANK_UP, r: { root: [-69, 0, 0], head: [16, 0, 0] } },
    // spring back up
    { t: 2.72, e: 'outBack', root: [0, 0.04, 0, 0], r: { root: [0, 0, 0], spine: [2, 0, 0], head: [6, 0, 0] }, hips: [0, -0.02, 0], hL: [-0.12, 1.08, -0.28], hR: [0.12, 1.08, -0.28], oL: [90, 0, 0], oR: FIST_FWD_R, eL: [-0.6, -1, 0.3], eR: [0.6, -1, 0.3] },
    { t: 2.82, e: 'in', root: [0, 0, 0, 0] },
    // dust off the gauntlets
    { t: 3.0, e: 'inOut', hL: [-0.02, 1.08, -0.3], hR: [0.14, 1.12, -0.28] },
    { t: 3.15, e: 'inOut', hL: [-0.14, 1.12, -0.28], hR: [0.02, 1.08, -0.3] },
    { t: 3.6, e: 'inOut', root: [0, 0, 0, 0], r: { root: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] }, hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0] },
  ],
};

// Tea time: saucer in one hand, cup in the other; a long, satisfied sip, then
// a slow look away. None of your business, really.
const teatime: ClipDef = {
  duration: 3.4,
  loop: true,
  keys: [
    { t: 0, hL: [-0.1, 1.14, -0.3], eL: [-1, -0.6, 0.2], oL: PALM_UP_L, hR: [0.12, 1.2, -0.3], eR: [1, -0.6, 0.2], oR: FIST_FWD_R, hips: [0.02, -0.03, 0], r: { hips: [0, 0, -3], spine: [2, 0, 2], chest: [2, 0, 0], neck: [0, 0, 0], head: [-6, 0, 0] } },
    { t: 0.45, e: 'inOut', hR: [0.07, 1.5, -0.3], oR: [100, 0, 0], r: { head: [0, 0, 0] } },
    { t: 0.75, e: 'inOut', hR: [0.05, 1.56, -0.26], oR: [132, 0, 0], r: { neck: [4, 0, 0], head: [16, 0, 0], chest: [5, 0, 0] } },
    { t: 1.4, hR: [0.05, 1.57, -0.25], oR: [138, 0, 0], r: { neck: [4, 0, 0], head: [18, 0, 0], chest: [6, 0, 0] } },
    // lower… and look away
    { t: 1.8, e: 'inOut', hR: [0.13, 1.21, -0.3], oR: FIST_FWD_R, r: { neck: [0, 12, 0], head: [6, 26, 6], chest: [3, 4, 0] } },
    { t: 2.9, hR: [0.13, 1.21, -0.3], r: { neck: [0, 14, 0], head: [7, 30, 8], chest: [3, 4, 0] } },
    { t: 3.4, e: 'inOut', hR: [0.12, 1.2, -0.3], oR: FIST_FWD_R, r: { neck: [0, 0, 0], head: [-6, 0, 0], chest: [2, 0, 0] } },
  ],
  osc: [
    { ch: 'oR', i: 0, amp: 3, hz: 2.2, from: 0.8, to: 1.4, fade: 0.1 },
    { ch: 'r.chest', i: 0, amp: 1.2, cycles: 2 },
  ],
  props: [
    { kind: 'saucer', bone: 'hand.L', keys: [{ t: 0, p: [0.035, -0.07, -0.01], r: [0, 0, -90] }] },
    { kind: 'teacup', bone: 'hand.R', keys: [{ t: 0, p: [-0.06, -0.06, 0.035], r: GRIP_R }] },
  ],
};

const MEMES: Record<MemeKind, ClipDef> = {
  takethel: takeTheL(),
  tpose,
  crab: crab(),
  facepalm,
  micdrop,
  gg,
  pushups,
  teatime,
};

const DEFS: Record<AnyEmoteKind, ClipDef> = {
  ...MEMES,
  // Locker "character" view idle: weight on one hip, breathing, a glance.
  idle: {
    duration: 4,
    loop: true,
    keys: [
      { t: 0, hips: [0.02, -0.03, 0], r: { hips: [0, 0, -3], spine: [1, 0, 2], chest: [0, 0, 1], head: [0, 6, 0] }, hL: HL_REST, hR: [0.255, 0.91, -0.05] },
      { t: 2, hips: [-0.018, -0.03, 0], r: { hips: [0, 0, 3], spine: [1, 0, -2], chest: [0, 0, -1], head: [2, -7, 0] }, hL: [-0.255, 0.91, -0.05], hR: HR_REST },
    ],
    osc: [
      { ch: 'r.chest', i: 0, amp: 1.2, cycles: 1 },
      { ch: 'hips', i: 1, amp: 0.004, cycles: 2 },
    ],
  },

  // Victory Cheer: crouch, explode up into a V, land, pump each fist, reset.
  cheer: {
    duration: 2.4,
    loop: true,
    keys: [
      // anticipation
      { t: 0, hips: [0, -0.13, 0.02], r: { spine: [-14, 0, 0], chest: [-6, 0, 0], head: [-10, 0, 0] }, hL: [-0.28, 0.98, 0.1], hR: [0.28, 0.98, 0.1], eL: [-0.3, -0.2, 1], eR: [0.3, -0.2, 1], root: [0, 0, 0, 0], fL: [-0.14, Y0, 0], fR: [0.14, Y0, 0.01] },
      // launch
      { t: 0.24, e: 'out', hips: [0, 0.01, 0], root: [0, 0.3, 0, 0], r: { spine: [8, 0, 0], chest: [6, 0, 0], head: [16, 0, 0] }, hL: [-0.5, 2.15, -0.05], hR: [0.5, 2.15, -0.05], eL: [-1, 0.2, 0.3], eR: [1, 0.2, 0.3], fL: [-0.12, Y0 + 0.06, 0.08], fR: [0.12, Y0 + 0.03, 0.1] },
      { t: 0.46, e: 'in', root: [0, 0, 0, 0], fL: [-0.14, Y0, 0], fR: [0.14, Y0, 0.01] },
      // land + absorb
      { t: 0.58, e: 'out', hips: [0, -0.12, 0.02], r: { spine: [-6, 0, 0], chest: [0, 0, 0], head: [6, 0, 0] }, hL: [-0.48, 2.02, -0.02], hR: [0.48, 2.02, -0.02] },
      { t: 0.8, hips: [0, -0.03, 0], r: { spine: [4, 0, 0], chest: [4, 0, 0], head: [12, 0, 0] }, hL: [-0.46, 2.08, -0.05], hR: [0.46, 2.08, -0.05], eL: [-1, 0.2, 0.3], eR: [1, 0.2, 0.3] },
      // fist pumps: yank each fist down to the shoulder, punch it back up
      { t: 1.02, e: 'inBack', hR: [0.24, 1.36, -0.16], eR: [0.5, -1, 0.3], hL: [-0.46, 2.06, -0.05], hips: [0, -0.07, 0], r: { chest: [-2, 10, 0], head: [6, 6, 0] } },
      { t: 1.22, e: 'outBack', hR: [0.4, 2.1, -0.1], eR: [1, 0.2, 0.3], hips: [0, -0.02, 0], r: { chest: [4, 0, 0], head: [14, 0, 0] } },
      { t: 1.46, e: 'inBack', hL: [-0.24, 1.36, -0.16], eL: [-0.5, -1, 0.3], hR: [0.4, 2.08, -0.1], hips: [0, -0.07, 0], r: { chest: [-2, -10, 0], head: [6, -6, 0] } },
      { t: 1.66, e: 'outBack', hL: [-0.4, 2.1, -0.1], eL: [-1, 0.2, 0.3], hips: [0, -0.02, 0], r: { chest: [4, 0, 0], head: [14, 0, 0] } },
      // arms drop, settle into the next anticipation
      { t: 2.05, hL: [-0.36, 1.2, -0.12], hR: [0.36, 1.2, -0.12], eL: [-0.4, -0.6, 0.8], eR: [0.4, -0.6, 0.8], hips: [0, -0.06, 0], r: { spine: [-4, 0, 0], chest: [0, 0, 0], head: [2, 0, 0] } },
    ],
  },

  // Wave: weight onto the left leg, elbow out, open palm to the crowd,
  // forearm and wrist swinging.
  wave: {
    duration: 3,
    loop: true,
    keys: [
      { t: 0, hR: HR_REST, eR: [0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { hips: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0] } },
      { t: 0.2, e: 'in', hR: [0.32, 1.3, -0.22], eR: [0.8, -0.6, 0.4], oR: [110, -40, 0] },
      { t: 0.44, e: 'outBack', hR: [0.44, 1.8, -0.14], eR: [1, -0.55, 0.15], oR: [180, -90, 0], hips: [-0.035, -0.03, 0], r: { hips: [0, 4, 4], spine: [0, -4, -3], head: [4, -8, 7] } },
      { t: 2.3, hR: [0.44, 1.79, -0.14], oR: [180, -90, 0] },
      { t: 2.55, e: 'in', hR: [0.33, 1.2, -0.16], eR: [0.6, -0.5, 0.5], oR: [80, -30, 0] },
      { t: 3, e: 'out', hR: HR_REST, eR: [0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { hips: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0] } },
    ],
    osc: [
      { ch: 'hR', i: 0, amp: 0.13, hz: 2.4, from: 0.5, to: 2.35, fade: 0.2 },
      { ch: 'oR', i: 1, amp: 24, hz: 2.4, phase: 0.18, from: 0.5, to: 2.35, fade: 0.2 },
      { ch: 'r.head', i: 2, amp: 3, hz: 1.2, from: 0.5, to: 2.35 },
      { ch: 'r.chest', i: 2, amp: 2, hz: 2.4, phase: 0.5, from: 0.5, to: 2.35 },
    ],
  },

  // Flex: hunch (anticipation) → snap into a double biceps → side chest.
  flex: {
    duration: 3.4,
    loop: true,
    keys: [
      { t: 0, hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0], hips: [0, 0, 0] } },
      { t: 0.4, hL: [-0.14, 1.02, -0.24], hR: [0.14, 1.02, -0.24], eL: [-1, 0, 0.3], eR: [1, 0, 0.3], oL: [70, 0, 0], oR: [70, 0, 0], hips: [0, -0.09, 0], r: { spine: [-12, 0, 0], chest: [-8, 0, 0], head: [-8, 0, 0] } },
      { t: 0.62, e: 'outBack', hL: [-0.48, 1.74, -0.05], hR: [0.48, 1.74, -0.05], eL: [-1, -0.45, 0.05], eR: [1, -0.45, 0.05], oL: [186, 0, 0], oR: [186, 0, 0], hips: [0, -0.01, 0], r: { spine: [6, 0, 0], chest: [9, 0, 0], head: [8, 0, 0] } },
      { t: 1.5, hL: [-0.47, 1.72, -0.05], hR: [0.47, 1.72, -0.05], hips: [0, -0.02, 0] },
      // side chest: twist right, left fist to the right palm, chest out
      { t: 1.85, e: 'outBack', hL: [0.06, 1.2, -0.24], hR: [0.14, 1.12, -0.2], eL: [-0.6, -0.5, 0.4], eR: [0.8, -0.3, 0.6], oL: [90, 0, 0], oR: [90, 0, 0], hips: [0.02, -0.05, 0], r: { hips: [0, -12, 0], spine: [2, -10, 0], chest: [8, -14, 0], head: [6, 22, 0] } },
      { t: 2.8, hL: [0.05, 1.21, -0.24], hR: [0.14, 1.13, -0.2], hips: [0.02, -0.05, 0] },
      { t: 3.4, hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], oL: [0, 0, 0], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { hips: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
    osc: [
      { ch: 'hips', i: 1, amp: 0.008, hz: 3, from: 0.7, to: 1.5 },
      { ch: 'r.chest', i: 0, amp: 1.5, hz: 3, from: 0.7, to: 1.5 },
    ],
  },

  // Spin: wind up, pirouette with arms flung out and a hop, stick it — ta-da.
  spin: {
    duration: 2.6,
    loop: true,
    keys: [
      { t: 0, root: [0, 0, 0, 0], hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], r: { spine: [0, 0, 0], head: [0, 0, 0], chest: [0, 0, 0] } },
      { t: 0.35, root: [0, 0, 0, -30], hips: [0, -0.1, 0], hL: [-0.12, 1.08, -0.2], hR: [0.2, 1.05, 0.12], r: { spine: [-8, -12, 0], chest: [-4, -14, 0], head: [-4, 20, 0] } },
      { t: 0.55, e: 'out', root: [0, 0.16, 0, 40], hips: [0, 0.0, 0], hL: [-0.78, 1.46, 0.02], hR: [0.78, 1.46, 0.02], eL: [-0.2, -1, 0.2], eR: [0.2, -1, 0.2], r: { spine: [4, 0, 0], chest: [2, 0, 0], head: [8, 0, 0] } },
      { t: 1.05, e: 'linear', root: [0, 0.2, 0, 260] },
      { t: 1.35, e: 'out', root: [0, 0, 0, 372], hips: [0, -0.1, 0], hL: [-0.62, 1.3, -0.1], hR: [0.62, 1.3, -0.1], r: { spine: [-6, 0, 0], head: [-2, 0, 0] } },
      // ta-da: arms up and out, chest proud
      { t: 1.6, e: 'outBack', root: [0, 0, 0, 360], hips: [0, -0.02, 0], hL: [-0.66, 1.78, -0.22], hR: [0.66, 1.78, -0.22], eL: [-0.4, -1, 0.3], eR: [0.4, -1, 0.3], r: { spine: [5, 0, 0], chest: [6, 0, 0], head: [12, 0, 0] } },
      { t: 2.2, hL: [-0.64, 1.76, -0.22], hR: [0.64, 1.76, -0.22], hips: [0, -0.03, 0] },
      { t: 2.6, root: [0, 0, 0, 360], hips: [0, HIP_DIP, 0], hL: HL_REST, hR: HR_REST, eL: [-0.3, 0, 1], eR: [0.3, 0, 1], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
  },

  // Disco: Travolta point on the beat, hips swinging, left hand on the hip.
  dance: {
    duration: 2,
    loop: true,
    keys: [
      { t: 0, e: 'outBack', hR: [0.58, 1.98, -0.22], eR: [0.6, -1, 0.3], hL: [-0.2, 1.0, 0.03], eL: [-1, 0, 0.2], hips: [0.045, -0.04, 0], r: { hips: [0, -6, -7], spine: [0, 4, 5], chest: [2, 6, 3], head: [10, -18, 5], 'hand.R': [0, 0, 20] }, fL: [-0.15, Y0, 0], fR: [0.15, Y0 + 0.0, 0.02] },
      { t: 0.5, e: 'inOut', hR: [-0.22, 0.98, -0.26], eR: [0.6, -1, 0.5], hips: [-0.045, -0.06, 0], r: { hips: [0, 6, 7], spine: [-4, -4, -5], chest: [-4, -8, -3], head: [-10, 10, -5], 'hand.R': [0, 0, -10] } },
      { t: 1, e: 'outBack', hR: [0.58, 1.98, -0.22], hips: [0.045, -0.04, 0], r: { hips: [0, -6, -7], spine: [0, 4, 5], chest: [2, 6, 3], head: [10, -18, 5], 'hand.R': [0, 0, 20] } },
      { t: 1.5, e: 'inOut', hR: [-0.22, 0.98, -0.26], hips: [-0.045, -0.06, 0], r: { hips: [0, 6, 7], spine: [-4, -4, -5], chest: [-4, -8, -3], head: [-10, 10, -5], 'hand.R': [0, 0, -10] } },
    ],
    osc: [
      { ch: 'hips', i: 1, amp: 0.022, cycles: 8, phase: 0.25 },
      { ch: 'r.neck', i: 0, amp: 5, cycles: 8, phase: 0.1 },
      { ch: 'fL', i: 1, amp: 0.02, cycles: 2, phase: 0.75 },
    ],
  },

  // Salute: snap to attention, flat hand to the brow, hold, snap down.
  salute: {
    duration: 2.8,
    loop: true,
    keys: [
      { t: 0, hR: HR_REST, eR: [0.3, 0, 1], hL: HL_REST, oR: [0, 0, 0], hips: [0, HIP_DIP, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
      // heels together, stand tall
      { t: 0.22, e: 'out', fL: [-0.085, Y0, 0], fR: [0.085, Y0, 0], hips: [0, 0.0, 0], hL: [-0.235, 0.88, 0.0], r: { spine: [3, 0, 0], chest: [4, 0, 0], head: [4, 0, 0] } },
      { t: 0.3, e: 'in', hR: [0.36, 1.35, -0.16], eR: [1, -0.4, 0.1], oR: [-20, 50, 70] },
      { t: 0.46, e: 'outBack', hR: [0.15, 1.7, -0.15], eR: [1, 0.15, -0.1], oR: [-53, 112, 146] },
      { t: 1.9, hR: [0.15, 1.7, -0.15], hL: [-0.235, 0.88, 0.0], oR: [-53, 112, 146], r: { head: [5, 0, 0] } },
      { t: 2.1, e: 'inBack', hR: [0.3, 1.1, -0.1], eR: [0.6, -0.3, 0.6], oR: [-10, 30, 40] },
      { t: 2.35, e: 'out', hR: [0.245, 0.88, 0.0], eR: [0.3, 0, 1], oR: [0, 0, 0] },
      { t: 2.8, fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], hR: HR_REST, hL: HL_REST, hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
  },

  // Come get some: palm up, fingers curl twice, then arms spread wide.
  beckon: {
    duration: 2.8,
    loop: true,
    keys: [
      { t: 0, hR: HR_REST, hL: HL_REST, eR: [0.3, 0, 1], eL: [-0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
      { t: 0.35, e: 'outBack', hR: [0.18, 1.3, -0.47], eR: [0.7, -1, 0.2], oR: [0, -90, -100], fL: [-0.15, Y0, -0.1], fR: [0.15, Y0, 0.1], hips: [0, -0.06, 0.02], r: { spine: [4, 8, 0], chest: [6, 10, 0], head: [-6, -14, 0] } },
      { t: 1.35, hR: [0.18, 1.3, -0.45], oR: [0, -90, -100] },
      { t: 1.65, e: 'outBack', hR: [0.64, 1.38, -0.24], hL: [-0.64, 1.38, -0.24], eR: [0.2, -1, 0.4], eL: [-0.2, -1, 0.4], oR: [0, -163, -95], hips: [0, -0.02, 0], r: { spine: [8, 0, 0], chest: [10, 0, 0], head: [12, 0, 0] } },
      { t: 2.3, hR: [0.62, 1.37, -0.24], hL: [-0.62, 1.37, -0.24], oR: [0, -163, -95] },
      { t: 2.8, hR: HR_REST, hL: HL_REST, eR: [0.3, 0, 1], eL: [-0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
    osc: [
      { ch: 'oR', i: 2, amp: 32, hz: 2, phase: 0.25, from: 0.45, to: 1.4, fade: 0.1 },
      { ch: 'r.head', i: 0, amp: 4, hz: 2, from: 0.45, to: 1.4 },
    ],
  },

  // Slow clap: weight back on one hip, three slow claps, head shaking.
  slowclap: {
    duration: 3.3,
    loop: true,
    keys: [
      { t: 0, hL: [-0.19, 1.3, -0.3], hR: [0.19, 1.3, -0.3], eL: [-1, -1, 0.3], eR: [1, -1, 0.3], oL: [115, 0, 0], oR: [115, 0, 0], hips: [0.03, -0.035, 0], r: { hips: [0, 0, -4], spine: [4, 0, 3], chest: [2, 0, 0], head: [-4, 0, 0] }, fL: [-0.13, Y0, -0.02], fR: [0.15, Y0, 0.04] },
      { t: 0.55, e: 'in', hL: [-0.045, 1.3, -0.34], hR: [0.045, 1.3, -0.34] },
      { t: 1.1, e: 'out', hL: [-0.19, 1.31, -0.3], hR: [0.19, 1.31, -0.3] },
      { t: 1.65, e: 'in', hL: [-0.045, 1.3, -0.34], hR: [0.045, 1.3, -0.34] },
      { t: 2.2, e: 'out', hL: [-0.19, 1.31, -0.3], hR: [0.19, 1.31, -0.3] },
      { t: 2.75, e: 'in', hL: [-0.045, 1.3, -0.34], hR: [0.045, 1.3, -0.34] },
      { t: 3.3, e: 'out', hL: [-0.19, 1.3, -0.3], hR: [0.19, 1.3, -0.3] },
    ],
    osc: [
      { ch: 'r.head', i: 1, amp: 7, cycles: 3, phase: 0 },
      { ch: 'r.chest', i: 0, amp: 1.5, cycles: 6, phase: 0.1 },
    ],
  },

  // Present arms: twirl the railgun beside the body, catch it barrel-up in
  // front of the chest, hold at attention, snap back to the ready.
  flourish: {
    duration: 3.4,
    loop: true,
    gun: true,
    keys: [
      { t: 0, hR: [0.22, 1.12, -0.24], eR: [0.5, -1, 0.4], hL: HL_REST, eL: [-0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
      { t: 0.3, e: 'out', hR: [0.44, 1.3, -0.14], eR: [0.8, -1, 0.1], oR: [25, 0, 0], r: { head: [-6, -14, 0] } },
      { t: 1.15, e: 'linear', hR: [0.45, 1.32, -0.12], oR: [-600, 0, 0] },
      { t: 1.35, e: 'out', hR: [0.03, 1.04, -0.36], eR: [0.9, -1, 0.3], hL: [0.02, 1.36, -0.3], eL: [-0.9, -1, 0.2], oR: [-630, 0, 0], fL: [-0.09, Y0, 0], fR: [0.09, Y0, 0], r: { head: [3, 0, 0], chest: [5, 0, 0], spine: [2, 0, 0] } },
      { t: 1.5, e: 'outBack', hR: [0.03, 1.05, -0.35], hL: [0.02, 1.37, -0.29] },
      { t: 2.7, hR: [0.03, 1.05, -0.35], hL: [0.02, 1.37, -0.29], oR: [-630, 0, 0], fL: [-0.09, Y0, 0], fR: [0.09, Y0, 0] },
      { t: 3.0, e: 'inOut', hR: [0.22, 1.12, -0.24], eR: [0.5, -1, 0.4], hL: HL_REST, eL: [-0.3, 0, 1], oR: [-720, 0, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], r: { head: [0, 0, 0], chest: [0, 0, 0], spine: [0, 0, 0] } },
      { t: 3.4, oR: [-720, 0, 0] },
    ],
  },

  // Air guitar: wide stance, fret hand up the neck, strum hand hammering the
  // body of an invisible axe, a knee-drop lean-back solo, then the windmill.
  airguitar: {
    duration: 3.2,
    loop: true,
    keys: [
      { t: 0, hips: [0, -0.1, 0], fL: [-0.22, Y0, 0.02], fR: [0.22, Y0, 0.02], hL: [-0.4, 1.32, -0.34], eL: [-1, -0.3, 0.2], hR: [0.16, 1.02, -0.2], eR: [0.6, -1, 0.5], r: { spine: [-6, -8, 0], chest: [-4, -10, 0], head: [-14, 14, 0] } },
      { t: 0.8, e: 'inOut', hips: [0.02, -0.14, 0], hL: [-0.46, 1.42, -0.3], r: { spine: [-10, -10, 0], chest: [-6, -12, 0], head: [-18, 16, 0] } },
      // solo: lean back, chin up, fret hand shoots up the neck
      { t: 1.35, e: 'outBack', hips: [0, -0.2, 0.03], hL: [-0.5, 1.62, -0.26], hR: [0.2, 1.0, -0.2], r: { spine: [10, -6, 0], chest: [12, -8, 0], head: [22, 8, 0] } },
      { t: 2.1, hips: [0, -0.2, 0.03], r: { spine: [12, -6, 0], chest: [14, -8, 0], head: [24, 8, 0] } },
      // windmill: right arm sweeps a big circle
      { t: 2.5, e: 'in', hips: [0, -0.1, 0], hR: [0.55, 1.95, -0.1], eR: [1, 0, 0.2], hL: [-0.4, 1.32, -0.34], r: { spine: [-4, -8, 0], chest: [0, -10, 0], head: [-6, 12, 0] } },
      { t: 2.85, e: 'inOut', hR: [0.3, 0.75, -0.3], r: { spine: [-16, -10, 0], chest: [-10, -10, 0], head: [-20, 14, 0] } },
      { t: 3.2, e: 'inOut', hips: [0, -0.1, 0], hR: [0.16, 1.02, -0.2], eR: [0.6, -1, 0.5], hL: [-0.4, 1.32, -0.34], r: { spine: [-6, -8, 0], chest: [-4, -10, 0], head: [-14, 14, 0] } },
    ],
    osc: [
      { ch: 'hR', i: 1, amp: 0.1, hz: 4.5, from: 0.15, to: 2.3, fade: 0.15 },
      { ch: 'hR', i: 2, amp: 0.05, hz: 4.5, phase: 0.25, from: 0.15, to: 2.3, fade: 0.15 },
      { ch: 'hips', i: 1, amp: 0.02, hz: 2.25, from: 0, to: 2.3 },
      { ch: 'r.head', i: 0, amp: 5, hz: 2.25, from: 0, to: 2.3 },
      { ch: 'hL', i: 1, amp: 0.05, hz: 2.25, phase: 0.3, from: 0.6, to: 2.2, fade: 0.2 },
    ],
  },

  // Headbang: horns up, torso folding hard on every beat.
  headbang: {
    duration: 2.4,
    loop: true,
    keys: [
      { t: 0, hips: [0, -0.1, 0], fL: [-0.2, Y0, 0], fR: [0.2, Y0, 0.02], hR: [0.5, 1.95, -0.08], eR: [1, 0, 0.2], oR: [90, 0, 0], hL: [-0.3, 0.98, -0.16], eL: [-0.6, -1, 0.5], r: { spine: [-14, 0, 0], chest: [-10, 0, 0], head: [-24, 0, 0] } },
      { t: 1.2, e: 'inOut', hips: [0, -0.13, 0], r: { spine: [-20, 0, 0], chest: [-14, 0, 0], head: [-30, 0, 0] } },
      { t: 2.4, e: 'inOut', hips: [0, -0.1, 0], r: { spine: [-14, 0, 0], chest: [-10, 0, 0], head: [-24, 0, 0] } },
    ],
    osc: [
      { ch: 'r.head', i: 0, amp: 30, cycles: 6, phase: 0.75 },
      { ch: 'r.chest', i: 0, amp: 12, cycles: 6, phase: 0.7 },
      { ch: 'r.spine', i: 0, amp: 8, cycles: 6, phase: 0.7 },
      { ch: 'hips', i: 1, amp: 0.035, cycles: 12, phase: 0.5 },
      { ch: 'hR', i: 1, amp: 0.06, cycles: 6, phase: 0.75 },
    ],
  },

  // Robot: everything snaps between right-angle poses on hard holds.
  robot: {
    duration: 3,
    loop: true,
    keys: [
      { t: 0, e: 'hold', hips: [0, HIP_DIP, 0], hL: [-0.42, 1.0, -0.1], eL: [-1, 0, 0], hR: [0.42, 1.42, -0.1], eR: [1, 0.6, 0], r: { spine: [0, 0, 0], head: [0, 0, 0] } },
      { t: 0.5, e: 'hold', hL: [-0.42, 1.42, -0.1], eL: [-1, 0.6, 0], hR: [0.42, 1.0, -0.1], eR: [1, 0, 0], r: { head: [0, 42, 0], chest: [0, 8, 0] } },
      { t: 1, e: 'hold', hL: [-0.3, 1.2, -0.42], eL: [-0.4, 0, 0], hR: [0.3, 1.2, -0.42], eR: [0.4, 0, 0], r: { head: [0, -42, 0], chest: [0, -8, 0] } },
      { t: 1.5, e: 'hold', hL: [-0.5, 1.7, -0.05], eL: [-1, 0, 0], hR: [0.42, 1.0, -0.1], eR: [1, 0, 0], r: { head: [14, 0, 0], chest: [0, 0, 0], spine: [0, 0, 0] } },
      { t: 2, e: 'hold', hL: [-0.42, 1.0, -0.1], eL: [-1, 0, 0], hR: [0.5, 1.7, -0.05], eR: [1, 0, 0], r: { head: [-8, 0, 12], spine: [0, 12, 0] } },
      { t: 2.5, e: 'hold', hL: [-0.42, 1.0, -0.1], hR: [0.42, 1.42, -0.1], eR: [1, 0.6, 0], r: { head: [0, 0, 0], spine: [0, 0, 0] } },
      { t: 3, e: 'hold', hips: [0, HIP_DIP, 0] },
    ],
    osc: [{ ch: 'hips', i: 1, amp: 0.012, cycles: 6 }],
  },

  // Kneel: drop to one knee, fist to the ground, head bowed — then look up.
  kneel: {
    duration: 3.2,
    loop: true,
    keys: [
      { t: 0, hips: [0, HIP_DIP, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], hL: HL_REST, hR: HR_REST },
      { t: 0.55, e: 'out', hips: [0, -0.4, -0.05], fL: [-0.16, Y0, -0.34], fR: [0.13, Y0 + 0.1, 0.3], kL: [-0.1, 0, -1], kR: [0.1, -1, 0.2], hL: [-0.22, 0.75, -0.3], eL: [-0.6, -1, 0.3], hR: [0.3, 0.42, -0.2], eR: [0.6, -1, 0.5], r: { spine: [-26, 0, 0], chest: [-14, 0, 0], head: [-18, 0, 0] } },
      { t: 1.9, hips: [0, -0.4, -0.05], r: { spine: [-28, 0, 0], chest: [-16, 0, 0], head: [-22, 0, 0] } },
      { t: 2.3, e: 'inOut', r: { spine: [-8, 0, 0], chest: [4, 0, 0], head: [16, 6, 0] } },
      { t: 2.7, hips: [0, -0.4, -0.05], r: { spine: [-8, 0, 0], chest: [4, 0, 0], head: [16, -6, 0] } },
      { t: 3.2, e: 'in', hips: [0, HIP_DIP, 0], fL: [-0.13, Y0, 0], fR: [0.13, Y0, 0.01], hL: HL_REST, hR: HR_REST, r: { spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
  },

  // Rail spin: a quick double gun twirl, a hop, and a hard catch across the chest.
  railspin: {
    duration: 2.6,
    loop: true,
    gun: true,
    keys: [
      { t: 0, hR: [0.22, 1.12, -0.24], eR: [0.5, -1, 0.4], hL: HL_REST, eL: [-0.3, 0, 1], oR: [0, 0, 0], hips: [0, HIP_DIP, 0], root: [0, 0, 0, 0], r: { spine: [0, 0, 0], head: [0, 0, 0] } },
      { t: 0.25, e: 'out', hR: [0.44, 1.3, -0.16], eR: [0.8, -1, 0.1], hips: [0, -0.06, 0], r: { head: [-4, -10, 0] } },
      { t: 1.05, e: 'linear', hR: [0.46, 1.34, -0.14], oR: [-1080, 0, 0] },
      { t: 1.3, e: 'out', root: [0, 0.14, 0, 0], hR: [0.1, 1.15, -0.34], eR: [0.9, -1, 0.3], hL: [0.05, 1.32, -0.3], eL: [-0.9, -1, 0.2], oR: [-1080, 0, 0], r: { head: [6, 0, 0], chest: [4, 0, 0] } },
      { t: 1.5, e: 'in', root: [0, 0, 0, 0], hips: [0, -0.1, 0] },
      { t: 1.6, e: 'outBack', hips: [0, -0.03, 0], hR: [0.06, 1.1, -0.34], hL: [0.04, 1.36, -0.3] },
      { t: 2.2, hR: [0.06, 1.1, -0.34], hL: [0.04, 1.36, -0.3] },
      { t: 2.6, e: 'inOut', hR: [0.22, 1.12, -0.24], eR: [0.5, -1, 0.4], hL: HL_REST, eL: [-0.3, 0, 1], oR: [-1080, 0, 0], hips: [0, HIP_DIP, 0], r: { head: [0, 0, 0], chest: [0, 0, 0] } },
    ],
    osc: [{ ch: 'hR', i: 2, amp: 0.05, cycles: 4, from: 0.3, to: 1.05, fade: 0.1 }],
  },

  // Laugh: hands on the belly, head thrown back, shoulders shaking, a knee slap.
  laugh: {
    duration: 2.6,
    loop: true,
    keys: [
      { t: 0, hips: [0, -0.05, 0], hL: [-0.17, 1.02, -0.22], eL: [-0.6, -1, 0.3], hR: [0.17, 1.06, -0.22], eR: [0.6, -1, 0.3], r: { spine: [4, 0, 0], chest: [8, 0, 0], head: [24, 0, 0] } },
      { t: 0.9, e: 'inOut', hips: [0, -0.08, 0], r: { spine: [8, 0, 0], chest: [10, 0, 0], head: [28, 6, 0] } },
      // double over for the knee slap
      { t: 1.4, e: 'inBack', hips: [0, -0.12, 0.02], hR: [0.3, 0.55, -0.22], eR: [0.8, -1, 0.3], hL: [-0.17, 1.0, -0.22], r: { spine: [-22, 0, 0], chest: [-14, 0, 0], head: [-6, 0, 0] } },
      { t: 1.7, e: 'outBack', hips: [0, -0.06, 0], hR: [0.17, 1.06, -0.22], r: { spine: [6, 0, 0], chest: [10, 0, 0], head: [26, -6, 0] } },
      { t: 2.6, e: 'inOut', hips: [0, -0.05, 0], r: { spine: [4, 0, 0], chest: [8, 0, 0], head: [24, 0, 0] } },
    ],
    osc: [
      { ch: 'r.chest', i: 0, amp: 3.5, hz: 7 },
      { ch: 'hips', i: 1, amp: 0.012, hz: 7, phase: 0.25 },
      { ch: 'r.head', i: 2, amp: 3, hz: 3.5 },
    ],
  },
};

const compiled = new Map<AnyEmoteKind, Clip>();
export function emoteClip(kind: AnyEmoteKind): Clip {
  let c = compiled.get(kind);
  if (!c) {
    c = compileClip(DEFS[kind] ?? DEFS.idle);
    compiled.set(kind, c);
  }
  return c;
}

export const EMOTE_KINDS = Object.keys(DEFS) as EmoteKind[]; // (lab list; includes the v3 extras at runtime)

export function isEmoteKind(k: string): k is AnyEmoteKind {
  return Object.prototype.hasOwnProperty.call(DEFS, k);
}
