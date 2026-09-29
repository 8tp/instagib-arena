// Look keys: a Look (def + effect/sheen/pattern) flattened to a stable string,
// so thumbnails and previews can be cached per LOOK rather than per def id.
// THREE-free (thumbs.ts and the UI both import it).
import type { Look } from '../game/items/types';

// 'hat.tophat' → itself; 'hat.tophat|e=fx.embers|p=12' for a rolled variant.
export function lookKey(look: Look): string {
  let k = look.d;
  if (look.e) k += `|e=${look.e}`;
  if (look.s) k += `|s=${look.s}`;
  if (look.k) k += `|k=${look.k}`;
  if (look.f) k += '|f=1';
  if (look.p != null) k += `|p=${look.p}`;
  if (look.w != null) k += `|w=${Math.round(look.w * 100)}`;
  if (look.t) k += `|t=${look.t}`;
  return k;
}

export function parseLookKey(key: string): Look {
  const [d, ...rest] = key.split('|');
  const look: Look = { d };
  for (const part of rest) {
    const i = part.indexOf('=');
    const f = part.slice(0, i);
    const v = part.slice(i + 1);
    if (f === 'e') look.e = v;
    else if (f === 's') look.s = v;
    else if (f === 'k') look.k = v;
    else if (f === 'f') look.f = 1;
    else if (f === 'p') look.p = Number(v);
    else if (f === 'w') look.w = Number(v) / 100;
    else if (f === 't') look.t = v;
  }
  return look;
}
