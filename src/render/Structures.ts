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

    // Two panel grids: big structural plates and a finer skin. Coarse enough to stay legible
    // from a kilometre, fine enough to have something to look at from a hundred metres.
    vec3 g = abs(fract(vLocal * 0.018) - 0.5);
    float seam = 1.0 - smoothstep(0.0, 0.035, min(min(g.x, g.y), g.z));
    vec3 g2 = abs(fract(vLocal * 0.09 + 0.37) - 0.5);
    float seam2 = 1.0 - smoothstep(0.0, 0.05, min(min(g2.x, g2.y), g2.z));
    seam = clamp(seam + seam2 * 0.4, 0.0, 1.0);
    albedo *= 1.0 - seam * 0.5;

    float roughness = clamp(0.42 + plate * 0.34 + seam * 0.2, 0.12, 0.95);
    vec3 color = shadeSurface(N, V, albedo, roughness, 0.72, 1.0 - seam * 0.3);

    // Lit window banks. Long thin strips rather than square panes: strips read as decks and
    // corridors, squares read as a pegboard, and strips also survive minification because
    // they stay several pixels long even when they are one pixel tall.
    // Cylindrical mapping: the strips run *around* the ring rather than across it, which is
    // how a rotating habitat would actually be laid out and stops the grid fighting the form.
    float ang = atan(vLocal.y, vLocal.x);
    float rad = length(vLocal.xy);
    vec3 cell = floor(vec3(ang * 7.0, rad * 0.016, vLocal.z * 0.02));
    float pick = hash13(cell);
    float on = step(1.0 - uWindowDensity, pick);
    vec2 f = abs(fract(vec2(ang * 7.0, rad * 0.016)) - 0.5);
    float pane = (1.0 - smoothstep(0.34, 0.48, f.x)) * (1.0 - smoothstep(0.1, 0.26, f.y)) * on;
    float flicker = step(0.96, fract(pick * 31.7)) * (0.5 + 0.5 * sin(uTime * 13.0 + pick * 90.0));
    float dist = length(uCameraPos - vWorldPos);
    pane *= 1.0 - smoothstep(2200.0, 6000.0, dist);
    // Vary the output per bank so the station is not uniformly powered.
    color += uWindow * pane * (0.28 + fract(pick * 7.3) * 0.7 + flicker * 0.7);

    // Structural floodlighting. The terminus has to read as inhabited machinery even when the
    // star is behind it, so it carries its own dim key rather than relying on the sun.
    float upward = max(dot(N, normalize(vec3(0.0, 0.0, 1.0))), 0.0);
    color += albedo * uWindow * 0.09 * (0.35 + upward * 0.65);

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

/**
 * A closed ring hull: a superelliptical cross-section swept around a circle. Building the
 * ring as one continuous surface rather than as N copies of a straight section means the
 * orientation can never drift out of alignment with the circumference, which is exactly how
 * the first attempt collapsed into an unreadable knot.
 */
function buildRingHull(
  radius: number,
  halfRadial: number,
  halfAxial: number,
  segments: number,
  sides: number,
  squareness: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const n = 2 / squareness;

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Frame: outward is radial, axial is the ring's own normal.
    for (let j = 0; j <= sides; j++) {
      const b = (j / sides) * Math.PI * 2;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const r = Math.sign(cb) * Math.pow(Math.abs(cb), n) * halfRadial;
      const z = Math.sign(sb) * Math.pow(Math.abs(sb), n) * halfAxial;
      const rr = radius + r;
      positions.push(ca * rr, sa * rr, z);
      uvs.push(i / segments, j / sides);
    }
  }

  const stride = sides + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const p0 = i * stride + j;
      const p1 = p0 + 1;
      const p2 = p0 + stride;
      const p3 = p2 + 1;
      indices.push(p0, p2, p1, p1, p2, p3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const APERTURE_BAND_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uTime;
  void main() {
    float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
    float core = pow(across, 2.2);
    // Two counter-running chases so the aperture reads as powered machinery.
    float a = smoothstep(0.72, 1.0, sin(vUv.x * 6.2831 * 6.0 - uTime * 1.4) * 0.5 + 0.5);
    float b = smoothstep(0.86, 1.0, sin(vUv.x * 6.2831 * 24.0 + uTime * 0.7) * 0.5 + 0.5);
    float glow = 0.5 + a * 1.4 + b * 0.7;
    gl_FragColor = vec4(uColor * core * glow * 2.2, core * min(glow, 1.0) * 0.9);
  }
`;

export interface TerminusOptions {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  lighting: LightingUniforms;
  seed: number;
}

/**
 * VESPER TERMINUS. Two kilometres across, with a 430 m aperture down the middle that the
 * player flies through to end the run.
 *
 * Everything is subordinated to reading correctly from four kilometres out: a heavy, solid
 * silhouette, a small number of large structural elements, one bright ring of approach light
 * marking the hole, and detail that only appears once you are close enough for it to mean
 * anything.
 */
export class Terminus {
  readonly object = new THREE.Group();
  readonly apertureRadius = 430;
  readonly position: THREE.Vector3;
  readonly normal: THREE.Vector3;

  private readonly hullMat: THREE.ShaderMaterial;
  private readonly lightMat: THREE.ShaderMaterial;
  private readonly bandMat: THREE.ShaderMaterial;
  private readonly spinner = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(options: TerminusOptions) {
    this.position = options.position.clone();
    this.normal = options.normal.clone().normalize();
    const rng = new Rng(options.seed);

    this.hullMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(0x49525f) },
        uAccent: { value: new THREE.Color(0x9aa6b4) },
        uWindow: { value: new THREE.Color(0xffcf92).multiplyScalar(1.1) },
        uWindowDensity: { value: 0.34 },
        uTime: { value: 0 },
      }),
      vertexShader: STRUCTURE_VERT,
      fragmentShader: STRUCTURE_FRAG,
    });

    const inner = this.apertureRadius;
    const outer = 1180;
    const ringMid = (inner + outer) * 0.5;
    const ringHalf = (outer - inner) * 0.5;

    // --- primary ring -----------------------------------------------------------------
    const ringGeo = buildRingHull(ringMid, ringHalf, 190, 128, 16, 5.0);
    this.geometries.push(ringGeo);
    this.spinner.add(new THREE.Mesh(ringGeo, this.hullMat));

    // --- aperture collar --------------------------------------------------------------
    const collarGeo = buildRingHull(inner - 26, 46, 250, 96, 12, 4.0);
    this.geometries.push(collarGeo);
    this.spinner.add(new THREE.Mesh(collarGeo, this.hullMat));

    // --- outer rim rail ---------------------------------------------------------------
    const railGeo = buildRingHull(outer + 34, 40, 78, 128, 10, 3.0);
    this.geometries.push(railGeo);
    this.spinner.add(new THREE.Mesh(railGeo, this.hullMat));

    // --- radial ribs across the ring face ---------------------------------------------
    const ribGeo = new THREE.BoxGeometry(outer - inner + 60, 96, 430);
    this.geometries.push(ribGeo);
    const ribCount = 16;
    const ribs = new THREE.InstancedMesh(ribGeo, this.hullMat, ribCount);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < ribCount; i++) {
      const a = (i / ribCount) * Math.PI * 2;
      pos.set(Math.cos(a) * ringMid, Math.sin(a) * ringMid, 0);
      quat.setFromEuler(new THREE.Euler(0, 0, a));
      matrix.compose(pos, quat, scale);
      ribs.setMatrixAt(i, matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;
    this.spinner.add(ribs);

    // --- docking spires: the vertical elements that give the ring a top and a bottom ----
    const spireProfile: LoftStation[] = [
      { z: 0, width: 60, height: 60, squareness: 5 },
      { z: 240, width: 96, height: 96, squareness: 6 },
      { z: 430, width: 62, height: 62, squareness: 5 },
      { z: 520, width: 20, height: 20, squareness: 4 },
    ];
    const spireGeo = loft({ stations: spireProfile, radialSegments: 10, capStart: true, capEnd: true });
    this.geometries.push(spireGeo);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      for (const face of [1, -1]) {
        const spire = new THREE.Mesh(spireGeo, this.hullMat);
        spire.position.set(Math.cos(a) * ringMid, Math.sin(a) * ringMid, face * 150);
        spire.rotation.x = face > 0 ? 0 : Math.PI;
        this.spinner.add(spire);
      }
    }

    // --- greebles: fewer and much larger than the first pass ---------------------------
    const greebleGeo = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(greebleGeo);
    const greebleCount = 240;
    const greebles = new THREE.InstancedMesh(greebleGeo, this.hullMat, greebleCount);
    for (let i = 0; i < greebleCount; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(inner + 120, outer - 90);
      const face = rng.bool() ? 1 : -1;
      pos.set(Math.cos(a) * r, Math.sin(a) * r, face * rng.range(160, 205));
      quat.setFromEuler(new THREE.Euler(0, 0, a + rng.signed(0.25)));
      scale.set(rng.range(70, 220), rng.range(50, 150), rng.range(30, 90));
      matrix.compose(pos, quat, scale);
      greebles.setMatrixAt(i, matrix);
    }
    greebles.instanceMatrix.needsUpdate = true;
    this.spinner.add(greebles);

    // --- aperture light band: the thing you actually aim at ----------------------------
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.gateArmed) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: APERTURE_BAND_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    for (const z of [-215, 215]) {
      const bandGeo = new THREE.TorusGeometry(inner + 6, 16, 6, 160);
      this.geometries.push(bandGeo);
      const band = new THREE.Mesh(bandGeo, this.bandMat);
      band.position.z = z;
      band.renderOrder = 6;
      this.spinner.add(band);
    }

    // --- approach strobes --------------------------------------------------------------
    const lightCount = 48;
    const lp = new Float32Array(lightCount * 3);
    const lo = new Float32Array(lightCount);
    for (let i = 0; i < lightCount; i++) {
      const a = (i / lightCount) * Math.PI * 2;
      lp[i * 3] = Math.cos(a) * (inner + 78);
      lp[i * 3 + 1] = Math.sin(a) * (inner + 78);
      lp[i * 3 + 2] = -235;
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
    lights.renderOrder = 7;
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
    this.bandMat.uniforms.uTime.value = time;
    // Slow enough to be dignified: a two-kilometre ring should not look like a fan.
    this.spinner.rotation.z = time * 0.009;
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
    this.bandMat.dispose();
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
      const length = rng.range(420, 1900);
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
      // Close enough to read as a known-size object, far enough to stay out of the racing line.
      const distance = rng.range(1700, 6200);
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
