import * as THREE from 'three';
import { applyHighlight, type BotModel } from './bots';
import { CharacterAnimator, type CharacterAnimInput } from './character-anim';
import { Character, skinColorFor } from './character/character';
import { attachRailgun, disposeRailgun, type AttachedRailgun } from './character/gun';
import { probeGibFloor } from './character/gibs';
import type { FootfallListener } from './locomotion';
import { WornHat } from './hats';
import {
  DEFAULT_RAILGUN_FINISH,
  isRailgunFinish,
  nameColorById,
  railgunFinishById,
  titleById,
  type KillEffectStyle,
} from './cosmetics';
import type { RemotePlayerSnapshot } from './net';
import { BOT_HEADSHOT_THRESHOLD, BOT_HEIGHT, BOT_RADIUS } from './constants';
import type { AABB } from './types';

// The combatant faces -Z at identity. A remote player at yaw=0 is looking down
// -Z too (forward = (-sin yaw, -cos yaw)), so the model already matches with
// NO offset — rotation.y = yaw faces the look direction exactly. (Bots use a
// +π offset, but only because they're fed atan2(dx,dz) of their MOVEMENT
// vector, a different angle convention — don't copy that offset here.)
const MODEL_YAW_OFFSET = 0;

const NAME_FONT = 'bold 28px ui-monospace, SFMono-Regular, Menlo, monospace';
const TITLE_FONT = '600 18px ui-monospace, SFMono-Regular, Menlo, monospace';

// The floating nameplate: the player's name, plus — when they have an equipped
// title — a smaller, fainter flair line UNDER the name. The canvas grows taller
// when a title is present; the sprite's Y scale tracks the canvas aspect so the
// on-screen text size stays constant (the plate just gets taller).
function makeNameSprite(name: string, color: string, title = ''): THREE.Sprite {
  const hasTitle = title.length > 0;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = hasTitle ? 96 : 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Size the box to the wider of the two lines.
    ctx.font = NAME_FONT;
    const nameW = ctx.measureText(name).width;
    const flair = hasTitle ? title.toUpperCase() : '';
    let titleW = 0;
    if (hasTitle) {
      ctx.font = TITLE_FONT;
      titleW = ctx.measureText(flair).width;
    }
    const padding = 16;
    const boxW = Math.min(canvas.width - 4, Math.max(nameW, titleW) + padding * 2);
    const boxH = hasTitle ? 72 : 40;
    const r = 8;
    const x = (canvas.width - boxW) / 2;
    const y = (canvas.height - boxH) / 2;
    ctx.fillStyle = 'rgba(8,10,14,0.7)';
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
    ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
    ctx.arcTo(x, y + boxH, x, y, r);
    ctx.arcTo(x, y, x + boxW, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `${color}59`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Name (primary line).
    ctx.font = NAME_FONT;
    ctx.fillStyle = color;
    ctx.fillText(name, canvas.width / 2, hasTitle ? canvas.height / 2 - 11 : canvas.height / 2 + 1);
    // Title flair (secondary line) — smaller, fainter, tracked uppercase.
    if (hasTitle) {
      ctx.font = TITLE_FONT;
      ctx.fillStyle = 'rgba(214,224,255,0.66)';
      ctx.fillText(flair, canvas.width / 2, canvas.height / 2 + 17);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  // Base plate is 2.0 × 0.5 for a 256×64 canvas; scale Y by the aspect so a
  // taller (title) canvas keeps the same world-units-per-pixel.
  sprite.scale.set(2.0, 0.5 * (canvas.height / 64), 1);
  return sprite;
}

// Window after a kill during which this avatar is "dead": the body bursts into
// gibs in place (see character/gibs.ts), hides once they've shrunk away, and
// un-hides at the server's new spawn when the window ends.
const DEAD_HIDE_DURATION_SEC = 1.4;

const DEFAULT_NAME_COLOR = '#c7e0ff';

export class RemotePlayer {
  // Reused animator input (no per-frame allocation) — see animInput().
  private readonly animIn: CharacterAnimInput = { dt: 0, yaw: 0, pitch: 0, pos: new THREE.Vector3() };
  private animInput(dt: number, yaw: number, pitch: number): CharacterAnimInput {
    const ai = this.animIn;
    ai.dt = dt;
    ai.yaw = yaw;
    ai.pitch = pitch;
    ai.pos = this.group.position;
    return ai;
  }
  id: string;
  name: string;
  team: number | null = null; // TDM team index; null otherwise (set by Game)
  group: THREE.Group;
  // Nameplate color is resolved from two sources: a TDM team override (set by
  // Game, takes precedence so teams stay readable) and the player's equipped
  // name-color cosmetic (from the snapshot). `appliedNameColor` is what's drawn.
  private appliedNameColor = DEFAULT_NAME_COLOR;
  private teamColor: string | null = null;
  private cosmeticColor = DEFAULT_NAME_COLOR;
  // When > 0, the player is visually "dead" until it ticks down: the body plays
  // its death in place, then hides. Set by Game on a server `kill` broadcast.
  deadTimer = 0;
  // group.visible is the AND of these two independent reasons to hide the avatar:
  // dead-and-collapsed (killcam window) and first-person-spectated (the local
  // viewer is riding this player's eyes). Kept separate so neither clobbers the other.
  private deadHidden = false;
  private firstPersonHidden = false;
  private plateHidden = false; // nameplate off while the corpse is on screen
  private modelRoot: THREE.Object3D | null = null;
  private character: Character | null = null;
  // Look inputs: TDM team colour > the viewer's enemy highlight > own skin.
  private highlight: THREE.Color | null = null;
  private weaponGroup: AttachedRailgun | null = null; // the attached 3rd-person railgun (recoloured on finish change)
  private railgunFinishId = DEFAULT_RAILGUN_FINISH;
  private hat: WornHat | null = null;
  private hatId = 'hat.none';
  private unusualId = 'unusual.none';
  private nameColorId = 'name.default';
  private spawnEffectId = 'spawn.beam';
  private titleId = 'title.none';
  private titleText = ''; // resolved flair text drawn under the name ('' = none)
  // Shared third-person animator (gait, aim, jump/land, gibs). Null on the
  // capsule fallback, which has nothing to animate.
  private anim: CharacterAnimator | null = null;
  private nameSprite: THREE.Sprite;
  private fallbackBody: THREE.Mesh | null = null;
  private shieldMesh: THREE.Mesh;
  private shieldMaterial: THREE.MeshBasicMaterial;
  private facing = 0;
  private pitch = 0; // view pitch (radians, + up) — drives the spine aim layer

  constructor(id: string, name: string, scene: THREE.Scene, model: BotModel | null) {
    this.id = id;
    this.name = name;
    this.group = new THREE.Group();
    if (model) this.installModel(model);
    else this.installFallback();
    this.nameSprite = makeNameSprite(name, this.appliedNameColor);
    this.nameSprite.position.y = BOT_HEIGHT + 0.35;
    this.group.add(this.nameSprite);

    // Spawn-protection shield bubble — visible only during invuln window.
    // depthTest:true so walls hide it correctly; depthWrite:false so it
    // doesn't occlude things behind it through its own translucency.
    this.shieldMaterial = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.18,
      depthTest: true,
      depthWrite: false,
    });
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 18, 14),
      this.shieldMaterial,
    );
    this.shieldMesh.position.y = BOT_HEIGHT * 0.55;
    this.shieldMesh.visible = false;
    this.group.add(this.shieldMesh);

    scene.add(this.group);
  }

  setInvuln(remainingMs: number) {
    // The server grants respawn invuln at the moment of death; keep the bubble
    // off the corpse and let it show once the player is back at their spawn.
    const active = remainingMs > 0 && this.deadTimer <= 0;
    this.shieldMesh.visible = active;
    if (active) {
      // Slight pulse so it reads as "active". Range ~0.14-0.26 opacity.
      const phase = (performance.now() / 220) % (Math.PI * 2);
      this.shieldMaterial.opacity = 0.2 + 0.06 * Math.sin(phase);
    }
  }

  // `style` = the killer's finisher (how this body breaks apart).
  markDead(style?: KillEffectStyle) {
    this.deadTimer = DEAD_HIDE_DURATION_SEC;
    this.shieldMesh.visible = false;
    const p = this.group.position;
    if (this.anim?.die(probeGibFloor(p.x, p.y, p.z) ?? undefined, style)) {
      // Instagib: the body bursts into gibs where it stood (the killer's kill
      // effect plays on top from Game); it hides once the chunks are gone.
      this.deadHidden = false;
      this.setPlateHidden(true);
    } else {
      // Capsule fallback: vanish at once.
      this.deadHidden = true;
    }
    this.applyVisibility();
  }

  private setPlateHidden(hidden: boolean) {
    this.plateHidden = hidden;
    this.nameSprite.visible = !hidden;
  }

  // Hide this avatar because the local viewer is spectating it in first person
  // (riding its eyes) — independent of the death-hide. Idempotent.
  setFirstPersonHidden(hidden: boolean) {
    if (hidden === this.firstPersonHidden) return;
    this.firstPersonHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility() {
    this.group.visible = !this.deadHidden && !this.firstPersonHidden;
  }

  // Bright-enemy highlight / TDM team colour (from Game). null = natural skin.
  setHighlight(color: THREE.Color | null) {
    if (color) (this.highlight ??= new THREE.Color()).copy(color);
    else this.highlight = null;
    if (this.fallbackBody) applyHighlight(this.fallbackBody.material, color);
    this.resolveLook();
  }

  // Armour colour: a TDM team colour reads as identification (natural look);
  // otherwise the viewer's enemy-highlight colour goes full-bright; otherwise
  // the player's own stable bright skin.
  private resolveLook() {
    const ch = this.character;
    if (!ch) return;
    if (this.teamColor) ch.setLook(this.teamColor, 'natural');
    else if (this.highlight) ch.setLook(this.highlight, 'highlight');
    else ch.setLook(skinColorFor(this.name), 'natural');
  }

  // Footfall events for synced footstep audio: a monotonically increasing
  // count, and/or a callback fired as each foot plants (side 0 = left).
  get footfalls(): number {
    return this.anim?.footfalls ?? 0;
  }
  set onFootfall(fn: FootfallListener | null) {
    if (this.anim) this.anim.onFootfall = fn;
  }

  // Returns true on the single frame this player un-hides (respawns), so the
  // Game can play their spawn-in effect at the new position.
  apply(snapshot: RemotePlayerSnapshot, dt: number): boolean {
    let justRespawned = false;
    if (this.deadTimer > 0) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        // Snap to the latest network position (which is already the new
        // spawn the server picked), reset the pose and un-hide.
        this.group.position.set(snapshot.pos.x, snapshot.pos.y, snapshot.pos.z);
        this.anim?.respawn(this.group.position);
        this.deadHidden = false;
        this.setPlateHidden(false);
        this.applyVisibility();
        justRespawned = true;
      } else {
        // Corpse phase: the body plays its death where it fell (the server has
        // already moved this player to their spawn, so the snapshot position is
        // deliberately ignored), then hides for the rest of the window (#26h).
        if (!this.deadHidden) this.driveCorpse(dt);
        return false;
      }
    }

    // NetClient.interpolate() already produced a smooth, render-rate, render-
    // delayed pose (and dead-reckons short gaps), so render it DIRECTLY. A second
    // smoothing lerp here only added lag and made motion read as stepped at the
    // snapshot rate instead of tracking the viewer's framerate. The server clock
    // is slewed (see net.ts) so renderT advances smoothly frame to frame. The
    // animator measures ground speed / jumps from this position each frame.
    this.group.position.set(snapshot.pos.x, snapshot.pos.y, snapshot.pos.z);

    this.facing = snapshot.yaw; // already angle-interpolated in NetClient.interpolate()
    this.pitch = snapshot.pitch;

    // Equipped hat + unusual (echoed from the server). Swap on change, re-seat.
    if (snapshot.hat !== this.hatId) {
      this.hatId = snapshot.hat;
      void this.hat?.setHat(this.hatId);
    }
    if (snapshot.unusual !== this.unusualId) {
      this.unusualId = snapshot.unusual;
      this.hat?.setUnusual(this.unusualId);
    }
    // Equipped railgun finish (gun skin, echoed from the server) — rebuild the
    // 3rd-person gun on change so other players + spectators see the right skin.
    if (snapshot.railgunFinish !== this.railgunFinishId) {
      this.railgunFinishId = snapshot.railgunFinish;
      this.rebuildWeapon();
    }
    // Equipped name color (echoed from the server) — resolve under any team
    // override. No-ops when unchanged so the sprite isn't rebuilt per frame.
    if (snapshot.nameColor !== this.nameColorId) {
      this.nameColorId = snapshot.nameColor;
      this.cosmeticColor = nameColorById(this.nameColorId).color;
      this.resolveNameColor();
    }
    // Equipped title flair — prefer the server-resolved text (a dynamic ranked
    // title keeps the same id while its "#N"/tier text changes), falling back to
    // the manifest text. Rebuild the plate only when the displayed text changes.
    const nextTitleText = snapshot.titleText ?? titleById(snapshot.title).text;
    if (snapshot.title !== this.titleId || nextTitleText !== this.titleText) {
      this.titleId = snapshot.title;
      this.titleText = nextTitleText;
      this.rebuildNameSprite();
    }
    this.spawnEffectId = snapshot.spawnEffect; // remembered for the spawn-in burst

    this.drive(dt);
    return justRespawned;
  }

  // Exact-pose playback for the Play-of-the-Match replay: place the actor at a
  // recorded pose directly (no network lerp) and drive its animation from the
  // measured frame-to-frame movement. Cosmetics are seeded once at replay start
  // (via a single apply()), so we don't touch them here. dt is the replay frame.
  // (Recorded poses carry visibility, not kill events, so a replayed death is a
  // hide, not a collapse.)
  snap(pose: { x: number; y: number; z: number; yaw: number; pitch?: number; visible: boolean }, dt: number) {
    this.deadTimer = 0;
    const wasHidden = this.deadHidden;
    const anim = this.anim;
    if (!pose.visible) {
      // Visible → hidden while playing forward is a death: gib in place (the
      // group stays where they died), then hide once the chunks are gone.
      if (!wasHidden && anim && !anim.isDying() && dt > 0 && dt < 0.25) {
        anim.die();
        this.setPlateHidden(true);
      }
      if (anim?.isDying() && !anim.deathDone()) {
        anim.update(this.animInput(dt, this.facing, this.pitch));
        return;
      }
      this.deadHidden = true;
      this.applyVisibility();
      this.group.position.set(pose.x, pose.y, pose.z);
      // Keep the motion history current so reappearing doesn't read as a move.
      anim?.resetMotion(this.group.position);
      return;
    }
    this.group.position.set(pose.x, pose.y, pose.z);
    if (wasHidden || anim?.isDying()) {
      anim?.respawn(this.group.position); // reappear standing, no stale pose
      this.setPlateHidden(false);
    }
    this.deadHidden = false;
    this.applyVisibility();
    this.facing = pose.yaw;
    this.pitch = pose.pitch ?? 0;
    this.drive(dt);
  }

  // Per-frame animation update shared by live (apply) and replay (snap): the
  // animator measures ground speed / jumps from the group position, blends the
  // gait, aims the spine by `pitch`, orients the model to `facing`, and then
  // the hat is re-seated on the (possibly rotated) head bone. The caller must
  // have already positioned the group + set `facing`/`pitch`.
  private drive(dt: number) {
    this.anim?.update(this.animInput(dt, this.facing + MODEL_YAW_OFFSET, this.pitch));
    this.hat?.update(dt);
  }

  // Dead but still on screen: the gibs fly where the body burst; hide once
  // they've shrunk away.
  private driveCorpse(dt: number) {
    if (this.anim) {
      this.drive(dt);
      if (!this.anim.deathDone()) return;
    }
    this.deadHidden = true;
    this.applyVisibility();
  }

  // The equipped spawn-effect cosmetic id (for the Game to resolve + play).
  get equippedSpawnEffect(): string {
    return this.spawnEffectId;
  }

  bounds(): AABB {
    return {
      min: {
        x: this.group.position.x - BOT_RADIUS,
        y: this.group.position.y,
        z: this.group.position.z - BOT_RADIUS,
      },
      max: {
        x: this.group.position.x + BOT_RADIUS,
        y: this.group.position.y + BOT_HEIGHT,
        z: this.group.position.z + BOT_RADIUS,
      },
    };
  }

  centerY(): number {
    return this.group.position.y + BOT_HEIGHT * 0.5;
  }

  headshotY(): number {
    return this.group.position.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD;
  }

  // True once the combatant is installed (vs the fallback capsule). The Game
  // upgrades a fallback → model when the model token arrives after the socket
  // already connected (so a late model load never leaves "pills").
  hasModel(): boolean {
    return this.modelRoot !== null;
  }

  setName(name: string) {
    this.name = name;
    this.rebuildNameSprite();
    this.resolveLook(); // the natural skin is keyed by name
  }

  // TDM team override (set by Game): a hex that takes precedence over the
  // cosmetic name color, or null to fall back to the cosmetic/default.
  setTeamColor(hex: string | null) {
    if (hex === this.teamColor) return;
    this.teamColor = hex;
    this.resolveNameColor();
    this.resolveLook();
  }

  // Pick the effective nameplate color (team override > cosmetic > default) and
  // rebuild the sprite only when it actually changes.
  private resolveNameColor() {
    const next = this.teamColor ?? this.cosmeticColor;
    if (next === this.appliedNameColor) return;
    this.appliedNameColor = next;
    this.rebuildNameSprite();
  }

  // Regenerate the nameplate sprite from the current name + color + title flair.
  // The single rebuild path for every input that changes the plate (name, name
  // color, team override, title). A taller plate (title present) is nudged up so
  // the name keeps its screen position and the flair sits beneath it.
  private rebuildNameSprite() {
    const smMat = this.nameSprite.material as THREE.SpriteMaterial;
    smMat.map?.dispose();
    smMat.dispose();
    this.group.remove(this.nameSprite);
    this.nameSprite = makeNameSprite(this.name, this.appliedNameColor, this.titleText);
    this.nameSprite.position.y = BOT_HEIGHT + 0.35 + (this.titleText ? 0.13 : 0);
    this.nameSprite.visible = !this.plateHidden;
    this.group.add(this.nameSprite);
  }

  dispose(scene: THREE.Scene) {
    this.hat?.dispose();
    this.disposeWeaponGroup();
    this.character?.dispose();
    scene.remove(this.group);
    if (this.fallbackBody) {
      this.fallbackBody.geometry.dispose();
      (this.fallbackBody.material as THREE.Material).dispose();
    }
    this.shieldMesh.geometry.dispose();
    this.shieldMaterial.dispose();
    const smMat = this.nameSprite.material as THREE.SpriteMaterial;
    smMat.map?.dispose();
    smMat.dispose();
    this.anim?.dispose();
  }

  private installModel(_model: BotModel) {
    // The code-built combatant (see character/): one skinned mesh, a clean
    // rig, sockets for the hat (helmet crown) and the railgun (right hand).
    const ch = new Character({ colorHex: skinColorFor(this.name) });
    this.group.add(ch.root);
    this.character = ch;
    this.modelRoot = ch.root;
    this.hat = new WornHat(ch.sockets.headTop);
    void this.hat.setHat(this.hatId);
    this.weaponGroup = attachRailgun(ch, railgunFinishById(this.railgunFinishId).data);
    // Gait, aim, gun hold, jumps/landings and gibs all live in the animator —
    // the same implementation bots use.
    this.anim = new CharacterAnimator(ch, { driveYaw: true, holdGun: true });
    this.resolveLook();
  }

  // Swap the 3rd-person railgun for one with the current finish.
  private rebuildWeapon() {
    if (!this.character) return; // fallback capsule has no gun
    const finishId = isRailgunFinish(this.railgunFinishId) ? this.railgunFinishId : DEFAULT_RAILGUN_FINISH;
    const finish = railgunFinishById(finishId).data;
    if (this.weaponGroup) this.weaponGroup.setFinish(finish); // shared geometry: recolour only
    else this.weaponGroup = attachRailgun(this.character, finish);
  }

  // Their shot: the 3rd-person gun flashes and its glow refills over the recharge.
  notifyFire() {
    this.weaponGroup?.notifyFire();
  }

  private disposeWeaponGroup() {
    disposeRailgun(this.weaponGroup);
    this.weaponGroup = null;
  }

  private installFallback() {
    const bodyGeom = new THREE.CapsuleGeometry(
      BOT_RADIUS,
      BOT_HEIGHT - BOT_RADIUS * 2 - 0.35,
      4,
      16,
    );
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x6699ff,
      emissive: 0x1a3470,
      emissiveIntensity: 0.4,
      roughness: 0.5,
    });
    this.fallbackBody = new THREE.Mesh(bodyGeom, bodyMat);
    this.fallbackBody.position.y = (BOT_HEIGHT - 0.35) / 2;
    this.fallbackBody.castShadow = true;
    this.group.add(this.fallbackBody);
  }
}
