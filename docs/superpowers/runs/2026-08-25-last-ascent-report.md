# LAST ASCENT — Chapter 02 builder report

Date: 2026-08-25  
Track: `parallel-gauntlet/flight-action-campaign-20260825/track/last-ascent`

## Delivered

- Added active mission `last-ascent` after CAIRN with canonical `?mission=last-ascent`, clear-only unlock, Chapter 02 metadata, ruleset-partitioned PB key, Korean story/a11y, English technical chrome, objective-specific briefing/HUD/result/failure copy, and a two-node campaign rail.
- Added one selected ACHRA ascent world: a 99,980 m authored path, launch structure, guided-impact celestials, elapsed-only shockfront, three sparse debris decisions/recovery gaps, and broad orbital extraction.
- Collision population is fixed at 20 in one instanced collision batch. Decorative debris and three safe rings use two more instanced batches. The nearest contact spawn is 29,770.9 m from the ship start (the inherited P2 exact-centre/1 mm guard is recorded); the minimum initial moving-debris surface margin outside an authored safe ring is 79.64 m.
- Added three one-shot `boost-recharge` rewards of +25. Stable `escape-checkpoint` source indices are adapted downstream to one-based radio and a procedural checkpoint SFX; the common reward transport remains mission-agnostic.
- Added localized `shockfront-catch` presentation distinct from hull breach. No TTS, random/homing/endless meteors, dynamic shadows, destruction physics, or per-frame contact allocation was introduced.

## Deterministic balance

`pnpm test:last-ascent` passed 4/4 checks. The shockfront has a five-second grace and reads elapsed time only.

| Strategy | 60 Hz | 120 Hz | Outcome |
| --- | ---: | ---: | --- |
| no boost, full throttle | 83.9667 s / 42.67% | 83.9583 s / 42.67% | caught |
| reference | 100.4833 s / +7.5167 s | 100.4583 s / +7.5417 s | extracted |
| wasted early 2 s | 103.1667 s / +4.8333 s | 103.1750 s / +4.8250 s | extracted |
| boost always held | 100.5333 s / +7.4667 s | 100.4917 s / +7.5083 s | extracted |

All outcomes agree across rates; finish/catch deltas are at most 0.0417 s and separation deltas are below 0.001. Successful traces emit and present exactly three unique +25 checkpoint rewards.

## Browser and performance evidence

`pnpm playtest:last-ascent` passed 10/10 checks against the production build. It exercised fresh lock state, session-only CAIRN unlock, canonical reload, exactly one canvas/selected world, escape HUD, full production autopilot, results/progress persistence, localhost-only runtime, and empty browser/game error channels.

The production journey extracted cleanly in 100.7833 s, cleared 3/3 corridors, retained 100% hull, and finished 7.2167 s ahead.

Hardest scene `debris-beta`, High quality, render scale 1, after every authored vantage was made resident:

| Arm | mean / p95 / max | draws | tris | geom / tex / prog | late shader |
| --- | --- | ---: | ---: | --- | ---: |
| DPR1 | 16.67 / 18.70 / 18.80 ms | 32 | 48,770 | 19 / 11 / 37 | 0 |
| DPR2 | 16.68 / 18.60 / 18.70 ms | 32 | 48,770 | 19 / 11 / 37 | 0 |

Both arms stayed below 160 draws, 620k triangles, 155 geometries, 16 textures, and 55 programs with no long frame or late shader compile/link.

Human-review captures (1920×1080 DPR1, settled, `REVIEW REQUIRED`):

- `playtest-out/last-ascent-browser/screenshots/last-ascent-title.png`
- `playtest-out/last-ascent-browser/screenshots/last-ascent-launch.png`
- `playtest-out/last-ascent-browser/screenshots/last-ascent-debris-beta.png`
- `playtest-out/last-ascent-browser/screenshots/last-ascent-result.png`

## Focused verification

- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test:i18n` — PASS, 9/9
- `pnpm test:campaign` — PASS, 9/9; CAIRN path/gate hashes unchanged
- `pnpm test:boost` — PASS, 2/2; shared drain 20 untouched
- `pnpm test:last-ascent` — PASS, 4/4
- `pnpm playtest:last-ascent` — PASS, 10/10

No broad legacy matrix or `playtest:all` was run.

## Builder falsification (maximum three findings)

1. P1: “always held” initially reused the reference alignment gate and the no-boost arm was not explicitly full throttle. Fixed both strategy definitions and reran the 60/120 matrix.
2. P2: headless pointer-lock recovery obscured flight captures and dark debris lacked early readability. Settled the optional recovery UI before capture and raised the single collision batch's material contrast.
3. P1: several debris surfaces intruded into the visible safe-ring volume even though the centreline remained flyable. Re-authored those offsets; the focused contract now enforces >50 m moving-debris surface margin outside every ring (observed 79.64 m before bounded drift).
