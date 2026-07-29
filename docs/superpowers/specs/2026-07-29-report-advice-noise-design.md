# run 완료 리포트 조언 밀도 축소 + 느린-스텝 인사이트 실질성 (report-advice-noise)

- **날짜**: 2026-07-29
- **유형 태그**: `user-path` (주) + `correctness-bug` (US4 — 근거 없는 "병목" 주장 제거)
- **테마**: §A11 속지 않는 오픈 시험 — **3차(사후 표면 밀도)**. 1차 `f93544a`(사후 soft validity+narrative), 2차 `1d7e8e4`(실행 전 preflight), 정밀화 `4723e06`.
- **발의**: 사용자 도그푸딩 원문 (2026-07-29)
  > "run 완료 후에 나오는 조언 여러줄이 이미 알만큼 아는 사람한테는 너무 노이즈야. 그리고 인사이트는 가장 느린 API를 알려주는데, 1~2ms 차이로 느려도 그게 문제라고 나오니 현실과는 거리가 있어보여."

## 사용자 스토리 (US)

> **US1**: QA가 부하 run을 끝내고 리포트를 열 때, 매번 반복되는 고정 안내를 건너뛰고 결과 숫자부터 보려 한다 — 성공하면 시험 유효성 `ok`인 run에서 조언 영역이 **접힌 한 줄**뿐이고(빈 배너 본문·주요 사건 섹션 소멸), `limited`인 run에서도 이유 줄 외에 해석 목록이 **접혀 있는** 것을 본다.

> **US2**: QA가 리포트를 처음 보는 팀원에게 설명할 때, 숨겨둔 일반 안내를 다시 켜려 한다 — 성공하면 인사이트 패널의 토글 한 번으로 모든 `→` 안내가 돌아오고, 그 선택이 **다음 run 리포트에서도 유지**되는 것을 본다.

> **US3**: 운영자가 open-loop run이 목표 부하를 다 못 걸었을 때, 슬롯을 얼마로 올려야 하는지 알아내려 한다 — 성공하면 **일반 안내를 꺼둔 상태에서도** 권장 `max_in_flight` 수치와 목표/달성 도착률이 그대로 보이는 것을 본다.

> **US4**: 운영자가 스텝들이 고만고만하게 빠른 run의 결과를 볼 때, 실제로 손볼 스텝이 있는지 판단하려 한다 — 성공하면 스텝 간 p95 격차가 1~2ms뿐인 run에서 느린-스텝 인사이트가 **아예 안 뜨고**(화면·CSV·XLSX·비교 뷰 전부), 격차가 큰 run에서만 **2위 대비 격차·배수와 함께** 뜨는 것을 본다.

> **US1 조정 고지 (brainstorming 승인본과의 차이)** — 승인 시 US1은 `ok` run에서 "0줄"이었다. 그러나 사용자가 `production_identity`("프로덕션과 동일한 환경")·`slo_gate`("SLO 게이트 판정(기준 미설정)") 두 문구를 **삭제하지 않고 유지**하기로 결정했으므로(§3 D4), `ok` run에서 블록을 통째로 미렌더하면 그 두 문구가 **가장 흔한 run 유형에서 도달 불가**가 되어 "유지" 결정이 사실상 무효화된다. → `ok`는 **0줄이 아니라 접힌 한 줄**로 확정한다. 사용자 spec 리뷰에서 이 한 줄을 없애기로 하면 §3 D4를 함께 뒤집어야 한다(두 결정은 독립이 아니다).

## 1. 문제 (실측)

`RunDetailPage` → `ReportView.tsx:160-164`가 종료 리포트 상단에 네 블록을 세로로 쌓는다:

```
<ValidityBanner />      // Callout: 제목 "시험 유효성" + 이유 <ul>
<NarrativeBlock />      // PageSection: 주요 사건 / 말할 수 있는 것 / 말할 수 없는 것 (각 최대 5)
<VerdictPanel />        // criteria 있을 때만
<InsightPanel />        // 인사이트마다 사실 1줄 + `→` 조치 1줄
```

관측되는 결함 4종:

| # | 결함 | 근거 |
|---|---|---|
| P1 | `level === "ok"`(=이유 0건)이어도 **제목만 있는 빈 Callout**이 렌더된다 | `ValidityBanner.tsx:50-56` — `reasons.length > 0`일 때만 `<ul>`, 그 외엔 `null` 자식. 조기 반환은 `!validity`뿐(`:41`). 로드맵 §A11 회고 6에 "empty-ok ValidityBanner 제목만"으로 이미 잔재 기록 |
| P2 | `주요 사건` 목록은 **같은 화면의 배너·인사이트를 코드로 재진술**한 것 | `validity.rs:178-187` — validity reason마다 `validity:{kind}`, 인사이트마다 `insight_event_code`(`:151-167`)를 push. 고유 정보 0 |
| P3 | 인사이트마다 붙는 `→` 조치문이 **일반 코칭과 계산된 권장치를 구분 없이** 같은 자리에 쌓인다 | `InsightPanel.tsx:60-80 actionFor` — `ko.insightActions`(7종 일반 코칭)와 `ko.saturation.*`(측정값+권장 `max_in_flight`)이 동일 렌더 경로(`:97-105`) |
| P4 | `slowest_step`에 **임계값이 전혀 없다** — 스텝이 1개뿐이거나 격차가 1ms여도 발행되고, 문구는 "이 API가 **병목**입니다" | `insights.rs:145-158`(무조건 max-p95 선정) + `ko.ts:1215` |

P4의 파급: `validity.rs:232-234`가 `slowest_step` 존재만 보고 `can_claim`에 `bottleneck_step`("상대적으로 느린(병목) 스텝을 식별할 수 있습니다")을 넣는다. 즉 격차 1ms짜리 run도 "병목을 식별할 수 있다"고 **주장**한다.

## 2. 범위 / 비범위

**범위**: 종료 리포트의 조언 표면 밀도(P1–P3) + 느린-스텝 인사이트의 발행 조건·문구(P4), 그리고 그 변화가 export 4표면·비교 뷰·내러티브에 일관되게 전파되는 것.

**비범위** (의도적):
- **기여도 기반 진짜 병목** — §10-A. p95-max는 `loop repeat`·`parallel` 동시성을 무시하므로 게이트를 걸어도 "어느 스텝을 고칠 것인가"엔 답하지 못한다. 별개 인사이트라 이번에 섞지 않는다.
- `production_identity`/`slo_gate` 문구 **삭제** — 사용자 보류(§3 D4). 접힌 채 유지.
- `ValidityBadge`(헤더, `RunDetailPage.tsx:132`) 및 헤더 배지 혼잡(§A11 회고 6 잔재) — 무변경.
- `InsightPanel.message()`의 선재 인라인 한국어 리터럴 전반 — §10-B.
- 임계값의 settings 승격 — §10-C. 같은 파일의 `TAU_5XX`/`TAU_LAT`/`TAU_SPAN`(`insights.rs:311-313`)이 상수인 선례를 따른다.

## 3. 결정 (brainstorming 승인)

| id | 결정 | 근거 |
|---|---|---|
| D1 | **잘라내고 + 접는다** — 항상 참인 것은 영구 삭제, 나머지 해석은 기본 접힘 | 사용자 선택. 초보자 보호(A11 테제)를 잃지 않으면서 전문가 피로 제거 |
| D2 | 느린-스텝 자격 = **격차 기준** — 2위와의 p95 절대 격차 ∧ 배수 둘 다 충족 | 사용자 원문 "1~2ms 차이"를 직접 인코딩. "골고루 느림"을 특정 스텝 문제로 오판하지 않음 |
| D3 | 조치문은 **패널 단위 접이식**(기본 숨김·영속) | 행마다 컨트롤을 달면 시각 노이즈가 되레 늘어남 |
| D4 | 영구 삭제 = **빈 ok 배너 본문 · 주요 사건 섹션** 2건. `production_identity`·`slo_gate`는 **접힌 채 유지** | 사용자: "추천 외의 항목들은 조금 더 써보면서 생각해볼게" |
| D5 | 게이트는 **서버**, 접기·토글은 **UI** | 인사이트가 export 4표면의 단일 소스(`export.rs:86-105`)이고 `bottleneck_step`이 거기서 파생 — UI에서만 숨기면 화면은 조용한데 export·내러티브는 계속 "병목"이라 말한다(화면↔export parity, ADR-0030 계보) |
| D6 | `narrative.events`는 **서버에서도 제거**(UI 미렌더에 그치지 않음) | 렌더하는 곳이 0이 되면 필드·계산 30줄·ko 14키·XLSX row 9가 전부 유지 대상 사각이 된다. 살릴 근거였던 §A13-g 감리 번들은 로드맵에 "지금은 착수하지 않음". YAGNI |
| D7 | 조치문 토글은 **일반 안내에만** — `ko.saturation.*`(측정값+권장치)는 항상 표시 | 포화 시 권장 `max_in_flight`는 전문가가 유일하게 원하는 조치문이고, `sut` arm은 "슬롯을 늘리지 말라"는 **반대 방향 경고**라 숨기면 위험 |
| D8 | 유효성 배너와 결과 해석을 **한 블록으로 병합** | 둘 다 같은 `validity` 파생인데 상자가 둘이라 그 자체로 "여러 줄"을 만든다 |
| D9 | 문구 정직화 — "병목" 인과 주장 제거, 사실(격차·배수)만 진술 | §10-A가 비범위인 한 "병목"은 증명되지 않은 주장 |

## 4. 서버 변경 (`crates/controller`)

### 4.1 느린-스텝 실질성 게이트 (`insights.rs`)

기존 `TAU_*` 명명을 따르는 상수 2개를 추가한다(현 `TAU_5XX`/`TAU_LAT`/`TAU_SPAN` 블록 근처):

```rust
/// 느린-스텝 인사이트 실질성 게이트 (spec §4.1).
const TAU_SLOW_GAP_MS: u64 = 20;   // 2위 스텝과의 p95 절대 격차 하한
const TAU_SLOW_RATIO: f64 = 1.5;   // 2위 스텝 대비 배수 하한
```

`derive_insights`의 `slowest_step` 블록(`insights.rs:145-158`)을 다음 규칙으로 교체:

- **top** = p95 최대 스텝 (기존 선정 규칙 유지 — 동률이면 첫 스텝, `steps`는 step_id 정렬).
- **runner_up** = top을 제외한 나머지 중 p95 최대. 나머지가 없으면(=스텝 1개) **미발행**.
- 발행 조건 (둘 다 참):
  1. `top.p95_ms - runner_up.p95_ms >= TAU_SLOW_GAP_MS`
  2. `top.p95_ms as f64 >= TAU_SLOW_RATIO * runner_up.p95_ms as f64`

**나눗셈을 쓰지 않는 것이 요건이다** — `top / runner_up`은 `runner_up == 0`(localhost sub-ms에서 흔함)에서 0-나눗셈이 된다. 곱셈 형태는 `runner_up == 0`일 때 조건 2가 자연히 참이 되고, 그 경우 조건 1이 단독 판정한다(의도된 동작: 0ms 대비 20ms 이상이면 실질적 격차).

`top.p95_ms >= runner_up.p95_ms`는 선정 방식상 불변이지만, 조건 1은 `saturating_sub` 또는 f64 연산으로 써서 향후 선정 규칙이 바뀌어도 언더플로 패닉이 나지 않게 한다.

발행 시 채우는 필드: 기존 `step_id`/`metric="p95_ms"`/`value=top.p95_ms` + **신규 `runner_up_ms = Some(runner_up.p95_ms as f64)`**.

`order_rank`(`insights.rs:75-88`)의 `("slowest_step", _) => 8`은 무변경 — 발행되면 자리는 그대로다.

### 4.2 `Insight`에 `runner_up_ms` 가산

`insights.rs`의 `Insight` 구조체 **맨 끝**에 추가한다(`export.rs:87-88` 주석이 "구조체 필드 순서와 일치"를 계약으로 못박고 있으므로 중간 삽입 금지):

```rust
/// 2위 스텝의 p95(ms) — `slowest_step`에서만 Some. UI가 격차·배수를 로직 복제 없이 표시.
#[serde(skip_serializing_if = "Option::is_none")]
pub runner_up_ms: Option<f64>,
```

`Insight::new`(`:50-70`)에 `runner_up_ms: None` 추가. `validity.rs`의 테스트 헬퍼 `insight()`(`:284-302`)도 같은 필드가 필요하다(struct 리터럴, 컴파일러가 잡음).

**UI가 자체 계산하지 않고 와이어로 받는 이유**: 발행 여부는 서버가 (격차, 배수)로 판정하는데 UI가 2위를 독립 계산해 배수를 표시하면, 향후 서버의 2위 정의가 바뀔 때(예: parallel 분기 스텝 제외) 화면 숫자가 발행 근거와 조용히 어긋난다. 이 저장소가 반복해 데인 "사전 권장 == 사후 인사이트 parity" 계열의 드리프트다.

### 4.3 `narrative.events` 제거 (`validity.rs`)

- `Narrative` 구조체(`:33-38`)에서 `events: Vec<String>` 필드 삭제.
- `insight_event_code`(`:151-167`) 함수 전체 삭제.
- `derive_narrative`(`:171-258`)의 §5.1 events 계산 블록(`:177-187`) 삭제. `push_unique`는 can/cannot에서 계속 쓰이므로 **존치**. `insights` 파라미터도 `:222-235`가 쓰므로 **존치**.
- `can_claim`/`cannot_claim` 로직·순서·truncate(5)·`production_identity` cap-replace(`:241-251`)는 **무변경**(D4).
- 삭제되는 테스트: `events_validity_first_then_insights_max_5`(`:566-590`), `events_dedup_multiple_no_request_step`(`:592-608`), `events_status_class_codes`(`:610-620`). `default_validity_is_ok_empty`(`:744-751`)의 `n.events.is_empty()` 항은 제거.

### 4.4 export (`export.rs`)

- `INSIGHT_COLUMNS`를 `[&str; 15]` → `[&str; 16]`로, 맨 끝에 `"runner_up_ms"` 추가(`:89-105`).
- `insight_csv_cells`(`:108-128`) 끝에 `f(ins.runner_up_ms)` 1줄, `write_insight_xlsx_row`(`:132-`) 끝에 `if let Some(v) = ins.runner_up_ms { ws.write_number(row, c(15), v) }` 1블록. 공유 writer라 이 두 곳이 단일/비교 × CSV/XLSX **4표면에 동시 반영**된다.
- XLSX Summary의 `narrative_events_count` 행 삭제(`:471-473`). row 9는 Summary 시트의 **마지막** 행이라(다음은 Steps 시트, `:475-`) 인덱스 시프트가 없다 — 7·8은 그대로.
- `report_with_steps` 픽스처의 `narrative: Default::default()`(`:631`)는 필드 삭제 후에도 유효(컴파일러 확인).
- `xlsx_summary_includes_validity_narrative_rows`(`:705-`)에서 row 9 단언 제거, 테스트명도 `..._includes_validity_rows`로 정정.

### 4.5 UI Zod 동반 (`ui/src/api/schemas.ts`)

- `InsightSchema`(`:380-397`)에 `runner_up_ms: z.number().optional()` — Rust가 `skip_serializing_if`라 **omit**이지 null이 아니므로 `.optional()`이 맞다(같은 블록 `:392` 주석이 이 규칙을 명시).
- `NarrativeSchema`(`:419-423`)에서 `events: z.array(z.string())` 제거.

## 5. UI 변경 (`ui/src`)

### 5.1 유효성·해석 병합 블록 (`ValidityBanner.tsx`, `NarrativeBlock.tsx` 삭제)

`NarrativeBlock.tsx`를 삭제하고 그 내용(말할 수 있는 것 / 말할 수 없는 것)을 `ValidityBanner`의 **접이식 상세**로 흡수한다. 파일·컴포넌트명은 `ValidityBanner` 유지(diff 최소화 — 역할은 커졌으나 여전히 리포트 상단 배너다).

렌더 규칙:

| level | 이유 목록(reasons) | 상세(can/cannot) | 기본 상태 |
|---|---|---|---|
| `ok` (reasons 항상 0건) | 표시 안 함 | 있음 | **접힘** — 화면상 한 줄 |
| `limited` | 표시 (현행과 동일) | 있음 | **접힘** |
| `suspect` | 표시 (현행과 동일) | 있음 | **펼침** |

- `!validity`(구식 리포트: 키 부재) → `return null` 유지. **`ok`를 가짜로 렌더하지 않는다**(A11 D11).
- `level === "ok"` ⟺ `reasons.length === 0`은 서버 불변식(`validity.rs:131-137`)이다. UI는 `reasons.length > 0`으로 이유 렌더를 게이트하므로 두 표현이 어긋나도 깨지지 않는다.
- 접기 토글은 **가시 텍스트를 가진 `<button aria-expanded>`** — `aria-label`을 붙이지 않는다. 붙이면 접근명이 가시 텍스트를 덮어써 WCAG 2.5.3(Label in Name) 위반이 되고, 이 저장소가 이미 두 번 적발한 클래스다.
- **접힘 상태는 영속하지 않는다.** level에서 매번 도출한다. 영속시키면 사용자가 `suspect` 경고를 영구히 숨길 수 있게 된다 — A11 테제 정면 위반.
- `Callout`의 `variant`(`LEVEL_VARIANT`)·`role="region"`·`aria-label={ko.validity.bannerAria}`는 **무변경**.

`ReportView.tsx:160-164`의 렌더 순서는 `ValidityBanner → VerdictPanel → InsightPanel`이 된다(`NarrativeBlock` 줄 삭제). `:160`의 A11 주석과 `ui/CLAUDE.md`의 "ReportView order MUST be Banner→Narrative→Verdict→Insight" 노트를 **같은 커밋에서** 갱신한다(문서화된 불변식의 의도적 변경).

### 5.2 인사이트 조치문 토글 (`InsightPanel.tsx`)

- `actionFor`(`:60-80`)의 반환을 `string | undefined` → `{ text: string; computed: boolean } | undefined`로 바꾼다.
  - `computed: true` = `ko.saturation.slots` / `ko.saturation.slots + slotsAtCap` / `ko.saturation.sut` (측정값·권장치·역방향 경고).
  - `computed: false` = `ko.insightActions.*` 전부(일반 코칭). `load_gen_saturated`의 폴백 2경로(신규 필드 부재 `:74`, cause None `:77`)도 `ko.insightActions` 출처이므로 `false`.
- 렌더(`:97-105`): `computed`면 무조건 표시, 아니면 `showGeneric`일 때만.
- 토글 컨트롤: 패널 제목 아래 첫 자식으로 우측 정렬 `<input type="checkbox">` + `<label>{ko.report.insightActionsToggle}</label>`. **`PageSection`의 `title`(=`<h3>`) 안에 넣지 않는다** — heading 안 대화형 요소 금지(`ui/src/components/ui/CLAUDE.md` U3). 라벨이 접근명을 주므로 `aria-label` 불요.
- 인사이트가 0건이면 패널 자체가 `null`(`:83`)이므로 토글도 안 뜬다 — 무변경.

### 5.3 조치문 표시 설정 영속 (`ui/src/report/…` 신규 소형 모듈)

`editorPrefs`(localStorage `handicap:editor:inspector-sections:v1`)와 동형의 fail-soft 읽기/쓰기:

- 키: `handicap:report:insight-actions:v1`, 값: `boolean`.
- **기본값 `false`(숨김)** — 이 슬라이스의 헤드라인이 "전문가에게 조용한 기본값"이다.
- malformed·비-boolean·`localStorage` 접근 예외 → 기본값, throw 금지.
- 테스트 파일은 `beforeEach(() => window.localStorage.clear())` 필수(이 저장소의 localStorage 누수 선례).

### 5.4 느린-스텝 문구 (`InsightPanel.tsx` `message()`)

`slowest_step` arm(`:42-43`)을 격차·배수 진술로 교체한다. 표시 규칙:

- 격차 `= value - runner_up_ms`는 **항상** 표시.
- 배수 `= value / runner_up_ms`는 **`runner_up_ms > 0`일 때만** 덧붙인다. `0`이면 JS에서 `Infinity`가 되어 "Infinity배"가 렌더되므로 구조적으로 막아야 한다.
- `runner_up_ms`가 부재(구식 리포트)면 현행 문구로 폴백한다.

문구는 `ko.ts` 경유(ADR-0035). `message()`의 다른 arm에 남아 있는 선재 인라인 리터럴은 이번 범위 밖(§10-B).

## 6. 문구 변경 (`ui/src/i18n/ko.ts`)

| 키 | 변경 |
|---|---|
| `ko.insightActions.slowest_step` | `"이 API가 병목입니다 — 스텝 표를 내보내 개발팀과 공유하세요."` → **`"다른 스텝보다 뚜렷하게 느립니다 — 스텝 표를 내보내 개발팀과 공유하세요."`** (인과 주장 제거, D9) |
| `ko.narrative.can.bottleneck_step` | `"상대적으로 느린(병목) 스텝을 식별할 수 있습니다"` → **`"상대적으로 느린 스텝을 식별할 수 있습니다"`** |
| `ko.narrative.eventsHeading` | **삭제** (§4.3) |
| `ko.narrative.event` (14키 블록) | **삭제** (§4.3) |
| `ko.report.insightActionsToggle` | **신규** — `"조치 안내 보기"` |
| `ko.validity.detailsToggle` | **신규** — `"자세히"` (접기 버튼 가시 텍스트) |
| `ko.insight.slowestStep` | **신규** — 격차(+선택 배수) 문구 빌더 |

**신규 4문구는 기존 카탈로그 전체와 양방향 부분문자열 대조를 거쳐야 한다.** 이 저장소는 신규↔신규만 대조하고 신규↔기존을 빠뜨려 `toHaveTextContent`(부분문자열 매칭) 단언이 엉뚱한 분기에서 통과한 전례가 있다. 특히 `"자세히"`는 짧아 충돌 위험이 높다 — plan 단계에서 `grep -n '"[^"]*자세히' ui/src/i18n/ko.ts`로 실측할 것.

조사는 병기형(`(으)로`/`(이)가`) — 변수 뒤 조사 고정 금지(ADR-0035).

## 7. 와이어 계약

| 항목 | 변경 | 하위호환 |
|---|---|---|
| `Insight.runner_up_ms` | 가산(`Option<f64>`, `skip_serializing_if`) | 구식 소비자 무영향. UI는 `.optional()` + 부재 시 폴백 문구(§5.4) |
| `Narrative.events` | **제거** | 리포트는 매 요청 `build_report`로 fresh 생성되고 저장 리포트가 없으므로 과거 run 재조회도 안전. **실측 확인**: `report.rs:44-46`이 `#[serde(default)]`라 필드 부재 역직렬화가 성립하고, `crates/controller/src`에 `deny_unknown_fields` 0건이며, `testdata/compare_golden.json`의 report 객체엔 `narrative`/`validity` 키 **자체가 없다**(키 = `if_breakdown`/`run`/`scenario_yaml`/`status_distribution`/`steps`/`summary`/`windows`) — 골든 파싱은 어느 방향으로도 안 깨진다 |
| XLSX Summary row 9 | 제거 | Summary 시트 마지막 행 — 위 행 인덱스 불변 |
| `INSIGHT_COLUMNS` | 15 → 16열 | export 열 추가는 선례 있음(사이징 3열). `insight_columns_are_single_source`가 락인 |
| migration / proto / store | **0-diff** | 인사이트·내러티브는 `build_report` 파생물이라 영속 스키마 무관 |

## 8. 테스트 계획

### 8.1 서버 단위 (`insights.rs`)

게이트 경계는 **양쪽**을 잠근다 — 통과 케이스만 있으면 게이트를 지워도 green이다.

| 케이스 | 입력(p95) | 기대 |
|---|---|---|
| 발행 | `[210, 50, 45]` | `slowest_step` 있음, `value=210`, `runner_up_ms=50` |
| 격차 미달 | `[3, 2, 1]` | 미발행 (US4 원문 케이스) |
| 배수 미달 | `[210, 190, 180]` | 미발행 (격차 20 ✓ / 배수 1.105 ✗) |
| 격차 경계 정확 | `[20, 0]` | 발행 — 격차 20 == 하한, 배수는 `runner_up=0` 곱셈 형태로 참 |
| 격차 경계 −1 | `[19, 0]` | 미발행 |
| 배수 경계 정확 | `[90, 60]` | 발행 — 격차 30 ✓, `90 >= 1.5*60` ✓ |
| 배수 경계 −1 | `[89, 60]` | 미발행 — `89 < 90` |
| 스텝 1개 | `[500]` | 미발행 (2위 부재) |
| 스텝 0개 | `[]` | 미발행 (기존 `no_data_run_flags_unconditional_steps`가 이미 커버) |
| 0-나눗셈 회귀 | `[300, 0]` | 발행 + **패닉/NaN/Infinity 없음** |

**게이트 도입으로 RED가 되는 기존 테스트 5건** (구현 전 실제 계산으로 확인 — 구현자가 원인을 헤매지 않도록 명시):

| 테스트 | 현재 픽스처 | 게이트 적용 결과 | 필요한 조치 |
|---|---|---|---|
| `slowest_step_picks_max_p95` (`:624-642`) | p95 `[50, 120, 90]` | top=120·2위=90 → 격차 30 ✓, `120 >= 1.5*90 = 135` **✗** → 미발행 | 픽스처를 발행되는 값으로(예 `[50, 210, 90]`) |
| `slowest_step_first_on_tie` (`:884-901`) | `[100, 100]` | 격차 0 → 미발행 | "동률이면 첫 스텝" 불변식은 **top 동률 + 3위와 격차 확보** 형태로 재구성(예 `[120, 120, 40]`) |
| `insights_deterministic_order` (`:818-844`) | 스텝 1개(`step_err("a", 50)`) | 2위 부재 → 미발행 → 기대 배열의 `("slowest_step", None)` 항이 남아 불일치 | 스텝을 2개 이상으로 늘려 발행시키거나, 기대 배열에서 해당 항 제거 — **둘 중 무엇을 택하든 순서 락인 의도(rank 8 자리)는 보존할 것** |
| `all_pass_run_has_slowest_and_slo_pass` (`:862-881`) | 스텝 1개(`step("a", 80)`) | 미발행 → `kinds == ["slowest_step", "slo_pass"]` 불일치 | 테스트 의도가 "clean run은 3개로 패딩하지 않는다"이므로 **스텝 2개로 늘려 발행 유지**가 의도 보존에 가깝다 |
| `error_heavy_run_yields_at_least_three` (`:846-859`) | 스텝 1개 + dist `{200:800, 500:200}` | 발행되던 인사이트 3개(slowest/error_hotspot/status_class 5xx) 중 하나가 사라져 **2 < 3** → 단언 실패 | 스텝을 2개로 늘려 3개 유지. **단언 수를 3→2로 낮추지 말 것** — "에러 많은 run은 신호를 3개 이상 낸다"는 능력 검사가 이 테스트의 존재 이유다 |

이 5건은 **의도가 살아 있는 테스트**다. 게이트를 통과시키려고 단언을 약화(개수 하향·항목 삭제)하는 방향이 아니라 **픽스처를 현실적인 값으로 올리는** 방향으로 고친다.

### 8.2 서버 단위 (`validity.rs`)

- `bottleneck_step`이 `slowest_step` 부재 시 안 붙는지(게이트 연동).
- events 관련 3테스트 삭제 후 나머지 골든(`golden_*`)이 그대로 green.

### 8.3 export (`export.rs`)

- `insight_columns_are_single_source`가 16열로 갱신되고 CSV 헤더와 정확 일치.
- `runner_up_ms`가 있는 인사이트/없는 인사이트 각각 CSV 셀·XLSX 셀(빈 셀은 `None | Some(Data::Empty)` 양쪽 허용 — 기존 관행).
- Summary 시트에 `narrative_events_count` 행이 **없음**.

### 8.4 UI (RTL)

| 대상 | 단언 |
|---|---|
| 병합 블록 `ok` | 이유 `<ul>` 부재 + 상세 접힘 + 토글 버튼 존재 |
| 병합 블록 `suspect` | 상세 **펼침**(can/cannot 텍스트 존재) |
| 병합 블록 구식 리포트 | `validity` 부재 → 블록 미렌더 (가짜 ok 금지) |
| `NarrativeBlock` 소멸 | 살아있는 블록이 **정확히 1개**임을 단언 — 은퇴 리터럴 부재로 쓰지 말 것(grep-0 불변식과 충돌하는 선례) |
| 조치문 토글 off(기본) | `ko.insightActions.*` 문구 부재 **그리고** `ko.saturation.*` 권장치 **존재**(US3 — 두 단언이 같이 있어야 D7이 증명된다) |
| 조치문 토글 on | 일반 안내 복귀 |
| 영속 | 토글 후 재마운트 시 유지 + localStorage malformed → 기본값(no-throw) |
| 느린-스텝 문구 | `runner_up_ms > 0` → 격차+배수 / `runner_up_ms === 0` → 격차만, **`"Infinity"` 문자열 부재 단언** |

**이빨 실증 의무**: 위 테스트 중 회귀 가드를 표방하는 것(게이트 경계 7건, 토글 off의 이중 단언, Infinity 가드)은 **고의 회귀 주입 → RED 확인 → 원복 → GREEN**을 실행해 증명한다. 특히 다음 두 개는 공허해지기 쉬우니 주의:

- **`ko.*` 보간 문구를 기대값으로 쓰는 단언은 자기참조**다 — 렌더와 기대가 같은 함수를 부르므로 카피 변이가 양쪽을 똑같이 바꿔 통과한다. 느린-스텝 문구 단언은 **렌더된 숫자**(`"160"`, `"4.2"`)를 별도로 확인한다.
- **토글 off에서 "일반 안내 부재"만 단언하면 공허**하다 — 조치문 렌더를 통째로 지워도 통과한다. 반드시 `ko.saturation.*` 존재 단언과 **짝**으로 둔다.

## 9. 라이브 검증 (US 척추)

두 종류 run이 필요하다 — 격차 없는 run과 격차 큰 run. `live-verify` 스킬의 responder에 **스텝별 지연 분기**를 주어 한 시나리오로 만든다(예: `/fast` 즉시 응답, `/slow` 200ms sleep).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | `/fast` 3스텝 + status assert + SLO 기준 → run → 리포트 | 유효성 블록이 **한 줄**(상세 접힘), `주요 사건` 텍스트 **부재**, 빈 Callout 본문 없음 |
| US1' | assert·SLO 제거한 시나리오로 같은 run → `limited` | 이유 줄은 보이고 can/cannot은 **접힘**. `suspect` run(전 스텝 connection-refused)은 **펼침** |
| US2 | 토글 on → 다른 run 상세로 이동 → 재확인 | 두 번째 리포트에서도 안내 표시 유지(localStorage) |
| US3 | open-loop `target_rps` 과대 + `max_in_flight` 소량 → `dropped > 0` | **토글 off 상태에서** 권장 `max_in_flight` 수치·목표/달성 도착률이 화면에 존재 |
| US4-a | `/fast`만 3스텝 (p95 격차 1~2ms) | 느린-스텝 인사이트 **부재** + `report-insights.csv`에 `slowest_step` 행 **부재** + 비교 뷰 매트릭스에도 부재 |
| US4-b | `/fast` 2스텝 + `/slow` 1스텝 | 인사이트 **존재** + 격차·배수 표시 + CSV `runner_up_ms` 열에 2위 값 기록 |

라이브 필수 사유: 리포트 파싱 경로 변경(Zod 2건)이라 S-D 갭에 해당한다 — RTL 픽스처는 서버가 실제로 보내는 형태(필드 omit)를 재현하지 못한다. 또한 **컴포넌트가 마운트되는 모든 진입 화면**에서 확인한다(run 상세 + 비교 뷰).

## 10. 알려진 한계 · 연기

**A. 기여도 기반 진짜 병목 (roadmap §B 신규 항목으로 기록)**

게이트를 걸어도 p95-max는 "어느 스텝을 고치면 총 소요가 줄어드는가"에 답하지 못한다:

- `loop repeat: 10` 안의 p95 50ms 스텝은 반복당 500ms를 쓰고, 단발 210ms 스텝보다 총 소요가 크다. 현 로직은 `repeat`를 보지 않는다.
- `parallel` 분기 안 스텝은 동시 실행이라 형제 분기가 더 느리면 벽시계를 늘리지 않는다(그래서 별도로 `group_latency` = 자식 max가 존재한다, ADR-0033).

정공법은 총 소요(`mean × count`, HDR에서 mean 산출 가능) 기반의 **별개 인사이트 kind**이며, parallel 보정 판단·새 문구·export 열이 함께 온다. 이번에 어설프게 섞으면 지금 고치는 것과 같은 종류의 거짓 주장을 새로 만든다. **연기는 코드 주석이 아니라 로드맵 항목으로 남긴다**(주석 연기는 사라진다).

**B. `InsightPanel.message()`의 선재 인라인 한국어 리터럴** — `slo_failure`/`status_class` 등 arm이 `ko.ts`를 안 거친다(ADR-0035 선재 위반). 이번엔 신규·변경 문구만 카탈로그 경유하고 나머지는 손대지 않는다(diff 확대·카피 드리프트 위험). 별도 정리 후보.

**C. 임계값 상수의 settings 승격** — `TAU_SLOW_GAP_MS`/`TAU_SLOW_RATIO`는 코드 상수다. 같은 파일의 기존 휴리스틱 임계값(`TAU_5XX`/`TAU_LAT`/`TAU_SPAN`)이 모두 상수인 선례를 따랐다. 도그푸딩에서 값이 흔들리면 그때 settings 레지스트리로 올린다.

**D. `production_identity`/`slo_gate` 존치** — 사용자 보류(D4). 접힌 상세 안에 있으므로 밀도 비용은 0줄이다. 도그푸딩 후 재평가.

## 11. 검증 게이트

- `cargo fmt --check` · `cargo clippy -D warnings` · `cargo nextest` (controller 단위 + export 골든)
- `pnpm lint && pnpm test && pnpm build` — `pnpm test`(esbuild)는 TS strict를 못 잡으므로 `build`까지 필수
- 보안 표면 게이트: `finish-slice §0` grep을 **직접 실행**해 판정한다. 본 슬라이스는 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드 파싱·trace/body 뷰어를 건드리지 않을 것으로 **예상**하나, 예상은 게이트가 아니다(선례: "N/A 예상"이라 적힌 slice가 `trace.rs`를 건드려 매치된 적 있음).
- 최종 whole-branch `handicap-reviewer` APPROVE — 특히 서버 게이트 ↔ UI 표시 ↔ export 3표면의 일관성(교차-task 상호작용은 per-task 리뷰가 원리적으로 못 본다).
