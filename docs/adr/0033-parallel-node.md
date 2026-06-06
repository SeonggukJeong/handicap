# 0033. Parallel 노드 (동시 분기 fan-out)

- 상태: 채택
- 날짜: 2026-06-06

## 맥락

세 번째 control-flow 노드 `type: parallel`. 테스트 대상이 **하이브리드 앱 + 웹뷰**라
프론트엔드 부하 — 브라우저가 페이지 로드 시 `/api/user`·`/api/feed`·`/api/notifications`
등을 **동시 fan-out** — 가 주력이다(로드맵 §A2). 이를 순차로 모델링하면 백엔드가 보는
**동시성 버스트·커넥션 재사용·per-session 경합**이 전부 틀어진다. 그리고 이건 **VU 수를
늘려도 대체 불가**다: 같은 세션/토큰/쿠키 jar(ADR-0018)·HTTP/2 커넥션을 공유하는
**상관된 요청 묶음**의 버스트(600 VU = 600 세션이라 못 만듦, per-session rate-limit·HTTP/2
멀티플렉싱·세션 캐시는 "공유 세션 fan-out"으로만 재현). JMeter Parallel Controller /
LoadRunner concurrent block의 관용구(ADR-0001 대체 목표와 연결).

loop(ADR-0020)·conditional(ADR-0023)이 깔아 놓은 재귀 `Step` 트리 + two-tier Zod +
캔버스 컨테이너 노드 인프라를 재사용한다. parallel은 **인터프리터 레이어**(핫패스 flat-http
무영향)라 처리량 회귀 위험이 낮다.

## 결정

### 1. wait-all join (`join_all` 협력 동시성, 공유 jar/client)

한 VU가 한 iteration 안에서 `branches`를 **동시 실행**하고, 모든 분기가 끝나야 노드가
완료된다(wait-all). 동시성은 `futures::future::join_all` — OS 스레드/tokio task spawn이
아니라 **단일 VU task 안의 협력 동시성**이라 cookie jar·`reqwest::Client`(ADR-0018)를
모든 분기가 **공유**한다(`&VuClient`로 전달). 이것이 "공유 세션 fan-out"의 핵심 — fresh
jar-per-branch면 세션 동시성이 안 나온다.

각 분기는 entry 시점 `iter_vars`의 **자기 clone** 위에서 실행된다(동시 분기가 `&mut
iter_vars`를 공유 불가). reads는 entry를 보고, writes(extract)는 분기-로컬에 머문 뒤
merge-back된다(§2). rng도 분기당 독립 `StdRng`(선언 순서로 VU rng에서 seed draw —
`think_seed` 주어지면 재현 가능).

`Box::pin`으로 재귀 async(If/Loop arm 동일) — 핫 flat-http 경로는 unboxed 유지.

### 2. 분기 출력 네임스페이스 merge-back (`{{branch.var}}`, key-origin)

분기 출력은 **선언 순서**로(join_all이 입력 순서 보존) `{{branch.name}}.{{var}}`
네임스페이스 키로 부모 `iter_vars`에 병합된다. **key-origin**: 분기가 선언한 extract 출력
키를 그대로 노출한다(값-diff 아님 — 부모 값을 재추출해도 `{{branch.var}}`는 여전히 노출).
분기명은 유니크(UI Zod gate)라 prefix가 disjoint → 순서 무관. `Branch::output_var_names()`
가 merge 소스(http leaf의 extract 변수명).

에러 처리: 첫 진짜 `EngineError`가 join 후 전파(최우선); 그 외 worst-flow(Aborted >
DeadlineReached > Continue). HTTP 실패는 **메트릭으로 기록될 뿐 VU를 죽이지 않음**(lenient —
ADR-0023 if 평가와 동일 철학).

### 3. top-level only v1 (http-only 분기, two-tier Zod gate)

v1에서 parallel은 **최상위 `steps`에만**, 분기는 **http-only**(`z.array(HttpStepModel)`)다.
엔진은 자유 중첩을 허용(`Branch.steps: Vec<Step>`)하나, UI Zod가 `ParallelStepModel`을
어떤 `Nested*` union의 멤버로도 두지 않고 분기를 http-only로 못 박아 구조적으로 강제한다
(loop/if의 two-tier 패턴 — ADR-0023/Slice 9c). 중첩·그룹 레이턴시·per-branch breakdown은
연기(§연기).

### 4. trace lockstep (순차 실행, 동일 merge)

trace(test-run, ADR-0026)는 1-VU 단일 패스라 타이밍이 무의미 → 분기를 **순차 실행**한다
(동시성 머신러리 없음). 단 §2와 **동일한 key-origin 네임스페이스 merge**를 적용해 다운스트림
행이 `{{branch.var}}`를 resolve한다(부하 경로와 lockstep). parallel 노드 자체엔 결정 행 없음
(전 분기 무조건 실행) — 각 분기 http가 평범한 Http 행으로 선언 순서 등장.

### 5. insights 1 arm, 메트릭 per-step 재사용, proto/워커/migration 무변경

컨트롤러 `insights.rs::collect_unconditional`의 `match`가 exhaustive(wildcard 없음)라
`Step::Parallel` arm이 **빌드 게이트**다. 분기는 무조건 도달 → `conditional` 플래그
passthrough(loop arm 동형). 효과: 분기 안 assertion 없는 http도 `no_request_step` 후보.

메트릭은 **기존 per-step 집계 재사용** — 각 분기 http leaf가 자기 `step_id`로 기록된다.
**proto/`MetricBatch`/워커/migration/controller store·report 무변경.** 머지 diff =
engine(`scenario`/`runner`/`trace`/`lib`) + `controller/insights.rs` + ui뿐.

### 6. 캔버스 세로 레인 시각화

캔버스는 분기를 **가로로 나란한 세로 레인**(`ParallelStepNode` 헤더 + 레인 라벨, 자식은
React Flow `parentId`로 부유)으로 그린다. parallel만 가로로 성장(`measureWidth` = Σ레인),
높이 = max 레인. loop/if의 세로 성장과 대조.

## 결과

**Positive**
- 웹뷰 fan-out 부하 모양(상관 버스트·공유 세션·커넥션 재사용)을 충실히 재현 — VU 스케일로
  불가능한 부하 충실도 갭을 메움.
- 핫 flat-http 경로 byte-identical(parallel arm은 추가만, 기존 경로 무변경) — 처리량 회귀 0.
- proto/워커/migration 무변경 — per-step 메트릭 재사용으로 파이프라인 신규 코드 0.
- 부하 경로(`join_all` 동시) ↔ trace 경로(순차)가 **동일 merge**라 test-run이 실제 run과
  같은 네임스페이스 변수를 보여줌.

**Negative / Trade-offs**
- `join_all`은 단일 VU task 안 협력 동시성 — 진짜 OS 병렬이 아니라 동시 I/O 대기(부하
  생성기엔 충분하나 CPU-bound 분기엔 무의미, 부하 도구라 무관).
- 분기당 `iter_vars` clone + `Box::pin` — HTTP round-trip 대비 무시 가능(Slice 7 loop와
  동일 결론).
- top-level-only + http-only 분기 v1 — 중첩은 후속(아래). **그룹/페이지 레이턴시는 A2-2로 구현됨(아래 연기 항목 해소).**
- 그룹 레이턴시("페이지 로드 = max(분기)")는 v1 ADR-0033엔 안 나왔으나 **A2-2(2026-06-06)로 구현·머지** — per-endpoint p95 + run 전체 분포(B7-D)에 더해 이제 동시 호출의 max(페이지 로드 분포)도 리포트에 나온다.

## 연기

- ~~**그룹/페이지 레이턴시 메트릭**~~ — **구현 완료(A2-2, 2026-06-06)**: 동시 분기의 max = 웹뷰 페이지 로드 KPI. parallel arm이 `join_all`을 `Instant`로 재 `Aggregator` HDR 계열(`group_stats`)에 clean-flow(`!aborted && !deadline_hit`)일 때만 기록 → proto `MetricBatch.group_stats=7` → controller `run_group_metrics`(migration 0010, append-only) → `build_report` 별도 `group_acc`(summary/RPS 비오염) → `ReportJson.group_latency` → UI `GroupLatencyTable`. 엔진 핫 flat-http byte-identical, ADR 불필요(additive). 잔여: per-branch bottleneck·초단위 시계열·페이지 성공/오류 분할·loop/if 컨테이너 확장은 후속.
- **per-branch breakdown**: 분기별 요청·오류 카운터(loop breakdown ADR-0021 / if breakdown
  ADR-0023 동형). v1은 per-step 메트릭만(분기 라벨 없음).
- **중첩**: parallel↔loop/if 상호 중첩, 분기 안 컨테이너(현재 http-only).
- **open-loop 상호작용**: open-loop(ADR-0031/0032) arrival당 parallel 분기 fan-out의
  슬롯/백프레셔 의미 정의.
- **분기 fail-fast 정책**: 한 분기 실패 시 형제 분기 취소(현재 wait-all로 전부 완주).
