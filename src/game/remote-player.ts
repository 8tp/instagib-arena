import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { applyHighlight, type BotModel } from './bots';
import { LocomotionBlender } from './locomotion';
import { attachRailgunToSoldier, WeaponHold } from './weapon-model';
import { WornHat } from './hats';
import {
  DEFAULT_RAILGUN_FINISH,
  isRailgunFinish,
  nameColorById,
  railgunFinishById,
  titleById,
} from './cosmetics';
import type { RemotePlayerSnapshot } from './net';
import { BOT_HEADSHOT_THRESHOLD, BOT_HEIGHT, BOT_RADIUS } from './constants';
import type { AABB } from './types';

const MODEL_SCALE = 1.0;
// Soldier.glb faces -Z at identity. A remote player at yaw=0 is looking down
// -Z too (forward = (-sin yaw, -cos yaw)), so the model already matches with
// NO offset — rotation.y = yaw faces the look direction exactly. (Bots use a
// +π offset, but only because they're fed atan2(dx,dz) of their MOVEMENT
// vector, a different angle convention — don't copy that offset here.)
const MODEL_YAW_OFFSET = 0;
// Replay playback: a frame-to-frame ground speed above this (u/s) is treated as
// a teleport (respawn / clip seek) and won't spike the run animation. Real
// players top out well under this.
const REPLAY_TELEPORT_SPEED = 60;

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

const DEAD_HIDE_DURATION_SEC = 1.4;

// Per-second smoothing rate for the locomotion blend's input speed. The speed
// is measured from the interpolated frame-to-frame displacement, which steps a
// little at the snapshot rate; smoothing keeps the idle/walk/run blend from
// flickering. Expressed as a RATE (not a per-frame factor) so it behaves the
// same at 60Hz and 144Hz — a fixed 0.15/frame lerp over-smoothed on high-refresh
// displays (more lag) and under-smoothed on slow ones. ~10/s ≈ the old
// 0.15/frame feel at 60fps.
const MOVESPEED_SMOOTH_HZ = 10;

const DEFAULT_NAME_COLOR = '#c7e0ff';

export class RemotePlayer {
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
  // When > 0, the model is hidden and visually "dead" until it ticks down.
  // Set by Game on receiving a server `kill` broadcast for this player.
  deadTimer = 0;
  // group.visible is the AND of these two independent reasons to hide the avatar:
  // dead (killcam window) and first-person-spectated (the local viewer is riding
  // this player's eyes). Kept separate so neither clobbers the other.
  private deadHidden = false;
  private firstPersonHidden = false;
  private modelRoot: THREE.Object3D | null = null;
  private weaponGroup: THREE.Group | null = null; // the attached 3rd-person railgun (rebuilt on finish change)
  private railgunFinishId = DEFAULT_RAILGUN_FINISH;
  private hat: WornHat | null = null;
  private hatId = 'hat.none';
  private unusualId = 'unusual.none';
  private nameColorId = 'name.default';
  private spawnEffectId = 'spawn.beam';
  private titleId = 'title.none';
  private titleText = ''; // resolved flair text drawn under the name ('' = none)
  private mixer: THREE.AnimationMixer | null = null;
  private loco: LocomotionBlender | null = null;
  private hold: WeaponHold | null = null;
  private nameSprite: THREE.Sprite;
  private fallbackBody: THREE.Mesh | null = null;
  private shieldMesh: THREE.Mesh;
  private shieldMaterial: THREE.MeshBasicMaterial;
  private facing = 0;
  private lastSeenPos = new THREE.Vector3();
  private lastMoveSpeed = 0;

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
    const active = remainingMs > 0;
    this.shieldMesh.visible = active;
    if (active) {
      // Slight pulse so it reads as "active". Range ~0.14-0.26 opacity.
      const phase = (performance.now() / 220) % (Math.PI * 2);
      this.shieldMaterial.opacity = 0.2 + 0.06 * Math.sin(phase);
    }
  }

  markDead() {
    this.deadTimer = DEAD_HIDE_DURATION_SEC;
    this.deadHidden = true;
    this.applyVisibility();
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

  // Bright-enemy highlight (emissive glow only). null = natural.
  setHighlight(color: THREE.Color | null) {
    this.group.traverse((obj) => {
      applyHighlight((obj as THREE.Mesh).material, color);
    });
  }

  // Returns true on the single frame this player un-hides (respawns), so the
  // Game can play their spawn-in effect at the new position.
  apply(snapshot: RemotePlayerSnapshot, dt: number): boolean {
    let justRespawned = false;
    if (this.deadTimer > 0) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        // Snap to the latest network position (which is already the new
        // spawn the server picked) and un-hide.
        this.group.position.set(snapshot.pos.x, snapshot.pos.y, snapshot.pos.z);
        this.lastSeenPos.copy(this.group.position);
        this.deadHidden = false;
        this.applyVisibility();
        justRespawned = true;
      } else {
        return false; // hidden/dead — skip the mixer + transform work entirely (#26h)
      }
    }

    // NetClient.interpolate() already produced a smooth, render-rate, render-
    // delayed pose (and dead-reckons short gaps), so render it DIRECTLY. A second
    // smoothing lerp here only added lag and made motion read as stepped at the
    // snapshot rate instead of tracking the viewer's framerate. The server clock
    // is slewed (see net.ts) so renderT advances smoothly frame to frame.
    this.group.position.set(snapshot.pos.x, snapshot.pos.y, snapshot.pos.z);

    // Ground speed from the per-frame displacement drives the idle/walk/run blend.
    const dx = this.group.position.x - this.lastSeenPos.x;
    const dz = this.group.position.z - this.lastSeenPos.z;
    const moveSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;

    this.facing = snapshot.yaw; // already angle-interpolated in NetClient.interpolate()

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
    // Equipped title flair (echoed from the server) — resolve to display text and
    // rebuild the plate only on change so it isn't regenerated every frame.
    if (snapshot.title !== this.titleId) {
      this.titleId = snapshot.title;
      this.titleText = titleById(this.titleId).text;
      this.rebuildNameSprite();
    }
    this.spawnEffectId = snapshot.spawnEffect; // remembered for the spawn-in burst

    this.drive(dt, moveSpeed);
    return justRespawned;
  }

  // Exact-pose playback for the Play-of-the-Match replay: place the actor at a
  // recorded pose directly (no network lerp) and drive its animation from the
  // measured frame-to-frame movement. Cosmetics are seeded once at replay start
  // (via a single apply()), so we don't touch them here. dt is the replay frame.
  snap(pose: { x: number; y: number; z: number; yaw: number; visible: boolean }, dt: number) {
    this.deadTimer = 0;
    this.deadHidden = !pose.visible;
    this.applyVisibility();
    if (!pose.visible) {
      // Keep lastSeenPos current so reappearing doesn't read as a teleport.
      this.lastSeenPos.set(pose.x, pose.y, pose.z);
      return;
    }
    this.group.position.set(pose.x, pose.y, pose.z);
    const dx = this.group.position.x - this.lastSeenPos.x;
    const dz = this.group.position.z - this.lastSeenPos.z;
    let moveSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    // A respawn / seek jump shouldn't spike the run animation for one frame.
    if (moveSpeed > REPLAY_TELEPORT_SPEED) moveSpeed = 0;
    this.facing = pose.yaw;
    this.drive(dt, moveSpeed);
  }

  // Per-frame animation update shared by live (apply) and replay (snap):
  // advance the mixer, pin the gun pose, blend locomotion from the measured
  // ground speed, orient the model to `facing`, and tick hat physics. The
  // caller must have already positioned the group + set `this.facing`.
  private drive(dt: number, moveSpeed: number) {
    const k = dt > 0 ? 1 - Math.exp(-MOVESPEED_SMOOTH_HZ * dt) : 1;
    this.lastMoveSpeed += (moveSpeed - this.lastMoveSpeed) * k;
    this.loco?.update(this.lastMoveSpeed, dt);
    if (this.mixer) this.mixer.update(dt);
    // Pin the gun-carry pose over the animated arms.
    this.hold?.apply();
    this.lastSeenPos.copy(this.group.position);
    if (this.modelRoot) {
      this.modelRoot.rotation.set(0, this.facing + MODEL_YAW_OFFSET, 0);
    }
    this.hat?.update(dt);
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

  // True once the real skinned model is installed (vs the fallback capsule).
  // The Game upgrades a fallback → model when the GLB finishes loading after the
  // socket already connected (so a slow/late model load doesn't leave "pills").
  hasModel(): boolean {
    return this.modelRoot !== null;
  }

  setName(name: string) {
    this.name = name;
    this.rebuildNameSprite();
  }

  // TDM team override (set by Game): a hex that takes precedence over the
  // cosmetic name color, or null to fall back to the cosmetic/default.
  setTeamColor(hex: string | null) {
    if (hex === this.teamColor) return;
    this.teamColor = hex;
    this.resolveNameColor();
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
    this.group.add(this.nameSprite);
  }

  dispose(scene: THREE.Scene) {
    this.hat?.dispose();
    this.disposeWeaponGroup();
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
    if (this.mixer) this.mixer.stopAllAction();
  }

  private installModel(model: BotModel) {
    const cloned = SkeletonUtils.clone(model.scene);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.setScalar(MODEL_SCALE);
    cloned.traverse((obj) => {
      obj.userData.shared = true;
    });
    this.group.add(cloned);
    this.modelRoot = cloned;
    this.hat = new WornHat(this.group, cloned);
    void this.hat.setHat(this.hatId);
    this.weaponGroup = attachRailgunToSoldier(
      cloned,
      BOT_HEIGHT,
      railgunFinishById(this.railgunFinishId).data,
    );
    this.hold = new WeaponHold(cloned);
    this.mixer = new THREE.AnimationMixer(cloned);
    // Soldier.glb clip order: 0 idle, 1 run, 3 walk (matches the three.js
    // skinning-blending example). Prefer names, fall back to those indices.
    const byName = new Map<string, THREE.AnimationClip>();
    for (const clip of model.animations) byName.set(clip.name.toLowerCase(), clip);
    const idleClip = byName.get('idle') ?? model.animations[0] ?? null;
    const runClip = byName.get('run') ?? byName.get('running') ?? model.animations[1] ?? null;
    const walkClip = byName.get('walk') ?? byName.get('walking') ?? model.animations[3] ?? null;
    this.loco = new LocomotionBlender({
      idle: idleClip ? this.mixer.clipAction(idleClip) : null,
      walk: walkClip ? this.mixer.clipAction(walkClip) : null,
      run: runClip ? this.mixer.clipAction(runClip) : null,
    });
  }

  // Swap the 3rd-person railgun for one with the current finish. Disposes the old
  // gun's procedural geometry/materials (not shared, unlike the cloned soldier).
  private rebuildWeapon() {
    if (!this.modelRoot) return; // fallback capsule has no gun
    this.disposeWeaponGroup();
    const finishId = isRailgunFinish(this.railgunFinishId) ? this.railgunFinishId : DEFAULT_RAILGUN_FINISH;
    this.weaponGroup = attachRailgunToSoldier(this.modelRoot, BOT_HEIGHT, railgunFinishById(finishId).data);
  }

  private disposeWeaponGroup() {
    if (!this.weaponGroup) return;
    this.weaponGroup.parent?.remove(this.weaponGroup);
    this.weaponGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh & THREE.Line;
      const geom = (mesh as unknown as { geometry?: THREE.BufferGeometry }).geometry;
      if (geom) geom.dispose();
      const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
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
    this.group.add(this.fallbackBody);
  }
}
