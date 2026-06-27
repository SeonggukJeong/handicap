# 디자인 시스템 확산 (설계) (§B12 / C-2 후속)

- **날짜**: 2026-06-27
- **상태**: 설계·plan 둘 다 spec-plan-reviewer **clean APPROVE**(spec 2라운드·plan 3라운드, 2026-06-27) + plan REVIEW-GATE 마커 → **구현 대기**(STOP-gate: `/clear`→fresh 컨텍스트). 사용자 spec 승인 후 **VF 정제**(R6 — 카드형 fieldset/`<h3>` 시각 회귀 방지) 반영. plan = `docs/superpowers/plans/2026-06-27-design-system-spread.md`
- **출처**: 사용자 요청 (roadmap shortlist #3 = §B12 "디자인 시스템 확장"). C-2(`2026-06-27-rundialog-design-system-design.md`)가 토대를 세우고 RunDialog 트리만 채택했고, §7에서 "다른 화면 토큰 이주 … 차츰 같은 프리미티브로 확장"을 연기했다. 이 슬라이스가 그 확산을 실행한다.
- **연관**:
  - **토대(소비만, 0-diff)**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`(accent 토큰)·`ui/src/components/Button.tsx`(accent primary).
  - **확산 대상(JSX 재구성)**: `ui/src/pages/{SettingsPage,ScenarioImportPage,DatasetsPage,EnvironmentsPage,TemplatesPage,SchedulesPage}.tsx` + `ui/src/components/{ScheduleForm,TriggerBuilder}.tsx` + `ui/src/components/datasets/UploadPanel.tsx`.
  - 문구: `ui/src/i18n/ko.ts`(ADR-0035).
- **ADR**: **신규 없음.** 이 슬라이스는 ADR-0043("UI 디자인 시스템 점진 채택")의 *실행*이지 새 결정이 아니다. roadmap §B12에서 완료 항목 이동·새 연기 적재만.
- **범위 결정(사용자, 2026-06-27)**:
  1. **간단/상세 토글은 이번 범위 밖**(별도 슬라이스로 연기). 이번은 확산만.
  2. **확산 대상 = 4개 화면 그룹**(Settings / ScenarioImport(HAR) / Datasets·Environments / Templates·Schedules) — 한 슬라이스·한 머지.
  3. **토대 동결(순수 소비)** — 프리미티브·토큰에 새 tone/variant 추가 없음. 데이터-식별 색·풀-모드 배너·소형 인라인 에러는 그대로 둔다.
  4. **VF(visual fidelity) 정제(spec 승인 후, 사용자 "디자인이 이상해지지 않길")**: `Section`은 **이미 `<fieldset><legend>`인 그룹에만** 적용(legend→legend 무회귀). plain `<section>/<div>`+`<h3>` 단일 폼 카드는 Section으로 바꾸지 않는다(`Section` legend `text-sm`가 `<h3 text-md>` 제목을 축소 = 시각 회귀) — 카드 토큰 정합 + 입력(Input)·알림(Callout)만 교체. 시각 회귀 방지가 적용 깊이보다 우선(R6).

---

## 1. 문제와 목표

C-2는 RunDialog 한 화면에서 정보 위계·용어 안내·시각 통일을 끌어올렸지만, **나머지 폼 화면들은 여전히 ad-hoc**이다 — 같은 입력 룩(`rounded border border-slate-300 px-2 py-1`)이 ~25곳에 손으로 반복되고, 카드/섹션·경고/오류 박스·배지가 화면마다 미묘하게 다르다. 이 슬라이스는 **C-2가 만든 6개 프리미티브를 4개 고빈도 폼 화면에 그대로 적용**해 앱 전반의 폼 룩·위계·포커스/접근성을 통일한다.

- **목표**:
  1. 4개 화면 그룹의 폼 입력·섹션·알림·배지를 **기존 프리미티브로 드롭인 교체**(룩·포커스 링·`aria-invalid`·번호/접힘 섹션 통일).
  2. **동작 byte-identical** — 뮤테이션 페이로드·검증·핸들러·react-query·와이어 0-diff. JSX 마크업만 교체.
  3. **토대 동결** — `ui/src/components/ui/*`·`tailwind.config.ts` 0-diff(순수 소비).
- **비목표(연기)**: §7. 간단/상세 토글·마법사·차트/compare 색 토큰화·기존 `Button`/`Modal`/`HelpTip` 폴더 통합·status 배지 tone화·기존 HelpTip aria ko 이주·나머지 화면(리포트·에디터/Inspector·목록·run 상세).

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 전부 UI-only 표시/구조 폴리시. 와이어/뮤테이션 계약 변경 없음(R3/R13가 0-diff 불변식 소유) → `seam` 열은 비어 있고, 라이브 검증(R15)은 뮤테이션-폼 리팩터 회귀 방지용.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 4개 화면 그룹(6 페이지 + 3 컴포넌트 = 9 파일)의 폼 마크업을 **기존 프리미티브 6종**(`Field`/`Input`/`Select`/`Section`/`Callout`/`Badge`)으로 재구성한다. 그룹 단위(Settings → Import → Datasets·Env → Templates·Schedules)로 진행 | 각 대상 파일 diff가 프리미티브 import·적용을 보임; §4 매핑대로 | |
| R2 | `MUST`(불변식) **토대 동결** — `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx` **0-diff**(새 tone/variant/토큰 0). 이 슬라이스는 순수 소비 | `git diff --name-only`에 `ui/src/components/ui/`·`tailwind.config.ts`·`Button.tsx` 부재 | |
| R3 | `MUST`(불변식) 각 폼의 **동작 byte-identical** — 뮤테이션 요청 본문(POST/PUT/PATCH/DELETE)·검증 게이트·이벤트 핸들러·react-query 훅·상태 round-trip이 재구성 전과 동일. JSX 마크업만 교체 | 각 페이지/컴포넌트 기존 테스트 전부 통과(payload·disable·mutation 분기); 로직 함수 0-diff(리뷰) | |
| R4 | `MUST`(불변식) **데이터-식별 색 동결** — `SchedulesPage` `STATUS_STYLE`(fired/skipped_overlap/missed/error 색)·`SettingsPage` 풀-모드 배너(초록/회색)·`StatusBadge`·`StageCurvePreview`/차트 stroke은 손대지 않는다(C-2 R13 원칙: 데이터-식별 색은 별 도메인) | 그 마크업 0-diff(grep) | |
| R5 | `MUST` raw **`<input>`/`<select>`**(`rounded border border-slate-300 px-2 py-1` 계열 ~25곳)을 `Input`/`Select`로 교체 — number/text/datetime/time/select. **정당 예외(구조 보존·프리미티브 비대상)**: `type="file"`·`type="checkbox"`·`type="radio"` 입력·`<textarea>`·**`aria-pressed` 토글 버튼(TriggerBuilder 요일 `:130`)·dashed 드롭존 컨테이너(UploadPanel `:89`)** 등 비-input 요소. **(a) 고정폭 입력(`w-40`/`w-64`/`w-24`/`w-48`)은 `Input` BASE `w-full`을 래퍼 `<div className="w-NN">`로 감싸 보존**(className 산출 순서 의존 회피 — C-2 RunDialog httpTimeout 래퍼 선례). **(b) auto-width 컨트롤이 *수평 flex 행*에 있으면**(UploadPanel 옵션 select `flex flex-wrap`·TriggerBuilder 간격단위 select)도 `w-full` 확장이 행을 깨므로 폭 래퍼로 compact 유지(라이브 시각 확인). **(c) `font-mono` 입력**(Env var 키 `:138`/`:175`·ScenarioImport 호스트 var `:318`·cron)은 `<Input className="font-mono">`로 mono 보존 | grep을 `<input`/`<select` 요소로 한정 시 raw `border-slate-300` 잔존 0(위 비-input 예외 제외); `pnpm build` + 라이브에서 고정폭·flex-행·mono 시각 확인 | |
| R6 | `MUST` `Section`은 **`border-t` 디바이더 그룹(legend + 위 구분선)에만** 적용 — `Section`은 카드 테두리/패딩/배경 없이 `<fieldset className="mb-4 [border-t border-slate-200 pt-3]"><legend class="text-sm">`만 렌더(RunDialog 내부 그룹용)하므로, 그 출력과 맞는 곳: **ScheduleForm SLO/고급(접힘 `border-t pt-3` `:367`/`:396`)·TriggerBuilder "트리거"(`border-t pt-3` `:78`)**. 접힘 동작 있는 SLO/고급은 `Section collapsible open onToggle divider` + **`hint=`(접힘 시 "N개 설정됨" 표시 보존)**. ⚠ **카드형 `<fieldset>`(ScenarioImport 4개 `rounded-md border p-4` `:184`/`:229`/`:245`/`:292`)·`min-w-0` 보존 fieldset(TemplatesPage preview `:128`)는 Section으로 바꾸지 않는다** — `Section`은 카드 테두리/패딩/`min-w-0`/`text-sm`를 못 실어 카드 룩·overflow 가드가 깨진다(시각 회귀). plain `<section>/<div>`+`<h3>` 단일 폼 카드(EnvironmentsPage `:112`·TemplatesPage 메인 `:105`·UploadPanel `:85`)·리스트 region(DatasetsPage `:46`·리스트 `:233`·Settings 그룹 `:310`/`:331`)·하위컴포넌트 래퍼(SchedulesPage `:128`)도 미변환(VF/F3). **비-Section 그룹은 컨테이너 클래스 토큰 정합 + 내부 입력(Input)·알림(Callout)만** 교체(구조·border·`<h3>`/legend·region·`aria-label`·`min-w-0` 보존) | Section 적용처(SLO/고급/트리거) 시각 무회귀+접힘/hint 보존; 카드형 fieldset border·`min-w-0` 보존(grep); 폼 카드 `<h3>`/region 보존(R10) | |
| R7 | `MUST` **블록-레벨 알림**(페이지/폼 단위 `text-sm` 오류·상태·경고)을 `Callout`으로 전환하되 **기존 `role`을 정확히 보존**(없으면 안 만든다) — error `<p role="alert" text-red-600>` 블록(~10)·warn 박스(Settings apply-note `:295`=**roleless** `<p>`→role 추가 금지·ScheduleForm blocked-reasons `:462`=`role="status"` 보존)·Upload preview/parse. **필드-레벨 인라인(`text-xs text-red-600` borderless)·Upload 인라인 `<span role="alert">`(버튼 옆)은 인라인 유지**(전환=레이아웃 시프트/의미 손상). roleless 블록 오류는 Callout로 옮겨도 **role 미부여**(byte-identical) | 전환 박스 role이 전환 전과 1:1(roleless→무 role·alert→alert·status→status); 기존 role RTL 통과 | |
| R8 | `MUST` warn 배지 **2곳만** `Badge tone="warn"`로 — `SettingsPage` "변경됨" 태그(`:67`)·`ScenarioImportPage` 중복 배지(`:281`). 나머지(status 배지)는 R4로 동결 | 그 2곳 `Badge` 적용; status 배지 0-diff | |
| R9 | `MUST` `EnvironmentsPage` raw `<button>` "추가"(`:196`)를 공유 `Button variant="secondary"`로(명백한 디자인-시스템 드롭인). **EmptyState CTA의 link-style 버튼(EnvironmentsPage `:242`·SchedulesPage `:167`, `EmptyState`의 `action` prop으로 인라인 렌더)은 링크 어포던스 의도라 손대지 않음** | 그 버튼 `Button` 적용·`disabled` 동작 보존; EmptyState CTA 0-diff | |
| R10 | `MUST` 라벨↔컨트롤 연결·셀렉터 lockstep — `aria-label`/placeholder/text로 셀렉트되는 입력은 **그 속성을 패스스루로 보존한 `Input`/`Select`**로 교체(가시 라벨 강제 안 함). **실제 테스트가 거는 셀렉터(보존 대상)**: ScheduleForm.test `getByLabelText(/HTTP 타임아웃/`·`/이름/`·`/시나리오/)`·Env.test `/환경 이름/`(nameAria)+placeholder `BASE_URL`/`/값/`·Templates.test `colName`·Upload.test `/파일 선택/`·`/구분자/`·Trigger.test radio name+`/시각/`·Settings.test `getByLabelText(설정 라벨)`. 가시 라벨(`<label htmlFor>`) 있는 곳만 `Field`. **`getByRole("region")` 거는 `<section aria-label>`은 보존**(R6 — Section=role group). 라벨 텍스트 변경 시 그 테스트 동반 수정(은퇴 리터럴 음수단언 금지=editor-ux-polish 함정) | 기존 `getByLabelText`/`getByRole`/`getByPlaceholderText`/`getByText` 셀렉터 통과; 외부 공유 `errorId`(있으면) `Field errorId=`로 보존 | |
| R11 | `MUST` 신규/변경 사용자-노출 문구는 `ko.ts` 경유(ADR-0035) — 단, 섹션 제목 등 **기존 문자열은 출처(ko/legend 텍스트) 그대로 이동**(신규 인라인 문자열 0). 신규 텍스트가 생기면 `ko.common`/해당 `ko.<page>` 재사용/추가. **required/필수·선택 `Badge`는 의미 있는 곳에만**(단일-폼 화면엔 강요 안 함 → 불필요 ko 추가 회피) | 만진 파일 인라인 영어 0·신규 노출 텍스트는 ko 참조(grep) | |
| R12 | `MUST`(불변식) 백엔드·proto·migration·`ui/src/api/*`·`ui/src/api/schemas.ts`·Zod 파싱 **0-diff** — 순수 UI 표시/구조 | `git diff --name-only`에 `crates/`·`*.proto`·`*.sql`·`api/` 부재; diff는 `ui/src`(페이지/컴포넌트)·`ko.ts`·`docs`만 | |
| R13 | `MUST`(불변식) accent 드리프트 — 대상 9 파일에 `text-blue-600`/`bg-blue-*`/`indigo-*` 컨트롤 색 **드리프트가 0개**임을 확인(탐색·spec 리뷰 grep 둘 다 0). 따라서 이번 확산은 신규 색 변경 없음(C-2가 이미 수렴). 새 컨트롤 색을 들이지 않는다 | 만진 파일 blue/indigo 드리프트 0(grep) | |
| R14 | `SHOULD` a11y — 프리미티브가 제공하는 accent 포커스 링·`Field`/`Input` `aria-invalid`+`aria-describedby`·`Section collapsible` `aria-expanded`를 소비로 획득하되 **기존 a11y 계약(role·aria-label·label 연결)은 회귀 없이 보존** | 만진 파일 RTL a11y 셀렉터 통과 + 라이브 키보드/포커스 | |
| R15 | `MUST` 라이브 검증(경량) — 이 화면들은 run-생성/report-파싱/Zod 경로가 **아니라** S-D Zod 갭 비해당. 다만 실 뮤테이션 폼이므로 **대표 라운드트립 스모크**(환경 생성 + 설정 저장 등 1~2개)로 JSX 리팩터 회귀를 닫는다. console 에러 0·포커스 링 가시 | `/live-verify`(워크트리 자체 바이너리 + Playwright) 또는 plan에서 근거와 함께 축소 | ✅(뮤테이션 폼) |

- **seam**: 와이어/뮤테이션 계약 변경 없음 — R3·R12가 "0-diff/byte-identical" 불변식을 명시 소유. R15는 계약이 아니라 리팩터 회귀를 라이브로 닫는다.

---

## 3. 핵심 통찰 (설계 근거)

1. **확산은 *발명*이 아니라 *적용*이다**(R1·R2). C-2가 프리미티브·토큰·accent를 이미 결정·구현했다. 이 슬라이스는 그것을 소비할 뿐이라 **토대를 동결**(R2)해야 위험이 "마크업 교체"로만 한정된다. 새 tone/variant가 필요하면 그건 토대 변경 = 별 슬라이스 신호(이번엔 필요 없음 — §3.3 확인).
2. **재구성의 안전선은 "표현만 바꾸고 로직은 안 건드린다"**(R3·R12). RunDialog는 `buildProfile` 0-diff가 안전선이었다. 여기선 **각 폼의 뮤테이션 페이로드·검증·핸들러·react-query 훅이 0-diff**다. 따라서 **기존 페이지/컴포넌트 테스트가 곧 회귀 가드**고, 셀렉터(라벨/role/aria/text)만 lockstep으로 따라간다.
3. **토대 동결이 성립한다 — 새 tone/variant 불필요**(R2·R4·R8). 탐색 결과 드롭인 후보(입력·카드·테두리 알림·warn 배지 2종)는 전부 기존 프리미티브 API로 덮인다. 토대 변경을 부르는 건 ① status 배지(데이터-식별 색)·② 초록 풀-모드 배너(success variant)·③ 소형 인라인 에러뿐인데, 셋 다 **그대로 두는 게 옳다**(데이터-식별 색은 별 도메인=C-2 R13·인라인→Callout은 레이아웃/의미 손상). 그래서 토대 0-diff가 자연스럽게 성립한다.
4. **`aria-label`↔`getByLabelText`가 최대 함정**(R10). 이 화면들의 입력은 **대부분 `aria-label`로 셀렉트**된다(ScheduleForm·Env·Templates·Upload·Trigger). `Input`/`Select`는 props 패스스루라 `<input aria-label={x} className="…">` → `<Input aria-label={x} />`가 셀렉터를 그대로 보존한다. **가시 라벨이 이미 있는 입력만 `Field`로 승격**하고, `aria-label`-only 입력에 가시 라벨을 강제하지 않는다(이중 라벨링·셀렉터 깨짐 회피). 라벨 텍스트를 실제로 바꾸는 경우만 그 테스트를 lockstep 수정하되, 은퇴 리터럴의 *부재*가 아니라 살아있는 라벨의 *유일성*으로 단언한다(editor-ux-polish grep-0 모순 함정).
5. **드롭인이 a11y를 *공짜로* 올린다**(R14). raw `<input>`엔 포커스 링·`aria-invalid` 스타일이 없지만 `Input`/`Select`는 토큰화된 accent 포커스 링과 `aria-[invalid]` 빨강 링을 BASE로 갖는다. 즉 확산만으로 포커스 가시성·invalid 표시가 통일된다(동작 변화 0, 표시 개선).
6. **데이터-식별 색은 손대면 손해다**(R4). Schedules `STATUS_STYLE`(fired=green/missed=orange/error=red…)는 *상태를 색으로 구분*하는 의도적 신호다. `Badge` 중립/accent/warn tone으로 바꾸면 그 구분이 무너진다 — C-2가 `StatusBadge`·차트 stroke·compare 팔레트를 동결한 것과 같은 이유.
7. **그룹별 단계 = subagent-driven 자연 매핑**(§8). 각 파일이 독립 green 커밋이고, 그룹 경계가 리뷰·롤백 단위가 된다. 한 그룹이 깨져도 다른 그룹과 격리(C-2 Phase B 정신의 화면-스케일 확장).

---

## 4. 변경 상세 (그룹별)

> 각 항목에 **충족 R** 태그. 전부 `ui/src`(페이지/컴포넌트)·`ko.ts`·`docs/` 범위. file:line은 탐색 시점 기준(구현 시 재확인).

### 4.1 Group 1 — Settings — 충족 R: `R1,R3,R4,R5,R6,R7,R8,R10,R11`
- `MutableRow` number 입력(`:77`) → `Input`(`type="number"`·기존 `getByLabelText` 보존).
- 설정 리스트 카드(`<ul ... border rounded-md bg-white>` `:179`/`:220`)는 **토큰 클래스 정합만**(Section 미적용 — 이미 그룹 region 안). **그룹 `<section aria-label>`(`:310`/`:331`)는 `getByRole("region")` 테스트가 걸려 있어 region으로 보존**(Section=group이라 미변환; R6·R10). `subHeader()` `<h4>`는 소제목으로 유지.
- apply-note warn `<p ... bg-amber-50 border>`(`:295`) → `Callout variant="warn"`. load error `<p role="alert" text-red-600>`(`:301`) → `Callout variant="error" role="alert"`.
- "변경됨" 배지(`:67`) → `Badge tone="warn"`(R8). **풀-모드 배너 `modeBanner()`(`:267`, 초록/회색)·행-레벨 소형 에러(`:103`/`:109`)는 동결**(R4·R7 인라인 유지).

### 4.2 Group 2 — ScenarioImport (HAR) — 충족 R: `R1,R3,R5,R7,R8,R10,R11`
- 4개 `<fieldset ... rounded-md border border-slate-200 p-4 [text-sm]>`(옵션/호스트/요청/Host→Env `:184`/`:229`/`:245`/`:292`)는 **카드형이라 Section 미적용**(R6 — Section은 border/padding을 못 실음)·기존 `<fieldset><legend>` 구조·border·`text-sm` 보존(클래스 토큰 정합만), 내부 입력/알림만 교체.
- 입력: 시나리오 이름(`:188`)·var 이름(`:313`, `w-40 font-mono`→래퍼+`className="font-mono"`)·env 이름(`:339`)·헤더모드 `<select>`(`:206`, flex 컬럼이라 w-full 허용·라이브 확인) → `Input`/`Select`(`aria-label` 보존). YAML 미리보기 `<textarea readOnly>`(`:373`)는 `textarea`라 프리미티브 비대상 → 그대로(클래스 토큰 정합만). file/checkbox는 정당 예외(R5).
- HAR parse error `<p role="alert">`(`:177`) → `Callout variant="error" role="alert"`(role=alert 보존). 중복 배지(`:281`) → `Badge tone="warn"`로 교체하되 **`shrink-0` 래퍼 `<span>` 유지**(Badge엔 className 없음[R2 토대 동결] → flex 행에서 압축 방지·F1).
- var 검증·예약 호스트 소형 인라인 에러(`:322`~`:334`/`:345`/`:361`)는 인라인 유지(R7).

### 4.3 Group 3 — Datasets · Environments · UploadPanel — 충족 R: `R1,R3,R5,R6,R7,R9,R10,R11`
- **DatasetsPage**: 삭제 error `<p role="alert">`(`:41`)·load error `<p>`(`:49`) → `Callout`(role 보존/부여). 리스트 `<section aria-label>`(`:46`)는 폼 카드가 아니라 **그대로 유지**(R6 — plain 리스트엔 Section 미적용). DatasetsPage는 입력이 없어 Callout 적용만.
- **EnvironmentsPage**: 폼 카드 `<section aria-label ... bg-white>`(`:112`)는 **구조·`<h3>`·`aria-label` 보존**(Section 미적용·VF/R6)·카드 클래스 토큰 정합만. 이름(`:121`, `w-64`)·키(`:138`/`:173`, `w-40 font-mono`→래퍼+`className="font-mono"`)·값(`:147`/`:183`, `flex-1`→`className="flex-1"`) 입력 → `Input`(`aria-label` 보존). raw "추가" `<button>`(`:196`) → `Button variant="secondary"`(R9·`disabled`/실제 핸들러 보존; 라이브에서 입력 행 높이 정렬 확인). 폼 error(`:210`)·삭제 error(`:227`) → `Callout variant="error" role="alert"`. **예약 var warn(`:204`, `text-xs text-amber-700` borderless 필드-레벨)·EmptyState CTA(`:244`) 동결**(R7 인라인 유지·R9).
- **UploadPanel**: 업로드 카드 `<section aria-label ... border rounded-md p-4>`(`:85`)는 **구조·`aria-label` 보존**(Section 미적용·VF/R6)·카드 클래스 토큰 정합만. 데이터셋 이름(`:109`, `w-48`) → `Input`(래퍼). 옵션 `<select>` 4~5개(`:117`~`:168`, **auto-width, `flex flex-wrap` 행 `:106`**) → `Select`로 바꾸되 **각 폭 래퍼로 compact 유지**(B — w-full로 퍼지면 side-by-side 깨짐; 래퍼 폭은 현재 렌더에 맞춰 라이브에서 확인). parse error `<p role="alert">`(`:180`) → `Callout error`. **parsing 상태 `<p role="status">`(`:175`)·업로드 인라인 `<span role="alert">`(`:219`, 버튼 옆)은 인라인 유지**(R7). file 입력·dashed 드롭존(`:89`) 정당 예외(R5).

### 4.4 Group 4 — Templates · Schedules · ScheduleForm · TriggerBuilder — 충족 R: `R1,R3,R4,R5,R6,R7,R10,R11`
- **TemplatesPage**: 메인 폼 카드 `<section ... bg-white>`(`:105`)는 **구조·`<h3>` 보존**(Section 미적용·VF/R6)·카드 클래스 토큰 정합만. **preview `<fieldset className="min-w-0 mb-3">`(`:128`)도 Section 미적용**(R6 — Section은 `min-w-0` overflow 가드를 못 실음)·fieldset 구조 보존. 이름(`:112`)·설명(`:120`) → `Input`(`aria-label` 보존). 폼/삭제 error(`:132`/`:148`) → `Callout error`.
- **SchedulesPage**: 폼 카드 `<section aria-label ... bg-white>`(`:128`)는 컨트롤이 아니라 `<ScheduleForm>`(자체 카드)+`<ScheduleEventTimeline>`을 감싸는 컨테이너라 **Section 미적용**(region 보존 또는 클래스 정합만·F3). 폼/삭제 error(`:135`/`:152`) → `Callout error`. **status 배지 `STATUS_STYLE`(`:199`)·EmptyState CTA(`:169`) 동결**(R4·R9).
- **ScheduleForm**: 이름(`:266`)·시나리오 `<select>`(`:276`)·httpTimeout(`:329`)·loopCap(`:349`) 입력 → `Input`/`Select`(`aria-label` 보존). SLO/고급 접힘 `<fieldset ... border-t pt-3><legend><button aria-expanded>`(`:367`/`:396`) → `Section collapsible open onToggle divider` + **`hint={!open && count>0 ? "N개 설정됨" : undefined}`로 접힘 카운트 인디케이터 보존**(`ui-optional-sections-collapsible` 메모·사용자 민감)·기존 caret span 제거(Section이 처리). blocked-reasons `<div role="status" ... bg-amber-50 border>`(`:462`) → `Callout variant="warn" role="status"`. checkbox(measurePhases/enabled) 정당 예외.
- **TriggerBuilder**: 전체 `<fieldset className="mb-4 border-t pt-3"><legend>트리거</legend>`(`:78`)는 border-t 디바이더라 `Section title="트리거" divider`(인라인 문자열 그대로 이동·R11). once datetime(`:97`, w-full)·time(`:109`, w-full)·간격 N(`:143`, `w-24`)·cron(`:168`, w-full font-mono) → `Input`(R-1, w-24만 래퍼·font-mono className 유지)·간격 단위 `<select>`(`:153`, **auto-width, flex 행**)는 `Select`로 바꾸되 폭 래퍼로 compact 유지(B). cron preview error `<p role="alert">`(`:181`)는 작아 인라인 유지(R7). radio(트리거 모드)·요일 토글(`aria-pressed`) 정당 예외(구조 보존).

### 4.5 문구 — `ui/src/i18n/ko.ts` — 충족 R: `R11`
- 신규 인라인 문자열 0이 원칙. 섹션 제목은 기존 출처(ko 키/legend 텍스트) 그대로 이동. 신규 노출 텍스트(예: Section `badge`에 필수/선택을 *의미 있게* 넣는 경우)만 `ko.common` 재사용/추가. **대부분의 단일-폼 섹션엔 required/optional 배지를 강요하지 않는다**(불필요 copy·잘못된 의미 부여 회피).
- **dead-key 위생(M1)**: VF 정제(R6)로 폼 카드 `<section aria-label={formAria}>`를 **그대로 보존**하므로 `ko.environment.formAria`(`:953`)·`ko.schedule.formAria`(`:940`)는 **고아 없음**(둘 다 계속 참조). 만에 하나 변환으로 더는 참조 안 되는 ko 키가 생기면 제거(C-2가 죽은 `ko.runDialog.group*`를 `c62080f`로 정리한 선례) — 이번 범위에선 발생 안 함.

---

## 5. 무변경 / 불변식 (명시)

- **토대**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx` 0-diff(R2 — 순수 소비).
- **백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·Zod 파싱**: 0-diff(R12).
- **각 폼 로직**: 뮤테이션 페이로드·검증·핸들러·react-query 훅·상태 round-trip 0-diff(R3) — 마크업만 교체.
- **데이터-식별 색**: Schedules `STATUS_STYLE`·Settings 풀-모드 배너(초록)·`StatusBadge`·차트/`StageCurvePreview` stroke·run-compare 팔레트 0-diff(R4).
- **공유 컴포넌트 경계**: `EmptyState` CTA·`HelpTip`·`Modal`·`Button`(secondary/danger) 시그니처/동작 무변경(소비만 늘림).
- **정당 예외(프리미티브 비대상)**: `type="file"`/`checkbox"`/`radio"` 입력·`<textarea>`·소형 borderless 인라인 에러·인라인 `<span role="alert">`(버튼 옆) — 구조 보존.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 각 대상 파일 diff에 프리미티브 적용(리뷰) + §4 매핑 대조 | |
| R2 | `git diff --name-only`에 `ui/src/components/ui/`·`tailwind.config.ts`·`Button.tsx` 부재 | |
| R3 | 각 페이지/컴포넌트 기존 RTL 테스트 전부 통과(payload·disable·mutation 분기)·로직 함수 0-diff | |
| R4 | Schedules `STATUS_STYLE`·Settings 배너·StatusBadge/차트 stroke 0-diff(grep) | |
| R5 | raw `border-slate-300` 입력 잔존 grep(file/checkbox/radio·textarea 예외) | |
| R6 | 각 그룹 섹션 헤딩/접힘 RTL 셀렉터 통과·ScheduleForm SLO/고급 접힘 토글 보존 | |
| R7 | role=alert/status 보존 RTL·Callout variant/role 1:1 | |
| R8 | Settings "변경됨"·Import 중복 `Badge` 적용·status 배지 0-diff | |
| R9 | Env "추가" `Button` 적용·disabled 보존·EmptyState 0-diff | |
| R10 | 기존 `getByLabelText`/`getByRole`/`getByText` 셀렉터 통과·외부 errorId 보존·변경분 lockstep | |
| R11 | 인라인 영어 0·신규 노출 텍스트 ko 참조(grep) | |
| R12 | `git diff --name-only`(ui/ko/docs만) | |
| R13 | 만진 파일 blue/indigo 드리프트 0(grep) | |
| R14 | 만진 파일 RTL a11y 셀렉터 통과 + 라이브 키보드/포커스 | ✅ |
| R15 | `/live-verify`: 대표 뮤테이션 라운드트립(환경 생성·설정 저장 등 1~2개)·console 에러 0·포커스 링 | ✅ |

- **UI 게이트**: 각 그룹 커밋마다 그 파일 + 의존 테스트 GREEN, 슬라이스 종료 시 `pnpm lint && pnpm test && pnpm build`(전체).
- **회귀 가드 보강(F6)**: R3의 "기존 테스트가 곧 회귀 가드"는 *변환 입력이 테스트로 실제 행사되는* 곳에만 성립한다. 다음은 변환되지만 미행사라 **타깃 lockstep 단언을 추가**한다(렌더 + 키 셀렉터 1~2개): SchedulesPage 폼-카드(폼이 테스트에서 열리지 않음)·TemplatesPage 설명/preview·EnvironmentsPage 기존-행 키/값·DatasetsPage 오류 `<p>`(Callout화 대상 자체가 미단언)·UploadPanel 이름/구분자 외 select. 이 추가 단언이 곧 아래 tdd-guard용 pending diff를 겸한다(F4 연계).
- **라이브 검증(R15)**: C-2보다 경량 — run-생성/report-파싱/Zod 경로 비해당이라 S-D Zod 갭 부재. 그러나 실 뮤테이션 폼 대규모 JSX 리팩터라 대표 라운드트립 1~2개로 회귀를 닫는다(워크트리 자체 바이너리 + Playwright 헤드리스).

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- **간단/상세 모드 토글·단계별 마법사**: 별도 슬라이스(사용자: "확산만, 토글 연기" 2026-06-27).
- **차트/compare 색 토큰화**: 데이터-식별 색은 별 도메인 — 별도 검토.
- **나머지 화면 토큰 이주**: 리포트(`ReportView`/`report/*`)·에디터/Inspector·시나리오 목록·run 상세(`RunDetailPage`)·워커 대시보드(`WorkerDashboardPage`)·비교(`ScenarioComparePage`) — 이번 4그룹 외. 차츰 같은 프리미티브로.
- **status 배지 tone화**: Schedules `STATUS_STYLE`을 `Badge`로 흡수하려면 status tone 추가(토대 변경) 필요 — 데이터-식별 색 정책과 함께 별도 검토.
- **풀-모드 배너 success variant**: Settings 초록 배너용 `Callout` success variant — 토대 변경이라 연기.
- **기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합**·**기존 HelpTip aria 텍스트 ko 이주**: C-2 §7 그대로 유지.

---

## 8. 구현 순서 (plan 입력)

> 전부 `ui/`(+`ko.ts`)·`docs/` — cargo 게이트 비대상(UI 게이트 `pnpm lint && pnpm test && pnpm build`만). **그룹별 단계** — 각 그룹이 독립 phase, 그룹 내 각 파일이 독립 green 커밋(그 파일 + 의존 테스트 GREEN). 단일 슬라이스·단일 머지. 토대(R2)·와이어(R12) 0-diff가 전 phase 공통 불변식.
>
> ⚠ **tdd-guard 사전조치(F4)**: `tdd-guard`는 `ui/src/**`(non-test) 편집 시 디스크에 *pending*(수정/미추적) test-path 파일을 요구하고, className/JSX-only 변경은 주석/공백 auto-pass에 안 들어간다. 셀렉터 보존으로 **테스트 변경이 불필요한 파일**은 pending diff가 없어 가드에 막힌다. 대응: (a) F6의 타깃 lockstep 단언을 *먼저* 그 파일의 test에 추가(=pending diff 생성, 회귀 가드도 겸함), 또는 (b) 단언 추가가 없는 파일엔 `ui/src/<...>/__tests__/_tdd_keepalive.test.tsx`(`it.todo`)를 미리 깔아 그 그룹 src 편집을 unblock하고 task 끝에 `rm`(커밋 금지). orchestrator는 implementer에 명시 경로만 `git add` 지시(`-A` 금지).

**Phase 1 — Settings** (단일 파일·드롭인 밀도 높음·낮은 위험 = 시작점)
1. `SettingsPage` — Input/Callout/Badge 적용(R5/R7/R8); 그룹 region·`<ul>` 카드는 토큰 정합(Section 미적용·VF), 배너·소형 에러 동결(R4). 기존 `SettingsPage.test` lockstep(`getByRole("region")` 보존).

**Phase 2 — ScenarioImport (HAR)**
2. `ScenarioImportPage` — 4 카드형 fieldset 유지(Section 미적용·R6)·입력→Input/Select(var 이름 font-mono)·중복 Badge·HAR error Callout. 기존 `ScenarioImportPage.test` lockstep(`group` 셀렉터 보존).

**Phase 3 — Datasets · Environments · UploadPanel** (그룹 내 3 파일·각 독립 커밋)
3. `DatasetsPage` — Callout만(입력 없음·리스트 region 보존). 오류 `<p>` 렌더 단언 추가(F6).
4. `EnvironmentsPage` — 카드 토큰 정합·Input·Button(추가)·Callout(Section 미적용·VF). 기존 `EnvironmentsPage.test` lockstep(`/환경 이름/`·placeholder `BASE_URL`/`/값/`).
5. `datasets/UploadPanel` — 카드 토큰 정합·Input/Select·Callout(Section 미적용·VF). 기존 `UploadPanel.test` lockstep(`/파일 선택/`·`/구분자/`).

**Phase 4 — Templates · Schedules · ScheduleForm · TriggerBuilder** (그룹 내 4 파일·각 독립 커밋)
6. `TemplatesPage` — 메인 카드 토큰 정합·preview `<fieldset>` 유지(Section 미적용·`min-w-0` 보존·R6)·Input·Callout. lockstep(`colName`).
7. `SchedulesPage` — Callout(폼/삭제 error)만; **폼-카드 Section 미적용(F3)**·status 배지 동결(R4). lockstep + 폼-카드 렌더 단언(F6).
8. `ScheduleForm` — Input/Select·Section collapsible(SLO/고급)·blocked Callout. 기존 `ScheduleForm.test` lockstep(`httpTimeout`/`이름`/`시나리오`).
9. `TriggerBuilder` — Section·Input/Select. 기존 `TriggerBuilder.test` lockstep(radio·`시각`).

**마무리**
10. 전체 UI 게이트(`pnpm lint && pnpm test && pnpm build`) + grep 불변식(R2·R4·R5·R12·R13) + 라이브 검증(R15).
11. roadmap **§B12** 완료 항목 이동 + 새 연기 적재(나머지 화면·success variant·status tone) + build-log 단락 + 루트 CLAUDE.md 상태줄.
