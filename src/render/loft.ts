import * as THREE from 'three';

/**
 * Lofting: build a hull by sweeping a cross-section along a spine.
 *
 * Every hard-surface shape in the game (fuselage, nacelles, station spars) is made this way.
 * It gives smooth, controllable, genuinely three-dimensional forms out of a table of numbers,
 * which is the only practical route to a ship that does not look like stacked boxes when the
 * build has to stay asset-free.
 */

export interface LoftStation {
  /** Position along the spine, in local Z (negative is forward). */
  z: number;
  /** Half-width and half-height of the cross-section. */
  width: number;
  height: number;
  /** Superellipse exponent: 2 is an ellipse, higher values square the section off. */
  squareness: number;
  /** Vertical offset of the section centre, for a cambered or drooping nose. */
  offsetY?: number;
  /** Scales the lower half only — lets a hull be flat-bottomed and round-topped. */
  bottomScale?: number;
}

/** Superellipse point at angle `t` in [0, 1). */
function sectionPoint(
  station: LoftStation,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const a = t * Math.PI * 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const n = 2 / station.squareness;
  const x = Math.sign(c) * Math.pow(Math.abs(c), n) * station.width;
  let y = Math.sign(s) * Math.pow(Math.abs(s), n) * station.height;
  if (y < 0 && station.bottomScale !== undefined) y *= station.bottomScale;
  out.set(x, y + (station.offsetY ?? 0), station.z);
  return out;
}

export interface LoftOptions {
  stations: LoftStation[];
  /** Points around each cross-section. */
  radialSegments: number;
  /** Close the front and back with a fan. */
  capStart?: boolean;
  capEnd?: boolean;
}

export function loft(options: LoftOptions): THREE.BufferGeometry {
  const { stations, radialSegments: seg } = options;
  const rings = stations.length;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const scratch = new THREE.Vector3();

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j <= seg; j++) {
      sectionPoint(stations[i], (j % seg) / seg, scratch);
      positions.push(scratch.x, scratch.y, scratch.z);
      uvs.push(j / seg, i / (rings - 1));
    }
  }

  const stride = seg + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  if (options.capStart) {
    const centre = positions.length / 3;
    const s = stations[0];
    positions.push(0, s.offsetY ?? 0, s.z);
    uvs.push(0.5, 0);
    for (let j = 0; j < seg; j++) indices.push(centre, j + 1, j);
  }
  if (options.capEnd) {
    const centre = positions.length / 3;
    const s = stations[rings - 1];
    positions.push(0, s.offsetY ?? 0, s.z);
    uvs.push(0.5, 1);
    const base = (rings - 1) * stride;
    for (let j = 0; j < seg; j++) indices.push(centre, base + j, base + j + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A swept, tapered aerofoil-ish panel: root chord at the fuselage, tip chord outboard, with
 * sweep, dihedral and a thickness taper. Used for wings, canards and fins.
 */
export interface WingOptions {
  rootChord: number;
  tipChord: number;
  span: number;
  /** Metres the tip is pushed aft relative to the root. */
  sweep: number;
  /** Radians the panel is raised about the root. */
  dihedral: number;
  rootThickness: number;
  tipThickness: number;
  /** Shifts the whole panel along Z. */
  z: number;
  y: number;
  /** +1 for starboard, -1 for port. */
  side: number;
}

/** Symmetric NACA-00 thickness distribution, normalised so the peak is ~1. */
function foilThickness(s: number): number {
  const x = THREE.MathUtils.clamp(s, 0, 1);
  return (
    5 *
    (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
  );
}

export function buildWing(options: WingOptions): THREE.BufferGeometry {
  const half = 12;
  const seg = half * 2;
  const spanSteps = 7;
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];

  for (let s = 0; s <= spanSteps; s++) {
    const t = s / spanSteps;
    const chord = THREE.MathUtils.lerp(options.rootChord, options.tipChord, t);
    const thick = THREE.MathUtils.lerp(options.rootThickness, options.tipThickness, t);
    const x = options.side * Math.cos(options.dihedral) * options.span * t;
    const y = options.y + Math.sin(options.dihedral) * options.span * t;
    const zc = options.z + options.sweep * t;

    // The section is a closed loop: leading edge -> upper surface -> trailing edge ->
    // lower surface -> back to the leading edge.
    for (let j = 0; j <= seg; j++) {
      const upper = j <= half;
      const u = upper ? j / half : (seg - j) / half;
      const zAlong = zc - chord * 0.5 + u * chord;
      const yOff = (upper ? 1 : -1) * thick * foilThickness(u);
      positions.push(x, y + yOff, zAlong);
      uvs.push(u, t);
    }
  }

  const stride = seg + 1;
  for (let s = 0; s < spanSteps; s++) {
    for (let j = 0; j < seg; j++) {
      const a = s * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (options.side > 0) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }

  // Duplicate the cap rings so their normals stay perpendicular to the end planes instead of
  // being averaged with the wing skin. The section's final vertex duplicates its first, so each
  // fan only copies the `seg` unique points and wraps explicitly at the leading edge.
  const addCap = (spanStep: number, outwardX: number): void => {
    const t = spanStep / spanSteps;
    const thick = THREE.MathUtils.lerp(options.rootThickness, options.tipThickness, t);
    const x = options.side * Math.cos(options.dihedral) * options.span * t;
    const y = options.y + Math.sin(options.dihedral) * options.span * t;
    const zc = options.z + options.sweep * t;
    const sourceBase = spanStep * stride;
    const capBase = positions.length / 3;
    const uvHalfHeight = Math.max(Math.abs(thick), 1e-6);

    for (let j = 0; j < seg; j++) {
      const source = sourceBase + j;
      const px = positions[source * 3];
      const py = positions[source * 3 + 1];
      const pz = positions[source * 3 + 2];
      positions.push(px, py, pz);

      const upper = j <= half;
      const chordU = upper ? j / half : (seg - j) / half;
      const capV = THREE.MathUtils.clamp(0.5 + (py - y) / (2 * uvHalfHeight), 0, 1);
      uvs.push(chordU, capV);
    }

    const centre = positions.length / 3;
    positions.push(x, y, zc);
    uvs.push(0.5, 0.5);

    for (let j = 0; j < seg; j++) {
      const current = capBase + j;
      const next = capBase + ((j + 1) % seg);
      if (outwardX > 0) indices.push(centre, current, next);
      else indices.push(centre, next, current);
    }
  };

  addCap(0, -options.side);
  addCap(spanSteps, options.side);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
