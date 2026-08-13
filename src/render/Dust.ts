import * as THREE from 'three';
import { Rng } from '../core/rng.ts';

/**
 * Near-field particulate. This is the single most important speed cue in the game: without
 * something passing close to the camera, 400 m/s and 900 m/s look identical against a sky.
 *
 * The particle cloud is a fixed set of positions wrapped modulo a box that follows the ship,
 * so density is constant and infinite at zero CPU cost. Each particle is drawn as a line
 * stretched backwards along the velocity vector, which turns speed into visible streaks
 * rather than a snowstorm.
 */

const DUST_VERT = /* glsl */ `
  attribute float aEnd;
  attribute float aSeed;

  uniform vec3 uOrigin;
  uniform vec3 uVelocity;
  uniform float uBoxSize;
  uniform float uStretch;
  uniform float uSpeed;

  varying float vFade;
  varying float vSeed;

  void main() {
    float half = uBoxSize * 0.5;
    // Wrap the static point into the box currently centred on the ship.
    vec3 world = uOrigin - half + mod(position - uOrigin + half, vec3(uBoxSize));

    float toCentre = length(world - uOrigin);
    // Fade out at the box boundary so wrapped particles never pop into view.
    float edge = 1.0 - smoothstep(half * 0.62, half * 0.98, toCentre);
    // ...and fade the ones that would be inside the cockpit.
    float near = smoothstep(3.0, 26.0, toCentre);

    vec3 trail = -uVelocity * uStretch;
    world += trail * aEnd;

    vFade = edge * near;
    vSeed = aSeed;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  precision highp float;
  varying float vFade;
  varying float vSeed;
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    if (vFade <= 0.001) discard;
    float tint = 0.75 + fract(vSeed * 7.13) * 0.5;
    gl_FragColor = vec4(uColor * tint, vFade * uOpacity);
  }
`;

export class DustField {
  readonly object: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly boxSize: number;
  private readonly velocity = new THREE.Vector3();

  constructor(count: number, boxSize = 900, seed = 4242) {
    this.boxSize = boxSize;
    const rng = new Rng(seed);

    const positions = new Float32Array(count * 6);
    const ends = new Float32Array(count * 2);
    const seeds = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      const x = rng.range(0, boxSize);
      const y = rng.range(0, boxSize);
      const z = rng.range(0, boxSize);
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = z;
      ends[i * 2] = 0;
      ends[i * 2 + 1] = 1;
      const s = rng.next();
      seeds[i * 2] = s;
      seeds[i * 2 + 1] = s;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uVelocity: { value: new THREE.Vector3() },
        uBoxSize: { value: boxSize },
        uStretch: { value: 0.02 },
        uSpeed: { value: 0 },
        uColor: { value: new THREE.Color(0x9fc8ff) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
  }

  /**
   * @param stretchScale seconds of travel each streak represents; ramp it with boost so the
   *   frame visibly tears when the drive lights.
   */
  update(shipPosition: THREE.Vector3, shipVelocity: THREE.Vector3, stretchScale: number, opacity: number): void {
    const u = this.material.uniforms;
    u.uOrigin.value.copy(shipPosition);
    this.velocity.copy(shipVelocity);
    u.uVelocity.value.copy(this.velocity);
    u.uStretch.value = stretchScale;
    u.uSpeed.value = this.velocity.length();
    u.uOpacity.value = opacity;
  }

  get size(): number {
    return this.boxSize;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
