/**
 * Relay Harvest tuning shared by state, objective, renderer, and focused contracts.
 *
 * Cell positions are generated from the mission flight path and asteroid field by
 * `RelayHarvestState`; there is intentionally no authored socket/layout catalogue.
 */
export const RELAY_HARVEST_ACTIVE_SOURCE_COUNT = 10;
export const RELAY_HARVEST_REQUIRED_SOURCE_COUNT = 10;
export const RELAY_HARVEST_CHARGE_PER_SOURCE = 10;
export const RELAY_HARVEST_CHARGE_REQUIRED = 100;

/** A pickup fills the ship's 0..100 boost reserve. */
export const RELAY_HARVEST_BOOST_REWARD = 100;
/** Cell-centre reach before adding the ship's collision radius. */
export const RELAY_HARVEST_PICKUP_RADIUS = 70;
export const RELAY_HARVEST_SHIP_RADIUS = 9;
/** Effective swept pickup radius retained under the old name for callers of the helper. */
export const RELAY_HARVEST_CAPTURE_RADIUS =
  RELAY_HARVEST_PICKUP_RADIUS + RELAY_HARVEST_SHIP_RADIUS;
/** Relay-centre reach before adding the ship's collision radius. */
export const RELAY_HARVEST_EXTRACT_RADIUS = 320;
export const RELAY_HARVEST_RELAY_CAPTURE_RADIUS =
  RELAY_HARVEST_EXTRACT_RADIUS + RELAY_HARVEST_SHIP_RADIUS;

export const RELAY_HARVEST_CELL_LIFETIME = 38;
export const RELAY_HARVEST_RETURN_MINIMUM_SECONDS = 22;
export const RELAY_HARVEST_RETURN_PACE = 1.2;

/** Enough deterministic positions for the opening field, every possible pickup, and slack. */
export const RELAY_HARVEST_PREGENERATED_POSITION_COUNT =
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT + RELAY_HARVEST_REQUIRED_SOURCE_COUNT + 4;
export const RELAY_HARVEST_PLACEMENT_ATTEMPTS = 28;
export const RELAY_HARVEST_MIN_SOURCE_SEPARATION = 900;
export const RELAY_HARVEST_REQUIRED_ROCK_CLEARANCE = 140;
export const RELAY_HARVEST_MIN_PATH_FRACTION = 0.08;
export const RELAY_HARVEST_MAX_PATH_FRACTION = 0.92;
export const RELAY_HARVEST_MIN_CHANNEL_MULTIPLIER = 1.12;
export const RELAY_HARVEST_MAX_CHANNEL_MULTIPLIER = 1.8;
