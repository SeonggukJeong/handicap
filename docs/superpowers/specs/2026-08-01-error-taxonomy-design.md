# transport 에러 분류(taxonomy) + 원인 후보 인사이트 + connect_timeout 노브 (영역 E)

**유형: user-path** · 워크트리 `error-taxonomy` · ADR: 신설 1건 예정(§12) · **영역 spec — 3 서브슬라이스(E1/E2/E3, §13)로 나눠 구현**(A3a/b/c·34a/b/c 선례)

## 사용자 스토리 (US)

> **사고 앵커(원문)**: "부하 테스트 중 수신측 소켓 부족으로 오류 — 테스터엔 그냥 타임아웃·503만 보였고, 수신측 소켓 재사용 설정으로 해결하기까지 원인 파악이 너무 오래 걸렸다." (2026-08-01 사용자)

- **US1** *(E1)*: QA가 타임아웃·503이 급증한 run을 마친 뒤 리포트를 열어 실패의 정체를 확인하려 한다 — 성공하면 지금까지 status=0 한 버킷으로 뭉뚱그려졌던 transport 실패가 종류별 분류표(연결 거부/연결 끊김/연결 수립 타임아웃/요청 타임아웃/DNS/TLS/테스터측 포트 고갈)로 나뉘어 보인다.
- **US2** *(E2)*: QA가 "처음엔 정상 → 런 도중부터 급증" 패턴의 run 리포트를 열면 — 성공하면 "t=N초까지 정상, 이후 transport 실패 급증(5xx 동반)" 시간 패턴 요약과 "SUT 측 소켓/포트 고갈 가능성 — TIME_WAIT·재사용 설정·backlog·FD 한도 확인" 원인 후보 안내를 본다(해당 패턴 없으면 블록 자체 미렌더).
- **US3** *(E3)*: QA가 타임아웃의 정체를 좁히기 위해 connect 타임아웃을 별도 설정하고 재실행한다 — 성공하면 connect 단계에서 막힌 요청이 `connect_timeout` 클래스로 분리돼 "서버가 연결 자체를 못 받는 상태"라는 결정적 신호를 본다(미설정 시 현행 거동·와이어 byte-identical).
- **US4** *(E1 분류 + E2 안내)*: QA가 부하 발생기 자신이 병목인 상황(로컬 ephemeral 포트 고갈)에서 run을 돌리면 — 성공하면 `local_port_exhaustion` 클래스로 분리돼 SUT 문제와 구분된 안내("부하 도구 머신의 포트 범위/재사용 설정 확인")를 본다 — SUT를 잘못 의심하는 역방향 오진 방지.

## 1. 문제

transport-레벨 실패(연결 거부·reset·타임아웃·DNS…)는 전부 `ExecOutcome { status: 0, error: Some(문자열) }`로 접히고(`crates/engine/src/executor.rs:283-293`), 집계는 counts-only라 리포트에 도달하는 정보는 "status=0이 N건"뿐이다. 에러 *종류*는 per-request 문자열로만 존재하다 버려진다. 그 결과:

- SUT 소켓/포트 고갈(사고 앵커)의 대표 증상인 connection reset·connect 지연이 "타임아웃"과 구분 불가.
- 전체-요청 타임아웃(reqwest `RequestBuilder::timeout`)은 connect 단계에서 멈췄는지 응답 대기에서 멈췄는지 알려주지 않는다.
- "처음 정상 → 도중 급증"이라는 자원 고갈 서명은 기존 초당 시계열(`ReportWindow.status_counts`)에 이미 있으나, 이를 해석하는 표면은 `validity.transport_heavy`(양 판정)와 `status_temporal`(5xx 후반 등장)뿐 — "언제부터·무엇이·왜"를 묶은 원인 후보 안내가 없다.
- 부하 발생기 자신의 포트 고갈(EADDRNOTAVAIL)과 SUT 문제가 구분되지 않아 역방향 오진 위험.

## 2. Goals / Non-goals

### Goals

1. *(E1)* send-실패를 8종 분류(taxonomy)로 접어 counts-only로 리포트까지 운반 + 리포트 분류표 (US1, US4).
2. *(E2)* 기존 초당 시계열로 mid-run 급증(onset)을 서버측 판정하는 인사이트 + 분류 지배-kind 기반 원인 후보 조치문 + 테스터측 포트 고갈 인사이트 (US2, US4 안내부).
3. *(E3)* `connect_timeout_seconds` 프로필 노브(opt-in) — connect 단계 타임아웃을 별도 클래스로 분리 (US3; S-A 의도적 연기 항목 회수).
4. transport 에러 0인 run·노브 미설정 run은 전 레이어 byte-identical (§8의 소급 발행 예외 1건 명시).

### Non-goals (연기·제외)

- **구성(composition) 인사이트** — 별도 인사이트로 만들지 않는다. 구성비는 분류표(§7.2)가, "transport-heavy" 양 판정은 이미 출하된 `validity.transport_heavy`(`crates/controller/src/validity.rs:81-93`)가 담당 — 세 번째 표면은 report-advice-noise 규율 위반(리뷰 R5/V2로 제거).
- **per-window(초당) kind 시계열** — onset은 기존 status "0" 시계열로 충분 (연기).
- **에러 원문 문자열 영속/표면화** — reqwest error 최상위 `Display`가 URL(크레덴셜 포함 가능)을 렌더하는 문서화된 함정(엔진 CLAUDE.md `Http(reqwest::Error)` 항목). kind만 운반, 분류도 체인 링크 메시지만 사용(§3.1) (의도적 제외).
- **body-read 중 reset 분류** — `read body:` 경로는 진짜 status를 이미 수신한 뒤라 status=0 오진 위험이 없음. 현행 유지 (연기).
- **trace/test-run(에디터) 표면** — `execute_step_traced`는 `HttpTrace`를 반환(`executor.rs:350`, `trace.rs:58-65`)하며 UI Zod `.strict()`가 소비하는 와이어 타입이므로 **v1은 필드 추가 없이 무변경**. 분류는 부하 경로 전용 (연기; lockstep 원칙은 흐름 의미론에 관한 것 — 분류 메타데이터 비대상, 코드 주석으로 명시).
- **validity(§A11) 체계 통합** — `local_port_exhaustion`은 측정 유효성 문제지만 v1은 인사이트(critical)로만. `evaluateTrust`/validity 연동은 도그푸딩 후 (연기).
- **ScheduleForm connect_timeout 입력** — 와이어는 통과(Profile 필드), 폼 입력은 RunDialog만 v1 (연기).
- **per-step kind 리포트 표면** — DB엔 per-step으로 저장, 리포트/UI는 run-level 롤업만 v1 (연기). 단일-스텝 국소 고갈의 onset 미검출 한계는 §5.4에 명시.
- **export(CSV/XLSX)의 error_kinds 분류표** — 연기. 단 `Insight.error_kind` **필드**는 export 불변식(`INSIGHT_COLUMNS`)에 걸리므로 E2에서 필수 배선(§5.4 — 이건 표가 아니라 기존 인사이트 export 경로).
- **실행 중 조기 경보** — 사후 리포트만 (ADR-0009 일관; 사용자 결정 2026-08-01).

## 3. 엔진 (`crates/engine`) — E1·E3

### 3.1 `ErrorKind` enum + 분류 함수 (신규 `error_kind.rs`) — E1

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ErrorKind {
    ConnectRefused,       // "connect_refused"
    ConnectionReset,      // "connection_reset" — RST/BrokenPipe + keep-alive 재사용 커넥션 조기 종료 포함
    ConnectTimeout,       // "connect_timeout"
    Timeout,              // "timeout" — 전체-요청 타임아웃, 단계 불명
    Dns,                  // "dns"
    Tls,                  // "tls"
    LocalPortExhaustion,  // "local_port_exhaustion" — 테스터 자신
    Other,                // "other"
}
impl ErrorKind { pub fn as_str(&self) -> &'static str { … } }
```

와이어 문자열은 위 주석의 snake_case 8종 — proto/DB/report/Zod 전 레이어의 계약(추가는 additive, 이름 불변).

`pub fn classify_send_error(e: &reqwest::Error) -> ErrorKind` — 아래 규칙을 **번호 순서대로** 평가, 첫 매치 채택:

1. **io kind 매핑(선별적 — fall-through)**: `std::error::Error::source()` 체인을 walk하며 **kind ∈ {AddrNotAvailable, ConnectionRefused, ConnectionReset, BrokenPipe}인 첫 `std::io::Error`만** 채택 — `AddrNotAvailable → LocalPortExhaustion` / `ConnectionRefused → ConnectRefused` / `ConnectionReset | BrokenPipe → ConnectionReset`. 그 외 kind의 io::Error(예: DNS 실패 아래의 Other/Uncategorized, rustls의 InvalidData)는 **무시하고 계속 walk**, 매치 없으면 규칙 2로.
2. **타임아웃**: `e.is_timeout()` → `e.is_connect()`도 참이면 `ConnectTimeout`, 아니면 `Timeout`. (노브 없이도 OS-레벨 connect ETIMEDOUT이 여기 올 수 있음 — "connect 단계에서 막힘" 의미는 동일하므로 허용, §10 US3 대조 주의.)
3. **DNS**: `e.is_connect()`이고 체인 링크 메시지에 `"dns error"` 포함(hyper-util `ConnectError` Display 형식) → `Dns`.
4. **keep-alive 조기 종료**: 체인 링크 메시지에 `"connection closed before message completed"` 포함 → `ConnectionReset`. **사고 앵커의 대표 형태** — 풀 재사용 커넥션에서 SUT가 요청 head 수신 후 절단하면 hyper는 io::Error 없이 이 Display로 감싼다(리뷰 R2; hyper `Kind::IncompleteMessage`의 Display 문자열이며 variant 이름 `"IncompleteMessage"`는 `to_string()`에 등장하지 않으므로 매치 대상 아님 — 리뷰 N2). 요청 head 발신 *전* 절단은 hyper-util이 투명 재시도하고, 비재시도 `Canceled`는 source 없는 Display라 `Other`로 떨어짐 — best-effort 허용(리뷰 N5).
5. **TLS**: 체인 링크 메시지(소문자화)에 `"tls"`/`"certificate"`/`"handshake"` 포함 → `Tls`. rustls 타입 다운캐스트는 **하지 않는다** — engine에 rustls 직접 의존이 없고, 버전 어긋나면 다운캐스트가 조용히 실패(fail-open)하는 함정(리뷰 R3).
6. 그 외 → `Other`.

**체인 링크 메시지 = 각 `source()` 링크의 개별 `to_string()`만. 최상위 `reqwest::Error`의 `Display`는 절대 사용 금지 — URL(크레덴셜 포함 가능)을 렌더한다(리뷰 C3, §2 보안 항목과 동일 근거). `{:?}`(Debug)도 금지 — reqwest Error의 Debug는 `url` 필드를 그대로 찍는다(리뷰 N2).** 3·4·5는 best-effort 문자열 매치임을 함수 doc에 명시(미스매치는 `Other` 안전 폴백 — 오분류보다 미분류). 1·2·4는 통합 테스트로 실제 reqwest 거동에 핀 고정(§9.1).

### 3.2 `ExecOutcome` 확장 + 기록 지점 — E1

- `ExecOutcome`에 `pub error_kind: Option<ErrorKind>` 추가. **send-실패 arm(`executor.rs:283-293`)에서만 `Some(classify_send_error(&e))`**, 나머지 전 구성 사이트(성공·body-read 실패·assert 실패)는 `None` — 컴파일러가 구성 사이트 전부 강제.
- `execute_step_traced`는 `HttpTrace` 반환이라 **무변경**(§2 Non-goals) — send-실패 arm에 "분류는 부하 경로 전용(ExecOutcome), trace 비대상 — spec §2" 주석만.
- 기록 지점은 **단 1곳**: `execute_steps`의 `Step::Http` arm에 있는 유일한 outcome 기록부(`runner.rs:509`의 `a.record(...)` 인접)에서 `error_kind`가 `Some`이면 `record_error_kind(step_id, kind)` 호출. loop/if/parallel 재귀는 전부 이 arm으로 수렴하고 VU 루프 3경로는 `execute_steps` 호출자일 뿐이라 **추가 배선 없음**(리뷰 F2 정정).

### 3.3 집계 → `MetricFlush` — E1

- `Aggregator`에 `error_kinds: BTreeMap<(String, ErrorKind), u64>` 누적 + `record_error_kind(step_id, kind)` + `drain_error_kinds() -> Vec<ErrorKindStat>`. `ErrorKindStat { step_id: String, kind: ErrorKind, count: u64 }` (delta 의미론 — branch_stats 동형).
- `MetricFlush`(`runner.rs:103-116`, 현행 7필드/6 Vec)에 **8번째 필드(7번째 Vec)** `pub error_kind_stats: Vec<ErrorKindStat>` — **드레인 6곳(`runner.rs:285/330/819/968/1295/1448`) + send-guard `|| !error_kind_stats.is_empty()` 5곳(open-loop final `:1448`만 무가드)** 전부 갱신(엔진 CLAUDE.md 6+5 함정). struct 리터럴 컴파일러 강제 + 드레인/가드 누락은 테스트로.

### 3.4 `connect_timeout` 배선 — E3

- `RunPlan`(`runner.rs:277`, `Default` 없음 — **의도적으로 도입하지 않는다**: struct 리터럴 컴파일러 강제가 이 레포의 필드-추가 가시성 관례)에 `pub connect_timeout: Option<Duration>` 추가. **명시 churn 예산: `RunPlan {` 리터럴 ~43곳**(engine 통합테스트 다수 + `crates/worker/tests/abort_and_env.rs:47,78` + `crates/worker/src/lib.rs:233`)에 `connect_timeout: None` 한 줄씩(리뷰 R4).
- `VuClient::with_timeout(cookie_mode, timeout, measure_phases)`에 `connect_timeout: Option<Duration>` 4번째 인자 — `Some`이면 `ClientBuilder::connect_timeout(d)` 체이닝, `None`이면 빌더 호출 자체 없음(byte-identical). 호출 사이트는 컴파일러 강제 일괄 갱신(runner 클라이언트 빌드 + executor 테스트 `:1450`/`:1467` 등).
- trace/test-run 클라이언트는 `None` 고정(§2).

## 4. proto + 워커 (`crates/proto`, `crates/worker`) — E1·E3

- *(E1)* `coordinator.proto`:
  ```proto
  message ErrorKindStat {
    string step_id = 1;
    string kind = 2;      // §3.1 snake_case 8종
    uint64 count = 3;     // delta since last flush
  }
  // MetricBatch(현행 1..9 사용)에 추가:
  repeated ErrorKindStat error_kind_stats = 10;
  ```
- *(E3)* proto `Profile`에 `optional uint32 connect_timeout_seconds = 15;` (현행 최대 14 `graceful_ramp_down_seconds`; absent=미설정 — 같은 optional-uint32 선례 동형).
- *(E1)* 워커 forwarder(`crates/worker/src/lib.rs:311-415`)의 **빈-배치 스킵 가드(`:388-397`)에 `&& flush.error_kind_stats.is_empty()` 추가 필수** — 누락 시 error_kind만 실린 flush 유실(`active_vu_samples`/`dropped` 동형 함정). prost `MetricBatch` 리터럴(`:401-411`)에 매핑 추가.
- *(E3)* 워커 assignment→`RunPlan` 매핑(`lib.rs:233-`)에 connect_timeout 추가(prost `optional` = `Option<u32>` → `Option<Duration>` 직결).

## 5. controller (`crates/controller`) — E1·E2·E3

### 5.1 store `Profile` + 검증 — E3

- `store/runs.rs::Profile`에 `#[serde(default, skip_serializing_if = "Option::is_none")] pub connect_timeout_seconds: Option<u32>` — profile_json 스냅샷 하위호환.
- `api/runs.rs::validate_run_config`: **기존 http_timeout 검사(`api/runs.rs:413`) 바로 뒤**에 추가 — `Some(v)`이고 ① `!(1..=600).contains(&v)` → 400 ② `v >= profile.http_timeout_seconds` → 400. ②의 비교 대상은 serde default(`store/runs.rs:127`, 기본 30)가 항상 채우는 실값이고 `0`은 ①(:413)이 이미 거절했으므로 "미설정" 분기 자체가 없다(리뷰 F4 정정). 메시지는 인접 `:415`와 같은 영문 스타일: `"connect_timeout_seconds must be between 1 and 600"` / `"connect_timeout_seconds must be less than http_timeout_seconds"`.
- **한계(명시)**: per-step `HttpStep.timeout_seconds` 오버라이드(`executor.rs:159`)가 run-level보다 짧으면 그 스텝에선 여전히 전체-타임아웃이 먼저 발화할 수 있다 — cross-field 검사는 run-level만 보증(리뷰 R13, 스텝별 검사는 비목표).
- dispatch 매핑(profile→assignment)에 필드 전달. 프리셋/스케줄은 Profile 재사용이라 와이어 자동 통과.

### 5.2 메트릭 ingest + 저장 — E1

- 신규 테이블 `run_error_kind_metrics(run_id TEXT, step_id TEXT, kind TEXT, count INTEGER)` — migration은 `/new-migration` 채번(작성 시점 다음 번호 0020 예상). ingest는 `(run_id, step_id, kind)` UPSERT 가산(`run_if_metrics` 동형 — `store/metrics.rs:203-224` + `migrations/0006_run_if_metrics.sql` 선례).
- grpc coordinator의 MetricBatch 처리에 `error_kind_stats` 저장 추가. 멀티워커 merge = SUM(가산 UPSERT가 자연 처리).

### 5.3 `build_report` + `ReportJson` — E1

- `ReportJson`에 `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub error_kinds: Vec<ErrorKindCount>` — `ErrorKindCount { kind: String, count: u64 }`, **run-level 롤업**(step/kind SUM을 kind로 재집계), 정렬 = count desc → kind asc(결정적). 빈 run은 직렬화 생략 → 기존 골든 fixture(ADR-0030) 무변경.
- **배선 열거**(컴파일러 비강제 — 리뷰 R11): `store::metrics`에 read 함수 신설 → `build_report`(`report.rs:439`) 인자 추가 → `build_report_for_run`(`api/runs.rs:1013`) 호출부 배선 → report/insights 테스트 호출부(~35곳)에 `&[]`/기본값 churn.

### 5.4 인사이트 2종 (`insights.rs::derive_insights`) — E2

`derive_insights`에 `error_kinds: &[ErrorKindCount]` 인자 추가. `Insight`에 `#[serde(skip_serializing_if = "Option::is_none")] pub error_kind: Option<String>` additive 필드 1개(onset 시점은 **기존 `onset_second` 필드 재사용** — `insights.rs:38-41`, 새 필드 아님·export 열 의미 일관, 리뷰 C4). 해당 없으면 미발행(ok는 블록 자체 없음):

**① `midrun_error_onset` (US2, severity critical)** — 발행 조건(결정적 수식; 리뷰 R8):

```
행 집합: ReportWindow 전체를 ts_second로 재집계(per-step·per-worker 행 중복 무관 — 전부 합산).
data_seconds = { t | Σ count(t) > 0 }를 오름차순 정렬한 s_1..s_m   (요청 0인 초는 존재하지 않는 초로 취급)
bad(s_i) = (status "0" 합 + 5xx 합) / count 합   (해당 초; 5xx = 첫 글자 '5'인 status 키)
h = bad(s_i) < 0.01 이 연속인 최장 프리픽스 길이 (프리픽스이므로 유일)
t0 = min{ i > h : bad(s_i) ≥ 0.10 }   (최소성으로 유일 — 1~10% 밴드를 거치는 점진적 급증도 포착, 리뷰 N1)
발행 ⇔ h ≥ 10  ∧  t0 존재  ∧  |{ i ≥ t0 : bad(s_i) ≥ 0.10 }| ≥ 0.5 × (m − t0 + 1)
onset_second = s_{t0} − s_1   (run 시작초 정본 = 첫 data-second s_1; ReportRun.started_at 아님 — 리뷰 C5)
```

- 내용 필드: `onset_second`(**기존 doc 주석이 `load_gen_saturated` 전용 서술이므로 두 kind 공용으로 갱신** — 리뷰 N6), `status_class`: onset 후 5xx 합 ≥ 10이면 `Some("5xx")`, `error_kind`: 지배 kind(아래), `count`: onset 후 (status0+5xx) 합.
- **지배 kind**: `error_kinds` 총합 대비 ≥50%인 kind가 {`connection_reset`, `connect_timeout`, `timeout`} → "SUT 소켓/포트/자원 고갈 가능성" 조치문; `connect_refused` ≥50% → "SUT 리슨 안 함/포트 오설정" 조치문; **그 외·`error_kinds` 빈 경우(과거 run·구 워커 혼합) → `error_kind=None` + 일반 조치문**(리뷰 R10).
- **조치문은 `computed: true`** — `load_gen_saturated` 선례(`InsightPanel.tsx:80-95`): run-특정 진단이므로 기본-숨김 토글(`readShowInsightActions()` 기본 false)과 무관하게 렌더. 이게 없으면 새 브라우저 프로필에서 US2가 실패한다(리뷰 C1).
- **억제 규칙**: 이 인사이트가 발행되면 `status_temporal`(`insights.rs:236-263`) **미발행**(같은 현상의 더 구체적 판정이 우선 — 리뷰 R7).
- **공존 정책**(리뷰 R5/R6): `validity.transport_heavy`(양 판정 배지)와 이 인사이트(시간 패턴+원인 후보)는 역할이 다르므로 공존. 단 narrative `cannot_claim: sut_capacity`와의 표면상 충돌을 피하기 위해 조치문 문구는 **용량 주장을 하지 않는다** — "측정치(RPS/레이턴시)로 용량을 판단하지 말고(validity 참조), SUT *상태*를 다음 목록으로 점검: TIME_WAIT/재사용 설정·backlog·FD 한도" 형태. 임계·분모도 validity와 다름이 의도(validity=양, onset=시간 패턴)를 spec에 명시.
- **한계(명시)**: bad(t)는 전 스텝 합산이라 N-스텝 시나리오에서 한 스텝만 전멸하면 bad ≤ 1/N — 11스텝 이상 단일-엔드포인트 국소 고갈은 미검출(리뷰 R9). per-step onset은 연기(§2).

**② `loadgen_port_exhaustion` (US4, severity critical)** — `error_kinds`의 `local_port_exhaustion` ≥ 1이면 발행. **1건 임계는 의도**: 테스터 자신의 포트 고갈은 단 1건이라도 그 run의 측정 전체가 오염됐다는 신호(간헐 EADDRNOTAVAIL도 임박 신호)라 조용히 넘기지 않는다. 본문에 "부하 발생기 머신 문제 — SUT 문제 아님" 명시. 조치문 `computed: true`.

**배선 열거**(컴파일러 비강제 — 리뷰 R11): ① `order_rank`(`insights.rs:80-93`)에 두 kind 명시 추가 — `loadgen_port_exhaustion`을 최상단(측정 유효성), `midrun_error_onset`을 그 다음(구체 값은 plan에서 기존 목록에 맞춰 핀) — 누락 시 `_ => 99`로 critical이 info 뒤에 정렬. ② export 불변식: `INSIGHT_COLUMNS` 16→17 + `insight_csv_cells` + `write_insight_xlsx_row`(`export.rs:88-128`)에 `error_kind` 열 동기 추가. ③ `ko.insightLabels`(`ui/src/i18n/ko.ts:1192`)에 두 kind — 누락 시 비교 뷰(`InsightCompareMatrix.tsx:21`) 라벨 공백.

**소급 발행(명시)**: 리포트는 조회 시 재계산되므로 슬라이스 이전 run에도 onset 인사이트가 소급 등장할 수 있다(그 run들은 `error_kinds`가 비어 일반 조치문) — 인사이트 재계산 자산의 기존 성질로 **수용**(§8 표에 기재).

## 6. (§4에 통합 — 별도 워커 섹션 없음)

## 7. UI (`ui/`) — E1·E2·E3

### 7.1 Zod (`api/schemas.ts`)

- `ReportSchema.error_kinds`: `z.array(z.object({ kind: z.string(), count: z.number() })).optional()` — 서버가 `skip_serializing_if`(absent, null 아님)이므로 레포 규약(`schemas.ts:98-106` 명문화)대로 **`.optional()`**(`.nullish()` 아님 — 리뷰 R15). `InsightSchema.error_kind`: `z.string().optional()`. `ProfileSchema.connect_timeout_seconds`: `z.number().optional()`(같은 근거 — `Option`+skip이라 null 불가).

### 7.2 리포트 분류표 (`ReportView`) — E1

- 새 섹션 "Transport 실패 분류": kind ko 라벨 + count + 비율(status=0 총합 대비) 표. `error_kinds` absent/빈 배열이면 **섹션 자체 미렌더**. status 분포 섹션 인접, `PageSection` 캐넌.

### 7.3 InsightPanel — E2

- 신규 2종 ko 문구 + `actionFor` 조치문 분기(지배-kind 3분기 + loadgen). **`computed: true`**(§5.4). 조치문 이외의 접이식/토글 규율은 기존 그대로.

### 7.4 RunDialog — E3

- 상세(고급) 영역 `http_timeout` 인접에 "연결 수립 타임아웃(초)" 입력 — 빈 값=미설정(payload 키 생략), 1–600 정수, http_timeout 미만. **배선 지점 전수**(리뷰 R12 — 하나라도 빠지면 "접힌 섹션에 값이 숨는" 이 사용자가 반복 지적한 결함 클래스): ① `advancedPrefill`(`RunDialog.tsx:151-166`) ② 제출 게이트의 invalid 술어(`:440-472`, `!httpTimeoutInvalid` 4곳 패턴에 합류) ③ `detailedAppliedCount`(`:395-400`) — "N개 설정됨" 힌트 ④ 프리셋 로더(`:243`) ⑤ 프리셋 "비기본값 → 상세 전환" 술어(`:280`).

### 7.5 ko 카탈로그 (`i18n/ko.ts`)

kind 라벨 8종: 연결 거부 / 연결 끊김(reset) / 연결 수립 타임아웃 / 요청 타임아웃 / DNS 실패 / TLS 실패 / 테스터 포트 고갈 / 기타. 인사이트 2종 제목·본문·조치문 + `insightLabels` 2키. 고유명사(TIME_WAIT 등) 원어 병기(ADR-0035).

## 8. 데이터/와이어 변경 요약 (불변식)

| 레이어 | 변경 | byte-identical 조건 |
|---|---|---|
| 엔진 | `ErrorKind`+분류, `ExecOutcome.error_kind`, `MetricFlush.error_kind_stats`(8번째 필드, 6드레인+5가드), `RunPlan.connect_timeout`(리터럴 ~43곳), `VuClient` 4번째 인자 | transport 에러 0 → 벡터 빈 채 유지; 노브 None → 빌더 호출 없음 |
| proto | `ErrorKindStat`+`MetricBatch.error_kind_stats=10`, `Profile.connect_timeout_seconds=15` | additive — 구 워커/컨트롤러 혼합 시 필드 무시(그 워커 몫 kind 미집계 — `error_kinds` 부분/공백 허용, §5.4 R10 거동) |
| controller | migration(신규 테이블), ingest UPSERT, `Profile.connect_timeout_seconds`, 검증 2규칙(위치 §5.1), `ReportJson.error_kinds`, `Insight.error_kind`, 인사이트 2종+`order_rank`+export 17열, `status_temporal` 억제 | 에러 0 run → `error_kinds` 생략·인사이트 미발행 = 기존 JSON 동일. **예외(수용)**: 과거 run에 onset 인사이트 소급 등장 가능(§5.4) — 이때 `status_temporal` 억제로 기존 인사이트가 사라질 수도 있음(더 구체적 판정으로 대체된 것) |
| UI | Zod 3필드(`.optional()`), 분류표 섹션, InsightPanel 2종(computed)+`insightLabels`, RunDialog 5지점 | absent 파싱 OK(구 리포트), 입력 빈 값 → payload 생략 |

## 9. 테스트

### 9.1 엔진 (E1·E3)

- **분류 통합 테스트**(실 reqwest, `tests/error_kind.rs`): ① refused=bind 후 drop한 포트 ② **신선-커넥션 reset**=accept 직후 SO_LINGER 0 close ③ **keep-alive 재사용 reset**=1번째 요청 정상 응답(keep-alive) 후 2번째 요청의 **head를 읽은 뒤** RST — hyper "connection closed before message completed" 경로 핀(리뷰 R2, 사고 앵커 대표 형태; head 발신 *전* 절단은 hyper-util 투명 재시도로 표면화 안 돼 flake — 리뷰 N5) ④ timeout=accept 후 무응답 + 짧은 `http_timeout` ⑤ connect_timeout=비라우팅 IP(`10.255.255.1`) + `connect_timeout(1s)`. reqwest 플래그 조합(is_timeout/is_connect)을 핀 고정하는 것이 목적 — §3.1 규칙 1·2·4가 가설이므로 테스트가 진실.
- **⑤의 폴백(결정)**: 비라우팅 IP가 CI/환경에서 즉시 unreachable을 주면 — skip 가드 금지 — **backlog-포화 리스너로 대체**: `tokio::net::TcpSocket::new_v4()?.listen(1)`(std `TcpListener::bind`는 backlog 미노출·기본 128이라 부적합, tokio는 이미 dev-dep = 신규 의존 0 — 리뷰 N4)로 backlog 1 리스너를 만들고 accept 안 하는 상태에서 선행 커넥션으로 백로그를 채워 이후 connect가 SYN 대기에 걸리게 함(로컬 결정적). plan 단계에서 두 방식 중 로컬 실측으로 확정.
- **`LocalPortExhaustion`/`Dns`/`Tls` 매핑 단위 테스트**: 실 유발이 위험/불안정하므로 소스-체인 walk 헬퍼를 `&dyn Error` 입력으로 분리해 합성 `io::Error` 체인으로 검증(fall-through 케이스 — 비매핑 kind가 있어도 계속 walk — 포함).
- 드레인/가드: error_kind_stats가 periodic·final 양쪽 드레인 + 빈 run 미송신 — 3경로(`Mode::{Closed,Curve,Open}` 헬퍼 선례).
- 회귀 가드 테스트는 **고의 회귀→RED→원복→GREEN 실증**(plan-mandated-vacuous-tests 규율).

### 9.2 controller (E1·E2·E3)

- ingest UPSERT 가산·멀티 flush 합산·`build_report` 롤업 정렬. 인사이트: §5.4 수식 경계 양쪽(h=9 미발행/h=10 발행, bad 경계 0.01/0.10, sustained 50% 경계, 빈-초 갭 존재 fixture, **밴드 통과형(1%→5%→80%) 발행 fixture — 리뷰 N1**, `error_kinds` 빈 경우 일반 조치문, `status_temporal` 억제 확인) + 지배-kind 3분기 + loadgen 1건 발행. **`status_temporal` 기존 테스트 3건(`insights.rs:744`/`:773`/`:791`)과 fixture(`:930`)의 전제를 억제 규칙에 맞춰 조정**(리뷰 N6). `validate_run_config` 2규칙 400(삽입 위치 뒤 기존 규칙 회귀 없음). export 17열 정합.
- e2e report smoke: 실패 유발 run 1개 → `/report`에 `error_kinds` 존재 + `ReportSchema.parse` 통과.

### 9.3 UI (E1·E2·E3)

- RTL: 분류표 렌더/미렌더, InsightPanel 2종 문구+computed 렌더(토글 off에서도 조치문 보임), RunDialog 입력→payload 생략/포함+"N개 설정됨" 힌트+프리셋 왕복. Zod parity: 서버 실 응답 fixture(absent 케이스).

## 10. 라이브 검증 (US 척추 — 서브슬라이스별)

`/live-verify` 스택 + 클래스 유발 responder. **워커 재빌드 필수**(엔진 모델 변경).

| US | 슬라이스 | 절차 | 통과 신호 |
|---|---|---|---|
| US1 | E1 | 시나리오 2스텝: 정상 responder + 닫힌 포트 URL | 분류표에 `connect_refused` count>0, 정상 스텝 오염 없음 |
| US1' | E1 | keep-alive 후 RST responder(재사용 커넥션 절단) | 분류표에 `connection_reset` count>0 (`other` 아님 — R2 실전 검증) |
| US2 | E2 | t=20s부터 200→503+5s 지연 전환 responder, duration 60s | `midrun_error_onset` 발행, onset_second≈20±수초, "5xx 동반", **조치문이 토글 off 기본 상태에서 보이고** SUT 점검 목록 포함, `status_temporal` 미발행 |
| US3 | E3 | `connect_timeout=2` + 비라우팅 IP(또는 backlog-포화) 스텝 | 분류표 `connect_timeout` count>0; 대조 run(노브 미설정·`http_timeout=5`)은 `timeout` — OS SYN 타임아웃(수십s)보다 전체-타임아웃이 먼저라 `is_connect` 미성립(리뷰 R14 주의 반영) |
| US4 | E1(표)+E2(인사이트) | 라이브 유발 제외(머신 포트 고갈 위험) — §9.1 단위 테스트 갈음, 근거 build-log 기록 | 매핑 단위 테스트 + 인사이트 fixture 테스트 green |
| 회귀 | 각 | 에러 0 정상 run | `error_kinds` 키 부재·신규 인사이트 부재·분류표 미렌더·기존 인사이트(saturation 등) 불변 |

## 11. 보안 게이트 예상

diff가 `executor.rs`(요청 실행)를 건드리므로 **security-reviewer 필수 예상**(finish-slice §0 grep 매치). 설계상 완화: 에러 원문은 어떤 새 sink에도 안 넣음(kind enum만) + 분류가 최상위 `Display`(URL 렌더)·`{:?}` Debug(reqwest Debug가 `url` 필드를 찍음 — 리뷰 N2)를 만지지 않음(§3.1) + `safe_cause` allowlist(`error.rs`) 무접촉(`EngineError` 변형 추가 없음).

## 12. ADR

신설 1건(다음 번호): "transport 에러 분류 체계 + 원인 후보 인사이트" — 8종 taxonomy 와이어 계약(추가 additive·이름 불변), 원인 문구는 "가능성 안내"(단정 금지·**용량 주장 금지 — validity/narrative와의 공존 정책 §5.4**), counts-only(원문 비영속·최상위 Display 비사용) 원칙, 구성 인사이트 비도입(분류표+validity 2표면 유지). connect_timeout 노브는 S-A 범위 내 additive라 한 줄 언급만.

## 13. 서브슬라이스 분해 (구현 단위 — 각자 plan·리뷰·라이브 검증)

리뷰 스코프 판정 수용: 한 슬라이스로는 (a) 새 메트릭 채널 전 계층 (b) 시계열 휴리스틱 서브시스템 (c) 프로필 노브 전 계층이 겹쳐 과대. A3a/b/c·34a/b/c 선례대로 영역 spec 1 + plan 3:

- **E1 — taxonomy + 분류표** (US1·US4 표): §3.1–3.3 + §4(E1) + §5.2–5.3 + §7.1(error_kinds)·7.2·7.5(라벨 8종). 완료 시 US1·US1' 라이브 + US4 단위 테스트.
- **E2 — onset·loadgen 인사이트** (US2·US4 안내): §5.4 + §7.1(Insight)·7.3·7.5(인사이트 문구) + export 17열. E1 데이터로 도그푸딩 후 임계 실측 보정 여지(R8/R9의 답이 E1 데이터에 있음). 완료 시 US2 라이브.
- **E3 — connect_timeout 노브** (US3): §3.4 + §4(E3) + §5.1 + §7.1(Profile)·7.4. 완료 시 US3 라이브.

권장 순서 E1 → E2 → E3 (E2가 E1의 `error_kinds`에 의존; E3는 독립이라 E1 뒤 어디든 인터리브 가). 각 서브슬라이스가 독립 머지 단위(별도 plan + REVIEW-GATE + live-verify).
