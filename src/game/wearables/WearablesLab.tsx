import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CharacterLab, type LabDriver } from '../character/lab';
import { CharacterAnimator } from '../character-anim';
import { attachRailgun } from '../character/gun';
import { setCharacterFxQuality } from '../character/gibs';
import type { Character } from '../character/character';
import { itemDef } from '../items/catalog';
import type { Look } from '../items/types';
import { WornGear, wearableBounds, wearableIds, wearableTris, type GearSlot } from './index';

// ── Wearables lab (dev only) ─────────────────────────────────────────────────
// Contact sheets of combatants wearing the code-built hats / face / back items
// (CharacterLab params apply: view=front|3q|side|back|3qb, zoom=full|upper|head,
// cols, spacing, bg, color, ty).
//
//   ?slot=hat|face|back|all  &from=0&n=12     one item per combatant
//   ?items=hat.cap,back.cape.royal            explicit list
//   ?combo=hat.crown~face.skull~back.pack     one combatant wearing a set
//   ?festive=1  ?tint=ff4fd8  ?unusual=embers  look attributes
//   ?pose=idle|run|dash|strafe|jump|gib  &t=1.1  (&play=1 real-time)
//   ?turn=1                                    each item from front · ¾ · side · back
//   ?tris=1                                    label with triangle counts
//   ?fx=low                                    low-spec geometry

type Scen = (t: number) => { x: number; y: number; z: number; vx: number; vy: number; vz: number };
const G = 25;
const SCEN = new Map<string, Scen>([
  ['run', (t) => ({ x: 0, y: 0, z: -8 * t, vx: 0, vy: 0, vz: -8 })],
  ['strafe', (t) => ({ x: 8 * t, y: 0, z: 0, vx: 8, vy: 0, vz: 0 })],
  ['dash', (t) => {
    const v = t < 1 ? 9 : t < 1.18 ? 24 : 9;
    const z = t < 1 ? 9 * t : t < 1.18 ? 9 + 24 * (t - 1) : 9 + 24 * 0.18 + 9 * (t - 1.18);
    return { x: 0, y: 0, z: -z, vx: 0, vy: 0, vz: -v };
  }],
  ['jump', (t) => {
    const u = t - 1;
    const y = u > 0 ? Math.max(0, 8 * u - 0.5 * G * u * u) : 0;
    const vy = u > 0 && y > 0 ? 8 - G * u : 0;
    return { x: 0, y, z: -8 * t, vx: 0, vy, vz: -8 };
  }],
  ['gib', (t) => ({ x: 0, y: 0, z: t < 1 ? -6 * t : -6, vx: 0, vy: 0, vz: t < 1 ? -6 : 0 })],
]);

type Entry = { looks: Partial<Record<GearSlot, Look>>; label: string; yaw?: number };
const TURN: [number, string][] = [
  [0, 'front'],
  [-Math.PI / 4, '3/4'],
  [-Math.PI / 2, 'side'],
  [Math.PI, 'back'],
];

function entries(params: URLSearchParams): Entry[] {
  const festive = params.get('festive') === '1';
  const tint = params.get('tint');
  const look = (d: string): Look => ({ d, ...(festive ? { f: 1 as const } : {}), ...(tint ? { t: `#${tint.replace('#', '')}` } : {}) });
  const slotOf = (id: string): GearSlot => (id.startsWith('hat.') ? 'hat' : id.startsWith('face.') ? 'face' : 'back');
  const tris = params.get('tris') === '1';
  const name = (id: string) => (itemDef(id)?.name ?? id) + (tris ? ` ${wearableTris(id, params.get('fx') === 'low')}` : '');
  const combo = params.get('combo');
  if (combo) {
    return combo.split(',').map((set) => {
      const looks: Entry['looks'] = {};
      for (const id of set.split('~')) if (id) looks[slotOf(id)] = look(id);
      return { looks, label: set.split('~').map(name).join(' + ') };
    });
  }
  let ids: string[];
  const items = params.get('items');
  if (items) ids = items.split(',').filter(Boolean);
  else {
    const slot = params.get('slot') ?? 'all';
    ids = wearableIds(slot === 'all' ? undefined : (slot as GearSlot));
  }
  const from = Number(params.get('from') ?? 0);
  ids = ids.slice(from, from + Number(params.get('n') ?? ids.length));
  return ids.map((id) => ({ looks: { [slotOf(id)]: look(id) }, label: name(id) }));
}

const STEP = 1 / 120;

function wearablesDriver(params: URLSearchParams): LabDriver {
  const fx = params.get('fx');
  setCharacterFxQuality({ reducedEffects: fx === 'reduced', lowSpec: fx === 'low' });
  const base = entries(params);
  const list: Entry[] = params.get('turn') === '1' ? base.flatMap((e) => TURN.map(([yaw, v]) => ({ ...e, yaw, label: `${e.label} · ${v}` }))) : base;
  const pose = params.get('pose') ?? 'idle';
  const T = Number(params.get('t') ?? (pose === 'idle' ? 0.5 : 2));
  const unusual = params.get('unusual');
  const play = params.get('play') === '1';
  const scen = SCEN.get(pose);
  const moving = Boolean(scen);
  type St = { anim: CharacterAnimator; gear: WornGear; t: number; dead: boolean };
  const st = new Map<Character, St>();
  const pos = new THREE.Vector3();
  const advance = (s: St, ch: Character, slot: THREE.Object3D, to: number) => {
    while (s.t + STEP <= to + 1e-9) {
      s.t += STEP;
      if (scen) {
        const p = scen(s.t);
        pos.set(p.x, p.y, p.z);
        if (pose === 'gib' && !s.dead && s.t >= 1) {
          s.dead = true;
          s.anim.die({ y: 0 });
        }
        s.anim.update({ dt: STEP, yaw: 0, pitch: 0, pos });
        slot.position.y = s.dead ? 0 : p.y;
        s.gear.update(STEP, s.dead ? undefined : { vx: p.vx, vy: p.vy, vz: p.vz });
      } else {
        s.anim.updateStatic(STEP);
        s.gear.update(STEP);
      }
    }
    void ch;
  };
  return {
    count: list.length,
    label: (i) => list[i].label,
    drive(ch, _clock, dt, i, slot) {
      let s = st.get(ch);
      if (!s) {
        if (list[i].yaw !== undefined) slot.rotation.y = list[i].yaw!;
        const anim = new CharacterAnimator(ch, { driveYaw: moving, holdGun: moving });
        if (moving) attachRailgun(ch);
        const gear = new WornGear(ch);
        for (const [k, l] of Object.entries(list[i].looks)) gear.setLook(k as GearSlot, l ?? null);
        if (unusual) gear.setUnusual(unusual);
        s = { anim, gear, t: 0, dead: false };
        st.set(ch, s);
        advance(s, ch, slot, T);
        return;
      }
      if (play && dt > 0) advance(s, ch, slot, s.t + dt);
    },
  };
}

export default function WearablesLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('audit') === '1') {
      // Triangle budget audit (printed as a warning so headless captures log it).
      const rows = wearableIds().map((id) => `${id}:${wearableTris(id)}/${wearableTris(id, true)}`);
      console.warn(`[wear-tris] ${rows.join(' ')}`);
      // Silhouette audit: hats → height above the crown (1.794); backs → |x| and depth behind the back (z 0.2).
      const b = wearableIds().map((id) => {
        const bb = wearableBounds(id);
        if (!bb) return id;
        const f = (v: number) => v.toFixed(3);
        return `${id}:top+${f(bb.max.y - 1.794)},x${f(Math.max(-bb.min.x, bb.max.x))},z+${f(bb.max.z - 0.2)}`;
      });
      console.warn(`[wear-bounds] ${b.join(' ')}`);
    }
    const lab = new CharacterLab(canvas, params);
    lab.setDriver(wearablesDriver(params));
    lab.start();
    const onResize = () => lab.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      lab.dispose();
    };
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0d13' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}
