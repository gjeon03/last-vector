import * as THREE from 'three';
import { loft, type LoftStation } from './loft.ts';
import { GLSL_NOISE } from './glslNoise.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { Rng } from '../core/rng.ts';
import { clamp01 } from '../core/mathx.ts';
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
      // Inverse transpose, because 260 of these instances carry non-uniform scale to 4:1.
      // Shading them with the instance matrix itself put the median normal error at 21.0 degrees
      // (p95 44.8), with 17.6% of surface samples wrong by more than 0.2 in N.L — which is why
      // the greeble field read as incoherent light rather than as a lit surface.
      mat3 im = mat3(instanceMatrix);
      mat3 instanceNormalMatrix = mat3(
        cross(im[1], im[2]),
        cross(im[2], im[0]),
        cross(im[0], im[1])
      );
      vNormal = normalize(mat3(modelMatrix) * instanceNormalMatrix * normal);
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

    // Triplanar-ish breakup at a second frequency plus a darkened crease along every plate
    // edge. At 230 m the hull previously showed two flat values and one bevel strip, and a
    // surface with no detail gradient has no readable size.
    float grain = fbm(vLocal * 0.11 + 5.0, 3) * 0.5 + 0.5;
    albedo *= 0.72 + grain * 0.5;
    float crease = smoothstep(0.35, 0.0, min(min(g.x, g.y), g.z));
    albedo *= 1.0 - crease * 0.34;

    float roughness = clamp(0.42 + plate * 0.34 + seam * 0.2 + grain * 0.16, 0.12, 0.95);
    vec3 color = shadeSurface(N, V, albedo, roughness, 0.72, (1.0 - seam * 0.3) * (1.0 - crease * 0.45));

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

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos), V), 1.0);
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
    // Floor after the scale: see Gate.ts. gl_PointSize is in framebuffer pixels, so applying it
    // before the multiply lets the approach lights fall below their own stated minimum.
    gl_PointSize = max(900.0 / max(dist, 1.0) * uPixelScale, 2.0);
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
  /** Radians of arc. Less than a full turn produces a broken fragment. */
  arc = Math.PI * 2,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const n = 2 / squareness;
  const partial = arc < Math.PI * 2 - 1e-4;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = t * arc;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // A fragment tapers to nothing at both broken ends, which closes the surface without a
    // cap and reads as a shear rather than a sawn-off tube.
    // Full section for almost the whole arc, then a fast shear at each broken end. A slow
    // taper reads as a deflated tube rather than as something that was torn apart.
    const taper = partial ? Math.min(1, Math.sin(Math.PI * t) * 9.0) : 1;
    // Frame: outward is radial, axial is the ring's own normal.
    for (let j = 0; j <= sides; j++) {
      const b = (j / sides) * Math.PI * 2;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const r = Math.sign(cb) * Math.pow(Math.abs(cb), n) * halfRadial * taper;
      const z = Math.sign(sb) * Math.pow(Math.abs(sb), n) * halfAxial * taper;
      const rr = radius + r;
      positions.push(ca * rr, sa * rr, z);
      uvs.push(t, j / sides);
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

/**
 * A station on the meridian of a surface of revolution, in (radius, axial) metres.
 */
interface ShellStation {
  r: number;
  /** Along the axis. Negative is toward the arriving pilot. */
  z: number;
  /**
   * How much of the angular lobe this station takes, 0..1. Held at zero across the bore so the
   * hole the player flies through stays a true circle whatever the outside is doing, and taken
   * in full at the rim, where a perfectly circular outline is the thing that made a
   * two-kilometre structure read as a decal.
   */
  lobe?: number;
}

/**
 * Breaks the rotational symmetry of a revolved shell. Three low harmonics rather than noise:
 * noise at this scale reads as a wobbly edge, whereas a small number of large lobes reads as
 * a plan that someone drew.
 */
function lobeRadial(angle: number): number {
  return (
    0.058 * Math.sin(angle * 3 + 1.13) +
    0.027 * Math.sin(angle * 7 - 0.61) +
    0.014 * Math.sin(angle * 11 + 2.2)
  );
}

/** Axial warp, metres. Lifts and drops the terraces so no deck is a flat plane. */
function lobeAxial(angle: number): number {
  return 46 * Math.sin(angle * 3 - 0.42) + 21 * Math.sin(angle * 5 + 1.7);
}

/**
 * Revolves a closed meridian around the local Z axis.
 *
 * One flat-shaded band per meridian edge, with its own vertices, so every crease between a
 * deck and a riser stays hard. A shared-vertex revolve run through computeVertexNormals
 * averages the deck normal into the riser normal, and a step whose corner is smoothed away is
 * not a step: it is a gradient, and it reads as one.
 *
 * A straight meridian edge revolves to an exact cone, so per-band averaging is not an
 * approximation here — it is the true normal.
 */
function revolveShell(meridian: ShellStation[], segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const stride = segments + 1;
  const bands = meridian.length - 1;

  for (let b = 0; b < bands; b++) {
    const base = positions.length / 3;
    for (const station of [meridian[b], meridian[b + 1]]) {
      const w = station.lobe ?? 1;
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const r = station.r * (1 + w * lobeRadial(a));
        positions.push(Math.cos(a) * r, Math.sin(a) * r, station.z + w * lobeAxial(a));
        uvs.push(i / segments, b / bands);
      }
    }
    for (let i = 0; i < segments; i++) {
      const a0 = base + i;
      const a1 = a0 + 1;
      const b0 = base + stride + i;
      const b1 = b0 + 1;
      indices.push(a0, a1, b0, b0, a1, b1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * THE MERIDIAN OF VESPER TERMINUS, approach face first.
 *
 * The shape of this table is the whole fix, so it is worth saying why it is shaped this way.
 *
 * The terminus is met head-on, and the star sits about 27 degrees off the approach axis on the
 * FAR side of it — so the face the player sees is a good 27 degrees past its own terminator.
 * With the shared wrapped-diffuse model, a surface square to the approach receives exactly
 * zero key light, and it keeps receiving zero however far forward or back you move it: the
 * renderer has no shadow maps, so depth alone casts nothing. Stacking three flat annuli at
 * three different Z values therefore changes nothing that can be measured.
 *
 * What does receive light is TILT. Direct light appears at about 45 degrees off face-on and
 * the product of lit-ness and visible area peaks near 70. So the approach face is built as a
 * terraced cone: wide decks joined by risers pitched 62-75 degrees off face-on, which catch
 * the key on the sunward side of the ring and receive nothing at all on the other side. That
 * is the directional read, and it comes from geometry rather than from staging.
 *
 * The bore runs the other way — it flares open toward the pilot — so the inside of the funnel
 * is lit on the side opposite the terraces. A lit crater inside a lit mesa is how a real
 * object of this size behaves, and it gives the eye two independent depth cues.
 */
const TERMINUS_FRONT: ShellStation[] = [
  { r: 520, z: -880, lobe: 0 }, //  funnel mouth lip, the closest point to the pilot
  { r: 596, z: -820, lobe: 0 }, //  mouth chamfer
  { r: 660, z: -590, lobe: 0.15 }, //  collar wall     75 deg off face-on
  { r: 722, z: -556, lobe: 0.25 }, //  terrace 1 deck
  { r: 794, z: -330, lobe: 0.45 }, //  riser 1         72 deg
  { r: 932, z: -300, lobe: 0.6 }, //   terrace 2 deck
  { r: 1004, z: -110, lobe: 0.8 }, //  riser 2         69 deg
  { r: 1132, z: -84, lobe: 0.92 }, //  terrace 3 deck
  { r: 1200, z: 34, lobe: 1 }, //      riser 3         60 deg
  { r: 1274, z: 62, lobe: 1 }, //      outer lip
];

const TERMINUS_BACK: ShellStation[] = [
  { r: 1294, z: 172, lobe: 1 }, //     outer flank: the silhouette's thickness
  { r: 1212, z: 286, lobe: 1 },
  { r: 982, z: 324, lobe: 0.75 }, //   underside, in permanent shadow
  { r: 700, z: 302, lobe: 0.4 },
  { r: 521, z: 248, lobe: 0.1 },
  { r: 434, z: 302, lobe: 0 }, //      rear bore lip
  { r: 400, z: 250, lobe: 0 },
  { r: 400, z: -84, lobe: 0 }, //      throat: the narrowest part of the hole
  { r: 440, z: -560, lobe: 0 }, //     funnel wall, opening toward the pilot
  { r: 520, z: -880, lobe: 0 }, //     closes on the first station
];

/** The rear deck, radius-ascending, for anything that has to sit on the underside. */
const TERMINUS_REAR: ShellStation[] = [
  { r: 521, z: 248, lobe: 0.1 },
  { r: 700, z: 302, lobe: 0.4 },
  { r: 982, z: 324, lobe: 0.75 },
  { r: 1212, z: 286, lobe: 1 },
];

/**
 * Where a face of the shell sits at a given radius and bearing, so ridges, masts and greebles
 * can be planted ON the terraces instead of floating in the plane the terraces used to be.
 * `profile` must be radius-ascending.
 */
function surfaceOn(
  profile: ShellStation[],
  radius: number,
  angle: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  let i = 0;
  while (i < profile.length - 2 && profile[i + 1].r < radius) i++;
  const a = profile[i];
  const b = profile[i + 1];
  const t = clamp01((radius - a.r) / (b.r - a.r));
  const lobe = (a.lobe ?? 1) + ((b.lobe ?? 1) - (a.lobe ?? 1)) * t;
  const r = radius * (1 + lobe * lobeRadial(angle));
  return out.set(
    Math.cos(angle) * r,
    Math.sin(angle) * r,
    a.z + (b.z - a.z) * t + lobe * lobeAxial(angle),
  );
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
    // The aperture is the thing the player is aiming at from four kilometres out, so it is
    // deliberately the brightest object in the sector after the star itself.
    // The old 4.2 was set when the collar buried all but the dim outer edge of this tube, so
    // what shipped was an eighth of what the number says. Against the rebuilt bore the whole
    // section is exposed, and at 4.2 it clipped to white and bloomed into a 200 px plate that
    // erased the terraces behind it: the aperture region measured 0.70 mean against 0.27 for
    // the version this replaces.
    float glow = 1.1 + a * 2.6 + b * 1.2;
    gl_FragColor = vec4(uColor * core * glow * 1.5, core * min(glow, 1.0) * 0.95);
  }
`;

export interface TerminusOptions {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  lighting: LightingUniforms;
  seed: number;
  apertureRadius?: number;
  palette?: {
    hullBase: number;
    hullAccent: number;
    window: number;
    aperture: number;
  };
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
  readonly apertureRadius: number;
  readonly position: THREE.Vector3;
  readonly normal: THREE.Vector3;

  private readonly hullMat: THREE.ShaderMaterial;
  private readonly lightMat: THREE.ShaderMaterial;
  private readonly bandMat: THREE.ShaderMaterial;
  private readonly spinner = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(options: TerminusOptions) {
    this.apertureRadius = options.apertureRadius ?? 430;
    this.position = options.position.clone();
    this.normal = options.normal.clone().normalize();
    const rng = new Rng(options.seed);

    this.hullMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(options.palette?.hullBase ?? 0x49525f) },
        uAccent: { value: new THREE.Color(options.palette?.hullAccent ?? 0x9aa6b4) },
        uWindow: { value: new THREE.Color(options.palette?.window ?? 0xffcf92).multiplyScalar(1.1) },
        uWindowDensity: { value: 0.34 },
        uTime: { value: 0 },
      }),
      vertexShader: STRUCTURE_VERT,
      fragmentShader: STRUCTURE_FRAG,
    });

    const inner = this.apertureRadius;
    const rim = TERMINUS_FRONT[TERMINUS_FRONT.length - 1].r;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const scratch = new THREE.Vector3();

    // --- primary shell ----------------------------------------------------------------
    // One revolved surface for the whole massing: terraced approach face, thick outer flank,
    // shadowed underside, flared bore. Previously this was three concentric tubes lying in
    // one plane, which is a disc however much greeble you put on it.
    const shellGeo = revolveShell([...TERMINUS_FRONT, ...TERMINUS_BACK], 176);
    this.geometries.push(shellGeo);
    this.spinner.add(new THREE.Mesh(shellGeo, this.hullMat));

    // --- throat collar ----------------------------------------------------------------
    // A raised lip standing proud of the bore. It does two jobs: it gives the central well an
    // edge for the occlusion pass to darken under, and it is what the aperture band hides
    // behind. Without something in front of it, an additive torus at the throat is seen head
    // on down an open tube and blooms into a plate.
    const collarGeo = buildRingHull(430, 48, 205, 96, 12, 4.0);
    this.geometries.push(collarGeo);
    const collar = new THREE.Mesh(collarGeo, this.hullMat);
    collar.position.z = -190;
    this.spinner.add(collar);

    // --- radial ridges ----------------------------------------------------------------
    // Rounded spines climbing the terraces from the collar to the rim. Rounded, not boxed,
    // and that is the point: a box sitting on a face-on disc presents either a square face
    // (which is unlit, being square to the approach) or a square flank (which is invisible,
    // being edge-on). A rounded ridge sweeps its normal through every in-plane direction, so
    // whatever the bearing of the star, one flank of every ridge is lit and the other is not.
    const ridgeCount = 12;
    const ridgeStep = (Math.PI * 2) / ridgeCount;
    for (let i = 0; i < ridgeCount; i++) {
      const angle = i * ridgeStep + rng.signed(ridgeStep * 0.34);
      // Two ridges in twelve stop short: a ring of twelve identical spokes is the loudest
      // procedural tell there is, and damage reads as history.
      const stunted = rng.next() < 0.18;
      const overhangs = rng.next() < 0.55;
      const reach = stunted
        ? rng.range(940, 1090)
        : overhangs
          ? rim + rng.range(50, 150)
          : rim - rng.range(10, 70);
      const girth = rng.range(0.78, 1.32);
      const stations: LoftStation[] = [];
      const steps = 11;
      for (let s = 0; s <= steps; s++) {
        const r = 700 + (reach - 700) * (s / steps);
        surfaceOn(TERMINUS_FRONT, Math.min(r, rim), angle, scratch);
        // Fat in the middle, tapering at both ends, and thinning fast once it overhangs the
        // rim so the overhang reads as a spar rather than as a stub.
        const t = s / steps;
        const swell = Math.sin(Math.PI * Math.pow(t, 0.72));
        const past = r > rim ? clamp01(1 - (r - rim) / Math.max(reach - rim, 1)) : 1;
        stations.push({
          z: r,
          width: (26 + 62 * swell) * girth * (0.35 + 0.65 * past),
          height: (34 + 58 * swell) * girth * (0.35 + 0.65 * past),
          squareness: 2.4,
          offsetY: scratch.z + (r > rim ? (r - rim) * 0.28 : 0),
        });
      }
      const ridgeGeo = loft({ stations, radialSegments: 12, capStart: true, capEnd: true });
      this.geometries.push(ridgeGeo);
      const ridge = new THREE.Mesh(ridgeGeo, this.hullMat);
      // Local Z outward along the radius, local Y along the station's own axis, so `offsetY`
      // walks the section up and down the terraces.
      basis.makeBasis(
        new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0),
      );
      ridge.quaternion.setFromRotationMatrix(basis);
      this.spinner.add(ridge);
    }

    // --- docking masts ----------------------------------------------------------------
    // These lean OUT rather than standing square to the approach face. A mast pointing at the
    // pilot is a foreshortened stub that adds nothing to the outline; a mast leaning outboard
    // puts a hard, irregular spike through the silhouette, which is what stops a two-kilometre
    // ring reading as a drawn circle.
    const mastProfile: LoftStation[] = [
      { z: 0, width: 60, height: 60, squareness: 5 },
      { z: 240, width: 96, height: 96, squareness: 6 },
      { z: 430, width: 62, height: 62, squareness: 5 },
      { z: 520, width: 20, height: 20, squareness: 4 },
    ];
    const mastGeo = loft({ stations: mastProfile, radialSegments: 10, capStart: true, capEnd: true });
    this.geometries.push(mastGeo);
    const forward = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + rng.signed(0.4);
      const rear = i >= 5;
      const radius = rng.range(940, 1180);
      const lean = rear ? rng.range(0.35, 0.8) : rng.range(0.75, 1.15);
      const mast = new THREE.Mesh(mastGeo, this.hullMat);
      surfaceOn(rear ? TERMINUS_REAR : TERMINUS_FRONT, radius, angle, mast.position);
      // Out along the radius by sin(lean), and away from the shell face by cos(lean).
      scratch.set(
        Math.cos(angle) * Math.sin(lean),
        Math.sin(angle) * Math.sin(lean),
        (rear ? 1 : -1) * Math.cos(lean),
      );
      mast.quaternion.setFromUnitVectors(forward, scratch);
      mast.scale.setScalar(rng.range(0.62, 1.12));
      this.spinner.add(mast);
    }

    // --- greebles ---------------------------------------------------------------------
    // Rounded blocks standing off the terraces, not flat plates lying in the face. Real
    // thickness is what the screen-space occlusion pass has to work with, and a bevelled top
    // is what turns one module into a lit face and a shadowed one.
    const greebleGeo = loft({
      stations: [
        { z: -0.5, width: 0.42, height: 0.42, squareness: 4.5 },
        { z: -0.42, width: 0.5, height: 0.5, squareness: 6.0 },
        { z: 0.4, width: 0.5, height: 0.5, squareness: 6.0 },
        { z: 0.5, width: 0.4, height: 0.4, squareness: 4.0 },
      ],
      radialSegments: 12,
      capStart: true,
      capEnd: true,
    });
    this.geometries.push(greebleGeo);
    const greebleCount = 260;
    const greebles = new THREE.InstancedMesh(greebleGeo, this.hullMat, greebleCount);
    for (let i = 0; i < greebleCount; i++) {
      const angle = rng.range(0, Math.PI * 2);
      // A quarter of them dress the underside, so the rim still reads as inhabited from
      // behind without spending detail where nobody is looking.
      const onRear = rng.next() < 0.25;
      const radius = onRear ? rng.range(560, 1150) : rng.range(inner + 200, rim - 40);
      surfaceOn(onRear ? TERMINUS_REAR : TERMINUS_FRONT, radius, angle, pos);
      // Power-law over a 4:1 range: a few large modules, many small fittings. Uniformly
      // sized greebles are detail at one frequency, which is noise rather than design.
      const g = 46 * Math.pow(4.4, Math.pow(rng.next(), 2.1));
      const stand = g * rng.range(0.5, 1.15);
      basis.makeBasis(
        new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0),
        new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0),
        new THREE.Vector3(0, 0, onRear ? 1 : -1),
      );
      quat.setFromRotationMatrix(basis);
      // A small random lean off the deck normal. Perfectly upright modules give the whole
      // field one shared normal, which is the flatness this rebuild exists to remove; too
      // much lean and a hull fitting reads as something that grew there.
      quat.multiply(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rng.signed(0.17), rng.signed(0.17), rng.range(0, Math.PI * 2)),
        ),
      );
      pos.z += (onRear ? 1 : -1) * stand * 0.3;
      scale.set(g * rng.range(0.9, 2.0), g * rng.range(0.6, 1.3), stand);
      matrix.compose(pos, quat, scale);
      greebles.setMatrixAt(i, matrix);
    }
    greebles.instanceMatrix.needsUpdate = true;
    this.spinner.add(greebles);

    // --- aperture light band: the thing you actually aim at ----------------------------
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(options.palette?.aperture ?? PALETTE.gateArmed) },
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
    // Both bands sit INSIDE the funnel — one at the throat, one at the far lip — so the hole
    // reads as a tube with a near end and a far end. Ringing the mouth instead put a 500 m
    // additive torus across the widest part of the object, and its bloom washed out the entire
    // terrace stack the rest of this rebuild exists to make visible.
    // The front band is centred on the collar's inner wall, so half the tube is buried in the
    // lip and what survives is a thin bright ring deep in the well. Fully exposed, an additive
    // torus at this radius blooms into a 200 px cyan plate that erases the terrace stack
    // behind it — which is what the old collar was quietly preventing.
    for (const [bandRadius, z] of [
      [383, -300],
      [428, 302],
    ]) {
      const bandGeo = new THREE.TorusGeometry(bandRadius, 12, 6, 160);
      this.geometries.push(bandGeo);
      const band = new THREE.Mesh(bandGeo, this.bandMat);
      band.position.z = z;
      band.renderOrder = 6;
      this.spinner.add(band);
    }

    // --- approach strobes --------------------------------------------------------------
    // Set back inside the funnel mouth and slightly proud of its wall: the chase now runs
    // down the throat toward the pilot instead of sitting on a flat annulus.
    const lightCount = 48;
    const lp = new Float32Array(lightCount * 3);
    const lo = new Float32Array(lightCount);
    for (let i = 0; i < lightCount; i++) {
      const a = (i / lightCount) * Math.PI * 2;
      lp[i * 3] = Math.cos(a) * 486;
      lp[i * 3 + 1] = Math.sin(a) * 486;
      lp[i * 3 + 2] = -540;
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
        uColor: { value: new THREE.Color(options.palette?.aperture ?? PALETTE.gateArmed) },
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

    this.spinner.scale.setScalar(this.apertureRadius / 430);
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

export interface ShelfSpanOptions {
  lighting: LightingUniforms;
  /** World position of the fragment's centre. */
  position: THREE.Vector3;
  seed: number;
}

/**
 * THE BROKEN SPAN — a nine-kilometre fragment of a ring far older than the terminus, hanging
 * across the middle of the route.
 *
 * It exists for one reason: scale. A sector of rocks and gates has no object of known enormous
 * size, so a 200 m boulder at 400 m and a 2 km wreck at 4 km look identical. One landmark that
 * is unmistakably kilometres long, that the player flies *past* rather than through, calibrates
 * every other distance in the frame.
 */
export class ShelfSpan {
  readonly object = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly spin: number;

  constructor(options: ShelfSpanOptions) {
    const rng = new Rng(options.seed);
    this.spin = rng.signed(0.0016);

    this.material = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(0x3b3a36) },
        uAccent: { value: new THREE.Color(0x77706a) },
        uWindow: { value: new THREE.Color(0xff9a55).multiplyScalar(0.5) },
        uWindowDensity: { value: 0.06 },
        uTime: { value: 0 },
      }),
      vertexShader: STRUCTURE_VERT,
      fragmentShader: STRUCTURE_FRAG,
    });

    const radius = 12_000;
    const arc = 0.78;
    // A nine-kilometre object fills a large solid angle, so it needs real tessellation: at 96
    // segments each facet was a hundred metres across and the silhouette read as origami.
    const main = buildRingHull(radius, 260, 420, 260, 22, 4.2, arc);
    this.geometries.push(main);
    this.object.add(new THREE.Mesh(main, this.material));

    // An inner rail and a scatter of ribs give the fragment internal structure, so it reads as
    // engineered wreckage instead of a bent pipe.
    const rail = buildRingHull(radius - 520, 90, 150, 220, 14, 3.4, arc * 0.92);
    this.geometries.push(rail);
    const railMesh = new THREE.Mesh(rail, this.material);
    railMesh.rotation.z = arc * 0.04;
    this.object.add(railMesh);

    const ribGeo = new THREE.BoxGeometry(620, 180, 700);
    this.geometries.push(ribGeo);
    const ribCount = 26;
    const ribs = new THREE.InstancedMesh(ribGeo, this.material, ribCount);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < ribCount; i++) {
      const a = (i / (ribCount - 1)) * arc;
      const r = radius - 260 + rng.signed(120);
      pos.set(Math.cos(a) * r, Math.sin(a) * r, rng.signed(260));
      quat.setFromEuler(new THREE.Euler(rng.signed(0.2), rng.signed(0.2), a));
      scale.setScalar(rng.range(0.6, 1.5));
      matrix.compose(pos, quat, scale);
      ribs.setMatrixAt(i, matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;
    this.object.add(ribs);

    // Recentre the arc on its own midpoint so `position` means what it says.
    const mid = arc * 0.5;
    this.object.children.forEach((child) => {
      child.position.x -= Math.cos(mid) * radius;
      child.position.y -= Math.sin(mid) * radius;
    });

    this.object.position.copy(options.position);
    this.object.rotation.set(rng.range(-0.4, 0.4), rng.range(0, Math.PI * 2), rng.range(-0.5, 0.5));
  }

  update(time: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uCameraPos.value.copy(cameraPosition);
    this.object.rotation.z += this.spin * 0.016;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
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
      // A wreck a kilometre long and two kilometres away fills a large part of the frame, so
      // seven stations and fourteen radial segments showed as origami. Detail here is cheap:
      // there are only fourteen of these in the whole sector.
      const segments = 14;
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        // A hull *section*, not a cone. The old taper ran almost to a point, and with only the
        // forward end capped you could see straight down the inside, so a wreck read as an
        // abstract open tube rather than as a piece of a ship.
        const taper = Math.max(0.42, 1 - Math.pow(u, 2.2) * rng.range(0.35, 0.62));
        stations.push({
          z: -length * 0.5 + length * u,
          width: width * taper * rng.range(0.85, 1.15),
          height: width * taper * rng.range(0.6, 1.0),
          squareness: rng.range(3, 6),
        });
      }
      const geometry = loft({ stations, radialSegments: 26, capStart: true, capEnd: true });
      this.geometries.push(geometry);

      const mesh = new THREE.Mesh(geometry, this.material);
      const dir = { x: 0, y: 0, z: 0 };
      rng.onSphere(dir);
      // Close enough to read as a known-size object, far enough to stay out of the racing line.
      const distance = rng.range(2600, 7400);
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
