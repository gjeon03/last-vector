import * as THREE from 'three';
import { GLSL_NOISE } from './glslNoise.ts';
import { PALETTE } from '../core/art.ts';

/**
 * The sky of THE CAIRN DRIFT.
 *
 * The nebula is a genuinely 3D solid function evaluated along the view direction, then baked
 * once into a cube map with a CubeCamera. Baking is the whole trick: it buys a shader far too
 * expensive to run per-frame (domain-warped, ridged, multi-layer, star-lit) for the cost of a
 * single cube lookup at runtime, and because it is a solid function there is no seam or pole
 * distortion anywhere.
 */

const NEBULA_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;

  uniform vec3 uSunDir;
  uniform vec3 uDeep;
  uniform vec3 uTeal;
  uniform vec3 uIndigo;
  uniform vec3 uMagenta;
  uniform vec3 uDust;
  uniform vec3 uStarGlow;
  uniform float uSeed;
  uniform int uOctaves;

  ${GLSL_NOISE}

  void main() {
    vec3 d = normalize(vDir);
    vec3 p = d * 2.4 + uSeed;

    // Domain warp. Two levels: the first bends the large masses, the second frays the edges
    // so the clouds have wisps instead of blobby silhouettes.
    vec3 w1 = vec3(fbm(p + 0.0, 4), fbm(p + 5.2, 4), fbm(p + 9.7, 4));
    vec3 w2 = vec3(fbm(p * 2.1 + w1 * 1.6 + 1.7, 3),
                   fbm(p * 2.1 + w1 * 1.6 + 8.3, 3),
                   fbm(p * 2.1 + w1 * 1.6 + 3.1, 3));
    vec3 q = p + w1 * 1.25 + w2 * 0.45;

    float base = fbm(q, uOctaves) * 0.5 + 0.5;
    float fil = ridged(q * 1.85 + 3.3, uOctaves);

    // A broad galactic band gives the sky an axis, which is what makes a sky feel like a
    // place rather than a random cloud.
    float band = exp(-pow(abs(dot(d, normalize(vec3(0.18, 1.0, -0.32)))) * 2.35, 2.0));

    float density = base * 0.62 + fil * 0.55;
    density *= mix(0.42, 1.0, band);
    density = smoothstep(0.22, 0.92, density);

    // Dust lanes subtract, and they use a different noise frequency so they cut across the
    // gas instead of following it.
    float dust = smoothstep(0.44, 0.86, fbm(q * 1.28 + 17.4, 5) * 0.5 + 0.5);
    density *= 1.0 - dust * 0.72;

    // Colour by density and by proximity to the star: gas near the light source scatters warm.
    float sunDot = max(dot(d, uSunDir), 0.0);
    float nearStar = pow(sunDot, 5.0);

    vec3 col = mix(uIndigo, uTeal, smoothstep(0.15, 0.75, base));
    col = mix(col, uMagenta, smoothstep(0.55, 1.0, fil) * 0.75);
    col = mix(col, uDust, dust * 0.55);
    col *= density;

    // Forward-scattering halo: the whole sky brightens toward the star, and the gas in front
    // of it glows through. This single term does most of the atmosphere work.
    col += uStarGlow * (nearStar * 0.55 + pow(sunDot, 22.0) * 1.6) * (0.28 + density * 1.5);
    col += uStarGlow * pow(sunDot, 2.0) * 0.035;

    // Deep space floor, slightly blue-shifted away from the star so the frame has a cool side.
    float away = 1.0 - sunDot;
    col += uDeep * (0.55 + away * 0.75);

    // A faint far-field of unresolved stars: stops the empty regions reading as flat black.
    float grain = fbm(d * 220.0, 3) * 0.5 + 0.5;
    col += vec3(0.05, 0.06, 0.085) * pow(grain, 5.0) * 1.8;

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

const NEBULA_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface NebulaOptions {
  resolution: number;
  octaves: number;
  seed: number;
  sunDirection: THREE.Vector3;
}

/**
 * Bakes the nebula and returns a cube texture ready to be used as `scene.background`.
 * The caller owns the returned render target and must dispose it.
 */
export function bakeNebula(
  renderer: THREE.WebGLRenderer,
  options: NebulaOptions,
): { texture: THREE.CubeTexture; target: THREE.WebGLCubeRenderTarget } {
  const target = new THREE.WebGLCubeRenderTarget(options.resolution, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: options.sunDirection.clone().normalize() },
      uDeep: { value: new THREE.Color(PALETTE.voidFar).multiplyScalar(0.55) },
      uTeal: { value: new THREE.Color(PALETTE.nebulaTeal).multiplyScalar(0.34) },
      uIndigo: { value: new THREE.Color(PALETTE.nebulaIndigo).multiplyScalar(0.3) },
      uMagenta: { value: new THREE.Color(PALETTE.nebulaMagenta).multiplyScalar(0.26) },
      uDust: { value: new THREE.Color(PALETTE.nebulaDust).multiplyScalar(0.55) },
      uStarGlow: { value: new THREE.Color(PALETTE.starGlow).multiplyScalar(0.5) },
      uSeed: { value: options.seed },
      uOctaves: { value: options.octaves },
    },
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const camera = new THREE.CubeCamera(0.1, 10, target);
  const prevTarget = renderer.getRenderTarget();
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  camera.update(renderer, scene);
  renderer.toneMapping = prevToneMapping;
  renderer.setRenderTarget(prevTarget);

  mesh.geometry.dispose();
  material.dispose();

  return { texture: target.texture, target };
}
