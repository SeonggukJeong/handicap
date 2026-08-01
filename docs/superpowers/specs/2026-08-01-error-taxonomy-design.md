# transport 에러 분류(taxonomy) + 원인 후보 인사이트 + connect_timeout 노브

**유형: user-path** · 워크트리 `error-taxonomy` · ADR: 신설 1건 예정(에러 분류 와이어 계약 + 원인 후보 인사이트 원칙 — 다음 번호)

## 사용자 스토리 (US)

> **사고 앵커(원문)**: "부하 테스트 중 수신측 소켓 부족으로 오류 — 테스터엔 그냥 타임아웃·503만 보였고, 수신측 소켓 재사용 설정으로 해결하기까지 원인 파악이 너무 오래 걸렸다." (2026-08-01 사용자)

- **US1**: QA가 타임아웃·503이 급증한 run을 마친 뒤 리포트를 열어 실패의 정체를 확인하려 한다 — 성공하면 지금까지 status=0 한 버킷으로 뭉뚱그려졌던 transport 실패가 종류별 분류표(연결 거부/연결 끊김/연결 수립 타임아웃/요청 타임아웃/DNS/TLS/테스터측 포트 고갈)로 나뉘어 보인다.
- **US2**: QA가 "처음엔 정상 → 런 도중부터 급증" 패턴의 run 리포트를 열면 — 성공하면 "t=N초까지 정상, 이후 transport 실패 급증(5xx 동반)" 시간 패턴 요약과 "SUT 측 소켓/포트 고갈 가능성 — TIME_WAIT·재사용 설정·backlog·FD 한도 확인" 원인 후보 안내를 본다(해당 패턴 없으면 블록 자체 미렌더).
- **US3**: QA가 타임아웃의 정체를 좁히기 위해 connect 타임아웃을 별도 설정하고 재실행한다 — 성공하면 connect 단계에서 막힌 요청이 `connect_timeout` 클래스로 분리돼 "서버가 연결 자체를 못 받는 상태"라는 결정적 신호를 본다(미설정 시 현행 거동·와이어 byte-identical).
- **US4**: QA가 부하 발생기 자신이 병목인 상황(로컬 ephemeral 포트 고갈)에서 run을 돌리면 — 성공하면 `local_port_exhaustion` 클래스로 분리돼 SUT 문제와 구분된 안내("부하 도구 머신의 포트 범위/재사용 설정 확인")를 본다 — SUT를 잘못 의심하는 역방향 오진 방지.

## 1. 문제

transport-레벨 실패(연결 거부·reset·타임아웃·DNS…)는 전부 `ExecOutcome { status: 0, error: Some(문자열) }`로 접히고(`crates/engine/src/executor.rs:283-294`), 집계는 counts-only라 리포트에 도달하는 정보는 "status=0이 N건"뿐이다. 에러 *종류*는 per-request 문자열로만 존재하다 버려진다. 그 결과:

- SUT 소켓/포트 고갈(사고 앵커)의 대표 증상인 connection reset·connect 지연이 "타임아웃"과 구분 불가.
- 전체-요청 타임아웃(reqwest `RequestBuilder::timeout`)은 connect 단계에서 멈췄는지 응답 대기에서 멈췄는지 알려주지 않는다.
- "처음 정상 → 도중 급증"이라는 자원 고갈 서명은 기존 초당 시계열(`ReportWindow.status_counts`)에 이미 있으나 아무도 해석해주지 않는다 — 루트 CLAUDE.md의 "status=0 + 높은 RPS" 휴리스틱이 문서로만 존재.
- 부하 발생기 자신의 포트 고갈(EADDRNOTAVAIL)과 SUT 문제가 구분되지 않아 역방향 오진 위험.

## 2. Goals / Non-goals

### Goals

1. send-실패를 8종 분류(taxonomy)로 접어 counts-only로 리포트까지 운반 (US1).
2. 기존 초당 시계열로 mid-run 급증(onset) 패턴을 서버측 판정, 분류 구성과 결합한 원인 후보 인사이트 3종 (US2, US4).
3. `connect_timeout_seconds` 프로필 노브(opt-in) — connect 단계 타임아웃을 별도 클래스로 분리 (US3; S-A 의도적 연기 항목 회수).
4. transport 에러 0인 run·노브 미설정 run은 전 레이어 byte-identical.

### Non-goals (연기·제외)

- **per-window(초당) kind 시계열** — onset은 기존 status "0" 시계열로 충분, 와이어 비용만 큼 (연기).
- **에러 원문 문자열 영속/표면화** — reqwest error `Display`가 URL(크레덴셜 포함 가능)을 렌더하는 문서화된 함정(엔진 CLAUDE.md `Http(reqwest::Error)` 항목). kind만 운반한다 (의도적 제외 — 재고 시 §B1 마스킹과 함께).
- **body-read 중 reset 분류** — `read body:` 경로는 진짜 status를 이미 수신한 뒤라 status=0 오진 위험이 없음. 현행 유지 (연기).
- **trace/test-run(에디터) 표면** — test-run은 1회성 진단이라 taxonomy 가치 낮음. `ExecOutcome.error_kind`는 traced twin에도 채워지지만(lockstep) trace JSON/UI 미노출 (연기).
- **validity(§A11) 체계 통합** — `local_port_exhaustion`은 측정 유효성 문제지만 v1은 인사이트(critical)로만. `evaluateTrust`/validity 연동은 도그푸딩 후 (연기).
- **ScheduleForm connect_timeout 입력** — 와이어는 통과(Profile 필드), 폼 입력은 RunDialog만 v1 (연기; open-loop misconfig 경고의 ScheduleForm 연기 선례).
- **per-step kind 리포트 표면** — DB엔 per-step으로 저장, 리포트/UI는 run-level 롤업만 v1 (연기).
- **export(CSV/XLSX) error_kinds 열** — insights는 기존 경로로 자동 포함, 분류표 자체의 export 열은 연기.
- **실행 중 조기 경보** — 사후 리포트만 (ADR-0009 일관; 사용자 결정 2026-08-01).

## 3. 엔진 (`crates/engine`)

### 3.1 `ErrorKind` enum + 분류 함수 (신규 `error_kind.rs`)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ErrorKind {
    ConnectRefused,       // "connect_refused"
    ConnectionReset,      // "connection_reset" — connect 후 요청/응답헤더 단계 RST/BrokenPipe 포함
    ConnectTimeout,       // "connect_timeout"
    Timeout,              // "timeout" — 전체-요청 타임아웃, 단계 불명
    Dns,                  // "dns"
    Tls,                  // "tls"
    LocalPortExhaustion,  // "local_port_exhaustion" — 테스터 자신
    Other,                // "other"
}
impl ErrorKind { pub fn as_str(&self) -> &'static str { … } }
```

와이어 문자열은 위 주석의 snake_case 8종 — proto/DB/report/Zod 전 레이어에서 이 문자열이 계약이다(UI ko 라벨은 §7.5).

`pub fn classify_send_error(e: &reqwest::Error) -> ErrorKind` — 판정 순서(결정적):

1. **io 소스 체인 우선**: `std::error::Error::source()` 체인을 walk하며 첫 `std::io::Error`의 kind를 본다 — `AddrNotAvailable → LocalPortExhaustion` / `ConnectionRefused → ConnectRefused` / `ConnectionReset | BrokenPipe → ConnectionReset`. (타임아웃 체인엔 이 세 kind가 등장하지 않으므로 순서 안전.)
2. **타임아웃**: `e.is_timeout()` → `e.is_connect()`도 참이면 `ConnectTimeout`(reqwest `connect_timeout` 발화), 아니면 `Timeout`.
3. **DNS**: `e.is_connect()`이고 체인 메시지에 `"dns error"` 포함(hyper-util `ConnectError` 래핑 형식) → `Dns`.
4. **TLS**: 체인에 `rustls::Error` 다운캐스트 성공 또는 메시지에 `"tls"`/`"certificate"`(대소문자 무시) → `Tls`.
5. 그 외 → `Other`.

3·4는 best-effort 문자열 매치임을 함수 doc에 명시(미스매치는 `Other`로 안전 폴백 — 오분류보다 미분류). 1·2는 통합 테스트로 실제 reqwest 거동에 핀 고정(§9.1).

### 3.2 `ExecOutcome` 확장 + 기록 지점

- `ExecOutcome`에 `pub error_kind: Option<ErrorKind>` 추가. **send-실패 arm(`executor.rs:283-294`)에서만 `Some(classify_send_error(&e))`**, 나머지 전 구성 사이트(성공·body-read 실패·assert 실패·traced twin 포함)는 `None` — 컴파일러가 구성 사이트 전부 강제.
- `execute_step_traced`(의도된 중복, 엔진 CLAUDE.md)의 send-실패 arm도 lockstep으로 `Some(…)` — trace 표면 미노출이지만 두 함수 어긋남 금지 원칙 유지.

### 3.3 집계 → `MetricFlush`

- `Aggregator`에 `error_kinds: BTreeMap<(String, ErrorKind), u64>` 누적 + `record_error_kind(step_id, kind)` + `drain_error_kinds() -> Vec<ErrorKindStat>`. `ErrorKindStat { step_id: String, kind: ErrorKind, count: u64 }` (delta 의미론 — branch_stats 동형).
- VU 루프 3경로(`run_vu`/`run_vu_curve`/`run_arrival`)가 outcome 기록 시 `error_kind`가 `Some`이면 `record_error_kind` 호출. `execute_steps` 재귀 내부(loop/if/parallel 분기)의 outcome도 동일 — 기록 지점은 기존 `agg.record(…)` 호출부와 같은 자리.
- `MetricFlush`에 8번째 벡터 `pub error_kind_stats: Vec<ErrorKindStat>` — **드레인 6곳(closed periodic/final·open periodic/final·curve periodic/final) + send-guard `|| !error_kind_stats.is_empty()` 5곳(open-loop final만 무가드)** 전부 갱신(엔진 CLAUDE.md 6+5 함정). struct 리터럴 컴파일러 강제 + 드레인/가드 누락은 테스트로.

### 3.4 `connect_timeout` 배선

- `RunPlan`에 `pub connect_timeout: Option<Duration>` 추가.
- `VuClient::with_timeout(cookie_mode, timeout, measure_phases)` 시그니처에 `connect_timeout: Option<Duration>` 4번째 인자 — `Some`이면 `ClientBuilder::connect_timeout(d)` 체이닝, `None`이면 빌더 호출 자체 없음(byte-identical). 기존 호출 사이트(runner 3경로의 클라이언트 빌드 + executor 테스트 `executor.rs:1450`/`1467` 등)는 컴파일러 강제로 일괄 갱신.
- trace/test-run 클라이언트는 `None` 고정(§2 Non-goals).

## 4. proto (`crates/proto/proto/coordinator.proto`)

```proto
message ErrorKindStat {
  string step_id = 1;
  string kind = 2;      // §3.1 snake_case 8종
  uint64 count = 3;     // delta since last flush
}
// MetricBatch에 추가:
repeated ErrorKindStat error_kind_stats = 10;  // 다음 번호(현재 9까지 사용)
```

- proto `Profile`에 `optional uint32 connect_timeout_seconds = 15;` (현행 최대 = 14 `graceful_ramp_down_seconds`; absent = 미설정 — 같은 optional-uint32 선례와 동형).
- 워커 `main.rs` forwarder의 **빈-배치 스킵 가드에 `&& flush.error_kind_stats.is_empty()` 추가 필수** — 누락 시 error_kind만 실린 flush가 유실(엔진 CLAUDE.md `active_vu_samples`/`dropped` 동형 함정).
- 워커 assignment→`RunPlan` 매핑에 connect_timeout 추가(prost `optional` = `Option<u32>` → `Option<Duration>` 직결).

## 5. controller (`crates/controller`)

### 5.1 store `Profile` + 검증

- `store/runs.rs::Profile`에 `#[serde(default, skip_serializing_if = "Option::is_none")] pub connect_timeout_seconds: Option<u32>` — profile_json 스냅샷 하위호환(기존 run 역직렬화 시 None).
- `api/runs.rs::validate_run_config`: `Some(v)`일 때 `1..=600` 범위 밖 → 400. 추가로 **유효 http timeout(미설정=30) 이상이면 400** ("connect_timeout_seconds must be less than the effective http timeout") — 전체-요청 타임아웃이 먼저 발화해 노브가 조용히 무의미해지는 misconfig를 생성 시점에 차단.
- dispatch 매핑(runs.rs의 profile→assignment)에 필드 전달. 프리셋/스케줄은 Profile 재사용이라 자동 통과(폼 입력만 RunDialog v1).

### 5.2 메트릭 ingest + 저장

- 신규 테이블 `run_error_kind_metrics(run_id TEXT, step_id TEXT, kind TEXT, count INTEGER)` — migration은 `/new-migration`으로 채번(작성 시점 다음 번호 0020 예상). ingest는 `(run_id, step_id, kind)` UPSERT 가산(counts-only delta 합산 — `run_if_metrics` 동형, HDR 아님·append-only 불필요).
- grpc coordinator의 MetricBatch 처리에 `error_kind_stats` 저장 추가. 멀티워커 merge = SUM(가산 UPSERT가 자연 처리).

### 5.3 `build_report` + `ReportJson`

- `ReportJson`에 `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub error_kinds: Vec<ErrorKindCount>` — `ErrorKindCount { kind: String, count: u64 }`, **run-level 롤업**(step/kind SUM을 kind로 재집계), 정렬 = count desc → kind asc(결정적). 빈 run은 직렬화 생략 → 기존 골든 fixture(ADR-0030 TS↔Rust parity) 무변경.

### 5.4 인사이트 3종 (`insights.rs::derive_insights`)

`derive_insights`에 `error_kinds: &[ErrorKindCount]` 인자 추가(report.rs 호출부 배선). `Insight`에 `#[serde(skip_serializing_if = "Option::is_none")] pub error_kind: Option<String>` additive 필드 1개. 모두 **해당 없으면 미발행**(report-advice-noise 규율 — ok는 블록 자체 없음):

| kind | 발행 조건 (결정적) | 내용 필드 |
|---|---|---|
| `transport_error_composition` | `total0 = status_distribution["0"]` ≥ 10 **그리고** ≥ `summary.count`의 0.5% | count=total0, pct=share, error_kind=최다 kind, value=최다 kind의 count. severity: share≥10% → critical, 아니면 warning |
| `midrun_error_onset` | ①초당 합산 시계열에서 bad(t)=Σ(status "0" + 5xx)/Σcount ②첫 10초 이상 연속 bad<1% 구간(건강 구간) 존재 ③이후 bad≥10%인 첫 초 t0 존재 ④t0~끝 구간의 ≥50% 초가 bad≥10% | value=t0의 run-시작 대비 오프셋 초, status_class=onset 후 5xx≥10건이면 "5xx", error_kind=지배 kind(§아래). severity: critical |
| `loadgen_port_exhaustion` | `error_kinds`에 `local_port_exhaustion` > 0 (1건이라도) | count=해당 건수. severity: critical |

- **지배 kind 판정**(onset 인사이트의 원인 후보 조치문 선택): `error_kinds` 합 대비 ≥50%인 kind가 {`connection_reset`, `connect_timeout`, `timeout`} 중 하나 → "SUT 소켓/포트/자원 고갈 가능성" 조치문; `connect_refused` ≥50% → "SUT 리슨 안 함/포트 오설정" 조치문; 그 외 → 일반 조치문. 5xx-only onset(transport 0)도 발행 가능 — error_kind=None, 일반 조치문.
- 조치문(권장 확인 목록)은 UI `actionFor` 경유·기본 숨김 토글(기존 규율). `loadgen_port_exhaustion`의 본문은 "부하 발생기 머신 문제 — SUT 문제 아님"을 명시(US4의 핵심 가치).
- 윈도 합산은 `windows`(per-step per-second)를 ts_second로 재집계 — 새 데이터 불필요. run 시작초 = windows 최소 ts_second.

## 6. worker (`crates/worker`)

- §4의 forwarder 스킵-가드 + assignment 매핑 두 가지가 전부. 엔진 `MetricFlush` 리터럴/드레인은 §3.3.

## 7. UI (`ui/`)

### 7.1 Zod (`api/schemas.ts`)

- `ReportSchema`에 `error_kinds: z.array(z.object({ kind: z.string(), count: z.number() })).optional()` (서버 skip-if-empty ↔ absent 허용). `InsightSchema`에 `error_kind: z.string().optional()`. `ProfileSchema`에 `connect_timeout_seconds: z.number().nullish()` — **서버-`null`/absent 양쪽 허용**(`.optional()`만 쓰면 S-D `.nullish()` 함정 재발, ui/CLAUDE.md).

### 7.2 리포트 분류표 (`ReportView`)

- 새 섹션 "Transport 실패 분류": kind ko 라벨 + count + 비율(총 status=0 대비) 표. `error_kinds` absent/빈 배열이면 **섹션 자체 미렌더**. 위치는 status 분포 섹션 인접. `PageSection` 캐넌 사용(ADR-0043 계열 기존 프리미티브).

### 7.3 InsightPanel

- 신규 insight kind 3종의 ko 문구 + `actionFor` 조치문 분기(지배-kind별 3종). 기존 조치문 패널 토글(기본 숨김·영속) 규율 그대로.

### 7.4 RunDialog

- 상세(고급) 영역의 `http_timeout` 입력 인접에 "연결 수립 타임아웃(초)" 입력 — 빈 값=미설정(payload에서 키 생략, byte-identical), 1–600 정수. 접이식/상세 배치는 기존 http_timeout 배치 관례 따름(사용자 선호: optional 섹션 disclosure).

### 7.5 ko 카탈로그 (`i18n/ko.ts`)

kind 라벨 8종: 연결 거부 / 연결 끊김(reset) / 연결 수립 타임아웃 / 요청 타임아웃 / DNS 실패 / TLS 실패 / 테스터 포트 고갈 / 기타. 인사이트 3종 제목·본문·조치문. 고유명사(TIME_WAIT 등) 원어 병기(ADR-0035).

## 8. 데이터/와이어 변경 요약 (불변식)

| 레이어 | 변경 | byte-identical 조건 |
|---|---|---|
| 엔진 | `ErrorKind`+분류, `ExecOutcome.error_kind`, `MetricFlush.error_kind_stats`(6+5), `RunPlan.connect_timeout`, `VuClient` 4번째 인자 | transport 에러 0 → 벡터 빈 채 유지; 노브 None → 빌더 호출 없음 |
| proto | `ErrorKindStat`+`MetricBatch.error_kind_stats=10`, `Profile.connect_timeout_seconds=15` | additive — 구 워커/컨트롤러 혼합 시 필드 무시 |
| controller | migration(신규 테이블), ingest UPSERT, `Profile.connect_timeout_seconds`, 검증 2규칙, `ReportJson.error_kinds`, `Insight.error_kind`, 인사이트 3종 | 에러 0 run → `error_kinds` 직렬화 생략·인사이트 미발행 = 기존 리포트 JSON 동일 |
| UI | Zod 3필드, 분류표 섹션, InsightPanel 문구, RunDialog 입력 | absent 파싱 OK(구 리포트), 입력 빈 값 → payload 생략 |

## 9. 테스트

### 9.1 엔진

- **분류 통합 테스트**(실 reqwest, `tests/error_kind.rs`): refused=bind 후 drop한 포트로 접속 / reset=accept 직후 SO_LINGER 0 close하는 tokio listener / timeout=accept 후 무응답 + 짧은 `http_timeout` / connect_timeout=비라우팅 IP(`10.255.255.1`) + `connect_timeout(1s)` — **reqwest 플래그 거동(is_timeout/is_connect 조합)을 핀 고정**하는 것이 목적(§3.1의 2번 규칙이 가설이므로 테스트가 진실). CI 환경에서 비라우팅 IP가 즉시 unreachable을 줄 수 있음 → 그 경우 kind가 `ConnectTimeout`이 아닌 값으로 나오면 skip 처리하는 가드 금지 — 대신 로컬 게이트에서 실측 후 plan에서 대체 전략(예: 스로틀 리스너) 확정.
- **`LocalPortExhaustion`/`Dns`/`Tls` 매핑 단위 테스트**: 실 유발이 위험/불안정(머신 포트 고갈)이므로 io::ErrorKind→ErrorKind 매핑 로직을 소스-체인 walk 헬퍼에 분리해 합성 `io::Error` 체인으로 검증.
- 드레인/가드: error_kind_stats가 periodic·final 양쪽에서 드레인되고 빈 run엔 안 실리는 것 — 3경로(`Mode::{Closed,Curve,Open}` 헬퍼 선례, think_time.rs) 각각.
- 회귀 가드 테스트는 **고의 회귀→RED→원복→GREEN 실증**(plan-mandated-vacuous-tests 규율).

### 9.2 controller

- ingest UPSERT 가산·멀티 flush 합산·`build_report` 롤업 정렬. 인사이트 3종: windows fixture로 발행/비발행 경계(건강 구간 9초=미발행, 10초=발행 등 임계 양쪽) + `error_kinds` 지배-kind 3분기. `validate_run_config` 2규칙(범위·cross-field) 400.
- e2e report smoke: 실패 유발 run 1개 → `/report`에 `error_kinds` 존재 + `ReportSchema.parse` 통과.

### 9.3 UI

- RTL: 분류표 렌더/미렌더, InsightPanel 3종 문구, RunDialog 입력→payload 생략/포함. Zod parity: 서버 실 응답 fixture(absent·null 케이스).

## 10. 라이브 검증 (US 척추)

`/live-verify` 스택 + 각 클래스 유발 responder. **워커 재빌드 필수**(엔진 모델 변경 — 루트 CLAUDE.md 함정).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 시나리오 2스텝: 정상 responder + 닫힌 포트 URL, run 실행 | 리포트 분류표에 `connect_refused` count>0, 정상 스텝 오염 없음 |
| US2 | t=20s부터 200→503+5s 지연으로 전환하는 responder, duration 60s | `midrun_error_onset` 발행, value≈20±수초, "5xx 동반", 조치문에 SUT 확인 목록 |
| US3 | `connect_timeout=2` + 비라우팅 IP 스텝 | 분류표 `connect_timeout` count>0 (미설정 대조 run은 `timeout`) |
| US4 | 라이브 유발 제외(머신 포트 고갈 위험) — §9.1 단위 테스트로 갈음, 근거 build-log 기록 | 단위 테스트 green + 인사이트 fixture 테스트 |
| 회귀 | 에러 0 정상 run | 리포트 JSON에 `error_kinds` 키 부재·인사이트 3종 부재·분류표 미렌더 |

## 11. 보안 게이트 예상

diff가 `executor.rs`(요청 실행)를 건드리므로 **security-reviewer 필수 예상**(finish-slice §0 grep 매치). 설계상 완화: 에러 원문 문자열은 어떤 새 sink에도 넣지 않음(kind enum만 운반 — reqwest Display URL 노출 함정 회피). `safe_cause` allowlist(`error.rs`)는 무접촉 — `EngineError` 변형 추가 없음(분류는 `Ok(ExecOutcome)` 경로).

## 12. ADR

신설 1건(다음 번호): "transport 에러 분류 체계 + 원인 후보 인사이트" — 8종 taxonomy 와이어 계약(추가는 additive·이름 불변), 원인 문구는 "가능성 안내"(단정 금지 — 테스터 관점 증거만으로 SUT 내부를 단정할 수 없음), counts-only(원문 비영속) 원칙. connect_timeout 노브는 ADR-0031/S-A 범위 내 additive라 본 ADR에 한 줄 언급만.
