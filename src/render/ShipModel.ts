import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildWing, loft, type LoftStation } from './loft.ts';
import { GLSL_NOISE } from './glslNoise.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { PALETTE } from '../core/art.ts';

/**
 * KESTREL-C7. An 18-metre courier interceptor: long nose, low canopy, mid-mounted swept
 * wings, twin outboard drive pods, canted tail fins.
 *
 * The whole airframe is lofted from cross-section tables, so it has real volume and a real
 * silhouette from every angle — which matters because a chase camera shows the ship from
 * behind three quarters of the time, and a flat billboard or a box stack reads as cheap
 * immediately.
 */

const HULL_VERT = /* glsl */ `
  attribute float aZone;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  varying float vZone;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    vLocalNormal = normal;
    vZone = aZone;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const HULL_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  varying float vZone;

  uniform vec3 uCameraPos;
  uniform vec3 uGraphite;
  uniform vec3 uArmor;
  uniform vec3 uGunmetal;
  uniform vec3 uTrim;
  uniform vec3 uHeat;
  uniform float uDamage;
  uniform float uTime;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    // Material identity is authored by actual parts rather than inferred from upward normals.
    // 0 graphite frame, 1 ivory ceramic armor, 2 restrained amber trim, 3 heat-treated hardware.
    float armor = 1.0 - step(0.49, abs(vZone - 1.0));
    float trim = 1.0 - step(0.49, abs(vZone - 2.0));
    float heat = 1.0 - step(0.49, abs(vZone - 3.0));
    float gunmetal = 1.0 - clamp(armor + trim + heat, 0.0, 1.0);

    vec3 albedo = uGraphite;
    albedo = mix(albedo, uArmor, armor);
    albedo = mix(albedo, uTrim, trim);
    albedo = mix(albedo, uHeat, heat);
    // Broad, continuous finish drift avoids both a uniform wash and unfiltered panel mosaics.
    float finish = fbm(vLocal * 0.16 + vec3(2.0, 7.0, 11.0), 3) * 0.5 + 0.5;
    albedo *= mix(0.94, 1.025, finish);
    float roughness = mix(0.62, 0.42, armor);
    roughness = mix(roughness, 0.38, trim);
    roughness = mix(roughness, 0.48, heat);
    float metalness = mix(0.68, 0.1, armor);
    metalness = mix(metalness, 0.56, trim);
    metalness = mix(metalness, 0.76, heat);
    float ao = mix(0.82, 1.0, armor);

    vec3 color = shadeSurface(N, V, albedo, roughness, metalness, ao);

    // Preserve warm ceramic highlights without feeding a broad clipped shelf into bloom. Shadowed
    // armor is untouched; only peaks above 0.72 are compressed, by luminance-preserving scaling.
    float armorPeak = max(max(color.r, color.g), color.b);
    float peakOver = max(armorPeak - 0.72, 0.0);
    float rolledPeak = 0.72 + peakOver / (1.0 + peakOver * 1.65);
    float peakScale = rolledPeak / max(armorPeak, 1e-4);
    color *= mix(1.0, peakScale, armor * step(0.72, armorPeak));

    // Graphite keeps a narrow, directionally-lit grazing response in backlight. This is not an
    // exposure lift: face-on and anti-light surfaces receive nothing, preserving the cold frame.
    float graphiteSheen = gunmetal * pow(1.0 - max(dot(N, V), 0.0), 4.0)
      * smoothstep(-0.05, 0.7, dot(N, uSunDir));
    color += uGunmetal * graphiteSheen * 0.22;

    float safeDamage = clamp(uDamage, 0.0, 1.0);
    if (safeDamage > 0.001) {
      float scorch = smoothstep(0.6, 1.0, fbm(vLocal * 3.4 + 21.0, 4) * 0.5 + 0.5);
      color = mix(color, color * 0.22, scorch * safeDamage * mix(0.7, 1.0, armor));
      color += vec3(0.72, 0.16, 0.035) * scorch * safeDamage * 0.34
        * (0.65 + 0.35 * sin(uTime * 11.0));
    }

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos), V), 1.0);
  }
`;

const CANOPY_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;

  uniform vec3 uCameraPos;
  uniform vec3 uGlass;
  uniform vec3 uInterior;
  uniform float uTime;

  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.2);

    // Dark glass: almost black head-on, a hard specular sheet at grazing angles, and a hint
    // of instrument light bleeding through from inside.
    vec3 color = uGlass * 0.3;
    color += shadeSurface(N, V, uGlass, 0.23, 0.42, 1.0) * 0.46;
    color += vec3(0.22, 0.46, 0.56) * fres * 0.34;
    color += uInterior * (0.07 + 0.025 * sin(uTime * 2.3)) * (1.0 - fres);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const PLUME_VERT = /* glsl */ `
  attribute vec3 aNozzle;
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  uniform float uLength;
  uniform float uWidth;
  void main() {
    vUv = uv;
    vec3 local = position - aNozzle;
    local.xy *= uWidth;
    local.z *= uLength;
    vec3 p = aNozzle + local;
    vLocal = local;
    vViewNormal = normalize(normalMatrix * vec3(normal.xy / uWidth, normal.z / uLength));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewDir = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  uniform vec3 uCore;
  uniform vec3 uFlame;
  uniform float uPower;
  uniform float uTime;

  ${GLSL_NOISE}

  void main() {
    // The shell is authored with vUv.y = 1 at the nozzle and 0 at the tail. Keep the corrected
    // nozzle-to-tail direction explicit: every axial term below expects t = 0 at the nozzle.
    float t = clamp(1.0 - vUv.y, 0.0, 1.0);

    // Keep the wrapped circumference continuous; using it as a fake radius cuts a view-dependent
    // seam into the shell. Fine variation is deliberately too small to break the body apart.
    float around = 0.94 + 0.06 * sin(vUv.x * 6.2831853 + uTime * 2.7);
    float diamonds = 0.88 + 0.12 * sin(t * 30.0 - uTime * 20.0);
    float turb = fbm(vec3(vLocal.xy * 3.4, t * 6.0 - uTime * 5.0), 3) * 0.5 + 0.5;

    // Release the translucent shell just behind the hardware. Full density at t=0 projected the
    // cone wall across the bell aperture and made the modeled rings read as a glass sphere.
    float rootRelease = smoothstep(0.025, 0.11, t);
    float body = rootRelease * pow(1.0 - t, 1.25) * (1.0 - smoothstep(0.76, 1.0, t));
    float facing = abs(dot(normalize(vViewNormal), normalize(vViewDir)));
    float softSurface = 0.55 + 0.45 * pow(facing, 0.55);
    float density = body * softSurface * around * (0.86 + turb * 0.2) * diamonds;

    vec3 col = mix(uFlame, uCore, pow(1.0 - t, 1.8));
    col *= uPower * 2.0;

    gl_FragColor = vec4(col, clamp(density * 0.72, 0.0, 1.0));
  }
`;

export interface ShipVisualOptions {
  lighting: LightingUniforms;
}

export interface ShipNozzle {
  /** Local-space position of the nozzle mouth. */
  position: THREE.Vector3;
  radius: number;
}

type SurfaceZone = 0 | 1 | 2 | 3;

const GRAPHITE_ZONE: SurfaceZone = 0;
const ARMOR_ZONE: SurfaceZone = 1;
const TRIM_ZONE: SurfaceZone = 2;
const HEAT_ZONE: SurfaceZone = 3;

const HULL_STATIONS: readonly LoftStation[] = [
  { z: -9.0, width: 0.06, height: 0.05, squareness: 2.2, offsetY: -0.12 },
  { z: -8.3, width: 0.34, height: 0.24, squareness: 2.8, offsetY: -0.14, bottomScale: 0.86 },
  { z: -7.35, width: 0.58, height: 0.38, squareness: 3.2, offsetY: -0.13, bottomScale: 0.83 },
  { z: -6.8, width: 0.72, height: 0.46, squareness: 3.6, offsetY: -0.12, bottomScale: 0.82 },
  { z: -5.7, width: 0.87, height: 0.56, squareness: 4.15, offsetY: -0.09, bottomScale: 0.81 },
  { z: -4.6, width: 1.08, height: 0.7, squareness: 4.5, offsetY: -0.06, bottomScale: 0.82 },
  { z: -3.55, width: 1.18, height: 0.77, squareness: 4.1, offsetY: -0.035, bottomScale: 0.84 },
  { z: -2.0, width: 1.42, height: 0.9, squareness: 4.7, bottomScale: 0.86 },
  { z: -0.45, width: 1.54, height: 0.96, squareness: 4.2, offsetY: 0.01, bottomScale: 0.87 },
  { z: 0.8, width: 1.6, height: 0.98, squareness: 4.8, bottomScale: 0.88 },
  { z: 1.9, width: 1.58, height: 0.96, squareness: 4.15, bottomScale: 0.89 },
  { z: 3.4, width: 1.5, height: 0.9, squareness: 4.35, bottomScale: 0.92 },
  { z: 4.45, width: 1.37, height: 0.82, squareness: 3.75, bottomScale: 0.94 },
  { z: 5.6, width: 1.16, height: 0.72, squareness: 3.9, bottomScale: 0.96 },
  { z: 6.35, width: 1.04, height: 0.65, squareness: 3.35, bottomScale: 0.98 },
  { z: 6.9, width: 0.92, height: 0.58, squareness: 3.0 },
  { z: 7.2, width: 0.6, height: 0.4, squareness: 2.8 },
];

interface StaticPartBatch {
  parts: THREE.BufferGeometry[];
  material: THREE.Material;
  name: string;
  renderOrder: number;
  frustumCulled?: boolean;
}

export class ShipModel {
  readonly object = new THREE.Group();
  /** Nozzle anchors in ship-local space, for trails and audio panning. */
  readonly nozzles: ShipNozzle[] = [];

  private readonly hullMat: THREE.ShaderMaterial;
  private readonly canopyMat: THREE.ShaderMaterial;
  private readonly plumeMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly solidParts: THREE.BufferGeometry[] = [];
  private readonly canopyParts: THREE.BufferGeometry[] = [];
  private readonly glowParts: THREE.BufferGeometry[] = [];
  private readonly plumeParts: THREE.BufferGeometry[] = [];
  private readonly idleCore = new THREE.Color(PALETTE.engineCore);
  private readonly boostCore = new THREE.Color(PALETTE.engineBoost);

  constructor(options: ShipVisualOptions) {
    this.object.name = 'kestrel-c7-cold-frame-warm-skin';

    // Every material is allocated up front. Geometry builders below only author static parts, so
    // entering flight cannot discover a new shader variant and hitch on compilation.
    this.hullMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uGraphite: { value: new THREE.Color(0x101820) },
        uArmor: { value: new THREE.Color(0xb8aa8d) },
        uGunmetal: { value: new THREE.Color(0x35424d) },
        uTrim: { value: new THREE.Color(0xb7652e) },
        uHeat: { value: new THREE.Color(0x342d31) },
        uDamage: { value: 0 },
        uTime: { value: 0 },
      }),
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
      side: THREE.FrontSide,
    });

    this.canopyMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uGlass: { value: new THREE.Color(0x203844) },
        uInterior: { value: new THREE.Color(0x225667) },
        uTime: { value: 0 },
      }),
      vertexShader: HULL_VERT,
      fragmentShader: CANOPY_FRAG,
      side: THREE.FrontSide,
    });

    this.glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.engineCore) },
        uFlame: { value: new THREE.Color(PALETTE.engineFlame) },
        uPower: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uColor;
        uniform vec3 uFlame;
        uniform float uPower;
        void main() {
          // A CircleGeometry has one normal, so the old view-facing term was constant across the
          // whole throat and tonemapped into a flat white coin. A radial core keeps the nozzle
          // cyan, gives bloom a compact source, and feathers directly into the plume behind it.
          float radius = length((vUv - 0.5) * 2.0);
          float halo = 1.0 - smoothstep(0.12, 0.8, radius);
          float core = 1.0 - smoothstep(0.0, 0.34, radius);
          vec3 col = mix(uFlame, uColor, 0.72 + core * 0.28) * (halo * 0.42 + core * 0.72);
          gl_FragColor = vec4(col * uPower * 0.48, halo * 0.82);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.plumeMat = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: this.idleCore.clone() },
        uFlame: { value: new THREE.Color(PALETTE.engineFlame) },
        uPower: { value: 0 },
        uLength: { value: 6 },
        uWidth: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.buildFuselage();
    this.buildCanopy();
    this.buildWings();
    this.buildFins();
    this.buildDrivePods();
    this.flushStaticBatches();
  }

  private addSolid(
    geometry: THREE.BufferGeometry,
    zone: SurfaceZone,
    position = new THREE.Vector3(),
    rotation = new THREE.Euler(),
    scale = new THREE.Vector3(1, 1, 1),
  ): void {
    const matrix = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      scale,
    );
    geometry.applyMatrix4(matrix);
    const zoneValues = new Float32Array(geometry.getAttribute('position').count);
    zoneValues.fill(zone);
    geometry.setAttribute('aZone', new THREE.BufferAttribute(zoneValues, 1));
    this.solidParts.push(geometry);
  }

  private addCanopy(geometry: THREE.BufferGeometry): void {
    geometry.setAttribute(
      'aZone',
      new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1),
    );
    this.canopyParts.push(geometry);
  }

  private addGlow(
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3,
    rotation = new THREE.Euler(),
  ): void {
    geometry.applyMatrix4(new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      new THREE.Vector3(1, 1, 1),
    ));
    this.glowParts.push(geometry);
  }

  private addPlume(geometry: THREE.BufferGeometry, nozzle: THREE.Vector3): void {
    geometry.translate(nozzle.x, nozzle.y, nozzle.z);
    const centres = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let vertex = 0; vertex < centres.length; vertex += 3) {
      centres[vertex] = nozzle.x;
      centres[vertex + 1] = nozzle.y;
      centres[vertex + 2] = nozzle.z;
    }
    geometry.setAttribute('aNozzle', new THREE.BufferAttribute(centres, 3));
    this.plumeParts.push(geometry);
  }

  private flushStaticBatches(): void {
    const batches: StaticPartBatch[] = [
      { parts: this.solidParts, material: this.hullMat, name: 'merged-armor-and-frame', renderOrder: 0 },
      { parts: this.canopyParts, material: this.canopyMat, name: 'integrated-canopy-glass', renderOrder: 1 },
      { parts: this.glowParts, material: this.glowMat, name: 'recessed-engine-cores', renderOrder: 3 },
      { parts: this.plumeParts, material: this.plumeMat, name: 'paired-engine-plumes', renderOrder: 4, frustumCulled: false },
    ];

    for (const batch of batches) {
      if (batch.parts.length === 0) continue;
      const merged = mergeGeometries(batch.parts, false);
      for (const part of batch.parts) part.dispose();
      batch.parts.length = 0;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      this.geometries.push(merged);
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.name = batch.name;
      mesh.renderOrder = batch.renderOrder;
      mesh.frustumCulled = batch.frustumCulled ?? true;
      this.object.add(mesh);
    }
  }

  private buildFuselage(): void {
    this.addSolid(
      loft({ stations: [...HULL_STATIONS], radialSegments: 40, capStart: true, capEnd: true }),
      GRAPHITE_ZONE,
    );

    // A cold graphite keel and dorsal carry-through remain visible between every raised cassette.
    const spine: LoftStation[] = [
      { z: -3.3, width: 0.2, height: 0.1, squareness: 4.0, offsetY: 0.73 },
      { z: -1.0, width: 0.39, height: 0.25, squareness: 5.0, offsetY: 0.86 },
      { z: 1.4, width: 0.44, height: 0.28, squareness: 5.4, offsetY: 0.89 },
      { z: 3.5, width: 0.4, height: 0.25, squareness: 5.1, offsetY: 0.83 },
      { z: 5.3, width: 0.28, height: 0.17, squareness: 4.4, offsetY: 0.72 },
      { z: 6.2, width: 0.16, height: 0.09, squareness: 3.8, offsetY: 0.64 },
    ];
    this.addSolid(loft({ stations: spine, radialSegments: 20, capStart: true, capEnd: true }), GRAPHITE_ZONE);

    const keel: LoftStation[] = [
      { z: -5.4, width: 0.16, height: 0.08, squareness: 4.0, offsetY: -0.5 },
      { z: -3.6, width: 0.32, height: 0.16, squareness: 5.0, offsetY: -0.7 },
      { z: -0.5, width: 0.46, height: 0.2, squareness: 5.4, offsetY: -0.79 },
      { z: 2.6, width: 0.48, height: 0.21, squareness: 5.4, offsetY: -0.8 },
      { z: 5.3, width: 0.34, height: 0.15, squareness: 4.7, offsetY: -0.69 },
      { z: 6.7, width: 0.15, height: 0.07, squareness: 4.0, offsetY: -0.49 },
    ];
    this.addSolid(loft({ stations: keel, radialSegments: 20, capStart: true, capEnd: true }), GRAPHITE_ZONE);

    // Physically separate ceramic cassettes: the closed graphite hull remains visible through
    // deliberate 120–250 mm station gaps and beneath their 55 mm raised side walls.
    const flankSegments: ReadonlyArray<readonly [number, number]> = [
      [-8.2, -6.95], [-6.75, -5.62], [-5.38, -3.78], [-3.55, -2.12],
      [-1.88, 0.48], [0.74, 3.13], [3.38, 5.28], [5.53, 6.76],
    ];
    for (const [z0, z1] of flankSegments) {
      this.addHullCassette(z0, z1, Math.PI * 0.075, Math.PI * 0.365, 14);
      this.addHullCassette(z0, z1, Math.PI * 0.635, Math.PI * 0.925, 14);
    }
    this.addHullCassette(-8.18, -6.92, Math.PI * 0.38, Math.PI * 0.62, 12);
    this.addHullCassette(-6.68, -5.58, Math.PI * 0.37, Math.PI * 0.63, 12);
    for (const [z0, z1] of [[-0.28, 1.55], [1.82, 3.48], [3.76, 5.48]] as const) {
      this.addHullCassette(z0, z1, Math.PI * 0.39, Math.PI * 0.61, 12);
    }

    // Two narrow amber joint keys give the ivory/graphite split a warm focal rhythm.
    for (const side of [1, -1]) {
      this.addBar(
        new THREE.Vector3(side * 1.22, 0.55, -0.08),
        new THREE.Vector3(side * 1.16, 0.56, 3.7),
        0.055,
        8,
        TRIM_ZONE,
      );
    }

    // The closed rear cap is deliberately readable as a shallow service bulkhead, not a hollow
    // oval. Three heat-treated louvers and a small ceramic chevron catch different light levels.
    for (const [y, width] of [[-0.17, 0.52], [0, 0.76], [0.17, 0.52]] as const) {
      this.addSolid(
        new THREE.BoxGeometry(width, 0.052, 0.065, 4, 1, 1),
        HEAT_ZONE,
        new THREE.Vector3(0, y, 7.235),
      );
    }
    this.addSolid(
      new THREE.BoxGeometry(0.34, 0.06, 0.06, 3, 1, 1),
      ARMOR_ZONE,
      new THREE.Vector3(-0.145, 0.08, 7.29),
      new THREE.Euler(0, 0, -0.36),
    );
    this.addSolid(
      new THREE.BoxGeometry(0.34, 0.06, 0.06, 3, 1, 1),
      ARMOR_ZONE,
      new THREE.Vector3(0.145, 0.08, 7.29),
      new THREE.Euler(0, 0, 0.36),
    );
  }

  private buildCanopy(): void {
    const stations: LoftStation[] = [
      { z: -5.4, width: 0.28, height: 0.12, squareness: 3.2, offsetY: 0.47 },
      { z: -4.4, width: 0.61, height: 0.35, squareness: 3.8, offsetY: 0.54 },
      { z: -3.65, width: 0.74, height: 0.45, squareness: 4.2, offsetY: 0.57 },
      { z: -2.9, width: 0.79, height: 0.48, squareness: 4.15, offsetY: 0.6 },
      { z: -1.4, width: 0.73, height: 0.44, squareness: 3.9, offsetY: 0.67 },
      { z: -0.42, width: 0.48, height: 0.27, squareness: 3.5, offsetY: 0.75 },
      { z: -0.1, width: 0.28, height: 0.14, squareness: 3.2, offsetY: 0.79 },
    ];
    this.addCanopy(loft({ stations, radialSegments: 16, capStart: true, capEnd: true }));

    // The glazing now seats into an actual sill, two bows, and a stepped turtledeck instead of
    // floating on the fuselage shader. Faceted six-sided rails stay mechanical rather than tubular.
    for (const side of [1, -1]) {
      this.addBar(
        new THREE.Vector3(side * 0.3, 0.5, -5.28),
        new THREE.Vector3(side * 0.51, 0.74, -4.32),
        0.085,
        6,
        GRAPHITE_ZONE,
      );
      this.addBar(
        new THREE.Vector3(side * 0.51, 0.74, -4.32),
        new THREE.Vector3(side * 0.68, 0.91, -2.82),
        0.09,
        6,
        GRAPHITE_ZONE,
      );
      this.addBar(
        new THREE.Vector3(side * 0.68, 0.91, -2.82),
        new THREE.Vector3(side * 0.42, 0.72, -0.55),
        0.095,
        6,
        GRAPHITE_ZONE,
      );
    }
    this.addBar(new THREE.Vector3(-0.57, 0.81, -4.18), new THREE.Vector3(0.57, 0.81, -4.18), 0.075, 6, GRAPHITE_ZONE);
    this.addBar(new THREE.Vector3(-0.72, 0.94, -1.42), new THREE.Vector3(0.72, 0.94, -1.42), 0.08, 6, GRAPHITE_ZONE);
    this.addBar(new THREE.Vector3(-0.52, 0.91, -4.28), new THREE.Vector3(0.52, 0.91, -4.28), 0.105, 6, ARMOR_ZONE);
    this.addBar(new THREE.Vector3(-0.48, 0.96, -0.4), new THREE.Vector3(0.48, 0.96, -0.4), 0.11, 6, ARMOR_ZONE);

    const turtledeck: LoftStation[] = [
      { z: -0.7, width: 0.38, height: 0.11, squareness: 4.4, offsetY: 0.72 },
      { z: -0.05, width: 0.52, height: 0.18, squareness: 5.0, offsetY: 0.8 },
      { z: 1.2, width: 0.5, height: 0.17, squareness: 5.0, offsetY: 0.82 },
      { z: 2.45, width: 0.28, height: 0.09, squareness: 4.3, offsetY: 0.76 },
    ];
    this.addSolid(loft({ stations: turtledeck, radialSegments: 18, capStart: true, capEnd: true }), GRAPHITE_ZONE);
    const turtleArmor: LoftStation[] = [
      { z: -0.54, width: 0.23, height: 0.06, squareness: 4.2, offsetY: 0.85 },
      { z: 0.05, width: 0.37, height: 0.1, squareness: 5.0, offsetY: 0.91 },
      { z: 1.12, width: 0.35, height: 0.09, squareness: 5.0, offsetY: 0.92 },
      { z: 2.2, width: 0.18, height: 0.045, squareness: 4.2, offsetY: 0.84 },
    ];
    this.addSolid(loft({ stations: turtleArmor, radialSegments: 16, capStart: true, capEnd: true }), ARMOR_ZONE);
  }

  private buildWings(): void {
    for (const side of [1, -1]) {
      this.addSolid(
        buildWing({
          rootChord: 6.4,
          tipChord: 2.1,
          span: 4.6,
          sweep: 2.7,
          dihedral: -0.1 * side * side,
          rootThickness: 0.34,
          tipThickness: 0.12,
          z: 1.6,
          y: -0.16,
          side,
        }),
        GRAPHITE_ZONE,
      );

      // A smaller raised aerofoil leaves a readable graphite root, perimeter, and trailing hinge.
      this.addSolid(
        buildWing({
          rootChord: 5.35,
          tipChord: 1.42,
          span: 3.92,
          sweep: 2.42,
          dihedral: -0.1 * side * side,
          rootThickness: 0.075,
          tipThickness: 0.038,
          z: 1.48,
          y: 0.05,
          side,
        }),
        ARMOR_ZONE,
        new THREE.Vector3(side * 0.35, 0, 0),
      );

      this.addBar(
        new THREE.Vector3(side * 1.0, -0.045, -0.82),
        new THREE.Vector3(side * 4.25, -0.42, 2.92),
        0.075,
        6,
        ARMOR_ZONE,
      );

      // Forward canards: small, high, and swept the other way — the detail that stops the
      // silhouette reading as a generic delta.
      this.addSolid(
        buildWing({
          rootChord: 1.9,
          tipChord: 0.7,
          span: 1.5,
          sweep: 0.75,
          dihedral: 0.22,
          rootThickness: 0.14,
          tipThickness: 0.06,
          z: -5.1,
          y: 0.05,
          side,
        }),
        GRAPHITE_ZONE,
      );
      this.addSolid(
        buildWing({
          rootChord: 1.48,
          tipChord: 0.42,
          span: 1.22,
          sweep: 0.58,
          dihedral: 0.22,
          rootThickness: 0.055,
          tipThickness: 0.025,
          z: -5.08,
          y: 0.145,
          side,
        }),
        ARMOR_ZONE,
        new THREE.Vector3(side * 0.12, 0, 0),
      );

      // Closed wingtip fairings reinforce the chase silhouette without expanding the planform.
      const wingtip: LoftStation[] = [
        { z: 3.16, width: 0.04, height: 0.04, squareness: 3.0 },
        { z: 3.42, width: 0.13, height: 0.1, squareness: 4.0 },
        { z: 4.66, width: 0.145, height: 0.105, squareness: 4.2 },
        { z: 5.26, width: 0.085, height: 0.065, squareness: 3.5 },
        { z: 5.38, width: 0.025, height: 0.02, squareness: 2.8 },
      ];
      this.addSolid(
        loft({ stations: wingtip, radialSegments: 16, capStart: true, capEnd: true }),
        GRAPHITE_ZONE,
        new THREE.Vector3(side * 4.42, -0.57, 0),
      );
      this.addSolid(
        new THREE.TorusGeometry(0.115, 0.035, 8, 20),
        ARMOR_ZONE,
        new THREE.Vector3(side * 4.42, -0.57, 3.55),
      );
    }
  }

  private buildFins(): void {
    for (const side of [1, -1]) {
      const fin = buildWing({
        rootChord: 3.1,
        tipChord: 1.1,
        span: 2.5,
        sweep: 1.5,
        dihedral: 0,
        rootThickness: 0.2,
        tipThickness: 0.08,
        z: 5.0,
        y: 0,
        side,
      });
      const rotation = new THREE.Euler(0, 0, side * (Math.PI / 2 - 0.62));
      const position = new THREE.Vector3(side * 1.0, 0.45, 0);
      // Preserve the approved cant while baking the transform so the pair joins the solid batch.
      this.addSolid(fin, GRAPHITE_ZONE, position, rotation);
      this.addSolid(
        buildWing({
          rootChord: 2.38,
          tipChord: 0.62,
          span: 1.9,
          sweep: 1.18,
          dihedral: 0,
          rootThickness: 0.07,
          tipThickness: 0.028,
          z: 5.08,
          y: 0.15,
          side,
        }),
        ARMOR_ZONE,
        position,
        rotation,
      );
      this.addSolid(
        new THREE.BoxGeometry(0.16, 0.11, 0.56, 2, 1, 3),
        TRIM_ZONE,
        new THREE.Vector3(side * 2.45, 2.48, 6.55),
        new THREE.Euler(0, 0, rotation.z),
      );
    }
  }

  private buildDrivePods(): void {
    for (const side of [1, -1]) {
      const stations: LoftStation[] = [
        { z: -2.6, width: 0.16, height: 0.16, squareness: 3.2 },
        { z: -1.6, width: 0.46, height: 0.44, squareness: 3.6 },
        { z: -0.4, width: 0.59, height: 0.56, squareness: 4.2 },
        { z: 0.6, width: 0.66, height: 0.62, squareness: 4.0 },
        { z: 2.25, width: 0.69, height: 0.65, squareness: 4.5 },
        { z: 4.2, width: 0.68, height: 0.64, squareness: 4.2 },
        { z: 5.45, width: 0.63, height: 0.6, squareness: 4.4 },
        { z: 6.4, width: 0.58, height: 0.56, squareness: 4.0 },
        { z: 7.4, width: 0.62, height: 0.6, squareness: 3.4 },
      ];
      const podPosition = new THREE.Vector3(side * 2.55, -0.14, 0);
      this.addSolid(
        loft({ stations, radialSegments: 32, capStart: true, capEnd: false }),
        GRAPHITE_ZONE,
        podPosition,
      );

      for (const [z0, z1] of [[-1.45, 0.92], [1.18, 4.03], [4.3, 6.18]] as const) {
        this.addCassette(stations, z0, z1, Math.PI * 0.22, Math.PI * 0.78, 16, podPosition);
      }
      this.addCassette(stations, 6.38, 7.08, Math.PI * 0.31, Math.PI * 0.69, 14, podPosition);

      // Three broad vent blades sit only at the hottest upper pod bay; one root access cassette
      // continues that construction logic onto the carry-through without spraying tiny greebles.
      for (let vent = 0; vent < 3; vent++) {
        this.addSolid(
          new THREE.BoxGeometry(0.34, 0.042, 0.14, 3, 1, 1),
          HEAT_ZONE,
          new THREE.Vector3(side * 2.55, 0.565, 2.72 + vent * 0.3),
        );
      }
      this.addSolid(
        new THREE.BoxGeometry(0.28, 0.045, 0.62, 2, 1, 4),
        HEAT_ZONE,
        new THREE.Vector3(side * 1.58, 0.035, 3.5),
      );

      // Pylon linking pod to fuselage.
      this.addSolid(
        buildWing({
          // The main wing carries the forward connection; this shoulder continues aft so the
          // fuselage and pod stay joined through the nozzle deck instead of exposing sky between
          // the main-wing trailing edge and the 7 m tail.
          rootChord: 4.6,
          tipChord: 3.6,
          span: 1.25,
          sweep: 0.2,
          dihedral: 0,
          rootThickness: 0.18,
          tipThickness: 0.14,
          z: 4.6,
          y: -0.14,
          side,
        }),
        GRAPHITE_ZONE,
        new THREE.Vector3(side * 1.25, 0, 0),
      );
      this.addSolid(
        buildWing({
          rootChord: 3.72,
          tipChord: 2.72,
          span: 0.94,
          sweep: 0.16,
          dihedral: 0,
          rootThickness: 0.065,
          tipThickness: 0.052,
          z: 4.55,
          y: 0.045,
          side,
        }),
        ARMOR_ZONE,
        new THREE.Vector3(side * 1.4, 0, 0),
      );

      const nozzleZ = 7.5;
      const nozzle = new THREE.Vector3(side * 2.55, -0.14, nozzleZ);
      this.nozzles.push({ position: nozzle.clone(), radius: 0.58 });

      // Armor lip, heat-treated outer deck, and a genuinely recessed bell replace the flat coin.
      this.addSolid(
        new THREE.CylinderGeometry(0.68, 0.61, 0.42, 32, 3, true),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 7.24),
        new THREE.Euler(Math.PI / 2, 0, 0),
      );
      // The pod skin ends open at z=7.4. This annulus closes its rear perimeter under the
      // shroud while preserving a real 1 m aperture through to the bell and compact core.
      this.addSolid(
        new THREE.RingGeometry(0.5, 0.62, 40),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 7.405),
      );
      this.addSolid(
        new THREE.TorusGeometry(0.59, 0.105, 12, 48),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 7.48),
      );
      this.addSolid(
        new THREE.CylinderGeometry(0.49, 0.31, 0.5, 32, 4, true),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 7.2),
        new THREE.Euler(Math.PI / 2, 0, 0),
      );
      this.addSolid(
        new THREE.TorusGeometry(0.37, 0.038, 8, 36),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 7.16),
      );
      this.addSolid(
        new THREE.CylinderGeometry(0.3, 0.19, 0.32, 32, 2, true),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 6.98),
        new THREE.Euler(Math.PI / 2, 0, 0),
      );
      this.addSolid(
        new THREE.RingGeometry(0.195, 0.305, 32),
        HEAT_ZONE,
        new THREE.Vector3(nozzle.x, nozzle.y, 6.815),
      );
      for (let vane = 0; vane < 4; vane++) {
        const angle = vane * Math.PI * 0.5 + Math.PI * 0.25;
        this.addSolid(
          new THREE.BoxGeometry(0.16, 0.038, 0.075, 2, 1, 1),
          HEAT_ZONE,
          new THREE.Vector3(
            nozzle.x + Math.cos(angle) * 0.4,
            nozzle.y + Math.sin(angle) * 0.4,
            7.31,
          ),
          new THREE.Euler(0, 0, angle),
        );
      }

      this.addGlow(new THREE.CircleGeometry(0.14, 32), new THREE.Vector3(nozzle.x, nozzle.y, 6.67));
      this.addGlow(new THREE.RingGeometry(0.153, 0.18, 32), new THREE.Vector3(nozzle.x, nozzle.y, 6.685));

      // A short tapered shell is stable from both axial and side views. Its maximum length stays
      // in front of the chase camera's near plane, so perspective cannot inflate it into a pair
      // of screen-corner triangles. UV.y remains 1 at the nozzle and 0 at the tail.
      const plumeGeo = new THREE.CylinderGeometry(0.38, 0.012, 1, 16, 1, true);
      plumeGeo.rotateX(-Math.PI / 2);
      plumeGeo.translate(0, 0, 0.5);
      this.addPlume(plumeGeo, nozzle);
    }
  }

  private addHullCassette(z0: number, z1: number, angle0: number, angle1: number, arcSegments: number): void {
    this.addCassette([...HULL_STATIONS], z0, z1, angle0, angle1, arcSegments);
  }

  /** Builds a closed raised shell segment, including inner skin and all four edge walls. */
  private addCassette(
    source: readonly LoftStation[],
    z0: number,
    z1: number,
    angle0: number,
    angle1: number,
    arcSegments: number,
    position = new THREE.Vector3(),
  ): void {
    const zSegments = Math.max(2, Math.ceil((z1 - z0) / 0.5));
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const stride = arcSegments + 1;
    const layerStride = (zSegments + 1) * stride;

    for (const offset of [0.075, 0.018]) {
      for (let zi = 0; zi <= zSegments; zi++) {
        const z = THREE.MathUtils.lerp(z0, z1, zi / zSegments);
        const station = this.stationAt(source, z);
        for (let ai = 0; ai <= arcSegments; ai++) {
          const angle = THREE.MathUtils.lerp(angle0, angle1, ai / arcSegments);
          const point = this.sectionPoint(station, angle, offset);
          positions.push(point.x, point.y, point.z);
          uvs.push(ai / arcSegments, zi / zSegments);
        }
      }
    }

    for (let zi = 0; zi < zSegments; zi++) {
      for (let ai = 0; ai < arcSegments; ai++) {
        const outer = zi * stride + ai;
        const outerNext = outer + stride;
        indices.push(outer, outer + 1, outerNext, outer + 1, outerNext + 1, outerNext);
        const inner = layerStride + outer;
        const innerNext = inner + stride;
        indices.push(inner, innerNext, inner + 1, inner + 1, innerNext, innerNext + 1);
      }
    }

    // Forward/rear thickness walls.
    for (let ai = 0; ai < arcSegments; ai++) {
      const frontOuter = ai;
      const frontInner = layerStride + ai;
      indices.push(frontOuter, frontInner, frontOuter + 1, frontOuter + 1, frontInner, frontInner + 1);
      const rearOuter = zSegments * stride + ai;
      const rearInner = layerStride + rearOuter;
      indices.push(rearOuter, rearOuter + 1, rearInner, rearOuter + 1, rearInner + 1, rearInner);
    }

    // Angular side walls.
    for (let zi = 0; zi < zSegments; zi++) {
      const startOuter = zi * stride;
      const startNext = startOuter + stride;
      const startInner = layerStride + startOuter;
      const startInnerNext = startInner + stride;
      indices.push(startOuter, startNext, startInner, startNext, startInnerNext, startInner);

      const endOuter = zi * stride + arcSegments;
      const endNext = endOuter + stride;
      const endInner = layerStride + endOuter;
      const endInnerNext = endInner + stride;
      indices.push(endOuter, endInner, endNext, endNext, endInner, endInnerNext);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.addSolid(geometry, ARMOR_ZONE, position);
  }

  private stationAt(source: readonly LoftStation[], z: number): LoftStation {
    let upper = 1;
    while (upper < source.length && source[upper].z < z) upper++;
    const b = source[Math.min(upper, source.length - 1)];
    const a = source[Math.max(0, upper - 1)];
    const t = a.z === b.z ? 0 : THREE.MathUtils.clamp((z - a.z) / (b.z - a.z), 0, 1);
    return {
      z,
      width: THREE.MathUtils.lerp(a.width, b.width, t),
      height: THREE.MathUtils.lerp(a.height, b.height, t),
      squareness: THREE.MathUtils.lerp(a.squareness, b.squareness, t),
      offsetY: THREE.MathUtils.lerp(a.offsetY ?? 0, b.offsetY ?? 0, t),
      bottomScale: THREE.MathUtils.lerp(a.bottomScale ?? 1, b.bottomScale ?? 1, t),
    };
  }

  private sectionPoint(station: LoftStation, angle: number, offset: number): THREE.Vector3 {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const exponent = 2 / station.squareness;
    const x = Math.sign(cosine) * Math.pow(Math.abs(cosine), exponent) * (station.width + offset);
    let y = Math.sign(sine) * Math.pow(Math.abs(sine), exponent) * (station.height + offset);
    if (y < 0) y *= station.bottomScale ?? 1;
    return new THREE.Vector3(x, y + (station.offsetY ?? 0), station.z);
  }

  private addBar(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    segments: number,
    zone: SurfaceZone,
  ): void {
    const delta = new THREE.Vector3().subVectors(to, from);
    const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const rotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      delta.clone().normalize(),
    );
    const geometry = new THREE.CylinderGeometry(radius * 0.84, radius, delta.length(), segments, 2, false);
    geometry.applyMatrix4(new THREE.Matrix4().compose(centre, rotation, new THREE.Vector3(1, 1, 1)));
    this.addSolid(geometry, zone);
  }

  /**
   * @param power  0..1 drive output
   * @param boost  0..1 overdrive blend
   */
  update(time: number, cameraPosition: THREE.Vector3, power: number, boost: number, damage: number): void {
    this.hullMat.uniforms.uTime.value = time;
    this.hullMat.uniforms.uCameraPos.value.copy(cameraPosition);
    this.hullMat.uniforms.uDamage.value = Number.isFinite(damage)
      ? THREE.MathUtils.clamp(damage, 0, 1)
      : 0;
    this.canopyMat.uniforms.uTime.value = time;
    this.canopyMat.uniforms.uCameraPos.value.copy(cameraPosition);

    const safePower = Number.isFinite(power) ? THREE.MathUtils.clamp(power, 0, 1) : 0;
    const safeBoost = Number.isFinite(boost) ? THREE.MathUtils.clamp(boost, 0, 1) : 0;
    const length = 3.4 + safePower * 0.4 + safeBoost * 0.2;
    const width = 0.95 + safePower * 0.15 + safeBoost * 0.25;
    this.plumeMat.uniforms.uPower.value = Math.max(0.05, safePower * 0.55 + safeBoost * 0.45);
    this.plumeMat.uniforms.uLength.value = length * (0.96 + Math.sin(time * 31 + this.plumeMat.id) * 0.04);
    this.plumeMat.uniforms.uWidth.value = width;
    this.plumeMat.uniforms.uTime.value = time;
    this.plumeMat.uniforms.uCore.value.lerpColors(this.idleCore, this.boostCore, safeBoost);
    this.glowMat.uniforms.uPower.value = 0.38 + safePower * 0.3 + safeBoost * 0.35;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.hullMat.dispose();
    this.canopyMat.dispose();
    this.glowMat.dispose();
    this.plumeMat.dispose();
  }
}
