import * as THREE from 'three';
import { loft, type LoftStation } from './loft.ts';
import { GLSL_NOISE } from './glslNoise.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { Rng } from '../core/rng.ts';
import { PALETTE } from '../core/art.ts';

/**
 * Built things. Two jobs:
 *
 *  1. VESPER TERMINUS — the destination. A kilometre-wide docking ring you fly *through*, so
 *     arriving is an action rather than a fade to black.
 *  2. Derelicts and spars scattered along the route. These exist almost entirely to give the
 *     eye a known-size object at a middle distance; without them a 6 km leg and a 60 km leg
 *     look the same, and the sector loses its scale.
 *
 * Detail comes from instanced greebles rather than modelled geometry: a few thousand boxes
 * on a hull surface is the cheapest convincing way to say "this was manufactured".
 */

const STRUCTURE_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  void main() {
    #ifdef USE_INSTANCING
      vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
      vLocal = (instanceMatrix * vec4(position, 1.0)).xyz;
    #else
      vec4 world = modelMatrix * vec4(position, 1.0);
      vNormal = normalize(mat3(modelMatrix) * normal);
      vLocal = position;
    #endif
    vWorldPos = world.xyz;
    vLocalNormal = normal;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const STRUCTURE_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;

  uniform vec3 uCameraPos;
  uniform vec3 uBase;
  uniform vec3 uAccent;
  uniform vec3 uWindow;
  uniform float uWindowDensity;
  uniform float uTime;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    float plate = fbm(vLocal * 0.014, 4) * 0.5 + 0.5;
    vec3 albedo = mix(uBase, uAccent, smoothstep(0.45, 0.72, plate));

    // Panel grid, coarse enough to be legible from a kilometre out.
    vec3 g = abs(fract(vLocal * 0.055) - 0.5);
    float seam = 1.0 - smoothstep(0.0, 0.045, min(min(g.x, g.y), g.z));
    albedo *= 1.0 - seam * 0.42;

    float roughness = clamp(0.42 + plate * 0.34 + seam * 0.2, 0.12, 0.95);
    vec3 color = shadeSurface(N, V, albedo, roughness, 0.72, 1.0 - seam * 0.3);

    // Lit windows: a sparse hash on a coarse grid, a few of them flickering.
    vec3 cell = floor(vLocal * 0.16);
    float pick = hash13(cell);
    float on = step(1.0 - uWindowDensity, pick);
    vec2 f = abs(fract(vLocal.xy * 0.16) - 0.5);
    float pane = (1.0 - smoothstep(0.16, 0.3, max(f.x, f.y))) * on;
    float flicker = step(0.94, fract(pick * 31.7)) * (0.5 + 0.5 * sin(uTime * 13.0 + pick * 90.0));
    color += uWindow * pane * (1.4 + flicker * 1.6);

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos)), 1.0);
  }
`;

const APPROACH_LIGHT_VERT = /* glsl */ `
  attribute float aOrder;
  uniform float uTime;
  uniform float uPixelScale;
  uniform float uCount;
  varying float vGlow;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    gl_PointSize = max(900.0 / max(dist, 1.0), 2.0) * uPixelScale;
    // A light chases inward around the aperture: it reads as "this way in" instantly.
    float phase = fract(aOrder / uCount - uTime * 0.32);
    vGlow = 0.28 + pow(1.0 - phase, 8.0) * 2.4;
  }
`;

const APPROACH_LIGHT_FRAG = /* glsl */ `
  precision highp float;
  varying float vGlow;
  uniform vec3 uColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = exp(-r * r * 6.0);
    gl_FragColor = vec4(uColor * core * vGlow * 3.0, core * min(vGlow, 1.0));
  }
`;

function greebleGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

export interface TerminusOptions {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  lighting: LightingUniforms;
  seed: number;
}

export class Terminus {
  readonly object = new THREE.Group();
  readonly apertureRadius = 430;
  readonly position: THREE.Vector3;
  readonly normal: THREE.Vector3;

  private readonly hullMat: THREE.ShaderMaterial;
  private readonly lightMat: THREE.ShaderMaterial;
  private readonly spinner = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(options: TerminusOptions) {
    this.position = options.position.clone();
    this.normal = options.normal.clone().normalize();
    const rng = new Rng(options.seed);

    this.hullMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(0x2b3340) },
        uAccent: { value: new THREE.Color(0x8f9aa8) },
        uWindow: { value: new THREE.Color(0xffd9a0).multiplyScalar(1.6) },
        uWindowDensity: { value: 0.1 },
        uTime: { value: 0 },
      }),
      vertexShader: STRUCTURE_VERT,
      fragmentShader: STRUCTURE_FRAG,
    });

    const outer = 1020;
    const inner = this.apertureRadius;

    // --- main ring ------------------------------------------------------------------
    const ringProfile: LoftStation[] = [
      { z: -150, width: 96, height: 96, squareness: 4.5 },
      { z: -70, width: 150, height: 150, squareness: 5.5 },
      { z: 70, width: 150, height: 150, squareness: 5.5 },
      { z: 150, width: 96, height: 96, squareness: 4.5 },
    ];
    const sectionGeo = loft({ stations: ringProfile, radialSegments: 12, capStart: true, capEnd: true });
    this.geometries.push(sectionGeo);
    const sectionCount = 48;
    const ringMesh = new THREE.InstancedMesh(sectionGeo, this.hullMat, sectionCount);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const ringRadius = (outer + inner) * 0.5;
    for (let i = 0; i < sectionCount; i++) {
      const a = (i / sectionCount) * Math.PI * 2;
      pos.set(Math.cos(a) * ringRadius, Math.sin(a) * ringRadius, 0);
      // Each segment is rotated so its long axis follows the ring's circumference.
      quat.setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2));
      const stretch = (Math.PI * 2 * ringRadius) / sectionCount / 300;
      scale.set(1, 1, stretch * 1.06);
      matrix.compose(pos, quat, scale);
      ringMesh.setMatrixAt(i, matrix);
    }
    ringMesh.instanceMatrix.needsUpdate = true;
    this.spinner.add(ringMesh);

    // --- inner rim: the aperture the player flies through ---------------------------
    const rimGeo = new THREE.TorusGeometry(inner, 34, 10, 96);
    this.geometries.push(rimGeo);
    this.spinner.add(new THREE.Mesh(rimGeo, this.hullMat));

    // --- radial spars ----------------------------------------------------------------
    const sparProfile: LoftStation[] = [
      { z: 0, width: 30, height: 60, squareness: 5 },
      { z: outer - inner, width: 46, height: 96, squareness: 5 },
    ];
    const sparGeo = loft({ stations: sparProfile, radialSegments: 8, capStart: true, capEnd: true });
    this.geometries.push(sparGeo);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const spar = new THREE.Mesh(sparGeo, this.hullMat);
      spar.position.set(Math.cos(a) * inner, Math.sin(a) * inner, 0);
      spar.rotation.z = a;
      spar.rotation.y = Math.PI / 2;
      this.spinner.add(spar);
    }

    // --- greebles ---------------------------------------------------------------------
    const greebleGeo = greebleGeometry();
    this.geometries.push(greebleGeo);
    const greebleCount = 900;
    const greebles = new THREE.InstancedMesh(greebleGeo, this.hullMat, greebleCount);
    for (let i = 0; i < greebleCount; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(inner + 60, outer - 30);
      const face = rng.bool() ? 1 : -1;
      pos.set(Math.cos(a) * r, Math.sin(a) * r, face * rng.range(120, 175));
      quat.setFromEuler(new THREE.Euler(rng.range(0, 0.3), rng.range(0, 0.3), a));
      scale.set(rng.range(14, 62), rng.range(14, 62), rng.range(10, 46));
      matrix.compose(pos, quat, scale);
      greebles.setMatrixAt(i, matrix);
    }
    greebles.instanceMatrix.needsUpdate = true;
    this.spinner.add(greebles);

    // --- approach lights ---------------------------------------------------------------
    const lightCount = 72;
    const lp = new Float32Array(lightCount * 3);
    const lo = new Float32Array(lightCount);
    for (let i = 0; i < lightCount; i++) {
      const a = (i / lightCount) * Math.PI * 2;
      lp[i * 3] = Math.cos(a) * (inner + 52);
      lp[i * 3 + 1] = Math.sin(a) * (inner + 52);
      lp[i * 3 + 2] = 0;
      lo[i] = i;
    }
    const lightGeo = new THREE.BufferGeometry();
    lightGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lightGeo.setAttribute('aOrder', new THREE.BufferAttribute(lo, 1));
    this.geometries.push(lightGeo);
    this.lightMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 1 },
        uCount: { value: lightCount },
        uColor: { value: new THREE.Color(PALETTE.gateArmed) },
      },
      vertexShader: APPROACH_LIGHT_VERT,
      fragmentShader: APPROACH_LIGHT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lights = new THREE.Points(lightGeo, this.lightMat);
    lights.frustumCulled = false;
    this.spinner.add(lights);

    this.object.add(this.spinner);
    this.object.position.copy(this.position);
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
  }

  update(time: number, cameraPosition: THREE.Vector3, pixelScale: number): void {
    this.hullMat.uniforms.uTime.value = time;
    this.hullMat.uniforms.uCameraPos.value.copy(cameraPosition);
    this.lightMat.uniforms.uTime.value = time;
    this.lightMat.uniforms.uPixelScale.value = pixelScale;
    // Slow enough to be dignified: a kilometre-wide ring should not look like a fan.
    this.spinner.rotation.z = time * 0.012;
  }

  /** Signed distance to the docking plane. */
  signedDistance(point: THREE.Vector3): number {
    return (
      (point.x - this.position.x) * this.normal.x +
      (point.y - this.position.y) * this.normal.y +
      (point.z - this.position.z) * this.normal.z
    );
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.hullMat.dispose();
    this.lightMat.dispose();
  }
}

export interface DerelictFieldOptions {
  lighting: LightingUniforms;
  spine: THREE.Vector3[];
  seed: number;
  count: number;
}

/** Broken hull sections and abandoned spars, used purely as scale references. */
export class DerelictField {
  readonly object = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(options: DerelictFieldOptions) {
    const rng = new Rng(options.seed);

    this.material = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(0x2a2b2e) },
        uAccent: { value: new THREE.Color(0x6a655c) },
        uWindow: { value: new THREE.Color(0xff9a55).multiplyScalar(0.8) },
        uWindowDensity: { value: 0.02 },
        uTime: { value: 0 },
      }),
      vertexShader: STRUCTURE_VERT,
      fragmentShader: STRUCTURE_FRAG,
    });

    for (let i = 0; i < options.count; i++) {
      const t = (i + 0.5) / options.count;
      const anchor = options.spine[Math.floor(t * (options.spine.length - 1))];
      const length = rng.range(320, 1400);
      const width = length * rng.range(0.1, 0.24);

      // A torn hull section: full section forward, ragged and thinning aft.
      const stations: LoftStation[] = [];
      const segments = 7;
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const taper = Math.max(0.08, 1 - Math.pow(u, 1.7) * rng.range(0.7, 1.05));
        stations.push({
          z: -length * 0.5 + length * u,
          width: width * taper * rng.range(0.85, 1.15),
          height: width * taper * rng.range(0.6, 1.0),
          squareness: rng.range(3, 6),
        });
      }
      const geometry = loft({ stations, radialSegments: 14, capStart: true });
      this.geometries.push(geometry);

      const mesh = new THREE.Mesh(geometry, this.material);
      const dir = { x: 0, y: 0, z: 0 };
      rng.onSphere(dir);
      const distance = rng.range(2600, 11000);
      mesh.position.set(
        anchor.x + dir.x * distance,
        anchor.y + dir.y * distance * 0.4,
        anchor.z + dir.z * distance,
      );
      mesh.rotation.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
      this.object.add(mesh);
    }
  }

  update(time: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uCameraPos.value.copy(cameraPosition);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}
