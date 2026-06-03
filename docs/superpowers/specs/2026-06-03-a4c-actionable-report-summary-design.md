# A4c: Actionable Report Summary — 설계

- 날짜: 2026-06-03
- 영역: A4 (LoadRunner급 리포트 깊이)의 세 번째이자 마지막 하위 슬라이스
- 출처: `docs/reviews/2026-06-02-roadmap-user-value-review-for-claude.md` §A4c "Actionable Report Summary" (codex 사용자-가치 리뷰) → A4a(verdict, ADR-0028) + A4b(run 비교/export, ADR-0030)에 이은 마무리.
- 선행: A4a(`ReportJson.verdict`) · A4b(`export.rs`, `build_report_for_run`) · Slice 5(리포트, ADR-0017) 완료.

## 1. 목표 한 줄

종료된 run 리포트 **최상단에 "무엇을 봐야 하는지"를 알려주는 결정론적 인사이트 패널**을 붙여, 차트·표를 읽지 않고도 "이 run의 핵심 문제가 무엇인가"를 답한다. A4a verdict("합격인가?")에 이어 도구를 "차트 뷰어"에서 "릴리스 게이트 + 진단기"로 옮기는 마지막 수.

## 2. 범위 (이 슬라이스에서 하는 것 / 안 하는 것)

### IN

- `ReportJson.insights: Vec<Insight>` — `build_report`가 이미 만든 `summary`/`steps`/`status_distribution`/`verdict`/`windows` + 파싱한 `scenario_yaml`에서 파생하는 **순수 함수 `derive_insights`**.
- v1 인사이트 7종(아래 §5): run_health(헤드라인) · slowest_step · error_hotspot · no_request_step · slo_failure/slo_pass · status_class · status_temporal.
- 인사이트는 **구조화(structured)만** emit하고 표시 텍스트(한국어)는 UI가 렌더 — 코드베이스 관례(스텝 라벨·verdict 텍스트가 UI 책임)와 일치.
- UI `InsightPanel` — 리포트 최상단(VerdictPanel 위), severity 정렬, 한 줄 메시지 + 색/아이콘.
- 단일-run XLSX export에 **Insights 시트** 추가(구조화 컬럼). JSON 리포트엔 `ReportJson`에 포함되므로 자동.
- 테스트: `derive_insights` Rust 단위(no-data / all-pass / error-heavy) + XLSX 라운드트립(Insights 시트) + UI RTL(`InsightPanel` 종류별·정렬·빈 케이스) + Zod 와이어 1:1.

### OUT (의도적 연기 — §9에 출처)

- **baseline 대비 회귀 인사이트** ("p95가 baseline 대비 34% 회귀") — 단일-run 리포트엔 baseline이 없음. A4b 비교 페이지(`/scenarios/{id}/compare`) 연계로 후속. 리뷰도 "if baseline selected" 조건부.
- **status-class verdict 기준** (`5xx_count == 0` 같은 pass/fail 게이트) — A4a Criteria 모델 확장(RunDialog 입력 + `validate_run_config` + `profile_json` 필드 + verdict 평가). 별도 성격 = A4a' 후속. v1은 status-class를 **정보성 인사이트로만**.
- **CSV 인사이트** — 단일-run `report.csv`는 스텝별 테이블 1장(단일 테이블)이라 이종 구조 인사이트를 못 섞음. XLSX 시트 + JSON으로 충분.
- **compare export 인사이트** — 인사이트는 per-run 파생이라 비교 export엔 run별 인사이트 컬럼 설계가 추가로 필요. 범위 밖.
- AI 서술(narrative), 근인(root-cause) 주장, APM 연동, 통계적 유의성.

## 3. 핵심 결정 (확정)

| 결정 | 값 | 이유 |
|---|---|---|
| 계산 위치 | **백엔드 `build_report` on-demand** | 부하 종료 후 계산이라 성능 영향 0. A4a verdict와 동일 패턴. 단일 소스 → JSON/XLSX export 무료 포함. 마이그레이션·proto·워커 무변경. |
| 표시 텍스트 | **구조화 emit, UI가 한국어 렌더** | 스텝 라벨·verdict 텍스트가 UI 책임인 관례와 일치(한국어 문자열은 UI에 삶). derivation은 백엔드 단일 소스라 compare 골든 fixture 같은 TS↔Rust 패리티 **불필요**(UI는 렌더만). |
| 모델 형태 | **평탄 `Insight` 구조체 + `kind` 판별자** | `CriterionResult` 선례(평탄). XLSX Insights 시트가 **균일 컬럼**으로 덤프 가능(tagged enum이면 variant별 컬럼 추출 필요). |
| 인사이트 정렬 | **백엔드가 결정론적 순서로 emit** | export·UI가 같은 순서를 본다(UI 재정렬 불필요, 비결정성 0). |
| no_request_step 범위 | **무조건 도달 http 스텝만**(top-level + loop 본문 repeat≥1; if/elif/else 분기 제외) | if 분기 스텝의 0건은 *정상*(미선택 분기) → false-alarm 방지. "무조건 실행될 스텝이 0건"만 actionable. |
| 인사이트 export | **단일-run XLSX Insights 시트 + JSON**. CSV·compare 무변경 | XLSX는 멀티시트(Branches 시트 선례). CSV는 단일 테이블 관례 유지. |

## 4. 데이터 모델 (controller `report.rs`)

`Verdict`/`CriterionResult` 옆에 추가. 모든 선택 필드는 `kind`에 따라 채워진다(나머지는 `None`):

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Insight {
    pub kind: String,     // 판별자(아래 §5)
    pub severity: String, // "critical" | "warning" | "info"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,      // "p95_ms" 등
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,          // 지표 실측치
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,            // 분수(0..1) — 점유율
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,          // 건수 / 실패 기준 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_class: Option<String>, // "4xx" | "5xx"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<i64>, // status_temporal: 5xx가 등장한 "마지막 N초"
}
```

`ReportJson`에 `pub insights: Vec<Insight>` 필드 추가(빈 vec 기본, 항상 emit). `Deserialize`도 함께(report.rs 관례 — typed round-trip 테스트가 강제).

UI Zod 미러(`ui/src/api/schemas.ts`)는 선택 필드 `.optional()`(serde `skip_serializing_if`와 lockstep), `severity`는 `z.enum(["critical","warning","info"])`. `ReportSchema.insights`는 `.optional()` + 소비처 `?? []`(if_breakdown 패턴).

## 5. v1 인사이트 7종 — 파생 규칙 · 조건부 emit · severity

**emit 순서 = `run_health`(헤드라인) 항상 첫째, 그다음 나머지를 severity rank(critical → warning → info)로.** `run_health`는 severity 정렬에서 빠지는 **고정 헤드라인**(패널의 토픽 문장)이고, 나머지는 조건 충족 시에만 push된다. 같은 severity 내 순서는 아래 표 순서로 고정(결정론적).

| # | kind | emit 조건 | severity | 채우는 필드 | UI 렌더(예시) |
|---|---|---|---|---|---|
| 0 | `run_health` | **항상**(헤드라인) | info(headline) | `count`(=summary.count), `value`(=summary.rps), `count` 외 errors는 UI가 summary에서 | "총 12,400건 · 410 req/s · 에러 0건" |
| 1 | `slo_failure` | `verdict.passed == false` | critical | `count`(실패 기준 수) | "SLO 실패: 2개 기준 미달" (상세는 아래 VerdictPanel) |
| 2 | `status_class` (5xx) | 5xx 합계 > 0 | critical | `status_class="5xx"`, `pct`, `count` | "5xx가 응답의 12% (1,203건)" |
| 3 | `no_request_step` | 무조건 도달 http 스텝이 메트릭 0건(스텝마다 1개) | warning | `step_id` | "스텝 profile에 요청이 기록되지 않음" |
| 4 | `error_hotspot` | 전체 `errors > 0` (최다 점유 스텝 1개) | warning | `step_id`, `pct`(해당 스텝 errors / 전체 errors), `count`(해당 스텝 errors) | "스텝 login이 에러의 82% (902건)" |
| 5 | `status_class` (4xx) | 4xx 합계 > 0 | warning | `status_class="4xx"`, `pct`, `count` | "4xx가 응답의 5% (510건)" |
| 6 | `status_temporal` | 5xx가 존재하고 run 후반부에 집중(아래 정의) | warning | `status_class="5xx"`, `window_seconds` | "5xx가 마지막 18초에 처음 등장" |
| 7 | `slowest_step` | 스텝 ≥ 1 (p95 최대 1개) | info | `step_id`, `metric="p95_ms"`, `value` | "스텝 checkout이 p95 1,240ms로 가장 느림" |
| 8 | `slo_pass` | `verdict.passed == true` | info | (없음) | "모든 SLO 기준 통과" |

> `run_health`는 Summary 패널과 수치가 겹치지만 **인사이트 패널의 헤드라인 한 줄**(차트로 스크롤 안 해도 규모를 즉시 보여줌)이자 §6의 "≥3 하한" 보장 장치다. `count`/`value`만 구조화로 싣고 errors 표시는 UI가 같은 report.summary에서 읽는다.

세부 정의:

- **status_class 점유율**: `status_distribution`(HTTP status 문자열 키, 예 `"200"`/`"404"`/`"500"`; 연결 실패 등 `"0"`은 HTTP 응답이 아니라 무시)에서 키 **첫 글자**가 `'4'`/`'5'`인지로 4xx/5xx 분류(`'0'`/`'2'`/`'3'`은 무시 — 엔진 실패는 error_count/error_hotspot이 잡음). `pct = class_count / total_responses`(`total = sum(status_distribution.values())`; 0이면 emit 안 함). `count = class_count`. **kind `status_class`는 4xx·5xx가 둘 다 있으면 2개 emit**(각자 severity).
- **status_temporal**: `windows`를 `ts_second`로 그룹해 초별 5xx 합계를 만들고, 5xx가 **처음 등장한 ts_second** `t_first`를 찾는다. run의 마지막 `ts_second` `t_last` 기준 `window_seconds = t_last - t_first + 1`. "후반부 집중" 판정 = `t_first`가 전체 구간의 **후반 50%** 안일 때만 emit(초반부터 5xx면 status_class(5xx)로 충분, temporal은 "뒤늦게 터졌다"는 신호 전용). 5xx 없으면 emit 안 함.
- **error_hotspot 점유율**: `report.steps` 중 `error_count` 최대 스텝. `pct = step.error_count / summary.errors`(summary.errors==0이면 emit 안 함). 동률이면 첫 스텝(steps 순서 = step_id group 순서, 결정론적).
- **slowest_step**: `report.steps` 중 `p95_ms` 최대 스텝. 동률이면 첫 스텝. 스텝이 하나도 없으면(=요청 0건 run) emit 안 함.
- **no_request_step**: `Scenario::from_yaml(&report.scenario_yaml)`로 파싱 → **무조건 도달 http 스텝 id 집합** 수집(아래) → `report.steps`에 없는 id마다 1개 emit. 파싱 실패 시 이 종만 skip(리포트는 정상). 다수면 다수 emit(step_id 사전순 안정 정렬).

**무조건 도달 http id 수집(no_request_step 핵심)**: `Step` 트리를 재귀 walk하되 `conditional: bool` 플래그를 들고 다닌다.
- 최상위 `steps[]`: `conditional=false`로 진입.
- `Step::Http`: `conditional==false`면 id를 집합에 추가.
- `Step::Loop`: `repeat >= 1`이면 `do_`를 현재 `conditional` 그대로 하강; `repeat == 0`이면 본문을 `conditional=true`로(실행 안 됨) 하강(=수집 제외).
- `Step::If`: `then_`/`elif[].then_`/`else_`를 모두 `conditional=true`로 하강(어느 분기든 미선택 가능 → 0건이 정상).

이로써 "무조건 실행되어야 하는데 0건"만 잡고, 조건 분기의 자연스러운 0건은 침묵한다.

### 엣지 케이스 (acceptance 대응)

- **no-data run(요청 0건, `steps` 비어있음)**: run_health("총 0건…") + 무조건 도달 http 스텝 전부 no_request_step. slowest_step/error_hotspot/status_*는 조건 미충족으로 skip. verdict 있으면 slo_* 도. → 패널이 "아무것도 안 돎 + 미실행 스텝"을 명확히 표시.
- **all-pass run(에러 0, SLO 통과)**: run_health + slowest_step(info) + slo_pass(info) = 3개(criteria 있을 때). 4xx/5xx 없으면 status 생략. criteria 미설정이면 run_health + slowest_step = 2(§6 예외).
- **error-heavy run**: run_health + slo_failure(있으면) + status_class(5xx) + error_hotspot + (status_temporal) + slowest_step → 넉넉히 ≥3.

## 6. 렌더링 (UI `InsightPanel`)

- 위치: `ReportView`의 **최상단**(VerdictPanel 위). VerdictPanel은 그대로 아래에 — slo_* 인사이트는 한 줄 요약, VerdictPanel은 기준별 상세 테이블(중복 아닌 보완).
- 정렬: 백엔드 emit 순서를 그대로 신뢰(이미 severity rank 순). UI는 추가 정렬 안 함.
- 각 인사이트: severity 색/아이콘(critical=적, warning=황, info=중립) + 한 줄 한국어 메시지. 메시지는 `kind` switch로 구조화 필드에서 조립.
- **스텝 표시명**: `step_id`는 ULID라, 기존 `ReportView`의 `stepMeta`(scenario_yaml 파싱 → id→{name,method,url})를 재사용해 `name`으로 렌더(`stepMeta` 없으면 step_id fallback). loop/if 노드명은 `findStepById` 재사용 가능하나 v1 인사이트의 step_id는 전부 http leaf라 `stepMeta`로 충분.
- `run_health`가 항상 emit되므로 `insights`는 **사실상 비지 않는다**(최소 1개). UI는 `insights.length === 0`이면 패널을 렌더 안 하는 방어 가드만 둔다(이 기능 이전 데이터·파싱 실패 등 forward-compat 용도).
- **acceptance "≥3 인사이트" 보장**: §5의 `run_health`(항상) + `slowest_step`(스텝 ≥1) + (`slo_pass` 또는 `slo_failure`, verdict 있을 때)로 **criteria가 설정된 정상 run은 최소 3개**. 에러/4xx/5xx가 있으면 그만큼 더. **예외**: criteria 미설정(verdict None) + 무에러 + 단일 스텝이면 `run_health` + `slowest_step` = 2개일 수 있다 — 이는 "특이사항 없는 pristine run"이라 2줄이 정상(과보고 회피). acceptance 테스트는 criteria 있는 all-pass run으로 ≥3을 검증한다.

## 7. Export (controller `export.rs`)

- 단일-run `report_to_xlsx`에 **Insights 시트**를 `Branches` 시트와 동형으로 추가(인사이트 있을 때만):
  - 헤더: `kind, severity, step_id, metric, value, pct, count, status_class, window_seconds`.
  - 인사이트당 1행, `None` 필드는 빈 셀. 문자열/숫자 분기는 기존 시트 패턴 그대로.
- `report_to_csv`(스텝 테이블) · `comparison_to_csv`/`comparison_to_xlsx` **무변경**.
- 라운드트립 테스트 `xlsx_has_insights_sheet` 추가(calamine read, `Branches` 테스트 패턴).

## 8. 테스트 전략

- **Rust 단위(`report.rs` 또는 새 `insights` 모듈)**:
  - `all_pass_run_has_health_slowest_slo_pass`(≥3, 에러/5xx 인사이트 없음).
  - `error_heavy_run_has_hotspot_and_5xx`(error_hotspot pct/count 정확, status_class(5xx)).
  - `no_data_run_flags_unconditional_steps`(steps 비어있음 → no_request_step만, slowest 없음).
  - `no_request_step_skips_if_branches`(if then/else 안 스텝 0건은 미플래그, top-level·loop 본문 0건은 플래그) — 무조건/조건 구분의 핵심 회귀.
  - `status_temporal_only_when_late`(초반 5xx면 미emit, 후반 5xx면 window_seconds 정확).
  - `slo_failure_counts_failed_criteria` / `slo_pass_when_passed`.
  - `run_health_always_first_and_present`(run_health가 항상 존재 + 인덱스 0).
  - `insights_deterministic_order`(run_health 헤드라인 후 severity rank 순서 고정).
- **Export**: `xlsx_has_insights_sheet`(헤더 + 행 수 + 샘플 셀).
- **UI RTL(`InsightPanel.test.tsx`)**: 종류별 메시지 렌더(stepMeta 이름 치환 포함) · severity 색/순서 · 빈 insights 시 미렌더 · `ReportSchema` 와이어 1:1(엔진 JSON fixture parse).

## 9. 연기 항목 (roadmap §B로)

- baseline 대비 회귀 인사이트(A4b 비교 페이지 연계).
- status-class verdict 기준(A4a' — pass/fail 게이트, RunDialog 입력까지).
- CSV 인사이트(단일 테이블 관례) · compare export 인사이트(per-run 컬럼 설계).
- 인사이트 임계 설정화(error_hotspot 점유율·status_temporal 후반 50% 등 하드코딩 기본값).
- loop/if 컨테이너 노드 자체에 대한 인사이트(현 v1은 http leaf 기준).

## 10. 영향 없는 영역 (명시)

엔진 · 워커 · proto · DB 마이그레이션 **무변경**. `runs` 테이블 무변경. A4b의 `build_report_for_run`/4 export 라우트 시그니처 무변경(XLSX 시트만 가산). 인사이트 없는(=조건 전부 미충족) 경로는 `insights: []`라 기존 리포트 소비처에 무영향(`?? []`).
