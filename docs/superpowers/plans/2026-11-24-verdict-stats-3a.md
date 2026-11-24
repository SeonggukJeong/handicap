# verdict-stats ③a — 서버·와이어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 run의 응답 시간 판정을 µs로 정확히 비교하고(run별 `latency_rule`), 평균·최대·임의 백분위 판정과 µs 통계 블록 `stats`를 서버·와이어·판정 표시까지 넣는다.

**Architecture:** 컨트롤러가 이미 가진 HDR 분포에서 통계를 계산한다(엔진·워커·proto 무변경). `runs.latency_rule` 칸(migration 0030)이 규칙 1(옛 run, 지금 동작)과 규칙 2(새 run, µs 비교)를 가른다. 와이어에 새 키가 생기는 task는 같은 task에서 UI Zod 스키마도 고친다(리포트 스키마 6개가 `.strict()`라 빠뜨리면 리포트 화면이 오류).

**Tech Stack:** Rust(axum·sqlx SQLite·hdrhistogram 7.5.4·serde), TypeScript(Zod·React·vitest).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-23-verdict-stats-a-design.md` — 이 plan은 그 spec의 ③a(R1–R16·R19·R25 + UI Zod)다. 요구 ID(R*)는 spec 것. 목업 `docs/superpowers/specs/2026-11-23-verdict-stats-a-mockups/a-screens.html` 2번(판정 표)이 Task 6의 시각 기준.

## Global Constraints

- 규칙 상수: `LATENCY_RULE_LEGACY = 1`(내린 ms 비교 — 지금 동작), `LATENCY_RULE_CURRENT = 2`(µs 비교). DB `runs.latency_rule INTEGER NOT NULL DEFAULT 1`. 모르는 값은 1로 읽는다.
- 규칙 1 run의 판정 결과·결과 행·응답 속도 구간 건수는 바이트 그대로(US6). 규칙 1 리포트 JSON에서 달라지는 것은 `stats`·`run.latency_rule` 키뿐(R16).
- 정수 ms 칸(`p50_ms`·`p95_ms`·`p99_ms`·`mean_ms`)과 그 계산식(`percentiles_of`)은 바꾸지 않는다. CSV·XLSX(`export.rs`)는 건드리지 않는다.
- 60초 상한: `CAP_US = 60_000_000`. 60초 칸 경계 `lowest_equivalent(60_000_000) = 59_998_208`, `highest_equivalent = 60_030_975`(유효 3자리 — 스크래치로 확인한 값, Task 3 테스트가 단언).
- 시간 기준 값(새 항목): 유한·0 이상·60,000 이하·소수 3자리까지. 「소수 3자리까지」 = `(x*1000 - (x*1000).round()).abs() < 1e-6`. 백분위 N: 0 < N < 100, 같은 소수 규칙.
- 백분위 정본 이름: `p` + N(뒤 0·불필요한 소수점·앞 0 없음, `0.5`의 `0`만 예외) + `_ms`. 예: `p90_ms`, `p99.9_ms`, `p0.5_ms`.
- 새 화면 문구는 `ui/src/i18n/ko.ts` 경유. 판정 표·배지 툴팁의 시간 값만 천 단위 쉼표(`4,210 ms`), 소수 3자리까지·뒤 0 생략(사용자 결정 2026-11-24).
- 커밋: cargo-영향 커밋은 `run_in_background`, `| tail` 금지, `--no-verify` 금지, 커밋 전 `git diff --cached --name-only`. 커밋 메시지는 `-F <파일>`(워크트리-격리 세션).
- clippy `-D warnings`: 7개 넘는 인자는 구조체로(`#[allow(clippy::too_many_arguments)]` 금지).

## Review Focus

1. **보여 주는 표본이 판정 통계를 물려받는 것** — `?sample=failed`·`all` 리포트의 `summary.stats`·`steps[].stats`가 통과 표본 값이면 틀리다(`shown_summary`는 `..summary.clone()`, `shown_steps`는 `..s.clone()`). Task 3에 표본별 값 단언 테스트.
2. **p99.9의 순위가 한 칸 밀리는 것** — `value_at_quantile(99.9/100)`는 표본 1,000건에서 999번째가 아니라 1000을 준다. Task 3의 정수 순위 테스트(1,000·10,000건).
3. **표본이 전부 60초 칸인 분포** — `mean()`이 60,014,592로 최대(60,000,000으로 자름)보다 커진다. Task 3 단언: `mean_us <= max_us`.
4. **옛 run의 판정이 조용히 바뀌는 것** — 규칙 1 픽스처의 `verdict`·속도 구간 바이트 동일(Task 4·5) + 골든 diff가 새 키뿐(Task 1·3).
5. **새 키 때문에 리포트 화면이 열리지 않는 것** — `.strict()` 스키마 6개가 새 키를 받는 Zod 테스트(Task 1·3·5), `CriterionResultSchema`는 `.strict()`가 아니라 `capped`가 조용히 버려지지 않게 스키마에 넣는다(Task 4).

## 공통: 골든 diff 확인 명령 (Task 1·3·4·5에서 사용)

`testdata/report_whole_golden.json`은 `whole_report_matches_golden`이 바이트 비교한다. 새 키가 생기는 task는 재생성 후 「새 키를 지우면 HEAD의 파일과 같다」를 확인한다. 워크트리 훅이 리다이렉트·여러 줄 `python -c`를 거부할 수 있으므로 검사 스크립트는 Write 도구로 `.superpowers/sdd/golden_strip_check.py`(gitignore됨)에 한 번 만들어 쓴다:

```python
import json, subprocess, sys
NEW_KEYS = {"stats", "latency_rule", "slow_us", "capped"}
def strip(v):
    if isinstance(v, dict): return {k: strip(x) for k, x in v.items() if k not in NEW_KEYS}
    if isinstance(v, list): return [strip(x) for x in v]
    return v
old = json.loads(subprocess.run(["git", "show", "HEAD:testdata/report_whole_golden.json"],
                                capture_output=True, text=True, check=True).stdout)
new = json.load(open("testdata/report_whole_golden.json"))
same = strip(old) == strip(new)
print("SAME" if same else "DIFF"); sys.exit(0 if same else 1)
```

실행(워크트리 루트에서, 따로따로):
```bash
REPORT_WHOLE_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller whole_report_matches_golden
python3 -I .superpowers/sdd/golden_strip_check.py
```
Expected: `SAME`.

---

### Task 1: 응답 시간 규칙 번호 `latency_rule` (R1) + ADR-0065

**Files:**
- Modify: `crates/controller/src/store/mod.rs`(`connect()` 끝에 `ensure_runs_latency_rule`, 함수 추가 — `ensure_runs_status_rule` 바로 아래, 같은 모양)
- Modify: `crates/controller/src/store/runs.rs`(상수·`narrow_latency_rule`·`RunRow.latency_rule`·`insert`·두 `SELECT`·테스트 모듈)
- Modify: `crates/controller/src/report.rs`(`ReportRun.latency_rule` + 조립 + 테스트 `run_row()`·`golden_inputs`의 `RunRow`)
- Modify: `RunRow {` 리터럴 11곳(`api/runs.rs` 2·`report.rs` 6·`store/runs.rs` 3 — `grep -rn "RunRow {" crates/controller/src crates/controller/tests | grep -v "pub struct"`)·`ReportRun {` 리터럴(`export.rs`·`report.rs`)
- Modify: `crates/controller/src/schedule/runner.rs`(테스트 `cron_due_fires_and_advances`에 단언 한 줄)
- Modify: `crates/controller/tests/api_test.rs`(새 테스트)
- Modify: `ui/src/api/schemas.ts`(`ReportRunSchema.latency_rule` + `reportLatencyRule`)
- Test: `ui/src/api/__tests__/schemas.test.ts`
- Create: `docs/adr/0065-latency-boundary-rule.md`, Modify: `docs/adr/README.md`(목록 한 줄)
- Modify: `testdata/report_whole_golden.json`(재생성)

**Interfaces:**
- Produces: `pub const LATENCY_RULE_LEGACY: u8 = 1; pub const LATENCY_RULE_CURRENT: u8 = 2;`(`store::runs`), `RunRow.latency_rule: u8`, `ReportRun.latency_rule: u8`(`#[serde(default = "latency_rule_legacy")]`, 늘 직렬화), UI `reportLatencyRule(report: Pick<Report,"run">): 1 | 2`.

- [ ] **Step 1: 실패하는 테스트 쓰기** — `store/runs.rs` 테스트 모듈에 `status_rule` 세 테스트를 본뜬 셋:
  - `insert_stamps_latency_rule_current`: `insert` 반환·`get`·`list_by_scenario` 모두 `latency_rule == LATENCY_RULE_CURRENT`이고 `LATENCY_RULE_CURRENT == 2`.
  - `migration_0030_idempotent`: `connect` 두 번 뒤 `pragma_table_info('runs') WHERE name = 'latency_rule'` 개수 1.
  - `legacy_row_reads_latency_rule_1`: `legacy_row_reads_status_rule_1`처럼 칸을 `DROP`한 옛 스키마에 행을 넣고 다시 `connect` → `latency_rule == 1`.
  - `narrow_latency_rule_maps_unknown_to_legacy`: `narrow_latency_rule(0) == 1`, `(3) == 1`, `(-1) == 1`, `(2) == 2`.
  - `report.rs`: `report_json_always_has_latency_rule` — `report_json_always_has_status_rule`(현재 `report.rs`의 같은 이름 테스트)를 본떠 `latency_rule` 키가 있고 값 2(`run.latency_rule = LATENCY_RULE_CURRENT`로 둔 경우), 옛 JSON(`latency_rule` 키 없음)을 `ReportRun`으로 역직렬화하면 1.
  - `tests/api_test.rs`: `create_run_stamps_latency_rule_current` — `create_run` 뒤 `GET /api/runs/{id}/report`의 `run.latency_rule == 2`(run이 끝나지 않아도 리포트는 만들어진다 — 안 되면 `store::runs::get`으로 같은 단언).
  - `schedule/runner.rs` `cron_due_fires_and_advances`: `assert_eq!(run.latency_rule, crate::store::runs::LATENCY_RULE_CURRENT);` 한 줄.
  - UI `schemas.test.ts`: `ReportRunSchema`가 `latency_rule: 2`를 받고 `3`을 거절, 키 없음을 받음, `reportLatencyRule`이 없으면 1·있으면 그 값.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller latency_rule` → 컴파일 실패(`LATENCY_RULE_CURRENT` 없음). `cd ui && pnpm vitest run src/api/__tests__/schemas.test.ts` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — `/new-migration latency_rule`의 3b(Rust 가드) 절차로 `ensure_runs_latency_rule`(번호 0030, `connect()` 마지막 `ensure_runs_status_rule` 줄 다음에 `// migration 0030 (Rust-guarded; see fn)`). `insert`는 `status_rule`처럼 `latency_rule` 칸에 `LATENCY_RULE_CURRENT`를 바인드하고 반환 `RunRow`에도 넣는다. 두 `SELECT`에 칸 추가 + `narrow_latency_rule`. `ReportRun`에 `latency_rule`(조립은 `run.latency_rule`). 테스트 `run_row()`·`golden_inputs`는 `LATENCY_RULE_LEGACY`. UI: `latency_rule: z.union([z.literal(1), z.literal(2)]).optional()`(`.default()` 금지 — `status_rule` 주석과 같은 이유) + `export function reportLatencyRule(report: Pick<Report, "run">): 1 | 2 { return report.run.latency_rule ?? 1; }`.
- [ ] **Step 4: ADR-0065 쓰기** — `docs/adr/0065-latency-boundary-rule.md`(MADR, ADR-0064 모양). 결정: run별 `latency_rule`, 규칙 2 = 시간 기준·응답 속도 구간을 µs로 비교, 평균·최대·임의 백분위 판정 항목 추가(ADR-0028 확장), 60초 칸 실측은 하한(`capped`, 상한 기준 실패), 통계 블록 `stats`(µs), 정수 ms 칸 불변. 대안 기각 둘(새 항목만 정확히·모두 내림 유지)과 이유는 spec 머리 「사용자 결정」 그대로. 연기는 spec §10을 가리킨다. `docs/adr/README.md` 목록에 한 줄.
- [ ] **Step 5: 골든 재생성 + diff 확인** — 위 「공통: 골든 diff 확인 명령」. Expected `SAME`.
- [ ] **Step 6: 통과 확인** — `cargo nextest run -p handicap-controller` 전체 PASS, `cd ui && pnpm lint && pnpm test && pnpm build` PASS.
- [ ] **Step 7: 되돌려 확인** — `insert`의 `latency_rule` 바인드를 `LATENCY_RULE_LEGACY`로 바꿔 `insert_stamps_latency_rule_current`·`create_run_stamps_latency_rule_current`·스케줄 단언이 RED인지 보고 원복.
- [ ] **Step 8: 커밋** — `feat(controller): run별 응답 시간 판정 규칙 latency_rule (migration 0030, ADR-0065)`.

### Task 2: 백분위 이름 문법 + 새 판정 기준 칸 + 검증 (R2–R5)

**Files:**
- Create: `crates/controller/src/percentile_name.rs`(+ `lib.rs`에 `pub mod percentile_name;`)
- Create: `testdata/percentile_metric_cases.json`
- Modify: `crates/controller/src/store/runs.rs`(`Criteria` 세 칸 + `PercentileLimit` + `has_any`)
- Modify: `crates/controller/src/api/runs.rs`(`validate_criteria`)
- Modify: `crates/controller/tests/presets_api_test.rs`·`crates/controller/tests/schedules_api_test.rs`·`crates/controller/tests/api_test.rs`(400 통합 각 1건)
- Modify: `ui/src/api/schemas.ts`(`CriteriaSchema`)
- Test: `ui/src/api/__tests__/schemas.test.ts`

**Interfaces:**
- Produces:
  - `percentile_name::to_milli(n: f64) -> Option<u32>` — 유한·0 < n < 100·소수 3자리까지(허용 오차 식)면 `round(n*1000)`.
  - `percentile_name::parse_percentile_metric(name: &str) -> Option<f64>` — 정본 이름만 `Some(N)`.
  - `percentile_name::percentile_metric_name(n: f64) -> String` — `to_milli` 뒤 정수부·소수부(뒤 0 제거)로 `p{N}_ms`. `to_milli`가 None이면 panic하지 말고 `format!("p{n}_ms")`(검증을 거친 값만 들어온다).
  - `percentile_name::is_three_decimals(x: f64) -> bool` — 허용 오차 식.
  - `store::runs::PercentileLimit { pub percentile: f64, pub max_ms: f64 }`(`Debug, Clone, Serialize, Deserialize, PartialEq`).
  - `Criteria.max_mean_ms: Option<f64>`, `Criteria.max_max_ms: Option<f64>`, `Criteria.max_percentiles_ms: Vec<PercentileLimit>` — 앞 둘 `#[serde(default, skip_serializing_if = "Option::is_none")]`, 목록 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`.

- [ ] **Step 1: 예시 파일 쓰기** — `testdata/percentile_metric_cases.json`:
  ```json
  {
    "names": [
      {"input": "p90_ms", "percentile": 90}, {"input": "p99.9_ms", "percentile": 99.9},
      {"input": "p99.99_ms", "percentile": 99.99}, {"input": "p0.5_ms", "percentile": 0.5},
      {"input": "p99.999_ms", "percentile": 99.999}, {"input": "p1_ms", "percentile": 1},
      {"input": "p90.0_ms", "percentile": null}, {"input": "p090_ms", "percentile": null},
      {"input": "p100_ms", "percentile": null}, {"input": "p0_ms", "percentile": null},
      {"input": "p99.9999_ms", "percentile": null}, {"input": "p.5_ms", "percentile": null},
      {"input": "p00.5_ms", "percentile": null}, {"input": "p90", "percentile": null},
      {"input": "P90_ms", "percentile": null}, {"input": "p-1_ms", "percentile": null},
      {"input": "p9e1_ms", "percentile": null}, {"input": "p 90_ms", "percentile": null}
    ],
    "numbers": [
      {"input": "90", "name": "p90_ms"}, {"input": "90.0", "name": "p90_ms"},
      {"input": "99.90", "name": "p99.9_ms"}, {"input": "0.5", "name": "p0.5_ms"},
      {"input": "1.005", "name": "p1.005_ms"}, {"input": "100", "name": null},
      {"input": "0", "name": null}, {"input": "99.9999", "name": null}, {"input": "-5", "name": null}
    ]
  }
  ```
- [ ] **Step 2: 실패하는 테스트 쓰기** (`percentile_name.rs` 테스트 모듈):
  - `names_table`: 파일 `names`마다 `parse_percentile_metric(input) == percentile`(null ↔ None), `Some`이면 `percentile_metric_name(N) == input`.
  - `numbers_table`: 파일 `numbers`마다 입력 글자를 `f64`로 읽어 `to_milli(..).map(|_| percentile_metric_name(n))`이 `name`과 같다.
  - `three_decimals`: `is_three_decimals(1.005)`·`(0.5)`·`(60000.0)` 참, `(1.0005)` 거짓.
  - `api/runs.rs` 테스트 `validate_criteria_new_time_fields`: 표 하나로 받음/거절 — 받음: `max_mean_ms 3000`, `max_max_ms 60000`, `max_percentiles_ms [{90,2500},{99.9,8000}]`, 스텝 `mean_ms`·`max_ms`·`p90_ms`·`p99.9_ms`(threshold 1200.5); 거절(그리고 사유에 든 글자): `max_mean_ms 60000.5`·`-1`·`NaN`·`1.0005`, 목록 11개, `{90}` 둘(「같은 백분위」), `{95}`(「위의 최대 p95 칸을 쓰세요」), `{100}`·`{0}`, 스텝 `p90.0_ms`·`p100_ms`·`median_ms`, 스텝 `mean_ms` threshold 60001. 스텝 `p95_ms` threshold 70000은 **받음**(기존 항목 면제).
  - `store/runs.rs` 테스트 `criteria_new_fields_skip_when_empty`: 새 칸 없는 `Criteria`의 JSON이 이 변경 전 문자열과 같다(리터럴로 고정), 새 칸 넣은 값 왕복 동일, `has_any`가 세 칸 각각만 있을 때 참.
  - 통합: run 생성(`POST /api/runs`)·프리셋 저장·스케줄 저장에 `max_percentiles_ms:[{"percentile":95,"max_ms":1}]` → 400.
  - UI `schemas.test.ts`: `CriteriaSchema`가 세 새 칸을 받고(목록 원소 `{percentile, max_ms}`), 없어도 받는다.
- [ ] **Step 3: 실패 확인** — `cargo nextest run -p handicap-controller percentile_name validate_criteria criteria_new_fields` → 컴파일 실패.
- [ ] **Step 4: 구현** — `parse_percentile_metric`: `p`로 시작·`_ms`로 끝나는 가운데 글자가 `^(0|[1-9][0-9]?)(\.[0-9]{1,3})?$`(정규식 대신 손으로 검사해도 된다)에 맞고 `to_milli`가 Some이고 `percentile_metric_name(N) == name`일 때만 Some. `validate_criteria`: 기존 검사 뒤에 — 새 시간 값 검사 함수 하나(`fn time_limit_ok(v: f64) -> bool` = 유한·0..=60000·`is_three_decimals`)를 run 새 칸·목록 `max_ms`·스텝 새 항목 threshold에 쓴다. 목록: 10개 초과 거절, `to_milli(percentile)` None 거절, milli 중복 거절, milli ∈ {50000, 95000, 99000}이면 거절. 스텝 metric 허용 = 기존 8개 ∪ {`mean_ms`, `max_ms`} ∪ `parse_percentile_metric(..).is_some()`. 사유 문구(한국어, `format!`):
  - 범위: `criteria.{name}은 0 이상 60000 이하, 소수 셋째 자리까지여야 합니다`
  - 목록 개수: `criteria.max_percentiles_ms는 10개까지입니다`
  - 백분위 값: `criteria.max_percentiles_ms[{i}].percentile은 0보다 크고 100보다 작은 수(소수 셋째 자리까지)여야 합니다`
  - 중복: `criteria.max_percentiles_ms[{i}]: 같은 백분위(p{N})가 이미 있습니다`
  - 50·95·99: `criteria.max_percentiles_ms[{i}]: p{N}은 위의 최대 p{N} 칸을 쓰세요`
  `has_any`에 `self.max_mean_ms.is_some() || self.max_max_ms.is_some() || !self.max_percentiles_ms.is_empty()`. UI `CriteriaSchema`: `max_mean_ms: z.number().nonnegative().optional()`, `max_max_ms` 같음, `max_percentiles_ms: z.array(z.object({ percentile: z.number(), max_ms: z.number().nonnegative() })).optional()`.
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` PASS, `cd ui && pnpm lint && pnpm test && pnpm build` PASS.
- [ ] **Step 6: 커밋** — `feat(controller): 평균·최대·임의 백분위 판정 기준 칸 + 백분위 이름 문법·검증`.

### Task 3: 통계 블록 `stats` (R6·R7·R15 앞부분·R25)

**Files:**
- Create: `crates/controller/src/latency_stats.rs`(+ `lib.rs`)
- Modify: `crates/controller/src/report.rs`(`ReportSummary`·`ReportStep`·`WorkerBreakdown`에 `stats` + 판정용·보여 주는 쪽·워커 조립 + `ReportStep {`·`ReportSummary {` 리터럴 — `export.rs`·`validity.rs`·`insights.rs`·`report.rs`)
- Modify: `crates/controller/src/steady.rs`(`BasisOther.stats`), `crates/controller/src/api/runs.rs`(`other_of`), `crates/controller/tests/report_test.rs`(`basis_other_has_stats`)
- Modify: `ui/src/api/schemas.ts`(`LatencyStatsSchema` + 네 스키마)
- Test: `ui/src/api/__tests__/schemas.test.ts`
- Modify: `testdata/report_whole_golden.json`

**Interfaces:**
- Consumes: 없음(Task 1·2와 독립).
- Produces:
  - `latency_stats::CAP_US: u64 = 60_000_000`.
  - `latency_stats::LatencyStats { pub min_us: u64, pub mean_us: u64, pub max_us: u64, pub stdev_us: u64, pub p50_us: u64, pub p90_us: u64, pub p95_us: u64, pub p99_us: u64, pub capped: bool }`(`Debug, Clone, Copy, Serialize, Deserialize, PartialEq`).
  - `latency_stats::value_at_milli(h: &Histogram<u64>, n_milli: u32) -> Option<u64>` — 정수 순위 백분위(CAP_US로 자름), 빈 분포 None.
  - `latency_stats::max_us(h) -> Option<u64>` = `min(h.max(), CAP_US)`, `latency_stats::is_cap_value(h, v_raw) -> bool` = `v_raw >= h.lowest_equivalent(CAP_US)`, `latency_stats::is_capped(h) -> bool` = `is_cap_value(h, h.max())`.
  - `latency_stats::latency_stats(h: &Histogram<u64>) -> Option<LatencyStats>`.
  - `ReportSummary.stats`·`ReportStep.stats`·`WorkerBreakdown.stats`·`BasisOther.stats`: `Option<LatencyStats>` + `#[serde(default, skip_serializing_if = "Option::is_none")]`.

- [ ] **Step 1: 실패하는 테스트 쓰기** (`latency_stats.rs` 테스트, 분포는 `Histogram::new_with_bounds(1, 60_000_000, 3)`):
  - `bucket_edges`: `lowest_equivalent(60_000_000) == 59_998_208`, `highest_equivalent(60_000_000) == 60_030_975`.
  - `integer_rank_matches_value_at_quantile_for_fixed`: 표본 수 1..=2_000(값 `i*37 % 50_000 + 1` 등 섞은 값)마다 `value_at_milli(h, 50_000/95_000/99_000) == Some(h.value_at_quantile(0.50/0.95/0.99))`(60초 칸 밖 값만).
  - `p999_rank_exact`: 값 1..=1000 기록 → `value_at_milli(h, 99_900) == Some(h.highest_equivalent(999))`이고 `!= Some(h.value_at_quantile(99.9/100.0))`; 값 `10*i`(i=1..=10_000) → `Some(h.highest_equivalent(99_900))`.
  - `all_capped`: 60_000_000 하나 기록 → `max_us == 60_000_000`, `mean_us == 60_000_000`(60_014_592를 자름), `capped`, `p99_us == 60_000_000`.
  - `capped_boundary`: 59_000_000만 → `!capped`; 59_998_208 → `capped`; 59_998_207 → `!capped`.
  - `basic_values`: 손 계산 분포(예: 1000µs × 9, 100_000µs × 1) → `min_us == 1000`, `p50_us`·`p90_us`가 1000 칸, `p95_us`·`p99_us`·`max_us`가 100_000 칸(`highest_equivalent`), `mean_us`·`stdev_us`가 `h.mean()`·`h.stdev()` 반올림.
  - `mean_error_within_0_1_pct`(R25): 1..=200_000µs 로그 분포 합성 표본의 정확한 평균과 `mean_us` 차이 ≤ 0.1%.
  - `empty_is_none`: 빈 분포 → `latency_stats` None, `value_at_milli` None.
  - `report.rs` `stats_follow_sample`: 나눌 수 있는 run(`passed_sample_is_default_for_split_run`의 `split_win` 행을 **복사** — 그 테스트 안의 지역 `let`이라 공유 픽스처가 아니다)에서 기본 리포트 `summary.stats.p50_us`가 40ms 칸, `Sample::Failed` 리포트는 2ms 칸, `Sample::All`은 합친 분포 값; 스텝 `stats`도 같은 표본.
  - `report.rs` `worker_stats_follow_sample`: 워커 표는 워커 2대 이상일 때만 만들어진다(`multi_worker`) — `worker_breakdown_follows_selected_sample`의 두 워커 행(`w-a`·`w-b`)을 복사해 `worker_breakdown.len() == 2`를 먼저 단언하고, 표본마다 각 워커 `stats.p50_us`·`p95_us`가 그 테스트의 `(p50_ms, p95_ms)` 기대값과 같은 칸(`/1000` 내림이 같음).
  - `stats_follow_basis`: 유지 구간 run에서 `whole`·`steady` 두 리포트의 `summary.stats.mean_us`가 다르고 각 범위 분포와 같다.
  - `stats_absent_without_samples`: 표본 없는 스텝·run은 키 없음(직렬화 문자열에 `"stats"` 없음).
  - `basis_other_has_stats`(`crates/controller/tests/report_test.rs`, `basis_whole_param_returns_whole_report` 옆 — 같은 `report_json` 도우미): `?basis=whole` 리포트의 `basis.other.stats`가 `?basis=steady` 리포트의 `summary.stats`와 같다.
  - UI `schemas.test.ts`: 네 스키마가 `stats` 있는/없는 픽스처를 받고, `stats`에 모르는 키가 있으면 거절(`.strict()`).
  - `report.rs` `#[ignore] bench_build_report_many_steps`(Step 7에서 씀 — 단언 없음, 시간만 출력).
- [ ] **Step 2: 실패 확인 + 성능 기준값** — `cargo nextest run -p handicap-controller latency_stats stats_` → 컴파일 실패. 새 테스트를 잠시 `#[cfg(any())]`로 막은 상태에서 `cargo nextest run -p handicap-controller --release --run-ignored only bench_build_report_many_steps --no-capture`로 기준 시간을 적어 둔다(측정 테스트는 지금 코드로도 컴파일된다). (`--ignored`는 이 nextest 0.9.137에서 거부된다 — `--run-ignored only`.)
- [ ] **Step 3: `value_at_milli` 구현** — 알고리즘(부동소수 순위 금지):
  ```rust
  let total = h.len();               // 0이면 None
  let rank = ((n_milli as u128 * total as u128 + 99_999) / 100_000).max(1) as u64;
  let mut seen = 0u64;
  for v in h.iter_recorded() {
      seen += v.count_at_value();
      if seen >= rank { return Some(h.highest_equivalent(v.value_iterated_to()).min(CAP_US)); }
  }
  ```
  (`value_iterated_to`가 이미 칸 위쪽 끝이어도 `highest_equivalent`는 같은 값 — `integer_rank_matches_value_at_quantile_for_fixed`가 지킨다.) `latency_stats`: `min_us = h.min()`, `max_us = max_us(h)`, `mean_us = (h.mean().round() as u64).min(max_us)`, `stdev_us = h.stdev().round() as u64`, 백분위 넷 `value_at_milli`(50_000·90_000·95_000·99_000), `capped = is_capped(h)`.
- [ ] **Step 4: 리포트에 싣기** — 판정용 `summary.stats = latency_stats(overall_h)`, 스텝 `stats = per_step_hists.get(id).and_then(latency_stats)`. **함정**: `shown_summary`·`shown_steps`는 `..clone()`으로 판정용을 물려받으므로 그 계산 안에서 보여 주는 표본 분포로 `stats`를 다시 넣는다(`shown_step_p`를 `(Percentiles, Option<LatencyStats>)`로 넓히는 식). 워커는 `w.hist.resolve(selected)` 분포로. `other_of`는 `stats: s.stats`. 분포를 다시 디코드·복사하지 않는다.
- [ ] **Step 5: UI 스키마** — `LatencyStatsSchema = z.object({min_us, mean_us, max_us, stdev_us, p50_us, p90_us, p95_us, p99_us: z.number().int().nonnegative(), capped: z.boolean()}).strict()`, `ReportSummarySchema`·`ReportStepSchema`·`WorkerBreakdownSchema`·`ReportBasisSchema`의 `other` 객체에 `stats: LatencyStatsSchema.optional()`.
- [ ] **Step 6: 골든 재생성 + diff 확인** — 공통 명령, `SAME`.
- [ ] **Step 7: 통과 확인 + 성능 비교** — `cargo nextest run -p handicap-controller` PASS, UI 게이트 PASS. 성능: Step 1에서 먼저 둔 `#[ignore]` 측정 테스트 `bench_build_report_many_steps`(50스텝 × 600초 행 픽스처, `build_report` 10회 평균 시간을 `eprintln!`)를 Step 3 **전에** 한 번(기준), 지금 한 번 `cargo nextest run -p handicap-controller --release --run-ignored only bench_build_report_many_steps --no-capture`로 돌려 두 숫자를 task 보고에 적는다. 20% 넘게 느려지면 STOP하고 보고.
- [ ] **Step 8: 되돌려 확인** — ① `shown_summary` 안의 `stats` 재계산을 빼서 `stats_follow_sample`이 RED ② `mean_us`의 `.min(max_us)`를 빼서 `all_capped`가 RED ③ `value_at_milli`를 `h.value_at_quantile((n_milli as f64 / 1000.0) / 100.0)`로 바꿔 `p999_rank_exact`가 RED(`n_milli / 100_000.0`은 정확히 0.999라 RED가 안 된다 — 사용자 입력 N=99.9를 100으로 나누는 실제 경로를 흉내 낸다) — 각각 원복.
- [ ] **Step 9: 커밋** — `feat(controller): 응답 시간 통계 블록 stats(µs, 정수 순위 백분위, 60초 칸 표시)`.

### Task 4: 규칙 2 판정 — µs 비교·새 항목·`capped`·표본 없음·순서 (R8–R12·R14·R15·R16)

**Files:**
- Modify: `crates/controller/src/report.rs`(`evaluate_criteria` 시그니처·본문, `CriterionResult.capped`, `build_report`의 호출, 테스트 17곳)
- Modify: `CriterionResult {` 리터럴 10곳(`report.rs` 8·`insights.rs` 1·`store/schedules.rs` 1)
- Modify: `ui/src/api/schemas.ts`(`CriterionResultSchema.capped`)
- Test: `ui/src/api/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 `LATENCY_RULE_*`·`run.latency_rule`, Task 2 `Criteria` 새 칸·`percentile_name::{parse_percentile_metric, percentile_metric_name, to_milli}`, Task 3 `latency_stats::{value_at_milli, max_us, is_cap_value, is_capped, latency_stats, CAP_US}`.
- Produces:
  - `pub struct JudgeInput<'a> { pub summary: &'a ReportSummary, pub status_dist: &'a BTreeMap<String, u64>, pub windows: &'a [ReportWindow], pub steps: &'a [ReportStep], pub warmup_override: Option<u32>, pub no_sample: &'a NoSample<'a>, pub latency_rule: u8, pub overall_hist: Option<&'a Histogram<u64>>, pub step_hists: &'a BTreeMap<String, Histogram<u64>> }`
  - `pub fn evaluate_criteria(c: &Criteria, input: &JudgeInput<'_>) -> Verdict`
  - `CriterionResult.capped: bool`(`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`).

- [ ] **Step 1: 테스트 도우미로 기존 17곳 옮기기** — 테스트 모듈에 `fn judge(c, s, dist, windows, steps, warmup, no_sample) -> Verdict`(규칙 1, 빈 분포 맵, `overall_hist: None`)를 두고 기존 호출을 그것으로 바꾼다(단언은 그대로). 이 스텝은 시그니처를 바꾸기 전엔 컴파일이 안 되므로 Step 3과 같은 커밋 안에서 끝낸다.
- [ ] **Step 2: 실패하는 테스트 쓰기** (`report.rs`, 도우미 `judge2(c, s, steps, overall: &Histogram, step_hists)` = 규칙 2):
  - `rule2_exact_compare`: p95 분포가 43,903µs 칸(43,900 기록) + `max_p95_ms: 43` → 규칙 2 ✗·`actual == 43.903`, 같은 입력 규칙 1 → ✓·`actual == 43.0`.
  - `rule2_sub_ms`: 350µs 분포 + `max_mean_ms: 0.5` → ✓, `actual == 0.35`; `max_mean_ms: 0.3` → ✗.
  - `rule2_new_metrics`: `max_mean_ms`·`max_max_ms`·`max_percentiles_ms [{90},{99.9}]` 각 행의 `actual`이 Task 3 `latency_stats`·`value_at_milli` 값/1000과 같고(R15), 스텝 `mean_ms`·`max_ms`·`p90_ms`(op max·min 둘 다) 행이 그 스텝 분포 값.
  - `rule2_order`: `max_mean_ms`·`max_p99_ms`·`max_p50_ms`·`max_percentiles_ms [{99.9},{90}]`·`max_max_ms`·`max_error_rate`·스텝 기준 하나 → 행 `metric` 순서 = `["mean_ms","p50_ms","p90_ms","p99_ms","p99.9_ms","max_ms","error_rate", <스텝>]`. 새 항목 없이 `max_p50/95/99_ms` → `["p50_ms","p95_ms","p99_ms"]`(지금 순서).
  - `rule2_capped`: 60,000,000µs 섞인 분포 — `max_max_ms: 60000` → ✗·`capped`·`actual == 60000.0`; `max_mean_ms: 60000` → 평균 행 `capped`·✗; 스텝 `max_ms` op `min` threshold 1000 → `capped`·✓; 60초 칸 밖 값인 `p50_ms` 행은 `capped == false`.
  - `rule2_no_usable_hist`: `summary.count > 0`인데 `overall_hist: None` → 시간 행 전부 `passed: false`·`no_sample: true`; 스텝(`count > 0`)인데 `step_hists`에 없음 → 같음. `summary.count == 0` → 시간 행 없음(다른 기준 없으면 `criteria` 빈 목록).
  - `rule1_defensive_new_items`: 규칙 1 + `max_mean_ms`·`max_p95_ms` → 평균 행은 규칙 2 방식 값(분포가 `capped`면 `capped`도 — R9의 방어 경로는 새 항목을 통째로 규칙 2로 판정한다), `max_p95_ms` 행은 정수(규칙 1, `capped` 없음). 순서는 R11(평균 → p95)로 규칙과 무관 — 새 항목 없는 규칙 1 run은 p50·p95·p99만이라 지금 순서와 같다.
  - `rule1_bytes_unchanged`: 기존 판정 픽스처(규칙 1) 하나의 `serde_json::to_string(&verdict)`가 변경 전 문자열과 같다(리터럴 고정 — 지금 코드로 먼저 뽑아 박는다).
  - `verdict_ignores_shown_sample`(R14): 같은 나눌 수 있는 run에서 `Sample::All`·`Sample::Failed` 리포트의 `verdict`가 기본 리포트와 같다.
  - `rule2_summary_stats_equal_actual`(R15): 기본 표본 리포트에서 `summary.stats.mean_us as f64 / 1000.0 == mean 행 actual`, 스텝도.
  - UI `schemas.test.ts`: `CriterionResultSchema`가 `capped: true`를 보존한다(파싱 결과에 남는다).
- [ ] **Step 3: 구현** — 시간 값 하나를 내는 함수 하나를 판정이 쓴다:
  ```rust
  enum TimeKind { Mean, Max, Milli(u32) }          // p50_ms → Milli(50_000) …
  fn time_actual(kind: TimeKind, h: &Histogram<u64>) -> Option<(u64 /*us*/, bool /*capped*/)>
  // Mean → (latency_stats(h).mean_us, is_capped(h)); Max → (max_us, is_cap_value(h, h.max()));
  // Milli(n) → 순위 표본의 raw 값으로 is_cap_value, 값은 value_at_milli
  ```
  규칙 2 행: `threshold_us = (threshold * 1000.0).round() as u64`; `capped && op == "max"` → 실패; 아니면 op `max`: `actual_us <= threshold_us`, `min`: `>=`. `actual = actual_us as f64 / 1000.0`. 표본: run은 `overall_hist`, 스텝은 `step_hists.get(target)`; `count == 0`이면 행 없음(run: `summary.count == 0`, 스텝: 지금 규칙), 분포가 없거나 비면 `passed:false, no_sample:true, actual:0.0`. run 시간 행 순서: 평균 → (고정 p50·p95·p99 + 목록)을 milli 오름차순 → 최대, 그 뒤 기존 순서. 규칙 1: 고정 p50·p95·p99 행의 값·판정은 기존 `push_max` 식 그대로(정수 비교, `capped` 없음), 새 항목이 있으면 규칙 2 방식으로 — 행 순서는 두 규칙 모두 R11. 스텝 기준: 규칙 2이거나 새 항목이면 위 방식, 규칙 1의 기존 항목은 지금 경로. `build_report`는 `JudgeInput { latency_rule: run.latency_rule, overall_hist: overall_judging.hist(), step_hists: &per_step_hists, .. }`.
- [ ] **Step 4: 골든 확인** — 골든은 규칙 1이라 바뀌지 않아야 한다: `cargo nextest run -p handicap-controller whole_report_matches_golden` PASS(재생성하지 않는다).
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` PASS(`export.rs`의 `compare_golden` 테스트 포함, 픽스처 무수정), UI 게이트 PASS.
- [ ] **Step 6: 되돌려 확인** — ① `capped && op max → 실패`를 빼서 `rule2_capped` RED ② 규칙 2 판정을 `summary.p95_ms` 정수 비교로 되돌려 `rule2_exact_compare` RED ③ 순서 정렬을 빼서 `rule2_order` RED ④ `no_sample` 확장을 빼서 `rule2_no_usable_hist` RED — 각각 원복.
- [ ] **Step 7: 커밋** — `feat(controller): 규칙 2 판정 — µs 비교·평균·최대·임의 백분위·capped·표본 없음`.

### Task 5: 응답 속도 구간 µs 경계 (R13)

**Files:**
- Modify: `crates/controller/src/speed_bands.rs`(`SpeedBandRow.slow_us`, `build`·`step_boundary`·`run_boundary`·`count_bands`)
- Modify: `crates/controller/src/report.rs`(`speed_bands::build` 호출에 규칙)
- Modify: `crates/controller/tests/speed_bands_test.rs`
- Modify: `ui/src/api/schemas.ts`(`SpeedBandRowSchema.slow_us`)
- Modify: `ui/src/print/speedBands.ts`(`slow_ms`를 읽는 7줄 — `grep -n "slow_ms" ui/src/print/speedBands.ts`), `ui/src/print/compare/speedCompare.ts`(`slow_ms`를 읽는 4줄: 35·43·52·54 — `fmtBoundary(o.slow_ms)` 둘·`b.slow_ms === a.slow_ms`·`fmtBoundary(b.slow_ms)`)
- Test: `ui/src/print/__tests__/speedBands.test.ts`, `ui/src/api/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 `LATENCY_RULE_*`.
- Produces:
  - `SpeedBandRow.slow_us: Option<u64>`(`#[serde(default, skip_serializing_if = "Option::is_none")]` — 규칙 2만 Some).
  - `speed_bands::build(overall, per_step, c, latency_rule: u8) -> Option<SpeedBands>`.
  - `speed_bands::count_bands_us(h: &Histogram<u64>, slow_us: u64, basis: &'static str, own: bool) -> SpeedBandRow`(규칙 2; `count_bands`는 규칙 1 그대로 남긴다).
  - `speed_bands::step_boundary_us(c, step_id) -> Option<(u64 /*us*/, &'static str)>` — `floor` 대신 `round(t * 1000)`.
  - UI `boundaryMs(row: { slow_ms: number; slow_us?: number }): number` = `slow_us != null ? slow_us / 1000 : slow_ms`(`ui/src/print/speedBands.ts`에서 export).

- [ ] **Step 1: 실패하는 테스트 쓰기**:
  - `speed_bands_test.rs` `rule2_counts_by_us`: 43,900µs 표본 하나 — 규칙 1 `count_bands(h, 43, ..)` → `within`, 규칙 2 `count_bands_us(h, 43_000, ..)` → `over`.
  - `rule2_step_fraction`: 스텝 기준 `p95_ms` 43.5 → `step_boundary_us == Some((43_500, "p95"))`, `step_boundary`(규칙 1)는 `Some((43, "p95"))` 그대로.
  - `rule2_build_sets_slow_us`: `build(.., LATENCY_RULE_CURRENT)`의 overall·step 행 `slow_us == Some(slow_ms*1000)`(정수 기준) / 43_500(소수 스텝 기준); `LATENCY_RULE_LEGACY`면 `None`이고 나머지 칸은 지금과 같다.
  - `verdict_agrees_with_over_share_rule2`: 기존 `verdict_agrees_with_over_share`를 본떠 `slow_us`(µs, 소수 기준 포함 `rng`로 `slow_ms*1000 + rng%1000`)와 `count_bands_us` → `value_at_milli(h, 95_000/99_000/50_000) <= slow_us` ⇔ `!exceeds_allowance(..)`.
  - UI `speedBands.test.ts`: `boundaryMs({slow_ms:43, slow_us:43_500}) === 43.5`, `slow_us` 없으면 `slow_ms`; `slow_us`가 있는 리포트의 경계 글자가 `fmtBoundary(43.5)`의 글자. `speedCompare`의 같은 경계 판정이 `slow_us` 43,500 vs 43,000을 다르다고 본다.
  - UI `schemas.test.ts`: `SpeedBandsSchema`가 overall·steps 행의 `slow_us`를 받는다.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test speed_bands_test` → 컴파일 실패.
- [ ] **Step 3: 구현** — 규칙 2면 run 경계 `run_boundary(c).0 * 1000`, 스텝 경계 `step_boundary_us`, `count_bands_us`는 `count_bands`와 같은 루프에서 `v.value_iterated_to()`(µs)를 `slow_us`·`FAST_MS * 1000`과 비교하고 `slow_ms = slow_us / 1000`, `slow_us = Some(slow_us)`. 규칙 1 경로는 글자 그대로. UI: `boundaryMs`를 쓰도록 `speedBands.ts` 7줄·`speedCompare.ts` 4줄을 바꾼다(같음 판정은 `boundaryMs(b) === boundaryMs(a)`).
- [ ] **Step 4: 골든 확인** — 골든은 규칙 1: `whole_report_matches_golden` 재생성 없이 PASS.
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` PASS, UI 게이트 PASS.
- [ ] **Step 6: 되돌려 확인** — `count_bands_us` 비교를 `/ 1_000` ms 비교로 되돌려 `rule2_counts_by_us` RED → 원복.
- [ ] **Step 7: 커밋** — `feat(controller): 규칙 2 응답 속도 구간을 µs 경계로 (slow_us)`.

### Task 6: 판정 표·배지 표시 + 백분위 이름 문법 UI 쪽 (R19·R4 UI)

**Files:**
- Create: `ui/src/api/percentileName.ts`, Test: `ui/src/api/__tests__/percentileName.test.ts`(spec R4의 UI 쪽 — 같은 `testdata/percentile_metric_cases.json`)
- Modify: `ui/src/components/report/verdictFormat.ts`
- Modify: `ui/src/components/report/VerdictPanel.tsx`, `ui/src/components/VerdictBadge.tsx`
- Modify: `ui/src/components/report/format.ts`(`msNumberText`), `ui/src/print/format.ts`(`fmtMsExact`가 `msNumberText`를 쓴다 — 출력 불변)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/VerdictPanel.test.tsx`, `ui/src/components/__tests__/VerdictBadge.test.tsx`, `ui/src/components/report/__tests__/format.test.ts`

**Interfaces:**
- Consumes: Task 4의 와이어 `capped`(UI `CriterionResultSchema`), 결과 행 이름 `mean_ms`·`max_ms`·`p<N>_ms`.
- Produces: `parsePercentileMetric(name: string): number | null`(정본 이름만 N, 서버 `parse_percentile_metric`과 같은 규칙)·`percentileMetricName(input: string): string | null`(입력 글자 → 정본 이름, 0 < N < 100·소수 3자리까지 아니면 null — ③b 입력 화면이 쓴다)(둘 다 `ui/src/api/percentileName.ts`), `metricLabel(metric: string): string`, `msNumberText(ms: number): string`(소수 3자리 반올림·뒤 0 생략·en-US 쉼표 — 지금 `fmtMsExact`의 숫자 부분과 같은 식), `fmt(metric, v)` 시간 값 = `${msNumberText(v)} ms`, `actualText(c)` = `no_sample` → 기존 문구 / `capped` → `≥ ${fmt(..)}` / 그 밖 `fmt(..)`.

- [ ] **Step 1: 실패하는 테스트 쓰기**:
  - `percentileName.test.ts`: `testdata/percentile_metric_cases.json`을 `nodePath.resolve(__dirname, "../../../../testdata/percentile_metric_cases.json")`로 읽어(`ui/src/print/__tests__/stairPrint.test.tsx`의 읽는 방식) `names`마다 `parsePercentileMetric(input) === percentile`, `numbers`마다 `percentileMetricName(input) === name`.
  - `format.test.ts`: `msNumberText(43.903) === "43.903"`, `(4210) === "4,210"`, `(0.35) === "0.35"`, `(1842.6130000001) === "1,842.613"`, `(60000) === "60,000"`.
  - `VerdictPanel.test.tsx`: 행 `{metric:"p95_ms", threshold:43, actual:43.903, passed:false}` → 기준 「≤ 43 ms」·실측 「43.903 ms」; `{metric:"p95_ms", threshold:5000, actual:4210}` → 「≤ 5,000 ms」·「4,210 ms」(옛 run 숫자, 쉼표만); `mean_ms` → 「평균 응답 시간」, `max_ms` → 「최대 응답 시간」, `p99.9_ms` → 「p99.9」; `capped: true` 행 → 실측 「≥ 60,000 ms」·「≥ 1,842.613 ms」, 표 아래 안내 문구(아래 Step 3 글자)가 보인다; `capped` 행이 없으면 안내 없음. 기존 `420 ms` 단언은 그대로 통과.
  - `VerdictBadge.test.tsx`: 실패 행 툴팁에 「평균 응답 시간 ≥ 1,842.613 ms > 1,000 ms」처럼 이름·「≥」·쉼표. 기존 단언 중 1000 이상 ms 글자가 있으면 쉼표로 바뀐다(`grep -rnE "[0-9]{4,} ms" ui/src/components/__tests__/VerdictBadge.test.tsx ui/src/components/report/__tests__/VerdictPanel.test.tsx ui/src/components/report/__tests__/verdictNoSample.test.tsx`로 찾아 사용자 결정대로 고친다 — 그 밖의 단언은 건드리지 않는다).
  - print `format.test.ts` 기존 `fmtMsExact` 단언 무수정 통과(출력 불변 확인).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/api/__tests__/percentileName.test.ts src/components/report src/components/__tests__/VerdictBadge.test.tsx src/print/__tests__/format.test.ts` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — `percentileName.ts`: 서버 Task 2와 같은 규칙(가운데 글자 `^(0|[1-9][0-9]?)(\.[0-9]{1,3})?$`·0 < N < 100·소수 3자리 허용 오차 `Math.abs(x*1000 - Math.round(x*1000)) < 1e-6`·정본으로 다시 쓴 글자와 같을 때만). `metricLabel`: `METRIC_LABEL[metric]` → 없으면 `mean_ms`·`max_ms`는 ko 문구, `parsePercentileMetric(metric)`이 N이면 `p${N}`, 그 밖 `metric`. `fmt`의 시간 갈래(`metric.endsWith("_ms")`): `${msNumberText(v)} ms`. `VerdictPanel`·`VerdictBadge`는 `METRIC_LABEL[..] ?? ..` 대신 `metricLabel`. `VerdictPanel` 표 아래(`</table>` 뒤) `verdict.criteria.some(c => c.capped)`이면 `<p>`로 안내. ko 문구(목업 2번 그대로):
  - `ko.report.verdictMetricMean: "평균 응답 시간"`, `ko.report.verdictMetricMax: "최대 응답 시간"`
  - `ko.report.verdictCappedNote: "60초를 넘긴 응답이 있습니다. 그런 응답은 60초로 기록되므로 「≥」가 붙은 실측은 실제보다 작게 나온 값이고, 상한 기준은 실패로 판정합니다."`
  안내 상자 모양은 목업 `.callout`(노란 바탕·테두리) — 기존 노란 안내 상자 클래스가 있으면 그것을 쓴다(`grep -rn "amber-50\|bg-amber" ui/src/components/report | head`).
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` PASS.
- [ ] **Step 5: 되돌려 확인** — `actualText`의 `capped` 갈래를 빼서 「≥」 단언 RED → 원복.
- [ ] **Step 6: 커밋** — `feat(ui): 판정 표·배지 — 새 항목 이름·µs 실측·쉼표·60초 칸 「≥」`.

---

## 슬라이스 마무리(이 plan 밖, `/finish-slice`가 다룸 — 기록용)

- 최종 `handicap-reviewer`(와이어 1:1: Rust ↔ Zod 새 키 6종, 규칙 1 무변화) + `finish-slice` §0 보안 grep(요청 실행·템플릿 무접촉 예상).
- 라이브(`/live-verify`, curl): US5(43.9ms 응답기 + `max_p95_ms: 43` → 새 run ✗·`actual` 소수·속도 구간 「초과」), US6(변경 전 DB의 run을 새 바이너리로 → 판정·속도 구간 같음, `latency_rule: 1`), US1·US2의 서버 쪽(`max_mean_ms`·`max_percentiles_ms`를 curl로 건 run의 판정 행), 화면은 판정 표(Task 6)만 — 입력 화면은 ③b.
- roadmap §B 새 항목: spec §10 표 + 4차 검토의 「≥ 안내는 스텝 표 아래만」 판단 + roadmap §A17 항목 7 ④ 문구 정정(「판정은 ms 정수 그대로」 → 규칙 2 run은 소수). CLAUDE.md 「알아둘 결정들」에 ADR-0065 한 줄.
