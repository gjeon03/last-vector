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
  /**
   * World-space normal, for every term that meets uSunDir.
   *
   * The lighting used the VIEW-space normal against a WORLD-space sun, which is
   * dot(n_world, transpose(R) * sun): the sun counter-rotates with the camera and the lit
   * hemisphere is pinned to a fixed SCREEN direction. Measured across a 60 s lap, the disc was
   * 35-45% too dark with contrast cut about 60%, and its luminance correlated with screen-x at
   * r = +0.962 — the planet was lit by where you were looking rather than by the star. At one
   * point in the lap the build renders a fully lit ring system wrapped around a solid black
   * void with the star visible in the same frame.
   *
   * vNormal stays view-space on purpose: the limb fresnel and the atmosphere rim pair it with
   * a view-space vector, and swapping those too would fix the diffuse and break both rims.
   */
  varying vec3 vWorldNormal;
  varying vec3 vPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
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
    float ndl = dot(normalize(vWorldNormal), uSunDir);
    float wrap = clamp((ndl + 0.28) / 1.28, 0.0, 1.0);
    float light = pow(wrap, 1.35);

    vec3 col = base * (uShadow * 0.16 + uLit * light * 0.92);

    // Forward scattering along the terminator: the classic warm rim on a lit gas giant.
    float terminator = pow(1.0 - abs(ndl), 6.0) * smoothstep(-0.35, 0.25, ndl);
    col += vec3(1.0, 0.72, 0.52) * terminator * 0.2;

    // Rayleigh-ish limb: the atmosphere is denser at grazing angles.
    vec3 viewDir = normalize(-vec3(0.0, 0.0, 1.0));
    float fres = pow(1.0 - abs(dot(n, viewDir)), 3.0);
    col += uAtmo * fres * light * 0.22;

    // Night side keeps a trace of scattered light so it never becomes a black hole in frame.
    col += uShadow * 0.05;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorldNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    // See PLANET_VERT: the rim term below is view-space and stays that way; only the sun dot
    // moves to world space.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
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
    float ndl = dot(normalize(vWorldNormal), uSunDir);
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
        uPower: { value: 2.4 },
        uStrength: { value: 0.42 },
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
    // The ring shadow test runs in world space, so it needs the body's world centre.
    if (this.ringMat) this.ringMat.uniforms.uPlanetCenter.value.copy(body.position);
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
        uPlanetCenter: { value: new THREE.Vector3() },
        uPlanetRadius: { value: radius },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          // World space outright: the sun dot at the bottom of the fragment shader is this
          // varying's only consumer, so there is no view-space term to preserve here.
          vNormal = normalize(mat3(modelMatrix) * normal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        uniform vec3 uSunDir;
        uniform vec3 uWarm;
        uniform vec3 uCool;
        uniform vec3 uPlanetCenter;
        uniform float uPlanetRadius;

        ${GLSL_NOISE}

        void main() {
          float t = vUv.x;
          // Sharp gaps plus fine structure: rings read as billions of particles, not a decal.
          float coarse = fbm(vec3(t * 26.0, 0.0, 0.0), 4) * 0.5 + 0.5;
          float fine = fbm(vec3(t * 165.0, 3.7, 0.0), 3) * 0.5 + 0.5;
          // A 165x radial frequency compresses to a couple of pixels at grazing angles and
          // aliases into crawling moire. Dissolve it toward its own mean as the footprint
          // grows — the standard fix, and it costs one fwidth.
          fine = mix(0.5, fine, 1.0 - smoothstep(0.0015, 0.009, fwidth(t)));
          float density = smoothstep(0.28, 0.72, coarse) * (0.55 + fine * 0.45);
          density *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.86, 1.0, t));
          // A couple of hard divisions.
          density *= 1.0 - smoothstep(0.30, 0.33, t) * (1.0 - smoothstep(0.36, 0.39, t));

          // The planet's shadow falling across its own rings. Ray-march from this fragment
          // toward the star and test the planet sphere: two lines, and it is the single cue
          // that separates "rings" from "a decal painted round a ball" — everyone has seen
          // the Cassini photographs even if they could not name what is missing.
          vec3 rel = vWorldPos - uPlanetCenter;
          float bq = dot(rel, uSunDir);
          float cq = dot(rel, rel) - uPlanetRadius * uPlanetRadius;
          float disc = bq * bq - cq;
          // Softened by how deeply the ray passes inside the limb, giving a penumbra.
          float shadow = (bq < 0.0) ? smoothstep(-0.04, 0.12, disc / (uPlanetRadius * uPlanetRadius)) : 0.0;

          float ndl = abs(dot(normalize(vNormal), uSunDir));
          vec3 col = mix(uCool, uWarm, fine) * (0.25 + ndl * 1.05);
          col *= mix(1.0, 0.1, shadow);
          // Pulled down so the rings stop out-competing the star for attention when they sit
          // in a corner of the frame.
          gl_FragColor = vec4(col * density * 0.86, density * 0.92);
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
