import * as THREE from 'three';
import { Rng, fbm3 } from '../core/rng.ts';
import { GLSL_NOISE } from './glslNoise.ts';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { distanceToSegment } from '../core/mathx.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { PALETTE } from '../core/art.ts';

/**
 * The debris shelf. Every rock is generated at load time by displacing an icosphere with
 * fbm and baking a cheap cavity term into vertex colours, then drawn with instancing.
 *
 * Surface detail comes from derivative-based bump mapping ("bump mapping unparametrized
 * surfaces", Mikkelsen): one noise sample per pixel, and the hardware derivatives supply the
 * gradient. That gives grain and pitting for the price of a single fbm call, with no textures.
 */

const ASTEROID_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vTint;
  varying float vCavity;
  varying vec3 vSmoothNormal;
  attribute vec3 aSmoothNormal;

  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    // The undisplaced sphere normal. computeVertexNormals on a non-indexed icosphere gives
    // flat per-face normals, so a fresnel taken from them quantises into whole facets.
    vSmoothNormal = normalize(mat3(instanceMatrix) * aSmoothNormal);
    vTint = instanceColor;
    vCavity = color.r;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ASTEROID_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vTint;
  varying float vCavity;
  varying vec3 vSmoothNormal;

  uniform vec3 uCameraPos;
  uniform vec3 uRock;
  uniform vec3 uMineral;
  uniform float uDetailScale;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 toEye = uCameraPos - vWorldPos;
    float dist = length(toEye);
    vec3 V = toEye / max(dist, 1e-4);

    // Surface detail is a near-field affordance. Past a few hundred metres a rock covers a
    // handful of pixels, so the octave count drops and the whole vein pass is skipped.
    int detailOctaves = dist < 900.0 ? 3 : (dist < 3000.0 ? 2 : 1);
    float h = fbm(vWorldPos * uDetailScale, detailOctaves);

    // A high-frequency near-field octave. Without detail that RESOLVES as you close, the eye
    // has no way to judge how large a rock is or how far away it sits — which is why the scale
    // read failed even though the depth layering was working.
    float closeness = 1.0 - smoothstep(90.0, 420.0, dist);
    if (closeness > 0.01) {
      float fine = fbm(vWorldPos * uDetailScale * 7.5, 2);
      h = mix(h, h * 0.72 + fine * 0.5, closeness);
    }

    // Gradient of the height field straight from screen-space derivatives. One noise tap.
    vec3 dpdx = dFdx(vWorldPos);
    vec3 dpdy = dFdy(vWorldPos);
    float dhdx = dFdx(h);
    float dhdy = dFdy(h);
    vec3 r1 = cross(dpdy, N);
    vec3 r2 = cross(N, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = (r1 * dhdx + r2 * dhdy) / max(abs(det), 1e-6) * sign(det);
    N = normalize(N - grad * 0.55);

    float cavity = clamp(vCavity, 0.0, 1.0);
    // Much wider albedo modulation. The derivative bump was there but swamped: a rock with a
    // ±13% albedo range has nothing that resolves as you approach it, and without detail that
    // resolves there is no cue for how large or how far away it is.
    vec3 albedo = uRock * vTint * (0.45 + h * 0.55) * mix(0.34, 1.0, cavity);
    float roughness = clamp(0.8 + h * 0.15, 0.3, 0.98);

    vec3 color = shadeSurfaceRim(N, normalize(vSmoothNormal), V, albedo, roughness, 0.04, mix(0.28, 1.0, cavity));

    // Mineral veins glow faintly, and only deep inside cracks. Kept sparse: it is an accent,
    // and at field density anything brighter turns the shelf into fairy lights.
    if (dist < 1600.0) {
      float vein = smoothstep(0.66, 0.86, fbm(vWorldPos * uDetailScale * 0.34 + 11.0, 3));
      vein *= 1.0 - smoothstep(0.15, 0.55, cavity);
      vein *= 1.0 - smoothstep(400.0, 1600.0, dist);
      color += uMineral * vein * 0.3;
    }

    gl_FragColor = vec4(applyHaze(color, dist, V), 1.0);
  }
`;

interface AsteroidGeometry {
  geometry: THREE.BufferGeometry;
  /** Radius of the generating sphere after displacement, for collision. */
  boundRadius: number;
}

function buildAsteroidGeometry(rng: Rng, detail: number): AsteroidGeometry {
  // Welded BEFORE displacement. IcosahedronGeometry is non-indexed, so computeVertexNormals can
  // only ever produce per-face normals — measured at 320 of 320 faces with all three vertex
  // normals identical. That gives hard creases and a polygonal silhouette that no amount of
  // derivative bump can recover, and the keep-clear radius guarantees the nearest rocks are
  // always large on screen. Merging first costs no triangles at all.
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const count = pos.count;

  const ox = rng.range(-50, 50);
  const oy = rng.range(-50, 50);
  const oz = rng.range(-50, 50);
  // Anisotropic squash makes each rock a distinct silhouette instead of a lumpy ball.
  const sx = rng.range(0.62, 1.35);
  const sy = rng.range(0.58, 1.2);
  const sz = rng.range(0.66, 1.4);
  const bigAmp = rng.range(0.24, 0.42);
  const fineAmp = rng.range(0.06, 0.14);

  const cavity = new Float32Array(count);
  const smoothNormals = new Float32Array(count * 3);
  let maxR = 0;

  for (let i = 0; i < count; i++) {
    const nx = pos.getX(i);
    const ny = pos.getY(i);
    const nz = pos.getZ(i);
    // Positions are still on the unit sphere at this point, so they are the smooth normal.
    smoothNormals[i * 3] = nx;
    smoothNormals[i * 3 + 1] = ny;
    smoothNormals[i * 3 + 2] = nz;

    const big = fbm3(nx * 1.35 + ox, ny * 1.35 + oy, nz * 1.35 + oz, 4);
    const fine = fbm3(nx * 5.1 + ox, ny * 5.1 + oy, nz * 5.1 + oz, 3);
    // A couple of large concave bites read as impact craters at a glance.
    const crater = Math.max(0, fbm3(nx * 2.2 - ox, ny * 2.2 - oy, nz * 2.2 - oz, 2));
    // Shallower than it was: at 0.3 the bite cut deep enough that a good fraction of the rocks
    // read as annular, and with only eight variants the same doughnut silhouette recurred
    // across the whole field.
    const displacement = 1 + big * bigAmp + fine * fineAmp - Math.pow(crater, 3) * 0.17;

    const x = nx * displacement * sx;
    const y = ny * displacement * sy;
    const z = nz * displacement * sz;
    pos.setXYZ(i, x, y, z);
    maxR = Math.max(maxR, Math.hypot(x, y, z));

    // Cheap cavity/AO proxy: points pushed inward are occluded by their neighbours.
    cavity[i] = THREE.MathUtils.clamp(0.5 + (displacement - 1) * 1.9 + fine * 0.35, 0, 1);
  }

  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = cavity[i];
    colors[i * 3 + 1] = cavity[i];
    colors[i * 3 + 2] = cavity[i];
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSmoothNormal', new THREE.BufferAttribute(smoothNormals, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, boundRadius: maxR };
}

export interface AsteroidInstance {
  /** Stable construction index, used only for deterministic harness evidence. */
  id: number;
  position: THREE.Vector3;
  /**
   * Close enough to the racing line to be part of the course. Gameplay rock is always drawn
   * and always collides, at every quality level, so difficulty does not follow the settings.
   */
  gameplay: boolean;
  /** Collision radius in metres, i.e. scale * the variant's displaced bound. */
  radius: number;
  /** Uniform scale applied to the unit variant geometry. */
  scale: number;
  /** Rotation axis and rate, for the slow tumble. */
  spinAxis: THREE.Vector3;
  spinRate: number;
  quaternion: THREE.Quaternion;
}



/**
 * Metres from the racing line inside which a rock is part of the course rather than scenery.
 * Comfortably wider than any line a player will actually fly, so nothing a pilot can reach is
 * ever classified as decoration.
 */
const GAMEPLAY_BAND = 900;

interface AsteroidBatch {
  mesh: THREE.InstancedMesh;
  instances: AsteroidInstance[];
}

interface MovingHazard {
  instance: AsteroidInstance;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  motionAxis: THREE.Vector3;
  fallbackReactionAxis: THREE.Vector3;
  phase: number;
  rate: number;
  mesh: THREE.InstancedMesh | null;
  matrixIndex: number;
  displacement: number;
  playerResponse: number;
}

interface TumblingAsteroid {
  instance: AsteroidInstance;
  mesh: THREE.InstancedMesh;
  matrixIndex: number;
}

/** A fixed gameplay set: quality settings may never add motion or remove a moving collider. */
const MOVING_HAZARD_CAP = 12;
const HAZARD_SWAY_LIMIT = 6;
const PLAYER_RESPONSE_LIMIT = 2;
// The response axis follows the player's actual approach, so it is not guaranteed perpendicular
// to the authored sway axis. The triangle-inequality sum is the only honest all-approach bound.
const TOTAL_DISPLACEMENT_LIMIT = HAZARD_SWAY_LIMIT + PLAYER_RESPONSE_LIMIT;
const PLAYER_RESPONSE_RANGE = 2400;
/** Cosmetic rotation is bounded too; sixteen gameplay rocks per silhouette variant. */
const TUMBLING_PER_VARIANT = 16;

export interface AsteroidMotionReport {
  count: number;
  cap: number;
  elapsed: number;
  maxDisplacement: number;
  displacementLimit: number;
  maxPlayerResponse: number;
  playerResponseLimit: number;
  /** Smallest per-frame change in player distance caused by the proximity response. */
  minPlayerDistanceDelta: number;
  /** Smallest observed surface clearance from a moving rock to a protected spawn/gate volume. */
  minProtectedVolumeClearance: number;
  signature: string;
}

export interface AsteroidFieldOptions {
  count: number;
  lighting: LightingUniforms;
  /** Points the field is scattered around; typically the course spine. */
  spine: THREE.Vector3[];
  /**
   * How many of `count` are placed against the RACING LINE rather than the spine, hugging each
   * leg's own clearance. Scattering around the spine alone left the median clearance at 448 m
   * with 1.9% of the line under 200 m — the field was everywhere except where it was flown.
   */
  hazardCount?: number;
  /** Metres of radial band the hazard rocks occupy, outward from each leg's clearance. */
  hazardBand?: number;
  /** Metres either side of the spine. */
  spread: number;
  /** Metres of clear space kept around the spine so the course is always flyable. */
  corridor: number;
  minRadius: number;
  maxRadius: number;
  seed: number;
  /**
   * Volumes that must stay empty regardless of where the corridor falls — the spawn point and
   * every gate aperture. Without them the player begins the run already inside a boulder: a
   * scripted run measured seven hull contacts in its first seven tenths of a second.
   */
  keepClear?: { center: THREE.Vector3; radius: number }[];
  /**
   * Capsules that must stay empty. The corridor is carved around the SPINE, but the line a
   * pilot actually flies is gate to gate — where the spine curves, the racing line cuts the
   * corner and leaves the protected channel. Clearing the spine alone left one or two
   * unavoidable collisions per run at every level of autopilot aggression.
   */
  keepClearSegments?: { a: THREE.Vector3; b: THREE.Vector3; radius: number }[];
}

export class AsteroidField {
  readonly object = new THREE.Group();
  /**
   * Every rock that exists. NOT the collision set — use `activeInstances` for that.
   *
   * Collision used to run over this list while the drawn count followed the quality profile,
   * so at the default quality 37% of the rocks a player could hit were never rendered, and at
   * the lowest quality 72% were. That is an invisible wall, and it was invisible to the test
   * suite too because both traces were bit-identical.
   */
  readonly instances: AsteroidInstance[] = [];
  /** The rocks currently drawn. This is the collision set, by construction. */
  readonly activeInstances: AsteroidInstance[] = [];

  private readonly batches: AsteroidBatch[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly variantGeometries: AsteroidGeometry[] = [];
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpMotionPosition = new THREE.Vector3();
  private readonly tmpReactionAxis = new THREE.Vector3();
  private readonly protectedVolumes: { center: THREE.Vector3; radius: number }[];
  private readonly movingHazards: MovingHazard[] = [];
  private readonly tumblingAsteroids: TumblingAsteroid[] = [];
  private motionElapsed = 0;
  private peakMotionDisplacement = 0;
  private peakPlayerResponse = 0;
  private minPlayerDistanceDelta = Infinity;
  private minProtectedVolumeClearance = Infinity;

  constructor(options: AsteroidFieldOptions) {
    const rng = new Rng(options.seed);
    // Independent stream: adding motion metadata cannot perturb placement of later rocks.
    const motionRng = new Rng(options.seed ^ 0x6d8f3a21);
    // Keep the exact construction volumes available for runtime evidence. Cloning prevents a
    // later course transform from silently changing what the placement pass originally proved.
    this.protectedVolumes = (options.keepClear ?? []).map(({ center, radius }) => ({
      center: center.clone(),
      radius,
    }));

    this.material = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uRock: { value: new THREE.Color(PALETTE.rockLit) },
        uMineral: { value: new THREE.Color(PALETTE.rockMineral).multiplyScalar(0.35) },
        uDetailScale: { value: 0.06 },
      }),
      vertexShader: ASTEROID_VERT,
      fragmentShader: ASTEROID_FRAG,
      vertexColors: true,
    });

    // Sixteen silhouettes rather than eight: a field of a thousand rocks makes any repetition
    // obvious, and silhouette is the thing the eye actually matches on.
    const VARIANTS = 16;
    // Detail is banded by index, and an instance picks its band from its *size* below — a
    // three-hundred-triangle variant on a two-hundred-metre boulder is what put visible facets
    // on the largest objects in the frame.
    const detailFor = (v: number): number => (v < 4 ? 5 : v < 9 ? 4 : 3);
    for (let v = 0; v < VARIANTS; v++) {
      this.variantGeometries.push(buildAsteroidGeometry(rng.fork(v), detailFor(v)));
    }

    const perVariant: AsteroidInstance[][] = Array.from({ length: VARIANTS }, () => []);
    const point = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const dirScratch = { x: 0, y: 0, z: 0 };

    let attempts = 0;
    while (this.instances.length < options.count && attempts < options.count * 24) {
      attempts++;
      const t = rng.next() * (options.spine.length - 1);
      const i0 = Math.floor(t);
      const i1 = Math.min(options.spine.length - 1, i0 + 1);
      point.lerpVectors(options.spine[i0], options.spine[i1], t - i0);

      rng.onSphere(dirScratch);
      // Flatten the distribution into a shelf: the field should look like an orbital plane,
      // not a spherical cloud. This is a big part of reading the sector as a *place*.
      // Power-law sizes: mostly small debris, a handful of landmark boulders. A uniform
      // distribution gives every rock a similar apparent size, which flattens the field.
      const spread01 = Math.pow(rng.next(), 2.4);
      const scale =
        options.minRadius * Math.pow(options.maxRadius / options.minRadius, spread01) *
        (rng.bool(0.035) ? 3.4 : 1);

      // Pick the detail band from the instance's size, then a silhouette within that band.
      const size01 = Math.min(1, (scale - options.minRadius) / (options.maxRadius - options.minRadius));
      const variant = size01 > 0.55 ? rng.int(0, 4) : size01 > 0.22 ? rng.int(4, 9) : rng.int(9, VARIANTS);
      const collisionRadius = scale * this.variantGeometries[variant].boundRadius;

      // The corridor clears the rock's SURFACE, not its centre. Measured to the centre, every
      // large boulder intruded into the racing line by its own radius.
      const dist = options.corridor + collisionRadius + Math.pow(rng.next(), 0.62) * options.spread;
      offset.set(dirScratch.x, dirScratch.y * 0.34, dirScratch.z).normalize().multiplyScalar(dist);

      const candidate = point.clone().add(offset);
      // Reject anything intruding on a protected volume rather than nudging it, so the field
      // keeps its natural distribution instead of growing a visible shell around each gate.
      let blocked = false;
      for (const zone of options.keepClear ?? []) {
        if (candidate.distanceTo(zone.center) < zone.radius + collisionRadius) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        for (const seg of options.keepClearSegments ?? []) {
          if (distanceToSegment(candidate, seg.a, seg.b) < seg.radius + collisionRadius) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;

      // Anything close enough to the flown line to matter to a pilot is GAMEPLAY, and gameplay
      // rock is never removed by a quality setting.
      let nearestLine = Infinity;
      for (const seg of options.keepClearSegments ?? []) {
        nearestLine = Math.min(nearestLine, distanceToSegment(candidate, seg.a, seg.b) - collisionRadius);
      }

      const instance: AsteroidInstance = {
        id: this.instances.length,
        position: candidate,
        gameplay: nearestLine <= GAMEPLAY_BAND,
        radius: collisionRadius,
        scale,
        spinAxis: new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize(),
        spinRate: rng.signed(0.09),
        quaternion: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize(),
          rng.range(0, Math.PI * 2),
        ),
      };
      this.instances.push(instance);
      perVariant[variant].push(instance);
    }

    // ---------------------------------------------------------------- hazard placement
    // Placed against the flown line, weighted toward the legs with the least room, so the
    // demanding legs are the ones that actually have rock in them.
    const segs = options.keepClearSegments ?? [];
    const hazardCount = Math.min(options.hazardCount ?? 0, segs.length * 90);
    if (segs.length > 0 && hazardCount > 0) {
      const weights = segs.map((seg) => 1 / Math.max(seg.radius, 40));
      const total = weights.reduce((a, b) => a + b, 0);
      const band = options.hazardBand ?? 260;
      const axis = new THREE.Vector3();
      const perp = new THREE.Vector3();
      const perp2 = new THREE.Vector3();
      const along = new THREE.Vector3();

      for (let n = 0; n < hazardCount; n++) {
        // Pick a leg by inverse clearance, so a 100 m leg gets roughly three times the rock of
        // a 300 m one.
        let pick = rng.next() * total;
        let si = 0;
        while (si < weights.length - 1 && pick > weights[si]) { pick -= weights[si]; si++; }
        const seg = segs[si];

        axis.subVectors(seg.b, seg.a);
        const legLength = axis.length();
        if (legLength < 1) continue;
        axis.multiplyScalar(1 / legLength);
        perp.set(-axis.z, 0, axis.x);
        if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0);
        perp.normalize();
        perp2.crossVectors(axis, perp).normalize();

        const spread01 = Math.pow(rng.next(), 2.4);
        const scale = options.minRadius * Math.pow(options.maxRadius / options.minRadius, spread01);
        const size01 = Math.min(1, (scale - options.minRadius) / (options.maxRadius - options.minRadius));
        const variant = size01 > 0.55 ? rng.int(0, 4) : size01 > 0.22 ? rng.int(4, 9) : rng.int(9, VARIANTS);
        const collisionRadius = scale * this.variantGeometries[variant].boundRadius;

        // Kept away from the leg's ends so a rock never lands on top of a gate aperture.
        const t = rng.range(0.12, 0.88);
        along.copy(seg.a).addScaledVector(axis, legLength * t);
        const angle = rng.range(0, Math.PI * 2);
        const dist = seg.radius + collisionRadius + Math.pow(rng.next(), 1.5) * band;
        const candidate = along.clone()
          .addScaledVector(perp, Math.cos(angle) * dist)
          .addScaledVector(perp2, Math.sin(angle) * dist);

        let blocked = false;
        for (const zone of options.keepClear ?? []) {
          if (candidate.distanceTo(zone.center) < zone.radius + collisionRadius) { blocked = true; break; }
        }
        if (!blocked) {
          for (const other of segs) {
            if (distanceToSegment(candidate, other.a, other.b) < other.radius + collisionRadius) { blocked = true; break; }
          }
        }
        if (blocked) continue;

        const instance: AsteroidInstance = {
          id: this.instances.length,
          position: candidate,
          gameplay: true,
          radius: collisionRadius,
          scale,
          spinAxis: new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize(),
          spinRate: rng.signed(0.09),
          quaternion: new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize(),
            rng.range(0, Math.PI * 2),
          ),
        };
        this.instances.push(instance);
        perVariant[variant].push(instance);

        // Only authored gameplay hazards can move. Reserve the full all-direction displacement
        // margin here: the runtime proximity response points away from the player's actual
        // position, which is fair from every approach but is not always the course's radial.
        let motionSafe = true;
        const motionMargin = TOTAL_DISPLACEMENT_LIMIT + 0.25;
        for (const zone of options.keepClear ?? []) {
          if (candidate.distanceTo(zone.center) < zone.radius + collisionRadius + motionMargin) {
            motionSafe = false;
            break;
          }
        }
        if (motionSafe) {
          for (const other of segs) {
            if (distanceToSegment(candidate, other.a, other.b)
                < other.radius + collisionRadius + motionMargin) {
              motionSafe = false;
              break;
            }
          }
        }
        if (motionSafe && this.movingHazards.length < MOVING_HAZARD_CAP) {
          const fallbackReactionAxis = candidate.clone().sub(along).normalize();
          const motionAxis = new THREE.Vector3().crossVectors(axis, fallbackReactionAxis).normalize();
          if (motionRng.bool()) motionAxis.negate();
          this.movingHazards.push({
            instance,
            basePosition: candidate.clone(),
            baseQuaternion: instance.quaternion.clone(),
            motionAxis,
            fallbackReactionAxis,
            phase: motionRng.range(0, Math.PI * 2),
            rate: motionRng.range(0.22, 0.38),
            mesh: null,
            matrixIndex: -1,
            displacement: 0,
            playerResponse: 0,
          });
        }
      }
    }

    const tint = new THREE.Color();
    for (let v = 0; v < VARIANTS; v++) {
      const list = perVariant[v];
      if (list.length === 0) continue;
      // Gameplay rock first, so truncating the drawn count can only ever remove scenery.
      list.sort((a, b) => Number(b.gameplay) - Number(a.gameplay));
      const mesh = new THREE.InstancedMesh(this.variantGeometries[v].geometry, this.material, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        this.tmpMatrix.compose(inst.position, inst.quaternion, this.tmpScale.setScalar(inst.scale));
        mesh.setMatrixAt(i, this.tmpMatrix);
        // Narrow, desaturated variation: real rock fields vary in value far more than hue.
        const value = rng.range(0.62, 1.12);
        tint.setRGB(value, value * rng.range(0.96, 1.02), value * rng.range(0.93, 1.02), THREE.LinearSRGBColorSpace);
        mesh.setColorAt(i, tint);
        const moving = this.movingHazards.find((entry) => entry.instance === inst);
        if (moving) {
          moving.mesh = mesh;
          moving.matrixIndex = i;
        }
        if (inst.gameplay && i < TUMBLING_PER_VARIANT) {
          this.tumblingAsteroids.push({ instance: inst, mesh, matrixIndex: i });
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.batches.push({ mesh, instances: list });
      this.object.add(mesh);
      for (const inst of list) this.activeInstances.push(inst);
    }
  }

  /**
   * Advances only the fixed moving gameplay subset, then writes those exact positions into the
   * instance buffers. Game calls this before collision resolution, so collision and render
   * consume one state for the frame. No population-sized scan or per-frame allocation occurs.
   */
  updateMotion(dt: number, playerPosition: THREE.Vector3): void {
    this.motionElapsed += dt;
    for (const moving of this.movingHazards) {
      const sway = (HAZARD_SWAY_LIMIT * 0.5)
        * (Math.sin(moving.phase + this.motionElapsed * moving.rate) - Math.sin(moving.phase));
      this.tmpMotionPosition.copy(moving.basePosition).addScaledVector(moving.motionAxis, sway);
      this.tmpReactionAxis.copy(this.tmpMotionPosition).sub(playerPosition);
      const distance = this.tmpReactionAxis.length();
      const proximity = Math.max(0, 1 - distance / PLAYER_RESPONSE_RANGE);
      // A small retreat, never homing: react directly away from the player's current position.
      // The construction-time axis is used only for the degenerate coincident-centres case.
      const response = PLAYER_RESPONSE_LIMIT * proximity * proximity;
      if (distance > 1e-6) this.tmpReactionAxis.multiplyScalar(1 / distance);
      else this.tmpReactionAxis.copy(moving.fallbackReactionAxis);

      moving.instance.position.copy(this.tmpMotionPosition)
        .addScaledVector(this.tmpReactionAxis, response);
      moving.displacement = moving.instance.position.distanceTo(moving.basePosition);
      moving.playerResponse = response;
      this.peakMotionDisplacement = Math.max(this.peakMotionDisplacement, moving.displacement);
      this.peakPlayerResponse = Math.max(this.peakPlayerResponse, response);
      this.minPlayerDistanceDelta = Math.min(
        this.minPlayerDistanceDelta,
        moving.instance.position.distanceTo(playerPosition) - distance,
      );
      for (const zone of this.protectedVolumes) {
        this.minProtectedVolumeClearance = Math.min(
          this.minProtectedVolumeClearance,
          moving.instance.position.distanceTo(zone.center) - moving.instance.radius - zone.radius,
        );
      }

      if (moving.mesh && moving.matrixIndex >= 0) {
        this.tmpMatrix.compose(
          moving.instance.position,
          moving.instance.quaternion,
          this.tmpScale.setScalar(moving.instance.scale),
        );
        moving.mesh.setMatrixAt(moving.matrixIndex, this.tmpMatrix);
        moving.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Restores the exact authored state for a new run or deterministic harness seek. */
  resetMotion(): void {
    this.motionElapsed = 0;
    this.peakMotionDisplacement = 0;
    this.peakPlayerResponse = 0;
    this.minPlayerDistanceDelta = Infinity;
    this.minProtectedVolumeClearance = Infinity;
    for (const moving of this.movingHazards) {
      moving.instance.position.copy(moving.basePosition);
      moving.instance.quaternion.copy(moving.baseQuaternion);
      moving.displacement = 0;
      moving.playerResponse = 0;
      for (const zone of this.protectedVolumes) {
        this.minProtectedVolumeClearance = Math.min(
          this.minProtectedVolumeClearance,
          moving.instance.position.distanceTo(zone.center) - moving.instance.radius - zone.radius,
        );
      }
      if (moving.mesh && moving.matrixIndex >= 0) {
        this.tmpMatrix.compose(
          moving.instance.position,
          moving.instance.quaternion,
          this.tmpScale.setScalar(moving.instance.scale),
        );
        moving.mesh.setMatrixAt(moving.matrixIndex, this.tmpMatrix);
        moving.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Allocates only when the automation harness explicitly asks for evidence. */
  getMotionReport(): AsteroidMotionReport {
    return {
      count: this.movingHazards.length,
      cap: MOVING_HAZARD_CAP,
      elapsed: +this.motionElapsed.toFixed(6),
      maxDisplacement: +this.peakMotionDisplacement.toFixed(6),
      displacementLimit: +TOTAL_DISPLACEMENT_LIMIT.toFixed(6),
      maxPlayerResponse: +this.peakPlayerResponse.toFixed(6),
      playerResponseLimit: PLAYER_RESPONSE_LIMIT,
      minPlayerDistanceDelta: Number.isFinite(this.minPlayerDistanceDelta)
        ? +this.minPlayerDistanceDelta.toFixed(6)
        : 0,
      minProtectedVolumeClearance: Number.isFinite(this.minProtectedVolumeClearance)
        ? +this.minProtectedVolumeClearance.toFixed(6)
        : 0,
      signature: this.movingHazards.map(({ instance }) => (
        `${instance.id}:${instance.position.x.toFixed(4)},${instance.position.y.toFixed(4)},${instance.position.z.toFixed(4)}`
      )).join('|'),
    };
  }

  /** Cosmetic tumble uses a fixed construction-time subset, then distance-culls that subset. */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uCameraPos.value.copy(cameraPosition);
    // At 4 km a 30 m rock's rotation is sub-pixel, so tumbling only runs near the player.
    const spinRadiusSq = 4200 * 4200;
    const spin = this.spinScratch;

    for (const entry of this.tumblingAsteroids) {
      const inst = entry.instance;
      if (inst.position.distanceToSquared(cameraPosition) > spinRadiusSq) continue;
      spin.setFromAxisAngle(inst.spinAxis, inst.spinRate * dt);
      inst.quaternion.multiply(spin).normalize();
      this.tmpMatrix.compose(inst.position, inst.quaternion, this.tmpScale.setScalar(inst.scale));
      entry.mesh.setMatrixAt(entry.matrixIndex, this.tmpMatrix);
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private readonly spinScratch = new THREE.Quaternion();

  /**
   * Quality scales the *drawn* population rather than rebuilding the field. Instances are
   * always allocated at the highest count, so switching quality in the menu takes effect on
   * the very next frame instead of silently doing nothing until reload.
   *
   * Two invariants hold here and both matter:
   *   - the course is identical at every quality level, because gameplay rock is never cut;
   *   - the collision set is exactly the drawn set, because it is rebuilt from the same count.
   */
  setVisibleFraction(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    /* `length = 0` and push, NEVER `this.activeInstances = []`. The array's REFERENCE is
       load-bearing: the collider records which list it iterated and M3.hazard-invariance asserts
       that record is identical, by reference, to this list — that identity is what turned the
       collider/draw coupling from prose into an assertion. Reallocating here would red M3 with a
       message about a parity violation when the actual change was an allocation strategy. */
    this.activeInstances.length = 0;
    for (const batch of this.batches) {
      let gameplay = 0;
      while (gameplay < batch.instances.length && batch.instances[gameplay].gameplay) gameplay++;
      const count = Math.max(gameplay, Math.min(batch.instances.length, Math.round(batch.instances.length * f)));
      batch.mesh.count = Math.max(1, count);
      for (let i = 0; i < batch.mesh.count; i++) this.activeInstances.push(batch.instances[i]);
    }
  }

  dispose(): void {
    for (const batch of this.batches) batch.mesh.dispose();
    for (const v of this.variantGeometries) v.geometry.dispose();
    this.material.dispose();
  }
}
