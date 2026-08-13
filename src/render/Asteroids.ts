import * as THREE from 'three';
import { Rng, fbm3 } from '../core/rng.ts';
import { GLSL_NOISE } from './glslNoise.ts';
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

  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
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

  uniform vec3 uCameraPos;
  uniform vec3 uRock;
  uniform vec3 uMineral;
  uniform float uDetailScale;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    float h = fbm(vWorldPos * uDetailScale, 3);

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
    vec3 albedo = uRock * vTint * (0.74 + h * 0.26) * mix(0.34, 1.0, cavity);
    float roughness = clamp(0.8 + h * 0.15, 0.3, 0.98);

    vec3 color = shadeSurface(N, V, albedo, roughness, 0.04, mix(0.28, 1.0, cavity));

    // Mineral veins glow faintly, and only deep inside cracks. Kept sparse: it is an accent,
    // and at field density anything brighter turns the shelf into fairy lights.
    float vein = smoothstep(0.66, 0.86, fbm(vWorldPos * uDetailScale * 0.34 + 11.0, 4));
    vein *= 1.0 - smoothstep(0.15, 0.55, cavity);
    // Veins are a close-range detail. Beyond a few hundred metres a rock is a handful of
    // pixels and an emissive vein becomes a coloured speck floating in the sky.
    vein *= 1.0 - smoothstep(400.0, 1600.0, length(uCameraPos - vWorldPos));
    color += uMineral * vein * 0.3;

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos)), 1.0);
  }
`;

interface AsteroidGeometry {
  geometry: THREE.BufferGeometry;
  /** Radius of the generating sphere after displacement, for collision. */
  boundRadius: number;
}

function buildAsteroidGeometry(rng: Rng, detail: number): AsteroidGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
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
  let maxR = 0;

  for (let i = 0; i < count; i++) {
    const nx = pos.getX(i);
    const ny = pos.getY(i);
    const nz = pos.getZ(i);

    const big = fbm3(nx * 1.35 + ox, ny * 1.35 + oy, nz * 1.35 + oz, 4);
    const fine = fbm3(nx * 5.1 + ox, ny * 5.1 + oy, nz * 5.1 + oz, 3);
    // A couple of large concave bites read as impact craters at a glance.
    const crater = Math.max(0, fbm3(nx * 2.2 - ox, ny * 2.2 - oy, nz * 2.2 - oz, 2));
    const displacement = 1 + big * bigAmp + fine * fineAmp - Math.pow(crater, 3) * 0.3;

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
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, boundRadius: maxR };
}

export interface AsteroidInstance {
  position: THREE.Vector3;
  /** Collision radius in metres, i.e. scale * the variant's displaced bound. */
  radius: number;
  /** Uniform scale applied to the unit variant geometry. */
  scale: number;
  /** Rotation axis and rate, for the slow tumble. */
  spinAxis: THREE.Vector3;
  spinRate: number;
  quaternion: THREE.Quaternion;
}

interface AsteroidBatch {
  mesh: THREE.InstancedMesh;
  instances: AsteroidInstance[];
}

export interface AsteroidFieldOptions {
  count: number;
  lighting: LightingUniforms;
  /** Points the field is scattered around; typically the course spine. */
  spine: THREE.Vector3[];
  /** Metres either side of the spine. */
  spread: number;
  /** Metres of clear space kept around the spine so the course is always flyable. */
  corridor: number;
  minRadius: number;
  maxRadius: number;
  seed: number;
}

export class AsteroidField {
  readonly object = new THREE.Group();
  readonly instances: AsteroidInstance[] = [];

  private readonly batches: AsteroidBatch[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly variantGeometries: AsteroidGeometry[] = [];
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3();

  constructor(options: AsteroidFieldOptions) {
    const rng = new Rng(options.seed);

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

    const VARIANTS = 8;
    for (let v = 0; v < VARIANTS; v++) {
      // Bigger rocks get more geometric detail; small ones never fill enough pixels to matter.
      this.variantGeometries.push(buildAsteroidGeometry(rng.fork(v), v < 4 ? 5 : 4));
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
      const dist = options.corridor + Math.pow(rng.next(), 0.62) * options.spread;
      offset.set(dirScratch.x, dirScratch.y * 0.34, dirScratch.z).normalize().multiplyScalar(dist);

      // Power-law sizes: mostly small debris, a handful of landmark boulders. A uniform
      // distribution gives every rock a similar apparent size, which flattens the field.
      const spread01 = Math.pow(rng.next(), 2.4);
      const scale =
        options.minRadius * Math.pow(options.maxRadius / options.minRadius, spread01) *
        (rng.bool(0.035) ? 3.4 : 1);
      const variant = rng.int(0, VARIANTS);

      const instance: AsteroidInstance = {
        position: point.clone().add(offset),
        radius: scale * this.variantGeometries[variant].boundRadius,
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

    const tint = new THREE.Color();
    for (let v = 0; v < VARIANTS; v++) {
      const list = perVariant[v];
      if (list.length === 0) continue;
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
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.batches.push({ mesh, instances: list });
      this.object.add(mesh);
    }
  }

  /**
   * Tumbling is updated only for rocks near the player. At 40 km the rotation of a 30 m rock
   * is invisible, and skipping them keeps the per-frame matrix writes bounded.
   */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uCameraPos.value.copy(cameraPosition);
    // At 4 km a 30 m rock's rotation is sub-pixel, so tumbling only runs near the player.
    const spinRadiusSq = 4200 * 4200;
    const spin = this.spinScratch;

    for (const batch of this.batches) {
      let dirty = false;
      for (let i = 0; i < batch.instances.length; i++) {
        const inst = batch.instances[i];
        if (inst.position.distanceToSquared(cameraPosition) > spinRadiusSq) continue;
        spin.setFromAxisAngle(inst.spinAxis, inst.spinRate * dt);
        inst.quaternion.multiply(spin).normalize();
        this.tmpMatrix.compose(inst.position, inst.quaternion, this.tmpScale.setScalar(inst.scale));
        batch.mesh.setMatrixAt(i, this.tmpMatrix);
        dirty = true;
      }
      if (dirty) batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private readonly spinScratch = new THREE.Quaternion();

  dispose(): void {
    for (const batch of this.batches) batch.mesh.dispose();
    for (const v of this.variantGeometries) v.geometry.dispose();
    this.material.dispose();
  }
}
