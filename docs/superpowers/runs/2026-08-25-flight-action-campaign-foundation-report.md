# Flight-Action Campaign Foundation Report

**Status:** PASS

**Scope:** Foundation only. Chapter 01 CAIRN is the sole active mission; escape/strike exist only as
bounded contracts. WRECKLINE, RINGFALL, and NEEDLE remain dormant recognized data and assets.

## Commits

- `8fbe04564368eba66ce96fcae0180a2e92641ba5` — boost drain 29 -> 20, derived HUD/i18n
  fixtures, deterministic 60/120 latch/reward evidence, and flight-ruleset PB partition.
- `b3fa622d60c83949262c0a21fe3e5515ca744ef3` — FlightPath extraction, mission/runtime/world
  boundaries, mission URL/progress v2 migration, CAIRN-only campaign UI, and focused proofs.
- `3418a44690a8514bbe69fad8dbf9c0925ce7214f` — final foundation evidence and falsification report.
- `43e5666f6e5df486c9dee7e6688fa4f87c0ef96c` — objective-neutral result and PB lifecycle.
- World-boundary correction (this commit) — sole selected-world construction, bounded common contact
  simulation, and isolated CAIRN capture/debug adapter.

## Delivered contract

- `FlightPath` owns deterministic path/spawn/extraction/clear-channel geometry; `Course` layers
  gate-race state on it. CAIRN geometry and gate output are locked by exact hashes.
- `MissionDefinition`, `MissionRuntime`, `GateRaceObjective`, and `World` form explicit bounded
  lifecycle seams. Common guidance plus discriminated gate-race/escape/strike telemetry and result
  unions are present without ECS, plugins, event bus, or mission-ID branches in `Game`.
- `Game` stores only `MissionRuntime`, not concrete `Course`, `GateRaceObjective`, or `World`
  fields. The selected factory is called once with the renderer, scenes, lighting, quality bounds,
  definition, and seed; therefore a non-CAIRN runtime does not construct or add a fallback CAIRN
  world. The seam validates identity, ruleset, and objective kind without rejecting escape/strike.
- Each world exposes a stable, capacity-bounded contact set. The common frame order is world
  simulation, all contact/proximity checks, common hull damage, hull terminal priority, and only
  then objective update. Result construction, PB identity/splits, presentation, quality, reset,
  and disposal also cross the common runtime boundary.
- CAIRN gate telemetry, autopilot, capture vantages, collision staging, crossing/shear diagnostics,
  and landmark debug state live behind an optional legacy adapter. Those surfaces fail closed or
  no-op for other runtimes and are not read by common simulation.
- Canonical navigation writes `?mission=cairn-drift`; `?course=cairn-drift` is the sole legacy
  alias. Unknown and dormant IDs fail closed to CAIRN, with canonical mission precedence.
- Progress v2 keeps monotonic mission facts, migrates CAIRN clear/time/rank/clean/precision facts,
  quarantines retired course facts under `dormantCourses`, derives unlocks, and does not overwrite
  future schemas.
- The title shows Chapter 01 plus `START FLIGHT` with zero mission nodes. Successful results expose
  `RUN AGAIN` and `RETURN`; failure exposes `RETRY` and `RETURN`. Korean narrative/accessibility and
  English technical chrome remain explicit.
- Shared physics advanced to ruleset 2, so PB keys are `<id>-r2-<seed>`; legacy PB keys remain in
  storage but are not compared with the new 4.6-second boost envelope.

## Verification

All commands passed on 2026-08-25 in the isolated mission-foundation worktree:

- `pnpm typecheck`
- `pnpm test:campaign`
- `pnpm test:i18n`
- `pnpm test:boost`
- `pnpm build`
- `pnpm playtest:campaign`
- `git diff --check`

Locked default-seed signatures:

- FlightPath: `cf64cc23e6accbd750712bb2a2140d5a0ac3dc55dbdce4851166846f24f7f605`
- Gates: `22ff40ffc12de5522e8cf83f6c8f0407201d2462d9b5e064d628c5c511c7cefc`

Boost evidence from the real `Ship` contract:

| Hz | Full burn | Natural re-arm gap | Natural burn | Gate reward burn |
|---:|---:|---:|---:|---:|
| 60 | 4.6167 s | 2.3500 s | 1.8500 s | 1.2500 s |
| 120 | 4.6000 s | 2.3333 s | 1.8500 s | 1.2500 s |

Production Chromium proof, seed 1337, skill-0.75 production autopilot (boost disabled so the proof
isolates mission/path/collision behavior):

| Hz | Result | Time | Hull | Collision clean | Errors | Max gate offset |
|---:|---|---:|---:|---|---:|---:|
| 60 | 9/9 + extraction | 130.6667 s | 1.0 | yes | 0 | 0.917924 |
| 120 | 9/9 + extraction | 130.7167 s | 1.0 | yes | 0 | 0.927018 |

Reports: `playtest-out/boost-contract/report.json`,
`playtest-out/campaign-contract/report.json`, `playtest-out/i18n-contract/report.json`, and
`playtest-out/campaign/report.json`.

Correction evidence in `MISSION.objective-neutral-factory` constructs isolated minimal escape and
strike runtimes through the same exported factory and simulation seam used by `Game`. For each kind,
the factory and world construction run once, exactly one mock world object is added, and world reset,
simulation update, objective reset, objective disposal, and world disposal each run once. A nonempty
hazard contact produces proximity, contact feedback, one body impact, and lethal hull damage; the
mock objective would succeed if called, but its update count remains zero and the terminal result is
null because hull failure wins. `buildResult` still preserves the kind, PB identity resolves through
`missionRecordId`, and objective-owned split facts remain empty. The production proof retained the
exact CAIRN path/gate hashes and the 60/120 finish facts above.

## Falsification self-review

1. **P1, fixed:** the first independent correction review found that the definition union
   advertised escape/strike while `Game` rejected them, retained concrete gate-race fields, and
   could not call the common result builder. Construction, result dispatch, PB handling, and
   lifecycle now go through the objective-neutral runtime contract.
2. **P1, fixed:** the second independent review found that `Game` still eagerly constructed CAIRN
   and resolved collision/proximity against its asteroids and landmarks even when another runtime
   was injected. There is now no fallback constructor or fallback field: the selected factory runs
   once, and common bounded world contacts apply hull damage before objective terminal resolution.
   The escape/strike lethal-contact contract proves both the contact path and terminal priority.
3. **P1, fixed:** CAIRN automation, vantage, collision-staging, and diagnostics still exposed
   concrete course/world assumptions in `Game`. They now sit behind an optional legacy adapter;
   non-CAIRN runtimes do not need or receive those surfaces.

Unproven claims are deliberately bounded: no broad browser/localization/performance matrix was run;
no manual feel verdict is claimed for the longer boost window; and escape/strike gameplay, authored
alternative worlds, future chapter UI, and multi-mission progression are contracts only, not
shipped content. Non-gate construction/contact lifecycle is proven with isolated fast runtimes at
the Game-facing seam, not as an authored browser playthrough. Renderer resource caps beyond the
declared contact capacity remain future mission implementation obligations.

## Diff scope

Changed only the product goal; focused playtest contracts/proof; core mission, selection, progress,
telemetry/result and harness contracts; FlightPath/course/game/runtime/world implementation; boot
selection; and title/result/i18n adapters. No Chapter 02/03 authored mission data, flight speed,
boost regeneration, or VFX tuning was added.

The final correction changes only `Game`, `MissionRuntime`, `World`, the extracted default
`CairnRuntime` factory/legacy adapter, the focused campaign contract, and this report. It adds no
mission definition, target, shockwave, weapon, world art, speed, regeneration, or VFX content.
