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

Build first, then run one suite or all three:

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
| `--seed <uint32>` | `1337` | Deterministic run seed |
| `--timeout-ms <ms>` | `15000` | Per-page/API timeout |
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
| `API.contract` | `window.__LV`, its string version, and every method required by that suite exist. | API prerequisite |
| `API.ready` | `__LV.ready()` resolves before the configured timeout. | API prerequisite |
| `M2.automation-input` | A fixed-step command containing pitch, yaw, roll, throttle, both strafes, boost, and brake is accepted; after 60 frames the run is flying, speed is positive, telemetry is finite, throttle is within 0.05 of the command, and pitch or roll changed. | M2 partial |
| `M7.automation-input-surface` | The full command vocabulary is accepted and `setInput(null)` releases automation control. | M7 partial; physical bindings/pointer lock manual |
| `M3.sequential-gates` | Skill-1 autopilot at fixed 1/60 s reaches positive `gatesTotal`, clears all gates, emits one split per gate, and sampled gate indices never decrease. | M3 full |
| `M4.destination-finish` | The deterministic playthrough reaches `finished` with a non-null result, positive finite total time, and non-empty destination name. | M4 full |
| `PERF.settings` | Requested quality, render scale 1, and hidden FPS overlay round-trip through settings. | perf prerequisite |
| `PERF.sample-shape` | Frames/seconds/timings/counts are valid, percentiles are ordered, and reported FPS is within 5% (or 1 FPS) of frames ÷ seconds. | perf prerequisite |
| `M5.performance-1080p` | At 1920×1080/device scale 1, `__LV.profile(seconds)` reports at least 60 FPS. | M5 full when paired with runtime-errors |
| `SCREENSHOT.setup` | Fixed 1/60 s flight starts at requested quality and every requested named vantage is advertised by `vantages()`. | visual evidence prerequisite |
| `SCREENSHOT.cell-NNN` | For one course-position × vantage cell, API seek/camera calls succeed, one fixed frame is stepped and frozen, and Playwright writes a PNG larger than 1 KiB. | Q1-Q6 review evidence, no direct M criterion |
| `SCREENSHOT.matrix-complete` | Every requested matrix cell produced a PNG; setup failure cannot masquerade as an empty success. | Q1-Q6 review evidence, no direct M criterion |
| `M5.runtime-errors` | Console errors, uncaught page errors, and strings from `__LV.errors()` are all empty. | M5 partial in each suite |
| `M6.localhost-only` | No intercepted browser request targets a non-loopback URL. | M6 full |

The fixed-step playthrough advances only through `setFixedTimestep`, `setInput`, `setAutopilot`,
and `step`; it does not wait on wall-clock sleeps for simulation assertions. `profile()` remains a
real-time measurement because that is its API contract.

## Current automation-contract gaps

No source change is made by this harness. These additions to `src/core/harness.ts` would make the
remaining claims machine-verifiable; the project lead should decide whether to add them:

1. Expose a kinematics snapshot containing world position, orientation, linear velocity, and
   angular velocity. Current telemetry can observe throttle, speed, pitch, and roll, but cannot
   prove that yaw or either strafe axis caused continuous six-axis motion (M2).
2. Expose a read-only input diagnostic with active device, resolved keyboard/mouse bindings,
   pointer-lock support/ownership, and the final command after settings such as invert-Y. The
   current API can inject the same command vocabulary but cannot prove physical keyboard/mouse
   bindings or pointer lock (M7).
3. Expose gate-pass history with stable gate IDs and pass position/time. The final result and
   sampled next-gate index prove ordered completion, but event-level history would let the runner
   detect an accidental multi-gate skip between 120-frame samples (stronger M3 evidence).
4. Specify whether `step()` guarantees that a render has been presented after `seekCourse()` and
   `vantage()` while paused, or add `present()`/`renderOnce()`. The matrix currently steps one
   fixed frame before freezing, which is deterministic but relies on that practical expectation.
