/** Small numeric helpers shared across the simulation. Kept dependency-free and inlineable. */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

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

/** Signed value moved toward a target at a bounded rate. */
export const approach = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
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

export const TAU = Math.PI * 2;

export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? '+' : '-';
  const a = Math.abs(seconds);
  return `${sign}${a.toFixed(2)}`;
}

/** 4200 -> "4.20 km", 940 -> "940 m". Distances are a core readability affordance. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '--';
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  return `${Math.round(metres)} m`;
}
