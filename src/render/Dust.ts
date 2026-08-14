import * as THREE from 'three';
import { Rng } from '../core/rng.ts';

/**
 * Near-field particulate. This is the single most important speed cue in the game: without
 * something passing close to the camera, 400 m/s and 900 m/s look identical against a sky.
 *
 * The cloud is a fixed set of positions wrapped modulo a box that follows the ship, so density
 * is constant and effectively infinite at zero CPU cost.
 *
 * Each mote is a camera-facing quad stretched along the velocity vector — not a line. Lines
 * are exactly one pixel wide, which means they alias, they shimmer, and any lens effect
 * downstream (chromatic aberration, in this case) shatters them into coloured confetti. A
 * quad with a soft alpha falloff survives all of that and reads as motion instead of noise.
 */

const DUST_VERT = /* glsl */ `
  attribute vec2 aCorner;
  attribute float aSeed;

  uniform vec3 uOrigin;
  uniform vec3 uVelocity;
  uniform vec3 uCameraPos;
  uniform float uBoxSize;
  uniform float uStretch;
  uniform float uWidth;

  varying vec2 vCorner;
  varying float vFade;
  varying float vSeed;

  void main() {
    float halfBox = uBoxSize * 0.5;
    // Wrap the static point into the box currently centred on the ship.
    vec3 centre = uOrigin - halfBox + mod(position - uOrigin + halfBox, vec3(uBoxSize));

    float toCentre = length(centre - uOrigin);
    // Only genuinely near-field motes are drawn: streaks hundreds of metres out read as a
    // warp tunnel rather than as dust, and they bury the scene behind them.
    float edge = 1.0 - smoothstep(halfBox * 0.06, halfBox * 0.24, toCentre);
    float near = smoothstep(5.0, 30.0, toCentre);
    vFade = edge * near;

    float speed = length(uVelocity);
    vec3 dir = speed > 0.001 ? uVelocity / speed : vec3(0.0, 0.0, 1.0);
    // No fixed floor: at rest a mote is a point, not a dash. A minimum length turned the
    // low-speed vantages into a field of uniform tally marks.
    float streak = max(speed * uStretch, uWidth * 1.2);

    vec3 view = normalize(uCameraPos - centre);
    vec3 side = cross(dir, view);
    float sideLen = length(side);
    side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);

    // aCorner.x runs -1 at the head to +1 at the tail; the mote trails behind its position.
    vec3 world = centre - dir * streak * (aCorner.x * 0.5 + 0.5) + side * aCorner.y * uWidth;

    vCorner = aCorner;
    vSeed = aSeed;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const DUST_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vCorner;
  varying float vFade;
  varying float vSeed;
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    if (vFade <= 0.002) discard;
    // Soft across the width, tapering to nothing at the tail.
    float across = 1.0 - abs(vCorner.y);
    float along = 1.0 - (vCorner.x * 0.5 + 0.5);
    float a = pow(across, 1.6) * pow(along, 0.8);
    float tint = 0.8 + fract(vSeed * 7.13) * 0.4;
    gl_FragColor = vec4(uColor * tint * a, a * vFade * uOpacity);
  }
`;

export class DustField {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly boxSize: number;
  private readonly capacity: number;

  constructor(count: number, boxSize = 900, seed = 4242) {
    this.boxSize = boxSize;
    this.capacity = count;
    const rng = new Rng(seed);

    const positions = new Float32Array(count * 4 * 3);
    const corners = new Float32Array(count * 4 * 2);
    const seeds = new Float32Array(count * 4);
    const indices = new Uint32Array(count * 6);

    // Corner layout: x = -1 head / +1 tail, y = -1 / +1 across.
    const cx = [-1, -1, 1, 1];
    const cy = [-1, 1, 1, -1];

    for (let i = 0; i < count; i++) {
      const x = rng.range(0, boxSize);
      const y = rng.range(0, boxSize);
      const z = rng.range(0, boxSize);
      const s = rng.next();
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v) * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        corners[(i * 4 + v) * 2] = cx[v];
        corners[(i * 4 + v) * 2 + 1] = cy[v];
        seeds[i * 4 + v] = s;
      }
      const base = i * 4;
      const io = i * 6;
      indices[io] = base;
      indices[io + 1] = base + 1;
      indices[io + 2] = base + 2;
      indices[io + 3] = base;
      indices[io + 4] = base + 2;
      indices[io + 5] = base + 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uVelocity: { value: new THREE.Vector3() },
        uCameraPos: { value: new THREE.Vector3() },
        uBoxSize: { value: boxSize },
        uStretch: { value: 0.02 },
        uWidth: { value: 0.24 },
        uColor: { value: new THREE.Color(0xa8c6ee) },
        uOpacity: { value: 0.18 },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
  }

  /**
   * @param stretchScale seconds of travel each streak represents; ramp it with boost so the
   *   frame visibly tears when the drive lights.
   */
  update(
    shipPosition: THREE.Vector3,
    shipVelocity: THREE.Vector3,
    cameraPosition: THREE.Vector3,
    stretchScale: number,
    opacity: number,
  ): void {
    const u = this.material.uniforms;
    u.uOrigin.value.copy(shipPosition);
    u.uVelocity.value.copy(shipVelocity);
    u.uCameraPos.value.copy(cameraPosition);
    u.uStretch.value = stretchScale;
    u.uOpacity.value = opacity;
  }

  /** Quality scaling: motes are allocated once and the draw range is trimmed. */
  setVisibleCount(count: number): void {
    const n = Math.max(1, Math.min(this.capacity, Math.floor(count)));
    this.object.geometry.setDrawRange(0, n * 6);
  }

  get size(): number {
    return this.boxSize;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
