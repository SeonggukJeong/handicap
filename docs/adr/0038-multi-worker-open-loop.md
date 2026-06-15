# 0038 — open-loop 멀티워커 fan-out: 명시 worker_count + 컨트롤러 레이트 분할

- Status: accepted
- Date: 2026-06-15

## Context

open-loop(arrival-rate, ADR-0031)은 부하 강도가 **도착률**(`target_rps`/`stages`)로
정해져 정확한 RPS 제어를 준다 — LoadRunner/JMeter의 arrival-rate 모델(ADR-0001). 그러나
**단일 워커로만 실행됐다**: `spawn_run`이 `is_open_loop() ⇒ n=1`로 하드 고정(`api/runs.rs`).
단일 워커가 목표 RPS를 못 내면(`dropped > 0`) 유일한 우회는 closed-loop 전환인데,
closed-loop은 VU를 워커들에 분배해 수평 확장되지만 RPS가 latency에 따라 떠다녀
**정확한 도착률을 포기**한다(capacity-planning §2). 즉 "정확한 레이트"와 "수평 확장"을
동시에 못 가졌다.

closed-loop은 이미 `worker_count = ceil(vus/capacity)`로 N개 워커에 fan-out하고(ADR-0027),
워커별 메트릭은 `run_metrics`의 worker_id PK + 읽기-머지(A3b), `dropped`는
`UPDATE runs SET dropped = dropped + ?` 합산으로 합쳐진다. **이 인프라가 그대로 깔려 있는데
open-loop만 N=1로 잠겨 있었다.**

> 이 슬라이스는 처음 "open-loop `vus` misconfig 가드"(워커가 N대면 `target_rps × N`로
> 부풀려지는 트랩 방지)로 출발했으나, `spawn_run`의 N=1 핀 때문에 그 "N× 트랩"이 **구조적으로
> 발생 불가**임이 드러났다(spec-plan-reviewer 검증). 진짜 격차는 open-loop이 수평 확장되지
> 않는다는 것이었고, 사용자 결정(2026-06-15)으로 멀티워커 open-loop을 제대로 구현한다.

ADR-0031을 supersede하지 않고 **확장**한다(v1 단일워커 → v2 계획된 fan-out). 반응형
스케일링은 여전히 비목표.

## Decision

### N = 명시적 `worker_count` 노브

- 컨트롤러 `Profile`(`store/runs.rs`)에 `worker_count: Option<u32>` 추가. `#[serde(default,
  skip_serializing_if = "Option::is_none")]` → profile_json 직렬화라 **마이그레이션 0**,
  기존 행은 None(=1)으로 역직렬화. **proto에는 추가하지 않는다** — 컨트롤러가 중앙에서
  분할하므로 워커는 worker_count를 알 필요 없고 기존 `shard_count` + 축소 프로필만 받는다.
- `spawn_run`/unique-binding의 워커 수 계산을 vu-curve·open-loop·closed-loop **3-way로 분리**:
  vu-curve→1, open-loop→`worker_count.unwrap_or(1)`, closed-loop→`worker_count_for(vus)`.
  open-loop의 `total_vus`(register `shard_split` 기준) = `max_in_flight`(슬롯 풀).

### 컨트롤러가 register 시 워커별 프로필을 분할

코디네이터 `assignment_for`(`grpc/coordinator.rs`)가 각 워커에 base 프로필을 그대로 clone하던
것을, open-loop N>1일 때 **워커 몫으로 축소**한 clone을 보낸다(`reduce_open_loop_profile`):

- 슬롯/동시성: `max_in_flight = vu_count`(register의 `shard_split(max_in_flight, n, i)` 결과).
- 고정 레이트: `target_rps = shard_split(target_rps_total, n, i).1` (Σ = 총량 정확).
- 곡선: 각 `stage.target = shard_split(stage.target_total, n, i).1` (선형 보간이라
  Σ(워커별 rate_at) = 총 rate_at).

분할 가드 = `is_open_loop && shard_count > 1`. **N=1이면 블록 스킵 → byte-identical.**
결과: **엔진·워커·proto·migration 무변경** — 워커는 받은 (축소)프로필을 그대로 실행하고,
N-워커 dispatch(subprocess N-spawn / K8s Indexed Job)·메트릭 머지·`dropped` 합산·등록
watchdog·fail-fast·unique 데이터 슬라이싱은 ADR-0027/A3b 인프라를 그대로 재사용한다.

### 검증 (`validate_run_config`, 공유 게이트)

worker_count/vus 정합 5종(위반 = 400): ① worker_count는 open-loop 전용(closed-loop/vu-curve에
w>1 거부), ② 범위 1–64(폭주 방지 하드캡 — §B2'' 설정 페이지 노출 예정), ③ `max_in_flight >= w`
(워커당 ≥1 슬롯), ④ 고정모드 `target_rps >= w`(워커당 ≥1 rps; 엔진 `.max(1)`의 0-share 왜곡
차단 — 곡선모드 면제), ⑤ **open-loop + `vus > 0` 거부**(open-loop은 vus를 실행·fan-out 양쪽
다 무시하므로 비정합 신호 → worker_count/closed-loop로 리다이렉트).

### 초보자 안전

- 기본 N=1(오늘과 동일·숨김). UI는 RunDialog open 모드(고정·곡선)에 접이식 고급 필드로
  worker_count 입력(기본 1, 접힘; closed/vu-curve 미렌더). RunDialog 전용.
- 사후 포화 인사이트: `load_gen_saturated` cause=capacity 분기가 워커 추천을 가산 —
  `peak`는 N워커 합산이라 **per-worker 천장으로 정규화** `M = ceil(target × wc / peak)`,
  `peak>0`(div-by-zero 가드) AND `M > 현재 worker_count`일 때만 emit. 사용자가 "부하기 한계
  vs 대상 서버 한계"를 판단하도록 양분기 병기(자동 귀속 안 함).

## Consequences

- 엔진/워커/proto/migration **무변경**. 컨트롤러 `store/runs.rs`(필드)·`api/runs.rs`
  (검증·fan-out)·`grpc/coordinator.rs`(분할)·`insights.rs`(워커 추천)·UI만 변경.
- N=1 open-loop·closed-loop·vu-curve 기존 run 전부 **byte-identical**(와이어·동작 무변경).
- **검증 ⑤(open-loop + vus>0 거부)는 run-create와 preset/schedule save가 공유하는 게이트**라
  발사/저장 시점에도 재검증된다(`schedule/runner.rs` 발사·preset/schedule save). 이 슬라이스
  이전에 손-API/curl로 저장된 `vus>0` open-loop preset/schedule은 발사·수정 시 400을 받는다 —
  **UI-생성분은 open 모드에서 vus=0을 보내므로 무영향**. 과거 무의미했던(vus가 무시되던) config를
  명시적으로 마감하는 **의도된 동작**.
- `worker_count` 상한 64는 코드 하드캡(v1). 운영 상한 관리자 화면(roadmap §B2'')에 설정값으로
  노출 예정(capacityVus·loop_breakdown_cap·dataset-max-rows·trace body cap와 함께).
- 연기(roadmap §8): create-time worker_count 사이징 헬퍼(prior-run 천장 → 권장 N을 폼에서
  미리), per-stage 워커 분해 리포트, best-effort/degraded(샤드 일부 실패 시 잔여 지속),
  곡선 0-share 워커 floor, closed-loop worker_count 오버라이드.

## Alternatives considered

1. **`max_in_flight ÷ capacity`로 N 유도(자동)**: CPU 병목이 동시성보다 레이트에서 먼저 오면
   과소 워커를 띄운다 — 워커당 RPS 천장은 동시성이 아니라 페이로드/지연/TLS에 종속이라
   슬롯 수로 역산 불가.
2. **`target_rps ÷ 워커당-RPS-예산`으로 N 유도(자동)**: 워커당 RPS 천장은 고정 상수가 아니라
   지연·페이로드 종속이라(capacity-planning이 명시 경고) 고정 예산을 박을 수 없다.
3. **반응형 HPA(run 중 CPU/메트릭 기반 워커 증감)**: 부하 생성기는 "정해진 부하를 안정적으로
   생성"이 목적이라 run 중 워커 수가 흔들리면 측정이 흔들린다 — ADR-0027 계획된 fan-out
   철학 유지(N은 시작 시 고정).

명시 노브(①가 아닌 사용자 지정)를 택한 이유: ADR-0027 "계획된 fan-out, 사용자 사이징" 철학 +
capacity-planning "단정 말고 측정" 정합. 사용자가 워커당 천장을 램프-테스트로 재고 직접
지정하며, 사후 인사이트가 권장 N을 안내한다.
