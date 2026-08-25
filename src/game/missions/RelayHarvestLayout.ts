export const RELAY_HARVEST_AUTHORED_SOCKET_COUNT = 12;
export const RELAY_HARVEST_ACTIVE_SOURCE_COUNT = 5;
export const RELAY_HARVEST_REQUIRED_SOURCE_COUNT = 3;
export const RELAY_HARVEST_CHARGE_PER_SOURCE = 20;
export const RELAY_HARVEST_CHARGE_REQUIRED = 60;
export const RELAY_HARVEST_BOOST_REWARD = 25;
export const RELAY_HARVEST_CAPTURE_RADIUS = 220;

export type RelayHarvestBand = 'near' | 'mid' | 'far';

export interface RelayHarvestSocketDefinition {
  readonly index: number;
  readonly id: string;
  readonly band: RelayHarvestBand;
  /** Launch-local metres. Positive values are to the ship's right. */
  readonly right: number;
  /** Launch-local metres. Positive values are above the ship. */
  readonly up: number;
  /** Launch-local metres along the ship's initial forward vector. */
  readonly forward: number;
}

export interface RelayHarvestReferenceRoute {
  readonly sourceIds: readonly [string, string, string];
  readonly distanceMetres: number;
  readonly referenceSeconds: number;
  readonly noBoostSeconds: number;
  readonly maximumTurnDegrees: number;
}

export interface RelayHarvestLayout {
  readonly index: number;
  readonly signature: string;
  readonly socketIndices: readonly [number, number, number, number, number];
  readonly sockets: readonly [
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
  ];
  /** The two fastest distinct authored reference routes used by the finite-catalog validator. */
  readonly referenceRoutes: readonly [RelayHarvestReferenceRoute, RelayHarvestReferenceRoute];
}

const socket = (
  index: number,
  id: string,
  band: RelayHarvestBand,
  right: number,
  up: number,
  forward: number,
): RelayHarvestSocketDefinition => Object.freeze({ index, id, band, right, up, forward });

/**
 * Twelve authored sockets, not random world coordinates. The launch-local catalogue is shared by
 * every run; a runtime layout only selects a validated 2 near / 2 mid / 1 far subset.
 */
export const RELAY_HARVEST_SOCKETS: readonly RelayHarvestSocketDefinition[] = Object.freeze([
  socket(0, 'CORE-N1', 'near', -4_500, -1_050, 7_600),
  socket(1, 'CORE-N2', 'near', 2_650, 1_350, 8_500),
  socket(2, 'CORE-N3', 'near', -2_300, 1_850, 10_100),
  socket(3, 'CORE-N4', 'near', 4_650, -1_650, 11_500),
  socket(4, 'CORE-M1', 'mid', -4_700, 850, 18_300),
  socket(5, 'CORE-M2', 'mid', 3_850, -2_050, 20_600),
  socket(6, 'CORE-M3', 'mid', -2_150, -2_200, 23_400),
  socket(7, 'CORE-M4', 'mid', 4_800, 2_100, 25_600),
  socket(8, 'CORE-F1', 'far', -3_550, 2_200, 32_200),
  socket(9, 'CORE-F2', 'far', 2_850, -2_350, 34_800),
  socket(10, 'CORE-F3', 'far', -4_850, -900, 37_100),
  socket(11, 'CORE-F4', 'far', 4_350, 1_450, 39_400),
]);

if (RELAY_HARVEST_SOCKETS.length !== RELAY_HARVEST_AUTHORED_SOCKET_COUNT) {
  throw new Error('BLACKOUT RELAY requires exactly twelve authored sockets');
}

const BAND_RANGES: Readonly<Record<RelayHarvestBand, readonly [number, number]>> = Object.freeze({
  near: Object.freeze([7_000, 12_000] as const),
  mid: Object.freeze([18_000, 26_000] as const),
  far: Object.freeze([32_000, 40_000] as const),
});
const MAX_REFERENCE_TURN_DEGREES = 55;
const MAX_REFERENCE_SECONDS = 60;
const MAX_NO_BOOST_SECONDS = 85;
const MAX_ROUTE_TIME_DELTA_SECONDS = 6;
const MIN_SOURCE_SEPARATION_METRES = 2_400;
const DEG_PER_RADIAN = 180 / Math.PI;

interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const LAUNCH: Point3 = Object.freeze({ x: 0, y: 0, z: 0 });
const LAUNCH_FORWARD: Point3 = Object.freeze({ x: 0, y: 0, z: 1 });

function pointOf(source: RelayHarvestSocketDefinition): Point3 {
  return { x: source.right, y: source.up, z: source.forward };
}

function subtract(to: Point3, from: Point3): Point3 {
  return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

function length(vector: Point3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function angleDegrees(a: Point3, b: Point3): number {
  const denominator = length(a) * length(b);
  if (denominator <= 1e-6) return 180;
  const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / denominator));
  return Math.acos(cosine) * DEG_PER_RADIAN;
}

function routeFor(
  first: RelayHarvestSocketDefinition,
  second: RelayHarvestSocketDefinition,
  third: RelayHarvestSocketDefinition,
): RelayHarvestReferenceRoute | null {
  const a = pointOf(first);
  const b = pointOf(second);
  const c = pointOf(third);
  const firstLeg = subtract(a, LAUNCH);
  const secondLeg = subtract(b, a);
  const thirdLeg = subtract(c, b);
  const turns = [
    angleDegrees(LAUNCH_FORWARD, firstLeg),
    angleDegrees(firstLeg, secondLeg),
    angleDegrees(secondLeg, thirdLeg),
  ];
  const maximumTurnDegrees = Math.max(...turns);
  const distanceMetres = length(firstLeg) + length(secondLeg) + length(thirdLeg);
  // These are conservative authored-reference models, not player physics. Turn settling prevents
  // the catalogue validator from treating a sharp zig-zag as equivalent to a straight boost line.
  // At cruise/boost speed the craft cannot pivot at the geometric waypoint. Roughly five
  // seconds for a 90° reversal accounts for yaw spool, the committed flight arc, and settling
  // the velocity vector; the previous 1 s estimate made impossible hairpins look dominant.
  const turnSettlingSeconds = turns.reduce((sum, turn) => sum + turn / 18, 0);
  const referenceSeconds = distanceMetres / 760 + turnSettlingSeconds;
  const noBoostSeconds = distanceMetres / 500 + turnSettlingSeconds;
  if (referenceSeconds >= MAX_REFERENCE_SECONDS || noBoostSeconds >= MAX_NO_BOOST_SECONDS) {
    return null;
  }
  return Object.freeze({
    sourceIds: Object.freeze([first.id, second.id, third.id]) as readonly [string, string, string],
    distanceMetres,
    referenceSeconds,
    noBoostSeconds,
    maximumTurnDegrees,
  });
}

function combinations<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, selected: T[]): void => {
    if (selected.length === size) {
      result.push(selected.slice());
      return;
    }
    for (let index = start; index <= values.length - (size - selected.length); index++) {
      selected.push(values[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

function sourceSeparation(a: RelayHarvestSocketDefinition, b: RelayHarvestSocketDefinition): number {
  return Math.hypot(a.right - b.right, a.up - b.up, a.forward - b.forward);
}

function validateSocket(source: RelayHarvestSocketDefinition): boolean {
  const bandRange = BAND_RANGES[source.band];
  return Number.isInteger(source.index)
    && source.index >= 0
    && source.index < RELAY_HARVEST_AUTHORED_SOCKET_COUNT
    && Number.isFinite(source.right)
    && Number.isFinite(source.up)
    && Number.isFinite(source.forward)
    && Math.abs(source.right) <= 5_000
    && Math.abs(source.up) <= 2_500
    && source.forward >= bandRange[0]
    && source.forward <= bandRange[1];
}

function referenceRoutesFor(
  selected: readonly RelayHarvestSocketDefinition[],
): readonly [RelayHarvestReferenceRoute, RelayHarvestReferenceRoute] | null {
  const routes: RelayHarvestReferenceRoute[] = [];
  for (const chosen of combinations(selected, RELAY_HARVEST_REQUIRED_SOURCE_COUNT)) {
    // Reference routes preserve forward-band order. Runtime remains free-flight; this ordering only
    // rejects catalogue entries whose plausible three-core choices require a >55 degree reversal.
    chosen.sort((a, b) => a.forward - b.forward || a.id.localeCompare(b.id));
    const route = routeFor(chosen[0]!, chosen[1]!, chosen[2]!);
    if (route) routes.push(route);
  }
  routes.sort((a, b) => a.referenceSeconds - b.referenceSeconds
    || a.sourceIds.join('.').localeCompare(b.sourceIds.join('.')));
  if (routes.length < 2) return null;
  // Consider every route before applying the authored turn ceiling. Otherwise an extremely short
  // >55° shortcut can be hidden from validation even though free flight still allows the player
  // to take it, leaving one dominant choice in a supposedly route-selecting layout.
  const fastest = routes[0]!;
  const practical = routes.find((route) =>
    route.maximumTurnDegrees <= MAX_REFERENCE_TURN_DEGREES);
  if (!practical
    || practical.referenceSeconds - fastest.referenceSeconds > MAX_ROUTE_TIME_DELTA_SECONDS) {
    return null;
  }
  const alternative = practical === fastest ? routes[1]! : practical;
  if (alternative.referenceSeconds - fastest.referenceSeconds > MAX_ROUTE_TIME_DELTA_SECONDS) {
    return null;
  }
  const chosenRoutes = [fastest, alternative].sort((a, b) =>
    a.referenceSeconds - b.referenceSeconds) as [RelayHarvestReferenceRoute, RelayHarvestReferenceRoute];
  return Object.freeze(chosenRoutes);
}

function createValidatedLayout(
  selected: readonly RelayHarvestSocketDefinition[],
): Omit<RelayHarvestLayout, 'index'> | null {
  if (selected.length !== RELAY_HARVEST_ACTIVE_SOURCE_COUNT || selected.some((source) => !validateSocket(source))) {
    return null;
  }
  const ids = new Set(selected.map((source) => source.id));
  const indices = new Set(selected.map((source) => source.index));
  if (ids.size !== selected.length || indices.size !== selected.length) return null;
  const counts = { near: 0, mid: 0, far: 0 };
  for (const source of selected) counts[source.band]++;
  if (counts.near !== 2 || counts.mid !== 2 || counts.far !== 1) return null;
  if (!selected.some((source) => source.right < 0)
    || !selected.some((source) => source.right > 0)
    || !selected.some((source) => source.up < 0)
    || !selected.some((source) => source.up > 0)) return null;
  for (let left = 0; left < selected.length; left++) {
    for (let right = left + 1; right < selected.length; right++) {
      if (sourceSeparation(selected[left]!, selected[right]!) < MIN_SOURCE_SEPARATION_METRES) {
        return null;
      }
    }
  }
  const referenceRoutes = referenceRoutesFor(selected);
  if (!referenceRoutes) return null;
  const ordered = selected.slice().sort((a, b) => a.index - b.index) as [
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
    RelayHarvestSocketDefinition,
  ];
  const socketIndices = ordered.map((source) => source.index) as [number, number, number, number, number];
  const signature = `rh1-${ordered.map((source) => source.id.replace('CORE-', '')).join('.')}`;
  return Object.freeze({
    signature,
    socketIndices: Object.freeze(socketIndices),
    sockets: Object.freeze(ordered),
    referenceRoutes,
  });
}

function buildValidatedCatalog(): readonly RelayHarvestLayout[] {
  const near = RELAY_HARVEST_SOCKETS.filter((source) => source.band === 'near');
  const mid = RELAY_HARVEST_SOCKETS.filter((source) => source.band === 'mid');
  const far = RELAY_HARVEST_SOCKETS.filter((source) => source.band === 'far');
  if (near.length !== 4 || mid.length !== 4 || far.length !== 4) {
    throw new Error('BLACKOUT RELAY authored sockets must be grouped 4 near / 4 mid / 4 far');
  }
  const validated: RelayHarvestLayout[] = [];
  for (const nearPair of combinations(near, 2)) {
    for (const midPair of combinations(mid, 2)) {
      for (const farSource of far) {
        const candidate = createValidatedLayout([...nearPair, ...midPair, farSource]);
        if (!candidate) continue;
        validated.push(Object.freeze({ ...candidate, index: validated.length }));
      }
    }
  }
  if (validated.length < 2 || validated.length > 144) {
    throw new Error(`BLACKOUT RELAY validated layout count is invalid: ${validated.length}`);
  }
  return Object.freeze(validated);
}

export const VALIDATED_RELAY_HARVEST_LAYOUTS = buildValidatedCatalog();

export function getRelayHarvestLayout(index: number): RelayHarvestLayout {
  if (!Number.isInteger(index) || index < 0 || index >= VALIDATED_RELAY_HARVEST_LAYOUTS.length) {
    throw new RangeError(`Invalid BLACKOUT RELAY layout index: ${String(index)}`);
  }
  return VALIDATED_RELAY_HARVEST_LAYOUTS[index]!;
}

/** Deterministic uint32 avalanche followed by a bounded catalogue lookup. */
export function selectRelayHarvestLayoutIndex(seed: number): number {
  let value = Number.isFinite(seed) ? seed >>> 0 : 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) % VALIDATED_RELAY_HARVEST_LAYOUTS.length;
}

export function nextRelayHarvestLayoutIndex(currentIndex: number, seed: number): number {
  const count = VALIDATED_RELAY_HARVEST_LAYOUTS.length;
  if (count < 2) return 0;
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < count
    ? currentIndex
    : selectRelayHarvestLayoutIndex(seed);
  const offset = 1 + (selectRelayHarvestLayoutIndex(seed ^ 0x9e3779b9) % (count - 1));
  return (current + offset) % count;
}

export function relayHarvestLayoutDebug(layout: RelayHarvestLayout): {
  readonly index: number;
  readonly signature: string;
  readonly sourceIds: readonly string[];
  readonly bandCounts: Readonly<Record<RelayHarvestBand, number>>;
  readonly referenceRoutes: readonly RelayHarvestReferenceRoute[];
} {
  const bandCounts = { near: 0, mid: 0, far: 0 };
  for (const source of layout.sockets) bandCounts[source.band]++;
  return {
    index: layout.index,
    signature: layout.signature,
    sourceIds: layout.sockets.map((source) => source.id),
    bandCounts: Object.freeze(bandCounts),
    referenceRoutes: layout.referenceRoutes,
  };
}
