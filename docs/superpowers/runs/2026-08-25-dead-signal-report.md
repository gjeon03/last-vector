# DEAD SIGNAL Chapter 03 Report

**Status:** PASS

**Scope:** Chapter 03 only. The standalone campaign order is CAIRN DRIFT then DEAD SIGNAL so this
track remains independently playable; final integration may insert Chapter 02 ahead of Chapter 03.

## Commits

- `fea23227bea665c9e0bddf0cd61e4bbfc2ff98e8` — Chapter 03 definition, fixed attack path,
  strike objective/state, BLACK ARRAY facility/effects, campaign UI, i18n, and fast contracts.
- `7f55ef3198ee7bd093cff161c08d6c865852c78d` — approved shared chapter-extension integration.
- `7e708a5a703d186bde6d7679eaa63653dcfa5c70` — centreline hitscan runtime, independent FIRE input,
  audio feedback, HUD/result wiring, and focused real-input/browser probes.
- `6f1151a7c00ea8f9f1396335bdb51e3d36924abe` — approved catalog-neutral persistent
  chase/cockpit/far-chase camera cycle.
- `7318d58771d6af244ec1e0eedf78ad4d4f64aa19` — final required-path, target-readability,
  result-denominator, failure/capture, and DPR evidence correction.

## Delivered chapter

- `?mission=dead-signal` constructs one continuous fixed-target run through the eclipsed BLACK
  ARRAY. The 62.4 km path contains ingress/calibration, six forward shield nodes, an exposed core,
  and two authored extraction turns. It never asks the pilot to turn back after the third node.
- Success requires any 3 of 6 shield nodes, the core, both extraction turns, and hull above zero.
  Objective-owned failures distinguish the core boundary without three nodes, missed core window,
  and blast timeout; common hull failure remains `HULL BREACH`.
- All eight damageable targets are represented by fixed facility geometry and bounded
  screen-readable beacons. Shield housings/halos are cyan, destroyed housings clear from the line of
  fire, and the exposed core receives an unmistakable pulsing red-orange sight marker with a bright
  inner point. Damage stages move beacon/halo intensity through cyan, amber, and red.
- LMB is FIRE only while the selected mission advertises the fire capability. It is a no-op in
  CAIRN. Shift is the sole boost input. Shift+LMB and independent release work without shared state;
  blur, pause, pointer-lock loss, countdown, and resume clear mouse fire without corrupting Shift.
- The weapon is a fixed 8 Hz, 22-damage centreline hitscan with 4.25-degree bounded assistance,
  3,200 m range, and a hard 16-targetable limit. It owns no projectile physics. Feedback uses the
  common audio bus and typed fire/hit/destroy events; each destroyed shield queues the approved
  25-point boost recharge reward.
- Effects remain two fixed draws: 48 pooled tracers and 8 pooled explosions. The facility is nine
  fixed draws, 24,240 triangles, seven geometries, and six materials. It adds no light, shadow,
  slicing, rigid-body debris, enemy, ammo, heat, loot, or upgrade system.
- Strike telemetry/result UI separates the clear threshold (`3 REQUIRED`) from authored progress
  (`3 / 6` or mastery `6 / 6`). Progress is clear-only and PB identity remains ruleset-partitioned.
- Story, radio, result accessibility, and chapter text are Korean; technical flight chrome remains
  English. No speech synthesis or second audio context was added.
- C cycles chase → cockpit → far-chase → chase. The camera choice persists and invalid stored data
  sanitises to chase without a mission-ID branch.

## Verification

All commands passed on 2026-08-25 in the isolated DEAD SIGNAL worktree. No broad matrix or
`playtest:all` was run.

- `pnpm build`
- `pnpm test:dead-signal`
- `pnpm test:campaign`
- `pnpm test:i18n`
- `pnpm test:boost`
- `pnpm playtest:dead-signal-input -- --timeout-ms 90000`
- `pnpm playtest:dead-signal -- --device-scale-factor 1 --out playtest-out/dead-signal-journey-dpr1 --timeout-ms 120000`
- `pnpm playtest:dead-signal -- --device-scale-factor 2 --out playtest-out/dead-signal-journey-dpr2 --timeout-ms 120000`
- `git diff --check`

Fast deterministic contracts at 60 Hz and 120 Hz produced identical weapon facts: 8 shots, 3 hits,
one destroyed shield, one 25-point recharge reward, and the same bounded event sequence. The full
objective proof succeeded at exactly 112 seconds at both rates with 6/6 shields, core destroyed,
extraction crossed, and `targetsRequired: 3` / `targetsTotal: 6`. All three authored failure
boundaries also returned their exact reasons.

The real-input Chromium probe proved:

- CAIRN LMB: `fire=false`, `boost=false`; Shift: boost only.
- DEAD SIGNAL LMB: fire only; Shift+LMB: fire and boost; releasing either leaves the other held.
- Pointer-lock loss clears fire but preserves held Shift; blur clears both; reconstructed input,
  resume, and countdown boundaries do not revive stale fire.
- C applied and persisted chase → cockpit → far-chase → chase, then sanitised an invalid stored mode.
- Zero page, console, game, or external-request errors.

The focused production journey first proved the actual `CORE WINDOW MISSED` failure screen, then
completed a required-path clear with exactly 3/6 nodes, the core, extraction, 100% hull, and persisted
clear. DPR1 finished in 112.58 seconds; DPR2 finished in 114.02 seconds. The slower capture arm holds
fire while each authored target scene settles, so shot accuracy is evidence-harness timing rather
than a mastery claim.

Hardest-scene profiles were sampled twice on the settled exposed-core scene:

| DPR arm | Backing store | FPS | p95 | Long frames | Draws | Triangles | Geometries | Textures | Programs |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1920×1080 | 59.98 | 17.6 ms | 0 | 35 | 57,784 | 22 | 12 | 44 |
| 2 | 2108×1186 | 59.98 | 17.4 ms | 0 | 35 | 57,784 | 22 | 12 | 44 |

The DPR2 backing store is the canonical 2.5 Mpx production fill-budget result for a 1920×1080
viewport, rather than raw 3840×2160. Both samples remain below 160 draws, 620k triangles, 155
geometries, 16 textures, and 55 programs. Consecutive program counts are identical, proving zero
late shader compilation in the settled scene.

## Settled captures

- `playtest-out/dead-signal-journey-dpr1/01-shield-run-dpr1.png` — cyan shield housing and facility
  beacon, before fire; no pointer-lock or impact overlay.
- `playtest-out/dead-signal-journey-dpr1/02-array-core-dpr1.png` — exposed core with distinct
  red-orange pulsing marker and bright inner point, before fire.
- `playtest-out/dead-signal-journey-dpr1/03-extraction-turns-dpr1.png` — readable array structure
  during the two-turn blast extraction.
- `playtest-out/dead-signal-journey-dpr1/04-result-dpr1.png` — actual settled result view showing
  `SHIELD NODES 3 / 6`, core destroyed, and 100% hull.

Reports: `playtest-out/dead-signal-contract/report.json`,
`playtest-out/dead-signal-input/report.json`,
`playtest-out/dead-signal-journey-dpr1/report.json`, and
`playtest-out/dead-signal-journey-dpr2/report.json`.

## Falsification self-review

1. **P1, fixed:** the original target housings collapsed to tiny cyan specks against the eclipse,
   and the core inherited the same cyan read. The facility now uses bounded larger housings,
   camera-facing colored halos, high-contrast fixed outlines/braces, destroyed-node clearing, and a
   distinct pulsing red-orange core sight marker. Original-resolution shield/core captures were
   inspected after the correction.
2. **P1, fixed:** target contacts made the all-node automation finish at 0.76% hull while a stale
   fourth-node director could imply turnback. Damageable fixed targets no longer masquerade as
   collision hazards, and guidance goes straight to the core at 3 nodes. The real required-path
   journey now clears with exactly 3/6 and 100% hull.
3. **P2, fixed:** early evidence preserved pointer-lock/contact overlays, captured a transitional
   result, and rendered the authored six-node count as `6 / 3`. Capture setup now settles transient
   UI and waits for the real result view; result/HUD rendering uses total 6 while separately stating
   the 3-node threshold.

## Bounded scope

No Chapter 02 or future chapter content was inspected, authored, merged, or referenced. No survival,
shockfront, dogfight, enemy ship, ammo, heat, loot, upgrade, dynamic light/shadow, projectile physics,
mesh slicing, rigid-body destruction, or broad performance/localization matrix was added.
