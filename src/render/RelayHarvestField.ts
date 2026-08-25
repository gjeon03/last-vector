import * as THREE from 'three';
import type { QualityProfile } from '../core/Settings.ts';
import type { LightingUniforms } from './lighting.ts';
import { buildRingHull, createStructureMaterial } from './Structures.ts';

export const RELAY_HARVEST_SOURCE_CAPACITY = 5;
export const RELAY_HARVEST_SOURCE_DRAW_CAP = 3;
export const RELAY_HARVEST_SOURCE_TRIANGLE_CAP = 5_000;

/** Structural seam: the objective owns these values and the renderer only observes them. */
export interface RelayHarvestSourceView {
  readonly id: string;
  readonly band?: 'near' | 'mid' | 'far';
  readonly position: THREE.Vector3;
  readonly collected: boolean;
  readonly collectedAt: number | null;
}

export interface RelayHarvestCollider {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly radius: number;
}

export interface RelayHarvestFieldDebug {
  readonly activeSources: number;
  readonly sourceDrawCalls: number;
  readonly sourceGeometries: number;
  readonly sourceMaterials: number;
  readonly sourceTriangles: number;
  readonly structureDrawCalls: number;
  readonly structureTriangles: number;
  readonly colliders: number;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const ARC_RADIUS = 1_050;
const ARC_LENGTH = Math.PI * 1.48;
const ARC_CONTACTS = 10;
const BANK_COUNT = 3;
const SOURCE_STRUCTURE_CLEARANCE = 500;

const SOURCE_VERT = /* glsl */ `
  attribute float aCollectedAt;
  uniform float uTime;
  uniform float uCollapseRate;
  uniform float uResidualScale;
  uniform float uFlashExpansion;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vLive;
  varying float vFlash;

  void main() {
    float collected = step(0.0, aCollectedAt);
    float age = collected * max(0.0, uTime - aCollectedAt);
    float collapse = 1.0 - clamp(age * uCollapseRate, 0.0, 1.0);
    float flash = collected * exp(-age * 22.0);
    float visualScale = mix(
      1.0,
      uResidualScale + (1.0 - uResidualScale) * collapse + flash * uFlashExpansion,
      collected
    );
    vec3 localPosition = position * visualScale;

    #ifdef USE_INSTANCING
      vec4 world = modelMatrix * instanceMatrix * vec4(localPosition, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    #else
      vec4 world = modelMatrix * vec4(localPosition, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
    #endif

    vWorldPosition = world.xyz;
    vLive = 1.0 - collected;
    vFlash = flash;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SOURCE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uCollectedColor;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  uniform float uEmissive;
  uniform float uCollectedLevel;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vLive;
  varying float vFlash;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float key = max(dot(normal, normalize(uSunDir)), 0.0);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.5);
    float liveEnergy = mix(uCollectedLevel, 1.0, vLive);
    vec3 base = mix(uCollectedColor, uColor, vLive);
    vec3 lit = base * (uEmissive + key * 0.72 + rim * 0.72);
    vec3 flash = vec3(1.0, 0.94, 0.72) * vFlash * 5.2;
    float alpha = uOpacity * (liveEnergy + vFlash * 1.7);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(lit * liveEnergy + flash, clamp(alpha, 0.0, 1.0));
  }
`;

function triangles(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(geometry.getAttribute('position').count / 3);
}

function createSourceMaterial(options: {
  readonly lighting: LightingUniforms;
  readonly color: number;
  readonly collectedColor: number;
  readonly opacity: number;
  readonly emissive: number;
  readonly collectedLevel: number;
  readonly collapseRate: number;
  readonly residualScale: number;
  readonly flashExpansion: number;
  readonly transparent: boolean;
  readonly wireframe?: boolean;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCollapseRate: { value: options.collapseRate },
      uResidualScale: { value: options.residualScale },
      uFlashExpansion: { value: options.flashExpansion },
      uColor: { value: new THREE.Color(options.color) },
      uCollectedColor: { value: new THREE.Color(options.collectedColor) },
      uSunDir: options.lighting.uSunDir,
      uOpacity: { value: options.opacity },
      uEmissive: { value: options.emissive },
      uCollectedLevel: { value: options.collectedLevel },
    },
    vertexShader: SOURCE_VERT,
    fragmentShader: SOURCE_FRAG,
    transparent: options.transparent,
    depthWrite: !options.transparent,
    depthTest: true,
    blending: options.transparent ? THREE.AdditiveBlending : THREE.NormalBlending,
    wireframe: options.wireframe ?? false,
    toneMapped: false,
  });
}

function validateSources(sources: readonly RelayHarvestSourceView[]): void {
  if (sources.length !== RELAY_HARVEST_SOURCE_CAPACITY) {
    throw new Error(`BLACKOUT RELAY requires exactly ${RELAY_HARVEST_SOURCE_CAPACITY} sources`);
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.id || ids.has(source.id)) {
      throw new Error('BLACKOUT RELAY source IDs must be stable and unique');
    }
    ids.add(source.id);
    if (
      !Number.isFinite(source.position.x)
      || !Number.isFinite(source.position.y)
      || !Number.isFinite(source.position.z)
    ) {
      throw new Error(`BLACKOUT RELAY source ${source.id} has a non-finite position`);
    }
  }
}

function clearsEverySource(
  position: THREE.Vector3,
  radius: number,
  sources: readonly THREE.Vector3[],
): boolean {
  const required = radius + SOURCE_STRUCTURE_CLEARANCE;
  const requiredSq = required * required;
  for (const source of sources) {
    if (position.distanceToSquared(source) < requiredSq) return false;
  }
  return true;
}

/**
 * Fixed-capacity procedural relay wreck and the three-draw physical source presentation.
 * Objective state is never copied: collection flags are observed from the shared source array.
 */
export class RelayHarvestField {
  readonly object = new THREE.Group();
  readonly colliders: readonly RelayHarvestCollider[];

  private readonly sources: readonly RelayHarvestSourceView[];
  private readonly sourcePositions: readonly THREE.Vector3[];
  private readonly structureMaterial: THREE.ShaderMaterial;
  private readonly conduitMaterial: THREE.LineBasicMaterial;
  private readonly wreckTraceMaterial: THREE.LineBasicMaterial;
  private readonly arcGeometry: THREE.BufferGeometry;
  private readonly wreckTraceGeometry = new THREE.BufferGeometry();
  private readonly trussGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly finGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly conduitGeometry = new THREE.BufferGeometry();
  private readonly coreGeometry = new THREE.IcosahedronGeometry(110, 1);
  private readonly cageGeometry = new THREE.OctahedronGeometry(380, 0);
  private readonly beaconGeometry = new THREE.CylinderGeometry(8, 20, 1_800, 6, 1, true);
  private readonly coreMaterial: THREE.ShaderMaterial;
  private readonly cageMaterial: THREE.ShaderMaterial;
  private readonly beaconMaterial: THREE.ShaderMaterial;
  private readonly cores: THREE.InstancedMesh;
  private readonly cages: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly sourceAttributes: readonly THREE.InstancedBufferAttribute[];
  private readonly visualCollected = new Uint8Array(RELAY_HARVEST_SOURCE_CAPACITY);
  private readonly visualCollectedAt = new Float32Array(RELAY_HARVEST_SOURCE_CAPACITY);
  private readonly debug: RelayHarvestFieldDebug;

  constructor(options: {
    readonly sources: readonly RelayHarvestSourceView[];
    readonly lighting: LightingUniforms;
  }) {
    validateSources(options.sources);
    this.sources = options.sources;
    this.sourcePositions = Object.freeze(options.sources.map((source) => source.position));
    this.object.name = 'BLACKOUT RELAY / WRECK AND ENERGY SOURCES';

    this.structureMaterial = createStructureMaterial({
      lighting: options.lighting,
      // This chapter is route-choice gameplay, so the wreck must read as physical navigation
      // space rather than disappear into the starfield behind its HUD diamonds.
      base: 0x283b4b,
      accent: 0x7795a4,
      window: 0x4ff5ff,
      windowDensity: 0.12,
    });
    this.conduitMaterial = new THREE.LineBasicMaterial({
      color: 0x4de8ef,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.wreckTraceMaterial = new THREE.LineBasicMaterial({
      color: 0x5fa4b5,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.arcGeometry = buildRingHull(ARC_RADIUS, 92, 138, 48, 8, 4.2, ARC_LENGTH);
    const arcs = new THREE.InstancedMesh(this.arcGeometry, this.structureMaterial, BANK_COUNT);
    const trusses = new THREE.InstancedMesh(this.trussGeometry, this.structureMaterial, 9);
    const fins = new THREE.InstancedMesh(this.finGeometry, this.structureMaterial, 6);
    arcs.name = 'BLACKOUT RELAY / BROKEN COLLECTOR ARCS';
    trusses.name = 'BLACKOUT RELAY / TRUSS ARMS';
    fins.name = 'BLACKOUT RELAY / SHATTERED COLLECTOR FINS';
    arcs.frustumCulled = false;
    trusses.frustumCulled = false;
    fins.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const sortedSources = this.sourcePositions
      .map((source) => source)
      .sort((a, b) => a.z - b.z);
    const nearSource = options.sources.find((source) => source.band === 'near')?.position;
    const midSource = options.sources.find((source) => source.band === 'mid')?.position;
    const farSource = options.sources.find((source) => source.band === 'far')?.position;
    const bankSources = nearSource && midSource && farSource
      ? [nearSource, midSource, farSource]
      : [sortedSources[4]!, sortedSources[2]!, sortedSources[0]!];
    const bankScales = [0.94, 1.08, 1] as const;
    const bankRotations = [0.38, 2.42, 4.46] as const;
    const colliderList: RelayHarvestCollider[] = [];
    let trussIndex = 0;
    let finIndex = 0;
    const wreckTracePositions: number[] = [];

    for (let bank = 0; bank < BANK_COUNT; bank++) {
      const center = bankSources[bank]!;
      const bankScale = bankScales[bank]!;
      const rotation = bankRotations[bank]!;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotation);
      scale.setScalar(bankScale);
      matrix.compose(center, quaternion, scale);
      arcs.setMatrixAt(bank, matrix);

      // A single cheap world-space trace makes the kilometre-scale broken collector readable
      // against a dense starfield. It follows the actual arc silhouette, so this is structure,
      // not another HUD ring or volumetric haze.
      const traceSteps = 32;
      for (let step = 0; step < traceSteps; step++) {
        const a0 = rotation + ARC_LENGTH * (step / traceSteps);
        const a1 = rotation + ARC_LENGTH * ((step + 1) / traceSteps);
        wreckTracePositions.push(
          center.x + Math.cos(a0) * ARC_RADIUS * bankScale,
          center.y + Math.sin(a0) * ARC_RADIUS * bankScale,
          center.z,
          center.x + Math.cos(a1) * ARC_RADIUS * bankScale,
          center.y + Math.sin(a1) * ARC_RADIUS * bankScale,
          center.z,
        );
      }

      for (let contact = 0; contact < ARC_CONTACTS; contact++) {
        const angle = rotation + ARC_LENGTH * ((contact + 0.5) / ARC_CONTACTS);
        position.copy(center).add(new THREE.Vector3(
          Math.cos(angle) * ARC_RADIUS * bankScale,
          Math.sin(angle) * ARC_RADIUS * bankScale,
          0,
        ));
        colliderList.push(Object.freeze({
          id: `relay-arc-${bank + 1}-${contact + 1}`,
          position: position.clone(),
          radius: 250 * bankScale,
        }));
      }

      for (let arm = 0; arm < 3; arm++) {
        let angle = rotation + 0.36 + arm * 1.67;
        const radialDistance = 1_520 * bankScale;
        const contactRadius = 430 * bankScale;
        for (let attempt = 0; attempt < 8; attempt++) {
          angle = rotation + 0.36 + arm * 1.67 + attempt * 0.41;
          position.set(
            center.x + Math.cos(angle) * radialDistance,
            center.y + Math.sin(angle) * radialDistance,
            center.z + (arm - 1) * 120,
          );
          if (clearsEverySource(position, contactRadius, this.sourcePositions)) break;
        }
        if (!clearsEverySource(position, contactRadius, this.sourcePositions)) continue;
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
        scale.set(820 * bankScale, 86, 110);
        matrix.compose(position, quaternion, scale);
        trusses.setMatrixAt(trussIndex, matrix);
        colliderList.push(Object.freeze({
          id: `relay-truss-${bank + 1}-${arm + 1}`,
          position: position.clone(),
          radius: contactRadius,
        }));
        trussIndex++;
      }

      for (let panel = 0; panel < 2; panel++) {
        let angle = rotation + 0.9 + panel * 2.85;
        const radialDistance = 2_050 * bankScale;
        const contactRadius = 430 * bankScale;
        for (let attempt = 0; attempt < 8; attempt++) {
          angle = rotation + 0.9 + panel * 2.85 + attempt * 0.47;
          position.set(
            center.x + Math.cos(angle) * radialDistance,
            center.y + Math.sin(angle) * radialDistance,
            center.z + (panel === 0 ? -230 : 260),
          );
          if (clearsEverySource(position, contactRadius, this.sourcePositions)) break;
        }
        if (!clearsEverySource(position, contactRadius, this.sourcePositions)) continue;
        quaternion.setFromEuler(new THREE.Euler(
          panel === 0 ? 0.22 : -0.31,
          bank * 0.17,
          angle + 0.25,
          'ZYX',
        ));
        scale.set(720 * bankScale, 26, 430);
        matrix.compose(position, quaternion, scale);
        fins.setMatrixAt(finIndex, matrix);
        colliderList.push(Object.freeze({
          id: `relay-fin-${bank + 1}-${panel + 1}`,
          position: position.clone(),
          radius: contactRadius,
        }));
        finIndex++;
      }
    }
    arcs.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trusses.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    fins.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trusses.count = trussIndex;
    fins.count = finIndex;
    arcs.instanceMatrix.needsUpdate = true;
    trusses.instanceMatrix.needsUpdate = true;
    fins.instanceMatrix.needsUpdate = true;
    this.colliders = Object.freeze(colliderList);
    this.wreckTraceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(wreckTracePositions, 3),
    );
    const wreckTrace = new THREE.LineSegments(this.wreckTraceGeometry, this.wreckTraceMaterial);
    wreckTrace.name = 'BLACKOUT RELAY / POWERED WRECK TRACE';
    wreckTrace.frustumCulled = false;
    wreckTrace.renderOrder = 4;

    const conduitPositions = new Float32Array(RELAY_HARVEST_SOURCE_CAPACITY * 4 * 2 * 3);
    let conduitOffset = 0;
    for (let index = 0; index < this.sourcePositions.length; index++) {
      const source = this.sourcePositions[index]!;
      for (let spoke = 0; spoke < 4; spoke++) {
        const angle = index * 0.71 + spoke * Math.PI * 0.5;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
        conduitPositions[conduitOffset++] = source.x + x * 265;
        conduitPositions[conduitOffset++] = source.y + y * 265;
        conduitPositions[conduitOffset++] = source.z;
        conduitPositions[conduitOffset++] = source.x + x * 780;
        conduitPositions[conduitOffset++] = source.y + y * 780;
        conduitPositions[conduitOffset++] = source.z + (spoke % 2 === 0 ? -90 : 90);
      }
    }
    this.conduitGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(conduitPositions, 3),
    );
    const conduits = new THREE.LineSegments(this.conduitGeometry, this.conduitMaterial);
    conduits.name = 'BLACKOUT RELAY / LIVE POWER CONDUITS';
    conduits.frustumCulled = false;
    conduits.renderOrder = 3;

    this.coreMaterial = createSourceMaterial({
      lighting: options.lighting,
      color: 0x54f4ff,
      collectedColor: 0x1d3440,
      opacity: 1,
      emissive: 0.48,
      collectedLevel: 0.08,
      collapseRate: 7.5,
      residualScale: 0.025,
      flashExpansion: 0.18,
      transparent: false,
    });
    this.cageMaterial = createSourceMaterial({
      lighting: options.lighting,
      color: 0x6ff9ff,
      collectedColor: 0x19404a,
      opacity: 0.72,
      emissive: 1.25,
      collectedLevel: 0.14,
      collapseRate: 5.5,
      residualScale: 0.34,
      flashExpansion: 0.24,
      transparent: true,
      wireframe: true,
    });
    this.beaconMaterial = createSourceMaterial({
      lighting: options.lighting,
      color: 0x48e8f4,
      collectedColor: 0x10272c,
      opacity: 0.38,
      emissive: 1.42,
      collectedLevel: 0,
      collapseRate: 10,
      residualScale: 0.001,
      flashExpansion: 0.04,
      transparent: true,
    });
    this.beaconGeometry.translate(0, 900, 0);

    this.cores = new THREE.InstancedMesh(
      this.coreGeometry,
      this.coreMaterial,
      RELAY_HARVEST_SOURCE_CAPACITY,
    );
    this.cages = new THREE.InstancedMesh(
      this.cageGeometry,
      this.cageMaterial,
      RELAY_HARVEST_SOURCE_CAPACITY,
    );
    this.beacons = new THREE.InstancedMesh(
      this.beaconGeometry,
      this.beaconMaterial,
      RELAY_HARVEST_SOURCE_CAPACITY,
    );
    this.cores.name = 'BLACKOUT RELAY / SOLID ENERGY CORES';
    this.cages.name = 'BLACKOUT RELAY / CAPTURE CAGES';
    this.beacons.name = 'BLACKOUT RELAY / NARROW SOURCE BEACONS';
    this.cores.frustumCulled = false;
    this.cages.frustumCulled = false;
    this.beacons.frustumCulled = false;
    this.cores.renderOrder = 12;
    this.cages.renderOrder = 13;
    this.beacons.renderOrder = 11;

    const attributes: THREE.InstancedBufferAttribute[] = [];
    for (const geometry of [this.coreGeometry, this.cageGeometry, this.beaconGeometry]) {
      const values = new Float32Array(RELAY_HARVEST_SOURCE_CAPACITY);
      values.fill(-1);
      const attribute = new THREE.InstancedBufferAttribute(values, 1);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aCollectedAt', attribute);
      attributes.push(attribute);
    }
    this.sourceAttributes = Object.freeze(attributes);

    const identityQuaternion = new THREE.Quaternion();
    for (let index = 0; index < RELAY_HARVEST_SOURCE_CAPACITY; index++) {
      matrix.compose(this.sourcePositions[index]!, identityQuaternion, UNIT_SCALE);
      this.cores.setMatrixAt(index, matrix);
      this.cages.setMatrixAt(index, matrix);
      this.beacons.setMatrixAt(index, matrix);
    }
    for (const mesh of [this.cores, this.cages, this.beacons]) {
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.visualCollected.fill(2);
    this.syncSources(0);

    this.object.add(
      arcs,
      trusses,
      fins,
      wreckTrace,
      conduits,
      this.beacons,
      this.cores,
      this.cages,
    );

    const sourceTriangles = RELAY_HARVEST_SOURCE_CAPACITY * (
      triangles(this.coreGeometry)
      + triangles(this.cageGeometry)
      + triangles(this.beaconGeometry)
    );
    this.debug = Object.freeze({
      activeSources: RELAY_HARVEST_SOURCE_CAPACITY,
      sourceDrawCalls: 3,
      sourceGeometries: 3,
      sourceMaterials: 3,
      sourceTriangles,
      structureDrawCalls: 5,
      structureTriangles: triangles(this.arcGeometry) * BANK_COUNT
        + triangles(this.trussGeometry) * trussIndex
        + triangles(this.finGeometry) * finIndex,
      colliders: this.colliders.length,
    });
    if (
      this.debug.sourceDrawCalls > RELAY_HARVEST_SOURCE_DRAW_CAP
      || this.debug.sourceGeometries > 3
      || this.debug.sourceMaterials > 3
      || sourceTriangles > RELAY_HARVEST_SOURCE_TRIANGLE_CAP
    ) {
      throw new Error('BLACKOUT RELAY energy sources exceed their render budget');
    }
  }

  update(runTime: number, cameraPosition: THREE.Vector3): void {
    this.structureMaterial.uniforms.uTime.value = runTime;
    this.structureMaterial.uniforms.uCameraPos.value.copy(cameraPosition);
    this.coreMaterial.uniforms.uTime.value = runTime;
    this.cageMaterial.uniforms.uTime.value = runTime;
    this.beaconMaterial.uniforms.uTime.value = runTime;
    this.syncSources(runTime);
  }

  reset(): void {
    // MissionRuntime resets the world before the objective. Mark the cache invalid and let the
    // first presentation frame observe the objective's already-reset shared state.
    this.visualCollected.fill(2);
  }

  applyQuality(_profile: QualityProfile, _maximum: QualityProfile): void {
    // Gameplay structure and all five sources stay identical across quality levels. The field is
    // already substantially below its fixed budget, so hiding geometry would only desynchronise
    // visible structure from the collider union.
  }

  getDebugState(): RelayHarvestFieldDebug {
    return this.debug;
  }

  dispose(): void {
    this.arcGeometry.dispose();
    this.wreckTraceGeometry.dispose();
    this.trussGeometry.dispose();
    this.finGeometry.dispose();
    this.conduitGeometry.dispose();
    this.coreGeometry.dispose();
    this.cageGeometry.dispose();
    this.beaconGeometry.dispose();
    this.structureMaterial.dispose();
    this.conduitMaterial.dispose();
    this.wreckTraceMaterial.dispose();
    this.coreMaterial.dispose();
    this.cageMaterial.dispose();
    this.beaconMaterial.dispose();
  }

  private syncSources(runTime: number): void {
    let dirty = false;
    for (let index = 0; index < RELAY_HARVEST_SOURCE_CAPACITY; index++) {
      const source = this.sources[index]!;
      const collected = source.collected ? 1 : 0;
      let collectedAt = -1;
      if (collected === 1) {
        collectedAt = source.collectedAt
          ?? (this.visualCollected[index] === 1 ? this.visualCollectedAt[index]! : runTime);
      }
      if (
        this.visualCollected[index] === collected
        && Math.abs(this.visualCollectedAt[index]! - collectedAt) < 1e-5
      ) continue;
      this.visualCollected[index] = collected;
      this.visualCollectedAt[index] = collectedAt;
      for (const attribute of this.sourceAttributes) attribute.setX(index, collectedAt);
      dirty = true;
    }
    if (!dirty) return;
    for (const attribute of this.sourceAttributes) attribute.needsUpdate = true;
  }
}
