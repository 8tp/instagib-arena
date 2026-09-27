// ── Observed-motion → movement sound events (remote players + bots) ──────────
//
// Other combatants' footsteps / jumps / landings, derived purely from their
// observed positions (the interpolated net snapshot, or a bot's sim position),
// so it works for any entity without netcode changes. Feed `sample()` once per
// update with that entity's position; events come out through the sink.
//
// Detection (vertical velocity from position deltas):
//  • jump      grounded → rising > 2.5 m/s sustained ≥ 25 ms (a one-tick
//              step-up onto a ledge is not a jump); > 14 m/s reads as a boost
//  • airjump   airborne and vy departs from free fall (-g·dt per sample) by
//              > 2.5 m/s upward, ending > 2 m/s up (double / wall jump)
//  • land      airborne, having fallen faster than 2.5 m/s, then the same
//              free-fall departure ending at ≤ 2 m/s — the ground stopped
//              the fall (works for 1-tick bunny-hop contacts too); strength =
//              peak fall speed
//  • dash      grounded horizontal speed jumps from < 15 to > 18 m/s
//  • step      grounded, one per FOOTSTEP_STRIDE metres travelled
// A > 3 m jump in one sample is a teleport (respawn), and a gap of > 0.2 s
// since the last sample means the entity was hidden (killcam): either way the
// track resets silently.
//
// Swapping in real gait footfalls later: set `cadenceSteps = false` and call
// the SoundManager's `remoteMove('step', x, y, z, speed)` from the character
// animator's footfall events instead — jump/land/dash detection stays here.

import { GRAVITY } from '../constants';

/** Metres per footstep at run speed (10 m/s → ~3.1 steps/s). Shared with the local player. */
export const FOOTSTEP_STRIDE = 3.2;

export type MotionEventKind = 'step' | 'jump' | 'airjump' | 'land' | 'dash' | 'boost';
/** Sink for motion events: kind, feet position, strength (speed in m/s). */
export type MotionSink = (kind: MotionEventKind, x: number, y: number, z: number, strength: number) => void;

class Track {
  x = 0;
  y = 0;
  z = 0;
  has = false;
  grounded = true;
  rise = 0; // s spent rising while grounded (jump confirm)
  fall = 0; // s spent falling while grounded (walked off a ledge)
  still = 0; // s vertically still while airborne (landing confirm)
  minVy = 0; // most negative vy this airborne arc
  lastVy = 0;
  lastHs = 0;
  cool = 0; // refractory for air-kicks / dashes
  stride = 0;
  lastT = 0; // clock of the last sample (s)
  contactT = -1; // clock of an unconfirmed partial ground contact
}

export class MotionTracker {
  /** Emit cadence-based footsteps (off once real gait footfalls drive steps). */
  cadenceSteps = true;
  private tracks = new Map<string, Track>();

  constructor(private sink: MotionSink) {}

  /** Forget everything (map change / reconnect). */
  clear() {
    this.tracks.clear();
  }

  /**
   * A gait footfall from the character animator (a foot planted): emit a step
   * at the entity's tracked speed if it's on the ground and moving. Used when
   * `cadenceSteps` is off, so steps land exactly on the animated foot plants.
   */
  footfall(id: string, x: number, y: number, z: number) {
    const tr = this.tracks.get(id);
    if (!tr || !tr.has || !tr.grounded) return;
    if (tr.lastHs > 2 && tr.lastHs < 16) this.sink('step', x, y, z, tr.lastHs);
  }

  /** Drop an entity's track (disconnected player). */
  forget(id: string) {
    this.tracks.delete(id);
  }

  /**
   * Feed one observation of entity `id`'s feet position at clock `now`
   * (seconds, any monotonic clock — sim time for bots, wall time for remotes).
   */
  sample(id: string, x: number, y: number, z: number, now: number, alive: boolean) {
    let tr = this.tracks.get(id);
    if (!tr) {
      tr = new Track();
      this.tracks.set(id, tr);
    }
    const dt = now - tr.lastT;
    tr.lastT = now;
    if (!alive) {
      tr.has = false;
      return;
    }
    if (!tr.has || dt > 0.2) {
      this.reset(tr, x, y, z);
      return;
    }
    if (!(dt > 1e-4)) return; // same instant (no new observation)
    const dx = x - tr.x;
    const dy = y - tr.y;
    const dz = z - tr.z;
    tr.x = x;
    tr.y = y;
    tr.z = z;
    if (dx * dx + dy * dy + dz * dz > 9) {
      this.reset(tr, x, y, z); // teleport / respawn
      return;
    }
    const vy = dy / dt;
    const hs = Math.sqrt(dx * dx + dz * dz) / dt;
    if (tr.cool > 0) tr.cool -= dt;

    if (tr.grounded) {
      if (vy > 2.5) {
        tr.rise += dt;
        if (tr.rise >= 0.025) {
          tr.grounded = false;
          tr.minVy = 0;
          tr.still = 0;
          tr.cool = 0.25;
          this.sink(vy > 14 ? 'boost' : 'jump', x, y, z, vy);
        }
      } else {
        tr.rise = 0;
        if (vy < -4) {
          tr.fall += dt;
          if (tr.fall >= 0.05) {
            tr.grounded = false;
            tr.minVy = vy;
            tr.still = 0;
          }
        } else {
          tr.fall = 0;
        }
      }
      if (tr.grounded) {
        if (hs > 18 && tr.lastHs < 15 && tr.cool <= 0) {
          tr.cool = 0.4;
          this.sink('dash', x, y, z, hs);
        } else if (this.cadenceSteps && hs > 2 && hs < 16) {
          tr.stride += hs * dt;
          if (tr.stride >= FOOTSTEP_STRIDE) {
            tr.stride -= FOOTSTEP_STRIDE;
            this.sink('step', x, y, z, hs);
          }
        }
      }
    } else {
      // In free fall vy changes by exactly -g·dt per sample; a sudden positive
      // deviation means something pushed back: the ground (vy snaps to ≈ 0 —
      // a landing, even when a bunny-hopper leaves again next tick) or an
      // upward impulse (double / wall jump, boost).
      const dev = vy - (tr.lastVy - GRAVITY * dt);
      if (dev > 2.5 && vy > 2) {
        if (now - tr.contactT < 0.06 && tr.minVy < -2.5) {
          // Right after a (partial-tick) ground contact: a bunny-hop.
          this.sink('land', x, y, z, -tr.minVy);
          this.sink(vy > 14 ? 'boost' : 'jump', x, y, z, vy);
        } else if (tr.cool <= 0) {
          tr.cool = 0.2;
          this.sink(vy > 14 ? 'boost' : 'airjump', x, y, z, vy);
        }
        tr.minVy = 0; // measure the landing from the new arc
        tr.still = 0;
        tr.contactT = -1;
      } else if (dev > 2.5 && tr.minVy < -2.5) {
        if (vy > -1.5) {
          this.sink('land', x, y, z, -tr.minVy);
          this.ground(tr);
        } else {
          // The fall only slowed: a contact partway through the tick (or net
          // jitter). Confirmed by the next samples — vy ≈ 0 or a hop.
          tr.contactT = now;
        }
      } else {
        if (vy < tr.minVy) tr.minVy = vy;
        // Fallback: vertically still for a while (hopped onto a ledge at the
        // apex, or a soft touchdown the deviation test missed) — no thud.
        if (Math.abs(vy) < 0.6) {
          tr.still += dt;
          if (tr.still >= 0.15) this.ground(tr);
        } else {
          tr.still = 0;
        }
      }
    }
    tr.lastVy = vy;
    tr.lastHs = hs;
  }

  private ground(tr: Track) {
    tr.grounded = true;
    tr.rise = 0;
    tr.fall = 0;
    tr.still = 0;
    tr.minVy = 0;
    tr.stride = FOOTSTEP_STRIDE * 0.5; // first step comes half a stride after touchdown
  }

  private reset(tr: Track, x: number, y: number, z: number) {
    tr.x = x;
    tr.y = y;
    tr.z = z;
    tr.has = true;
    tr.lastVy = 0;
    tr.lastHs = 0;
    tr.cool = 0;
    this.ground(tr);
  }
}
