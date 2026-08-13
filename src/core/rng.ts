/**
 * Deterministic randomness. Every procedural asset in the game is generated from a seed so
 * a course looks identical on every machine and headless screenshots are reproducible.
 */

/** mulberry32 — small, fast, good enough distribution for content generation. */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** 0 <= x < 1 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive));
  }

  /** Symmetric about zero. */
  signed(magnitude = 1): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)];
  }

  /** Approximately normal via the sum of three uniforms; cheap and adequate for scatter. */
  gaussian(mean = 0, deviation = 1): number {
    const u = this.next() + this.next() + this.next() - 1.5;
    return mean + u * 1.1547 * deviation;
  }

  /** Uniform point on the unit sphere. */
  onSphere(out: { x: number; y: number; z: number }): void {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
    out.z = z;
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0);
  }
}

/** Hash a string into a seed so course names double as reproducible seeds. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Classic value-noise gradient hash, used by CPU-side mesh displacement. */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Value noise in 3D. Smooth, cheap, and stable — used for asteroid displacement. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);

  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);

  const x00 = lerp(c000, c100, xf);
  const x10 = lerp(c010, c110, xf);
  const x01 = lerp(c001, c101, xf);
  const x11 = lerp(c011, c111, xf);

  return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf) * 2 - 1;
}

/** Fractal Brownian motion over `noise3`. */
export function fbm3(x: number, y: number, z: number, octaves = 4, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(fx, fy, fz) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    fz *= lacunarity;
  }
  return sum / norm;
}
