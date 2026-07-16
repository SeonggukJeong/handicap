# dataset-preview-optin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋 미리보기를 opt-in("데이터 확인" 버튼 뒤 기본 숨김)으로 바꾸고, 페이지 크기 선택(10/25/50/100, 기본 10, localStorage 영속)을 추가하고, sequential 모드에서 행 클릭=시작 행 지정을 지원한다.

**Architecture:** UI-only 3파일 중심 — ① opt-in 게이트는 `TestRunDatasetSection`(에디터) 로컬 state(DatasetsPage는 이미 opt-in이라 무변경), ② 페이지 크기는 공유 `DatasetRowsPreview` 내부 state + 신규 `previewPrefs.ts`(fail-soft localStorage) + `useDatasetRows` limit 파라미터화(서버는 이미 limit 1–200 지원 — 와이어/서버 0-diff), ③ sequential은 기존 `onSelectRow`/`selectedRow` prop 재사용.

**Tech Stack:** React + TS + Tailwind, React Query v5, vitest + RTL. 서버/proto/store/migration 0-diff.

**Spec:** `docs/superpowers/specs/2026-07-16-dataset-preview-optin-design.md` (spec-plan-reviewer clean APPROVE, US1–US3 사용자 승인)

REVIEW-GATE: APPROVED

## Global Constraints

- **워크트리에서 작업**: `cd /Users/sgj/develop/handicap/.claude/worktrees/dataset-preview-optin` (메인 체크아웃 금지).
- **tdd-guard**: `ui/src` non-test 파일 편집 전에 반드시 테스트 파일부터 편집(pending test diff 생성) — 각 Task의 Step 순서가 이를 강제하니 순서를 바꾸지 말 것.
- **모든 사용자 노출 문구는 `ko.ts` 경유** (ADR-0035) — 하드코딩 한국어/영어 금지, `aria-label`도 포함.
- **게이트**: 커밋 전 `pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?` 전부 0 확인. **파이프(`| tail`) 금지** — 종료코드 마스킹.
- **ES2023+ 배열 메서드(`findLast` 등) 금지** — tsconfig lib ES2022라 `pnpm build`에서만 깨진다.
- **`Select`/`Input` 폭 제한은 래퍼 `<div className="w-NN">`으로만** — BASE `block w-full`이 호출부 className을 이긴다(ui/src/components/ui/CLAUDE.md).
- 커밋은 단일 foreground `git commit`(timeout 600000ms), `--no-verify` 금지.

---

### Task 1: 페이지 크기 선택 — previewPrefs + useDatasetRows(limit) + Select + 기존 테스트 마이그레이션 (spec R2, US2)

**Files:**
- Create: `ui/src/components/datasets/previewPrefs.ts`
- Create: `ui/src/components/datasets/__tests__/previewPrefs.test.ts`
- Modify: `ui/src/api/hooks.ts:230-240` (상수 교체 + `useDatasetRows` limit 파라미터) 및 `:51` (`queryKeys.datasetRows`)
- Modify: `ui/src/components/datasets/DatasetRowsPreview.tsx` (pageSize state + 툴바 Select + 보폭)
- Modify: `ui/src/i18n/ko.ts` (`ko.dataset.pageSizeLabel` — `ko.dataset` 블록, `noRows` 근처)
- Test: `ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx` (**기존 ~13개 50-하드코딩 마이그레이션 + T6–T9**)

**Interfaces:**
- Produces: `DATASET_ROWS_PAGE_SIZES = [10, 25, 50, 100] as const`, `DATASET_ROWS_DEFAULT_PAGE_SIZE = 10`, `useDatasetRows(id, offset, limit)` (hooks.ts — 기존 `DATASET_ROWS_PAGE_SIZE`는 삭제), `loadPreviewPageSize(): number` / `savePreviewPageSize(n: number): void` (previewPrefs.ts), localStorage 키 `handicap:dataset:preview-page-size:v1`, `ko.dataset.pageSizeLabel = "표시 행 수"`.
- Consumes: 기존 `api.getDatasetRows(id, offset, limit)`(client.ts — 이미 limit 받음, 무변경), `Select`(`ui/Select.tsx`, `size="sm"`).
- Task 2가 의존: 기본 크기 10(fetch `limit=10`), `DatasetRowsPreview`의 나머지 prop 시그니처 불변.

- [ ] **Step 1: 기존 테스트 마이그레이션 + 신규 테스트 작성 (테스트 파일 먼저 — tdd-guard)**

`ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx`:

1. `beforeEach`에 localStorage 클리어 추가(이중 방어 — setup.ts 글로벌 afterEach와 별개):
```ts
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
```
2. `mockRowsByUrl`의 limit fallback을 기본값에 맞춤(코스메틱): `?? "50"` → `?? "10"`.
3. **50-보폭 단언을 10-보폭으로 기계적 치환** (전략 = 기본 10 기준 재작성, spec 테스트 계획):
   - `rowsRange(1, 50, 1000)` → `rowsRange(1, 10, 1000)` (9곳: 라인 57, 67, 94, 109, 155, 168, 178, 187, 195 — 치환 후 `grep -n "rowsRange(1, 50" 파일`로 잔존 0 확인).
   - "다음 → offset 50 페이지·행 번호 51" 케이스: `rowsRange(51, 100, 1000)` → `rowsRange(11, 20, 1000)`, `getByText("r50")` → `getByText("r10")`, it 이름도 `"다음 → offset 10 페이지·행 번호 11 (R5)"`로.
   - jump 케이스 2곳(라인 112, 171): `rowsRange(743, 792, 1000)` → `rowsRange(743, 752, 1000)` (`r742` 단언은 불변, clamp 5000→`rowsRange(1000, 1000, 1000)` 불변).
   - **경계 disabled 케이스**(라인 83–89): `mockRowsByUrl(30)`/`renderPreview(30)`/`rowsRange(1, 30, 30)` → `mockRowsByUrl(8)`/`renderPreview(8)`/`rowsRange(1, 8, 8)` (크기 10에서 총 8행 = 1페이지 — 같은 both-disabled 경계 유지, 주석도 "총 8행 = 1페이지"로).
   - 응답-offset-에코 케이스(라인 73–81)·columns/title/0행/에러 케이스는 **무변경**.
4. 신규 케이스 4개를 describe 끝에 추가:
```ts
it("T6: 기본 페이지 크기 10 — 첫 fetch limit=10", async () => {
  mockRowsByUrl(1000);
  renderPreview();
  await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
  expect(String(fetchMock.mock.calls[0][0])).toContain("limit=10");
});

it("T7: 크기 25 선택 → limit=25 refetch + localStorage 저장", async () => {
  const user = userEvent.setup();
  mockRowsByUrl(1000);
  renderPreview();
  await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
  await user.selectOptions(screen.getByLabelText(ko.dataset.pageSizeLabel), "25");
  expect(await screen.findByText(ko.dataset.rowsRange(1, 25, 1000))).toBeInTheDocument();
  const urls = fetchMock.mock.calls.map(([u]) => String(u));
  expect(urls.some((u) => u.includes("limit=25"))).toBe(true);
  expect(window.localStorage.getItem("handicap:dataset:preview-page-size:v1")).toBe("25");
});

it("T8: localStorage 저장값 25로 시드된다", async () => {
  window.localStorage.setItem("handicap:dataset:preview-page-size:v1", "25");
  mockRowsByUrl(1000);
  renderPreview();
  expect(await screen.findByText(ko.dataset.rowsRange(1, 25, 1000))).toBeInTheDocument();
});

it("T9: 크기 변경 시 offset 유지 + 이전/다음 보폭 = 현재 크기", async () => {
  const user = userEvent.setup();
  mockRowsByUrl(1000);
  renderPreview();
  await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
  await user.click(screen.getByRole("button", { name: ko.dataset.nextPage })); // offset 10
  await screen.findByText(ko.dataset.rowsRange(11, 20, 1000));
  await user.selectOptions(screen.getByLabelText(ko.dataset.pageSizeLabel), "25");
  // offset 10 유지 + 25행 렌더
  expect(await screen.findByText(ko.dataset.rowsRange(11, 35, 1000))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: ko.dataset.nextPage })); // offset 35
  expect(await screen.findByText(ko.dataset.rowsRange(36, 60, 1000))).toBeInTheDocument();
});
```
5. Select 폭 래퍼 회귀 가드 — 기존 "행 이동 입력은 w-24 래퍼" 케이스에 추가:
```ts
const sizeSelect = screen.getByLabelText(ko.dataset.pageSizeLabel);
expect(sizeSelect.parentElement).toHaveClass("w-20");
expect(sizeSelect).not.toHaveClass("w-20");
```

`ui/src/components/datasets/__tests__/previewPrefs.test.ts` 신규:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadPreviewPageSize, savePreviewPageSize } from "../previewPrefs";

const KEY = "handicap:dataset:preview-page-size:v1";

beforeEach(() => window.localStorage.clear());

describe("previewPrefs (fail-soft — editorPrefs 이디엄)", () => {
  it("미저장이면 기본 10", () => {
    expect(loadPreviewPageSize()).toBe(10);
  });

  it("save→load 왕복", () => {
    savePreviewPageSize(100);
    expect(loadPreviewPageSize()).toBe(100);
  });

  it("비옵션 값(37)·malformed('abc')는 기본 10", () => {
    window.localStorage.setItem(KEY, "37");
    expect(loadPreviewPageSize()).toBe(10);
    window.localStorage.setItem(KEY, "abc");
    expect(loadPreviewPageSize()).toBe(10);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test DatasetRowsPreview; echo exit=$?` 및 `pnpm test previewPrefs; echo exit=$?`
Expected: FAIL — `previewPrefs` 모듈 부재, `pageSizeLabel` 키 부재, 기존 컴포넌트는 여전히 50 보폭이라 `rowsRange(1, 10, 1000)` not found.

- [ ] **Step 3: 구현**

`ui/src/api/hooks.ts` — `:231-238`의 상수·훅 교체:
```ts
/** 미리보기 페이지 크기 옵션 (opt-in 슬라이스 R2 — 서버 limit 1–200 내). */
export const DATASET_ROWS_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DATASET_ROWS_DEFAULT_PAGE_SIZE = 10;

export function useDatasetRows(id: string | undefined, offset: number, limit: number) {
  return useQuery({
    queryKey: id ? queryKeys.datasetRows(id, offset, limit) : ["datasets", "missing", "rows"],
    queryFn: () => api.getDatasetRows(id!, offset, limit),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}
```
`:51`의 queryKeys(limit이 키에 없으면 크기 변경이 stale 캐시를 보여준다):
```ts
datasetRows: (id: string, offset: number, limit: number) =>
  ["datasets", id, "rows", offset, limit] as const,
```

`ui/src/components/datasets/previewPrefs.ts` 신규:
```ts
/** 미리보기 페이지 크기의 localStorage 영속. `scenario/editorPrefs.ts` 이디엄:
 *  localStorage 불가/오염/비옵션 값 → fail-soft(기본값). */
import { DATASET_ROWS_DEFAULT_PAGE_SIZE, DATASET_ROWS_PAGE_SIZES } from "../../api/hooks";

const KEY = "handicap:dataset:preview-page-size:v1";

export function loadPreviewPageSize(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DATASET_ROWS_DEFAULT_PAGE_SIZE;
    const n = Number(raw);
    return (DATASET_ROWS_PAGE_SIZES as readonly number[]).includes(n)
      ? n
      : DATASET_ROWS_DEFAULT_PAGE_SIZE;
  } catch {
    return DATASET_ROWS_DEFAULT_PAGE_SIZE;
  }
}

export function savePreviewPageSize(n: number): void {
  try {
    window.localStorage.setItem(KEY, String(n));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 메모리 상태만으로 동작)
  }
}
```

`ui/src/components/datasets/DatasetRowsPreview.tsx`:
1. import 교체/추가:
```ts
import { DATASET_ROWS_PAGE_SIZES, useDatasetRows } from "../../api/hooks";
import { Select } from "../ui/Select";
import { loadPreviewPageSize, savePreviewPageSize } from "./previewPrefs";
```
2. state·훅 (`:27-29`):
```ts
const [offset, setOffset] = useState(0);
const [pageSize, setPageSize] = useState(loadPreviewPageSize);
const [jumpDraft, setJumpDraft] = useState("");
const { data, error, isLoading, isPlaceholderData } = useDatasetRows(datasetId, offset, pageSize);
```
3. 보폭 3곳 치환(`DATASET_ROWS_PAGE_SIZE` → `pageSize`): `nextDisabled = offset + pageSize >= total || isPlaceholderData`, prev 클릭 `setOffset(Math.max(offset - pageSize, 0))`, next 클릭 `setOffset(offset + pageSize)`.
4. 툴바 — `rowsRange` span 바로 뒤에 크기 select 추가(`ml-auto` form 앞):
```tsx
<div className="flex items-center gap-1">
  <span className="whitespace-nowrap text-slate-600">{ko.dataset.pageSizeLabel}</span>
  <div className="w-20">
    <Select
      size="sm"
      aria-label={ko.dataset.pageSizeLabel}
      value={String(pageSize)}
      onChange={(e) => {
        const n = Number(e.target.value);
        setPageSize(n);
        savePreviewPageSize(n);
      }}
    >
      {DATASET_ROWS_PAGE_SIZES.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  </div>
</div>
```

`ui/src/i18n/ko.ts` — `ko.dataset` 블록(`noRows` 근처)에 추가:
```ts
pageSizeLabel: "표시 행 수",
```

- [ ] **Step 4: 소비처 전수 확인**

Run: `grep -rnw DATASET_ROWS_PAGE_SIZE ui/src; echo exit=$?`
Expected: exit=1 (0매치 — 구 상수 잔존 없음. `-w` 전어 매치라 `DATASET_ROWS_PAGE_SIZES`는 비매치).

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test DatasetRowsPreview; echo exit=$?` / `pnpm test previewPrefs; echo exit=$?`
Expected: PASS (기존 마이그레이션분 + T6–T9 + previewPrefs 3건).

- [ ] **Step 6: 전체 게이트**

Run: `cd ui && pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?`
Expected: 전부 0. (주의: `TestRunSection.dataset.test.tsx`는 rows fetch를 URL 라우팅 스텁으로 받고 single_row 미리보기가 아직 자동 렌더라 limit=10으로 fetch — fixture는 limit 무시하고 40행 반환하므로 기존 케이스 영향 없음. 만약 red가 나면 그 파일의 50 가정을 찾아 10으로 정정.)

- [ ] **Step 7: 커밋**

```bash
git add ui/src/api/hooks.ts ui/src/components/datasets/previewPrefs.ts ui/src/components/datasets/DatasetRowsPreview.tsx ui/src/i18n/ko.ts ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx ui/src/components/datasets/__tests__/previewPrefs.test.ts
git commit -m "feat(ui): 데이터셋 미리보기 페이지 크기 선택 — 10/25/50/100 기본 10, localStorage 영속 (spec R2)"
```
커밋 후 `git log -1`로 landed 확인.

---

### Task 2: 에디터 test-run 미리보기 opt-in + sequential 행 클릭=시작 행 (spec R1·R3, US1·US3)

**Files:**
- Modify: `ui/src/components/scenario/TestRunDatasetSection.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.editor.dsPreviewToggle` — `ko.editor`의 다른 `ds*` 키 옆, `dsIncompleteRow` 근처)
- Test: `ui/src/components/scenario/__tests__/TestRunSection.dataset.test.tsx` (T1–T5 추가 — **기존 10개 케이스는 미리보기 의존 단언이 없어 무수정**, 리뷰어 실증)

**Interfaces:**
- Consumes: Task 1의 기본 크기 10(fetch `limit=10`), `DatasetRowsPreview`의 `onSelectRow`/`selectedRow` prop(기존), `ko.dataset.previewAria(name)`/`selectRowAria(n)`(기존).
- Produces: `ko.editor.dsPreviewToggle = "데이터 확인"`. 신규 컴포넌트 export 없음.

- [ ] **Step 1: 테스트 T1–T5 작성 (테스트 파일 먼저 — tdd-guard)**

`TestRunSection.dataset.test.tsx` — 먼저 기존 `beforeEach`(`:138-142`)에 localStorage 클리어 추가(Task 1 이후 이 파일이 `DatasetRowsPreview`→`loadPreviewPageSize`로 localStorage를 *읽으므로* ui/CLAUDE.md 규약 적용):
```ts
beforeEach(() => {
  fetchMock.mockClear();
  testRunResponse = TRACE_OK;
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
```
이어 describe 끝에 추가(기존 헬퍼 `renderSection`/`openDatasetSection`/`selectDataset`/`lastTestRunBody`/fixture 재사용):

```ts
it("T1: 데이터셋 선택 직후 — 미리보기 부재 + rows fetch 0 + 토글 aria-expanded=false (US1)", async () => {
  const user = userEvent.setup();
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);

  const toggle = screen.getByRole("button", { name: ko.editor.dsPreviewToggle });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
  ).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/rows"))).toBe(false);
});

it("T2: 데이터 확인 클릭 → 렌더 + limit=10 fetch, 재클릭 → 닫힘 (US1)", async () => {
  const user = userEvent.setup();
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);

  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  expect(
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") }),
  ).toBeInTheDocument();
  const rowsCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/rows"));
  expect(String(rowsCalls[0][0])).toContain("limit=10");

  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  expect(
    screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
  ).not.toBeInTheDocument();
});

it("T2b: 모드 전환에도 열림 상태 유지 (R1.3)", async () => {
  const user = userEvent.setup();
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);
  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

  await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

  expect(screen.getByRole("button", { name: ko.editor.dsPreviewToggle })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    screen.getByRole("region", { name: ko.dataset.previewAria("users") }),
  ).toBeInTheDocument();
});

it("T3: 미리보기 연 채 데이터셋 해제→재선택 → 닫힘 리셋 (R1.4)", async () => {
  const user = userEvent.setup();
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);
  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

  await user.selectOptions(screen.getByLabelText(ko.editor.dsPickLabel), "");
  await user.selectOptions(screen.getByLabelText(ko.editor.dsPickLabel), DATASET_ID);

  expect(screen.getByRole("button", { name: ko.editor.dsPreviewToggle })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
  ).not.toBeInTheDocument();
});

it("T4: sequential — 행 클릭 → 시작 행 채움 + payload start_row 0-based (US3)", async () => {
  const user = userEvent.setup();
  testRunResponse = SEQ_OK;
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);
  await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
  await user.click(screen.getByRole("button", { name: ko.dataset.selectRowAria(7) }));

  expect(screen.getByLabelText(ko.editor.dsStartRowLabel)).toHaveValue(7);
  await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));
  const body = lastTestRunBody();
  expect((body.dataset as { start_row: number }).start_row).toBe(6);
});

it("T5: sequential — 시작 행 직접 입력 → 해당 행 하이라이트, 빈 draft면 하이라이트 없음 (R3.3)", async () => {
  const user = userEvent.setup();
  renderSection(YAML_2_STEPS);
  await openDatasetSection(user);
  await selectDataset(user);
  await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));
  await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
  await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

  await user.type(screen.getByLabelText(ko.editor.dsStartRowLabel), "3");
  expect(screen.getByRole("button", { name: ko.dataset.selectRowAria(3) })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await user.clear(screen.getByLabelText(ko.editor.dsStartRowLabel));
  expect(screen.getByRole("button", { name: ko.dataset.selectRowAria(3) })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
```

주의: `ko.dataset`은 이 파일에서 처음 쓰면 import 불필요(`ko` 단일 객체에서 접근). T2의 limit=10 단언은 Task 1이 먼저 머지된 상태를 전제(이 Task는 Task 1 뒤에 실행).

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test TestRunSection.dataset; echo exit=$?`
Expected: FAIL — `dsPreviewToggle` 키 부재(TS 컴파일 에러) 또는 토글 버튼 not found.

- [ ] **Step 3: 구현**

`ui/src/i18n/ko.ts` — `ko.editor`의 `ds*` 키 군(예: `dsIncompleteRow` 근처)에 추가:
```ts
dsPreviewToggle: "데이터 확인",
```

`ui/src/components/scenario/TestRunDatasetSection.tsx`:

1. **부모** `TestRunDatasetSection`에 state 추가(`:44-50`의 state 군):
```ts
const [previewOpen, setPreviewOpen] = useState(false);
```
2. `handleSelectDataset`(`:101-107`)의 리셋 군에 추가:
```ts
setPreviewOpen(false);
```
3. `DatasetBody` 호출부(`:126-144`)에 prop 전달:
```tsx
previewOpen={previewOpen}
onPreviewToggle={() => setPreviewOpen((o) => !o)}
```
4. `DatasetBody` props 인터페이스(`:149-181`)에 추가:
```ts
previewOpen: boolean;
onPreviewToggle: () => void;
```
5. single_row 분기(`:244-275`)에서 기존 `<DatasetRowsPreview …>` 블록(`:266-273`)을 **제거**(행 번호 입력 label은 유지).
6. sequential 블록 뒤·`<MappingEditor …>`(`:314`) **앞**에 공통 opt-in 블록 추가. `Button` import(`import { Button } from "../Button";`) 필요. sequential 하이라이트 파생은 derived `startN`과 동일식(`Math.floor(Number(…)) - 1`):
```tsx
<div className="flex flex-col gap-2">
  <Button
    variant="secondary"
    aria-expanded={previewOpen}
    onClick={onPreviewToggle}
    className="self-start"
  >
    {ko.editor.dsPreviewToggle}
  </Button>
  {previewOpen && (
    <DatasetRowsPreview
      datasetId={selected.id}
      name={selected.name}
      columns={selected.columns}
      rowCount={selected.rowCount}
      selectedRow={mode === "single_row" ? (rowIndex ?? undefined) : seqSelectedRow}
      onSelectRow={
        mode === "single_row"
          ? onRowIndexChange
          : (idx) => onStartRowDraftChange(String(idx + 1))
      }
    />
  )}
</div>
```
7. `DatasetBody` 본문에 `seqSelectedRow` 파생 추가(return 앞):
```ts
const seqStartN = Math.floor(Number(startRowDraft)) - 1;
const seqSelectedRow =
  startRowDraft.trim() !== "" && Number.isFinite(seqStartN) && seqStartN >= 0
    ? seqStartN
    : undefined;
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test TestRunSection.dataset; echo exit=$?`
Expected: PASS — 신규 T1–T5 + 기존 10개(무수정) 전부 green.

- [ ] **Step 5: 전체 게이트**

Run: `cd ui && pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?`
Expected: 전부 0.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/scenario/TestRunDatasetSection.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/TestRunSection.dataset.test.tsx
git commit -m "feat(ui): 에디터 test-run 미리보기 opt-in('데이터 확인') + sequential 행 클릭=시작 행 (spec R1·R3)"
```
커밋 후 `git log -1`로 landed 확인.

---

## 라이브 검증 (Task 2 뒤, 머지 전 — orchestrator가 /live-verify로 수행)

spec의 US 척추 표를 그대로 실행(user-path 필수): vite dev(`localhost` — IPv6 함정) + 워크트리 자체 `./target/debug/controller` + 격리 DB + 행 30+개 데이터셋 업로드 → Playwright로 US1(선택 직후 테이블 부재·`/rows` 요청 0 → 버튼 후 등장), US2(크기 25 → `limit=25` 실측·렌더 행 수 25·재열기 유지), US2'(DatasetsPage 동일), US3(행 7 클릭 → 시작 행 7·aria-pressed) + 페이지 크기 Select 폭(툴바 한 줄 레이아웃) + 콘솔 에러 0.

## 커버리지 맵 (spec ↔ task)

- R1(전항) → Task 2 / R2(전항) → Task 1 / R3(전항) → Task 2 / R4 → Task 1(`pageSizeLabel`)+Task 2(`dsPreviewToggle`) / 테스트 계획 T1–T5 → Task 2, T6–T9+마이그레이션 → Task 1 / 라이브 검증 → 머지 전 단계.
