// The training range's gameplay layout — the contract between the map module
// (src/game/maps/training.ts exports TRAINING_LAYOUT) and the challenge system
// (src/game/training/*). Pure data: no three.js.
//
// Coordinates are world metres. Positions of standing things (spawns, starts)
// are FEET positions (y = surface top + 0.05). Target positions are the CENTRE
// of a 0.42 m target sphere, and must be clear of geometry by ≥ 0.6 m.

import type { AABB, TrainingChallengeId, Vec3 } from '../types';

export type ChallengeId = TrainingChallengeId;

export type TrainingPad = {
  center: Vec3; // floor centre of the pad (y = the surface top it sits on)
  size: [number, number]; // x, z extent (≥ 2.5 m each)
  signYaw: number; // the sign above the pad faces this yaw (0 = faces +z; π/2 = faces +x)
};

export type TrainingLayout = {
  // Hub / spawn plaza.
  hub: { spawn: Vec3; yaw: number; area: AABB };
  // One pad per challenge, in the hub. Standing on a pad (idle) starts it.
  pads: Record<ChallengeId, TrainingPad>;
  gallery: {
    // Where aim challenges put you and where you must stay: leaving this box
    // while an aim challenge runs cancels it.
    firingLine: AABB;
    start: Vec3;
    startYaw: number; // facing down-range
    // Target centres for free practice + Flick: spread over 8–55 m from the
    // firing line and 0.5–14 m high, every one visible from anywhere on the
    // firing line (eye height 1.6 m).
    anchors: Vec3[];
    // Moving-target rails for Strafers: the target centre slides between a
    // and b (straight segment, clear of geometry along the way plus 2.2 m of
    // jump headroom above), visible from the firing line.
    strafeLanes: Array<{ a: Vec3; b: Vec3 }>;
    // Painted distance markers (the look draws them; the HUD may label them).
    markers: Array<{ at: Vec3; metres: number }>;
  };
  course: {
    start: Vec3;
    startYaw: number;
    // Checkpoint volumes in order; the last one is the finish. A run counts a
    // gate when the player's feet point enters it.
    gates: AABB[];
    // Gauntlet targets along the route (centres), each visible from somewhere
    // on the route before or at the gate it precedes.
    targets: Vec3[];
    // A good run's time in seconds (the "par" shown on the sign).
    par: number;
  };
};
