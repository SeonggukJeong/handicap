# 0043. UI 디자인 시스템 — 시맨틱 토큰 + 프리미티브 컴포넌트 레이어 점진 채택

- 상태: 채택됨 (2026-06-27)
- 관련: [ADR-0035](0035-korean-copy.md)(한국어 copy 카탈로그), `docs/superpowers/specs/2026-06-27-rundialog-design-system-design.md`(슬라이스 설계), `tailwind.config.ts`(토큰 정의), `ui/src/components/ui/`(프리미티브 홈)

## 맥락

앱은 Tailwind로 스타일링하지만 **디자인 토대가 없는 상태**였다 — `tailwind.config.ts`의 `theme.extend`가 비어 있고, 사실상 accent 색상이 `indigo-600`이지만 `text-blue-600` 링크·`bg-blue-200` 배지가 혼재해 드리프트가 누적됐다. 프리미티브는 `Button`·`Modal`·`HelpTip` 3종뿐이어서 폼 화면마다 라벨·에러·힌트·aria 연결을 임의로 구현했다.

RunDialog는 앱에서 사용자가 가장 먼저 만나는 폼 화면으로, 수십 개 입력이 평탄하게 펼쳐져 초보자에게 진입 장벽이 됐다(정보 과부하·전문 용어·안내·시각 위계 부재). 동시에 앱 전체에서 **재사용할 디자인 시스템의 출발점**으로 삼기 적합한 규모였다.

## 결정

**UI 디자인 시스템(시맨틱 토큰 + 프리미티브 컴포넌트 레이어)을 점진 채택하고 RunDialog를 첫 채택처로 삼는다.**

### 토큰 레이어 (`tailwind.config.ts`)

`theme.extend`에 시맨틱 별칭을 정의한다 — `colors.accent`는 `indigo` 스케일(primary `indigo-600`·hover `indigo-700`·ring `indigo-500`·soft `indigo-50/700`), neutral은 `slate`(유지), semantic은 amber(경고)/red(오류)/green(통과, 기존 유지). 입력 radius `rounded-md` 통일. 토큰은 Tailwind 스케일 위 별칭이라 런타임 무변화·오프라인 제약 유지.

### 프리미티브 레이어 (`ui/src/components/ui/`)

6종 프리미티브를 신규 홈 디렉토리에 추가한다:
- **`Field`**: 라벨+컨트롤+힌트+에러(`aria-invalid`/`aria-describedby` 자동)+선택적 HelpTip+추천 Badge 래퍼. `htmlFor`+`useId` `id`로 명시 연결, 외부 `errorId` 지원(단일 에러 `<p>`를 여러 입력이 공유하는 경우 보존).
- **`Input`/`Select`**: 토큰화된 컨트롤(포커스 ring=accent·`rounded-md`·`aria-invalid` 스타일). `forwardRef`·표준 HTML 속성 패스스루.
- **`Section`**: 번호 배지+제목+필수/선택 Badge+선택적 접힘(`aria-expanded`). fieldset/legend 대체.
- **`Callout`**: `variant: "info"|"warn"|"error"`, `role` 호출자 지정(alert/status/alertdialog 보존). 토큰화된 soft 배경.
- **`Badge`**: `tone: "neutral"|"accent"|"warn"|…` — 색 단독 금지(텍스트 동반).

기존 `Button`·`Modal`·`HelpTip`는 이번에 제자리 유지(폴더 통합은 연기 — §결과 참조).

### accent 통일 (`Button.tsx`)

`STYLES.primary`를 `bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300`으로. `secondary`/`danger` variant·시그니처·기존 className 병합은 무변경(앱 전역 primary 버튼 색 통일).

### byte-identical 재구성 원칙

채택 화면(RunDialog)은 **JSX 마크업만 프리미티브로 교체**한다. `buildProfile()`·검증 로직(`loadModelErrors`/`canSubmit`)·크로스필드 동작·핸들러·wire 출력은 **0-diff**. 이 불변식이 있어야 라이브 검증(실 run 1회)이 리팩터 회귀를 닫을 수 있다. 다른 화면도 같은 원칙으로 차츰 이주한다.

### 드리프트 수렴 범위

이번에 만지는 파일의 떠도는 `text-blue-600`·`bg-blue-200`를 accent 토큰으로 수렴한다. **차트 stroke(`#2563eb`)·`StageCurvePreview` 곡선선·`runLabel.ts` compare 팔레트·`StatusBadge` running은 데이터 식별 색 도메인이라 손대지 않는다** — 컨트롤 색과 구분이 의도적이다.

## 근거

- **토큰은 신규가 아니라 드리프트 수렴이다**: 앱은 이미 `indigo-600`을 사실상 accent로 쓴다. 이름 붙여 못박으면 새 색을 들이는 게 아니라 기존 드리프트를 닫는 것이다.
- **프리미티브 6종이 폼 화면 전체를 덮는다**: Field/Input/Select/Section/Callout/Badge면 RunDialog 렌더 트리를 덮고, 동시에 폼이 있는 어느 화면에도 재사용 가능하다. 작지만 진짜여야 향후 확장의 출발점이 된다.
- **byte-identical 원칙이 안전선이다**: 로직을 건드리지 않아야 기존 테스트(RunDialog/LoadModelFields/ScheduleForm)가 회귀 가드로 동작한다. 마크업 교체 + 테스트 셀렉터 lockstep으로 페이로드·검증·동작을 유지한다.
- **점진 채택이 리스크를 분산한다**: 한 화면씩 이주하면 버그가 좁은 범위에 격리된다.

## 대안 (기각)

- **전면 UI 리라이트**: 리스크가 크고 점진적 가치가 없다. 기존 로직·테스트를 버리는 비용 대비 이점이 불분명하다.
- **CSS-in-JS(styled-components, Emotion 등)**: Tailwind가 이미 하우스 이디엄이라 런타임 스타일 주입과 빌드 복잡성이 추가 부담이다. Tailwind 토큰 레이어로 같은 목표를 달성한다.
- **3rd-party UI 라이브러리(shadcn/ui, Radix, Ant Design 등)**: a11y·ko 문구·오프라인-CSP 제약을 완전히 제어할 수 없다. 외부 의존성이 큰데 앱의 특수 제약(ADR-0001 사내 QA·ADR-0035 한국어)에 맞춰 커스터마이즈하는 비용이 직접 구현보다 크다. 단, 규모가 커지면 Radix Primitives의 행동 레이어(ARIA 패턴 컴플라이언스)를 취사 도입하는 것은 재검토 가능.

## 결과

- 검증 = 라이브 run 1회(워크트리 자체 바이너리 + Playwright 헤드리스): payload byte-identical·console Zod 0·키보드 포커스 링·추천값 즉시 실행 확인.
- `ui/src/components/ui/`가 디자인 시스템 홈이 됨 — 향후 새 프리미티브는 여기에.
- 연기 항목: 아래 § (roadmap §B12에 누적).
  - 다른 화면(리포트·에디터·목록·설정) 토큰 이주
  - 차트/compare 색 토큰화(데이터 식별 색 도메인)
  - 간단/상세 토글·단계별 마법사
  - 기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합
  - 기존 HelpTip `label` aria 텍스트 `ko.ts` 이주
  - 기본값 숫자 재검토
