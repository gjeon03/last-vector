# LAST VECTOR

Fly the last vector home.

A browser-native spacecraft flight run through **the Cairn Drift** — a debris shelf orbiting a
dying amber star, strung with monolithic navigation markers left by whoever charted it first.
Thread the nine cairns and make **Vesper Terminus** before the drift closes.

Runs entirely in the browser. No server, no network at runtime, no binary assets — every rock,
star, nebula, hull panel and sound in the build is generated from a seed at load time.

```bash
pnpm install
pnpm dev            # http://127.0.0.1:5173
```

```bash
pnpm build          # typecheck + static build into dist/
pnpm serve:dist     # http://127.0.0.1:4173 — a dumb static file server, no rewrites
```

`dist/` is path-relative and self-contained: drop it on any static host.

## Controls

| | |
|---|---|
| **Mouse** | Steer. The pointer drives a virtual stick that self-centres, so holding a deflection holds the turn. |
| **W / S** | Throttle up / down |
| **A / D** | Roll |
| **Shift** *or* left mouse | Boost — drains the reserve, refills after a beat |
| **Space** *or* right mouse | Brake and drift: kills the assist so the ship slides |
| **Q / E** | Strafe left / right |
| **R / F** | Strafe up / down |
| **Arrow keys** | Pitch and yaw without the mouse |
| **Esc** | Pause |
| **N** | Restart the run |

A gamepad works if one is connected: left stick steers, right stick rolls, triggers throttle.

## How it is built

```
src/core/       contracts between subsystems, input, settings, seeded rng, art direction
src/render/     the renderer: HDR post stack, procedural sky, rocks, gates, hull, station
src/game/       flight model, chase camera, course, orchestration, automation surface
src/audio/      procedural WebAudio engine — synthesis only, no samples
src/ui/         HUD and screens: DOM for text, one canvas for the vector instruments
```

A few decisions worth knowing about before changing anything:

- **Two scenes, two cameras.** The nebula, the stars, Achra and Vesper live in a scene drawn by
  a camera that only ever *rotates*, so they sit at effectively infinite distance. Depth is then
  cleared and everything reachable is drawn with a 90 km range. That is what lets a gas giant and
  a hull panel share a frame without z-fighting.
- **The sky is baked, not raymarched.** A domain-warped, ridged, star-lit nebula is rendered once
  into a cube map at boot. It buys a shader far too expensive to run per frame for the price of
  one texture lookup, with no seams and no pole distortion.
- **Adaptive resolution.** The internal buffer scales to hold a 16.7 ms frame while the canvas
  stays at native size. The quality setting is a ceiling, not a promise — see `PerfSample.renderScale`.
- **The flight model splits velocity.** Thrust drives the component along the nose; the lateral
  component decays on its own clock. Turning converts forward velocity into lateral velocity, so
  the ship visibly arcs through a turn before the vector catches up. The assist level is nothing
  but that decay time constant.

## Automation

The page exposes `window.__LV` (see `src/core/harness.ts`) so playthroughs, performance probes
and screenshot matrices can be driven headlessly without synthetic input events.

```bash
pnpm playtest         # full unattended playthrough + assertions
pnpm playtest:perf    # 1080p / 1440p frame-time probe
pnpm playtest:shots   # deterministic screenshot matrix
```

The API is installed after an asynchronous boot, not at `load`. Wait for `window.__LV` or for
`html[data-lv-ready="1"]` before driving it. Pin a world with `?seed=<uint32>`.

## Credits and originality

Original art direction, fiction, ship design, course layout, interface and audio. The quality
target was the class of modern space-flight games; nothing in here is copied from one.
