# LAST VECTOR — Chapter 01 Stages Design

- Date: 2026-08-25
- Status: Approved direction; written specification pending final user review
- Target branch: `codex/chapter-one-stages`
- Base: `codex/develop` at `5e4fe09126d44a6467b54c2a07128258f47693b0`

## 1. Purpose

LAST VECTOR is strongest when the player reads a route, manages speed, and learns a better line.
The meteor-survival prototype removed those positive targets and asked an inertial racing craft to
react to predicted, converging threats. Direct playtesting found that loop frustrating and close
to impossible rather than rewarding.

Chapter 01 expands the proven gate-flight loop instead. It provides three short, authored stages
whose difficulty comes from readable fixed terrain, braking decisions, three-dimensional turns,
and discovering new locations.

The survival prototype remains preserved on `codex/meteor-survival-spike`. It is not included in
this branch or hidden inside the shipped chapter runtime.

## 2. Product Decision

The product hierarchy is:

```text
CHAPTER
  -> STAGE
    -> optional mastery goals
```

Chapter 01 contains three linear stages. Clearing a stage once unlocks the next. Rank, time,
damage, and precision never block story progression.

The chapter does not add a separate campaign hub, branching mission tree, cutscene system, or
large route-card catalog. With only three stages, the title uses a compact horizontal stage rail.
A dedicated chapter map is deferred until there are at least two chapters or four active routes.

## 3. Goals

- Preserve CAIRN's current handling, geometry, times, PB keys, and full time-trial identity.
- Make braking and line choice materially more important in Stages 01-2 and 01-3.
- Give every stage a memorable location reveal rather than merely moving gates in the same sky.
- Keep hazards fixed, deterministic, readable, and learnable.
- Tell a light story through one short briefing and at most three subtitle radio beats per stage.
- Keep progression familiar: clear, unlock, continue, replay.
- Load exactly one stage world at a time so the chapter does not multiply runtime resources.
- Verify new content proportionally, without repeating unrelated ten-minute test matrices.

## 4. Non-goals

Chapter 01 does not include:

- Meteor survival, combat, weapons, enemies, loot, upgrades, XP, or currency.
- Moving shutters, homing obstacles, random unavoidable hazards, or procedural gate placement.
- Branching routes or alternate endings.
- Runtime world hot-swapping.
- A full chapter-map screen while only three stages exist.
- TTS, streamed speech, cutscenes, or long dialogue.
- Rank-gated progression.
- Reusing `needle-grave` as the identity of a redesigned stage.
- New touch-flight controls.

## 5. Chapter 01 — THE CAIRN FRONTIER

ACHRA's outer relay chain is failing. KESTREL-C7 carries a recovered VECTOR from VESPER through
the WRECKLINE and below the ring plane to wake ORISON ARRAY. The story remains subordinate to
flight: a briefing establishes the task, radio subtitles warn or confirm, and the destination
reveal closes each stage.

### 5.1 Stage 01-1 — CAIRN DRIFT / DEPARTURE

- Identity: `cairn-drift`
- Destination: `VESPER TERMINUS`
- Role: balanced introduction and compatibility anchor

The existing course is retained behaviorally and numerically. Its current nine gates, PB scope,
rank calculation, world props, vantages, and typical completion range are not retuned to match the
shorter new stages.

Flight rhythm:

1. `APPROACH` — wide opening gates re-establish steering and throttle.
2. `SHELF CUT` — the known dive and S-line ask for one deliberate braking decision.
3. `TERMINUS RUN` — the shelf opens onto the planet and VESPER, followed by the boost finish.

Stage 01-1 teaches the chapter grammar. Existing players with a valid CAIRN PB are treated as
having cleared it, but no historical rank, clean-clear, or precision claim is invented.

### 5.2 Stage 01-2 — WRECKLINE / DEAD SPAN

- Identity: `wreckline`
- Destination: `NADIR RELAY`
- Target skilled duration: approximately 60–70 seconds
- Target gate count: eight

WRECKLINE is the braking and technical-turn stage. It reuses compatible wreck materials and
destination infrastructure but does not use the dormant NEEDLE route, its ID, PBs, or SHEAR
mechanic.

Flight rhythm:

1. `TWIN KEELS` — a broad approach between two split carrier hulls establishes scale and gives a
   safe first line-reading decision.
2. `THE FRACTURE` — the player brakes before a fixed hull break, turns through it, then commits to
   a reverse S-line. The corner is visible before braking must begin.
3. `ENGINE SPINE` — three dead engine rings form a vertical slalom, followed by a recovery boost
   toward NADIR.

Fixed landmarks:

- `TWIN KEELS`
- `THE FRACTURE`
- `ENGINE SPINE`

### 5.3 Stage 01-3 — RINGFALL / BELOW THE PLANE

- Identity: `ringfall`
- Destination: `ORISON ARRAY`
- Target skilled duration: approximately 65–75 seconds
- Target gate count: nine

RINGFALL is the discovery and three-dimensional-line finale. It combines vertical and horizontal
turns without adding a new moving hazard system.

Flight rhythm:

1. `HIGH ORBIT` — a wide descending curve reveals the ring plane across the screen.
2. `RINGFALL` — the player brakes in the shadow of `TWIN SPIRES`, drops below the plane, then
   reverses into a climbing turn.
3. `ORISON ASCENT` — a low slalom leads through a fixed arch. ORISON wakes beyond the silhouette
   and opens the final straight.

Fixed landmarks:

- `RING WALL`
- `TWIN SPIRES`
- `ORISON ARCH`

## 6. Route Fairness and Readability

Difficulty comes from curvature, elevation, approach speed, and fixed landmark placement. It does
not come from shrinking apertures until they are hard to see or from changing the safe line after
the player commits.

Every stage follows these rules:

- A major turn is readable from at least the preceding gate.
- The strongest braking decision has roughly two seconds of cruise-speed distance before the
  committed turn.
- After at most two demanding turns, the route provides a recovery straight or broad gate.
- At least one deterministic, collision-free racing line exists through every fixed landmark.
- Course clear-channel generation protects both the authored curve and viable corner-cutting
  chords.
- Fixed obstacles do not animate into the clean channel.
- The deterministic pilot completes each stage without hull contact at representative 60 Hz and
  120 Hz fixed-step arms.

The first human playtest is a product gate, not just a tuning suggestion. If a player cannot tell
why they missed a line, the response is to improve sightline, spacing, landmark language, or
braking room—not merely lower a hidden difficulty value.

## 7. Light Story and Radio

Each stage has:

- One short Korean narrative briefing with English proper nouns.
- At most three in-flight radio subtitle beats.
- A short transmission-start beep and end beep.
- No TTS or required voice asset.

Radio subtitles use the existing speaker/message presentation. They must not compete with a
gate-clear callout or cover a braking cue. A line may fire only when the deterministic maximum-
speed trace has at least:

```text
subtitle TTL + 2.0 seconds
```

before the next required steering or braking commitment. If no safe window exists, the line moves
to the briefing, a recovery straight, or the result screen. Stage-critical instruction is also
communicated spatially; story text is never the only warning.

Example beats:

- WRECKLINE approach: NADIR has gone dark; the wreck channel is the remaining path.
- WRECKLINE recovery: the fracture is behind; follow the engine spine.
- RINGFALL approach: the recovered VECTOR points below the ring plane.
- RINGFALL finale: ORISON responds as the array becomes visible.

## 8. Title and Stage Selection

The title keeps its current visual hierarchy and primary `START FLIGHT` action. A compact stage
rail replaces the disabled two-card campaign presentation:

```text
CHAPTER 01
THE CAIRN FRONTIER

01-1  ●────○────○  01-3
      CAIRN DRIFT

[ START FLIGHT ]
```

Behavior:

- The rail is a horizontal `radiogroup` with three compact stage nodes, not three cards.
- Left/Right moves between nodes because the visible layout is horizontal.
- The selected unlocked node uses roving `tabindex=0`; other unlocked nodes use `-1`.
- Locked nodes remain discoverable and described with `aria-disabled=true`, but cannot become the
  run target.
- `Enter`/`Space` selects an unlocked node; `START FLIGHT` remains a separate action.
- The selected stage updates the existing title sector, destination, and short Korean scenario
  description.
- Node hit targets remain at least 24 CSS pixels.
- At 375×667 and 640×360 the rail remains one row and does not push `START FLIGHT` below the
  viewport.
- A large map, thumbnail grid, live multi-world preview, and stacked mobile cards are deferred.

## 9. Screen Flow

```text
TITLE + STAGE RAIL
  -> STAGE BRIEFING
  -> COUNTDOWN
  -> FLIGHT
  -> RESULTS
```

First clear with a next stage:

1. `NEXT STAGE`
2. `RUN AGAIN`
3. `STAGE SELECT`

Replay clear:

1. `RUN AGAIN`
2. `STAGE SELECT`
3. `NEXT STAGE` when another unlocked stage exists

Chapter-final clear:

1. `RUN AGAIN`
2. `STAGE SELECT`
3. `RETURN`

`STAGE SELECT` returns to the title rail focused on the current stage; it does not open another
screen. `NEXT STAGE` persists progress and selection, then reloads directly into the next stage's
briefing. Same-stage retry stays in memory and does not reload.

Mastery is compact and optional:

- Stage clear state is shown by the node itself.
- Three small result/rail markers represent `S RANK`, `CLEAN`, and `PRECISION`.
- A lower rank does not mark the rank goal complete; the goal is specifically S.
- Results may show one `NEXT TARGET`, but never a blocking mastery modal.

## 10. Catalog and World Lifecycle

The existing boot-time course resolution remains. Exactly one complete world is constructed from
the selected stage definition. Stage changes use the existing loader and `?course=` navigation;
runtime hot-swap is not introduced.

Catalog identities are separated explicitly:

```ts
KNOWN_COURSE_ORDER = [
  'cairn-drift',
  'needle-grave', // retained but inactive
  'wreckline',
  'ringfall',
]

CHAPTER_ONE_STAGE_ORDER = [
  'cairn-drift',
  'wreckline',
  'ringfall',
]
```

Implementation uses these two ownership boundaries: `KNOWN_COURSE_ORDER` owns recognized data and
`CHAPTER_ONE_STAGE_ORDER` owns player-reachable Chapter 01 order. The old
`CAMPAIGN_MODE_ENABLED` boolean must not remain the single owner of both UI visibility and route
authorization.

Course definitions own:

- Stable stage identity and order.
- Geometry legs, gate count, spacing, radius, clearance, and rank rules.
- World lighting, planet/ring composition, fixed landmark kind, and destination treatment.
- Canonical telemetry names and localized story keys.
- Radio trigger points and safe timing metadata.
- Camera vantages used by screenshots and attract mode.

New landmarks replace or reorganize near-field content rather than layering an additional world
on top of CAIRN. They reuse current materials and shaders where practical. Stage content must not
create a second per-frame collision system.

## 11. Progress, PBs, and Migration

The existing `last-vector.progress.v1` storage shape remains sufficient. No chapter-completion or
persisted unlock flags are added.

Unlock is derived:

- Stage 01-1 is always unlocked.
- Stage `n` is unlocked only when every preceding active Chapter 01 stage is cleared.
- Recognized but inactive routes never authorize selection or navigation.

Progress facts merge monotonically across sanitized session and local stores:

- `cleared`, `cleanClear`, and `precisionClear` use logical OR.
- `clearedAt` keeps the earliest valid time.
- `highestRank` keeps the best valid rank.
- Unlock itself is recalculated and never persisted.

PB identity remains `${stageId}-${seed}`:

- Existing `cairn-drift-*` keys remain byte-for-byte valid.
- `wreckline-*` and `ringfall-*` are independent.
- `needle-grave-*` facts remain recognized but inactive.
- A material route-geometry change requires a new stage ID or an explicit PB migration.

Legacy migration runs only when both progress stores are absent. A valid CAIRN best time proves
only that Stage 01-1 was cleared; it does not invent rank, clear time, clean, or precision facts.
A newer progress schema remains read-only.

## 12. URL and Failure Behavior

One canonical parameter is sufficient:

```text
?course=<stable-stage-id>
```

- Valid, active, unlocked URL stage: load it.
- Unknown, inactive, or locked URL stage: fail closed to CAIRN with a diagnostic.
- No URL stage: use the persisted selection only when it remains active and unlocked.
- Normal stage navigation removes debug `seed`; harness navigation may preserve it explicitly.
- Unrelated query parameters and the URL hash are preserved.
- A direct URL cannot bypass sequential unlocks.

Progress is written to session and local storage independently. `NEXT STAGE` reloads only if at
least one handoff write succeeds. If neither write succeeds, the current result remains usable and
shows a non-blocking localized `PROGRESS NOT SAVED` message instead of navigating into a stage the
reload cannot authorize.

## 13. Localization and Accessibility

The approved hybrid-language policy remains:

- Technical chrome, stage numbers, route names, actions, HUD labels, and ranks use English.
- Briefing prose, radio subtitles, lock explanations, errors, and accessibility descriptions use
  the selected language.
- Proper nouns retain `lang="en"` within Korean sentences.
- Automation uses stable IDs and `data-*` selectors, never translated copy.
- Result actions follow their visible horizontal axis with Left/Right navigation.
- Stage-rail focus survives locale rebuilds and stage reloads.

## 14. Performance Contract

Adding three catalog entries must not keep three worlds resident. Every boot owns one `Course`,
one destination, one static field, and only the landmarks for the selected stage.

Stage-specific constraints:

- No late shader compile/link after the normal stage prewarm.
- No per-frame allocation from fixed landmarks or radio scheduling.
- No resource growth across retry, pause, result, and title return.
- Existing quality population caps and collision broad-phase bounds remain in force.
- Landmark differentiation uses geometry placement and shared materials rather than extra lights,
  particle fields, or duplicate sky systems.
- Each stage must pass the existing frame-time and render-scale thresholds at 1080p and HiDPI.

The current performance runner only proves the default CAIRN URL. Chapter acceptance therefore
adds a route parameter to the same focused probe and runs one representative prewarmed profile for
each of `cairn-drift`, `wreckline`, and `ringfall` at both device scale factors. It does not repeat
unrelated audio, localization, boost-plume, or screenshot matrices per stage.

Each of the six stage/DPR arms uses High quality, begins at render scale 1, presents all authored
materials, warms for 120 real frames, and then profiles five seconds of live `requestAnimationFrame`
at the stage's heaviest authored vantage. Existing M5 frame thresholds remain authoritative. The
initial resource ceilings, fixed before measurement, are:

- 160 draw calls.
- 620,000 triangles.
- 155 geometries.
- 16 textures.
- 55 programs.

If one arm fails, only that stage/DPR arm is repeated once on an idle machine with a ten-second
sample. The thresholds are not raised merely to make a failing landmark pass.

## 15. Proportional Verification

Fast checks on relevant changes use only:

- `pnpm build` (including typecheck).
- `pnpm test:i18n`.
- `pnpm test:campaign` for catalog, progress, URL, PB identity, and radio-authoring contracts.
- `git diff --check`.
- Deterministic course signatures and protected clean line for each stage.

One focused browser journey:

- Fresh player starts on 01-1.
- Locked nodes are visible but cannot start.
- A successful 01-1 finish unlocks and navigates to 01-2.
- A successful 01-2 finish unlocks and navigates to 01-3.
- Retry, stage select, locale lock, keyboard navigation, and storage failure remain actionable.
- The compact rail and primary action fit 1920×1080, 375×667, and 640×360.
- One actual radio subtitle is observed per stage; the fast contract owns all remaining lines,
  order, keys, and both-language parity.
- Console, page, harness, and external-network error channels remain empty.

Focused content evidence:

- WRECKLINE signature and destination captures.
- RINGFALL signature and destination captures.
- One title-rail and one result capture.
- Deterministic pilot clean completion at 60 Hz and 120 Hz for each new stage.
- Per-stage 1080p and HiDPI performance profiles described in Section 14.

These six new 1920×1080 images first prove only technical validity: correct stage identity,
expected subject in frame, non-empty image, and finite pixel statistics. Because no approved visual
baseline exists yet, composition and differentiation remain `REVIEW REQUIRED` until a human
accepts the images. They must not be labeled visual-regression PASS on their first run.

Explicitly not repeated unless a shared subsystem changes or focused evidence fails:

- Full normal and HiDPI localization browser matrices.
- Full 22-cell screenshot matrix.
- Boost VFX probes.
- Audio probe.
- Aggregate `playtest:all` after every small content edit.

A final aggregate is considered only once at release readiness and only if the cumulative diff
touches shared input, renderer, localization lifecycle, or audio behavior beyond this design.

## 16. Delivery Sequence

1. Generalize recognized versus playable stage catalogs, progress loops, URL resolution, and
   compact stage rail while preserving CAIRN behavior.
2. Add WRECKLINE's deterministic course, fixed landmarks, destination treatment, brief/radio, and
   focused gameplay evidence.
3. Add RINGFALL's deterministic course, ring landmarks, destination treatment, brief/radio, and
   focused gameplay evidence.
4. Finish combined unlock flow, result actions, mastery markers, storage failure UX, and chapter
   completion presentation.
5. Run the single focused journey and the per-stage performance matrix.
6. Perform one adversarial review, prepare the branch for direct user playtesting, and stop before
   merging to `main`.

## 17. Success Criteria

Chapter 01 is ready for user testing when:

- CAIRN behavior and historical PB identity remain intact.
- A fresh player can understand the three-stage order without a separate map screen.
- Clearing 01-1 and 01-2 reliably unlocks the next stage without rank gates.
- WRECKLINE rewards braking and line learning without moving traps.
- RINGFALL delivers a distinct three-dimensional location reveal.
- Every major turn is readable early enough to explain failure.
- Radio never overlaps a gate callout or consumes a required braking window.
- All three stages have a deterministic clean route and remain fair across representative fixed
  step rates.
- All three stages meet the focused 1080p and HiDPI performance gates.
- Korean narrative and English technical chrome remain readable on desktop and compact layouts.
- Direct user playtesting finds the routes understandable and worth retrying.

## 18. Accepted Trade-offs

- Stage changes show the normal loader.
- CAIRN is longer than the two new stages to preserve existing records and feel.
- Three stages use a compact rail rather than a dedicated visual chapter map.
- New destinations reuse and parameterize current rendering infrastructure.
- Story is delivered without voice acting in the initial release.
- Detailed per-gate medal history is not persisted.
- Verification is asymmetric: existing CAIRN regression evidence plus focused new-stage arms.

## 19. Merge Boundary

Implementation, commits, and pushing may occur on `codex/chapter-one-stages`. The work must not be
merged into `main` without explicit user approval after direct playtesting.
