import * as THREE from 'three';
import type { FinishPattern, RailgunFinish } from '../cosmetics';
import { BARREL_Y, COIL_COUNT, COIL_R, COIL_Z, CORE_R, CORE_Y, CORE_Z, MUZZLE_Z, NO_AXIS, PART, WINDOW_Z } from './gun-geometry';

// ─────────────────────────────────────────────────────────────────────────
// The railgun's surface: ONE MeshStandardMaterial for the whole gun, with the
// per-part look driven by the geometry's `gun` attribute (gun-geometry.ts) and
// a handful of uniforms. So the viewmodel is a single draw, a finish change is
// a uniform write (recolor, no rebuild), and the energy parts (coils, core,
// charge windows, capacitor) are all lit from uniforms the CoilDriver animates.
//
// Finish patterns are shader-injected in object space (metres, box-projected
// on flat parts, wrapped cylindrically on the barrel): carbon weave, hex
// plating, hazard chevrons, plasma veins (animated), spectrum (iridescent by
// view angle), digital camo (glitch flicker) and ceramic plates. On the high
// LOD the pattern relief also bends the normal (3-tap forward differences, no
// textures), chamfer faces get a worn machined-edge highlight, and the coils,
// core and discharge throw a little of their light onto the metal around
// them. The low LOD (third person) keeps the colours and skips all of that.
//
// Emissive levels are LINEAR radiance against the bloom threshold (1.5, see
// renderer.ts): everything at rest stays under it (a charged gun reads lit,
// not a lamp under your crosshair); only the discharge blooms.
// ─────────────────────────────────────────────────────────────────────────

export const STOCK_FINISH: RailgunFinish = {
  body: 0x171b22,
  metal: 0x2c333f,
  metalLt: 0x515d6e,
  accent: 0x37a6ff,
  accentHot: 0x8af2ff,
};

// Keyed by string so the table can run ahead of the FinishPattern union
// (cosmetics.ts): 'enamel' and 'void' render as soon as a finish uses them.
const PATTERN_ID: Record<string, number> = {
  plain: 0,
  carbon: 1,
  hex: 2,
  hazard: 3,
  plasma: 4,
  spectrum: 5,
  digital: 6,
  ceramic: 7,
  enamel: 8,
  void: 9,
};

// Base-colour slots (uPartCol / uPartRM index): parts 0–4 map to themselves;
// every glowing part sits on the dark ENERGY_BASE coat, the core on its own.
const SLOT_ENERGY = 5;
const SLOT_CORE = 6;
const SLOT_GLASS = 7;
const SLOTS = 8;

export type GunUniforms = {
  uPartCol: { value: THREE.Color[] };
  uPartRM: { value: THREE.Vector2[] };
  uEdgeCol: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uAccentHot: { value: THREE.Color };
  uPatA: { value: THREE.Color };
  uPatB: { value: THREE.Color };
  // Animated by the CoilDriver (radiance, linear):
  uCoil: { value: THREE.Color[] };
  uCap: { value: THREE.Color };
  uWin: { value: THREE.Vector4 }; // rgb radiance, w = charge fill 0…1
  uCore: { value: THREE.Color };
  uFlash: { value: THREE.Color }; // discharge light cast on the gun
  uTime: { value: number };
  uPattern: { value: number };
  uCalm: { value: number };
  // Not a shader uniform: how far the CoilDriver whitens the coils' colour
  // (the Ratz hero finish runs white-hot coils).
  coilWhite: { value: number };
};

// Reduced effects (accessibility), global for every railgun: animated
// finishes freeze (the CoilDriver / third-person shells stop advancing uTime)
// and the glitch finish stops flickering. See setRailgunReducedEffects.
export const gunFx = { reduced: false };

export type GunMaterialOptions = {
  lod?: 'high' | 'low';
};

const GLSL_COMMON = /* glsl */ `
uniform vec3 uPartCol[${SLOTS}];
uniform vec2 uPartRM[${SLOTS}];
uniform vec3 uEdgeCol;
uniform vec3 uAccent;
uniform vec3 uAccentHot;
uniform vec3 uPatA;
uniform vec3 uPatB;
uniform vec3 uCoil[${COIL_COUNT}];
uniform vec3 uCap;
uniform vec4 uWin;
uniform vec3 uCore;
uniform vec3 uFlash;
uniform float uTime;
uniform float uPattern; // finish pattern id (PATTERN_ID) — a uniform branch, not a define
uniform float uCalm; // 1 = reduced effects: no glitch flicker
varying vec3 vGunPos;
varying vec3 vGunNrm;
varying vec3 vGun;

#define GUN_PAT int(uPattern + 0.5)
#define GUN_BARREL_Y ${BARREL_Y.toFixed(4)}
#define GUN_MUZZLE vec3(0.0, ${BARREL_Y.toFixed(4)}, ${MUZZLE_Z.toFixed(4)})

float gHash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(gHash3(i), gHash3(i + vec3(1, 0, 0)), f.x), mix(gHash3(i + vec3(0, 1, 0)), gHash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(gHash3(i + vec3(0, 0, 1)), gHash3(i + vec3(1, 0, 1)), f.x), mix(gHash3(i + vec3(0, 1, 1)), gHash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// Pattern coordinates in metres: wrapped round the lathe axis (seam at the
// bottom, never in view) or box-projected on the dominant normal axis.
vec2 gunUV(vec3 p, vec3 n, float axisY) {
  if (axisY > ${(NO_AXIS + 1).toFixed(1)}) {
    vec2 d = p.xy - vec2(0.0, axisY);
    return vec2(atan(d.x, d.y) * max(length(d), 0.03), p.z);
  }
  vec3 a = abs(n);
  if (a.x >= a.y && a.x >= a.z) return vec2(p.z, p.y);
  if (a.y >= a.z) return vec2(p.x, p.z);
  return vec2(p.x, p.y);
}

// Which base slot a part draws its colour / roughness / metalness from.
int gunSlot(int part) {
  if (part <= ${PART.CARBON}) return part;
  if (part == ${PART.CORE}) return ${SLOT_CORE};
  if (part == ${PART.WINDOW}) return ${SLOT_GLASS};
  return ${SLOT_ENERGY};
}


// How strongly the finish pattern covers a part (0 = untouched).
float gunPatternWeight(int part) {
  if (GUN_PAT == 1) {
    return part == ${PART.BODY} || part == ${PART.CARBON} ? 1.0 : part == ${PART.METAL} ? 0.7 : 0.0;
  } else if (GUN_PAT == 3) {
    return part == ${PART.BODY} || part == ${PART.METAL} ? 1.0 : 0.0;
  } else if (GUN_PAT == 5) {
    return part == ${PART.BODY} ? 1.0 : part == ${PART.METAL} ? 0.8 : part == ${PART.METAL_LT} ? 0.5 : 0.0;
  } else if (GUN_PAT == 6) {
    return part == ${PART.BODY} ? 1.0 : part == ${PART.METAL} ? 0.8 : 0.0;
  } else if (GUN_PAT == 8) {
    return part == ${PART.BODY} ? 1.0 : 0.0;
  } else if (GUN_PAT == 9) {
    return part == ${PART.BODY} ? 1.0 : part == ${PART.METAL} ? 0.7 : 0.0;
  } else {
    return part == ${PART.BODY} ? 1.0 : part == ${PART.METAL} ? 0.45 : 0.0;
  }
}

// World size of one pixel on the gun surface (metres), set once per fragment
// before any pattern runs. Every pattern fades to its average as its cell
// shrinks toward a pixel, so nothing shimmers as the gun sways (or at range).
float gPx = 0.001;
float gunFade(float cell) {
  return 1.0 - smoothstep(0.18, 0.45, gPx / cell);
}
// Anti-aliased "inside a line of half-width hw" for a distance d (metres).
// (Footprint from gPx, not fwidth: the part branches are not uniform flow.)
float gunLine(float d, float hw) {
  float aa = gPx * 0.75;
  return 1.0 - smoothstep(hw - aa, hw + aa, d);
}

// 2×2 twill: x = across-tow position 0…1, y = 1 for weft, 0 for warp. Tows
// are oversized (real ones are ~3 mm) so the weave reads at arm's length.
#define GUN_TOW 0.024
vec2 gunTwill(vec2 uv) {
  vec2 q = uv / GUN_TOW;
  vec2 c = floor(q);
  vec2 f = fract(q);
  bool weft = mod(c.x + c.y, 4.0) < 2.0;
  return vec2(weft ? f.y : f.x, weft ? 1.0 : 0.0);
}

// Hex cell: xy = offset from the cell centre, z = distance to the cell edge
// (metres), w = cell hash.
#define GUN_HEX 0.085
vec4 gunHex(vec2 uv) {
  vec2 q = uv / GUN_HEX;
  const vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(q, r) - h;
  vec2 b = mod(q - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = q - gv;
  float edge = 0.5 - max(abs(gv.x) * 0.5 + abs(gv.y) * 0.8660254, abs(gv.x));
  return vec4(gv, edge * GUN_HEX, gHash2(floor(id * 2.0 + 0.5)));
}

// Plasma vein field (0 on a vein's centre line).
float gunVein(vec3 p) {
  vec3 q = p * 13.0 + vec3(0.0, 0.0, uTime * 0.5);
  return abs(gNoise(q) + 0.5 * gNoise(q * 2.1 + 3.7) - 0.75);
}

// Engraved panel seams on the receiver shell (0…1 line mask): two cuts across
// it and one along each flank between the charge window and the lower plate
// (the enamel finish runs its gold pinstripes down the same lines).
float gunSeam(vec3 p, vec3 n, int part) {
  if (part != ${PART.BODY} || p.z < -0.25 || p.z > 0.15) return 0.0;
  float m = max(gunLine(abs(p.z - 0.048), 0.0009), gunLine(abs(p.z + 0.155), 0.0009));
  if (abs(n.x) > 0.7) m = max(m, gunLine(abs(p.y - 0.004), 0.0008));
  return m * gunFade(0.004);
}

// Grip stipple: a fine dimple field on the pistol grip and the butt pad.
bool gunGripZone(vec3 p, int part) {
  return part == ${PART.RUBBER} && ((p.y < -0.075 && p.z > 0.02 && p.z < 0.2) || p.z > 0.425);
}
float gunStipple(vec2 uv) {
  vec2 q = uv / 0.0036;
  vec2 f = fract(q + vec2(0.5 * mod(floor(q.y), 2.0), 0.0)) - 0.5;
  return (1.0 - smoothstep(0.22, 0.34, length(f))) * gunFade(0.0036);
}

// Cavity occlusion (0…1, 1 = open): contact shadows where parts meet — either
// side of each coil housing down the barrel channel, under the top cover lip,
// the receiver's ends, the fin roots, the top of the grip. Analytic in model
// space (no textures, no extra geometry); applied to the ambient/IBL and,
// more gently, to the albedo.
float gunAO(vec3 p, vec3 n, int part) {
  float ao = 0.8 + 0.2 * smoothstep(-0.9, 0.35, n.y); // faces turned down sit in the gun's own shade
  if (part >= ${PART.GLOW}) return 1.0;
  float r = length(p.xy - vec2(0.0, GUN_BARREL_Y));
  if (p.z < -0.24 && p.z > -0.78 && r < 0.058) {
    ${COIL_Z.map((z) => `{ float d = max(abs(p.z - (${z.toFixed(4)})) - 0.025, 0.0) / 0.014; ao *= 1.0 - 0.5 * exp(-d * d); }`).join('\n    ')}
    { float d = max(-0.3 - p.z, 0.0) / 0.02; ao *= 1.0 - 0.45 * exp(-d * d); }
    { float d = max(p.z + 0.766, 0.0) / 0.02; ao *= 1.0 - 0.45 * exp(-d * d); }
  }
  if (part == ${PART.BODY}) {
    if (abs(n.x) > 0.7) ao *= 1.0 - 0.32 * smoothstep(0.058, 0.079, p.y);
    ao *= 1.0 - 0.3 * smoothstep(0.112, 0.14, p.z);
    ao *= 1.0 - 0.35 * smoothstep(-0.212, -0.245, p.z);
  }
  if (part == ${PART.METAL_LT} && p.y > 0.1 && abs(p.x) < 0.029 && p.z > -0.08 && p.z < 0.1) {
    ao *= mix(0.45, 1.0, smoothstep(0.1005, 0.113, p.y)); // fin roots
  }
  if (part == ${PART.METAL} && p.y > 0.098 && p.y < 0.102 && abs(p.x) < 0.029) ao *= 0.55; // between the fins
  if (part == ${PART.RUBBER} && p.y < -0.03 && p.y > -0.12 && p.z > 0.0 && p.z < 0.2) {
    ao *= mix(0.55, 1.0, smoothstep(-0.04, -0.085, p.y)); // grip root under the receiver
  }
  return ao;
}

// Relief (metres, ≤ ~1 mm) the pattern cuts into a part: grooves < 0.
float gunHeight(vec3 p, vec3 n, vec3 g) {
  int part = int(g.x + 0.5);
  float w = gunPatternWeight(part);
  vec2 uv = gunUV(p, n, g.z);
  float h = 0.0;
  if (gunGripZone(p, part)) h -= 0.00035 * gunStipple(uv);
  if (GUN_PAT == 0 || GUN_PAT == 7 || GUN_PAT == 8) {
    // Engraved panel seams across the receiver; ceramic adds plate joints.
    if (part == ${PART.BODY}) {
      h -= 0.0007 * gunSeam(p, n, part);
      if (GUN_PAT == 7) {
        float pz = abs(fract(uv.x / 0.09) - 0.5) * 0.09;
        h -= 0.0008 * (1.0 - smoothstep(0.0008, 0.002, 0.045 - pz));
      }
    }
  }
  if (GUN_PAT == 1) {
    if (w > 0.0) h += w * 0.0008 * sin(gunTwill(uv).x * 3.14159) * gunFade(GUN_TOW * 2.0);
  } else if (GUN_PAT == 2) {
    if (w > 0.0) h -= w * 0.0012 * (1.0 - smoothstep(0.003, 0.006, gunHex(uv).z)) * gunFade(GUN_HEX * 0.12);
  } else if (GUN_PAT == 4) {
    if (w > 0.0) h -= w * 0.0005 * (1.0 - smoothstep(0.0, 0.07, gunVein(p)));
  } else if (GUN_PAT == 6) {
    if (w > 0.0) {
      vec2 cell = floor(uv / 0.034);
      h -= w * 0.0005 * step(0.55, gNoise(vec3(cell * 0.3, 0.0))) * gunFade(0.034);
    }
  }
  if (part == ${PART.CARBON}) {
    if (GUN_PAT != 1) {
      h += 0.0005 * sin(gunTwill(uv).x * 3.14159) * gunFade(GUN_TOW * 2.0);
    }
  }
  return h;
}

struct GunSurf {
  vec3 albedo;
  float rough;
  float metal;
  vec3 emit;
  float glow; // 1 on parts lit by the material's own emissive (the glow knob)
  float ao; // cavity occlusion (gunAO)
};

// Carbon weave tinted by base: bright tow crowns, dark valleys, and the two
// directions catch the light differently (the warp tows turn up the sheen);
// glossy like a clear coat. Fades to its mean when tiny.
void gunCarbon(inout GunSurf s, vec2 uv, vec3 base, float w, vec3 vn, vec3 vdir) {
  vec2 tw = gunTwill(uv);
  float tow = sin(tw.x * 3.14159);
  float fade = gunFade(GUN_TOW * 2.0);
  float sheen = mix(0.4, 1.0, tw.y) * (0.75 + 0.5 * pow(1.0 - abs(dot(vn, vdir)), 2.0));
  float k = mix(0.6, (0.12 + 1.6 * tow) * sheen, fade);
  s.albedo = mix(s.albedo, base * k, w);
  s.rough = mix(s.rough, mix(0.22, 0.12 + 0.22 * (1.0 - tow), fade), w);
  s.metal = mix(s.metal, 0.3, w);
}

GunSurf gunSurface(vec3 p, vec3 n, vec3 g, vec3 vn, vec3 vdir) {
  GunSurf s;
  int part = int(g.x + 0.5);
  int slot = gunSlot(part);
  s.albedo = uPartCol[slot];
  s.rough = uPartRM[slot].x;
  s.metal = uPartRM[slot].y;
  s.emit = vec3(0.0);
  s.glow = part == ${PART.GLOW} ? 1.0 : 0.0;
  s.ao = gunAO(p, n, part);
  float w = gunPatternWeight(part);
  vec2 uv = gunUV(p, n, g.z);

  // ── Energy parts ──
  if (part >= ${PART.COIL0}) {
    int ci = part - ${PART.COIL0};
    // Brightest on the band's crown, dimmer down its chamfers.
    float crown = smoothstep(${(COIL_R - 0.006).toFixed(4)}, ${COIL_R.toFixed(4)}, length(p.xy - vec2(0.0, GUN_BARREL_Y)));
    s.emit = uCoil[ci] * (0.55 + 0.45 * crown);
  } else if (part == ${PART.CAP}) {
    s.emit = uCap * (0.8 + 0.2 * sin(p.z * 90.0 - uTime * 6.0));
  } else if (part == ${PART.CORE}) {
    // Energy running down the barrel toward the muzzle.
    float flow = 0.72 + 0.28 * sin(p.z * 70.0 + uTime * 16.0) * sin(p.z * 23.0 + uTime * 5.0 + 1.3);
    float tip = smoothstep(${CORE_Z[1].toFixed(3)}, ${(CORE_Z[1] - 0.05).toFixed(3)}, p.z);
    s.emit = uCore * flow * mix(0.4, 1.0, tip);
  } else if (part == ${PART.WINDOW}) {
    // A six-cell gauge filling rear → front with the charge, behind glass.
    float u = clamp((${WINDOW_Z[0].toFixed(3)} - p.z) / ${(WINDOW_Z[0] - WINDOW_Z[1]).toFixed(3)}, 0.0, 1.0);
    float cell = fract(u * 6.0);
    float gap = smoothstep(0.0, 0.1, cell) * smoothstep(1.0, 0.9, cell);
    float vy = abs(p.y - 0.036) / 0.015;
    float lit = smoothstep(uWin.w + 0.02, uWin.w - 0.02, u);
    s.emit = uWin.rgb * (0.08 + 0.92 * lit) * gap * (1.0 - 0.45 * vy * vy);
  }

  // ── Finish patterns ──
  if (GUN_PAT == 1) {
    // Carbon: the whole shell is woven (receiver, stock, housings).
    if (w > 0.0) gunCarbon(s, uv, uPatA, w, vn, vdir);
  } else if (GUN_PAT == 2) {
    // Hex plating on gloss black; every seam carries a neon line in the accent.
    if (w > 0.0) {
      vec4 hx = gunHex(uv);
      // Seams hold >= ~1.5 px however small the gun draws; only when the
      // cells themselves shrink toward a few pixels does the pattern fade.
      float fade = gunFade(GUN_HEX * 0.3);
      float seam = gunLine(hx.z, max(0.0045, gPx * 1.4)) * fade;
      float neon = gunLine(hx.z, max(0.0022, gPx * 0.8)) * fade;
      // Alternate plates catch the light differently (gloss vs satin).
      float alt = step(0.5, hx.w);
      s.albedo *= mix(1.0, 0.6 + 0.9 * hx.w, w * fade);
      s.albedo = mix(s.albedo, vec3(0.0), seam * w);
      s.rough = mix(s.rough, mix(0.1, 0.34, alt), w * fade);
      s.emit += uAccent * neon * w * 1.6 + uAccent * 0.18 * seam * w;
    }
  } else if (GUN_PAT == 3) {
    // Hazard: bold black/yellow chevrons down the flanks (pointing at the
    // muzzle), stripes everywhere else, with chipped paint.
    if (w > 0.0) {
      vec3 a = abs(n);
      float v = (a.x > a.y && a.x > a.z && g.z < ${(NO_AXIS + 1).toFixed(1)})
        ? (uv.x - abs(uv.y - 0.024)) / 0.075
        : (uv.x + uv.y) / 0.075;
      float d = abs(fract(v) - 0.5) * 2.0;
      float aa = max(gPx * 30.0, 1e-4);
      float stripe = mix(0.5, smoothstep(0.5 - aa, 0.5 + aa, d), gunFade(0.03));
      float wear = step(0.74, gNoise(p * 180.0)) * 0.6 * gunFade(0.008);
      vec3 paint = mix(uPatB, uPatA, stripe);
      s.albedo = mix(s.albedo, mix(paint, uPartCol[${PART.METAL_LT}] * 0.5, wear * 0.4), w);
      s.rough = mix(s.rough, mix(0.5, 0.32, wear), w);
      s.metal = mix(s.metal, mix(0.08, 0.8, wear), w);
    }
  } else if (GUN_PAT == 4) {
    // Plasma: living veins of energy flowing toward the muzzle.
    if (w > 0.0) {
      float v = gunVein(p);
      float aa = max(gPx * 16.0, 1e-4);
      float vein = 1.0 - smoothstep(0.0, 0.05 + aa, v);
      float pulse = 0.75 + 0.25 * sin(uTime * 3.1 + p.z * 26.0);
      s.albedo = mix(s.albedo, uAccent * 0.15, vein * w);
      s.emit += mix(uAccent, uAccentHot, vein * vein * 0.6) * vein * pulse * 1.15 * w;
    }
  } else if (GUN_PAT == 5) {
    // Spectrum: thin-film chrome, hue slides with the view angle.
    if (w > 0.0) {
      float fres = 1.0 - abs(dot(vn, vdir));
      float hue = fres * 1.3 + p.z * 1.7 + (p.x + p.y) * 2.4 + uTime * 0.04;
      vec3 film = 0.55 + 0.45 * cos(6.2831853 * (hue + vec3(0.0, 0.33, 0.67)));
      s.albedo = mix(s.albedo, film * mix(0.55, 0.95, fres), w);
      s.metal = mix(s.metal, 1.0, w);
      s.rough = mix(s.rough, 0.17, w);
    }
  } else if (GUN_PAT == 6) {
    // Glitch: big digital-camo blocks (black / accent / pale); bands of blocks
    // jump sideways and split into magenta + cyan ghosts, a few pixels flicker.
    if (w > 0.0) {
      float cellM = 0.034;
      float fade = gunFade(cellM);
      float tq = floor(uTime * 7.0);
      vec2 q = floor(uv / cellM);
      float band = floor(q.y / 2.0);
      float glitch = step(0.8, gHash2(vec2(band, tq))) * (1.0 - uCalm);
      q.x += glitch * floor(gHash2(vec2(band, tq + 7.0)) * 5.0 - 2.0);
      float tone = gNoise(vec3(q * 0.3, 0.0)) + (gHash2(q) - 0.5) * 0.25;
      vec3 c = tone < 0.45 ? vec3(0.004, 0.006, 0.005) : tone < 0.63 ? uPatA : uPatB;
      vec3 mean = (uPatA + uPatB) * 0.33;
      s.albedo = mix(s.albedo, mix(mean, c, fade), w);
      s.rough = mix(s.rough, 0.45, w);
      // RGB split on the glitching band: magenta on one edge, cyan on the other.
      float fx = fract(uv.x / cellM);
      vec3 split = mix(vec3(1.0, 0.0, 0.8), vec3(0.0, 0.9, 1.0), step(0.5, fx));
      s.emit += split * glitch * 0.8 * fade * w;
      float lit = step(0.985, gHash2(q + tq * 0.37)) * fade * (1.0 - uCalm);
      s.emit += uAccent * lit * 1.1 * w;
    }
  } else if (GUN_PAT == 7) {
    // Ceramic: matte glazed plates (the palette carries the white).
    if (part == ${PART.BODY}) {
      s.albedo *= 0.94 + 0.08 * gNoise(p * 40.0);
    }
  } else if (GUN_PAT == 8) {
    // Enamel: gloss white body with gold pinstripes along the panel lines and
    // the flank (Regalia — the inverse of Midas).
    if (w > 0.0) {
      float pin = max(gunLine(abs(p.z - 0.048), 0.0016), gunLine(abs(p.z + 0.155), 0.0016));
      vec3 a = abs(n);
      if (a.x > a.y && a.x > a.z) pin = max(pin, gunLine(abs(p.y - 0.004), 0.0018));
      s.albedo = mix(s.albedo, uPatA, pin * w);
      s.metal = mix(s.metal, 1.0, pin * w);
      s.rough = mix(s.rough, 0.2, pin * w);
    }
  } else if (GUN_PAT == 9) {
    // Void: a night sky in the plating — deep indigo nebula, twinkling stars.
    if (w > 0.0) {
      float neb = gNoise(p * 9.0 + vec3(0.0, 0.0, uTime * 0.05));
      neb = smoothstep(0.45, 0.95, neb + 0.35 * gNoise(p * 23.0));
      s.albedo = mix(s.albedo, s.albedo + uAccent * 0.05 * neb, w);
      s.emit += uAccent * neb * 0.16 * w;
      vec2 sq = floor(uv / 0.006);
      float star = step(0.93, gHash2(sq));
      vec2 sf = fract(uv / 0.006) - 0.5;
      float spot = exp(-dot(sf, sf) * 60.0) * star;
      float tw = 0.55 + 0.45 * sin(uTime * (2.0 + 4.0 * gHash2(sq + 3.1)) + gHash2(sq) * 40.0);
      s.emit += mix(uAccentHot, vec3(1.0), 0.5) * spot * tw * 1.3 * gunFade(0.006) * w;
      s.rough = mix(s.rough, 0.18, w);
    }
  }

  if (GUN_PAT == 0) {
    // Plain: anodised coat with a faint brushed grain along the barrel axis.
    if (part == ${PART.BODY} || part == ${PART.METAL}) {
      float grain = gNoise(vec3(uv.x * 900.0, uv.y * 8.0, 0.0));
      s.rough += (grain - 0.5) * 0.1 * gunFade(0.004);
      s.albedo *= 0.93 + 0.14 * gNoise(p * 16.0);
    }
  }
  // Carbon parts always carry the weave (stock + foregrip).
  if (GUN_PAT != 1) {
    if (part == ${PART.CARBON}) gunCarbon(s, uv, s.albedo * 1.4, 1.0, vn, vdir);
  }

  if (part <= ${PART.CARBON}) {
    // Handling: low-frequency smudges in the roughness (never a flat CG sheen).
    s.rough *= 0.9 + 0.28 * gNoise(p * 21.0 + 3.1);
    // Panel seams: dark, rough cuts (the bump adds the groove on the high tier).
    float seam = GUN_PAT == 8 ? 0.0 : gunSeam(p, n, part); // enamel gilds its seams
    s.albedo *= 1.0 - 0.6 * seam;
    s.rough = mix(s.rough, 0.8, seam);
  }
  // Grip stipple: satin dimples in the matte rubber.
  if (gunGripZone(p, part)) {
    float st = gunStipple(uv);
    s.albedo *= 1.0 + 0.5 * st;
    s.rough = mix(0.92, 0.62, st);
  }
  // Machined edge highlight on chamfers, worn to bright metal — broken up so
  // the wear gathers on some stretches of an edge and skips others.
  if (part <= ${PART.CARBON} && part != ${PART.RUBBER}) {
    float e = g.y;
    float chip = mix(0.55, gNoise(p * 260.0 + 7.3), gunFade(0.004));
    e *= 0.78 + 0.22 * chip;
    s.albedo = mix(s.albedo, uEdgeCol, 0.46 * e);
    s.metal = mix(s.metal, 1.0, 0.7 * e);
    // (Satin, not mirror: a hot key light on a glossy chamfer would bloom.)
    s.rough = mix(s.rough, 0.34, 0.6 * e);
  }
  s.rough = clamp(s.rough, 0.06, 1.0);
  return s;
}


#ifdef GUN_HI
// Light the energy parts throw on the metal round them (a cheap bounce: the
// coils, the core through the rail gaps, and the discharge at the muzzle).
vec3 gunBounce(vec3 p, vec3 n) {
  vec2 d = p.xy - vec2(0.0, GUN_BARREL_Y);
  float r = length(d);
  vec3 e = vec3(0.0);
  float nearBarrel = 1.0 - smoothstep(0.08, 0.12, r);
  if (nearBarrel > 0.0) {
    ${COIL_Z.map((z, i) => `{ float dz = (p.z - (${z.toFixed(4)})) / 0.045; e += uCoil[${i}] * exp(-dz * dz); }`).join('\n    ')}
    e *= 0.07 * nearBarrel;
    float inCore = step(${CORE_Z[0].toFixed(3)}, p.z) * step(p.z, ${CORE_Z[1].toFixed(3)});
    float rc = max(length(p.xy - vec2(0.0, ${CORE_Y.toFixed(4)})) - ${CORE_R.toFixed(3)}, 0.0) / 0.022;
    e += uCore * 0.3 * exp(-rc * rc) * inCore;
  }
  vec3 dm = p - GUN_MUZZLE;
  float fm = dot(dm, dm) / (0.38 * 0.38);
  vec3 L = normalize(-dm + vec3(0.0, 0.0, -0.05));
  e += uFlash * exp(-fm) * (0.35 + 0.65 * max(dot(n, L), 0.0));
  return e;
}

vec3 gunPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos));
  vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
#endif
`;

const FRAG_SURFACE = /* glsl */ `
  gPx = max(length(fwidth(vGunPos)), 1e-6);
  vec3 gunN = normalize(vGunNrm);
  GunSurf gunS = gunSurface(vGunPos, gunN, vGun, normalize(vNormal), normalize(vViewPosition));
  vec4 diffuseColor = vec4(gunS.albedo * mix(1.0, gunS.ao, 0.55), opacity);
`;

// Cavity occlusion on the ambient + IBL (after three's own aoMap chunk).
const FRAG_AO = /* glsl */ `
  reflectedLight.indirectDiffuse *= gunS.ao;
  reflectedLight.indirectSpecular *= gunS.ao;
`;

const FRAG_EMISSIVE = /* glsl */ `
  vec3 totalEmissiveRadiance = gunS.emit + emissive * gunS.glow;
  #ifdef GUN_HI
    if (vGun.x < ${PART.GLOW - 0.5}) totalEmissiveRadiance += gunS.albedo * gunBounce(vGunPos, gunN);
  #endif
`;

const FRAG_BUMP = /* glsl */ `
  #ifdef GUN_HI
  {
    vec3 gp = vGunPos;
    vec3 gdx = dFdx(gp);
    vec3 gdy = dFdy(gp);
    float h0 = gunHeight(gp, gunN, vGun);
    float hx = gunHeight(gp + gdx, gunN, vGun) - h0;
    float hy = gunHeight(gp + gdy, gunN, vGun) - h0;
    vec2 dH = vec2(hx / max(length(gdx), 1e-6), hy / max(length(gdy), 1e-6));
    dH = clamp(dH, vec2(-1.2), vec2(1.2));
    // Unconditional: the perturb takes screen derivatives (uniform flow).
    normal = gunPerturb(-vViewPosition, normal, dH, faceDirection);
  }
  #endif
`;

function lift(c: THREE.Color, minLum: number, keepTint = 1): THREE.Color {
  // Raise a (linear) colour to at least `minLum` luminance: the finish
  // palettes are "paint chips"; metal F0 needs to be brighter than the chip or
  // a gunmetal gun reflects almost nothing. `keepTint` < 1 blends the lifted
  // colour toward neutral grey, so a dark red chip becomes red-tinged steel
  // rather than dusty pink.
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (l >= minLum) return c;
  if (l <= 0) return c.setScalar(minLum);
  const tinted = c.clone().multiplyScalar(minLum / l);
  return c.setScalar(minLum).lerp(tinted, keepTint);
}

// Finish → uniforms. Pure function of the finish, so recolouring is cheap.
export function applyFinishUniforms(u: GunUniforms, finish: RailgunFinish | undefined) {
  const f = finish ?? STOCK_FINISH;
  const pattern = f.pattern ?? 'plain';
  const col = u.uPartCol.value;
  const rm = u.uPartRM.value;
  const body = new THREE.Color(f.body);
  const metal = new THREE.Color(f.metal);
  const metalLt = new THREE.Color(f.metalLt);
  const accent = new THREE.Color(f.accent);
  const hot = new THREE.Color(f.accentHot);
  u.uAccent.value.copy(accent);
  u.uAccentHot.value.copy(hot);

  // Receiver coat: a dielectric paint/anodise (its specular sheen is what
  // reads on a near-black gun), a touch lifted so it never crushes to black.
  col[PART.BODY].copy(lift(body.clone(), 0.012));
  rm[PART.BODY].set(0.34, 0.25);
  col[PART.METAL].copy(lift(metal.clone(), 0.07, 0.45));
  rm[PART.METAL].set(0.36, 0.85);
  col[PART.METAL_LT].copy(lift(metalLt.clone(), 0.2, 0.8));
  rm[PART.METAL_LT].set(0.28, 0.92);
  col[PART.RUBBER].setHex(0x121417);
  rm[PART.RUBBER].set(0.82, 0.0);
  col[PART.CARBON].copy(lift(body.clone().multiplyScalar(1.3), 0.02));
  rm[PART.CARBON].set(0.3, 0.2);
  col[SLOT_ENERGY].copy(body).lerp(accent, 0.08);
  rm[SLOT_ENERGY].set(0.4, 0.4);
  col[SLOT_CORE].copy(accent).multiplyScalar(0.25);
  rm[SLOT_CORE].set(0.2, 0.0);
  col[SLOT_GLASS].setRGB(0.01, 0.012, 0.016);
  rm[SLOT_GLASS].set(0.08, 0.0);
  u.uEdgeCol.value.copy(lift(metalLt.clone(), 0.3, 0.7));
  u.uPatA.value.copy(metalLt);
  u.uPatB.value.copy(body);
  u.coilWhite.value = 0;

  switch (pattern) {
    case 'carbon':
      // Grey-black weave, clear-coated.
      u.uPatA.value.setRGB(0.12, 0.125, 0.135);
      rm[PART.BODY].set(0.18, 0.3);
      break;
    case 'hex':
      // The hero: gloss-black plates with neon seams, hot-pink anodised
      // housings, white-hot coils.
      col[PART.BODY].setRGB(0.004, 0.003, 0.005);
      rm[PART.BODY].set(0.14, 0.55);
      col[PART.METAL].copy(lift(accent.clone(), 0.09, 0.95));
      rm[PART.METAL].set(0.26, 0.9);
      u.coilWhite.value = 0.45;
      break;
    case 'hazard':
      // Safety yellow on black, whole receiver + barrel housing.
      u.uPatA.value.copy(lift(metalLt.clone(), 0.36, 1));
      u.uPatB.value.setRGB(0.008, 0.008, 0.007);
      break;
    case 'plasma':
      rm[PART.BODY].set(0.22, 0.4);
      break;
    case 'spectrum':
      break;
    case 'digital':
      // Accent blocks + pale blocks on black.
      u.uPatA.value.copy(accent).multiplyScalar(0.35);
      u.uPatB.value.copy(lift(metalLt.clone(), 0.28, 0.4));
      break;
    case 'ceramic':
      // Matte white plates on a darker metal frame.
      col[PART.BODY].copy(body);
      rm[PART.BODY].set(0.42, 0.0);
      u.uEdgeCol.value.copy(body).lerp(new THREE.Color(0xffffff), 0.4);
      break;
    case 'enamel' as FinishPattern:
      // Gloss white enamel, gold trim (the palette's metal / metalLt).
      col[PART.BODY].copy(body);
      rm[PART.BODY].set(0.16, 0.0);
      col[PART.METAL].copy(lift(metal.clone(), 0.16, 1));
      rm[PART.METAL].set(0.24, 1.0);
      u.uPatA.value.copy(lift(metalLt.clone(), 0.4, 1));
      u.uEdgeCol.value.copy(lift(metalLt.clone(), 0.45, 1));
      break;
    case 'void' as FinishPattern:
      // Deep indigo lacquer with a night sky in it.
      col[PART.BODY].copy(body).lerp(accent, 0.04);
      rm[PART.BODY].set(0.18, 0.2);
      break;
    default:
      break;
  }
}

export class GunMaterial extends THREE.MeshStandardMaterial {
  readonly gun: GunUniforms;
  private pattern: FinishPattern = 'plain';

  constructor(finish: RailgunFinish | undefined, opts: GunMaterialOptions = {}) {
    const f = finish ?? STOCK_FINISH;
    super({ color: 0xffffff, roughness: 0.4, metalness: 0.5, emissive: new THREE.Color(f.accentHot), emissiveIntensity: 0.8 });
    this.name = 'railgun';
    const col = () => Array.from({ length: SLOTS }, () => new THREE.Color());
    this.gun = {
      uPartCol: { value: col() },
      uPartRM: { value: Array.from({ length: SLOTS }, () => new THREE.Vector2()) },
      uEdgeCol: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uAccentHot: { value: new THREE.Color() },
      uPatA: { value: new THREE.Color() },
      uPatB: { value: new THREE.Color() },
      uCoil: { value: Array.from({ length: COIL_COUNT }, () => new THREE.Color()) },
      uCap: { value: new THREE.Color() },
      uWin: { value: new THREE.Vector4(0, 0, 0, 1) },
      uCore: { value: new THREE.Color() },
      uFlash: { value: new THREE.Color() },
      uTime: { value: 0 },
      uPattern: { value: 0 },
      uCalm: { value: 0 },
      coilWhite: { value: 0 },
    };
    const hi = (opts.lod ?? 'high') === 'high';
    this.defines = { STANDARD: '' };
    if (hi) this.defines.GUN_HI = '';
    this.setFinish(finish);
  }

  get finishPattern(): FinishPattern {
    return this.pattern;
  }

  // High detail = pattern relief (3-tap bump) + the energy bounce light. The
  // low-spec tier drops both (a program swap, cached after the first use).
  setHighDetail(on: boolean) {
    const defs = (this.defines ??= {});
    if ((defs.GUN_HI !== undefined) === on) return;
    if (on) defs.GUN_HI = '';
    else delete defs.GUN_HI;
    this.needsUpdate = true;
  }

  // Recolour in place: palette AND pattern are uniforms (the pattern is a
  // uniform branch), so a finish change never compiles a shader — every gun
  // of a LOD/detail tier shares one program.
  setFinish(finish: RailgunFinish | undefined) {
    const f = finish ?? STOCK_FINISH;
    applyFinishUniforms(this.gun, f);
    this.emissive.setHex(f.accentHot);
    this.pattern = f.pattern ?? 'plain';
    this.gun.uPattern.value = PATTERN_ID[this.pattern as string] ?? 0;
  }

  customProgramCacheKey(): string {
    return `railgun-surface-3|${this.defines?.GUN_HI !== undefined ? 'hi' : 'lo'}`;
  }

  onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.gun);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 gun;\nvarying vec3 vGunPos;\nvarying vec3 vGunNrm;\nvarying vec3 vGun;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunPos = position;\nvGunNrm = normal;\nvGun = gun;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', FRAG_SURFACE)
      .replace('vec3 totalEmissiveRadiance = emissive;', FRAG_EMISSIVE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = gunS.rough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = gunS.metal;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_BUMP}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${FRAG_AO}`);
  }
}
