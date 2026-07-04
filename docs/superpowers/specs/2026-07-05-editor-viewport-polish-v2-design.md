# 에디터 뷰포트 폴리시 v2 설계 (스크롤바·팝오버·1줄입력·크롬 압축·변수 넓게)

- **날짜**: 2026-07-05
- **상태**: 설계 (spec) — **아직 spec-plan-reviewer 미검토**. 구현 세션(fresh)에서 start-slice §4 검토 루프를 먼저 돌릴 것.
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
| **C3** | 그리드 cap이 접힘 상태에 반응(편집창이 reclaimed 세로를 *사용*). `EditorShell`에 optional `chromeCollapsed?:boolean` prop → 비-wide 그리드(및 wide aside/detail) cap을 **리터럴 2클래스 토글**: `chromeCollapsed ? "max-h-[calc(100vh-11rem)]" : "max-h-[calc(100vh-16rem)]"`(둘 다 소스 리터럴이라 JIT 생성). 동적 `calc(...${x}...)` 금지(Tailwind JIT 미생성). min-h-[520px] 유지. prop 미전달(ScenarioNewPage 등)=기존 16rem=byte-identical. | RTL: `chromeCollapsed` prop별 cap 클래스 계약. 라이브: 접힘 시 그리드 height 증가(≈+80px)·여전히 뷰포트 내(스크롤 없음). **slice-1 EditorShell.test의 `max-h-[calc(100vh-16rem)]` 단언은 기본(non-collapsed) 유지로 그대로 통과.** |
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
- **C**: ScenarioEditPage 헤더 `<div>`(현 `flex flex-col gap-4`)를 sticky 컨테이너로, `gap-4→gap-2`, `chromeCollapsed` state + 토글, 접힘 시 브레드크럼·`<p>`부제 미렌더. `<EditorShell chromeCollapsed={chromeCollapsed}>`. EditorShell: cap 리터럴 토글(위 C3). sticky 기준은 라이브로 확정(Layout `<main>` 문서 스크롤·네비 비-sticky).
- **B**: EditorShell에 `varsWide` state + 툴바 토글. grid-cols 분기 확장(현 `wideOpen`/`varsOpen` 2축에 varsWide 추가). 상태 조합 규칙(varsWide↔wideOpen 상호배타 권장)·detail 열 처리·slice-1 cap 보존을 plan에서 명세.

## 4. 비목표
- 앱 네비(Layout header 61px) 자체 sticky/축소 — 별 영역(단 C sticky가 네비와 상호작용하면 라이브로 조정).
- main `py-8`(32px) 전역 축소 — 공유 레이아웃이라 이 슬라이스 밖(C는 헤더 내부만).
- 스크롤바 색/폭 정밀 튜닝(8px·slate-300은 1차값).
- 변수 값 다줄 편집 UX 개편(E는 스크롤바 노출만 수정).

## 5. 열린 질문 (fresh 리뷰/구현에서 결정)
- B `varsWide`와 `wideOpen`의 조합/상호배타 규칙, detail 열(모달?) 처리.
- C sticky의 정확한 기준점(네비 아래 vs 뷰포트 top)·z-index·bg 블리드.
- C3 접힘 cap 값(11rem은 추정 — 접힘 크롬 실측 후 확정).
- A 글로벌 vs 에디터-스코프(Monaco/타 페이지 영향 시 스코프 축소).
- 슬라이스 분할: A+E+D(작은 fix, 1 task) / C(sticky 접이식) / B(뷰모드) — plan에서 task 경계.
