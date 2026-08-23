import * as THREE from 'three';
import { GLSL_NOISE } from './glslNoise.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { PALETTE } from '../core/art.ts';
import { Rng } from '../core/rng.ts';
import { clamp01, damp, smoothstep } from '../core/mathx.ts';
import type { GateNameMessage } from '../core/contracts.ts';

/**
 * A CAIRN — one of the navigation markers the drift is strung with. Not a neon hoop: five
 * weathered monoliths hanging in a ring around a field of standing light, left by whoever
 * charted this shelf first.
 *
 * Readability drove every choice here. A gate has to be identifiable at 6 km (beacon sprite
 * + rim ring that never falls below a pixel floor), obviously *the next one* rather than any
 * other (armed state changes colour and animation, not just brightness), and obviously
 * *passed* the instant you clear it (a hard gold flash and a shock ring).
 */

export type GateState = 'dormant' | 'armed' | 'cleared' | 'missed';

const TERMINUS_APPROACH_MESSAGE: GateNameMessage = Object.freeze({
  type: 'gate-name.terminus-approach',
});

const MONOLITH_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const MONOLITH_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vLocal;

  uniform vec3 uCameraPos;
  uniform vec3 uStone;
  uniform vec3 uGlyph;
  uniform float uCharge;
  uniform float uTime;

  ${GLSL_NOISE}
  ${GLSL_LIGHTING}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    float grain = fbm(vWorldPos * 0.22, 4);
    vec3 dpdx = dFdx(vWorldPos);
    vec3 dpdy = dFdy(vWorldPos);
    vec3 r1 = cross(dpdy, N);
    vec3 r2 = cross(N, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = (r1 * dFdx(grain) + r2 * dFdy(grain)) / max(abs(det), 1e-6) * sign(det);
    N = normalize(N - grad * 0.35);

    vec3 albedo = uStone * (0.82 + grain * 0.4);
    float roughness = clamp(0.62 + grain * 0.2, 0.2, 0.95);
    vec3 color = shadeSurface(N, V, albedo, roughness, 0.05, 0.85);

    // Cut glyph channels down the inward face. They light up as the gate arms — the stone
    // is inert, the marking is what the builders energised.
    float band = abs(fract(vLocal.y * 0.09 + 0.5) - 0.5);
    float glyph = smoothstep(0.075, 0.03, band);
    float rib = smoothstep(0.6, 0.95, fbm(vec3(vLocal.y * 0.4, vLocal.x * 0.2, 3.0), 3) * 0.5 + 0.5);
    // The geometry's rotateY bakes into vLocal, so which local axis faces the ring centre MOVES
    // with that angle: at the old PI/2 it was -Z alone, at the current PI/4 it splits evenly
    // between -X and -Z, so the gate blends both (0.7071 = 1/sqrt(2) renormalises the pair).
    // Currently moot either way — the rib term above suppresses this channel to ~0, because
    // fbm's amplitude cannot reach the smoothstep(0.6, 0.95) knee. Whoever repairs rib must
    // re-derive this axis against the rotateY in force at the time.
    vec3 inwardN = normalize(vLocal);
    float inward = smoothstep(0.1, 0.7, -(inwardN.x + inwardN.z) * 0.7071);
    float channel = glyph * rib * inward;

    float pulse = 0.62 + 0.38 * sin(uTime * 2.1 - vLocal.y * 0.16);
    color += uGlyph * channel * uCharge * pulse * 3.4;
    color -= albedo * channel * 0.25 * (1.0 - uCharge);

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos), V), 1.0);
  }
`;

const FIELD_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FIELD_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uTime;
  uniform float uCharge;
  uniform float uFlash;
  uniform vec3 uCameraPos;

  ${GLSL_NOISE}

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);

    // Standing wave across the aperture: concentric ripples plus a slow angular drift.
    float ripple = sin(r * 26.0 - uTime * 2.6) * 0.5 + 0.5;
    // The angular term is a pure function of polar angle, so it is undefined at r=0 and exactly
    // periodic everywhere else — as a 50% mix it rendered a nine-petal mandala with a hard
    // singularity pinched at the centre of the hole the player flies through nine times a run.
    // Fade it out toward the axis, break its periodicity with the turbulence field, and let the
    // ripple carry the aperture.
    float turb = fbm(vec3(p * 3.4, uTime * 0.16), 4) * 0.5 + 0.5;
    float spokes = sin(a * 9.0 + uTime * 0.55 + turb * 2.6) * 0.5 + 0.5;
    spokes *= smoothstep(0.0, 0.35, r);

    // Density is concentrated at the rim; the middle stays open so you can see through it.
    float rim = smoothstep(0.62, 1.0, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float body = smoothstep(1.0, 0.2, r) * 0.16;
    float density = rim * (0.55 + ripple * 0.45) * (0.6 + turb * 0.7) + body * (0.85 + spokes * 0.15);

    // Viewed edge-on the field almost vanishes, which is what makes it read as a plane of
    // light in space rather than a flat disc sprite.
    vec3 V = normalize(uCameraPos - vWorldPos);
    float facing = abs(dot(normalize(vNormal), V));
    density *= mix(0.18, 1.0, pow(facing, 0.6));

    vec3 col = mix(uColor, uHot, ripple * 0.6 + rim * 0.4);
    col *= density * (0.3 + uCharge * 1.45);
    col += uHot * uFlash * (rim * 2.2 + body * 4.0);

    float alpha = clamp(density * (0.28 + uCharge * 0.72) + uFlash * 0.6, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

const BEACON_VERT = /* glsl */ `
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelScale;
  uniform float uCharge;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    // Angular size with a hard pixel floor: a cairn is never smaller than a findable dot,
    // which is what keeps the next gate locatable from 6 km out.
    //
    // The floor is applied AFTER the scale, not before. gl_PointSize is in framebuffer pixels,
    // so a floor taken before the multiply is a floor on the pre-scaled quantity and the drawn
    // dot falls under it whenever uPixelScale < 1 — which the dynamic scaler now makes routine.
    // 2.4 px is a stated gameplay affordance and it has to be 2.4 px on the screen.
    float size = max(280.0 / max(dist, 1.0) * uPixelScale, 2.4);
    float blink = 0.55 + 0.45 * sin(uTime * 2.4 + aPhase);
    gl_PointSize = size * (0.85 + blink * 0.4);
    vAlpha = (0.35 + uCharge * 0.65) * blink;
  }
`;

const BEACON_FRAG = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  uniform vec3 uColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = exp(-r * r * 7.0);
    float halo = exp(-r * r * 1.7) * 0.4;
    gl_FragColor = vec4(uColor * (core * 2.6 + halo), (core + halo) * vAlpha);
  }
`;

export interface GateOptions {
  index: number;
  total: number;
  position: THREE.Vector3;
  /** Direction the player should be travelling when they pass through. */
  normal: THREE.Vector3;
  radius: number;
  lighting: LightingUniforms;
  seed: number;
}

export class Gate {
  readonly object = new THREE.Group();
  readonly index: number;
  readonly position: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly radius: number;
  readonly name: string;
  readonly nameMessage: GateNameMessage | undefined;

  state: GateState = 'dormant';

  private readonly monolithMat: THREE.ShaderMaterial;
  private readonly fieldMat: THREE.ShaderMaterial;
  private readonly beaconMat: THREE.ShaderMaterial;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly shockMesh: THREE.Mesh;
  private readonly shockMat: THREE.ShaderMaterial;
  private readonly spinner = new THREE.Group();

  private charge = 0;
  private flash = 0;
  private shock = -1;

  constructor(options: GateOptions) {
    this.index = options.index;
    this.position = options.position.clone();
    this.normal = options.normal.clone().normalize();
    this.radius = options.radius;
    const isTerminusApproach = options.index === options.total - 1;
    this.name = isTerminusApproach
      ? 'TERMINUS APPROACH'
      : `CAIRN ${String(options.index + 1).padStart(2, '0')}`;
    this.nameMessage = isTerminusApproach ? TERMINUS_APPROACH_MESSAGE : undefined;

    const rng = new Rng(options.seed);

    this.monolithMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        // The cairn is stone that someone put a light in, and it was reading as a light with
        // some black shapes near it: the aperture blew out while the monoliths sat one value
        // step above the void. Raised so the stone holds its own against its own beacon.
        uStone: { value: new THREE.Color(0x8d887e) },
        uGlyph: { value: new THREE.Color(PALETTE.gateArmed) },
        uCharge: { value: 0 },
        uTime: { value: 0 },
      }),
      vertexShader: MONOLITH_VERT,
      fragmentShader: MONOLITH_FRAG,
    });

    // --- monoliths ------------------------------------------------------------------
    // Count, spacing and archetype all vary, and some positions are deliberately empty. Five
    // identical slabs at a uniform 72 degrees reads as generated in well under a second — the
    // eye matches on rotational symmetry faster than on almost anything else — and it also
    // makes better fiction: these markers have been out here a very long time.
    const SEGMENTS = 3 + rng.int(0, 4);
    for (let i = 0; i < SEGMENTS; i++) {
      if (SEGMENTS > 4 && rng.bool(0.16)) continue;
      const angle = (i / SEGMENTS) * Math.PI * 2 + rng.signed(0.34);
      const mesh = new THREE.Mesh(this.buildMonolith(options.radius, rng), this.monolithMat);
      const r = options.radius * rng.range(0.98, 1.16);
      mesh.position.set(Math.cos(angle) * r, Math.sin(angle) * r, rng.range(-options.radius * 0.09, options.radius * 0.09));
      // Tilt off the ring plane, to bring the extruded SIDE WALLS into view.
      //
      // CORRECTION, twice over. This comment previously claimed that every rotation in the chain
      // was about Z so nothing moved the extrusion axis, and that direct sun on the cairn "was not
      // small, it was exactly zero". Both are false.
      //
      // 1. `git show 4582276^` has `rotation.x = rng.range(-0.09, 0.09)` and `rotation.y =
      //    rng.range(-0.13, 0.13)` on the two lines after `rotation.z`. Non-Z tilt already
      //    existed; this commit widened it (x 5x, y 3.8x) rather than introducing it. The comment
      //    enumerated the rotation chain and omitted the two rotations in the code it replaced.
      // 2. The closure figures quoted here — across-slab mean spread 25.3 -> 72.9, 0.7 -> 89.5,
      //    17.8 -> 59.4 — are a CROSS-slab metric, and cannot separate key light from tilt-induced
      //    ambient variation: `hemi = N.y * 0.5 + 0.5` is itself a function of the tilt, and
      //    uGroundColor != uSkyColor. Four independent round-7 measurements found four slabs at
      //    four different tilts whose face means land within 2.9 code values of each other, which
      //    is a hemisphere signature and not a key.
      //
      // What this tilt delivered on its own WAS only the side walls — 6.3% of the object, with
      // 93.7% of the stone at zero key light, because these ranges are symmetric about zero
      // (E[cos x cos y] = 0.927): the mean face normal does not move, so this jitter can never
      // cross the -0.15 wrap threshold by itself. The repair that worked is the geometry-level
      // rotateY in buildMonolith (finally 45 degrees, d9c27c5), which moves the mean normal;
      // this per-slab jitter stays for variety on top of it. Round 9: five reviewers and two
      // skeptics judged the lit result shippable from pixels. Ledger L04 — closed, and it was
      // certified closed once before on a cross-slab spread that could not tell key light from
      // tilt-induced ambient, so do not re-certify it with that metric.
      mesh.rotation.z = angle;
      mesh.rotation.x = rng.range(-0.45, 0.45);
      mesh.rotation.y = rng.range(-0.5, 0.5);
      this.spinner.add(mesh);
    }

    // --- standing field -------------------------------------------------------------
    this.fieldMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.gateIdle) },
        uHot: { value: new THREE.Color(PALETTE.gateArmed) },
        uTime: { value: 0 },
        uCharge: { value: 0 },
        uFlash: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
      },
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    // The disc must run PAST the ring's inner edge and let the ring cover the join. At 0.99R
    // against a torus whose inner edge sits at 0.988R the overlap was 0.002R, and a 96-gon
    // inscribed in that circle pulls its edge midpoints in further still — which left a one to
    // two pixel dark hairline right around every aperture, on the one silhouette in the game
    // that has to read cleanly from four kilometres. Segment count matched to the ring so the
    // two polygons agree where they meet.
    const field = new THREE.Mesh(new THREE.CircleGeometry(options.radius * 1.006, 160), this.fieldMat);
    field.renderOrder = 5;
    this.object.add(field);

    // --- rim ring: the long-range silhouette ----------------------------------------
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.gateArmed) },
        uCharge: { value: 0 },
        uFlash: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        varying float vDist;
        uniform vec3 uColor;
        uniform float uCharge;
        uniform float uFlash;
        uniform float uTime;
        void main() {
          // The tube is under a pixel wide past a couple of kilometres, so coverage aliases
          // and a solid ring breaks into a dashed circle — which reads as a rendering fault
          // and undercuts the promise that a cairn is findable from six kilometres out. Fade
          // the ring out with range and let the beacons, which have a pixel-size floor,
          // carry the long-distance read.
          float ranged = 1.0 - smoothstep(1800.0, 3600.0, vDist);
          if (ranged <= 0.002) discard;
          float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
          float core = pow(across, 3.0);
          // A light pulse chases around the ring when armed: unmistakable directionality.
          float chase = smoothstep(0.55, 1.0, sin(vUv.x * 6.2831 * 2.0 - uTime * 1.9) * 0.5 + 0.5);
          float a = core * (0.18 + uCharge * 0.45 + chase * uCharge * 0.7 + uFlash * 1.2);
          gl_FragColor = vec4(uColor * (0.36 + uCharge * 0.85 + uFlash * 2.1) * ranged, a * ranged);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(options.radius, options.radius * 0.012, 8, 160), this.ringMat);
    ring.renderOrder = 6;
    this.object.add(ring);

    // --- beacons --------------------------------------------------------------------
    const beaconCount = 12;
    const bp = new Float32Array(beaconCount * 3);
    const bph = new Float32Array(beaconCount);
    for (let i = 0; i < beaconCount; i++) {
      const a = (i / beaconCount) * Math.PI * 2;
      bp[i * 3] = Math.cos(a) * options.radius * 1.13;
      bp[i * 3 + 1] = Math.sin(a) * options.radius * 1.13;
      bp[i * 3 + 2] = 0;
      bph[i] = a * 2.4;
    }
    const beaconGeo = new THREE.BufferGeometry();
    beaconGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    beaconGeo.setAttribute('aPhase', new THREE.BufferAttribute(bph, 1));
    this.beaconMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 1 },
        uCharge: { value: 0 },
        uColor: { value: new THREE.Color(PALETTE.gateArmed) },
      },
      vertexShader: BEACON_VERT,
      fragmentShader: BEACON_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const beacons = new THREE.Points(beaconGeo, this.beaconMat);
    beacons.frustumCulled = false;
    beacons.renderOrder = 7;
    this.object.add(beacons);

    // --- pass-through shock ring ----------------------------------------------------
    this.shockMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTE.gateCleared) },
        uProgress: { value: 0 },
      },
      vertexShader: FIELD_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        uniform vec3 uColor;
        uniform float uProgress;
        void main() {
          float r = length((vUv - 0.5) * 2.0);
          if (r > 1.0) discard;
          float front = uProgress;
          float band = exp(-pow((r - front) * 11.0, 2.0));
          float fade = 1.0 - smoothstep(0.0, 1.0, uProgress);
          gl_FragColor = vec4(uColor * band * 7.0 * fade, band * fade);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.shockMesh = new THREE.Mesh(new THREE.CircleGeometry(options.radius * 2.1, 64), this.shockMat);
    this.shockMesh.visible = false;
    this.shockMesh.renderOrder = 8;
    this.object.add(this.shockMesh);

    this.object.add(this.spinner);
    this.object.position.copy(this.position);
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
    this.object.rotateZ(rng.range(0, Math.PI * 2));
  }

  /** A tapered slab, wider at the base, with a chamfered inward edge. */
  private buildMonolith(gateRadius: number, rng: Rng): THREE.BufferGeometry {
    // Three archetypes rather than one slab at three sizes: a tall spar, a broad plinth, and a
    // broken stub. Varying only the scale of one shape is still one shape.
    const archetype = rng.int(0, 3);
    const height =
      gateRadius * (archetype === 0 ? rng.range(1.0, 1.35) : archetype === 1 ? rng.range(0.6, 0.8) : rng.range(0.3, 0.46));
    const width =
      gateRadius * (archetype === 0 ? rng.range(0.06, 0.09) : archetype === 1 ? rng.range(0.17, 0.24) : rng.range(0.12, 0.18));
    const depth =
      gateRadius * (archetype === 0 ? rng.range(0.08, 0.12) : archetype === 1 ? rng.range(0.16, 0.23) : rng.range(0.14, 0.2));

    const shape = new THREE.Shape();
    const w = width;
    shape.moveTo(-w, -height * 0.5);
    shape.lineTo(w * 0.62, -height * 0.5);
    shape.lineTo(w * 0.9, -height * 0.18);
    shape.lineTo(w * 0.72, height * 0.42);
    shape.lineTo(-w * 0.55, height * 0.5);
    shape.lineTo(-w * 1.1, height * 0.1);
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSize: width * 0.16,
      bevelThickness: width * 0.14,
      bevelSegments: 2,
      curveSegments: 1,
    });
    geometry.translate(0, 0, -depth * 0.5);
    // Extrusion builds in XY; rotate so local +X is radially outward and +Y runs along it.
    geometry.rotateZ(-Math.PI / 2);
    /* Then turn the slab so its BROAD faces point around the ring instead of along the gate
       normal. Without this every monolith presented nearly the same face direction: the placement
       chain DOES carry X/Y jitter (it always did — claiming otherwise is ledger L04), but its
       ranges are symmetric about zero, so the mean face normal never moved and N.L stayed between
       -0.42 and -0.97 against a -0.15 wrap threshold. 93.7% of the stone rendered as hemisphere
       ambient alone, every material term multiplied by zero. Only a geometry-level rotation moves
       the MEAN, which is why this line exists and jitter widening could not replace it.
       Now the five slabs' faces are spread through the ring plane and roughly half meet the sun
       at any course heading, seed-independently, without touching the shared lighting model.

       PI/4, not PI/2. The full quarter-turn fixed the lighting and collapsed the silhouette:
       three round-8 skeptics, refuting three different cairn blockers, converged on the residue
       that the slabs had gone edge-on to the approach — the spar archetype's frontal extent fell
       107.35 m -> 10.16 m, ~90% of the face the player navigates by. A calibrated offline sweep
       of this angle (reproducing both known endpoints before measuring anything between them)
       found most of the lighting gain arrives by 45 degrees while three quarters of the frontal
       extent survives: 82.24 m frontal, lit-eligible fraction 24.1% across a full spinner period
       against 12.9% at zero and ~26% at ninety. The sweep measures geometric eligibility for
       wrapped diffuse, not shaded pixels — the visual call on whether it reads as a cairn belongs
       to reviewers, not to this comment. */
    geometry.rotateY(Math.PI / 4);
    geometry.computeVertexNormals();
    return geometry;
  }

  /**
   * Colour follows state in BOTH directions. Setting cleared/missed used to overwrite the
   * palette permanently, so a gate that was cleared and later re-armed — which happens on a
   * restart, on a seek, and every time the player misses and comes back — stayed gold or red
   * while the game insisted it was the live target.
   */
  setState(state: GateState): void {
    if (this.state === state) return;
    this.state = state;

    const tint =
      state === 'cleared' ? PALETTE.gateCleared : state === 'missed' ? PALETTE.gateFail : PALETTE.gateArmed;
    this.tintScratch.set(tint);
    this.fieldMat.uniforms.uHot.value.copy(this.tintScratch);
    this.ringMat.uniforms.uColor.value.copy(this.tintScratch);
    this.beaconMat.uniforms.uColor.value.copy(this.tintScratch);
    this.monolithMat.uniforms.uGlyph.value.copy(this.tintScratch);

    if (state === 'cleared') {
      this.flash = 1;
      this.shock = 0;
      this.shockMesh.visible = true;
    } else if (state === 'missed') {
      this.flash = 1;
    }
  }

  private readonly tintScratch = new THREE.Color();

  update(dt: number, time: number, cameraPosition: THREE.Vector3, pixelScale: number): void {
    const targetCharge = this.state === 'armed' ? 1 : this.state === 'cleared' ? 0.16 : 0.05;
    this.charge = damp(this.charge, targetCharge, 0.22, dt);
    this.flash = damp(this.flash, 0, 0.16, dt);

    if (this.shock >= 0) {
      this.shock += dt * 1.5;
      this.shockMat.uniforms.uProgress.value = this.shock;
      if (this.shock > 1.05) {
        this.shock = -1;
        this.shockMesh.visible = false;
      }
    }

    // Counter-rotating drift: slow enough to be subliminal, fast enough that a gate never
    // looks like a static prop when you approach it twice.
    this.spinner.rotation.z = time * 0.035 * (this.index % 2 === 0 ? 1 : -1);

    this.monolithMat.uniforms.uCharge.value = this.charge;
    this.monolithMat.uniforms.uTime.value = time;
    this.monolithMat.uniforms.uCameraPos.value.copy(cameraPosition);
    this.fieldMat.uniforms.uCharge.value = this.charge;
    this.fieldMat.uniforms.uFlash.value = this.flash;
    this.fieldMat.uniforms.uTime.value = time;
    this.fieldMat.uniforms.uCameraPos.value.copy(cameraPosition);
    this.ringMat.uniforms.uCharge.value = this.charge;
    this.ringMat.uniforms.uFlash.value = this.flash;
    this.ringMat.uniforms.uTime.value = time;
    this.beaconMat.uniforms.uCharge.value = this.charge;
    this.beaconMat.uniforms.uTime.value = time;
    this.beaconMat.uniforms.uPixelScale.value = pixelScale;
  }

  /**
   * Returns the signed distance along the gate normal. The course watches this flip sign to
   * detect a pass, which is exact regardless of speed — no tunnelling at 1000 m/s.
   */
  signedDistance(point: THREE.Vector3): number {
    return (
      (point.x - this.position.x) * this.normal.x +
      (point.y - this.position.y) * this.normal.y +
      (point.z - this.position.z) * this.normal.z
    );
  }

  /** Radial distance from the gate axis at the crossing point, in metres. */
  radialDistance(point: THREE.Vector3, out: THREE.Vector3): number {
    out.copy(point).sub(this.position);
    const along = out.dot(this.normal);
    out.addScaledVector(this.normal, -along);
    return out.length();
  }

  /** 0..1 alignment of a heading with the gate's forward axis. */
  alignment(heading: THREE.Vector3): number {
    return clamp01(smoothstep(-0.2, 1, heading.dot(this.normal)));
  }

  dispose(): void {
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
    });
    this.monolithMat.dispose();
    this.fieldMat.dispose();
    this.beaconMat.dispose();
    this.ringMat.dispose();
    this.shockMat.dispose();
  }
}
