# LAST VECTOR — Two-Chapter Energy Collection Campaign Design

- Date: 2026-08-26
- Status: Approved direction; written specification awaiting user review
- Product branch: `codex/flight-action-campaign`
- Preserved three-chapter integration: `c7581fe`

## 1. Product decision

LAST VECTOR ships exactly two active chapters for now:

1. `CAIRN DRIFT` — the existing nine-gate race.
2. `BLACKOUT RELAY` — a new energy-collection flight through a wrecked orbital power relay.

`LAST ASCENT` and `DEAD SIGNAL` are rejected product directions. They are removed from the active
catalog, runtime factories, UI, localization, product tests, and shipped bundle. Their existing Git
history remains recoverable through archive refs; none of their mission IDs, clear facts, PBs, or
presentation assets are reinterpreted as Chapter 02 progress.

The new chapter is not a reskin of LAST ASCENT. It has no shockfront, scripted escape corridor,
safe-corridor counter, weapon, target destruction, or extraction commute. Its play is spatial route
selection among simultaneously visible physical objectives.

## 2. Why the rejected chapters are removed

The LAST ASCENT build presents a large forward arrow over mostly empty space. Its planetary impact
is background dressing rather than a decision, and the mission's safe-corridor logic does not read
as a meaningful evasive route during normal play. It repeats the existing forward-flight grammar
without the gate race's legible targets and timing feedback.

DEAD SIGNAL adds a separate weapon grammar, facility targeting, and extraction sequence before the
campaign has established a strong second flight objective. Keeping that infrastructure would leave
always-present input, audio, UI, and runtime complexity for a rejected chapter.

The product therefore returns to a smaller rule: each chapter must introduce one immediately
readable spatial decision while preserving the same ship and flight feel.

## 3. Campaign structure

### Chapter 01 — CAIRN DRIFT

- Mission ID: `cairn-drift`
- Objective: clear nine gates in order and cross the terminus.
- World, path, timing, rank, clean-run, and precision behaviour remain unchanged.
- Clearing CAIRN unlocks Chapter 02.

### Chapter 02 — BLACKOUT RELAY

- New mission ID: `relay-harvest`.
- Objective kind: `collection`.
- Setting: a dead orbital power relay with broken collector rings, trusses, conduits, and structural
  apertures.
- Story premise: KESTREL-C7 must recover three live relay cores to restore a stable drive reserve.
- Target skilled clear: 45–60 seconds.
- Target first clear: 60–80 seconds.
- Failure: hull reaches zero. The MVP has no hard time-out.
- Rank and PB provide time pressure without turning exploration into another survival timer.

The public title is provisional presentation copy; the stable mission ID is deliberately new so an
old LAST ASCENT or DEAD SIGNAL clear cannot unlock, clear, or populate PB data for this mission.

## 4. Core play contract

Five energy sources are active and visible at the same time. The player may collect any three.

```text
active sources             5
required distinct sources  3
objective charge/source    20
clear threshold            60 / 100
boost reward/source        25% of capacity
collection radius          220 m ship-centre swept volume
terminal                   immediate on the third distinct collection
```

Objective charge is permanent mission state and is never the ship boost reserve. Spending boost
cannot reduce mission progress. The one-shot boost reward is capped by normal capacity and keeps
the existing authored-reward behaviour that can immediately re-enable boost above its engage
floor.

There is no final gate or return flight after the third collection. The interesting decision ends
when the threshold is reached, so completion and result presentation begin immediately.

A source can be collected only once. Collection uses swept segment-sphere intersection from the
previous to current ship pose so a high-speed pass cannot tunnel through the 220 m volume. When
multiple sources are crossed in one frame, time of impact and then stable source ID define order.

## 5. Why the visible count is fixed at five

The literal alternative of randomly showing three to five sources is rejected:

- A three-source layout makes every source mandatory and removes route choice.
- Different visible counts produce materially different difficulty and invalidate raw PB
  comparisons.
- UI goals and onboarding would change between attempts without adding meaningful flight skill.

The randomness is which five authored sockets become active, not how many objectives exist. Five
visible sources and a three-source threshold consistently provide two skips and therefore a real
route choice.

Risk-weighted sources and timed collection chains are deferred. They may become later mastery or
challenge contracts only after the equal-value loop is proven fun.

## 6. Layout generation, retry, and PB fairness

The relay contains twelve authored and validated socket positions. Uniform random world coordinates
and unbounded rejection sampling are forbidden.

Each new run selects five sockets through a dedicated layout seed. The selected layout must satisfy:

- finite coordinates and stable source IDs;
- two sources in a 7–12 km forward band;
- two sources in an 18–26 km forward band;
- one source in a 32–40 km forward band;
- lateral offsets within 5 km and vertical offsets within 2.5 km;
- no source behind the launch vector;
- a minimum 4 km collision-free approach cone per source;
- at least 500 m clearance from damaging structure surfaces;
- left/right and high/low choices in every accepted layout;
- no required leg turn greater than 55 degrees;
- at least two valid three-source routes whose reference times differ by no more than six seconds;
- a reference three-source route below 60 seconds and a no-boost route below 85 seconds.

The authored sockets form a finite layout catalog. With four sockets in each distance band and an
exact `2 near / 2 mid / 1 far` selection, there are at most 144 candidate layouts. Focused contracts
exhaustively validate the complete candidate catalog and ship only layouts that satisfy every
constraint above. Runtime selection indexes that validated catalog; it does not search, reject, or
retry coordinates during play.

Layout identity is resolved before `Game` reads a PB or creates a mission runtime. A launch
descriptor carries the mission ID, mission seed, validated layout index, layout signature, and
ruleset-partitioned record ID. Both persistence and the runtime consume this one descriptor.

Canonical collection URLs may include `layout=<validated-index>`:

- entering Chapter 02 without `layout` selects a valid index, writes it into the URL, then boots;
- a valid explicit index reproduces that layout exactly;
- an invalid index selects a valid layout with a diagnostic and canonicalizes the URL;
- failure `RETRY`, pause `RESTART`, and result `RUN AGAIN` retain the descriptor and layout;
- result `NEW LAYOUT` chooses an index different from the current one, writes it to the URL, and
  performs a full mission reload;
- chapter navigation omits `layout`, so a fresh Chapter 02 entry selects a new one.

This lets players learn a failed route, improve a same-layout PB after clearing, and deliberately
request new geometry without restart-fishing. `NEW LAYOUT` is guaranteed to differ when the catalog
contains more than one valid entry.

PB identity is `mission ruleset + mission seed + layout signature`. Raw seconds are compared only
for the same layout. Campaign clear, rank, and clean-run facts remain layout-independent.

Inactive authored sockets are not visible decoys and have no interaction. There is no arbitrary
"wrong socket" penalty; inefficient routing already costs time.

## 7. World and visual direction

BLACKOUT RELAY must read as a different place, not empty starfield with waypoint icons.

The world contains a bounded procedural relay structure:

- two or three broken collector arcs rather than a complete gate ring;
- large dark-metal truss arms and shattered solar collector fins;
- visible power conduits that lead toward authored socket regions;
- broad apertures and structural gaps that create line choice without requiring precision-gate
  traversal;
- a restrained field of damaging static debris used to shape routes, not increase density.

Energy sources are solid physical objects:

- approximately 80 m hard polyhedral core;
- rigid luminous cage or spikes that make the 220 m capture volume legible;
- a narrow long-range beacon;
- strong silhouette and emissive contrast at every quality level;
- no fog, mist, particle cloud, vague bloom-only blob, or dynamic point light.

Collection collapses the physical core inward, emits one hard flash and procedural audio hit, and
leaves a stable collected socket state. No geometry, material, texture, light, or shader program is
created or disposed during collection.

## 8. Guidance, HUD, audio, and controls

All five active sources have persistent small world markers and off-screen edge indicators. They
are numbered consistently for the layout. Only one primary source receives a large bracket and
distance readout. Primary selection uses angular/distance hysteresis so it does not flicker as the
ship crosses marker boundaries; steering deliberately toward another source can retarget it.

The collection HUD presents:

- `RELAY CHARGE 0/60` with a threshold at 60;
- `CORES 0/3`;
- the primary source ID and distance;
- quiet secondary source markers;
- elapsed time and same-layout PB comparison.

On pickup it presents exact objective and boost feedback, for example `CORE 02 ACQUIRED`,
`RELAY CHARGE 40/60`, and the existing boost refill response. It does not display a giant central
route arrow or five simultaneous large brackets.

Technical chrome remains English in Korean mode. Story, briefing, radio subtitles, guidance detail,
errors, and accessibility descriptions remain Korean. Sources are distinguished by shape, number,
position, and text rather than colour alone.

No TTS is added. Radio remains localized text with the existing procedural communication treatment.

With the strike chapter removed, the forward cannon and FIRE capability are removed from the
product. `LMB` returns to the existing boost alias, `Shift` remains boost, and `C` retains the
three-mode `chase -> cockpit -> far-chase -> chase` camera cycle.

## 9. Runtime architecture

The approved mission foundation is retained. The collection chapter adds one explicit objective
variant rather than mission-ID branches in `Game`.

```ts
interface CollectionSourceState {
  readonly id: string;
  readonly position: readonly [number, number, number];
  collected: boolean;
  collectedAt: number | null;
}

interface CollectionObjectiveTelemetry {
  readonly kind: 'collection';
  readonly collected: number;
  readonly required: 3;
  readonly activeTotal: 5;
  readonly charge: number;
  readonly chargeRequired: 60;
  readonly sources: readonly CollectionSourceTelemetry[];
}
```

Mission selection produces the immutable launch descriptor before constructing `Game`. PB lookup
is deferred until that descriptor exists; the collection runtime cannot silently substitute a
different layout. Telemetry and the test harness expose the validated layout index, signature, and
record ID so served-build evidence can prove which geometry it measured.

One factory-owned fixed-capacity source state is shared by the collection objective and renderer.
Sources are not `MissionWorldRuntime.contacts`: contacts apply hull damage, while pickup is a
non-damaging swept objective event. Static relay structure uses the ordinary bounded world-contact
path.

The collection objective owns source selection, swept collection, guidance, telemetry, terminal
success, and result construction. The collection world owns the relay render objects, damaging
static contacts, source presentation, quality changes, and disposal. `Game` only adapts common
mission rewards, audio events, telemetry, result presentation, and persistence.

The following rejected product code is removed rather than left dormant in the bundle:

- LAST ASCENT objective, world, HUD, pressure, shockfront, copy, CSS, and tests;
- DEAD SIGNAL objective, world, facility, weapon, target, extraction, copy, CSS, and tests;
- escape and strike result/telemetry variants with no remaining consumer;
- FIRE input capability, weapon event transport, weapon SFX, and LMB fire presentation.

The Git archive remains the recovery mechanism for those experiments.

## 10. Progress, URL, and navigation

The active order is exactly:

```text
cairn-drift -> relay-harvest
```

CAIRN is always available. BLACKOUT RELAY unlocks only after CAIRN is cleared. The title rail shows
exactly two chapters; it does not expose dormant stages, LAST ASCENT, or DEAD SIGNAL.

Canonical navigation uses `?mission=cairn-drift` and `?mission=relay-harvest`. Old
`?mission=last-ascent` and `?mission=dead-signal` URLs fail closed to CAIRN with a diagnostic. Old
selected IDs and rejected mission clear facts are ignored for active navigation while CAIRN facts
are preserved.

`pnpm dev` on the final working branch must open the complete two-chapter product directly. The user
must not switch worktrees or branches to test it. No merge to `main` is performed.

## 11. Performance contract

The energy-source subsystem has these hard ceilings:

- fixed capacity of five active source render states;
- at most three draw calls;
- at most three geometries and three materials;
- at most 5,000 triangles;
- no unique textures;
- no dynamic point lights;
- no per-frame DOM or gameplay-object allocation;
- matrix uploads only at construction, reset, or collection;
- no shader compilation or GPU resource allocation on collection.

The full scene retains the current campaign ceilings:

- 160 draw calls;
- 620,000 triangles;
- 155 geometries;
- 16 textures;
- 55 programs;
- no late shader compile/link work after presentation;
- approximately 60 fps at 1920x1080 DPR1 and the existing DPR2 fill budget.

Quality changes may reduce decorative relay detail but never active source count, marker visibility,
collection volume, socket position, or damaging collider shape.

## 12. Bounded verification

Verification is intentionally focused:

1. Fast layout contract exhaustively checks every candidate in the finite `2 near / 2 mid / 1 far`
   catalog: exactly five active IDs, deterministic positions, socket constraints, two competitive
   routes, and stable reset. It separately covers absent, minimum, maximum, and invalid URL indexes.
2. Swept collection contract whose frame endpoints miss but whose travel segment crosses a source:
   one pickup at 20, 60, and 120 Hz, no duplicate, correct third-source terminal.
3. Progress/navigation contract: exactly two missions, CAIRN-only initial state, clear-only unlock,
   rejected URLs fail closed, old rejected progress cannot clear Chapter 02, retry and `RUN AGAIN`
   retain the record ID, and `NEW LAYOUT` changes it before PB lookup.
4. Removal regression gate: `pnpm typecheck`, `pnpm build`, focused i18n/catalog contracts, shipped
   bundle absence of rejected runtime IDs, and a CAIRN 60/120 Hz production run with its locked path
   and gate signatures, clean result, hull, and error state unchanged.
5. Focused input contract proves LMB and Shift independently engage boost, both orders coexist,
   release and pointer-lock clearing are correct, and no FIRE capability or weapon feedback remains.
6. One focused production Chapter 02 run at 60 and 120 Hz: same layout and collection sequence,
   same outcome, hull remaining, no runtime errors.
7. One real UI journey through title, briefing, collection, result, retry, same-layout `RUN AGAIN`,
   and different-layout `NEW LAYOUT` at a normal desktop viewport plus one compact overflow check.
8. One hardest-scene performance run at DPR1 and DPR2, including the collection frame and resource
   stability.
9. A bounded direct-development smoke spawns `pnpm dev` from the checked-out product branch, waits
   for readiness, opens CAIRN and BLACKOUT RELAY through the two-node UI, then terminates the server.
10. Human and independent-critic review of title, live collection, and result screenshots before the
   mode is accepted.

Broad localization, gameplay, screenshot, and aggregate matrices are not rerun unless a focused
check reveals a shared regression.

## 13. Git and rejection strategy

Before product edits, create an archive ref at the current three-chapter integration commit
`c7581fe`. Continue on a new `codex/` product branch and leave it checked out for direct
`pnpm dev` testing.

Implementation is split into independently reviewable commits:

1. Archive and remove LAST ASCENT/DEAD SIGNAL product integration.
2. Add collection contracts, deterministic layouts, and swept objective logic.
3. Add the bounded relay world and solid source renderer.
4. Add Chapter 02 HUD, result, navigation, localization, and progress wiring.
5. Add focused evidence and final tuning fixes.

No commit combines rejected-chapter removal with the new objective implementation. If BLACKOUT
RELAY is rejected, it can be removed without restoring LAST ASCENT or DEAD SIGNAL. `main` remains
untouched throughout development.

## 14. Acceptance criteria

The chapter is accepted only when all are true:

- the product exposes exactly CAIRN DRIFT and BLACKOUT RELAY;
- the rejected chapters and their always-present infrastructure are absent from the shipped bundle;
- every run presents five solid, unmistakable sources and clears on any third distinct pickup;
- failed retry and `RUN AGAIN` keep the layout; `NEW LAYOUT` changes it;
- objective charge never changes when boost is spent;
- the player can identify at least two plausible routes within three seconds of launch;
- no valid layout forces a backtrack or places a source behind the launch direction;
- pickup cannot tunnel at maximum speed or duplicate across frame rates;
- collection produces no late shader compile or resource allocation;
- the relay world reads as a physical location rather than points in empty sky;
- direct `pnpm dev` launches the two-chapter build on the checked-out branch;
- focused functional, deterministic, performance, and visual checks pass;
- an independent critic finds no P0/P1 gameplay, readability, ownership, or performance defect.
