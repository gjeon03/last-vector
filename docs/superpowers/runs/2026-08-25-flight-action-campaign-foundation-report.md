# Flight-Action Campaign Foundation Report

**Status:** PASS

**Scope:** Foundation only. Chapter 01 CAIRN is the sole active mission; escape/strike exist only as
bounded contracts. WRECKLINE, RINGFALL, and NEEDLE remain dormant recognized data and assets.

## Commits

- `8fbe04564368eba66ce96fcae0180a2e92641ba5` — boost drain 29 -> 20, derived HUD/i18n
  fixtures, deterministic 60/120 latch/reward evidence, and flight-ruleset PB partition.
- `b3fa622d60c83949262c0a21fe3e5515ca744ef3` — FlightPath extraction, mission/runtime/world
  boundaries, mission URL/progress v2 migration, CAIRN-only campaign UI, and focused proofs.

## Delivered contract

- `FlightPath` owns deterministic path/spawn/extraction/clear-channel geometry; `Course` layers
  gate-race state on it. CAIRN geometry and gate output are locked by exact hashes.
- `MissionDefinition`, `MissionRuntime`, `GateRaceObjective`, and `World` form explicit bounded
  lifecycle seams. Common guidance plus discriminated gate-race/escape/strike telemetry and result
  unions are present without ECS, plugins, event bus, or mission-ID branches in `Game`.
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

## Falsification self-review

1. **P1, fixed:** moving debris no longer rewound when CAIRN's title/briefing flight loop reset the
   ship after world extraction. `resetShipToStart` now preserves the historical world rewind while
   mission reset paths avoid a double reset.
2. **P1, fixed:** objective-neutral guidance exposed its own anchor but `Game` projected the legacy
   gate anchor. Guidance now projects the objective-supplied anchor; CAIRN remains numerically
   identical because its guidance target is the current gate/terminus.
3. **P2, fixed:** the deprecated `CourseSelection` import-path shim omitted the old resolver export
   name. It now forwards both resolver names while all production code uses `MissionSelection`.

Unproven claims are deliberately bounded: no broad browser/localization/performance matrix was run;
no manual feel verdict is claimed for the longer boost window; and escape/strike gameplay, target
caps, future chapter UI, and multi-mission progression are contracts only, not shipped content.

## Diff scope

Changed only the product goal; focused playtest contracts/proof; core mission, selection, progress,
telemetry/result and harness contracts; FlightPath/course/game/runtime/world implementation; boot
selection; and title/result/i18n adapters. No Chapter 02/03 authored mission data, flight speed,
boost regeneration, or VFX tuning was added.
