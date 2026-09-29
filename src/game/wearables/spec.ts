import type { Kit, Surf, V3 } from './kit';

// What a wearable builder declares. Everything is authored in rest model
// space (see kit.ts); the runtime (index.ts) bakes it relative to the socket.

export type SubAnim =
  // Spin about `axis` (model space) at `rate` rad/s (+ `move` rad/s per m/s of
  // the wearer's speed — the propeller winds up when you run).
  | { kind: 'spin'; axis: V3; rate: number; move?: number }
  // A damped pendulum/spring: the part's rest direction `dir` (from the
  // pivot, model space) is a spring (`stiff`, 1/s²) with `damp` (1/s);
  // `grav` scales gravity's pull (1 = hangs, 0 = springy antenna); `len` is
  // the lever arm the wearer's acceleration acts on.
  | { kind: 'swing'; dir: V3; len: number; stiff: number; damp: number; grav: number }
  // Hover: bob `amp` m at `freq` Hz, optionally turning at `spin` rad/s.
  | { kind: 'bob'; amp: number; freq: number; spin?: number };

export type SubSpec = { pivot: V3; build(k: Kit): void; anim: SubAnim };

// Spring-simulated cape (index.ts → cape.ts). Pinned along the shoulders.
export type CapeSpec = {
  width: number; // across the shoulders (m)
  hemWidth: number; // across the hem (m) — the cape flares
  length: number; // collar → hem (m)
  top: V3; // centre of the pinned collar line (model space)
  // Colour bands down the cape: [v from, surface] (v = 0 collar … 1 hem),
  // sorted by v; each band starts a crisp colour change.
  bands: ReadonlyArray<readonly [number, Surf]>;
  // Vertical edge stripes (e.g. gold piping) — surface + width as a fraction.
  edge?: { s: Surf; w: number };
};

export type WearSpec = {
  build(k: Kit): void;
  subs?: SubSpec[];
  keepCrest?: boolean; // hats: leave the helmet's crest fin visible
  festive?(k: Kit): void; // hats: festive string lights (Look.f)
  cape?: CapeSpec;
};
