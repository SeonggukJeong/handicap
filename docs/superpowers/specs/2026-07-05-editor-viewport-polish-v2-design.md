# 에디터 뷰포트 폴리시 v2 설계 (스크롤바·팝오버·1줄입력·크롬 압축·변수 넓게)

- **날짜**: 2026-07-05
- **상태**: 설계 (spec) — **spec-plan-reviewer clean APPROVE (2026-07-05, §6 결정 반영·2라운드)**. 다음 = plan 작성 → plan 리뷰 루프 → REVIEW-GATE 마커 → STOP(fresh 구현).
- **출처**: editor-viewport-height-fix(min-h floor + gutter, master `858f559` 머지) 직후 사용자 라이브 도그푸딩 세션(2026-07-04~05). 컨트롤러-served dist(8095)에서 `getBoundingClientRect`/screenshot 실측하며 5개 마찰을 발견·프리뷰 검증. 프리뷰 코드는 revert됨(이 spec이 단일 소스, fresh 구현).
- **선행**: editor-viewport-height-fix(#4 후속) 위. ADR-0044(에디터 아웃라인) 범위 내 — **신규 ADR 없음 예상**(단 B 변수-넓게 뷰모드가 새 상태기계라 리뷰 시 ADR 여부 재판단).
- **성격**: **UI-only**. `crates`/proto/migration/`model.ts`(Zod)/YAML 직렬화/store wire 무접촉 예상. A(글로벌 CSS)·B/C(레이아웃 상태·className)·D/E(컴포넌트 로직).
- **Figma UI 원칙 참조**(사용자 요청, resource-library/ui-design-principles): **Hierarchy**(1차 표면=편집 그리드에 세로 공간 몰기 → C 크롬 압축·min-h floor), **Proximity/whitespace**(스크롤바 gutter·A 얇은 바), **Progressive disclosure**(C 접기/펴기), **Consistency**(#4 idiom 유지).

---

## 1. 문제·실측 (라이브 근거)

editor-viewport-height-fix 머지 후 사용자가 실사용하며 발견한 5개 마찰. 모두 컨트롤러-served dist(비-wide 에디터, `/scenarios/{id}`)에서 실측:

- **A) 스크롤바가 너무 두껍다** — 이 환경은 classic 15px 스크롤바(항상 표시). 변수 리스트·에디터 열·값 입력 모두 15px 클래식 바라 답답. 얇은 바 요청.
- **E) 1줄 값 입력에도 스크롤바** — 값 입력은 `AutoGrowTextarea`(내용 맞춰 높이 자동). 1줄 값(`value-01-example`)인데도 세로 스크롤바 표시. 원인: height=`scrollHeight`인데 `overflow-y-auto`가 항상 켜져 sub-pixel/border 반올림(scrollH 28 vs clientH 26 = 2px)에 바가 뜬다. **A의 `::-webkit-scrollbar` 스타일링이 overlay(자동숨김)→always-visible로 바꿔 노출**시킴.
- **D) 사용처 팝오버가 tight-space에서 엉뚱한 곳에 뜬다** — `VarUsagePopover`(#3). 작은 창에서 "N개 스텝에서 사용" 클릭 시 팝오버가 앵커에서 떨어져 상단으로 floating. 원인 `computePos`: ① 위로 flip 시 **고정 `POPOVER_MAX_H`(256)** 만큼 빼서(실측 높이 154 무시) 앵커와 detach 갭 발생, ② `top`/`left` 뷰포트 clamp 없음 → off-screen 드리프트.
- **C) 세로 높이가 여전히 낮다 — 크롬(브레드크럼/이름/저장버튼)이 편집창 세로를 먹는다** — 사용자: "편집창이 한눈에 들어오는 게 중요". 실측(900px 창) 그리드 위 크롬 = **243px**:
  | 밴드 | px | 비고 |
  |---|---|---|
  | 앱 네비(Layout header) | 61 | 전역(비-sticky, 스크롤 시 사라짐) |
  | main `py-8` 상단 | 32 | Layout `<main>` 공유 |
  | 브레드크럼 | 20 | ScenarioEditPage |
  | gap-4 | 16 | |
  | 제목+부제("v1·updated") 블록 | 56 | 제목 text-xl + 부제 text-sm 스택 |
  | gap-4 | 16 | |
  | 에디터 툴바(변수/YAML/넓게) | 30 | EditorShell |
  | 툴바→그리드 갭 | 12 | EditorShell gap-3 |
  | **= 그리드 top** | **243** | 그리드=644(cap 100vh-16rem), 바닥 887(13px 여백) |
  사용자 요청: 위 크롬을 **sticky 압축 바 + 접기/펴기 토글**로 → 접으면 편집 그리드가 늘어남.
- **B) 변수 영역이 좁다** — 변수 컬럼 고정 210px. 사용자: "스텝 넓게 보기처럼, **스텝영역이 기본 사이즈로 오른쪽에 붙고 변수가 나머지 영역을 차지**하는 변수-넓게 모드". 기존 `wideOpen`(스텝 넓게 = 아웃라인 1fr)의 **거울상**.

## 2. 요구사항 (R-id)

| ID | 요구사항 | acceptance |
|---|---|---|
| **A1** | 전역 얇은 스크롤바(8px). `ui/src/index.css` `@layer base`에 `scrollbar-width:thin` + `scrollbar-color`(slate-300 thumb/transparent track) + `::-webkit-scrollbar{width/height:8px}`·thumb(slate-300, radius-full, hover slate-400)·track transparent. | 라이브: 리스트/열/값 입력 스크롤바 폭 8px(getComputedStyle `::-webkit-scrollbar` 실측 불가 → 스크린샷 + `scrollbarWidth` 계열). dist CSS에 규칙 존재. |
| **A2** | Monaco YAML 뷰가 자체 스크롤바를 관리하므로, 글로벌 규칙이 Monaco를 깨지 않는지 라이브 확인(필요 시 `.monaco-editor` 예외 또는 스코프 축소). | Monaco YAML 모달 스크롤 정상. |
| **E1** | `AutoGrowTextarea`: 캡(160px=max-h-40) 초과 시에만 스크롤. `height=min(scrollHeight,160)` + `overflowY = scrollHeight>160 ? "auto":"hidden"`. className에서 `overflow-y-auto` 제거(→ `resize-none max-h-40`). | 라이브: 1줄 값 입력 `overflowY==="hidden"`·스크롤바 없음. 긴(>160px) 값은 여전히 스크롤. RTL: jsdom scrollHeight=0이라 로직 no-op(값/onChange 유지) — 실측은 라이브. |
| **D1** | `VarUsagePopover.computePos`를 **export** + `(anchor, popoverH=POPOVER_MAX_H)` 시그니처. 알고리즘: 좌우 clamp(우측 넘치면 우측정렬 후 `[8, innerW-W-8]` clamp), 상하 = 아래 우선 → 아래 넘치고 위가 실측 popoverH만큼 맞으면 위로 flip(`r.top-4-popoverH`) → 둘 다 부족하면 `innerH-popoverH-8`, 최종 `[8, innerH-popoverH-8]` clamp. `useLayoutEffect`에서 `panelRef` 실측 높이(`h||undefined`)로 재계산. | 라이브(작은 창): 팝오버가 앵커에 flush(위 flip 시 바닥=앵커top-4)·4변 모두 뷰포트 내(8px 여백). 단위: `computePos` 순수함수 4케이스(아래맞음/위flip-flush/둘다부족-clamp/좌clamp, mocked rect+window). |
| **C1** | 크롬 압축: 접기 상태 `chromeCollapsed`(ScenarioEditPage) + 접기/펴기 토글 버튼. 펼침=현재 헤더(단 `gap-4→gap-2`), 접힘=브레드크럼·부제 숨김 + 제목·액션(저장 등 클릭 가능)만 남긴 컴팩트 행. | 라이브: 접으면 크롬 top 감소, 펴면 복귀. 액션 버튼 접힘 상태에서도 클릭 가능. |
| **C2** | sticky: 헤더가 스크롤 시 상단 고정(sticky top-0 z-위 bg-page). 앱 네비 비-sticky·문서 스크롤 컨텍스트(Layout `<main>`, min-h-screen) 고려해 sticky 기준·z·bg(투과 방지)·`-mx-6 px-6` 블리드 설계. | 라이브: 아래(test-run 섹션)로 스크롤 시 헤더 상단 고정, 그리드 위로 겹치지 않음(z/bg). |
| **C3** | 그리드 cap이 접힘 상태에 반응(편집창이 reclaimed 세로를 *사용*). `EditorShell`에 optional `chromeCollapsed?:boolean` prop → **3개 리터럴 cap 사이트**(비-wide 그리드 `:104` · wide 변수 aside `:111` · wide **아웃라인/flow 컨테이너** `:117`; wide detail은 캡 없는 Modal `:146-152`이라 대상 아님) cap을 **리터럴 2클래스 토글**: `chromeCollapsed ? "max-h-[calc(100vh-11rem)]" : "max-h-[calc(100vh-16rem)]"`(둘 다 소스 리터럴이라 JIT 생성). 동적 `calc(...${x}...)` 금지(Tailwind JIT 미생성). min-h-[520px] 유지. prop 미전달(ScenarioNewPage 등)=기존 16rem=byte-identical. | RTL: `chromeCollapsed` prop별 cap 클래스 계약. 라이브: 접힘 시 그리드 height 증가(≈+80px)·여전히 뷰포트 내(스크롤 없음). **slice-1 EditorShell.test의 `max-h-[calc(100vh-16rem)]` 단언은 기본(non-collapsed) 유지로 그대로 통과.** |
| **B1** | 변수-넓게 뷰모드(`varsWide` 토글, 에디터 툴바에 "변수 넓게 보기" 버튼 — `wideOpen`/스텝넓게의 거울상). ON: 변수 컬럼 1fr(나머지 폭), 스텝(아웃라인) 기본 사이즈(minmax(260px,300px)) 우측 pin. 상호 배타(varsWide↔wideOpen 동시 불가) 또는 명확한 조합 규칙. detail 열은 wide 모드처럼 처리(모달 or 숨김). | RTL: `varsWide` 시 grid-cols 계약(`[1fr_minmax(260px,300px)]` 류)·토글 aria-pressed. 라이브: 변수 컬럼이 넓어지고 스텝 우측 base. |
| **R-inv** | UI-only 0-diff: `crates`/proto/migration/`model.ts`/YAML/store/wire 무접촉. #4·slice-1 클래스(min-h-520·grid-rows·overflow-auto min-h-0·aside overflow-visible·gutter pr-1.5) 보존. | `git diff --name-only` = `ui/**`·`docs/**`만. slice-1·#4 테스트 green. |

## 3. 검증된 프리뷰 코드 (fresh 구현 참조 — 라이브 실측 통과)

> A/D/E는 이 세션에서 프리뷰로 구현·라이브 검증 완료 후 revert. 아래는 fresh 구현의 출발점(transcription). B/C는 미구현 설계.

### A1 — `ui/src/index.css` (기존 3 `@tailwind` 줄 아래 append)
```css
@layer base {
  * { scrollbar-width: thin; scrollbar-color: rgb(203 213 225) transparent; }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background-color: rgb(203 213 225); border-radius: 9999px; }
  *::-webkit-scrollbar-thumb:hover { background-color: rgb(148 163 184); }
}
```
검증: dist CSS에 규칙 존재, 값 입력/리스트 바 8px thin. **주의(A2)**: `::-webkit-scrollbar` 스타일링은 overlay→always-visible로 만든다(E의 노출 원인) — 라이브에서 Monaco/모달 영향 확인.

### E1 — `ui/src/components/AutoGrowTextarea.tsx` useLayoutEffect
```js
const el = ref.current; if (!el) return;
el.style.height = "auto";
const full = el.scrollHeight;
const MAX = 160; // max-h-40
el.style.height = `${Math.min(full, MAX)}px`;
el.style.overflowY = full > MAX ? "auto" : "hidden"; // 캡 넘칠 때만 스크롤(1줄=바 없음)
```
className: `resize-none max-h-40 ${className ?? ""}`(기존 `overflow-y-auto` 제거). 검증: 1줄 `overflowY:hidden`·바 없음.

### D1 — `ui/src/components/scenario/VarUsagePopover.tsx`
```js
export function computePos(anchor: HTMLElement, popoverH = POPOVER_MAX_H) {
  const r = anchor.getBoundingClientRect();
  const M = 8;
  let left = r.left + POPOVER_WIDTH > window.innerWidth - M ? r.right - POPOVER_WIDTH : r.left;
  left = Math.max(M, Math.min(left, window.innerWidth - POPOVER_WIDTH - M));
  const below = r.bottom + 4;
  const above = r.top - 4 - popoverH;
  let top;
  if (below + popoverH <= window.innerHeight - M) top = below;
  else if (above >= M) top = above;
  else top = window.innerHeight - popoverH - M;
  top = Math.max(M, Math.min(top, window.innerHeight - popoverH - M));
  return { top, left };
}
```
useLayoutEffect: `const h = panelRef.current?.getBoundingClientRect().height; setPos(computePos(anchor, h || undefined));` dep `[anchor]`.
테스트 4케이스(`computePos` export 후 mocked `getBoundingClientRect`+`Object.defineProperty(window,"innerWidth/Height")`): ①below-fits(top=bottom+4) ②flip-above-flush(top=r.top-4-popoverH) ③both-short-clamp(top∈[8,innerH-popoverH-8]) ④left-clamp. 검증: 560px 창·앵커top470→팝오버 top312/bottom466(flush)/height154/on-screen.

### C1–C3, B1 — 설계만 (fresh 구현)
> ⚠️ **아래 C의 "outer `flex flex-col gap-4` div를 sticky로"는 §6 Q2에서 폐기됨.** 구현은 §6 Q2를 따른다 — outer div는 통째 sticky 불가(페이지 전체를 감쌈)이므로 **브레드크럼+제목행만 감싸는 전용 wrapper**를 신설해 그 wrapper만 sticky. `gap-2`는 그 wrapper 내부 갭(outer는 gap-4 유지).
- **C**: ScenarioEditPage 헤더 `<div>`(현 `flex flex-col gap-4`)를 sticky 컨테이너로, `gap-4→gap-2`, `chromeCollapsed` state + 토글, 접힘 시 브레드크럼·`<p>`부제 미렌더. `<EditorShell chromeCollapsed={chromeCollapsed}>`. EditorShell: cap 리터럴 토글(위 C3). sticky 기준은 라이브로 확정(Layout `<main>` 문서 스크롤·네비 비-sticky). **(→ 정확 구조는 §6 Q2.)**
- **B**: EditorShell에 `varsWide` state + 툴바 토글. grid-cols 분기 확장(현 `wideOpen`/`varsOpen` 2축에 varsWide 추가). 상태 조합 규칙(varsWide↔wideOpen 상호배타 권장)·detail 열 처리·slice-1 cap 보존을 plan에서 명세.

## 4. 비목표
- 앱 네비(Layout header 61px) 자체 sticky/축소 — 별 영역(단 C sticky가 네비와 상호작용하면 라이브로 조정).
- main `py-8`(32px) 전역 축소 — 공유 레이아웃이라 이 슬라이스 밖(C는 헤더 내부만).
- 스크롤바 색/폭 정밀 튜닝(8px·slate-300은 1차값).
- 변수 값 다줄 편집 UX 개편(E는 스크롤바 노출만 수정).

## 5. 열린 질문 → §6에서 결정 (2026-07-05 fresh 세션)
아래 5개는 §6에서 결정됨. 경험적 항목(C sticky 정확값·C3 cap·A Monaco)은 *접근+잠정값+라이브 확정+폴백*으로 결정(최종 수치는 구현 라이브 검증에서 확정).
- B `varsWide`↔`wideOpen` 조합/상호배타·detail 열 처리 → §6 Q1.
- C sticky 기준점(네비 아래 vs 뷰포트 top)·z·bg 블리드 → §6 Q2.
- C3 접힘 cap 값(11rem 추정) → §6 Q3.
- A 글로벌 vs 에디터-스코프(Monaco/타 페이지 영향) → §6 Q4.
- 슬라이스 분할(A+E+D / C / B) → §6 Q5.

## 6. 결정 (fresh 세션 resolution — 코드 실측 기반)

라이브 근거·코드 실측(EditorShell.tsx·ScenarioEditPage.tsx·Layout.tsx·FlowOutline.tsx·EditorShell.test.tsx)으로 §5를 해소한다.

### Q1 — B `varsWide` 조합 규칙·레이아웃·detail 열
- **`varsWide` ↔ `wideOpen` 상호배타.** 둘 다 "1fr을 어디에 줄지"의 배타적 선택이라 동시 성립 불가. `wideOpen` 토글 onClick에 `setVarsWide(false)`, `varsWide` 토글 onClick에 `setWideOpen(false)` 추가. 두 토글 모두 전환 시 `setDetailOpen(false)`(R8 ③ 대칭).
- **`varsWide`는 변수 가시성을 함의**: `varsWide` ON이면 변수 aside를 렌더한다 — 넓게 보기의 *대상*이 변수라 숨김이 무의미. 구현은 **`varsOpen` state를 건드리지 않고** aside 렌더 게이트를 `(varsWide || varsOpen)`로(토글 상태 보존 — varsWide OFF 시 사용자의 원래 varsOpen 선택 복귀).
- **dead-control 회피**: 툴바 "변수"(show/hide, EditorShell.tsx:70) 토글은 `varsWide` ON 동안 **`disabled`**(title 힌트 "변수 넓게 보기 중" — aside 게이트가 `(varsWide||varsOpen)`라 클릭해도 무변화 = dead-control이므로 명시적 비활성이 덜 혼란). varsWide는 "변수 넓게 보기" 토글로 끄거나 "스텝 넓게 보기" 전환 시 상호배타(위 첫 bullet)로 꺼진다 — 단 "변수" show/hide 토글로는 못 끈다(그래서 disabled). varsWide OFF 시 "변수" 토글 재활성.
- **레이아웃**: `grid-cols-[1fr_minmax(260px,300px)]` — 변수 1fr(좌), 아웃라인 base(우 pin). 사용자 요구("스텝영역이 기본 사이즈로 오른쪽, 변수가 나머지")와 1:1. `wideOpen`의 거울상(wide=아웃라인 1fr, varsWide=변수 1fr).
- **detail 열 = wide 미러**: 인스펙터 열 미렌더. 아웃라인은 **non-wide FlowOutline + `onActivateStep`**(FlowOutline.tsx:293 — `onActivate`는 `wide`와 독립 발화 확인) → 행 활성화가 기존 `detailOpen` 모달(Inspector 재사용)을 연다. 모달 게이트 `wideOpen && detailOpen && selectedStepId!==null`을 `(wideOpen || varsWide) && detailOpen && …`로 확장. 칩 스트립은 **없음**(varsWide 아웃라인은 base 크기라 개요 칩 불요 — wide는 아웃라인 1fr이라 칩 제공).
- **cap**: varsWide 변수 aside·아웃라인 열도 뷰포트 cap(`max-h-[calc(100vh-16rem)]`, C3의 chromeCollapsed 토글 동일 적용)·`min-h-0`.
- **B는 additive tweak이 아니라 신규 3번째 렌더 분기**(리뷰어 지적): 현 wide/non-wide 분기 어느 것도 varsWide(변수 aside 1fr + base 아웃라인 열 + 인스펙터 모달)와 일치하지 않는다. **byte-identity 제약(수동 불변식)**: grid className을 **선행 `varsWide ? … :` 삼항**으로 구성해 non-varsWide 경로가 현 EditorShell.tsx:104 리터럴로 그대로 fall-through시킨다(안 그러면 `EditorShell.test.tsx:187` "스텝 넓게 OFF 복귀 byte-identical"이 깨진다). varsWide 아웃라인 행에는 **`data-step-id` 부여**(현재 wide-전용 FlowOutline.tsx:302) — 변수 패널 점프의 `jumpToStep` 스크롤(EditorShell.tsx:63)이 동작하도록(미부여면 select만·스크롤 no-op = LOW).
- **ADR**: **신규 ADR 없음** — `varsWide`는 ADR-0044 에디터 아웃라인 뷰의 뷰 토글(양방향 sync 모델·wire 무변경) 범위 내. 아키텍처 결정 아닌 UI 뷰 상태 추가. (리뷰어가 이견이면 재론.)

### Q2 — C sticky 구조·기준점·z·bg
- **전용 sticky chrome wrapper 신설(구조 정정)**: spec §3의 "outer `flex flex-col gap-4` div를 sticky로"는 부정확 — 그 div는 페이지 전체(브레드크럼+제목행+Callout+EditorShell+TestRunSection)를 감싸므로 통째 sticky 불가. **브레드크럼+제목행만** 감싸는 새 `<div>`(sticky)를 도입하고, Callout(에러)·EditorShell·TestRunSection은 wrapper 밖 정상 흐름에 둔다(에러 배너가 스크롤에 붙어다니지 않게).
- **`gap-4→gap-2`는 *새 wrapper 내부* 갭**(리뷰어 지적 — 모호성 확정): C1의 "gap-4→gap-2"는 **신설 sticky wrapper의 내부 갭**(브레드크럼↔제목행 `flex flex-col gap-2`)을 뜻한다. **outer 페이지 div의 `gap-4`는 그대로 유지**(그걸 gap-2로 줄이면 EditorShell↔TestRunSection 간격까지 좁아짐). 즉 outer=`flex flex-col gap-4`(불변), 새 wrapper=`flex flex-col gap-2`(sticky).
- **sticky 기준**: Layout `<main>`은 `overflow` 없음 → 스크롤 컨테이너=문서(viewport). chrome wrapper `sticky top-0`은 viewport 상단 고정. 앱 네비(`<header>`)는 비-sticky라 스크롤 시 사라지고 chrome이 top-0 자리 인수(충돌 없음).
- **z·bg·블리드**: `z-20`(EditorShell 내부 팝오버 `z-50`보다 낮게 — 팝오버가 chrome 위로 유지; grid 콘텐츠보다는 높게) + **불투명 페이지 배경**(그리드 투과 방지 — 정확한 배경 클래스는 실측 확인, 앱 페이지 배경과 일치) + 가로 블리드 `-mx-6 px-6`(main `px-6` 상쇄) + `border-b`(스크롤 시 하단 구분).
- **라이브 확정**: 정확한 top offset·z 레이어·pt/pb·배경 클래스는 라이브(컨트롤러-served dist)에서 확정. **폴백**: top-0가 부족(네비 잔상/py-8 겹침)하면 소폭 `pt` 또는 top offset 조정.

### Q3 — C3 접힘 cap 값
- **접근**: 접힘 컴팩트 행(제목+액션만 ~40–48px)으로 크롬이 줄면 그리드 cap을 늘린다. `chromeCollapsed ? "max-h-[calc(100vh-11rem)]" : "max-h-[calc(100vh-16rem)]"` **리터럴 2클래스 토글**(둘 다 소스 리터럴 → Tailwind JIT 생성; 동적 `calc(...${x}...)` 금지). `min-h-[520px]` 유지. prop 미전달(ScenarioNewPage 등)=16rem=byte-identical.
- **11rem은 잠정**: 펼침 16rem − 절약분(≈5rem≈80px)에서 역산한 추정. **라이브에서 접힘 크롬 높이 실측 후 확정** — 실측이 다르면 리터럴 `N`rem 교체(플랜이 실측→확정 스텝 명시).
- **적용 대상**: EditorShell의 3개 cap 리터럴 사이트 전부(`:104` 비-wide 그리드 · `:111` wide 변수 aside · `:117` wide **아웃라인/flow 컨테이너**; wide detail=캡 없는 Modal이라 제외) + Q1 varsWide 열 — optional `chromeCollapsed?:boolean` prop 하나로 토글.
- **default/persistence**: `chromeCollapsed` 기본 **펼침(false)·비영속**(마운트 수명 — wideOpen/varsWide와 동일 R10 정신). 기본 펼침=16rem이라 `EditorShell.test.tsx:69` 하드단언 유지·byte-identical. (localStorage 영속은 후속 여지 — 이 슬라이스는 단순 유지.)

### Q4 — A 스크롤바 스코프
- **글로벌 우선(@layer base `*`) + 라이브 Monaco 검증 필수.** Monaco는 스크롤바를 **네이티브 `::-webkit-scrollbar`가 아니라 합성(synthetic) overlay `<div>`**로 그리므로 글로벌 규칙이 **아예 적용 안 될 가능성이 높다**(=무해; 리뷰어 지적). 그래도 라이브에서 **YAML 모달 Monaco 스크롤 정상 + 시각 허용** 확인(만일 영향 시 폴백).
- **폴백**: Monaco가 깨지면 `.monaco-editor` 하위 예외로 원복하거나 A 규칙을 에디터 컨테이너 스코프로 축소. **타 페이지(리포트 Recharts·목록 등) 영향도 라이브 스팟체크**(글로벌이라 전역 영향 — 시각 회귀 없음 확인).

### Q5 — 슬라이스 분할·task 순서
- **단일 슬라이스, 3 task 그룹**(SDD — 각 task 독립 green 커밋, 테스트 우선):
  - **Task 1 — A+E+D 소fix**(독립·저위험 quick-win, 먼저 랜딩): A(index.css 글로벌 얇은 바)·E(`AutoGrowTextarea` 캡초과만 스크롤)·D(`VarUsagePopover.computePos` export+실측높이 flip+뷰포트 clamp). A·E 결합 필수(A의 styled 스크롤바가 overlay 환경에서 E의 1줄 바를 새로 노출 — 같은 task).
  - **Task 2 — C sticky 접이식 크롬**: ScenarioEditPage chrome wrapper·`chromeCollapsed` state+토글·`gap-4→gap-2`·EditorShell `chromeCollapsed` prop→cap 토글(C3).
  - **Task 3 — B 변수-넓게 뷰모드**: EditorShell `varsWide` state·툴바 토글·grid-cols 분기·wideOpen 상호배타·detail 모달 확장.
- 순서 근거: A+E+D 독립·저위험 → C(ScenarioEditPage 구조 변경, 중) → B(EditorShell 상태기계 확장, 대).
- **Task 3(B) → Task 2(C3) 하드 의존(재정렬 금지)**: §6 Q1의 varsWide 열 cap이 C3의 `chromeCollapsed` prop을 재사용하므로 B는 C3 뒤에 와야 한다(단순 "둘 다 EditorShell 건드림"이 아니라 prop 의존). Task 1은 완전 독립.

### 테스트 계약 보존 (회귀 가드)
- **EditorShell.test.tsx `#4` 테스트**(grid `max-h-[calc(100vh-16rem)]` 하드단언): C3 기본(non-collapsed)=16rem이라 **그대로 green**. B는 additive(varsWide OFF=기본 클래스 불변)라 "스텝 넓게 OFF 복귀 byte-identical" 테스트도 green.
- **wide 테스트**(변수 aside `max-h-[calc(100vh-16rem)]`): 기본 유지로 green.
- 신규 계약: chromeCollapsed prop별 cap 클래스(C3)·varsWide grid-cols+aria-pressed·상호배타(B)·computePos 4케이스(D)·AutoGrowTextarea overflow(E, jsdom scrollHeight=0 no-op).

### 신규 `ko.ts` 키 (ADR-0035 — 라벨·aria 모두 카탈로그 경유, additive)
기존 `varSearch*`(ko.ts:457-458)는 재사용. B/C가 추가하는 키(제안명 — 최종 문구는 plan/구현에서 확정, `ko.editor` 아래):
- **B varsWide 토글**: `varsWideToggle: "변수 넓게 보기"`, `varsWideToggleAria: "변수 넓게 보기 전환"`(기존 `wideToggle`/`wideToggleAria` 대칭). 툴바 "변수" 토글 disabled title: `varsWideActiveTitle: "변수 넓게 보기 중"`(Q1 dead-control 힌트).
- **C 크롬 접기 토글**: `chromeCollapse: "헤더 접기"` / `chromeExpand: "헤더 펴기"`(또는 단일 aria `chromeToggleAria: "헤더 접기/펴기"` + 글리프). 접힘/펼침에 따라 라벨·aria 스왑.
- 전부 additive(기존 키 무변경)·wire/model 무접촉. RTL 셀렉터(`getByRole("button",{name})`)는 이 키로 lockstep.
