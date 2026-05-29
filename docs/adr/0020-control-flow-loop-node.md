# ADR-0020 — 첫 제어 흐름 노드: loop (재귀 스텝 트리, 단일 레벨, repeat-count)

* Status: Accepted
* Date: 2026-05-29
* Deciders: handicap maintainers
* Tags: scenario-model, engine, ui, control-flow

## Context

MVP 1단계(슬라이스 1–6)는 시나리오를 **순차 HTTP 스텝의 평탄 배열**로만
표현했다. MVP 설계 §4.5가 후속의 첫 후보로 지목한 "다른 노드 종류
(loop / conditional / parallel)" 중 첫 조각을 Slice 7이 도입한다 — `type: loop`
노드. loop은 하위 스텝 배열 `do:`를 고정 횟수 `repeat: N` 만큼 반복 실행하는
컨테이너다. 이 결정은 (a) 시나리오 모델이 평탄 배열에서 **트리**로 바뀌는
점, (b) 엔진 인터프리터가 재귀로 바뀌는 점, (c) 그 둘이 Slice 8(conditional)·
Slice 9(parallel)로 어떻게 확장될지를 못박는다.

설계 명세: `docs/superpowers/specs/2026-05-29-slice-7-loop-node-design.md`.

## Decision Drivers

- conditional(Slice 8)·parallel(Slice 9)을 같은 컨테이너 패턴으로 잇기.
- 직렬화된 YAML이 명세 §3의 canonical 형태(`type: http`가 내부 스텝에도 박힘)와
  일치할 것.
- 엔진 hot path(평탄 http 시퀀스)에 오버헤드를 더하지 않을 것.
- 단일 레벨(loop 안엔 http만)이라는 Slice 7 한계를 명확한 곳 한 군데에서 강제.

## Considered Options

1. **중첩 트리 모델 + 재귀 인터프리터** — loop은 `do: [...]` 하위 스텝을 갖는
   컨테이너, 엔진은 스텝 리스트를 재귀 실행.
2. **flat 배열 + `loop_start`/`loop_end` 마커** — 평탄 배열에 페어 마커.
3. **단일 스텝의 `repeat` 프로퍼티** — 한 스텝만 N회 반복.

## Decision

**옵션 1(중첩 트리 모델 + 재귀 인터프리터) 선택.**

엔진 `Step`을 internally-tagged enum으로 확장한다:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
}

pub struct LoopStep {
    pub id: String,
    pub name: String,
    pub repeat: u32,
    #[serde(rename = "do")]
    pub do_: Vec<Step>,   // 명세 §4.1의 Vec<HttpStep>에서 변경 — 아래 참조
}
```

엔진은 `execute_steps(steps, ctx)`로 스텝 리스트를 재귀 실행한다. `Step::Loop`
arm만 `0..repeat`를 돌며 `ctx.loop_index`를 설정하고 `do_`를 재귀 실행한다.

**`do_: Vec<Step>` (명세 §4.1의 `Vec<HttpStep>`에서 의도적 변경).**
엔진은 임의 중첩(자유 재귀)을 타입 레벨에서 허용하고, 단일 레벨(loop 안엔 http만)
강제는 **UI Zod 스키마**(`do: z.array(HttpStepModel)`)가 authoring gate로 담당한다.
명세는 중첩 loop을 타입으로 차단하려고 `Vec<HttpStep>`을 적었지만, **internally-tagged
enum에 `Vec<HttpStep>`을 쓰면 직렬화 시 내부 스텝에서 `type: http` 태그가 빠져
명세 §3의 canonical YAML 자기모순**이 된다 (역직렬화는 enum이라 `type`을 요구하는데
직렬화는 구조체라 `type`을 안 붙임 → round-trip 깨짐). `Vec<Step>`은 엔진을
단순하게 유지하고, Slice 8/9의 컨테이너 노드를 같은 재귀 entry로 잇는 포석이 된다.
중첩 loop의 진짜 게이트는 (a) Zod(`do`는 http만), (b) UI 캔버스(loop 안에 loop
추가 UI 없음) 두 곳이다.

**`${loop_index}` 0-based 시스템 변수.** `${vu_id}`/`${iter_id}`와 같은 per-context
시스템 변수 해석 경로에 추가. loop 밖에서 참조하면 `EngineError::UnknownVar`로
실패(fail-fast). 단일 레벨이라 `TemplateContext`에서 스칼라 하나로 충분 — 중첩
loop이면 바깥/안쪽 인덱스가 섀도잉되어 스코프된 이름이 필요(§8 연기).

**메트릭 의미.** loop 내부 http 스텝은 자기 `step_id`로 기록되므로 `count`는
`repeat`배 누적되지만 **distinct `step_id` 개수는 그대로**다 — 리포트 행 수,
집계 버킷 수는 영향 없음. loop 노드 자체는 HTTP 메트릭을 내지 않는다(제어 흐름).

**컨트롤러 무변경.** 시나리오는 YAML 문자열로 워커에 전달되고 엔진이 해석한다 —
와이어 포맷·gRPC·Job spec 무변경. `build_report`는 메트릭을 step_id로 group만
하고 시나리오 YAML을 walk하지 않으므로 손대지 않는다. step 라벨링(내부 스텝 포함)은
UI(`ReportView`/`RunDetailPage`)가 `flattenHttpSteps`로 `do:`를 재귀 평탄화해 처리.

## Consequences

**Positive**
- conditional(Slice 8)·parallel(Slice 9)이 같은 "하위 스텝을 담고 실행 규칙이
  다른 컨테이너" 패턴 + 재귀 entry를 그대로 재사용한다.
- 직렬화된 모든 스텝(중첩 포함)에 `type:`이 붙어 round-trip이 깨지지 않는다.
- 엔진 hot path 무영향: `Step::Loop` arm만 재귀 호출을 `Box::pin`한다. flat http
  경로는 추가 박스 0개. A/B 측정(200 VUs × 20s, 1KB body, 동일 머신): flat
  ~19,974 RPS avg vs loop(repeat:1) ~19,449 RPS avg — ~2.6% 차이로 run-to-run
  변동(±5–7%) 범위 내, p95 17–18ms / p99 24–25ms 양쪽 동일. `Box::pin`-per-iteration
  오버헤드는 HTTP round-trip 대비 무시 가능 — iterative-executor 최적화 불필요.
  (Slice 6 baseline 20,389 RPS.)

**Negative / Trade-offs**
- 엔진 타입(`Vec<Step>`)이 UI 스키마(http만)보다 느슨하다 — "단일 레벨"이 한
  곳(타입)이 아니라 두 곳(Zod + 캔버스 UI)에서 강제된다. 엔진에 직접 YAML을 넣으면
  중첩이 통과한다(의도 — Slice 8/9 대비 자유 재귀 보존). 사용자 authoring 경로는
  UI를 거치므로 안전.
- `Step`이 discriminated union이 되어 `.request`/`.assert`/`.extract`를 직접 읽던
  모든 TS/Rust consumer가 union narrowing을 거쳐야 한다 (1회성 마이그레이션 비용).

## 명시적 연기 (Out of scope, future slices)

- **data-driven loop** — 각 반복이 데이터셋 한 행을 바인딩 (계정 목록 순회 등).
  loop 모델에 `over:`/`data:` 추가 방향. 부하 테스트 파라미터라이제이션의 핵심이라
  우선순위 높음. 다음 슬라이스.
- **중첩 loop** — 엔진 재귀는 이미 지원. (a) Zod/UI 제약 완화, (b) React Flow
  subflow 깊이 레이아웃, (c) `${loop_index}` 스코프된 이름이 추가로 필요.
- **템플릿화 `repeat`** (`repeat: ${LOOP_N}`) — 숫자 필드 템플릿 해석 추가 필요.
- **conditional 노드 (Slice 8)** — 이전 스텝 extract/status에 따른 if/else. 같은
  컨테이너 패턴.
- **parallel 노드 (Slice 9)** — VU 내 동시 요청. 동시성·메트릭 귀속 때문에 가장 복잡.

## Alternatives considered

1. **flat 배열 + `loop_start`/`loop_end` 마커.** 검증·캔버스 렌더·conditional 확장이
   모두 지저분하고, 깨진 마커 쌍이 런타임 에러를 낸다. 거절.
2. **단일 스텝의 `repeat` 프로퍼티.** 한 스텝만 반복 가능 — 다중 스텝 시퀀스
   반복(로그인→장바구니→결제 ×N)이 불가. 거절.

## Links

- Spec `docs/superpowers/specs/2026-05-29-slice-7-loop-node-design.md` (§2 아키텍처
  결정, §3 canonical YAML, §4 엔진, §8 연기)
- ADR-0014 (변수·env·시스템 변수 표기) — `${loop_index}`는 `${}` 시스템 변수 계열
- ADR-0017 (MVP 리포트 스코프) — 메트릭은 step_id 집계, 라벨은 UI
