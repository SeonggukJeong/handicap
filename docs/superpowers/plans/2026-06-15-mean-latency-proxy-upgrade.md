# mean 지연 프록시 전면 일관 업그레이드 Implementation Plan

> **이 문서는 plan 템플릿(`_TEMPLATE.md`)의 dogfood다.** R-id 커버리지 표 + task별 인라인 acceptance가 크로스커팅 슬라이스에서 동작하는지 검증용. 아직 `spec-plan-reviewer` 미통과 초안 — 일부 UI 앵커는 구현 시점 grep 확정 필요로 표기.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** post-run·create-time 두 사이징 경로의 지연 프록시를 p50→mean으로 동시 교체하되 parity를 보존하고, `ReportSummary.mean_ms`를 UI까지 배선한다.
**Architecture:** `overall` HDR 히스토그램(`report.rs`에 이미 존재)의 `mean()`을 `ReportSummary.mean_ms`로 노출 → post-run `insights.rs`와 create-time `sizing.ts` 앵커가 그 값을 같은 프록시로 사용. 새 계산은 `overall.mean()` 한 번뿐, 나머지는 p50→mean 교체.
**Tech Stack:** Rust(`report.rs`/`insights.rs`, hdrhistogram), TypeScript/React(`schemas.ts`/`SlotSizingHelper.tsx`/`WorkerSizingHelper.tsx`/`sizing.ts`).
**Spec:** `docs/superpowers/specs/2026-06-15-mean-latency-proxy-upgrade-design.md`

---

## Requirement Coverage (R-id → Task) ⟵ 커버리지 게이트

> spec §2의 R1–R6 전부가 ≥1 task에 매핑됨(미매핑 0). R1·R3은 한 와이어 계약의 양쪽 → 같은 Task 1에 묶어 함께 머지.

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | `ReportSummary.mean_ms` 직렬화(`(overall.mean()/1_000).round()` u64, µs→ms) | Task 1 (계약-먼저) | ✅ wire |
| R3 | UI Zod `ReportSummary`가 `mean_ms` 수용 | Task 1 (계약-먼저) | ✅ wire |
| R2 | post-run `insights.rs` `required` 프록시 p50→mean | Task 2 | |
| R5 | create-time ≡ post-run 프록시 (둘 다 mean, parity) | Task 2 (+ Task 3 앵커) | |
| R6 | mean 판별 불가(==0) 폴백 = 기존 p50==0 동형 | Task 2 | |
| R4 | create-time 슬롯 앵커(`SlotSizingHelper.tsx:22`) `p50_ms`→`mean_ms` | Task 3 | |

- **계약-먼저**: R1+R3(Task 1)이 머지돼 `mean_ms`가 와이어에 흐른 뒤에야 R2/R4가 그 값을 소비할 수 있다. Task 1 → 2 → 3 순서 강제.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/report.rs` | 리포트 집계·`ReportSummary` | `mean_ms: u64` 필드(`:54` 구조체) + 빌드(`:596`) `(overall.mean() / 1_000.0).round() as u64` (HDR는 µs 저장 → `/1_000`로 ms; reviewer #1) |
| `crates/controller/src/insights.rs` | `load_gen_saturated` 사이징 | `:229` 프록시 `p50_ms`→`mean_ms` + `:228` 0-가드 주석 mean 기준 |
| `ui/src/api/schemas.ts` | 리포트 Zod | `ReportSummarySchema`(`:327`, p50_ms `:333` 인접)에 `mean_ms: z.number().int().nonnegative()` |
| `ui/src/components/SlotSizingHelper.tsx` | create-time 슬롯 사이징 앵커 | `:22` `summary.p50_ms`→`summary.mean_ms` |
| `ui/src/components/sizing.ts` | `recommendSlots` 순수계산 | 시그니처·본문 **불변**(프록시는 호출자) — 주석 `:50-51`만 mean으로 |

**Ripple 사이트(reviewer #2/#3 — 컴파일러가 *전부*는 못 잡음)**: `ReportSummary`에 비-optional `mean_ms` 추가 시:
- **컴파일러-caught (4)**: `report.rs:596`(프로덕션) + `report.rs:999`·`insights.rs:318`(테스트 헬퍼) + `export.rs:414`(픽스처). `cargo build --workspace --tests` "missing field".
- **런타임-caught (1)**: `testdata/compare_golden.json` summary 객체 2개 — `export.rs` `golden_summary_deltas_match`가 역직렬화하므로 누락 시 **serde 런타임 패닉**(컴파일 OK). `pnpm`/cargo 테스트 실행으로만 발견.
- **UI 픽스처 (~6)**: `ReportSummarySchema`가 `.strict()`라 full-report fixture 테스트(`reportLatency`·`ReportHeadline`·`ReportView`·`Summary`·`RunDetailPage`·`ScenarioComparePage`)에 `mean_ms` 추가 — `pnpm test`가 잡음(`tsc` 아님).
- 테스트 사이트는 `mean_ms: 0` 등 결정론 상수. **WorkerSizingHelper는 무관**(peakThroughput/count 기반 — dogfood G2).

**무변경(명시)**: `p50_ms`/`p95_ms`/`p99_ms`·CSV/XLSX 열·비교 export·proto·migration·워커·엔진 부하생성·VuSizingHelper. `mean_ms`는 순수 가산(spec §5).
**TDD 가드 메모**: `report.rs`/`insights.rs`는 인라인 `#[cfg(test)] mod tests` 디스크 보유 → tdd-guard 자동통과. UI는 `schemas.test.ts`/`*Helper.test.tsx` 먼저 RED. keepalive 불요.
**커밋 경계 메모**: 각 Task = 하나의 green 커밋(전체 게이트 때문에 dead-code/RED 단독 불가). Task 1은 Rust+UI 동시(와이어 양쪽)라 한 커밋에 backend serde + Zod.

---

## Task 1: `ReportSummary.mean_ms` 노출 + UI Zod 수용 (계약-먼저)

**충족 R:** R1, R3 (한 와이어 계약의 양쪽 — 함께 머지)
**Files:**
- Modify: `crates/controller/src/report.rs` — 구조체 `:54` + 빌드 `:596` (+ ripple 4사이트)
- Modify: `ui/src/api/schemas.ts` — `ReportSummarySchema` `:327` (+ 골든 fixture·UI fixture ripple)

- [ ] **Step 1: `report.rs` 테스트 먼저 (RED)** — summary 단위테스트에 `mean_ms` 기대값 단언 추가(알려진 µs 분포 → ms 기대값).
  **Acceptance (R1):** 알려진 분포에서 `summary.mean_ms`가 `(overall.mean()/1_000).round()`(µs→ms)와 일치.

- [ ] **Step 2: `report.rs` 프로덕션** — `ReportSummary`(`:49`)에 `pub mean_ms: u64`(p50_ms 인접), 빌드부(`:590`)에 `mean_ms: overall.mean().round() as u64`(무조건 호출; `overall` 빈 히스토그램이면 `.mean()`==0.0 → 0 → R6 폴백). **그다음 ripple 4사이트**(`report.rs:999`·`insights.rs:318`·`export.rs:414` struct 리터럴)에 `mean_ms`를 `cargo build --workspace --tests` "missing field"가 0될 때까지 추가(테스트는 결정론 상수).

- [ ] **Step 3: `schemas.ts` Zod** — `ReportSummary`에 `mean_ms: z.number().int().nonnegative()`(p50_ms 인접). `schemas.test.ts`에 mean_ms 포함 fixture 파싱 통과 단언.
  **Acceptance (R3):** 서버 shape(`mean_ms` 포함)이 `ReportSummarySchema.parse` 통과. (라이브 최종 확인은 머지절.)

- [ ] **Step 4: 검증** — `cargo build -p handicap-worker && cargo nextest run -p handicap-controller`(> `/tmp/mean-t1.log`), `cd ui && pnpm test`. 둘 green.

- [ ] **Step 5: 커밋** — `git add crates/controller/src/report.rs ui/src/api/schemas.ts ui/src/**/schemas.test.ts`(명시 경로), 파이프 없는 단일 커밋, `git log -1` 확인.

---

## Task 2: 사이징 프록시 p50→mean + parity + 폴백 (post-run)

**충족 R:** R2, R5(parity), R6(폴백)
**Files:**
- Modify: `crates/controller/src/insights.rs` — `:229` 프록시 + 테스트 `s.p50_ms =` 사이트들

- [ ] **Step 1: 테스트 이식 (RED→GREEN 단일 fold)** — 프록시를 mean으로 바꾸면 `summary()` 헬퍼 기본 `mean_ms: 0`(`:323`)이라 `s.p50_ms` 설정 테스트는 전부 `l_sec==0`→`cause None`으로 무너진다. **`s.p50_ms =`를 `s.mean_ms =`로 바꿔야 하는 정확한 7사이트(reviewer #4)**: `insights.rs:918, 946, 970, 1000, 1027, 1075, 1100`. (`:914`/`:966`/`:995`는 `#[test] fn` 헤더이지 설정 라인이 아님 — 헷갈리지 말 것.)
  **Acceptance (R2):** mean=50ms·target=10000 → required=ceil(10000×0.05)=500.
  **Acceptance (R6 — 마이그레이션 *불요*, reviewer #5):** `:1050`(`...falls_back_when_latency_zero`)은 bare `summary()`(이미 `mean_ms:0`)라 **손대지 말 것** — 프록시 교체 후 그대로 통과(R6는 헬퍼 기본값이 이미 보장). 단 `:1075`(`...max_in_flight_absent`, `s.p50_ms=50`)는 위 7사이트에 포함돼 마이그레이션 대상. 비대칭 주의.

- [ ] **Step 2: 프로덕션** — `:229` `summary.p50_ms`→`summary.mean_ms`, `:228` 주석/가드를 mean 기준으로(동작 동형, 새 분기 없음).
  **Acceptance (R5):** 이 프록시(`mean_ms as f64/1000`)가 create-time `recommendSlots`가 받을 프록시와 *같은 정수 ms·같은 수식*임을 spec §3.2로 보장 — Task 3 앵커가 `summary.mean_ms`를 그대로 먹이면 양쪽 동일값.

- [ ] **Step 3: 검증** — `cargo build -p handicap-worker && cargo nextest run -p handicap-controller`(> `/tmp/mean-t2.log`) green(이식 테스트 포함).

- [ ] **Step 4: 커밋** — `git add crates/controller/src/insights.rs`, 단일 커밋, `git log -1`.

---

## Task 3: create-time 슬롯 사이징 앵커 mean 교체 (SlotSizingHelper)

**충족 R:** R4 (+ R5 parity의 create-time 측 닫음)
**Files:**
- Modify: `ui/src/components/SlotSizingHelper.tsx` — `:22` 앵커 (WorkerSizingHelper는 무관 — peakThroughput/count 기반, latency 앵커 없음)
- Modify: `ui/src/components/sizing.ts` — 주석 `:50-51`만(코드 불변)

- [ ] **Step 1: 테스트 먼저 (RED)** — `SlotSizingHelper.test.tsx`에 prior run의 `summary.mean_ms`로 권장 슬롯이 계산되는지(p50≠mean fixture) 단언.
  **Acceptance (R4):** prior open-loop run의 `mean_ms`(≠p50_ms)가 `recommendSlots`의 `latencyMs`로 흘러 권장값이 mean 기반.

- [ ] **Step 2: 프로덕션** — `SlotSizingHelper.tsx:22` `const p50Ms = report.data?.summary.p50_ms ?? 0`의 소스를 `summary.mean_ms`로(변수명도 의미에 맞게). `sizing.ts:50-51` 주석을 mean으로 + 그 주석의 stale 인용 `insights.rs:222-227`/`:224`를 실제 위치 `:229-231`로 정정(reviewer #7).
  **Acceptance (R5 create-time 측):** 앵커가 `summary.mean_ms`를 그대로 먹임 → Task 2의 post-run 프록시와 같은 정수·수식 → 동일 권장값(parity 닫힘).

- [ ] **Step 3: 검증** — `cd ui && pnpm lint && pnpm test && pnpm build`(`--max-warnings=0`) green.

- [ ] **Step 4: 커밋** — 명시 경로 add, 단일 커밋, `git log -1`.

---

## 머지 / 마무리

- **라이브 검증 필수**(spec §6, R3): `/live-verify`로 open-loop run 1회 — 리포트 GET에 `mean_ms` 있고 Zod 통과 + SlotSizingHelper가 mean 앵커로 권장. (RTL fixture는 absent-not-null이라 서버 응답경로 못 잡음 — S-D 갭.)
- **워크트리 ff-merge**: `git -C /Users/sgj/develop/handicap branch --list 'worktree-*'`로 실제 브랜치명 확인 → `merge --ff-only worktree-<X>`(메인 클린·ff 사전확인) → `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: Playwright 썼다면 `rm -rf .playwright-mcp` + 루트 png.
- **docs**: roadmap §A9 완료 한 줄(mean 프록시(C) 해소) + build-log 한 단락.

## Self-Review (작성자 체크)

- **R 커버리지**: R1–R6 전부 담당 task 있음(미매핑 0). R1·R3(seam) Task 1에 묶어 함께 머지 ✓.
- **인라인 acceptance**: 각 task가 자기 R의 acceptance 인라인 보유 — 구현 subagent가 spec 없이 닫을 수 있음 ✓.
- **Placeholder scan**: 코드 변경은 실제 파일·라인·transform 명시. UI 앵커 정확 라인만 "구현 시 grep"(파일·심볼·변환은 확정) — dogfood 한계 표기 ✓.
- **Type consistency**: `mean_ms: u64`(Rust) ↔ `z.number().int()`(Zod) ↔ `recommendSlots(latencyMs: number)` 일치. R5 parity = 양쪽 같은 정수 ms ✓.
- **커밋 경계**: Task당 green 커밋, Task 1은 와이어 양쪽 한 커밋 ✓.
