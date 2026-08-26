# Korean-Default, English-Selectable Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Korean the default language, allow English selection only before a run, localize the complete player-facing experience including the cockpit MFD, and preserve every gameplay, performance, accessibility, and external telemetry contract.

**Architecture:** A dependency-free typed catalog and a separate `LocaleStore` own the selected locale. `Game` snapshots that locale on title-to-briefing transition, replaces the entire `Overlay` as one hydrated transaction, and updates the persistent cockpit MFD translator in the same transaction. Public telemetry keeps its required legacy English strings and gains optional JSON-safe message descriptors so the HUD can localize without breaking consumers.

**Tech Stack:** TypeScript, Vite, Three.js, Canvas2D, Playwright, Node 22+, CSS, WOFF2.

**Spec:** [2026-08-23-korean-english-localization-design.md](../specs/2026-08-23-korean-english-localization-design.md)

## Global Constraints

- Work only on `codex/korean-english-localization`. Do not merge to `main` without explicit user approval.
- Keep proper nouns and rank codes unchanged: `LAST VECTOR`, `THE CAIRN DRIFT`, `ACHRA`, `CAIRN NN`, `VESPER TERMINUS`, `TERMINUS`, and `S`–`D`.
- Keep control keys and units in Latin: `W`, `S`, `A`, `D`, `C`, `N`, `ESC`, `SHIFT`, `LMB`, `RMB`, `m/s`, `FPS`.
- The clean persisted English boot must make zero NanumSquare Neo requests.
- Locale selection is writable only on the title screen. Title-to-briefing locks the locale; restart and retry reuse the locked locale; returning to title unlocks and reloads the persisted selection.
- Never rebuild `Input`, `AudioEngine`, `SettingsStore`, the settings subscription, or WebGL resources when locale changes.
- Preserve event order: audio-unlock capture listener, then Overlay capture listener, then Input bubble listener.
- Preserve required legacy English telemetry exactly. Optional descriptors may only add data.
- Do not allocate domain message objects in per-frame telemetry paths. Reuse frozen singletons or event-time objects.
- Every implementation task starts with a red test, applies the smallest production change, runs the focused test, then commits.

---

## Task 1: Replace English-text Test Selectors with Semantic Contracts

**Files:**

- Modify: `src/ui/Screens.ts`
- Modify: `src/ui/Hud.ts`
- Modify: `scripts/playtest/playtest.mjs`
- Test: `scripts/playtest/playtest.mjs`

- [ ] **Step 1: Add a red selector contract to the existing playtest**

  Update `UX.screen-flow` and failure/countdown/boost checks to require:

  - `data-view` on each screen.
  - `data-action` on every navigable action.
  - `data-control` on briefing and controls rows.
  - `data-setting` and `data-value` on settings controls.
  - `data-countdown-value="3|2|1|go"`.
  - Numeric boost attributes: `data-usable-seconds`, `data-rearm-percent`, `data-availability`.

  Remove behavior assertions that locate `ENGAGE`, `RETRY`, `GO`, `HULL BREACH`, or boost state by visible English text. Also migrate `INPUT.chord-order-recovery` focus evidence and `failureUiSnapshot.buttonLabels` to `activeElement.dataset.action` / semantic action IDs. Keep key-chip assertions because key names are intentionally invariant.

  Scope every action query to the open view: `[data-view="X"][data-open="1"] [data-action="Y"]`. Action/control IDs need only be unique inside one `data-view`; the same settings, controls, return, or control-row ID may legitimately exist in another screen.

- [ ] **Step 2: Run the focused test and confirm it fails for missing attributes**

  Run:

  ~~~bash
  npm run build
  npm run playtest -- --timeout-ms 60000
  ~~~

  Expected: the relevant UI contract fails on the first missing semantic attribute, not on an unrelated runtime error.

- [ ] **Step 3: Add stable UI identifiers**

  In `Screens.ts`:

  - Define a `ScreenAction` union containing `begin`, `settings`, `controls`, `engage`, `return`, `resume`, `restart`, `abort`, `again`, and `retry`. Every BACK or title-return action uses `return` and is disambiguated by `data-view`.
  - Add an `action` argument to `button()` and set `button.dataset.action`.
  - Preserve click order: play the UI sound before invoking the action callback.
  - Add stable IDs to `ControlRow` and render `data-control`.
  - Add `data-view` in `makeView()`.
  - Add `data-setting` and raw `data-value` to setting controls.
  - Add `data-countdown-value` without changing visible copy yet; explicitly delete it when `setCountdown(null)` closes the view.

  In `Hud.ts` expose raw numeric/state values through dataset attributes; do not parse rendered strings in tests. Seed `data-usable-seconds`, `data-rearm-percent`, and `data-availability="available"` when the boost DOM is built, then update them in the normal state-change path so initial reads cannot see `null`.

  Correct the existing `UX.screen-flow` call to pass `options.timeoutMs` into `reloadHarness` rather than the entire options object.

- [ ] **Step 4: Run behavior and accessibility checks**

  Run:

  ~~~bash
  npm run typecheck
  npm run build
  npm run playtest -- --timeout-ms 60000
  git diff --check
  ~~~

  Expected: all existing checks pass with the current English UI, proving selector migration is behavior-neutral.

- [ ] **Step 5: Commit**

  ~~~bash
  git add src/ui/Screens.ts src/ui/Hud.ts scripts/playtest/playtest.mjs
  git commit -m "test: decouple UI behavior from English copy"
  ~~~

---

## Task 2: Add the Typed Catalog, Locale Store, and Contract Test

**Files:**

- Create: `src/i18n/Locale.ts`
- Create: `src/i18n/messages.ts`
- Create: `src/i18n/ko.ts`
- Create: `src/i18n/en.ts`
- Create: `src/i18n/domain.ts`
- Create: `src/i18n/index.ts`
- Create: `src/i18n/typeFixtures.ts`
- Create: `scripts/playtest/i18n-contract.mjs`
- Modify: `src/core/contracts.ts`
- Modify: `package.json`
- Test: `scripts/playtest/i18n-contract.mjs`

- [ ] **Step 1: Write a red, dependency-free catalog contract**

  Add fixtures and these exact checks:

  - `I18N.module-load`: dynamically import every i18n TypeScript module under Node's type stripper.
  - `I18N.catalog-parity`: Korean and English recursively have identical keys and leaf types.
  - `I18N.compile-time-arguments`: verify the dedicated source fixture contains and exercises at least three `@ts-expect-error` dynamic-argument failures.
  - `I18N.preserved-tokens`: proper nouns, key names, units, and rank codes remain unchanged.
  - `I18N.locale-store`: missing/invalid/corrupt storage resolves to `ko`; valid `en` persists; write failures do not corrupt in-memory state.
  - `I18N.descriptor-roundtrip`: every domain descriptor survives JSON serialization.
  - `I18N.legacy-english`: English descriptor rendering exactly equals independent legacy fixtures.
  - Catalog strings are non-empty and contain no HTML.

  Include both camera modes, all three gate accuracies, remaining counts 0/1/2, unsafe reason text, percentages, and fractional seconds.

  Put compile-time fixtures in `src/i18n/typeFixtures.ts` so the existing `tsc --noEmit` includes them. Export the fixture array to satisfy `noUnusedLocals`. Guard calls with `@ts-expect-error` proving that `boostUsable` cannot omit its numeric argument or receive a string, and `gateClearedLog` cannot omit either required argument. If a signature becomes loose, TypeScript must fail with an unused directive.

  `i18n-contract.mjs` is browser-free and dist-free. Reuse only `Report`, `parseOptions`, and `verify` from `runtime.mjs`; do not call `runManagedSuite` or launch Playwright.

- [ ] **Step 2: Add the test command and verify red**

  Add:

  ~~~json
  "test:i18n": "node --experimental-strip-types scripts/playtest/i18n-contract.mjs"
  ~~~

  Run `npm run test:i18n`.

  Expected: module/key failures because the catalog and store do not yet exist.

- [ ] **Step 3: Define dependency-free public types**

  In `contracts.ts` add:

  ~~~ts
  export type Locale = 'ko' | 'en';
  export type GateAccuracy = 'dead-centre' | 'clean' | 'cleared';

  export type GateNameMessage =
    | { type: 'gate-name.terminus-approach' };

  export type CalloutTitleMessage =
    | { type: 'callout-title.pointer-lock-unavailable' }
    | { type: 'callout-title.camera-view'; mode: CameraMode }
    | { type: 'callout-title.engage' }
    | { type: 'callout-title.hull-impact' }
    | { type: 'callout-title.boost-depleted' }
    | { type: 'callout-title.gate-cleared'; accuracy: GateAccuracy }
    | { type: 'callout-title.gate-missed' };

  export type CalloutSubMessage =
    | { type: 'callout-sub.keyboard-flight-available' }
    | { type: 'callout-sub.camera-active'; mode: CameraMode }
    | { type: 'callout-sub.boost-recharging' }
    | { type: 'callout-sub.gate-progress'; remaining: number }
    | { type: 'callout-sub.gate-realign' };

  export type LogMessage =
    | { type: 'log.pointer-lock-refused'; reason: string }
    | { type: 'log.hull-contact'; percent: number }
    | { type: 'log.boost-depleted' }
    | { type: 'log.gate-cleared'; gate: number; seconds: number }
    | { type: 'log.gate-missed'; gate: number };
  ~~~

  Add only these optional fields:

  - `GateTelemetry.nameMessage?: GateNameMessage`
  - `Callout.titleMessage?: CalloutTitleMessage`
  - `Callout.subMessage?: CalloutSubMessage`
  - `LogLine.message?: LogMessage`

  Do not import the i18n catalog from `contracts.ts`.

- [ ] **Step 4: Implement the catalog API**

  `Messages` has exactly these named top-level sections: `meta`, `loader`, `screens`, `controls`, `settings`, `hud`, `events`, `results`, `cockpit`, and `a11y`. Define every leaf as a named property; index signatures are forbidden. Dynamic leaves include these exact signatures:

  ~~~ts
  boostUsable: (seconds: number) => string;
  boostRecharging: (percent: number) => string;
  splitDelta: (delta: string) => string;
  hullContact: (percent: number) => string;
  gateProgress: (remaining: number) => string;
  gateClearedLog: (gate: number, seconds: number) => string;
  gateMissedLog: (gate: number) => string;
  ~~~

  Export the translator contract:

  ~~~ts

  export interface Translator {
    readonly locale: Locale;
    readonly messages: Messages;
    domain(message: DomainMessage): string;
  }

  export function createTranslator(locale: Locale): Translator;
  ~~~

  Define every subinterface leaf explicitly, without index signatures, then define `ko` and `en` with `satisfies Messages`. Call dynamic functions directly so key-specific argument count and types are checked by TypeScript. Keep interpolation text-only and do not permit HTML.

  All `src/i18n` imports include the `.ts` extension and use `import type` for erased symbols. Keep the modules compatible with Node 22 type stripping: no `enum`, namespace, constructor parameter properties, or `import = require`.

  `I18N.catalog-parity` also compares dynamic `fn.length` against this table and proves marker arguments appear in rendered output:

  | Path | Arity |
  |---|---:|
  | hud.boostUsable | 1 |
  | hud.boostRecharging | 1 |
  | results.splitDelta | 1 |
  | events.hullContact | 1 |
  | events.gateProgress | 1 |
  | events.gateClearedLog | 2 |
  | events.gateMissedLog | 1 |

- [ ] **Step 5: Implement the isolated LocaleStore**

  Use storage key `last-vector.locale.v1` and default `ko`. The store writes memory before attempting localStorage and swallows storage exceptions. `reload()` rereads storage only when Game returns to title and changes memory only when it successfully reads a valid `ko`/`en` value; missing or unreadable storage retains the current in-memory selection. Catch access to the global `localStorage` getter as well as `getItem`/`setItem`. Never touch localStorage at module evaluation time and do not add storage-event synchronization.

  Contract fixtures cover null storage, empty storage, invalid `jp`, JSON-like `{"locale":"en"}`, throwing getter/read, and throwing write. After a failed write, `set('en')` and then `reload()` must both retain in-memory `en`.

- [ ] **Step 6: Fill the canonical catalog**

  First inventory player-facing literals with:

  ~~~bash
  rg -n "'[^']*[A-Za-z가-힣][^']*'|`[^`]*[A-Za-z가-힣][^`]*`" src/main.ts src/game src/ui src/render/CockpitModel.ts
  ~~~

  Classify every result as translated catalog copy, preserved proper noun/key/unit, developer-only diagnostic, or required legacy telemetry fixture. Use authored Korean, not word-for-word fragments. The required canonical groups include:

  - Menu: `비행 시작`, `설정`, `조작법`.
  - Briefing: `비행 브리핑`, `목적지`, `표식`, `항로`, `드리프트`, `수축 중`, `핵심 조작`, `출격`, `뒤로`.
  - Pause/results/failure: `비행 정지`, `일시정지`, `계속`, `재시작`, `비행 중단`, `도착 확인`, `신기록`, `다시 비행`, `선체 파손`, `재도전`.
  - HUD: `키보드 비행`, `추력`, `선체`, `부스터`, `구간`, `경과`, `최고`, `다음 표식`, `출발`, `충전`.
  - MFD keys: `자세`, `벡터 / 거리`, `기체 계통`, `동력`, `역추진 제동`, `선체 경고`, `근접 경고`.

  Canonical briefing prose:

  1. `ACHRA가 꺼져 가고 있다. 매시간 선반 얼음과 회전하는 철편이 마지막 생존 항로로 쏟아진다.`
  2. `응답하는 CAIRN은 아홉 기. 오래전에 사라진 손들이 남긴 표식이 곧 항로다.`
  3. `순서대로 통과하라. 좁은 구간에서는 암석이 바짝 파고들며, 제동만이 선회 공간을 만든다.`

  Language selector labels must be locale-native:

  - Korean UI: `한국어` / `영어`
  - English UI: `Korean` / `English`

  Independent legacy-English fixtures live as literal strings in `i18n-contract.mjs`, never imported from `en.ts` or Game:

  | Descriptor | Exact English |
  |---|---|
  | terminus approach | `TERMINUS APPROACH` |
  | pointer lock title/sub | `MOUSE CAPTURE UNAVAILABLE` / `W A S D / ARROWS STILL FLY` |
  | camera cockpit/chase title | `COCKPIT VIEW` / `CHASE VIEW` |
  | camera cockpit/chase sub | `PILOT CAMERA ACTIVE` / `EXTERIOR CAMERA ACTIVE` |
  | engage / impact | `ENGAGE` / `HULL IMPACT` |
  | boost title/sub/log | `DRIVE DRY` / `RESERVE RECHARGING` / `overdrive reserve depleted` |
  | gate accuracy | `DEAD CENTRE` / `CLEAN` / `CLEARED` |
  | gate progress 2/1/0 | `2 CAIRNS REMAINING` / `1 CAIRN REMAINING` / `TERMINUS AHEAD` |
  | missed title/sub | `MISSED` / `REALIGN AND RE-ENTER` |
  | pointer log | `mouse capture refused \u00B7 <reason>` |
  | hull log | `hull contact \u00B7 <percent>%` |
  | cleared log fixture | `cairn 07 \u00B7 12.34s` |
  | missed log fixture | `cairn 07 missed` |

  Gate numbers in log descriptors are already 1-based and render with two-digit zero padding. Hull percent is already rounded at the caller. Descriptor round-trip compares exact key sets as well as values and rendered output so an explicit `undefined` key cannot silently disappear.

- [ ] **Step 7: Verify and commit**

  Run:

  ~~~bash
  npm run test:i18n
  npm run typecheck
  git diff --check
  ~~~

  Commit:

  ~~~bash
  git add src/i18n src/core/contracts.ts scripts/playtest/i18n-contract.mjs package.json
  git commit -m "feat: add typed Korean and English catalogs"
  ~~~

---

## Task 3: Add Boot-Time Selection and the Run Locale Lock

**Files:**

- Create: `scripts/playtest/localization.mjs`
- Modify: `scripts/playtest/runtime.mjs`
- Modify: `scripts/playtest/manifest.mjs`
- Modify: `scripts/playtest/all.mjs`
- Modify: `src/game/Game.ts`
- Modify: `src/ui/Overlay.ts`
- Modify: `src/ui/Screens.ts`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/Settings.ts`
- Modify: `src/core/harness.ts`
- Modify: `src/main.ts`
- Test: `scripts/playtest/localization.mjs`

- [ ] **Step 1: Add isolated boot scenarios**

  Export the existing network-boundary and page-observer installers, then add:

  ~~~js
  openBootScenario(session, {
    localStorageSeed = {},
    seed,
    initScripts = [],
  })
  ~~~

  It creates a fresh browser context with the same viewport, `options.deviceScaleFactor`, service-worker policy, and loopback origin; seeds localStorage through Playwright `storageState` before navigation; installs the normal localhost network boundary and console/pageerror observers into shared `session.observations`; records requests in a scenario-local array; applies supplied init scripts before page creation; opens one page with the deterministic seed; and returns `{ page, requests, close }`.

  Use `new URL(session.target.url).origin` without a trailing slash for the storage-state origin.

  Each clean-boot assertion owns and closes its scenario. Do not reuse the main suite context, request accumulator, HTTP cache, or an `addInitScript` that repeats on every reload.

- [ ] **Step 2: Write red locale lifecycle checks**

  Add report IDs:

  - `I18N.default-korean`
  - `I18N.persisted-english-clean-boot`
  - `I18N.title-selector`
  - `I18N.run-lock`
  - `I18N.restart-lock`
  - `I18N.return-title-unlock`
  - `I18N.overlay-listener-stability`

  Assert:

  - A fresh empty-storage scenario boots Korean with `document.documentElement.lang === 'ko'`.
  - A separate fresh `en` storageState scenario boots English before the loader and Overlay are constructed.
  - Title selection persists and replaces the visible Overlay.
  - Once briefing begins, locale controls are locked/absent.
  - Restart/retry preserve the locked locale.
  - Returning to title unlocks and reloads storage.
  - Repeated locale changes do not multiply click, keyboard, resize, settings, or pointer-lock listeners.
  - The harness version is exactly `1.4.0` and `locale` is a required method.
  - Every locale snapshot satisfies `locked === (active !== null)`.
  - Returning to title restores a visible `[data-view="title"][data-open="1"] [data-action="begin"]`.

  In a dedicated scenario, install an EventTarget add/remove census and a ResizeObserver construct/disconnect census before the document loads. Compare active listener populations by target/type/capture before and after repeated locale switches. Expose a read-only `SettingsStore.subscriberCount` and include it in harness locale evidence; it must remain exactly one.

- [ ] **Step 3: Run the new suite and confirm red**

  Run:

  ~~~bash
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  ~~~

- [ ] **Step 4: Add Game locale ownership**

  Extend `GameOptions` with optional `localeStore`. Add:

  ~~~ts
  private readonly root: HTMLElement;
  private readonly localeStore: LocaleStore;
  private overlay: Overlay;
  private selectedLocale: Locale;
  private activeRunLocale: Locale | null;
  private activeTranslator: Translator;
  ~~~

  Add focused methods:

  - `createOverlay(translator)`
  - `replaceOverlay(translator)`
  - `applyLocale(locale)`
  - `lockLocaleForRun()`
  - `unlockLocaleAtTitle()`

  `replaceOverlay` must:

  1. Snapshot phase, countdown, `input.pointerLocked`, telemetry, and the active navigation focus token.
  2. Dispose the old Overlay.
  3. Create the new Overlay without touching Input/audio/settings/WebGL.
  4. Call the new Overlay's `setPhase(phase)` directly, never `Game.setPhase(phase)`, because Game's same-phase guard would skip hydration.
  5. Restore countdown, pointer-lock state, telemetry, then the matching focus token.

  Preserve listener installation order and do not recreate the settings subscription.

  Add narrow Overlay/Screens focus-token capture and restore methods using semantic attributes (`data-view` plus `data-action`/`data-nav`/`data-locale`). A locale change must not reset keyboard focus to BEGIN RUN.

  At this stage retain `activeTranslator` for the persistent cockpit. Task 7 introduces the cockpit locale API and then adds it to this same transaction; do not call a nonexistent cockpit method in this commit.

  Extend `HudHost` with `requestLocale(locale: Locale)` and explicitly forward it from `Overlay.proxyHost()` to the real host; Screens only receives that proxy. The request path must persist and apply only while `phase === 'title'`.

- [ ] **Step 5: Apply the stored locale before any player-facing boot UI**

  In `main.ts` construct/reload `LocaleStore` before `showLoader()`, immediately set `document.documentElement.lang`, construct the translator, and use it for loader, WebGL failure, context-loss, and fatal-launch text. Pass the same store into Game so boot and title cannot disagree.

- [ ] **Step 6: Lock at the correct boundary**

  - `toBriefing()` snapshots the selected locale before changing phase.
  - `beginRun()` locks only if no locale is active, covering harness direct-start.
  - `restart()` and failure retry do not resnapshot.
  - `toTitle()` finishes cleanup, changes phase, then unlocks, reloads the store, and applies the title locale.

- [ ] **Step 7: Add the title selector**

  Reuse the existing segmented-navigation contract after the main title actions so keyboard navigation and first focus remain stable:

  - Group: `data-nav="segmented"`, `tabIndex=0`, `role="radiogroup"`, localized `aria-label`.
  - Options: `data-seg="ko|en"`, `data-locale="ko|en"`, `role="radio"`, `aria-checked`.
  - Creation sets exactly one `aria-checked="true"` from `selectedLocale` and mirrors it in the group's `data-value`; this selector is not part of Settings synchronization.
  - Existing W/S/arrow focus collection, A/D adjustment, and Enter activation must work without a new keyboard path.

  Reject locale requests outside title without mutating storage.

  `I18N.title-selector` performs a keyboard-only `ko → en → ko` round trip, asserts focus remains on the segmented locale control after each Overlay reconstruction, and verifies exactly one checked option matches `locale().selected`.

- [ ] **Step 8: Expose a narrow harness state**

  Add:

  ~~~ts
  interface HarnessLocaleState {
    selected: Locale;
    active: Locale | null;
    locked: boolean;
    settingsSubscribers: number;
  }
  ~~~

  Expose `locale()`, include `locale` in localization's required methods, and bump harness version from `1.3.0` to `1.4.0`. The browser suite asserts the exact version string, not merely that a string exists.

- [ ] **Step 9: Register the report-producing suite**

  Add the browser-free `i18n-contract` plus `localization` and `localization-hidpi` to `all.mjs` after performance-sensitive suites, preserving the existing settle interval.

  Pin exact sets in `manifest.mjs`:

  - `i18n-contract`: its seven `I18N.*` checks.
  - Each localization variant: the six automatic managed-suite checks (`M1.static-host`, `SETUP.playwright`, `SETUP.page-load`, `API.contract`, `M5.runtime-errors`, `M6.localhost-only`) plus the seven Task 3 `I18N.*` checks.

- [ ] **Step 10: Verify and commit**

  Run:

  ~~~bash
  npm run test:i18n
  npm run typecheck
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  node scripts/playtest/localization.mjs --device-scale-factor 2 --timeout-ms 60000
  npm run playtest -- --timeout-ms 60000
  git diff --check
  ~~~

  Commit:

  ~~~bash
  git add src/game/Game.ts src/ui/Overlay.ts src/ui/Screens.ts src/core/contracts.ts src/core/Settings.ts src/core/harness.ts src/main.ts scripts/playtest/runtime.mjs scripts/playtest/localization.mjs scripts/playtest/manifest.mjs scripts/playtest/all.mjs
  git commit -m "feat: add title-only locale switching"
  ~~~

  After the tree is clean at that commit, run the actual aggregate once:

  ~~~bash
  npm run playtest:all -- --timeout-ms 60000
  ~~~

  If aggregate verification exposes a defect, fix and commit it, then rerun focused coverage and the clean-tree aggregate before reporting.

---

## Task 4: Translate Screens and Static UI Without Changing Navigation

**Files:**

- Modify: `src/i18n/messages.ts`
- Modify: `src/i18n/ko.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/ui/Screens.ts`
- Modify: `src/ui/styles.css`
- Modify: `src/boot.css`
- Modify: `scripts/playtest/localization.mjs`
- Test: `scripts/playtest/localization.mjs`

- [ ] **Step 1: Write red static-copy and layout checks**

  For both locales, open every screen through real controls and assert:

  - Title, briefing, settings, controls, pause, results, and failure have the expected catalog messages.
  - Every `data-action` and `data-control` remains present and unique within its own `data-view`.
  - The selected language remains visible on title and cannot be changed in briefing or flight.
  - Proper nouns, controls, and units remain Latin.
  - At 1920×1080, 1280×720, 375×667, and 640×360, primary actions stay inside the viewport.
  - At 640×360, the camera control row is initially visible rather than hidden below an unannounced inner scroll.

- [ ] **Step 2: Migrate screen constants to typed keys**

  Replace hard-coded player-facing strings in `BRIEF_LINES`, `CONTROLS`, `SETTING_GROUPS`, menu builders, pause/results/failure builders, and countdown with catalog keys or typed message builders.

  Preserve these control translations:

  | English | Korean |
  |---|---|
  | Steer — self-centering virtual stick | 조향 — 자동 복귀 가상 스틱 |
  | Throttle up / down | 스로틀 올림 / 내림 |
  | Roll left / right | 좌 / 우 롤 |
  | Boost | 부스터 |
  | Brake and drift | 제동 및 드리프트 |
  | Strafe left / right | 좌 / 우 평행 이동 |
  | Strafe up / down | 상 / 하 평행 이동 |
  | Pitch / yaw without mouse | 마우스 없이 피치 / 요 |
  | Toggle chase / first-person cockpit | 추적 / 1인칭 조종석 전환 |
  | Pause | 일시정지 |
  | Restart run | 비행 재시작 |

  Preserve the Korean note:

  `출격하면 마우스가 고정됩니다. ESC를 누르면 마우스가 풀리고 비행이 일시정지됩니다.`

- [ ] **Step 3: Translate settings labels and values**

  Required Korean labels:

  - Sections: `비행`, `화면`, `영상`, `오디오`.
  - `비행 보조` — `항전 장치가 입력을 얼마나 감쇠할지 정합니다.`
  - `기본 시점` — `비행 중 C를 눌러 시점을 전환합니다.`
  - `마우스 감도`, `피치 반전`, `시야각`, `카메라 흔들림`.
  - `품질`, `렌더 배율`, `프레임 표시`, `모션 블러`, `필름 그레인`, `색수차`.
  - `전체 음량`, `음악`.
  - Values: `아케이드`, `표준`, `원본`, `추적`, `조종석`, `낮음`, `중간`, `높음`, `최고`, `켬`, `끔`.

  Keep raw enum/boolean/number values in `data-value` so tests and settings persistence are locale-independent.

- [ ] **Step 4: Translate terminal screens**

  Use:

  - `도착 확인`, `비행 종료`, `등급`, `총 시간`, `신기록`.
  - `표식`, `최고 속도`, `선체`, `무손상`, `손상`.
  - `구간`, `경과`, `최고기록 대비`.
  - `다시 비행`, `타이틀로`.
  - `선체 파손`, `시간`, `재도전`.

  Keep `TERMINUS` and rank codes unchanged and wrap them in `lang="en"`.

- [ ] **Step 5: Preserve semantics and focus**

  - Translator output enters the DOM through `textContent` only.
  - Set accessible names from the same catalog.
  - Keep the first navigable action focused on each screen.
  - Keep W/S keyboard menu navigation order unchanged.
  - Do not translate `data-*` values.

- [ ] **Step 6: Run focused and regression tests**

  ~~~bash
  npm run test:i18n
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  npm run playtest -- --timeout-ms 60000
  git diff --check
  ~~~

- [ ] **Step 7: Commit**

  ~~~bash
  git add src/i18n/messages.ts src/i18n/ko.ts src/i18n/en.ts src/ui/Screens.ts src/ui/styles.css scripts/playtest/localization.mjs
  git commit -m "feat: localize menus and run screens"
  ~~~

---

## Task 5: Localize Dynamic HUD Events Through Additive Descriptors

**Files:**

- Modify: `src/core/contracts.ts`
- Modify: `src/i18n/messages.ts`
- Modify: `src/i18n/ko.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/domain.ts`
- Modify: `src/game/Game.ts`
- Modify: `src/render/Gate.ts`
- Modify: `src/ui/Hud.ts`
- Modify: `scripts/playtest/i18n-contract.mjs`
- Modify: `scripts/playtest/localization.mjs`
- Test: `scripts/playtest/i18n-contract.mjs`
- Test: `scripts/playtest/localization.mjs`

- [ ] **Step 1: Expand red legacy-parity fixtures**

  Record independent canonical English fixtures for:

  - Pointer-lock rejection and keyboard fallback.
  - Chase/cockpit camera activation.
  - Engage.
  - Hull impact and rounded hull percent.
  - Boost depleted/recharging.
  - Dead-centre, clean, and cleared gates.
  - Remaining gate counts 0, 1, and 2.
  - Gate miss/realign.
  - Gate index and `seconds.toFixed(2)` log formatting.

  Confirm the test fails until production events attach descriptors.

- [ ] **Step 2: Attach descriptors at event boundaries**

  Change `pushCallout` and `pushLog` to accept typed objects rather than adding more positional parameters. Preserve the legacy `title`, `sub`, and `text` fields byte-for-byte.

  Add descriptors at:

  - Pointer-lock result.
  - Camera toggle.
  - Engage.
  - Collision/hull impact.
  - Boost reserve depletion.
  - Gate pass and miss.

  Keep `RunResult` unchanged.

- [ ] **Step 3: Localize all five radio/comms lines**

  Replace `RADIO_LINES.text` with stable catalog IDs and resolve the text with the locked active-run translator only when the event fires. Keep `DRIFT CONTROL` and `VESPER TERMINUS` as untranslated speaker identities; no public telemetry descriptor is needed.

  Canonical Korean radio copy:

  1. `Kestrel, CAIRN 항로 진입을 허가한다. 행운을 빈다.`
  2. `선반 밀도가 높아진다. 좌현을 주의하라.`
  3. `트랜스폰더를 확인했다. 항로를 유지하라.`
  4. `갈 길이 멀다, Kestrel. 태워 버려라.`
  5. `접근등 점등. 무사히 들어와라.`

- [ ] **Step 4: Handle gate names without frame allocations**

  In `Gate.ts` preserve `CAIRN NN` and `TERMINUS APPROACH`. Create one frozen module-level `TERMINUS_APPROACH_MESSAGE`. In Game telemetry:

  - Attach it only when `gate.index === course.gates.length - 1`.
  - Clear `nameMessage` for all other gates.
  - Clear it when the course is complete and the destination becomes `VESPER TERMINUS`.

- [ ] **Step 5: Render descriptors with legacy fallback**

  In `Hud.ts`:

  - If a descriptor exists, use the active-run translator.
  - Otherwise render the required legacy field.
  - Translate static labels and ARIA values through catalog keys.
  - Keep `CAIRN NN`, `VESPER TERMINUS`, units, and ranks in Latin with `lang="en"` where DOM structure allows.
  - Do not create translator closures or descriptor objects per frame.

- [ ] **Step 6: Add hostile-text and fallback browser checks**

  Inject `<img src=x onerror=window.__LV_INJECTED=1>` as a reason through the test harness. Assert it appears as text, creates no child element, leaves `window.__LV_INJECTED` unset, and triggers no error.

  Also inject telemetry with no descriptor and assert the legacy English string remains visible in both locales.

- [ ] **Step 7: Verify and commit**

  ~~~bash
  npm run test:i18n
  npm run typecheck
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  npm run playtest -- --timeout-ms 60000
  git diff --check
  ~~~

  ~~~bash
  git add src/core/contracts.ts src/i18n/messages.ts src/i18n/ko.ts src/i18n/en.ts src/i18n/domain.ts src/game/Game.ts src/render/Gate.ts src/ui/Hud.ts scripts/playtest/i18n-contract.mjs scripts/playtest/localization.mjs
  git commit -m "feat: localize HUD telemetry without breaking legacy fields"
  ~~~

---

## Task 6: Vendor and Lazily Load NanumSquare Neo

**Files:**

- Create: `public/fonts/NanumSquareNeo-Light.woff2`
- Create: `public/fonts/NanumSquareNeo-Regular.woff2`
- Create: `public/fonts/NanumSquareNeo-Bold.woff2`
- Create: `public/fonts/OFL.txt`
- Create: `public/fonts/NOTICE.md`
- Create: `src/i18n/fonts.ts`
- Modify: `src/ui/styles.css`
- Modify: `src/main.ts`
- Modify: `src/game/Game.ts`
- Modify: `src/core/harness.ts`
- Modify: `src/core/art.ts`
- Modify: `scripts/playtest/localization.mjs`
- Test: `scripts/playtest/localization.mjs`

- [ ] **Step 1: Add red network and readiness checks**

  Assert:

  - A fresh persisted-English `openBootScenario` requests zero `NanumSquareNeo-*.woff2` files.
  - A separate fresh Korean `openBootScenario` requests only declared weights and receives HTTP 200.
  - Korean title reaches either `ready` or bounded `fallback` without blocking forever.
  - A forced font failure still leaves the game playable and text visible.
  - Korean loader and fatal DOM compute a font-family containing `NanumSquare Neo Hangul` rather than silently using only the system fallback.

- [ ] **Step 2: Download the official archive and verify hashes**

  Source:

  `https://campaign.naver.com/nanumsquare_neo/download/NaverNanumSquareNeo.zip`

  Expected archive SHA-256:

  `aba166203bf7637324f1d923bcf9501eb276cfca044c1ad714ba06b1e61a15cc`

  Expected unmodified WOFF2 hashes:

  | Repo file | Official file | SHA-256 |
  |---|---|---|
  | NanumSquareNeo-Light.woff2 | NanumSquareNeoTTF-aLt.woff2 | f0da0f2329935d3f88f7e4162b68fcdc0be393f74398736ea0967594282ca4e2 |
  | NanumSquareNeo-Regular.woff2 | NanumSquareNeoTTF-bRg.woff2 | d13846b612acc829078aff4f91c272c637c08441b409d46bb1a4c802eb2967c3 |
  | NanumSquareNeo-Bold.woff2 | NanumSquareNeoTTF-cBd.woff2 | 97dfe9720fbed813fc988fcedbcf741e97eef9353515b2043717484ec0b90aa1 |

  Verify copyright metadata:

  `Copyright © 2022 NAVER Corp. All rights reserved. Font Designed by Sandoll Inc.`

  Do not subset or modify the binary font files.

- [ ] **Step 3: Add license records**

  - Add the verbatim SIL Open Font License 1.1 text from the official SIL source as `OFL.txt`.
  - In `NOTICE.md` record the Naver source URL, official archive hash, each WOFF2 hash, copyright metadata, renamed file mapping, retrieval date, and that binaries are unmodified.

- [ ] **Step 4: Declare Hangul-only faces**

  Add `@font-face` entries under the family alias `NanumSquare Neo Hangul` with `font-display: swap` and:

  `U+1100-11FF, U+3130-318F, U+A960-A97F, U+AC00-D7A3, U+D7B0-D7FF`

  Put this family first only in Korean UI stacks. Latin glyphs and numbers must fall through to the current display/mono fonts.

- [ ] **Step 5: Add bounded font preparation**

  Implement a two-stage handle:

  ~~~ts
  export interface LocaleFontResult {
    locale: Locale;
    status: 'not-required' | 'ready' | 'fallback' | 'failed';
    error?: string;
  }

  export interface LocaleFontPreparation {
    initial: Promise<LocaleFontResult>;
    settled: Promise<LocaleFontResult>;
  }

  export function prepareLocaleFonts(
    locale: Locale,
    timeoutMs?: number,
  ): LocaleFontPreparation;
  ~~~

  English resolves both promises as `not-required` without calling `document.fonts.load`. For Korean, `initial` races the actual load against a finite timeout and may return `fallback`; `settled` independently resolves later as `ready` or `failed`. Catch the underlying load so neither promise can reject unobserved. Boot awaits only `initial` and therefore never deadlocks.

  Pass the completed boot result and the existing `settled` promise into Game so it does not issue a duplicate initial load. Both must correspond to the same sanitized locale supplied through `LocaleStore`.

- [ ] **Step 6: Handle title-time English-to-Korean switching**

  `Game.applyLocale()` must start `prepareLocaleFonts(locale)` for a newly selected title locale, increment a generation token, and observe both `initial` and `settled`. Store each result only if both the generation and selected locale still match. A late `ready` result replaces `fallback`. Expose `fontStatus` in the existing `locale()` harness snapshot.

  This task records readiness but does not yet mutate the cockpit. Task 7 consumes the current readiness and generation-safe completion to redraw the MFD. Test rapid `en → ko → en` switching with a delayed Korean promise and prove the stale result cannot change the final English state.

- [ ] **Step 7: Verify and commit**

  ~~~bash
  shasum -a 256 public/fonts/*.woff2
  npm run test:i18n
  npm run typecheck
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  git diff --check
  ~~~

  ~~~bash
  git add public/fonts src/i18n/fonts.ts src/ui/styles.css src/boot.css src/main.ts src/game/Game.ts src/core/harness.ts src/core/art.ts scripts/playtest/localization.mjs
  git commit -m "feat: add licensed Korean font loading"
  ~~~

---

## Task 7: Localize the Cockpit MFD and Prove Real Pixels Changed

**Files:**

- Modify: `src/render/CockpitModel.ts`
- Modify: `src/game/Game.ts`
- Modify: `src/core/harness.ts`
- Modify: `src/main.ts`
- Modify: `scripts/playtest/localization.mjs`
- Modify: `scripts/playtest/perf-probe.mjs`
- Test: `scripts/playtest/localization.mjs`
- Test: `scripts/playtest/perf-probe.mjs`

- [ ] **Step 1: Write red MFD evidence checks**

  Assert Korean and English cockpit runs produce:

  - Different hashes for the label atlas ROI.
  - Different hashes for the final post-FX MFD screen ROI.
  - Stable `mfdUpdates` at the existing 20 Hz cadence.
  - Unit object scale and unchanged cockpit draw/triangle budgets.
  - Zero late `compileShader` and `linkProgram` calls.
  - Exactly one actual WebGL upload of the 1024×256 MFD CanvasTexture per MFD redraw, never one upload per render frame.

- [ ] **Step 2: Make MFD locale-aware**

  Extend `CockpitModel` with:

  ~~~ts
  constructor(locale: Locale, translator: Translator, fontReady: boolean)
  setLocale(locale: Locale, translator: Translator, fontReady: boolean): void
  setFontReady(locale: Locale, ready: boolean): void
  invalidateMfd(): void
  getMfdEvidence(camera: PerspectiveCamera): CockpitMfdEvidence
  ~~~

  Localize:

  - `ATTITUDE` → `자세`
  - `VECTOR / RANGE` → `벡터 / 거리`
  - `SHIP SYSTEMS` → `기체 계통`
  - `ENG` → `동력`
  - `HULL` → `선체`
  - `THR` → `추력`
  - `RETRO BRAKE` → `역추진 제동`
  - `HULL WARN` → `선체 경고`
  - `PROX WARN` → `근접 경고`

  Render velocity unit as `m/s`.

  Complete the final locale transaction here: after `replaceOverlay` hydration, `Game.applyLocale()` calls `cockpitModel.setLocale(locale, translator, fontReady)` with the matching current font result. A generation-safe Korean `settled` result calls `setFontReady('ko', true)` and `invalidateMfd()` even when `initial` previously timed out, but only when Korean is still selected. A `failed` result preserves fallback rendering. This is the point at which Overlay and cockpit become atomically consistent in the finished feature.

- [ ] **Step 3: Preserve temporal and allocation contracts**

  - `invalidateMfd()` sets only a dirty flag.
  - Redraw when dirty, on the existing 20 Hz deadline, or after a time rewind.
  - Upload the CanvasTexture once per redraw.
  - Do not allocate materials, textures, canvases, or closures inside `update()`.
  - Ignore stale Korean font promises if the active locale changed to English.

- [ ] **Step 4: Make text fit deterministically**

  Add a Canvas2D helper that measures text, reduces font size to a defined minimum, and ellipsizes only if still necessary. Keep fixed numeric/data regions stable and limit localized labels to their assigned panels.

- [ ] **Step 5: Expose actual-pixel evidence**

  `CockpitMfdEvidence` must contain:

  - Locale and font readiness.
  - Canvas dimensions.
  - Label ROI coordinates and pixel hash from `getImageData`.
  - MFD mesh final projected NDC corners.
  - Redraw count.

  The browser suite must additionally capture the corresponding final PNG ROI after post-processing and hash that pixel region. A debug string or catalog lookup alone is not sufficient.

  Wrap `WebGL2RenderingContext.texImage2D` and `texSubImage2D` after warm-up, identify TexImageSource uploads with the exposed 1024×256 MFD canvas dimensions, and compare their count to the `mfdUpdates` delta over a deterministic 60-frame trace. Restore both methods in `finally`. This catches a regression where `needsUpdate` is set at 60 Hz while the debug redraw counter still reports 20 Hz.

- [ ] **Step 6: Verify and commit**

  ~~~bash
  npm run typecheck
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  npm run playtest:perf -- --timeout-ms 60000
  git diff --check
  ~~~

  ~~~bash
  git add src/render/CockpitModel.ts src/game/Game.ts src/core/harness.ts src/main.ts scripts/playtest/localization.mjs scripts/playtest/perf-probe.mjs
  git commit -m "feat: localize cockpit instrumentation"
  ~~~

---

## Task 8: Finish Accessibility and Responsive Visual Coverage

**Files:**

- Modify: `index.html`
- Modify: `src/main.ts`
- Modify: `src/ui/Screens.ts`
- Modify: `src/ui/Hud.ts`
- Modify: `src/ui/styles.css`
- Modify: `scripts/playtest/localization.mjs`
- Modify: `scripts/playtest/screenshot-matrix.mjs`
- Modify: `scripts/playtest/manifest.mjs`
- Test: `scripts/playtest/localization.mjs`
- Test: `scripts/playtest/screenshot-matrix.mjs`

- [ ] **Step 1: Write red language/accessibility checks**

  Check:

  - `html[lang]` is correct before Game creation and after every title locale switch.
  - Proper nouns, keys, and units embedded in Korean sentences use `lang="en"`.
  - Language controls are a labeled radiogroup with correct selected state.
  - Screen/dialog accessible names, buttons, setting controls, HUD meters, failure, and result announcements are localized.
  - Keyboard focus and W/S navigation work in both locales.
  - Reduced-motion behavior is unchanged.

- [ ] **Step 2: Localize boot/fatal static markup**

  Update `index.html` to a Korean-default shell and set its runtime language immediately from the sanitized persisted locale before font or application initialization. Keep a safe Korean fallback for invalid storage.

  Localize loader, WebGL failure, and fatal error DOM through the same catalog without requiring Game or Overlay construction.

- [ ] **Step 3: Add explicit responsive screenshot cells**

  Capture both languages at:

  - 1920×1080 desktop title and briefing.
  - 1280×720 title, briefing, settings, and controls.
  - 375×667 portrait title, briefing, settings, and failure.
  - 640×360 short viewport title and briefing.
  - Cockpit MFD in normal and HiDPI.

  Store check IDs in the manifest and inspect every image for clipping, overlap, broken line-height, unreadable labels, missing camera controls, and fallback tofu.

- [ ] **Step 4: Verify semantics and visuals**

  ~~~bash
  npm run build
  node scripts/playtest/localization.mjs --timeout-ms 60000
  npm run playtest:screenshots -- --timeout-ms 60000
  npm run playtest:screenshots -- --device-scale-factor 2 --timeout-ms 60000
  git diff --check
  ~~~

- [ ] **Step 5: Commit**

  ~~~bash
  git add index.html src/main.ts src/ui/Screens.ts src/ui/Hud.ts src/ui/styles.css scripts/playtest/localization.mjs scripts/playtest/screenshot-matrix.mjs scripts/playtest/manifest.mjs
  git commit -m "feat: complete localized accessibility and layouts"
  ~~~

---

## Task 9: Full Regression, Documentation, and Merge-Readiness Review

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-23-korean-english-localization-design.md` only if implementation decisions require an explicit amendment
- Modify: `docs/superpowers/plans/2026-08-23-korean-english-localization.md` to mark completed checkboxes
- Test: all production and playtest files changed above

- [ ] **Step 1: Update user and contributor documentation**

  Document:

  - Korean default and English selection on title only.
  - Locale persistence key and run-lock behavior.
  - Camera key `C` and direction-key flight controls.
  - Font source, license, and lazy-loading behavior.
  - `npm run test:i18n` and localization visual test commands.

- [ ] **Step 2: Run the complete verification matrix**

  Run in this order:

  ~~~bash
  npm run test:i18n
  npm run typecheck
  npm run build
  npm run playtest -- --timeout-ms 60000
  node scripts/playtest/localization.mjs --timeout-ms 60000
  npm run playtest:screenshots -- --timeout-ms 60000
  npm run playtest:screenshots -- --device-scale-factor 2 --timeout-ms 60000
  npm run playtest:perf -- --timeout-ms 60000
  npm run playtest:all -- --timeout-ms 60000
  git diff --check
  ~~~

  Required final evidence:

  - All catalog/schema checks pass.
  - Both locale lifecycle paths pass from clean context.
  - Main gameplay suite remains green.
  - Normal and HiDPI screenshots are green.
  - Cold-cockpit compile/link remains zero.
  - MFD update cadence, actual CanvasTexture upload count, and actual-pixel localization pass.
  - No meaningful FPS, p95 frame-time, draw-call, triangle, texture-upload, or render-scale regression.

- [ ] **Step 3: Perform an adversarial review**

  Try to refute:

  1. Locale cannot change after briefing begins.
  2. Restart/retry cannot accidentally resnapshot persisted storage.
  3. Rebuilding Overlay cannot duplicate listeners or settings subscriptions.
  4. English clean boot cannot fetch Korean fonts.
  5. A stale font promise cannot mutate English MFD state.
  6. Optional descriptors cannot alter legacy English fields.
  7. Dynamic text cannot inject HTML.
  8. Korean font loading cannot delay or deadlock boot.
  9. Per-frame gameplay paths do not allocate new descriptor objects.

  Fix any concrete counterexample and rerun the affected focused suite plus the full matrix.

- [ ] **Step 4: Review working tree and commit final documentation**

  ~~~bash
  git status --short
  git diff --stat
  git diff --check
  git add README.md docs/superpowers
  git commit -m "docs: document Korean and English localization"
  ~~~

- [ ] **Step 5: Prepare handoff without merging**

  Report:

  - Branch name and commit list.
  - Exact verification commands and report paths.
  - Font hashes/license records.
  - Any intentionally retained English proper nouns.
  - Any remaining non-blocking visual limitation.

  Do not merge this branch to `main`. Push only when requested or as part of the separately approved local-branch archival workflow.
