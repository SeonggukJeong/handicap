# A9 v1 — 부하 생성기 포화 인사이트 (`load_gen_saturated`) 설계

- **날짜**: 2026-06-14
- **상태**: 설계 승인 → plan 대기
- **출처**: roadmap §A9(부하 생성기 용량 추천 / 포화 인사이트). 사용자 질문 2026-06-14 "RPS 10,000 돌리고 싶은데 컴퓨팅이 받쳐줄지 어떻게 아나?".
- **연관**: ADR-0028(A4c insights 패턴 — 재사용), ADR-0031(open-loop·`dropped`·단일워커 v1), ADR-0035(한국어 문구·`ko.ts` 카탈로그·초보자 친화), `docs/dev/capacity-planning.md`(이 인사이트가 자동화하는 수동 절차).
- **ADR 신규 불필요**: A4c가 "인사이트 종류 추가 = 기존 파이프라인 내 additive, ADR 불요" 선례를 세움. 이 슬라이스는 인사이트 1종 추가일 뿐 새 결정이 없다.

---

## 1. 문제와 목표

Handicap은 부하 *생성기*지 용량 *플래너*가 아니라, "지속 가능한 최대 RPS"를 자동으로 알려주지 않는다. open-loop run에서 사용자는 리포트의 `dropped`/`summary.rps`를 눈으로 보고 "내 부하기가 그 도착률을 못 따라갔나"를 직접 판단해야 한다(수동 절차 = `capacity-planning.md`).

**목표**: 그 판단을 **리포트가 직접 한 줄로 뱉게** 한다 — open-loop run이 요청한 도착률을 실제로 못 냈으면(=`dropped > 0`), "목표 부하를 다 걸지 못했다"는 인사이트를 자동 표면화하고, 관측된 최대 처리량과 다음 행동을 **초보 QA도 해석 가능한 평이한 한국어**로 제시한다.

**비목표(연기)**: §8 참조. 요약하면 Little's Law 사이징 권장, open-loop misconfig 경고, per-window dropped 정밀 핀포인트, "achieved vs 고정 target 부족분" arm.

---

## 2. 핵심 통찰 (설계의 근거)

1. **`dropped`는 open-loop 전용 신호다.** closed-loop는 `dropped`를 절대 증가시키지 않는다(엔진 `runner.rs` open-loop 스케줄러만 `dropped++`). 따라서 **`dropped > 0`은 그 자체로 open-loop run에 자동 한정**된다 — `target_rps`/`stages`/`is_open_loop()`를 따로 검사할 필요가 없다.

2. **"achieved ≪ target" arm은 ramp에서 거짓양성을 낸다.** `stages` 램프(예: 0→10k over 30s)는 whole-run 평균 achieved가 ~5k라, 이를 *peak* target(10k)과 비교하면 모든 램프가 "포화"로 오판된다. 그래서 v1 트리거에서 이 arm을 **제외**하고 `dropped > 0` 단일 신호만 쓴다.

3. **관측 천장 N은 `summary.rps`(whole-run 평균)가 아니라 peak per-second throughput이다.** 램프 run에서 whole-run 평균은 천장을 과소평가한다(0부터 올라간 평균). 정확한 천장 = **초당 처리량의 최대값** = `windows`(이미 `derive_insights`가 받는 입력)를 `ts_second`로 묶어 초당 총 count를 구한 뒤 그 최대. 새 데이터 라인 0.

4. **원인(부하기 vs SUT)은 `dropped`만으로 단정 불가** — open-loop `dropped`는 부하기 CPU 한계뿐 아니라 SUT 응답 지연으로 슬롯이 막혀도 오른다(`capacity-planning.md §0`의 두 용량 구분). 그래서 인사이트는 **"목표 도착률 미달성"이라는 관측 사실만 단정**하고, 원인 귀속은 사용자가 에러·지연 인사이트와 교차로 판단하도록 "다음 행동" 줄에서 안내한다(자동 귀속 로직 없음 = 최소 범위).

---

## 3. 트리거와 계산

`derive_insights`(순수 함수, `crates/controller/src/insights.rs`) 안에서:

### 3.1 발사 조건
```
dropped > 0
```
- `dropped`는 새 파라미터로 주입(§5). closed-loop·비포화 open-loop은 항상 0 → 미emit.

### 3.2 관측 천장 N (peak per-second throughput)
- `windows: &[ReportWindow]`를 `ts_second`로 그룹핑, 각 초의 모든 step 행 `count` 합 → 그 최대값을 `N`(u64)으로.
- **경계 부분초 제외 불필요**: 부분초는 요청 수가 적어 최대가 될 수 없으므로 단순 max로 충분(`min_window_rps`와 달리 경계 trim 불요).
- **폴백**: `windows`가 비어 있으면(이론상 `dropped>0`인데 완료 윈도가 0인 극단 — 사실상 미발생) `N = summary.rps.round() as u64`.

### 3.3 인사이트 레코드 (`Insight` 구조체 재사용, 필드 추가 없음)
| 필드 | 값 |
|---|---|
| `kind` | `"load_gen_saturated"` |
| `severity` | `"warning"` |
| `value` | `N` (관측 최대 초당 처리량, f64로) |
| `count` | `dropped` (못 보낸 요청 수) |
| 그 외 | `None` |

`Insight`의 기존 optional 필드(`value`/`count`)만 쓴다 — **구조체·proto·migration·UI Zod 무변경**(`InsightSchema.kind: z.string()`·`value`/`count` optional이라 새 kind가 그대로 파싱).

### 3.4 정렬 (`order_rank`)
`load_gen_saturated`를 **rank 3**(5xx 다음, no_request_step 앞)에 삽입하고 이후를 +1 시프트. 근거: 부하 미적용은 리포트 전체 해석을 흔드는 방법론적 경고라 상위에 두되, 구체 결함인 SLO 실패(1)·서버 5xx(2) 아래.

| rank | kind |
|---|---|
| 1 | `slo_failure` |
| 2 | `status_class` 5xx |
| **3** | **`load_gen_saturated`** (신규) |
| 4 | `no_request_step` (3→4) |
| 5 | `error_hotspot` (4→5) |
| 6 | `status_class` 4xx (5→6) |
| 7 | `status_temporal` (6→7) |
| 8 | `slowest_step` (7→8) |
| 9 | `slo_pass` (8→9) |

기존 kind들은 **상대 순서가 보존**된다(전부 균일하게 +1) → `dropped==0`인 기존 리포트는 인사이트 집합·순서 모두 불변(§6 불변식).

---

## 4. UI / 문구 (초보자 해석 가능, U5 §7.3 패턴)

기존 `InsightPanel`의 2-요소 렌더 경로를 그대로 탄다(새 표면·HelpTip 없음):

### 4.1 헤드라인 — `InsightPanel.tsx::message()` 신규 case
> **목표한 부하를 다 걸지 못했어요 — 초당 최대 {value}건까지만 보냈고, 보내려다 못 보낸 요청이 {count}건 있어요.**

- `{value}`/`{count}`는 기존 `n()`(`toLocaleString("en-US")`)로 천단위 구분.

### 4.2 다음 행동 — `ko.ts::insightActions.load_gen_saturated` 신규 키
> 에러·지연(latency)이 함께 높으면 **대상 서버**의 한계, 아니면 **테스트 도구**(워커 CPU·동시 실행 수 max_in_flight)를 늘려 다시 실행하세요.

`InsightPanel`이 `→` 프리픽스로 자동 렌더(`ACTIONS[i.kind]` 경로, 기존 6종과 동일).

### 4.3 초보자 배려 원칙
- **내부 용어 추방**: "부하 생성기/SUT" 대신 **"테스트 도구" / "대상 서버"**. `latency`·`max_in_flight`는 한국어 뜻 인라인 병기("지연(latency)", "동시 실행 수(max_in_flight)").
- **두 줄 구조**: 헤드라인 = *무슨 일이 일어났나*, 행동 줄 = *그래서 뭘 하나*(원인 귀속을 일상어로 사용자에게 위임).
- **모든 신규 문구는 `ko.ts`**(ADR-0035 단일 소스). severity `warning` → 기존 앰버 카드 스타일 재사용.

---

## 5. 데이터 흐름 / 손대는 파일

순수 가산. **엔진·워커·proto·migration·골든 fixture·UI Zod 스키마 전부 무변경.**

| 파일 | 변경 |
|---|---|
| `crates/controller/src/insights.rs` | `derive_insights`에 파라미터 `dropped: u64` 추가(시그니처 **맨 끝**) · `order_rank` 테이블에 `("load_gen_saturated", _) => 3` 추가 + 이후 +1 · `dropped > 0` 분기에서 peak 계산 후 인사이트 push · 단위 테스트 추가 |
| `crates/controller/src/report.rs` | `derive_insights(...)` 호출부(현 `:557`)에 **`run.dropped as u64`** 인자 추가 (유일 prod 호출부). **`RunRow.dropped`는 `i64`**(`store/runs.rs:165`)라 cast 필요 — `report.rs:652`가 이미 `dropped: run.dropped as u64`로 같은 cast를 함. |
| `ui/src/components/report/InsightPanel.tsx` | `message()` switch에 `load_gen_saturated` case |
| `ui/src/i18n/ko.ts` | `insightActions.load_gen_saturated` 추가 |

`derive_insights`의 신규 입력은 `dropped` **하나뿐** — `summary`/`windows`는 이미 받고 있다.

### 5.1 시그니처 변경 영향
`derive_insights`의 **모든 호출부가 새 인자를 받아야 한다**(컴파일러-driven):
- prod 1곳: `report.rs::build_report` → `run.dropped as u64`.
- 단위 테스트 ~다수(`insights.rs` 인라인 `mod tests`): 기존 테스트는 전부 `0`(비포화)을 넘김 → 동작 불변. (Rust는 기본 인자가 없으므로 각 호출부에 `0` 명시.)

---

## 6. 불변식

1. **`dropped == 0` → 리포트 byte-identical.** 모든 closed-loop + 비포화 open-loop은 새 인사이트를 안 만들고, `order_rank` 시프트가 기존 kind들의 상대 순서를 보존하므로 인사이트 배열이 정확히 이전과 동일.
2. **`load_gen_saturated == (dropped > 0)`.** 다른 어떤 신호도 이 인사이트를 만들지 않는다(closed-loop에서 절대 안 뜸).
3. **summary/windows/overall/RPS/per_step 미접촉.** 인사이트는 읽기 전용 파생 — 집계를 건드리지 않는다.

---

## 7. 테스트

### 7.1 `insights.rs` 단위
- `load_gen_saturated_when_dropped`: `dropped=5` + windows(여러 초·여러 step) → 인사이트 `value == max(초당 총 count)`, `count == 5`, `severity=="warning"`.
- `no_saturation_when_dropped_zero`: `dropped=0` → `load_gen_saturated` 미emit(기존 인사이트는 정상).
- `saturation_peak_is_max_per_second`: windows = `{ts0: step_a 3 + step_b 4 = 7, ts1: step_a 10 = 10}` → `value == 10`(평균 아님).
- `saturation_falls_back_to_summary_rps`: `dropped>0` + `windows=[]` → `value == summary.rps.round()`. **주의**: 인라인 테스트의 `summary()` 헬퍼(`insights.rs:240`)는 `rps: 0.0`이라, 이 테스트는 픽스처에 **0이 아닌 `rps`를 명시 설정**해야 폴백이 0을 동어반복으로 단언하지 않는다.
- `insights_deterministic_order` **갱신**: `dropped>0`를 픽스처에 추가해 `load_gen_saturated`가 rank 3 위치(5xx와 no_request_step 사이)에 끼는지 단언 + 기존 kind 상대순서 보존 확인.
- **`all_pass_run_has_slowest_and_slo_pass`의 인라인 주석 갱신**(`insights.rs:518` `// order_rank 7 then 8`): +1 시프트로 slowest_step→8·slo_pass→9가 되므로 주석을 "8 then 9"로 정정(단언 자체는 kind 순서라 통과·불변, 주석만 stale).

### 7.2 `report.rs` 배선
- `build_report_saturation_insight`: `RunRow.dropped = N(>0)` + 윈도 픽스처 → `ReportJson.insights`에 `load_gen_saturated`(value=peak, count=N) 포함. `dropped=0`이면 미포함.

### 7.3 UI (`InsightPanel.test.tsx`)
- `load_gen_saturated` 인사이트 1건 입력 → 헤드라인(못 보낸 {count}·초당 최대 {value}) + "→ 다음 행동" 줄 렌더, 문구는 `ko.ts` 경유. severity=warning → 앰버 카드.

### 7.4 라이브 검증(머지 전, 수동)
`capacity-planning.md §1`/루트 CLAUDE.md "RPS로 수동 검증" 레시피로: python `ThreadingHTTPServer` 200-responder + controller subprocess + 격리 DB. 의도적으로 작은 `max_in_flight`로 open-loop run을 돌려 `dropped > 0` 유발 → 리포트 `/report` JSON에 `load_gen_saturated` 인사이트(value≈관측 천장, count=dropped) + 실브라우저 InsightPanel에 평이한 한국어 두 줄 + 콘솔 Zod 0. closed-loop run은 인사이트 부재(byte-identical) 확인.

---

## 8. 의도적 연기 (roadmap §A9에 누적)

- **Little's Law 사이징 권장**: 관측 평균 latency 기반 `max_in_flight`/`vus` 권장값 제안. 권고값이라 오도 가능 + 판단 복잡도↑ → 별도 슬라이스.
- **open-loop misconfig 경고**: open-loop인데 `vus`가 커서 N>1 워커 fan-out → `target_rps` 복제 사고(capacity-planning §4) 경고. `capacity`가 리포트에 없어 post-run 감지가 애매 → create-time 경고가 더 자연스러움. 별도.
- **per-window dropped 정밀 핀포인트**: 초별 `dropped` 분해(drain/guard/proto/migration 비용)로 "어느 stage에서 꺾였나"를 정확히. v1은 run-total `dropped` + peak per-second로 충분.
- **"achieved vs 고정 target 부족분" arm**: 고정-레이트(stages 아님) open-loop에서 `achieved < 0.9×target_rps`를 보조 트리거로. §2.2 ramp 거짓양성 회피 위해 고정-레이트 게이팅 필요 → 가치 대비 복잡, 연기.
- **원인 자동 귀속**: 에러/지연 신호로 "부하기 vs SUT"를 인사이트가 분기 표기. v1은 사용자 위임(다음 행동 줄).

---

## 9. 구현 순서 (plan 입력)

1. `insights.rs`: `derive_insights` 시그니처에 `dropped` 추가 + peak 헬퍼 + `order_rank` 시프트 + 인사이트 push + 단위 테스트 + `report.rs` 호출부 `run.dropped as u64`. (Rust 게이트가 전체 워크스페이스를 돌리므로 dead-code/RED 단독 커밋 불가 — 한 green 커밋으로 fold: 헬퍼+로직+테스트+호출부.)
2. UI: `ko.ts` 키 + `InsightPanel.tsx` case + `InsightPanel.test.tsx`. (UI 게이트 `pnpm lint && pnpm test && pnpm build`.)
3. 라이브 검증(§7.4) → 머지.
