# LAST ASCENT — Chapter 02 builder report

Date: 2026-08-25  
Track: `parallel-gauntlet/flight-action-campaign-20260825/track/last-ascent`

## Delivered

- Added active mission `last-ascent` after CAIRN with canonical `?mission=last-ascent`, clear-only unlock, Chapter 02 metadata, ruleset-partitioned PB key, Korean story/a11y, English technical chrome, objective-specific briefing/HUD/result/failure copy, and a two-node campaign rail.
- Added one selected ACHRA ascent world: a 99,980 m authored path, launch structure, guided-impact celestials, elapsed-only shockfront, three sparse debris decisions/recovery gaps, and broad orbital extraction.
- Collision population is fixed at 20 in one instanced collision batch. Decorative debris and three broken-arc safe-corridor markers use two more instanced batches. The nearest contact spawn is 29,782.3 m from the ship start (the inherited P2 exact-centre/1 mm guard is recorded); the minimum initial moving-debris surface margin outside an authored safe corridor is 43.54 m. The three route blockers measure 0, 1.42e-14 and 0 m from their corresponding sampled path centres.
- Added three one-shot `boost-recharge` rewards of +25. Stable `escape-checkpoint` source indices are adapted downstream to one-based radio and a procedural checkpoint SFX; the common reward transport remains mission-agnostic.
- Added localized `shockfront-catch` presentation distinct from hull breach. No TTS, random/homing/endless meteors, dynamic shadows, destruction physics, or per-frame contact allocation was introduced.
- Independent-review correction: all three debris walls now contain a fixed route-centre blocker while their authored offset openings remain clean. ACHRA has a visible crater ring, branching fissures, impact plume and fixed shard train aimed from the guided moon. A normalized-separation warning advances through hysteretic `nominal` / `warning` / `critical` HUD states and reuses the procedural `warnProximity` SFX only on bounded escalation transitions.

## Deterministic balance

`pnpm test:last-ascent` passed 5/5 checks. The shockfront has a five-second grace and reads elapsed time only.

| Strategy | 60 Hz | 120 Hz | Outcome |
| --- | ---: | ---: | --- |
| no boost, full throttle | 84.1000 s / 43.00% | 84.0917 s / 43.00% | caught |
| offset reference | 100.5333 s / +7.4667 s | 100.5000 s / +7.5000 s | 3/3, hull 1.0, zero contacts |
| wasted early 2 s | 103.1833 s / +4.8167 s | 103.1750 s / +4.8250 s | extracted |
| boost always held | 100.5833 s / +7.4167 s | 100.5333 s / +7.4667 s | extracted |
| same-boost route centreline | 104.1000 s / hull 0.2775 | 104.1000 s / hull 0.1708 | damaged by debris 2/10/16 |

All outcomes agree across rates; finish/catch deltas are at most 0.0500 s and separation deltas are below 0.001. Clean successful traces emit and present exactly three unique +25 checkpoint rewards. The negative control uses the reference throttle/boost rule but steers along the un-offset route centre: it hits all three authored centre blockers (five resolved contact frames), first hits debris `2` at 31.4833 s with severity 1.0 while 27.44% of the path remains between ship and front, and loses hull at both rates. The offset reference clears 3/3 with no contact and full hull at both rates, so the negative outcome is physical debris contact rather than missing rewards or shockfront catch.

## Browser and performance evidence

`pnpm playtest:last-ascent` passed 10/10 checks against the production build. It exercised fresh lock state, session-only CAIRN unlock, canonical reload, exactly one canvas/selected world, escape HUD, full production autopilot, results/progress persistence, localhost-only runtime, and empty browser/game error channels.

The production journey extracted cleanly in 100.8333 s, cleared 3/3 corridors, retained 100% hull, and finished 7.1667 s ahead. The focused no-boost browser arm reached the `critical` HUD state at 83.0000 s with 1,931 m / normalized 0.01932 separation, positive hull, and a visible `SHOCKFRONT CRITICAL` edge callout before catch.

Hardest scene `debris-beta`, High quality, render scale 1, after every authored vantage was made resident:

| Arm | mean / p95 / max | draws | tris | geom / tex / prog | late shader |
| --- | --- | ---: | ---: | --- | ---: |
| DPR1 | 16.67 / 17.60 / 17.70 ms | 40 | 49,126 | 23 / 11 / 39 | 0 |
| DPR2 | 16.67 / 17.60 / 17.70 ms | 40 | 49,126 | 23 / 11 / 39 | 0 |

Both arms stayed below 160 draws, 620k triangles, 155 geometries, 16 textures, and 55 programs with no long frame or late shader compile/link.

Human-review captures (1920×1080 DPR1, settled, `REVIEW REQUIRED`):

- `playtest-out/last-ascent-browser/screenshots/last-ascent-title.png`
- `playtest-out/last-ascent-browser/screenshots/last-ascent-launch.png`
- `playtest-out/last-ascent-browser/screenshots/last-ascent-near-front.png`

## Focused verification

- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test:i18n` — PASS, 9/9
- `pnpm test:last-ascent` — PASS, 5/5
- `pnpm playtest:last-ascent` — PASS, 10/10

Correction verification intentionally did not rerun campaign/boost or any broad legacy matrix; the previously recorded campaign 9/9 and boost 2/2 evidence remains unchanged. `playtest:all` was not run.

## Builder falsification (maximum three findings)

1. P1: “always held” initially reused the reference alignment gate and the no-boost arm was not explicitly full throttle. Fixed both strategy definitions and reran the 60/120 matrix.
2. P2: headless pointer-lock recovery obscured flight captures and dark debris lacked early readability. Settled the optional recovery UI before capture and raised the single collision batch's material contrast.
3. P1: several debris surfaces intruded into the visible safe-ring volume even though the centreline remained flyable. Re-authored those offsets; the original focused contract enforced a positive moving-debris surface margin outside every ring.

The bounded correction initially tightened the reward volume around the new opening and the reference stopped receiving its 3/3 rewards. Before evidence capture, the opening was instead moved farther off the blocked centreline while retaining the existing 360 m reward volume. The final real-contact matrix above is the falsification evidence for both routes.
