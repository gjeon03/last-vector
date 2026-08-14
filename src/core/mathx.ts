import * as THREE from 'three';

/** Small numeric helpers shared across the simulation. Kept dependency-free and inlineable. */

/**
 * NaN-safe by construction. The naive form returns NaN unchanged, because `NaN < lo` and
 * `NaN > hi` are both false — so every "sanitise" that leaned on clamp silently passed a
 * non-finite value straight through to the renderer and the canvas API.
 */
export const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : lo;

export const clamp01 = (v: number): number =>
  Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : clamp01((v - a) / (b - a));

export const smoothstep = (edge0: number, edge1: number, v: number): number => {
  const t = invLerp(edge0, edge1, v);
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential approach. `tau` is the time in seconds to close
 * ~63% of the gap. Using this everywhere is what keeps the feel identical at 30 and 144 fps.
 */
export const damp = (current: number, target: number, tau: number, dt: number): number => {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
};

/** Removes stick/mouse jitter without introducing a hard step at the deadzone edge. */
export const deadzone = (v: number, dz: number): number => {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
};

/** Keeps low inputs precise and high inputs responsive. */
export const expo = (v: number, amount: number): number => {
  const a = clamp01(amount);
  return v * (a * v * v + (1 - a));
};

const segScratch = new THREE.Vector3();
const segScratchB = new THREE.Vector3();

/** Shortest distance from a point to the line segment a-b. */
export const distanceToSegment = (point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number => {
  segScratch.subVectors(b, a);
  const lenSq = segScratch.lengthSq();
  if (lenSq < 1e-6) return point.distanceTo(a);
  segScratchB.subVectors(point, a);
  const t = clamp01(segScratchB.dot(segScratch) / lenSq);
  segScratchB.copy(a).addScaledVector(segScratch, t);
  return point.distanceTo(segScratchB);
};
