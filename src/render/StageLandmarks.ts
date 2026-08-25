import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { loft, type LoftStation } from './loft.ts';
import type { LightingUniforms } from './lighting.ts';
import {
  ShelfSpan,
  buildRingHull,
  createStructureMaterial,
} from './Structures.ts';

export type StageLandmarkKind = 'cairn' | 'wreckline' | 'ringfall';

export type StageLandmarkId =
  | 'broken-span'
  | 'twin-keels'
  | 'the-fracture'
  | 'engine-spine'
  | 'ring-wall'
  | 'twin-spires'
  | 'orison-arch';

export interface StageLandmarkAnchorSpec {
  readonly id: StageLandmarkId;
  readonly routeFraction: number;
  readonly rightOffset: number;
  readonly forwardOffset: number;
  readonly verticalOffset: number;
}

const frozenAnchor = (
  spec: StageLandmarkAnchorSpec,
): Readonly<StageLandmarkAnchorSpec> => Object.freeze(spec);

/**
 * Authored route positions used by Game to construct orthonormal course frames.
 *
 * CAIRN repeats the exact ShelfSpan placement values already owned by its course definition.
 * Game should continue to prefer those definition values for CAIRN so the compatibility anchor
 * has one runtime source of truth; the mirrored values here make the renderer contract explicit.
 */
export const STAGE_LANDMARK_ANCHORS: Readonly<
  Record<StageLandmarkKind, readonly Readonly<StageLandmarkAnchorSpec>[]>
> = Object.freeze({
  cairn: Object.freeze([
    frozenAnchor({
      id: 'broken-span',
      routeFraction: 0.5,
      rightOffset: 5200,
      forwardOffset: 2600,
      verticalOffset: -900,
    }),
  ]),
  wreckline: Object.freeze([
    frozenAnchor({ id: 'twin-keels', routeFraction: 0.16, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
    frozenAnchor({ id: 'the-fracture', routeFraction: 0.43, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
    frozenAnchor({ id: 'engine-spine', routeFraction: 0.72, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
  ]),
  ringfall: Object.freeze([
    frozenAnchor({ id: 'ring-wall', routeFraction: 0.18, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
    frozenAnchor({ id: 'twin-spires', routeFraction: 0.48, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
    frozenAnchor({ id: 'orison-arch', routeFraction: 0.77, rightOffset: 0, forwardOffset: 0, verticalOffset: 0 }),
  ]),
});

/** Local -Z points along `forward`; the four vectors are copied during construction. */
export interface StageLandmarkAnchorFrame {
  readonly position: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
}

export interface ProtectedCleanChannelSegment {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly radius: number;
}

export type ImmutablePoint3 = readonly [number, number, number];

/** JSON-safe immutable sphere approximation consumed by Game's existing collision pass. */
export interface StageLandmarkCollider {
  readonly id: string;
  readonly center: ImmutablePoint3;
  readonly radius: number;
}

export interface StageLandmarkDebugState {
  readonly kind: StageLandmarkKind;
  readonly landmarks: readonly StageLandmarkId[];
  readonly signature: string;
  readonly draws: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly materials: number;
  readonly colliders: number;
}

export interface StageLandmarksOptions {
  readonly kind: StageLandmarkKind;
  readonly lighting: LightingUniforms;
  readonly seed: number;
  readonly anchors: readonly StageLandmarkAnchorFrame[];
  readonly protectedChannel: readonly ProtectedCleanChannelSegment[];
}

interface StagePalette {
  readonly base: number;
  readonly accent: number;
  readonly window: number;
  readonly windowDensity: number;
}

const STAGE_PALETTES: Readonly<Record<'wreckline' | 'ringfall', StagePalette>> = Object.freeze({
  wreckline: Object.freeze({
    base: 0x272c35,
    accent: 0x716862,
    window: 0xa74632,
    windowDensity: 0.025,
  }),
  ringfall: Object.freeze({
    base: 0x313849,
    accent: 0x8a94aa,
    window: 0x63b9c9,
    windowDensity: 0.045,
  }),
});

const MAX_COLLIDERS = 24;
const EPSILON = 1e-8;

function isFiniteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function squaredDistanceToSegment(
  x: number,
  y: number,
  z: number,
  segment: ProtectedCleanChannelSegment,
): number {
  const abx = segment.b.x - segment.a.x;
  const aby = segment.b.y - segment.a.y;
  const abz = segment.b.z - segment.a.z;
  const apx = x - segment.a.x;
  const apy = y - segment.a.y;
  const apz = z - segment.a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = lengthSq > EPSILON
    ? THREE.MathUtils.clamp((apx * abx + apy * aby + apz * abz) / lengthSq, 0, 1)
    : 0;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/** Rejects invalid or unfair authored collision volumes before they enter the gameplay pass. */
export function validateStageLandmarkColliders(
  colliders: readonly StageLandmarkCollider[],
  protectedChannel: readonly ProtectedCleanChannelSegment[],
): void {
  if (colliders.length > MAX_COLLIDERS) {
    throw new Error(`Stage landmarks exceed the ${MAX_COLLIDERS}-collider ceiling.`);
  }
  for (const collider of colliders) {
    const [x, y, z] = collider.center;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
      || !Number.isFinite(collider.radius) || collider.radius <= 0) {
      throw new Error(`Invalid stage landmark collider: ${collider.id}.`);
    }
    for (let i = 0; i < protectedChannel.length; i++) {
      const segment = protectedChannel[i]!;
      if (!Number.isFinite(segment.radius) || segment.radius < 0
        || !isFiniteVector(segment.a) || !isFiniteVector(segment.b)) {
        throw new Error(`Invalid protected clean-channel segment ${i}.`);
      }
      const protectedRadius = segment.radius + collider.radius;
      if (squaredDistanceToSegment(x, y, z, segment) <= protectedRadius * protectedRadius) {
        throw new Error(
          `Stage landmark collider ${collider.id} intersects protected clean-channel segment ${i}.`,
        );
      }
    }
  }
}

function buildKeelGeometry(): THREE.BufferGeometry {
  const stations: LoftStation[] = [
    { z: -1380, width: 210, height: 130, squareness: 3.4 },
    { z: -1120, width: 340, height: 205, squareness: 4.6 },
    { z: -360, width: 390, height: 230, squareness: 5.2 },
    { z: 520, width: 360, height: 215, squareness: 4.8 },
    { z: 1180, width: 280, height: 170, squareness: 4.2 },
    { z: 1380, width: 120, height: 80, squareness: 3.2 },
  ];
  return loft({ stations, radialSegments: 20, capStart: true, capEnd: true });
}

function buildFractureGeometry(): THREE.BufferGeometry {
  const stations: LoftStation[] = [
    { z: -920, width: 120, height: 85, squareness: 3.2, offsetY: 45 },
    { z: -760, width: 310, height: 210, squareness: 5.4, offsetY: 20 },
    { z: -120, width: 350, height: 230, squareness: 5.8, offsetY: -25 },
    { z: 620, width: 250, height: 170, squareness: 4.8, offsetY: 35 },
    { z: 900, width: 80, height: 55, squareness: 3.0, offsetY: 80 },
  ];
  return loft({ stations, radialSegments: 18, capStart: true, capEnd: true });
}

function buildSpireGeometry(): THREE.BufferGeometry {
  const stations: LoftStation[] = [
    { z: -980, width: 210, height: 170, squareness: 4.8 },
    { z: -760, width: 250, height: 205, squareness: 5.5 },
    { z: 420, width: 190, height: 160, squareness: 5.2 },
    { z: 820, width: 95, height: 82, squareness: 4.0 },
    { z: 1040, width: 16, height: 14, squareness: 2.4 },
  ];
  return loft({ stations, radialSegments: 16, capStart: true, capEnd: true });
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(geometry.getAttribute('position').count / 3);
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** One allocation-bounded landmark owner; exactly one instance exists for the selected stage. */
export class StageLandmarks {
  readonly object = new THREE.Group();
  readonly kind: StageLandmarkKind;
  readonly colliders: readonly StageLandmarkCollider[];

  private readonly shelfSpan: ShelfSpan | null;
  private readonly material: THREE.ShaderMaterial | null;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly colliderDrafts: StageLandmarkCollider[] = [];
  private readonly debugState: StageLandmarkDebugState;
  private disposed = false;

  constructor(options: StageLandmarksOptions) {
    this.kind = options.kind;
    this.object.name = `STAGE LANDMARKS / ${options.kind.toUpperCase()}`;

    const expectedAnchors = STAGE_LANDMARK_ANCHORS[options.kind];
    if (options.anchors.length !== expectedAnchors.length) {
      throw new Error(
        `Stage landmark kind ${options.kind} requires ${expectedAnchors.length} anchor frame(s); received ${options.anchors.length}.`,
      );
    }
    for (let i = 0; i < options.anchors.length; i++) this.validateAnchor(options.anchors[i]!, i);

    if (options.kind === 'cairn') {
      this.material = null;
      this.shelfSpan = new ShelfSpan({
        lighting: options.lighting,
        position: options.anchors[0]!.position,
        seed: options.seed,
      });
      this.shelfSpan.object.name = 'BROKEN SPAN';
      this.object.add(this.shelfSpan.object);
    } else {
      this.shelfSpan = null;
      const palette = STAGE_PALETTES[options.kind];
      this.material = createStructureMaterial({ lighting: options.lighting, ...palette });
      const rng = new Rng(options.seed);
      if (options.kind === 'wreckline') this.buildWreckline(options.anchors, rng);
      else this.buildRingfall(options.anchors, rng);
    }

    this.colliders = Object.freeze(this.colliderDrafts);
    try {
      validateStageLandmarkColliders(this.colliders, options.protectedChannel);
    } catch (error) {
      this.releaseResources();
      throw error;
    }
    this.debugState = this.measureDebugState(expectedAnchors.map((anchor) => anchor.id));
  }

  private validateAnchor(anchor: StageLandmarkAnchorFrame, index: number): void {
    if (!isFiniteVector(anchor.position) || !isFiniteVector(anchor.forward)
      || !isFiniteVector(anchor.right) || !isFiniteVector(anchor.up)
      || anchor.forward.lengthSq() <= EPSILON || anchor.right.lengthSq() <= EPSILON
      || anchor.up.lengthSq() <= EPSILON) {
      throw new Error(`Invalid stage landmark anchor frame ${index}.`);
    }
  }

  private makeAnchor(frame: StageLandmarkAnchorFrame, name: string): THREE.Group {
    const forward = frame.forward.clone().normalize();
    const right = frame.right.clone().addScaledVector(forward, -frame.right.dot(forward));
    if (right.lengthSq() <= EPSILON) right.crossVectors(forward, frame.up);
    right.normalize();
    let up = new THREE.Vector3().crossVectors(right, forward).normalize();
    if (up.dot(frame.up) < 0) {
      right.negate();
      up = new THREE.Vector3().crossVectors(right, forward).normalize();
    }
    const backward = forward.clone().negate();
    const basis = new THREE.Matrix4().makeBasis(right, up, backward);

    const anchor = new THREE.Group();
    anchor.name = name;
    anchor.position.copy(frame.position);
    anchor.quaternion.setFromRotationMatrix(basis);
    anchor.matrixAutoUpdate = false;
    anchor.updateMatrix();
    this.object.add(anchor);
    return anchor;
  }

  private addMesh(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    name: string,
    position: readonly [number, number, number],
    rotation: readonly [number, number, number],
    scale: readonly [number, number, number] = [1, 1, 1],
  ): THREE.Mesh {
    if (!this.material) throw new Error('Stage landmark material is unavailable.');
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    return mesh;
  }

  private addCollider(
    id: string,
    owner: THREE.Object3D,
    localCenter: readonly [number, number, number],
    radius: number,
  ): void {
    owner.updateWorldMatrix(true, false);
    const center = new THREE.Vector3(localCenter[0], localCenter[1], localCenter[2])
      .applyMatrix4(owner.matrixWorld);
    const frozenCenter = Object.freeze([center.x, center.y, center.z]) as ImmutablePoint3;
    this.colliderDrafts.push(Object.freeze({ id, center: frozenCenter, radius }));
  }

  private buildWreckline(anchors: readonly StageLandmarkAnchorFrame[], rng: Rng): void {
    const keelGeometry = buildKeelGeometry();
    const fractureGeometry = buildFractureGeometry();
    // Use authored-metre vertices rather than object scaling: STRUCTURE_VERT keys its panel
    // breakup from local positions, so a unit sphere scaled to 420m would shade like one smooth
    // metre-wide blob instead of a bank of manufactured engine housings.
    const engineGeometry = new THREE.SphereGeometry(420, 16, 10);
    this.geometries.push(keelGeometry, fractureGeometry, engineGeometry);

    const keels = this.makeAnchor(anchors[0]!, 'TWIN KEELS');
    for (const side of [-1, 1] as const) {
      const keel = this.addMesh(
        keels,
        keelGeometry,
        side < 0 ? 'TWIN KEELS / PORT' : 'TWIN KEELS / STARBOARD',
        [side * 1180, side * rng.signed(45), rng.signed(80)],
        [rng.signed(0.035), side * rng.range(0.025, 0.065), side * rng.range(0.055, 0.095)],
        [1, 1, 0.65],
      );
      this.addCollider(`twin-keels-${side < 0 ? 'port' : 'starboard'}-fore`, keel, [0, 0, -680], 620);
      this.addCollider(`twin-keels-${side < 0 ? 'port' : 'starboard'}-aft`, keel, [0, 0, 680], 620);
    }

    const fracture = this.makeAnchor(anchors[1]!, 'THE FRACTURE');
    for (const side of [-1, 1] as const) {
      const fragment = this.addMesh(
        fracture,
        fractureGeometry,
        side < 0 ? 'THE FRACTURE / PORT' : 'THE FRACTURE / STARBOARD',
        [side * 1250, -side * 450 + rng.signed(35), side * 120],
        [side * 0.16 + rng.signed(0.025), -side * 0.2, side * 0.22],
        [1, 1, 0.55],
      );
      this.addCollider(`the-fracture-${side < 0 ? 'port' : 'starboard'}-fore`, fragment, [0, 0, -430], 450);
      this.addCollider(`the-fracture-${side < 0 ? 'port' : 'starboard'}-aft`, fragment, [0, 0, 430], 450);
    }

    const engines = this.makeAnchor(anchors[2]!, 'ENGINE SPINE');
    const engineOffsets: readonly (readonly [number, number, number])[] = [
      [-120, 170, -1080],
      [150, -190, 0],
      [-90, 150, 1080],
    ];
    if (!this.material) throw new Error('Stage landmark material is unavailable.');
    const enginePods = new THREE.InstancedMesh(engineGeometry, this.material, 15);
    enginePods.name = 'ENGINE SPINE / PODS';
    enginePods.matrixAutoUpdate = false;
    enginePods.updateMatrix();
    engines.add(enginePods);
    const instanceMatrix = new THREE.Matrix4();
    const instancePosition = new THREE.Vector3();
    const instanceQuaternion = new THREE.Quaternion();
    const instanceEuler = new THREE.Euler();
    const instanceScale = new THREE.Vector3(1, 1, 1);
    let instanceIndex = 0;
    for (let ringIndex = 0; ringIndex < engineOffsets.length; ringIndex++) {
      const offset = engineOffsets[ringIndex]!;
      for (let part = 0; part < 5; part++) {
        const angle = (part / 5) * Math.PI * 2 + ringIndex * 0.17;
        instancePosition.set(
          offset[0] + Math.cos(angle) * 1100,
          offset[1] + Math.sin(angle) * 1100,
          offset[2],
        );
        instanceEuler.set(rng.signed(0.12), angle + rng.signed(0.08), rng.signed(0.12));
        instanceQuaternion.setFromEuler(instanceEuler);
        instanceMatrix.compose(instancePosition, instanceQuaternion, instanceScale);
        enginePods.setMatrixAt(instanceIndex, instanceMatrix);
        this.addCollider(
          `engine-spine-${ringIndex + 1}-${part + 1}`,
          enginePods,
          [instancePosition.x, instancePosition.y, instancePosition.z],
          420,
        );
        instanceIndex++;
      }
    }
    enginePods.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    enginePods.instanceMatrix.needsUpdate = true;
    enginePods.computeBoundingBox();
    enginePods.computeBoundingSphere();
  }

  private buildRingfall(anchors: readonly StageLandmarkAnchorFrame[], rng: Rng): void {
    const wallGeometry = buildRingHull(2100, 210, 270, 96, 14, 4.2, 1.36);
    const spireGeometry = buildSpireGeometry();
    const archPillarGeometry = new THREE.BoxGeometry(260, 1800, 300);
    const archCrownGeometry = new THREE.BoxGeometry(2200, 250, 320);
    this.geometries.push(wallGeometry, spireGeometry, archPillarGeometry, archCrownGeometry);

    const wall = this.makeAnchor(anchors[0]!, 'RING WALL');
    const wallRotations = [0.2, Math.PI + 0.44] as const;
    for (let fragmentIndex = 0; fragmentIndex < wallRotations.length; fragmentIndex++) {
      const rotation = wallRotations[fragmentIndex]! + rng.signed(0.035);
      const fragment = this.addMesh(
        wall,
        wallGeometry,
        `RING WALL / FRAGMENT ${fragmentIndex + 1}`,
        [0, 0, fragmentIndex === 0 ? -260 : 300],
        [rng.signed(0.04), rng.signed(0.04), rotation],
      );
      for (let part = 0; part < 4; part++) {
        const angle = (part / 3) * 1.36;
        this.addCollider(
          `ring-wall-${fragmentIndex + 1}-${part + 1}`,
          fragment,
          [Math.cos(angle) * 2100, Math.sin(angle) * 2100, 0],
          580,
        );
      }
    }

    const spires = this.makeAnchor(anchors[1]!, 'TWIN SPIRES');
    for (const side of [-1, 1] as const) {
      const spire = this.addMesh(
        spires,
        spireGeometry,
        side < 0 ? 'TWIN SPIRES / PORT' : 'TWIN SPIRES / STARBOARD',
        [side * 1250, rng.signed(55), side * 70],
        [-Math.PI * 0.5 + rng.signed(0.035), side * 0.055, side * 0.045],
        [1, 1, 0.9],
      );
      for (let part = 0; part < 3; part++) {
        this.addCollider(
          `twin-spires-${side < 0 ? 'port' : 'starboard'}-${part + 1}`,
          spire,
          [0, 0, -590 + part * 590],
          500,
        );
      }
    }

    const arch = this.makeAnchor(anchors[2]!, 'ORISON ARCH');
    const archRotation = rng.signed(0.035);
    const portPillar = this.addMesh(
      arch,
      archPillarGeometry,
      'ORISON ARCH / PORT PIER',
      [-1000, 100, 0],
      [0, 0, archRotation],
    );
    const starboardPillar = this.addMesh(
      arch,
      archPillarGeometry,
      'ORISON ARCH / STARBOARD PIER',
      [1000, 100, 0],
      [0, 0, -archRotation],
    );
    const crown = this.addMesh(
      arch,
      archCrownGeometry,
      'ORISON ARCH / CROWN',
      [0, 1080, 0],
      [0, 0, 0],
    );
    for (const [owner, sideName] of [
      [portPillar, 'port'],
      [starboardPillar, 'starboard'],
    ] as const) {
      this.addCollider(`orison-arch-${sideName}-lower`, owner, [0, -450, 0], 510);
      this.addCollider(`orison-arch-${sideName}-upper`, owner, [0, 450, 0], 510);
    }
    for (let part = 0; part < 3; part++) {
      this.addCollider(`orison-arch-crown-${part + 1}`, crown, [-2200 / 3 + part * (2200 / 3), 0, 0], 430);
    }
  }

  private measureDebugState(landmarks: readonly StageLandmarkId[]): StageLandmarkDebugState {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const signatureParts: string[] = [this.kind];
    const instanceMatrix = new THREE.Matrix4();
    let draws = 0;
    let triangles = 0;

    this.object.updateMatrixWorld(true);
    this.object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      draws++;
      geometries.add(child.geometry);
      const instances = child instanceof THREE.InstancedMesh ? child.count : 1;
      triangles += triangleCount(child.geometry) * instances;
      if (Array.isArray(child.material)) {
        for (const material of child.material) materials.add(material);
      } else {
        materials.add(child.material);
      }
      signatureParts.push(child.name);
      for (const value of child.matrixWorld.elements) signatureParts.push(value.toFixed(4));
      if (child instanceof THREE.InstancedMesh) {
        for (let instance = 0; instance < child.count; instance++) {
          child.getMatrixAt(instance, instanceMatrix);
          for (const value of instanceMatrix.elements) signatureParts.push(value.toFixed(4));
        }
      }
    });
    for (const collider of this.colliders) {
      signatureParts.push(collider.id, collider.radius.toFixed(3));
      for (const value of collider.center) signatureParts.push(value.toFixed(3));
    }

    return Object.freeze({
      kind: this.kind,
      landmarks: Object.freeze([...landmarks]),
      signature: `${this.kind}-${hashText(signatureParts.join('|'))}`,
      draws,
      triangles,
      geometries: geometries.size,
      materials: materials.size,
      colliders: this.colliders.length,
    });
  }

  getDebugState(): StageLandmarkDebugState {
    return this.debugState;
  }

  update(time: number, cameraPosition: THREE.Vector3): void {
    if (this.disposed) return;
    if (this.shelfSpan) {
      this.shelfSpan.update(time, cameraPosition);
      return;
    }
    if (this.material) {
      this.material.uniforms.uTime.value = time;
      this.material.uniforms.uCameraPos.value.copy(cameraPosition);
    }
  }

  /** Static solid landmarks have no point-size uniform; validate and accept the shared lifecycle. */
  setPixelScale(pixelScale: number): void {
    if (!Number.isFinite(pixelScale) || pixelScale <= 0) {
      throw new Error('Stage landmark pixel scale must be finite and positive.');
    }
  }

  private releaseResources(): void {
    if (this.shelfSpan) this.shelfSpan.dispose();
    else {
      for (const geometry of this.geometries) geometry.dispose();
      this.material?.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseResources();
    this.object.clear();
  }
}
