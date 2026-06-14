# A9 후속 — 용량 사이징 권장 (`load_gen_saturated` enrich, Little's Law) 설계

- **날짜**: 2026-06-14
- **상태**: 설계 승인(사용자 2026-06-14) → plan 대기
- **출처**: roadmap §A9 의도적 연기 #1 "Little's Law 사이징 권장". A9 v1(`load_gen_saturated`, 2026-06-14)이 "포화됐다"까지만 답했고, 사용자 원 질문("RPS 10,000 돌리고 싶은데 … 최대 RPS 추천값·필요 리소스는?")의 "그래서 뭘 설정하나" 절반이 미해결.
- **연관**: A9 v1 spec `2026-06-14-load-gen-saturation-insight-design.md`(이 슬라이스가 enrich하는 인사이트), ADR-0028(A4c insights 패턴), ADR-0031(open-loop·`dropped`·`max_in_flight`·단일워커 v1), ADR-0035(한국어·`ko.ts`·초보자 친화), `docs/dev/capacity-planning.md`(§3 Little's Law 수동 절차 = 이 슬라이스가 자동화).
- **ADR 신규 불필요**: A4c가 "인사이트 enrich = 기존 파이프라인 내 additive, ADR 불요" 선례. 새 결정 없음. (단 A9와 달리 `Insight` 구조체에 optional 필드 2개를 *가산*한다 — §3.3.)

---

## 1. 문제와 목표

A9 v1은 open-loop run이 목표 도착률을 못 냈을 때(`dropped > 0`) "목표한 부하를 다 걸지 못했다 + 관측 천장 N RPS + 못 보낸 요청 수"를 한 줄로 뱉는다. 하지만 **"그래서 max_in_flight를 얼마로 올려야 하나"**, 그리고 더 중요하게 **"올리는 게 의미가 있긴 한가(슬롯 부족인가, 워커 CPU/대상 서버 한계인가)"**는 여전히 사용자가 `capacity-planning.md §3`의 Little's Law를 손으로 적용해 판단해야 한다.

**목표**: 포화 인사이트가 **사이징 권장 한 줄을 덧붙이게** 한다 —
1. 슬롯(`max_in_flight`)이 목표에 비해 수학적으로 부족하면 → **권장 `max_in_flight ≈ 목표 × 관측 지연`** 숫자를 제시.
2. 슬롯이 이미 충분했는데도 포화했으면 → **"올려도 소용없다, 한계는 다른 곳"** 이라고 분명히 말해 헛수고를 막는다(오도 방지).
3. 판별이 불가능하면(지연 0 등) → A9의 일반 안내로 안전하게 폴백.

전부 초보 QA가 해석 가능한 평이한 한국어로.

**비목표(연기)**: §8. 요약하면 closed-loop `vus` 권장, mean latency 정밀화, per-window dropped, create-time 힌트, open-loop misconfig 경고.

---

## 2. 핵심 통찰 (설계의 근거)

1. **트리거는 A9 그대로 `dropped > 0`.** `dropped`는 open-loop 전용 신호라(closed-loop는 절대 0) 자동으로 open-loop에 한정된다 — `is_open_loop()` 재검사 불필요. 이 슬라이스는 새 인사이트가 아니라 기존 `load_gen_saturated`를 **그 자리에서 enrich**한다.

2. **판별식은 "설정 `max_in_flight` vs 목표의 Little's Law 요구량"** — 증명 가능한 비교라서 오도를 차단한다. Little's Law: 목표 도착률 `target` RPS를 각 요청이 슬롯을 `L`초 점유하며 내려면 동시 슬롯 `required = ceil(target × L)`이 필요하다.
   - **`max_in_flight < required`**: 슬롯이 *수학적으로* 부족 — 워커 CPU가 무한이고 대상 서버가 완벽해도 드롭이 난다. **`max_in_flight`를 올리는 게 정확히 그 해법.** → 권장값 제시.
   - **`max_in_flight ≥ required`**: 슬롯은 목표에 충분했는데도 드롭이 났다 — 한계는 슬롯 수가 아니라 **워커 CPU(요청을 그 속도로 못 띄움)나 대상 서버(부하 시 지연 상승으로 슬롯이 막힘)**. **`max_in_flight`를 더 올려도 처리량은 안 는다.** → "올리지 마라" 안내.

3. **지연 프록시 `L`은 `summary.p50_ms`(중앙값).** mean은 리포트에 저장되지 않는다(HDR 백분위만). p50은 `derive_insights`가 이미 받는 `summary`에 있어 새 데이터 라인 0. 권장값은 근사라 *floor*("최소 ~N")로 제시 — 부하 상승 시 지연이 더 오를 수 있어 `required`는 하한이다.

4. **`L == 0`(localhost sub-ms)이면 판별 불가 → 폴백.** `required = target × 0 = 0`을 계산해 "슬롯 충분"으로 오분류하면 안 된다. `L > 0` 가드로 막고 cause 없이 A9 일반 안내로 떨어진다. (Slice 5 "localhost sub-ms → p95_ms=0" 함정과 동류 — §6.4 라이브 검증 주의.)

5. **관측 천장 N(=`value`)은 A9 그대로 유지** — peak per-second throughput. 권장값(`required`)과는 별개 축(천장 = 관측 사실, 권장 = 목표 기반 처방).

6. **유효 목표 `target`은 open-loop이면 항상 존재.** `dropped > 0 ⟹ open-loop ⟹ is_open_loop() ⟹ target_rps.is_some() || stages 비어있지 않음`. 따라서 `target = target_rps` (고정-레이트) `or max(stages[].target)` (램프). 단 방어적으로 부재 시 폴백 처리(§3.2).

---

## 3. 트리거와 계산 (`derive_insights`, `crates/controller/src/insights.rs`)

기존 `if dropped > 0` 블록(peak 계산 직후) 안에서 확장한다.

### 3.1 발사 조건 (불변)
```
dropped > 0
```

### 3.2 사이징 계산
새 입력 2개(§5): `max_in_flight: Option<u32>`, `target_rps: Option<u32>`(= 유효 목표, report.rs에서 산출해 주입).

```text
L_sec    = summary.p50_ms as f64 / 1000.0
required = if L_sec > 0.0 {
               target_rps.map(|t| ((t as f64) * L_sec).ceil().max(1.0) as u64)
           } else { None }                              // p50==0 → 판별 불가

(cause, recommended) = match (required, max_in_flight) {
    (Some(req), Some(m)) if (m as u64) < req => ("slots",    Some(req as f64)),
    (Some(_),   Some(_))                     => ("capacity", None),
    _                                        => (none,       None),   // 폴백
}
```

- `required`는 `.max(1.0)`로 최소 1(목표·지연이 작아 0으로 반올림되는 경우 방어).
- 폴백(cause 없음)이 발동하는 경우: `p50_ms == 0`, 또는 `max_in_flight`/`target_rps` 부재(prod open-loop에선 사실상 미발생이나 방어).

### 3.3 인사이트 레코드 (`Insight` 구조체에 optional 필드 2개 **가산**)
A9의 `value=peak, count=dropped`는 유지하고, 사이징 결과를 새 필드로 싣는다:

| `Insight` 필드 | 값 | 비고 |
|---|---|---|
| `kind` | `"load_gen_saturated"` | A9 동일 |
| `severity` | `"warning"` | A9 동일 |
| `value` | peak per-second throughput (f64) | A9 동일 |
| `count` | `dropped` | A9 동일 |
| **`recommended`** (신규) | `Option<f64>` = 권장 max_in_flight (slots일 때만 Some, 정수값) | `#[serde(skip_serializing_if="Option::is_none")]` |
| **`cause`** (신규) | `Option<String>` = `"slots"` \| `"capacity"` (폴백=None) | `#[serde(skip_serializing_if="Option::is_none")]` |

구조체 변경은 **순수 가산** — 다른 모든 인사이트는 두 필드가 `None`이라 `skip_serializing_if`로 와이어에서 생략된다. **proto·migration·엔진·워커·골든 fixture 무변경**(insights는 `build_report` 파생, proto/DB 미경유).

### 3.4 정렬 (`order_rank`) — 불변
A9가 이미 `load_gen_saturated`를 rank 3에 넣었다. enrich는 같은 kind라 rank 무변경 → 인사이트 집합·순서 전부 A9와 동일.

---

## 4. UI / 문구 (초보자 해석 가능, ADR-0035)

### 4.1 헤드라인 — 불변
`InsightPanel.tsx::message()`의 `load_gen_saturated` case는 A9 그대로:
> 목표한 부하를 다 걸지 못했어요 — 초당 최대 {value}건까지만 보냈고, 보내려다 못 보낸 요청이 {count}건 있어요

### 4.2 행동 줄 — cause로 분기 (신규)
현재 `InsightPanel`은 행동 줄을 정적 `ACTIONS[i.kind]`(=`ko.insightActions[kind]`)로 렌더한다. `load_gen_saturated`만 **insight 값에 따라 동적 산출**하도록 작은 분기를 추가한다(다른 kind는 기존 정적 경로 그대로):

```ts
// InsightPanel.tsx — 행동 줄 산출
function actionFor(i: Insight): string | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots")    return ko.saturation.slots(n(i.recommended)); // n()=toLocaleString
    if (i.cause === "capacity") return ko.saturation.capacity;
    return ko.insightActions.load_gen_saturated;                              // 폴백(A9 일반 문구)
  }
  return ACTIONS[i.kind];
}
```
숫자 포맷(`n()`=`toLocaleString("en-US")`)은 기존대로 InsightPanel에 남기고, 문구 텍스트만 `ko.ts`에서 가져온다(ADR-0035 단일 소스).

### 4.3 `ko.ts` 문구 (신규 키)
```ts
// 기존 (A9, 폴백으로 재사용): insightActions.load_gen_saturated
//   "에러·지연(latency)이 함께 높으면 대상 서버의 한계, 아니면 테스트 도구
//    (워커 CPU·동시 실행 수 max_in_flight)를 늘려 다시 실행하세요."
saturation: {
  slots: (rec: string) =>
    `동시 실행 수(max_in_flight)가 목표에 비해 작아요 — 최소 ~${rec}로 올려 다시 실행하세요. ` +
    `(에러·지연이 함께 높으면 대상 서버가 한계라 슬롯만 늘려선 처리량이 안 늘 수 있어요.)`,
  capacity:
    `동시 실행 수(max_in_flight)는 목표에 충분했어요 — 한계는 테스트 도구(워커 CPU)나 ` +
    `대상 서버입니다. max_in_flight를 올려도 처리량은 안 늘어요.`,
},
```

### 4.4 초보자 배려 원칙 (A9 계승)
- 내부 용어 추방: "부하 생성기/SUT" 대신 "테스트 도구"/"대상 서버", `max_in_flight`는 "동시 실행 수(max_in_flight)" 병기.
- 두 줄 구조: 헤드라인=*무슨 일*, 행동 줄=*그래서 뭘 하나*.
- severity `warning` → 기존 앰버 카드 재사용.

---

## 5. 데이터 흐름 / 손대는 파일

순수 가산·읽기경로. **엔진·워커·proto·migration·골든 fixture 무변경.** `Insight` 구조체 + UI Zod만 가산(A9의 "구조체 무변경" 대비 유일한 차이).

| 파일 | 변경 |
|---|---|
| `crates/controller/src/insights.rs` | `Insight`에 `recommended: Option<f64>`·`cause: Option<String>` 필드 + `Insight::new` 초기화(둘 다 None) · `derive_insights` 시그니처에 `max_in_flight: Option<u32>`·`target_rps: Option<u32>` 추가(맨 끝, `dropped` 다음) · `dropped > 0` 블록에 §3.2 계산 후 `ins.recommended`/`ins.cause` 세팅 · 단위 테스트 추가 |
| `crates/controller/src/report.rs` | `derive_insights(...)` 호출부(현 `:557`)에 인자 2개 추가: `run.profile.max_in_flight` + 유효 목표 `run.profile.target_rps.or_else(|| run.profile.stages.as_ref().and_then(|s| s.iter().map(|st| st.target).max()))`(둘 다 `Option<u32>`). `Profile`/`Stage`는 이미 call site에서 deref 가능(`run.profile`, `:471`/`:550`/`:691`). |
| `ui/src/api/schemas.ts` | `InsightSchema`에 `recommended: z.number().optional()`·`cause: z.string().optional()` (백엔드 `skip_serializing_if` → 생략되므로 **`.optional()`**, `.nullish()` 아님 — controller CLAUDE.md "skip_serializing_if 필드 → .optional()"). |
| `ui/src/components/report/InsightPanel.tsx` | §4.2 `actionFor` 분기로 행동 줄 산출(load_gen_saturated만 동적, 나머지 정적 `ACTIONS[i.kind]`). |
| `ui/src/i18n/ko.ts` | §4.3 `saturation.slots`(함수)·`saturation.capacity` 키 추가. 기존 `insightActions.load_gen_saturated`는 폴백으로 유지. |

### 5.1 시그니처 변경 영향
`derive_insights`의 **모든 호출부가 새 인자 2개를 받아야 한다**(컴파일러-driven):
- prod 1곳: `report.rs::build_report` → 위 두 식.
- 단위 테스트 다수(`insights.rs` 인라인 `mod tests`): 기존 테스트는 `None, None`(또는 사이징 무관 값)을 넘김 → cause 없음/동작 불변. A9가 추가한 `load_gen_saturated_*`/`saturation_falls_back_*` 테스트도 새 두 인자 갱신(사이징 단언 없으면 `None, None`).

### 5.2 유효 목표 산출 위치
유효 목표(`target_rps` or `max(stages[].target)`)는 **report.rs 호출부에서 산출**해 단일 `Option<u32>`로 주입한다 — `derive_insights`를 스칼라의 순수 함수로 유지(사이징 로직 단위 테스트가 stages 파싱에 안 얽힘). A9의 `dropped` 주입과 동형.

---

## 6. 불변식

1. **`dropped == 0` → 리포트 byte-identical.** 새 필드는 `skip_serializing_if=None`이라 모든 비포화 run에서 생략. `load_gen_saturated` 자체가 안 emit되고 다른 인사이트도 두 필드 None.
2. **`dropped > 0` & `cause`가 폴백(None) → 인사이트가 A9 출력과 byte-identical.** `recommended`/`cause` 둘 다 None → 생략 → A9의 `{value=peak, count=dropped}`와 정확히 동일 + 행동 줄도 A9 일반 문구. 즉 **이 슬라이스의 유일한 와이어 변화는 cause ∈ {slots, capacity}일 때뿐.**
3. **`load_gen_saturated == (dropped > 0)`** (A9 불변식 유지). closed-loop에서 절대 안 뜸 → `vus` 권장은 구조적으로 발생 불가.
4. **summary/windows/overall/RPS/per_step 미접촉.** 사이징은 `summary.p50_ms`·peak·profile 스칼라를 *읽기*만 — 집계 무변경.
5. **판별식 일관**: `max_in_flight < ceil(target × p50_sec)` ⟺ `cause=="slots"` ⟺ `recommended.is_some()`. (capacity·폴백은 recommended None.)

---

## 7. 테스트

### 7.1 `insights.rs` 단위
- `saturated_slots_recommends_when_underprovisioned`: `dropped>0` + windows(peak 산출) + `summary.p50_ms = 50` + `target_rps = Some(10_000)` + `max_in_flight = Some(100)` → `cause=="slots"`, `recommended == Some(500.0)`(=ceil(10000×0.05)). value=peak·count=dropped 동시 단언.
- `saturated_capacity_when_slots_sufficient`: 같은 지연/목표지만 `max_in_flight = Some(2_000)`(≥500) → `cause=="capacity"`, `recommended == None`.
- `saturated_sizing_falls_back_when_latency_zero`: `summary.p50_ms = 0` + 목표/슬롯 Some → `cause == None`, `recommended == None`(폴백). **value/count는 여전히 A9대로 emit**(인사이트 자체는 뜸).
- `saturated_sizing_falls_back_when_profile_absent`: `max_in_flight = None`(또는 `target_rps = None`) → `cause == None`.
- `sizing_uses_stages_peak_target`: report.rs 측 유효목표 산출 — `target_rps=None` + `stages=[{4000,..},{12000,..}]` → 주입된 target=12000으로 `required` 산출. (이 산출은 §5.2상 report.rs에 있으므로 report.rs 테스트로, 아래 7.2.)
- **A9 기존 테스트 갱신**: `derive_insights` 호출 전부 새 인자 2개 추가. `load_gen_saturated_when_dropped`/`no_saturation_when_dropped_zero`/`saturation_falls_back_to_summary_rps`/`insights_deterministic_order`는 사이징 무관이면 `None, None` 전달 → 기존 단언 불변.
- `recommended.max(1)` 경계: `target × L < 1`(예 target=10, p50=50ms → 0.5) → `required == 1`(0 아님). (slots/capacity 분기는 max_in_flight 비교라 별도.)

### 7.2 `report.rs` 배선
- `build_report_sizing_slots`: `RunRow.profile.target_rps=Some(10_000)`·`max_in_flight=Some(100)`·`dropped=N(>0)` + p50>0 윈도 → `ReportJson.insights`의 `load_gen_saturated`에 `cause="slots"`·`recommended=Some(500.0)`.
- `build_report_sizing_uses_stages_peak`: `target_rps=None` + `stages=[…peak 12000…]` → 유효목표 12000 주입 검증(`required` 반영).
- `dropped=0` → 인사이트 미포함(A9 회귀 가드 유지).

### 7.3 UI (`InsightPanel.test.tsx`)
- slots 인사이트(`cause:"slots", recommended:500, value, count`) → 헤드라인 + "→ … 최소 ~500로 올려 …" 행동 줄, 문구 `ko.saturation.slots` 경유, 앰버 카드.
- capacity 인사이트(`cause:"capacity"`, recommended 없음) → "→ … 올려도 처리량은 안 늘어요" 행동 줄(`ko.saturation.capacity`).
- 폴백(cause/recommended 없는 A9형 `load_gen_saturated`) → A9 일반 행동 줄(`ko.insightActions.load_gen_saturated`) 그대로 — **A9 기존 테스트 회귀 가드**.

### 7.4 라이브 검증(머지 전, 수동)
`capacity-planning.md §1` 레시피로 python responder + controller subprocess + 격리 DB. **단, responder에 수십 ms 인공 지연을 넣어 `p50_ms > 0`을 보장**(localhost sub-ms면 §2.4 폴백이라 권장이 안 뜸 — Slice 5 함정과 동류). 작은 `max_in_flight`로 open-loop run → `/report` JSON의 `load_gen_saturated`에 `cause="slots"`·`recommended≈목표×p50` 확인 + 실브라우저 InsightPanel에 "최소 ~N로 올려" 두 줄 + 콘솔 Zod 0. 그 다음 `max_in_flight`를 충분히 크게(≥required) 잡아 같은 목표로 다시 → `cause="capacity"`·"올려도 안 늘어요" 확인. closed-loop run은 인사이트 부재(byte-identical) 확인.

---

## 8. 의도적 연기 (roadmap §A9에 누적)

- **closed-loop `vus` 권장**: `dropped`가 closed-loop엔 없어 이 트리거로는 발생 불가. closed-loop 사이징은 다른 트리거(create-time, 또는 별도 post-run 휴리스틱)가 필요 → 별도(create-time 힌트와 묶임).
- **mean latency 정밀화**: 현재 p50 프록시. HDR mean을 `summary`까지 끌어와 정밀화는 별도(권장값은 근사 floor라 v1 가치 충분).
- **per-window dropped 정밀 핀포인트**: "어느 stage에서 슬롯이 꺾였나"(drain/guard/proto/migration 비용). v1은 run-total `dropped` + peak로 충분.
- **create-time RunDialog 사이징 힌트**: target_rps/max_in_flight 입력 중 라이브 "이 슬롯은 ~Y RPS에서 막힘"(지연 가정 필요, 완료 run 불요). pre-run 계획 표면 — 별도 슬라이스.
- **open-loop misconfig 경고**: open-loop인데 큰 `vus`로 N>1 워커 fan-out → `target_rps` 복제 사고(capacity-planning §4). create-time 경고가 자연스러움 → 별도.
- **원인 자동 귀속 심화**: 현재 판별은 "슬롯 vs 그 외(CPU/SUT)"까지. CPU vs SUT를 에러·지연 신호로 자동 분기하는 건 v1 위임(행동 줄이 "에러·지연이 함께 높으면 서버" 단서 제공).

---

## 9. 구현 순서 (plan 입력)

1. **`insights.rs` + `report.rs` (한 green 커밋)**: `Insight` 필드 2개 + `derive_insights` 시그니처 2 스칼라 + §3.2 계산 + 단위 테스트 + `report.rs` 호출부(유효목표 산출 포함) + report.rs 배선 테스트. (Rust 게이트가 전체 워크스페이스를 돌리므로 dead-code/RED 단독 커밋 불가 — 헬퍼+로직+테스트+호출부를 한 커밋으로 fold. A9와 동일.)
2. **UI**: `schemas.ts` Zod 2필드 + `ko.ts` `saturation` 문구 + `InsightPanel.tsx` `actionFor` + `InsightPanel.test.tsx`. (UI 게이트 `pnpm lint && pnpm test && pnpm build`.)
3. **라이브 검증(§7.4)** → 머지.
