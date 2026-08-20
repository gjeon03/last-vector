import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Flight state consumed by the procedural cockpit. `dt` is seconds, `speed` is metres/second,
 * pitch/yaw/roll and alignment are signed -1..1 values, the remaining numeric status values
 * are normalised 0..1, and `brake` is boolean.
 *
 * The interface is intentionally mutable: Game owns one instance and reuses it every frame.
 */
export interface CockpitState {
  dt: number;
  speed: number;
  speed01: number;
  throttle: number;
  energy: number;
  hull: number;
  proximity: number;
  impact: number;
  alignment: number;
  pitch: number;
  yaw: number;
  roll: number;
  boost: number;
  brake: boolean;
}

/** Small allocation-on-demand snapshot used by the deterministic visual harness. */
export interface CockpitDebugState {
  visible: boolean;
  fov: number;
  near: number;
  perspectiveScale: [number, number, number];
  drawCalls: number;
  triangles: number;
  minCameraDistance: number;
  motionX: number;
  motionY: number;
  motionZ: number;
  motionPitch: number;
  motionYaw: number;
  motionRoll: number;
  stickPitch: number;
  stickYaw: number;
  stickRoll: number;
  throttleAngle: number;
  mfdUpdates: number;
}

interface GeometryBatch {
  material: THREE.Material;
  parts: THREE.BufferGeometry[];
}

const SOLID_RENDER_ORDER = 210;
const EMISSIVE_RENDER_ORDER = 224;
const GLASS_RENDER_ORDER = 230;

const DEFAULT_STATE: CockpitState = {
  dt: 1 / 60,
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

/**
 * A camera-local, metre-authored spacecraft interior.
 *
 * Unlike the former screen-space frame, this model never compensates for field of view or
 * aspect ratio. Near controls, the instrument deck and the distant canopy therefore move by
 * different amounts under a real perspective projection. Opaque parts deliberately stay on
 * Three's transparent render list (alpha one) so they draw after world glows, while still using
 * depth testing and depth writes to behave as solid objects.
 */
export class CockpitModel {
  readonly object = new THREE.Group();

  private readonly motionRoot = new THREE.Group();
  private readonly stickRoot = new THREE.Group();
  private readonly throttleRoot = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly debugObjectInverse = new THREE.Matrix4();
  private readonly debugMeshWorld = new THREE.Matrix4();
  private readonly debugMeshToObject = new THREE.Matrix4();
  private readonly debugInstance = new THREE.Matrix4();
  private readonly debugVertex = new THREE.Vector3();
  private readonly mfdCanvas: HTMLCanvasElement;
  private readonly mfdContext: CanvasRenderingContext2D;
  private readonly mfdBackground: CanvasGradient;
  private readonly mfdTexture: THREE.CanvasTexture;
  private indicatorCoolMaterial!: THREE.MeshBasicMaterial;
  private indicatorWarmMaterial!: THREE.MeshBasicMaterial;
  private readonly glassMaterial: THREE.ShaderMaterial;
  private readonly coolFill: THREE.PointLight;
  private readonly warmKey: THREE.PointLight;

  private drawCalls = 0;
  private triangles = 0;
  private lastFov = 76;
  private lastNear = 0.1;
  private lastMfdTime = -Infinity;
  private mfdUpdates = 0;

  private motionX = 0;
  private motionY = 0;
  private motionZ = 0;
  private motionPitch = 0;
  private motionYaw = 0;
  private motionRoll = 0;
  private stickPitch = 0;
  private stickYaw = 0;
  private stickRoll = 0;
  private throttleAngle = -0.56;

  constructor() {
    this.object.name = 'immersive-cockpit';
    this.motionRoot.name = 'cockpit-head-inertia';
    this.object.add(this.motionRoot);

    // Dark painted structure, slightly lighter upward-facing panels, and two small warm accents
    // establish an interior exposure hierarchy instead of outlining the viewport in bright trim.
    const cabin = this.solidMaterial(0x0a0e13, 0.66, 0.26);
    const panel = this.solidMaterial(0x111922, 0.58, 0.18);
    const trim = this.solidMaterial(0x26333d, 0.28, 0.62);
    const recess = this.solidMaterial(0x020508, 0.82, 0.04);
    const accent = this.solidMaterial(0x71371d, 0.42, 0.38);
    const fabric = this.solidMaterial(0x211a18, 0.94, 0.02);
    const glove = this.solidMaterial(0x8e674b, 0.78, 0.01);

    const cabinBatch = this.batch(cabin);
    const panelBatch = this.batch(panel);
    const trimBatch = this.batch(trim);
    const recessBatch = this.batch(recess);
    const accentBatch = this.batch(accent);
    const fabricBatch = this.batch(fabric);

    this.buildEnclosure(cabinBatch, panelBatch, trimBatch, recessBatch, accentBatch, fabricBatch);

    // Six material-sorted static meshes replace dozens of independent decorative boxes.
    this.flushBatch(cabinBatch, SOLID_RENDER_ORDER);
    this.flushBatch(panelBatch, SOLID_RENDER_ORDER + 1);
    this.flushBatch(trimBatch, SOLID_RENDER_ORDER + 2);
    this.flushBatch(recessBatch, SOLID_RENDER_ORDER + 3);
    this.flushBatch(accentBatch, SOLID_RENDER_ORDER + 4);
    this.flushBatch(fabricBatch, SOLID_RENDER_ORDER + 1);

    this.buildRepeatedControls(accent);
    this.buildPilotControls(trim, fabric, glove);

    // A single 3-zone display atlas keeps the three large MFDs readable for one draw call.
    this.mfdCanvas = document.createElement('canvas');
    this.mfdCanvas.width = 1024;
    this.mfdCanvas.height = 256;
    const context = this.mfdCanvas.getContext('2d');
    if (!context) throw new Error('Cockpit MFD canvas unavailable');
    this.mfdContext = context;
    this.mfdBackground = context.createLinearGradient(0, 0, 0, this.mfdCanvas.height);
    this.mfdBackground.addColorStop(0, '#07131b');
    this.mfdBackground.addColorStop(1, '#010407');
    this.mfdTexture = new THREE.CanvasTexture(this.mfdCanvas);
    this.mfdTexture.colorSpace = THREE.SRGBColorSpace;
    this.mfdTexture.minFilter = THREE.LinearFilter;
    this.mfdTexture.magFilter = THREE.LinearFilter;
    this.mfdTexture.generateMipmaps = false;
    this.textures.push(this.mfdTexture);

    const mfdMaterial = new THREE.MeshBasicMaterial({
      map: this.mfdTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    this.materials.push(mfdMaterial);
    const mfdGeometry = new THREE.PlaneGeometry(1.08, 0.18);
    this.geometries.push(mfdGeometry);
    const mfd = this.registerMesh(new THREE.Mesh(mfdGeometry, mfdMaterial), EMISSIVE_RENDER_ORDER);
    mfd.name = 'three-zone-flight-mfd';
    // Sit just proud of the recessed instrument face while remaining behind its physical
    // divider rails. The previous depth placed the emissive canvas behind the recess box, so
    // the entire three-screen cluster was correctly depth-tested away and read as a blank slab.
    mfd.position.set(0, -0.425, -0.846);
    mfd.rotation.x = -0.035;

    this.glassMaterial = this.createGlassMaterial();
    this.buildCanopyGlass();

    // These lights are children of the camera-local cockpit, so highlights remain coherent with
    // the cabin while banking. The warm port key and cool starboard fill make the volume read
    // asymmetrically without illuminating the shader-based world assets.
    this.motionRoot.add(new THREE.AmbientLight(0x172433, 1.15));
    this.warmKey = new THREE.PointLight(0xff9d68, 4.2, 4.5, 2);
    this.warmKey.position.set(-0.92, 0.52, -0.36);
    this.motionRoot.add(this.warmKey);
    this.coolFill = new THREE.PointLight(0x5ab8e8, 3.1, 3.8, 2);
    this.coolFill.position.set(0.72, -0.08, -0.28);
    this.motionRoot.add(this.coolFill);

    this.drawMfd(0, DEFAULT_STATE);
    this.object.visible = false;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  update(camera: THREE.PerspectiveCamera, time: number, state: CockpitState): void {
    // Camera-local authoring is intentional, but scale is never touched: FOV and aspect retain
    // their real perspective effect across the supported 60–124 degree envelope.
    this.object.position.copy(camera.position);
    this.object.quaternion.copy(camera.quaternion);
    this.lastFov = camera.fov;
    this.lastNear = camera.near;

    const dt = clamp(Number.isFinite(state.dt) && state.dt > 0 ? state.dt : 1 / 60, 1 / 240, 0.1);
    const pitch = clamp(state.pitch, -1, 1);
    const yaw = clamp(state.yaw, -1, 1);
    const roll = clamp(state.roll, -1, 1);
    const boost = clamp01(state.boost);
    const proximity = clamp01(state.proximity);
    const impact = clamp01(state.impact);
    const speed01 = clamp01(state.speed01);

    // A restrained, critically damped head/airframe disagreement supplies the parallax the old
    // rigid overlay lacked. Inputs set the low-frequency lean; engine and impact state add only
    // millimetres of high-frequency vibration so the HUD remains easy to read.
    const targetX = clamp(-yaw * 0.014 - roll * 0.018, -0.034, 0.034);
    const targetY = clamp(-pitch * 0.012 - (state.brake ? 0.009 : 0) + boost * 0.004, -0.025, 0.025);
    const targetZ = clamp(-impact * 0.018 + (state.brake ? 0.008 : 0) - boost * 0.004, -0.024, 0.018);
    this.motionX = dampValue(this.motionX, targetX, 0.075, dt);
    this.motionY = dampValue(this.motionY, targetY, 0.085, dt);
    this.motionZ = dampValue(this.motionZ, targetZ, 0.06, dt);
    this.motionPitch = dampValue(this.motionPitch, pitch * 0.012 + (state.brake ? 0.008 : 0), 0.07, dt);
    this.motionYaw = dampValue(this.motionYaw, yaw * 0.009, 0.08, dt);
    this.motionRoll = dampValue(this.motionRoll, roll * 0.026, 0.09, dt);

    const vibration = (boost * 0.7 + proximity * 0.22 + speed01 * 0.13 + impact * 1.1) * 0.0022;
    const vibrationX = Math.sin(time * 47.3) * vibration;
    const vibrationY = Math.sin(time * 61.7 + 0.8) * vibration * 0.72;
    const vibrationZ = Math.sin(time * 37.9 + 1.7) * vibration * 0.42;
    this.motionRoot.position.set(
      this.motionX + vibrationX,
      this.motionY + vibrationY,
      this.motionZ + vibrationZ,
    );
    this.motionRoot.rotation.set(
      this.motionPitch + vibrationY * 0.34,
      this.motionYaw + vibrationX * 0.28,
      this.motionRoll + Math.sin(time * 53.1) * vibration * 0.45,
      'YXZ',
    );

    this.stickPitch = dampValue(this.stickPitch, -pitch * 0.24, 0.045, dt);
    this.stickYaw = dampValue(this.stickYaw, yaw * 0.12, 0.055, dt);
    this.stickRoll = dampValue(this.stickRoll, -roll * 0.31, 0.04, dt);
    this.stickRoot.rotation.set(this.stickPitch, this.stickYaw, this.stickRoll, 'YXZ');

    const throttleTarget = -0.56 + clamp01(state.throttle) * 0.78 + boost * 0.14 - (state.brake ? 0.18 : 0);
    this.throttleAngle = dampValue(this.throttleAngle, throttleTarget, state.brake ? 0.035 : 0.075, dt);
    this.throttleRoot.rotation.x = this.throttleAngle;

    this.indicatorCoolMaterial.opacity = 0.5 + boost * 0.35 + Math.sin(time * 4.2) * 0.05;
    this.indicatorWarmMaterial.opacity = 0.42 + Math.max(impact, proximity * 0.75, 1 - clamp01(state.hull)) * 0.5;
    this.warmKey.intensity = 3.8 + boost * 1.2 + impact * 2.2;
    this.coolFill.intensity = 2.7 + clamp01(state.energy) * 0.8;
    this.glassMaterial.uniforms.uTime.value = time;
    this.glassMaterial.uniforms.uBoost.value = boost;
    this.glassMaterial.uniforms.uRoll.value = roll;
    this.glassMaterial.uniforms.uImpact.value = impact;

    if (time - this.lastMfdTime >= 1 / 20 || time < this.lastMfdTime) {
      this.drawMfd(time, state);
    }
  }

  getDebugState(): CockpitDebugState {
    return {
      visible: this.object.visible,
      fov: this.lastFov,
      near: this.lastNear,
      perspectiveScale: [this.object.scale.x, this.object.scale.y, this.object.scale.z],
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      minCameraDistance: this.measureMinCameraDistance(),
      motionX: this.motionRoot.position.x,
      motionY: this.motionRoot.position.y,
      motionZ: this.motionRoot.position.z,
      motionPitch: this.motionRoot.rotation.x,
      motionYaw: this.motionRoot.rotation.y,
      motionRoll: this.motionRoot.rotation.z,
      stickPitch: this.stickPitch,
      stickYaw: this.stickYaw,
      stickRoll: this.stickRoll,
      throttleAngle: this.throttleAngle,
      mfdUpdates: this.mfdUpdates,
    };
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
  }

  private buildEnclosure(
    cabin: GeometryBatch,
    panel: GeometryBatch,
    trim: GeometryBatch,
    recess: GeometryBatch,
    accent: GeometryBatch,
    fabric: GeometryBatch,
  ): void {
    // Thick glareshield and recessed instrument face. The top edge projects below 61% screen
    // height at normal flight FOV, leaving the requested central x30–70/y24–61 safe rectangle.
    this.addQuad(panel, [
      new THREE.Vector3(-0.82, -0.255, -0.75),
      new THREE.Vector3(0.82, -0.255, -0.75),
      new THREE.Vector3(0.98, -0.34, -1.07),
      new THREE.Vector3(-0.98, -0.34, -1.07),
    ]);
    this.addBar(cabin, new THREE.Vector3(-0.82, -0.285, -0.73), new THREE.Vector3(0.82, -0.285, -0.73), 0.04, 0.12);
    this.addBox(panel, new THREE.Vector3(0, -0.425, -0.94), new THREE.Vector3(1.21, 0.235, 0.13), new THREE.Euler(-0.03, 0, 0));
    this.addBox(recess, new THREE.Vector3(0, -0.425, -0.865), new THREE.Vector3(1.13, 0.2, 0.025));
    this.addBar(trim, new THREE.Vector3(-0.59, -0.535, -0.842), new THREE.Vector3(0.59, -0.535, -0.842), 0.024, 0.032);
    for (const x of [-0.19, 0.19]) {
      this.addBox(trim, new THREE.Vector3(x, -0.425, -0.842), new THREE.Vector3(0.018, 0.2, 0.018));
    }

    // Lower canopy sills run away from the pilot, then turn upward into broad angled A-pillars.
    // Their actual z separation from the controls makes FOV changes reveal physical parallax.
    for (const side of [-1, 1]) {
      this.addBar(
        cabin,
        new THREE.Vector3(side * 0.74, -0.245, -0.82),
        new THREE.Vector3(side * 1.45, -0.275, -1.56),
        0.12,
        0.17,
      );
      this.addBar(
        trim,
        new THREE.Vector3(side * 0.76, -0.22, -0.8),
        new THREE.Vector3(side * 1.42, -0.245, -1.54),
        0.025,
        0.185,
      );
      this.addBar(
        cabin,
        new THREE.Vector3(side * 1.45, -0.275, -1.56),
        new THREE.Vector3(side * 1.08, 0.79, -1.72),
        0.145,
        0.18,
      );
      this.addBar(
        trim,
        new THREE.Vector3(side * 1.405, -0.23, -1.50),
        new THREE.Vector3(side * 1.045, 0.77, -1.66),
        0.027,
        0.195,
      );
      this.addBar(
        cabin,
        new THREE.Vector3(side * 1.08, 0.79, -1.72),
        new THREE.Vector3(side * 0.43, 0.96, -1.03),
        0.115,
        0.16,
      );
    }

    // The centre post is deliberately short: it ends above the flight-safe zone while giving
    // the roof a believable structural load path.
    this.addBar(cabin, new THREE.Vector3(0, 0.755, -1.52), new THREE.Vector3(0, 1.07, -0.94), 0.075, 0.14);
    this.addBar(trim, new THREE.Vector3(0, 0.775, -1.48), new THREE.Vector3(0, 1.04, -0.96), 0.018, 0.155);

    // A raked overhead panel projects as a converging ceiling rather than a horizontal UI bar.
    this.addQuad(panel, [
      new THREE.Vector3(-0.76, 0.755, -1.53),
      new THREE.Vector3(0.76, 0.755, -1.53),
      new THREE.Vector3(0.62, 1.02, -0.78),
      new THREE.Vector3(-0.62, 1.02, -0.78),
    ]);
    this.addBar(cabin, new THREE.Vector3(-0.78, 0.75, -1.55), new THREE.Vector3(0.78, 0.75, -1.55), 0.085, 0.15);
    this.addBar(trim, new THREE.Vector3(-0.7, 0.785, -1.44), new THREE.Vector3(0.7, 0.785, -1.44), 0.018, 0.035);
    this.addBar(cabin, new THREE.Vector3(-0.64, 1.02, -0.79), new THREE.Vector3(0.64, 1.02, -0.79), 0.095, 0.16);
    for (const side of [-1, 1]) {
      this.addBar(
        trim,
        new THREE.Vector3(side * 0.735, 0.77, -1.48),
        new THREE.Vector3(side * 0.6, 1.0, -0.82),
        0.022,
        0.045,
      );
    }

    // Four inset overhead bays, their seams and labels sit slightly proud of the roof plane.
    // They share the existing static batches, so the ceiling gains readable spacecraft scale
    // without adding a draw call or turning into a bright screen-space banner.
    for (const centreX of [-0.45, -0.15, 0.15, 0.45]) {
      this.addQuad(recess, [
        new THREE.Vector3(centreX * 1.1 - 0.12, 0.78, -1.505),
        new THREE.Vector3(centreX * 1.1 + 0.12, 0.78, -1.505),
        new THREE.Vector3(centreX + 0.1, 0.985, -0.83),
        new THREE.Vector3(centreX - 0.1, 0.985, -0.83),
      ]);
      this.addBox(
        accent,
        new THREE.Vector3(centreX, 0.875, -1.145),
        new THREE.Vector3(0.09, 0.012, 0.018),
        new THREE.Euler(-0.34, 0, 0),
      );
    }
    for (const x of [-0.3, 0, 0.3]) {
      this.addBar(
        trim,
        new THREE.Vector3(x * 1.08, 0.785, -1.48),
        new THREE.Vector3(x, 0.98, -0.84),
        0.014,
        0.02,
      );
    }
    this.addBar(trim, new THREE.Vector3(-0.59, 0.885, -1.16), new THREE.Vector3(0.59, 0.885, -1.16), 0.014, 0.02);

    // Long side consoles pass the eye toward the canopy sill. Their near ends disappear through
    // the lower corners, a strong human-scale depth cue that does not narrow the centre window.
    for (const side of [-1, 1]) {
      this.addQuad(panel, [
        new THREE.Vector3(side * 0.5, -0.42, -0.48),
        new THREE.Vector3(side * 0.76, -0.35, -0.62),
        new THREE.Vector3(side * 1.23, -0.38, -1.43),
        new THREE.Vector3(side * 0.79, -0.52, -0.72),
      ]);
      this.addQuad(cabin, [
        new THREE.Vector3(side * 0.5, -0.46, -0.48),
        new THREE.Vector3(side * 0.79, -0.52, -0.72),
        new THREE.Vector3(side * 1.23, -0.61, -1.43),
        new THREE.Vector3(side * 0.74, -0.62, -0.58),
      ]);
      this.addBar(
        trim,
        new THREE.Vector3(side * 0.5, -0.42, -0.48),
        new THREE.Vector3(side * 1.21, -0.355, -1.4),
        0.035,
        0.055,
      );
      this.addBox(recess, new THREE.Vector3(side * 0.67, -0.405, -0.55), new THREE.Vector3(0.18, 0.025, 0.21), new THREE.Euler(0, side * 0.12, 0));
    }

    // Warning stripes and hard seams are short, never a full-screen glowing outline.
    this.addBox(accent, new THREE.Vector3(-0.61, -0.266, -0.695), new THREE.Vector3(0.19, 0.018, 0.025));
    this.addBox(accent, new THREE.Vector3(0.61, -0.266, -0.695), new THREE.Vector3(0.19, 0.018, 0.025));
    this.addBox(recess, new THREE.Vector3(-0.55, -0.39, -0.61), new THREE.Vector3(0.13, 0.045, 0.04));
    this.addBox(recess, new THREE.Vector3(0.55, -0.39, -0.61), new THREE.Vector3(0.13, 0.045, 0.04));

    // Seat bolsters, suit sleeves and crossed harness straps put familiar dimensions close to the
    // eye. They stay in the lower outer quarters and never enter the central flight aperture.
    for (const side of [-1, 1]) {
      this.addBox(fabric, new THREE.Vector3(side * 0.53, -0.73, -0.29), new THREE.Vector3(0.23, 0.28, 0.23), new THREE.Euler(0.12, 0, side * 0.08));
      this.addBar(
        accent,
        new THREE.Vector3(side * 0.47, -0.79, -0.27),
        new THREE.Vector3(side * 0.25, -0.63, -0.39),
        0.045,
        0.018,
      );
    }
    this.addBox(trim, new THREE.Vector3(0, -0.72, -0.31), new THREE.Vector3(0.11, 0.08, 0.04));

    // Continuous inner console shoulders bind the controls to the sidewalls. Earlier rows of
    // floating vent slats broke into bracket-like shards during banked views.
    for (const side of [-1, 1]) {
      this.addBar(
        panel,
        new THREE.Vector3(side * 0.5, -0.49, -0.48),
        new THREE.Vector3(side * 0.78, -0.48, -0.78),
        0.16,
        0.11,
      );
      this.addBar(
        trim,
        new THREE.Vector3(side * 0.49, -0.435, -0.47),
        new THREE.Vector3(side * 0.75, -0.425, -0.75),
        0.024,
        0.12,
      );
    }
  }

  private buildRepeatedControls(accent: THREE.Material): void {
    const switchGeometry = new THREE.BoxGeometry(0.024, 0.045, 0.022);
    this.geometries.push(switchGeometry);
    const switchCount = 30;
    const switches = new THREE.InstancedMesh(switchGeometry, accent, switchCount);
    switches.name = 'cockpit-switch-bank';
    const dummy = new THREE.Object3D();
    let instance = 0;
    for (let row = 0; row < 3; row++) {
      const rowT = (row + 0.5) / 3;
      for (let column = 0; column < 8; column++) {
        dummy.position.set(
          -0.48 + column * 0.137,
          THREE.MathUtils.lerp(0.79, 0.96, rowT),
          THREE.MathUtils.lerp(-1.39, -0.91, rowT),
        );
        dummy.rotation.set(-0.38, 0, (column % 3 - 1) * 0.08);
        dummy.scale.set(1, column % 2 === 0 ? 1 : 0.72, 1);
        dummy.updateMatrix();
        switches.setMatrixAt(instance++, dummy.matrix);
      }
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        dummy.position.set(side * (0.62 + i * 0.07), -0.37, -0.54 - i * 0.065);
        dummy.rotation.set(0.16, side * 0.18, 0);
        dummy.scale.set(0.75, 0.7, 0.75);
        dummy.updateMatrix();
        switches.setMatrixAt(instance++, dummy.matrix);
      }
    }
    switches.instanceMatrix.needsUpdate = true;
    this.registerMesh(switches, SOLID_RENDER_ORDER + 5, this.motionRoot, switchCount);

    const boltGeometry = new THREE.CylinderGeometry(0.009, 0.009, 0.008, 8, 1, false);
    boltGeometry.rotateX(Math.PI * 0.5);
    this.geometries.push(boltGeometry);
    const boltPositions: THREE.Vector3[] = [];
    for (const x of [-0.55, -0.19, 0.19, 0.55]) {
      boltPositions.push(new THREE.Vector3(x, -0.315, -0.835), new THREE.Vector3(x, -0.535, -0.835));
    }
    for (const side of [-1, 1]) {
      boltPositions.push(
        new THREE.Vector3(side * 1.39, -0.18, -1.48),
        new THREE.Vector3(side * 1.21, 0.35, -1.57),
        new THREE.Vector3(side * 1.06, 0.73, -1.61),
      );
    }
    const bolts = new THREE.InstancedMesh(boltGeometry, accent, boltPositions.length);
    bolts.name = 'cockpit-fasteners';
    for (let i = 0; i < boltPositions.length; i++) {
      dummy.position.copy(boltPositions[i]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      bolts.setMatrixAt(i, dummy.matrix);
    }
    bolts.instanceMatrix.needsUpdate = true;
    this.registerMesh(bolts, SOLID_RENDER_ORDER + 6, this.motionRoot, boltPositions.length);

    this.indicatorCoolMaterial = this.emissiveMaterial(0x58d9ff, 0.62);
    this.indicatorWarmMaterial = this.emissiveMaterial(0xff8a46, 0.52);
    this.buildIndicatorBank(this.indicatorCoolMaterial, -0.26, 6);
    this.buildIndicatorBank(this.indicatorWarmMaterial, 0.26, 6);
    this.buildOverheadStatusLights(this.indicatorCoolMaterial);
  }

  private buildIndicatorBank(material: THREE.Material, centreX: number, count: number): void {
    const geometry = new THREE.BoxGeometry(0.026, 0.012, 0.009);
    this.geometries.push(geometry);
    const indicators = new THREE.InstancedMesh(geometry, material, count);
    indicators.name = centreX < 0 ? 'cool-status-lights' : 'warm-warning-lights';
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(centreX + (i - (count - 1) * 0.5) * 0.043, -0.275, -0.695);
      dummy.updateMatrix();
      indicators.setMatrixAt(i, dummy.matrix);
    }
    indicators.instanceMatrix.needsUpdate = true;
    this.registerMesh(indicators, EMISSIVE_RENDER_ORDER, this.motionRoot, count);
  }

  private buildOverheadStatusLights(material: THREE.Material): void {
    const geometry = new THREE.BoxGeometry(0.025, 0.016, 0.018);
    this.geometries.push(geometry);
    const count = 10;
    const lights = new THREE.InstancedMesh(geometry, material, count);
    lights.name = 'overhead-status-lights';
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 5);
      const column = i % 5;
      dummy.position.set(-0.3 + column * 0.15, 0.86 + row * 0.055, -1.17 + row * 0.16);
      dummy.rotation.set(-0.34, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      lights.setMatrixAt(i, dummy.matrix);
    }
    lights.instanceMatrix.needsUpdate = true;
    this.registerMesh(lights, EMISSIVE_RENDER_ORDER + 1, this.motionRoot, count);
  }

  private buildPilotControls(
    trim: THREE.Material,
    fabric: THREE.Material,
    glove: THREE.Material,
  ): void {
    // Right flight stick: metal/grip and the pilot's hand/forearm are separately batched so the
    // whole assembly pivots together with pitch, yaw and roll input in two draw calls.
    this.stickRoot.name = 'right-flight-stick';
    this.stickRoot.position.set(0.38, -0.57, -0.55);
    this.motionRoot.add(this.stickRoot);
    const stickMetal = this.batch(trim);
    this.addCylinder(stickMetal, new THREE.Vector3(0, 0.08, 0), 0.024, 0.024, 0.18, 10);
    this.addBox(stickMetal, new THREE.Vector3(0, 0.19, -0.005), new THREE.Vector3(0.065, 0.11, 0.055), new THREE.Euler(-0.16, 0, 0));
    this.addBox(stickMetal, new THREE.Vector3(-0.025, 0.24, -0.034), new THREE.Vector3(0.027, 0.02, 0.018));
    this.flushBatch(stickMetal, SOLID_RENDER_ORDER + 7, this.stickRoot);

    const stickPilot = this.batch(glove);
    this.addSphere(stickPilot, new THREE.Vector3(-0.008, 0.18, 0.028), new THREE.Vector3(0.055, 0.072, 0.05), 12, 8);
    this.addCylinderBetween(stickPilot, new THREE.Vector3(-0.13, -0.12, 0.2), new THREE.Vector3(-0.018, 0.14, 0.055), 0.048, 10);
    this.flushBatch(stickPilot, SOLID_RENDER_ORDER + 8, this.stickRoot);

    // A dark cuff visually separates the glove from the warm suit sleeve without another mesh.
    const stickSleeve = this.batch(fabric);
    this.addCylinderBetween(stickSleeve, new THREE.Vector3(-0.17, -0.18, 0.24), new THREE.Vector3(-0.105, -0.075, 0.16), 0.062, 10);
    this.flushBatch(stickSleeve, SOLID_RENDER_ORDER + 7, this.stickRoot);

    // Left throttle travels through a real arc. The hand and lever share its pivot, while the
    // console slot below remains static and makes the motion immediately legible.
    this.throttleRoot.name = 'left-throttle';
    this.throttleRoot.position.set(-0.38, -0.49, -0.55);
    this.throttleRoot.rotation.x = this.throttleAngle;
    this.motionRoot.add(this.throttleRoot);
    const throttleMetal = this.batch(trim);
    this.addCylinder(throttleMetal, new THREE.Vector3(0, 0.09, 0), 0.018, 0.018, 0.19, 10);
    this.addBox(throttleMetal, new THREE.Vector3(0, 0.19, 0), new THREE.Vector3(0.09, 0.065, 0.075), new THREE.Euler(0.08, 0, 0));
    this.flushBatch(throttleMetal, SOLID_RENDER_ORDER + 7, this.throttleRoot);

    const throttlePilot = this.batch(glove);
    this.addSphere(throttlePilot, new THREE.Vector3(0.012, 0.17, 0.025), new THREE.Vector3(0.061, 0.065, 0.052), 12, 8);
    this.addCylinderBetween(throttlePilot, new THREE.Vector3(0.15, -0.14, 0.21), new THREE.Vector3(0.025, 0.13, 0.06), 0.048, 10);
    this.flushBatch(throttlePilot, SOLID_RENDER_ORDER + 8, this.throttleRoot);

    const throttleSleeve = this.batch(fabric);
    this.addCylinderBetween(throttleSleeve, new THREE.Vector3(0.19, -0.2, 0.25), new THREE.Vector3(0.12, -0.09, 0.17), 0.064, 10);
    this.flushBatch(throttleSleeve, SOLID_RENDER_ORDER + 7, this.throttleRoot);
  }

  private buildCanopyGlass(): void {
    const parts = [
      this.quadGeometry([
        new THREE.Vector3(-1.34, -0.22, -1.74),
        new THREE.Vector3(1.34, -0.22, -1.74),
        new THREE.Vector3(1.03, 0.78, -1.78),
        new THREE.Vector3(-1.03, 0.78, -1.78),
      ]),
      this.quadGeometry([
        new THREE.Vector3(-1.34, -0.22, -1.74),
        new THREE.Vector3(-1.78, -0.3, -1.5),
        new THREE.Vector3(-1.44, 0.64, -1.56),
        new THREE.Vector3(-1.03, 0.78, -1.78),
      ]),
      this.quadGeometry([
        new THREE.Vector3(1.78, -0.3, -1.5),
        new THREE.Vector3(1.34, -0.22, -1.74),
        new THREE.Vector3(1.03, 0.78, -1.78),
        new THREE.Vector3(1.44, 0.64, -1.56),
      ]),
    ];
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    this.geometries.push(geometry);
    const glass = this.registerMesh(new THREE.Mesh(geometry, this.glassMaterial), GLASS_RENDER_ORDER);
    glass.name = 'canopy-glass';
  }

  private drawMfd(time: number, state: CockpitState): void {
    const ctx = this.mfdContext;
    const width = this.mfdCanvas.width;
    const height = this.mfdCanvas.height;
    const energy = clamp01(state.energy);
    const hull = clamp01(state.hull);
    const throttle = clamp01(state.throttle);
    const proximity = clamp01(state.proximity);
    const alignment = clamp01((state.alignment + 1) * 0.5);
    const boost = clamp01(state.boost);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.mfdBackground;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(102, 213, 240, 0.22)';
    ctx.lineWidth = 3;
    ctx.strokeRect(15.5, 12.5, 289, height - 25);
    ctx.strokeRect(327.5, 12.5, 369, height - 25);
    ctx.strokeRect(719.5, 12.5, 289, height - 25);
    ctx.fillStyle = 'rgba(160, 225, 239, 0.76)';
    ctx.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('ATTITUDE', 28, 39);
    ctx.fillText('VECTOR / RANGE', 342, 39);
    ctx.fillText('SHIP SYSTEMS', 734, 39);

    // Left MFD: clipped attitude horizon and pitch ladder.
    ctx.save();
    ctx.beginPath();
    ctx.rect(24, 50, 272, 180);
    ctx.clip();
    ctx.translate(160, 145 + clamp(state.pitch, -1, 1) * 34);
    ctx.rotate(clamp(state.roll, -1, 1) * 0.42);
    ctx.fillStyle = 'rgba(46, 116, 139, 0.22)';
    ctx.fillRect(-220, -130, 440, 130);
    ctx.fillStyle = 'rgba(133, 72, 42, 0.18)';
    ctx.fillRect(-220, 0, 440, 130);
    ctx.strokeStyle = '#7de5f2';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-175, 0);
    ctx.lineTo(175, 0);
    ctx.stroke();
    ctx.lineWidth = 2;
    for (let rung = -3; rung <= 3; rung++) {
      if (rung === 0) continue;
      const y = rung * 24;
      const half = rung % 2 === 0 ? 54 : 34;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#d7f7fb';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(116, 144);
    ctx.lineTo(145, 144);
    ctx.lineTo(160, 158);
    ctx.lineTo(175, 144);
    ctx.lineTo(204, 144);
    ctx.stroke();

    // Centre MFD: speed, alignment diamond and a proximity radar bloom.
    ctx.fillStyle = boost > 0.25 ? '#fff0bc' : '#e8fbff';
    ctx.font = '700 49px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.max(0, Math.round(state.speed)).toString().padStart(4, '0')}`, 512, 102);
    ctx.fillStyle = 'rgba(150, 221, 235, 0.64)';
    ctx.font = '600 17px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('M / S', 512, 125);
    const radarX = 512;
    const radarY = 183;
    const radarRadius = 42 + proximity * 25;
    ctx.strokeStyle = proximity > 0.65 ? '#ff8a53' : 'rgba(90, 220, 244, 0.72)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(radarX, radarY, radarRadius, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    const diamond = 11 + (1 - alignment) * 22;
    ctx.save();
    ctx.translate(radarX, radarY - 10);
    ctx.rotate(Math.PI * 0.25 + state.yaw * 0.08);
    ctx.strokeRect(-diamond, -diamond, diamond * 2, diamond * 2);
    ctx.restore();
    ctx.fillStyle = proximity > 0.72 ? '#ffad69' : '#75e9ff';
    ctx.fillRect(radarX - 2, radarY - 57 + Math.sin(time * 3.4) * 3, 4, 13);

    // Right MFD: physical resource bars and clear numeric labels.
    ctx.textAlign = 'left';
    this.drawMfdBar(ctx, 'ENG', energy, '#55daf5', 0);
    this.drawMfdBar(ctx, 'HULL', hull, hull < 0.35 ? '#ff7956' : '#8ee6c7', 1);
    this.drawMfdBar(ctx, 'THR', throttle, boost > 0.2 ? '#ffd279' : '#72bfff', 2);
    if (state.brake || hull < 0.35 || proximity > 0.72) {
      ctx.fillStyle = hull < 0.35 ? '#ff7453' : '#ffb468';
      ctx.font = '700 17px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(state.brake ? 'RETRO BRAKE' : hull < 0.35 ? 'HULL WARN' : 'PROX WARN', 738, 239);
    }

    // Fine scanlines keep the panel technological without brightening a large connected area.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);

    this.mfdTexture.needsUpdate = true;
    this.lastMfdTime = time;
    this.mfdUpdates++;
  }

  private drawMfdBar(
    ctx: CanvasRenderingContext2D,
    label: string,
    value: number,
    color: string,
    index: number,
  ): void {
    const y = 70 + index * 55;
    ctx.fillStyle = 'rgba(203, 239, 245, 0.7)';
    ctx.font = '600 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(label, 738, y + 14);
    ctx.fillStyle = 'rgba(18, 42, 50, 0.9)';
    ctx.fillRect(804, y, 174, 17);
    ctx.fillStyle = color;
    ctx.fillRect(804, y, 174 * value, 17);
    ctx.fillStyle = 'rgba(230, 250, 252, 0.8)';
    ctx.font = '600 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`${Math.round(value * 100).toString().padStart(3, '0')}%`, 926, y + 37);
  }

  private solidMaterial(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
      toneMapped: true,
      side: THREE.FrontSide,
    });
    this.materials.push(material);
    return material;
  }

  private emissiveMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    this.materials.push(material);
    return material;
  }

  private createGlassMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBoost: { value: 0 },
        uRoll: { value: 0 },
        uImpact: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewPosition;
        void main() {
          vUv = uv;
          vNormalView = normalize(normalMatrix * normal);
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = viewPosition.xyz;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uBoost;
        uniform float uRoll;
        uniform float uImpact;
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewPosition;
        void main() {
          vec3 V = normalize(-vViewPosition);
          float fresnel = pow(1.0 - abs(dot(normalize(vNormalView), V)), 3.2);
          float sweep = exp(-pow((vUv.y - 0.78) * 9.0 + (vUv.x - 0.5) * 1.7 - sin(uTime * 0.12) * 0.4, 2.0));
          float panelReflection = exp(-pow((vUv.x - 0.5 - uRoll * 0.04) * 4.0, 2.0))
            * exp(-pow((vUv.y - 0.08) * 11.0, 2.0));
          float alpha = 0.009 + fresnel * (0.08 + uBoost * 0.025) + sweep * 0.012
            + panelReflection * 0.018 + uImpact * 0.012;
          vec3 color = mix(vec3(0.10, 0.34, 0.43), vec3(0.57, 0.76, 0.84), fresnel);
          color += vec3(0.11, 0.36, 0.48) * panelReflection;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.materials.push(material);
    return material;
  }

  private batch(material: THREE.Material): GeometryBatch {
    return { material, parts: [] };
  }

  private flushBatch(
    batch: GeometryBatch,
    renderOrder: number,
    parent: THREE.Object3D = this.motionRoot,
  ): THREE.Mesh | null {
    if (batch.parts.length === 0) return null;
    const geometry = mergeGeometries(batch.parts, false);
    for (const part of batch.parts) part.dispose();
    batch.parts.length = 0;
    this.geometries.push(geometry);
    return this.registerMesh(new THREE.Mesh(geometry, batch.material), renderOrder, parent);
  }

  private registerMesh<T extends THREE.Mesh>(
    mesh: T,
    renderOrder: number,
    parent: THREE.Object3D = this.motionRoot,
    instanceCount = 1,
  ): T {
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    parent.add(mesh);
    this.meshes.push(mesh);
    this.drawCalls++;
    const geometry = mesh.geometry;
    const triangles = geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute('position').count / 3;
    this.triangles += Math.round(triangles * instanceCount);
    return mesh;
  }

  /**
   * Measures every rendered vertex in camera-local space, including instance transforms and the
   * current head-inertia rig. This is intentionally debug-only: it makes the near-plane contract
   * evidence-based without adding a vertex walk to normal frames.
   */
  private measureMinCameraDistance(): number {
    this.object.updateMatrixWorld(true);
    this.debugObjectInverse.copy(this.object.matrixWorld).invert();
    let minimum = Number.POSITIVE_INFINITY;

    for (const mesh of this.meshes) {
      const position = mesh.geometry.getAttribute('position');
      if (!position) continue;

      if (mesh instanceof THREE.InstancedMesh) {
        for (let instance = 0; instance < mesh.count; instance++) {
          mesh.getMatrixAt(instance, this.debugInstance);
          this.debugMeshWorld.multiplyMatrices(mesh.matrixWorld, this.debugInstance);
          this.debugMeshToObject.multiplyMatrices(this.debugObjectInverse, this.debugMeshWorld);
          minimum = this.measureAttributeDepth(position, this.debugMeshToObject, minimum);
        }
      } else {
        this.debugMeshToObject.multiplyMatrices(this.debugObjectInverse, mesh.matrixWorld);
        minimum = this.measureAttributeDepth(position, this.debugMeshToObject, minimum);
      }
    }

    return Number.isFinite(minimum) ? minimum : 0;
  }

  private measureAttributeDepth(
    position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    transform: THREE.Matrix4,
    minimum: number,
  ): number {
    for (let vertex = 0; vertex < position.count; vertex++) {
      this.debugVertex
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(transform);
      minimum = Math.min(minimum, -this.debugVertex.z);
    }
    return minimum;
  }

  private addBox(
    batch: GeometryBatch,
    position: THREE.Vector3,
    scale: THREE.Vector3,
    rotation = new THREE.Euler(),
  ): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const matrix = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      scale,
    );
    geometry.applyMatrix4(matrix);
    batch.parts.push(geometry);
  }

  private addBar(
    batch: GeometryBatch,
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    depth: number,
  ): void {
    const delta = to.clone().sub(from);
    const length = delta.length();
    const position = from.clone().add(to).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(width, length, depth)));
    batch.parts.push(geometry);
  }

  private addCylinder(
    batch: GeometryBatch,
    position: THREE.Vector3,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    segments: number,
    rotation = new THREE.Euler(),
  ): void {
    const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, false);
    geometry.applyMatrix4(new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      new THREE.Vector3(1, 1, 1),
    ));
    batch.parts.push(geometry);
  }

  private addCylinderBetween(
    batch: GeometryBatch,
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    segments: number,
  ): void {
    const delta = to.clone().sub(from);
    const length = delta.length();
    const position = from.clone().add(to).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    const geometry = new THREE.CylinderGeometry(radius, radius * 0.86, length, segments, 1, false);
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)));
    batch.parts.push(geometry);
  }

  private addSphere(
    batch: GeometryBatch,
    position: THREE.Vector3,
    scale: THREE.Vector3,
    widthSegments: number,
    heightSegments: number,
  ): void {
    const geometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion(), scale));
    batch.parts.push(geometry);
  }

  private addQuad(batch: GeometryBatch, points: readonly THREE.Vector3[]): void {
    batch.parts.push(this.quadGeometry(points));
  }

  private quadGeometry(points: readonly THREE.Vector3[]): THREE.BufferGeometry {
    if (points.length !== 4) throw new Error('Cockpit quads require exactly four points');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => point.toArray()), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));

    const normal = new THREE.Vector3()
      .subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0]));
    const centre = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(0.25);
    const towardCamera = centre.multiplyScalar(-1);
    geometry.setIndex(normal.dot(towardCamera) >= 0
      ? [0, 1, 2, 0, 2, 3]
      : [0, 2, 1, 0, 3, 2]);
    geometry.computeVertexNormals();
    return geometry;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function dampValue(current: number, target: number, tau: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
}
