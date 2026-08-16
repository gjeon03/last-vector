# Disproved-claim ledger

Every claim this project stated as fact and measurement later disproved. **Counts derive from this
table** — two round-9 reviewers each labelled their find "the eleventh", which was possible only
because the count lived in prose. A row enters with: the claim, who disproved it, the measurement,
and where the correction lives. Reconstructed from the full commit history by an independent
read-only audit at `a01b128`; maintained here since.

| ID | Claim (location) | Disproved by | Measurement | Correction |
|---|---|---|---|---|
| L01 | Course.ts: "the fix is not more turn — it is less room" | skeptic review | f3aea92 changed clearance only; 59f4bc9 raised 6/9 turn magnitudes and every length | 4582276, b572962 |
| L02 | Hud.ts: pre/post G-load distributions proved an improvement | skeptic review | both distributions reproduce on one unchanged commit | 4582276 |
| L03 | audio-probe measured the live volume-control path | audio reviewer | probe assigned gains directly, never called setMusicVolume | b572962 |
| L04 | Gate.ts: every placement rotation was about Z; direct sun exactly zero | skeptic review + Codex | pre-fix code carried X/Y rotations; hemisphere-dominated illumination, side walls 6.3% | b572962, 66451e8, d9c27c5 + this batch |
| L05 | PostFX.ts: flat regions pay four taps | TA reviewer | five taps; with CA, 15 flat / 39 edge fetches | b572962 |
| L06 | harness.ts: harness pitch inverted downstream ("before invertY is applied") | harness audit | override returns before invertY is read | b572962 |
| L07 | styles.css: min-height:0 was load-bearing | interface skeptic | forcing min-height:auto moved clientHeight 0 px everywhere | 66451e8 |
| L08 | M2 "full": automation exercised every declared control | mutation M10a | stubbing held() killed all keys, M2 stayed green | 0dc47b5, 81ae7f7 |
| L09 | audio-live "compared directly" its two pause readings | audio reviewer | each checked against expectations; never compared | b572962 |
| L10 | styles.css: "three of five panels had the guard" | interface skeptic | two guarded, three not; .lv-pause missed because of the miscount | 66451e8 |
| L11 | AudioEngine.ts: browsers refuse to create a context outside a gesture | audio skeptic | construction succeeds suspended; only resume() needs the gesture | 66451e8 |
| L12 | Settings/Screens: value-equality proved renderScale untouched; net-zero drag + thumb disagreement explained it | second skeptic | deliberate 0.72 must stay; net-zero drag reproduces on neither grid; visible thumb is JS fill | 42d0dce |
| L13 | Declining resume() guaranteed pre-gesture silence | second skeptic | with autoplay permitted the context starts running; sources had already started | 8e8291d |
| L14 | M3 "full": collision/draw parity asserted directly | QA mutation P11 | rewiring the collider changed no check | e66a53c |
| L15 | GOAL.md: mouse flight "needs a human... nothing else will do it" | QA, by construction | pointerLockElement override + MouseEvents drive the shipped pipeline; found the boost latch on first contact | 926f6c0 + this batch |
| L16 | screenshot matrix: 5 positions x 10 vantages = 50 distinct views | suite reviewer | ten repeated views, not a product | 78fec22 |
| L17 | screenshot checks proved meaningful imagery / asserted subject bounds | visual reviewers | black/magenta/loading frames passed size-only checks; the edge assertion never ran | 78fec22, 317b63 + this batch |
| L18 | harness present() rendered one requested frame | harness reviewer | a start-line capture published as the destination frame | 874d6d9 |
| L19 | GOAL.md: every cue cleared the detection threshold; before/after comparable | audio review | gateNear −15.6/−23.2 dB; mixed metrics overstated the improvement | c49c3b8, 158c457 |
| L20 | PLAYTEST.md M5: criterion "≥60 FPS" | perf reviewer | a perfectly vsynced run reports ~59.99; the gate uses mean/p95/max budgets + renderScale floor | 0aae99d + this batch |
| L21 | GOAL.md: "exactly eight such claims, five lead-owned, one correction-born" | Codex ledger audit | enumeration yields 21 roots, 11 lead-owned, 5 correction-born | this batch |

## Pattern numbers (derived, not maintained)

- **Total roots: 21.** Lead-owned: **11**. Born inside corrective work: **5** (L04's repeat, L07, L10, L12, L13).
- Nearly every row asserted a **mechanism** where a **measurement** was owed; the corrections that
  have held are the ones that replaced the sentence with an instrument (a mutation, a manifest
  entry, a recorded reference) rather than a better sentence.
