import * as THREE from 'three';
import { SoundManager, type SoundClipName } from './audio';
import {
  BotManager,
  loadBotModel,
  pickFreeSpot,
  type BotFireIntent,
  type BotModel,
  type BotTarget,
} from './bots';
import {
  BANNER_DURATION_SEC,
  BOT_HEADSHOT_THRESHOLD,
  BOT_HEIGHT,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_FOV,
  DEFAULT_ZOOM_FOV,
  MIN_ZOOM_FOV,
  MAX_ZOOM_FOV,
  VIEWMODEL_BASE,
  VIEWMODEL_SCALE,
  EYE_HEIGHT,
  HIT_MARKER_KILL_DURATION_SEC,
  MAX_FOV,
  MIN_FOV,
  KILL_CONFIRM_DURATION_SEC,
  KILLCAM_DURATION_SEC,
  KILLFEED_DURATION_SEC,
  LOCAL_RESPAWN_INVULN_SEC,
  LOCAL_WARMUP_SEC,
  MATCH_FRAG_LIMIT,
  MAX_KILLFEED_ENTRIES,
  MAX_PLAYERS,
  MAX_TOASTS,
  NUM_BOTS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  KILL_FLASH_DURATION_SEC,
  RAIL_RANGE,
  SHAKE_DEATH,
  SHAKE_FIRE,
  SHAKE_KILL,
  SHAKE_MAX,
  TICK_DT,
  TOAST_DURATION_SEC,
  TEAM_COLORS,
  TDM_FRIEND_COLOR,
  TDM_FRAG_LIMIT,
  DUEL_ROUND_FRAG_LIMIT,
  DUEL_ROUNDS_TO_WIN,
  type BotDifficulty,
  type GameMode,
  type KeybindAction,
} from './constants';
import { EffectsManager } from './effects';
import { TrainingRange, type TrainingStats } from './training';
import { InputManager } from './input';
import { buildMapMesh, DEFAULT_MAP, mapById, rayAabb, type ArenaMap } from './map';
import { BANNER_MEDALS, MEDAL_LABELS, MedalTracker } from './medals';
import {
  DEFAULT_KILL_EFFECT,
  DEFAULT_RAIL_COLOR,
  DEFAULT_HAT,
  DEFAULT_UNUSUAL,
  DEFAULT_EMOTE,
  DEFAULT_RAILGUN_FINISH,
  DEFAULT_NAME_COLOR,
  DEFAULT_SPAWN_EFFECT,
  isKillEffectStyle,
  isRailColor,
  isRailgunFinish,
  isHat,
  isUnusual,
  isEmote,
  isNameColor,
  isSpawnEffect,
  railColorById,
  railgunFinishById,
  spawnEffectById,
  SPAWN_EFFECTS,
  type KillEffectStyle,
} from './cosmetics';
import { NetClient, type KillEvent } from './net';
import { Player } from './player';
import { RemotePlayer } from './remote-player';
import {
  MatchRecorder,
  ReplayPlayer,
  type ReplayPose,
  type HighlightClip,
  type ReplayOptions,
} from './replay';

// End-of-match cinematic: how the final-blow slow-mo is paced before the PotG.
const FINALE_TIME_SCALE = 0.5; // play the final blow at half speed
const FINALE_FREEZE_SEC = 1.9; // then hold on the frozen frame: the VICTORY/DEFEAT beat

// One stage of the end-of-match cinematic (slow-mo finale, then Play of Match).
type ReplaySegment = { kind: 'finale' | 'potg'; clip: HighlightClip; opts: ReplayOptions };
import { createCamera, createRenderer, createScene } from './renderer';
import { buildRailgun } from './weapon-model';
import type {
  AABB,
  BannerState,
  CardPayload,
  DuelHud,
  HitMarker,
  HudState,
  KillConfirm,
  KillFlash,
  KillcamState,
  KillfeedEntry,
  MapVoteState,
  Medal,
  PlayerScore,
  PomState,
  ToastEntry,
} from './types';
import { Railgun, type RailTarget } from './weapon';

export type HudListener = (state: HudState) => void;

// Reported to the client when a match ends (frag limit) or the player leaves.
export type MatchResult = {
  won: boolean;
  kills: number;
  deaths: number;
  bestStreak: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
};
export type MatchEndListener = (result: MatchResult) => void;

// Multiplayer-only lifecycle signals the client surfaces outside the HUD
// (e.g. "couldn't join — lobby is gone/full" → bounce back to the menu). Map
// changes are shown in-game via a HUD banner, not through this channel.
export type NetMatchEvent = { type: 'join-failed'; reason: string };
export type NetMatchListener = (ev: NetMatchEvent) => void;

const PLAYER_NAME_DEFAULT = 'You';
const BOT_MODEL_URL = '/models/instagib/soldier.glb';
const POS_SEND_HZ = 32;

const MEDAL_VOICE: Partial<Record<Medal, SoundClipName>> = {
  'first-blood':   'first-blood',
  'double-kill':   'double-kill',
  'multi-kill':    'triple-kill',
  'ultra-kill':    'quad-kill',
  'monster-kill':  'penta-kill',
  'killing-spree': 'killing-spree',
  'rampage':       'rampage',
  'dominating':    'dominating',
  'unstoppable':   'unstoppable',
  'godlike':       'godlike',
  'headshot':      'headshot',
  'mid-air':       'humiliation',
  'comeback':      'comeback',
};

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private map: ArenaMap = DEFAULT_MAP;
  private mapMesh: THREE.Group;
  private player: Player;
  private weapon = new Railgun();
  private input: InputManager;
  private bots: BotManager | null = null;
  private botModel: BotModel | null = null;
  private medals = new MedalTracker();
  private effects = new EffectsManager();
  private audio = new SoundManager();
  private locked = false;
  private accumulator = 0;
  private lastTime = 0;
  private rafHandle: number | null = null;
  private contextLost = false; // true while the WebGL context is lost (skip render)
  // Frame scheduler: 0 = VSync (rAF, default), >0 = cap to that fps (setTimeout),
  // <0 = uncapped (MessageChannel tight loop — renders past vsync for the lowest
  // input latency, at high CPU cost). See scheduleFrame().
  private fpsLimit = 0;
  private frameTimeout: ReturnType<typeof setTimeout> | null = null;
  private fpsChannel: MessageChannel | null = null;
  private tickFn: ((now: number) => void) | null = null;
  private disposed = false;
  private resizeHandler: () => void;
  private elapsed = 0;

  private playerName = PLAYER_NAME_DEFAULT;
  private playerFrags = 0;
  private playerDeaths = 0;
  private playerHeadshots = 0;
  private playerShotsFired = 0;
  private playerShotsHit = 0;
  private botDeathCounts = new Map<string, number>();
  private botFrags = new Map<string, number>();
  // Per-bot shot tallies so the scoreboard can show bot accuracy too.
  private botShotsFired = new Map<string, number>();
  private botShotsHit = new Map<string, number>();

  // Match config + state
  private botCount = NUM_BOTS;
  private botDifficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  private matchOver = false;
  private matchWon = false;
  // Match "drama" cues, evaluated from the scoreboard in emitHud. One-shot per
  // match (offline: a fresh Game per match; online: reset on vote/round).
  private worstDeficit = 0; // largest frag gap you've trailed the leader by
  private comebackAwarded = false; // Comeback medal fires at most once per match
  private matchPointAnnounced = false; // "Match point" banner fires once per match
  private training = false; // endless practice — never hit the frag limit
  private trainingRange: TrainingRange | null = null; // target-practice range (training mode)
  private localRespawnInvuln = 0; // seconds of post-respawn grace vs bots
  private localWarmupUntil = 0; // perf.now() ms; offline pre-match no-fire window
  private shake = 0; // camera screen-shake amount, decays each render frame

  // Visual customization
  private worldColor = new THREE.Color(0xffffff);
  private worldBrightness = 0;
  private enemyColor: THREE.Color | null = null; // null = natural enemies

  // Multiplayer
  private net: NetClient | null = null;
  private remotePlayers = new Map<string, RemotePlayer>();
  private wantBots = true;
  private wantMultiplayer = false;
  private multiplayerUrl = '';
  private multiplayerRoomId = '';
  private posSendAccumMs = 0;
  // End-of-match map vote (server-driven). Non-null → vote overlay + pointer
  // released; the local player idles until the result resumes play.
  private vote: MapVoteState | null = null;
  private onNetEvent: NetMatchListener = () => {};
  // Multiplayer match result latch: in MP the server (not checkMatchEnd) ends a
  // match — the vote opening IS the end. wonLastMatch is latched from the
  // vote-start winnerId; matchSubmitted guards a single stats POST per match.
  private wonLastMatch = false;
  private matchSubmitted = false;
  // Active online game mode + this client's team (TDM). Offline is always FFA.
  private netMode: GameMode = 'ffa';
  private localTeam: number | null = null;
  // Duel round tracking (mirrors the server; drives the round HUD).
  private duel: DuelHud | null = null;

  private killfeed: KillfeedEntry[] = [];
  private toasts: ToastEntry[] = [];
  private banner: BannerState | null = null;
  private hitMarker: HitMarker | null = null;
  private killConfirm: KillConfirm | null = null;
  private killFlash: KillFlash | null = null;
  private damageFlash = 0; // 0..1, set on death, decays — red "you were hit" vignette
  private killcam: KillcamState | null = null;
  private killcamLookAt = new THREE.Vector3();

  // Play of the Match: record the live match, then on match-end pick the best
  // moment and replay it cinematically before the results screen. All captured
  // client-side, so it works offline-vs-bots and online (no server changes).
  private recorder = new MatchRecorder();
  private replay: ReplayPlayer | null = null;
  private replaySegments: ReplaySegment[] = [];
  private replaySegIdx = 0;
  private pom: PomState | null = null;
  private pomOnDone: (() => void) | null = null;
  private endWon = false; // win/loss latched for the end-of-match cinematic
  private verdictSpoken = false; // guards the one-shot VICTORY/DEFEAT callout
  private nextEventId = 1;
  private fireWasAirborne = false;
  private weaponWasReady = true; // tracks cooldown-to-ready transition

  private fps = 60;
  private fpsFrames = 0;
  private fpsAccumMs = 0;
  private hudAccumMs = 0; // throttles HUD delivery in runLoop (#24)
  private frameDt = 1 / 60; // last real frame delta (s) — for framerate-independent juice

  private tmpForward = new THREE.Vector3();
  private tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private tmpRight = new THREE.Vector3();
  private tmpUp = new THREE.Vector3();
  private tmpBeamOrigin = new THREE.Vector3();

  // Railgun viewmodel (first-person), parented to the camera. Quake-centered low
  // so it never blocks the crosshair; user offset + hide applied on top.
  private viewmodel: THREE.Group | null = null;
  private viewmodelGlow: THREE.MeshStandardMaterial | null = null;
  private viewmodelOffset = { x: 0, y: 0, z: 0 };
  private hideViewmodel = false;
  private killEffectStyle: KillEffectStyle = DEFAULT_KILL_EFFECT;
  private localRailgunFinish: string = DEFAULT_RAILGUN_FINISH; // viewmodel skin (local)
  private localNameColor: string = DEFAULT_NAME_COLOR; // nameplate tint (broadcast)
  private localSpawnEffect: string = DEFAULT_SPAWN_EFFECT; // spawn-in burst (broadcast)
  private botAlive = new Map<string, boolean>(); // prev alive-state per bot (spawn fx edge)
  private localHat: string = DEFAULT_HAT; // equipped hat (broadcast to remotes)
  private localUnusual: string = DEFAULT_UNUSUAL; // equipped unusual effect
  private localEmote: string = DEFAULT_EMOTE; // equipped podium emote (broadcast to remotes)
  private localCard: CardPayload | null = null; // your playercard (kill banner)
  private reducedEffects = false; // accessibility: gate shake/flash/heavy bursts
  // Weapon feedback: recoil kicks the viewmodel back+up; viewKick punches the
  // view up. Both are transient and decay to 0 each frame (aim is unaffected —
  // viewKick is purely visual, layered on top of the real pitch).
  private recoil = 0;
  private viewKick = 0;

  // FOV / zoom. baseFov is the settings FOV; camera.fov lerps toward zoomFov
  // while the zoom bind is held.
  private baseFov = DEFAULT_FOV;
  private zoomFov = DEFAULT_ZOOM_FOV;
  private zoomSensMul = 1; // ADS sensitivity multiplier (blends in while zoomed)
  private wantZoom = false;
  // Graphics quality
  private resolutionScale = 1;
  private lowSpec = false;

  private onMatchEnd: MatchEndListener;

  constructor(
    private canvas: HTMLCanvasElement,
    private onHud: HudListener,
    onMatchEnd?: MatchEndListener,
  ) {
    this.onMatchEnd = onMatchEnd ?? (() => {});
    this.renderer = createRenderer(canvas);
    this.scene = createScene(this.renderer);
    this.camera = createCamera(canvas);
    // Parent the viewmodel to the camera so it tracks the view. The camera is
    // added to the scene so its child (the gun) is part of the render.
    this.scene.add(this.camera);
    this.buildViewmodel();

    // WebGL context loss (GPU reset, driver hiccup, backgrounded low-VRAM tab):
    // preventDefault keeps the context recoverable; we pause GL rendering and
    // tell the player, then resume automatically when it's restored.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.banner = {
        id: this.nextEventId++,
        tier: 'special',
        title: 'Graphics paused',
        subtitle: 'GPU context lost — restoring…',
        remaining: 999,
        total: 999,
      };
      this.emitHud();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.banner = null;
      this.emitHud();
    });
    this.mapMesh = buildMapMesh(this.map);
    this.scene.add(this.mapMesh);
    this.player = new Player(this.map.spawn);

    this.input = new InputManager(
      canvas,
      (locked) => {
        this.locked = locked;
        this.emitHud();
        if (locked) this.audio.resume();
      },
      () => {
        // Pointer lock was refused (no gesture / unsupported / touch). Surface a
        // hint instead of a silently dimmed screen (#14).
        this.banner = {
          id: this.nextEventId++,
          tier: 'special',
          title: 'Click the arena to play',
          subtitle: 'mouse capture needed',
          remaining: BANNER_DURATION_SEC,
          total: BANNER_DURATION_SEC,
        };
        this.emitHud();
      },
    );
    void this.audio.init();

    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
    this.handleResize();
    this.emitHud();
  }

  requestLock() {
    // Refuse to re-capture the cursor once the match is over / a cinematic or
    // vote is up — otherwise a stray click on the canvas during the Play of the
    // Match re-locks the pointer and the results screen opens with no cursor.
    if (this.matchOver || this.vote || this.replay || this.replaySegments.length) return;
    this.input.requestLock();
    this.audio.resume();
  }

  setSensitivity(s: number) {
    this.input.setSensitivity(s);
  }

  setVertScale(v: number) {
    this.input.setVertScale(v);
  }

  setRawInput(on: boolean) {
    this.input.setRawInput(on);
  }

  setKeybinds(binds: Record<KeybindAction, string>) {
    this.input.setBindings(binds);
  }

  setFov(fov: number) {
    // Clamp + finite-guard so a corrupt/hand-edited persisted FOV can't write an
    // invalid projection matrix (black/garbled viewport with no recovery). (#25)
    const f = Number.isFinite(fov) ? fov : DEFAULT_FOV;
    this.baseFov = Math.max(MIN_FOV, Math.min(MAX_FOV, f));
    // Apply immediately unless mid-zoom (the per-frame lerp owns it then).
    if (!this.wantZoom) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  setZoomFov(fov: number) {
    const f = Number.isFinite(fov) ? fov : DEFAULT_ZOOM_FOV;
    this.zoomFov = Math.max(MIN_ZOOM_FOV, Math.min(MAX_ZOOM_FOV, f));
  }

  // Independent zoom/ADS sensitivity multiplier (1 = same feel as the FOV-scaled
  // default; <1 = slower while zoomed for precise long-range flicks).
  setZoomSens(mul: number) {
    this.zoomSensMul = Number.isFinite(mul) ? Math.max(0.1, Math.min(3, mul)) : 1;
  }

  // Render quality. resolutionScale scales the render resolution (perf ↔ sharp);
  // lowSpec caps high-DPI rendering at 1× and thins out particle effects.
  setQuality(resolutionScale: number, lowSpec: boolean) {
    this.resolutionScale = Number.isFinite(resolutionScale)
      ? Math.max(0.4, Math.min(2, resolutionScale))
      : 1;
    this.lowSpec = !!lowSpec;
    this.applyPixelRatio();
    this.effects.setQuality(lowSpec ? 0.5 : 1);
  }

  private applyPixelRatio() {
    if (typeof window === 'undefined') return;
    const dpr = window.devicePixelRatio || 1;
    const cap = this.lowSpec ? 1 : 2; // low-spec ignores high-DPI displays
    const pr = Math.min(Math.min(dpr, cap) * this.resolutionScale, this.lowSpec ? 1.5 : 3);
    this.renderer.setPixelRatio(pr);
  }

  setViewmodel(offset: { x: number; y: number; z: number }, hide: boolean) {
    this.viewmodelOffset = { x: offset.x, y: offset.y, z: offset.z };
    this.hideViewmodel = hide;
    this.applyViewmodelTransform();
  }

  private applyViewmodelTransform() {
    if (!this.viewmodel) return;
    this.viewmodel.position.set(
      VIEWMODEL_BASE.x + this.viewmodelOffset.x,
      VIEWMODEL_BASE.y + this.viewmodelOffset.y,
      VIEWMODEL_BASE.z + this.viewmodelOffset.z,
    );
  }

  setMasterVolume(v: number) {
    this.audio.setVolume(v);
  }

  setSfxVolume(v: number) {
    this.audio.setSfxVolume(v);
  }

  setAnnouncerVolume(v: number) {
    this.audio.setAnnouncerVolume(v);
  }

  setAnnouncerEnabled(on: boolean) {
    this.audio.setAnnouncerEnabled(on);
  }

  setPlayerName(name: string) {
    const trimmed = name?.trim() ?? '';
    this.playerName = trimmed || PLAYER_NAME_DEFAULT;
  }

  setTraining(on: boolean) {
    this.training = on;
  }

  setBotsEnabled(enabled: boolean) {
    this.wantBots = enabled;
    this.applyBotsState();
  }

  setBotCount(n: number) {
    const next = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(n)));
    if (next === this.botCount) return;
    this.botCount = next;
    this.rebuildBots();
  }

  setBotDifficulty(difficulty: BotDifficulty) {
    if (difficulty === this.botDifficulty) return;
    this.botDifficulty = difficulty;
    this.rebuildBots();
  }

  private rebuildBots() {
    if (!this.bots) return; // not spawned yet — applyBotsState() will use the new values
    this.bots.dispose(this.scene);
    this.bots = null;
    this.botDeathCounts.clear();
    this.botFrags.clear();
    this.botShotsFired.clear();
    this.botShotsHit.clear();
    this.applyBotsState();
  }

  // Tint + full-bright the arena surfaces (Ratz-style world color).
  setWorldStyle(colorHex: string, brightness: number) {
    this.worldColor.set(colorHex);
    this.worldBrightness = brightness;
    this.applyWorldStyle();
  }

  private applyWorldStyle() {
    const tint = this.worldColor;
    const intensity = this.worldBrightness * 1.6;
    this.mapMesh.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material;
      const apply = (m: THREE.Material) => {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial || !sm.emissiveMap) return; // textured surfaces only
        sm.color.copy(tint);
        sm.emissive.copy(tint);
        sm.emissiveIntensity = intensity;
      };
      if (Array.isArray(mat)) mat.forEach(apply);
      else if (mat) apply(mat);
    });
  }

  // Make enemies glow a bright colour for visibility (null = natural).
  setEnemyStyle(colorHex: string | null) {
    this.enemyColor = colorHex ? new THREE.Color(colorHex) : null;
    this.applyEnemyStyle();
  }

  // Equipped kill-effect cosmetic (the explosion that plays at YOUR frags).
  // Cosmetic-only; unknown IDs fall back to the default so a stale/forged value
  // can never break rendering.
  setKillEffect(id: string) {
    this.killEffectStyle = isKillEffectStyle(id) ? id : DEFAULT_KILL_EFFECT;
  }

  // Equipped rail-beam color cosmetic — recolors only the local player's beam.
  setRailColor(id: string) {
    const c = railColorById(isRailColor(id) ? id : DEFAULT_RAIL_COLOR);
    this.weapon.setBeamColors(c.data.core, c.data.helix);
  }

  // (Re)build the first-person railgun viewmodel with the equipped finish. Called
  // from the constructor and whenever the finish changes (Locker equip).
  private buildViewmodel() {
    if (this.viewmodel) {
      this.camera.remove(this.viewmodel);
      disposeGroup(this.viewmodel);
    }
    const finish = railgunFinishById(this.localRailgunFinish).data;
    const vm = buildRailgun(finish);
    this.viewmodel = vm.group;
    this.viewmodel.scale.setScalar(VIEWMODEL_SCALE);
    this.viewmodelGlow = vm.glow;
    this.applyViewmodelTransform();
    this.camera.add(this.viewmodel);
  }

  // Equipped railgun finish (gun skin) — recolors the local viewmodel only.
  setRailgunFinish(id: string) {
    const next = isRailgunFinish(id) ? id : DEFAULT_RAILGUN_FINISH;
    if (next === this.localRailgunFinish) return;
    this.localRailgunFinish = next;
    this.buildViewmodel();
  }

  // Equipped hat — worn on the local player's model (seen by others online + in
  // the killcam). Stored here; the net layer broadcasts it so remotes render it.
  setHat(id: string) {
    this.localHat = isHat(id) ? id : DEFAULT_HAT;
    this.net?.setLocalHat(this.localHat);
  }

  // Equipped unusual particle effect — broadcast so remotes render it on your hat.
  setUnusual(id: string) {
    this.localUnusual = isUnusual(id) ? id : DEFAULT_UNUSUAL;
    this.net?.setLocalUnusual(this.localUnusual);
  }

  // Equipped podium emote — broadcast so remotes show it on the results podium.
  setEmote(id: string) {
    this.localEmote = isEmote(id) ? id : DEFAULT_EMOTE;
    this.net?.setLocalEmote(this.localEmote);
  }

  // Equipped nameplate color — broadcast so other players see your tinted name.
  setNameColor(id: string) {
    this.localNameColor = isNameColor(id) ? id : DEFAULT_NAME_COLOR;
    this.net?.setLocalNameColor(this.localNameColor);
  }

  // Equipped spawn-in effect — broadcast so others see your materialize style,
  // and used locally for your own + bots' respawns.
  setSpawnEffect(id: string) {
    this.localSpawnEffect = isSpawnEffect(id) ? id : DEFAULT_SPAWN_EFFECT;
    this.net?.setLocalSpawnEffect(this.localSpawnEffect);
  }

  // Your playercard (built client-side from your profile + card settings).
  // Broadcast so the victim's killcam shows it when you frag them.
  setCardPayload(card: CardPayload) {
    this.localCard = card;
    this.net?.setLocalCard(card);
  }

  // Accessibility: when on, suppress camera shake + full-screen kill flash and
  // swap the 3D kill burst for a small spark (WCAG vestibular / flashing). The
  // hit marker, kill-confirm text, killfeed, and SFX still fire (informational).
  setReducedEffects(v: boolean) {
    this.reducedEffects = v;
  }

  private applyEnemyStyle() {
    if (this.bots) for (const b of this.bots.bots) b.setHighlight(this.enemyColor);
    // Remotes may be team-colored (TDM) — recolor through the team-aware path so
    // the enemy-color setting doesn't clobber team identification.
    this.recolorRemotes();
  }

  // Swap the arena in place (keeps the renderer/canvas — a second WebGL context
  // can't be created on the same canvas, so we rebuild scene contents instead).
  setMap(map: ArenaMap) {
    if (map === this.map) return;
    this.map = map;
    this.scene.remove(this.mapMesh);
    disposeGroup(this.mapMesh);
    this.mapMesh = buildMapMesh(map);
    this.scene.add(this.mapMesh);
    this.applyWorldStyle(); // re-tint the freshly-built materials
    // Reset the local player onto the new spawn.
    this.player.pos = { ...map.spawn };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.onGround = false;
    // Clear transient visuals tied to the old geometry.
    this.weapon.disposeAll(this.scene);
    this.effects.dispose(this.scene);
    this.killcam = null;
    // Rebuild bots for the new layout.
    if (this.bots) {
      this.bots.dispose(this.scene);
      this.bots = new BotManager(
        this.scene,
        this.map,
        this.botCount,
        this.map.spawn,
        this.botModel,
        this.botDifficulty,
      );
      this.botDeathCounts.clear();
      this.botFrags.clear();
      this.botShotsFired.clear();
      this.botShotsHit.clear();
      for (const b of this.bots.bots) {
        this.botDeathCounts.set(b.state.id, 0);
        this.botFrags.set(b.state.id, 0);
      }
      this.applyEnemyStyle();
    }
    this.emitHud();
  }

  setMultiplayer(opts: { enabled: boolean; url: string; roomId?: string }) {
    this.wantMultiplayer = opts.enabled;
    this.multiplayerUrl = opts.url;
    this.multiplayerRoomId = opts.roomId ?? '';
    this.applyMultiplayerState();
  }

  // Surface multiplayer lifecycle events (join failure, map change) to the
  // client orchestrator so it can navigate / toast.
  setNetEventListener(fn: NetMatchListener) {
    this.onNetEvent = fn;
  }

  async start() {
    if (this.disposed) return;
    this.lastTime = performance.now();
    this.runLoop();
    let model: BotModel | null = null;
    try {
      model = await loadBotModel(BOT_MODEL_URL);
    } catch {
      model = null;
    }
    if (this.disposed) return;
    this.botModel = model;
    this.applyBotsState();
    this.applyMultiplayerState();
    // Training mode: a target-practice range (no bots, no return fire).
    if (this.training && !this.net && !this.trainingRange) {
      this.trainingRange = new TrainingRange(this.scene, this.map);
    }
    this.emitHud();
  }

  dispose() {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    if (this.frameTimeout !== null) clearTimeout(this.frameTimeout);
    this.frameTimeout = null;
    if (this.fpsChannel) {
      this.fpsChannel.port1.onmessage = null;
      this.fpsChannel.port1.close();
      this.fpsChannel.port2.close();
      this.fpsChannel = null;
    }
    this.tickFn = null;
    this.input.detach();
    window.removeEventListener('resize', this.resizeHandler);
    this.replay?.dispose();
    this.replay = null;
    this.replaySegments = [];
    this.replaySegIdx = 0;
    this.pom = null;
    this.pomOnDone = null;
    this.recorder.reset();
    this.weapon.disposeAll(this.scene);
    this.effects.dispose(this.scene);
    this.trainingRange?.dispose(this.scene);
    this.trainingRange = null;
    if (this.bots) this.bots.dispose(this.scene);
    for (const rp of this.remotePlayers.values()) rp.dispose(this.scene);
    this.remotePlayers.clear();
    if (this.net) this.net.dispose();
    this.audio.dispose();
    // The PMREM IBL render target lives on scene.environment and isn't a scene
    // child, so disposeScene() misses it — free it explicitly so each match
    // remount (Play Again / new match) doesn't leak a cube render target (#26i).
    (this.scene.environment as THREE.Texture | null)?.dispose();
    this.scene.environment = null;
    this.disposeScene();
    this.renderer.dispose();
  }

  private applyBotsState() {
    if (!this.botModel && this.wantBots) {
      // Model not loaded yet — applyBotsState() will be called again from start()
      return;
    }
    if (this.wantBots && !this.bots) {
      this.bots = new BotManager(
        this.scene,
        this.map,
        this.botCount,
        this.map.spawn,
        this.botModel,
        this.botDifficulty,
      );
      for (const b of this.bots.bots) {
        this.botDeathCounts.set(b.state.id, 0);
        this.botFrags.set(b.state.id, 0);
      }
      this.applyEnemyStyle();
      // A real (non-training) offline match opens with a short warmup: a
      // countdown during which neither side can frag, plus first-spawn grace so
      // the cold open isn't a free kill for whoever the bots target first.
      if (!this.training && !this.net) this.beginLocalWarmup();
    } else if (!this.wantBots && this.bots) {
      this.bots.dispose(this.scene);
      this.bots = null;
      this.botDeathCounts.clear();
      this.botFrags.clear();
      this.botShotsFired.clear();
      this.botShotsHit.clear();
    }
  }

  private beginLocalWarmup() {
    this.localWarmupUntil = performance.now() + LOCAL_WARMUP_SEC * 1000;
    // Invuln spans the warmup AND a beat past it (ticks down each frame), so the
    // first live moment still has the normal respawn grace.
    this.localRespawnInvuln = LOCAL_WARMUP_SEC + LOCAL_RESPAWN_INVULN_SEC;
  }

  // The 3-2-1 pre-match countdown — offline (localWarmupUntil) OR online
  // (server resumeAt). During it nobody can move OR fire; bots stay put too.
  private get inCountdown(): boolean {
    return this.warmupMsLeft() > 0;
  }

  private warmupMsLeft(): number {
    return this.net ? this.net.warmupMsLeft : Math.max(0, this.localWarmupUntil - performance.now());
  }

  private applyMultiplayerState() {
    if (this.wantMultiplayer && !this.net) {
      if (!this.multiplayerUrl) {
        console.warn('[instagib] multiplayer enabled but no serverUrl set');
        return;
      }
      console.info(`[instagib] connecting to ${this.multiplayerUrl} room=${this.multiplayerRoomId}`);
      this.net = new NetClient({
        url: this.multiplayerUrl,
        name: this.playerName,
        roomId: this.multiplayerRoomId,
        events: {
          onKill: (ev) => this.handleNetKill(ev),
          onJoined: (info) => this.handleNetJoined(info),
          onJoinFailed: (reason) => this.onNetEvent({ type: 'join-failed', reason }),
          onRespawn: (pos) => this.handleNetRespawn(pos),
          onVoteStart: (v) => this.handleVoteStart(v),
          onVoteUpdate: (counts) => this.handleVoteUpdate(counts),
          onVoteResult: (r) => this.handleVoteResult(r),
          onRound: (r) => this.handleNetRound(r),
        },
      });
      this.net.connect();
    } else if (!this.wantMultiplayer && this.net) {
      this.net.dispose();
      this.net = null;
      this.vote = null;
      this.netMode = 'ffa';
      this.localTeam = null;
      this.duel = null;
      for (const rp of this.remotePlayers.values()) rp.dispose(this.scene);
      this.remotePlayers.clear();
    }
  }

  // Server confirmed our room join → adopt the room's authoritative map and
  // drop onto the server-assigned spawn.
  private handleNetJoined(info: {
    mapId: string;
    spawn: { x: number; y: number; z: number };
    state: 'active' | 'voting';
    mode: GameMode;
    team: number | null;
    roundsToWin: number | null;
  }) {
    this.netMode = info.mode;
    this.localTeam = info.team;
    this.duel =
      info.mode === 'duel'
        ? {
            roundNum: 1,
            roundsToWin: info.roundsToWin ?? DUEL_ROUNDS_TO_WIN,
            myWins: 0,
            oppWins: 0,
          }
        : null;
    const desired = mapById(info.mapId);
    if (desired !== this.map) this.setMap(desired);
    this.player.pos = { x: info.spawn.x, y: info.spawn.y, z: info.spawn.z };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.onGround = false;
    this.killcam = null;
    this.matchSubmitted = false;
    this.wonLastMatch = false;
    // Recolor any already-present remotes for the new mode (team colors in TDM).
    this.recolorRemotes();
    if (info.state !== 'voting') this.vote = null;
    // "Now playing: <map>" so a server map adoption on join isn't silent (#26g).
    this.banner = {
      id: this.nextEventId++,
      tier: 'special',
      title: desired.name,
      subtitle: 'Now playing',
      remaining: BANNER_DURATION_SEC,
      total: BANNER_DURATION_SEC,
    };
    this.emitHud();
  }

  // Server forced a respawn (we fell out of the world) — snap to the new spot.
  private handleNetRespawn(pos: { x: number; y: number; z: number }) {
    this.player.pos = { x: pos.x, y: pos.y, z: pos.z };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.onGround = false;
  }

  private handleVoteStart(v: { options: string[]; endsAtClient: number; durationMs: number; winnerId: string | null; winnerTeam: number | null }) {
    // The vote opening IS the end of the online match — this is the moment to
    // latch win/loss and submit stats exactly once, BEFORE handleVoteResult
    // resets the counters for the next map (#4). In TDM the winner is a team.
    this.wonLastMatch =
      v.winnerTeam != null
        ? this.localTeam != null && v.winnerTeam === this.localTeam
        : v.winnerId != null && v.winnerId === this.net?.clientId;
    if (this.net && !this.matchSubmitted) {
      this.matchSubmitted = true;
      this.onMatchEnd(this.collectStats(this.wonLastMatch));
    }
    const counts: Record<string, number> = {};
    for (const o of v.options) counts[o] = 0;
    this.vote = {
      options: v.options,
      endsAtClient: v.endsAtClient,
      durationMs: v.durationMs,
      counts,
      myVote: null,
    };
    // Release the cursor so the player can click a map; freeze sim via vote.
    if (typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
    // The end cinematic (slow-mo → VICTORY/DEFEAT → Play of the Match) plays over
    // the now-running vote countdown; the results + vote UI are gated behind
    // hud.pom in React until it ends. The reveal is a no-op here — those overlays
    // are React-state driven and simply un-gate when finishPlayOfMatch clears
    // hud.pom (which also speaks the verdict via the freeze beat).
    this.startPlayOfMatch(() => {}, this.wonLastMatch);
    this.emitHud();
  }

  private handleVoteUpdate(counts: Record<string, number>) {
    if (this.vote) {
      this.vote = { ...this.vote, counts };
      this.emitHud();
    }
  }

  private handleVoteResult(r: { mapId: string; resumeAtClient: number }) {
    this.vote = null;
    // The clip is normally done by the time the vote resolves; finish it
    // defensively (no-op if not playing) so a fresh match starts clean.
    this.finishPlayOfMatch();
    this.recorder.reset();
    // New match on the winning map: reset local medal/streak + per-run stats
    // (server resets the authoritative scoreboard; HUD reads it from snapshots).
    // Done AFTER handleVoteStart already submitted the finished match's stats.
    this.medals = new MedalTracker();
    this.playerFrags = 0;
    this.playerDeaths = 0;
    this.playerHeadshots = 0;
    this.playerShotsFired = 0;
    this.playerShotsHit = 0;
    this.matchSubmitted = false;
    this.wonLastMatch = false;
    this.resetMatchDrama();
    const desired = mapById(r.mapId);
    if (desired !== this.map) {
      this.setMap(desired);
    } else {
      // Same map → still respawn fresh (player radius so we don't clip a box).
      this.player.pos = { ...pickFreeSpot(this.map, null, PLAYER_RADIUS) };
      this.player.vel = { x: 0, y: 0, z: 0 };
    }
    this.localRespawnInvuln = LOCAL_RESPAWN_INVULN_SEC;
    this.banner = {
      id: this.nextEventId++,
      tier: 'special',
      title: desired.name,
      subtitle: 'Next map',
      remaining: BANNER_DURATION_SEC,
      total: BANNER_DURATION_SEC,
    };
    // Best-effort re-lock so the player isn't dropped to a generic Click-to-Play
    // after every map cycle (#8). Works when the vote resolved right after the
    // local player clicked an option (transient activation); otherwise the
    // ClickToPlay overlay is the fallback.
    this.input.requestLock();
    this.emitHud();
  }

  // Duel: the server ended a round and reset the scoreboard. Mirror the reset
  // locally (emitHud only RAISES frags from snapshots, so we must lower them
  // here), update the round tally, and show a "Round N" banner.
  private handleNetRound(r: {
    roundNum: number;
    roundWins: Record<string, number>;
    winnerId: string | null;
    resumeAtClient: number;
  }) {
    const myId = this.net?.clientId ?? '';
    const myWins = r.roundWins[myId] ?? 0;
    let oppWins = 0;
    for (const [id, w] of Object.entries(r.roundWins)) {
      if (id !== myId) oppWins = Math.max(oppWins, w);
    }
    this.duel = {
      roundNum: r.roundNum,
      roundsToWin: this.duel?.roundsToWin ?? DUEL_ROUNDS_TO_WIN,
      myWins,
      oppWins,
    };
    this.playerFrags = 0;
    this.playerDeaths = 0;
    this.resetMatchDrama();
    this.player.pos = { ...pickFreeSpot(this.map, null, PLAYER_RADIUS) };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.onGround = false;
    this.localRespawnInvuln = LOCAL_RESPAWN_INVULN_SEC;
    const iWon = r.winnerId != null && r.winnerId === myId;
    this.banner = {
      id: this.nextEventId++,
      tier: 'special',
      title: `Round ${r.roundNum}`,
      subtitle: iWon ? 'You won the round' : 'Round lost',
      remaining: BANNER_DURATION_SEC,
      total: BANNER_DURATION_SEC,
    };
    this.input.requestLock();
    this.playLocalSpawnEffect(); // materialize at the fresh round spawn
    this.emitHud();
  }

  // On-screen bearing to the killer at death: 0 = dead ahead, +π/2 = your right.
  // Uses your view yaw + the death position so the killcam can draw a "shot came
  // from here" arrow. forward = (-sin yaw,-cos yaw), right = (cos yaw,-sin yaw).
  private killDirAngle(killerPos: { x: number; z: number }, fromPos: { x: number; z: number }): number {
    const dx = killerPos.x - fromPos.x;
    const dz = killerPos.z - fromPos.z;
    if (Math.hypot(dx, dz) < 1e-3) return 0;
    const yaw = this.player.yaw;
    const vf = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
    const vr = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
    return Math.atan2(vr, vf);
  }

  // TDM team highlight: friendlies green, foes wear their team color. Returns
  // null in non-TDM modes so the caller falls back to the enemy-highlight color.
  private teamColorHex(team: number | null): string | null {
    if (this.netMode !== 'tdm' || this.localTeam == null || team == null) {
      return null;
    }
    return team === this.localTeam
      ? TDM_FRIEND_COLOR
      : TEAM_COLORS[team] ?? TEAM_COLORS[0];
  }

  private applyRemoteColor(rp: RemotePlayer) {
    const hex = this.teamColorHex(rp.team);
    if (hex) {
      rp.setHighlight(new THREE.Color(hex));
      rp.setTeamColor(hex); // team override > the player's name-color cosmetic
    } else {
      rp.setHighlight(this.enemyColor);
      rp.setTeamColor(null); // fall back to the cosmetic name color
    }
  }

  private recolorRemotes() {
    for (const rp of this.remotePlayers.values()) this.applyRemoteColor(rp);
  }

  // Submit a map vote (called from the client overlay via the Game wrapper).
  voteForMap(mapId: string) {
    if (!this.net || !this.vote) return;
    if (!this.vote.options.includes(mapId)) return;
    this.vote = { ...this.vote, myVote: mapId };
    this.net.sendVote(mapId);
    this.emitHud();
  }

  // Frame-rate limit. 0 = VSync (display refresh), a positive number caps to
  // that fps, a negative value uncaps (renders as fast as the machine allows,
  // beyond vsync). Applied on the next scheduled frame.
  setFpsLimit(n: number) {
    this.fpsLimit = Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  private runLoop() {
    this.tickFn = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < 5) {
        this.simStep(TICK_DT);
        this.accumulator -= TICK_DT;
        steps += 1;
      }
      if (steps === 5) this.accumulator = 0;
      this.tickHudTimers(dt);
      this.tickFps(dt);
      this.frameDt = dt;
      if (this.replay) {
        // Play-of-the-Match clip is playing: drive the replay and age its
        // beams + bursts here, since the sim (which normally steps them) is
        // frozen at match end. The camera is owned by the ReplayPlayer.
        this.replay.update(dt);
        this.weapon.step(dt, this.scene);
        this.effects.step(dt, this.scene);
        if (this.replay.done) this.advanceReplay();
      } else {
        this.syncRemotePlayers(dt);
        // Record the match for Play of the Match (downsampled; live play only).
        if (!this.matchOver && !this.vote && !this.training) {
          this.recorder.tick(dt, () => this.sampleReplayFrame());
        }
      }
      // Skip GL work while the WebGL context is lost (GPU reset / driver hiccup)
      // — rendering to a dead context spams errors and freezes black. The sim
      // keeps ticking so we resume cleanly once the context is restored.
      if (!this.contextLost) this.render();
      // Throttle HUD delivery to ~20Hz so React isn't re-rendering ~14 overlay
      // components every animation frame (the 3D render stays full-rate). Event
      // sites (kills, respawn, vote, lock change) still call emitHud() directly
      // for instant feedback. (#24)
      this.hudAccumMs += dt * 1000;
      if (this.hudAccumMs >= 50) {
        this.hudAccumMs = 0;
        this.emitHud();
      }
      this.scheduleFrame();
    };
    this.scheduleFrame();
  }

  // Schedule the next frame according to the FPS-limit mode. Exactly one frame
  // is queued per tick, so switching modes at runtime is seamless (no overlap).
  private scheduleFrame() {
    const fn = this.tickFn;
    if (this.disposed || !fn) return;
    const limit = this.fpsLimit;
    if (limit < 0) {
      // Uncapped: re-run ASAP via a MessageChannel — beats setTimeout's ~4ms
      // clamp, so it can render well past the display refresh.
      if (!this.fpsChannel) {
        this.fpsChannel = new MessageChannel();
        this.fpsChannel.port1.onmessage = () => {
          if (!this.disposed) fn(performance.now());
        };
      }
      this.fpsChannel.port2.postMessage(null);
    } else if (limit > 0) {
      // Cap: aim for the target interval, discounting time already spent this
      // frame so the cap holds under load.
      const target = 1000 / limit;
      const spent = performance.now() - this.lastTime;
      this.frameTimeout = setTimeout(() => fn(performance.now()), Math.max(0, target - spent));
    } else {
      // VSync (default): one render per display refresh.
      this.rafHandle = requestAnimationFrame(fn);
    }
  }

  private tickFps(dt: number) {
    this.fpsAccumMs += dt * 1000;
    this.fpsFrames += 1;
    if (this.fpsAccumMs >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / this.fpsAccumMs);
      this.fpsFrames = 0;
      this.fpsAccumMs = 0;
    }
  }

  private syncRemotePlayers(dt: number) {
    if (!this.net) return;
    // Refresh the interpolated view of remote players (render-delayed so we
    // always interpolate between two snapshots — see NetClient.interpolate).
    this.net.interpolate();
    // Remove disconnected
    for (const [id, rp] of this.remotePlayers) {
      if (!this.net.remotes.has(id)) {
        rp.dispose(this.scene);
        this.remotePlayers.delete(id);
      }
    }
    // Add new + tick existing
    for (const [id, snap] of this.net.remotes) {
      let rp = this.remotePlayers.get(id);
      if (!rp) {
        rp = new RemotePlayer(id, snap.name, this.scene, this.botModel);
        rp.group.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
        rp.team = snap.team;
        this.applyRemoteColor(rp);
        this.remotePlayers.set(id, rp);
      } else if (rp.team !== snap.team) {
        rp.team = snap.team;
        this.applyRemoteColor(rp);
      }
      const respawned = rp.apply(snap, dt);
      if (respawned && !this.reducedEffects) {
        // This remote just materialized at its new spawn — play its effect.
        this.effects.spawnInBurst(this.scene, rp.group.position, spawnEffectById(rp.equippedSpawnEffect).style);
      }
      rp.setInvuln(snap.invulnMs);
    }
  }

  // Map a network client id to the replay actor id: the local player is always
  // recorded as 'you' (so offline + online kill logs line up with the sampler),
  // every other id passes through unchanged.
  private replayId(netId: string): string {
    return this.net && netId === this.net.clientId ? 'you' : netId;
  }

  // One downsampled frame for the match recorder: the pose of every entity the
  // client can see (local player, remotes, bots), keyed by replay actor id.
  // Also lazily captures each entity's static profile (name + cosmetics).
  private sampleReplayFrame(): Record<string, ReplayPose> {
    const poses: Record<string, ReplayPose> = {};

    // Local player — first-person, but recorded as a body so the replay can
    // show "you" in third person.
    this.recorder.ensureProfile({
      id: 'you',
      name: this.playerName,
      kind: 'local',
      hat: this.localHat,
      unusual: this.localUnusual,
      nameColor: this.localNameColor,
      team: this.localTeam,
    });
    poses['you'] = {
      x: this.player.pos.x,
      y: this.player.pos.y,
      z: this.player.pos.z,
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      visible: this.killcam === null, // hidden while you're dead (killcam)
    };

    // Remote players (online). Cosmetics/yaw come from the latest net snapshot.
    for (const [id, rp] of this.remotePlayers) {
      const snap = this.net?.remotes.get(id);
      this.recorder.ensureProfile({
        id,
        name: rp.name,
        kind: 'remote',
        hat: snap?.hat ?? 'hat.none',
        unusual: snap?.unusual ?? 'unusual.none',
        nameColor: snap?.nameColor ?? 'name.default',
        team: rp.team,
      });
      poses[id] = {
        x: rp.group.position.x,
        y: rp.group.position.y,
        z: rp.group.position.z,
        yaw: snap?.yaw ?? 0,
        pitch: snap?.pitch ?? 0,
        visible: rp.group.visible,
      };
    }

    // Bots (offline). Their facing uses a +π model offset vs. the player/remote
    // convention, so convert it here for a faithful replay orientation.
    if (this.bots) {
      for (const b of this.bots.bots) {
        const id = b.state.id;
        this.recorder.ensureProfile({
          id,
          name: b.state.name,
          kind: 'bot',
          hat: 'hat.none',
          unusual: 'unusual.none',
          nameColor: 'name.default',
          team: null,
        });
        poses[id] = {
          x: b.state.pos.x,
          y: b.state.pos.y,
          z: b.state.pos.z,
          yaw: b.getFacing() + Math.PI,
          pitch: 0, // bots don't track a persistent look pitch
          visible: b.state.alive,
        };
      }
    }

    return poses;
  }

  private addShake(amount: number) {
    if (this.reducedEffects) return; // accessibility: no camera shake
    this.shake = Math.min(SHAKE_MAX, this.shake + amount);
  }

  // Spawn the kill burst at `at`, honoring the reduced-effects setting: the full
  // 3D explosion is replaced by a small, non-flashing spark.
  private spawnKillEffect(at: THREE.Vector3, headshot: boolean, style: KillEffectStyle) {
    if (this.reducedEffects) {
      this.effects.spawnHitFlash(this.scene, at, headshot ? 0xffd27a : 0x9be8ff);
      return;
    }
    this.effects.spawnKillBurst(this.scene, at, headshot, style);
  }

  // Punchy feedback when YOU land a kill: a crisp shake, a full-screen edge
  // flash, and a glow pop on the viewmodel — on top of the hit marker, kill
  // confirm text, SFX, and 3D burst handled at the call sites.
  private fireKillFeedback(headshot: boolean) {
    this.addShake(SHAKE_KILL);
    if (!this.reducedEffects) {
      this.killFlash = {
        id: this.nextEventId++,
        headshot,
        remaining: KILL_FLASH_DURATION_SEC,
        total: KILL_FLASH_DURATION_SEC,
      };
    }
    if (this.viewmodelGlow) this.viewmodelGlow.emissiveIntensity = 5.5;
  }

  private simStep(dt: number) {
    if (!this.locked || this.matchOver) return;
    this.elapsed += dt;

    const input = this.input.consume();
    this.wantZoom = input.zoom;
    const dead = this.killcam !== null;

    // While dead the input is still consumed (so accumYaw/accumPitch don't
    // pile up and snap the view on respawn), but it does NOT apply to the
    // player. The camera is owned by the killcam in render().
    if (!dead) this.player.step(input, dt, this.map, this.inCountdown);

    // Self-heal the local sim: a NaN (degenerate collision) or falling out of
    // the world (boosted through a seam) would otherwise be unrecoverable
    // offline — online the server force-respawns us, but offline nothing does.
    if (!dead) {
      const p = this.player.pos;
      const b = this.map.bounds;
      const finite = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
      const voided =
        p.y < b.min.y - 6 ||
        p.x < b.min.x - 4 || p.x > b.max.x + 4 ||
        p.z < b.min.z - 4 || p.z > b.max.z + 4;
      if (!finite || voided) {
        this.player.pos = { ...pickFreeSpot(this.map, null, PLAYER_RADIUS) };
        this.player.vel = { x: 0, y: 0, z: 0 };
        this.player.onGround = false;
        this.localRespawnInvuln = LOCAL_RESPAWN_INVULN_SEC;
      }
    }

    // Boost-jump feedback: a cyan spark at the surface the player kicked off.
    if (this.player.didBoost) {
      this.player.didBoost = false;
      const c = this.player.boostContact;
      this.effects.spawnHitFlash(this.scene, new THREE.Vector3(c.x, c.y, c.z), 0x9be8ff);
    }

    this.weapon.step(dt, this.scene);
    this.effects.step(dt, this.scene);
    this.trainingRange?.update(dt);
    if (this.localRespawnInvuln > 0) {
      this.localRespawnInvuln = Math.max(0, this.localRespawnInvuln - dt);
    }
    if (this.bots) {
      // Targetable entities: the local player (only while alive) + all live
      // bots. Each bot skips itself. Resolve any shots they decide to take.
      const enemies: BotTarget[] = [];
      if (!dead) enemies.push({ id: 'player', pos: this.player.pos });
      for (const b of this.bots.bots) {
        if (b.state.alive) enemies.push({ id: b.state.id, pos: b.state.pos });
      }
      const intents = this.bots.step(dt, this.map, enemies, this.inCountdown);
      // During the countdown bots are frozen (no intents); afterwards they frag.
      if (!this.inCountdown) for (const intent of intents) this.handleBotShot(intent);
      // Spawn-in effect when a bot materializes (dead→alive), so solo play shows
      // the effect too. A stable per-bot style gives variety without netcode.
      if (!this.reducedEffects) {
        for (const b of this.bots.bots) {
          const was = this.botAlive.get(b.state.id);
          if (b.state.alive && was === false) {
            const style = SPAWN_EFFECTS[hashStr(b.state.id) % SPAWN_EFFECTS.length].style;
            this.effects.spawnInBurst(
              this.scene,
              new THREE.Vector3(b.state.pos.x, b.state.pos.y, b.state.pos.z),
              style,
            );
          }
          this.botAlive.set(b.state.id, b.state.alive);
        }
      }
    }

    // Cooldown-to-ready transition → reload-ready ping. Fires once per shot.
    const ready = this.weapon.cooldown === 0;
    if (ready && !this.weaponWasReady && !dead) {
      this.audio.play('reload-ready', 0.6);
    }
    this.weaponWasReady = ready;

    if (input.firePressed && !dead && !this.inCountdown) this.handleFire();

    // Throttled position broadcast
    if (this.net) {
      this.posSendAccumMs += dt * 1000;
      const intervalMs = 1000 / POS_SEND_HZ;
      if (this.posSendAccumMs >= intervalMs) {
        this.posSendAccumMs = 0;
        this.net.sendPosition(
          this.player.pos.x,
          this.player.pos.y,
          this.player.pos.z,
          this.player.yaw,
          this.player.pitch,
        );
      }
    }
  }

  private handleFire() {
    this.tmpEuler.set(this.player.pitch, this.player.yaw, 0, 'YXZ');
    this.tmpForward.set(0, 0, -1).applyEuler(this.tmpEuler);
    this.tmpRight.set(1, 0, 0).applyEuler(this.tmpEuler);
    this.tmpUp.set(0, 1, 0).applyEuler(this.tmpEuler);
    const eye = new THREE.Vector3(
      this.player.pos.x,
      this.player.pos.y + EYE_HEIGHT,
      this.player.pos.z,
    );
    const muzzle = eye.addScaledVector(this.tmpForward, 0.3);
    // The VISIBLE beam leaves the gun muzzle (lower-right of the eye, tracking
    // the viewmodel offset) instead of the crosshair, so it never blocks POV.
    // Hits + the server shot still use `muzzle` (eye) so aim stays exact.
    this.tmpBeamOrigin
      .set(this.player.pos.x, this.player.pos.y + EYE_HEIGHT, this.player.pos.z)
      .addScaledVector(this.tmpRight, 0.16 + this.viewmodelOffset.x)
      .addScaledVector(this.tmpUp, -0.16 + this.viewmodelOffset.y)
      .addScaledVector(this.tmpForward, 0.5);

    // Bots are resolved locally; remote players are resolved by the SERVER
    // (lag-compensated). So the local raycast only carries bots — the wall
    // distance (result.end) becomes the shot's range cap sent to the server.
    const targets: RailTarget[] = [];
    const bots = this.bots?.bots ?? [];
    for (const b of bots) {
      if (!b.state.alive) continue;
      targets.push({
        kind: 'bot',
        id: b.state.id,
        name: b.state.name,
        bounds: b.bounds(),
        headshotY: b.state.pos.y + BOT_HEIGHT * BOT_HEADSHOT_THRESHOLD,
        centerY: b.centerY(),
      });
    }
    // Training-range targets are raycast just like bots (collateral allowed).
    if (this.trainingRange) targets.push(...this.trainingRange.targets());

    const result = this.weapon.fire(
      muzzle,
      this.tmpForward,
      this.scene,
      this.map.boxes,
      targets,
      this.tmpBeamOrigin,
    );
    // Cooldown blocked the shot → no SFX, no side effects.
    if (!result) return;

    // Real shot: play fire SFX exactly once. The weapon already set cooldown.
    this.weaponWasReady = false;
    this.fireWasAirborne = !this.player.onGround;
    this.playerShotsFired += 1;
    // Record the visible beam so the Play-of-the-Match replay can re-draw it.
    this.recorder.logShot({
      origin: { x: this.tmpBeamOrigin.x, y: this.tmpBeamOrigin.y, z: this.tmpBeamOrigin.z },
      end: { x: result.end.x, y: result.end.y, z: result.end.z },
      killerId: 'you',
    });
    this.audio.play('fire', 0.55);
    this.addShake(SHAKE_FIRE);
    // Weapon feedback: recoil the gun, punch the view up, flash the muzzle, and
    // spike the gun's energy glow (all decay back over the next few frames).
    this.recoil = 1;
    this.viewKick = this.reducedEffects ? 0 : 0.03; // camera pitch-punch — gated for reduced motion
    if (this.viewmodelGlow) this.viewmodelGlow.emissiveIntensity = 4.5;
    this.effects.spawnMuzzleFlash(this.scene, this.tmpBeamOrigin);

    // Training range: count the shot, pop any targets the rail passed through,
    // and break the streak on a clean miss. Live stats refresh to the HUD.
    if (this.trainingRange) {
      this.trainingRange.registerShot();
      let hitTarget = false;
      for (const hit of result.hits) {
        if (hit.target.kind !== 'target') continue;
        const pos = this.trainingRange.onHit(hit.target.id);
        if (pos) {
          hitTarget = true;
          this.spawnKillEffect(pos, hit.headshot, this.killEffectStyle);
          this.audio.play(hit.headshot ? 'headshot' : 'hit', 0.5);
        }
      }
      if (!hitTarget) this.trainingRange.registerMiss();
      this.emitHud();
    }

    // Hand the shot to the server for authoritative, lag-compensated hit
    // detection against remote players. maxDist = distance to the nearest wall.
    if (this.net) {
      const maxDist = muzzle.distanceTo(result.end);
      this.net.sendShot(
        { x: muzzle.x, y: muzzle.y, z: muzzle.z },
        { x: this.tmpForward.x, y: this.tmpForward.y, z: this.tmpForward.z },
        maxDist,
      );
    }

    if (result.hits.length === 0) return; // missed every bot

    // Local bot kills resolve immediately. (Remote-player kills are decided by
    // the server via the shot above and arrive through handleNetKill.)
    let firstHitHeadshot = false;
    let anyHit = false;

    for (const hit of result.hits) {
      if (hit.target.kind !== 'bot') continue;
      anyHit = true;
      if (!firstHitHeadshot && hit === result.hits[0]) {
        firstHitHeadshot = hit.headshot;
      }
      this.effects.spawnHitFlash(this.scene, hit.point, 0xffd1d8);

      const bot = bots.find((b) => b.state.id === hit.target.id);
      if (!bot) continue;
      const midAir = this.fireWasAirborne;
      const special = hit.headshot ? 'headshot' : midAir ? 'mid-air' : null;
      this.spawnKillEffect(
        new THREE.Vector3(bot.state.pos.x, bot.centerY(), bot.state.pos.z),
        hit.headshot,
        this.killEffectStyle,
      );
      bot.kill();
      this.recorder.logKill({
        killerId: 'you',
        victimId: bot.state.id,
        headshot: hit.headshot,
        killerName: this.playerName,
        victimName: hit.target.name,
      });
      this.botDeathCounts.set(
        bot.state.id,
        (this.botDeathCounts.get(bot.state.id) ?? 0) + 1,
      );
      this.playerFrags += 1;
      if (hit.headshot) this.playerHeadshots += 1;
      this.audio.play('kill', 0.7);
      this.audio.hitConfirm(hit.headshot, 0.5);
      this.pushKillfeed({
        killer: this.playerName,
        killerLocal: true,
        victim: hit.target.name,
        weapon: 'rail',
        special,
      });
      const medals = this.medals.onKill(this.elapsed, {
        midAir,
        headshot: hit.headshot,
      });
      for (const m of medals) this.awardMedal(m);
    }

    if (anyHit) {
      this.playerShotsHit += 1;
      this.hitMarker = {
        id: this.nextEventId++,
        kind: firstHitHeadshot ? 'headshot' : 'kill',
        remaining: HIT_MARKER_KILL_DURATION_SEC,
        total: HIT_MARKER_KILL_DURATION_SEC,
      };
      // Prominent kill confirmation on EVERY frag (offline path — the online
      // path sets this in handleNetKill). result.hits[0] is the nearest victim.
      this.killConfirm = {
        id: this.nextEventId++,
        victimName: result.hits[0].target.name,
        headshot: firstHitHeadshot,
        remaining: KILL_CONFIRM_DURATION_SEC,
        total: KILL_CONFIRM_DURATION_SEC,
      };
      this.fireKillFeedback(firstHitHeadshot);
      this.checkMatchEnd();
    }
  }

  // ── Bot combat: resolve a bot's fired shot against the world ──────────────
  private handleBotShot(intent: BotFireIntent) {
    // Every intent is one shot fired — count it for the bot's accuracy.
    this.botShotsFired.set(intent.botId, (this.botShotsFired.get(intent.botId) ?? 0) + 1);
    const origin = new THREE.Vector3(intent.origin.x, intent.origin.y, intent.origin.z);
    const dir = new THREE.Vector3(intent.dir.x, intent.dir.y, intent.dir.z).normalize();
    const o = intent.origin;
    const d = { x: dir.x, y: dir.y, z: dir.z };

    // Nearest wall caps the beam + the shot.
    let wallT = RAIL_RANGE;
    for (const b of this.map.boxes) {
      const t = rayAabb(o, d, b);
      if (t !== null && t > 0 && t < wallT) wallT = t;
    }

    // Nearest victim (player + other bots) closer than the wall.
    let victimKind: 'player' | 'bot' | null = null;
    let victimId = '';
    let victimName = '';
    let victimPos: { x: number; y: number; z: number } | null = null;
    let bestT = wallT;
    if (this.killcam === null && this.localRespawnInvuln <= 0) {
      const t = rayAabb(o, d, this.playerBounds());
      if (t !== null && t > 0 && t < bestT) {
        bestT = t;
        victimKind = 'player';
        victimId = 'player';
        victimName = this.playerName;
        victimPos = { ...this.player.pos };
      }
    }
    if (this.bots) {
      for (const b of this.bots.bots) {
        if (!b.state.alive || b.state.id === intent.botId) continue;
        const t = rayAabb(o, d, b.bounds());
        if (t !== null && t > 0 && t < bestT) {
          bestT = t;
          victimKind = 'bot';
          victimId = b.state.id;
          victimName = b.state.name;
          victimPos = { ...b.state.pos };
        }
      }
    }

    // Visible beam to the impact point (enemy fire reveals positions).
    const end = origin.clone().addScaledVector(dir, victimPos ? bestT : wallT);
    this.weapon.spawnBeam(origin, end, this.scene);
    this.recorder.logShot({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      end: { x: end.x, y: end.y, z: end.z },
      killerId: intent.botId,
    });
    this.audio.play('fire', 0.28);
    if (!victimKind || !victimPos) return;

    // Landed on someone (instagib = every hit is a kill) → count for accuracy.
    this.botShotsHit.set(intent.botId, (this.botShotsHit.get(intent.botId) ?? 0) + 1);
    this.effects.spawnHitFlash(this.scene, end, 0xffd1d8);
    this.recorder.logKill({
      killerId: intent.botId,
      victimId: victimKind === 'player' ? 'you' : victimId,
      headshot: false,
      killerName: intent.botName,
      victimName,
    });
    if (victimKind === 'player') {
      this.handleLocalDeath(intent.botName, intent.botId);
    } else {
      const victim = this.bots?.bots.find((b) => b.state.id === victimId);
      if (victim) {
        this.spawnKillEffect(
          new THREE.Vector3(victim.state.pos.x, victim.centerY(), victim.state.pos.z),
          false,
          DEFAULT_KILL_EFFECT,
        );
        victim.kill();
        this.botDeathCounts.set(victimId, (this.botDeathCounts.get(victimId) ?? 0) + 1);
      }
      this.pushKillfeed({
        killer: intent.botName,
        killerLocal: false,
        victim: victimName,
        weapon: 'rail',
        special: null,
      });
    }
    this.botFrags.set(intent.botId, (this.botFrags.get(intent.botId) ?? 0) + 1);
    this.checkMatchEnd();
  }

  private playerBounds(): AABB {
    const p = this.player.pos;
    return {
      min: { x: p.x - PLAYER_RADIUS, y: p.y, z: p.z - PLAYER_RADIUS },
      max: { x: p.x + PLAYER_RADIUS, y: p.y + PLAYER_HEIGHT, z: p.z + PLAYER_RADIUS },
    };
  }

  // Local (single-player vs bots) death + respawn. Mirrors the multiplayer
  // victim branch of handleNetKill but for a bot killer.
  private handleLocalDeath(killerName: string, killerId: string) {
    if (this.killcam) return;
    const deathPos = { ...this.player.pos };
    // Respawn away from where we died AND from every live bot (not just one).
    const avoid = [this.player.pos];
    if (this.bots) for (const b of this.bots.bots) if (b.state.alive) avoid.push(b.state.pos);
    const spot = pickFreeSpot(this.map, avoid, PLAYER_RADIUS);
    this.player.pos = { x: spot.x, y: spot.y, z: spot.z };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.onGround = false;
    this.weapon.cooldown = 0;
    this.weaponWasReady = true;
    this.audio.play('hit', 0.6);
    this.addShake(SHAKE_DEATH);
    if (!this.reducedEffects) this.damageFlash = 1;
    this.medals.onDeath();
    this.playerDeaths += 1;
    // Invuln spans the killcam plus a short grace once you respawn.
    this.localRespawnInvuln = KILLCAM_DURATION_SEC + LOCAL_RESPAWN_INVULN_SEC;
    const bot = this.bots?.bots.find((b) => b.state.id === killerId);
    this.killcam = {
      killerId,
      killerName,
      deathPos,
      remaining: KILLCAM_DURATION_SEC,
      total: KILLCAM_DURATION_SEC,
      dirAngle: bot ? this.killDirAngle(bot.state.pos, deathPos) : undefined,
    };
    if (bot) {
      this.killcamLookAt.set(bot.state.pos.x, bot.centerY(), bot.state.pos.z);
    } else {
      this.killcamLookAt.set(deathPos.x, deathPos.y + 1.5, deathPos.z);
    }
    this.pushKillfeed({
      killer: killerName,
      killerLocal: false,
      victim: this.playerName,
      weapon: 'rail',
      special: null,
    });
  }

  private checkMatchEnd() {
    // Multiplayer match-end is server-authoritative (it triggers the map vote),
    // training is endless — only local/bot matches end client-side.
    if (this.matchOver || this.training || this.net) return;
    const counts = [this.playerFrags];
    if (this.bots) {
      for (const b of this.bots.bots) counts.push(this.botFrags.get(b.state.id) ?? 0);
    }
    counts.sort((a, b) => b - a);
    const top = counts[0];
    // End only when someone reaches the frag limit — matches play to the limit.
    if (top >= MATCH_FRAG_LIMIT) {
      this.endMatch(this.playerFrags >= top); // you win iff you (co-)lead
    }
  }

  private endMatch(won: boolean) {
    if (this.matchOver) return;
    this.matchOver = true;
    this.matchWon = won;
    // Release the cursor and freeze the sim; the client shows a results screen.
    if (typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
    // Reveal the results — deferred until the whole cinematic finishes. The
    // VICTORY/DEFEAT callout fires earlier, on the slow-mo freeze (see tick).
    const reveal = () => this.onMatchEnd(this.collectStats(won));
    if (this.startPlayOfMatch(reveal, won)) {
      this.emitHud(); // surface the cinematic now; reveal() fires when it ends
    } else {
      this.audio.speak(won ? 'Victory' : 'Defeat', 1); // no clip → call it now
      reveal();
      this.emitHud();
    }
  }

  // ── Play of the Match ──────────────────────────────────────────────────────

  // Pick the best moment of the just-ended match and start its cinematic replay
  // in the live scene. Returns false when there's nothing worth showing (the
  // caller then jumps straight to results). `onDone` runs once the clip ends.
  private startPlayOfMatch(onDone: () => void, won: boolean): boolean {
    if (this.replay || this.replaySegments.length) return true; // already playing
    this.endWon = won;
    this.verdictSpoken = false;

    // The cinematic is up to two first-person segments: a slow-motion replay of
    // the match-ending blow (whose freeze frame is the VICTORY/DEFEAT beat), then
    // the Play of the Match. Either may be absent (a 0-kill match has neither).
    const segments: ReplaySegment[] = [];
    const finale = this.recorder.selectFinale();
    if (finale) {
      segments.push({
        kind: 'finale',
        clip: finale,
        opts: { timeScale: FINALE_TIME_SCALE, freezeSec: FINALE_FREEZE_SEC },
      });
    }
    const potg = this.recorder.selectHighlight('you');
    if (potg) segments.push({ kind: 'potg', clip: potg, opts: {} });
    if (segments.length === 0) return false;

    // Hide the live world — the replay renders its own actors on the real map.
    for (const rp of this.remotePlayers.values()) rp.group.visible = false;
    if (this.bots) for (const b of this.bots.bots) b.group.visible = false;
    if (this.viewmodel) this.viewmodel.visible = false;

    this.replaySegments = segments;
    this.replaySegIdx = 0;
    this.pomOnDone = onDone;
    this.startReplaySegment(0);
    return true;
  }

  // Spin up the ReplayPlayer for one cinematic segment and surface its overlay.
  private startReplaySegment(i: number) {
    const seg = this.replaySegments[i];
    const replay = this.makeReplayPlayer();
    replay.start(seg.clip, this.recorder, seg.opts);
    this.replay = replay;
    this.pom = {
      phase: seg.kind,
      won: this.endWon,
      star: seg.clip.starName,
      label: seg.clip.label,
      subLabel: seg.clip.subLabel,
      remaining: replay.totalWall,
      total: replay.totalWall,
      hitId: 0,
      hitHeadshot: false,
    };
  }

  // Current segment finished: advance to the next, or end the whole cinematic.
  private advanceReplay() {
    if (this.replay) {
      this.replay.dispose();
      this.replay = null;
    }
    this.replaySegIdx += 1;
    if (this.replaySegIdx < this.replaySegments.length) {
      this.startReplaySegment(this.replaySegIdx);
      this.emitHud(); // refresh the overlay for the new phase (e.g. PotG title)
    } else {
      this.finishPlayOfMatch();
    }
  }

  private makeReplayPlayer(): ReplayPlayer {
    return new ReplayPlayer({
      scene: this.scene,
      camera: this.camera,
      botModel: this.botModel,
      spawnBeam: (o, e) =>
        this.weapon.spawnBeam(
          new THREE.Vector3(o.x, o.y, o.z),
          new THREE.Vector3(e.x, e.y, e.z),
          this.scene,
        ),
      spawnMuzzleFlash: (at) =>
        this.effects.spawnMuzzleFlash(this.scene, new THREE.Vector3(at.x, at.y, at.z)),
      spawnKillEffect: (at, headshot) => this.spawnKillEffect(at, headshot, this.killEffectStyle),
      reducedEffects: () => this.reducedEffects,
      // Each star kill in the clip flashes a crosshair hit-marker + a soft cue so
      // it reads as "they just fragged someone" during the cinematic.
      onStarKill: (headshot) => {
        if (this.pom) {
          this.pom.hitId += 1;
          this.pom.hitHeadshot = headshot;
        }
        this.audio.play(headshot ? 'headshot' : 'hit', 0.6);
        this.emitHud();
      },
    });
  }

  // End the whole cinematic (finished or skipped): tear down the replay, restore
  // the live world, and run the deferred results reveal exactly once.
  private finishPlayOfMatch() {
    if (!this.replay && this.replaySegments.length === 0) return;
    if (this.replay) {
      this.replay.dispose();
      this.replay = null;
    }
    this.replaySegments = [];
    this.replaySegIdx = 0;
    this.pom = null;
    for (const rp of this.remotePlayers.values()) rp.group.visible = true;
    if (this.bots) for (const b of this.bots.bots) b.group.visible = b.state.alive;
    const done = this.pomOnDone;
    this.pomOnDone = null;
    done?.();
    this.emitHud(); // push pom:null so the overlay clears and results show
  }

  // Public: skip the cinematic (Skip button / Esc) — jump straight to results.
  skipPlayOfMatch() {
    this.finishPlayOfMatch();
  }

  private collectStats(won: boolean): MatchResult {
    return {
      won,
      kills: this.playerFrags,
      deaths: this.playerDeaths,
      bestStreak: this.medals.bestStreak,
      headshots: this.playerHeadshots,
      shotsFired: this.playerShotsFired,
      // Clamp: a single rail can pierce multiple remotes (collateral), so the
      // per-kill hit count can briefly exceed shots fired — keep accuracy ≤100%.
      shotsHit: Math.min(this.playerShotsHit, this.playerShotsFired),
    };
  }

  // Snapshot of the current run for the client to submit if the player leaves
  // before the frag limit is reached. Online, "won" is the server-authoritative
  // latch (the local match never sets matchOver); offline it's the frag limit.
  getStats(): MatchResult {
    const won = this.net
      ? this.wonLastMatch
      : this.matchOver && this.playerFrags >= MATCH_FRAG_LIMIT;
    return this.collectStats(won);
  }

  // True only when this run produced something worth recording — guards the
  // client from POSTing an all-zero match (enter→leave / dead-lobby bounce) that
  // would inflate totalGames and pollute win-rate / K-D-per-game (#4).
  hasRecordableStats(): boolean {
    return this.playerFrags > 0 || this.playerDeaths > 0 || this.playerShotsFired > 0;
  }

  // Server `kill` broadcast — drives the same effect set as a local bot kill
  // but works for every client in the match (including the victim).
  private handleNetKill(ev: KillEvent) {
    const myId = this.net?.clientId ?? null;
    const iAmKiller = ev.killerId === myId;
    const iAmVictim = ev.victimId === myId;

    // Visual effects at the victim's last-known position.
    const burstAt = new THREE.Vector3(
      ev.victimPos.x,
      ev.victimPos.y + 0.9,
      ev.victimPos.z,
    );
    // Your equipped kill effect plays on YOUR frags; everyone else's frags use
    // the default until the server broadcasts each player's equipped cosmetics
    // (progression Phase 1 — remote cosmetics in the snapshot payload).
    this.spawnKillEffect(burstAt, ev.headshot, iAmKiller ? this.killEffectStyle : DEFAULT_KILL_EFFECT);

    if (iAmKiller) {
      // Killer: trust the server-authoritative score (next snapshot will
      // confirm); play kill SFX + medal locally for immediate feedback.
      this.audio.play('kill', 0.7);
      this.audio.hitConfirm(ev.headshot, 0.5);
      this.fireKillFeedback(ev.headshot);
      // Credit the confirmed hit so online accuracy/headshots aren't ~0 (#5).
      // (MP has no bots, so this is the only place these increment online — no
      // double-count with the local bot path.)
      this.playerShotsHit += 1;
      if (ev.headshot) this.playerHeadshots += 1;
      // "Gibbed <name>" / "Headshot <name>" floating text near crosshair.
      this.killConfirm = {
        id: this.nextEventId++,
        victimName: ev.victimName,
        headshot: ev.headshot,
        remaining: KILL_CONFIRM_DURATION_SEC,
        total: KILL_CONFIRM_DURATION_SEC,
      };
      // midAir is unreliable a full RTT after the shot (the server doesn't
      // report it), so don't award the Jump Shot medal on networked kills (#26a).
      const medals = this.medals.onKill(this.elapsed, {
        midAir: false,
        headshot: ev.headshot,
      });
      for (const m of medals) this.awardMedal(m);
    } else if (iAmVictim) {
      // Capture deathPos for the killcam BEFORE teleporting to respawn.
      const deathPos = { ...this.player.pos };
      // Snap the player data to the server-picked respawn. The camera
      // stays at deathPos during the killcam — see render().
      this.player.pos = {
        x: ev.respawnPos.x,
        y: ev.respawnPos.y,
        z: ev.respawnPos.z,
      };
      this.player.vel = { x: 0, y: 0, z: 0 };
      this.weapon.cooldown = 0;
      this.weaponWasReady = true;
      this.audio.play('hit', 0.6);
      this.addShake(SHAKE_DEATH);
      if (!this.reducedEffects) this.damageFlash = 1;
      this.medals.onDeath();
      this.playerDeaths += 1;
      const killer = this.remotePlayers.get(ev.killerId);
      this.killcam = {
        killerId: ev.killerId,
        killerName: ev.killerName,
        deathPos,
        remaining: KILLCAM_DURATION_SEC,
        total: KILLCAM_DURATION_SEC,
        killerCard: ev.killerCard,
        dirAngle: killer ? this.killDirAngle(killer.group.position, deathPos) : undefined,
      };
      // Initialize the killcam's smoothed look-at near the killer's
      // current position so we don't whip from origin on the first
      // frame.
      if (killer) {
        this.killcamLookAt.set(
          killer.group.position.x,
          killer.centerY(),
          killer.group.position.z,
        );
      } else {
        this.killcamLookAt.set(deathPos.x, deathPos.y + 1.5, deathPos.z);
      }
    } else {
      // Bystander — just hide the dead remote player briefly.
      const rp = this.remotePlayers.get(ev.victimId);
      if (rp) rp.markDead();
    }

    // For non-victim clients that are local-rendering the victim, hide them.
    if (!iAmVictim) {
      const rp = this.remotePlayers.get(ev.victimId);
      if (rp) rp.markDead();
    }

    // Killfeed everywhere.
    this.pushKillfeed({
      killer: ev.killerName,
      killerLocal: iAmKiller,
      victim: ev.victimName,
      weapon: 'rail',
      special: ev.headshot ? 'headshot' : null,
    });

    // Record for Play of the Match (the local player is keyed as 'you').
    this.recorder.logKill({
      killerId: this.replayId(ev.killerId),
      victimId: this.replayId(ev.victimId),
      headshot: ev.headshot,
      killerName: ev.killerName,
      victimName: ev.victimName,
    });
  }

  private pushKillfeed(
    opts: Omit<KillfeedEntry, 'id' | 'remaining' | 'total'>,
  ) {
    this.killfeed.unshift({
      ...opts,
      id: this.nextEventId++,
      remaining: KILLFEED_DURATION_SEC,
      total: KILLFEED_DURATION_SEC,
    });
    if (this.killfeed.length > MAX_KILLFEED_ENTRIES) {
      this.killfeed.length = MAX_KILLFEED_ENTRIES;
    }
  }

  private awardMedal(medal: Medal) {
    const meta = MEDAL_LABELS[medal];
    this.toasts.unshift({
      id: this.nextEventId++,
      medal,
      title: meta.title,
      subtitle: meta.subtitle,
      tier: meta.tier,
      remaining: TOAST_DURATION_SEC,
      total: TOAST_DURATION_SEC,
    });
    if (this.toasts.length > MAX_TOASTS) this.toasts.length = MAX_TOASTS;

    if (BANNER_MEDALS.has(medal)) {
      this.banner = {
        id: this.nextEventId++,
        tier: meta.tier,
        title: meta.title,
        subtitle: meta.subtitle,
        remaining: BANNER_DURATION_SEC,
        total: BANNER_DURATION_SEC,
      };
    }

    const voice = MEDAL_VOICE[medal];
    if (voice) this.audio.play(voice, 1);
  }

  private tickHudTimers(dt: number) {
    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      this.killfeed[i].remaining -= dt;
      if (this.killfeed[i].remaining <= 0) this.killfeed.splice(i, 1);
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].remaining -= dt;
      if (this.toasts[i].remaining <= 0) this.toasts.splice(i, 1);
    }
    if (this.banner) {
      this.banner.remaining -= dt;
      if (this.banner.remaining <= 0) this.banner = null;
    }
    if (this.hitMarker) {
      this.hitMarker.remaining -= dt;
      if (this.hitMarker.remaining <= 0) this.hitMarker = null;
    }
    if (this.killConfirm) {
      this.killConfirm.remaining -= dt;
      if (this.killConfirm.remaining <= 0) this.killConfirm = null;
    }
    if (this.killFlash) {
      this.killFlash.remaining -= dt;
      if (this.killFlash.remaining <= 0) this.killFlash = null;
    }
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt / 0.5);
    if (this.killcam) {
      this.killcam.remaining -= dt;
      if (this.killcam.remaining <= 0) {
        this.killcam = null;
        this.playLocalSpawnEffect(); // you materialize at your new spawn
      }
    }
    // Play-of-the-Match countdown mirrors the replay clock (single source of
    // truth, so Skip / completion stay consistent with the progress bar).
    if (this.pom && this.replay) {
      this.pom.remaining = this.replay.wallRemaining;
      // The finale freezes on the final-kill frame — that hold IS the VICTORY/
      // DEFEAT beat. Flip the overlay to the verdict card and call it out once.
      if (
        this.replaySegments[this.replaySegIdx]?.kind === 'finale' &&
        this.replay.isFrozen &&
        this.pom.phase !== 'verdict'
      ) {
        this.pom.phase = 'verdict';
        if (!this.verdictSpoken) {
          this.verdictSpoken = true;
          this.audio.speak(this.endWon ? 'Victory' : 'Defeat', 1);
        }
        this.emitHud();
      }
    }
  }

  // Play the local player's spawn-in effect at their feet. Suppressed under
  // reduced-effects (it's a particle burst). Called when you (re)materialize.
  private playLocalSpawnEffect() {
    if (this.reducedEffects) return;
    const p = this.player.pos;
    this.effects.spawnInBurst(
      this.scene,
      new THREE.Vector3(p.x, p.y, p.z),
      spawnEffectById(this.localSpawnEffect).style,
    );
  }

  private emitHud() {
    const speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    const pct = (hit: number, fired: number): number | null =>
      fired > 0 ? (hit / fired) * 100 : null;
    const scores: PlayerScore[] = [
      {
        id: 'you',
        name: this.playerName,
        isLocal: true,
        frags: this.playerFrags,
        deaths: this.playerDeaths,
        bestStreak: this.medals.bestStreak,
        currentStreak: this.medals.currentStreak,
        accuracy: pct(this.playerShotsHit, this.playerShotsFired),
        team: this.localTeam,
        hat: this.localHat,
        emote: this.localEmote,
      },
    ];
    if (this.bots) {
      for (const b of this.bots.bots) {
        scores.push({
          id: b.state.id,
          name: b.state.name,
          isLocal: false,
          frags: this.botFrags.get(b.state.id) ?? 0,
          deaths: this.botDeathCounts.get(b.state.id) ?? 0,
          bestStreak: 0,
          currentStreak: 0,
          accuracy: pct(
            this.botShotsHit.get(b.state.id) ?? 0,
            this.botShotsFired.get(b.state.id) ?? 0,
          ),
        });
      }
    }
    if (this.net) {
      // Server tracks frag/death authoritatively for the local player; use
      // it whenever it diverges from our local count (post-kill snapshots
      // arrive within ~30ms on LAN).
      const serverFrags = this.net.localFrags;
      const serverDeaths = this.net.localDeaths;
      if (serverFrags > this.playerFrags) this.playerFrags = serverFrags;
      if (serverDeaths > this.playerDeaths) this.playerDeaths = serverDeaths;
      scores[0].frags = this.playerFrags;
      scores[0].deaths = this.playerDeaths;
      // Local player's accuracy is tracked client-side from confirmed kills.
      scores[0].accuracy = pct(this.playerShotsHit, this.playerShotsFired);
      scores[0].ping = Math.round(this.net.rttMs);
      for (const [id, snap] of this.net.remotes) {
        scores.push({
          id,
          name: snap.name,
          isLocal: false,
          frags: snap.frags,
          deaths: snap.deaths,
          bestStreak: 0,
          currentStreak: 0,
          accuracy: null, // server doesn't report remote shot counts
          team: snap.team,
          hat: snap.hat,
          emote: snap.emote,
          ping: snap.ping,
        });
      }
    }
    scores.sort(
      (a, b) =>
        b.frags - a.frags ||
        a.deaths - b.deaths ||
        a.name.localeCompare(b.name),
    );

    // TDM team frag totals [red, blue] from the (authoritative) scoreboard.
    let teamScores: [number, number] | null = null;
    if (this.netMode === 'tdm') {
      const totals: [number, number] = [0, 0];
      for (const s of scores) {
        if (s.team === 0) totals[0] += s.frags;
        else if (s.team === 1) totals[1] += s.frags;
      }
      teamScores = totals;
    }

    this.updateMatchDrama(scores, teamScores);

    this.onHud({
      frags: this.playerFrags,
      railCooldown: this.weapon.cooldown,
      dashCooldown: this.player.dashCooldown,
      airJumpsLeft: this.player.airJumpsLeft,
      boostReady: this.player.boostInRange,
      speed,
      locked: this.locked,
      currentStreak: this.medals.currentStreak,
      bestStreak: this.medals.bestStreak,
      fps: this.fps,
      scores,
      killfeed: this.killfeed.map((k) => ({ ...k })),
      toasts: this.toasts.map((t) => ({ ...t })),
      banner: this.banner ? { ...this.banner } : null,
      hitMarker: this.hitMarker ? { ...this.hitMarker } : null,
      killConfirm: this.killConfirm ? { ...this.killConfirm } : null,
      killFlash: this.killFlash ? { ...this.killFlash } : null,
      damageFlash: this.damageFlash,
      killcam: this.killcam ? { ...this.killcam } : null,
      showScoreboard: this.input.scoreboardHeld,
      matchOver: this.matchOver ? { won: this.matchWon } : null,
      netStatus: this.net?.status ?? 'off',
      netPeers: this.net ? this.net.remotes.size : 0,
      netRttMs: this.net ? Math.round(this.net.rttMs) : 0,
      warmupMsLeft: this.warmupMsLeft(),
      localInvulnMs: this.net?.localInvulnMs ?? 0,
      vote: this.vote ? { ...this.vote, counts: { ...this.vote.counts } } : null,
      mode: this.netMode,
      localTeam: this.localTeam,
      teamScores,
      duel: this.duel ? { ...this.duel } : null,
      training: this.trainingRange ? { ...this.trainingRange.stats() } : null,
      pom: this.pom ? { ...this.pom } : null,
    });
  }

  private resetMatchDrama() {
    this.worstDeficit = 0;
    this.comebackAwarded = false;
    this.matchPointAnnounced = false;
  }

  // Match "drama" cues derived from the live scoreboard (so they work the same
  // offline vs. online): a one-shot "MATCH POINT" call when the leader is a
  // single frag from winning, and the Comeback medal when you retake the lead
  // after trailing badly. Both fire at most once per match (reset on vote/round).
  private updateMatchDrama(scores: PlayerScore[], teamScores: [number, number] | null) {
    if (this.matchOver || this.vote || this.training) return;

    // My score, the best opponent's score, and the frags needed to win — all
    // mode-aware. TDM compares team totals; FFA/Duel compare individuals.
    let mine: number;
    let oppBest: number;
    let limit: number;
    if (this.netMode === 'tdm') {
      if (!teamScores || this.localTeam == null) return;
      const other = this.localTeam === 0 ? 1 : 0;
      mine = teamScores[this.localTeam];
      oppBest = teamScores[other];
      limit = TDM_FRAG_LIMIT;
    } else {
      mine = 0;
      oppBest = 0;
      for (const s of scores) {
        if (s.isLocal) mine = s.frags;
        else oppBest = Math.max(oppBest, s.frags);
      }
      limit = this.netMode === 'duel' ? DUEL_ROUND_FRAG_LIMIT : MATCH_FRAG_LIMIT;
    }

    // "MATCH POINT": the leader (either side) needs exactly one more frag.
    if (!this.matchPointAnnounced && Math.max(mine, oppBest) === limit - 1) {
      this.matchPointAnnounced = true;
      const leadingMe = mine > oppBest;
      this.banner = {
        id: this.nextEventId++,
        tier: 'multi',
        title: 'MATCH POINT',
        subtitle: leadingMe ? 'one frag to win' : 'hold the line',
        remaining: BANNER_DURATION_SEC,
        total: BANNER_DURATION_SEC,
      };
      this.audio.play('match-point', 1);
    }

    // Comeback: track the worst hole you've been in, and award the medal the
    // moment you climb back into a clear lead from a meaningful deficit. The
    // threshold scales with the mode's frag limit (FFA 25→5, Duel 7→2, TDM 40→8).
    this.worstDeficit = Math.max(this.worstDeficit, oppBest - mine);
    const threshold = Math.max(2, Math.round(limit * 0.2));
    if (
      !this.comebackAwarded &&
      this.worstDeficit >= threshold &&
      mine > oppBest &&
      mine > 0
    ) {
      this.comebackAwarded = true;
      this.awardMedal('comeback');
    }
  }

  private render() {
    if (this.replay) {
      // Play of the Match: the ReplayPlayer owns the camera (positioned in its
      // update() earlier this frame), so leave it untouched here.
    } else if (this.killcam) {
      // Killcam: camera parks at the deathPos (slightly above eye-line),
      // looking at the killer's center. Look-at point is smoothed so the
      // killer running around doesn't jitter the camera.
      const killer = this.remotePlayers.get(this.killcam.killerId);
      const killerBot = killer
        ? null
        : this.bots?.bots.find((b) => b.state.id === this.killcam!.killerId);
      const targetX = killer
        ? killer.group.position.x
        : killerBot
          ? killerBot.state.pos.x
          : this.killcam.deathPos.x;
      const targetY = killer
        ? killer.centerY()
        : killerBot
          ? killerBot.centerY()
          : this.killcam.deathPos.y + 1.5;
      const targetZ = killer
        ? killer.group.position.z
        : killerBot
          ? killerBot.state.pos.z
          : this.killcam.deathPos.z;
      // Exponential smoothing toward the target (real dt → framerate-independent).
      const dt = this.frameDt;
      const a = 1 - Math.exp(-6 * dt);
      this.killcamLookAt.x += (targetX - this.killcamLookAt.x) * a;
      this.killcamLookAt.y += (targetY - this.killcamLookAt.y) * a;
      this.killcamLookAt.z += (targetZ - this.killcamLookAt.z) * a;
      this.camera.position.set(
        this.killcam.deathPos.x,
        this.killcam.deathPos.y + 2.2,
        this.killcam.deathPos.z,
      );
      this.camera.lookAt(this.killcamLookAt);
    } else {
      this.camera.position.set(
        this.player.pos.x,
        this.player.pos.y + EYE_HEIGHT,
        this.player.pos.z,
      );
      // viewKick is a transient upward view-punch on fire — visual only, so it
      // never alters the authoritative aim (player.pitch).
      this.camera.rotation.set(this.player.pitch - this.viewKick, this.player.yaw, 0, 'YXZ');
    }
    // Screen shake: jitter the camera position, decaying each frame. (Skipped
    // during the PoM replay — the ReplayPlayer owns the camera.)
    if (!this.replay && this.shake > 1e-4) {
      this.camera.position.x += (Math.random() * 2 - 1) * this.shake;
      this.camera.position.y += (Math.random() * 2 - 1) * this.shake;
      this.camera.position.z += (Math.random() * 2 - 1) * this.shake;
      this.shake *= Math.exp(-9.05 * this.frameDt); // ≈ 0.86/frame at 60fps, fps-independent
    }
    // Zoom: ease FOV toward the zoom target while the bind is held in-play.
    const zooming =
      this.wantZoom && this.locked && !this.killcam && !this.matchOver && !this.vote && !this.replay;
    const targetFov = zooming ? this.zoomFov : this.baseFov;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-18 * this.frameDt));
      this.camera.updateProjectionMatrix();
    }
    // Scale look sensitivity with the current (lerping) FOV so zoomed aim stays
    // steady, then fold in the ADS multiplier — which eases in as you zoom (1×
    // at hipfire → zoomSensMul at full zoom) so hipfire feel is untouched.
    const fovRatio = this.baseFov > 0 ? this.camera.fov / this.baseFov : 1;
    const zoomT =
      this.baseFov > this.zoomFov
        ? Math.max(0, Math.min(1, (this.baseFov - this.camera.fov) / (this.baseFov - this.zoomFov)))
        : 0;
    this.input.lookScale = fovRatio * (1 + (this.zoomSensMul - 1) * zoomT);
    // Decay weapon feedback — exp easing keyed to real dt so the punch feels the
    // same at 60fps and uncapped (the marketed FPS-uncap would otherwise change
    // recoil/kick feel with framerate). Constants match the old /frame factors.
    const fdt = this.frameDt;
    this.recoil *= Math.exp(-10.46 * fdt); // ≈ 0.84/frame at 60fps
    this.viewKick *= Math.exp(-11.9 * fdt); // ≈ 0.82/frame at 60fps
    if (this.viewmodelGlow) {
      const g = 1 - Math.exp(-11.9 * fdt); // ≈ 0.18/frame approach at 60fps
      this.viewmodelGlow.emissiveIntensity += (1.3 - this.viewmodelGlow.emissiveIntensity) * g;
    }
    // Viewmodel: show only while actively playing in first person; apply recoil
    // (kicks back toward the camera + muzzle tilts up, easing back to rest).
    if (this.viewmodel) {
      this.viewmodel.visible =
        !this.hideViewmodel && this.locked && !this.killcam && !this.replay;
      const r = this.recoil;
      this.viewmodel.position.set(
        VIEWMODEL_BASE.x + this.viewmodelOffset.x,
        VIEWMODEL_BASE.y + this.viewmodelOffset.y + r * 0.02,
        VIEWMODEL_BASE.z + this.viewmodelOffset.z + r * 0.08,
      );
      this.viewmodel.rotation.x = r * 0.22;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Re-apply pixelRatio (honoring the quality settings) so moving the window to
    // a different-DPI monitor (or a browser-zoom change) re-sharpens instead of
    // staying at the mount-time DPR (#26j).
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private disposeScene() {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((obj) => {
      if (obj.userData.shared) return;
      const mesh = obj as THREE.Mesh & THREE.Line & THREE.Sprite;
      if (mesh.isMesh || mesh.isLine || mesh.isSprite) {
        const geom = (mesh as unknown as { geometry?: THREE.BufferGeometry })
          .geometry;
        if (geom) geometries.add(geom);
        const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] })
          .material;
        if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
        else if (mat) materials.add(mat);
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  }
}

// Dispose every geometry + material under a group (used when swapping the
// arena mesh on a map change). Map meshes aren't tagged `shared`, so their
// resources are ours to free.
// Small stable string hash (for picking a per-bot spawn-effect style).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function disposeGroup(group: THREE.Object3D) {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geoms.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => mats.add(m));
    else if (mat) mats.add(mat);
  });
  geoms.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
}
