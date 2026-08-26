# Goal Ledger — Two-Chapter Flight Campaign

**Product:** `cairn-drift` → `relay-harvest`

**Sources of truth:** `src/core/Missions.ts`, `src/game/missions/RelayHarvestLayout.ts`, `package.json`

## Outcome

**LAST VECTOR** is a browser-native spacecraft flight game with two active chapters. Both use the
same ship, six-axis-capable handling, camera, hull, BOOST economy and guidance language while each
chapter owns a different objective and world.

- **Chapter 01 — CAIRN DRIFT:** fly all nine cairns in order and reach VESPER TERMINUS.
- **Chapter 02 — BLACKOUT RELAY:** sweep ten unstable CORE signals through a dense wreck field,
  then return their charge to the launch relay before its distance-derived window closes. Each
  CORE adds 10 RELAY CHARGE and restores 25 BOOST.

CAIRN is initially available. Its first successful clear unlocks BLACKOUT RELAY; rank and optional
mastery do not affect the unlock.

## Mandatory criteria

| # | Criterion | Evidence |
|---|-----------|----------|
| M1 | The game runs entirely client-side and the built `dist/` works on a plain static host. | `pnpm build`, browser network capture |
| M2 | The player pilots a spacecraft in 3D with keyboard, mouse and continuous six-axis-capable controls; gamepad remains optional. | `pnpm playtest` plus manual control check |
| M3 | The active catalog contains exactly CAIRN DRIFT followed by BLACKOUT RELAY, and only a CAIRN clear unlocks Chapter 02. | `pnpm test:campaign`, `pnpm playtest:campaign` |
| M4 | CAIRN requires all nine authored gates in order and finishes at VESPER TERMINUS with hull remaining. | `pnpm playtest` |
| M5 | BLACKOUT RELAY presents ten visible physical CORE sources, relocates expired signals deterministically, awards +10 charge and +25 BOOST per CORE, and succeeds only after all ten are returned to the relay. | `pnpm test:relay`, `pnpm test:relay-render`, manual playtest |
| M6 | `RETRY`, `RESTART` and `RUN AGAIN` retain the current validated layout; `NEW LAYOUT` loads a different validated layout. PB identity is partitioned by layout signature. | `pnpm test:relay`, `pnpm playtest:relay` |
| M7 | The shipped build has no runtime console errors or external network dependencies and meets its browser performance gates. | `pnpm playtest:perf`, `pnpm playtest:all` |

## Quality and constraints

- Preserve clear depth, strong warm/cool lighting, weighted motion, readable objective guidance and
  polished title/briefing/countdown/result transitions.
- Keep the art direction, fiction, ship, UI and audio original. Runtime worlds and audio remain
  procedural; the repository-hosted Korean fonts are the only binary presentation assets.
- Do not add free-roaming combat, loot, RPG systems, multiplayer or weapon switching.
- Build one mission world per page load. Do not preload dormant or future mission worlds.
- Keep objective ownership behind the mission runtime boundary; do not add mission-ID branches to
  `Game` for objective-specific behaviour.
- Keep TypeScript strict, named exports and the project two-space indentation convention.

## Verification

Use only the scripts declared in `package.json`:

```bash
pnpm typecheck
pnpm test:i18n
pnpm test:campaign
pnpm test:boost
pnpm test:relay
pnpm test:relay-render
pnpm test:stage-landmarks
pnpm build

pnpm playtest
pnpm playtest:perf
pnpm playtest:boost-vfx
pnpm playtest:campaign
pnpm playtest:relay
pnpm playtest:screenshots
pnpm playtest:all
```

Browser playtests serve `dist/` without rebuilding it, so run `pnpm build` first whenever the current
working tree is the subject. Evidence intended to describe a commit must also name that commit and
must not be presented as clean-commit evidence when the tree is dirty.

Automated screenshots and audio measurements do not establish subjective flight feel or sound
quality. Final acceptance still needs a human mouse flight, a brief listening pass and visual review
of both chapters.
