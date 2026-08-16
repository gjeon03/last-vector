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

**A check that cannot answer must fail loudly, because silence and success are the same
output.** Three instances in one day, every one biased toward "all clear": a staleness checker
whose parse error put the literal word `at` into the ref, so `git diff at` died on stderr with
exit 128 while stdout stayed empty and an empty diff scored "not stale" — a broken check and a
clean bill of health, indistinguishable; a BSD-sed incompatibility that silently substituted
nothing; and `all.mjs --require-clean`, which reds four suites at SETUP for an unrelated reason.
The repair is never "be more careful reading the output": validate the ref before diffing, check
the exit code of the instrument itself, and treat "the check found nothing" as a claim that needs
the check's own health as a premise. The operator nearly accepted the first failure because it
agreed with what they already believed — which is exactly when it fires.

**Where it can be enforced, enforce it rather than remember it.** `scripts/playtest/audio-probe.mjs`
reads `git rev-parse HEAD` and `git status --porcelain` and stamps its own summary line — `PASS
16/16 checks at 9b8296e`, or `(DIRTY TREE)` with the offending paths and a note that the numbers
describe no commit. `--require-clean` refuses outright and exits 2, which is the flag for any run
whose output will be quoted as evidence.

| the countdown froze — or did it | which build the static server was handing out |
| planet relit — or vanished | whether the shader linked at all |
| the perf gate was green for four rounds | `deviceScaleFactor`, hard-asserted at 1 |

Three later ones, all after the two checks above were written down. The first was aimed at
someone else's work: a stale `dist` returned `countdown expired` where the fix says `frozen`,
which reads as a defect in the lead's reasoning rather than as a stale server. A plausible wrong
answer pointed at another person is the most expensive form this takes, because the correct
conclusion — *my apparatus is stale* — is the one nobody reaches while reading somebody else's
code.

So the artefact rule needs its sharper form. **The question is not "did I build" but "is the
thing being served the thing I changed".** Chaining the build and the serve into one command
answers it; running them separately does not, and leaves no trace when it goes wrong.

And the fourth row is the widest: for four review rounds the performance gate hard-asserted
`deviceScaleFactor === 1`, so every frame-time figure in the project described a configuration
the game does not ship in on any Retina or 4K display — 2.07 Mpx measured against 8.29 Mpx
allocated. An apparatus can be blind by *assertion*, not only by parameter, and an assertion that
pins a variable is indistinguishable from one that tests it until someone asks what it excludes.



**Two confirmations that share a hidden dependency are one confirmation, and they feel like two.**

This is the rule that would have prevented the most expensive error in the project. Diagnosing a
teammate's failing harness, the author ran two checks — `grep` for a method in the built bundle,
and a live Playwright probe against the preview server — and both said the game was healthy, so the
fault was handed back as "your static server is the variable". Both measurements pointed at a
`dist/` the author had rebuilt in between; the teammate's suite had been serving one three commits
older. Two *different instruments* agreeing read as independent corroboration. The agreement was
structurally guaranteed and carried no information, and it is precisely the agreement that retired
the doubt.

The same observation arrives from the other side in the audio work: two implementations reproducing
a figure to 0.0 dB rules out independent error — arithmetic, banding, window misalignment — and
rules out nothing about a shared wrong assumption. Both instruments agreed perfectly the entire
time they were blind to the two defects that mattered.

So: **the evidence that feels strongest is the evidence to interrogate first.** Ask what two
agreeing measurements share before treating their agreement as weight.

**Corollaries earned since.**

- *The right evidence for diagnosing a defect is often the wrong quantity for describing it.* The
  music-send bypass was diagnosed by a fraction — 6.5% of the score reached the duck — and that
  fraction implies "~15x more". The rendered outcome was 3.99 dB, bounded by the trim depth and
  diluted by the drive in the bed. Anyone told "fifteen times" expects far more than four decibels.
- *A gate can be blind by assertion, not only by parameter.* `perf-probe` hard-asserted
  `deviceScaleFactor === 1` for four review rounds, so every frame-time figure described a
  configuration the game does not ship in on any Retina or 4K display.
- *The apparatus can be the load.* Inside `all.mjs` the perf arms measured a 66 ms worst frame;
  standalone on the same commit, 18.6 ms and zero long frames. They were sampling the previous
  suite's browser teardown. `hostLoad` is now recorded in the evidence so a future instance is
  attributable rather than a mystery.
- *Measure a class, claim a class.* `FILL_BUDGET_PIXELS` was verified at the single configuration
  where the budget binds and shipped as a fix for every configuration; a 4K desktop still allocated
  3.3x the declared budget.
- *A number without its build is a claim without its commit.* Two G-load distributions (p90 25.4
  and 34.7) looked like a measurement dispute and were two different courses, because a geometry
  fix had landed in between and neither lap recorded which build it came from.
- *A new check's first disagreement is more likely to be its own.* It has never run against a
  known-good state, so it has no baseline to be surprising against. Three for three in the audio
  suite: every surprising number was the instrument before it was the subject.
- *Verify the result of a copy, not the exit of the command.* `cp` aliased to `cp -i` caught two
  authors in one session, in opposite directions. The visible failure cost ten minutes; the silent
  one cost correctness, because the copy did not happen and the author carried on believing two
  files were in sync.


**Capability assertions and wiring assertions look identical in a report and fail in completely
different circumstances.** The operational test, and it is cheap: **a capability assertion passes
when you delete the caller.**

Silence a graph and an offline check still passes; unwire the method that is supposed to silence it
and the same check still passes. Every instrument in this project that has embarrassed us was the
first kind sold as the second, and the test predicts each failure retroactively: delete the code
that aims the vantage camera and the screenshot suite's histogram checks still pass — which is how
ten stills of empty sky went green. Delete the fill-budget clamp and the performance gate still
passes, because it was pinned to `deviceScaleFactor === 1`. An assertion that cannot tell the two
apart should say which one it is in its own name.

**A correct description of a defect is not a fix, and it reads like one.** Three instances, by two
authors, in one week: a source comment naming both bypassed audio nodes, written by the author who
then fixed one of them and shipped the sentence describing the other; `Course.ts` claiming leg
lengths were the remedy when `git show` proves every leg byte-identical across that commit; and two
G-load distributions labelled "pre-fix" and "post-fix" that both reproduce on a single commit with
no code change between them. Comments survive review because nobody measures them.

**A declared support range bounds layout, not accessibility.** Keyboard focus escaping the viewport
was undetectable at 1280 and above, because `maxScrollTop` is 0 there and the defect cannot
manifest. The test was correct everywhere it was allowed to look. This is the free-parameter
failure with a spec as the parameter — and it is the nastiest variant, because holding the value
constant was compliance rather than oversight, and nothing distinguishes *I chose not to vary this*
from *I was told I did not have to*.

**An instrument is the last thing its own users audit.** Six rounds of reviewers examined the game
and never the aggregator — which is the thing that tells them whether the game is fine. `all.mjs`
computed its verdict from `report.status` alone and ignored child exit codes, so `--require-clean`,
which writes its report and exits 2, could never fail the gate it was added to. Three authors spent
an exchange calibrating the strictness of a mechanism that was inert. It was found in one pass by
an agent from a different family, with no stake in the apparatus, reading the aggregator instead of
the game.

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
- **Pointer-locked MOUSE flight has never been exercised, in any driver.** Still the largest
  evidence gap in the project, and the reason four of eight reviewers on the expert panel could not
  judge the primary control scheme.

  **CORRECTION, round 7.** An earlier version of this bullet said the failure was environmental and
  that this "is established rather than assumed". The environmental half is true and is restated
  below. The word *established* was not, and the error was load-bearing: it attributed the whole
  gap to the browser and so nobody looked for a cause we controlled.

  There were two gates, and pointer lock was the second. `Input.update()` returns inside its
  override branch at `src/core/Input.ts:171`, and `__LV.setInput` — the only way any suite supplied
  flight input — takes that branch. So the virtual stick, the expo response curves, the key
  mapping, the throttle integrator, `mouseSensitivity`, `invertY` and the entire gamepad block were
  executed by **no automated test at all**, and would not have been even with pointer lock granted.
  Worse, `handleKeyDown` is a window listener whose only `locked` reference is the Tab guard, so the
  **keyboard half was never gated on pointer lock in the first place** — it was testable throughout
  and simply was not tested.

  The claim that hid this was `M2.automation-input`, which declared `criterion('M2', 'full',
  'Exercises every declared control')`. Proven false by mutation rather than argued: stubbing
  `Input.held()` kills every key-derived input in the game, `INPUT.keys-drive-the-command` goes red,
  and **M2 stays green**. Six rounds of review had read that `full` as coverage.

  Now covered by `INPUT.keys-drive-the-command` and `INPUT.invertY-reaches-flight`: the key-derived
  axes in both signs, the throttle integrator measured as a rate rather than an endpoint, and
  `invertY` in both positions through the real settings path. Still genuinely blocked, and blocked
  environmentally: the mouse-derived virtual stick, `mouseSensitivity`, `expo` on stick input, the
  gamepad branch, and pointer lock itself. `mouseSensitivity`'s continued invisibility is now
  asserted by an inverse mutation, so the day a harness reaches the mouse path this paragraph starts
  failing a check instead of quietly going stale.

  The environmental part, unchanged and still true. `requestPointerLock`
  is refused in Playwright Chromium both headless and headed, with the browser's own reason —
  "The root document of this element is not valid for pointer lock." A control experiment calling
  `document.body.requestPointerLock()` directly from a trusted click on the same page fails
  identically, so the refusal is not caused by anything in `src/core/Input.ts`. The Chrome
  extension driver cannot reach the local static server in this environment either.

  What HAS changed: the refusal is no longer swallowed. `Input` listens for `pointerlockerror`,
  reports the promise rejection, exposes `lockRefused`, and the game raises a player-facing
  callout that the keyboard still flies. Previously a browser that refused capture was
  indistinguishable from one that granted it — which is precisely why this went unnoticed.

  Closing the mouse half needs a human with a mouse. Nothing else will do it. Closing the rest did
  not, and that is the lesson: for six rounds an environmental limit was cited for a gap that was
  mostly a choice, because the sentence naming the limit could not fail.
- **No gamepad has been connected**, and the gamepad branch sits in the region above that no
  automated test reaches, so "the code path is read-only verified" is all that can be said for it.
- **Twenty-one claims in this project's own record have been disproved by measurement — see
  `docs/LEDGER.md`, which is the authority.** Counts kept in prose, including the "eight" that
  used to open this bullet, have been wrong in both directions; one round produced two different
  findings each labelled "the eleventh". Eleven of the twenty-one are the author's, and five were
  born inside corrective work. The pattern is not carelessness about facts — nearly every row had
  its supporting facts right. It is asserting a **mechanism** where a **measurement** was owed.

  Two of round 7's fixes failed the same way and had to be made three times each. In both, the
  premise was verified and true and the inference from it was false — that declining to `resume()`
  keeps an audio context silent (it does not, where autoplay is permitted the context starts
  `running`), and that putting profile values on the slider grid makes a value-equality test sound
  (it destroys the unreachability that test depended on).

  The rule this yields, and the only one that has actually worked: **a claim about coverage can be
  settled only by deleting the subject and watching what survives.** Every other form of the
  argument is a story about the code, told by someone who has read it.
- **The results, pause and settings screens have only synthetic-background evidence.** The
  in-flight HUD was re-verified against the real renderer; those three were not.
- **Frame-rate headroom is unknown.** Every configuration measured is vsync-locked at 60, so the
  ceiling was never found — only that ultra at 1440p does not approach it on this machine.

## Safe autonomy

Lead owns: engine/tech choices, art direction, palette, ship design, course layout, flight
model tuning, HUD language, audio design, naming, and all creative detail not specified above.
