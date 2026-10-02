import * as THREE from 'three';
import {
  BOT_HEADSHOT_THRESHOLD,
  BOT_HEIGHT,
  BOT_RADIUS,
  BOT_RESPAWN_DELAY,
  DEFAULT_BOT_DIFFICULTY,
  type BotDifficulty,
} from './constants';
import type { ArenaMap } from './map';
import { BotBrain, type BotTarget } from './bot-brain';
import { navFor, pickSpawnPoint } from './bot-nav';
import { CharacterAnimator, type CharacterAnimInput } from './character-anim';
import { Character, skinColorFor } from './character/character';
import { dyeById } from './dyes';
import { attachRailgun, disposeRailgun, type AttachedRailgun } from './character/gun';
import { floorBelow, type GibFloor } from './character/gibs';
import type { FootfallListener } from './locomotion';
import {
  BodyGear,
  applyFinishLook,
  asV3,
  createTauntAura,
  emoteKindOfLook,
  randomBotLoadout,
  resolveCosmetics,
  vfxHooks,
  type EyesLike,
  type TauntAuraLike,
} from './look-runtime';
import { emoteClip } from './emotes';
import { railgunFinishById, type KillEffectStyle } from './cosmetics';
import type { Loadout } from './items/types';
import type { BotState, EntityId, Vec3 } from './types';

// The AI lives in bot-brain.ts (perception, aim, movement, tactics) over the
// nav graph in bot-nav.ts — both THREE-free so scripts/bot-sim.ts can QA them
// headless. This module is the bot's body: model, animation, cosmetics.
export type { BotTarget } from './bot-brain';
export { pickFreeSpot, pickSpawnPoint } from './bot-nav';

const BOT_NAMES = ['Vex', 'Razor', 'Strafe', 'Pyro', 'Vandal', 'Frost', 'Pulse', 'Echo'];

// A bot's decision to fire this tick — resolved by Game against the world.
export type BotFireIntent = { botId: string; botName: string; origin: Vec3; dir: Vec3; team: number | null };
// The combatant faces -Z at identity. Look yaw is atan2(dx, dz) (0 = +Z),
// so we add π to rotate the model's natural -Z forward around to match.
export const MODEL_YAW_OFFSET = Math.PI;

// The character "model" is now built in code (see character/): there is no
// asset to load. BotModel stays as an opaque token so callers (Game, replays,
// the replay viewer) keep their load-then-spawn flow unchanged.
export type BotModel = { readonly kind: 'combatant' };
const COMBATANT_MODEL: BotModel = Object.freeze({ kind: 'combatant' as const });

// Resolves immediately. The URL (the old soldier.glb path) is ignored.
export async function loadBotModel(_url?: string): Promise<BotModel | null> {
  return COMBATANT_MODEL;
}

function makeNameSprite(name: string, color = '#ffd1d8'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(name);
    const padding = 16;
    const boxW = Math.min(canvas.width - 4, metrics.width + padding * 2);
    const boxH = 40;
    ctx.fillStyle = 'rgba(8,10,14,0.7)';
    roundRect(ctx, (canvas.width - boxW) / 2, (canvas.height - boxH) / 2, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    // Respect the depth buffer so nameplates are hidden when the bot is
    // behind a wall — depthTest: true is the WebGL way to do simple
    // occlusion without per-frame raycasts.
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.0, 0.5, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Emissive-only highlight for plain MeshStandardMaterials (the capsule
// fallback). The combatant recolours its armour via Character.setLook().
// Reversible: null clears the glow without touching base colours/textures.
export function applyHighlight(
  mat: THREE.Material | THREE.Material[] | undefined,
  color: THREE.Color | null,
) {
  const one = (m: THREE.Material) => {
    const sm = m as THREE.MeshStandardMaterial;
    if (!sm.isMeshStandardMaterial) return;
    if (color) {
      sm.emissive.copy(color);
      sm.emissiveIntensity = 1.4;
    } else {
      sm.emissive.setRGB(0, 0, 0);
      sm.emissiveIntensity = 1;
    }
  };
  if (Array.isArray(mat)) mat.forEach(one);
  else if (mat) one(mat);
}

export class Bot {
  state: BotState;
  group: THREE.Group;
  private readonly brain: BotBrain;
  private gear: BodyGear | null = null;
  readonly loadout: Loadout = randomBotLoadout(); // random cosmetics for variety (solo)
  private tauntLeft = 0;
  private streak = 0;
  private tauntAura: TauntAuraLike | null = null; // an Unusual emote's aura while it plays
  private eyes: EyesLike | null = null; // Professional Killstreak eyes while on a streak
  private gun: AttachedRailgun | null = null; // third-person railgun (disposed with the bot)
  // Reused animator input (no per-frame allocation).
  private readonly animIn: CharacterAnimInput = { dt: 0, yaw: 0, pitch: 0, pos: new THREE.Vector3() };
  // Shared third-person animator (gait, aim, jump/land, gibs) — the same
  // implementation remote players use. Null on the capsule fallback.
  private anim: CharacterAnimator | null = null;
  private character: Character | null = null;
  // The combatant body (null on the capsule fallback) — for viewer-side
  // overlays such as the enemy outline.
  get body(): Character | null {
    return this.character;
  }
  private highlight: THREE.Color | null = null; // viewer's enemy-highlight colour
  private teamLook: string | null = null; // TDM team colour (overrides highlight)
  private lastMap: ArenaMap | null = null; // for the gib floor probe (visual only)
  private fallbackBody: THREE.Mesh | null = null;
  private fallbackHead: THREE.Mesh | null = null;
  private nameSprite: THREE.Sprite;
  // The in-world nameplate (Game hides an enemy's plate for a frame when no
  // part of the body is in line of sight — see Game.gateEnemyPlates).
  get plate(): THREE.Sprite {
    return this.nameSprite;
  }
  private team: number | null = null; // TDM team (0/1); null in FFA/Duel — drives targeting + nameplate color
  private nameColor = '#ffd1d8'; // current nameplate color (team-tinted in TDM)

  constructor(
    id: EntityId,
    name: string,
    spawn: Vec3,
    scene: THREE.Scene,
    model: BotModel | null,
    difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  ) {
    this.brain = new BotBrain(id, spawn, difficulty);
    this.state = {
      id,
      name,
      pos: this.brain.pos,
      alive: true,
      respawnTimer: 0,
    };
    this.group = new THREE.Group();

    if (model) {
      this.installModel(model);
    } else {
      this.installFallback();
    }

    this.nameSprite = makeNameSprite(name);
    this.nameSprite.position.y = BOT_HEIGHT + 0.35;
    this.group.add(this.nameSprite);
    this.group.position.set(spawn.x, spawn.y, spawn.z);
    scene.add(this.group);
    // LocomotionBlender (created in installModel) already starts in idle.
  }

  // Face into the map at the start of a match (bots are created at spawns).
  initFacing(map: ArenaMap) {
    this.brain.respawn(this.state.pos, map);
    this.state.pos = this.brain.pos;
  }

  // Returns a fire intent when the bot decides to shoot this tick, else null.
  // `enemies` is every targetable entity (player + other bots); the bot filters
  // itself out by id.
  step(dt: number, map: ArenaMap, enemies: BotTarget[], frozen = false): BotFireIntent | null {
    this.lastMap = map;
    const intent = this.stepLogic(dt, map, enemies, frozen);
    // Animate AFTER the body's transform is final for this tick (the animator
    // measures motion from the group position). The manager re-seats the hat
    // afterwards via updateHat().
    this.animate(dt);
    return intent;
  }

  private stepLogic(dt: number, map: ArenaMap, enemies: BotTarget[], frozen: boolean): BotFireIntent | null {
    // Countdown freeze: keep animating (idle, via animate()) but stay put — no
    // movement, decisions, or fire until the match goes live.
    if (frozen) {
      this.brain.freeze();
      return null;
    }

    if (!this.state.alive) {
      // Corpse phase: the gibs fly where the body burst, then the body hides
      // for the rest of the respawn delay (the delay itself is unchanged — it
      // keeps ticking through the corpse phase).
      if (this.group.visible && !(this.anim?.isDying() && !this.anim.deathDone())) {
        this.group.visible = false;
      }
      this.state.respawnTimer -= dt;
      if (this.state.respawnTimer <= 0) {
        const spot = pickSpawnPoint(map, enemies.filter((e) => e.id !== this.state.id).map((e) => e.pos));
        this.brain.respawn(spot, map);
        this.state.pos = this.brain.pos;
        this.group.position.set(spot.x, spot.y, spot.z);
        this.state.alive = true;
        this.group.visible = true;
        this.anim?.respawn(this.group.position); // clear the gibs, back to idle
        this.nameSprite.visible = !this.plateSuppressed;
      }
      return null;
    }

    const shot = this.brain.step(dt, map, enemies);
    this.state.pos = this.brain.pos;
    this.group.position.set(this.state.pos.x, this.state.pos.y, this.state.pos.z);
    if (!shot) return null;
    return { botId: this.state.id, botName: this.state.name, origin: shot.origin, dir: shot.dir, team: this.team };
  }

  // Gunfire somewhere in the arena (see BotBrain.hearShot).
  hearShot(origin: Vec3, end: Vec3, shooterId: string, shooterTeam: number | null) {
    if (this.state.alive) this.brain.hearShot(origin, end, shooterId, shooterTeam);
  }

  // Drive the shared third-person animator: gait from the measured motion, the
  // body + aim pitch from the brain's look direction, jump/land/death layers.
  // Purely visual — the hitbox is the state.pos AABB.
  private animate(dt: number) {
    if (!this.anim || !this.group.visible) return;
    // Safety net: a finished gib burst never lingers (e.g. a death right
    // before a countdown freeze skips the corpse branch in stepLogic).
    if (!this.state.alive && this.anim.deathDone()) {
      this.group.visible = false;
      return;
    }
    const ai = this.animIn;
    ai.dt = dt;
    ai.yaw = this.brain.yaw + MODEL_YAW_OFFSET;
    ai.pitch = this.state.alive ? this.brain.pitch : 0;
    ai.pos = this.group.position;
    this.anim.update(ai);
  }

  // TDM team assignment (null = FFA/Duel). `color` tints the nameplate so the
  // player can tell allies (green) from foes (team color) — required since
  // friendly fire is off. Rebuilds the name sprite with the new color.
  setTeam(team: number | null, color = '#ffd1d8') {
    this.team = team;
    this.brain.team = team;
    // TDM: the armour wears the team colour too (identification > highlight).
    const look = team != null ? color : null;
    if (look !== this.teamLook) {
      this.teamLook = look;
      this.resolveLook();
    }
    if (color === this.nameColor) return;
    this.nameColor = color;
    const next = makeNameSprite(this.state.name, color);
    next.position.copy(this.nameSprite.position);
    this.group.remove(this.nameSprite);
    this.nameSprite.material.map?.dispose();
    this.nameSprite.material.dispose();
    this.nameSprite = next;
    this.group.add(this.nameSprite);
  }
  getTeam(): number | null {
    return this.team;
  }

  // The bot fired: its 3rd-person gun's claw flashes (in `railColor`) and the
  // coils recharge.
  notifyFire(railColor?: number) {
    this.gun?.notifyFire(railColor);
  }

  // World position of the 3rd-person gun's muzzle into `out` (null without a
  // gun) — where this bot's visible beam + discharge should start.
  gunMuzzle(out: THREE.Vector3): THREE.Vector3 | null {
    return this.gun && this.state.alive ? this.gun.muzzleWorld(out) : null;
  }

  // `style` = the killer's finisher (how this body breaks apart).
  kill(style?: KillEffectStyle) {
    if (!this.state.alive) return;
    this.state.alive = false;
    this.state.respawnTimer = BOT_RESPAWN_DELAY;
    // Instagib: the body bursts into its armour chunks where it stood; step()
    // hides it once they've shrunk away. Capsule fallback: vanish at once.
    let floor: GibFloor = null;
    if (this.brain.onGround) floor = { y: this.state.pos.y };
    else if (this.lastMap) {
      const y = floorBelow(this.lastMap.boxes, this.state.pos.x, this.state.pos.y, this.state.pos.z);
      if (y !== null && this.state.pos.y - y < 4) floor = { y };
    }
    if (!this.anim?.die(floor, style)) this.group.visible = false;
    this.nameSprite.visible = false; // no floating name over the gibs
  }

  isHeadshot(hitY: number): boolean {
    return hitY >= this.state.pos.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD;
  }

  centerY(): number {
    return this.state.pos.y + BOT_HEIGHT * 0.5;
  }

  // Current look/aim yaw (radians) — sampled by the match recorder so the
  // Play-of-the-Match replay can re-orient a bot actor faithfully.
  getFacing(): number {
    return this.brain.yaw;
  }

  // Current look/aim pitch (radians, + up) — the same angle the body's aim
  // layer uses. Sampled by the match recorder so a killcam through this bot's
  // eyes looks where it aimed.
  getAimPitch(): number {
    return this.state.alive ? this.brain.pitch : 0;
  }

  bounds(): { min: Vec3; max: Vec3 } {
    return {
      min: {
        x: this.state.pos.x - BOT_RADIUS,
        y: this.state.pos.y,
        z: this.state.pos.z - BOT_RADIUS,
      },
      max: {
        x: this.state.pos.x + BOT_RADIUS,
        y: this.state.pos.y + BOT_HEIGHT,
        z: this.state.pos.z + BOT_RADIUS,
      },
    };
  }

  // Animate the hat's unusual effect (the hat itself rides the head socket).
  updateHat(dt: number) {
    this.gear?.update(dt);
    this.eyes?.update?.(dt);
    this.tauntAura?.update(dt);
    if (this.tauntLeft > 0) {
      this.tauntLeft -= dt;
      const over = this.tauntLeft <= 0 || !this.state.alive;
      if (over) {
        this.anim?.playEmote(null);
        this.clearTauntAura();
      }
      // A non-gun emote hides the held railgun (it would ride the raised hand).
      if (this.gun && this.anim) this.gun.visible = over || this.anim.emoteShowsGun;
    }
  }

  // Killcam showcase: the nameplate stays off while this bot is on camera (a
  // respawn inside that window doesn't bring it back).
  private plateSuppressed = false;
  setPlateSuppressed(off: boolean) {
    this.plateSuppressed = off;
    this.nameSprite.visible = !off && this.state.alive;
  }

  get isTaunting(): boolean {
    return this.tauntLeft > 0 && this.state.alive;
  }

  // Play this bot's equipped emote (a brief victory taunt). Grounded only — a
  // taunting bot stands still (and stays a normal target).
  taunt(): boolean {
    if (!this.anim || !this.state.alive || !this.brain.onGround || this.tauntLeft > 0) return false;
    const look = this.loadout.emote;
    const kind = emoteKindOfLook(look);
    this.anim.playEmote(kind, true);
    const dur = Math.min(emoteClip(kind).duration, 2.6);
    this.tauntLeft = dur;
    // An Unusual emote's aura (whole-body, on the character root).
    this.clearTauntAura();
    const aura = createTauntAura(look?.e);
    if (aura?.start && this.character) {
      this.character.root.add(aura.group);
      aura.start(dur);
      this.tauntAura = aura;
    } else {
      aura?.dispose();
    }
    return true;
  }

  private clearTauntAura() {
    if (!this.tauntAura) return;
    this.tauntAura.group.removeFromParent();
    this.tauntAura.dispose();
    this.tauntAura = null;
  }

  // Killstreak on the gun (sheen) — bots roll a random finish, some are killstreak-capable.
  setStreak(n: number) {
    if (n === this.streak) return;
    this.streak = n;
    if (this.gun) asV3(this.gun).setStreak?.(n);
    // Professional Killstreak: the eyes light from a 5-kill streak.
    const ks = this.loadout.finish?.k;
    const on = !!ks && n >= 5;
    if (on && !this.eyes && this.character) {
      this.eyes = vfxHooks.createKillstreakEyes?.(this.character.sockets.headTop, ks) ?? null;
    } else if (!on && this.eyes) {
      this.eyes.dispose();
      this.eyes = null;
    }
    this.eyes?.setStreak?.(n);
  }

  // Footfall events for synced footstep audio (see RemotePlayer).
  get footfalls(): number {
    return this.anim?.footfalls ?? 0;
  }
  set onFootfall(fn: FootfallListener | null) {
    if (this.anim) this.anim.onFootfall = fn;
  }

  dispose(scene: THREE.Scene) {
    this.gear?.dispose();
    this.eyes?.dispose();
    this.eyes = null;
    this.clearTauntAura();
    if (this.gun) disposeRailgun(this.gun); // per-bot gun geometry/materials
    this.gun = null;
    this.character?.dispose();
    scene.remove(this.group);
    if (this.fallbackBody) {
      this.fallbackBody.geometry.dispose();
      (this.fallbackBody.material as THREE.Material).dispose();
    }
    if (this.fallbackHead) {
      this.fallbackHead.geometry.dispose();
      (this.fallbackHead.material as THREE.Material).dispose();
    }
    const smMat = this.nameSprite.material as THREE.SpriteMaterial;
    smMat.map?.dispose();
    smMat.dispose();
    this.anim?.dispose();
  }

  private installModel(_model: BotModel) {
    // The code-built combatant: one skinned mesh on a clean rig, the hat on
    // the helmet socket, the railgun in the right-hand socket.
    const ch = new Character({ colorHex: skinColorFor(this.state.name) });
    this.group.add(ch.root);
    this.character = ch;
    this.gear = new BodyGear(ch.sockets.headTop);
    this.gear.setLooks(this.loadout);
    const cos = resolveCosmetics(this.loadout);
    this.gun = attachRailgun(ch, railgunFinishById(cos.railgunFinish).data);
    applyFinishLook(this.gun, this.loadout.finish);
    // Gait, aim, gun hold, jumps/landings and gibs live in the animator — the
    // same one remote players use.
    this.anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
    this.resolveLook();
  }

  // Armour colour: TDM team colour > the viewer's enemy highlight > own dye / skin.
  private resolveLook() {
    const ch = this.character;
    if (!ch) return;
    if (this.teamLook) ch.setLook(this.teamLook, 'natural');
    else if (this.highlight) ch.setLook(this.highlight, 'highlight');
    else ch.wearDye(dyeById(this.loadout.dye?.d), skinColorFor(this.state.name));
  }

  private installFallback() {
    const bodyGeom = new THREE.CapsuleGeometry(
      BOT_RADIUS,
      BOT_HEIGHT - BOT_RADIUS * 2 - 0.35,
      4,
      16,
    );
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xff4d6d,
      emissive: 0x4a0e1c,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      metalness: 0.1,
    });
    this.fallbackBody = new THREE.Mesh(bodyGeom, bodyMat);
    this.fallbackBody.position.y = (BOT_HEIGHT - 0.35) / 2;
    this.fallbackBody.castShadow = true;
    this.group.add(this.fallbackBody);
    const headGeom = new THREE.SphereGeometry(BOT_RADIUS * 0.78, 16, 12);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffe3e8,
      emissive: 0x5a1226,
      emissiveIntensity: 0.4,
      roughness: 0.35,
    });
    this.fallbackHead = new THREE.Mesh(headGeom, headMat);
    this.fallbackHead.position.y = BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD + 0.12;
    this.fallbackHead.castShadow = true;
    this.group.add(this.fallbackHead);
  }

  // Bright-enemy highlight (the viewer's chosen colour, full-bright armour).
  // null = the bot's natural skin. The capsule fallback keeps the old glow.
  setHighlight(color: THREE.Color | null) {
    if (color) (this.highlight ??= new THREE.Color()).copy(color);
    else this.highlight = null;
    if (this.fallbackBody) applyHighlight(this.fallbackBody.material, color);
    if (this.fallbackHead) applyHighlight(this.fallbackHead.material, color);
    this.resolveLook();
  }
}

export class BotManager {
  bots: Bot[] = [];

  constructor(
    scene: THREE.Scene,
    map: ArenaMap,
    count: number,
    playerSpawn: Vec3,
    model: BotModel | null,
    difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  ) {
    // Build (or fetch) the map's nav graph now, during the countdown, rather
    // than on the first live tick.
    navFor(map);
    const names = pickN(BOT_NAMES, count);
    for (let i = 0; i < count; i++) {
      const spawn = pickSpawnPoint(map, [playerSpawn, ...this.bots.map((b) => b.state.pos)]);
      const bot = new Bot(`bot-${i}`, names[i] ?? `Bot${i}`, spawn, scene, model, difficulty);
      bot.initFacing(map);
      this.bots.push(bot);
    }
  }

  // Gunfire (the player's or a bot's): every bot may hear it, and one it
  // passes close to flinches toward the shooter.
  hearShot(origin: Vec3, end: Vec3, shooterId: string, shooterTeam: number | null) {
    for (const b of this.bots) b.hearShot(origin, end, shooterId, shooterTeam);
  }

  // Steps every bot and returns the fire intents they produced this tick.
  // `enemies` should include the local player and all bots (each bot skips
  // itself); Game resolves the returned shots against the world.
  step(dt: number, map: ArenaMap, enemies: BotTarget[], frozen = false): BotFireIntent[] {
    const intents: BotFireIntent[] = [];
    for (const b of this.bots) {
      const intent = b.step(dt, map, enemies, frozen);
      if (intent) intents.push(intent);
      b.updateHat(dt);
    }
    return intents;
  }

  dispose(scene: THREE.Scene) {
    for (const b of this.bots) b.dispose(scene);
    this.bots.length = 0;
  }
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}
