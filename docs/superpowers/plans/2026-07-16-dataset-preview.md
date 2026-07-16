# 데이터셋 미리보기 (§A12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 저장된 데이터셋의 행을 `GET /api/datasets/{id}/rows`(offset/limit 페이징)로 노출하고, DatasetsPage 인라인 확장 행에서 행 번호·행 이동·페이징으로 열람한다.

**Architecture:** 컨트롤러는 기존 `store::datasets::get_rows_range`를 REST 핸들러 하나로 노출(store/engine/proto/migration 0-diff). UI는 Zod 스키마 + client 함수 + `useDatasetRows` 훅(React Query v5 `keepPreviousData`) + 신설 `DatasetRowsPreview` 컴포넌트를 DatasetsPage의 확장 행(`<tr><td colSpan={4}>`)에 배선한다.

**Tech Stack:** axum 0.8 / sqlx SQLite / React + TS + Zod + @tanstack/react-query 5.100 / RTL + vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-dataset-preview-design.md` — R-id는 전부 그 spec §2를 가리킨다.

## Global Constraints

- **한국어 문구(aria-label 포함)는 전부 `ko.dataset.*` 경유** — 컴포넌트에 한글 하드코딩 0 (R11, ADR-0035).
- **응답 Zod는 plain 타입** — rows 응답 전 필드 항상 직렬화(Option 없음)라 `.nullish()`/`.default()` 금지 (R3).
- **byte-identical**: 기존 `GET /api/datasets/{id}`·`POST /api/datasets/preview`·UploadPanel·DataBindingPanel 무변경 (R12).
- **placeholder 일관성**: 행 번호·"N–M" 범위는 **응답의** `offset`/`total`에서 도출, `isPlaceholderData` 동안 이전/다음 disabled (R5·R6, spec §4.4).
- 커밋은 **단일 blocking 호출**(`run_in_background: false`, timeout 600000ms), `git commit … | tail` 파이프 금지, `--no-verify` 금지.
- UI 게이트: `cd ui && pnpm lint && pnpm test && pnpm build` (lint는 `--max-warnings=0`, build의 `tsc -b`가 최종 게이트). 단일 파일 반복은 `pnpm test <name>` (`--` 붙이면 전체 스위트).
- cargo 게이트: pre-commit이 전체 워크스페이스(fmt/build/clippy -D warnings/nextest/doctest)를 돈다 — cargo-영향 커밋은 수 분 소요 정상.
- 리포트 파일(`task-N-report.md` 등)은 `.superpowers/sdd/` 아래에만 — worktree 루트에 쓰지 말고 `git add` 금지.

---

### Task 1: 컨트롤러 rows 엔드포인트 (R1·R2·R3 서버 절반, R12)

**Files:**
- Modify: `crates/controller/tests/datasets_api_test.rs` (테스트 append)
- Modify: `crates/controller/src/api/datasets.rs` (`RowsQuery`/`RowsResponse`/`rows` 핸들러)
- Modify: `crates/controller/src/app.rs` (라우트 1줄, 기존 `/datasets/{id}` 라우트(:85–86) 옆)

**Interfaces:**
- Consumes: `store::datasets::get_rows_range(db, id, start_idx, limit) -> Result<Vec<BTreeMap<String,String>>, sqlx::Error>`(`store/datasets.rs:129`, 기존) / `get_meta`(`:69`) / `ApiError::{BadRequest, NotFound}`.
- Produces: `GET /api/datasets/{id}/rows?offset=N&limit=M` → 200 `{"rows":[{col:val}],"offset":N,"total":T}` · 400(offset<0, limit<1, limit>200, 한국어) · 404(없는 id). Task 2의 UI Zod가 이 shape과 1:1 (seam R3).

- [ ] **Step 1: 실패하는 통합 테스트 작성** — `crates/controller/tests/datasets_api_test.rs` 파일 끝에 append:

```rust
/// 명시 header=true 업로드 (rows 페이징 테스트용 — 자동감지 비의존).
async fn upload_ds_with_header(app: &axum::Router, csv: &str) -> String {
    let (ct, body) = multipart(&[
        ("file", Some("data.csv"), csv.as_bytes()),
        ("header", None, b"true"),
    ]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "upload failed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

async fn get_rows(app: &axum::Router, id: &str, qs: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/datasets/{id}/rows{qs}"))
        .body(Body::empty())
        .unwrap();
    body_json(app.clone().oneshot(req).await.unwrap()).await
}

#[tokio::test]
async fn dataset_rows_default_and_paged() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let id = upload_ds_with_header(&app, "name,val\nr0,0\nr1,1\nr2,2\nr3,3\nr4,4\n").await;

    // 기본값 offset=0/limit=50 → 전체 5행, idx 순서 (R1)
    let (status, v) = get_rows(&app, &id, "").await;
    assert_eq!(status, StatusCode::OK, "{v:?}");
    assert_eq!(v["offset"], 0);
    assert_eq!(v["total"], 5);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0]["name"], "r0");

    // offset=2&limit=2 → r2, r3 (R1)
    let (status, v) = get_rows(&app, &id, "?offset=2&limit=2").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["offset"], 2);
    assert_eq!(v["total"], 5);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["name"], "r2");
    assert_eq!(rows[1]["name"], "r3");

    // offset이 total을 넘으면 빈 rows (에러 아님)
    let (status, v) = get_rows(&app, &id, "?offset=10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 0);
    assert_eq!(v["total"], 5);
}

#[tokio::test]
async fn dataset_rows_param_validation_and_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let id = upload_ds_with_header(&app, "c\nx\n").await;

    // 검증 3종 → 400 (R2; 한국어 메시지는 이 3종만 — 타입 불일치 ?offset=abc는
    // axum Query 추출기의 영어 400이라 단언하지 않는다)
    for qs in ["?offset=-1", "?limit=0", "?limit=201"] {
        let (status, v) = get_rows(&app, &id, qs).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{qs}: {v:?}");
    }
    // 없는 id → 404 (R2)
    let (status, _) = get_rows(&app, "01JNOSUCHDATASET0000000000", "").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --test datasets_api_test dataset_rows`
Expected: 두 테스트 FAIL — 라우트 부재로 모든 `get_rows`가 404를 반환해 첫 status assert에서 실패(페이징 테스트는 `left: 404, right: 200`, 검증 테스트는 `left: 404, right: 400`). 컴파일은 성공(기존 헬퍼만 사용).

- [ ] **Step 3: 핸들러 구현** — `crates/controller/src/api/datasets.rs`. `DeleteQuery`(:39–43) 아래에 타입 2개, `get` 핸들러(:212) 아래에 핸들러 추가(`Query`는 이미 import돼 있음 — `:2`):

```rust
#[derive(Debug, serde::Deserialize)]
pub struct RowsQuery {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RowsResponse {
    pub rows: Vec<BTreeMap<String, String>>,
    pub offset: i64,
    pub total: i64,
}

const ROWS_DEFAULT_LIMIT: i64 = 50;
const ROWS_MAX_LIMIT: i64 = 200;
```

```rust
/// GET /api/datasets/{id}/rows — 저장된 행 페이징 조회 (§A12 미리보기).
pub async fn rows(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RowsQuery>,
) -> Result<Json<RowsResponse>, ApiError> {
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(ROWS_DEFAULT_LIMIT);
    if offset < 0 {
        return Err(ApiError::BadRequest("offset은 0 이상이어야 합니다".into()));
    }
    if !(1..=ROWS_MAX_LIMIT).contains(&limit) {
        return Err(ApiError::BadRequest(format!(
            "limit은 1 이상 {ROWS_MAX_LIMIT} 이하여야 합니다"
        )));
    }
    let meta = store::datasets::get_meta(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = store::datasets::get_rows_range(&state.db, &id, offset, limit).await?;
    Ok(Json(RowsResponse {
        rows,
        offset,
        total: meta.row_count,
    }))
}
```

- [ ] **Step 4: 라우트 배선** — `crates/controller/src/app.rs`의 `/datasets/{id}` 라우트(:85–86) 바로 아래에:

```rust
.route("/datasets/{id}/rows", get(datasets_api::rows))
```

(리터럴 세그먼트라 `{id}` 캡처와 무충돌 — `/runs/{id}/report.csv` 선례. GET이라 body-limit layer 불요.)

- [ ] **Step 5: GREEN 확인**

Run: `cargo test -p handicap-controller --test datasets_api_test`
Expected: 신규 2개 포함 전부 PASS (기존 테스트 회귀 0 — R12).

- [ ] **Step 6: 커밋** (단일 blocking 호출, timeout 600000ms — pre-commit 전체 cargo 게이트가 수 분):

```bash
git add crates/controller/tests/datasets_api_test.rs crates/controller/src/api/datasets.rs crates/controller/src/app.rs
git commit -m "feat(controller): GET /api/datasets/{id}/rows 페이징 엔드포인트 (§A12 미리보기 R1–R3)"
```

---

### Task 2: UI 계약 — Zod 스키마 + client + 훅 (R3 클라 절반, R13)

**Files:**
- Create: `ui/src/api/__tests__/datasetRows.test.ts`
- Modify: `ui/src/api/schemas.ts` (`DatasetPreviewSchema`(:476–482) 아래)
- Modify: `ui/src/api/client.ts` (import + `getDataset`(:236) 옆)
- Modify: `ui/src/api/hooks.ts` (queryKeys + `useDataset`(:215) 아래 + react-query import)

**Interfaces:**
- Consumes: Task 1의 `GET /api/datasets/{id}/rows` 응답 shape `{rows, offset, total}`.
- Produces: `DatasetRowsSchema`/`type DatasetRows`(schemas.ts) · `api.getDatasetRows(id: string, offset: number, limit: number): Promise<DatasetRows>` · `useDatasetRows(id: string | undefined, offset: number)` · `export const DATASET_ROWS_PAGE_SIZE = 50`(hooks.ts). Task 3이 이 넷을 그대로 import.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/api/__tests__/datasetRows.test.ts` 신규 (자체 fetch mock — 기존 `datasets.test.ts` 큐 스타일과 간섭 없게 별 파일):

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../client";
import { DatasetRowsSchema } from "../schemas";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getDatasetRows / DatasetRowsSchema", () => {
  it("GET /datasets/{id}/rows?offset=&limit= 로 요청하고 응답을 파싱한다 (R3)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "r2", val: "2" }], offset: 2, total: 5 }),
    );
    const r = await api.getDatasetRows("01J", 2, 50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe("/api/datasets/01J/rows?offset=2&limit=50");
    expect(r.total).toBe(5);
    expect(r.offset).toBe(2);
    expect(r.rows[0]).toEqual({ name: "r2", val: "2" });
  });

  it("스키마는 plain 필드 — 누락 필드는 거부한다 (R3)", () => {
    expect(DatasetRowsSchema.safeParse({ rows: [], offset: 0, total: 0 }).success).toBe(true);
    expect(DatasetRowsSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(DatasetRowsSchema.safeParse({ rows: [{ a: 1 }], offset: 0, total: 1 }).success).toBe(
      false, // 셀 값은 string
    );
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test datasetRows`
Expected: FAIL — `DatasetRowsSchema`/`getDatasetRows` 미존재 (import 해석 실패).

- [ ] **Step 3: 스키마 추가** — `ui/src/api/schemas.ts`의 `DatasetPreviewSchema` 블록(:476–482) 아래:

```ts
// rows 페이징 응답 (GET /datasets/{id}/rows) — 전 필드 항상 직렬화라 plain 타입 (.nullish()/.default() 불요)
export const DatasetRowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())),
  offset: z.number().int(),
  total: z.number().int(),
});
export type DatasetRows = z.infer<typeof DatasetRowsSchema>;
```

- [ ] **Step 4: client 함수 추가** — `ui/src/api/client.ts` import 블록에 `DatasetRowsSchema` 추가 후, `getDataset`(:236–237) 아래:

```ts
getDatasetRows: (id: string, offset: number, limit: number) =>
  request(
    `/datasets/${encodeURIComponent(id)}/rows?offset=${offset}&limit=${limit}`,
    { method: "GET" },
    DatasetRowsSchema,
  ),
```

- [ ] **Step 5: 훅 추가** — `ui/src/api/hooks.ts`:
  - react-query import 줄(:1)에 `keepPreviousData` 추가: `import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";`
  - `queryKeys`에 `dataset` 옆: `datasetRows: (id: string, offset: number) => ["datasets", id, "rows", offset] as const,`
  - `useDataset`(:215) 아래:

```ts
/** 미리보기 페이지 크기 (spec R5 — 50 고정). */
export const DATASET_ROWS_PAGE_SIZE = 50;

export function useDatasetRows(id: string | undefined, offset: number) {
  return useQuery({
    queryKey: id ? queryKeys.datasetRows(id, offset) : ["datasets", "missing", "rows"],
    queryFn: () => api.getDatasetRows(id!, offset, DATASET_ROWS_PAGE_SIZE),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}
```

("펼쳐진 동안만 fetch"(R13)는 훅이 아니라 mount-게이팅 — Task 3에서 패널이 접히면 컴포넌트 unmount. 훅에 별도 enabled 플래그를 배관하지 않는다. `keepPreviousData`는 이 repo 첫 사용 — v5.100.14가 export, 선례 없음이 정상.)

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test datasetRows`
Expected: PASS (2 tests).

- [ ] **Step 7: 전체 UI 게이트 + 커밋** (단일 blocking):

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/api/__tests__/datasetRows.test.ts ui/src/api/schemas.ts ui/src/api/client.ts ui/src/api/hooks.ts
git commit -m "feat(ui): DatasetRowsSchema + getDatasetRows + useDatasetRows 훅 (§A12 R3·R13)"
```

---

### Task 3: DatasetRowsPreview 컴포넌트 + DatasetsPage 배선 + ko (R4–R11, R13)

**Files:**
- Create: `ui/src/components/datasets/DatasetRowsPreview.tsx`
- Create: `ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx`
- Modify: `ui/src/pages/DatasetsPage.tsx` (확장 행 배선)
- Modify: `ui/src/pages/__tests__/DatasetsPage.test.tsx` (펼침/접힘/단일확장/R13 테스트 append)
- Modify: `ui/src/i18n/ko.ts` (`ko.dataset` 키 추가, :1104 블록)

**Interfaces:**
- Consumes: Task 2의 `useDatasetRows(id, offset)`·`DATASET_ROWS_PAGE_SIZE`(hooks.ts) / `Button`(`../Button`, variant `"secondary"`) / `Input`(`../ui/Input`, `size="sm"`) / `Callout`(`../ui/Callout`) / `ko.dataset.*`.
- Produces: `DatasetRowsPreview({ datasetId, name, columns, rowCount })` — DatasetsPage 전용, 외부 재사용 계약 없음.

- [ ] **Step 1: 실패하는 컴포넌트 테스트 작성** — `ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx` 신규. **반드시 이 테스트 파일을 Task 3의 첫 편집으로** — tdd-guard는 pending test 파일이 없으면 `ko.ts` 포함 `ui/src` 편집을 차단한다(테스트 경로 편집은 항상 허용, ui/CLAUDE.md):

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatasetRowsPreview } from "../DatasetRowsPreview";
import { ko } from "../../../i18n/ko";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** offset/limit 쿼리를 읽어 total행짜리 데이터셋을 시뮬레이트. 셀 = r{전역idx}. */
function mockRowsByUrl(total: number) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://localhost");
    const offset = Number(u.searchParams.get("offset") ?? "0");
    const limit = Number(u.searchParams.get("limit") ?? "50");
    const n = Math.max(Math.min(total - offset, limit), 0);
    const rows = Array.from({ length: n }, (_, i) => ({
      name: `r${offset + i}`,
      val: String(offset + i),
    }));
    return Promise.resolve(jsonResponse({ rows, offset, total }));
  });
}
function renderPreview(rowCount = 1000, columns: string[] = ["name", "val"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetRowsPreview datasetId="01J" name="users" columns={columns} rowCount={rowCount} />
    </QueryClientProvider>,
  );
}
const panel = () => screen.getByRole("region", { name: ko.dataset.previewAria("users") });

describe("DatasetRowsPreview", () => {
  it("첫 페이지: 범위 표기·행 번호 1부터 (R5·R6)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(1, 50, 1000))).toBeInTheDocument();
    const cells = within(panel()).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("1"); // # 열
    expect(within(panel()).getByText("r0")).toBeInTheDocument();
  });

  it("다음 → offset 50 페이지·행 번호 51 (R5)", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage }));
    expect(await screen.findByText(ko.dataset.rowsRange(51, 100, 1000))).toBeInTheDocument();
    expect(within(panel()).getByText("r50")).toBeInTheDocument();
  });

  it("행 번호는 로컬 state가 아니라 응답 offset 기준 (R6)", async () => {
    // 컴포넌트는 offset 0을 요청했지만 응답이 offset 50을 에코 → 번호는 51부터
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "rX", val: "9" }], offset: 50, total: 1000 }),
    );
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(51, 51, 1000))).toBeInTheDocument();
    expect(within(panel()).getAllByRole("cell")[0]).toHaveTextContent("51");
  });

  it("경계 disabled: offset 0에서 이전, 마지막 페이지에서 다음 (R5)", async () => {
    mockRowsByUrl(30); // 총 30행 = 1페이지
    renderPreview(30);
    await screen.findByText(ko.dataset.rowsRange(1, 30, 30));
    expect(screen.getByRole("button", { name: ko.dataset.prevPage })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.dataset.nextPage })).toBeDisabled();
  });

  it("페이지 전환 중(placeholder) 이전/다음 둘 다 disabled (R5)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
    // 2번째 페이지 요청은 영영 pending
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage }));
    expect(screen.getByRole("button", { name: ko.dataset.nextPage })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.dataset.prevPage })).toBeDisabled();
    // placeholder 동안 이전 페이지 내용 유지 (R13 keepPreviousData)
    expect(within(panel()).getByText("r0")).toBeInTheDocument();
  });

  it("행 이동: 743 → 743행부터, 범위 밖은 clamp (R7)", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "743");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    expect(await screen.findByText(ko.dataset.rowsRange(743, 792, 1000))).toBeInTheDocument();
    expect(within(panel()).getByText("r742")).toBeInTheDocument();
    // clamp: 5000 → 마지막 행(1000)
    await user.clear(screen.getByLabelText(ko.dataset.jumpLabel));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "5000");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    expect(await screen.findByText(ko.dataset.rowsRange(1000, 1000, 1000))).toBeInTheDocument();
  });

  it("컬럼 순서는 columns prop(메타) 순서 — 행 객체 키 순서 아님 (R8)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ a: "1", b: "2" }], offset: 0, total: 1 }),
    );
    renderPreview(1, ["b", "a"]); // 메타 순서 b,a (알파벳 역순)
    await screen.findByText(ko.dataset.rowsRange(1, 1, 1));
    const headers = within(panel()).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([ko.dataset.rowNumHeader, "b", "a"]);
  });

  it("셀에 title 툴팁 (R9)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "LONGVALUE", val: "v" }], offset: 0, total: 1 }),
    );
    renderPreview(1);
    await screen.findByText(ko.dataset.rowsRange(1, 1, 1));
    expect(within(panel()).getByText("LONGVALUE")).toHaveAttribute("title", "LONGVALUE");
  });

  it("0행이면 빈 상태 (R10)", async () => {
    mockRowsByUrl(0);
    renderPreview(0);
    expect(await screen.findByText(ko.dataset.noRows)).toBeInTheDocument();
  });

  it("에러면 Callout (R10)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    renderPreview();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
```

(주의: `Callout variant="error"`가 `role="alert"`를 렌더하는지 확인 — DatasetsPage 기존 사용(`role="alert"` 명시 prop)을 따라 `<Callout variant="error" role="alert">`로 전달.)

- [ ] **Step 2: ko 키 추가** — `ui/src/i18n/ko.ts`의 `dataset:` 블록(:1104) `delimiterTab` 뒤에 (Step 1의 pending test가 있어 src 편집 허용됨):

```ts
    previewToggle: "미리보기",
    previewAria: (name: string) => `${name} 행 미리보기`,
    prevPage: "이전",
    nextPage: "다음",
    rowsRange: (from: number, to: number, total: number) => `${from}–${to} / 총 ${total}행`,
    rowNumHeader: "#",
    jumpLabel: "행 이동",
    jumpGo: "이동",
    noRows: "행이 없습니다",
```

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test DatasetRowsPreview`
Expected: FAIL — `DatasetRowsPreview` 미존재.

- [ ] **Step 4: 컴포넌트 구현** — `ui/src/components/datasets/DatasetRowsPreview.tsx` 신규:

```tsx
import { useState } from "react";
import { DATASET_ROWS_PAGE_SIZE, useDatasetRows } from "../../api/hooks";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { Callout } from "../ui/Callout";
import { ko } from "../../i18n/ko";

interface Props {
  datasetId: string;
  name: string;
  columns: string[];
  rowCount: number;
}

/** 저장된 데이터셋 행 미리보기 — DatasetsPage 확장 행 안에서 렌더 (spec §4.4). */
export function DatasetRowsPreview({ datasetId, name, columns, rowCount }: Props) {
  const [offset, setOffset] = useState(0);
  const [jumpDraft, setJumpDraft] = useState("");
  const { data, error, isLoading, isPlaceholderData } = useDatasetRows(datasetId, offset);

  // placeholder 일관성(R5·R6): 번호·범위는 응답 기준, total은 응답 ?? 목록 메타
  const total = data?.total ?? rowCount;
  const respOffset = data?.offset ?? offset;
  const rows = data?.rows ?? [];

  const prevDisabled = offset === 0 || isPlaceholderData;
  const nextDisabled = offset + DATASET_ROWS_PAGE_SIZE >= total || isPlaceholderData;

  function jump() {
    const n = Number(jumpDraft);
    if (!jumpDraft.trim() || !Number.isFinite(n)) return;
    setOffset(Math.min(Math.max(Math.floor(n) - 1, 0), Math.max(total - 1, 0)));
  }

  return (
    <section
      aria-label={ko.dataset.previewAria(name)}
      className="my-2 rounded border border-slate-200 bg-slate-50 p-3"
    >
      {isLoading && (
        <p className="text-slate-500" role="status">
          {ko.common.loading}
        </p>
      )}
      {error && (
        <Callout variant="error" role="alert">
          {ko.common.failedToLoad((error as Error).message)}
        </Callout>
      )}
      {data && total === 0 && <p className="text-slate-500">{ko.dataset.noRows}</p>}
      {data && total > 0 && (
        <>
          <div className="mb-2 flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {ko.dataset.rowsRange(respOffset + 1, respOffset + rows.length, total)}
            </span>
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                jump();
              }}
            >
              <label className="text-slate-600" htmlFor={`jump-${datasetId}`}>
                {ko.dataset.jumpLabel}
              </label>
              <Input
                id={`jump-${datasetId}`}
                type="number"
                min={1}
                size="sm"
                numeric
                className="w-24"
                value={jumpDraft}
                onChange={(e) => setJumpDraft(e.target.value)}
              />
              <Button type="submit" variant="secondary">
                {ko.dataset.jumpGo}
              </Button>
            </form>
            <Button
              variant="secondary"
              disabled={prevDisabled}
              onClick={() => setOffset(Math.max(offset - DATASET_ROWS_PAGE_SIZE, 0))}
            >
              {ko.dataset.prevPage}
            </Button>
            <Button
              variant="secondary"
              disabled={nextDisabled}
              onClick={() => setOffset(offset + DATASET_ROWS_PAGE_SIZE)}
            >
              {ko.dataset.nextPage}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full border border-slate-200 text-sm">
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th className="border-b border-slate-200 px-2 py-1 font-medium text-slate-500">
                    {ko.dataset.rowNumHeader}
                  </th>
                  {columns.map((c) => (
                    <th key={c} className="border-b border-slate-200 px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={respOffset + i} className="border-b border-slate-100">
                    <td className="px-2 py-1 tabular-nums text-slate-400">{respOffset + i + 1}</td>
                    {columns.map((c) => (
                      <td key={c} className="max-w-xs truncate px-2 py-1" title={row[c] ?? ""}>
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: 컴포넌트 GREEN 확인**

Run: `cd ui && pnpm test DatasetRowsPreview`
Expected: PASS (10 tests).

- [ ] **Step 6: 실패하는 페이지 테스트 작성** — `ui/src/pages/__tests__/DatasetsPage.test.tsx`에 append (기존 `jsonResponse`/`renderPage` 헬퍼 재사용; **확장 시 페이지에 테이블이 2개**가 되므로 패널 단언은 `within(region)` 스코프):

```tsx
const twoDatasets = {
  datasets: [
    { id: "01A", name: "users", columns: ["email"], row_count: 2, byte_size: 10, created_at: 1 },
    { id: "01B", name: "items", columns: ["sku"], row_count: 1, byte_size: 5, created_at: 2 },
  ],
};
function routeFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/rows")) {
      const which = url.includes("01A") ? "users" : "items";
      const rows =
        which === "users" ? [{ email: "a@ex.com" }, { email: "b@ex.com" }] : [{ sku: "S1" }];
      return Promise.resolve(jsonResponse({ rows, offset: 0, total: rows.length }));
    }
    return Promise.resolve(jsonResponse(twoDatasets));
  });
}

describe("DatasetsPage 미리보기 확장 (R4·R13)", () => {
  it("접힌 상태에선 rows fetch 없음, 펼치면 패널 렌더 (R4·R13)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("/rows"))).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    const region = await screen.findByRole("region", {
      name: ko.dataset.previewAria("users"),
    });
    expect(await within(region).findByText("a@ex.com")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0],
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("다른 행을 펼치면 이전 패널이 접힌다 — 단일 확장 (R4)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    const user = userEvent.setup();
    const toggles = () => screen.getAllByRole("button", { name: ko.dataset.previewToggle });
    await user.click(toggles()[0]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(toggles()[1]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("items") });
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
  });

  it("같은 토글을 다시 누르면 접힌다 (R4)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
  });
});
```

(`within` import를 파일 상단 `@testing-library/react` import에 추가.)

- [ ] **Step 7: RED 확인**

Run: `cd ui && pnpm test DatasetsPage`
Expected: 신규 3개 FAIL — 미리보기 버튼 부재. 기존 테스트는 PASS 유지.

- [ ] **Step 8: DatasetsPage 배선** — `ui/src/pages/DatasetsPage.tsx`:
  - import 추가: `import { Fragment, useState } from "react";`(기존 `useState` 대체), `import { DatasetRowsPreview } from "../components/datasets/DatasetRowsPreview";`
  - 컴포넌트에 state 추가: `const [expandedId, setExpandedId] = useState<string | null>(null);`
  - tbody 매핑을 Fragment로 감싸 확장 행 추가 — 기존 `<tr key={d.id}>`(:67–80) 를:

```tsx
{data.datasets.map((d) => (
  <Fragment key={d.id}>
    <tr className="border-b border-slate-100">
      <td className="py-2 pr-4 font-medium">{d.name}</td>
      <td className="py-2 pr-4 text-slate-600">{d.columns.join(", ")}</td>
      <td className="py-2 pr-4">{d.row_count}</td>
      <td className="py-2 pr-4">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            aria-expanded={expandedId === d.id}
            onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
          >
            {ko.dataset.previewToggle}
          </Button>
          <Button
            variant="danger"
            onClick={() => handleDelete(d.id)}
            disabled={del.isPending}
          >
            {ko.common.delete}
          </Button>
        </div>
      </td>
    </tr>
    {expandedId === d.id && (
      <tr>
        <td colSpan={4} className="p-0">
          <DatasetRowsPreview
            datasetId={d.id}
            name={d.name}
            columns={d.columns}
            rowCount={d.row_count}
          />
        </td>
      </tr>
    )}
  </Fragment>
))}
```

(확장 행은 `expandedId` 변경 시 조건부 렌더 위치가 바뀌며 `DatasetRowsPreview`가 unmount/remount → offset 자연 리셋 = R4. 패널이 접히면 훅도 사라져 fetch 0 = R13.)

- [ ] **Step 9: GREEN 확인**

Run: `cd ui && pnpm test DatasetsPage`
Expected: 기존 + 신규 전부 PASS.

- [ ] **Step 10: 하드코딩 스윕 + 전체 UI 게이트**

Run: `grep -n '"[^"]*[가-힣]' ui/src/components/datasets/DatasetRowsPreview.tsx` → **0건** (전부 ko 경유, R11).
Run: `git diff ui/src/pages/DatasetsPage.tsx | grep '^+' | grep '[가-힣]'` → **0건** (신규 추가 줄에 한글 리터럴 없음 — 기존 window.confirm 문구는 pre-existing이라 대상 아님).

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS (lint 경고 0, `tsc -b` 클린).

- [ ] **Step 11: 커밋** (단일 blocking):

```bash
git add ui/src/components/datasets/DatasetRowsPreview.tsx ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx ui/src/pages/DatasetsPage.tsx ui/src/pages/__tests__/DatasetsPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 데이터셋 미리보기 인라인 확장 행 — 행 번호·행 이동·페이징 (§A12 R4–R11)"
```

---

## 최종 단계 (orchestrator — task 아님)

1. **최종 리뷰**: `handicap-reviewer` APPROVE (R3 seam 와이어 1:1 대조 포함). finish-slice §0 보안 게이트 grep — `api/datasets.rs` 편집이 업로드파싱 경로에 매치하면 `security-reviewer`도 (grep이 지배, 예측 스킵 금지).
2. **라이브 검증** (spec §6): `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 워크트리 상대경로 `./target/debug/controller --db /tmp/dataset-preview.db --ui-dir ui/dist`(먼저 `just ui-build`) — ① CSV 업로드 후 `curl "http://127.0.0.1:8080/api/datasets/{id}/rows?offset=2&limit=2"` 응답이 UI Zod와 1:1(R3) ② 브라우저에서 펼침→페이징→행 이동 743→truncate/가로 스크롤 실측(R9 — jsdom 불가) ③ 400/404 curl.
3. **finish**: `/finish-slice` — build-log·roadmap-status(§A12 도그푸딩 3호 완료)·CLAUDE 상태줄·메모리 → ff-merge(마스터가 graceful-ramp-down-cap 머지로 전진했으므로 `merge-base --is-ancestor` 실패 시 문서화된 rebase 경로) → ExitWorktree.
