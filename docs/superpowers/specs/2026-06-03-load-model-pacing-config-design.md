# 부하 모델·페이싱 설정 (Load Model & Pacing Config) — 영역 설계

> **상태**: 설계(brainstorming) — 2026-06-03. 출처: 로드맵 §B5 "open-loop / arrival-rate 부하 모델 + per-step·per-scenario timeout (P2)" + 사용자 요청(target RPS / ramp stages / think time / per-step timeout / http_timeout_seconds / max in-flight cap).
>
> **이 문서의 성격**: **영역(umbrella) spec**. 요청된 6개 + 추가 knob 전부를 하나의 기능 영역으로 묶고, **의존성 순서로 4개 하위 슬라이스(S-A→S-D)** 로 쪼갠다. 전부 출하 대상이며(범위 축소 아님), 순서는 가치/리스크 trade-off다. S-A는 곧장 plan으로 갈 수 있을 만큼 상세하고, S-B/S-C/S-D는 범위·결정·연기항목만 잡는다(각자 착수 시 focused spec/brainstorm으로 디테일을 채운다 — 특히 S-C open-loop는 ADR + 자체 설계 결정 필요).
>
> **연관 문서**:
> - 로드맵 진입점 = `docs/roadmap.md` §B5 (이 영역으로 승격)
> - codex 평가 출처 = `docs/reviews/2026-06-02-load-tester-evaluation-assessment.md`
> - 관련 ADR: 0013(scenario vs run config 분리), 0016(VU = tokio task per VU), 0012(워커측 메트릭 집계), 0018(VU별 cookie jar), 0028(SLO verdict — 사후 판정)
> - 신규 ADR 예정: **ADR-0031**(open-loop 실행 모델 — S-C에서 작성)

---

## 1. 목표 / 동기

Handicap은 LoadRunner/JMeter를 사내에서 대체하는 게 목표인데, 현재 부하를 **거는 방식**의 표현력이 빈약하다:

- **실행 모델이 closed-loop 하나뿐** — VU N개를 띄우면 각 VU가 시나리오를 deadline까지 자유 반복한다. RPS가 "VU 수 × 응답속도"의 **결과값**이라, "초당 500요청을 꽂아라" 같은 **목표 도착률(arrival rate)** 을 직접 줄 수 없다. SLA식 정밀 부하("이 서비스가 X RPS를 버티나")를 못 한다.
- **요청 간 pacing이 없다** — think time(사용자가 페이지를 읽는 시간) 개념이 없어 실제 트래픽 패턴을 못 흉내 낸다.
- **HTTP 타임아웃이 client 레벨 30s 하드코드** (`crates/engine/src/executor.rs:23`) — 모든 요청 공통, 설정·스텝별 오버라이드 불가. 느린 엔드포인트가 30s까지 매달려 결과를 왜곡한다(codex 지적).
- **ramp이 단일 선형뿐** — `ramp_up_seconds` 하나. "30s 동안 200까지 올리고 → 2분 유지 → 30s 내리기" 같은 다단계 부하 곡선을 못 짠다.

이 영역은 이 표현력 격차를 메운다.

## 2. 현재 상태 (코드 기준)

- **실행 모델**: closed-loop. `runner.rs::run_scenario`가 `plan.vus`개 VU를 spawn(선형 ramp), 각 `run_vu`가 `while Instant::now() < deadline { execute_steps(...) }`로 반복. 요청 간 지연 0.
- **동시성(in-flight)**: 사실상 `vus` (VU당 직렬 실행이라 동시 요청 ≤ VU 수). 독립 cap 없음.
- **ramp**: 단일 선형 — `ramp_secs` 동안 초당 `vus.div_ceil(ramp_secs)` 만큼 spawn(`runner.rs:67-126`).
- **HTTP 타임아웃**: `VuClient::new`가 `reqwest::Client::builder().timeout(Duration::from_secs(30))` (executor.rs:23). client 전역 total timeout. `connect_timeout` 미설정(reqwest 기본). per-request 오버라이드 없음.
- **Profile 배선 경로**: `RunDialog` → `POST /api/runs` body.profile → controller `store::runs::Profile`(profile_json JSON 컬럼, `#[serde(default)]`이라 **마이그레이션 불필요**) → proto `Profile` 메시지 → worker `main.rs`가 `RunPlan` 빌드 → engine. 현 Profile 필드: `vus`, `ramp_up_seconds`, `duration_seconds`, `loop_breakdown_cap`, `data_binding`, `criteria`.
- **Scenario/HttpStep 모델**: `crates/engine/src/scenario.rs`. `HttpStep`은 `#[serde(deny_unknown_fields)]`(strict). UI 측 `HttpStepModel`(Zod)이 와이어 1:1 strict 게이트.

## 3. 지배 원칙 (cross-cutting, 전 슬라이스 공통)

이 영역의 모든 knob은 아래 규칙을 따른다. 슬라이스마다 재결정하지 않는다.

### 3.1 배치 규칙 — "run-level → Profile, per-step → Scenario"
ADR-0013(시나리오는 git/YAML, run config는 DB)의 연장:

- **run 단위로 부하를 *어떻게 거는가*** → **Profile**(profile_json, run config). 예: `http_timeout_seconds`, run-level think time, `target_rps`, `max_in_flight`, `stages`. 같은 시나리오를 다른 강도로 돌리는 축이라 run config가 맞다.
- **시나리오의 *일부인* per-step 속성** → **Scenario `HttpStep`**(YAML, git 버전). 예: per-step `timeout_seconds`, per-step think time. "이 스텝은 느린 리포트 생성이라 60s 준다", "이 스텝 뒤엔 사용자가 3s 읽는다"는 시나리오 정의의 일부다.

이 규칙이 애매한 knob은 각 슬라이스 절에서 근거와 함께 결정한다.

### 3.2 하위 호환 불변식 — "absent → byte-identical"
**모든 knob은 미지정 시 현재 동작과 byte-identical** 이어야 한다. 구체적으로:

- Profile 신규 필드 = `#[serde(default)]` (옛 profile_json 행 호환, **runs 테이블 migration 0건** — Slice 7-1/8c와 동일 패턴).
- proto `Profile` 신규 필드 = additive(prost 기본값 0/empty = 현재 동작). controller+worker 동시 배포라 enum/필드 추가는 안전(controller CLAUDE.md).
- Scenario `HttpStep` 신규 필드 = `Option`/`#[serde(default)]` + `skip_serializing_if`(비면 YAML 키 사라져 옛 시나리오와 byte-identical — `Request.disabled` 사이드카(B4)와 동형).
- **open-loop(S-C)도 opt-in** — `target_rps` 미지정이면 closed-loop 경로를 그대로 타 byte-identical.

### 3.3 검증 레이어
- **Profile knob 범위 검증** → controller `validate_run_config`(`api/runs.rs`, run-create + preset-save 공유 게이트). 기존 `loop_breakdown_cap` 검증과 같은 자리.
- **Scenario step knob 검증** → UI Zod `HttpStepModel`(authoring 게이트) + 엔진은 관대(런타임에 비정상값이면 안전한 기본으로 fallback, run을 죽이지 않음 — lenient 평가 정책과 정합).

### 3.4 메트릭/리포트 영향 최소화
- S-A/S-B/S-D: 메트릭 파이프라인(`Aggregator`/`MetricFlush`/proto `MetricBatch`/리포트) **무변경**. 타임아웃·think time·ramp 곡선은 "언제/얼마나 빨리 요청을 보내나"만 바꾸지 "무엇을 집계하나"는 안 바꾼다.
- S-C(open-loop)만 메트릭 의미에 새 개념을 들일 수 있다(예: in-flight cap에 막혀 *발사되지 못한* 반복 = "dropped/skipped" 카운터). 이건 S-C 자체 spec에서 결정.

## 4. 전체 config 표면 (요청 + 추가 아이디어)

| knob | 배치 | 타입/모양 | 기본값 | 검증 | 슬라이스 |
|---|---|---|---|---|---|
| `http_timeout_seconds` | Profile | `u32` | 30 | 1..=600 | **S-A** |
| per-step `timeout_seconds` | Scenario `HttpStep` | `Option<u32>` | 없음(=profile값) | 1..=600 | **S-A** |
| `connect_timeout_seconds` (추가) | Profile | `Option<u32>` | 없음(=reqwest 기본) | 1..=120 | **S-A**(곁들임) |
| run-level think time | Profile | `Option<{min_ms,max_ms}>` | 없음 | min≤max, ≤600_000 | **S-B** |
| per-step think time | Scenario `HttpStep` | `Option<{min_ms,max_ms}>` | 없음 | min≤max | **S-B** |
| `target_rps` (arrival rate) | Profile | `Option<u32>` | 없음(=closed-loop) | >0, ≤상한 | **S-C** |
| `max_in_flight` | Profile | `Option<u32>` | 없음(open-loop 시 필수/기본) | >0 | **S-C** |
| `stages` (다단계 ramp) | Profile | `Option<[{target,duration_seconds}]>` | 없음(=단일 ramp_up) | 각 stage 검증 | **S-D** |

추가 아이디어(요청은 아니나 같은 영역에서 자연스러움 — §8에 상세, 해당 슬라이스에 흡수):
think time 분포(Poisson), `max_iterations`(반복수 종료), graceful stop/ramp-down, warmup 구간(메트릭 제외), abort-on-error threshold, connection pool 튜닝.

---

## 5. 하위 슬라이스

### S-A. 타임아웃 (`http_timeout_seconds` + per-step `timeout_seconds`)

**한 줄**: client 30s 하드코드를 profile 설정값으로 빼고, 스텝별 오버라이드를 추가한다. 새 실행 모델 0, 순수 가산. codex의 구체 지적(하드코드 30s) 해소 + 이후 슬라이스가 재사용할 "Profile 필드 + HttpStep 필드 + proto + UI" 배선 패턴을 깐다.

**범위 / 변경 지점**:
1. **proto** `Profile`에 `uint32 http_timeout_seconds = 5;` (+ 곁들임 `uint32 connect_timeout_seconds = 6;`, 0 = 미설정). prost exhaustive → `Profile{…}` literal 사이트 전부 갱신(grep).
2. **controller** `store::runs::Profile`에 `#[serde(default = "default_http_timeout")] http_timeout_seconds: u32`(기본 30) + `#[serde(default)] connect_timeout_seconds: Option<u32>`. `validate_run_config`에 범위 검증(1..=600 / connect 1..=120). proto 매핑(`Option<u32>` → `0`=미설정 컨벤션).
3. **engine** `RunPlan`에 `http_timeout: Duration` + `connect_timeout: Option<Duration>`. `VuClient::new`가 하드코드 대신 이 값 사용. **per-step**: `HttpStep`에 `#[serde(default, skip_serializing_if = "Option::is_none")] timeout_seconds: Option<u32>` 추가. `execute_step`/`execute_step_traced`(둘 다 — lockstep 불변식, engine CLAUDE.md)가 `http.timeout_seconds.map(|s| req = req.timeout(Duration::from_secs(s)))`로 per-request 오버라이드(reqwest `RequestBuilder::timeout`이 client 기본을 덮어씀).
4. **worker** `main.rs`의 `RunPlan` 빌드에 두 필드 매핑.
5. **UI**: RunDialog에 `http_timeout_seconds`(+ optional connect) 입력 — A4a SLO 섹션처럼 접이식 "고급" 섹션 권장(`ui-optional-sections-collapsible` 선호). Inspector(`HttpStepModel`/Zod)에 per-step `timeout_seconds` 필드 + 와이어 1:1.

**하위 호환**: profile 미지정 → `http_timeout_seconds=30`(현재와 동일), connect 미지정 → reqwest 기본. per-step 미지정 → client 기본 적용. 셋 다 미지정이면 byte-identical.

**검증/테스트**: 엔진 — per-step timeout이 실제로 적용되는지(느린 wiremock stub + 짧은 step timeout → 그 step만 timeout 에러, run은 계속). controller — `validate_run_config` 범위. round-trip(profile_json·YAML).

**연기/주의**:
- `0 = 무한 타임아웃`은 채택 안 함(hung VU 풋건). 매우 큰 값을 원하면 600s 상한 내에서. 무한이 진짜 필요하면 별도 결정.
- per-step think time은 S-B(같은 HttpStep 확장이라 S-B가 자연 흡수).

---

### S-B. think time (요청/반복 간 페이싱)

**한 줄**: closed-loop를 더 현실적으로 — 반복 사이(run-level)와 스텝 뒤(per-step)에 지연을 넣는다. 실행 모델은 closed-loop 유지.

**범위 / 변경 지점**(디테일은 S-B 착수 시 focused spec):
- **Profile** `think_time: Option<ThinkTime>` — `run_vu` 반복 루프 *사이*에 적용(다음 iteration 시작 전 pacing). `ThinkTime { min_ms: u32, max_ms: u32 }`: `min==max`면 고정, 아니면 `[min,max]` 균등 랜덤(시드 = 데이터바인딩과 같은 결정성 정책 재사용 검토).
- **Scenario `HttpStep`** `think_time: Option<ThinkTime>` — 그 스텝 실행 *직후* 지연("사용자가 응답 읽는 시간"). 시나리오 정의의 일부라 YAML.
- **engine**: 지연은 `tokio::time::sleep`을 `cancel`·`deadline`과 `tokio::select!`/clamp 해서 — abort 즉시 반응 + deadline 넘겨 매달리지 않게(loop deadline 함정과 동형). think time 동안은 요청을 안 보내므로 RPS가 자연히 내려감(의도된 동작).

**하위 호환**: 둘 다 미지정 → sleep 0 → byte-identical.

**메트릭**: 무변경(think time은 윈도 사이 idle일 뿐).

**연기**: 분포 확장(Poisson/exponential — open-loop 도착 모델과 묶어 S-C 또는 후속), 글로벌 "pacing"(반복 시작 간격 고정 = constant-pacing-timer, JMeter식) — S-C의 arrival-rate와 개념이 겹쳐 S-C 이후 재검토.

---

### S-C. 오픈루프 (target RPS + max in-flight) — **헤드라인, 새 ADR-0031**

**한 줄**: 목표 도착률을 직접 주는 open-loop 실행 모델을 opt-in으로 추가. closed-loop는 기본·무변경. **새 실행 모델이라 자체 spec + ADR-0031 필수** — 이 영역 spec은 *방향과 경계*만 잡는다.

**개념**: closed-loop에선 RPS가 결과값이라 못 설정한다. open-loop는 **반복 *시작*을 목표 레이트로 스케줄**하고(응답 완료를 안 기다림), 워커 풀이 그걸 처리한다. `max_in_flight`가 동시 처리량 상한.

**Profile**(잠정): `target_rps: Option<u32>`(존재 = open-loop 선택), `max_in_flight: Option<u32>`(동시 in-flight 상한). `target_rps` 미지정 → 기존 closed-loop 경로(byte-identical).

**S-C 착수 시 반드시 결정할 설계 포인트(여기선 미결, ADR-0031로)**:
1. **arrival 분포** — 균등 간격(`1/rps` 틱) vs Poisson(현실적 burst). v1 균등 권장, Poisson은 분포 knob과 묶어 후속.
2. **in-flight cap 도달 시 backpressure 정책** — ① drop(반복을 못 쏘고 "skipped" 카운트, 실제 RPS < target), ② queue/delay(레이턴시로 흡수), ③ rate 하향. 부하 도구로선 **drop + 명시 카운터**가 정직(목표를 못 채웠음을 숨기지 않음). 이게 메트릭에 새 개념을 들이는 유일한 지점(§3.4 예외).
3. **VU/cookie jar 모델**(ADR-0016/0018) — open-loop엔 "VU"가 없다. 재사용 client 풀 vs 반복마다 ephemeral client. cookie 세션 의미(ADR-0018 VU별 jar)가 open-loop에서 무엇인지 정의.
4. **글로벌 vu_id·데이터바인딩**(ADR-0014/0022) — `${vu_id}`·per_vu/unique 바인딩이 VU 없는 모델에서 갖는 의미. iteration_id 기반으로 재정의 필요할 수 있음.
5. **멀티워커(A3) 합성** — N 워커 fan-out 시 target_rps를 워커별로 쪼개는 규칙(`target_rps / N` per shard, capacity 모델과 정합).
6. **메트릭 윈도** — dropped 반복을 어떤 카운터로(loop/if breakdown과 별개 최상위 카운터일 가능성, 7-1/9d 패턴 참고).

**경계**: S-C 본체는 위를 closed-loop와 **격리된 새 경로**로 구현(기존 `run_scenario` 분기 or 별도 `run_scenario_open_loop`). closed-loop 회귀 0이 acceptance.

---

### S-D. 다단계 ramp (load stages)

**한 줄**: `ramp_up_seconds` 단일 선형을 `stages: [{target, duration}]` 배열로 일반화. closed-loop면 `target`=VU 수, open-loop(S-C)면 `target`=RPS. **S-C 뒤가 가장 가치**(RPS 곡선까지 표현).

**범위 / 변경 지점**(디테일은 S-D 착수 시):
- **Profile** `stages: Option<Vec<Stage>>`, `Stage { target: u32, duration_seconds: u32 }`. 각 stage는 현재 레벨에서 `target`까지 `duration` 동안 선형 전이(k6 stages식). 마지막 `target=0` stage = ramp-down.
- **engine** `runner.rs` spawn 스케줄러를 stage 곡선 구동으로 일반화 — 현재 단일 ramp는 `stages: [{target:vus, duration:ramp_up}, {target:vus, duration:총-ramp}]`와 등가. closed-loop면 VU spawn/retire 곡선, open-loop면 rate 곡선(S-C 스케줄러에 곡선 주입).
- **back-compat / 우선순위**: `stages` 미지정 → 기존 `vus`+`ramp_up_seconds`+`duration_seconds` 경로(byte-identical). `stages` 지정 시 — `ramp_up_seconds`와 충돌하므로 **둘 다 주면 거부**(validate_run_config 400) 또는 stages 우선(S-D에서 확정, 거부 쪽이 명확).
- **VU retire**(target가 내려가는 stage) — closed-loop에서 VU를 줄이려면 현재 없는 "VU 회수" 메커니즘 필요(deadline 외 종료 신호). S-D 설계 포인트.

**연기**: stage별 think time/RPS 혼합 등 고급 조합.

---

## 6. open-loop ADR (ADR-0031, S-C에서 작성)

S-C 착수 시 **ADR-0031 "open-loop / arrival-rate 실행 모델"** 을 쓴다. 결정 사항 = §5 S-C의 6개 설계 포인트 + "closed-loop 기본 유지·open-loop opt-in" 정책. 이 영역 spec은 ADR을 *예고*만 하고, 실제 결정은 S-C brainstorm에서.

## 7. 시퀀싱 (전부 commit, 순서 1→4)

순서는 **가치/리스크 trade-off**다. 범위 축소가 아니라 출하 순서:

1. **S-A 타임아웃** — 작고 additive, 30s 하드코드 해소, 배선 패턴 확립. 리스크 최저.
2. **S-B think time** — closed-loop 페이싱. 독립.
3. **S-C 오픈루프** — 새 실행 모델 + ADR-0031. 가장 큼, 헤드라인.
4. **S-D 다단계 ramp** — S-C 위에서 RPS 곡선까지.

의존성: S-A·S-B는 서로 및 S-C/S-D와 독립(원하면 순서 교체 가능). S-C가 target_rps·max_in_flight의 토대. S-D는 S-C 뒤가 자연(target=RPS 표현). 사용자 확정: **급한 것 없음, 1→4 순서**.

각 슬라이스는 착수 시 자체 plan(S-A) 또는 focused spec+plan(S-B/S-C/S-D)을 만든다. S-C는 brainstorm + ADR-0031 선행.

## 8. 추가 knob 아이디어 (기록 — 해당 슬라이스에 흡수 또는 후속)

요청엔 없으나 같은 영역에서 가치 있는 것들. 잊지 않게 적어둔다:

- **connect timeout 분리** — reqwest `connect_timeout` vs total `timeout`. → **S-A** 곁들임(이미 §5에 포함).
- **think time 분포(Poisson/exponential)** — 균등 랜덤을 넘어 현실적 도착. → S-B 또는 S-C(open-loop 도착 모델과 묶임).
- **`max_iterations` cap** — 기간 대신 "총/ VU당 반복 수"로 종료(k6 `iterations`). → 작은 후속(Profile 필드 + `run_vu`/스케줄러 카운터).
- **graceful stop / ramp-down 시 in-flight 완료** — 현재는 hard deadline cut(mid-request 절단). 종료 시 N초 grace로 in-flight 완료 허용(k6 `gracefulStop`). → S-D(ramp-down stage)와 묶거나 단독.
- **warmup 구간(메트릭 제외)** — 초반 N초를 리포트 집계에서 제외(JIT/풀 워밍업 노이즈 제거). → 메트릭 영역이라 A4 곁다리에 가깝지만 페이싱과 연관.
- **abort-on-error threshold** — 에러율이 X 넘으면 run 자동 중단(A4a SLO verdict는 *사후* 판정이라 다름 — 이건 *실시간* 차단). → 단독 작은 슬라이스(엔진이 윈도 에러율 보고 cancel 트리거).
- **connection pool 튜닝** — host당 max connections, keep-alive 토글, HTTP/2 prior-knowledge. → reqwest client 빌더(S-A와 같은 자리) 후속.
- **per-VU rate cap(closed-loop 스로틀)** — VU당 최대 RPS 제한. open-loop와 개념 겹침 → S-C 이후 재검토.

이 목록은 로드맵 §B5(영역 승격)에 옮겨 적는다.

## 9. 범위 밖 (이 영역 아님)

- 라이브 대시보드(ADR-0009 영구 제외).
- 트랜잭션 시간 분해(DNS/TCP/TLS/TTFB) — 리포트 깊이(A4b §B7 C항목), 별개.
- 분산 조정/HPA — A3(완료) / 반응형 HPA(연기). open-loop의 멀티워커 합성(S-C 설계 포인트 5)만 이 영역과 접점.

## 10. Acceptance (영역 전체)

- 각 슬라이스: 해당 knob 미지정 → **byte-identical**(회귀 0) 단언 + knob 지정 시 동작 검증(엔진 통합/wiremock).
- 게이트: `cargo fmt/clippy/test --workspace` + UI `pnpm lint && pnpm test && pnpm build`.
- 마이그레이션 0건(profile_json + scenario YAML 둘 다 `#[serde(default)]` 흡수) — S-C 포함 전 슬라이스.
- 최종 슬라이스마다 `handicap-reviewer`로 와이어 1:1(proto↔controller↔engine↔UI Zod) 대조.
