# Step-level + 일반 연산자 SLO criteria — 설계

- **상태**: 설계 승인 (2026-06-14). 구현 대기.
- **출처**: roadmap §B6 잔여 2항목 — "step-level criteria"(특정 스텝 p95 등) + "일반 연산자 모델"(`{metric, op, threshold}` 자유 조합).
- **ADR**: 신규 불필요 — **ADR-0028 범위 내 additive**(run-level SLO criteria의 step-level/일반연산자 확장). `Verdict` 출력은 ADR-0028 구현 때 이미 일반형(`{metric, direction, threshold, actual, passed}`)으로 만들어 둠(`store/runs.rs:49` 주석이 이 슬라이스를 명시 예고).
- **연관**: ADR-0028(SLO criteria·verdict 패턴), B6(status-class/per-window RPS criteria·verdict 배지), A4a(criteria 입력 UI).

---

## 1. 목표와 범위

### 1.1 목표
종료된 run 리포트의 SLO verdict가 **run 전체**뿐 아니라 **특정 스텝**을 기준으로 pass/fail을 판정하게 한다. 예: "로그인 스텝 p95 ≤ 300ms", "피드 스텝 5xx 비율 ≤ 1%". 동시에 metric×방향(max/min)을 자유 조합하는 일반 연산자 입력 모델을 step-level 리스트로 제공한다.

이 기능은 스케줄러(예약/반복 발사) + verdict 배지 + insights와 맞물려 **스텝 단위 회귀 감시 루프**를 완성한다(run-level만으로는 "전체는 통과인데 한 스텝이 느려짐"을 못 잡는다).

### 1.2 IN (이 슬라이스)
- 기존 fixed-field `Criteria`(`max_p50_ms` 등 11필드)는 **그대로 유지**하고, **가산** `step_criteria: Vec<Criterion>` 리스트를 추가한다.
- 각 `Criterion`은 `{metric, op, threshold, target}` — target은 **http-leaf step_id 필수**(step-level 전용 리스트).
- metric 어휘 **8종**: `p50_ms`, `p95_ms`, `p99_ms`, `error_rate`, `4xx_rate`, `5xx_rate`, `4xx_count`, `5xx_count`.
- op **2종**: `max`(actual ≤ threshold) / `min`(actual ≥ threshold) — 출력 `direction`과 1:1.
- 평가는 **리포트 경로 only**(`build_report`/`evaluate_criteria`). 엔진·워커·proto·migration **무변경**.
- 입력 검증: 범위(metric/op/threshold) + **create-time target 존재 검증**(시나리오 스냅샷의 http-leaf 아니면 400 거부).
- UI: RunDialog·ScheduleForm의 기존 collapsible "SLO 기준" 섹션 안에 step-criteria 행 편집기 + VerdictPanel/배지 tooltip의 step 표시.

### 1.3 OUT (연기 → §8)
- target optional(None=run-level) — 일반 연산자를 run-level에서도 쓰기. v1은 target 필수(8종 metric은 run-level에서 이미 fixed-field로 커버되므로 손실 없음). 모델은 relax가 순수 가산이 되게 설계.
- 풍부한 연산자(`==`/`<`/`>`/`!=`), step-level `rps`/min_window_rps(시계열 개념, ReportStep에 없음), per-window step criteria, loop_index/branch 단위 criteria, criteria의 CSV/XLSX export 열, 시계열 step SLO.

---

## 2. 데이터 모델 & 와이어 (가산, migration-0)

### 2.1 입력: `Criterion` + `Criteria.step_criteria`
`crates/controller/src/store/runs.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Criterion {
    pub metric: String,    // 8종 중 하나
    pub op: String,        // "max" | "min" (→ 출력 direction)
    pub threshold: f64,    // rate 0.0..=1.0, ms/count ≥ 0
    pub target: String,    // http-leaf step_id (v1 필수)
}
```

`Criteria` 구조체에 한 필드 추가:
```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub step_criteria: Vec<Criterion>,
```

- `Criteria`는 `profile_json`에 저장되고 이미 `#[serde(default)]` → **migration 불필요**, 옛 run은 빈 리스트로 역직렬화, `skip_serializing_if = "Vec::is_empty"`라 **빈 리스트면 직렬화에서 생략 → byte-identical**.
- `Criteria::has_any()`를 확장: `|| !self.step_criteria.is_empty()`. step-only criteria도 verdict를 만들게.

### 2.2 출력: `CriterionResult.target`
`crates/controller/src/report.rs`의 `CriterionResult`에 한 필드 추가:
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub target: Option<String>,  // step_id; fixed-field run-level 행은 None
```
- 출력 shape는 여전히 일반형 `{metric, direction, threshold, actual, passed, target?}`.
- fixed-field 행은 `target: None`(생략) → **기존 출력 byte-identical**. step 행만 `target: Some(step_id)`.
- **`CriterionResult { … }` struct 리터럴 churn**: `CriterionResult`엔 `Default` derive가 없어 새 필드 추가 시 모든 리터럴에 `target: None` 명시 필요. report.rs 외 **2곳**: `crates/controller/src/insights.rs:330`(테스트 헬퍼 `verdict()`), `crates/controller/src/store/schedules.rs:617`(테스트 fixture). export.rs는 `verdict: None`이라 리터럴 없음. 컴파일러-driven이나 §7 테스트 계획·churn 목록에 포함.

### 2.3 metric → ReportStep 추출 매핑 (평가 §3)
| metric | step actual |
|---|---|
| `p50_ms`/`p95_ms`/`p99_ms` | `ReportStep.{p50,p95,p99}_ms` |
| `error_rate` | `error_count / count` (count==0 → no-data skip, §3.3) |
| `4xx_rate`/`5xx_rate` | `status_class_count(status_counts,'4'/'5') / http_response_total(status_counts)` (공유 헬퍼 재사용) |
| `4xx_count`/`5xx_count` | `status_class_count(status_counts,'4'/'5')` |

`http_response_total`/`status_class_count`는 이미 `report.rs`의 `pub(crate)` 공유 헬퍼(B6에서 insights와 단일화). step `status_counts`에 그대로 적용 — 인라인 복제 금지.

---

## 3. 평가 의미 (`evaluate_criteria`)

### 3.1 시그니처 확장
```rust
pub fn evaluate_criteria(
    c: &Criteria,
    s: &ReportSummary,
    status_dist: &BTreeMap<String, u64>,
    windows: &[ReportWindow],
    steps: &[ReportStep],   // ← 신규
) -> Verdict
```
- `build_report`는 `steps`를 verdict 계산(report.rs:550) **이전**(report.rs:516)에 이미 빌드하고 verdict 시점에 in-scope(line 559 `derive_insights`도 `&steps` 사용) → `&steps`를 그대로 전달. 추가 집계 0.
- 호출부: prod 1곳(build_report:552) + report.rs 인라인 테스트 **10곳**(966·982·996·1006·1130·1144·1156·1203·1222·1575 — 대부분 fixed-field 테스트라 `&[]` 추가, 컴파일러-driven). export·compare 경로는 `evaluate_criteria`를 직접 호출하지 않음(`build_report` 경유)이라 무변경.

### 3.2 행 생성 순서
1. 기존 fixed-field 행(p50/p95/p99 → error_rate → 4xx/5xx rate → 4xx/5xx count → rps → min_window_rps) — **불변, target=None**.
2. 그 뒤에 `step_criteria` 행을 **리스트 순서대로** append(target=Some). 결정론적 = 입력 순서.

### 3.3 step 행 평가
각 `Criterion`에 대해 `steps`에서 `step.step_id == criterion.target`인 `ReportStep`을 찾는다.
- **있고 `count > 0`**: §2.3 매핑으로 actual 계산 → op로 pass(`≤`/`≥`) 판정 → 행 push(metric=criterion.metric, direction=criterion.op, threshold, actual, passed, target).
- **없거나 `count == 0`** (스텝이 실행 안 됨 — 미도달 if 분기 등 / 또는 데이터 없음): **행을 생성하지 않고 skip**(거짓 FAIL 금지). 기존 `min_window_rps` "eligible 부족 → skip" 규칙과 동형.
- **중첩 투명성**: loop/if/parallel 안의 http leaf도 자기 step_id로 `report.steps`에 집계되므로 target 매칭이 그대로 동작한다(loop 안 스텝 p95 = 모든 iteration 합산 p95). 추가 코드 불필요.

### 3.4 verdict.passed & 전부-skip → None
`passed = 모든 (생성된) 행의 passed AND`. skip된 step 행은 행 자체가 없어 영향 없음.

전 기준이 skip이면(fixed-field도 없고 step도 전부 skip → `v.criteria` 빈 배열) `build_report`(report.rs:553 `if v.criteria.is_empty() { None }`)가 **verdict를 None으로** 만든다 — 기존 동작 그대로(B6 "전 기준 skip → verdict None"과 동형, `min_window_rps`-only 짧은 run 선례 `build_report_verdict_none_when_only_window_rps_and_short_run`). 즉 step-only criteria가 전부 미실행 스텝을 가리키면 verdict 없음. `has_any()` 확장은 "verdict 평가를 시도할지" 게이트(line 551)일 뿐, 빈-결과 nullify는 line 553이 이미 처리하므로 추가 분기 불요. 이 동작을 step-only-all-skip 회귀 테스트로 고정.

---

## 4. 입력 검증

기존 검증 구조: `validate_run_config(state, profile)` 안에서 fixed-field criteria 범위는 순수 헬퍼 `validate_criteria(&Criteria) -> Result<(),String>`가 검증하고, dataset 컬럼 존재 같은 cross-resource 검증도 `validate_run_config` 안에서 한다. 시나리오는 `validate_run_config`에 안 들어오지만(profile만), **4개 실호출부 전부 시나리오를 이미 보유**(run-create·preset create/update·schedule create/update·schedule fire).

### 4.1 범위 검증 — `validate_criteria` 확장 (시나리오 불필요, 항상 강제)
`validate_criteria(c)`에 step_criteria 루프 추가:
- `metric` ∈ 8종 집합 — 아니면 `criteria.step_criteria[i].metric '{m}'은 지원하지 않습니다`.
- `op` ∈ {`max`,`min`} — 아니면 거부.
- `threshold`: `is_finite()` 필수. rate metric(`error_rate`/`4xx_rate`/`5xx_rate`)이면 `0.0..=1.0`, ms/count metric이면 `≥ 0.0`.
- `target`: 비어있지 않은 문자열(공백-only 거부) — 존재 검증은 §4.2(시나리오 필요).

`validate_criteria`는 `validate_run_config` 안에서 호출되므로 **모든 실호출부가 범위 검증을 자동 통과**(call-site 누락 위험 없음). 호출부 시그니처 churn 0.

### 4.2 target 존재 검증 — 신규 sibling, 4개 실호출부에서 호출
```rust
pub(crate) fn validate_step_criteria_targets(
    profile: &Profile,
    scenario_yaml: &str,
) -> Result<(), ApiError>
```
- `profile.criteria`는 `Option<Criteria>`라 navigate에 guard 필요: `profile.criteria.as_ref().map_or(true, |c| c.step_criteria.is_empty())`면 **즉시 Ok**(시나리오 파싱 skip → 무비용·하위호환).
- 비어있지 않으면 `Scenario::from_yaml(scenario_yaml)`(`Result<Scenario>` anyhow) → http-leaf step_id 집합 수집(아래) → 각 `target`이 집합에 있는지 검사, 없으면 `ApiError::BadRequest("criteria target '{id}'은 시나리오의 http 스텝이 아닙니다")`.
- 파싱 실패 시(스냅샷이 깨졌을 리 없지만 방어): BadRequest.

**http-leaf 수집 walk**: `api/scenarios.rs::validate_parallel_branch_names`(scenarios.rs:19, `handicap_engine::{Scenario, Step}` import)의 재귀 `Step` walk를 미러한 헬퍼 `collect_http_step_ids(steps, &mut set)` — `Step::Http(h)` → `set.insert(h.id.clone())`, `Step::Loop(l)` → recurse `l.do_`, `Step::If(i)` → recurse `then_`/`elif[].then_`/`else_`(엔진 필드명 **trailing underscore**, scenario.rs:95-150), `Step::Parallel(p)` → recurse 각 `branch.steps`. **container 노드 id(loop/if/parallel)는 수집 안 함** — ReportStep latency가 없어 target 불가(UI step picker도 http leaf만 노출 = 1:1). `Step::id()`(scenario.rs:50, 모든 변형의 id 반환)가 이미 있으나 leaf만 골라야 하므로 match로 `Http`만 수집. `Step` match는 exhaustive라 새 Step 변형 추가 시 컴파일러가 이 walk 갱신을 강제(insights `collect_unconditional`·`validate_parallel_branch_names`에 이은 세 번째 시나리오-walk 사이트).

**호출 위치**(`validate_run_config` 호출 직후) — ⚠ **호출부마다 시나리오 확보 비용이 다르다**(spec-review 발견):
- `api/runs.rs::create` (run-create, 459) — `scenario`(`.yaml`) 이미 보유(runs.rs:455). 1줄.
- `api/presets.rs::create` (84) — `scenarios::get`로 가져온 scenario를 현재 `_` 폐기(77) → **캡처**해 사용. 1줄.
- **`api/presets.rs::update` (135) — 시나리오 미보유(`Path`=preset id, scenario fetch 없음)**. preset → `scenario_id` 조회 → `scenarios::get(&state.db, &scenario_id)` **신규 fetch 추가** 필요(3~4줄). "각 1줄·4 호출부 전부 보유"가 이 호출부에선 거짓 — plan이 별도 step으로 예산.
- `api/schedules.rs` 공통 검증 게이트(182) — 404 체크로 가져온 scenario(현재 폐기) 캡처. 게이트가 create+update 공유라 1곳 수정으로 둘 다 커버.
- `schedule/runner.rs` fire 루프(142) — `scenarios::get`(106)로 가져온 scenario 보유. **발사마다 재검증**(TOCTOU: 스케줄 생성 후 시나리오에서 스텝 삭제 시 발사 시점에 거부).

> 분리 근거: 범위 검증은 profile-only(순수, 항상 강제) ↔ target 존재는 cross-reference(시나리오 의존, dataset 컬럼 검증과 동류). dataset 컬럼은 `dataset_id`가 profile 안에 있어 `validate_run_config`가 직접 fetch하지만, scenario_id는 profile에 없어 호출부가 주입해야 한다. `validate_run_config` 시그니처(+30 테스트 호출부)를 안 건드리는 최소 churn 선택.

---

## 5. UI

### 5.1 모델/와이어 (Zod, `ui/src/api/schemas.ts`) + profileForm 게이트
- 입력 payload: `profileForm.ts`가 `criteria` 객체에 `step_criteria: Criterion[]`을 추가 빌드. fixed-field는 그대로. **단 게이트 3곳 갱신**(spec-review 발견):
  - `buildCriteria`(profileForm.ts:72-86)의 early-return `Object.keys(c).length > 0`(85) — **step-only criteria**(fixed 전부 빔 + step_criteria 있음)도 non-undefined `Criteria`를 반환하게 조건에 `|| step_criteria.length > 0` 가산.
  - `criteriaHasValue`(52-54): step_criteria 있으면 true → SLO 섹션 자동 펼침(`ui/CLAUDE.md` collapsible 선례).
  - `criteriaActiveCount`(57-70): step_criteria 행 수를 "N개 설정됨" 힌트에 합산.
  - `CriteriaState`(flat string-draft)에 `stepCriteria: 행드래프트[]` 서브배열 추가 — RunDialog·ScheduleForm 공유 타입 구조 변경(둘 다 소비, `profileForm.ts` 단일 소스).
- 응답 파싱: `RunSchema`/`PresetSchema`/`ScheduleSchema`의 `profile.criteria`에 `step_criteria` 배열 추가 — **plain 타입**(`.default()` 누출 금지). 빈 리스트는 서버가 `skip_serializing_if`로 생략 → Zod `.optional()`(absent) — `data_binding`/`stages` 선례와 동일(`.nullish()` 불요, null로 안 옴).
- 출력: `CriterionResultSchema`(schemas.ts:84, VerdictPanel용)에 `target: z.string().nullish()` 추가(서버 `Option`·`skip_serializing_if` → absent거나 string; nullish가 안전).

### 5.2 입력 편집기 — `StepCriteriaFields` (신규, 프레젠테이셔널)
기존 collapsible "SLO 기준 (선택)" 섹션 **안에** fixed-field `CriteriaFields` 아래로 배치. 반복 행(stage 에디터·KeyValueGrid 패턴):
- 행 = **step picker**(`flattenHttpSteps(scenario.steps)` → http leaf만, `name·method·url` 표시 / 빈 url은 id) + **metric** `<select>`(8종) + **op** `<select>`(max/min) + **threshold** `<input type=number>`.
- threshold 단위: rate metric(`*_rate`)이면 `%` 라벨 + 제출 시 `/100`(fixed-field `maxErrPct` 선례), ms/count면 raw. 행 로컬 string-draft → 제출 시 Number 변환(stage 행 패턴, onBlur-commit 불요 — RunDialog submit이 commit 경계).
- "+ 기준 추가"/행 "×". scenario 없음(파싱 실패)이면 step picker 비활성 + 안내.
- a11y: 행 region/label은 KeyValueGrid 컨벤션 따름.

`scenario`는 RunDialog(`scenario: Scenario|null`, RunDialog.tsx:43)·ScheduleForm(`parsedScenario`, 56-62) 둘 다 이미 보유(DataBindingPanel·flowvars용 파싱). `flattenHttpSteps`/`findStepById`는 `scenario/model.ts:263/324`. `profileForm.ts`(공유 추출, 34c)가 `buildCriteria`에서 step_criteria도 빌드 → RunDialog·ScheduleForm 단일 소스.

**ScheduleForm 시나리오 변경 reseed**(spec-review 발견): ScheduleForm은 시나리오 드롭다운(ScheduleForm.tsx:258)이라 변경 시 step_criteria 행의 target이 dangling. 기존 `DataBindingPanel` **reseed-by-key 패턴**(34c)을 따라 StepCriteriaFields도 시나리오 변경 시 행 초기화(panelKey bump 또는 같은 키로 remount). RunDialog는 per-scenario 1회 마운트라 무관.

### 5.3 출력 렌더 — VerdictPanel + 배지 tooltip
- **VerdictPanel은 steps prop 신규 배선**(spec-review 발견): 현재 `VerdictPanel({ verdict })`만 받음(VerdictPanel.tsx) → scenario steps 미보유. ReportView(`ReportView.tsx:62-179`)가 이미 `scenario_yaml`을 파싱해 `stepMeta`/`ifMeta`를 만드므로, 그 steps(또는 meta lookup)를 VerdictPanel에 **새 prop으로 전달**(BranchStatsTable의 `ifMeta` 선례). `target` 행은 `findStepById(steps, target)` → step 표시명(`name`/method·url) 앞에 붙임. fixed-field 행(target 없음)은 기존대로.
- **행 key 충돌 수정**(spec-review 발견): `VerdictPanel.tsx:29`가 `key={r.metric}` — 같은 metric을 다른 target에(login p95 + feed p95), 또는 fixed-field p95와 step p95가 공존하면 **React key 중복**. `key={`${r.metric}-${r.target ?? ""}-${idx}`}`로 변경.
- metric 문자열이 fixed-field와 동일(`4xx_rate` 등)하므로 `fmt`(verdictFormat.ts)의 단위 포맷(%/ms/count)이 step 행에도 그대로 적용 — 새 포맷 분기 불요, step은 target 라벨만 추가.
- **VerdictBadge tooltip은 raw step_id로 degrade**(spec-review 결정): `VerdictBadge`(VerdictBadge.tsx)는 run 목록·스케줄 타임라인(`ScheduleEventTimeline.tsx:46`) 컨텍스트에서 쓰이고 **scenario steps에 접근 불가**(per-event 시나리오 plumbing은 과도). FAIL tooltip의 step 행은 `target`(raw step_id)을 그대로 표시(또는 metric 옆 짧은 id). 풀 step명은 VerdictPanel(리포트 본문)에서만. 이 비대칭은 의도된 degrade — §8 연기에 "배지 step명 plumbing".

---

## 6. 하위호환 & byte-identical 보장
- `step_criteria` 빈 = `skip_serializing_if` 생략 → profile_json·report JSON **byte-identical**. 기존 run/preset/schedule·골든 fixture 무영향.
- 엔진·워커·proto·migration·`MetricBatch`·export(CSV/XLSX) 스키마 **전부 무변경**(리포트 verdict 경로만).
- fixed-field criteria 행 출력은 `target` 생략으로 기존과 동일.
- `Criteria`/`Verdict`는 typed round-trip(report.rs deser 테스트)이 강제 — 새 필드에 양방향 derive 유지.

---

## 7. 테스트 & 검증
- **Rust 단위**(report.rs): step 행 pass/fail(8 metric × max/min), 중첩 스텝 target(loop 안 http leaf), no-data/`count==0` skip, rate 분모(`http_response_total` 재사용), 출력 순서(fixed → step append), 전부-skip verdict(빈 criteria=PASS), `has_any` step-only.
- **Rust 단위**(api/runs.rs): `validate_criteria` step 범위(미지원 metric/op·rate>1·음수·NaN), `validate_step_criteria_targets`(없는 target 400, http-leaf-아닌 container id 400, 중첩 http leaf OK, 빈 step_criteria Ok·시나리오 파싱 skip). 컴파일러-driven 리터럴 fixup(`insights.rs:330`·`schedules.rs:617` `target: None`)은 빌드 게이트가 강제.
- **통합**(controller): run-create payload에 step_criteria → `/report` verdict에 step 행 존재(터미널). preset create+**update**(신규 scenario fetch 경로)·schedule 경로 target 검증.
- **UI**(vitest): `StepCriteriaFields` 행 add/remove·metric별 단위, `profileForm` payload 빌드(% 변환) + **step-only** criteria(fixed 빔)도 `buildCriteria` 반환·`criteriaActiveCount` 합산, VerdictPanel target 렌더 + **같은 metric 다중 target 행 key 무충돌**(회귀), `ReportSchema`가 step-criteria verdict JSON 파싱(`.nullish()` target).
- **라이브**(머지 전 필수, S-D 갭): controller+worker 띄우고 step-targeted `p95` criterion run 1회 → VerdictPanel에 step명 + PASS/FAIL 행, 실 `/report` JSON `ReportSchema.parse` 통과. 빈 step_criteria run → report byte-identical 확인.

---

## 8. 연기 (future)
- **target optional(run-level 일반 연산자)**: `Criterion.target`을 `Option<String>`으로 relax(순수 가산: 필수→옵션). None이면 summary 평가. v1 8종 metric은 run-level fixed-field와 중복이라 손실 없음 — 미래 `rps`/`min_window_rps`를 step set 밖 run-level-list metric으로 열 때 자연히 필요.
- 풍부한 연산자(`==`/`<`/`>`/`!=`/근사), step-level `rps`·per-window·loop_index/branch criteria, criteria의 CSV/XLSX export 열, run 목록 step-fail 필터/정렬, baseline-상대 polarity, step SLO 시계열.
- **VerdictBadge tooltip step명 plumbing**: v1은 배지(run 목록·스케줄 타임라인) FAIL tooltip이 step을 raw step_id로 표시(§5.3 degrade). per-event 시나리오 steps를 배지에 흘리면 풀 step명 가능 — 비용 대비 저가치라 연기.

---

## 9. 결정 로그 (brainstorming 2026-06-14)
1. **입력 모델**: 가산 리스트(fixed-field 유지) — fixed→일반 전면 이주 기각(profile_json 하위호환·11 UI·다수 테스트 재작성 비용, repo의 additive·byte-identical 관례 위배).
2. **metric 어휘**: 전체 패리티 8종(rps/min_window_rps 제외 = run-level 전용·ReportStep 부재).
3. **op**: max/min 2종(= 출력 direction 1:1). `==`/`<`/`>` YAGNI 연기.
4. **target**: v1 필수(step-level 전용 리스트). 모델은 일반형 유지 → optional relax가 순수 가산(사용자: "확장성 필요 시 고려").
5. **target 존재 검증**: create-time 거부(400) + fire-time 재검증. 시나리오 http-leaf 집합 대조.
6. **no-data/count==0**: 행 skip(거짓 FAIL 금지, min_window_rps 선례).
