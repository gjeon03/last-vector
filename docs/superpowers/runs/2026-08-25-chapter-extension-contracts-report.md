# Chapter Extension Contracts Report

**Status:** PASS

## Delivered

- Objective and optional weapon runtimes expose bounded, caller-owned reward drains. Runtime
  aggregation preserves weapon -> objective order; Game validates finite boost-recharge amounts,
  clamps them to reserve capacity, and consumes them only after a surviving objective update.
- Optional weapon lifecycle, stable no-steady-allocation update framing, bounded fire/hit/destroy
  feedback, forward/fire simulation input, generic targetables, and exact hull -> weapon ->
  objective terminal order are present. CAIRN has no weapon and drains zero shared rewards; its
  accepted-gate +25 recharge remains in the unchanged legacy handler.
- FIRE defaults false across Input, harness, and failure commands. Input stores the generic
  mission capability flag while LMB remains boost. Nonlegacy active-flight autopilot preserves
  independent boost/brake input; CAIRN legacy and attract flight remain unchanged.
- Campaign projection maps `ACTIVE_MISSION_ORDER`, clear-gates `getNextMission`, derives state from
  progress, and exposes definition chapter/capabilities plus normalized mastery. One active CAIRN
  still renders no rail.
- Objective failure reasons cross Game -> Overlay -> Screens as stable `data-failure-reason` with
  generic `RUN ENDED / MISSION FAILED` copy. Reasonless hull failure remains `HULL BREACH`.

## Verification

- `pnpm typecheck`
- `pnpm test:campaign`
- `pnpm test:i18n`
- `pnpm test:boost`
- `pnpm build`
- `git diff --check`

All passed. Campaign evidence retains the exact CAIRN path hash
`cf64cc23e6accbd750712bb2a2140d5a0ac3dc55dbdce4851166846f24f7f605` and gate hash
`22ff40ffc12de5522e8cf83f6c8f0407201d2462d9b5e064d628c5c511c7cefc`; the 60/120 Hz boost
contract remains green. Focused contracts cover reusable event identity/order, amount validation,
lethal-frame suppression, weapon reset/dispose/drains, campaign projection, objective failure
reason threading, and generic autopilot buttons. No browser matrix was run.

## Falsification self-review

1. **P1, fixed:** the first pass found the dormant shared `MissionRewardEvent` in core contracts;
   a second definition would split chapter consumers. The core type is now the single generic
   boost-recharge event and MissionRuntime re-exports it.
2. **P2, fixed:** failure reason metadata could survive into a later successful result. Result
   rendering and reasonless hull failure now clear `data-failure-reason` explicitly.
3. **No material finding:** checked CAIRN reward location, lifecycle call counts, event-capacity
   enforcement, lethal ordering, one-node rail suppression, legacy autopilot behavior, and LMB
   binding. Required contracts and locked hashes remained green.

## Scope

No escape/strike authoring, mission IDs, weapon gameplay, weapon audio/SFX, LMB remap, flight
tuning, asset work, merge, or push is included.
