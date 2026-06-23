# 트랜잭션 시간 분해 — DNS/connect/wait/download phase 분해 (A4 LoadRunner급 리포트 깊이, 하이브리드 v1)

- **날짜**: 2026-06-24
- **상태**: spec+plan spec-plan-reviewer clean APPROVE(2026-06-24·사용자 설계승인) → 구현 대기(STOP-gate, fresh 컨텍스트)
- **출처**: roadmap §A4 마지막 잔여(트랜잭션 시간 분해 DNS/TCP/TLS/TTFB) + 사용자 요청(2026-06-24 슬라이스 선택). **왜 지금**: A4의 고가치 부분(SLO·비교·인사이트·히스토그램·B7-C TTFB+download)이 다 끝났고, "어디서 시간이 새는가"의 마지막 분해 갭만 남음. roadmap이 "reqwest로 불가·큰 슬라이스"로 봤으나 실측 결과 reqwest 0.12가 hook을 노출(아래 §3) → proto/migration 0의 잘 닫힌 슬라이스로 판명.
- **연관**: B7-C 트랜잭션 단계 분해(TTFB+download, `crates/controller/CLAUDE.md`·`engine/CLAUDE.md` phase 채널) · ADR-0017(MVP 리포트 범위) · ADR-0009(라이브 대시보드 없음·종료 후 리포트) · ADR-0035(ko.ts 문구).
- **ADR**: 신규 불필요 — ADR-0017 리포트 범위 + B7-C phase 패턴 내 **additive**(proto 주석이 이미 `"dns/tcp/tls/total later"` 예약). 계측 접근(reqwest `connector_layer`+`dns_resolver`+task-local, raw hyper 재구현 회피)은 구현 결정이라 spec §3·build-log에 기록.

---

## 1. 문제와 목표

현재 리포트는 요청 시간을 **TTFB(전체) + download** 2단계로만 본다(B7-C). "TTFB 안에서 DNS가 느린가·연결 핸드셰이크가 느린가·서버가 느린가"를 못 가른다 — LoadRunner의 핵심 진단(어디서 시간이 새나)이 빠져 있다. 부하 테스트는 keep-alive로 커넥션을 재사용하므로 DNS/TCP/TLS는 **요청당 거의 0**(커넥션당 첫 요청만 지불) — 그래서 "요청당 평균"이 아니라 **하이브리드 모델**로 답한다.

- **목표**: ① `measure_phases` opt-in run에서 **연결 비용**(DNS, connect=TCP+TLS)을 **커넥션 단위로 집계**해 run-level로, ② **wait**(=TTFB−connect=거의 서버 처리시간)를 **스텝당** 분해(기존 download 옆)해 리포트·UI에 노출. ③ UI는 단순 나열이 아니라 시각화(재사용률 게이지·워터폴/칩 토글) + 초보자 설명 + ⓘ HelpTip.
- **비목표(연기)**: §7. 한 줄: TCP↔TLS 분리·wait의 network/server 분리·스텝당 connect 드릴다운·connect 시계열·test-run trace connect·exact 커넥션 카운트.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | `measure_phases` ON일 때 엔진은 신규 커넥션의 **DNS 시간**과 **connect-total(DNS+TCP+TLS) 시간**을 측정해 그 요청에 귀속하고, **재사용 커넥션은 0** | engine 단위테스트: wiremock 1서버에 2요청(`pool_max_idle_per_host` 기본) → 첫 요청 connect_total>0·둘째 0 (task-local 관찰) | |
| R2 | 엔진이 phase 3종을 `record_phase`로 기록 — `"wait"`(=TTFB−connect, **매 요청·per-step**), `"dns"`+`"connect"`(=connect_total−dns=TCP+TLS, **신규 커넥션일 때만**, triggering step_id). **proto/migration 무변경**(phase 문자열·`run_phase_metrics` 재사용) | aggregator 테스트(phase 키 누적) + `record_phase` **단일 site**(`runner.rs:473`, `execute_steps`의 download 미러 블록)에 추가 | ✅ phase 문자열 채널(proto `PhaseStat.phase`·migration 0013 재사용, 둘 다 0-diff) |
| R3 | `measure_phases` OFF면 `VuClient`가 resolver/connector_layer를 **미설치** = 현 `with_timeout`와 **byte-identical**(네트워크 동작·메트릭·클라 구성 무변경) | off run 리포트에 wait/dns/connect 행 0 + 클라 구성 분기 테스트 | |
| R4 | 커스텀 resolver는 기본 GAI resolver를 대체하되 **동작 등가**(opt-in run이 정상 해석·결과 skew 없음) — `tokio::net::lookup_host` 사용. **주의: 명시 호스트만 타깃이라 /etc/hosts·search-domain 미세차이는 저위험이나 라이브로 확인** | 라이브: phase-on run 정상 완료·해석 성공·DNS 값 sane(localhost ~0, 외부 호스트 >0) | |
| R5 | `build_report`가 `"dns"`/`"connect"`를 run-level `ReportJson.connection: Option<ConnectionStats>`로 롤업, `"wait"`를 step `wait: Option<PhaseStats>`로(기존 `download` 옆) | report build 테스트(롤업·step 부착) | ✅ serde → UI Zod |
| R6 | UI Zod `ReportSchema`가 run-level `connection` + step `wait`를 수용(`.optional()`/서버 None) | 실 `/report` 응답 `ReportSchema.safeParse` 통과(라이브, S-D 갭) | ✅ UI Zod ↔ serde |
| R7 | `ConnectionStats.reuse_ratio = 1 − connections_opened/requests_total`, `connections_opened` = `"connect"` phase 샘플 수, `requests_total` = 기존 step count 합. **`requests_total==0`이면 division 회피(`connection: None`일 때만 도달 가능하나 명시 guard)**, 전부 재사용(`connections_opened==0`) → `reuse_ratio=1.0` | report 테스트 exact 수치 + all-reused/0-req 엣지 | |
| R8 | UI 리포트에 run-level **"연결 비용" 카드**(재사용률 게이지·새 연결 수·DNS·connect p50/p95) + 스텝별 **wait/download 분해를 뷰 토글**(워터폴 막대 기본 ↔ 컴팩트 칩) | RTL: 카드 렌더·토글 전환·`measure_phases` off면 미렌더 | |
| R9 | 각 항목에 **초보자 1줄 설명**("무엇인가 + 함께 볼 것") + 긴 설명은 **ⓘ HelpTip 팝오버**, 전 문구 `ko.ts` 경유(ADR-0035) | RTL: HelpTip 존재·ko 카탈로그 키 / orchestrator grep 잔존 영어 0 | |
| R10 | `measure_phases` ON에서도 **처리량 무회귀** — 재사용 커넥션은 task-local scope만(신규만 계측) | 라이브 throughput A/B(phase-on vs off, RPS 변동 범위 내) | |

- **R11(문서화 한계, 테스트 아님)**: 귀속은 **근사** — hyper 풀 경합 시 백그라운드로 spawn된 connect(hyper-util `client.rs:446`)는 task-local 밖이라 누락 → `connections_opened`가 약간 과소. §5 명시·§7 연기(exact는 connector에 공유 핸들 필요).

---

## 3. 핵심 통찰 (설계 근거)

1. **reqwest를 버리지 않는다 (실측)**: reqwest 0.12.28은 `dns_resolver(Arc<R: Resolve>)`(`client.rs:2290`)와 `connector_layer(L: tower::Layer)`(`:2449`)를 노출 — DNS와 connect를 정확히 이 용도로 hook할 수 있다. cookies(ADR-0018 per-VU jar)·gzip·redirect·풀을 전부 유지(raw hyper 재구현 회피). roadmap의 "불가"는 B7-C 시점 미확인 추정이었음. (R1·R4)
2. **귀속이 가능한 이유**: hyper-util legacy client는 `future::select(checkout, connect).await`(`client.rs:422`)로 connect 미래를 **호출자 task에서 inline poll** → `send().await`를 task-local scope로 감싸면 resolver/connector_layer가 그 셀에 쓴다. 재사용이면 connect 미발동 → 0. (R1) **단** 풀 경합 시 background spawn(`:446`)은 task-local 밖 → 근사(R11).
3. **하이브리드인 이유 (keep-alive amortization)**: DNS/TCP/TLS는 커넥션당 1회라 "요청당 평균"이 ~0으로 오해를 부른다 → connect는 **커넥션 집계**(N개 열림·재사용률·분포)로, wait/download는 요청당 분해로. wait=TTFB−connect라 재사용/신규 무관하게 순수 서버 처리시간이 나온다. (R5·R7)
4. **proto/migration 0인 이유**: `PhaseStat.phase`는 자유 문자열이고 주석이 `"room for dns/tcp/tls/total later"`(`coordinator.proto:57`), `run_phase_metrics(run_id,step_id,phase,...)`(migration 0013)는 임의 phase/step 문자열을 받는다 → 새 phase 이름 + dns/connect를 triggering step_id로 저장하면 끝. `build_report`만 dns/connect를 run-level로 롤업. (R2)
5. **DNS/connect 분리 도출**: connector_layer는 커넥터 최외곽이라 DNS+TCP+TLS 합. 커스텀 resolver가 DNS를 따로 재므로 `connect(TCP+TLS) = connect_total − dns`(saturating). TCP↔TLS 추가 분리는 HTTPS 커넥터 재구현 필요 → §7 연기(사용자 선택 옵션1). (R2)
6. **opt-in이라 blast radius 제한**: `measure_phases`는 RunDialog opt-in(`RunDialog.tsx:740`, proto `measure_phases=11` "opt-in"). OFF면 resolver 교체조차 없어 byte-identical, 계측은 phase 분해를 켠 run에만. (R3)

---

## 4. 변경 상세

### 4.1 `crates/engine/src/conn_timing.rs` (신규) — 충족 R: R1, R4
- **선행: `crates/engine/Cargo.toml`에 `tower.workspace = true` 추가**(엔진은 현재 tower 직접 의존 없음 — 컨트롤러만 끌어옴; root `Cargo.toml:48` `tower = "0.5"`). **버전 통일 확인됨**: 워크스페이스 0.5→`0.5.3`, reqwest 0.12.28도 `tower 0.5.2`→`0.5.3`(동일 lock 노드) → `Layer`/`Service` trait이 reqwest와 통일돼 `connector_layer`가 우리 layer를 수용(lock의 0.4.13은 무관 subtree). 스파이크(Task 0)가 dep 누락을 가장 먼저 친다.
- `task_local! { static CONN_TIMING: ... }` — 요청 1회 타이밍 셀(interior mut, dns_us/connect_total_us). `record_dns`/`record_connect` 헬퍼.
- `TimingResolver`(impl `reqwest::dns::Resolve`, `resolve(&self, Name) -> Resolving`): `tokio::net::lookup_host`로 해석 + `Instant` 측정 → `CONN_TIMING`에 dns_us 기록. `Addrs` 반환(기본 동작 등가).
- `timing_connector_layer()`(tower `Layer`): inner connector `call()`을 `Instant`로 감싸 connect_total_us 기록. **반드시 type-opaque로 작성** — reqwest의 `Unnameable`/`Conn`(`connect.rs:1290/1298`)은 crate-private이라 **이름을 짓지 말고** 제네릭 `S: Service<Req>`로 inner future만 래핑(연관타입 forward). reqwest 실 bound = `L: Layer<BoxedConnectorService>` w/ `L::Service: Service<Unnameable, Response=Conn, Error=BoxError>`(`client.rs:2449`).

### 4.2 `crates/engine/src/executor.rs` — 충족 R: R1, R2, R3
- `VuClient::with_timeout`에 `measure_phases: bool` 추가(또는 신규 `with_options`): ON이면 `.dns_resolver(Arc::new(TimingResolver))` + `.connector_layer(timing_connector_layer())`, OFF면 현재 빌더 그대로(R3 byte-identical).
- `ExecOutcome`에 `dns: Option<Duration>`·`connect: Option<Duration>`·`wait: Option<Duration>` 가산(`download` 패턴 동형). `execute_step`이 `send().await`를 `CONN_TIMING.scope(...)`로 감싸고, 후 셀을 읽어 `wait=latency−connect_total`, `connect=connect_total−dns`(saturating); connect_total>0일 때만 dns/connect `Some`.
- `execute_step_traced`(trace)는 **무변경** — 기존 `download_ms`(`executor.rs:427`) 그대로 유지, dns/connect/wait phase는 **추가 안 함**(§7 연기). trace는 본래 download만 측정하므로 byte-identical.

### 4.3 `crates/engine/src/{runner.rs,aggregator.rs}` — 충족 R: R2, R3
- `record_phase` 기록은 **단일 site**(`runner.rs:473`, `execute_steps`의 Http arm `if measure_phases` 블록[471–478], 현 `download` 기록 바로 옆)에서 `measure_phases` 게이트 하에 `"wait"`(매번)·`"dns"`/`"connect"`(`outcome.connect`이 `Some`일 때) 추가 — download 미러. aggregator `record_phase` 시그니처 무변경(phase 문자열만 추가).
- `VuClient::with_timeout` 생성 **3 site**(`:349` closed `run_vu`·`:954` open `run_arrival` 슬롯풀·`:1111` vu-curve `Arc`)에 `measure_phases` 전달(전부 그 함수에 `measure_phases` 지역변수 이미 threading됨).

### 4.4 `crates/controller/src/report.rs` — 충족 R: R5, R7
- `"download"` 누적 옆에 `"wait"` 누적(step별 `PhaseStats`, `download_acc` 미러) → step `wait: Option<PhaseStats>`.
- `"dns"`/`"connect"` 행을 phase별로 run-level 합산(step_id 무시) → `ConnectionStats{dns: PhaseStats, connect: PhaseStats, connections_opened: u64, requests_total: u64, reuse_ratio: f64}`. `connections_opened` = connect count 합, `requests_total` = step count 합, `reuse_ratio` 도출. dns/connect 행 없으면 `connection: None`.
- `ReportStep`에 `wait`, `ReportJson`에 `connection` 가산(`#[serde(default, skip_serializing_if)]`).

### 4.5 `ui/src/api/schemas.ts` — 충족 R: R6
- step 스키마에 `wait: PhaseStatsSchema.optional()`, report에 `connection: ConnectionStatsSchema.optional()`. **nullability 규율(ui/CLAUDE.md)**: `wait`·`connection`은 serde `skip_serializing_if`로 키 생략 → **`.optional()`**(`.nullish()` 금지, B7-C download와 동형). 신규 `ConnectionStatsSchema`의 **내부 필드는 `connection: Some`일 때 항상 직렬화**되므로 `dns`/`connect`=`PhaseStatsSchema`, `connections_opened`/`requests_total`/`reuse_ratio`=**plain `z.number()`**(Option 아님 → `.optional()`/`.nullish()` 쓰지 말 것 — `number|undefined` 누출 `tsc -b` 트랩 회피).

### 4.6 `ui/src/components/report/*` + `ko.ts` — 충족 R: R8, R9
- 신규 `ConnectionCostCard.tsx`(run-level): 재사용률 게이지·새 연결 수·DNS·connect p50/p95 + 초보자 1줄 + ⓘ HelpTip. `measure_phases`/`connection` 있을 때만.
- `StepStatsTable.tsx`(또는 신규 `StepPhaseBreakdown.tsx`)에 wait 추가 + **뷰 토글**(`useState<'waterfall'|'chips'>`, 기본 waterfall): 워터폴=wait/download 수평 스택 막대, 칩=단계별 p50 칩. 초보자 설명 + ⓘ.
- `ko.ts`: `ko.report.connection.*`·`ko.report.phaseWait`·toggle 라벨·HelpTip 본문 신규 키.

---

## 5. 무변경 / 불변식 (명시)

- **proto 0 / migration 0 / 워커 로직 0**: phase는 문자열, `run_phase_metrics`·`MetricBatch.phase_stats` 재사용. 워커는 phase 문자열을 통과만.
- **`measure_phases` OFF → byte-identical**: resolver/connector_layer 미설치, ExecOutcome 새 필드 None, phase 행 0, 클라 구성 현행 동일(R3).
- **기존 phase(download)·summary(TTFB)·latency 분포·CSV/XLSX/비교 무변경**: wait/connection은 순수 가산. summary p50/p95/p99 = TTFB 그대로(wait는 그 *분해*지 대체 아님).
- **trace(test-run) 무변경**: connect phase는 trace에 미수집(§7).
- **R11 근사**: `connections_opened`는 background-spawn connect 누락분만큼 과소 가능(풀 경합 시) — 진단용 근사로 수용, 문구에 "약 N개" 뉘앙스.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | engine 테스트: wiremock 2요청 → 첫 요청 connect_total>0·둘째 0 (task-local) | |
| R2 | aggregator phase 키 누적 테스트 + `record_phase` **단일 site**(`runner.rs:473`) 추가 + ingest phase 행 | |
| R3 | off run wait/dns/connect 행 0 + 클라 구성 분기 단위테스트 | |
| R4 | phase-on run 정상 완료·DNS 값 sane | ✅ |
| R5 | report build: dns/connect 롤업·wait step 부착 테스트 | |
| R6 | 실 `/report` `ReportSchema.safeParse` 통과 | ✅ |
| R7 | reuse_ratio·connections_opened exact 단언 | |
| R8 | RTL: 카드·토글·off 미렌더 | |
| R9 | RTL HelpTip + orchestrator grep 영어 잔존 0 | |
| R10 | throughput A/B (phase-on vs off RPS) | ✅ |

- **라이브 필수**(`/live-verify`): run-생성·report-파싱·엔진 경로를 건드림(S-D 갭). 실 responder(http+https 둘 다·keep-alive)로 dns/connect 집계·재사용률·wait/step 관찰 + safeParse + 처리량 A/B + 브라우저 카드/토글/HelpTip·콘솔 Zod 0.
- **plan 권장 Task 0 = throwaway 스파이크**: `dns_resolver`+`connector_layer`+task-local이 실제로 per-request 타이밍을 채우는지(§3-2 inline-poll 가정) 작은 독립 바이너리로 실측 후 본 구현. 가정이 깨지면 connection-aggregate 전용(공유 핸들)로 fallback.

---

## 7. 의도적 연기 (roadmap §A4/§B에 누적)

- **TCP↔TLS 분리**: connector_layer 최외곽 한계 → HTTPS 커넥터(tokio-rustls) 재구현 필요(ALPN/인증서/SNI 복제). 사용자 선택 옵션1로 v1 제외.
- **wait의 network vs server 분리**: LoadRunner 시그니처(First Buffer→Network+Server). connect RTT 기반 휴리스틱 필요·keep-alive면 fresh RTT 드뭄 → 별도.
- **스텝당 connect 드릴다운**: 저장은 step별이나 v1 리포트는 run-level 롤업만. step별 connect 표면화는 후속.
- **connect/wait per-second 시계열**: active-VU·rps 시계열 선례지만 phase 시계열 채널 별도.
- **test-run trace에 connect 단계**: 단발 trace는 fresh 커넥션이라 실 DNS/connect를 보여줄 수 있으나 trace 경로 확장은 별도.
- **exact 커넥션 카운트**: connector_layer가 task-local 대신 run-global 공유 핸들에 쓰면 background-spawn connect도 포착(R11 해소) — 플러밍 추가라 후속.

---

## 8. 구현 순서 (plan 입력)

> green fold 주의: 미사용 헬퍼만/RED 테스트만 단독 커밋 불가(전체 워크스페이스 게이트). 엔진 신규 모듈+호출은 한 green 커밋으로 fold.

1. **Task 0 (스파이크, throwaway·미커밋)**: `crates/engine/Cargo.toml`에 `tower.workspace = true` 추가(root `Cargo.toml:48` 워크스페이스 dep) 후 resolver+connector_layer+task-local 실측(§6). 가정 확인 후 진행. (스파이크가 tower dep 누락을 가장 먼저 친다 — 의도된 순서.)
2. **엔진**: `conn_timing.rs` + `VuClient` measure 분기 + `ExecOutcome` 필드 + executor scope/계산 + runner **단일 site** `record_phase`(`:473`, `measure_phases`는 이미 threading됨) + VuClient 생성 3 site에 measure 전달 + 단위테스트(R1/R2/R3) — 한 green 커밋.
3. **컨트롤러**: `report.rs` 롤업/wait + `ConnectionStats`/`ReportStep.wait` + 테스트(R5/R7).
4. **UI**: Zod(R6) → `ConnectionCostCard` + 스텝 토글/wait + ko.ts + RTL(R8/R9).
5. **라이브 검증**(R4/R6/R10) → finish.
