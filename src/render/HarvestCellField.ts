import * as THREE from 'three';
import { clamp01 } from '../core/mathx.ts';

/** Logical HARVEST source surface observed by the renderer. */
export interface HarvestCellSourceView {
  readonly id: number | string;
  readonly position: THREE.Vector3;
  readonly phase?: number;
  readonly charge?: number;
  readonly alive?: boolean;
  readonly generation?: number;
  readonly collected?: boolean;
}

export interface HarvestCellFieldDebug {
  readonly activeSources: number;
  readonly sourceDrawCalls: number;
  readonly sourceGeometries: number;
  readonly sourceMaterials: number;
  readonly sourceTriangles: number;
  readonly structureDrawCalls: 0;
  readonly structureTriangles: 0;
  readonly colliders: 0;
}

const CELL_VERT = /* glsl */ `
  varying vec2 vUv;
  uniform float uScale;

  void main() {
    vUv = uv;
    vec4 origin = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 corner = (uv - 0.5) * uScale;
    vec4 view = origin + vec4(corner, 0.0, 0.0);
    gl_Position = projectionMatrix * view;
  }
`;

const CELL_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uPhase;
  uniform float uCharge;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    float core = pow(clamp(1.0 - r / 0.28, 0.0, 1.0), 1.6);
    float bloom = pow(clamp(1.0 - r, 0.0, 1.0), 2.6);
    float ring = smoothstep(0.62, 0.52, r) * smoothstep(0.34, 0.46, r);

    float urgency = 1.0 - clamp(uCharge, 0.0, 1.0);
    float beat = 2.7 + urgency * urgency * 9.0;
    float pulse = (0.82 + 0.18 * sin(uTime * beat + uPhase)) * (1.0 - urgency * 0.35);
    vec3 warn = vec3(1.0, 0.55, 0.18);
    vec3 tint = mix(uColor, warn, smoothstep(0.45, 1.0, urgency));

    vec3 colour = tint * (bloom * 0.9 + ring * (0.7 - urgency * 0.35))
      + vec3(1.0) * core * (1.0 - urgency * 0.4);
    float alpha = clamp(core + bloom * 0.75 + ring * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(colour * uIntensity * pulse, alpha * uIntensity * pulse);
  }
`;

interface CellVisual {
  readonly group: THREE.Group;
  readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly core: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  readonly haloMaterial: THREE.ShaderMaterial;
  readonly coreMaterial: THREE.MeshBasicMaterial;
  shownLifecycle: string;
  spawnFlash: number;
  collectFlash: number;
  collecting: boolean;
}

const CORE_RADIUS = 26;
const MIN_ANGULAR_SIZE = 0.012;
const HALO_RADIUS = 150;

/** The exact physical-core plus angular-floor halo presentation from the HARVEST reference. */
export class HarvestCellField {
  readonly object = new THREE.Group();

  private readonly visuals: CellVisual[] = [];
  private readonly haloGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly coreGeometry = new THREE.IcosahedronGeometry(CORE_RADIUS, 0);
  private readonly colour = new THREE.Color(0x64e8ff);
  private readonly debug: HarvestCellFieldDebug;
  private time = 0;

  constructor(count: number) {
    this.object.name = 'HARVEST / ENERGY CELLS';
    for (let index = 0; index < count; index++) {
      const haloMaterial = new THREE.ShaderMaterial({
        vertexShader: CELL_VERT,
        fragmentShader: CELL_FRAG,
        uniforms: {
          uColor: { value: this.colour },
          uIntensity: { value: 1 },
          uTime: { value: 0 },
          uPhase: { value: 0 },
          uCharge: { value: 1 },
          uScale: { value: HALO_RADIUS },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      });
      const halo = new THREE.Mesh(this.haloGeometry, haloMaterial);
      halo.frustumCulled = false;
      halo.renderOrder = 12;

      const coreMaterial = new THREE.MeshBasicMaterial({
        color: 0xd8fbff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const core = new THREE.Mesh(this.coreGeometry, coreMaterial);

      const group = new THREE.Group();
      group.name = `HARVEST / ENERGY CELL ${index + 1}`;
      group.add(halo, core);
      group.visible = false;
      this.object.add(group);
      this.visuals.push({
        group,
        halo,
        core,
        haloMaterial,
        coreMaterial,
        shownLifecycle: '',
        spawnFlash: 0,
        collectFlash: 0,
        collecting: false,
      });
    }

    this.debug = Object.freeze({
      activeSources: count,
      sourceDrawCalls: count * 2,
      sourceGeometries: 2,
      sourceMaterials: count * 2,
      sourceTriangles: count * 22,
      structureDrawCalls: 0,
      structureTriangles: 0,
      colliders: 0,
    });
  }

  reset(): void {
    this.time = 0;
    for (const visual of this.visuals) {
      visual.shownLifecycle = '';
      visual.spawnFlash = 0;
      visual.collectFlash = 0;
      visual.collecting = false;
      visual.group.visible = false;
    }
  }

  update(
    sources: readonly HarvestCellSourceView[],
    dt: number,
    cameraPosition: THREE.Vector3,
    viewportHeight: number,
    fovRadians: number,
  ): void {
    this.time += dt;

    for (let index = 0; index < this.visuals.length; index++) {
      const visual = this.visuals[index]!;
      const source = sources[index];
      if (!source) {
        visual.group.visible = false;
        continue;
      }

      const alive = source.alive ?? (source.collected !== true);
      const lifecycle = `${String(source.id)}:${source.generation ?? 0}`;
      if (alive && lifecycle !== visual.shownLifecycle) {
        visual.shownLifecycle = lifecycle;
        visual.spawnFlash = 1;
        visual.collectFlash = 0;
        visual.collecting = false;
        visual.group.position.copy(source.position);
      }

      if (!alive && !visual.collecting && visual.shownLifecycle === lifecycle) {
        visual.collecting = true;
        visual.collectFlash = 1;
      }

      if (visual.collecting) {
        visual.collectFlash = Math.max(0, visual.collectFlash - dt * 3.2);
        if (visual.collectFlash <= 0) {
          visual.group.visible = false;
          continue;
        }
      } else if (!alive) {
        visual.group.visible = false;
        continue;
      }

      visual.spawnFlash = Math.max(0, visual.spawnFlash - dt * 1.8);
      visual.group.visible = true;

      const distance = visual.group.position.distanceTo(cameraPosition);
      void viewportHeight;
      const floorSize = MIN_ANGULAR_SIZE * 2 * distance * Math.tan(fovRadians * 0.5);
      const haloSize = Math.max(HALO_RADIUS, floorSize);
      const collect = visual.collecting ? visual.collectFlash : 0;
      const swell = 1 + (1 - collect) * (visual.collecting ? 1.9 : 0);
      const charge = clamp01(source.charge ?? 1);

      visual.haloMaterial.uniforms.uScale.value = haloSize * swell;
      visual.haloMaterial.uniforms.uTime.value = this.time;
      visual.haloMaterial.uniforms.uPhase.value = source.phase ?? 0;
      visual.haloMaterial.uniforms.uCharge.value = charge;
      visual.haloMaterial.uniforms.uIntensity.value = visual.collecting
        ? clamp01(collect) * 2.4
        : 1 + visual.spawnFlash * 1.4;

      visual.coreMaterial.opacity = visual.collecting ? clamp01(collect) : 1;
      visual.core.rotation.y += dt * 0.9;
      visual.core.rotation.x += dt * 0.35;
      const coreScale = visual.collecting
        ? 1 + (1 - collect) * 2.2
        : (0.55 + 0.45 * charge) * (1 + visual.spawnFlash * 0.5);
      visual.core.scale.setScalar(coreScale);
    }
  }

  getDebugState(): HarvestCellFieldDebug {
    return this.debug;
  }

  dispose(): void {
    this.haloGeometry.dispose();
    this.coreGeometry.dispose();
    for (const visual of this.visuals) {
      visual.haloMaterial.dispose();
      visual.coreMaterial.dispose();
    }
  }
}
