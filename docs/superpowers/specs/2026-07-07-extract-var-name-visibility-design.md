# 변수 패널 추출 변수 이름 가시성 — 좁은 열에서 이름이 0폭으로 눌리는 행을 적응형 줄바꿈으로 수리 (에디터 변수 패널 폴리시)

- **날짜**: 2026-07-07
- **상태**: 설계 승인(사용자 2026-07-07) → plan 대기
- **출처**: 사용자 도그푸딩 보고 — "변수를 응답에서 추출하고 사용하는 경우, 변수 이름이 완전히 가려져 버려서 이름을 볼 수가 없는 문제". 에디터를 실사용하는 즉시 부딪히는 가시성 결함이라 지금 수리.
- **연관**: `2026-07-04-editor-var-tools-design.md`(변수 패널 행 구조·usage 버튼), `2026-07-04-editor-varpanel-viewport-polish-design.md`(#3 팝오버·열 스크롤), `2026-07-05-editor-viewport-polish-v2-design.md`(varsWide 뷰모드·210px 열).
- **ADR**: 신규 불필요 — 순수 UI 레이아웃(className) 변경, 기존 ADR-0044(아웃라인 에디터)·ADR-0043(디자인 시스템) 범위 내.

---

## 1. 문제와 목표

기본(비-wide) 에디터 그리드에서 변수 열은 210px 고정(`EditorShell.tsx` `grid-cols-[210px_…]`)인데, `VariablesPanel.tsx`의 단일 줄 행 3종(flat-extract·parallel-extract·undefined)은 `flex items-center gap-2`(no-wrap) 한 줄에 `[이름(flex-1 min-w-0)] [✎] [배지] [사용처 버튼]`을 전부 얹는다. 이름만 `min-w-0`으로 축소를 흡수하므로, 고정 요소(✎ 11px + "추출됨" 31px + "N개 스텝에서 사용" ~85px + gap 24px ≈ 151px)를 빼면 **이름에 27px만 남아 사실상 안 보인다**(라이브 실측: `token`이 `to…`로 렌더, 행폭 178px). 추출되고 *사용 중*인 변수가 정확히 최악 조합(배지 2개 모두 김)이라 사용자 보고와 일치한다. 선언 변수 행은 usage가 별도 줄이라 무사하다.

- **목표**: 행을 `flex-wrap` + 이름 최소폭으로 바꿔, 좁은 열에선 사용처 버튼(필요시 배지)이 자동으로 둘째 줄로 내려가 이름이 항상 읽히고, 넓은 모드(varsWide)에선 현재의 단일 줄 밀도를 그대로 유지한다.
- **비목표(연기)**: §7 참조. 문구 축약·선언 행 재구성·열 폭 조정 없음.

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST: 단일 줄 행 3종(flat-extract·parallel-extract·undefined)의 `<li>` 컨테이너는 `flex-wrap`을 허용하고 세로 간격은 행 간 간격(gap-3)보다 좁게(`gap-x-2 gap-y-1`) 둔다 | RTL: li `className.split(/\s+/)`에 `flex-wrap`·`gap-x-2`·`gap-y-1` 토큰 포함, `gap-2` 부재 | |
| R2 | MUST: 이름 span 4곳(flat-extract/declared 공용 `nameCell`, parallel non-shadow, parallel shadow, undefined)과 rename 인라인 Input 래퍼 div 2곳(flat·parallel)은 `min-w-0` 대신 `min-w-[72px]`로 최소폭을 보장한다 | RTL: 이름 span/래퍼 `className` 토큰에 `min-w-[72px]` 포함·`min-w-0` 부재 | |
| R3 | MUST: 좁은 기본 열(210px)에서 추출+사용 행의 이름 실폭이 72px 이상이고 사용처 버튼은 이름보다 아래 줄에 렌더된다 | 라이브 Playwright: `getBoundingClientRect()` — name.width ≥ 72 && usageBtn.top > name.top | |
| R4 | MUST: varsWide(◧) 모드에서 같은 행이 단일 줄을 유지한다(밀도 무손실) | 라이브 Playwright: name.top === usageBtn.top (같은 행) | |
| R5 | MUST: 선언 변수 행의 구조·시각 결과, 문구(`ko.ts`)·usage 팝오버 동작·`truncate`+`title` 툴팁·모델/스토어/wire는 무변경 — 단 declared(renamable) 행이 공유하는 `nameCell`의 클래스 변경은 허용(폭이 넉넉해 min-width 미발동 = 시각 no-op) | `git diff` 범위 = `VariablesPanel.tsx`(+테스트)뿐, 기존 VariablesPanel 테스트 전부 green | |
| R6 | SHOULD: 줄바꿈 시 이름+✎+상태 배지("추출됨"/"분기"/"⚠ 미정의")가 첫 줄에 우선 남고 사용처 버튼부터 내려간다(DOM 순서 유지로 자연 충족) | 라이브 Playwright: 배지.top === name.top (기본 열, 배지가 첫 줄) — parallel 행처럼 첫 줄이 넘치면 배지도 내려감은 허용 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **왜 flex-wrap + 이름 최소폭인가 (대안 기각)**: ① *항상 2줄 스택*(선언 행 미러)은 예측 가능하지만 varsWide에서도 2줄이라 밀도 손실(R4 위반) — 사용자가 적응형을 선택. ② *문구 축약*("N곳 사용")은 고정폭을 줄일 뿐 긴 이름은 여전히 잘리고, 선언 행의 동일 문구와 불일치가 생겨 기각. flex-wrap에서 flex-1 항목의 줄바꿈 판정은 hypothetical main size = max(flex-basis 0, min-width)라, `min-w-[72px]`가 곧 줄바꿈 트리거가 된다 — 좁은 열(행폭 178px)에선 이름(72) + 고정(151)이 한 줄을 넘어 usage가 내려가고, 넓은 열에선 전부 들어가 한 줄 유지. 이름/짧은 이름 구분 없이 열 폭만으로 결정되므로 행마다 들쭉날쭉하지 않다.
2. **72px 근거**: mono text-xs(12px) 글자폭 ≈ 7.2px → 72px ≈ 10자. 줄바꿈 후 이름 실폭은 flex-1로 첫 줄 잔여를 다 받아 ~100–120px(14–16자, `access_token` 12자 완전 표시). 초장문 이름은 기존 `truncate`+`title`이 그대로 커버(R5).
3. **rename 인라인 Input도 같은 27px 함정**: 편집 상태의 `<div className="flex-1 min-w-0">`가 이름 span과 같은 flex 슬롯이라 동일하게 눌린다 — R2가 래퍼 div까지 포함하는 이유.
4. **클래스 계약 테스트는 정확-토큰 방식**: raw 문자열 `toContain("min-w-[72px]")`… 은 안전하지만 `flex-wrap` 같은 토큰은 substring 오염 위험이 있어(ui/CLAUDE.md `max-h-`⊃`h-` 함정) 일괄 `className.split(/\s+/)` membership으로 통일. jsdom은 레이아웃이 없으므로 R3/R4의 실제 줄바꿈은 라이브 Playwright rect 실측이 권위([[implementation-rigor-over-spec]] — DOM 존재/클래스만으로 PASS 금지).

---

## 4. 변경 상세

### 4.1 `ui/src/components/scenario/VariablesPanel.tsx` — 충족 R: R1, R2, R6

- flat-extract `<li>`(`key={f:…}`), parallel-extract `<li>`(`key={p:…}`), undefined `<li>`(`key={u:…}`): `className="flex items-center gap-2"` → `"flex flex-wrap items-center gap-x-2 gap-y-1"`.
- `nameCell` 비편집 이름 span·parallel non-shadow 이름 span·parallel shadow 이름 span·undefined 이름 span: `min-w-0 flex-1 truncate …` → `min-w-[72px] flex-1 truncate …`.
- `nameCell` 편집 상태 래퍼 `<div className="flex-1 min-w-0">`·parallel 편집 상태 래퍼 동일 → `flex-1 min-w-[72px]`.
- DOM 순서는 그대로(이름 → ✎ → 배지 → usage) — R6은 순서 보존만으로 충족.
- 선언 변수 행(`key={d:…}`)의 li/textarea/usage 구조·하단 add-row·검색 Input·usageCell/`VarUsagePopover`는 무변경(R5). 단 declared(renamable) 행은 `nameCell`을 공유하므로 그 이름 span/rename 래퍼의 클래스 변경이 함께 적용된다 — declared 서브행은 `[이름][×]`뿐이라 폭이 항상 72px를 넘어 min-width 미발동(시각 no-op). declared *non-renamable* 이름 span(별도 인라인 span, `min-w-0`)은 건드리지 않는다.

### 4.2 `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` — 충족 R: R1, R2, R5

- 클래스 계약 테스트 추가: extract+사용 fixture로 행 li·이름 span의 토큰 단언(§3-4 방식). 기존 테스트(이름 rename·usage 팝오버 등)는 무변경 green이 R5의 절반(나머지 절반은 diff 범위 확인).

---

## 5. 무변경 / 불변식 (명시)

- 엔진/컨트롤러/proto/migration/스토어/모델/Zod/ko.ts: 0-diff. 순수 프레젠테이션(className) 변경.
- 선언 변수 행(이름+×/textarea/usage 3층 구조): 구조·시각 결과 불변 — 공유 `nameCell` 클래스만 바뀌고 min-width는 미발동(R5 단서).
- "추출됨"/"분기"/"⚠ 미정의"/"N개 스텝에서 사용" 문구·`title` 툴팁·aria-label: byte-identical.
- varsWide 모드 시각 결과: 단일 줄 유지(클래스는 바뀌지만 렌더 결과 동일 — wrap 미발동).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | RTL `VariablesPanel.test.tsx` — li 클래스 토큰(`flex-wrap`·`gap-x-2`·`gap-y-1` 포함, `gap-2` 부재) | |
| R2 | RTL — 이름 span·rename 래퍼 클래스 토큰(`min-w-[72px]` 포함, `min-w-0` 부재), rename은 ✎ 클릭 후 단언 | |
| R3 | 라이브 Playwright(vite dev, `/scenarios/new` → "로그인 흐름" 템플릿): 기본 열에서 name rect.width ≥ 72 && usage.top > name.top | ✅ |
| R4 | 라이브 Playwright: ◧ 토글 후 name.top === usage.top | ✅ |
| R5 | `git diff --stat` 범위 확인 + 기존 `VariablesPanel.test.tsx` 전체 green + `pnpm lint && pnpm test && pnpm build` | |
| R6 | R3 측정에 배지 top 단언 포함(배지.top === name.top) | |

- 라이브 검증은 클라이언트-only(`/scenarios/new`는 백엔드 불필요) — `/live-verify` 풀스택 불요, vite dev + Playwright rect 실측으로 충분. run-생성/리포트/엔진 경로 0-diff라 라이브 run은 불요.
- 재현 기준값(수리 전, 2026-07-06 실측): 행폭 178px에서 name.width = 27px.

---

## 7. 의도적 연기 (roadmap 비누적 — 재보고 시 재평가)

- **"N개 스텝에서 사용" 문구 축약**: 레이아웃 수리로 충분하고, 선언 행과 문구 일관성 유지가 우선. 축약은 별도 UX 근거가 생기면 재평가.
- **변수 열 폭(210px) 자체 조정·리사이저**: viewport 폴리시 v2에서 확정한 그리드 계약 — 이 슬라이스는 열 폭을 건드리지 않는다.
- **선언 변수 행 레이아웃 재구성**: 현재 문제없음(usage 별도 줄).

---

## 8. 구현 순서 (plan 입력)

1. 단일 task: RTL 클래스 계약 테스트 먼저(RED — tdd-guard pending test 요건 충족) → `VariablesPanel.tsx` className 변경(GREEN) → `pnpm lint && pnpm test && pnpm build` → 커밋(UI-only, cargo 게이트 skip).
2. 라이브 Playwright 실측(R3/R4/R6) — 머지 전 orchestrator 직접 수행(스크린샷 before/after 비교 포함).
