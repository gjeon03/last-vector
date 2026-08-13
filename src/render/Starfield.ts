import * as THREE from 'three';
import { Rng } from '../core/rng.ts';

/**
 * Stars stay as real points rather than being baked into the nebula cube map, because points
 * survive at any resolution and can twinkle. Colour follows a rough stellar temperature
 * distribution — mostly cool red dwarfs, a few blue-white giants — which reads as depth even
 * though every star is at the same radius.
 */

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uPixelScale;
  uniform float uTime;
  varying vec3 vColor;
  varying float vBright;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Scintillation: slow, per-star, and shallow. Enough to feel alive, never sparkly.
    float tw = 0.82 + 0.18 * sin(uTime * (0.6 + fract(aPhase) * 1.4) + aPhase * 43.0);
    // Points smaller than about a pixel alias into hard saturated dots, which is why a naive
    // starfield looks like RGB confetti. Clamp the size and pay the energy back in intensity
    // so faint stars stay faint instead of becoming bright single pixels.
    float size = aSize * uPixelScale * tw;
    // A star narrower than the chromatic-aberration offset loses its red and blue samples to
    // neighbouring texels and survives as a pure green dot. Two and a half pixels is the
    // smallest footprint that stays achromatic through the whole post chain.
    float clamped = max(size, 2.5);
    vBright = tw * min(1.0, (size * size) / (clamped * clamped));
    vColor = aColor;
    gl_PointSize = clamped;
  }
`;

const STAR_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vBright;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // Tight core with a soft halo; the halo is what the bloom chain latches onto. The core is
    // deliberately soft enough to span more than one pixel — a hard one-pixel core aliases and
    // shatters under any lens effect.
    float core = exp(-r * r * 4.2);
    float halo = exp(-r * r * 1.5) * 0.4;
    float a = core + halo;
    gl_FragColor = vec4(vColor * a * vBright * 1.7, a);
  }
`;

/** Kelvin -> approximate linear RGB, normalised so the brightest channel is 1. */
function blackBody(kelvin: number, out: THREE.Color): THREE.Color {
  const t = kelvin / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out.setRGB(
    Math.min(1, Math.max(0, r / 255)),
    Math.min(1, Math.max(0, g / 255)),
    Math.min(1, Math.max(0, b / 255)),
    THREE.LinearSRGBColorSpace,
  );
  return out;
}

export class Starfield {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;

  constructor(count: number, radius: number, seed = 1337) {
    this.capacity = count;
    const rng = new Rng(seed);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);

    const dir = { x: 0, y: 0, z: 0 };
    const colour = new THREE.Color();
    const bandAxis = new THREE.Vector3(0.18, 1.0, -0.32).normalize();

    for (let i = 0; i < count; i++) {
      // Bias two thirds of the stars toward the galactic band so the sky has structure.
      rng.onSphere(dir);
      if (i % 3 !== 0) {
        const pull = rng.range(0.35, 0.95);
        const dot = dir.x * bandAxis.x + dir.y * bandAxis.y + dir.z * bandAxis.z;
        dir.x -= bandAxis.x * dot * pull;
        dir.y -= bandAxis.y * dot * pull;
        dir.z -= bandAxis.z * dot * pull;
        const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
        dir.x /= len;
        dir.y /= len;
        dir.z /= len;
      }

      positions[i * 3] = dir.x * radius;
      positions[i * 3 + 1] = dir.y * radius;
      positions[i * 3 + 2] = dir.z * radius;

      // Log-uniform magnitude: a very few bright anchors, a great many faint ones.
      const m = Math.pow(rng.next(), 3.1);
      sizes[i] = 0.55 + m * 4.6;

      const kelvin = rng.bool(0.72) ? rng.range(2600, 5200) : rng.range(6200, 22000);
      blackBody(kelvin, colour);
      // Faint stars are perceived as colourless; only the bright anchors carry hue.
      colour.lerp(new THREE.Color(0.86, 0.9, 1.0), 1 - Math.pow(m, 0.55));
      const intensity = 0.3 + m * 0.8;
      colors[i * 3] = colour.r * intensity;
      colors[i * 3 + 1] = colour.g * intensity;
      colors[i * 3 + 2] = colour.b * intensity;

      phases[i] = rng.range(0, 100);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -100;
  }

  /** Quality scaling: stars are allocated once and the draw range is trimmed. */
  setVisibleCount(count: number): void {
    const n = Math.max(1, Math.min(this.capacity, Math.floor(count)));
    this.object.geometry.setDrawRange(0, n);
  }

  /** Point size is in device pixels, so it has to track the drawing-buffer height. */
  setViewportHeight(pixels: number): void {
    this.material.uniforms.uPixelScale.value = Math.max(0.6, pixels / 1080);
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
