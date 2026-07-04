# 에디터 뷰포트 높이 floor + 변수 리스트 스크롤바 간격 설계

- **날짜**: 2026-07-04
- **상태**: 설계 (spec)
- **출처**: 사용자 피드백 (editor-varpanel-viewport-polish #4 직후). "에디터 높이가 너무 낮음 — 한 화면에 들어오게 해달라고 했는데 이정도면 800x600 해상도도 쓸 수 있는거 아닌가" + "변수 섹션은 스크롤이 생기면 입력에 있는 스크롤과 딱 붙어서 보기 흉함".
- **선행**: editor-varpanel-viewport-polish(#4 뷰포트 캡) 위에 얹는 폴리시 fix. ADR-0044 범위 내 — **ADR 신규 없음**.
- **성격**: **UI-only**. `crates`/proto/migration/`model.ts`/YAML 직렬화/store 무접촉. `EditorShell.tsx`·`VariablesPanel.tsx` CSS 클래스만.

---

## 1. 문제 (실측 근거)

editor-varpanel-viewport-polish #4가 비-wide 에디터 그리드를 `max-h-[calc(100vh-16rem)]`(256px 고정 차감)으로 캡했다. 실측(controller-served dist, `getBoundingClientRect`):

- 그리드 위 크롬(고정) = **243px**(앱 nav 61 + 브레드크럼/시나리오 제목/저장 바 ~140 + 에디터 내부 툴바 42). 대부분 앱/페이지 레이아웃이라 이 슬라이스 밖.
- 그리드는 크롬 아래를 뷰포트 바닥까지 채운다: 900px 화면 → 644px(72%·바닥 13px 여백). **하지만 520px 화면 → 264px(51%)** — 256px 고정 차감이 작은 화면에서 큰 비율을 먹어 편집 영역이 절반만 남는다("800x600" 체감).
- 변수 리스트 `<ul overflow-auto>`는 `padding-right: 0` → 15px 클래식 스크롤바가 행의 값 textarea 우단에 **정확히 flush**(gap=0)로 붙어 보기 흉함.

## 2. 사용자 결정

AskUserQuestion(2026-07-04): 3안 중 **"최소 높이 보장 + 뷰포트 캡"** 선택.
- 작은 화면: 편집 영역 **최소 높이(floor)** 보장 → 페이지가 살짝 스크롤(무한정 길어짐은 여전히 방지).
- 큰 화면: 지금처럼 뷰포트에 캡 → 스크롤 없음(현 동작 유지).

## 3. 요구사항 (R-id)

| ID | 요구사항 | acceptance |
|---|---|---|
| R1 | 비-wide `editor-grid`에 `min-h-[520px]` floor 추가(기존 `max-h-[calc(100vh-16rem)]` 캡·`grid-rows-[minmax(0,1fr)]` 유지). CSS `used = max(min-h, min(max-h, content))`이므로: 큰 화면(뷰포트−256 ≥ 520)+많은 스텝=캡 우세(스크롤 없음, 현 동작)·작은 화면(뷰포트−256 < 520)=floor 우세(≥520px, 페이지 스크롤). **부수효과(의도됨)**: 스텝이 적어 content < 520이면 화면 크기 무관 그리드=520px(기존엔 content-높이라 짧았음 — 이 fix가 '적은 스텝일 때 그리드가 쪼그라드는' 두 번째 too-short 케이스도 해소). | RTL 클래스 계약: 그리드 className에 `min-h-[520px]`·`max-h-[calc(100vh-16rem)]` 둘 다 존재 / 라이브: 작은 화면(예 520px)서 그리드 height ≥ 520·큰 화면(900px)+많은 스텝서 ≤ 뷰포트−256(스크롤 없음) |
| R2 | 스크롤되는 변수 `<ul>`에 우측 gutter를 줘 스크롤바가 행 값 입력과 붙지 않게(`pr-1.5`, 6px). VariablesPanel은 wide/비-wide 공유라 gutter는 양 모드 적용(무해·R4의 *높이 캡*과 무관). | RTL: `<ul>` className에 `pr-1.5` / 라이브: 리스트 스크롤 시 **ul content-box가 6px 좁아짐**(macOS 오버레이 스크롤바는 레이아웃 미점유·자동숨김이라 픽셀 gap 대신 content-box 축소 또는 classic 스크롤바[15px, 불평 발생 env]로 측정) |
| R3 | UI-only·0-diff: `crates`/proto/migration/`model.ts`/YAML/store 무접촉. 기존 #4 클래스(`grid-rows`·열 `overflow-auto min-h-0`·aside `overflow-visible`) 보존. | diff 스코프 grep = `ui/**`·`docs/**`만 / 기존 EditorShell·VariablesPanel 테스트 green |
| R4 | wide 모드는 이 슬라이스 스코프 밖(사용자 불평은 비-wide 기본 뷰) — wide aside/outline 캡 무변경. | wide 관련 클래스 diff 0 |

## 4. 변경 상세

### `components/scenario/EditorShell.tsx` — R1
- 비-wide 그리드 className(`grid gap-4 max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)] ...`)에 `min-h-[520px]` 추가.

### `components/scenario/VariablesPanel.tsx` — R2
- 스크롤 `<ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">`에 `pr-1.5` 추가.

## 5. 검증

- **RTL**: 클래스 계약(그리드 min-h/max-h 공존·ul pr-1.5). jsdom은 레이아웃 미관측이라 여기까지.
- **라이브(controller-served dist, 백엔드 무런)**: [[implementation-rigor-over-spec]] 실측 —
  - R1: 900px 화면 그리드 ≤ 뷰포트−256(스크롤 없음)·520px 화면 그리드 ≥ 520(페이지 스크롤 발생).
  - R2: 변수 리스트 스크롤 상태에서 행 값 입력 우단↔ul 우단 gap > 0(스크롤바 미접).

## 6. 비목표
- 앱/페이지 헤더(243px 중 201px) 축소 — 별 영역, 이 fix 밖.
- wide 모드 높이 — 사용자 불평 대상 아님.
- floor 값 정밀 튜닝 — 520px는 사용자 승인 preview 값, 필요 시 후속 조정.
