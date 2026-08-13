# Goal Ledger — G1

**Run:** `755dda47-81b7-4de8-ba20-98eb21f8b0be`
**Logical lead:** Claude (host = Claude) · **Partner:** Codex
**Policy:** claude-lead — the dominant unresolved risk is experience/art direction ("does it *feel* like a great space flight game?"), not repository integration.

## Outcome

**LAST VECTOR** — a browser game where the player pilots a spacecraft through open space,
flies through a sequence of checkpoint gates, and reaches a final destination.

## Mandatory criteria

| # | Criterion | Evidence method |
|---|-----------|-----------------|
| M1 | Runs entirely client-side; `dist/` deploys to any static host with no server code | build + serve `dist/` over plain static file server |
| M2 | Player pilots a spacecraft in 3D space with continuous 6-axis-capable control | headless input drive + telemetry |
| M3 | Sequential checkpoint gates must be flown through; passing is detected reliably | scripted playthrough reaching final gate |
| M4 | A final destination terminates the run with a resolution beat | scripted playthrough to `finished` phase |
| M5 | 60 fps at 1920×1080 on the dev machine; no console errors | perf probe + console capture |
| M6 | Zero external network requests at runtime (fully self-contained) | network capture during play |
| M7 | Keyboard + mouse; pointer-lock flight; gamepad optional | manual + scripted |

## Quality bar

Everspace 2-class **visual fidelity, atmosphere, sense of scale, flight feel, and polish** —
reached with original art direction and 100% procedural assets (no copied designs, names, or IP).

Concretely, the build is only "excellent" when all of these hold:

- **Q1 Scale** — layered depth reads instantly: near dust → mid debris/asteroids → far megastructures → planetary bodies → background nebula. The player can tell that objects are *kilometres* apart.
- **Q2 Light** — one dominant warm key light, strong colour separation between lit/shadow/rim, HDR emissives that bloom convincingly, ACES-class tonemapping.
- **Q3 Motion** — speed is *felt*: parallax streaks, camera lag and spring, FOV kick, boost distortion, inertial drift. Turning has weight; the ship is never a rigid camera.
- **Q4 Atmosphere** — volumetric nebula and scattering, god rays, colour grading with a deliberate palette; the sector feels like a *place*, not a skybox.
- **Q5 Readability** — the next gate is always findable within ~1 second, even off-screen. HUD is diegetic, restrained, and never blocks the view.
- **Q6 Polish** — title/briefing/countdown/finish flow, procedural audio, settings, pause, no placeholder text, no jank at any transition.

## Anti-goals / constraints

- Do **not** copy Everspace 2 assets, ship silhouettes, UI layouts, names, or story. Reference the *class* of quality only.
- Do **not** expand the objective. No combat loop, no loot, no RPG systems, no multiplayer.
- No runtime CDN dependency, no analytics, no telemetry beacons, no server.
- No binary art assets checked in — everything procedural or generated at build/runtime.
- TypeScript strict, named exports, 2-space indent (project convention).

## Evidence plan

1. `pnpm typecheck` + `pnpm build` clean.
2. Static-serve `dist/`, drive the game headlessly through `window.__LV` harness API.
3. Screenshot matrix at fixed course positions → fresh visual critics score against Q1–Q6.
4. Perf probe: frame-time histogram, p95, draw calls, triangles.
5. Network capture asserts zero external requests.
6. Fresh `FINAL_REVIEW` challenge before claiming COMPLETE.

## Verification limits — what this build's evidence does NOT cover

Recorded honestly, because an unstated gap reads as coverage.

- **Nobody has heard the audio.** Every audio claim rests on offline `OfflineAudioContext`
  renders measured in headless Chromium: per-event band energy, RMS, and an "audibility
  increment" over the engine bed. That proves each cue exists, is placed in a band the drive
  leaves open, and clears the detection threshold. It does not establish that anything *sounds*
  good. A single human listening to one boost lockout and one gate approach is worth more than
  every measurement in the report.
- **Peak levels in the audio tables carry roughly ±3 dB of harness noise** for click-heavy
  events. The limiter's 4× oversampling resamples a 1 ms transient differently depending on its
  phase within the render quantum, so a pure time shift moved a reported peak by 2.95 dB. RMS,
  band-energy and increment figures are averages and are unaffected; the conclusions rest on
  those.
- **Pointer-locked mouse flight is inferred, not felt.** Pointer lock is unavailable in the
  headless driver, so the virtual-stick behaviour is reasoned from `src/core/Input.ts`. Keyboard
  and harness axes are measured.
- **No gamepad has been connected.** The code path is read-only verified.
- **The results, pause and settings screens have only synthetic-background evidence.** The
  in-flight HUD was re-verified against the real renderer; those three were not.
- **Frame-rate headroom is unknown.** Every configuration measured is vsync-locked at 60, so the
  ceiling was never found — only that ultra at 1440p does not approach it on this machine.

## Safe autonomy

Lead owns: engine/tech choices, art direction, palette, ship design, course layout, flight
model tuning, HUD language, audio design, naming, and all creative detail not specified above.
