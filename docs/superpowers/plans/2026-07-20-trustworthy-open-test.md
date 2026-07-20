# 속지 않는 오픈 시험 (A11) 1차 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료 리포트에 시험 **유효성(`validity`)** · **내러티브(`narrative`)** 를 붙여, completed/SLO 초록과 분리된 soft 신호로 거짓 초록을 드러내고 Go/No-Go 출발 문장을 준다 (US1–4).

**Architecture:** A4c와 동일 — `build_report` on-demand 순수 파생. 신규 `crates/controller/src/validity.rs`에 `derive_validity` + `derive_narrative`. 엔진·워커·proto·migration 0-diff. soft-only (run status / verdict 식 / 스케줄 0-diff). UI는 헤더 `ValidityBadge` + `ReportHeadline` 연동 + `ReportView` 상단 Banner/Narrative + Verdict→Insight 순서.

**Tech Stack:** Rust (serde, controller report/export) · TypeScript/React · Zod · vitest/RTL · ko.ts

설계 문서: `docs/superpowers/specs/2026-07-20-trustworthy-open-test-design.md` (**spec-plan-reviewer clean APPROVE**, 2026-07-20)

## Global Constraints

- **US 스파인 (매 brief 첨부):**
  - US1: 헤더+리포트 상단에서 유효성을 completed/SLO와 분리 배지·사유로 본다.
  - US2: transport(`status` 0) 다수 run을 완료 초록·고RPS·HTTP 오류 부재로 오해하지 않는다 (errors는 오를 수 있음 — 승격 신호가 핵심).
  - US3: Status assert·활성 criteria 없으면 “검증 없는 측정” 경고.
  - US4: 사건 요약 + 말할 수 있는/없는 것.
- **soft-only:** run `status` 전이 · `evaluate_criteria`/verdict 부착 조건 · 스케줄 발사 **0-diff**.
- **engine / worker / proto / migration 0-diff.**
- **신규 Insight kind 없음** — validity reasons 분리.
- **와이어:** `ReportJson.validity` / `narrative` always-emit objects; `#[serde(default)]` for old JSON. UI Zod `.optional()` + 부재 시 **숨김** (fake ok 금지).
- **criteria 술어 단일:** `has_active_criteria = profile.criteria.as_ref().is_some_and(|c| c.has_any())` — **verdict is Some 과 동일시 금지**.
- **assert 정본:** `HttpStep.assert` 의 `Assertion::Status(_)` only (`scenario.rs`).
- **`collect_unconditional`:** `insights.rs` private → Task 1에서 `pub(crate)`로 공유(행동 0-diff). 복제 walk 금지.
- **XLSX:** Summary 시트 하단 additive 3행 (level 문자열 · reason kinds 문자열 · events count 숫자). insights CSV OUT.
- **tdd-guard:** 각 task 첫 스텝 = 테스트 파일. UI production 편집 task는 pending test 필수.
- **게이트:** cargo 영향 시 full cargo gate; UI 시 `pnpm lint && pnpm test && pnpm build` (파이프 마스킹 금지).
- **커밋:** `| tail`/`--no-verify` 금지. task당 green 커밋.
- **라이브:** Task 5 — R11 3경로 (US 표).

## 파일 구조

| 파일 | 조치 |
|---|---|
| `crates/controller/src/validity.rs` | **신규** — types + derive_validity + derive_narrative |
| `crates/controller/src/lib.rs` | `pub mod validity;` only (not main.rs) |
| `crates/controller/src/insights.rs` | `collect_unconditional` → `pub(crate)` |
| `crates/controller/src/report.rs` | `ReportJson` 필드 + `build_report` 호출 |
| `crates/controller/src/export.rs` | Summary 3행 |
| `ui/src/api/schemas.ts` | Validity/Narrative Zod + ReportSchema |
| `ui/src/components/ValidityBadge.tsx` | **신규** |
| `ui/src/components/report/ValidityBanner.tsx` | **신규** |
| `ui/src/components/report/NarrativeBlock.tsx` | **신규** |
| `ui/src/components/report/ReportHeadline.tsx` | validity 연동 |
| `ui/src/components/report/ReportView.tsx` | 배치 + 순서 |
| `ui/src/pages/RunDetailPage.tsx` | 헤더 배지 |
| `ui/src/i18n/ko.ts` | 라벨·사유·can/cannot 문구 |
| 각 `__tests__` | 단위/RTL |

## ⚠ 구현 전 필독

**H0. transport는 errors를 올린다.** `transport_heavy` 조건에 `errors==0`을 넣지 말 것.

**H1. `silent_http_errors` 분자는 4xx+5xx 합** (`http_response_total` 분모의 class count). 5xx-only로 좁히지 말 것. **테스트는 4xx-only + 5xx-only 둘 다.**

**H2. Summary XLSX는 현재 f64 전용 루프** (`export.rs` ~447). 문자열 행은 **별도 write_string** — 숫자 배열에 문자열을 넣지 말 것. 테스트는 rows 7–8을 `Data::String`, row 9를 number로 단언.

**H3. `ReportSchema.strict()`** — `validity`/`narrative` 키 미등록 시 전 리포트 파싱 실패.

**H4. Headline props** — `validity?: Validity` optional; 없으면 기존 동작(구 리포트).

**H5. tdd-guard + `lib.rs`:** `#[cfg(test)]` in `validity.rs`는 **그 파일만** 언블록한다. `lib.rs`에 `pub mod validity;`를 넣으려면 **그 전에** untracked `crates/controller/tests/validity_mod_keepalive.rs`(빈 `#[test] fn keepalive() {}` 또는 실제 통합 테스트)가 작업트리에 있어야 한다. 커밋 전 keepalive를 실 테스트로 접거나 유지.

**H6. `collect_unconditional`는 id만 수집.** Status assert 판정은 (권장) `pub(crate) fn http_step_has_status_assert(steps, id) -> bool` 같은 **동일 tree-walk 규칙** 헬퍼로 — loop `repeat==0` 스킵·if 제외·parallel 포함을 insights와 공유. id 목록만 보고 top-level `steps`만 훑지 말 것. 대안: `collect_unconditional_http -> Vec<&HttpStep>`로 승격 후 insights가 id map (행동 0-diff).

**H7. narrative events:** insights 슬라이스는 이미 `order_rank` 정렬됨 — **재구현 금지**, 앞에서부터 순회. `VerdictBadge` 색은 **비범위**(Spec 수용 — emerald 합격 유지, ValidityBadge로 대비).

**H8. emit 조건:** `build_report`가 호출되는 **모든** 경로에 always-emit (terminal 게이트 신설 금지). UI만 terminal일 때 report fetch.

---

### Task 1: `validity.rs` 코어 + insights 공유

**Files:**
- Create: `crates/controller/src/validity.rs` (types + derive + `#[cfg(test)]`)
- Create first (tdd-guard): `crates/controller/tests/validity_mod_keepalive.rs` — empty keepalive or thin smoke (H5)
- Modify: `crates/controller/src/insights.rs` — `pub(crate) fn collect_unconditional` + assert helper per H6
- Modify: **`crates/controller/src/lib.rs` only** — `pub mod validity;` (not main.rs)

**Produces:**

```rust
pub struct Validity { pub level: String, pub reasons: Vec<ValidityReason> }
pub struct ValidityReason { /* kind, severity, pct, count, ... Option fields */ }
pub struct Narrative { pub events: Vec<String>, pub can_claim: Vec<String>, pub cannot_claim: Vec<String> }

impl Default for Validity { /* level ok, reasons [] */ }
impl Default for Narrative { /* empty vecs */ }

pub fn derive_validity(
    summary: &ReportSummary,
    status_distribution: &BTreeMap<String, u64>,
    scenario_yaml: &str,
    has_active_criteria: bool,
    insights: &[Insight],
) -> Validity;

pub fn derive_narrative(
    validity: &Validity,
    summary: &ReportSummary,
    has_active_criteria: bool,
    insights: &[Insight],
) -> Narrative;
```

- [ ] **Step 0 (tdd-guard):** create `crates/controller/tests/validity_mod_keepalive.rs` **before** any `lib.rs` edit.

- [ ] **Step 1: 실패 테스트** (`validity.rs` `#[cfg(test)]` table-driven):
  - zero_requests → suspect + reason
  - transport pct 0.8 → severity critical → level suspect
  - transport emit at pct=0.05 and at n0=50 with low pct (boundary)
  - silent **4xx-only** errors=0 → silent_http_errors
  - silent **5xx-only** errors=0 → silent_http_errors (R5)
  - no assert + !has_active_criteria + unconditional http>0 → no_response_validation
  - has `Assertion::Status` → no no_response
  - has_active_criteria true → no no_response even if no assert
  - unconditional http 0 → no no_response (vacuous)
  - nested loop body http without assert still detected (H6 walk)
  - load_gen_saturated insight → load_not_delivered
  - **events (R7 §5.1):** max 5; validity codes first; insight codes next from **pre-sorted** slice; dedup; multiple no_request_step → one event; status_class → `insight:status_class:5xx|4xx`
  - **can/cannot goldens:** count=0; transport; unchecked 200; clean slo_pass
  - throughput_measured only when `summary.count > 0`
  - **production_identity cap-replace:** when cannot_claim already has 5 codes before always-step, final[4]==`production_identity`

- [ ] **Step 2: 구현** — spec §4–§5. H6 assert walk. level: any critical→suspect else nonempty→limited else ok. narrative: iterate insights as given (already sorted).

- [ ] **Step 3:** `cargo test -p handicap-controller` (validity modules + keepalive) green

- [ ] **Step 4: Commit** `feat(controller): derive validity and narrative for trustworthy reports`

---

### Task 2: `build_report` + export 배선

**Files:**
- `crates/controller/src/report.rs` — `ReportJson` fields + assemble site ~902–928
- `crates/controller/src/export.rs` — Summary rows + **`report_with_steps` helper ~579** (compile fix)
- existing report/export tests

- [ ] **Step 1: 테스트** — build_report (or helper) attaches validity/narrative for transport / unchecked / clean. XLSX: row7–8 `Data::String`, row9 count. Grep `ReportJson {` only two sites updated.

- [ ] **Step 2:**  
  `#[serde(default)] pub validity: Validity`  
  `#[serde(default)] pub narrative: Narrative`  
  (Default: ok/empty — **deserialization only**; production always recompute).  
  After insights in `build_report` (any status — **no new terminal gate**):  
  `let has_active = run.profile.criteria.as_ref().is_some_and(|c| c.has_any());`  
  `validity = derive_validity(...)`; `narrative = derive_narrative(...)`.

- [ ] **Step 3:** XLSX Summary rows 0–6 unchanged numbers; then write_string/write_number for validity_level, validity_reason_kinds, narrative_events_count.

- [ ] **Step 4:** `cargo test -p handicap-controller` green

- [ ] **Step 5: Commit** `feat(controller): attach validity/narrative on build_report and XLSX summary`

---

### Task 3: Zod 와이어 + ko 카탈로그

**Files:**
- `ui/src/api/schemas.ts`
- `ui/src/api/__tests__/schemas.test.ts` (or report schema tests)
- `ui/src/i18n/ko.ts`

**ko 키 정본 (구현이 이 이름을 그대로 사용):**

| 키 | 용도 | 초안 문구 |
|---|---|---|
| `ko.validity.level.ok` | 배지 | 해석 가능 |
| `ko.validity.level.limited` | 배지 | 제한적 해석 |
| `ko.validity.level.suspect` | 배지 | 해석 주의 |
| `ko.validity.reason.zero_requests` | 사유 | 요청이 한 건도 기록되지 않았습니다 |
| `ko.validity.reason.transport_heavy` | 사유 (pct/count 치환) | 전송 실패(연결 단계)가 전체의 {pct}% ({count}건)입니다 — 대상 서버 한계로 읽지 마세요 |
| `ko.validity.reason.silent_http_errors` | 사유 | HTTP 오류 상태코드가 있으나 엔진 에러 수는 0입니다(응답 검증 부재 가능) |
| `ko.validity.reason.no_response_validation` | 사유 | 응답 검증(status assert)과 SLO 기준이 없어 성공·실패를 확정할 수 없습니다 |
| `ko.validity.reason.load_not_delivered` | 사유 | 목표한 부하를 다 걸지 못했습니다(도착 실패/드롭) |
| `ko.validity.bannerAria` / `title` | 섹션 | 시험 유효성 |
| `ko.narrative.sectionAria` / `title` | 섹션 | 결과 해석 |
| `ko.narrative.eventsHeading` | 소제 | 한눈에 |
| `ko.narrative.canHeading` | 소제 | 말할 수 있는 것 |
| `ko.narrative.cannotHeading` | 소제 | 말할 수 없는 것 |
| `ko.narrative.can.<code>` / `cannot.<code>` | 코드 맵 | (구현 시 production_identity·sut_capacity 등 §5.2 전 코드 채움) |
| `ko.narrative.event.<code>` | events 코드 | validity:/insight: 접두 맵 또는 헬퍼 |
| `ko.report.headlineSloPassLimited` | Headline | SLO 수치는 통과 · 시험 해석은 제한적 |
| `ko.report.headlineSloPassSuspect` | Headline | SLO 수치는 통과 · 시험 해석 주의 |

- [ ] **Step 1: 테스트** — ReportSchema parses with validity/narrative; without (optional); rejects bad severity; strict rejects unknown keys. omit-or-object only (null not expected).

- [ ] **Step 2:** schemas as below; `count: z.number().int().nonnegative().optional()` preferred.

```ts
export const ValidityReasonSchema = z.object({
  kind: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  pct: z.number().optional(),
  count: z.number().int().nonnegative().optional(),
  step_id: z.string().optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
});
export const ValiditySchema = z.object({
  level: z.enum(["ok", "limited", "suspect"]),
  reasons: z.array(ValidityReasonSchema),
});
export const NarrativeSchema = z.object({
  events: z.array(z.string()),
  can_claim: z.array(z.string()),
  cannot_claim: z.array(z.string()),
});
// ReportSchema.strict:
validity: ValiditySchema.optional(),
narrative: NarrativeSchema.optional(),
```

- [ ] **Step 3:** `ko.ts`에 위 키 전부 추가 (ADR-0035). can/cannot 코드 전수.

- [ ] **Step 4:** `pnpm lint && pnpm test && pnpm build` (no pipe mask)

- [ ] **Step 5: Commit** `feat(ui): validity/narrative Zod wire and ko copy`

---

### Task 4: UI 표면 (Badge · Banner · Narrative · Headline · ReportView · RunDetail)

**Files:**
- Create: ValidityBadge, ValidityBanner, NarrativeBlock + `__tests__`
- Modify: ReportHeadline, ReportView, RunDetailPage

- [ ] **Step 1: 실패 RTL 먼저** (tdd-guard — production 편집 전 테스트 파일):
  - ValidityBadge: each level text from `ko.validity.level.*`
  - ValidityBanner: reasons rendered
  - NarrativeBlock: three headings + mapped can/cannot
  - **Headline 이빨:** `verdict.passed && validity.level==="suspect"` → pass node **`not.toHaveClass("text-emerald-700")`** **and** text includes `ko.report.headlineSloPassSuspect` (둘 다 — 한쪽만이면 vacuous)
  - **DOM 순서 이빨:** single container; assert Banner region `compareDocumentPosition` Narrative → Verdict → Insight (document order). **고의 회귀:** 순서 뒤집고 RED → 원복 GREEN 실증을 brief 검증 의무에 포함
  - missing validity/narrative → badge/banner/narrative **absent** (fake ok 금지)
  - **VerdictBadge 비수정** (색 유지 — scope)

- [ ] **Step 2: 구현** per Step 1 + Spec §5.3

- [ ] **Step 3:** `pnpm lint && pnpm test && pnpm build`

- [ ] **Step 4: Commit** `feat(ui): report validity badge, banner, narrative, headline coupling`

---

### Task 5: soft/0-diff 검증 + 라이브

**Files:** none for product (verify only)

- [ ] **Step 1: R6 soft-only + R10 0-diff** (orchestrator 직접, self-report 불신):
  ```bash
  git diff $(git merge-base master HEAD)..HEAD --name-only
  ```
  Allowlist only: `crates/controller/src/{validity.rs,insights.rs,report.rs,export.rs,lib.rs}` · `crates/controller/tests/**` · `ui/src/**` · `docs/**` · plan/spec paths.  
  **Must not appear:** `crates/engine/**`, `crates/worker/**`, `crates/proto/**`, `crates/worker-core/**`, `**/migrations/**`, schedule runner status transition files beyond report/export.  
  Grep dirty tree: no changes to `evaluate_criteria` body / schedule `spawn_run` success criteria / run status enum transitions for validity.

- [ ] **Step 2:** 워크트리 `./target/debug` controller+worker, 격리 DB, responder

- [ ] **Step 3: US 표 (R11)**

| US | 절차 | 통과 신호 |
|---|---|---|
| US2 | URL → 죽은 포트 run | level suspect/limited · `transport_heavy` · 헤더 ValidityBadge |
| US3 | assert [] · !criteria · 200 | limited · `no_response_validation` · cannot `functional_correctness` |
| US1/US4 | 리포트 UI | Banner+Narrative · Headline 비-emerald when limited/suspect+SLO pass |
| clean | assert+SLO | level ok · `production_identity` · Zod 0 |

- [ ] **Step 4:** 콘솔 Zod 0

- [ ] **Step 5:** live-only → 커밋 불필요; 회귀 픽스 있으면 최소 커밋

---

## 완료 정의

- R1–R11: T1–T5 스텝으로 검증 가능 (R6/R10 = Task 5 Step 1)
- US1–4 관찰 가능
- soft + engine/worker/proto/migration 0-diff
- plan clean APPROVE 후 하단 `REVIEW-GATE: APPROVED` → **`/clear` 후** 구현 세션 (같은 세션 구현 비권장)

---

## 참고 fixture YAML 스케치

```yaml
# unchecked (no assert)
version: 1
name: unchecked
steps:
  - id: "01HXTEST000000000000000001"
    name: ping
    type: http
    request: { method: GET, url: "http://127.0.0.1:PORT/" }
    assert: []
```

```yaml
# clean
# same with assert: [{ status: 200 }]
```

Transport: same with url to closed port.

---

REVIEW-GATE: APPROVED

(spec-plan-reviewer clean APPROVE on plan 2026-07-20; prior APPROVE-WITH-FIXES must-fix 1–8 landed. Implementation: `/clear` then subagent-driven-development against this plan + US spine.)
