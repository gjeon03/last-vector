# Chapter 01 Stages — Implementation Plan

- Design: `docs/superpowers/specs/2026-08-25-chapter-one-stages-design.md`
- Branch: `codex/chapter-one-stages`
- Base: `codex/develop` at `5e4fe09126d44a6467b54c2a07128258f47693b0`
- Merge boundary: commit and push this branch; do not merge `main`.

## Execution Principles

- Preserve CAIRN physics, course signature, PB keys, and default URL behavior.
- Keep the dormant `needle-grave` definition and facts recognized but unreachable.
- Add no meteor-survival code to this branch.
- Use red/green contract checks at subsystem boundaries, not a full browser suite after each edit.
- Give parallel workers exclusive file ownership; the root agent owns `Game.ts` integration.
- Treat Steps 1–4 as one compile-green foundation checkpoint. Workers may temporarily expose
  expected cross-file type errors while the widened stage union is being integrated; do not
  weaken types or add placeholders just to make a partial parallel tree compile.
- Stop tuning when a route is readable, cleanly flyable, visually distinct, and inside the fixed
  resource budget. Do not add decorative systems merely to fill the scene.

## Step 1 — Freeze Chapter Contracts and Catalog Ownership

### Files

- Modify `src/core/Courses.ts`
- Modify `src/core/Progress.ts`
- Modify `src/core/CourseSelection.ts`
- Modify `scripts/playtest/campaign-contract.mjs`
- Modify `scripts/playtest/manifest.mjs` only if an existing exact ID cannot express the contract

### Work

1. Change `CourseId` to recognize:
   - `cairn-drift`
   - `needle-grave`
   - `wreckline`
   - `ringfall`
2. Replace the coupled feature flag/order with:
   - `KNOWN_COURSE_ORDER` for sanitized retained data.
   - `CHAPTER_ONE_STAGE_ORDER` for reachable player stages.
3. Remove definition-owned `unlocks`; stage availability and the next stage are derived only from
   ordered clear facts, with no second unlock truth in catalog or harness snapshots.
4. Keep `needle-grave` in the catalog but exclude it from active order, next-stage lookup, saved
   selection, and URL authorization.
5. Add final WRECKLINE and RINGFALL course definitions with stable default seeds, legs, clearances,
   rank rules, vantages, destination palettes, landmark kind, pilot tuning, and radio authoring.
6. Generalize progress clone/merge/sanitize loops over recognized IDs.
7. Derive unlock for stage `n` from every preceding active stage's clear fact.
8. Generalize first-clear/unlock reporting; never persist an `unlocked` boolean.
9. Preserve the absent-storage CAIRN-PB migration exactly.
10. Preserve strict URL precedence and fail-closed locked/inactive behavior.

### RED first

Update `pnpm test:campaign` to require:

- Active order `cairn-drift → wreckline → ringfall`.
- NEEDLE recognized but inactive.
- Clear-only sequential unlocks independent of rank/clean/precision.
- `getNextCourse` chain ending in `null`.
- Distinct PB prefixes with historical CAIRN prefix unchanged.
- Invalid, inactive, and locked URLs resolving to CAIRN.
- Two or three monotonically ordered radio entries per new stage with valid bilingual keys.

### Acceptance

- `pnpm test:campaign` passes.
- Existing CAIRN default seed, course record ID, and definition values remain unchanged.
- Full `pnpm build` is intentionally deferred until Step 4 has updated the exhaustive Game/i18n
  consumers of the widened `CourseId` union.
- No browser test is run in this step.

## Step 2 — Add Compact Stage Rail and Hybrid-Language Flow

### Files

- Modify `src/ui/Screens.ts`
- Modify `src/ui/Overlay.ts` only for the smallest host/API additions
- Modify `src/ui/styles.css`
- Modify `src/i18n/messages.ts`
- Modify `src/i18n/ko.ts`
- Modify `src/i18n/en.ts`
- Modify `src/i18n/domain.ts` and `src/i18n/typeFixtures.ts` only when required by typed keys
- Modify `scripts/playtest/i18n-contract.mjs`

### Work

1. Replace the disabled two-card route strip with a compact three-node horizontal stage rail.
2. Keep `START FLIGHT` as a separate primary action.
3. Implement roving focus:
   - Left/Right follows the horizontal visual axis.
   - Locked nodes are focusable/described with `aria-disabled=true` but cannot change the active
     stage.
   - Enter/Space selects only an unlocked node and never launches the run by accident.
4. Update title sector, destination, and Korean scenario summary from the selected stage.
5. Render compact clear/S/clean/precision markers without route cards or a mastery wall.
6. Use stable selectors:
   - `[data-stage-id]`
   - `[data-stage-state="locked|available|cleared"]`
   - `[data-stage-selected="0|1"]`
   - `[data-action="next-stage|run-again|stage-select"]`
7. Keep English technical chrome and Korean narrative/a11y copy.
8. Ensure the rail stays one row with ≥24px targets at 375×667 and 640×360.

### RED first

Extend fast i18n/source contracts for exact stage IDs, key parity, hybrid-language tokens, semantic
selectors, and absence of translated IDs.

### Acceptance

- `pnpm test:i18n` passes.
- Source/contract syntax checks pass; full `pnpm build` is deferred to the Step 4 integration
  checkpoint.
- No long localization browser matrix is run.

## Step 3 — Build Allocation-Free Stage Landmarks

### Files

- Add `src/render/StageLandmarks.ts`
- Modify `src/render/Structures.ts` only to export shared geometry/material construction needed by
  the stage landmark owner
- Add a small browser-free `scripts/playtest/stage-landmarks-contract.mjs` only if structural
  counts cannot be asserted through the existing campaign contract
- Modify `package.json` only when the new fast contract requires a script

### Work

1. Create one `StageLandmarks` owner selected by the course definition's landmark kind:
   - CAIRN: existing shelf composition.
   - WRECKLINE: `TWIN KEELS`, `THE FRACTURE`, `ENGINE SPINE`.
   - RINGFALL: `RING WALL`, `TWIN SPIRES`, `ORISON ARCH`.
2. Reuse existing structure shaders/materials. Share geometries and materials within a stage.
3. Keep all landmark transforms deterministic from stage seed and authored anchors.
4. Expose a bounded immutable collider set (maximum 24 simple sphere approximations) for
   integration into the existing collision pass; do not add an independent broad-phase.
5. Expose JSON-safe debug counts for draws, triangles, geometries, materials, and colliders.
6. Implement `update`, `setPixelScale` if needed, and `dispose` without per-frame allocations.
7. Reject authored landmark colliders that intersect the protected clean channel.

### Acceptance

- Construction is deterministic for a fixed stage seed.
- CAIRN's existing shelf resource/signature evidence remains unchanged.
- Each new stage stays within the predeclared global ceilings from the design.
- Clean-channel/collider validation passes browser-free.

## Step 4 — Integrate Stage Worlds, Collision, Pilot, and Safe Radio

### Files

- Modify `src/game/Game.ts`
- Modify `src/core/contracts.ts` for the definition-owned final-gate descriptor union
- Modify `src/game/Course.ts` only for definition-owned final gate messages or route evidence
- Modify `src/ui/Hud.ts` only to share the existing radio-duration formula
- Add `src/core/RadioSchedule.ts` for a pure duration/safe-window contract
- Modify `src/core/harness.ts`
- Modify `src/main.ts`

### Work

1. Construct exactly one `StageLandmarks` instance for the selected stage and remove unconditional
   shelf construction.
2. Update and dispose the selected landmark owner through the existing world lifecycle.
3. Integrate its ≤24 immutable colliders into `resolveCollisions` using the current impact path and
   allocation-free scratch values.
4. Include landmark colliders in camera-vantage clearance without changing CAIRN asteroid logic.
5. Replace route-ID-specific pilot branches with definition-owned brake/boost tuning while keeping
   CAIRN's numeric path identical.
6. Replace the hard-coded two-route radio record with definition-owned stage lines.
7. Export one pure `radioDurationSeconds(englishLength)` function used by both HUD playback and
   authoring validation.
8. Enforce each new line's safe window:
   `next commitment time >= subtitle TTL + 2.0 seconds`.
9. Remove immediate radio emission from the gate-pass callback. Queue lines by authored progress,
   wait until the current ENGAGE/gate/event callout has ended, then revalidate the remaining safe
   window before emitting; discard or defer a line whose window is no longer safe.
10. Reduce in-flight CAIRN story playback to at most three safely scheduled beats without changing
   flight physics, score, or PB evidence; move any retained non-safe copy to briefing/result.
11. Replace the catalog/harness `unlocks` snapshot with ordered derived availability/next-stage
    evidence while keeping the API JSON-safe.
12. Add harness evidence for stage ID, landmark signature/colliders, radio schedule, stage URL, and
    deterministic course completion. Add a dedicated `stageLandmarkCollision()` seam rather than
    changing the existing asteroid-only `stageCollision()` contract.

### Acceptance

- CAIRN course signature, default PB identity, and deterministic clean result remain unchanged.
- WRECKLINE and RINGFALL deterministic pilots finish cleanly at 60 Hz and 120 Hz.
- A staged landmark collision uses the production impact path.
- No landmark collider intersects the protected route.
- No radio overlaps a gate-clear callout or an authored braking commitment.
- `pnpm build`, `pnpm test:i18n`, and `pnpm test:campaign` all pass together before the foundation
  checkpoint is committed.

## Step 5 — Complete Progression, Results, and Reload Flow

### Files

- Modify `src/game/Game.ts`
- Modify `src/ui/Screens.ts`
- Modify `src/ui/Overlay.ts`
- Modify `scripts/playtest/campaign.mjs`
- Modify `scripts/playtest/manifest.mjs` for exact focused IDs

### Work

1. On every successful finish, record progress independently of PB creation.
2. First clear with a next stage shows:
   - `NEXT STAGE`
   - `RUN AGAIN`
   - `STAGE SELECT`
3. Final-stage clear omits `NEXT STAGE` and keeps replay/select/return actions.
4. `NEXT STAGE` selects and persists before reload; navigate only when at least one storage handoff
   succeeds.
5. Failed persistence leaves the result usable with a non-blocking localized error.
6. `STAGE SELECT` returns to the title rail focused on the current stage.
7. Results show only one optional `NEXT TARGET`; S completion means actual S rank, not any recorded
   rank.
8. Keep locale locked from briefing through result and preserved across next-stage reload.

### Focused browser path

Use one clean session to prove:

1. Fresh 01-1 start and locked-node nonactivation.
2. Actual title → briefing → engage path.
3. 01-1 clear → real next-stage reload → 01-2.
4. 01-2 clear → real next-stage reload → 01-3.
5. Final result has no next-stage action.
6. Stage select and refresh retain valid progress.
7. One real radio subtitle appears per stage.
8. Desktop plus one 375×667 and one 640×360 rail geometry check.
9. Console, page, harness, and external-network errors remain empty.

### Acceptance

- `pnpm playtest:campaign` passes its exact focused manifest.
- The run completes in one browser session without the full gameplay/localization suites.

## Step 6 — Focused Visual and Performance Acceptance

### Files

- Add or modify one focused stage screenshot runner under `scripts/playtest/`
- Add or modify one focused stage performance runner under `scripts/playtest/`
- Modify `scripts/playtest/manifest.mjs`
- Modify `package.json` with explicit focused commands

### Visual evidence

Capture exactly six new 1920×1080 DPR1 images:

1. WRECKLINE signature.
2. WRECKLINE destination.
3. RINGFALL signature.
4. RINGFALL destination.
5. Title stage rail.
6. Results.

Automation checks only stage identity, intended subject, finite/non-empty pixels, and errors. The
first run is marked `REVIEW REQUIRED`, not visual-regression PASS. The root agent inspects all six
once before handoff.

### Performance evidence

Run six short arms: three stages × DPR1/DPR2. Each arm:

- High quality, initial render scale 1.
- Presents every stage material.
- Warms for 120 real frames.
- Profiles five live-rAF seconds at the stage's heaviest authored vantage.
- Uses existing M5 frame/render-scale thresholds.
- Enforces no late shader compile/link and no runtime error.
- Enforces ≤160 draws, ≤620k triangles, ≤155 geometries, ≤16 textures, ≤55 programs.

If an arm fails, repeat only that arm once on an idle machine for ten seconds. Do not raise a
threshold to accept a heavy landmark.

### Explicit omissions

Do not run unless a focused failure or an out-of-scope shared edit requires them:

- `pnpm playtest:all`
- Full localization normal/HiDPI browser matrices
- Full screenshot matrix
- Boost VFX probes
- Audio probe
- Multiple seed matrix
- Per-stage cold cockpit/MFD cadence

## Step 7 — Final Review, Documentation, Commit, and Push

### Work

1. Run final fast gates once:
   - `pnpm build`
   - `pnpm test:i18n`
   - `pnpm test:campaign`
   - `git diff --check`
2. Confirm the focused campaign path, six visual artifacts, and six performance arms are current.
3. Run one read-only adversarial review for progression, collision/readability, and resource
   lifecycle blockers only.
4. Update README controls/progression/testing sections without exposing dormant NEEDLE or survival.
5. Commit in logical checkpoints and push `codex/chapter-one-stages`.
6. Leave `main` untouched and hand the branch to the user for direct playtesting.

### Final acceptance

- Worktree clean and remote branch current.
- No merge to `main`.
- User can run `pnpm dev`, clear 01-1, and continue through all three stages.
- Known limitations and visual-review decisions are reported plainly.
