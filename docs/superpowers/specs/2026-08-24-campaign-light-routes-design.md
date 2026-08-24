# LAST VECTOR — Campaign-Light Routes Design

Date: 2026-08-24
Status: Design direction approved; written specification awaiting review
Target branch: `codex/korean-english-localization`

## 1. Purpose

LAST VECTOR currently offers a polished single-route time trial. Its restart, result, rank,
split, and per-course PB loops are strong, but the player has no authored progression beyond
improving one record.

This design adds a small campaign arc without turning the game into an open world, RPG, or
content treadmill. The MVP contains two sequentially unlocked routes:

1. `CAIRN DRIFT` — the existing balanced route.
2. `NEEDLE GRAVE` — a shorter precision-and-timing sprint ending at `NADIR RELAY`.

Clearing CAIRN once unlocks NEEDLE. Rank and mastery goals never block progression.

## 2. Goals

- Give the first clear an immediate, understandable next objective.
- Preserve the current fair, deterministic time-trial and PB loop.
- Teach a second layer of mastery through braking, precision steering, and arrival timing.
- Reuse the current boot, world-generation, result, restart, localization, and accessibility
  systems where safe.
- Keep existing CAIRN behavior, copy, PBs, and default automation byte-for-byte or
  behaviorally equivalent.
- Create boundaries that can support a third route later without committing to a large
  campaign system now.

## 3. Non-goals

The MVP does not include:

- `HELIOS RUN` or more than two routes.
- Runtime world hot-swapping.
- A dedicated route-map screen.
- Ghosts, leaderboards, daily challenges, mutators, or seasonal content.
- Combat, enemies, weapons, loot, upgrades, XP, currencies, or stat progression.
- New touch-flight controls.
- A fully new sky renderer or a completely bespoke destination renderer.
- Duplicating the full regression matrix for every route.

## 4. Product Loop

The title screen gains a two-item route strip immediately above the primary run action.

```text
Title route strip
  -> route-specific briefing
  -> countdown and run
  -> result and progress update
  -> retry, next route, or route selection
```

### 4.1 Unlock rule

- `CAIRN DRIFT` is always available.
- `NEEDLE GRAVE` is available after one successful CAIRN finish.
- No rank, time, collision, or precision requirement can block NEEDLE.
- Unlockability is derived from predecessor completion; an independent `unlocked` boolean is
  not persisted.

### 4.2 Terminal actions

After the first successful CAIRN clear:

1. `NEXT ROUTE` / localized equivalent.
2. `RUN AGAIN`.
3. `ROUTE SELECT`.

After a NEEDLE clear:

1. `RUN AGAIN`.
2. `ROUTE SELECT`.

After a failure:

1. `RETRY`.
2. `ROUTE SELECT`.

The first unlock appears as a result-screen badge. It is not a blocking modal and does not add
another confirmation step.

### 4.3 Route selection UI

Two routes do not justify a dedicated map view. The title uses the existing segmented/radio
control conventions:

- Available routes are native keyboard-accessible controls.
- The selected route exposes an accessible selected state.
- A locked route remains focusable for discovery but cannot activate; its visible and accessible
  description explains that CAIRN must be cleared.
- Route state is never communicated by color alone.
- Selecting a route changes the title facts and the subsequent briefing.

A dedicated route map becomes appropriate only when the catalog reaches four or more routes, or
when route objectives no longer fit the title/briefing layout.

## 5. World Lifecycle

### 5.1 Chosen approach: boot-time route resolution

The active route is resolved before `Game` construction. Changing to another route persists the
selection and navigates to `?course=<course-id>`, allowing the normal loader and constructor path
to create exactly one complete world.

Same-route retries do not reload.

This approach preserves the existing invariant that `Course`, `AsteroidField`, `Terminus`, route
props, collision identities, camera vantages, and harness closures belong to one boot-built world.
It also prevents a partial runtime swap from silently contaminating PBs with mismatched geometry
or hazard state.

### 5.2 Resolution order

Resolution is explicit rather than a generic first-non-null chain:

1. If a `course` URL parameter is present, use it only when it is a known, effectively unlocked
   route. An unknown or locked URL value resolves directly to CAIRN with a diagnostic resolution
   reason; it does not consult the persisted selection.
2. If the URL parameter is absent, use the effective selected course only when it is known and
   unlocked.
3. Otherwise use `cairn-drift`.

- Effective progress is the monotonic merge of sanitized `sessionStorage` and `localStorage`
  campaign state. Clear and mastery booleans use logical OR, and rank uses the better valid rank.
  A valid session-selected course takes precedence over the persisted local selection.
- Tests unlock NEEDLE by installing valid progress before loading its URL; production does not
  expose a bypass query.
- `?seed=` continues to override a route's default seed.
- URL-selected debug seeds do not overwrite the player's normal selected route or PB identity.

### 5.3 Navigation failure

Progress and selected-route persistence happen before navigation. The store writes the same
sanitized state to `sessionStorage` as a tab-scoped reload handoff and attempts durable
`localStorage` persistence independently. If durable storage fails but the session handoff
succeeds, the newly unlocked route still works after reload in the current tab. If neither write
succeeds, the in-memory clear still counts for the current screen, but route navigation is not
attempted because the reloaded page could not authorize NEEDLE. If navigation itself fails after
at least one successful handoff, the title/result remains usable and displays a non-blocking
localized error.

### 5.4 Future upgrade trigger

Runtime swapping is reconsidered only if one of these becomes true:

- Measured route-change boot time exceeds 2.5 seconds on the supported baseline.
- Live route changes during a run become a product requirement.
- Four or more routes require a live 3D route browser.

## 6. Course Catalog

Route identity, authored geometry, world tuning, text keys, rank rules, and route-specific
mechanics move into frozen definitions.

```ts
type CourseId = 'cairn-drift' | 'needle-grave';
type RankLetter = 'S' | 'A' | 'B' | 'C' | 'D';

interface CourseDefinition {
  readonly id: CourseId;
  readonly order: number;
  readonly defaultSeed: number;
  readonly unlocks?: CourseId;

  readonly text: {
    readonly sectorKey: string;
    readonly destinationKey: string;
    readonly briefingKeys: readonly string[];
    readonly canonicalSector: string;
    readonly canonicalDestination: string;
  };

  readonly geometry: {
    readonly legs: readonly CourseLeg[];
    readonly gateRadius: number;
    readonly finalGateRadiusScale: number;
    readonly leadInMetres: number;
    readonly runOutSteps: number;
    readonly terminusStandoff: number;
  };

  readonly field: {
    readonly corridor: number;
    readonly spreadFraction: number;
    readonly minRadius: number;
    readonly maxRadius: number;
    readonly hazardCount: number;
    readonly hazardBand: number;
    readonly startKeepClearRadius: number;
    readonly gateKeepClearScale: number;
  };

  readonly rank: {
    readonly par: number | 'derived';
    readonly thresholds: Readonly<{ s: number; a: number; b: number; c: number }>;
    readonly sRequiresClean: boolean;
  };

  readonly vantages: readonly VantageDefinition[];
  readonly objectives: readonly ObjectiveId[];
  readonly shear?: ShearGateDefinition;
}
```

Exact TypeScript key types replace the illustrative `string` fields during implementation. The
catalog persists IDs, never localized display text.

### 6.1 CAIRN compatibility

The existing CAIRN legs and world constants are first moved into a definition without changing
their numeric values or order. CAIRN keeps:

- Its existing default/no-query behavior.
- Its canonical English telemetry names.
- Its localized title, briefing, and result copy.
- Its nine-gate course.
- Its derived rank formula and thresholds.
- Its vantages, props, hazard behavior, and PB key.

This compatibility extraction lands before NEEDLE content so regressions can be attributed
cleanly.

### 6.2 PB identity

Progress identity and record identity remain separate:

- Progress identity: stable `CourseId`.
- PB identity: `${courseId}-${seed}`.

Existing keys such as `cairn-drift-1337` remain valid. NEEDLE creates independent keys such as
`needle-grave-1337`. The existing best-time storage schema does not change.

CAIRN's catalog `defaultSeed` is the existing `hashSeed('cairn-drift-01')` result, carried over by
that expression rather than copied as a hand-typed numeric literal. `Course` composes its record
ID from `CourseDefinition.id`; it must not retain the current hard-coded `cairn-drift` prefix.
The default-key compatibility assertion therefore compares `cairn-drift-<resolved-default-seed>`,
while explicit historical keys such as `cairn-drift-1337` remain valid when that seed is supplied.

## 7. Campaign Progress

Campaign progress uses a separate, failure-tolerant store:

```ts
const PROGRESS_KEY = 'last-vector.progress.v1';

interface CourseProgress {
  readonly cleared: boolean;
  readonly clearedAt: number | null;
  readonly highestRank: RankLetter | null;
  readonly cleanClear: boolean;
  readonly precisionClear: boolean;
}

interface ProgressV1 {
  readonly version: 1;
  readonly selectedCourse: CourseId;
  readonly courses: Partial<Record<CourseId, CourseProgress>>;
}
```

### 7.1 Update rules

Progress updates after every successful finish, independently of whether the run sets a PB:

- `cleared` and `clearedAt` update on the first clear.
- `highestRank` keeps the best rank using an explicit rank ordering.
- `cleanClear` is logical OR with the existing `RunResult.cleanRun` value.
- `precisionClear` is logical OR with the run's precision result.
- Failure does not update course mastery or unlocks.

### 7.2 Precision definition

A precision clear requires every gate pass to have normalized offset `< 0.4`. This reuses the
existing clean-gate feedback band. It is not based on an average, so one poor gate cannot be
hidden by several centered passes.

`RunResult` gains the optional additive field `maxGateOffset?: number`, computed from the passes
of that run. Progress derives precision from this evidence rather than duplicating the gate
formula. Offset remains normalized by each gate's own authored radius; the wider final gate is
therefore intentionally a physically looser precision band while retaining the same normalized
feedback contract.

### 7.3 Migration and corruption handling

- If progress storage is absent and an existing `cairn-drift-*` PB exists, CAIRN is marked
  cleared. This inference is valid because best times are written only after successful finish.
- Historical rank, collision state, precision, and clear time remain unknown; they are not
  guessed.
- Unknown route IDs and malformed fields are discarded during sanitization.
- Storage exceptions fall back to in-memory progress for the session.
- A store version newer than the running code is treated as read-only rather than overwritten.

## 8. NEEDLE GRAVE

### 8.1 Route role

NEEDLE is a compact precision-and-timing sprint rather than a second long CAIRN:

- Six gates.
- Approximately 24–26 km.
- Intended skilled completion time: 45–55 seconds.
- No long recovery/cruise leg.
- Gates 1 and 2 teach the route without a moving barrier.
- Gates 3 through 6 introduce the route mechanic.

Its exact par is route data calibrated from deterministic clean runs. It does not blindly reuse
CAIRN's global length-derived par.

### 8.2 Visual identity

NEEDLE shares the far-sky renderer and content pipeline but uses a different route seed, lighting
grade, and near-field composition:

- Long needle-like wreckage and fractured antenna frames.
- Narrow silhouettes that visually reinforce precision flying.
- Dark violet structure with restrained red warning lights.
- Route-specific gate and relay accents without a second gate system.

The destination is `NADIR RELAY`. It reuses a parameterized Terminus renderer with distinct
lighting, markings, and authored attachments. It is a separate location in fiction without
requiring a wholly new destination engine.

### 8.3 SHEAR GATE

NEEDLE's only unique gameplay mechanic is a rotating aperture barrier.

```ts
interface ShearGateDefinition {
  /** Zero-based gameplay gate indices; [2,3,4,5] means UI gates 3–6. */
  readonly gates: readonly number[];
  readonly halfWidthRadians: number;
  readonly hubRadiusFraction: number;
  readonly angularSpeedRange: readonly [number, number];
  readonly aimOffsetFraction: number;
  readonly onBlocked: 'miss';
}
```

Initial authored range:

- Barrier half-width: approximately 22 degrees.
- Central hub radius: approximately 12% of the authored gate radius.
- Angular speed: 0.55–0.95 rad/s, deterministically derived per gate from route seed.
- Active zero-based indices: `[2, 3, 4, 5]`, displayed to players as gates 3–6.
- Clock: current run elapsed time, reset with every run.
- Blocked crossing: gate miss, no damage, gate remains available for recovery.

The barrier is one radial shutter arm attached to a central hub, not a two-sided diameter. Angle
zero is the gate's final rendered local `+X` axis after its normal alignment and authored bank; the
same precomputed gate-local basis drives rendering, collision, and autopilot. For a gate-local
crossing `(x, y)`, let `r = hypot(x, y)` and `theta = atan2(y, x)`. A crossing inside the aperture
is blocked when either:

- `r <= gate.radius * hubRadiusFraction`, or
- the wrapped angular distance from `theta` to the shutter phase is
  `<= halfWidthRadians`.

The per-gate initial phase, angular speed, and signed rotation direction are all derived once from
the route seed and gate index. The rendered arm and predicate call the same phase function.

The barrier check uses the already interpolated gate-plane crossing point and crossing time.
`Course` retains the previous sample's run time and evaluates the barrier at
`lerp(previousRunTime, runTime, crossingFraction)`, never at the current frame-end time. This keeps
pass/miss results invariant across fixed-step rates and frame boundaries. The mechanic does not
add a second continuous collision system or per-frame object allocation.

The rendered barrier must clearly expose its blocked sector and rotation direction before the
player commits. Color is not its only cue.

### 8.4 Autopilot

Autopilot and attract-mode steering must understand SHEAR in the same change that introduces the
mechanic. Their target shifts to `gate.radius * aimOffsetFraction` along the open direction
opposite the shutter phase, outside the central hub. A route is not complete if the shipped
deterministic pilot cannot finish it reliably.

## 9. Localization and Accessibility

- Route catalog data stores localization keys and canonical English telemetry separately.
- Korean and English catalogs include route names, destinations, briefings, lock explanations,
  objective labels, unlock feedback, and terminal actions.
- Proper nouns such as `NEEDLE GRAVE` and `NADIR RELAY` retain `lang="en"` treatment inside Korean
  UI.
- Route cards use native controls with selected, locked, and described states.
- Keyboard and W/S navigation follow existing front-end behavior.
- The route strip and primary action remain visible at 375×667 and 640×360; overflow uses the
  existing inner-scroll pattern.
- Route selection remains title-only. Entering briefing keeps the current locale lock boundary.
- A direct next-route reload carries the active run locale so another tab cannot change language
  between result and the next briefing.

## 10. Failure and Recovery

- Invalid or corrupt progress falls back to a sanitized CAIRN-first state.
- A locked or unknown route URL cannot create a partially authorized world.
- Storage failure preserves current-session unlocks in memory and never blocks a finished run.
- Route navigation failure leaves the current result/title actionable.
- A missing optional SHEAR definition yields an ordinary playable route rather than a broken
  gate.
- Invalid vantage gate indices fail construction with a precise authored-data error.
- SHEAR visual construction failure may fall back to static staggered aperture bars while keeping
  course completion possible.

## 11. Harness and Stable UI Contracts

Harness changes are additive and versioned. It exposes JSON-safe evidence for:

- Active course ID, seed, gate count, length, and resolution source.
- Course catalog order, selected state, clear state, and unlock state.
- Sanitized campaign progress.
- SHEAR phase/state for deterministic tests.
- A separate additive crossing history containing passes and misses, including
  `cleared: boolean` and `blockedBy: 'shear' | null`, without changing the existing pass-only gate
  history contract.
- A test-only progress installer used before page reload.
- A route URL resolver that returns a URL but does not navigate implicitly in driven mode.

Stable selectors include:

```text
[data-route="cairn-drift|needle-grave"]
[data-route-state="locked|available|cleared"]
[data-action="select-route|next-route|retry|route-select"]
[data-objective="first-clear|highest-rank|clean-clear|precision"]
[data-complete="0|1"]
```

Automation never selects controls by localized copy.

## 12. Verification Strategy

### 12.1 CAIRN regression

No-query CAIRN remains the primary full regression route. Existing course, gameplay,
localization, screenshot, perf, audio, and persistence checks continue to run without requiring a
second route.

The catalog extraction additionally proves that CAIRN's:

- Spine/gate signature.
- Gate count and course length.
- Default seed and PB key.
- Protected corridor and hazard bounds.
- Vantage subjects.
- Deterministic pilot result.

remain unchanged.

### 12.2 NEEDLE focused arm

NEEDLE receives focused coverage for:

- Locked deep-link fallback and valid unlocked boot.
- Progress migration, first clear, unlock, highest-rank, clean, and precision aggregation.
- Reload selection and locale continuity.
- Deterministic course and SHEAR signatures for fixed seed/time.
- Restart resetting SHEAR phase exactly.
- Gate miss/recovery behavior without damage.
- Deterministic pilot completion and representative manual control trace.
- PB separation from CAIRN.
- Route-specific Korean/English title, briefing, result, and objective copy.
- Title-strip keyboard/focus/mobile layout.
- One forward, one banked/SHEAR, one result, and one high-density cockpit capture.
- No late shader compile on first SHEAR reveal.
- Stable draw calls, triangle count, upload count, render scale, and frame-time budget.

The full aggregate is not duplicated for NEEDLE. Exact manifest IDs make the focused arm durable.

### 12.3 Initial SHEAR acceptance targets

- Zero per-frame allocations attributable to SHEAR state.
- No extra collision broad-phase.
- At most six additional draw calls and 2,000 additional triangles for all barriers.
- Deterministic state and rendered instance identity across quality settings.
- Deterministic pilot finishes the route cleanly.
- An uninformed timing trace is blocked often enough to communicate the mechanic, while the
  phase-aware pilot has zero blocked crossings.

Exact gameplay tuning thresholds are recorded before the first measurement and adjusted only
with captured evidence.

## 13. Delivery Sequence

1. Add course contracts, catalog, and progress store.
2. Move CAIRN constants into its definition and prove behavior preservation.
3. Add route resolution, title strip, locked state, and reload flow.
4. Add route-aware localized briefing/result data and progress aggregation.
5. Add NEEDLE geometry, world identity, and NADIR RELAY parameters.
6. Add SHEAR evaluation, rendering, and autopilot support together.
7. Add focused NEEDLE harness, regression, visual, and performance evidence.
8. Perform adversarial review and prepare the branch for user-approved integration; do not merge
   to `main` without explicit approval.

## 14. Success Criteria

The MVP is complete when:

- A new player can clear CAIRN, see NEEDLE unlock, and enter it without confusion.
- Existing CAIRN PBs remain readable and continue to scope by seed.
- Rank and mastery goals never block progression.
- NEEDLE feels materially different through shorter pacing, precision geometry, and SHEAR timing.
- Both routes remain deterministic and fair for PB comparison.
- Restart and retry remain immediate on the active route.
- Route changes never leave mixed world state or stale harness identity.
- Korean and English flows remain accessible and layout-safe.
- CAIRN's existing full regression remains green and NEEDLE's focused arm passes its route-specific
  contracts.

Post-release product evaluation should look for whether a first CAIRN clear leads to either a
NEEDLE selection or an immediate retry, and whether sessions commonly contain at least three
runs. The MVP does not add network analytics; these criteria are evaluated through playtests or a
separately approved privacy-conscious telemetry effort.

## 15. Accepted Trade-offs

- A route change shows the normal loader once.
- The MVP uses a title strip rather than a visual map.
- NEEDLE reuses the far-sky and destination rendering pipelines.
- High-level objectives are persisted, but detailed per-gate medal history is not.
- Testing is intentionally asymmetric: full CAIRN coverage, focused NEEDLE coverage.
- A third route is not promised until the two-route loop demonstrates replay value.
