# 속지 않는 오픈 시험 (A11) — 1차: 리포트 유효성 + 거짓 초록 신호 + 내러티브

- **날짜**: 2026-07-20
- **상태**: **spec APPROVE** + **plan APPROVE** (`docs/superpowers/plans/2026-07-20-trustworthy-open-test.md`, `REVIEW-GATE: APPROVED`) — 구현은 `/clear` 후 진입
- **유형**: `user-path`
- **출처**: 제품 방향 대화(2026-07-20) — 시나리오 작성 장벽은 상당 해소, 현재 최대 고통 = **거짓 초록** + **결과 해석**. roadmap §A11 · 주차 §A13.
- **연관**: A4c insights(`insights.rs` / `InsightPanel`) · ADR-0028 SLO verdict · ADR-0017 리포트 · ADR-0009 라이브 대시 비목표 · ADR-0046 포화 인사이트 · 엔진 `status:0` transport · assert 없으면 생 4xx/5xx≠engine error(A4c).
- **ADR**: 1차 범위에서는 **신규 ADR 불필요 예상** — `ReportJson` additive 필드 + 순수 파생 함수. 의미론이 “run status/SLO와 직교하는 시험 유효성”으로 굳고 영속 컬럼이 필요해지면 후속 ADR.
- **리뷰 반영**: 2026-07-20 `APPROVE-WITH-FIXES` must-fix 1–7 (transport 저에러 오보 수정 · silent 4xx+5xx 통일 · 상단 초록 계층 · narrative merge 알고리즘 · 공허 no_response skip · assert 정본 · always-emit+구서버 숨김 · `no_request_step` level 비채택).

---

### 사용자 스토리 (US)

- **US1**: QA가 종료된 run 상세·리포트 **헤더와 리포트 본문 최상단**에서 **시험 유효성**을 run 상태(`completed`)·SLO 판정과 **분리된 배지·사유**로 한눈에 본다 — 성공하면 “돌았다/SLO 합격” 초록만 보고 “믿을 수 있는 시험인가”를 혼동하지 않는다.
- **US2**: QA(또는 운영자)가 **전송 실패(`status` 0)가 많은 run**을 **완료 초록·비정상 고RPS·HTTP 오류 부재처럼 보이는 지표**로 오해하지 않는다 — 성공하면 유효성이 내려가고, 전송 실패 비중·건수가 리포트 상단에 명시된다. *(참고: transport 실패는 엔진 `error_count`/`summary.errors`를 **올린다**. 거짓 초록의 핵은 “에러 0”이 아니라 **SUT 미도달이 전용 승격 신호 없이 completed 성공 UI에 묻히는 것**이다.)*
- **US3**: QA가 **응답 검증(`Assertion::Status`)도 SLO criteria도 없는** 시나리오/run이 completed로 끝나도 “검증 없는 측정”임을 본다 — 성공하면 에러 0·합격 톤만 보고 기능·오픈 가능을 단정하지 않도록 경고가 남는다.
- **US4**: QA(또는 운영자)가 같은 리포트 상단에서 **짧은 사건 요약**과 **이 결과로 말할 수 있는 것 / 없는 것**을 본다 — 성공하면 차트를 읽지 않고도 Go/No-Go 논의의 출발 문장을 얻는다.

---

## 1. 문제와 목표

### 1.1 거짓 초록 (false green)

| 패턴 | 왜 초록·오해처럼 보이나 | 현재 Handicap |
|---|---|---|
| **전송 실패 위장** | `status=0`은 HTTP 아님. 실패가 빠르면 **RPS 폭증**. `completed` 배지(emerald). `status_class` insights는 `"0"`을 분모·분류에서 제외 → “HTTP 4xx/5xx 없음”처럼 읽힘. transport는 `summary.errors`를 **올리지만** `error_hotspot`은 “어느 스텝 에러 비중”이지 “SUT 미도달” 승격 신호가 아님 | `"0"` 분포는 표에 있을 수 있음. **전용 유효성 승격 없음** |
| **검증 없는 측정** | assert·SLO 없으면 **생 4xx/5xx는 engine error가 아님**. completed + errors=0 + (SLO 없음) = 심리적 초록 | A4c 문서화. `status_class`는 4xx/5xx를 띄울 수 있으나 **“검증 부재” 자체 신호 없음** |
| **부하 미도달** | open-loop drop | `load_gen_saturated` 있음 → 유효성 입력 **재사용** |
| **요청 0** | 실패·빈 실행 | `summary.count==0` → 최하위 유효성 |

### 1.2 해석 장벽

- `InsightPanel` = 진단 bullet 나열. **인식론적 한계·한 줄 결론** 없음.
- 시각 계층: `RunDetailPage` 헤더 `StatusBadge`(completed=emerald) + `VerdictBadge` · `ReportHeadline` SLO 합격=`text-emerald-700` “합격”이 Insight/본문보다 **먼저** 보임 → 유효성 배지만 본문 아래 두면 US1 실패.

### 1.3 1차 목표

1. **`validity`** — status/SLO와 직교하는 레벨 + 구조화 사유.
2. **거짓 초록 승격 신호** — transport 비중, 검증 부재, silent HTTP 오류, 부하 미도달, 요청 0.
3. **`narrative`** — events + can_claim + cannot_claim (결정론 코드 → UI 한국어).
4. **soft-only** — run 생성/완료/스케줄/`status`/`verdict` 평가 **불변**.

### 1.4 비목표 (1차)

- 실행 전 preflight, hard gate, 라이브 대시(ADR-0009), AI, baseline compare 내러티브, mutation/assert 제안, 감리 PDF, §A13 전항, proto/워커/엔진 핫패스/migration, run **목록** 배지, insights CSV 변경.

---

## 2. 핵심 결정 (확정)

| # | 결정 | 값 | 이유 |
|---|---|---|---|
| D1 | 표면 | 종료 리포트(+ run 상세 헤더 배지) | 사용자 승인 |
| D2 | 정책 | soft-only | 스케줄/야간 비차단 |
| D3 | 계산 | `build_report` on-demand 순수 함수 | A4c 패턴 |
| D4 | 축 | `Run.status` ⟂ `verdict` ⟂ `validity.level` | overwrite 금지 |
| D5 | 텍스트 | 구조화 emit · UI ko | 관례 |
| D6 | insights | 유지. **신규 Insight kind 없음** — validity reason 분리 | 이중 카드 방지 |
| D7 | 내러티브 | 비-LLM 규칙 엔진 §5 | R7 |
| D8 | 임계 | 고정 상수 §4.2 | YAGNI |
| D9 | 상단 초록 | **ValidityBadge 헤더 MUST** + **ReportHeadline 연동 MUST** (§5.3) | US1 |
| D10 | 와이어 | `validity`·`narrative` **non-optional always-serialize objects** (빈 vec OK) | 모호한 Option 폐기 |
| D11 | 구 리포트 UI | 필드 부재 시 **Validity/Narrative 숨김** (fake `ok` 금지) | R8 단일 |
| D12 | `no_request_step`→level | **비채택** (insight·events만) | optional 모호성 제거 |

---

## 3. 데이터 모델

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Validity {
    /// "ok" | "limited" | "suspect"
    pub level: String,
    pub reasons: Vec<ValidityReason>, // 결정론 정렬, ok면 보통 빈 배열
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidityReason {
    pub kind: String,
    /// "critical" | "warning" | "info" only
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Narrative {
    pub events: Vec<String>,
    pub can_claim: Vec<String>,
    pub cannot_claim: Vec<String>,
}
```

`ReportJson` (신규 빌드 경로):

```rust
pub validity: Validity,   // always present; serde #[serde(default)] for old JSON
pub narrative: Narrative, // always present; default empty vectors
```

- **Default**: `Validity { level: "ok", reasons: [] }`, `Narrative { events:[], can_claim:[], cannot_claim:[] }` — 역직렬화 전용. **신규 `build_report`는 항상 재계산 값 emit** (default를 “가짜 ok 성공”으로 UI에 쓰지 않음 — 구 클라이언트는 키 없음 → Zod optional → **숨김**).
- UI Zod: `validity`/`narrative` **`.optional()`** (구 서버·구 저장 JSON). 존재 시에만 배너. severity `z.enum(["critical","warning","info"])`.
- `ReportSchema.strict()`에 키 **명시 추가** 필수.
- XLSX: Summary 시트 **하단 additive 3행** — `validity_level`, `validity_reason_kinds`(comma-joined kinds), `narrative_events_count`. 신규 Validity 시트 없음(1차). insights CSV **OUT**.

모듈: `crates/controller/src/validity.rs` (또는 `report` 인근) — `derive_validity` + `derive_narrative`. plan 확정.

---

## 4. 유효성 사유 + level

### 4.1 reasons (MUST 전부 평가, 조건 충족 시만 push)

| kind | emit | severity | 필드 |
|---|---|---|---|
| `zero_requests` | `summary.count == 0` | critical | — |
| `transport_heavy` | §4.2 | `pct ≥ 0.50` → critical, else warning | `pct`, `count`(=n0) |
| `silent_http_errors` | `(4xx+5xx count) > 0` **AND** `summary.errors == 0` | warning | `count`=4xx+5xx 합, `pct`=합/http_total (http_total>0일 때) |
| `no_response_validation` | §4.3 | warning | — |
| `load_not_delivered` | insights에 `kind==load_gen_saturated` | warning | `count`=insight.count(dropped) 있으면 복사 |

**정렬**: kind 고정 순위  
`zero_requests` → `transport_heavy` → `silent_http_errors` → `no_response_validation` → `load_not_delivered`.

### 4.2 `transport_heavy`

- `n0 = status_distribution.get("0").copied().unwrap_or(0)`
- `n_http = http_response_total(status_distribution)` (기존 헬퍼)
- `n_all = n0 + n_http`
- emit iff `n0 > 0 && n_all > 0 && (n0 as f64 / n_all as f64 >= 0.05 || n0 >= 50)`
- `pct = n0 / n_all`

### 4.3 `no_response_validation`

- `Scenario::from_yaml` 실패 → **skip** (fail-soft).
- 무조건 도달 HTTP id = insights `collect_unconditional` **동일 규칙** (if 분기 제외, loop·parallel 포함 — `insights.rs` 정본).
- **공허 가드**: 무조건 도달 HTTP 스텝 수 `== 0` 이면 **skip** (`zero_requests` / 구조 신호에 위임).
- 응답 검증 있음 ⇔ 해당 `HttpStep.assert`에 `Assertion::Status(_)`가 **하나라도** 있음.  
  정본: `crates/engine/src/scenario.rs` — `HttpStep.assert: Vec<Assertion>`, `Assertion::Status(u16)` only (body assert 없음). extract는 검증으로 **불인정**.
- criteria 있음 ⇔ **`has_active_criteria(profile) = profile.criteria.as_ref().is_some_and(|c| c.has_any())`** (design-time 게이트).  
  **`verdict is Some` 과 동일하지 않음** — verdict는 completed + has_any + evaluate 행 비어 있지 않을 때만 부착(`report.rs`). failed/aborted·skip-only criteria run도 criteria가 있으면 이 reason **비emit** (SLO 게이트를 *설정한* 시험으로 본다).

### 4.4 level

```
if any reason.severity == "critical" → "suspect"
else if reasons non-empty → "limited"
else → "ok"
```

(`zero_requests`·`transport_heavy` pct≥0.5 는 이미 critical severity로 push.)

UI 배지 라벨: ok=`해석 가능` · limited=`제한적 해석` · suspect=`해석 주의`.

---

## 5. 내러티브 규칙 엔진

### 5.1 `events` (max 5)

1. validity reasons를 §4.1 순위대로 `validity:<kind>` 코드 append (전부, 캡 전).
2. 남은 슬롯을 insight `order_rank` 순으로 보충. 코드:
   - `insight:slo_failure` / `insight:slo_pass`
   - `insight:status_class:5xx` / `insight:status_class:4xx`
   - `insight:load_gen_saturated`
   - `insight:error_hotspot`
   - `insight:status_temporal`
   - `insight:no_request_step` (step마다 여러 개면 첫 1개만 events에)
   - `insight:slowest_step`
3. 총 길이 > 5 → **앞쪽 유지 truncate** (validity 우선이 자연 보장되도록 reasons를 먼저 넣음).
4. 동일 코드 중복 제거(첫 등장).

### 5.2 `can_claim` / `cannot_claim` (결정론 merge)

**알고리즘**:

1. 아래 조건 행을 **표 위→아래 고정 순서**로 스캔.
2. 조건 참이면 해당 코드를 해당 배열 끝에 append.
3. 배열 내 중복 코드 제거(첫 등장 유지).
4. 각 배열 **max 5** truncate(앞쪽 유지).
5. 마지막에 `cannot_claim`에 `production_identity`가 없으면 **always append** (캡 때문에 잘렸으면 4번째까지 남기고 5번째를 `production_identity`로 교체 — “always” 보장).

| # | 조건 | can_claim += | cannot_claim += |
|---|---|---|---|
| 1 | `zero_requests` reason | — | `any_performance_claim` |
| 2 | `transport_heavy` reason | `client_reachability_issue` | `sut_capacity`, `slo_as_capacity` |
| 3 | `silent_http_errors` reason | `http_error_statuses_seen` | `zero_engine_errors_means_ok` |
| 4 | `no_response_validation` reason | if **`summary.count > 0`**: `throughput_measured` (reason 필드 `count` 아님) | `functional_correctness`, `error_free_service` |
| 5 | `load_not_delivered` reason | `delivery_ceiling_observed` | `target_load_applied` |
| 6 | `level==ok` && insight `slo_pass` | `slo_held` | — |
| 7 | `level==ok` && insight status_class 5xx | `sut_errors_observed` | — |
| 8 | `level==ok` && insight `slowest_step` | `bottleneck_step` | — |
| 9 | `!has_active_criteria(profile)` (§4.3 동일 술어) | — | `slo_gate` |
| 10 | always (step 5) | — | `production_identity` |

**골든 fixture (단위 테스트 고정)**:

| 입력 요약 | level | can (prefix) | cannot (prefix) |
|---|---|---|---|
| count=0 | suspect | [] | any_performance_claim, production_identity |
| n0/n_all=0.8, errors>0 | suspect | client_reachability_issue | sut_capacity, slo_as_capacity, production_identity |
| 200 only, no assert, no criteria, count>0 | limited | throughput_measured | functional_correctness, error_free_service, slo_gate, production_identity |
| 5xx>0, errors=0, has assert? no → silent+no_response | limited | http_error_statuses_seen, throughput_measured | zero_engine_errors_means_ok, functional_correctness, … |
| clean assert+SLO pass, no bad reasons | ok | slo_held, bottleneck_step? | production_identity (± slo_gate 없음) |

### 5.3 UI 시각 계층 (US1 MUST)

| 위치 | 요구 |
|---|---|
| `RunDetailPage` 헤더 | `StatusBadge` · `VerdictBadge` **옆**에 `ValidityBadge` **MUST** (report 로드 후). level 색: ok=slate/중립, limited=amber, suspect=red/amber-red. **completed emerald를 제거하지는 않음** — 옆에 유효성으로 대비. |
| `ReportHeadline` | `validity.level != ok`이면 SLO “합격” **emerald 강조 금지**: 중립 카피 또는 “SLO 수치 통과 · 시험 해석은 {limited\|suspect}” 병기 MUST. `level==ok`이면 기존 합격 강조 유지 가능. |
| `ReportView` 본문 상단 | 1) ValidityBanner(사유 목록) 2) NarrativeBlock 3) **VerdictPanel** 4) **InsightPanel** 5) 나머지. **기존 Insight→Verdict 순서를 Verdict→Insight로 스왑** 포함(R8). |
| 구 리포트 | validity/narrative 키 없음 → 배지·배너·내러티브 **미렌더** (D11). |

---

## 6. 요구사항 (R-id)

| ID | 요구 | acceptance |
|---|---|---|
| R1 | MUST `build_report`가 terminal run(completed/failed/aborted)에 `validity`+`narrative` always-emit | unit/fixture |
| R2 | MUST level 산정 = §4.4 | table-driven |
| R3 | MUST `transport_heavy` §4.2; pct≥0.5 → severity critical → level `suspect`; 그 외 emit 시 최소 `limited` | unit |
| R4 | MUST `no_response_validation` §4.3 (공허 skip · Status assert · criteria) | yaml fixtures |
| R5 | MUST `silent_http_errors` = (4xx+5xx)>0 && errors==0 | unit (4xx-only + 5xx fixtures) |
| R6 | MUST soft-only: status 전이·verdict 식·스케줄 0-diff | 기존 테스트+grep |
| R7 | MUST narrative §5.1–5.2 결정론 + 골든 표 | unit |
| R8 | MUST UI: ValidityBadge 헤더 · Headline 연동 · Banner+Narrative · Verdict→Insight 순서 · 구 리포트 숨김 · ko | RTL |
| R9 | MUST Zod↔serde 1:1; XLSX Summary 3행 additive; insights CSV OUT | schema+export |
| R10 | MUST engine/worker/proto/migration 0-diff | workspace |
| R11 | SHOULD live: (a) 대상 down→transport_heavy/suspect (b) assert·SLO 없음 200→limited+no_response_validation (c) assert+SLO clean→ok | /live-verify US 표 |

---

## 7. 무변경 / 불변식

- ADR-0009, insight kind 의미·order_rank 기존 항, `evaluate_criteria`, 시나리오 YAML 스키마, soft API.
- 신규 Insight kind 없음.

---

## 8. 연기 (2차+)

preflight · hard gate · 목록 배지 · assert 확장 · threshold 설정 · compare 유효성 · 감리 번들 · §A13 · transport “고RPS 자동 의심” 휴리스틱(별도) · ReportHeadline 카피 미세 A/B.

---

## 9. 테스트 / 검증

- Rust: `derive_validity` / `derive_narrative` table + `build_report` 3 fixture (transport / unchecked / clean).
- UI: Badge·Banner·Narrative·Headline·ReportView 순서 · Zod old/new.
- Export: Summary 3행.
- Live: R11.
- 회귀: insights·verdict 스위트.

---

## 10. 슬라이스 분해

한 plan multi-task 권장. US1–4 **모두 1차 출하**.

1. validity 모델+derive+R1–5  
2. narrative derive+R7  
3. UI R8 + ko  
4. export R9 + live R11  

---

## 11. plan이 코드로 닫을 디테일 (제품 불변)

1. 모듈 파일명 `validity.rs` vs `report/validity.rs`.
2. `has_any` criteria 헬퍼 재사용 경로.
3. Headline 정확한 카피 키 (`ko.report.*`).
4. failed+zero_requests events 최소 스모크 1개.
