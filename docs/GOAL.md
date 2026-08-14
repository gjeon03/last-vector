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

### Two rules about evidence, both learned the hard way

**Build the artefact from a clean tree, and name the commit.** `dist/` is built from whatever is
on disk, so a green build and a good screenshot can both be true of code that is not in the commit
under review. Before any capture that will be used as evidence, `git status --porcelain` must
return empty, and the commit SHA goes in the report. This is the same failure mode as a capture
harness photographing a 30%-opacity transition and shipping it as a settled screen: the artefact
and the thing you believe you are testing diverge silently, and nothing in the pipeline objects.

**Every claim about state names the commit it was measured at** — "verified at 7de86ce", never
"verified". Several reports in this project were true when written and false when read, because
two authors were exchanging claims about a mutable tree with a round-trip longer than the interval
at which either of them changed it. A stamped report is visibly stale rather than silently wrong,
and it is checkable with one `git show`.

### Measurement discipline

An apparatus with one silently wrong parameter does not return garbage. It returns a plausible
number, in range, that nobody interrogates. Four from this project:

| measurement | free parameter that was silently wrong |
|---|---|
| UI hover produced no sound | audio context did not exist yet — unlock state |
| `vantage('terminus')` moved the ship 0 m | vantage applies during frame update — no frame stepped |
| terminus rim ratio 2.28 (true 1.49) | brightness sampled from an assumed, not fitted, centre |
| terminus silhouette varied 2.1% | luminance threshold caught nebula as the outline |

Note which way each one pointed. `hover: 0` looked like a bug and was correct behaviour. The rim
ratio looked *better* than the truth, which is exactly why it went unexamined. Neither looked
broken, and "does the result look right" would have passed all four.

Three checks, in order of cost:

1. **Read the result against the apparatus's own bounds first.** The silhouette measured 515 px
   against a 520 px scan limit. A value sitting on the edge of its own search range is the
   apparatus reporting its bound, not the subject. This one is mechanical and free.
2. **Treat a flattering error as evidence that a parameter was free.** An unconstrained parameter
   drifts toward whatever makes the number look like what you expected, because nothing is pushing
   back. The rim ratio had a guessed centre and the audio SNR had an unstated bed; both were
   arithmetically fine, both moved substantially when the parameter was fitted or pinned, and both
   unpinned versions happened to flatter. That is not coincidence, and the direction of an error is
   the cheapest signal available that something underneath it was never constrained.
3. **Then ask what the apparatus assumed** — not whether the answer looks right. A metric has to be
   tested for sensitivity to its own free parameters, not only for correctness. Every parameter the
   measurement did not fit, it assumed. List them before publishing the number.

Holding the concept is not a detector. It was applied correctly to two other people's
measurements within the hour of being violated on the author's own, on a number that flattered
the result. The question has to be asked mechanically, because when it fires on a flattering
number nothing feels wrong.

**The check has to run per measurement, not per subject — and the cost ordering is what makes
that affordable.** The four instances are not evenly distributed: three are mine, and two of them
are the same object within the same hour. First a luminance threshold caught the nebula as the
terminus outline; then, measuring the same object again, an assumed centre inflated its rim ratio
by more than half — and I published that one. Per-subject vigilance failed under the best possible
conditions: recent, specific, and still stinging. So memory is not the defence. Nobody
interrogates an apparatus on every number, which is exactly why being burned on the threshold did
not make me interrogate the centre. But reading a result against its own bounds costs nothing, so
it can run on every measurement without requiring either discipline or memory. The free checks are
what make per-measurement possible at all.

**Where it can be enforced, enforce it rather than remember it.** `scripts/playtest/audio-probe.mjs`
reads `git rev-parse HEAD` and `git status --porcelain` and stamps its own summary line — `PASS
16/16 checks at 9b8296e`, or `(DIRTY TREE)` with the offending paths and a note that the numbers
describe no commit. `--require-clean` refuses outright and exits 2, which is the flag for any run
whose output will be quoted as evidence.

## Verification limits — what this build's evidence does NOT cover

Recorded honestly, because an unstated gap reads as coverage.

- **Nobody has heard the audio.** Every audio claim rests on offline `OfflineAudioContext`
  renders, now via a committed harness (`scripts/playtest/audio-probe.mjs`) that reports per-band
  SNR against both the cruise and the boost bed, BS.1770-4 momentary loudness and true peak, with
  the exact `EngineAudioState` of each bed pinned in its output. It does not establish that
  anything *sounds* good — a single human listening to one boost lockout and one gate approach is
  worth more than every measurement in the report.

  An earlier version of this document claimed every cue "clears the detection threshold". **That
  was false.** An independent review flagged `gateNear` as inaudible (−15.6 dB against cruise,
  −23.2 dB against boost, on that reviewer's own metric), and the committed harness confirmed the
  defect and found its mechanism: the cue's own escalation raised its pitch from 1180 to 2430 Hz as
  the gate approached, walking it into the band the turbine owns, so it grew *less* audible as it
  grew more urgent. Re-levelling could not have fixed that; the cue had to move.

  Measured before and after **on the same metric**, against the pinned boost bed:
  `gateNear` −10.4 → +7.5 dB at intensity 0.2, and −26.8 → +5.4 dB at intensity 1.0; `scrape`
  −0.6 → +2.5 dB. The reviewer's figures above are not comparable to these — they use a different
  integration window, which is most of why the two reports disagreed — and a before/after pair
  drawn from two different metrics would overstate the improvement.

  `scrape` carries one further caveat: the game re-triggers it for the length of a contact, so it
  is heard as a sustained texture and the single-grain figure understates it. Measured as used, a
  continuous graze lifts the boost bed by 7.7 dB (implied cue-over-bed +6.9 dB). The harness
  asserts both, because the single-grain check alone is not sufficient for that cue.

  The blanket claim is replaced by a stated margin under a stated metric (200 ms integration
  window; the full-span figures are 8–12 dB lower and are also reported).
- **Peak levels in the audio tables carry roughly ±3 dB of harness noise** for click-heavy
  events. The limiter's 4× oversampling resamples a 1 ms transient differently depending on its
  phase within the render quantum, so a pure time shift moved a reported peak by 2.95 dB. RMS,
  band-energy and increment figures are averages and are unaffected; the conclusions rest on
  those.
- **Pointer-locked mouse flight has never been exercised, in any driver.** This is the largest
  evidence gap in the project: four of eight reviewers on the expert panel could not judge the
  primary control scheme.

  The failure is environmental, and that is established rather than assumed. `requestPointerLock`
  is refused in Playwright Chromium both headless and headed, with the browser's own reason —
  "The root document of this element is not valid for pointer lock." A control experiment calling
  `document.body.requestPointerLock()` directly from a trusted click on the same page fails
  identically, so the refusal is not caused by anything in `src/core/Input.ts`. The Chrome
  extension driver cannot reach the local static server in this environment either.

  What HAS changed: the refusal is no longer swallowed. `Input` listens for `pointerlockerror`,
  reports the promise rejection, exposes `lockRefused`, and the game raises a player-facing
  callout that the keyboard still flies. Previously a browser that refused capture was
  indistinguishable from one that granted it — which is precisely why this went unnoticed.

  Closing this needs a human with a mouse. Nothing else will do it.
- **No gamepad has been connected.** The code path is read-only verified.
- **The results, pause and settings screens have only synthetic-background evidence.** The
  in-flight HUD was re-verified against the real renderer; those three were not.
- **Frame-rate headroom is unknown.** Every configuration measured is vsync-locked at 60, so the
  ceiling was never found — only that ultra at 1440p does not approach it on this machine.

## Safe autonomy

Lead owns: engine/tech choices, art direction, palette, ship design, course layout, flight
model tuning, HUD language, audio design, naming, and all creative detail not specified above.
