# Flight Action Campaign Integration Report

**Status:** ACCEPTED FOR MANUAL TESTING

**Integration head before this report:** `127d0d682e84f9ee2e9c37f8184e1728802e5b40`

## Delivered campaign

- Chapter 01 — **CAIRN DRIFT**: the original nine-gate race, preserved behind the common mission runtime.
- Chapter 02 — **LAST ASCENT**: escape from the ACHRA impact event through three debris corridors while a shockfront closes from behind.
- Chapter 03 — **DEAD SIGNAL**: destroy any three of six shield nodes, destroy the exposed array core, then clear two sequential extraction turns.
- Chapters unlock in order from clear facts only: CAIRN → LAST ASCENT → DEAD SIGNAL.
- Each mission owns a ruleset-partitioned PB and shows first-run `NEW BEST` or an exact comparison on replay.
- Boost drain is 20 units/s. `Shift` is the global boost input. LMB is FIRE only in fire-capable missions and is a no-op in CAIRN/LAST ASCENT.
- `C` cycles chase → cockpit → far-chase → chase and the selected camera persists.
- Technical flight chrome remains English while Korean story, radio, hints, failure detail, and accessible descriptions remain Korean.

## Modular branch boundary

- Foundation/shared runtime: integration history through `69d59507`.
- Chapter 02 isolated accepted head: `6d72d441dd79d0a9908f48a6e99a75568f141b9a` (`codex/chapter-02-last-ascent`).
- Chapter 03 isolated accepted head: `be7902f67d4cb09e5c448c74f0ba076b33d357c7` (`codex/chapter-03-dead-signal`).
- Integrated implementation and focused-regression head: `127d0d682e84f9ee2e9c37f8184e1728802e5b40`.

The chapter branches remain independently selectable/rejectable. No commit was merged to `main` and nothing was pushed.

## Focused verification

Static and contract gates passed:

- `pnpm typecheck`
- `pnpm build`
- `pnpm test:campaign` — 9/9
- `pnpm test:i18n` — 9/9
- `pnpm test:boost`
- `pnpm test:last-ascent` — 6/6 after the PB/a11y correction
- `pnpm test:dead-signal` — 5/5
- `git diff --check`

Final integrated browser gates passed 40/40 before the final two Last Ascent corrections:

- Campaign 9/9: CAIRN 9/9 at 60/120 Hz, hull 1, first clear unlocks LAST ASCENT.
- LAST ASCENT 10/10: 3/3 corridors, hull 1, S rank, first clear unlocks DEAD SIGNAL.
- DEAD SIGNAL input 11/11: capability-gated LMB, independent Shift/LMB chord, persistent three-camera cycle.
- DEAD SIGNAL journey 10/10: 3/6 + core + 2/2 extraction turns, hull 1, exact PB comparison, stable DPR1 profile.

The final targeted LAST ASCENT browser rerun also passed 10/10:

- First clear: 100.833 s, `NEW BEST`, DEAD SIGNAL unlocked.
- Replay against 100.00 s: `+0.83 vs BEST 01:40.00`.
- Korean status region uses `lang=ko`; its six technical visual children use `lang=en`.

Accepted isolated performance evidence remains valid:

- LAST ASCENT DPR1/DPR2: approximately 60 fps, 40 draws, 49,126 triangles, zero late shaders.
- DEAD SIGNAL DPR1/DPR2: approximately 60 fps, 35 draws, 57,784 triangles, stable 44 programs and zero long frames in the measured hardest scene.

## Review outcome

- LAST ASCENT independent review: ACCEPT after meaningful debris avoidance, impact-planet readability, and staged shockfront pressure were proven.
- DEAD SIGNAL independent review: ACCEPT after sequential extraction, physical facility contacts, and PB result feedback were proven.
- Whole-artifact audit: ACCEPT after fixing the LAST ASCENT PB presentation and accessible status language.

No P0/P1/P2 findings remain in the reviewed scope. Broad localization/performance/aggregate matrices were intentionally not repeated; accepted per-chapter evidence plus one focused integrated browser pass were used to avoid redundant test cost.

## Manual test entry

```bash
pnpm dev
```

Open the local URL printed by Vite. Clear CAIRN to unlock LAST ASCENT, then clear LAST ASCENT to unlock DEAD SIGNAL. For direct authorized debugging, use the stable mission URL only after the preceding clear facts exist.
