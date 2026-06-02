# A4a: SLO / Pass-Fail Criteria — 설계

- 날짜: 2026-06-03
- 영역: A4 (LoadRunner급 리포트 깊이)의 첫 하위 슬라이스
- 출처: `docs/reviews/2026-06-02-roadmap-user-value-review-for-claude.md` (codex 사용자-가치 리뷰) → A4a 채택. ADR-0017이 명시적으로 연기한 "SLA(pass/fail)"의 실현.
- 선행: 영역 A(Run 프리셋, ADR-0024) · Slice 5(리포트, ADR-0017) 완료.

## 1. 목표 한 줄

종료된 run의 리포트에 **run-level SLO 기준(criteria)에 대한 pass/fail 판정(verdict)** 을 붙여, "이 run은 합격인가?"를 차트 읽기 없이 답한다. 도구를 "차트 뷰어"에서 "릴리스 게이트"로 옮기는 첫 수.

## 2. 범위 (이 슬라이스에서 하는 것 / 안 하는 것)

### IN

- run-level criteria 모델: p50/p95/p99 지연 상한, error_rate 상한, min_rps 하한.
- criteria를 run 설정(`profile_json`)에 스냅샷 저장 — 생성 시 동결, 불변.
- 리포트 빌드 시 on-demand verdict 계산(`ReportJson.verdict`).
- `validate_run_config`(runs + presets 공유 게이트)에 criteria 검증.
- RunDialog의 criteria 입력 UI(프리셋 저장/불러오기에 자동 포함).
- 리포트 페이지 verdict 패널(전체 PASS/FAIL 배지 + 기준별 테이블).

### OUT (의도적 연기 — §11에 출처)

- **step-level criteria**(특정 스텝 p95 등) — step_id 셀렉터 + loop/if 중첩 step_id 매칭 살집. → A4a' 또는 step/status가 들어올 때.
- **status-class criteria**(`5xx_count == 0` 등 생 status 분포 기반) — `status_distribution` 활용. → 후속.
- **run 목록 pass/fail 배지** — 목록은 메트릭이 없어 영속화(또는 행마다 리포트 빌드)가 필요. v1은 리포트 페이지만. → 명시적 fast-follow(§11).
- **per-window 최소 RPS**(지속 RPS 바닥) — v1 min_rps는 평균 rps 기준. → 후속.
- **일반 연산자 모델**(`{metric, op, threshold}` 자유 조합) — §10 참조, 출력 shape만 미리 일반화.
- run 비교/baseline(A4b), actionable 요약(A4c), CSV/Excel export, 트랜잭션 분해, 워터폴, 라이브 대시보드.

## 3. 핵심 결정 (확정)

| 결정 | 값 | 이유 |
|---|---|---|
| 판정 단위 | **run-level만** | step-level/status-class는 모델 살집이 커 후속. |
| criteria 모델 형태 | **고정 per-metric 임계값**(필드별 Option) | run-level 고정 소수 지표엔 연산자 자유도 불필요(YAGNI). 출력은 일반형으로 A2 대비(§10). |
| verdict 대상 | **completed run만** | 게이트는 정상 완주 run에만 의미. 비완료는 run status 자체가 이미 실패를 보임. |
| verdict 계산 위치 | **`build_report` on-demand**(B2) | 마이그레이션·완료-시점 훅 0. 모든 메트릭 정착 후 계산이라 race 없음. 멀티워커 finalize 경로 미접촉. |
| criteria 저장 | **`store::runs::Profile.criteria`** (`profile_json`, `#[serde(default)]`) | `data_binding` 선례와 동일. 마이그레이션 0(기존 행 default None), proto/엔진/워커 무변경, 프리셋 자동 포함. |

## 4. 데이터 모델 (controller)

`crates/controller/src/store/runs.rs`의 `Profile`에 `data_binding` 선례를 미러해 추가:

```rust
pub struct Profile {
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
    #[serde(default = "default_loop_cap")]
    pub loop_breakdown_cap: u32,
    #[serde(default)]
    pub data_binding: Option<crate::binding::DataBinding>,
    #[serde(default)]                       // ← 신규. 기존 profile_json 행은 None으로 역직렬화
    pub criteria: Option<Criteria>,
}

/// run-level SLO 기준. 모든 필드 Option — Some이면 활성 기준 1개. 전부 None이면 기준 없음.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Criteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p50_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p95_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p99_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error_rate: Option<f64>,        // 분수 0.0..=1.0 (UI는 %로 입출력)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_rps: Option<f64>,
}

impl Criteria {
    /// 활성 기준이 하나라도 있는가. 전부 None이면 verdict를 만들지 않는다.
    pub fn has_any(&self) -> bool { /* 5개 필드 중 하나라도 Some */ }
}
```

- **프리셋 자동 포함**: `run_presets.profile_json`도 같은 `Profile`을 직렬화하므로, 프리셋 저장 시 criteria가 캡처되고 불러오기 시 prefill된다(영역 A의 prefill 이음새 재사용). 별도 작업 0.
- **불변 스냅샷**: criteria는 run 생성 시 profile에 복사·동결. 리포트는 그 스냅샷으로 평가하므로 가변 프리셋의 현재값을 옛 리포트에 읽지 않는다(codex 경고 충족).

## 5. verdict 모델 + 평가 (순수 함수)

`crates/controller/src/report.rs`(또는 신규 `crates/controller/src/criteria.rs`)에 순수 평가 함수.

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub passed: bool,                       // 모든 활성 기준 AND
    pub criteria: Vec<CriterionResult>,     // metric 고정 순서(p50,p95,p99,error_rate,rps)
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CriterionResult {
    pub metric: String,     // "p50_ms" | "p95_ms" | "p99_ms" | "error_rate" | "rps"
    pub direction: String,  // "max" | "min"  (A2/step 확장에도 출력 shape 유지)
    pub threshold: f64,
    pub actual: f64,
    pub passed: bool,
}

/// 순수: 입력만으로 결정적. 엣지(count==0)도 여기서 처리.
pub fn evaluate_criteria(c: &Criteria, s: &ReportSummary) -> Verdict;
```

### 평가 규칙

- 활성 기준(필드 Some)만 결과 행을 만든다.
- **출력 타입 계약**: `threshold`·`actual`은 정수 ms 기준이라도 항상 `f64`로 캐스트해 담는다(A2 일반 모델이 같은 출력 shape를 재사용하기 위함, §10). (N-1)
- `max_*` 지연: `actual = s.p{50,95,99}_ms as f64`, `passed = actual <= threshold`, direction `"max"`.
- `max_error_rate`: `actual = if s.count==0 { 0.0 } else { s.errors as f64 / s.count as f64 }`, `passed = actual <= threshold`, direction `"max"`.
- `min_rps`: `actual = s.rps`(summary의 평균 rps; `report.rs`에서 duration==0이면 `0.0`), `passed = actual >= threshold`, direction `"min"`. → count==0/duration==0인 degenerate completed run은 `actual=0`이라 `min_rps>0` 기준에서 fail(의도된 동작 — 테스트로 고정, §12). (N-2)
- `Verdict.passed = criteria.iter().all(|r| r.passed)`. 활성 기준이 없으면 verdict 자체를 만들지 않는다(§6) — 빈 `Verdict{passed:true, criteria:[]}`를 만들면 잘못된 "PASS"로 보이므로 금지. (N-3)

## 6. 리포트 배선 (B2, on-demand)

`build_report(run: &RunRow, …) -> ReportJson` — 시그니처 무변경(이미 `run.status`·`run.profile` 보유).

```rust
pub struct ReportJson {
    // … 기존 필드 …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,           // ← 신규
}

// summary 빌드 직후:
let verdict = match (run.status, run.profile.criteria.as_ref()) {
    (RunStatus::Completed, Some(c)) if c.has_any() => Some(evaluate_criteria(c, &summary)),
    _ => None,                              // 비완료 OR 기준 없음 → null
};
```

`GET /api/runs/{id}/report` 핸들러는 무변경(build_report 결과를 그대로 직렬화).

## 7. 검증 (`validate_run_config` 공유 게이트)

`crates/controller/src/api/runs.rs::validate_run_config`(runs 생성 + 프리셋 저장 공유)에 criteria 검증 추가. 위반은 기존 run-config 검증과 일관되게 `ApiError::BadRequest`(400):

- `max_error_rate`가 Some이면 `0.0..=1.0` 범위 + 유한(NaN/inf 거부).
- `min_rps`가 Some이면 `>= 0.0` + 유한.
- 지연 상한(u64)은 0 포함 허용(0ms는 불만족 기준이지 무효는 아님).
- (선택) 모든 필드 None인 `Some(Criteria)`는 허용 — verdict가 안 만들어질 뿐.

## 8. UI

### 8.1 와이어 스키마 — `ui/src/api/schemas.ts`

**두 군데 모두** 손봐야 한다 (criteria는 입력, verdict는 출력):

1. **`ProfileSchema`에 `criteria` 추가** — criteria가 backend `Profile`에 생기면 **모든 run/preset 응답의 `profile` 객체에 실려 온다.** `ProfileSchema`는 `.strict()`가 아닌 평범한 `z.object`라 키가 없어도 파싱 에러는 안 나지만 **criteria를 조용히 strip**한다 → prefill·run 응답에서 criteria 유실. 따라서 `ProfileSchema`에 `criteria: CriteriaSchema.nullish()` 추가 필수(파싱 깨짐 방지가 아니라 *기능*을 위해). (SF-5)
2. **`ReportSchema`에 `verdict` 추가** — 엔진 와이어 1:1:

```ts
const Criteria = z.object({                 // ProfileSchema에 nullish로
  max_p50_ms: z.number().int().nonnegative().optional(),
  max_p95_ms: z.number().int().nonnegative().optional(),
  max_p99_ms: z.number().int().nonnegative().optional(),
  max_error_rate: z.number().min(0).max(1).optional(),  // 분수 (UI 표시·입력은 %)
  min_rps: z.number().nonnegative().optional(),
});
const CriterionResult = z.object({
  metric: z.string(), direction: z.enum(["max", "min"]),
  threshold: z.number(), actual: z.number(), passed: z.boolean(),
});
const Verdict = z.object({ passed: z.boolean(), criteria: z.array(CriterionResult) });
// ReportSchema: verdict: Verdict.nullish()  (없으면 null/undefined)
```

> **출하 결합 불변식 (SF-2)**: `ReportSchema`는 `.strict()`라, backend가 `verdict` 키를 내보내는데 UI 스키마에 키가 없으면 **completed+criteria run의 리포트 파싱 전체가 거부**된다. 따라서 backend `verdict` 필드와 UI `verdict` 스키마는 **같은 슬라이스에서 함께 출하**해야 하며(이 슬라이스가 그렇다), `schemas.test.ts`의 verdict round-trip을 게이트로 둔다. (verdict는 None일 때 키 생략이라 criteria 없는 기존 run은 영향 없음. `ReportRunSchema.profile`은 `z.unknown()`이라 profile 안 criteria는 별개로 안전.)

### 8.2 입력 — `ui/src/components/RunDialog.tsx`

"SLO 기준" 섹션: 5개 선택적 숫자 입력(p50/p95/p99 ms, error_rate %, min rps). 빈 칸 = 미설정(undefined).

- **profile 생성 지점이 2곳 — 둘 다 criteria를 넣어야 한다 (SF-3)**:
  1. submit 시 `POST /api/runs` 본문 profile (`RunDialog.tsx:373-379` 부근).
  2. 프리셋 저장용 `currentInput()` profile (`RunDialog.tsx:132-138` 부근).
  한쪽만 넣으면 "프리셋 저장 시 criteria 자동 캡처"가 조용히 깨진다(run은 되는데 preset엔 누락).
- **error_rate 단위 변환**: UI는 **%**로 입출력(예: `1` → 저장 `0.01`), 백엔드는 분수. 변환 지점을 한 곳(직렬화 경계)에 둔다.
- **`runPrefill.ts`는 변경 불필요 (SF-5)**: `RunPrefill.profile`이 Zod `Profile` 타입이고 `normalizeProfile = ProfileSchema.parse`라, §8.1의 `ProfileSchema.criteria` 추가만으로 criteria가 prefill을 자동 통과한다. 별도 편집 없음.

### 8.3 출력 — `ui/src/components/report/ReportView.tsx`

상단에 verdict 패널:
- 전체 **PASS / FAIL** 배지 — **`StatusBadge`를 직접 확장하지 말 것**(`StatusBadge`는 5개 RunStatus만 받는 닫힌 `Record`라 PASS/FAIL을 못 그린다). 같은 Tailwind 배지 *이디엄*을 따르는 **새 작은 배지** 컴포넌트를 만든다. (SF-4)
- 기준 테이블: 행마다 metric 라벨 · 임계값 · 실측값 · pass/fail. 지연은 ms, error_rate는 %, rps는 1자리. direction으로 `≤`/`≥` 표기.
- `verdict`가 null/undefined면 패널 미렌더(기준 없음 OR 비완료 run).

## 9. error_rate 의미 — 명시된 한계

엔진 `error_count` = **transport 실패 + `Assertion::Status` 불일치 + extract 실패**(검증: `crates/engine/src/executor.rs`, `runner.rs`의 `outcome.error.is_some()`). status assertion이 없는 시나리오에서는 **생 4xx/5xx 응답이 error로 안 잡힌다.** 따라서 v1 `error_rate` criterion은 "엔진이 실패로 본 요청 비율"을 의미한다.

- "5xx면 무조건 fail"을 원하면: ① 시나리오 스텝에 status assertion을 넣거나, ② **status-class 후속**(OUT, §2)을 기다린다.
- 이 한계 자체가 status-class 후속의 사용자 가치를 부각한다 — 설계서/리포트 툴팁에 1줄 안내 권장.

## 10. A2(일반 연산자/step-level) 확장성

- **출력은 이미 일반형**: `CriterionResult{metric, direction, threshold, actual, passed}` + `Verdict{passed, criteria[]}`는 A2(연산자 리스트)·step-level이 들어와도 그대로 재사용 → 리포트 verdict 패널·Zod 스키마 불변.
- **입력만 마이그레이션**: 고정 필드 `Criteria`가 list(`[{metric, op, threshold, step_id?}]`)로 바뀔 때 `evaluate_criteria`와 RunDialog 입력만 손댄다. `profile_json`이라 `#[serde(default)]`로 점진 호환.

## 11. 연기 항목 (roadmap §B로 누적)

- **run 목록 pass/fail 배지**(fast-follow): 영속화(`verdict_json` 컬럼 + 완료 시 평가, migration) 또는 목록용 경량 요약 캐시. v1은 리포트 페이지만.
- **step-level criteria**: step_id 셀렉터 + 중첩 step_id 매칭.
- **status-class criteria**(생 5xx_count 등): `status_distribution` 기반.
- **per-window 최소 RPS**: 지속 RPS 바닥(현 평균 rps와 별개).
- **일반 연산자 모델**: §10.
- (A4b/A4c는 A4 영역의 별도 슬라이스 — 이 spec 범위 밖.)

## 12. 테스트 계획

- **엔진**: 변경 없음(테스트 없음).
- **controller unit**:
  - `evaluate_criteria`: 전부 통과 / 일부 실패 / error_rate·rps 경계값 / `count==0`(error_rate→0) / `duration==0`(rps→0이라 min_rps fail, N-2).
  - `build_report`: completed + criteria → `Some(verdict)`; (비완료 | 기준 없음) → `None`; **all-None `Some(Criteria)` → `None`(gate가 evaluate를 아예 호출 안 함, 빈 PASS 금지, N-3)**.
  - `validate_run_config`: error_rate 범위 밖 / NaN / 음수 rps 거부; 정상 통과.
- **UI(vitest/RTL)**:
  - RunDialog: criteria 입력 → `POST` 본문에 criteria 포함; %↔분수 변환; 프리셋 prefill.
  - ReportView: verdict pass/fail 패널 렌더; null → 미렌더.
  - schemas: verdict round-trip(`schemas.test.ts`).
- **게이트**: `cargo build/clippy/test --workspace`(pre-commit) + `cd ui && pnpm lint && pnpm test && pnpm build`(수동).

## 13. 영향 받는 파일(예상)

### 프로덕션
- `crates/controller/src/store/runs.rs` — `Profile.criteria`, `Criteria`, `has_any`.
- `crates/controller/src/report.rs` (또는 신규 `criteria.rs`) — `Verdict`, `CriterionResult`, `evaluate_criteria`, `build_report` 배선.
- `crates/controller/src/api/runs.rs` — `validate_run_config` criteria 검증.
- `ui/src/api/schemas.ts` — `ProfileSchema.criteria`(입력) + `ReportSchema.verdict`(출력).
- `ui/src/components/RunDialog.tsx` — criteria 입력 + **profile 생성 2곳**(submit·preset, §8.2/SF-3).
- `ui/src/components/report/ReportView.tsx` — verdict 패널(+ 신규 PASS/FAIL 배지, SF-4).

### `criteria: None`을 추가해야 컴파일되는 `runs::Profile {…}` 리터럴 (SF-1)
`Profile`이 `Default`를 파생하지 않아(`runs.rs:43`) `..Default::default()` 불가 — 비스프레드 신규 필드라 **아래 7곳 전부**에 `criteria: None` 명시 필요(전부 테스트 픽스처; pb::Profile 리터럴 `runs.rs:179`는 무관):
- `crates/controller/src/store/runs.rs:292`
- `crates/controller/src/store/presets.rs:194`
- `crates/controller/src/grpc/coordinator.rs:969` (`seed_run` 헬퍼)
- `crates/controller/src/api/runs.rs:358` (`unique_profile` 헬퍼)
- `crates/controller/src/report.rs:298` (`run_row` 헬퍼)
- `crates/controller/tests/crash_recovery_test.rs:28`
- `crates/controller/tests/report_test.rs:70`

> `Default` 파생으로 우회하지 말 것 — `loop_breakdown_cap`의 serde 기본값이 256(비-Default)이라 `Default::default()`는 0을 줘 의미가 달라진다. 7곳에 `criteria: None` 명시가 정답.

### 무변경
마이그레이션 · proto · 엔진 · 워커 · `ui/src/api/runPrefill.ts`(§8.2/SF-5): **변경 없음**.

## 14. ADR

신규 **ADR-0028** (Conditional/criteria 계열과 별개의 리포트 판정 결정): run-level SLO criteria — profile_json 스냅샷 저장, completed-only on-demand verdict, 고정 per-metric 모델(일반형 출력), error_rate=엔진 실패 비율. CLAUDE.md "알아둘 결정들"에 1줄.
