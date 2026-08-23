# 한국어 기본·영어 선택 다국어 설계

상태: 승인된 제품 방향을 구현 가능한 구조로 구체화한 설계안
작성일: 2026-08-23
대상 브랜치: `codex/korean-english-localization`

## 1. 배경

LAST VECTOR는 현재 화면, HUD, 결과, 조종석 MFD, 접근성 레이블을 포함한 사용자 문구가 영어로 직접 작성되어 있다. 초기 진입 경험을 한국어로 제공하면서 기존 영어 UI를 계속 선택할 수 있도록 다국어 기반을 추가한다.

제품 요구는 다음과 같다.

- 신규 사용자의 기본 언어는 한국어다.
- 영어를 선택할 수 있다.
- 언어는 타이틀 화면에서만 변경할 수 있다.
- 선택은 즉시 화면에 반영되고 로컬에 저장된다.
- 비행을 시작하면 해당 판의 결과 화면까지 언어가 고정된다.
- 메인 브랜치에는 별도 승인 전 병합하지 않는다.

## 2. 목표와 비목표

### 목표

- 메뉴, 브리핑, 조작 안내, 설정, HUD, 경고, 로그, 결과/실패 화면, 조종석 MFD를 한국어와 영어로 제공한다.
- 한국어가 더 길거나 줄바꿈 방식이 달라도 데스크톱과 작은 화면에서 조작 버튼이 가려지지 않게 한다.
- 기존 게임 상태, 물리, SFX, 저장 데이터, 플레이테스트 하니스의 의미를 유지한다.
- 외부 네트워크 요청 없이 동작한다.
- 나눔스퀘어 네오 공식 WOFF2를 자체 호스팅하고 라이선스 고지를 배포물에 포함한다.

### 비목표

- 비행 또는 일시정지 중 언어 전환
- 브라우저 언어 자동 감지
- 서버 계정 기반 언어 동기화
- 번역 관리 SaaS 또는 런타임 i18n 라이브러리 도입
- 고유명사, 키 이름, 단위, 내부 식별자 번역
- 임의의 복수 언어 확장을 전제로 한 대형 프레임워크 구축

## 3. 번역 정책

### 번역 대상

- 타이틀 메뉴와 브리핑 설명
- 조작법과 설정의 레이블·힌트·옵션 표시명
- HUD 레이블, 부스터 상태, 경고, 콜아웃, 로그
- 완주, 실패, 기록, 스플릿, 재도전 문구
- 조종석 MFD의 기능 레이블
- `aria-label`, 화면 역할, 라이브 리전 등 접근성 문구
- 로더와 사용자에게 노출되는 오류 안내

### 번역하지 않는 항목

- `LAST VECTOR`, `THE CAIRN DRIFT`, `CAIRN 01`, `VESPER`, `VESPER TERMINUS`
- `W`, `A`, `S`, `D`, `SHIFT`, `SPACE`, `C`, 방향키 등 실제 키 이름
- `m/s`, `%` 및 고정 숫자 포맷
- SFX 이벤트 ID, 설정 enum 값, 저장 키, Three.js 오브젝트 이름
- `S`, `A`, `B`, `C`, `D` 랭크 코드
- 테스트용 vantage 이름과 개발자 텔레메트리 식별자

한국어 문구는 짧은 계기판 문체를 사용한다. 영문 대문자 문장을 직역하지 않고, 좁은 HUD에서는 2~6글자 중심의 명사를 우선한다. 한국어 텍스트에는 과도한 자간을 적용하지 않으며 `word-break: keep-all`과 제한적인 `overflow-wrap`을 사용한다.

## 4. 사용자 경험과 언어 생명주기

### 최초 실행

1. 별도 언어 저장값이 없으면 `ko`를 선택한다.
2. Game 생성 전에 저장된 locale을 읽는다.
3. 즉시 `document.documentElement.lang`을 설정한다.
4. 한국어 로더와 타이틀을 표시한다.

브라우저의 `navigator.language`은 기본값 결정에 사용하지 않는다. 제품 기본값은 언제나 한국어다.

### 타이틀 화면

타이틀에 두 언어 선택지를 둔다. 한국어 화면에서는 `한국어 | 영어`, 영어 화면에서는 `Korean | English`로 표시한다. 현재 선택은 `aria-pressed` 또는 동등한 단일 선택 상태로 명확히 노출한다. 영어 화면에 한글 glyph를 남기지 않아 깨끗한 영어 부팅에서는 한글 폰트를 요청하지 않게 한다.

선택 시 `Game.applyLocale()`가 다음 작업을 원자적으로 수행한다.

1. locale 저장소에 값을 기록한다.
2. 문서 `lang`과 지역화 메타데이터를 변경한다.
3. 기존 Overlay를 폐기한다.
4. 새 translator와 locale로 Overlay를 재생성한다.
5. 영속하는 CockpitModel에 locale을 전달하고 MFD를 invalidation한다.
6. 타이틀 화면과 현재 telemetry, 포인터 상태, 설정, 포커스 위치를 복원한다.

언어 변경은 새로고침 없이 즉시 반영한다. 화면 일부의 `textContent`만 교체하는 부분 재바인딩은 사용하지 않는다.

### 브리핑과 비행

- 타이틀을 떠난 뒤에는 언어 선택기를 노출하지 않는다.
- 타이틀에서 브리핑으로 전이할 때 현재 locale을 active run locale로 스냅샷하고 잠근다.
- countdown, flying, paused, finished, failed 전체가 같은 run locale을 사용한다.
- localStorage가 다른 탭이나 테스트 코드에서 변경되어도 진행 중인 판에는 반영하지 않는다.
- 브리핑의 ENGAGE와 결과/실패의 restart는 이미 잠긴 locale을 그대로 재사용한다.
- 타이틀을 우회해 `beginRun()`을 호출하는 하니스 경로는 locale이 아직 잠기지 않았을 때만 같은 lock 함수를 호출한다.
- 결과에서 타이틀로 돌아오면 저장된 locale을 다시 활성 locale로 사용하고 변경 잠금을 해제한다.

## 5. locale 저장소

locale은 기존 `SettingsStore`에 넣지 않고 전용 저장소로 분리한다.

```ts
type Locale = 'ko' | 'en'

const LOCALE_STORAGE_KEY = 'last-vector.locale.v1'
const DEFAULT_LOCALE: Locale = 'ko'
```

저장값이 없거나 스키마에 없는 값이면 `ko`로 복구한다. 저장 실패는 게임 진입을 막지 않으며 현재 세션에서 선택한 locale은 유지한다.

분리 이유는 `SettingsStore.patch()`와 하니스의 `setSettings()`가 비행 중에도 호출될 수 있기 때문이다. locale을 Settings에 넣으면 “한 판 동안 고정” 불변식이 외부 API를 통해 깨진다.

## 6. 타입 안전 카탈로그

런타임 의존성 없이 `src/i18n/`에 정적 카탈로그를 둔다.

```text
src/i18n/
  Locale.ts
  messages.ts
  ko.ts
  en.ts
  index.ts
```

카탈로그는 다음 영역으로 나눈다.

- `meta`
- `loader`
- `screens`
- `controls`
- `settings`
- `hud`
- `events`
- `results`
- `cockpit`
- `a11y`

정적 문자열은 같은 키를 사용하고, 동적 문장은 문자열 이어붙이기 대신 타입이 있는 함수로 표현한다.

```ts
interface Messages {
  hud: {
    boostUsable: (seconds: number) => string
    boostRecharging: (percent: number) => string
  }
  results: {
    splitDelta: (delta: string) => string
  }
}

export const ko = { /* ... */ } satisfies Messages
export const en = { /* ... */ } satisfies Messages
```

문장 내부에 HTML을 넣지 않는다. 사용자 문구는 `textContent`로 출력하며, 키 칩이나 강조가 필요하면 렌더러가 구조를 만든다.

## 7. 외부 계약 보존

`Telemetry`, `GateTelemetry`, `Callout`, `LogLine`, `RunResult`의 기존 영문 문자열은 저장소 밖 소비자가 사용할 수 있는 호환 계약으로 취급한다. 기존 필드의 값이나 의미를 지역화하지 않는다.

공개 `contracts.ts`는 의도적으로 dependency-free이므로 i18n 카탈로그의 `MessageKey`나 `MessageParams`를 import하지 않는다. 지역화가 필요한 동적 이벤트에는 `contracts.ts`가 소유하는 JSON 직렬화 가능한 domain descriptor를 사용한다. 각 variant가 필요한 params를 직접 소유하는 discriminated union으로 key와 params의 상관관계를 보존한다.

```ts
type TelemetryMessage =
  | { type: 'gate-cleared'; gate: number; accuracy: 'dead-centre' | 'clean' | 'cleared' }
  | { type: 'boost-recharging'; percent: number }
  | { type: 'pointer-lock-refused' }
```

실제 union은 코드에 존재하는 이벤트만 열거한다. i18n 계층의 adapter가 이 domain descriptor를 locale별 카탈로그 문구로 바꾼다. optional 필드는 기존 legacy 필드와 1:1로 대응시킨다.

- `gate.nameMessage`
- `callout.titleMessage` / `callout.subMessage`
- `log.message`

`destinationName`은 고유명사이므로 descriptor를 추가하지 않는다. HUD와 Screens는 descriptor가 있으면 현재 run translator로 렌더링하고, 없으면 기존 영문 필드로 폴백한다. 외부 하니스와 보고서는 기존 영문 필드를 계속 사용할 수 있다. 공개 shape가 추가되면 Harness API minor version과 계약 문서를 갱신하고, 별도의 schema assertion으로 optional descriptor의 shape와 `render(en, descriptor) === legacyEnglishField`를 검증한다. `REQUIRED_METHODS`는 함수 존재만 검사하므로 이 검증에 사용하지 않는다.

## 8. Overlay 재생성

현재 HUD는 값 변경이 없으면 DOM 쓰기를 건너뛰는 이전값 캐시를 사용하고 Screens는 정적 노드를 한 번 구축한다. 따라서 locale 변경을 값 변경처럼 취급하는 방식은 누락되기 쉽다.

Game은 `selectedLocale`, `activeRunLocale`, `localeLocked`를 소유하고 다음 수명주기를 한곳에서 관리한다.

- `createOverlay(locale)`
- `disposeOverlay()`
- `replaceOverlay(locale)`
- `applyLocale(locale)`
- `lockLocaleForRun()`
- `unlockLocaleAtTitle()`

`applyLocale()`와 `replaceOverlay()`는 타이틀 phase이며 locale이 잠기지 않았을 때만 호출할 수 있다. 기존 Overlay의 DOM, Overlay가 소유한 이벤트 리스너, 라이브 리전을 완전히 정리한 뒤 새 Overlay를 만든다. 새 Overlay에는 선택한 translator가 생성자 의존성으로 전달된다. 언어 선택기의 callback은 `HudHost.requestLocale(locale)`를 통해 Game의 `applyLocale()`로 들어오며, `Locale` primitive는 dependency-free contracts가 소유하고 i18n 계층이 이를 import한다.

Game의 현재 `readonly overlay`는 private mutable reference로 바꾸되, Input의 lock callback처럼 `this.overlay`를 실행 시점에 조회하는 콜백은 그대로 새 인스턴스를 가리키게 한다. 초기 Overlay는 기존과 동일하게 audio unlock capture listener를 등록한 뒤 만들어 keyboard 첫 제스처의 오디오 순서를 보존한다. locale 변경 제스처는 이미 같은 unlock listener를 통과하며 Overlay 교체가 이를 다시 등록하거나 순서를 바꾸지 않는다.

재생성 후 다음 상태를 복원한다.

- 현재 설정값
- 타이틀 view
- 선택된 언어 버튼
- 첫 내비게이션 항목의 포커스
- 포인터 잠금 안내 상태

Game이 생성자에서 한 번 등록하는 기존 SettingsStore 구독은 재등록하지 않는다. 설정 변경은 렌더 상태를 갱신하고 Overlay는 `getSettings()`로 최신 값을 읽으므로, 새 Overlay를 만든 직후 현재 설정을 한 번 동기화한다. 오래된 DOM 노드와 Overlay 소유 리스너가 남지 않도록 정리 책임은 `Overlay.dispose()`에 둔다.

CockpitModel은 Overlay 수명주기 밖에서 계속 유지되므로 `Game.applyLocale()`가 `cockpitModel.setLocale(activeTranslator)`와 `invalidateMfd()`를 명시적으로 호출한다. Overlay 재생성만으로 locale 변경이 완료됐다고 간주하지 않는다.

## 9. 부트와 오류 화면

`main.ts`의 로더와 Game 생성 전 오류 화면도 같은 locale을 사용한다. 이를 위해 locale 읽기와 카탈로그 접근은 Three.js나 Game 초기화에 의존하지 않는 작은 모듈이어야 한다.

- `index.html`의 정적 기본 `lang`과 기본 메타 문구는 한국어로 둔다.
- 부트 직후 저장 locale이 영어면 `lang`, 제목, 설명을 영어로 교체한다.
- 오류 원문은 디버깅 세부 정보로 별도 표시할 수 있지만 사용자 안내 문구는 번역한다.
- 오류 렌더링은 `innerHTML` 문자열 결합 대신 DOM 생성과 `textContent`를 사용한다.

## 10. 폰트와 라이선스

나눔스퀘어 네오 공식 배포본의 수정하지 않은 WOFF2를 자체 호스팅한다.

예상 파일:

```text
public/fonts/nanum-square-neo/NanumSquareNeo-Light.woff2
public/fonts/nanum-square-neo/NanumSquareNeo-Regular.woff2
public/fonts/nanum-square-neo/NanumSquareNeo-Bold.woff2
public/fonts/nanum-square-neo/OFL.txt
public/fonts/nanum-square-neo/NOTICE.txt
```

배포 전 공식 ZIP 안의 실제 파일명, 저작권 문구, OFL 원문을 그대로 확인한다. 바이너리를 서브셋하거나 수정하지 않는다.

각 `@font-face`는 `font-display: swap`을 사용하고 한글 범위로 제한한다.

```css
unicode-range:
  U+1100-11FF,
  U+3130-318F,
  U+A960-A97F,
  U+AC00-D7A3,
  U+D7B0-D7FF;
```

폰트 family는 기존 display/body/mono 스택에서 한글 glyph만 담당하도록 구성한다. 라틴 문자와 숫자는 기존 폰트를 유지하므로 타이머, 속도, THR, 스플릿의 등폭 정렬이 바뀌지 않는다. `--f-mono` 전체를 나눔스퀘어 네오로 교체하지 않는다.

영어 UI에서는 언어 선택기까지 한글 glyph가 없으므로 깨끗한 영어 부팅에 WOFF2 요청이 발생하지 않아야 한다. 한국어 UI도 실제로 사용한 weight만 브라우저가 요청하도록 모든 파일을 강제 preload하지 않는다. 타이틀에 필요한 weight는 유한 시간 제한이 있는 `document.fonts.load()`로 준비하고, 실패나 지연이 게임 부팅을 영구 정지시키지 않게 한다.

## 11. 조종석 MFD

Canvas2D는 폰트가 준비되지 않아도 오류 없이 폴백하므로 별도 상태 관리가 필요하다.

- MFD renderer에 translator와 `fontReady` 상태를 전달한다.
- 한국어 MFD 문구는 짧은 전용 키를 사용한다.
- `measureText()`로 각 칼럼/바의 허용 폭을 검사하고 넘으면 축약 또는 영문 폴백을 사용한다.
- 나눔스퀘어 네오 로딩이 끝나면 MFD의 dirty 상태를 강제로 올려 다음 프레임에 다시 그린다.
- 폰트 로딩 실패 시 MFD만 영문 레이블로 안전하게 폴백하고 진단 오류를 기록한다.
- 기존 20Hz 캔버스 업데이트 주기와 텍스처 업로드 횟수는 늘리지 않는다.

디버그 상태에는 테스트 가능한 최소한의 정보만 추가한다.

- 적용 locale
- MFD font ready/fallback 상태
- MFD redraw counter
- 측정된 최대 라벨 폭과 허용 폭

자기 보고 값만으로 잘못 그려진 canvas를 통과시키지 않도록 harness에는 실제 MFD canvas에서 얻은 한정된 snapshot 또는 ROI pixel hash를 노출한다. en→ko 전환 및 폰트 강제 실패 전후에 hash가 기대대로 달라지는지 검사하고, cockpit screenshot의 MFD ROI도 함께 비교한다.

## 12. 접근성

- 루트 문서의 `lang`은 활성 locale과 일치한다.
- 영문으로 유지하는 고유명사와 브랜드는 `lang="en"` span으로 렌더링한다.
- 키 칩의 `<kbd>`에도 `lang="en"`을 둔다.
- `aria-label`, dialog 이름, 결과/실패 화면의 역할 문구도 카탈로그에 포함한다.
- 언어 전환 버튼은 키보드로 접근 가능하고 선택 상태를 스크린리더에 알린다.
- Overlay 전체를 교체하므로 과거 callout/log 라이브 리전의 문구를 다시 써서 재낭독시키지 않는다.
- 조종석 MFD의 핵심 상태는 기존 DOM HUD와 의미가 중복되어야 하며 Canvas 텍스트만 유일한 정보원이 되지 않는다.

## 13. 테스트 선택자와 자동화 계약

기존 Playwright 검사가 영문 문구로 버튼과 상태를 찾는 부분을 안정 식별자로 교체한다.

- 버튼: `data-action="begin|engage|resume|restart|settings|controls|abort|again|return|retry"`
- 설정: `data-setting`, `data-value`
- 수치 상태: 언어와 무관한 `data-*` 값
- 화면: 기존 view/phase 식별자 유지

문구 선택자는 카탈로그 검증에만 사용하고 게임 동작 검증에는 사용하지 않는다. 한국어 기본 경로를 피하기 위해 테스트 URL을 영어로 강제하는 방식은 사용하지 않는다.

## 14. 회귀 게이트

### 카탈로그

- `ko`와 `en` 키 집합 및 동적 함수 시그니처 동일
- 빈 번역 없음
- 고유명사, 키 이름, 단위 보존 검사
- 동적 값이 이스케이프된 텍스트로 렌더링되는지 검사

### locale 생명주기

- 빈 저장소 첫 진입은 한국어 및 `<html lang="ko">`
- 타이틀에서 ko → en → ko 왕복 후 text와 모든 aria가 최초 한국어 상태와 동일
- 영어 선택 후 새로고침해 영어가 유지됨
- 잘못된 저장값은 한국어로 복구됨
- 브리핑 진입 후 localStorage와 settings를 변경해도 브리핑부터 결과 화면까지 active run locale이 바뀌지 않음
- restart와 타이틀 우회 harness 시작이 같은 locale lock 규칙을 따름
- 타이틀 복귀 후에만 새 locale을 적용할 수 있음

### 외부 계약

- ko/en에서 기존 Telemetry와 RunResult의 영문 호환 필드가 바이트 동일
- optional domain descriptor만 locale과 무관한 discriminated union과 JSON-safe params로 추가됨
- 영어 renderer가 descriptor를 기존 legacy 영문 필드와 동일하게 렌더링함
- 기존 SFX ID, setting value, rank, storage schema 불변

### 폰트와 MFD

- 페이지 로드 전에 저장 locale을 `en`으로 시드한 깨끗한 영어 부팅의 WOFF2 요청 0건
- 한국어 부팅은 실제 사용 weight만 같은 origin에서 요청
- `.woff2` MIME과 외부 요청 차단 게이트 통과
- `document.fonts.check()` 및 유한 timeout 동작 검증
- 폰트 준비 뒤 MFD redraw counter 증가
- MFD 모든 라벨 폭이 허용 폭 이하
- en/ko와 폰트 실패 상태의 실제 MFD canvas ROI/hash가 기대대로 구분됨
- 폰트 요청 강제 실패 시 영문 폴백과 진단 기록

### 레이아웃과 시각

두 locale에서 다음 화면을 캡처·검사한다.

- 타이틀
- 브리핑과 조작 안내
- 설정과 전체 Controls
- chase/cockpit HUD
- 콜아웃과 로그
- 완주 결과와 실패 화면
- cockpit MFD

기본 데스크톱 외에 최소 1280×720, 375×667, 640×360을 포함하고, clip·overflow·조작 버튼 가림·문구 겹침이 없어야 한다.

### 기존 품질 게이트

- typecheck와 production build
- 전체 playtest
- screenshot matrix
- normal/HiDPI performance probe
- 외부 네트워크 요청 0
- 기존 카메라, 부스터, 실패/재시작, 입력 순서 계약 유지

## 15. 구현 순서

1. 안정적인 `data-action`/`data-setting` 선택자와 테스트 마이그레이션
2. LocaleStore와 타입 안전 카탈로그 기반 구축
3. 부트 로더, 문서 `lang`, 타이틀 언어 선택기
4. Overlay 생성/폐기 수명주기 정리
5. Screens와 설정/조작 안내 번역
6. HUD, 게임 이벤트 descriptor, 결과/실패 번역
7. 공식 폰트와 라이선스 추가, 한국어 타이포 조정
8. Cockpit MFD 번역과 폰트 로딩/폴백
9. ko/en 기능·접근성·시각·성능 회귀 게이트

각 단계는 기능 계약을 먼저 녹색으로 만든 뒤 다음 단계로 진행한다. 번역 변경과 물리·게임 밸런스 변경은 같은 커밋에 섞지 않는다.

## 16. 채택하지 않은 대안

### 부분 DOM 재바인딩

HUD 이전값 캐시, 생성자 고정 문자열, Screens 정적 노드, settings 노드 구독을 모두 무효화해야 한다. 누락 시 언어가 섞여 보이므로 채택하지 않는다.

### 언어 변경 시 전체 페이지 새로고침

구현은 단순하지만 타이틀 상호작용과 포커스를 끊고 로딩을 반복한다. 안전한 Overlay 재생성이 가능하므로 채택하지 않는다.

### i18next 등 외부 라이브러리

두 locale과 약 200개 문구 규모에서는 번들, 네트워크 정책, API 복잡도에 비해 이점이 작다. 타입 안전 정적 카탈로그로 충분하다.

### 번역된 문자열을 기존 Telemetry에 기록

저장소 밖 소비자와 하니스의 의미가 locale에 따라 달라진다. 기존 영문 계약과 message descriptor를 병행한다.

### 나눔스퀘어 네오로 전체 mono 스택 교체

숫자 폭과 HUD 정렬이 흔들릴 수 있다. 한글 glyph만 나눔스퀘어 네오로 보완한다.

## 17. 완료 기준

- 한국어가 무조건 최초 기본값이다.
- 영어 선택이 타이틀에서 즉시 적용되고 새로고침 후 유지된다.
- 비행 시작 이후 결과까지 언어가 변하지 않는다.
- 두 언어의 모든 기능 UI와 접근성 문구가 번역되어 있다.
- 고유명사, 키, 단위, 내부 코드와 외부 영문 계약이 유지된다.
- 나눔스퀘어 네오 원본 WOFF2 및 OFL/저작권 고지가 배포물에 포함된다.
- 영어 경로는 한글 WOFF2를 요청하지 않는다.
- MFD에 폴백, 폭 측정, 재렌더링 검증이 있다.
- 한국어/영어 시각 및 모바일 레이아웃과 기존 전체 품질 게이트가 통과한다.
- 메인 브랜치는 사용자의 명시적 승인 전 변경하거나 병합하지 않는다.
