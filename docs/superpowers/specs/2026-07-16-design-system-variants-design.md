# 디자인 시스템 5차 — 토대 variant 확장 (compact·card) + RunListControls 해동·InspectorSection 통합 (설계) (§B12 후속)

- 날짜: 2026-07-16
- 출처: `docs/roadmap-status.md` UX·디자인 시스템 테마 추천 다음("토대 변경[컴팩트/카드 variant]이라 brainstorming 선행") + `docs/roadmap.md` §B12 연기 항목 2건(`RunListControls` 컴팩트 variant·`Section` 카드 variant/`InspectorSection` 통합)
- 관련 ADR: ADR-0043(디자인 시스템 — 점진 채택), ADR-0035(ko 카탈로그)
- 서버/와이어: **0-diff** (UI-only)

## 범위 결정 (사용자, 2026-07-16)

1. **범위 = 둘 다**: 컴팩트 variant(Input/Select)+RunListControls 해동 **및** 카드 variant(Section)+InspectorSection 통합. 각각 토대 소변경 + 채택처 1곳씩.
2. **컴팩트 정책 = 캐넌-컴팩트**: Input/Select 캐넌(rounded-md·accent 포커스 링·aria-invalid 링)을 유지하고 패딩만 `py-0.5`로 축소. RunListControls는 이주 시 포커스 링·둥글기 6px를 *얻는* 작은 시각 변화(일관성 획득, 문서화된 fold-in). 픽셀 보존(rounded 4px·링 없음 variant)은 기각 — 토대가 캐넌과 어긋나는 variant를 품게 됨.
3. **카드 채택 범위 = 에디터 Inspector만**: InspectorSection(접이식 5섹션) + Inspector 비접이 카드 중 흡수 가능 사이트. 폼/표시 화면의 `rounded-md p-4 bg-white` 카드는 지오메트리가 다른 별개 캐넌이라 동결 유지(§7 연기).
4. **API 조합 = 1-A + 2-A**: 독립 `compact?: boolean` prop(폰트 축 `size`와 직교) + `Section variant="card"`(별도 CardSection 프리미티브 승격 기각 — 섹션류 3종 drift 표면). + 접힘 hint accname 캐넌 픽스 동반.
5. **사용자 지시(2026-07-16)**: 확립된 UI/UX 원칙(Figma 디자인 시스템 실무 원칙·Nielsen 휴리스틱·WCAG)에 앵커한 **사용자 스토리 + 통과 기준 + 검증 절차**를 spec에 반영 → §2.

---

## 1. 문제와 목표

**문제**: 디자인 시스템 1–4차가 폼·결과·에디터 화면군을 프리미티브로 수렴시켰지만, 두 부류가 "토대에 variant가 없다"는 이유로 동결돼 있다.

- `RunListControls`(run 목록 필터/정렬 툴바)의 raw `<select>`/`<input type="date">`는 `py-0.5` 컴팩트 밀도인데 `Input`/`Select` BASE는 `py-1` — byte-identical 이주 불가로 결과화면 슬라이스(design-system-results-screens)가 동결. 이 컨트롤들은 둥글기(4px vs 6px)·**포커스 링 부재**(키보드 순회 시 브라우저 기본 outline만)로 나머지 화면과 어긋난다.
- 에디터 Inspector의 카드형 fieldset 캐넌(`border border-slate-200 rounded p-3` + `text-xs` legend)은 로컬 `InspectorSection`(접이식)과 raw fieldset(비접이)으로 Inspector.tsx 안에 사본이 흩어져 있다 — `Section`이 카드 룩을 못 실어(3차가 동결) 프리미티브 밖에 남았다.

**목표**: 토대에 두 variant 축을 additive로 추가하고(`compact`·`variant="card"`), 동결 채택처 2곳(RunListControls·Inspector)을 해동/통합한다. 부수 캐넌 픽스 1건: `Section` 접힘 hint가 토글 버튼 *안*에 있어 accessible name이 값에 따라 변하는 문제를 InspectorSection 구조(hint 버튼 밖)로 정렬.

## 2. 사용자 스토리 + 통과 기준 (원칙 앵커) ⟵ 사용자 지시 반영

> 각 스토리는 확립된 UI/UX 원칙에 앵커하고, 통과 기준은 기계 검증 가능(RTL 단언 또는 라이브 computed-style 실측)해야 한다. 검증 절차의 실행 시점·방법은 §6.

| # | 사용자 스토리 | 원칙 앵커 | 통과 기준 | 검증 방법 | 관련 R |
|---|---|---|---|---|---|
| US1 | QA 담당자가 run 목록 툴바에서 필터·날짜를 조작할 때 **다른 화면과 동일한 컨트롤 룩**을 본다 | Nielsen #4 일관성·표준 | 툴바 select/date input의 computed `borderRadius`=6px(`rounded-md`)·`borderColor`=slate-300 `rgb(203,213,225)` — 폼 화면 Input과 동일 | 라이브 `getComputedStyle` 실측 (§6.2) | R5 |
| US2 | 키보드 사용자가 툴바를 Tab으로 순회할 때 **포커스 위치가 항상 시각적으로 보인다** | WCAG 2.4.7 포커스 가시성 | focus 시 `boxShadow`에 accent 링 `rgba(99,102,241,0.3) … 2px` 실측(현행 raw 컨트롤은 링 없음 → 이주로 **획득**) | 라이브 focus 후 `getComputedStyle().boxShadow` (§6.2) | R1·R5 |
| US3 | 툴바·인스펙터의 **시각 밀도(행 높이·글자 크기)가 이주 전과 동일**하다 | 밀도 보존 ([[ui-optional-sections-collapsible]] 사용자 밀도 민감·3차 text-xs 트랩 교훈) | 툴바 컨트롤 `paddingTop/Bottom`=2px(py-0.5)·`fontSize`=14px, Inspector legend `fontSize`=12px — 전/후 동일 | 라이브 실측 전/후 비교 + RTL 클래스 락인 (§6.1·§6.2) | R1·R2·R5·R6 |
| US4 | 스크린리더 사용자가 접힘 섹션 토글에서 **값에 따라 변하지 않는 안정된 이름**을 듣는다 | WCAG 4.1.2 이름·역할·값 (accname 안정성) | 접힘 상태에서 토글 버튼 accname == 제목(힌트 "N개 설정됨" 미포함) — 두 variant 공통 | RTL `getByRole("button",{name})` **정확매치** 단언 (§6.1) | R4 |
| US5 | 사용자가 필터·정렬·섹션 접기를 조작할 때 **동작과 서버 payload가 이주 전과 동일**하다 | 무회귀 (byte-identical 채택 원칙, ADR-0043) | 기존 RTL 전체 무수정 GREEN(R8 예외 제외) + URL 쿼리 직렬화·store 커밋 코드 0-diff | `pnpm test` 전체 + diff 리뷰 (§6.1) | R8·R9 |
| US6 | 개발자가 컴팩트 컨트롤/카드 섹션이 필요할 때 **프리미티브 variant로 얻는다**(raw 복제 금지) | Figma 디자인 시스템 실무 원칙 — 변형은 컴포넌트 사본이 아니라 variant로 관리 | 이주 대상 사이트에 raw 컴팩트 form 컨트롤·raw 카드 fieldset 잔존 0(§4.4 동결 명단 제외); `InspectorSection` 정의 삭제 | orchestrator 직접 grep 재실행 (§6.3) | R5·R6·R7 |

## 3. 요구사항 (정규 — R-id) ⟵ 척추

> **byte-identical의 정의**(design-system-deep과 동일): 렌더 DOM의 태그·aria 속성·클래스 *집합*·computed style이 이주 전과 동일. 클래스 문자열 *순서* 차이는 허용. 이 슬라이스에서 **의도된 시각 delta는 R5의 3건**(§4.3 표)과 **R4의 hint DOM 위치**뿐이며 전부 문서화·라이브 실측.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` `Input`/`Select`에 additive `compact?: boolean` — true면 세로 패딩 `py-0.5`, 미지정 `py-1`(기존). 폰트 축 `size?: "sm"`과 직교(조합 가능). **미지정 경로(md·sm)의 클래스 집합 불변** | 단위 테스트: compact→`py-0.5` 有+`py-1` 無, 미지정→`py-1` 有; `size="sm"` 조합; 기존 Input/Select 단언 무수정 GREEN | Task 3이 소비 |
| R2 | `MUST` `Section`에 additive `variant?: "card"` — card: fieldset `flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3`, legend `px-1 text-xs font-semibold text-slate-600`(+collapsible이면 `flex items-center gap-1`), 본문 `mt-2` 래퍼 **없이** children 직접(fieldset flex gap이 간격 소유), collapsible 버튼은 `hover:underline`+`<span aria-hidden>▾/▸</span> {title}`(기본 variant의 titleRow `text-sm font-semibold text-slate-800` span **미적용** — 에디터 실측 캐넌 §4.2와 1:1). **기본 variant 경로의 클래스 집합 불변**(유일한 승인된 기본-variant 구조 delta는 R4의 hint 이동뿐). card에서 `index`/`badge`/`help`/`divider`는 미지원 — 타입으로 금지하지 않고(교차 조합 타입 복잡화 회피) card 렌더 경로가 **무시**하며, 소비처는 전달하지 않는다(사용처 없음 — YAGNI) | 단위 테스트: card 정확 클래스·구조(래퍼 無)·collapsible 토글·non-collapsible 렌더; 기본 variant 기존 단언 무수정 GREEN | Task 4가 소비 |
| R3 | `MUST` `Section`에 additive `"aria-label"?: string` passthrough(fieldset 속성) — Inspector 조건 카드의 기존 `aria-label` byte-identical용 | 단위 테스트: 전달 시 fieldset에 aria-label, 미전달 시 속성 부재 | Task 4가 소비 |
| R4 | `MUST` `Section` 접힘 hint accname 캐넌 픽스 — hint `<span>`을 collapsible 버튼 **밖**으로 이동. **원칙은 두 variant 공통이되 DOM 모양은 variant별로 다르다**: 기본 variant는 legend가 non-flex라 버튼+hint를 감싸는 `<span className="flex items-center gap-2">` 래퍼 신설, card variant는 legend 자체가 flex라 hint를 legend 직속 형제로(래퍼 없음 — InspectorSection 현행과 1:1). 접힘 버튼 accname == title(정확매치). 각 variant의 hint 클래스는 자기 캐넌 유지(기본 `text-xs font-normal text-slate-500` / card `font-normal text-slate-400`) | 신규 정확매치 단언: `getByRole("button",{name:"<제목>"})`(hint 켜진 접힘 상태에서) + hint 텍스트는 `getByText`로 여전히 노출; 기존 소비처 테스트(RunDialog·ScheduleForm — 정규식 매치) 무수정 GREEN | |
| R5 | `MUST` `RunListControls` 해동 — DateFilter `<select>`→`<Select compact>`·date `<input>` 2개→`<Input compact type="date">`(셋 다 `<div className="w-fit">` 래퍼 — `block w-full` BASE의 auto-width flex 행 캐넌, Inspector method Select 선례). **의도된 delta 3건**(§4.3 표: radius 4→6px·포커스 링 획득·date `px-1`→`px-2`)과 `bg-white`/`text-slate-900` 승계 여부는 라이브 실측으로 시각 동등 확인 | 컴포넌트 diff + 기존 RunListControls/ScenarioRunsPage 테스트 무수정 GREEN + 라이브 §6.2 | R1 소비 |
| R6 | `MUST` Inspector 통합 — `InspectorSection` 정의 **삭제**, 접이식 5섹션 호출부를 `<Section variant="card" collapsible open onToggle title hint>`로; 비접이 요청 카드(`ko.editor.requestLegend`)·조건 카드(`ko.editor.conditionLegend`, `aria-label` passthrough)를 `<Section variant="card" title>`로 — DOM byte-identical(클래스 집합·aria·구조 1:1, §4.2 대조표) | Inspector 기존 테스트(섹션 토글 accname 정확매치 포함) **무수정 GREEN** + `grep -rn "function InspectorSection\|<InspectorSection" ui/src` → 0(**게이트는 정의·JSX 사용만** — 테스트 describe 문자열 `Inspector.sections.test.tsx:59`·주석 `Inspector.test.tsx:514`의 정당한 참조는 위반 아님·개명 불요, ui/CLAUDE.md grep-0 vs 정당 참조 함정) | R2·R3 소비 |
| R7 | `MUST`(불변식) 동결 사이트 무접촉 — §4.4 근거표(elif 카드·정렬 pill 투명 select·필터 칩/리셋/+추가 버튼·ScenarioDefaults 카드·폼/표시 `rounded-md p-4` 카드 전부·LoadModelFields 자체 disclosure) | diff 리뷰: 동결 사이트 라인 무변경 | |
| R8 | `MUST` 기존 테스트 무수정 GREEN이 byte-identical의 1차 증거 — 깨지면 단언이 아니라 이주를 고친다. **명시 예외**: R4 캐넌 픽스로 hint-in-button을 직접 단언하던 테스트가 있으면 그 단언만 캐넌에 맞게 갱신(현재 조사로는 없음 — Section.test·RunDialog 계열은 정규식/텍스트 매치) | `pnpm test` 전체 GREEN + 예외 발생 시 커밋 메시지에 사유 | |
| R9 | `MUST`(불변식) 서버/와이어/모델 0-diff — `crates/`·proto·migration·`ui/src/api/**`·`ui/src/runs/runFilterSort.ts` 0-diff. URL 쿼리 직렬화·store 커밋 경로 무접촉 | `git diff --name-only`가 `ui/src/components`(+테스트)·docs만 | |
| R10 | `SHOULD` 라이브 검증 — §6.2 computed-style 실측 표 + 전/후 스크린샷(run 목록 툴바·에디터 Inspector) | `/live-verify` 절차 기록(수치 포함) | |
| R11 | `MUST`(불변식) 신규 하드코딩 한글 0(신규 사용자 문구 자체가 없음)·신규 `blue-*`/`indigo-*` 컨트롤 색 리터럴 0(accent만) | diff python sweep(`'"[가-힣]'` grep의 비한글-선두 누락 함정 회피) | |

## 4. 변경 상세

### 4.1 컴팩트 variant — `Input.tsx`/`Select.tsx` (충족 R: R1)

```tsx
// Input.tsx 스케치. ⚠ Select.tsx는 "같은 패턴"이지 "같은 BASE"가 아니다 — 각 파일의
// *자기* 현행 BASE를 유지한 채 py-1만 PAD로 이동할 것. Select 현행 BASE엔
// aria-[invalid=true]:* 두 줄이 없고 numeric prop도 없다(이식 금지 — R1 클래스 집합 불변 위반).
const BASE =
  "block w-full rounded-md border border-slate-300 px-2 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400"; // 기존 BASE에서 py-1만 아래 PAD로 이동
const PAD = { normal: "py-1", compact: "py-0.5" } as const;
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  numeric?: boolean;
  size?: "sm";
  compact?: boolean;
};
// className 조립: `${BASE} ${PAD[compact ? "compact" : "normal"]} ${SIZE[size ?? "md"]}` + numeric/호출자 className 기존 규칙 유지
```

- 미지정 경로 클래스 *집합* 불변(문자열 순서는 py 위치가 뒤로 이동 — byte-identical 정의상 허용, 기존 테스트는 `toContain`/`toHaveClass`라 무수정 GREEN).
- `compact`는 패딩만 담당 — 폰트는 `size` 축이 그대로 소유(RunListControls는 컨테이너 `text-sm` 상속과 BASE `text-sm`이 일치해 `size` 미전달).

### 4.2 카드 variant + accname 픽스 — `Section.tsx` (충족 R: R2·R3·R4)

에디터 실측 캐넌과 1:1 대조. **아래 표는 리터럴 계약이다** — 기존 Inspector 테스트 ~15개 단언(`getByRole("button",{name})` 정확매치·`closest("legend").textContent` hint·`closest("fieldset")` `min-w-0` 클래스·`getByRole("group",{name})` fieldset accname)이 이 클래스/구조를 그대로 강제하므로, 어떤 드리프트도 한꺼번에 다발 FAIL로 드러난다(의도된 teeth):

| 부위 | card variant (신설) | 에디터 현행 (InspectorSection·요청/조건 카드) | 기본 variant (불변, hint 위치만 픽스) |
|---|---|---|---|
| fieldset | `flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3` (+`aria-label` passthrough) | 동일 | `mb-4` + divider 조건부 |
| legend | `px-1 text-xs font-semibold text-slate-600`; collapsible이면 `flex items-center gap-1` 추가 | 동일 | `text-sm font-medium` |
| 접이 버튼 | `hover:underline`, 내용 `<span aria-hidden>▾/▸</span> {title}` | 동일 | `flex items-center gap-2 text-slate-700 hover:underline` + titleRow |
| hint (접힘 시) | 버튼 **밖** 형제 `<span className="font-normal text-slate-400">` | 동일 | 버튼 **밖으로 이동**(R4 픽스), 클래스 `text-xs font-normal text-slate-500` 유지 |
| 본문 | `{(!collapsible \|\| open) && children}` — 래퍼 無 | 동일(`{open && children}`) | `<div className="mt-2">` 래퍼 유지 |

- **R4 픽스의 이유**: 접힘 hint("3개 설정됨")가 버튼 안이면 accname이 "판정·고급 3개 설정됨"처럼 **값에 따라 변한다**(WCAG 4.1.2 name 안정성 저해). InspectorSection이 이미 옳은 구조(hint 밖) — 통합하며 Section을 캐넌에 정렬. 기본 variant 소비처는 RunDialog(1)·ScheduleForm(2)이고 테스트는 정규식 매치(`/판정·고급/` 등)라 생존. DOM 구조 변화(버튼+hint를 감싸는 형제 배치)는 flex gap 동일해 시각 무변화 — 라이브 스크린샷으로 확인.
- 기본 variant에서 hint를 버튼 밖에 두려면 legend 안에 `<span className="flex items-center gap-2">` 공통 래퍼로 버튼·hint를 나란히 배치(gap-2는 기존 버튼 내부 gap과 동일값).

### 4.3 RunListControls 해동 (충족 R: R5)

| 사이트 (`RunListControls.tsx`) | 현행 raw | 이후 | 의도된 delta |
|---|---|---|---|
| DateFilter `<select>` | `rounded border border-slate-300 bg-white px-2 py-0.5` | `<div className="w-fit"><Select compact aria-label=…>` | radius 4→6px·포커스 링 획득 |
| dateFrom/dateTo `<input type="date">` ×2 | `rounded border border-slate-300 bg-white px-1 py-0.5` | `<div className="w-fit"><Input compact type="date" aria-label=…>` | 위 2건 + `px-1`→`px-2`(소폭 폭 증가) |

- `bg-white` 클래스는 승계하지 않는다(Input/Select 캐넌에 없음 — 폼 화면 전체가 브라우저 기본 field 배경으로 흰색 렌더 중). `text-slate-900`은 BASE가 부여. 라이브 실측으로 배경·글자색 시각 동등 확인(§6.2).
- 동결: 정렬 pill 내부 `bg-transparent` select(borderless 인라인 — BASE border와 비호환, 억지 흡수 금지 캐넌), 필터 칩(`aria-pressed` 토글 버튼 — Input/Select 도메인 아님, 이미 accent), 리셋/`+ 추가` 버튼(중립 버튼 — Button-accent 도메인 밖).

### 4.4 Inspector 통합 + 동결 근거표 (충족 R: R6·R7)

**흡수** (Inspector.tsx):

| 사이트 | 현행 | 이후 |
|---|---|---|
| 접이식 5섹션 (`InspectorSection` 소비) | 로컬 컴포넌트(173–197) | `<Section variant="card" collapsible open={…} onToggle={…} title={…} hint={…}>` — 정의 삭제, 호출부 직접 교체 |
| 요청 카드 (`requestLegend`, :316) | raw fieldset+legend | `<Section variant="card" title={ko.editor.requestLegend}>` |
| 조건 카드 (`conditionLegend`, :1439) | raw fieldset(`aria-label`)+legend | `<Section variant="card" title={…} aria-label={ko.editor.conditionLegend}>` |

**동결** (이번 무접촉, 근거):

| 사이트 | 근거 |
|---|---|
| elif 카드 (Inspector :1459) | legend 안에 삭제 `×` 버튼 — bespoke interactive legend, 프리미티브로 byte-identical 흡수 불가(design-system-deep "래핑 불가 사이트 억지 흡수 금지" 캐넌) |
| `ScenarioDefaults.tsx` 카드 `<section>` | fieldset/legend 구조가 아님(plain section) — 카드 fieldset 캐넌 밖 |
| 폼/표시 화면 카드(`rounded-md p-4 bg-white` — ScheduleForm·TemplatesPage·SchedulesPage·RunDialog 프리셋 카드·OnboardingGuide·UploadPanel 등) | 별개 지오메트리(6px·p-4·bg-white 명시) = 별개 캐넌 — 이번 card variant(에디터 4px·p-3)로 흡수하면 시각 회귀. 후속 검토(§7) |
| `LoadModelFields` 자체 disclosure 2곳(fieldset `mb-3`) | Section 캐넌(mb-4)과 마진 상이 + worker disclosure 등 bespoke 구조 — 기존 동결 유지 |
| Inspector :940 카드 `<div>`(extract 행 등) | fieldset 아님 — 캐넌 밖 |

### 4.5 문구

신규 사용자 노출 문구 없음(`ko.ts` 0-diff 예상 — 기존 legend/제목/aria 텍스트 전부 이동 없이 재사용).

## 5. 무변경 / 불변식 (명시)

- `crates/**`·proto·migration·`ui/src/api/**`·`ui/src/runs/runFilterSort.ts`·`ui/src/scenario/**`(store/model) **0-diff** — 이 슬라이스의 diff는 `ui/src/components/**`(+테스트)와 docs뿐.
- 토대 중 `Badge`/`Callout`/`Field`/`PageSection`/`Segmented`/`Textarea`/`tailwind.config.ts` **0-diff**(이번 토대 diff는 `Input`·`Select`·`Section` 3파일).
- RunListControls의 필터/정렬 **동작**(핸들러·직렬화·`toggle`/`promoteSort`) 무접촉 — JSX className/컴포넌트 교체만.
- Inspector의 섹션 접힘 localStorage 영속(`editorPrefs`)·store 커밋 경로 무접촉(open/onToggle prop 배선 그대로).
- 기존 `size?: "sm"` 소비처(5파일 22곳 — Inspector·KeyValueGrid·VariablesPanel·BulkEditPanel·ExtractConfirmRow) 렌더 불변(R1이 `compact`를 `size`와 직교로 두므로 전부 무영향).

## 6. 테스트 / 검증 절차 (US 표의 실행)

### 6.1 RTL (tdd-guard: 테스트 파일 먼저 — pending RED 후 src)

- **토대 단위**: R1(compact 락인·직교 조합·기본 경로 불변), R2(card 정확 클래스·구조·토글), R3(aria-label passthrough), R4(**US4 정확매치 accname** + hint `getByText` 노출).
- **채택처**: RunListControls·ScenarioRunsPage·Inspector 계열 기존 테스트 **무수정 GREEN**(R8 — byte-identical 1차 증거). 신규 단언은 라이브가 못 보는 구조 계약만(예: date input이 `Input` BASE 클래스 보유).
- 전체 `pnpm lint && pnpm test && pnpm build`(US5).

### 6.2 라이브 computed-style 실측 (US1–US3의 권위 — jsdom은 JIT purge·투명 렌더·상속 폰트를 못 본다)

`pnpm dev`+controller로 라이브 기동 후 Playwright `browser_evaluate`:

| 대상 | 속성 | 기대값 | US |
|---|---|---|---|
| run 목록 툴바 select/date input | `borderRadius` | `6px` | US1 |
| 〃 | `borderColor` | `rgb(203,213,225)`(slate-300) | US1 |
| 〃 focus 후 | `boxShadow` | `rgba(99,102,241,0.3) … 2px` 포함 | US2 |
| 〃 | `paddingTop`/`paddingBottom` | `2px`(py-0.5) | US3 |
| 〃 | `fontSize` | `14px` | US3 |
| 〃 | `backgroundColor`·`color` | 이주 전과 동일(흰 배경·진회색 글자 — bg-white 제거 검증) | US1 |
| Inspector 카드 fieldset | `borderRadius`/`padding`/`borderColor` | `4px`/`12px`(p-3)/`rgb(226,232,240)`(slate-200) | US3 |
| Inspector legend | `fontSize` | `12px`(text-xs) | US3 |
| RunDialog 판정·고급 접힘 토글 | 스크린샷 | hint 위치 시각 무변화(R4 DOM 이동) | US4 |

+ 전/후 스크린샷: run 목록 툴바·에디터 Inspector(같은 시나리오·같은 뷰포트).

### 6.3 완성도 게이트 (orchestrator 직접 재실행 — subagent self-report 불신)

- `grep -rn "function InspectorSection\|<InspectorSection" ui/src` → **0** (US6 — 정의·JSX 사용 스코프; 테스트 describe/주석의 정당한 참조는 게이트 밖).
- 컴팩트 raw form 컨트롤 잔존 스윕: RunListControls에서 `py-0\.5`를 가진 `<select`/`<input` → 동결 명시(투명 select)만 잔존.
- R7 동결 사이트 라인 무변경 diff 리뷰.

## 7. 의도적 연기 (roadmap §B12에 누적)

- **폼/표시 카드 지오메트리(`rounded-md p-4 bg-white`) 흡수** — 별개 캐넌이라 이번 card variant 범위 밖. 수요 확인 후 variant 축 추가(밀도 prop 또는 두 번째 카드 캐넌) 검토.
- **elif 카드 bespoke legend** — legend-내 액션 버튼 패턴이 다른 사이트에도 생기면 `legendExtra` 류 prop 검토(현재 1곳 — YAGNI).
- **정렬 pill 내부 투명 select** — borderless 인라인 컨트롤 캐넌 부재.
- 기존 §B12 잔여(Callout success·status 배지 tone·severity 팔레트·Checkbox·bespoke 헤더·PageSection 화면군 밖 확산) — 이번 무접촉.

## 8. 구현 순서 (plan 입력)

1. **Task 1**: `Input`/`Select` `compact` prop + 단위 테스트 (R1)
2. **Task 2**: `Section` `variant="card"`·`aria-label`·hint accname 픽스 + 단위 테스트 (R2·R3·R4)
3. **Task 3**: RunListControls 해동 (R5 — Task 1 소비)
4. **Task 4**: Inspector 통합 (R6 — Task 2 소비)
5. **최종**: `handicap-reviewer` + §6.2 라이브 실측 + §6.3 완성도 게이트 (R7–R11)
