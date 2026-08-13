import * as THREE from 'three';
import { GLSL_NOISE } from './glslNoise.ts';
import { PALETTE } from '../core/art.ts';

/**
 * VESPER — the gas giant the terminus orbits. It is the game's primary scale reference: it
 * fills a large solid angle, it has a visible terminator, and it never moves relative to the
 * player. Everything about the shading is aimed at "that is very far away and very large".
 */

const PLANET_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLANET_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vPos;

  uniform vec3 uSunDir;
  uniform vec3 uLit;
  uniform vec3 uShadow;
  uniform vec3 uAtmo;
  uniform float uTime;

  ${GLSL_NOISE}

  void main() {
    vec3 n = normalize(vNormal);
    vec3 p = normalize(vPos);

    // Zonal banding: latitude drives the base stripe, turbulence shears it into cloud belts.
    float lat = p.y;
    float turbulence = fbm(vec3(p.x * 2.2, p.y * 9.0, p.z * 2.2) + uTime * 0.006, 5);
    float bands = sin((lat * 11.0 + turbulence * 1.35) * 3.14159);
    bands = bands * 0.5 + 0.5;
    float fine = fbm(vec3(p.x * 5.0, p.y * 26.0, p.z * 5.0) + 4.1, 4) * 0.5 + 0.5;

    // A long-lived storm gives the eye something to fix on and sells the rotation.
    vec3 stormAxis = normalize(vec3(0.62, -0.28, 0.73));
    float storm = smoothstep(0.955, 0.995, dot(p, stormAxis));
    float stormSwirl = fbm(p * 14.0 + 9.0, 4) * 0.5 + 0.5;

    vec3 base = mix(uShadow * 1.6, uLit, bands * 0.62 + fine * 0.38);
    base = mix(base, vec3(0.78, 0.42, 0.30), storm * (0.55 + stormSwirl * 0.45));

    // Wrapped diffuse: gas giants have deep atmospheres, so the terminator is soft and warm.
    float ndl = dot(n, uSunDir);
    float wrap = clamp((ndl + 0.28) / 1.28, 0.0, 1.0);
    float light = pow(wrap, 1.35);

    vec3 col = base * (uShadow * 0.16 + uLit * light * 1.15);

    // Forward scattering along the terminator: the classic warm rim on a lit gas giant.
    float terminator = pow(1.0 - abs(ndl), 6.0) * smoothstep(-0.35, 0.25, ndl);
    col += vec3(1.0, 0.62, 0.34) * terminator * 0.55;

    // Rayleigh-ish limb: the atmosphere is denser at grazing angles.
    vec3 viewDir = normalize(-vec3(0.0, 0.0, 1.0));
    float fres = pow(1.0 - abs(dot(n, viewDir)), 3.0);
    col += uAtmo * fres * light * 0.55;

    // Night side keeps a trace of scattered light so it never becomes a black hole in frame.
    col += uShadow * 0.05;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const ATMO_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vView;
  uniform vec3 uSunDir;
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uStrength;

  void main() {
    vec3 n = normalize(vNormal);
    float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), uPower);
    float ndl = dot(n, uSunDir);
    // Only the lit limb glows, and the brightest band sits just inside the terminator.
    float lit = smoothstep(-0.22, 0.55, ndl);
    float grazing = smoothstep(-0.05, 0.45, ndl) * (1.0 - smoothstep(0.6, 1.0, ndl) * 0.45);
    vec3 col = uColor * rim * uStrength * (lit * 0.75 + grazing * 0.85);
    gl_FragColor = vec4(col, clamp(rim * lit, 0.0, 1.0));
  }
`;

export interface PlanetOptions {
  /** Far-scene distance from origin. */
  distance: number;
  /** Apparent angular radius, radians. */
  angularRadius: number;
  direction: THREE.Vector3;
  sunDirection: THREE.Vector3;
  rings: boolean;
}

export class Planet {
  readonly object = new THREE.Group();
  private readonly surface: THREE.Mesh;
  private readonly surfaceMat: THREE.ShaderMaterial;
  private readonly atmoMat: THREE.ShaderMaterial;
  private ringMat: THREE.ShaderMaterial | null = null;

  constructor(options: PlanetOptions) {
    const radius = Math.tan(options.angularRadius) * options.distance;
    const sunDir = options.sunDirection.clone().normalize();

    this.surfaceMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDir },
        uLit: { value: new THREE.Color(PALETTE.planetLit) },
        uShadow: { value: new THREE.Color(PALETTE.planetShadow) },
        uAtmo: { value: new THREE.Color(PALETTE.planetAtmo) },
        uTime: { value: 0 },
      },
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      depthWrite: true,
      depthTest: true,
    });

    this.surface = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.surfaceMat);
    this.surface.rotation.z = 0.24;

    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDir },
        uColor: { value: new THREE.Color(PALETTE.planetAtmo) },
        uPower: { value: 3.2 },
        uStrength: { value: 1.35 },
      },
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.035, 64, 48), this.atmoMat);

    const body = new THREE.Group();
    body.add(this.surface, atmosphere);

    if (options.rings) body.add(this.buildRings(radius, sunDir));

    body.position.copy(options.direction).normalize().multiplyScalar(options.distance);
    // Tilt the whole system so the ring plane cuts the silhouette at an interesting angle.
    body.rotation.set(0.42, 0.9, -0.18);
    this.object.add(body);
  }

  private buildRings(radius: number, sunDir: THREE.Vector3): THREE.Mesh {
    const geometry = new THREE.RingGeometry(radius * 1.42, radius * 2.45, 256, 1);
    // RingGeometry's default uv is unusable for radial banding; rebuild it as (radial, angle).
    const pos = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.hypot(x, y);
      const t = (r - radius * 1.42) / (radius * 2.45 - radius * 1.42);
      uv.setXY(i, t, Math.atan2(y, x) / (Math.PI * 2) + 0.5);
    }
    uv.needsUpdate = true;

    this.ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDir },
        uWarm: { value: new THREE.Color(0xd8b48a) },
        uCool: { value: new THREE.Color(0x6e7fa8) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vNormal;
        uniform vec3 uSunDir;
        uniform vec3 uWarm;
        uniform vec3 uCool;

        ${GLSL_NOISE}

        void main() {
          float t = vUv.x;
          // Sharp gaps plus fine structure: rings read as billions of particles, not a decal.
          float coarse = fbm(vec3(t * 26.0, 0.0, 0.0), 4) * 0.5 + 0.5;
          float fine = fbm(vec3(t * 165.0, 3.7, 0.0), 3) * 0.5 + 0.5;
          float density = smoothstep(0.28, 0.72, coarse) * (0.55 + fine * 0.45);
          density *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.86, 1.0, t));
          // A couple of hard divisions.
          density *= 1.0 - smoothstep(0.30, 0.33, t) * (1.0 - smoothstep(0.36, 0.39, t));

          float ndl = abs(dot(normalize(vNormal), uSunDir));
          vec3 col = mix(uCool, uWarm, fine) * (0.25 + ndl * 1.05);
          gl_FragColor = vec4(col * density, density * 0.92);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const ring = new THREE.Mesh(geometry, this.ringMat);
    ring.rotation.x = Math.PI / 2;
    return ring;
  }

  update(time: number): void {
    this.surfaceMat.uniforms.uTime.value = time;
    // Barely perceptible, but over a two-minute run the storm visibly walks around the limb.
    this.surface.rotation.y = time * 0.0022;
  }

  dispose(): void {
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.surfaceMat.dispose();
    this.atmoMat.dispose();
    this.ringMat?.dispose();
  }
}
