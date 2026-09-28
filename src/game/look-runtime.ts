// Looks runtime (economy v3): everything the game-side needs to turn a compact
// `Loadout` (slot → Look) into what the renderers consume, in one place.
//
//   • looksToLegacy   Looks → the legacy per-slot Settings ids (kept in sync so
//                     un-migrated consumers still work)
//   • resolveCosmetics  a Loadout → the legacy-shaped ids a RemotePlayer draws
//   • randomBotLoadout  variety for solo bots (wearables + finish, ~5% unusual)
//   • BodyGear        the worn gear (hat now; face/back when WornGear lands)
//   • RailgunV3       the optional killstreak/strange setters on a railgun model
//   • vfxHooks        seams for the VFX track (TauntAura / KillstreakEyes)
import * as THREE from 'three';
import { WornHat } from './hats';
import {
  DEFAULT_CARD,
  DEFAULT_EMOTE,
  DEFAULT_KILL_EFFECT,
  DEFAULT_NAME_COLOR,
  DEFAULT_RAIL_COLOR,
  DEFAULT_RAILGUN_FINISH,
  DEFAULT_SPAWN_EFFECT,
  DEFAULT_TITLE,
  UNUSUALS,
  emoteById,
  cardById,
  killEffectById,
  nameColorById,
  titleById,
  type UnusualKind,
  isCard,
  isEmote,
  isHat,
  isKillEffectStyle,
  isNameColor,
  isRailColor,
  isRailgunFinish,
  isSpawnEffect,
  isTitle,
} from './cosmetics';
import { ITEM_DEFS } from './items/catalog';
import { ITEM_SLOTS, KS_EFFECTS, KS_SHEENS, UNUSUAL_EFFECTS, strangeRank, type ItemSlot, type Loadout, type Look } from './items/types';
import { UnusualEffect, unusualKindForEffect, type EffectKind } from './fx/unusuals';
import { TauntAura } from './fx/taunt-aura';
import { KillstreakEyes } from './fx/killstreak-eyes';
import type { Settings } from '../app-types';
import { isEmoteKind, type AnyEmoteKind } from './emotes';

// ── Looks → legacy ids ───────────────────────────────────────────────────────
export type LegacyCosmetics = {
  hat: string;
  unusual: string;
  killEffect: string;
  railColor: string;
  railgunFinish: string;
  card: string;
  emote: string;
  nameColor: string;
  spawnEffect: string;
  title: string;
};

// The legacy `unusual.*` id whose emitter kind matches a v3 effect id ('fx.embers'),
// or 'unusual.none' when the old renderer has no such kind.
export function effectToLegacyUnusual(effectId: string | undefined): string {
  if (!effectId) return 'unusual.none';
  const kind = UNUSUAL_EFFECTS.find((e) => e.id === effectId)?.kind;
  if (!kind) return 'unusual.none';
  return UNUSUALS.find((u) => u.kind === kind)?.id ?? 'unusual.none';
}

export function effectKind(effectId: string | undefined): string | null {
  if (!effectId) return null;
  return UNUSUAL_EFFECTS.find((e) => e.id === effectId)?.kind ?? null;
}

const pick = (look: Look | undefined, ok: (id: string) => boolean, fallback: string): string =>
  look && ok(look.d) ? look.d : fallback;

export function looksToLegacy(looks: Loadout | undefined): LegacyCosmetics {
  const l = looks ?? {};
  return {
    hat: pick(l.hat, isHat, 'hat.none'),
    unusual: effectToLegacyUnusual(l.hat?.e),
    killEffect: pick(l.finisher, isKillEffectStyle, DEFAULT_KILL_EFFECT),
    railColor: pick(l.beam, isRailColor, DEFAULT_RAIL_COLOR),
    railgunFinish: pick(l.finish, isRailgunFinish, DEFAULT_RAILGUN_FINISH),
    card: pick(l.card, isCard, DEFAULT_CARD),
    emote: pick(l.emote, isEmote, DEFAULT_EMOTE),
    nameColor: pick(l.nameColor, isNameColor, DEFAULT_NAME_COLOR),
    spawnEffect: pick(l.spawn, isSpawnEffect, DEFAULT_SPAWN_EFFECT),
    title: pick(l.title, isTitle, DEFAULT_TITLE),
  };
}

// What a RemotePlayer draws from: the legacy-shaped ids (validated, so a stale
// or forged look can never break rendering) plus the raw Looks for the parts
// the legacy ids can't express (face/back gear, sheen, effect kinds).
export type ResolvedCosmetics = LegacyCosmetics & { looks: Loadout };
export function resolveCosmetics(looks: Loadout): ResolvedCosmetics {
  return { ...looksToLegacy(looks), looks };
}

// Keep the legacy per-slot Settings fields in step with `looks` (the hub writes
// `looks`; un-migrated consumers still read the old ids). No-op without looks.
export function withLegacyFromLooks(s: Settings): Settings {
  if (!s.looks) return s;
  const l = looksToLegacy(s.looks);
  const same =
    s.hat === l.hat && s.unusual === l.unusual && s.killEffect === l.killEffect &&
    s.railColor === l.railColor && s.railgunFinish === l.railgunFinish && s.card === l.card &&
    s.emote === l.emote && s.nameColor === l.nameColor && s.spawnEffect === l.spawnEffect &&
    s.title === l.title;
  if (same) return s;
  return {
    ...s,
    hat: l.hat,
    unusual: l.unusual,
    killEffect: l.killEffect as Settings['killEffect'],
    railColor: l.railColor,
    railgunFinish: l.railgunFinish,
    card: l.card,
    emote: l.emote,
    nameColor: l.nameColor,
    spawnEffect: l.spawnEffect,
    title: l.title,
  };
}
// ── Kit summary (killcam card / Play of the Match title) ─────────────────────
// What an on-screen card says about a player's setup: their gun with its
// qualities ("Professional Killstreak Wyrmfang"), their finisher, title and card
// style. `strangeKills` (only known for your own strange gun) adds the Strange
// rank + counter. Cosmetic text only.
export type KitInfo = {
  weapon: string; // e.g. 'Festive Killstreak Wyrmfang' (or 'Railgun')
  weaponKills?: number; // the strange counter, when known
  finisher: string; // '' for the default finisher
  title: string; // '' = none
  cardBg: string; // CSS background of the equipped playercard
  cardAccent: string;
  nameColor: string; // CSS colour of the name
};

export function kitInfo(looks: Loadout | undefined, strangeKills?: number | null): KitInfo {
  const l = looks ?? {};
  const fin = l.finish;
  const def = fin ? ITEM_DEFS.find((d) => d.id === fin.d) : undefined;
  const base = def && !def.default ? def.name : 'Railgun';
  const parts: string[] = [];
  const kills = typeof strangeKills === 'number' ? strangeKills : undefined;
  if (kills !== undefined) parts.push(strangeRank(kills));
  if (fin?.f) parts.push('Festive');
  if (fin?.k) parts.push('Professional Killstreak');
  else if (fin?.s) parts.push('Killstreak');
  const legacy = looksToLegacy(l);
  const card = cardById(legacy.card);
  const finisher = legacy.killEffect === DEFAULT_KILL_EFFECT ? '' : killEffectById(legacy.killEffect).name;
  return {
    weapon: [...parts, base].join(' '),
    weaponKills: kills,
    finisher,
    title: titleById(legacy.title).text,
    cardBg: card.bg,
    cardAccent: card.accent,
    nameColor: nameColorById(legacy.nameColor).color,
  };
}

// ── Loadout tokens ───────────────────────────────────────────────────────────
// What `{type:'loadout', uids}` carries: per slot the equipped instance uid, or
// `def:<id>` for a default/entitlement (the server drops anything unowned).
export function loadoutTokens(looks: Loadout | undefined, uids: Partial<Record<ItemSlot, string>> | undefined): string[] {
  const out: string[] = [];
  for (const slot of ITEM_SLOTS) {
    const uid = uids?.[slot];
    if (uid) out.push(uid);
    else if (looks?.[slot]?.d) out.push(`def:${looks[slot]!.d}`);
  }
  return out;
}

// ── Emote → clip kind ────────────────────────────────────────────────────────
// The clip kind of a Look's emote def (unknown → the default cheer).
export function emoteKindOfLook(look: Look | undefined): AnyEmoteKind {
  const kind = emoteById(look && isEmote(look.d) ? look.d : DEFAULT_EMOTE).kind as string;
  return isEmoteKind(kind) ? kind : 'cheer';
}

// ── Bot loadouts ─────────────────────────────────────────────────────────────
const defsIn = (slot: ItemSlot) => ITEM_DEFS.filter((d) => d.slot === slot && !d.default && d.inCases);
const HAT_DEFS = defsIn('hat');
const FACE_DEFS = defsIn('face');
const BACK_DEFS = defsIn('back');
const FINISH_DEFS = ITEM_DEFS.filter((d) => d.slot === 'finish' && d.inCases);
const EMOTE_DEFS = ITEM_DEFS.filter((d) => d.slot === 'emote' && d.inCases);
// Only effect kinds the hat renderer actually has (legacy UnusualKind set).
const RENDERABLE_EFFECTS = UNUSUAL_EFFECTS.filter((e) => UNUSUALS.some((u) => u.kind === e.kind));
const oneOf = <T>(a: readonly T[]): T | undefined => a[Math.floor(Math.random() * a.length)];

// A random cosmetic loadout for a solo bot: usually a hat, often face/back gear
// and a finish, ~5% of hats Unusual. Purely visual.
export function randomBotLoadout(): Loadout {
  const out: Loadout = {};
  const hat = Math.random() < 0.85 ? oneOf(HAT_DEFS) : undefined;
  if (hat) {
    out.hat = { d: hat.id };
    if (Math.random() < 0.05) {
      const fx = oneOf(RENDERABLE_EFFECTS);
      if (fx) out.hat.e = fx.id;
    }
  }
  const face = Math.random() < 0.4 ? oneOf(FACE_DEFS) : undefined;
  if (face) out.face = { d: face.id };
  const back = Math.random() < 0.4 ? oneOf(BACK_DEFS) : undefined;
  if (back) out.back = { d: back.id };
  const finish = Math.random() < 0.6 ? oneOf(FINISH_DEFS) : undefined;
  if (finish) {
    out.finish = { d: finish.id };
    // Variety for solo: some guns are Killstreak (a few Professional) and some Festive.
    if (Math.random() < 0.3) {
      out.finish.s = oneOf(KS_SHEENS)?.id;
      if (Math.random() < 0.4) out.finish.k = oneOf(KS_EFFECTS)?.id;
    }
    if (Math.random() < 0.12) out.finish.f = 1;
  }
  const emote = oneOf(EMOTE_DEFS);
  if (emote) {
    out.emote = { d: emote.id };
    if (Math.random() < 0.25) {
      const fx = oneOf(UNUSUAL_EFFECTS.filter((e) => e.taunt && unusualKindForEffect(e.id)));
      if (fx) out.emote.e = fx.id;
    }
  }
  return out;
}

// ── Worn gear ────────────────────────────────────────────────────────────────
// Adapter over the head-socket wearables. Today: the legacy WornHat (glTF hats
// + Unusual crown). When the wearables track lands (`WornGear` in
// src/game/wearables: setLook(slot, look), setUnusual(kind), update, dispose)
// only this class's internals change — every caller already goes through it.
export class BodyGear {
  private hat: WornHat;
  // A v3 Unusual (any effect kind — the legacy WornHat only knows the old set),
  // seated on the hat's unusual anchor so it crowns whatever hat is worn.
  private fx: UnusualEffect | null = null;
  private fxKind: EffectKind | null = null;
  constructor(headTop: THREE.Object3D) {
    this.hat = new WornHat(headTop);
  }
  // STUB(T3): face/back gear render nothing until WornGear exists.
  setLook(slot: 'hat' | 'face' | 'back', look: Look | undefined): void {
    if (slot !== 'hat') return;
    void this.hat.setHat(look && isHat(look.d) ? look.d : 'hat.none');
    const kind = unusualKindForEffect(look?.e);
    if (kind) {
      this.hat.setUnusual('unusual.none');
      this.setFx(kind);
    } else {
      this.setFx(null);
      this.hat.setUnusual(effectToLegacyUnusual(look?.e));
    }
  }
  private setFx(kind: EffectKind | null): void {
    if (kind === this.fxKind) return;
    this.fxKind = kind;
    this.fx?.group.removeFromParent();
    this.fx?.dispose();
    this.fx = null;
    if (!kind) return;
    this.fx = new UnusualEffect(kind);
    (this.hat as unknown as { unusualAnchor: THREE.Group }).unusualAnchor.add(this.fx.group);
  }
  setLegacy(hatId: string, unusualId: string): void {
    this.setFx(null);
    void this.hat.setHat(hatId);
    this.hat.setUnusual(unusualId);
  }
  setLooks(looks: Loadout): void {
    this.setLook('hat', looks.hat);
    this.setLook('face', looks.face);
    this.setLook('back', looks.back);
  }
  update(dt: number): void {
    this.hat.update(dt);
    this.fx?.update(dt);
  }
  dispose(): void {
    this.setFx(null);
    this.hat.dispose();
  }
}

// ── Railgun v3 setters (owned by the VFX track) ──────────────────────────────
// Optional so this compiles before they merge; call sites use `?.`.
export type RailgunV3 = {
  setStreak?: (n: number) => void;
  setKillstreak?: (sheen: string | undefined, ksEffect: string | undefined) => void;
  setFestive?: (on: boolean) => void;
  setStrangeKills?: (kills: number | null) => void;
  visible?: boolean;
};
export const asV3 = (o: unknown): RailgunV3 => (o ?? {}) as RailgunV3;

export function applyFinishLook(gun: unknown, look: Look | undefined): void {
  const g = asV3(gun);
  g.setKillstreak?.(look?.s, look?.k);
  g.setFestive?.(!!look?.f);
}

// ── VFX seams ────────────────────────────────────────────────────────────────
export type TauntAuraLike = {
  group: THREE.Object3D;
  update(dt: number): void;
  dispose(): void;
  // The VFX track's whole-body TauntAura: parented on the character root and
  // started for the emote's length (the legacy crown emitter has neither).
  start?(seconds: number): void;
  stop?(): void;
};
export type EyesLike = {
  setActive(on: boolean): void;
  setStreak?(n: number): void;
  update?(dt: number): void;
  dispose(): void;
};
export const vfxHooks: {
  createTauntAura?: (effectKind: string) => TauntAuraLike | null;
  createKillstreakEyes?: (headTop: THREE.Object3D, ksEffect: string) => EyesLike | null;
} = {};

// VFX track wiring: the whole-body taunt aura and the killstreak eyes.
vfxHooks.createTauntAura = (effectKind) => {
  const kind = unusualKindForEffect(UNUSUAL_EFFECTS.find((e) => e.kind === effectKind)?.id);
  if (!kind) return null;
  const a = new TauntAura(kind);
  return { group: a.group, update: (dt) => a.update(dt), dispose: () => a.dispose(), start: (sec) => a.start(sec), stop: () => a.stop() };
};
vfxHooks.createKillstreakEyes = (headTop, ksEffect) => {
  const e = new KillstreakEyes();
  e.setEffect(ksEffect);
  headTop.add(e.group);
  return {
    setActive: () => {},
    setStreak: (n) => e.setStreak(n),
    update: (dt) => e.update(dt),
    dispose: () => e.dispose(),
  };
};

// A taunt's effect aura: the VFX track's TauntAura when the effect has one, else
// the existing Unusual emitter for kinds the old renderer knows.
export function createTauntAura(effectId: string | undefined): TauntAuraLike | null {
  const kind = effectKind(effectId);
  if (!kind) return null;
  const custom = vfxHooks.createTauntAura?.(kind);
  if (custom) return custom;
  if (!UNUSUALS.some((u) => u.kind === kind)) return null;
  const fx = new UnusualEffect(kind as Exclude<UnusualKind, 'none'>);
  return { group: fx.group, update: (dt) => fx.update(dt), dispose: () => fx.dispose() };
}
