import * as THREE from 'three';
import { GLSL_NOISE } from './glslNoise.ts';
import { GLSL_LIGHTING, withLighting, type LightingUniforms } from './lighting.ts';
import { PALETTE, SCALE } from '../core/art.ts';
import { Rng } from '../core/rng.ts';
import { clamp01, damp, smoothstep } from '../core/mathx.ts';

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

    vec3 albedo = uStone * (0.7 + grain * 0.34);
    float roughness = clamp(0.62 + grain * 0.2, 0.2, 0.95);
    vec3 color = shadeSurface(N, V, albedo, roughness, 0.22, 0.85);

    // Cut glyph channels down the inward face. They light up as the gate arms — the stone
    // is inert, the marking is what the builders energised.
    float band = abs(fract(vLocal.y * 0.09 + 0.5) - 0.5);
    float glyph = smoothstep(0.075, 0.03, band);
    float rib = smoothstep(0.6, 0.95, fbm(vec3(vLocal.y * 0.4, vLocal.x * 0.2, 3.0), 3) * 0.5 + 0.5);
    float inward = smoothstep(0.1, 0.7, -normalize(vLocal).x);
    float channel = glyph * rib * inward;

    float pulse = 0.62 + 0.38 * sin(uTime * 2.1 - vLocal.y * 0.16);
    color += uGlyph * channel * uCharge * pulse * 3.4;
    color -= albedo * channel * 0.25 * (1.0 - uCharge);

    gl_FragColor = vec4(applyHaze(color, length(uCameraPos - vWorldPos)), 1.0);
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

    // Standing wave across the aperture: concentric ripples plus slow angular spokes.
    float ripple = sin(r * 26.0 - uTime * 2.6) * 0.5 + 0.5;
    float spokes = sin(a * 9.0 + uTime * 0.55) * 0.5 + 0.5;
    float turb = fbm(vec3(p * 3.4, uTime * 0.16), 4) * 0.5 + 0.5;

    // Density is concentrated at the rim; the middle stays open so you can see through it.
    float rim = smoothstep(0.62, 1.0, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float body = smoothstep(1.0, 0.2, r) * 0.16;
    float density = rim * (0.55 + ripple * 0.45) * (0.6 + turb * 0.7) + body * (0.5 + spokes * 0.5);

    // Viewed edge-on the field almost vanishes, which is what makes it read as a plane of
    // light in space rather than a flat disc sprite.
    vec3 V = normalize(uCameraPos - vWorldPos);
    float facing = abs(dot(normalize(vNormal), V));
    density *= mix(0.18, 1.0, pow(facing, 0.6));

    vec3 col = mix(uColor, uHot, ripple * 0.6 + rim * 0.4);
    col *= density * (0.35 + uCharge * 2.4);
    col += uHot * uFlash * (rim * 3.0 + body * 6.0);

    float alpha = clamp(density * (0.3 + uCharge * 0.9) + uFlash * 0.7, 0.0, 1.0);
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
    float size = max(280.0 / max(dist, 1.0), 2.4) * uPixelScale;
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
    this.name = options.index === options.total - 1 ? 'TERMINUS APPROACH' : `CAIRN ${String(options.index + 1).padStart(2, '0')}`;

    const rng = new Rng(options.seed);

    this.monolithMat = new THREE.ShaderMaterial({
      uniforms: withLighting(options.lighting, {
        uCameraPos: { value: new THREE.Vector3() },
        uStone: { value: new THREE.Color(0x3d3a3a) },
        uGlyph: { value: new THREE.Color(PALETTE.gateArmed) },
        uCharge: { value: 0 },
        uTime: { value: 0 },
      }),
      vertexShader: MONOLITH_VERT,
      fragmentShader: MONOLITH_FRAG,
    });

    // --- monoliths ------------------------------------------------------------------
    const SEGMENTS = 5;
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = (i / SEGMENTS) * Math.PI * 2 + rng.range(-0.06, 0.06);
      const mesh = new THREE.Mesh(this.buildMonolith(options.radius, rng), this.monolithMat);
      const r = options.radius * rng.range(1.02, 1.11);
      mesh.position.set(Math.cos(angle) * r, Math.sin(angle) * r, rng.range(-options.radius * 0.09, options.radius * 0.09));
      // Local +X points outward, so the shader's "inward face" test is well defined.
      mesh.rotation.z = angle;
      mesh.rotation.x = rng.range(-0.09, 0.09);
      mesh.rotation.y = rng.range(-0.13, 0.13);
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
    const field = new THREE.Mesh(new THREE.CircleGeometry(options.radius * 0.99, 96), this.fieldMat);
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
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uColor;
        uniform float uCharge;
        uniform float uFlash;
        uniform float uTime;
        void main() {
          float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
          float core = pow(across, 3.0);
          // A light pulse chases around the ring when armed: unmistakable directionality.
          float chase = smoothstep(0.55, 1.0, sin(vUv.x * 6.2831 * 2.0 - uTime * 1.9) * 0.5 + 0.5);
          float a = core * (0.22 + uCharge * 0.55 + chase * uCharge * 0.8 + uFlash * 1.4);
          gl_FragColor = vec4(uColor * (0.6 + uCharge * 2.2 + uFlash * 5.0), a);
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
    const height = gateRadius * rng.range(0.72, 1.05);
    const width = gateRadius * rng.range(0.1, 0.16);
    const depth = gateRadius * rng.range(0.13, 0.2);

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
    geometry.computeVertexNormals();
    return geometry;
  }

  setState(state: GateState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === 'cleared') {
      this.flash = 1;
      this.shock = 0;
      this.shockMesh.visible = true;
      const gold = new THREE.Color(PALETTE.gateCleared);
      this.fieldMat.uniforms.uHot.value.copy(gold);
      this.ringMat.uniforms.uColor.value.copy(gold);
      this.beaconMat.uniforms.uColor.value.copy(gold);
      this.monolithMat.uniforms.uGlyph.value.copy(gold);
    } else if (state === 'missed') {
      this.flash = 1;
      const red = new THREE.Color(PALETTE.gateFail);
      this.fieldMat.uniforms.uHot.value.copy(red);
      this.ringMat.uniforms.uColor.value.copy(red);
      this.beaconMat.uniforms.uColor.value.copy(red);
    }
  }

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

export const GATE_RADIUS = SCALE.gateRadius;
