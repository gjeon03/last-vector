import * as THREE from 'three';
import { Ship } from './Ship.ts';
import { ChaseCamera } from './ChaseCamera.ts';
import { Course } from './Course.ts';
import { ShipModel } from '../render/ShipModel.ts';
import { PostFX, type GradeParams } from '../render/PostFX.ts';
import { Starfield } from '../render/Starfield.ts';
import { Star } from '../render/Star.ts';
import { Planet } from '../render/Planet.ts';
import { bakeNebula } from '../render/Nebula.ts';
import { AsteroidField } from '../render/Asteroids.ts';
import { DustField } from '../render/Dust.ts';
import { Trail } from '../render/Trail.ts';
import { DerelictField, ShelfSpan, Terminus } from '../render/Structures.ts';
import { createLightingUniforms } from '../render/lighting.ts';
import { Input, type FlightCommand } from '../core/Input.ts';
import {
  SettingsStore,
  qualityProfile,
  readBestTime,
  writeBestTime,
  type QualityProfile,
} from '../core/Settings.ts';
import { AudioEngine } from '../audio/index.ts';
import { Overlay } from '../ui/index.ts';
import { FICTION, FLIGHT, SCALE } from '../core/art.ts';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/mathx.ts';
import { hashSeed } from '../core/rng.ts';
import type {
  AudioBus,
  Callout,
  LogLine,
  Phase,
  RunResult,
  Settings,
  Telemetry,
} from '../core/contracts.ts';
import type { GatePassRecord, HarnessInput, HarnessPose, PerfSample } from '../core/harness.ts';

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

const RADIO_LINES: { at: number; speaker: string; text: string }[] = [
  { at: 0, speaker: 'DRIFT CONTROL', text: 'Kestrel, you are clear on the cairn line. Good hunting.' },
  { at: 2, speaker: 'DRIFT CONTROL', text: 'Shelf density climbing. Watch your left.' },
  { at: 4, speaker: 'VESPER TERMINUS', text: 'We have your transponder. Hold the line.' },
  { at: 6, speaker: 'VESPER TERMINUS', text: 'Long run ahead, Kestrel. Burn it.' },
  { at: 8, speaker: 'VESPER TERMINUS', text: 'Approach lit. Bring her in.' },
];

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
  /** When set, frames the terminus instead. */
  terminusStandoff?: number;
}

export interface GameOptions {
  root: HTMLElement;
  seed?: number;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly settings: SettingsStore;
  readonly audio: AudioBus;
  readonly overlay: Overlay;

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
  private readonly lighting = createLightingUniforms(new THREE.Vector3(-0.58, 0.3, -0.76));
  private readonly starfield: Starfield;
  private readonly star: Star;
  private readonly planet: Planet;
  private readonly nebulaTarget: THREE.WebGLCubeRenderTarget;
  private readonly asteroids: AsteroidField;
  private readonly derelicts: DerelictField;
  private readonly shelfSpan: ShelfSpan;
  private readonly dust: DustField;
  private readonly terminus: Terminus;
  private readonly course: Course;
  private readonly ship = new Ship();
  private readonly shipModel: ShipModel;
  private readonly shipRoot = new THREE.Group();
  private readonly shipMeshHolder = new THREE.Group();
  private readonly trails: Trail[] = [];

  private phase: Phase = 'boot';
  private elapsed = 0;
  private clock = 0;
  private countdown: number | null = null;
  private countdownTimer = 0;
  private result: RunResult | null = null;
  private topSpeed = 0;
  private impacts = 0;
  private lastRadio = -1;
  private fade = 0;
  private fadeTarget = 1;
  private damageFlash = 0;
  private proximity = 0;
  private cinematicTime = 0;
  private wasBoosting = false;
  private wasBoostLocked = false;
  private gateTickTimer = 0;

  private autopilot = false;
  private autopilotSkill = 1;
  private harnessInput: HarnessInput | null = null;
  private fixedTimestep: number | null = null;
  private paused = false;
  private cinematic = false;
  private activeVantage: Vantage | null = null;
  private readonly gateHistory: GatePassRecord[] = [];
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
  private dynamicScale = 1;
  private adaptAccumulator = 0;
  private adaptFrames = 0;
  private adaptCooldown = 0;
  private adaptLongFrames = 0;
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
  private readonly sunScreen = new THREE.Vector2(0.5, 0.5);
  private readonly blurCentre = new THREE.Vector2(0.5, 0.5);
  private readonly grade: GradeParams;

  private readonly vantages: Vantage[] = [];
  private disposed = false;
  private contextLost = false;
  private frameFailures = 0;
  private firstFrameResolve: (() => void) | null = null;
  private readonly firstFrame: Promise<void>;

  constructor(options: GameOptions) {
    const seed = options.seed ?? hashSeed('cairn-drift-01');
    this.seed = seed;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lv-canvas';
    options.root.appendChild(this.canvas);

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

    // --- far scene ------------------------------------------------------------------
    const sunDir = this.lighting.uSunDir.value.clone();
    const nebula = bakeNebula(this.renderer, {
      resolution: profile.nebulaSteps >= 20 ? 1024 : profile.nebulaSteps >= 12 ? 768 : 512,
      octaves: profile.nebulaSteps >= 20 ? 6 : profile.nebulaSteps >= 12 ? 5 : 4,
      seed: (seed % 97) * 0.37,
      sunDirection: sunDir,
    });
    this.nebulaTarget = nebula.target;
    this.farScene.background = nebula.texture;

    // Populations are always allocated at the highest quality and trimmed per setting, so a
    // change in the menu takes effect on the next frame rather than on the next reload.
    const maxProfile = qualityProfile('ultra');
    this.starfield = new Starfield(maxProfile.starCount, 90, seed ^ 0x51ed);
    this.farScene.add(this.starfield.object);

    this.star = new Star(60, Math.atan(SCALE.starRadius / SCALE.starDistance), sunDir);
    this.farScene.add(this.star.object);

    this.planet = new Planet({
      distance: 40,
      angularRadius: Math.atan(SCALE.planetRadius / SCALE.planetDistance),
      direction: new THREE.Vector3(0.68, -0.2, -0.7).normalize(),
      sunDirection: sunDir,
      rings: true,
    });
    this.farScene.add(this.planet.object);

    // --- near scene -----------------------------------------------------------------
    this.course = new Course(seed, this.lighting);
    this.mainScene.add(this.course.object);

    this.terminus = new Terminus({
      position: this.course.terminusPosition,
      normal: this.course.terminusNormal,
      lighting: this.lighting,
      seed: seed ^ 0x7f31,
    });
    this.mainScene.add(this.terminus.object);

    this.asteroids = new AsteroidField({
      count: maxProfile.asteroidCount,
      lighting: this.lighting,
      spine: this.course.spine,
      spread: SCALE.asteroidFieldRadius * 0.55,
      corridor: SCALE.gateRadius * 1.9,
      minRadius: 9,
      maxRadius: 160,
      seed: seed ^ 0x2f19,
    });
    this.mainScene.add(this.asteroids.object);

    this.derelicts = new DerelictField({
      lighting: this.lighting,
      spine: this.course.spine,
      seed: seed ^ 0x1a77,
      count: 7,
    });
    this.mainScene.add(this.derelicts.object);

    // Placed just off the middle of the route, so the player passes it broadside at the point
    // where the legs are longest and the frame would otherwise be emptiest.
    // Anchored to the course's own frame rather than to world axes, so it reliably sits off
    // the player's starboard side through the middle legs instead of wherever the route
    // happened to be pointing.
    const spanIndex = Math.floor(this.course.spine.length * 0.5);
    const spanAnchor = this.course.spine[spanIndex];
    const spanAhead = this.course.spine[Math.min(this.course.spine.length - 1, spanIndex + 6)];
    const spanForward = new THREE.Vector3().subVectors(spanAhead, spanAnchor).normalize();
    const spanRight = new THREE.Vector3().crossVectors(spanForward, new THREE.Vector3(0, 1, 0)).normalize();
    this.shelfSpan = new ShelfSpan({
      lighting: this.lighting,
      position: spanAnchor
        .clone()
        .addScaledVector(spanRight, 5200)
        .addScaledVector(spanForward, 2600)
        .add(new THREE.Vector3(0, -900, 0)),
      seed: seed ^ 0x5bd1,
    });
    this.mainScene.add(this.shelfSpan.object);

    this.dust = new DustField(maxProfile.dustCount, 1100, seed ^ 0x99ab);
    this.mainScene.add(this.dust.object);

    this.shipModel = new ShipModel({ lighting: this.lighting });
    this.shipMeshHolder.add(this.shipModel.object);
    this.shipRoot.add(this.shipMeshHolder);
    this.mainScene.add(this.shipRoot);

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
    this.input = new Input(this.canvas);
    this.input.onLockChange = (locked) => this.overlay.setPointerLocked(locked);
    this.input.onAction = (action) => {
      if (action === 'restart' && (this.phase === 'flying' || this.phase === 'finished')) this.restart();
    };

    this.audio = new AudioEngine();
    this.overlay = new Overlay(options.root, {
      start: () => this.beginRun(),
      restart: () => this.restart(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      quitToTitle: () => this.toTitle(),
      setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => this.applySetting(key, value),
      getSettings: () => this.settings.value,
    });

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

  // ---------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------

  private createTelemetry(): Telemetry {
    return {
      phase: 'boot',
      speed: 0,
      maxSpeed: FLIGHT.maxSpeed,
      throttle: 0,
      boosting: false,
      energy: 1,
      hull: 1,
      roll: 0,
      pitch: 0,
      gLoad: 0,
      velocityAnchor: { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 },
      gate: {
        index: 0,
        total: this.course.gates.length,
        name: this.course.gates[0]?.name ?? '',
        distance: 0,
        anchor: { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 },
        alignment: 0,
      },
      courseRemaining: 0,
      courseTotal: this.course.totalLength,
      elapsed: 0,
      splits: [],
      bestTime: readBestTime(this.course.id),
      sectorName: FICTION.sectorName,
      destinationName: FICTION.destinationName,
      callout: null,
      log: this.logLines,
      proximity: 0,
      fps: 60,
    };
  }

  private buildVantages(): void {
    this.vantages.push(
      { name: 'title', t: 0.02, offset: new THREE.Vector3(-17, 4.4, 24), lookAhead: 34, fov: 50 },
      { name: 'hull', t: 0.2, offset: new THREE.Vector3(-11, 2.6, 15), lookAhead: 10, fov: 42 },
      { name: 'chase', t: 0.34, offset: new THREE.Vector3(0, 3.2, 16.5), lookAhead: 90, fov: 76 },
      { name: 'gate-approach', t: 0, offset: new THREE.Vector3(0, 6, 40), lookAhead: 700, fov: 64, gateIndex: 0, gateStandoff: 760 },
      { name: 'gate-close', t: 0, offset: new THREE.Vector3(34, 12, 62), lookAhead: 260, fov: 58, gateIndex: 2, gateStandoff: 230 },
      { name: 'field-dive', t: 0, offset: new THREE.Vector3(-60, 22, 130), lookAhead: 1200, fov: 70, gateIndex: 3, gateStandoff: 1900 },
      { name: 'planet-rise', t: 0, offset: new THREE.Vector3(90, -26, 180), lookAhead: 1500, fov: 74, gateIndex: 5, gateStandoff: 2600 },
      { name: 'long-run', t: 0.7, offset: new THREE.Vector3(-26, 8, 62), lookAhead: 2200, fov: 82 },
      { name: 'shelf-edge', t: 0, offset: new THREE.Vector3(120, 44, 240), lookAhead: 1600, fov: 62, gateIndex: 7, gateStandoff: 2100 },
      { name: 'terminus', t: 0, offset: new THREE.Vector3(-60, 26, 480), lookAhead: 3400, fov: 56, terminusStandoff: 4200 },
    );
  }

  private resetShipToStart(): void {
    this.ship.reset(this.course.startPosition, this.course.startQuaternion, FLIGHT.cruiseSpeed * 0.55);
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

  beginRun(): void {
    // Clearing this matters the moment any restart affordance is reachable from the pause
    // menu: without it the new run starts already frozen on the countdown.
    this.paused = false;
    void this.audio.unlock();
    this.course.reset();
    this.gateHistory.length = 0;
    this.logLines.length = 0;
    this.resetShipToStart();
    this.chase.snapTo(this.ship);
    this.elapsed = 0;
    this.topSpeed = 0;
    this.impacts = 0;
    this.lastRadio = -1;
    this.result = null;
    this.telemetry.splits = [];
    this.telemetry.bestTime = readBestTime(this.course.id);
    this.autopilot = false;
    this.cinematic = false;
    this.activeVantage = null;
    this.input.reset();
    this.countdown = 3;
    this.countdownTimer = 0;
    this.setPhase('countdown');
    this.overlay.setCountdown(3);
    this.audio.play('countdownTick');
    this.input.requestLock();
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
    if (this.paused || this.phase !== 'flying') return;
    this.paused = true;
    this.input.releaseLock();
    this.audio.suspend();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.audio.resume();
    if (this.phase === 'flying') this.input.requestLock();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  toTitle(): void {
    this.paused = false;
    this.course.reset();
    this.resetShipToStart();
    this.chase.snapTo(this.ship);
    this.elapsed = 0;
    this.autopilot = true;
    this.cinematic = true;
    this.activeVantage = this.vantages[0];
    this.input.releaseLock();
    this.setPhase('title');
  }

  // ---------------------------------------------------------------------------------
  // frame
  // ---------------------------------------------------------------------------------

  /** Advances simulation and renders one frame. Called by the rAF loop and by the harness. */
  frame(rawDt: number): void {
    if (this.disposed || this.contextLost) return;
    const dt = this.fixedTimestep ?? clamp(rawDt, 0.0005, 0.05);
    this.clock += dt;
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
   * Moves the internal resolution toward the frame budget. Deliberately slow and asymmetric:
   * it drops quickly when the frame is over budget and creeps back up when there is comfort,
   * so a single hitch never causes a visible resolution oscillation.
   */
  private adaptResolution(rawDt: number): void {
    this.adaptAccumulator += rawDt;
    this.adaptFrames++;
    if (rawDt > 0.0205) this.adaptLongFrames++;
    this.adaptCooldown -= rawDt;
    if (this.adaptFrames < 20 || this.adaptCooldown > 0) return;

    const meanMs = (this.adaptAccumulator / this.adaptFrames) * 1000;
    const missed = this.adaptLongFrames;
    this.adaptAccumulator = 0;
    this.adaptFrames = 0;
    this.adaptLongFrames = 0;

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
    if (meanMs > 18.5) {
      this.dynamicScale = Math.max(floor, this.dynamicScale - (meanMs > 26 ? 0.12 : 0.06));
      this.adaptCooldown = 0.35;
    } else if (missed === 0 && meanMs < 17.6 && this.dynamicScale < ceiling) {
      this.dynamicScale = Math.min(ceiling, this.dynamicScale + 0.03);
      this.adaptCooldown = 0.8;
    }

    if (Math.abs(this.dynamicScale - before) > 0.001) this.handleResize();
  }

  private simulate(dt: number): void {
    const command = this.resolveCommand(dt);

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
          this.pushCallout('ENGAGE', FICTION.destinationName, 'good', 1.6);
          this.radio(0);
          window.setTimeout(() => this.overlay.setCountdown(null), 700);
        }
      }
      // The ship holds a slow cruise through the countdown so the frame is never static.
      this.ship.update(dt, { ...command, throttle: 0.22, boost: false, brake: false });
    } else if (this.phase === 'flying' || this.phase === 'title' || this.phase === 'briefing') {
      this.ship.update(dt, command);
      if (this.phase === 'flying') this.elapsed += dt;
    } else {
      this.ship.update(dt, { ...command, throttle: 0.3, boost: false });
    }

    this.topSpeed = Math.max(this.topSpeed, this.ship.speed);
    this.resolveCollisions(dt);

    if (this.phase === 'flying') {
      this.course.update(this.ship.position, this.ship.speed, this.elapsed);
      this.checkArrival();
    } else if (this.phase === 'title' || this.phase === 'briefing') {
      // Keep the title flight looping forever rather than running off the end of the course.
      if (this.ship.position.distanceTo(this.course.startPosition) > SCALE.gateSpacing * 2.2) {
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
    const target = this.course.autopilotTarget(this.ship.position, this.tmpA);
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
    const gate = this.course.nextGate;
    const far = gate ? this.ship.position.distanceTo(gate.position) > gate.radius * 12 : true;
    command.boost = this.autopilotSkill > 0.75 && alignment > 0.985 && far && this.ship.energy01 > 0.45;
    command.brake = false;
    command.strafeX = 0;
    command.strafeY = 0;
    void dt;
    return command;
  }

  private resolveCollisions(dt: number): void {
    void dt;
    const shipRadius = this.ship.radius;
    let nearest = Infinity;
    for (const rock of this.asteroids.instances) {
      const dx = rock.position.x - this.ship.position.x;
      const dy = rock.position.y - this.ship.position.y;
      const dz = rock.position.z - this.ship.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const reach = rock.radius + shipRadius + 260;
      if (distSq > reach * reach) continue;

      const dist = Math.sqrt(distSq);
      nearest = Math.min(nearest, dist - rock.radius - shipRadius);

      const overlap = rock.radius + shipRadius - dist;
      if (overlap > 0 && dist > 1e-3) {
        this.tmpA.set(-dx / dist, -dy / dist, -dz / dist);
        const severity = this.ship.applyImpact(this.tmpA, overlap);
        if (severity > 0.02) {
          this.impacts++;
          this.damageFlash = Math.min(1, this.damageFlash + severity * 1.4 + 0.2);
          this.audio.play('impact', severity);
          if (severity > 0.25) this.pushCallout('HULL IMPACT', null, 'bad', 1.1);
          this.pushLog(`hull contact · ${Math.round(severity * 100)}%`, 'bad');
        }
      }
    }
    this.proximity = nearest === Infinity ? 0 : clamp01(1 - nearest / 260);
  }

  private updateProximity(dt: number): void {
    this.damageFlash = damp(this.damageFlash, 0, 0.35, dt);
    if (this.proximity > 0.72 && this.phase === 'flying') {
      if (Math.floor(this.clock * 3) !== Math.floor((this.clock - dt) * 3)) {
        this.audio.play('warnProximity', this.proximity);
      }
    }
  }

  private checkArrival(): void {
    if (!this.course.complete) return;
    const signed = this.terminus.signedDistance(this.ship.position);
    if (signed < 0) return;
    this.tmpA.copy(this.ship.position).sub(this.terminus.position);
    const along = this.tmpA.dot(this.terminus.normal);
    this.tmpA.addScaledVector(this.terminus.normal, -along);
    if (this.tmpA.length() > this.terminus.apertureRadius * 2.4) return;
    this.finish();
  }

  private finish(): void {
    if (this.phase === 'finished') return;
    const splits = this.course.passes.map((p) => p.time);
    const best = readBestTime(this.course.id);
    const isNewBest = best === null || this.elapsed < best;
    if (isNewBest) writeBestTime(this.course.id, this.elapsed);

    const par = (this.course.totalLength / FLIGHT.cruiseSpeed) * 1.06;
    const ratio = this.elapsed / par;
    const clean = this.impacts === 0;
    let rank = 'D';
    if (ratio < 0.74 && clean) rank = 'S';
    else if (ratio < 0.84) rank = 'A';
    else if (ratio < 0.96) rank = 'B';
    else if (ratio < 1.18) rank = 'C';

    this.result = {
      totalTime: this.elapsed,
      splits,
      bestTime: best,
      isNewBest,
      gatesCleared: this.course.passes.length,
      gatesTotal: this.course.gates.length,
      topSpeed: this.topSpeed,
      cleanRun: clean,
      rank,
      destinationName: FICTION.destinationName,
    };

    this.setPhase('finished');
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
    const boostBlend = damp(this.grade.warp / 0.075, boost, 0.22, dt);

    this.shipRoot.position.copy(this.ship.position);
    this.shipRoot.quaternion.copy(this.ship.quaternion);
    this.shipMeshHolder.rotation.copy(this.ship.visualLean);

    if (this.activeVantage) {
      this.applyVantage(this.activeVantage);
    } else if (this.cinematic) {
      this.updateCinematicCamera(dt);
    } else {
      this.chase.update(dt, this.ship, {
        boost: boostBlend,
        impact: this.damageFlash,
        proximity: this.proximity,
      });
    }

    this.farCamera.quaternion.copy(this.chase.camera.quaternion);
    this.farCamera.fov = this.chase.camera.fov;
    this.farCamera.aspect = this.chase.camera.aspect;
    this.farCamera.updateProjectionMatrix();

    const pixelScale = Math.max(0.6, this.renderer.domElement.height / 1080);
    this.starfield.setViewportHeight(this.renderer.domElement.height);
    this.starfield.update(this.clock);
    this.star.update(this.clock, this.farCamera);
    this.planet.update(this.clock);

    const camPos = this.chase.camera.position;
    this.asteroids.update(dt, camPos);
    this.derelicts.update(this.clock, camPos);
    this.shelfSpan.update(this.clock, camPos);
    this.terminus.update(this.clock, camPos, pixelScale);
    this.course.update3d(dt, this.clock, camPos, pixelScale);

    // Streak length is measured in seconds of travel, so it scales with actual speed. Kept
    // short at cruise and only tearing open under boost — that contrast is the point.
    const stretch = 0.003 + speed01 * 0.01 + boostBlend * 0.028;
    // Opacity is quadratic in speed: dust is nearly invisible at a crawl and only becomes a
    // wall of streaks under boost, which is where the cue is actually wanted.
    const dustOpacity = 0.05 + speed01 * speed01 * 0.24 + boostBlend * 0.3;
    this.dust.update(this.ship.position, this.ship.velocity, camPos, stretch, dustOpacity);

    this.shipModel.update(
      this.clock,
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
    this.shipModel.setVisible(!this.cinematic || this.activeVantage !== null || this.phase !== 'boot');

    this.updateGrade(dt, speed01, boostBlend);
    this.updateTelemetry(dt);
  }

  private updateCinematicCamera(dt: number): void {
    this.cinematicTime += dt;
    // A slow, wide orbit around the ship while it cruises: the title screen is a beauty shot.
    const angle = this.cinematicTime * 0.11;
    const radius = 46 + Math.sin(this.cinematicTime * 0.07) * 12;
    this.tmpA.set(Math.sin(angle) * radius, 9 + Math.sin(this.cinematicTime * 0.13) * 4, Math.cos(angle) * radius);
    this.tmpA.applyQuaternion(this.ship.quaternion).add(this.ship.position);
    this.chase.camera.position.lerp(this.tmpA, 1 - Math.exp(-dt / 0.5));
    this.ship.getForward(this.tmpB);
    this.tmpC.copy(this.ship.position).addScaledVector(this.tmpB, 30);
    this.chase.camera.up.set(0, 1, 0);
    this.chase.camera.lookAt(this.tmpC);
    if (Math.abs(this.chase.camera.fov - 58) > 0.05) {
      this.chase.camera.fov = damp(this.chase.camera.fov, 58, 0.6, dt);
      this.chase.camera.updateProjectionMatrix();
    }
  }

  private applyVantage(v: Vantage): void {
    if (v.gateIndex !== undefined && this.course.gates[v.gateIndex]) {
      const gate = this.course.gates[v.gateIndex];
      this.tmpA.copy(gate.position).addScaledVector(gate.normal, -(v.gateStandoff ?? 800));
      this.tmpQuat.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(this.tmpA, gate.position, new THREE.Vector3(0, 1, 0)),
      );
    } else if (v.terminusStandoff !== undefined) {
      this.tmpA.copy(this.terminus.position).addScaledVector(this.terminus.normal, -v.terminusStandoff);
      this.tmpQuat.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(this.tmpA, this.terminus.position, new THREE.Vector3(0, 1, 0)),
      );
    } else {
      this.course.poseAt(v.t, this.tmpA, this.tmpQuat);
    }
    this.ship.position.copy(this.tmpA);
    this.ship.quaternion.copy(this.tmpQuat);
    this.shipRoot.position.copy(this.tmpA);
    this.shipRoot.quaternion.copy(this.tmpQuat);

    this.tmpB.copy(v.offset).applyQuaternion(this.tmpQuat).add(this.tmpA);
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
    target.blurStrength = damp(target.blurStrength, speed01 * 0.012 + boost * 0.03, 0.18, dt);
    // No constant term: aberration is a speed effect, and a base value meant the title
    // screen was fringing every star while standing still.
    target.aberration = damp(target.aberration, speed01 * speed01 * 0.0035 + boost * 0.011, 0.2, dt);
    target.warp = damp(target.warp, boost * 0.075, 0.2, dt);
    target.vignette = damp(target.vignette, 0.42 + boost * 0.2 + this.proximity * 0.14, 0.3, dt);
    target.damage = clamp01(this.damageFlash * 0.9 + (1 - this.ship.hull) * 0.12);
    target.exposure = damp(target.exposure, 1.3 - boost * 0.08, 0.5, dt);
    target.saturation = damp(target.saturation, 1.07 + boost * 0.06, 0.4, dt);
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
    t.phase = this.phase;
    t.speed = num(this.ship.speed);
    t.throttle = num(this.ship.throttleSmoothed);
    t.boosting = this.ship.boosting;
    t.energy = num(this.ship.energy01);
    t.hull = num(this.ship.hull, 1);
    t.gLoad = num(this.ship.gForce);
    t.elapsed = num(this.elapsed);
    t.proximity = num(this.proximity);
    t.fps = num(this.fps, 60);
    t.courseRemaining = num(this.course.remainingDistance(this.ship.position));

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

    const gate = this.course.nextGate;
    const targetPosition = gate ? gate.position : this.terminus.position;
    t.gate.index = this.course.nextIndex;
    t.gate.total = this.course.gates.length;
    t.gate.name = gate ? gate.name : FICTION.destinationName;
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

    if (t.callout) {
      t.callout.ttl -= dt;
      if (t.callout.ttl <= 0) t.callout = null;
    }
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
  private updateBoostFeedback(): void {
    const boosting = this.ship.boosting;
    if (boosting !== this.wasBoosting) {
      this.wasBoosting = boosting;
      this.audio.play(boosting ? 'boostStart' : 'boostEnd');
    }
    const locked = this.ship.boostLocked;
    if (locked && !this.wasBoostLocked) {
      this.audio.play('boostEmpty');
      this.pushCallout('DRIVE DRY', 'RESERVE RECHARGING', 'warn', 1.2);
      this.pushLog('overdrive reserve depleted', 'warn');
    }
    this.wasBoostLocked = locked;

    // A rising tick as the aperture closes: the player should hear the gate arrive.
    const gate = this.course.nextGate;
    if (gate && this.phase === 'flying') {
      const distance = this.ship.position.distanceTo(gate.position);
      const band = distance < 900 ? Math.max(0.12, distance / 2600) : 0;
      if (band > 0) {
        this.gateTickTimer -= 1 / 60;
        if (this.gateTickTimer <= 0) {
          this.gateTickTimer = band;
          this.audio.play('gateNear', clamp01(1 - distance / 900));
        }
      } else {
        this.gateTickTimer = 0;
      }
    }
  }

  private updateAudio(dt: number): void {
    this.updateBoostFeedback();
    this.audio.update(dt, {
      throttle: this.ship.throttleSmoothed,
      speed01: this.ship.speed01,
      boosting: this.ship.boosting,
      slip: this.ship.slip,
    });
    const intensity =
      this.phase === 'flying'
        ? clamp01(0.34 + this.ship.speed01 * 0.5 + this.course.progress(this.ship.position) * 0.3)
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
    this.course.onPass = (event) => {
      this.gateHistory.push({
        index: event.index,
        time: event.time,
        radialDistance: event.radialDistance,
        speed: event.speed,
        cleared: true,
      });
      this.telemetry.splits = this.course.passes.map((p) => p.time);
      const precision = 1 - event.offset;
      this.audio.play('gatePass', clamp01(0.4 + precision * 0.6));
      const label = precision > 0.86 ? 'DEAD CENTRE' : precision > 0.6 ? 'CLEAN' : 'CLEARED';
      const remaining = this.course.gates.length - this.course.nextIndex;
      this.pushCallout(
        label,
        remaining > 0 ? `${remaining} CAIRN${remaining === 1 ? '' : 'S'} REMAINING` : 'TERMINUS AHEAD',
        precision > 0.6 ? 'good' : 'neutral',
        1.15,
      );
      this.pushLog(`cairn ${String(event.index + 1).padStart(2, '0')} · ${event.time.toFixed(2)}s`, 'good');
      this.radio(event.index + 1);
    };

    this.course.onMiss = (gate) => {
      this.audio.play('gateMiss');
      this.pushCallout('MISSED', 'REALIGN AND RE-ENTER', 'warn', 1.6);
      this.pushLog(`cairn ${String(gate.index + 1).padStart(2, '0')} missed`, 'warn');
    };
  }

  private radio(step: number): void {
    const line = RADIO_LINES.find((l) => l.at === step);
    if (!line || this.lastRadio === step) return;
    this.lastRadio = step;
    this.audio.play('radio');
    this.overlay.radio(line.speaker, line.text);
  }

  private pushCallout(title: string, sub: string | null, tone: Callout['tone'], ttl: number): void {
    this.telemetry.callout = {
      id: ++this.calloutId,
      title,
      sub: sub ?? undefined,
      tone,
      ttl,
      ttlMax: ttl,
    };
  }

  private pushLog(text: string, tone: LogLine['tone']): void {
    this.logLines.push({ id: ++this.logId, text, tone, age: 0 });
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
    this.handleResize();
  }

  /** Trims drawn populations to the current quality level. Cheap and immediate. */
  private applyQualityPopulations(): void {
    const profile = this.settings.profile;
    const max = qualityProfile('ultra');
    this.starfield.setVisibleCount(profile.starCount);
    this.dust.setVisibleCount(profile.dustCount);
    this.asteroids.setVisibleFraction(profile.asteroidCount / max.asteroidCount);
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = this.dynamicScale;
    const bufferWidth = Math.max(320, Math.round(width * dpr * scale));
    const bufferHeight = Math.max(240, Math.round(height * dpr * scale));

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(bufferWidth, bufferHeight, false);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.post.setSize(bufferWidth, bufferHeight);
    this.chase.setAspect(width / height);
    this.farCamera.aspect = width / height;
    this.farCamera.updateProjectionMatrix();
  };

  /** Fired when the browser or driver drops the GPU context. */
  onContextLost: (() => void) | null = null;

  private readonly handleContextLost = (event: Event): void => {
    // Preventing the default is what allows a restore event to ever fire.
    event.preventDefault();
    this.contextLost = true;
    this.paused = true;
    this.audio.suspend();
    this.input.releaseLock();
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
    else if (!this.paused) this.audio.resume();
  };

  // ---------------------------------------------------------------------------------
  // automation surface
  // ---------------------------------------------------------------------------------

  start(): void {
    this.bindCourseEvents();
    this.fadeTarget = 1;
    let last = performance.now();
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
      } catch (error) {
        this.errors.push(`frame: ${error instanceof Error ? error.message : String(error)}`);
        this.frameFailures++;
        // A defect that repeats every frame would otherwise spam until the tab dies.
        if (this.frameFailures > 60) {
          this.contextLost = true;
          this.onContextLost?.();
        }
      }
    };
    requestAnimationFrame(loop);
  }

  private driven = false;

  /** Hands frame pacing to the caller. Used by `__LV.step`. */
  setDriven(driven: boolean): void {
    this.driven = driven;
  }

  ready(): Promise<void> {
    return this.firstFrame;
  }

  getPhase(): Phase {
    return this.phase;
  }

  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  getResult(): RunResult | null {
    return this.result;
  }

  setHarnessInput(input: HarnessInput | null): void {
    this.harnessInput = input;
  }

  setAutopilot(enabled: boolean, skill = 1): void {
    this.autopilot = enabled;
    this.autopilotSkill = clamp(skill, 0.2, 1);
  }

  seekCourse(t: number): void {
    this.course.poseAt(clamp01(t), this.tmpA, this.tmpQuat);
    this.ship.reset(this.tmpA, this.tmpQuat, FLIGHT.cruiseSpeed);
    this.chase.snapTo(this.ship);
    for (const trail of this.trails) trail.reset();
    // Re-arm the course so gate state matches where the ship actually is.
    this.course.reset();
    const index = Math.min(this.course.gates.length - 1, Math.floor(clamp01(t) * this.course.gates.length));
    for (let i = 0; i < index; i++) {
      this.course.gates[i].setState('cleared');
    }
    this.course.nextIndex = index;
    this.course.gates[index]?.setState('armed');
  }

  setVantage(name: string): void {
    const v = this.vantages.find((x) => x.name === name);
    if (!v) throw new Error(`unknown vantage: ${name}`);
    this.activeVantage = v;
    this.cinematic = false;
    // Put the course into the state a player would actually be in at this point on the route,
    // so a screenshot shows a lit, armed cairn rather than a dormant prop.
    if (v.gateIndex !== undefined) {
      this.course.reset();
      for (let i = 0; i < v.gateIndex; i++) this.course.gates[i].setState('cleared');
      this.course.nextIndex = v.gateIndex;
      this.course.gates[v.gateIndex]?.setState('armed');
    } else if (v.terminusStandoff !== undefined) {
      this.course.reset();
      for (const gate of this.course.gates) gate.setState('cleared');
      this.course.nextIndex = this.course.gates.length;
    }
  }

  clearVantage(): void {
    this.activeVantage = null;
  }

  vantageNames(): string[] {
    return this.vantages.map((v) => v.name);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
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
    };
  }

  getActiveInput(): Required<HarnessInput> {
    const c = this.input.command;
    return {
      pitch: c.pitch,
      yaw: c.yaw,
      roll: c.roll,
      throttle: c.throttle,
      strafeX: c.strafeX,
      strafeY: c.strafeY,
      boost: c.boost,
      brake: c.brake,
    };
  }

  getGateHistory(): GatePassRecord[] {
    return this.gateHistory.slice();
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
      drawingBufferWidth: this.renderer.domElement.width,
      drawingBufferHeight: this.renderer.domElement.height,
    };
  }

  dispose(): void {
    this.disposed = true;
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
    this.starfield.dispose();
    this.star.dispose();
    this.planet.dispose();
    this.nebulaTarget.dispose();
    this.asteroids.dispose();
    this.derelicts.dispose();
    this.shelfSpan.dispose();
    this.dust.dispose();
    this.terminus.dispose();
    this.course.dispose();
    this.shipModel.dispose();
    for (const trail of this.trails) trail.dispose();
    this.renderer.dispose();
  }

  /** The seed the world was actually generated from, for reproducible reports. */
  readonly seed: number;

  get qualityProfile(): QualityProfile {
    return this.settings.profile;
  }
}
