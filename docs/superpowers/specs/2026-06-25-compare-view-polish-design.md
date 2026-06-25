# 비교 뷰 폴리시 묶음 (compare-view-polish) — 설계

- **날짜**: 2026-06-25
- **출처**: roadmap §B7 연기 (compare-view-depth 직속 후속) — "CompareMatrix 헤더 색 스와치(열↔오버레이 라인 색 연동) + InsightCompareMatrix 인라인 `#slice(-6)`→`runShortLabel` 수렴(최종 리뷰 지적)"
- **성격**: **UI-only · read-only**. 엔진/proto/migration·`schemas.ts`/`client.ts`/`hooks.ts` **0-diff**. 이미 파싱된 `CompareResult`/`Report`만 소비 → 와이어 byte-identical.
- **범위 ADR**: ADR-0030(Run 비교) 범위 내 additive 폴리시. 새 ADR 불필요.

## 1. 배경·동기

직전 슬라이스(Run 비교 뷰 깊이, 2026-06-25)가 비교 뷰(`ScenarioComparePage`)에 ① per-second 멀티-run **오버레이**(`CompareOverlaySection` + `CompareTimeSeriesChart`), ② verdict 행 baseline-상대 polarity를 추가했다. 오버레이는 각 run을 **위치-인덱스 팔레트**(`overlaySeries.ts`의 `RUN_COLORS` 5색)로 색칠하고, recharts `<Legend>`가 "색 ↔ 짧은 라벨(`runShortLabel`)"을 보여 준다.

그러나 같은 페이지의 **CompareMatrix 헤더 열**은 라벨만 보이고 색이 없어, 사용자가 "오버레이의 파란 라인 = 매트릭스의 어느 열"인지 시각적으로 연결할 단서가 없다. 이 슬라이스는 매트릭스 열 헤더에 **오버레이 라인 색과 동일한 색 스와치**를 달아 그 연결을 닫는다.

부수적으로, 직전 슬라이스 최종 리뷰가 지적한 `InsightCompareMatrix`의 인라인 `` `#${r.run.id.slice(-6)}` ``(이미 존재하는 `runShortLabel` 헬퍼의 복제)를 헬퍼 호출로 **수렴**시킨다(drift 제거).

### 정합성의 근거 (by-construction 색 매칭)

`ScenarioComparePage`에서:
- `reports = results.map(r => r.data)` — `runIds`(URL `runs=` 순서)와 **같은 순서**.
- `compareReports(reports, baseline)` → `result.runIds = reports.map(r => r.run.id)` — **같은 순서**.
- `CompareMatrix`는 `result.runIds`를 인덱스 `i`로 순회.
- `CompareOverlaySection`은 `reports`를 그대로 받아 `overlaySeries(reports, …)`가 `reports.map((r,i) => color: RUN_COLORS[i])`로 색칠.
- `InsightCompareMatrix`는 `reports`를 인덱스 `i`로 순회.

따라서 **CompareMatrix 열 `i` ≡ InsightCompareMatrix 열 `i` ≡ overlay 라인 `i` ≡ 같은 run**. 색을 `runColor(i)` 단일 accessor로 뽑으면 세 표면이 by-construction 일치한다. (정렬·재배열 로직이 없으므로 인덱스 어긋남 경로가 구조적으로 없다.)

## 2. 목표 / 비목표

### 목표
1. 색 팔레트를 매트릭스·오버레이가 **공유하는 단일 소스**로 추출(`runColor(index)`).
2. `CompareMatrix` 헤더 각 열에 `runColor(i)` 색 스와치(장식·a11y 안전).
3. `InsightCompareMatrix` 헤더 각 열에 동형 스와치 + 인라인 라벨을 `runShortLabel`로 수렴.

### 비목표 (이번 슬라이스 아님)
- XLSX/CSV export Δ 조건부 서식(별도 슬라이스 — roadmap 후보 #1).
- per-step 오버레이·active-VU 비교 오버레이·색각 보조 라인 구분(직전 슬라이스 §7 연기 유지).
- 스와치를 인터랙티브로(클릭→라인 토글 등) — YAGNI.
- 오버레이 차트(`CompareTimeSeriesChart`)·`overlaySeries` 색 **로직 변경 없음**(라인 색은 byte-identical 유지, 팔레트의 *위치만* 이동).

## 3. 상세 설계

### 3.1 색 팔레트 단일 소스 추출

현재 `ui/src/compare/overlaySeries.ts`:

```ts
// Stable per-index palette (compare view is capped at 5 runs upstream).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
// …
color: RUN_COLORS[i % RUN_COLORS.length],
```

변경: `RUN_COLORS` 배열과 accessor를 `ui/src/compare/runLabel.ts`로 이동·export.

```ts
// runLabel.ts — run 표시 정체성(라벨 + 색)을 매트릭스 헤더와 오버레이 범례가
// 공유해 두 표면이 절대 어긋나지 않게 하는 단일 소스(기존 R5 라벨 단일소스의 색 확장).
export function runShortLabel(id: string): string {
  return `#${id.slice(-6)}`;
}

// 비교 뷰는 상류에서 5개 run으로 상한 → modulo는 실제로 순환 안 함(방어적).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

export function runColor(index: number): string {
  return RUN_COLORS[index % RUN_COLORS.length];
}
```

`overlaySeries.ts`는 로컬 `RUN_COLORS`를 제거하고 `runColor`를 import해 `color: runColor(i)`로 사용 → **반환 색 byte-identical**.

> **설계 결정**: 별도 `runPalette.ts` 신파일 대신 `runLabel.ts`에 둔다. 둘 다 "run 표시 정체성, 표면들이 공유해 drift 방지"라는 동일 목적이고 `overlaySeries.ts`가 이미 `runShortLabel`을 거기서 import하므로 import 소스가 하나로 모인다. (파일 증식 회피.) 라벨은 id-키, 색은 위치-인덱스-키로 시그니처가 다르지만(색은 본질적으로 위치적) 한 모듈 공존은 무해.

### 3.2 CompareMatrix 헤더 색 스와치

`ui/src/components/compare/CompareMatrix.tsx`의 열 헤더(현재 라벨 + `(base)` 마커가 있는 `<button>`)에서, 라벨 **앞**에 장식 스와치를 추가:

```tsx
{runIds.map((runId, i) => (
  <th key={runId} className="py-2 pr-4 font-medium">
    <button type="button" onClick={() => onBaselineChange(runId)} className="hover:underline text-left inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
        style={{ backgroundColor: runColor(i) }}
      />
      {labels[runId] ?? runId}
      {i === baselineIdx && (
        <span className="ml-1 text-xs text-slate-500 font-normal">(base)</span>
      )}
    </button>
  </th>
))}
```

- 스와치는 `aria-hidden`(장식) → **색 단독 금지** 원칙 충족(의미는 텍스트 라벨이 전달). 버튼 accessible name은 텍스트(라벨)에서만 와서 기존 baseline-전환 클릭 테스트의 `getByRole("button",{name})`가 그대로 통과.
- `ring-1 ring-black/10 dark:ring-white/20` → 라이트·다크 배경 둘 다에서 스와치 경계 가시.
- `inline-flex items-center gap-1.5`로 스와치·라벨·`(base)` 세로 정렬.

### 3.3 InsightCompareMatrix — 라벨 수렴 + 스와치

`ui/src/components/compare/InsightCompareMatrix.tsx`의 헤더(현재 `{labels?.[r.run.id] ?? `#${r.run.id.slice(-6)}`}`):

```tsx
import { runColor, runShortLabel } from "../../compare/runLabel";
// …
{reports.map((r, i) => (
  <th key={r.run.id} className="px-2 py-1 border-b … text-center">
    <span className="inline-flex items-center justify-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
        style={{ backgroundColor: runColor(i) }}
      />
      {labels?.[r.run.id] ?? runShortLabel(r.run.id)}
    </span>
  </th>
))}
```

- 인라인 `` `#${r.run.id.slice(-6)}` `` → `runShortLabel(r.run.id)` (출력 **byte-identical** — 두 식이 같은 문자열을 만든다 → 순수 리팩터, 동작 불변).
- 스와치 마크업은 §3.2와 동형(`runColor(i)`·`aria-hidden`).
- 헤더 셀이 `text-center`라 스와치+라벨을 `justify-center inline-flex`로 묶는다.

### 3.4 ko.ts / schemas.ts

- **ko.ts 0-diff**: 스와치는 텍스트가 없고(장식·`aria-hidden`) 신규 사용자 노출 문구가 없다.
- **schemas.ts 0-diff**: 파싱 모델 무변경(이미 있는 `Report`/`CompareResult`만 소비) → S-D `.nullish()` 갭 무관, 라이브 검증 불필요.

## 4. 불변식 (R)

- **R1** — 색 단일 소스: 매트릭스 스와치·오버레이 라인 둘 다 `runColor(i)` 한 accessor 경유. 별도 색 리터럴/배열 복제 0(`RUN_COLORS`는 `runLabel.ts`에만 존재, grep로 검증).
- **R2** — overlay 색 byte-identical: 팔레트 이동 후 `overlaySeries`가 만드는 `OverlayRun.color`는 종전과 동일(기존 `overlaySeries.test.ts` 무수정 통과).
- **R3** — 색 매칭 by-construction: CompareMatrix/InsightCompareMatrix/overlay 세 표면 모두 `reports`/`runIds`의 **같은 순서**를 인덱스 `i`로 순회 → `runColor(i)`가 같은 run에 같은 색. (재배열 로직 없음.)
- **R4** — a11y: 스와치는 `aria-hidden` 장식. 버튼/헤더의 accessible name은 텍스트 라벨에서만 옴 → 기존 `getByRole(...,{name})` 셀렉터 무영향. 색 단독으로 의미 전달 안 함.
- **R5** — 라벨 수렴 byte-identical: `InsightCompareMatrix`의 `runShortLabel(id)`는 종전 인라인 `` `#${id.slice(-6)}` ``와 동일 문자열 → 동작 불변(순수 drift 제거).
- **R6** — ko.ts·schemas.ts·client.ts·hooks.ts·proto·migration·엔진 **0-diff**. 라이브 검증 불필요(production diff가 비교 뷰 렌더에 한정, run-create/report-parse 무관).
- **R7** — 오버레이 색 로직 무변경: `CompareTimeSeriesChart`·`CompareOverlaySection`은 0-diff(`overlaySeries`만 import 소스 변경).

## 5. 테스트

- **`runLabel.test.ts`(신규)**: `runColor(0..4)`가 기존 팔레트 `["#2563eb","#dc2626","#16a34a","#d97706","#7c3aed"][i]`와 정확히 일치, `runColor(5)===runColor(0)`(modulo 순환·방어적). 이 단위 테스트가 **R2의 무조건적 회귀 가드**(팔레트 값 락인) — 아래 overlaySeries 락인과 이중.
- **`overlaySeries.test.ts`(확장 — 무조건)**: 기존 `overlaySeries.test.ts:36`은 색 *distinctness*(`runs[0].color !== runs[1].color`)만 단언하고 정확한 hex는 안 본다 → 팔레트 이동이 색을 바꿔도 못 잡는다. 그러므로 **무조건** `runs[i].color === runColor(i)` 한 줄을 추가해 byte-identical(R2)을 명시 락인(조건부 아님).
- **`CompareMatrix.test.tsx`**: ① 각 run 열 헤더 버튼 안에 `span[aria-hidden="true"]` 스와치 존재 + `toHaveStyle({ backgroundColor: runColor(i) })` ② 기존 baseline-전환 클릭 테스트(`getByRole("button",{name:/#B/})`, line 102)가 스와치 추가 후에도 통과(R4 — `aria-hidden` 스와치는 accname 무오염).
- **`InsightCompareMatrix.test.tsx`**: ① `labels` 미주입 시 헤더 텍스트 = `runShortLabel(id)`(수렴, R5) ② 각 열 스와치(`span[aria-hidden="true"]`) 존재 + `toHaveStyle({ backgroundColor: runColor(i) })`.
- 전체 게이트: `pnpm lint && pnpm test && pnpm build` green(UI 변경 commit 전 필수).

### 테스트 함정 메모 (ui/CLAUDE.md 기존 항목 적용)
- **테스트 파일을 *먼저* 편집(tdd-guard 순서)**: `ui/CLAUDE.md` 빌드-게이트 함정 — ui-only 슬라이스에서 plan이 src 편집을 test 편집보다 *앞*에 두면 `tdd-guard`가 첫 src 편집(`runLabel.ts`/`CompareMatrix.tsx` 등)을 막는다. **plan은 반드시 각 task에서 test-path 파일(`__tests__/`·`*.test.tsx`)을 먼저 편집해 pending RED diff를 만든 뒤 src를 편집**한다(§6 파일 표의 src-먼저 나열은 논리적 그룹핑일 뿐, plan의 실행 순서가 아님). import 미해결로 RED여도 무방.
- **스와치 색 단언은 `toHaveStyle({ backgroundColor: runColor(i) })`로 (실측 근거 — string-contains 금지)**: 스와치는 텍스트 없는 `aria-hidden`이라 role/text 쿼리 불가 → 헤더 셀(`th`/버튼) 안 자식 `span[aria-hidden="true"]`를 `container.querySelector`로 찾아 단언. **이 repo jsdom 실측(probe)**: inline `style={{backgroundColor:"#2563eb"}}`은 `getAttribute("style")`에서 `"background-color: rgb(37, 99, 235);"`로 직렬화돼 **hex 문자열을 포함하지 않는다** → `getAttribute("style").includes(runColor(i))`(hex contains)는 **항상 실패하니 쓰지 말 것**. 올바른 방법: `toHaveStyle({ backgroundColor: runColor(i) })` — jest-dom이 expected hex를 *같은* CSSOM(cssstyle)으로 `rgb(...)` 정규화해 element의 `rgb(...)`와 like-for-like 비교(probe에서 양쪽 정규화값 동일 = round-trip 일치 확인). 동치 대안: 참조 span에 `ref.style.backgroundColor = runColor(i)` 후 `swatch.style.backgroundColor === ref.style.backgroundColor`. `data-testid`/`title` 추가는 지양(title은 사용자 노출 → ko.ts 필요해짐).

## 6. 파일 변경 목록 (예상)

| 파일 | 변경 |
|---|---|
| `ui/src/compare/runLabel.ts` | `RUN_COLORS` + `runColor(index)` 추가·export |
| `ui/src/compare/overlaySeries.ts` | 로컬 `RUN_COLORS` 제거 → `runColor` import·사용(색 byte-identical) |
| `ui/src/components/compare/CompareMatrix.tsx` | 헤더 버튼에 `runColor(i)` 스와치 |
| `ui/src/components/compare/InsightCompareMatrix.tsx` | 헤더에 스와치 + 인라인 라벨 → `runShortLabel` |
| `ui/src/compare/__tests__/runLabel.test.ts`(또는 overlaySeries 테스트) | `runColor` 단위 |
| `ui/src/components/compare/__tests__/CompareMatrix.test.tsx` | 스와치 단언 |
| `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx` | 수렴 + 스와치 단언 |

ko.ts·schemas.ts·기타 백엔드 **변경 없음**.

## 7. 연기 (이 슬라이스 밖)

- 색각(color-blind) 보조: 라인/스와치에 패턴·dash 구분 추가 — 직전 슬라이스 §7과 동일하게 연기(현재 색 단독 금지는 텍스트 라벨 동반으로 충족).
- 오버레이 범례 ↔ 매트릭스 헤더 hover 상호 하이라이트 — YAGNI.
- XLSX/CSV Δ 조건부 서식(roadmap 후보 #1, 백엔드).
