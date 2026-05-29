# Slice 7 — Loop 노드 설계 명세

- **상태**: 작성 완료
- **날짜**: 2026-05-29
- **대상 범위**: Slice 7 (MVP 1단계 완료 후 첫 후속 슬라이스 — 노드 종류 확장의 시작)
- **참조**: MVP 설계 [2026-05-27-handicap-mvp1-design.md](2026-05-27-handicap-mvp1-design.md) §1.5/§2.6/§4.5, [ADR 인덱스](../../adr/README.md)

MVP 1단계(슬라이스 1–6)는 시나리오를 **순차 HTTP 스텝의 평탄 배열**로만 표현했다. 이 슬라이스는 시나리오 모델에 **제어 흐름 노드의 첫 종류 — `loop`** 를 도입한다. MVP 설계 §4.5가 "다음 단계의 첫 후보"로 지목한 "다른 노드 종류(loop/conditional/parallel)"의 첫 조각이다.

이 문서는 **Slice 7만의 설계**다. conditional(Slice 8)·parallel(Slice 9)·data-driven loop·중첩 loop은 §8 "명시적 연기"에 기록만 하고 구현하지 않는다.

---

## 목차

1. 범위 (In / Out)
2. 아키텍처 결정
3. 시나리오 모델
4. 엔진 (모델 + 인터프리터)
5. Controller / proto / 리포트
6. UI (캔버스 · YAML · 인스펙터 · 검증)
7. 에러·중단·메트릭 의미
8. 명시적 연기 (Future)
9. 완료 기준
10. 추가되는 ADR

---

## 1. 범위 (In / Out)

**IN — Slice 7**
- 시나리오 모델에 `type: loop` 노드 추가. loop은 하위 스텝 배열 `do: [...]`를 **고정 횟수 `repeat: N` 만큼 반복** 실행.
- `do:` 안에는 **`http` 스텝만** 허용 (단일 레벨 — loop 안에 loop 금지).
- `repeat`는 **리터럴 정수 ≥ 1**.
- 시스템 변수 `${loop_index}` (0-based) — 현재 loop 반복 순번. 템플릿에서 사용 가능.
- 엔진: 스텝 리스트를 재귀 실행하도록 인터프리터 확장. loop 내부 http 스텝의 메트릭은 그 step_id로 `repeat`배 누적.
- UI: 캔버스에 loop **부모 컨테이너 노드**(React Flow subflow) — 내부에 http 스텝을 담음. loop 인스펙터(`repeat`·`name`). YAML 뷰는 중첩 `do:` 경로를 targeted-edit으로 round-trip. Zod discriminated union 검증.
- 양방향 sync: 기존 탭 전환 모델(캔버스 active / YAML active) 그대로, 중첩 구조까지 확장.

**OUT — 명시적으로 후속 (§8 상세)**
- data-driven loop (데이터셋 순회) — 다음 슬라이스
- 중첩 loop (loop 안 loop) — 후속, React Flow subflow 깊이 + `${loop_index}` 스코프 필요
- 템플릿화된 `repeat` (`repeat: ${LOOP_N}`) — 후속
- `conditional` 노드 (if/else) — Slice 8
- `parallel` 노드 (VU 내 동시 요청) — Slice 9

## 2. 아키텍처 결정

**중첩 트리 모델 (채택).** loop은 `do: [...]` 하위 스텝을 갖는 컨테이너 노드이고, 엔진은 스텝 리스트를 **재귀 실행**한다.

거절한 대안:
- **flat 배열 + `loop_start`/`loop_end` 마커**: 검증·캔버스 렌더·conditional 확장이 모두 지저분. 트리가 깨진 마커 쌍을 허용하면 런타임 에러.
- **단일 스텝에 `repeat` 프로퍼티**: 한 스텝만 반복 가능 — 다중 스텝 시퀀스 반복(로그인→장바구니→결제 ×N) 불가.

트리 모델은 Slice 8(conditional)·9(parallel)을 **같은 컨테이너 노드 패턴**으로 잇는다. 세 제어 노드 모두 "하위 스텝을 담고 실행 규칙이 다른 컨테이너"로 통일된다.

## 3. 시나리오 모델 (canonical YAML)

```yaml
version: 1
name: "Repeat checkout"
steps:
  - id: "01HX...loop"     # stable ULID (모델 ↔ 캔버스 매칭)
    name: "Repeat add-to-cart"
    type: loop
    repeat: 5             # 리터럴 정수 ≥ 1
    do:                   # 1개 이상, http 스텝만
      - id: "01HX...add"
        name: "Add to cart"
        type: http
        request:
          method: POST
          url: "{{base_url}}/cart/items"
          body:
            json:
              sku: "item-${loop_index}"
        assert:
          - status: 200
        extract:
          - var: cart_id
            from: body
            path: "$.cart_id"

  - id: "01HX...checkout"  # loop 뒤에 이어지는 평범한 http 스텝
    name: "Checkout"
    type: http
    request:
      method: POST
      url: "{{base_url}}/checkout"
    assert:
      - status: 200
```

규칙:
- loop 스텝은 `id`·`name`·`type: loop`·`repeat`·`do`만 가진다. `request`/`assert`/`extract`를 자기 레벨에 두면 **검증 거부**.
- `do`는 비어 있을 수 없고(≥ 1), 원소는 모두 `type: http`. loop 원소는 거부 (단일 레벨).
- loop은 다른 http 스텝과 형제로 임의 위치에 올 수 있다.

## 4. 엔진

### 4.1 모델 (`crates/engine/src/scenario.rs`)

기존 `Step`(http 단일)을 **internally-tagged enum**으로 확장:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoopStep {
    pub id: String,
    pub name: String,
    pub repeat: u32,
    #[serde(rename = "do")]
    pub do_: Vec<HttpStep>,   // Vec<HttpStep> 로 못박아 중첩 loop을 타입 레벨에서 차단
}
```

- `#[serde(tag = "type", ...)]` internally-tagged + struct variant는 serde_yaml 0.9에서 round-trip OK (Slice 4 `Extract`에서 검증). Slice 1의 externally-tagged map-shape enum 함정(`Body`/`Assertion`)과 다른 안전 패턴.
- `do`는 Rust 예약어 → `#[serde(rename = "do")] do_`.
- 기존 http 스텝 필드는 `HttpStep`으로 이동 (구조 보존). `version`/`name`/`variables`/`cookie_jar` 등 시나리오 최상위는 불변.

### 4.2 인터프리터 (`crates/engine/src/runner.rs`)

평탄 루프를 **재귀 함수**로 전환:

```
execute_steps(steps, ctx):
  for step in steps:
    check cancellation                       # 매 스텝
    match step:
      Http(h)  => execute_http(h, ctx)        # 기존 로직, 메트릭은 h.id 로 기록
      Loop(l)  => for i in 0..l.repeat:
                    check cancellation         # 반복 사이에도 체크
                    ctx.loop_index = Some(i)
                    execute_steps(&l.do_, ctx)
                  ctx.loop_index = None         # loop 종료 후 해제
```

- VU iteration 1회는 `execute_steps(&scenario.steps, ctx)` 한 번. 기존 호출부를 이 재귀 진입점으로 교체.
- **단일 레벨이라 `loop_index` 스코프 충돌 없음** — 중첩 loop이 생기면 스코프된 인덱스가 필요(§8).

### 4.3 `${loop_index}` 시스템 변수 (`crates/engine/src/template.rs`)

- `${vu_id}`/`${iter_id}`와 동일한 per-context 시스템 변수 해석 경로에 `loop_index`를 추가한다. 매 요청 빌드 시점에 현재 컨텍스트에서 해석.
- **0-based**. (구현 시 `iter_id`의 base 컨벤션을 확인하고 동일하게 맞춘다 — 0-based 가정.)
- loop 밖에서 `${loop_index}`를 참조하면 미해결로 둔다 (엔진 런타임은 엄격하나, loop_index 미설정 시는 빈 값/에러 정책을 플랜에서 기존 미해결 토큰 처리와 일치시킨다).

## 5. Controller / proto / 리포트

- **proto·controller 디스패치 변경 없음**: 시나리오는 YAML 문자열로 워커에 전달되고 엔진이 해석한다. loop은 엔진이 이해하는 더 풍부한 YAML일 뿐 — 와이어 포맷·gRPC·Job spec 무변경.
- **리포트 step 라벨링은 재귀 평탄화 필요**:
  - Slice 5 `StepStatsTable`와 Slice 4 M2 진단(`step_id → {name, method, url}`)이 시나리오 YAML을 walk해 step 메타 맵을 만든다. 이제 `do:` 안으로 재귀해 http 스텝을 평탄화해야 한다. (이 walk는 UI에서 일어남 — §6.4.)
  - controller `build_report`가 관측된 메트릭을 step_id로 group만 한다면 무변경. 만약 "기대 스텝 목록"을 YAML에서 열거한다면 거기도 재귀. → **플랜 Task에서 `build_report` 코드 확인 후 필요 시 재귀 추가.**

## 6. UI

### 6.1 캔버스 — 부모 컨테이너 노드 (채택: A안)

- loop은 React Flow **부모 노드**(`parentId` + `extent: 'parent'`)로 렌더. 내부 http 스텝은 자식 노드로 컨테이너 bounds 안에 배치.
- 기존 Slice 3 패턴 유지: `draggable: false`, 위치는 매 렌더 재계산. `layoutNodes`(또는 동등 레이아웃 함수)가 컨테이너의 자식들을 컨테이너 내부 좌표로 배치하고, 컨테이너 높이를 자식 수에 맞게 산출.
- 엣지: 상위 체인이 loop 컨테이너로 들어오고, 내부 스텝이 체인으로 연결되며, loop 뒤 스텝으로 이어진다.

### 6.2 캔버스 — 신규 조작

- **loop 노드 추가**: palette/버튼에서 loop 노드 추가 (기존엔 http만). 추가 시 빈 `do` 또는 http 1개 포함 — 빈 `do`는 검증 실패하므로 추가와 동시에 http 스텝 1개를 넣거나, 저장 게이트에서 막는다(플랜에서 UX 결정, 기본: loop 추가 시 자리표시 http 1개 동반).
- **loop 안에 http 추가**: 컨테이너에 드롭/버튼으로 내부 스텝 append.
- **선택**: 컨테이너·내부 스텝 모두 선택 가능, 인스펙터가 분기.

### 6.3 인스펙터

- 선택 노드 `type`으로 분기: http → 기존 폼, loop → loop 폼(`repeat` 숫자 입력 + `name`).
- `repeat` 입력은 정수 ≥ 1 강제. 입력 commit 타이밍은 Slice 4 `ExtractEditor` 표준(local state onChange 즉시, commit은 onBlur/구조 변경 시 즉시)을 따른다.

### 6.4 YAML round-trip (`ui/src/scenario/yamlDoc.ts`)

- `addStep`/`removeStep`/`moveStep` 및 `setIn` 경로가 **중첩 경로**를 지원: 예) loop 안 1번째 스텝 method → `['steps', 2, 'do', 1, 'request', 'method']`.
- 코멘트 보존 규칙은 Slice 3 한계 그대로: 부분 키 수정은 코멘트 유지, 스텝 통째 교체는 그 안 코멘트 손실.
- `normalizeForModel`이 discriminated union(loop/http)을 통과시키도록 확장.
- step_id → 메타 walk(§5)는 `do:` 재귀.

### 6.5 검증 (Zod, `ui/src/scenario/`)

```ts
const HttpStepSchema = z.object({ type: z.literal("http"), /* ... 기존 ... */ }).strict();
const LoopStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal("loop"),
  repeat: z.number().int().min(1),
  do: z.array(HttpStepSchema).min(1),   // http만 → 중첩 loop 타입상 차단
}).strict();
const StepSchema = z.discriminatedUnion("type", [HttpStepSchema, LoopStepSchema]);
```

- `.strict()`로 loop 스텝의 request/assert/extract 거부, http 스텝의 repeat/do 거부.
- discriminatedUnion이 `do` 원소를 http로만 받아 중첩 loop을 거부.

## 7. 에러·중단·메트릭 의미

- **메트릭**: loop 내부 http 스텝은 VU iteration당 `repeat`회 실행 → 그 step_id 카운트가 `repeat`배 누적. 의도된 자연스러운 동작. loop 노드 자체는 HTTP 메트릭을 내지 않음 (제어 흐름). 리포트/테스트에 이 의미를 명시.
- **중단(abort)**: Slice 4 CancellationToken을 loop 반복 사이에서도 확인해 긴 loop이 K8s grace period 안에 멈추도록.
- **extract**: loop 내부에서 추출한 흐름 변수는 반복 간 last-write-wins로 잔존 (현 흐름변수 모델 유지). loop 종료 후에도 마지막 값이 남아 뒤 스텝에서 참조 가능.
- **assert 실패/HTTP 에러**: 기존과 동일 — `error_count` 메트릭으로 기록하고 시나리오는 계속 (다음 스텝/iteration).

## 8. 명시적 연기 (Future)

다음 슬라이스에서 다룰 후보. 이번 슬라이스는 모델·인터프리터·캔버스를 이들로 확장하기 쉬운 형태로 둔다.

- **data-driven loop**: 각 반복이 데이터셋 한 행을 `{{var}}`로 바인딩 (예: 계정 목록 순회). 데이터 소스(inline list / CSV 업로드) 메커니즘 필요. loop 모델에 `over:`/`data:` 필드를 더하는 방향. **부하 테스트 파라미터라이제이션의 핵심이라 우선순위 높음.**
- **중첩 loop**: loop 안 loop. 엔진 재귀는 이미 지원하므로 (a) Zod/serde 제약 완화, (b) React Flow subflow 깊이 레이아웃, (c) `${loop_index}` 스코프된 이름(바깥/안쪽 구분)이 필요.
- **템플릿화 `repeat`**: `repeat: ${LOOP_N}` 으로 run config가 반복 수 주입. 숫자 필드 템플릿 해석 추가.
- **conditional 노드 (Slice 8)**: 이전 스텝 extract/status에 따른 if/else. 같은 컨테이너 패턴.
- **parallel 노드 (Slice 9)**: VU 내 동시 요청. 동시성·메트릭 귀속 때문에 가장 복잡.

## 9. 완료 기준 (acceptance)

**모델·엔진**
- [ ] `type: loop` + `repeat` + `do` 시나리오가 serde_yaml로 round-trip (proptest 포함)
- [ ] loop 내부 http 스텝이 VU iteration당 정확히 `repeat`회 실행 (wiremock integration으로 요청 수 검증)
- [ ] `${loop_index}`가 0..repeat 로 해석되어 요청에 반영
- [ ] loop 반복 도중 abort 시 grace period 내 중단 (CancellationToken)
- [ ] loop 내부 extract 변수가 반복 간 잔존, loop 뒤 스텝에서 참조 가능
- [ ] repeat=1 degenerate 케이스 정상 동작

**UI**
- [ ] 캔버스에 loop 부모 컨테이너 노드가 내부 http 스텝을 담아 렌더
- [ ] loop 인스펙터에서 `repeat`·`name` 편집, 캔버스↔YAML 양방향 반영
- [ ] loop 포함 YAML이 round-trip에서 코멘트 보존 (부분 수정 한도 내)
- [ ] Zod가 중첩 loop·repeat=0·loop 스텝의 request 키를 거부
- [ ] loop 포함 시나리오의 fast-check round-trip 프로퍼티 통과

**리포트·e2e**
- [ ] 리포트 StepStatsTable이 loop 내부 스텝을 라벨과 함께 표시 (step walk 재귀)
- [ ] e2e: loop 시나리오 생성 → run → 리포트 내부 스텝 카운트 = repeat × iterations 검증

**문서**
- [ ] ADR-0020 `Accepted`, CLAUDE.md "알아둘 결정들"에 한 줄
- [ ] CLAUDE.md에 Slice 7 결과 + 함정 기록

## 10. 추가되는 ADR

- **ADR-0020** — Scenario control-flow 노드: loop (재귀 스텝 트리, 단일 레벨, repeat-count). 트리 모델 채택 근거, data-driven·중첩·conditional·parallel 연기 기록.
