import * as THREE from 'three';
import { Ship } from './Ship.ts';
import { ChaseCamera } from './ChaseCamera.ts';
import { ShipModel } from '../render/ShipModel.ts';
import {
  CockpitModel,
  type CockpitDebugState,
  type CockpitMfdEvidence,
  type CockpitState,
} from '../render/CockpitModel.ts';
import { PostFX, type GradeParams } from '../render/PostFX.ts';
import { Trail } from '../render/Trail.ts';
import { createLightingUniforms } from '../render/lighting.ts';
import { Input, type FlightCommand } from '../core/Input.ts';
import {
  SettingsStore,
  qualityProfile,
  readBestSplits,
  readBestTime,
  writeBestTime,
  type QualityProfile,
} from '../core/Settings.ts';
import { AudioEngine, createUiAudio } from '../audio/index.ts';
import { Overlay } from '../ui/index.ts';
import type { CampaignViewModel } from '../ui/Screens.ts';
import {
  createTranslator,
  LocaleStore,
  prepareLocaleFonts,
  writeLocaleHandoff,
  type LocaleFontPreparation,
  type LocaleFontResult,
  type Translator,
} from '../i18n/index.ts';
import { FILL_BUDGET_PIXELS, FLIGHT, FLIGHT_THRESHOLDS } from '../core/art.ts';
import { clamp, clamp01, damp, lerp, smoothstep, distanceToSegment } from '../core/mathx.ts';
import {
  type CourseDefinition,
} from '../core/Courses.ts';
import { hasRadioSafeWindow, radioDurationSeconds } from '../core/RadioSchedule.ts';
import { CAIRN_MISSION, type MissionDefinition } from '../core/Missions.ts';
import { buildMissionUrl, type MissionResolution } from '../core/MissionSelection.ts';
import { ProgressStore } from '../core/Progress.ts';
import {
  createGameMissionRuntime,
  type GameMissionRuntimeFactory,
  type MissionRewardEvent,
  type MissionRuntime,
  type MissionWeaponEvent,
  type WorldContact,
} from './MissionRuntime.ts';
import {
  buildCampaignViewModel,
  consumeMissionFrameEvents,
  resolveAutopilotButton,
} from './GameContracts.ts';
import { createCairnMissionRuntime } from './CairnRuntime.ts';
import { playDeadSignalWeaponFeedback } from './missions/DeadSignalAudio.ts';
import type {
  AudioBus,
  CameraMode,
  Callout,
  CalloutSubMessage,
  CalloutTitleMessage,
  GateAccuracy,
  LogLine,
  LogMessage,
  Locale,
  Phase,
  MissionResult,
  Settings,
  Telemetry,
  UiAudioBus,
} from '../core/contracts.ts';
import type {
  GatePassRecord,
  HarnessInput,
  HarnessLocaleState,
  HarnessPose,
  HarnessStageLandmarkState,
  HarnessShipVisualDebugState,
  HazardReport,
  PerfSample,
} from '../core/harness.ts';

/**
 * The game. Owns the render graph, the simulation, the phase machine and the automation
 * surface.
 *
 * Rendering is split across two scenes with two cameras. The far scene holds the nebula, the
 * stars, ACHRA and VESPER, and is drawn with a camera that only ever *rotates* — so those
 * bodies sit at effectively infinite distance and never suffer depth precision problems. The
 * near scene holds everything the player can actually reach. Clearing depth between the two
 * gives an unbounded apparent world with a 90 km depth range, which is what lets a gas giant
 * and a 40 cm hull panel share a frame without z-fighting.
 */

/** Public telemetry keeps canonical English regardless of the active run locale. */
const LEGACY_ENGLISH = createTranslator('en');

const POINTER_LOCK_TITLE_MESSAGE: CalloutTitleMessage = Object.freeze({
  type: 'callout-title.pointer-lock-unavailable',
});
const KEYBOARD_FLIGHT_MESSAGE: CalloutSubMessage = Object.freeze({
  type: 'callout-sub.keyboard-flight-available',
});
const CAMERA_TITLE_MESSAGES: Readonly<Record<CameraMode, CalloutTitleMessage>> = Object.freeze({
  cockpit: Object.freeze({ type: 'callout-title.camera-view', mode: 'cockpit' }),
  'far-chase': Object.freeze({ type: 'callout-title.camera-view', mode: 'far-chase' }),
  chase: Object.freeze({ type: 'callout-title.camera-view', mode: 'chase' }),
});
const CAMERA_SUB_MESSAGES: Readonly<Record<CameraMode, CalloutSubMessage>> = Object.freeze({
  cockpit: Object.freeze({ type: 'callout-sub.camera-active', mode: 'cockpit' }),
  'far-chase': Object.freeze({ type: 'callout-sub.camera-active', mode: 'far-chase' }),
  chase: Object.freeze({ type: 'callout-sub.camera-active', mode: 'chase' }),
});
const NEXT_CAMERA_MODE: Readonly<Record<CameraMode, CameraMode>> = Object.freeze({
  chase: 'cockpit',
  cockpit: 'far-chase',
  'far-chase': 'chase',
});
const ENGAGE_MESSAGE: CalloutTitleMessage = Object.freeze({ type: 'callout-title.engage' });
const HULL_IMPACT_MESSAGE: CalloutTitleMessage = Object.freeze({ type: 'callout-title.hull-impact' });
const BOOST_DEPLETED_MESSAGE: CalloutTitleMessage = Object.freeze({
  type: 'callout-title.boost-depleted',
});
const BOOST_RECHARGING_MESSAGE: CalloutSubMessage = Object.freeze({
  type: 'callout-sub.boost-recharging',
});
const BOOST_DEPLETED_LOG_MESSAGE: LogMessage = Object.freeze({ type: 'log.boost-depleted' });
const GATE_ACCURACY_MESSAGES: Readonly<Record<GateAccuracy, CalloutTitleMessage>> = Object.freeze({
  'dead-centre': Object.freeze({
    type: 'callout-title.gate-cleared',
    accuracy: 'dead-centre',
  }),
  clean: Object.freeze({ type: 'callout-title.gate-cleared', accuracy: 'clean' }),
  cleared: Object.freeze({ type: 'callout-title.gate-cleared', accuracy: 'cleared' }),
});
const GATE_MISSED_MESSAGE: CalloutTitleMessage = Object.freeze({
  type: 'callout-title.gate-missed',
});
const GATE_SHEAR_BLOCKED_MESSAGE: CalloutTitleMessage = Object.freeze({
  type: 'callout-title.gate-missed',
  blockedBy: 'shear',
});
const GATE_REALIGN_MESSAGE: CalloutSubMessage = Object.freeze({
  type: 'callout-sub.gate-realign',
});
const GATE_SHEAR_WINDOW_MESSAGE: CalloutSubMessage = Object.freeze({
  type: 'callout-sub.gate-shear-window',
});

interface CalloutSpec {
  titleMessage: CalloutTitleMessage;
  sub: string | undefined;
  subMessage: CalloutSubMessage | undefined;
  tone: Callout['tone'];
  ttl: number;
}

interface LogSpec {
  message: LogMessage;
  tone: LogLine['tone'];
}

/** Shader precompilation is optional polish; a slow or unsupported driver must still boot. */
const COCKPIT_PREWARM_TIMEOUT_MS = 1500;
const COCKPIT_PREWARM_POLL_MS = 10;

interface ShaderProgramReadiness {
  isReady(): boolean;
}

const hasShaderProgramReadiness = (value: unknown): value is ShaderProgramReadiness =>
  typeof (value as { isReady?: unknown } | null)?.isReady === 'function';

/** No thrust or control authority after a hull breach; inertia and tumble still integrate. */
const FAILURE_DRIFT_COMMAND: FlightCommand = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0,
  strafeX: 0,
  strafeY: 0,
  fire: false,
  boost: false,
  brake: false,
  stickX: 0,
  stickY: 0,
};

interface Vantage {
  name: string;
  /** Normalised course position the camera is anchored to. */
  t: number;
  offset: THREE.Vector3;
  /** Metres ahead of the ship the camera aims at. Small values frame the ship itself. */
  lookAhead: number;
  fov: number;
  /**
   * When set, the ship is parked on this gate's approach axis at `gateStandoff` metres and
   * the camera looks straight down the aperture. Hand-authored offsets drift out of frame the
   * moment the course layout changes; anchoring to the actual object never does.
   */
  gateIndex?: number;
  gateStandoff?: number;
  /**
   * Multiplier on the frame exposure while this vantage is active.
   *
   * An authored still is not a gameplay frame. Gameplay is graded so the HUD stays legible over
   * a moving image; a store-page frame needs a dark anchor, a broad midtone shelf and a small
   * hot accent. Eight of ten of these had the anchor and the accent and nothing between — one
   * put 89.2% of the frame below 0.18, and the committed screenshot suite now fails on exactly
   * that. Per-vantage, because how dark a vantage is depends entirely on where it points.
   *
   * Re-fitted after the vantage-camera aliasing bug was found: the first set of values was tuned
   * against frames whose camera had been thrown 4.5 Mm off, so they were compensating for empty
   * sky rather than grading a composition. Five of the ten were substantially wrong.
   */
  exposureBias?: number;
  /** When set, frames the terminus instead. */
  terminusStandoff?: number;
}

export interface GameOptions {
  root: HTMLElement;
  missionDefinition?: MissionDefinition;
  missionResolution?: MissionResolution;
  missionRuntimeFactory?: GameMissionRuntimeFactory;
  progressStore?: ProgressStore;
  localeStore?: LocaleStore;
  fonts?: {
    result: LocaleFontResult;
    settled: Promise<LocaleFontResult>;
    cancel(): void;
  };
  seed?: number;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly settings: SettingsStore;
  readonly audio: AudioBus;

  private readonly root: HTMLElement;
  private readonly localeStore: LocaleStore;
  private overlay: Overlay;
  private selectedLocale: Locale;
  private activeRunLocale: Locale | null = null;
  private activeTranslator: Translator;
  private fontResult: LocaleFontResult;
  private fontGeneration = 0;
  private fontPreparation: Pick<LocaleFontPreparation, 'cancel'> | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly farScene = new THREE.Scene();
  private readonly mainScene = new THREE.Scene();
  private readonly farCamera: THREE.PerspectiveCamera;
  private readonly chase: ChaseCamera;
  private readonly post: PostFX;
  private readonly input: Input;

  // ACHRA sits ahead, high and to port of the opening heading. Putting the key light in
  // front of the player is what buys backlit rock silhouettes, visible shafts and a rim on
  // every gate; with the star behind the camera the whole sector renders flat and frontal.
  private readonly lighting: ReturnType<typeof createLightingUniforms>;
  private readonly missionDefinition: MissionDefinition;
  private readonly courseDefinition: CourseDefinition;
  private readonly missionResolution: MissionResolution;
  private readonly progressStore: ProgressStore;
  private newlyUnlockedMissionId: MissionDefinition['id'] | null = null;
  private campaignNavigationError: CampaignViewModel['navigationError'] = null;
  private readonly mission: MissionRuntime;
  private readonly ship = new Ship();
  private readonly shipModel: ShipModel;
  private readonly cockpitModel: CockpitModel;
  private readonly shipRoot = new THREE.Group();
  private readonly shipMeshHolder = new THREE.Group();
  private readonly trails: Trail[] = [];

  private phase: Phase = 'boot';
  private elapsed = 0;
  private clock = 0;
  /** Ship-local visual time freezes with pause while the background scene keeps breathing. */
  private shipVisualClock = 0;
  private countdown: number | null = null;
  private countdownTimer = 0;
  /** Cancels the lingering GO card without letting an old run hide a new countdown. */
  private countdownClearTimer: number | null = null;
  private result: MissionResult | null = null;
  private topSpeed = 0;
  private impacts = 0;
  /** -1 = not triggered, -2 = emitted/deferred; non-negative = run-time trigger second. */
  private readonly radioTriggeredAt = [-1, -1, -1, -1, -1];
  private radioBusyUntil = 0;
  private radioEndPending = false;
  private fade = 0;
  private fadeTarget = 1;
  private damageFlash = 0;
  private proximity = 0;
  private cinematicTime = 0;
  private boostBlend = 0;
  private wasBoosting = false;
  private wasBoostLocked = false;
  private gateTickTimer = 0;
  private readonly rewardEvents: MissionRewardEvent[] = [];
  private readonly weaponEvents: MissionWeaponEvent[] = [];

  private autopilot = false;
  private autopilotSkill = 1;
  private harnessInput: HarnessInput | null = null;
  private fixedTimestep: number | null = null;
  private paused = false;
  private cinematic = false;
  private activeVantage: Vantage | null = null;
  private readonly gateHistory: GatePassRecord[] = [];
  /** Exposure multiplier from the active vantage; 1 during normal play. */
  private vantageExposure = 1;
  /** Title-camera offset in the ship's frame; see updateCinematicCamera. */
  private readonly cinematicOffset = new THREE.Vector3(0, 9, 46);
  private readonly uiAudio: UiAudioBus;
  /** Removes the one-shot audio-unlock listeners if the game is disposed before any gesture. */
  private readonly releaseUnlock: () => void;
  private readonly errors: string[] = [];

  private frameTimes: number[] = [];
  private fps = 60;
  private fpsAccumulator = 0;
  private fpsFrames = 0;

  /**
   * Adaptive resolution. The internal buffer is scaled to hold the frame budget while the
   * canvas stays at native size — the only honest way to promise a smooth frame on hardware
   * you cannot see. The player's renderScale setting is the *ceiling*, not the value.
   */
  /** Throttle cap for the attract flight. See driveAutopilot. */
  private static readonly ATTRACT_THROTTLE = 0.55;
  private dynamicScale = 1;
  private allocWidth = 1;
  private allocHeight = 1;
  private adaptAccumulator = 0;
  private adaptFrames = 0;
  private adaptCooldown = 0;
  private adaptLongFrames = 0;
  private adaptSettle = 0;
  /**
   * Recent clean window means, newest last — the estimate of the display's paced interval is
   * their minimum. A rolling window rather than a session minimum, because a session minimum can
   * only fall: drag the window from a 60 Hz monitor to a 50 Hz one and a permanent 16.7 estimate
   * re-pins the controller at the floor on the new display, which is the exact defect this
   * estimator exists to fix. Only windows with zero long frames and a plausible mean feed it, so
   * a boot clock skew or a tab-return hitch cannot poison the estimate.
   */
  private adaptRecentMs: number[] = [];
  /** A dynamicScale change waiting to be applied at the next frame START. See frame(). */
  private pendingScaleApply = false;
  /** Pending debounced shrink from a window drag. See handleResize. */
  private resizeSettleTimer: number | null = null;
  /** Exact stable world-contact list consumed by the last common collision pass. */
  private lastCollisionContacts: readonly WorldContact[] | null = null;
  /** Long-frame threshold in ms, refresh-relative; starts lenient until a clean window lands. */
  private adaptLongMs = 25.7;
  private adaptWinMinMs = Infinity;
  private adaptWinMaxMs = 0;
  private adaptWindowCount = 0;
  private lastRenderScaleCeiling = 1;

  private readonly telemetry: Telemetry;
  private calloutId = 0;
  private logId = 0;
  private readonly logLines: LogLine[] = [];

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler();
  private readonly missionForward = new THREE.Vector3();
  private readonly onWorldContact = (
    _contact: WorldContact,
    penetration: number,
    severity: number,
  ): void => {
    this.handleWorldContact(penetration, severity);
  };
  /** Dedicated heading scratch so cockpit gate alignment cannot alias another visual calculation. */
  private readonly cockpitForward = new THREE.Vector3();
  /** Reused every frame: the cockpit reacts to flight state without adding per-frame garbage. */
  private readonly cockpitState: CockpitState = {
    dt: 0,
    speed: 0,
    speed01: 0,
    throttle: 0,
    energy: 1,
    hull: 1,
    proximity: 0,
    impact: 0,
    alignment: 1,
    pitch: 0,
    yaw: 0,
    roll: 0,
    boost: 0,
    brake: false,
  };
  private readonly sunScreen = new THREE.Vector2(0.5, 0.5);
  private readonly blurCentre = new THREE.Vector2(0.5, 0.5);
  private readonly grade: GradeParams;

  private readonly vantages: Vantage[] = [];
  private disposed = false;
  private contextLost = false;
  private frameFailures = 0;
  /** Cancels the loader-only shader readiness poll before renderer/material disposal. */
  private cancelCockpitPrewarm: (() => void) | null = null;
  private firstFrameResolve: (() => void) | null = null;
  private readonly firstFrame: Promise<void>;

  constructor(options: GameOptions) {
    this.root = options.root;
    this.missionDefinition = options.missionDefinition ?? CAIRN_MISSION;
    this.courseDefinition = this.missionDefinition.world.sourceCourse;
    this.missionResolution = options.missionResolution ?? {
      missionId: this.missionDefinition.id,
      source: 'default',
      diagnostic: null,
    };
    this.progressStore = options.progressStore ?? new ProgressStore();
    const sun = this.courseDefinition.world.sunDirection;
    this.lighting = createLightingUniforms(new THREE.Vector3(sun[0], sun[1], sun[2]));
    this.localeStore = options.localeStore ?? new LocaleStore();
    this.selectedLocale = this.localeStore.get();
    this.activeTranslator = createTranslator(this.selectedLocale);
    this.applyDocumentLocale(this.activeTranslator);
    const bootstrapFonts = options.fonts;
    if (bootstrapFonts?.result.locale === this.selectedLocale) {
      this.fontResult = bootstrapFonts.result;
      this.fontPreparation = bootstrapFonts;
      this.observeFontResult(bootstrapFonts.settled, this.fontGeneration);
    } else {
      bootstrapFonts?.cancel();
      this.fontResult = this.pendingFontResult(this.selectedLocale);
      const preparation = prepareLocaleFonts(this.selectedLocale);
      this.fontPreparation = preparation;
      this.observeFontPreparation(preparation, this.fontGeneration);
    }

    const seed = options.seed ?? this.missionDefinition.defaultSeed;
    this.seed = seed;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lv-canvas';
    this.root.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;

    this.settings = new SettingsStore();
    const profile = this.settings.profile;

    this.post = new PostFX(this.renderer, profile);
    this.chase = new ChaseCamera(1);
    this.chase.baseFov = this.settings.value.fov;
    this.farCamera = new THREE.PerspectiveCamera(this.settings.value.fov, 1, 1, 260);

    // The selected factory is the sole world constructor. A non-CAIRN mission never allocates or
    // adds the shipped CAIRN world, which keeps page-load resources inside one mission budget.
    const maxProfile = qualityProfile('ultra');
    this.mission = createGameMissionRuntime({
      definition: this.missionDefinition,
      seed,
      renderer: this.renderer,
      farScene: this.farScene,
      mainScene: this.mainScene,
      lighting: this.lighting,
      initialQuality: profile,
      maximumQuality: maxProfile,
    }, options.missionRuntimeFactory ?? createCairnMissionRuntime);

    this.shipModel = new ShipModel({ lighting: this.lighting });
    this.shipMeshHolder.add(this.shipModel.object);
    this.shipRoot.add(this.shipMeshHolder);
    this.mainScene.add(this.shipRoot);

    this.cockpitModel = new CockpitModel(
      this.selectedLocale,
      this.activeTranslator,
      this.isCockpitFontReady(this.selectedLocale),
    );
    this.mainScene.add(this.cockpitModel.object);

    // Trails live in world space rather than under the ship, because the whole point of them
    // is that they stay where the ship *was*.
    for (let i = 0; i < this.shipModel.nozzles.length; i++) {
      const trail = new Trail({
        capacity: 56,
        width: 0.3,
        nearColor: new THREE.Color(0xbfeaff),
        farColor: new THREE.Color(0x2f6cff),
      });
      this.trails.push(trail);
      this.mainScene.add(trail.object);
    }

    // --- input, ui, audio -------------------------------------------------------------
    this.input = new Input(this.canvas, {
      fireEnabled: this.missionDefinition.capabilities.includes('fire'),
    });
    this.input.onLockChange = (locked) => this.overlay.setPointerLocked(locked);
    this.input.onLockError = (reason) => {
      // Surfaced, not swallowed: a mouse that does nothing with no explanation is worse than
      // no mouse flight at all, and the player needs to be told the keyboard still flies.
      //
      // Deliberately NOT pushed into `this.errors`. That array is the game's error boundary and
      // the runtime suite asserts it stays empty; a browser declining an optional capability is
      // not a game fault, and filing it there turned an expected headless condition into a red
      // suite. Observable to a test through telemetry instead.
      this.telemetry.pointerLockRefused = true;
      this.pushCallout({
        titleMessage: POINTER_LOCK_TITLE_MESSAGE,
        sub: undefined,
        subMessage: KEYBOARD_FLIGHT_MESSAGE,
        tone: 'bad',
        ttl: 4.5,
      });
      this.pushLog({
        message: { type: 'log.pointer-lock-refused', reason },
        tone: 'bad',
      });
    };
    this.input.onAction = (action) => {
      if (
        action === 'restart' &&
        (this.phase === 'flying' || this.phase === 'failed' || this.phase === 'finished')
      ) {
        this.restart();
      }
      if (action === 'view' && !this.paused && (this.phase === 'flying' || this.phase === 'countdown')) {
        const next = NEXT_CAMERA_MODE[this.settings.value.cameraMode];
        this.settings.set('cameraMode', next);
        // Keep the public camera contract synchronous with the key action. The pose itself is
        // resolved in updateVisuals, but projection state (notably the cockpit near plane) must
        // not report the previous mode for a driven frame after the persisted setting has moved.
        if (this.activeVantage === null && !this.cinematic) this.chase.setCameraMode(next);
        this.pushCallout({
          titleMessage: CAMERA_TITLE_MESSAGES[next],
          sub: undefined,
          subMessage: CAMERA_SUB_MESSAGES[next],
          tone: 'neutral',
          ttl: 1.1,
        });
      }
    };

    this.audio = new AudioEngine();
    this.uiAudio = createUiAudio(this.audio);
    // Unlock on the first gesture anywhere, not behind START. The whole front end was silent on
    // first load — title, attract flight, briefing, every settings interaction — because the
    // only unlock call site was inside beginRun, and four synths were unreachable as a result.
    // Capture phase, so it runs before anything can stop propagation.
    const unlock = (): void => {
      this.uiAudio.unlock();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    this.releaseUnlock = unlock;
    /* ORDERING DEPENDENCY, stated because nothing else states it: these two listeners must be
       registered BEFORE the Overlay below adds its own capture-phase keydown. AudioEngine.play()
       and update() drop everything until unlock() has run, and unlock() sets its flag
       synchronously — so on a keyboard first-gesture the unlock listener must fire first or the
       overlay's own key handling would produce a UI cue into a still-locked engine and lose it.
       Moving the Overlay construction above this block would reintroduce that swallow silently,
       on the keyboard path only. */

    this.overlay = this.createOverlay(this.activeTranslator);
    this.overlay.syncCampaign(this.campaignViewModel());

    this.telemetry = this.createTelemetry();
    this.grade = {
      exposure: 1,
      contrast: 1.05,
      saturation: 1.07,
      bloomStrength: profile.bloomStrength,
      godrayStrength: 0.85,
      sunScreen: this.sunScreen,
      sunVisible: 0,
      blurCentre: this.blurCentre,
      blurStrength: 0,
      aberration: 0,
      warp: 0,
      vignette: 0.85,
      grain: 0.035,
      damage: 0,
      fade: 0,
      time: 0,
    };

    this.buildVantages();
    this.resetShipToStart();
    this.chase.snapTo(this.ship);

    this.settings.subscribe((s) => this.onSettingsChanged(s));
    this.onSettingsChanged(this.settings.value);
    this.applyQualityPopulations();

    // A lost context is not recoverable without rebuilding every buffer, program and target in
    // the renderer. Rather than pretend, the game stops cleanly and says so: a frozen or
    // black canvas with no explanation is the worst possible outcome for the player.
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('error', this.handleError);
    window.addEventListener('unhandledrejection', this.handleRejection);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.handleResize();

    this.firstFrame = new Promise<void>((resolve) => {
      this.firstFrameResolve = resolve;
    });

    this.setPhase('title');
    this.cinematic = true;
    this.autopilot = true;
  }

  private createOverlay(translator: Translator): Overlay {
    return new Overlay(this.root, {
      // BEGIN RUN opens the briefing; ENGAGE inside it starts the run. The briefing panel and
      // its control primer were fully built and mapped but nothing ever routed to them, so the
      // game never told a player that the mouse steers, that SHIFT boosts or that SPACE brakes —
      // the two verbs it is actually about — against an 82 s-vs-129 s skill gap.
      audio: this.uiAudio,
      start: () => this.toBriefing(),
      engage: () => this.beginRun(),
      restart: () => this.restart(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      quitToTitle: () => this.toTitle(),
      selectMission: (missionId) => this.selectMission(missionId),
      showMissionSelect: () => this.showMissionSelect(),
      requestLocale: (locale) => this.applyLocale(locale),
      setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => this.applySetting(key, value),
      getSettings: () => this.settings.value,
    }, translator);
  }

  private replaceOverlay(translator: Translator): void {
    const phase = this.phase;
    const countdown = this.countdown;
    const pointerLocked = this.input.pointerLocked;
    const telemetry = this.telemetry;
    const focus = this.overlay.captureFocusToken();

    this.overlay.dispose();
    this.overlay = this.createOverlay(translator);
    this.overlay.syncCampaign(this.campaignViewModel());
    // Hydrate directly: Game.setPhase has a same-phase guard and would leave every new view closed.
    this.overlay.setPhase(phase);
    this.overlay.setCountdown(countdown);
    this.overlay.setPointerLocked(pointerLocked);
    this.overlay.update(telemetry, 0);
    this.overlay.restoreFocusToken(focus);
  }

  private selectMission(missionId: MissionDefinition['id']): void {
    if (missionId === this.missionDefinition.id) {
      this.showMissionSelect();
      return;
    }

    const selected = this.progressStore.selectMission(missionId);
    if (!selected.accepted) return;
    if (!selected.persistence.reloadSafe) {
      this.campaignNavigationError = 'storage-unavailable';
      this.overlay.syncCampaign(this.campaignViewModel());
      return;
    }

    const locale = this.activeRunLocale ?? this.selectedLocale;
    writeLocaleHandoff(locale);
    const target = new URL(buildMissionUrl(window.location.href, missionId));
    if (this.phase === 'finished') target.searchParams.set('briefing', '1');
    else target.searchParams.delete('briefing');
    try {
      window.location.assign(target.href);
    } catch {
      this.campaignNavigationError = 'navigation-failed';
      this.overlay.syncCampaign(this.campaignViewModel());
    }
  }

  private showMissionSelect(): void {
    // NEXT STAGE reloads with `briefing=1`. Returning to the stage rail must consume that
    // one-shot boot instruction or a later refresh jumps straight back into briefing.
    const url = new URL(window.location.href);
    if (url.searchParams.has('briefing')) {
      url.searchParams.delete('briefing');
      try {
        window.history.replaceState(window.history.state, '', url.href);
      } catch {
        this.campaignNavigationError = 'navigation-failed';
      }
    }
    this.toTitle();
    this.overlay.syncCampaign(this.campaignViewModel());
    this.overlay.focusStageSelection();
  }

  private campaignViewModel(): CampaignViewModel {
    return buildCampaignViewModel(
      this.progressStore.snapshot(),
      this.missionDefinition.id,
      this.newlyUnlockedMissionId,
      this.campaignNavigationError,
    );
  }

  private applyLocale(locale: Locale): void {
    if (this.phase !== 'title') return;
    this.localeStore.set(locale);
    const changed = locale !== this.selectedLocale;
    this.selectedLocale = locale;
    this.activeTranslator = createTranslator(locale);
    this.applyDocumentLocale(this.activeTranslator);
    if (changed) {
      this.fontGeneration += 1;
      this.fontPreparation?.cancel();
      this.fontResult = this.pendingFontResult(locale);
      const preparation = prepareLocaleFonts(locale);
      this.fontPreparation = preparation;
      this.observeFontPreparation(preparation, this.fontGeneration);
      this.replaceOverlay(this.activeTranslator);
      this.syncCockpitLocale();
    }
  }

  private pendingFontResult(locale: Locale): LocaleFontResult {
    return locale === 'en'
      ? { locale, status: 'not-required' }
      : { locale, status: 'fallback' };
  }

  private observeFontPreparation(
    preparation: LocaleFontPreparation,
    generation: number,
  ): void {
    this.observeFontResult(preparation.initial, generation);
    this.observeFontResult(preparation.settled, generation);
  }

  private observeFontResult(
    promise: Promise<LocaleFontResult>,
    generation: number,
  ): void {
    void promise.then(
      (result) => {
        if (generation !== this.fontGeneration
          || result.locale !== this.selectedLocale
          || this.disposed
          || this.contextLost) return;
        this.fontResult = result;
        this.syncCockpitLocale();
      },
      () => {
        // LocaleFontPreparation promises are non-rejecting; observe defensively at this boundary.
      },
    );
  }

  private isCockpitFontReady(locale: Locale): boolean {
    return locale === 'en' || this.fontResult.status === 'ready';
  }

  private syncCockpitLocale(): void {
    const locale = this.activeRunLocale ?? this.selectedLocale;
    this.cockpitModel.setLocale(
      locale,
      this.activeTranslator,
      this.isCockpitFontReady(locale),
    );
  }

  private lockLocaleForRun(): void {
    if (this.activeRunLocale !== null) return;
    this.activeRunLocale = this.selectedLocale;
    this.activeTranslator = createTranslator(this.activeRunLocale);
    this.applyDocumentLocale(this.activeTranslator);
  }

  private applyDocumentLocale(translator: Translator): void {
    document.documentElement.lang = translator.locale;
    document.title = translator.messages.meta.documentTitle;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
      'content',
      translator.messages.meta.documentDescription,
    );
  }

  private unlockLocaleAtTitle(): void {
    this.activeRunLocale = null;
    this.applyLocale(this.localeStore.reload());
  }

  // ---------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------

  private createTelemetry(): Telemetry {
    const guidance = this.mission.objective.guidance(this.mission.path.startPosition);
    return {
      phase: 'boot',
      speed: 0,
      maxSpeed: FLIGHT.maxSpeed,
      throttle: 0,
      boosting: false,
      boostLocked: false,
      energy: 1,
      hull: 1,
      roll: 0,
      pitch: 0,
      gLoad: 0,
      velocityAnchor: { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 },
      gate: {
        index: 0,
        total: guidance.total,
        name: guidance.label,
        nameMessage: guidance.labelMessage,
        distance: 0,
        anchor: { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 },
        alignment: 0,
      },
      guidance: {
        label: guidance.label,
        anchor: { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 },
        distance: 0,
        progress: 0,
        current: 0,
        total: guidance.total,
      },
      objective: this.mission.objective.telemetry(),
      courseRemaining: 0,
      courseTotal: this.mission.path.totalLength,
      elapsed: 0,
      splits: [],
      bestTime: readBestTime(this.mission.recordId(this.seed)),
      bestSplits: readBestSplits(this.mission.recordId(this.seed)),
      courseLength: this.mission.path.totalLength,
      sectorName: this.courseDefinition.text.canonicalSector,
      destinationName: this.courseDefinition.text.canonicalDestination,
      callout: null,
      log: this.logLines,
      proximity: 0,
      impactFlash: 0,
      fps: 60,
    };
  }

  private buildVantages(): void {
    const authored = this.mission.legacy?.vantages();
    if (!authored) return;
    for (const vantage of authored) {
      this.vantages.push({
        ...vantage,
        offset: new THREE.Vector3(...vantage.offset),
      });
    }
  }

  private resetShipToStart(resetWorld = true): void {
    // Title/briefing loops historically rewind moving debris with the ship. Mission resets have
    // already reset their world, so their call sites pass false and avoid doing the same work twice.
    if (resetWorld) this.mission.world.reset();
    this.ship.reset(
      this.mission.path.startPosition,
      this.mission.path.startQuaternion,
      FLIGHT.cruiseSpeed * 0.55,
    );
    // A restart is a new visual run as well as a new physics run. Leaving the smoothed boost
    // value alive made the first countdown frame look like a shutdown transient after restarting
    // during boost, even though Ship.reset() had already cleared the actual engine state.
    this.boostBlend = 0;
    this.wasBoosting = false;
    this.wasBoostLocked = false;
    this.gateTickTimer = 0;
    this.shipModel.resetPlumeState(this.shipVisualClock);
    this.shipRoot.position.copy(this.ship.position);
    this.shipRoot.quaternion.copy(this.ship.quaternion);
    for (const trail of this.trails) trail.reset();
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.telemetry.phase = phase;
    this.overlay.setPhase(phase);
  }

  private cancelCountdownClear(): void {
    if (this.countdownClearTimer === null) return;
    window.clearTimeout(this.countdownClearTimer);
    this.countdownClearTimer = null;
  }

  /**
   * @param skipIntro jump straight to flying instead of running the three-second countdown.
   *   The interface never passes this; it exists so an unattended playthrough does not spend
   *   three seconds of every run watching numerals.
   */
  beginRun(skipIntro = false): void {
    this.lockLocaleForRun();
    // Clearing this matters the moment any restart affordance is reachable from the pause
    // menu: without it the new run starts already frozen on the countdown.
    this.cancelCountdownClear();
    this.paused = false;
    void this.audio.unlock();
    this.mission.reset();
    this.gateHistory.length = 0;
    this.logLines.length = 0;
    this.resetShipToStart(false);
    this.ship.resetRunContacts();
    this.chase.snapTo(this.ship);
    this.elapsed = 0;
    this.topSpeed = 0;
    this.impacts = 0;
    this.radioTriggeredAt.fill(-1);
    this.radioBusyUntil = 0;
    this.radioEndPending = false;
    this.result = null;
    this.telemetry.splits = [];
    this.telemetry.bestTime = readBestTime(this.mission.recordId(this.seed));
    this.telemetry.bestSplits = readBestSplits(this.mission.recordId(this.seed));
    this.clearPause();
    this.autopilot = false;
    this.cinematic = false;
    this.activeVantage = null;
    this.vantageExposure = 1;
    this.input.reset();
    if (skipIntro) {
      this.countdown = null;
      this.countdownTimer = 0;
      this.overlay.setCountdown(null);
      this.setPhase('flying');
      this.queueRadio(0);
      this.input.requestLock();
      return;
    }
    this.countdown = 3;
    this.countdownTimer = 0;
    this.setPhase('countdown');
    this.overlay.setCountdown(3);
    this.audio.play('countdownTick');
    this.input.requestLock();
  }

  toBriefing(): void {
    this.lockLocaleForRun();
    this.clearPause();
    this.autopilot = true;
    this.cinematic = true;
    this.setPhase('briefing');
  }

  restart(): void {
    this.beginRun();
  }

  /**
   * Pause is requested by the interface layer, which is the only component that knows whether
   * a menu is open. Both methods are idempotent because pointer-lock loss and the Escape key
   * can legitimately arrive in the same frame.
   */
  pause(): void {
    // Countdown counts. Lock is taken during `countdown`, but every recovery path was gated on
    // `flying`, so Esc or a focus steal in that ~3 s window was silently ignored and the run went
    // live and timed with the mouse dead. Worse than a gap: Screens.ts ships the sentence
    // "ESC releases it and holds the flight" and lists ESC -> Pause unconditionally, so the
    // shipped copy was false in that window.
    //
    // Safe because `simulate()` is gated on `!paused` and `countdownTimer` only advances inside
    // it — the countdown freezes behind the menu rather than expiring.
    if (this.paused || (this.phase !== 'flying' && this.phase !== 'countdown')) return;
    this.paused = true;
    this.input.releaseLock();
    // Duck, do not suspend. Suspending freezes the context clock for the whole graph, so every
    // interface cue fired from a menu — including the master-volume slider's own feedback —
    // scheduled into a frozen timeline and never sounded.
    this.audio.menuMix(true);
  }

  /**
   * Leaving the pause state, by any route.
   *
   * RESTART, N and ABORT all left the menu mix latched, because they set `paused = false` directly
   * and never told the audio layer. Filed independently by two disciplines with different
   * harnesses, whose numbers matched to four decimal places.
   */
  private clearPause(): void {
    this.paused = false;
    this.audio.menuMix(false);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.audio.menuMix(false);
    if (this.phase === 'flying' || this.phase === 'countdown') this.input.requestLock();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  toTitle(): void {
    /* clearPause(), not `paused = false`. The pause menu sets sticky mix floors via
       audio.menuMix(true), and only clearPause() and resume() release them — so clearing the flag
       directly left ABORT RUN playing the title screen 13.6 dB down (drive 17.9 dB down),
       indefinitely, until BEGIN RUN jumped it back up. This is the third instance of the class:
       RESTART and N were fixed and the comment above clearPause() claimed ABORT was too. */
    this.clearPause();
    /* Pre-existing, and separate from the duck: aborting a pause taken DURING the countdown left
       the countdown element open over the title screen, because nothing here cleared it. */
    this.cancelCountdownClear();
    this.countdown = null;
    this.overlay.setCountdown(null);
    this.mission.reset();
    this.resetShipToStart(false);
    this.chase.snapTo(this.ship);
    this.elapsed = 0;
    this.autopilot = true;
    this.cinematic = true;
    // Authored vantages are still poses. Keeping one active here made ABORT RUN pin both ship and
    // camera every frame, while a fresh title correctly enters the moving cinematic orbit.
    this.activeVantage = null;
    this.input.releaseLock();
    this.setPhase('title');
    this.unlockLocaleAtTitle();
  }

  // ---------------------------------------------------------------------------------
  // frame
  // ---------------------------------------------------------------------------------

  /** Advances simulation and renders one frame. Called by the rAF loop and by the harness. */
  frame(rawDt: number): void {
    if (this.disposed || this.contextLost) return;
    /* Scale changes land HERE, never mid-frame. In live play the distinction is invisible — the
       controller runs inside the frame anyway — but a harness-driven capture steps and presents
       as separate calls, and a viewport move landing between them presented frames whose bloom
       chain read margins the renderer never wrote: catastrophic, reproducible corruption in 2 of
       10 authored vantages, invisible to every numeric bar the screenshot suite has. Live mode
       measured clean across a 915-frame screencast precisely because it applies at frame start;
       driven mode now mirrors it. */
    if (this.pendingScaleApply) {
      this.pendingScaleApply = false;
      this.applyRenderScale();
    }
    const dt = this.fixedTimestep ?? clamp(rawDt, 0.0005, 0.05);
    this.clock += dt;
    if (!this.paused) this.shipVisualClock += dt;
    this.grade.time = this.clock;

    this.fpsAccumulator += rawDt;
    this.fpsFrames++;
    if (this.fpsAccumulator >= 0.35) {
      this.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
    if (!this.driven) this.adaptResolution(rawDt);
    if (this.frameTimes.length < 6000) this.frameTimes.push(rawDt * 1000);

    if (!this.paused) this.simulate(dt);
    this.updateVisuals(dt);
    this.render();

    if (this.firstFrameResolve) {
      const resolve = this.firstFrameResolve;
      this.firstFrameResolve = null;
      resolve();
    }
  }

  /**
   * Harness-only deterministic physics stepping.
   *
   * A 120 Hz course proof should exercise the production simulation, collision and progression
   * path, but rendering every intermediate half-frame turns a one-minute route into a ten-minute
   * SwiftShader job. Visual and GPU behaviour have their own focused gates, so this advances the
   * same `simulate()` method without intermediate draws and synchronises the scene/telemetry
   * state once at the end. Live play and the normal `step()` contract remain unchanged.
   */
  stepSimulation(frames: number, rawDt = 1 / 60): void {
    if (this.disposed || this.contextLost || this.paused) return;
    const count = Math.max(0, Math.trunc(Number.isFinite(frames) ? frames : 0));
    const dt = clamp(Number.isFinite(rawDt) ? rawDt : 1 / 60, 0.0005, 0.05);
    for (let i = 0; i < count; i++) {
      this.clock += dt;
      this.shipVisualClock += dt;
      this.grade.time = this.clock;
      this.simulate(dt);
      if (this.phase === 'finished' || this.phase === 'failed') break;
    }
    this.updateVisuals(dt);
  }

  /**
   * Moves the internal resolution toward the frame budget. Deliberately slow and asymmetric:
   * it drops quickly when the frame is over budget and creeps back up when there is comfort,
   * so a single hitch never causes a visible resolution oscillation.
   */
  private adaptResolution(rawDt: number): void {
    if (this.adaptSettle > 0) {
      this.adaptSettle--;
      return;
    }
    /* A stall is not pixel-load evidence. Unclamped, a single >1 s main-thread hitch (a tab
       switch, a GC pause, a debugger) polluted one window's mean enough to cost a measured
       -0.12 scale step and ~3 s of recovery — violating this function's own single-hitch
       contract two comments up. Discard the contaminated window entirely: sustained slowness
       still accumulates through ordinary frames, so genuine load keeps dropping the scale. */
    if (rawDt > 0.25) {
      this.adaptAccumulator = 0;
      this.adaptFrames = 0;
      this.adaptLongFrames = 0;
      this.adaptWinMinMs = Infinity;
      this.adaptWinMaxMs = 0;
      return;
    }
    this.adaptAccumulator += rawDt;
    this.adaptFrames++;
    if (rawDt * 1000 > this.adaptLongMs) this.adaptLongFrames++;
    this.adaptWinMinMs = Math.min(this.adaptWinMinMs, rawDt * 1000);
    this.adaptWinMaxMs = Math.max(this.adaptWinMaxMs, rawDt * 1000);
    this.adaptCooldown -= rawDt;
    if (this.adaptFrames < 20 || this.adaptCooldown > 0) return;

    const meanMs = (this.adaptAccumulator / this.adaptFrames) * 1000;
    const missed = this.adaptLongFrames;
    const spreadMs = this.adaptWinMaxMs - this.adaptWinMinMs;
    this.adaptAccumulator = 0;
    this.adaptFrames = 0;
    this.adaptLongFrames = 0;
    this.adaptWinMinMs = Infinity;
    this.adaptWinMaxMs = 0;
    this.adaptWindowCount++;

    const ceiling = this.settings.value.renderScale;
    const floor = 0.58;
    const before = this.dynamicScale;

    // Climbing cannot key off mean frame time. On a vsynced display the mean is pinned at the
    // refresh interval no matter how much headroom there is, so a "< 13.8 ms" condition is
    // unreachable and the scaler became a one-way ratchet: any hitch, including boot, was
    // permanent and the game never rendered at native resolution again.
    //
    // The signal that actually distinguishes "comfortable" from "just barely making it" is
    // whether any frame in the window *missed*. None missed means there is room to climb.
    //
    // Every threshold below is RELATIVE TO THE DISPLAY'S OWN PACE, not to 60 Hz. The fixed
    // constants this replaces (drop > 18.5, climb < 17.6, long > 20.5) all assumed a 16.7 ms
    // refresh, and on any display pacing slower than ~54 Hz the drop condition was permanently
    // true while the climb condition was permanently false: measured on an exact 50 Hz grid,
    // the controller walked to the 0.580 floor and HELD it for the whole 32 s sample — 66.4% of
    // pixels discarded for a measured 0.05 ms of a 19.9 ms frame — because rawDt is presentation
    // cadence, and below budget-miss the cadence belongs to the display, not the GPU.
    //
    // The pace estimate is the minimum of the last twelve CLEAN window means, clamped to
    // [16.0, 20.9] ms: the lower clamp keeps a 120 Hz display from demanding 120 fps, and the
    // upper clamp keeps a machine that has been GPU-bound since boot (33 ms means, never a fast
    // window) from teaching itself that 30 fps is the display's pace and never dropping. A window
    // is clean when it had no long frames and a mean a real display could produce — the first
    // window after boot can carry a clock skew that would otherwise poison the estimate through
    // the lower clamp and re-pin a 50 Hz display at the floor, which was measured, not imagined.
    // At 60 Hz the ratios reproduce the previous constants exactly: 18.5 / 26.0 / 17.6 / 20.5 ms.
    // The estimator's acceptance test must be INDEPENDENT of the pace estimate, or it deadlocks:
    // the first version gated acceptance on `missed === 0`, whose threshold derives from the
    // pace — so one polluted boot window (mean 9.98 ms, measured) dragged the pace to the 16.0
    // clamp, which put the long-frame threshold at 19.7 ms, which marked every exact 20 ms frame
    // as long, which starved the estimator forever, which held the poisoned pace. A display-paced
    // window identifies itself without reference to any threshold: its frame times cluster (small
    // spread) around a rate a real display could run (4-30 ms). The first two windows are skipped
    // outright — boot noise wears every disguise — and the rolling twelve mean one bad acceptance
    // ages out instead of lasting the session.
    if (this.adaptWindowCount > 2 && meanMs >= 4 && meanMs <= 30 && spreadMs <= Math.max(2, meanMs * 0.25)) {
      this.adaptRecentMs.push(meanMs);
      if (this.adaptRecentMs.length > 12) this.adaptRecentMs.shift();
    }
    const paceMs = this.adaptRecentMs.length
      ? Math.min(Math.max(Math.min(...this.adaptRecentMs), 16.0), 20.9)
      : 20.9;
    this.adaptLongMs = paceMs * 1.23;
    if (meanMs > paceMs * 1.11) {
      this.dynamicScale = Math.max(floor, this.dynamicScale - (meanMs > paceMs * 1.56 ? 0.12 : 0.06));
      this.adaptCooldown = 0.35;
    } else if (missed === 0 && meanMs < paceMs * 1.055 && this.dynamicScale < ceiling) {
      this.dynamicScale = Math.min(ceiling, this.dynamicScale + 0.03);
      this.adaptCooldown = 0.8;
    }

    if (Math.abs(this.dynamicScale - before) > 0.001) {
      this.pendingScaleApply = true;
      // Discard the next two frames from the controller's evidence. A scale change still costs
      // one pipeline flush; counting that flush as a long frame is what let the scaler drive
      // itself to the floor and stay there.
      this.adaptSettle = 2;
    }
  }

  private simulate(dt: number): void {
    /* Once failed, do not even sample pilot input for the physics path. The input listeners stay
       alive so N can still reach the restart action, but stick/throttle/gamepad state cannot add
       control authority behind the terminal overlay. */
    const command = this.phase === 'failed' ? FAILURE_DRIFT_COMMAND : this.resolveCommand(dt);

    if (this.phase === 'countdown') {
      this.countdownTimer += dt;
      if (this.countdownTimer >= 1) {
        this.countdownTimer -= 1;
        this.countdown = (this.countdown ?? 1) - 1;
        if (this.countdown !== null && this.countdown > 0) {
          this.overlay.setCountdown(this.countdown);
          this.audio.play('countdownTick');
        } else {
          this.overlay.setCountdown(0);
          this.audio.play('countdownGo');
          this.countdown = null;
          this.setPhase('flying');
          this.pushCallout({
            titleMessage: ENGAGE_MESSAGE,
            sub: this.courseDefinition.text.canonicalDestination,
            subMessage: undefined,
            tone: 'good',
            ttl: 1.6,
          });
          this.queueRadio(0);
          this.cancelCountdownClear();
          this.countdownClearTimer = window.setTimeout(() => {
            this.countdownClearTimer = null;
            /* A restart may already have opened another countdown. Only the run that displayed
               this GO card is allowed to dismiss it. */
            if (this.phase === 'flying' && this.countdown === null) {
              this.overlay.setCountdown(null);
            }
          }, 700);
        }
      }
      // The ship holds a slow cruise through the countdown so the frame is never static.
      this.ship.update(dt, { ...command, throttle: 0.22, boost: false, brake: false });
    } else if (this.phase === 'flying' || this.phase === 'title' || this.phase === 'briefing') {
      this.ship.update(dt, command);
      if (this.phase === 'flying') this.elapsed += dt;
    } else if (this.phase === 'failed') {
      this.ship.update(dt, FAILURE_DRIFT_COMMAND);
    } else {
      this.ship.update(dt, { ...command, throttle: 0.3, boost: false });
    }

    this.topSpeed = Math.max(this.topSpeed, this.ship.speed);
    this.ship.getForward(this.missionForward);
    const missionFrame = this.mission.simulate({
      dt,
      elapsed: this.elapsed,
      body: this.ship,
      forward: this.missionForward,
      fire: command.fire,
      proximityRange: FLIGHT_THRESHOLDS.proximityRange,
      resolveContacts: this.phase !== 'failed',
      resolveObjective: this.phase === 'flying',
      onContact: this.onWorldContact,
    });
    this.lastCollisionContacts = this.mission.world.contacts;
    this.proximity = missionFrame.proximity;

    if (this.phase === 'flying') {
      /* All contacts in this frame have now contributed damage. Resolve the terminal outcome once,
         before course progression, so a lethal strike and terminus crossing in the same frame
         deterministically produce a breach rather than a saved result. */
      if (missionFrame.hullFailed) this.checkFailure();
      if (this.phase === 'flying' && missionFrame.terminal) {
        consumeMissionFrameEvents(
          this.mission,
          missionFrame,
          this.ship,
          this.rewardEvents,
          this.weaponEvents,
        );
        playDeadSignalWeaponFeedback(this.weaponEvents, this.audio);
        const terminal = missionFrame.terminal;
        if (terminal.status === 'failed') this.failObjective(terminal.reason);
        else if (terminal.status === 'succeeded') this.finish();
      }
    } else if (this.phase === 'title' || this.phase === 'briefing') {
      // Keep the title flight looping forever rather than running off the end of the course.
      if (this.ship.position.distanceTo(this.mission.path.startPosition) >
        this.courseDefinition.geometry.gateSpacing * 2.2) {
        this.resetShipToStart();
        this.chase.snapTo(this.ship);
      }
    }

    this.updateProximity(dt);
    this.updateAudio(dt);
  }

  private resolveCommand(dt: number): FlightCommand {
    this.input.setOverride(this.harnessInput);
    const command = this.input.update(dt);
    if (this.autopilot) return this.driveAutopilot(command, dt);
    return command;
  }

  /**
   * Autopilot exists for two reasons: it flies the attract-mode title loop, and it lets the
   * headless harness complete a full run deterministically. It steers with the same command
   * struct a human produces, so it exercises the real flight model rather than a shortcut.
   */
  private driveAutopilot(command: FlightCommand, dt: number): FlightCommand {
    const legacy = this.mission.legacy;
    const target = legacy
      ? legacy.autopilotTarget(
        this.ship.position,
        this.tmpA,
        this.elapsed,
        this.ship.speed,
      )
      : this.mission.objective.guidance(this.ship.position).anchor;
    this.tmpB.copy(target).sub(this.ship.position);
    const distance = this.tmpB.length();
    if (distance < 1e-3) return command;
    this.tmpB.divideScalar(distance);

    // Into ship space: +x right, +y up, -z forward.
    this.tmpQuat.copy(this.ship.quaternion).invert();
    this.tmpC.copy(this.tmpB).applyQuaternion(this.tmpQuat);

    const gain = 2.6 * this.autopilotSkill;
    command.yaw = clamp(this.tmpC.x * gain, -1, 1);
    command.pitch = clamp(this.tmpC.y * gain, -1, 1);

    // Roll so the airframe stays level against world up; purely for how it looks on camera.
    this.tmpA.set(0, 1, 0).applyQuaternion(this.tmpQuat);
    command.roll = clamp(-this.tmpA.x * 1.4, -1, 1);

    const alignment = clamp01(-this.tmpC.z);
    // Ease off the throttle when badly misaligned so the AI does not overshoot every gate.
    command.throttle = lerp(0.42, 1, Math.pow(alignment, 2.2));
    // The attract loop cruises. It used to fly at the same near-redline throttle a timed run
    // does, which is both implausible — an attract camera shows a ship cruising, not one at 95%
    // with nobody aboard — and the reason the interface cues sit on a razor over it: the engine
    // bed at throttle 0.95 measures -23.09 LUFS-S against -29.31 at cruise, so every UI margin on
    // the title screen was paying 6.2 dB for a number nothing needed.
    //
    // Fixing the loudness at its source rather than ducking it downstream: no menu mix at the
    // title, no new contract surface, and uiClick goes from +0.5 dB over the bed to about +6.7.
    if (this.cinematic) command.throttle = Math.min(command.throttle, Game.ATTRACT_THROTTLE);
    const controls = legacy?.autopilotControls({
      position: this.ship.position,
      speed: this.ship.speed,
      energy: this.ship.energy01,
      skill: this.autopilotSkill,
      alignment,
      targetDistance: distance,
    });
    // Generic runtimes may use the shared autopilot with independent player buttons. Preserve
    // those only during active flight; title/briefing attract input remains deliberately neutral.
    const preserveGenericButtons = legacy === null && this.phase === 'flying';
    command.brake = resolveAutopilotButton(
      controls?.brake,
      command.brake,
      preserveGenericButtons,
    );
    command.boost = resolveAutopilotButton(
      controls?.boost,
      command.boost,
      preserveGenericButtons,
    );
    command.strafeX = 0;
    command.strafeY = 0;
    void dt;
    return command;
  }

  private handleWorldContact(penetration: number, severity: number): void {
    if (penetration < this.ship.radius * 0.6) {
      this.audio.play('scrape', clamp01(penetration / (this.ship.radius * 0.6)));
    }
    if (severity > 0.02) {
      this.impacts++;
      this.damageFlash = Math.min(1, this.damageFlash + severity * 1.4 + 0.2);
      this.audio.play('impact', severity);
      if (severity > 0.25) {
        this.pushCallout({
          titleMessage: HULL_IMPACT_MESSAGE,
          sub: undefined,
          subMessage: undefined,
          tone: 'bad',
          ttl: 1.1,
        });
      }
      this.pushLog({
        message: { type: 'log.hull-contact', percent: Math.round(severity * 100) },
        tone: 'bad',
      });
    }
  }

  private updateProximity(dt: number): void {
    // Short: an impact should punch and clear, not linger over the next four seconds.
    this.damageFlash = damp(this.damageFlash, 0, 0.16, dt);
    if (this.proximity > 0.72 && this.phase === 'flying') {
      if (Math.floor(this.clock * 3) !== Math.floor((this.clock - dt) * 3)) {
        this.audio.play('warnProximity', this.proximity);
      }
    }
  }

  private failObjective(reason: string): void {
    if (this.phase !== 'flying') return;
    this.autopilot = false;
    this.result = null;
    this.cancelCountdownClear();
    this.overlay.setCountdown(null);
    this.setPhase('failed');
    this.overlay.showFailure(this.elapsed, reason);
    this.input.releaseLock();
  }

  private checkFailure(): void {
    if (this.phase !== 'flying' || this.ship.hull > 0) return;
    this.autopilot = false;
    this.result = null;
    this.cancelCountdownClear();
    this.overlay.setCountdown(null);
    this.setPhase('failed');
    this.overlay.showFailure(this.elapsed);
    this.input.releaseLock();
  }

  private finish(): void {
    if (this.phase !== 'flying') return;
    this.cancelCountdownClear();
    this.overlay.setCountdown(null);
    const recordId = this.mission.recordId(this.seed);
    const splits = [...this.mission.bestRunSplits()];
    const best = readBestTime(recordId);
    const isNewBest = best === null || this.elapsed < best;
    // Read the previous best's splits BEFORE overwriting, so the results screen compares this
    // run against the run it beat rather than against itself.
    const bestSplits = readBestSplits(recordId);
    if (isNewBest) writeBestTime(recordId, this.elapsed, splits);

    const clean = this.impacts === 0;
    this.result = this.mission.buildResult({
      totalTime: this.elapsed,
      hullRemaining: this.ship.hull,
      bestTime: best,
      bestSplits,
      isNewBest,
      topSpeed: this.topSpeed,
      cleanRun: clean,
      cruiseSpeed: FLIGHT.cruiseSpeed,
    });

    const progress = this.progressStore.recordSuccessfulFinish(
      this.missionDefinition.id,
      this.result,
    );
    this.newlyUnlockedMissionId = progress.newlyUnlocked;
    this.result.newlyUnlockedMissionId = progress.newlyUnlocked;
    this.campaignNavigationError = progress.newlyUnlocked !== null && !progress.persistence.reloadSafe
      ? 'storage-unavailable'
      : null;

    this.setPhase('finished');
    this.overlay.syncCampaign(this.campaignViewModel());
    this.overlay.showResult(this.result);
    this.audio.play('finish');
    if (isNewBest) this.audio.play('newBest');
    this.input.releaseLock();
    this.autopilot = true;
  }

  // ---------------------------------------------------------------------------------
  // visuals
  // ---------------------------------------------------------------------------------

  private updateVisuals(dt: number): void {
    const speed01 = this.ship.speed01;
    const boost = this.ship.boosting ? 1 : 0;
    // Boost is a first-class piece of state, not something to reconstruct by dividing another
    // effect's uniform by its own scale factor. Reading it back out of `grade.warp` meant every
    // boost-driven effect — FOV kick, streak length, dust density, plume, trail width, lens warp
    // — was keyed off a value that had already been through two independent smoothers, so it lagged
    // badly and never reached full strength. That is why boost barely deformed the frame.
    if (!this.paused) this.boostBlend = damp(this.boostBlend, boost, 0.16, dt);
    const boostBlend = this.boostBlend;

    this.shipRoot.position.copy(this.ship.position);
    this.shipRoot.quaternion.copy(this.ship.quaternion);
    this.shipMeshHolder.rotation.copy(this.ship.visualLean);

    const cockpitActive =
      this.activeVantage === null && !this.cinematic && this.settings.value.cameraMode === 'cockpit';
    if (this.activeVantage) {
      this.applyVantage(this.activeVantage);
    } else if (this.cinematic) {
      this.updateCinematicCamera(dt);
    } else {
      this.chase.update(dt, this.ship, {
        boost: boostBlend,
        impact: this.damageFlash,
        proximity: this.proximity,
      }, this.settings.value.cameraMode);
    }

    this.cockpitModel.setVisible(cockpitActive);
    if (cockpitActive) {
      // Failure bypasses Input.update(), exactly like the physics path in simulate(). Keep the
      // visible stick/head rig on the command that actually reaches the ship instead of leaving
      // held pre-breach input frozen into the cockpit behind the terminal overlay.
      const command = this.phase === 'failed' ? FAILURE_DRIFT_COMMAND : this.input.command;
      const gate = this.mission.legacy?.currentGate() ?? null;
      this.ship.getForward(this.cockpitForward);
      const state = this.cockpitState;
      state.dt = dt;
      state.speed = this.ship.speed;
      state.speed01 = speed01;
      state.throttle = this.ship.throttleSmoothed;
      state.energy = this.ship.energy01;
      state.hull = this.ship.hull;
      state.proximity = this.proximity;
      state.impact = this.damageFlash;
      state.alignment = gate ? gate.alignment(this.cockpitForward) : 1;
      state.pitch = command.pitch;
      state.yaw = command.yaw;
      state.roll = command.roll;
      state.boost = boostBlend;
      state.brake = command.brake;
      this.cockpitModel.update(this.chase.camera, this.clock, state);
    }

    this.farCamera.quaternion.copy(this.chase.camera.quaternion);
    this.farCamera.fov = this.chase.camera.fov;
    this.farCamera.aspect = this.chase.camera.aspect;
    this.farCamera.updateProjectionMatrix();

    // Rendered height, not allocation height. gl_PointSize is in CURRENT-framebuffer pixels, and
    // the scene renders into a sub-rectangle of the allocation, so deriving the scale from the
    // canvas made every point sprite too large by 1/renderScale whenever the scaler was engaged.
    // Moving the pixel floors past the multiply (last round) fixed the multiply ORDER and left
    // the multiplicand wrong.
    const pixelScale = Math.max(0.6, this.post.renderHeight / 1080);
    const camPos = this.chase.camera.position;
    this.mission.world.updatePresentation({
      dt,
      clock: this.clock,
      runTime: this.elapsed,
      camera: this.chase.camera,
      farCamera: this.farCamera,
      pixelScale,
      viewportHeight: this.post.renderHeight,
      shipPosition: this.ship.position,
      shipVelocity: this.ship.velocity,
      speed01,
      boostBlend,
    });

    this.shipModel.update(
      this.shipVisualClock,
      camPos,
      this.ship.throttleSmoothed,
      boostBlend,
      1 - this.ship.hull,
    );

    const trailIntensity =
      clamp01(this.ship.throttleSmoothed * 0.5 + boostBlend * 0.55) * clamp01(speed01 * 3.2);
    for (let i = 0; i < this.trails.length; i++) {
      this.tmpA
        .copy(this.shipModel.nozzles[i].position)
        .applyQuaternion(this.ship.quaternion)
        .add(this.ship.position);
      this.trails[i].update(this.tmpA, camPos, trailIntensity, 1 + boostBlend * 1.6);
    }
    this.shipModel.setVisible(
      (!this.cinematic || this.activeVantage !== null || this.phase !== 'boot') && !cockpitActive,
    );

    this.updateGrade(dt, speed01, boostBlend);
    this.updateTelemetry(dt);
  }

  private updateCinematicCamera(dt: number): void {
    this.chase.setCameraMode('chase');
    this.cinematicTime += dt;
    // A slow, wide orbit around the ship while it cruises: the title screen is a beauty shot.
    const angle = this.cinematicTime * 0.11;
    const radius = 46 + Math.sin(this.cinematicTime * 0.07) * 12;
    // Damped in the SHIP's frame, then reconstructed in the world.
    //
    // This used to lerp the camera's WORLD position toward the orbit anchor. An exponential
    // follower chasing a target moving at constant velocity settles at a permanent lag of
    // v * tau: at the attract flight's 940 m/s with tau = 0.5 s that is 470 m, and the reviewer
    // measured 478 m — the ship shrinks to a dot and the title screen photographs empty space.
    // 39 of 60 sampled seconds failed the stills brightness bar, and 25 of those frames were
    // darker than the one the round-3 art review already condemned.
    //
    // ChaseCamera.ts:68-75 documents this exact failure and its cure for the flight camera. The
    // cinematic camera never got the treatment.
    this.tmpA.set(Math.sin(angle) * radius, 9 + Math.sin(this.cinematicTime * 0.13) * 4, Math.cos(angle) * radius);
    this.cinematicOffset.lerp(this.tmpA, 1 - Math.exp(-dt / 0.5));
    this.chase.camera.position.copy(this.cinematicOffset)
      .applyQuaternion(this.ship.quaternion)
      .add(this.ship.position);
    this.ship.getForward(this.tmpB);
    this.tmpC.copy(this.ship.position).addScaledVector(this.tmpB, 30);
    this.chase.camera.up.set(0, 1, 0);
    this.chase.camera.lookAt(this.tmpC);
    if (Math.abs(this.chase.camera.fov - 58) > 0.05) {
      this.chase.camera.fov = damp(this.chase.camera.fov, 58, 0.6, dt);
      this.chase.camera.updateProjectionMatrix();
    }
  }

  private clearVantageOfObstacles(point: THREE.Vector3): void {
    this.mission.legacy?.clearVantage(point, this.ship.radius, 220);
  }

  private applyVantage(v: Vantage): void {
    this.vantageExposure = v.exposureBias ?? 1;
    // Snapped, not damped. The exposure term has a 0.5 s time constant, and the screenshot
    // harness steps exactly one frame before it presents — a damped value would move about 3%
    // of the way there, so the bias would have measured as having no effect at all.
    this.grade.exposure = 1.3 * this.vantageExposure;
    const posedAtGate = v.gateIndex !== undefined && this.mission.legacy?.poseGate(
      v.gateIndex,
      v.gateStandoff ?? 800,
      this.tmpA,
      this.tmpQuat,
    );
    if (posedAtGate) {
      // Nudge clear of anything the ship is parked inside. A vantage that lands touching a
      // boulder reports proximity 1.0, fills half the frame with that rock's bloom, and makes
      // the shot useless as evidence — which is exactly how a "palette" defect turned out to
      // be a staging defect.
      this.clearVantageOfObstacles(this.tmpA);
    } else if (v.terminusStandoff !== undefined) {
      this.tmpA.copy(this.mission.path.terminusPosition)
        .addScaledVector(this.mission.path.terminusNormal, -v.terminusStandoff);
      this.tmpQuat.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(
          this.tmpA,
          this.mission.path.terminusPosition,
          new THREE.Vector3(0, 1, 0),
        ),
      );
    } else {
      this.mission.path.poseAt(v.t, this.tmpA, this.tmpQuat);
      this.clearVantageOfObstacles(this.tmpA);
    }
    this.ship.position.copy(this.tmpA);
    this.ship.quaternion.copy(this.tmpQuat);
    this.shipRoot.position.copy(this.tmpA);
    this.shipRoot.quaternion.copy(this.tmpQuat);

    this.tmpB.copy(v.offset).applyQuaternion(this.tmpQuat).add(this.tmpA);
    // Clearing only the ship anchor left the camera itself free to sit inside a boulder — one
    // shipped capture was taken from within an asteroid, looking at the inside of its far wall.
    this.clearVantageOfObstacles(this.tmpB);
    this.tmpC.set(0, 0, -1).applyQuaternion(this.tmpQuat).multiplyScalar(v.lookAhead).add(this.tmpA);
    this.chase.setPose(this.tmpB, this.tmpC, v.fov);
  }

  private updateGrade(dt: number, speed01: number, boost: number): void {
    // Project the star into screen space for the shafts.
    this.tmpA.copy(this.lighting.uSunDir.value).multiplyScalar(60).project(this.farCamera);
    const inFront = this.tmpA.z < 1;
    this.sunScreen.set(this.tmpA.x * 0.5 + 0.5, this.tmpA.y * 0.5 + 0.5);
    const offCentre = Math.max(Math.abs(this.tmpA.x), Math.abs(this.tmpA.y));
    this.grade.sunVisible = inFront ? clamp01(1 - smoothstep(0.85, 1.5, offCentre)) : 0;

    // The streak origin is the projected velocity vector, so turning skews the smear.
    if (this.ship.speed > 8) {
      this.tmpB.copy(this.ship.position).addScaledVector(this.ship.velocity, 2).project(this.chase.camera);
      this.blurCentre.set(
        clamp(this.tmpB.x * 0.5 + 0.5, -0.5, 1.5),
        clamp(this.tmpB.y * 0.5 + 0.5, -0.5, 1.5),
      );
    }

    const target = this.grade;
    target.blurStrength = damp(target.blurStrength, speed01 * 0.016 + boost * 0.055, 0.18, dt);
    // No constant term: aberration is a speed effect, and a base value meant the title
    // screen was fringing every star while standing still.
    target.aberration = damp(target.aberration, speed01 * speed01 * 0.0035 + boost * 0.011, 0.2, dt);
    target.warp = damp(target.warp, boost * 0.15, 0.2, dt);
    target.vignette = damp(target.vignette, 0.42 + boost * 0.2 + this.proximity * 0.14, 0.3, dt);
    // The flash carries the event; the standing term is a whisper. A persistent tint
    // proportional to accumulated damage means a scratched hull recolours the whole run.
    target.damage = clamp01(this.damageFlash * 0.75 + (1 - this.ship.hull) * 0.05);
    target.exposure = damp(target.exposure, (1.3 - boost * 0.08) * this.vantageExposure, 0.5, dt);
    target.saturation = damp(target.saturation, 1.0 + boost * 0.05, 0.4, dt);
    target.bloomStrength = this.settings.profile.bloomStrength * (1 + boost * 0.22);

    this.fade = damp(this.fade, this.fadeTarget, 0.22, dt);
    target.fade = this.fade;
  }

  /** Never hand a non-finite number to the interface layer: canvas APIs throw on them. */
  private static num(value: number, fallback = 0): number {
    return Number.isFinite(value) ? value : fallback;
  }

  private updateTelemetry(dt: number): void {
    const t = this.telemetry;
    const num = Game.num;
    const legacy = this.mission.legacy;
    const guidance = this.mission.objective.guidance(this.ship.position);
    t.phase = this.phase;
    t.speed = num(this.ship.speed);
    t.throttle = num(this.ship.throttleSmoothed);
    t.boosting = this.ship.boosting;
    t.boostLocked = this.ship.boostLocked;
    t.energy = num(this.ship.energy01);
    t.hull = num(this.ship.hull, 1);
    t.gLoad = num(this.ship.gForce);
    t.elapsed = num(this.elapsed);
    t.proximity = num(this.proximity);
    t.impactFlash = num(this.damageFlash);
    t.fps = num(this.fps, 60);
    t.courseRemaining = num(legacy
      ? legacy.remainingDistance(this.ship.position)
      : guidance.distance);

    // Reused scratch: this runs 60 times a second and allocating an Euler here was measurable.
    this.scratchEuler.setFromQuaternion(this.ship.quaternion, 'ZYX');
    t.roll = num(this.scratchEuler.z);
    t.pitch = num(this.scratchEuler.x);

    // Every screen-space anchor below projects through the camera, and the renderer only
    // refreshes these matrices during render() — which happens AFTER this. Without an explicit
    // update the HUD is projecting through last frame's camera, which at several hundred
    // metres a second puts the flight-path marker off the bottom of the screen.
    this.chase.camera.updateMatrixWorld();
    this.chase.camera.matrixWorldInverse.copy(this.chase.camera.matrixWorld).invert();

    // --- flight-path marker ----------------------------------------------------------
    // Projected a fixed distance along the velocity vector rather than at a fixed world point,
    // so the marker sits at the ship's actual heading regardless of speed.
    const speed = this.ship.speed;
    if (speed > 6) {
      this.tmpC.copy(this.ship.velocity).multiplyScalar(120 / speed).add(this.ship.position);
      this.tmpA.copy(this.tmpC).project(this.chase.camera);
      this.tmpB.copy(this.tmpC).applyMatrix4(this.chase.camera.matrixWorldInverse);
      const ahead = this.tmpB.z < 0;
      t.velocityAnchor.x = num(this.tmpA.x);
      t.velocityAnchor.y = num(this.tmpA.y);
      t.velocityAnchor.onScreen =
        ahead && Math.abs(this.tmpA.x) <= 1 && Math.abs(this.tmpA.y) <= 1;
      t.velocityAnchor.angle = num(Math.atan2(this.tmpB.y, this.tmpB.x));
      t.velocityAnchor.distance = speed;
    } else {
      t.velocityAnchor.onScreen = false;
      t.velocityAnchor.x = 0;
      t.velocityAnchor.y = 0;
      t.velocityAnchor.distance = speed;
    }

    const gate = legacy?.currentGate() ?? null;
    const targetPosition = gate?.position ?? guidance.anchor;
    t.gate.index = guidance.current;
    t.gate.total = guidance.total;
    t.gate.name = guidance.label;
    t.gate.nameMessage = guidance.labelMessage;
    t.gate.distance = num(this.ship.position.distanceTo(targetPosition));

    this.tmpA.copy(targetPosition).project(this.chase.camera);
    const onScreen = this.tmpA.z > -1 && this.tmpA.z < 1 && Math.abs(this.tmpA.x) <= 1 && Math.abs(this.tmpA.y) <= 1;
    t.gate.anchor.x = num(this.tmpA.x);
    t.gate.anchor.y = num(this.tmpA.y);
    t.gate.anchor.onScreen = onScreen;
    t.gate.anchor.distance = t.gate.distance;

    // Behind the camera the *projection* mirrors, so the bearing is taken from the raw
    // camera-space vector instead of the projected point. Camera space already has +x right
    // and +y up, so atan2(y, x) is the bearing directly — the sign flip that used to guard
    // against the projection mirror negated both components, which is a rotation by pi. The
    // arrow pointed the long way round for every target behind the camera, and flipped between
    // opposite screen edges frame to frame near z = 0.
    this.tmpB.copy(targetPosition).applyMatrix4(this.chase.camera.matrixWorldInverse);
    t.gate.anchor.angle = num(Math.atan2(this.tmpB.y, this.tmpB.x));

    this.ship.getForward(this.tmpC);
    t.gate.alignment = num(gate ? gate.alignment(this.tmpC) : 1, 1);

    t.guidance.label = guidance.label;
    t.guidance.labelMessage = guidance.labelMessage;
    t.guidance.distance = num(guidance.distance);
    t.guidance.progress = num(guidance.progress);
    t.guidance.current = guidance.current;
    t.guidance.total = guidance.total;
    this.tmpA.copy(guidance.anchor).project(this.chase.camera);
    t.guidance.anchor.x = num(this.tmpA.x);
    t.guidance.anchor.y = num(this.tmpA.y);
    t.guidance.anchor.onScreen = this.tmpA.z > -1
      && this.tmpA.z < 1
      && Math.abs(this.tmpA.x) <= 1
      && Math.abs(this.tmpA.y) <= 1;
    this.tmpB.copy(guidance.anchor).applyMatrix4(this.chase.camera.matrixWorldInverse);
    t.guidance.anchor.angle = num(Math.atan2(this.tmpB.y, this.tmpB.x));
    t.guidance.anchor.distance = num(guidance.distance);
    t.objective = this.mission.objective.telemetry();

    if (t.callout) {
      t.callout.ttl -= dt;
      if (t.callout.ttl <= 0) t.callout = null;
    }
    this.updateRadioSchedule();
    for (let i = this.logLines.length - 1; i >= 0; i--) {
      this.logLines[i].age += dt;
      if (this.logLines[i].age > 9) this.logLines.splice(i, 1);
    }

    this.overlay.update(t, dt);
  }

  /**
   * Boost is the loudest thing the player does and it had no voice at all: no ignition, no
   * cut-out, no warning when the reserve ran dry. These are the three transitions that matter.
   */
  private updateBoostFeedback(dt: number): void {
    const boosting = this.ship.boosting;
    const locked = this.ship.boostLocked;
    const ranDry = locked && !this.wasBoostLocked;

    // These are two different events and must never fire together. The drive stopping because
    // the pilot let go, and the drive stopping because the reserve ran out, are the same frame
    // in the simulation but must not be the same sound — two one-shots at the same instant read
    // as a single muddled event, and the "you are out" cue was the one that lost.
    if (boosting !== this.wasBoosting) {
      this.wasBoosting = boosting;
      if (boosting) this.audio.play('boostStart');
      else if (!ranDry) this.audio.play('boostEnd');
    }
    if (ranDry) {
      this.audio.play('boostEmpty');
      this.pushCallout({
        titleMessage: BOOST_DEPLETED_MESSAGE,
        sub: undefined,
        subMessage: BOOST_RECHARGING_MESSAGE,
        tone: 'warn',
        ttl: 1.2,
      });
      this.pushLog({ message: BOOST_DEPLETED_LOG_MESSAGE, tone: 'warn' });
    }
    this.wasBoostLocked = locked;

    // A rising tick as the aperture closes: the player should hear the gate arrive.
    const gate = this.mission.legacy?.currentGate() ?? null;
    if (gate && this.phase === 'flying') {
      const distance = this.ship.position.distanceTo(gate.position);
      const band =
        distance < FLIGHT_THRESHOLDS.gateTickRange
          ? Math.max(0.12, distance / FLIGHT_THRESHOLDS.gateTickIntervalDivisor)
          : 0;
      if (band > 0) {
        // Seconds, not frames. `band` is in seconds, and this ran once per RENDERED frame, so the
    // repeat interval was band * 60/fps: at 120 Hz the first tick at 900 m already fires at
    // 5.8 Hz and the whole escalation range sits above the designed 2.9-8.3 Hz, so the
    // calm-tick-that-tightens dynamic did not exist on a ProMotion display; at 30 fps the player
    // got four ticks for the entire approach and no arrival cue. Rate is the sole carrier of
    // that cue — pitch moves three semitones and peak moves 0.05 — so nothing picked up the
    // slack. It was the only 1/60 literal in the whole sim/audio/UI path.
    this.gateTickTimer -= dt;
        if (this.gateTickTimer <= 0) {
          this.gateTickTimer = band;
          this.audio.play(
            'gateNear',
            clamp01(1 - distance / FLIGHT_THRESHOLDS.gateTickRange),
          );
        }
      } else {
        this.gateTickTimer = 0;
      }
    }
  }

  private updateAudio(dt: number): void {
    this.updateBoostFeedback(dt);
    this.audio.update(dt, {
      throttle: this.ship.throttleSmoothed,
      speed01: this.ship.speed01,
      boosting: this.ship.boosting,
      slip: this.ship.slip,
    });
    const intensity =
      this.phase === 'flying'
        ? clamp01(0.34 + this.ship.speed01 * 0.5
          + this.mission.objective.guidance(this.ship.position).progress * 0.3)
        : this.phase === 'finished'
          ? 0.5
          : 0.22;
    this.audio.setIntensity(intensity);
  }

  private render(): void {
    const renderer = this.renderer;
    // three resets info at every render() call by default, so reading it afterwards reports
    // only the final fullscreen composite. Reset once here and read the aggregate instead.
    renderer.info.autoReset = false;
    renderer.info.reset();
    this.post.setCamera(this.chase.camera);
    renderer.setRenderTarget(this.post.sceneTarget);
    renderer.clear(true, true, true);
    renderer.render(this.farScene, this.farCamera);
    renderer.clearDepth();
    renderer.render(this.mainScene, this.chase.camera);
    this.post.render(this.grade);
  }

  // ---------------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------------

  private bindCourseEvents(): void {
    this.mission.legacy?.bindGateEvents({
      onPass: (event) => {
        const recharge = this.ship.rechargeBoost(FLIGHT.boostCapacity * 0.25);
        this.gateHistory.push({
          index: event.index,
          time: event.time,
          radialDistance: event.radialDistance,
          speed: event.speed,
          cleared: true,
          boostEnergyBefore: recharge.before,
          boostEnergyAfter: recharge.after,
        });
        this.telemetry.splits = [...this.mission.bestRunSplits()];
        const precision = 1 - event.offset;
        this.audio.play('gatePass', clamp01(0.4 + precision * 0.6));
        const accuracy: GateAccuracy = precision > 0.86
          ? 'dead-centre'
          : precision > 0.6
            ? 'clean'
            : 'cleared';
        const guidance = this.mission.objective.guidance(this.ship.position);
        const remaining = guidance.total - guidance.current;
        this.pushCallout({
          titleMessage: GATE_ACCURACY_MESSAGES[accuracy],
          sub: undefined,
          subMessage: {
            type: 'callout-sub.gate-progress',
            remaining,
            courseId: this.courseDefinition.id,
          },
          tone: precision > 0.6 ? 'good' : 'neutral',
          ttl: 1.15,
        });
        this.pushLog({
          message: {
            type: 'log.gate-cleared',
            gate: event.index + 1,
            seconds: event.time,
            courseId: this.courseDefinition.id,
          },
          tone: 'good',
        });
        this.queueRadio(event.index + 1);
      },

      onMiss: (event) => {
        const shearBlocked = event.blockedBy === 'shear';
        // Keep the proven miss voice, but strike it at full intensity for a shutter block. The
        // differentiated callout carries the semantic truth without adding a new procedural graph.
        this.audio.play('gateMiss', shearBlocked ? 1 : 0.5);
        this.pushCallout({
          titleMessage: shearBlocked ? GATE_SHEAR_BLOCKED_MESSAGE : GATE_MISSED_MESSAGE,
          sub: undefined,
          subMessage: shearBlocked ? GATE_SHEAR_WINDOW_MESSAGE : GATE_REALIGN_MESSAGE,
          tone: 'warn',
          ttl: 1.6,
        });
        this.pushLog({
          message: {
            type: 'log.gate-missed',
            gate: event.gateIndex + 1,
            courseId: this.courseDefinition.id,
            blockedBy: event.blockedBy ?? undefined,
          },
          tone: 'warn',
        });
      },
    });
  }

  private queueRadio(afterGate: number): void {
    const lines = this.missionDefinition.radio;
    for (let i = 0; i < lines.length && i < this.radioTriggeredAt.length; i++) {
      if (lines[i]!.afterGate === afterGate && this.radioTriggeredAt[i] === -1) {
        this.radioTriggeredAt[i] = this.elapsed;
      }
    }
  }

  private updateRadioSchedule(): void {
    if (this.phase !== 'flying') return;

    if (this.radioEndPending && this.elapsed >= this.radioBusyUntil) {
      this.radioEndPending = false;
      this.audio.play('radio');
    }
    if (this.telemetry.callout !== null || this.elapsed < this.radioBusyUntil) return;

    const lines = this.missionDefinition.radio;
    for (let i = 0; i < lines.length && i < this.radioTriggeredAt.length; i++) {
      const triggeredAt = this.radioTriggeredAt[i]!;
      if (triggeredAt < 0) continue;

      const line = lines[i]!;
      const englishText = LEGACY_ENGLISH.messages.campaign.routes[this.missionDefinition.id][line.messageKey];
      const remainingWindow = line.safeWindowSeconds - (this.elapsed - triggeredAt);
      this.radioTriggeredAt[i] = -2;
      if (!hasRadioSafeWindow(englishText.length, remainingWindow)) continue;

      const localizedText = this.activeTranslator.messages.campaign.routes[this.missionDefinition.id][line.messageKey];
      const duration = radioDurationSeconds(englishText.length);
      this.audio.play('radio');
      this.overlay.radio(line.speaker, localizedText, englishText.length);
      this.radioBusyUntil = this.elapsed + duration;
      this.radioEndPending = true;
      return;
    }
  }

  private pushCallout(spec: CalloutSpec): void {
    const title = LEGACY_ENGLISH.domain(spec.titleMessage);
    const sub = spec.subMessage
      ? LEGACY_ENGLISH.domain(spec.subMessage)
      : spec.sub;
    this.telemetry.callout = {
      id: ++this.calloutId,
      title,
      titleMessage: spec.titleMessage,
      sub,
      subMessage: spec.subMessage,
      tone: spec.tone,
      ttl: spec.ttl,
      ttlMax: spec.ttl,
    };
  }

  private pushLog(spec: LogSpec): void {
    this.logLines.push({
      id: ++this.logId,
      text: LEGACY_ENGLISH.domain(spec.message),
      message: spec.message,
      tone: spec.tone,
      age: 0,
    });
    if (this.logLines.length > 6) this.logLines.shift();
  }

  private applySetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings.set(key, value);
  }

  private onSettingsChanged(s: Settings): void {
    // Raising the render-scale ceiling must immediately give the scaler room again, and
    // lowering it must take effect at once. Clamping downward only made the slider one-way.
    this.dynamicScale = Math.min(this.dynamicScale, s.renderScale);
    if (s.renderScale > this.lastRenderScaleCeiling) this.dynamicScale = s.renderScale;
    this.lastRenderScaleCeiling = s.renderScale;
    this.input.sensitivity = s.mouseSensitivity;
    this.input.invertY = s.invertY;
    this.chase.shakeScale = s.cameraShake;
    this.chase.baseFov = s.fov;
    this.ship.assist = s.assistLevel;
    this.audio.setMasterVolume(s.masterVolume);
    this.audio.setMusicVolume(s.musicVolume);
    this.post.setProfile(this.settings.profile);
    this.post.setFeatureFlags({
      motionBlur: s.motionBlur,
      grain: s.filmGrain,
      chromaticAberration: s.chromaticAberration,
    });
    this.applyQualityPopulations();
    // Allocation depends on the window alone now, so a settings change only moves the viewport —
    // at the next frame START, like every other scale change: this ran between a driven capture's
    // step and present once, and the presented frame's bloom chain read margins nothing wrote.
    this.pendingScaleApply = true;
  }

  /** Trims drawn populations to the current quality level. Cheap and immediate. */
  private applyQualityPopulations(): void {
    const profile = this.settings.profile;
    const max = qualityProfile('ultra');
    this.mission.world.applyQuality(profile, max);
  }

  /**
   * Reallocates for a genuine window change. The dynamic-resolution controller must NOT call
   * this — it calls applyRenderScale, which moves a viewport and allocates nothing.
   */
  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Budget the FILL, not the device ratio.
    //
    // Clamping to `min(dpr, 2)` meant a 1920x1080 window on any Retina or 4K display allocated
    // 3840x2160 — four times the pixels of every measurement ever taken for this project, in
    // four rounds of review. Measured with EXT_disjoint_timer_query_webgl2, renderScale pinned
    // at 0.58 in both arms so the scaler cannot explain it: 4.58 ms at dsf=1 against 13.71 ms at
    // dsf=2, a 2.99x ratio, against 2.19x of headroom. `detectQuality()` returns `high` on the
    // machine this was built on, so the auto-selected default there was the untested case.
    //
    // The browser upscales from the CSS size, which it already does at every render scale.
    const rawDpr = window.devicePixelRatio || 1;
    const budget = Math.sqrt(FILL_BUDGET_PIXELS / Math.max(width * height, 1));
    // No floor at 1. The first version wrote `Math.max(1, Math.min(rawDpr, 2, budget))`, which
    // lets the budget pull the RATIO down but never the pixel COUNT — so a 4K desktop at dpr 1
    // allocated 8.29 Mpx, 3.3x the declared budget, and that is exactly the case the change was
    // committed to eliminate. Two disciplines found it independently.
    //
    // My own measurement did not catch it because I measured a 1080p window at dsf 2, where the
    // budget does bind, and reported the class from the one configuration that happened to work.
    // Below 1 the backing store is smaller than the CSS size and the browser upscales, which is
    // what already happens at every dynamic render scale; the 320x240 floors below are the guard
    // against an absurdly small buffer.
    const dpr = Math.min(rawDpr, 2, budget);
    const wantW = Math.max(320, Math.round(width * dpr));
    const wantH = Math.max(240, Math.round(height * dpr));

    /* CSS size and aspect follow the drag immediately — that is what keeps the picture attached
       to the window. REALLOCATION does not: a drag delivers a resize event stream, and
       reallocating nine render targets per event measured ~2.4 GB/s of allocation, 25-28 long
       frames in 2.5 s, and drove renderScale 1.0 -> 0.73-0.79 for zero GPU benefit — the
       controller read its own reallocation stalls as pixel load, the round-1 feedback loop on
       the one path the fix never covered. So: grow now (a too-small backing store would upscale
       blurrily), defer shrinks to the drag settling, and either way tell the controller to
       discard what it saw. */
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.chase.setAspect(width / height);
    this.farCamera.aspect = width / height;
    this.farCamera.updateProjectionMatrix();

    if (wantW > this.allocWidth || wantH > this.allocHeight) {
      this.reallocateTargets(Math.max(wantW, this.allocWidth), Math.max(wantH, this.allocHeight));
    }
    if (this.resizeSettleTimer !== null) window.clearTimeout(this.resizeSettleTimer);
    this.resizeSettleTimer = window.setTimeout(() => {
      this.resizeSettleTimer = null;
      if (wantW !== this.allocWidth || wantH !== this.allocHeight) this.reallocateTargets(wantW, wantH);
    }, 250);
  };

  /** The expensive half of a resize: reallocates every render target and resets the adaptive
      controller's evidence, because reallocation stalls are not pixel load and must not be
      graded as if they were — the same settle discipline the controller applies to its own
      viewport moves, which this path used to bypass. */
  private reallocateTargets(allocW: number, allocH: number): void {
    this.allocWidth = allocW;
    this.allocHeight = allocH;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.allocWidth, this.allocHeight, false);
    this.post.setSize(this.allocWidth, this.allocHeight);
    this.applyRenderScale();
    this.adaptSettle = 4;
    this.adaptAccumulator = 0;
    this.adaptFrames = 0;
    this.adaptLongFrames = 0;
    this.adaptWinMinMs = Infinity;
    this.adaptWinMaxMs = 0;
    this.adaptCooldown = Math.max(this.adaptCooldown, 0.35);
  }

  /** Cheap: moves each target's viewport rectangle. No allocation, no canvas resize. */
  private applyRenderScale(): void {
    this.post.setRenderSize(
      Math.max(320, Math.round(this.allocWidth * this.dynamicScale)),
      Math.max(240, Math.round(this.allocHeight * this.dynamicScale)),
    );
  }

  /** Fired when the browser or driver drops the GPU context. */
  onContextLost: (() => void) | null = null;

  /** Fired when the simulation halts after the same frame path repeatedly throws. */
  onRuntimeFailure: (() => void) | null = null;

  private haltRendering(): void {
    this.contextLost = true;
    this.fontGeneration += 1;
    this.fontPreparation?.cancel();
    this.fontPreparation = null;
    this.cancelCockpitPrewarm?.();
    this.paused = true;
    this.audio.suspend();
    this.input.releaseLock();
    // A fatal condition can happen before the first present. Always settle the boot wait so the
    // loader can hand control to the localized fatal screen instead of hanging indefinitely.
    if (this.firstFrameResolve) {
      const resolve = this.firstFrameResolve;
      this.firstFrameResolve = null;
      resolve();
    }
  }

  private readonly handleContextLost = (event: Event): void => {
    // Preventing the default is what allows a restore event to ever fire.
    event.preventDefault();
    this.haltRendering();
    this.errors.push('webgl context lost');
    this.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    this.errors.push('webgl context restored (a reload is required to resume)');
  };

  private readonly handleError = (e: ErrorEvent): void => {
    this.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
  };

  private readonly handleRejection = (e: PromiseRejectionEvent): void => {
    this.errors.push(`unhandled rejection: ${String(e.reason)}`);
  };

  private readonly handleVisibility = (): void => {
    if (document.hidden) this.audio.suspend();
    // Resume unconditionally. The `!this.paused` guard was correct when pause() itself suspended
    // the context, but 874d6d9 replaced that with menuMix() and deleted the only other recovery
    // path — so alt-tabbing away during a pause and coming back left the context suspended with
    // no route out. Two reviewers filed it independently and two skeptics failed to refute it.
    //
    // Resuming a never-suspended context is a no-op, and menuMix(true) already holds the engine
    // and score ducked, so this returns to a running-but-ducked graph: exactly what a pause menu
    // needs. Fixing it inside resume() instead would leave the pause screen silent between
    // tab-return and the RESUME click, which is the state 874d6d9 existed to fix.
    // ...but only once a gesture has reached the engine. That caveat is new and load-bearing: the
    // graph now exists from boot, so before this gate a tab-focus event was enough to un-suspend a
    // context the player had never authorised and start the mix on the title screen. The reasoning
    // above was written when no context existed before the first gesture.
    else if (this.audio.unlocked) this.audio.resume();
  };

  // ---------------------------------------------------------------------------------
  // automation surface
  // ---------------------------------------------------------------------------------

  /**
   * Compiles the cockpit's cold material variants while the loader still covers the canvas.
   *
   * The cockpit owns the only Three lights in the near scene. Compiling `mainScene` itself while
   * the cockpit is visible therefore collects those lights exactly once and warms the same
   * scene-context variants as the first live cockpit frame. Compiling only the cockpit root
   * misses two programs used by other near-scene materials under that light state. The active
   * render target is equally load-bearing: the cockpit is normally drawn into PostFX's linear
   * HalfFloat target, and Three includes output colour-space state in its program cache key.
   */
  private async prewarmCockpitShaders(): Promise<void> {
    const wasVisible = this.cockpitModel.object.visible;
    const previousTarget = this.renderer.getRenderTarget();
    const previousCubeFace = this.renderer.getActiveCubeFace();
    const previousMipmapLevel = this.renderer.getActiveMipmapLevel();
    const programs = new Set<ShaderProgramReadiness>();

    try {
      this.cockpitModel.setVisible(true);
      this.renderer.setRenderTarget(this.post.sceneTarget);
      const programsBefore = new Set(this.renderer.info.programs ?? []);
      const materials = this.renderer.compile(this.mainScene, this.chase.camera);

      // Three's public declarations omit WebGLProgram.isReady(), but compileAsync itself uses
      // this same renderer-owned method. Track both each material's current program and every
      // newly cached program so transparent two-pass variants are not missed.
      for (const material of materials) {
        const state = this.renderer.properties.get(material) as { currentProgram?: unknown };
        if (hasShaderProgramReadiness(state.currentProgram)) programs.add(state.currentProgram);
      }
      for (const program of this.renderer.info.programs ?? []) {
        if (!programsBefore.has(program) && hasShaderProgramReadiness(program)) programs.add(program);
      }
    } catch {
      // Shader prewarming is an optimisation, never a launch requirement. The first real render
      // remains the browser/driver fallback on implementations where compilation fails.
    } finally {
      this.cockpitModel.setVisible(wasVisible);
      this.renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    }

    if (programs.size > 0) await this.waitForCockpitPrograms(programs);
  }

  /**
   * A cancellable counterpart to Three's compileAsync poll. Three's implementation owns an
   * unexposed recursive timer, so racing its promise cannot stop driver queries after our timeout
   * and can call isReady() on deleted programs after dispose(). Owning the timer here makes both
   * terminal paths synchronous and leaves no background work behind.
   */
  private waitForCockpitPrograms(programs: ReadonlySet<ShaderProgramReadiness>): Promise<void> {
    return new Promise((resolve) => {
      const deadline = performance.now() + COCKPIT_PREWARM_TIMEOUT_MS;
      let timerId: number | null = null;
      let finished = false;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timerId !== null) {
          window.clearTimeout(timerId);
          timerId = null;
        }
        if (this.cancelCockpitPrewarm === finish) this.cancelCockpitPrewarm = null;
        resolve();
      };
      const poll = (): void => {
        timerId = null;
        if (this.disposed || this.contextLost || performance.now() >= deadline) {
          finish();
          return;
        }
        try {
          for (const program of programs) {
            if (!program.isReady()) {
              timerId = window.setTimeout(poll, COCKPIT_PREWARM_POLL_MS);
              return;
            }
          }
        } catch {
          // A driver that cannot report readiness falls back to compilation on first use.
        }
        finish();
      };

      this.cancelCockpitPrewarm?.();
      this.cancelCockpitPrewarm = finish;
      poll();
    });
  }

  start(): void {
    this.bindCourseEvents();
    this.fadeTarget = 1;
    let last = 0;
    const loop = (now: number): void => {
      if (this.disposed) return;
      const dt = (now - last) / 1000;
      last = now;
      // Re-arm FIRST. If frame() throws — a HUD edge case, a shader failure, a lost context —
      // re-arming afterwards would never run and the game would be bricked until reload, with
      // the error swallowed by the window handler. A frame that fails must not stop the clock.
      requestAnimationFrame(loop);
      // When the harness is stepping the simulation by hand the rAF loop must not also
      // advance it, or a "deterministic" playthrough silently runs at double rate.
      if (this.driven) return;
      try {
        this.frame(dt);
        this.frameFailures = 0;
      } catch (error) {
        this.errors.push(`frame: ${error instanceof Error ? error.message : String(error)}`);
        this.frameFailures++;
        // A defect that repeats every frame would otherwise spam until the tab dies.
        if (this.frameFailures > 60) {
          this.haltRendering();
          this.onRuntimeFailure?.();
        }
      }
    };
    const beginLoop = (): void => {
      if (this.disposed) return;
      // Do not charge loader-only shader work to the first simulation/performance sample.
      last = performance.now();
      requestAnimationFrame(loop);
    };
    // A rejected/timeout prewarm must not hold the loader or prevent the normal render fallback.
    void this.prewarmCockpitShaders().then(beginLoop, beginLoop);
  }

  private driven = false;

  /** Hands frame pacing to the caller. Used by `__LV.step`. */
  setDriven(driven: boolean): void {
    const wasDriven = this.driven;
    this.driven = driven;
    if (driven && !wasDriven) {
      // Zero the world clock on taking control.
      //
      // Every animated shader reads `this.clock`, which accumulates from the moment the page
      // loads — and the title screen runs free rAF frames before `startRun`, for however long
      // the driver took to get there. So two harness processes stepping the identical sequence
      // rendered different frames: mean drift 0.33/255, but single bright features moving up to
      // 89/255. That invalidated every cross-process screenshot comparison in the project, and
      // it is the mechanism behind two rounds of mismatched capture pairs — including one
      // reviewer's blocker whose 336 changed pixels were reproduced, 206 of them, by a null
      // control of two identical unpatched runs.
      //
      // `setFixedTimestep` fixes the STEP; this fixes the ORIGIN. Both are needed for two
      // processes to render the same frame.
      this.clock = 0;
      this.shipVisualClock = 0;
      // Reset the time origin without inventing an engine edge. A driver can take ownership in
      // the middle of sustained boost, so the plume's baseline must match the live blend.
      this.shipModel.rebasePlumeTime(0, this.boostBlend);
      this.grade.time = 0;
    }
  }

  ready(): Promise<void> {
    return this.firstFrame;
  }

  getPhase(): Phase {
    return this.phase;
  }

  getCameraMode(): CameraMode {
    // Report the camera's applied projection state, not the saved preference. In harness-driven
    // mode a setting can change between rendered frames, and those two values intentionally
    // differ until updateVisuals applies the new pose/near plane.
    return this.chase.getCameraMode();
  }

  /** Read-only cockpit evidence for deterministic integration and render-budget checks. */
  getCockpitDebug(): CockpitDebugState {
    return this.cockpitModel.getDebugState();
  }

  /** Read-only locale, fitted-label, source-pixel, and final-screen evidence for the MFD. */
  getCockpitMfd(): CockpitMfdEvidence {
    const evidence = this.cockpitModel.getMfdEvidence(this.chase.camera);
    return {
      ...evidence,
      screenNdcCorners: evidence.projectedNdcCorners.map((corner) => this.toScreenNdc(corner)),
      labelScreenNdcCorners: evidence.labelProjectedNdcCorners.map(
        (corner) => this.toScreenNdc(corner),
      ),
    };
  }

  /**
   * Invert the composite's radial warp so a projected scene point maps to its final PNG pixel.
   * Shared by ship and cockpit evidence to keep both screenshot contracts on one implementation.
   */
  private toScreenNdc(
    ndc: readonly [number, number, number],
  ): [number, number, number] {
    const centre = this.grade.blurCentre;
    const dx = ndc[0] * 0.5 + 0.5 - centre.x;
    const dy = ndc[1] * 0.5 + 0.5 - centre.y;
    const sourceRadius = Math.hypot(dx, dy);
    if (sourceRadius < 1e-9 || this.grade.warp <= 0) return [ndc[0], ndc[1], ndc[2]];
    let outputRadius = sourceRadius;
    for (let i = 0; i < 5; i++) {
      const radius2 = outputRadius * outputRadius;
      outputRadius -= (
        outputRadius + this.grade.warp * outputRadius * radius2 - sourceRadius
      ) / (1 + 3 * this.grade.warp * radius2);
    }
    const scale = outputRadius / sourceRadius;
    return [
      (centre.x + dx * scale) * 2 - 1,
      (centre.y + dy * scale) * 2 - 1,
      ndc[2],
    ];
  }

  /** Read-only exterior renderer contract used by the boost VFX regression probe. */
  getShipDebug(): HarnessShipVisualDebugState {
    const debug = this.shipModel.getDebugState();
    const plumeLength = debug.plume.length;
    const plumeWidth = debug.plume.width;
    this.shipModel.object.updateWorldMatrix(true, false);
    this.chase.camera.updateMatrixWorld();
    const projectLocal = (point: THREE.Vector3): [number, number, number] => {
      const world = this.shipModel.object.localToWorld(point.clone());
      const ndc = world.project(this.chase.camera);
      return [ndc.x, ndc.y, ndc.z];
    };
    return {
      ...debug,
      engineProjection: this.shipModel.nozzles.map((nozzle) => {
        const mouthNdc = projectLocal(nozzle.position);
        const mouthRimNdc = projectLocal(
          nozzle.position.clone().add(new THREE.Vector3(0.38 * plumeWidth, 0, 0)),
        );
        const coreNdc = projectLocal(nozzle.position.clone().setZ(6.67));
        const coreRimNdc = projectLocal(
          nozzle.position.clone().setZ(6.67).add(new THREE.Vector3(0.14, 0, 0)),
        );
        const sheathMidNdc = projectLocal(
          nozzle.position.clone().add(new THREE.Vector3(0, 0, plumeLength * 0.38)),
        );
        const sheathMidRimNdc = projectLocal(nozzle.position.clone().add(new THREE.Vector3(
          (0.38 * (1 - 0.38) + 0.012 * 0.38) * plumeWidth,
          0,
          plumeLength * 0.38,
        )));
        const tailNdc = projectLocal(
          nozzle.position.clone().add(new THREE.Vector3(0, 0, plumeLength)),
        );
        return {
          mouthNdc,
          mouthRimNdc,
          coreNdc,
          coreRimNdc,
          sheathMidNdc,
          sheathMidRimNdc,
          tailNdc,
          mouthScreenNdc: this.toScreenNdc(mouthNdc),
          mouthRimScreenNdc: this.toScreenNdc(mouthRimNdc),
          coreScreenNdc: this.toScreenNdc(coreNdc),
          coreRimScreenNdc: this.toScreenNdc(coreRimNdc),
          sheathMidScreenNdc: this.toScreenNdc(sheathMidNdc),
          sheathMidRimScreenNdc: this.toScreenNdc(sheathMidRimNdc),
          tailScreenNdc: this.toScreenNdc(tailNdc),
        };
      }),
    };
  }

  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  getLocaleState(): HarnessLocaleState {
    return {
      selected: this.selectedLocale,
      active: this.activeRunLocale,
      locked: this.activeRunLocale !== null,
      settingsSubscribers: this.settings.subscriberCount,
      fontStatus: this.fontResult.status,
    };
  }

  getResult(): MissionResult | null {
    return this.result;
  }

  /** Automation-only structural damage injection for deterministic phase-boundary tests. */
  damageHull(amount: number): number {
    if (this.phase !== 'flying') return this.ship.hull;
    return this.ship.applyHullDamage(amount);
  }

  /**
   * Places the ship on a deterministic closing contact with a currently drawn asteroid.
   * No damage is applied here: the next frame must traverse updateMotion -> mission.simulate ->
   * Ship.applyImpact, which is why the playtest uses this alongside the direct phase-boundary
   * injector above instead of mistaking that injector for evidence of a playable failure path.
   * Hull and the run's contact sequence survive the physical reset, so repeated staging exercises
   * cumulative production damage rather than a series of isolated first-hit samples.
   */
  stageCollision(): { rockId: number; overlap: number; closingSpeed: number } | null {
    if (this.phase !== 'flying') return null;
    const contact = this.mission.legacy?.stageContact('debris');
    if (!contact || typeof contact.id !== 'number') return null;

    const overlap = Math.min(6, contact.radius * 0.5);
    const closingSpeed = FLIGHT_THRESHOLDS.maxImpactClosingSpeed;
    this.tmpA.set(0.73, 0.41, -0.54).normalize();
    this.tmpC.copy(this.tmpA).negate();
    this.tmpQuat.setFromUnitVectors(this.tmpB.set(0, 0, -1), this.tmpC);
    this.tmpB.copy(contact.position).addScaledVector(
      this.tmpA,
      contact.radius + this.ship.radius - overlap,
    );
    const hull = this.ship.hull;
    this.ship.reset(this.tmpB, this.tmpQuat, closingSpeed);
    this.ship.hull = hull;
    this.chase.snapTo(this.ship);
    for (const trail of this.trails) trail.reset();
    return { rockId: contact.id, overlap, closingSpeed };
  }

  /** Stages a real contact against one authored landmark without changing asteroid contracts. */
  stageLandmarkCollision(): {
    colliderId: string;
    overlap: number;
    closingSpeed: number;
  } | null {
    if (this.phase !== 'flying') return null;
    const contact = this.mission.legacy?.stageContact('landmark');
    if (!contact || typeof contact.id !== 'string') return null;

    const overlap = Math.min(6, contact.radius * 0.2);
    const closingSpeed = FLIGHT_THRESHOLDS.maxImpactClosingSpeed;
    this.tmpA.set(0.73, 0.41, -0.54).normalize();
    this.tmpC.copy(this.tmpA).negate();
    this.tmpQuat.setFromUnitVectors(this.tmpB.set(0, 0, -1), this.tmpC);
    this.tmpB.copy(contact.position).addScaledVector(
      this.tmpA,
      contact.radius + this.ship.radius - overlap,
    );
    const hull = this.ship.hull;
    this.ship.reset(this.tmpB, this.tmpQuat, closingSpeed);
    this.ship.hull = hull;
    this.chase.snapTo(this.ship);
    for (const trail of this.trails) trail.reset();
    return { colliderId: contact.id, overlap, closingSpeed };
  }

  setHarnessInput(input: HarnessInput | null): void {
    this.harnessInput = input;
  }

  setAutopilot(enabled: boolean, skill = 1): void {
    this.autopilot = enabled;
    this.autopilotSkill = clamp(skill, 0.2, 1);
  }

  seekCourse(t: number): void {
    this.mission.path.poseAt(clamp01(t), this.tmpA, this.tmpQuat);
    this.ship.reset(this.tmpA, this.tmpQuat, FLIGHT.cruiseSpeed);
    this.mission.legacy?.resetMotion();
    this.chase.snapTo(this.ship);
    for (const trail of this.trails) trail.reset();
    this.mission.legacy?.seek(t);
  }

  setVantage(name: string): void {
    const v = this.vantages.find((x) => x.name === name);
    if (!v) {
      if (this.mission.legacy) throw new Error(`unknown vantage: ${name}`);
      return;
    }
    this.activeVantage = v;
    this.cinematic = false;
    this.mission.legacy?.resetMotion();
    this.mission.legacy?.setVantageState(
      v.gateIndex,
      v.terminusStandoff !== undefined,
    );
  }

  clearVantage(): void {
    this.activeVantage = null;
  }

  vantageSubjects(): { name: string; subject: 'ship' | 'gate' | 'terminus' }[] {
    return this.vantages.map((v) => ({
      name: v.name,
      subject: v.gateIndex !== undefined ? 'gate' : v.terminusStandoff !== undefined ? 'terminus' : 'ship',
    }));
  }

  vantageNames(): string[] {
    return this.vantages.map((v) => v.name);
  }

  /**
   * Freezes SIMULATION only, for capture. Deliberately does not open the pause menu, release
   * pointer lock or duck the drive — the stills suite must not photograph a pause veil over every
   * vantage. Use `pauseMenu` for anything testing pause behaviour.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** The player's pause, by the route a player takes. */
  pauseMenu(on: boolean): void {
    if (on) this.pause();
    else this.resume();
  }

  setFixedTimestep(dt: number | null): void {
    this.fixedTimestep = dt;
  }

  getPose(): HarnessPose {
    this.ship.getForward(this.tmpA);
    return {
      position: [this.ship.position.x, this.ship.position.y, this.ship.position.z],
      quaternion: [
        this.ship.quaternion.x,
        this.ship.quaternion.y,
        this.ship.quaternion.z,
        this.ship.quaternion.w,
      ],
      velocity: [this.ship.velocity.x, this.ship.velocity.y, this.ship.velocity.z],
      angularVelocity: [
        this.ship.angularVelocity.x,
        this.ship.angularVelocity.y,
        this.ship.angularVelocity.z,
      ],
      forward: [this.tmpA.x, this.tmpA.y, this.tmpA.z],
      camera: (() => {
        const cam = this.chase.camera;
        cam.updateMatrixWorld();
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        return {
          position: [cam.position.x, cam.position.y, cam.position.z] as [number, number, number],
          forward: [f.x, f.y, f.z] as [number, number, number],
          near: cam.near,
          fov: cam.fov,
        };
      })(),
    };
  }

  getActiveInput(): Required<HarnessInput> {
    // `failed` deliberately bypasses Input.update() and feeds the neutral drift command straight
    // to Ship.update(). Expose that applied command rather than the last live stick sample; the
    // harness contract is about authority that reached physics, not keys still held behind UI.
    const c = this.phase === 'failed' ? FAILURE_DRIFT_COMMAND : this.input.command;
    return {
      pitch: c.pitch,
      yaw: c.yaw,
      roll: c.roll,
      throttle: c.throttle,
      strafeX: c.strafeX,
      strafeY: c.strafeY,
      fire: c.fire,
      boost: c.boost,
      brake: c.brake,
    };
  }

  /** See `HazardReport`. Walks the flown line and measures the room around it. */
  getHazard(samples = 900): HazardReport {
    return this.mission.legacy?.hazard(samples, this.lastCollisionContacts) ?? {
      activeRocks: 0,
      gameplayRocks: 0,
      totalRocks: 0,
      minClearance: 0,
      p05Clearance: 0,
      medianClearance: 0,
      tightFraction: 0,
      colliderSharesDrawnList: null,
      motion: {
        count: 0,
        cap: 0,
        elapsed: 0,
        maxDisplacement: 0,
        displacementLimit: 0,
        maxPlayerResponse: 0,
        playerResponseLimit: 0,
        minPlayerDistanceDelta: 0,
        minProtectedVolumeClearance: 0,
        signature: '',
      },
    };
  }

  /** See `channelExcursion`. Positive metres are outside the protected volume. */
  getChannelExcursion(): number {
    const pos = this.ship.position;
    let best = Infinity;
    for (const seg of this.mission.path.clearChannel) {
      const d = distanceToSegment(pos, seg.a, seg.b) - seg.radius;
      if (d < best) best = d;
    }
    return +best.toFixed(1);
  }

  getGateHistory(): GatePassRecord[] {
    return this.gateHistory.slice();
  }

  getCourseState(): {
    courseId: CourseDefinition['id'];
    recordId: string;
    seed: number;
    gateCount: number;
    length: number;
    resolution: MissionResolution;
  } {
    const objective = this.mission.objective.telemetry();
    return {
      courseId: this.courseDefinition.id,
      recordId: this.mission.recordId(this.seed),
      seed: this.seed,
      gateCount: objective.kind === 'gate-race'
        ? objective.gatesTotal
        : 0,
      length: this.mission.path.totalLength,
      resolution: { ...this.missionResolution },
    };
  }

  getCampaignProgress(): ReturnType<ProgressStore['snapshot']> {
    return this.progressStore.snapshot();
  }

  getCrossingHistory(): {
    index: number;
    time: number;
    radialDistance: number;
    normalizedOffset: number;
    speed: number;
    cleared: boolean;
    blockedBy: 'aperture' | 'shear' | null;
  }[] {
    return this.mission.legacy?.crossings() ?? [];
  }

  /**
   * Deterministic test seam for the one failure that cannot be staged by a straight seek: the
   * course curve and authored gate plane are intentionally not interchangeable. This crosses the
   * currently armed SHEAR gate through its always-blocked hub, so feedback is exercised through
   * the same Course.update/onMiss path as real flight without exposing arbitrary world mutation.
   */
  stageShearBlock(): ReturnType<Game['getCrossingHistory']>[number] | null {
    if (this.phase !== 'flying') return null;
    return this.mission.legacy?.stageShearBlock(this.elapsed, this.ship.speed) ?? null;
  }

  getShearState(): ReturnType<NonNullable<MissionRuntime['legacy']>['shearState']> {
    return this.mission.legacy?.shearState(this.elapsed) ?? null;
  }

  getStageLandmarkState(): HarnessStageLandmarkState {
    return this.mission.legacy?.landmarkState() ?? {
      kind: 'none',
      landmarks: [],
      signature: '',
      draws: 0,
      triangles: 0,
      geometries: 0,
      materials: 0,
      colliders: 0,
    };
  }

  getRouteUrl(missionId: MissionDefinition['id']): string {
    return buildMissionUrl(window.location.href, missionId);
  }

  getAudioState(): ReturnType<AudioBus['debugMixState']> {
    return this.audio.debugMixState();
  }

  getErrors(): string[] {
    return this.errors.slice();
  }

  beginProfile(): void {
    this.frameTimes = [];
  }

  collectProfile(seconds: number): PerfSample {
    const samples = this.frameTimes.slice().sort((a, b) => a - b);
    const info = this.renderer.info;
    const pick = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0;
    const total = samples.reduce((a, b) => a + b, 0);
    return {
      frames: samples.length,
      seconds,
      fps: seconds > 0 ? samples.length / seconds : 0,
      meanFrameMs: samples.length ? total / samples.length : 0,
      p50FrameMs: pick(0.5),
      p95FrameMs: pick(0.95),
      p99FrameMs: pick(0.99),
      maxFrameMs: samples[samples.length - 1] ?? 0,
      longFrames: samples.filter((s) => s > 20).length,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      renderScale: this.dynamicScale,
      drawingBufferWidth: this.post.renderWidth,
      drawingBufferHeight: this.post.renderHeight,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.fontGeneration += 1;
    this.fontPreparation?.cancel();
    this.fontPreparation = null;
    this.cancelCockpitPrewarm?.();
    this.releaseUnlock();
    this.cancelCountdownClear();
    if (this.resizeSettleTimer !== null) window.clearTimeout(this.resizeSettleTimer);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('error', this.handleError);
    window.removeEventListener('unhandledrejection', this.handleRejection);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.input.dispose();
    this.overlay.dispose();
    this.audio.dispose();
    this.post.dispose();
    this.mission.dispose();
    this.shipModel.dispose();
    this.cockpitModel.dispose();
    for (const trail of this.trails) trail.dispose();
    this.renderer.dispose();
  }

  /** The seed the world was actually generated from, for reproducible reports. */
  readonly seed: number;

  get qualityProfile(): QualityProfile {
    return this.settings.profile;
  }
}
