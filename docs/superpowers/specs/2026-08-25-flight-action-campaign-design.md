# LAST VECTOR — Flight-Action Campaign Design

- Date: 2026-08-25
- Status: Approved direction
- Integration branch: `codex/flight-action-campaign`
- Source branch: `codex/chapter-one-stages` at `0eb9cb2`

## 1. Product decision

LAST VECTOR becomes a forward-flight action campaign with one complete mission per chapter.
Every chapter uses the same ship, handling, camera, hull, boost economy, guidance language, and
three-act rhythm. A chapter changes the world, objective, hazards, and one signature mechanic; it
does not replace the flight game with a disconnected minigame.

The campaign identity is:

```text
approach -> commit to one spatial objective -> extract
```

Chapters target 90–150 seconds as an outer bound. Authored skilled times are narrower so a single
mechanic does not overstay its welcome.

## 2. Campaign arc

KESTREL-C7 is an armed pathfinder for an unseen evacuation convoy. The ship first recovers the
LAST VECTOR, then broadcasts it while escaping the destruction of ACHRA, and finally destroys the
orbital array that deliberately guided the lunar collision and is now targeting the convoy.

ACHRA remains a fictional Earth-like colony. The game does not become literal near-future Earth
fiction, and no convoy ships need to be rendered or simulated.

### Chapter 01 — LAST VECTOR / NAVIGATE

- Mission ID: `cairn-drift`
- Target skilled time: 80–100 seconds
- Signature mechanic: sequential gate navigation
- World: the existing amber Cairn frontier and VESPER TERMINUS

Acts:

1. `CALIBRATION` — two broad gates establish steering, throttle, and guidance.
2. `SHELF CUT` — braking and technical gates demand readable line choice.
3. `TERMINUS RUN` — an open boost finish resolves the recovered VECTOR.

Success requires all nine gates in order and a terminus crossing with hull remaining. Gate misses
are recoverable and there is no hard timer. Rank is based on time; clean and precision remain
separate mastery facts.

The current WRECKLINE and RINGFALL missions become inactive. Their IDs, authored geometry, and
progress facts are preserved but never mapped to new chapter clears.

### Chapter 02 — FALL OF ACHRA / ESCAPE

- Mission ID: `last-ascent`
- Target skilled time: 100–120 seconds
- Signature mechanic: staying ahead of a scripted shockfront through deterministic debris lines
- World: the upper atmosphere and collapsing orbit of ACHRA during a guided lunar impact

Acts:

1. `LAST ASCENT` (0–30s) — leave a damaged launch structure, reveal the impact and distant front.
2. `DEBRIS CORRIDOR` (30–80s) — three large, sparse, authored lateral/vertical line decisions,
   each followed by a short recovery gap.
3. `ESCAPE BURN` (80–115s) — a broad orbital arc and sustained burn to the extraction boundary.

Success requires crossing extraction before the shockfront with hull remaining. Failure occurs on
hull zero or shockfront overtake. A no-boost full-throttle reference is eventually caught, but the
mission clear remains recoverable after one mistimed early two-second burn. A clean reference line
finishes three to eight seconds ahead; an always-held trace must not finish more than ten seconds
ahead. The shockfront follows path progress rather than instantaneous player speed and never
rubber-bands.

Debris never homes toward the player. Commitment hazards are visible at least 2.5 seconds before
the line closes. The moon collision, planet breakup, and shockfront are far-scene set pieces rather
than physical simulations.

### Chapter 03 — BLACK ARRAY / STRIKE

- Mission ID: `dead-signal`
- Target skilled time: 105–125 seconds
- Signature mechanic: forward-gun attack alignment during one continuous flight line
- World: an eclipsed industrial array assembled from retained WRECKLINE and RINGFALL silhouettes

Acts:

1. `INGRESS` (0–25s) — approach the facility and destroy one forgiving calibration target.
2. `SHIELD RUN` (25–85s) — six fixed shield nodes are offered across the forward attack path;
   any three are required. Missing one never requires turning around.
3. `CORE / EXTRACT` (85–120s) — destroy the exposed core, then fly a two-turn extraction around
   the collapsing structure before the blast countdown expires.

Success requires three shield nodes, the core, extraction, and hull remaining. Failure occurs on
hull zero, reaching the core boundary without three nodes, leaving the core attack window without
destroying it, or blast timeout. Targets provide 2–3 second valid firing windows and bounded aim
assistance. Extra shield nodes and accuracy are mastery, not story gates.

There are no enemy fighters, return fire, ammunition, heat, weapon switching, loot, upgrades,
rigid-body destruction, or free-roaming combat.

## 3. Shared controls and flight contract

Final campaign controls are stable across every chapter:

- `LMB`: forward fixed cannon (`FIRE`), active only when the mission grants weapon capability.
- `Shift`: boost.
- `RMB` or `Space`: brake.
- `C`: chase -> cockpit -> far chase.
- Existing steering, throttle, roll, and strafe bindings remain.

LMB is removed as a boost alias when the weapon capability lands. It never changes meaning by
chapter. Non-weapon missions ignore FIRE and do not play an empty gun sound. `Shift+LMB` in a
strike mission independently boosts and fires. Blur, pause, pointer-lock loss, countdown, and
resume boundaries clear mouse fire without corrupting a physically held Shift.

The cannon is a centreline hitscan pulse with a short pooled tracer. It has no projectile physics,
ammo, reload, or weapon selection. Damage checks only the bounded targetable set. Boost changes
the attack-window duration through movement but never changes fire rate or damage.

## 4. Boost baseline

The campaign fixes the flight baseline before authoring escape or strike distances:

```text
capacity             100
engage floor         8%
rearm threshold      45%
drain                20 / second  (was 29)
regen                22 / second
regen delay          0.65 seconds
cruise speed         462 m/s
boost target speed   1078 m/s
max speed            1188 m/s
```

Expected behaviour:

- Full usable burn: 4.60 seconds.
- Natural rearm gap: about 2.33 seconds.
- Natural rearm burn: 1.85 seconds.
- A 25% authored mission reward immediately unlocks about 1.25 seconds of boost.
- HUD usable label: `4.6S`; ticks: `28/48/68/88%`; rearm remains `45%`.

The first tuning changes drain only. Speed, steering authority, regeneration, and camera/VFX
amplitude do not change in the same commit.

Mission rewards share one typed event:

- Chapter 01: accepted gate pass.
- Chapter 02: authored safe-corridor checkpoint.
- Chapter 03: shield-node destruction.

Natural regeneration waits for 45%; an authored reward deliberately bypasses the latch once energy
is above the 8% floor. The two semantics remain distinct.

Boost changes the physical rules, so best runs are partitioned by mission ruleset version. Existing
clear/unlock facts survive, but legacy PBs and splits are not compared against the new flight model.

## 5. Runtime architecture

The implementation uses explicit bounded unions, not an ECS, plugin framework, or growing set of
mission-ID conditionals in `Game`.

```ts
type ObjectiveDefinition =
  | { kind: 'gate-race'; path: FlightPathDefinition; gates: GateRaceDefinition }
  | { kind: 'escape'; path: FlightPathDefinition; shockwave: ShockwaveDefinition }
  | { kind: 'strike'; path: FlightPathDefinition; targets: TargetGroupDefinition[];
      extraction: ExtractionDefinition };

interface MissionDefinition {
  id: MissionId;
  chapter: 1 | 2 | 3;
  rulesetVersion: number;
  world: WorldDefinition;
  objective: ObjectiveDefinition;
  mastery: readonly MasteryId[];
  radio: readonly RadioCueDefinition[];
}
```

`FlightPath` is extracted from the current `Course` without changing CAIRN path or gate signatures.
`Course` then becomes the gate-race layer over a path. Escape and strike reuse the same path for
spawn pose, guidance, authored clear channels, title flight, and extraction.

`MissionWorldRuntime` owns render objects, stable collider/targetable arrays, quality changes, world
simulation, and disposal. It does not know about success, UI, storage, or localization.

`MissionObjectiveRuntime` owns objective progress, success/failure, guidance, typed telemetry, and
objective-specific result construction. It does not call DOM, translation, audio, or persistence.

`Game` owns the common frame order, flight phase, ship, camera, audio/event adaptation, and screen
flow. Terminal priority in one frame is hull failure, objective-specific failure, then success.

Common guidance supplies label, anchor, distance, progress, current, and total. Objective telemetry
is a discriminated union for gate-race, escape, and strike. Results share `TIME / HULL / OBJECTIVE`
and exhaustive objective-specific fields rather than a large optional object.

## 6. World construction and performance contract

One mission world is created per page load and fully disposed on mission URL reload. No other world
is preloaded invisibly.

Global starting ceilings remain:

- 160 draw calls.
- 620,000 triangles.
- 155 geometries.
- 16 textures.
- 55 programs.
- zero late shader compile/link work after presentation.

Escape limits:

- 16–24 simultaneous moving collision debris objects.
- At most four instanced moving-debris batches.
- Decorative density replaces, rather than adds to, the existing asteroid budget.
- Large debris is opaque/low-complexity; transparent overdraw is bounded.

Strike limits:

- At most 16 targetables.
- Facility additions: at most 12 draw calls and 120,000 triangles.
- 32–64 tracers in one fixed instanced pool.
- At most eight concurrent pooled explosion effects in one or two draws.
- No dynamic shadow-casting lights.
- No bullet-by-asteroid broad collision loop, CSG, mesh slicing, or rigid-body debris.

Gameplay colliders are quality-independent. Quality affects decoration only. All objects capable of
damaging the ship or receiving fire are visibly represented.

## 7. Progress, URLs, and UI

Campaign order is:

```text
cairn-drift -> last-ascent -> dead-signal
```

Progress v2 stores mission clears, earliest clear time, best rank, clean clear, and mission-declared
mastery facts. Unlock is derived from earlier mission clears and never stored. The current monotonic
merge/future-schema protection is retained.

Migration rules:

- Existing CAIRN clear/rank/clean/precision facts migrate to Chapter 01.
- WRECKLINE, RINGFALL, and NEEDLE facts remain recognized dormant data but do not unlock or clear a
  new mission.
- Legacy selection of a retired mission falls back to CAIRN.
- Legacy PBs remain stored under their old keys but do not compare with the new ruleset.

Canonical URLs use `?mission=<id>`. During migration, `?course=cairn-drift` remains an accepted alias;
new navigation writes only `mission`.

The current rail becomes a chapter rail only once Chapter 02 is active. With one active mission the
title shows the chapter label and `START FLIGHT`, not a one-node selector. Results use `NEXT CHAPTER`,
`RUN AGAIN`, `CHAPTER SELECT`, and `RETURN` as applicable.

Visible technical chrome remains English in Korean mode; story, briefing, radio, guidance details,
errors, and accessibility remain Korean. Proper nouns remain English.

## 8. Radio and audiovisual pacing

Radio cues attach to typed mission events rather than gate indices. A line may fire only when its
deterministic maximum-speed trace leaves `subtitle TTL + 2.0 seconds` before the next required
commitment. Story text is never the only hazard warning.

- Chapter 01: recover the VECTOR.
- Chapter 02: broadcast the route; reveal that the collision was guided.
- Chapter 03: identify and silence the targeting array.

There is no TTS requirement. Subtitle radio, procedural transmission cues, chapter-specific ambient
beds, lighting, celestial body, silhouette, and palette establish identity.

## 9. Scope exclusions

- Open world or free-roam mission selection.
- Enemy ships, dogfighting, turret mode, escorts, or convoy AI.
- Ammunition, heat, weapon inventory, upgrades, XP, currency, or loot.
- Random homing hazards or endless survival.
- Physical moon/planet simulation.
- Real-time mesh destruction, rigid-body debris, or dynamic shadow lights.
- Branching story or alternate endings.
- Loading multiple chapter worlds in one scene.

## 10. Delivery strategy and acceptance

The work is separated so any chapter can be rejected without corrupting the shared game:

1. `codex/flight-action-campaign` — integration and common foundation.
2. `codex/chapter-02-last-ascent` — escape mission only, based on locked foundation.
3. `codex/chapter-03-dead-signal` — strike mission only, based on locked foundation.

The integration branch accepts a chapter only after its own fast contracts, builder self-review,
one relevant independent critique, one real journey, hardest-scene performance, and human-facing
capture review pass. Chapter 02 must prove readable and fun enough to keep before Chapter 03 combat
is treated as a shippable campaign dependency.

Broad browser matrices are reserved for final integration. During implementation, use fast typed
contracts, one objective fixed-step proof, one active journey, and one hardest-scene profile.

No work is merged to `main` in this delivery.
