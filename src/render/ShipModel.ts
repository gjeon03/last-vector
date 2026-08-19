import * as THREE from 'three';
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
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    vLocalNormal = normal;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const HULL_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vLocalNormal;

  uniform vec3 uCameraPos;
  uniform vec3 uBase;
  uniform vec3 uPanel;
  uniform vec3 uTrim;
  uniform vec3 uEmissive;
  uniform float uEmissiveStrength;
  uniform float uDamage;
  uniform float uTime;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  // Triplanar panel seams: the grid follows the surface instead of smearing across it.
  float seams(vec3 p, vec3 n, float scale, float width) {
    vec3 w = abs(n);
    w = w / max(w.x + w.y + w.z, 1e-4);
    vec2 px = p.yz * scale;
    vec2 py = p.xz * scale;
    vec2 pz = p.xy * scale;
    vec2 gx = abs(fract(px) - 0.5);
    vec2 gy = abs(fract(py) - 0.5);
    vec2 gz = abs(fract(pz) - 0.5);
    float lx = 1.0 - smoothstep(0.0, width, min(gx.x, gx.y));
    float ly = 1.0 - smoothstep(0.0, width, min(gy.x, gy.y));
    float lz = 1.0 - smoothstep(0.0, width, min(gz.x, gz.y));
    return lx * w.x + ly * w.y + lz * w.z;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    // Two seam frequencies: big structural panels, then small access hatches.
    float bigSeam = seams(vLocal, normalize(vLocalNormal), 0.34, 0.045);
    float fineSeam = seams(vLocal + 13.0, normalize(vLocalNormal), 1.15, 0.06);
    float seam = clamp(bigSeam * 0.9 + fineSeam * 0.35, 0.0, 1.0);

    // Ivory panels over a dark structural base. The split favours upper surfaces but wraps
    // onto the flanks, so the ship still reads as painted when seen from directly astern.
    float upper = smoothstep(-0.25, 0.45, normalize(vLocalNormal).y);
    float paint = upper * smoothstep(0.28, 0.7, fbm(vLocal * 0.55, 3) * 0.5 + 0.78);
    vec3 albedo = mix(uBase, uPanel, paint * 0.85);

    // Warning stripe along the spine and the wing leading edges.
    float stripe = smoothstep(0.06, 0.0, abs(abs(vLocal.x) - 1.72)) * smoothstep(-1.0, 3.0, vLocal.z);
    albedo = mix(albedo, uTrim, stripe * 0.8);

    albedo = mix(albedo, albedo * 0.28, seam * 0.78);

    // Plate-to-plate variation. A hull built from separately fitted panels never has two
    // adjacent plates at the same value or the same finish, and that difference is most of what
    // reads as "machine" rather than "maquette". The material measured at 0.13 saturation and a
    // single tone: it had seams and paint but every plate inside them was identical.
    // The per-plate value hash lived here and is gone.
    //
    // It was an unfiltered nearest-neighbour hash on an axis-aligned cube lattice at scales 1.6
    // and 4.2, against seam scales of 0.34 and 1.15 — ratios of 4.70 and 3.65, so its value steps
    // landed mid-panel rather than on seam lines, and with no fwidth guard on the floor() it read
    // as a hard-edged rectangular tile mosaic at 1:1 in the chase camera, which is on screen for
    // 100% of gameplay. Two reviewers filed it independently as a corrupt-texture artefact.
    //
    // It also delivered none of what it was added for: measured by patching the served shader in
    // flight, the plate term contributes 0.006-0.009 saturation and 0.001-0.007 sd. The R10 gain
    // came entirely from removing the view-aligned hero fill. My own note at the time — that the
    // frequency change was "NOT distinguishable in the aggregate" — was the tell, and I wrote it
    // down and shipped the term anyway: an aggregate statistic cannot see a hard-edged local
    // mosaic, and nobody looked at a magnified crop with grain off.
    float wear = smoothstep(0.55, 0.95, fbm(vLocal * 2.2 + 7.0, 4) * 0.5 + 0.5);
    albedo = mix(albedo, uBase * 0.55, wear * 0.35);

    float roughness = clamp(0.34 + seam * 0.32 + wear * 0.24, 0.12, 0.95);
    float metalness = mix(0.52, 0.22, paint);
    float ao = 1.0 - seam * 0.45;

    vec3 color = shadeSurface(N, V, albedo, roughness, metalness, ao);

    // There was a view-aligned hero fill here, adding albedo * uFill * (0.25 + fill * 0.75) so
    // the hull would not go to pure silhouette when the star is ahead. It is a
    // constant term across every visible surface, which is the definition of flattening: it
    // raised the floor and desaturated everything at once. Screen-space occlusion and the
    // directionally-gated rim now carry form on the unlit side, so the crutch is removed.

    // Running lights: thin channels down the flanks and a chevron on the nose.
    float channel = smoothstep(0.035, 0.0, abs(abs(vLocal.x) - 1.32)) * smoothstep(-6.0, -1.0, vLocal.z);
    float chevron = smoothstep(0.09, 0.0, abs(vLocal.z + 6.4 + abs(vLocal.x) * 0.55));
    float glow = max(channel, chevron * 0.85);
    color += uEmissive * glow * uEmissiveStrength * (0.75 + 0.25 * sin(uTime * 3.1));

    if (uDamage > 0.001) {
      float scorch = smoothstep(0.6, 1.0, fbm(vLocal * 3.4 + 21.0, 4) * 0.5 + 0.5);
      color = mix(color, color * 0.25, scorch * uDamage);
      color += vec3(1.0, 0.35, 0.08) * scorch * uDamage * 0.6 * (0.5 + 0.5 * sin(uTime * 11.0));
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
    vec3 color = uGlass * 0.06;
    color += shadeSurface(N, V, uGlass, 0.06, 1.0, 1.0) * 0.85;
    color += vec3(0.55, 0.78, 1.0) * fres * 0.5;
    color += uInterior * (0.18 + 0.06 * sin(uTime * 2.3)) * (1.0 - fres);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const PLUME_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocal;
  uniform float uLength;
  uniform float uWidth;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.xy *= uWidth;
    p.z *= uLength;
    vLocal = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const PLUME_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vLocal;
  uniform vec3 uCore;
  uniform vec3 uFlame;
  uniform float uPower;
  uniform float uTime;

  ${GLSL_NOISE}

  void main() {
    /* vUv.y runs 1 at the NOZZLE and 0 at the tail — the opposite of what this comment used to
     * claim, and every term below was written against the claim rather than the geometry.
     *
     * Measured, not argued. three's CylinderGeometry emits uv.y as 1 - v with v = 0 at
     * radiusTop, so the narrow end carries uv.y = 1; rotateX(-PI/2) then translate(0,0,0.5)
     * puts that narrow end at local z = 0, which is the nozzle. Reading the built attribute back
     * confirms it exactly: (z=0, radius=0.10, v=1) and (z=1, radius=0.52, v=0).
     *
     * With t = vUv.y the consequences were total, not subtle: body = pow(1-t, 1.7) evaluated to
     * 0.000 at the nozzle and 1.000 at the tail, so the drive was fully transparent exactly where
     * it should burn, and the white-hot uCore was painted on the far end where only the cool
     * uFlame belongs. At full boost the ship showed two nozzle-throat discs and no flame — the
     * plume cone was there, dense, four metres behind where anyone would look for it. This is the
     * most-looked-at surface in the game; it is on screen for the whole run.
     */
    float t = clamp(1.0 - vUv.y, 0.0, 1.0);
    float radial = abs(vUv.x - 0.5) * 2.0;

    // Shock diamonds: periodic brightening along the plume, drifting outward.
    float diamonds = 0.55 + 0.45 * sin(t * 34.0 - uTime * 22.0);
    float turb = fbm(vec3(vLocal.xy * 3.4, t * 6.0 - uTime * 5.0), 3) * 0.5 + 0.5;

    float body = pow(1.0 - t, 1.7);
    float edge = 1.0 - smoothstep(0.25, 1.0, radial);
    float density = body * edge * (0.55 + turb * 0.55) * mix(1.0, diamonds, 0.45);

    vec3 col = mix(uFlame, uCore, pow(1.0 - t, 2.4) * (1.0 - radial * 0.55));
    col *= density * uPower * 2.6;

    gl_FragColor = vec4(col, clamp(density * uPower, 0.0, 1.0));
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

export class ShipModel {
  readonly object = new THREE.Group();
  /** Nozzle anchors in ship-local space, for trails and audio panning. */
  readonly nozzles: ShipNozzle[] = [];

  private readonly hullMat: THREE.ShaderMaterial;
  private readonly canopyMat: THREE.ShaderMaterial;
  private readonly plumeMats: THREE.ShaderMaterial[] = [];
  private readonly plumeMeshes: THREE.Mesh[] = [];
  private readonly glowMeshes: THREE.Mesh[] = [];
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(options: ShipVisualOptions) {
    this.hullMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(0x27313f) },
        uPanel: { value: new THREE.Color(0xcdbd9c) },
        uTrim: { value: new THREE.Color(PALETTE.starRim).multiplyScalar(0.55) },
        uEmissive: { value: new THREE.Color(PALETTE.engineCore) },
        uEmissiveStrength: { value: 1.5 },
        uDamage: { value: 0 },
        uTime: { value: 0 },
      }),
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
    });

    this.canopyMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uGlass: { value: new THREE.Color(0x1a2a38) },
        uInterior: { value: new THREE.Color(0x39d7ff) },
        uTime: { value: 0 },
      }),
      vertexShader: HULL_VERT,
      fragmentShader: CANOPY_FRAG,
    });

    this.glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.engineCore) },
        uFlame: { value: new THREE.Color(PALETTE.engineFlame) },
        uPower: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vNormal;
        varying vec3 vView;
        uniform vec3 uColor;
        uniform vec3 uFlame;
        uniform float uPower;
        void main() {
          // Two lobes, and deliberately landing under 1.0 before the tonemap so the bloom
          // chain carries the brightness instead of the disc clipping to flat white. A clipped
          // emissive has no shape, so it reads as a hole rather than as a light source — and it
          // throws away the cyan machine-light the whole direction is built on.
          float facing = max(dot(normalize(vNormal), normalize(vView)), 0.0);
          float core = pow(facing, 3.5);
          float halo = pow(facing, 1.1);
          vec3 col = mix(uFlame, uColor, core) * (halo * 0.55 + core * 0.85);
          gl_FragColor = vec4(col * uPower, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.buildFuselage();
    this.buildCanopy();
    this.buildWings();
    this.buildFins();
    this.buildDrivePods();
  }

  private add(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    this.object.add(mesh);
    return mesh;
  }

  private buildFuselage(): void {
    const stations: LoftStation[] = [
      { z: -9.0, width: 0.06, height: 0.05, squareness: 2.2, offsetY: -0.12 },
      { z: -8.3, width: 0.34, height: 0.24, squareness: 2.6, offsetY: -0.14, bottomScale: 0.86 },
      { z: -6.8, width: 0.72, height: 0.46, squareness: 3.0, offsetY: -0.12, bottomScale: 0.82 },
      { z: -4.6, width: 1.08, height: 0.7, squareness: 3.4, offsetY: -0.06, bottomScale: 0.82 },
      { z: -2.0, width: 1.42, height: 0.9, squareness: 3.9, bottomScale: 0.86 },
      { z: 0.8, width: 1.6, height: 0.98, squareness: 4.1, bottomScale: 0.88 },
      { z: 3.4, width: 1.5, height: 0.9, squareness: 3.8, bottomScale: 0.92 },
      { z: 5.6, width: 1.16, height: 0.72, squareness: 3.3, bottomScale: 0.96 },
      { z: 6.9, width: 0.92, height: 0.58, squareness: 3.0 },
      { z: 7.2, width: 0.6, height: 0.4, squareness: 2.8 },
    ];
    this.add(loft({ stations, radialSegments: 28, capStart: true, capEnd: true }), this.hullMat);

    // Dorsal spine: a raised structural fairing that breaks up the top surface.
    const spine: LoftStation[] = [
      { z: -3.2, width: 0.22, height: 0.1, squareness: 4.0, offsetY: 0.72 },
      { z: -0.5, width: 0.42, height: 0.26, squareness: 5.0, offsetY: 0.86 },
      { z: 3.0, width: 0.4, height: 0.24, squareness: 5.0, offsetY: 0.82 },
      { z: 6.0, width: 0.2, height: 0.12, squareness: 4.0, offsetY: 0.66 },
    ];
    this.add(loft({ stations: spine, radialSegments: 14, capStart: true, capEnd: true }), this.hullMat);
  }

  private buildCanopy(): void {
    const stations: LoftStation[] = [
      { z: -5.4, width: 0.28, height: 0.1, squareness: 3.0, offsetY: 0.42 },
      { z: -4.4, width: 0.6, height: 0.3, squareness: 3.4, offsetY: 0.48 },
      { z: -2.9, width: 0.78, height: 0.42, squareness: 3.6, offsetY: 0.54 },
      { z: -1.4, width: 0.72, height: 0.38, squareness: 3.4, offsetY: 0.6 },
      { z: -0.5, width: 0.42, height: 0.2, squareness: 3.0, offsetY: 0.62 },
    ];
    const canopy = this.add(loft({ stations, radialSegments: 18, capStart: true, capEnd: true }), this.canopyMat);
    canopy.renderOrder = 1;
  }

  private buildWings(): void {
    for (const side of [1, -1]) {
      this.add(
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
        this.hullMat,
      );

      // Forward canards: small, high, and swept the other way — the detail that stops the
      // silhouette reading as a generic delta.
      this.add(
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
        this.hullMat,
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
        side: 1,
      });
      // Cant the fins outward and up: 35 degrees reads as a real tail from behind.
      const mesh = this.add(fin, this.hullMat);
      mesh.rotation.z = side * (Math.PI / 2 - 0.62);
      mesh.position.set(side * 1.0, 0.45, 0);
    }
  }

  private buildDrivePods(): void {
    for (const side of [1, -1]) {
      const stations: LoftStation[] = [
        { z: -2.6, width: 0.16, height: 0.16, squareness: 3.2 },
        { z: -1.6, width: 0.46, height: 0.44, squareness: 3.6 },
        { z: 0.6, width: 0.66, height: 0.62, squareness: 4.0 },
        { z: 4.2, width: 0.68, height: 0.64, squareness: 4.2 },
        { z: 6.4, width: 0.58, height: 0.56, squareness: 4.0 },
        { z: 7.4, width: 0.62, height: 0.6, squareness: 3.4 },
      ];
      const pod = this.add(loft({ stations, radialSegments: 22, capStart: true }), this.hullMat);
      pod.position.set(side * 2.55, -0.14, 0);

      // Pylon linking pod to fuselage.
      const pylon = this.add(
        buildWing({
          rootChord: 3.0,
          tipChord: 2.4,
          span: 1.25,
          sweep: 0.3,
          dihedral: 0,
          rootThickness: 0.18,
          tipThickness: 0.14,
          z: 1.4,
          y: -0.14,
          side,
        }),
        this.hullMat,
      );
      pylon.position.set(side * 1.25, 0, 0);

      const nozzleZ = 7.5;
      this.nozzles.push({ position: new THREE.Vector3(side * 2.55, -0.14, nozzleZ), radius: 0.58 });

      // Nozzle throat: a bright disc that stays visible even at idle.
      // Sized to sit inside the nozzle throat. Any larger and the bloom swallows the pod.
      const glowGeo = new THREE.CircleGeometry(0.42, 24);
      const glow = this.add(glowGeo, this.glowMat);
      glow.position.set(side * 2.55, -0.14, nozzleZ + 0.02);
      glow.renderOrder = 3;
      this.glowMeshes.push(glow);

      // Plume: a cone opening backwards from the nozzle.
      const plumeGeo = new THREE.CylinderGeometry(0.1, 0.52, 1, 20, 1, true);
      plumeGeo.rotateX(-Math.PI / 2);
      plumeGeo.translate(0, 0, 0.5);
      const plumeMat = new THREE.ShaderMaterial({
        uniforms: {
          uCore: { value: new THREE.Color(PALETTE.engineBoost) },
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
      this.geometries.push(plumeGeo);
      const plume = new THREE.Mesh(plumeGeo, plumeMat);
      plume.position.set(side * 2.55, -0.14, nozzleZ);
      plume.renderOrder = 4;
      plume.frustumCulled = false;
      this.object.add(plume);
      this.plumeMats.push(plumeMat);
      this.plumeMeshes.push(plume);
    }
  }

  /**
   * @param power  0..1 drive output
   * @param boost  0..1 overdrive blend
   */
  update(time: number, cameraPosition: THREE.Vector3, power: number, boost: number, damage: number): void {
    this.hullMat.uniforms.uTime.value = time;
    this.hullMat.uniforms.uCameraPos.value.copy(cameraPosition);
    this.hullMat.uniforms.uDamage.value = damage;
    this.canopyMat.uniforms.uTime.value = time;
    this.canopyMat.uniforms.uCameraPos.value.copy(cameraPosition);

    const length = 3.0 + power * 6.2 + boost * 13;
    const width = 0.78 + power * 0.2 + boost * 0.42;
    for (const mat of this.plumeMats) {
      mat.uniforms.uPower.value = Math.max(0.05, power * 0.55 + boost * 0.45);
      mat.uniforms.uLength.value = length * (0.94 + Math.sin(time * 31 + mat.id) * 0.06);
      mat.uniforms.uWidth.value = width;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uCore.value.lerpColors(
        new THREE.Color(PALETTE.engineCore),
        new THREE.Color(PALETTE.engineBoost),
        boost,
      );
    }
    this.glowMat.uniforms.uPower.value = 0.55 + power * 0.5 + boost * 0.7;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.hullMat.dispose();
    this.canopyMat.dispose();
    this.glowMat.dispose();
    for (const m of this.plumeMats) m.dispose();
    this.plumeMeshes.length = 0;
    this.glowMeshes.length = 0;
  }
}
