# LAST VECTOR playtest harness

The harness turns `window.__LV` into repeatable evidence. Playwright handles browser launch,
navigation, request/error observation, and PNG capture; every game-state change goes through the
API declared in `src/core/harness.ts`. A failed setup or missing API capability becomes a named
`FAIL` check in `report.json`, and the remaining checks still run.

## One-time setup

Install project dependencies, then install Playwright's Chromium build once. Browser binaries are
kept in Playwright's user cache and are not vendored into this repository.

```sh
pnpm install
pnpm exec playwright install chromium
```

## Static-build evidence

Build first, then run one child suite or the aggregate of all three:

```sh
pnpm build
pnpm playtest
pnpm playtest:perf
pnpm playtest:screenshots
pnpm playtest:all
```

Without `--url`, each suite starts the existing zero-dependency
`scripts/static-server.mjs` against `dist/` on a free loopback port. The `M1.static-host` check
records the exact command, HTTP status, content type, byte count, and SHA-256 of the served entry
document. A `--url` run deliberately fails that M1 proof because it did not exercise the static
build.

For faster iteration against an already-running Vite server:

```sh
pnpm dev
pnpm playtest -- --url http://127.0.0.1:5173/
```

Only `http(s)` loopback targets are accepted. The browser context intercepts all requests and
aborts any attempt outside `localhost`, `127.0.0.1`, or `::1`. Browser-local `data:`, `blob:`, and
`about:` URLs are allowed. There are no uploads, analytics, or telemetry calls in the runner.

Useful options shared by the suites:

| Option | Default | Purpose |
| --- | --- | --- |
| `--out <dir>` | `playtest-out/<suite>` | Report and PNG destination |
| `--seed <uint32>` | `1337` | Boot-time world seed; the runner loads `?seed=...` and verifies `__LV.seed` |
| `--timeout-ms <ms>` | `45000` | Per-page/API timeout, including asynchronous game boot |
| `--headed` | off | Show Chromium for debugging |
| `--quality <level>` | `high` | Perf/screenshot quality |
| `--max-sim-seconds <n>` | `300` | Fixed-time playthrough ceiling |
| `--profile-seconds <n>` | `10` | Real-time performance sample |
| `--positions <csv>` | `0,.25,.5,.75,1` | Screenshot course positions |
| `--vantages <csv>` | all API names | Screenshot vantage subset |
| `--port <port>` | free port | Static server port |

`--dist <dir>` exists only for local diagnostics such as the missing-API fixture. An alternate
root never passes M1.

## Reports and exit status

Every suite writes `<out>/report.json` before returning. `playtest:all` keeps running after a
failed child suite and writes `playtest-out/report.json` with links to all three reports.
Screenshot PNGs and their byte-size/position/vantage manifest live under
`playtest-out/screenshot-matrix/`. `playtest-out/` is gitignored.

The process exits zero only when every check in that report passes. The report includes:

- environment, viewport, browser, target mode, and effective options;
- exact assertion text, M1-M7 coverage level, evidence, and structured error for each check;
- console errors, uncaught page errors, `__LV.errors()`, and request observations;
- perf samples or screenshot artifact metadata.

To verify graceful degradation without changing the game, run the deliberately API-free static
fixture. It must write a report containing explicit `HarnessUnavailable` failures rather than an
unhandled rejection:

```sh
pnpm playtest -- --dist scripts/playtest/fixtures/missing-harness \
  --out playtest-out/graceful-degradation
```

## Exact checks and mandatory-criterion coverage

| Check | Exact assertion | Coverage |
| --- | --- | --- |
| `M1.static-host` | Production `dist/index.html` is returned by `scripts/static-server.mjs` with status 200 and an HTML content type. `--url` and alternate `--dist` runs fail this proof. | M1 full |
| `SETUP.playwright` | `playwright` imports and Chromium launches at a 1920×1080 viewport with device scale 1. | setup only |
| `SETUP.page-load` | Chromium receives a successful main-document response and reaches `load`. | setup only |
| `API.contract` | `window.__LV`, its string version, requested boot-time seed, and every method required by that suite exist after the bounded boot wait. | API prerequisite |
| `API.ready` | `__LV.ready()` resolves before the configured timeout. | API prerequisite |
| `M2.automation-input` | A fixed-step command containing pitch, yaw, roll, throttle, both strafes, boost, and brake is applied exactly; after 60 frames the run is flying and moving, pose vectors are finite, position changed, and all three body angular rates responded. | M2 partial — proves the harness override path only; the shipped pipeline is covered by the INPUT.* checks (ledger L08) |
| `M7.automation-input-surface` | The full resolved command vocabulary is accepted and `setInput(null)` releases automation control. | M7 partial — see INPUT.keys-drive-the-command, INPUT.invertY-reaches-flight and INPUT.mouse-pipeline for the shipped pipeline; only trusted lock acquisition and raw OS deltas remain manual (ledger L15) |
| `M3.sequential-gates` | Skill-1 autopilot at fixed 1/60 s reaches positive `gatesTotal`, clears every gate exactly once in index order, records finite monotonic pass evidence, and emits one split per gate. | M3 full |
| `M4.destination-finish` | The deterministic playthrough reaches `finished` with a non-null result, positive finite total time, and non-empty destination name. | M4 full |
| `PERF.settings` | Requested quality, render scale 1, and hidden FPS overlay round-trip through settings. | perf prerequisite |
| `PERF.sample-shape` | Frames/seconds/timings/counts are valid, percentiles are ordered, reported FPS is within 5% (or 1 FPS) of frames ÷ seconds, and effective render scale matches the drawing buffer. | perf prerequisite |
| `M5.performance-1080p` | At 1920×1080, `__LV.profile(seconds)` holds the 60 Hz budget: mean frame ≤ 16.9 ms, p95 ≤ 20 ms, no frame over 33 ms, and renderScale ≥ 0.58 so the budget was not bought by collapsing resolution. ("At least 60 FPS" was the old wording — a perfectly vsynced run reports ~59.99, ledger L20.) | M5 full when paired with runtime-errors |
| `SCREENSHOT.setup` | Fixed 1/60 s flight starts at requested quality and every requested named vantage is advertised by `vantages()`. | visual evidence prerequisite |
| `SCREENSHOT.cell-NNN` | For one course-position × vantage cell, API seek/camera calls succeed, the HUD fade settles, one fixed frame is stepped and presented, and the DECODED image passes: requested dimensions, ≥12 distinct luminance levels, ≥12% midtone shelf in 0.18-0.45, <86% shadow, measurable chroma, and the vantage subject projecting on screen. (The old "PNG larger than 1 KiB" passed on black, magenta, and loading frames — ledger L17.) | Q1-Q6 review evidence, no direct M criterion |
| `SCREENSHOT.matrix-complete` | Every requested matrix cell produced a PNG; setup failure cannot masquerade as an empty success. | Q1-Q6 review evidence, no direct M criterion |
| `M5.runtime-errors` | Console errors, uncaught page errors, and strings from `__LV.errors()` are all empty. | M5 partial in each suite |
| `M6.localhost-only` | No intercepted browser request targets a non-loopback URL. | M6 full |

The fixed-step playthrough advances only through `setFixedTimestep`, `setInput`, `setAutopilot`,
and `step`; it does not wait on wall-clock sleeps for simulation assertions. `profile()` remains a
real-time measurement because that is its API contract.

## Current automation-contract gap

The harness consumes the API's pose, resolved-input, gate-history, driven-mode, and presentation
diagnostics, and — since `926f6c0` — drives the shipped keyboard AND mouse pipelines directly:
real key events with no override for the key-derived axes, throttle integrator and invertY, and a
`pointerLockElement` override with synthetic MouseEvents for the lock gate, virtual stick,
sensitivity/expo and button mapping (ledger L15; an earlier version of this section called all of
that "a manual browser check"). The remaining M7 boundary is narrow and real: trusted pointer-lock
ACQUISITION, raw OS mouse-delta delivery, gamepad hardware, and every judgement of feel. The
authoritative list of gate checks is `scripts/playtest/manifest.mjs` — set-equal, so this document
can lag but the gate cannot.
