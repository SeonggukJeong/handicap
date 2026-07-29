# run 완료 리포트 조언 밀도 축소 + 느린-스텝 인사이트 실질성 (report-advice-noise)

- **날짜**: 2026-07-29 (rev3 — `spec-plan-reviewer` APPROVE-WITH-FIXES의 N1–N5 반영)
- **유형 태그**: `user-path` (주) + `correctness-bug` (US4 — 근거 없는 "병목" 주장 제거)
- **테마**: §A11 속지 않는 오픈 시험 — **3차(사후 표면)**. 1차 `f93544a`, 2차 `1d7e8e4`, 정밀화 `4723e06`.
- **발의**: 사용자 도그푸딩 원문 (2026-07-29)
  > "run 완료 후에 나오는 조언 여러줄이 이미 알만큼 아는 사람한테는 너무 노이즈야. 그리고 인사이트는 가장 느린 API를 알려주는데, 1~2ms 차이로 느려도 그게 문제라고 나오니 현실과는 거리가 있어보여."

## 사용자 스토리 (US)

> **US1**: QA가 부하 run을 끝내고 리포트를 열 때, 매번 반복되는 고정 안내를 건너뛰고 결과 숫자부터 보려 한다 — 성공하면 시험 유효성 `ok`인 run에서 조언 영역이 **0줄**(유효성 블록 자체 미렌더·주요 사건 섹션 소멸)이고, `limited`인 run에서도 이유 줄만 보이고 해석 목록은 **접혀 있는** 것을 본다.

> **US2**: QA가 리포트를 처음 보는 팀원에게 설명할 때, 숨겨둔 일반 안내를 다시 켜려 한다 — 성공하면 인사이트 패널의 토글 한 번으로 모든 `→` 안내가 돌아오고, 그 선택이 **다음 run 리포트에서도 유지**되는 것을 본다.

> **US3**: 운영자가 open-loop run이 목표 부하를 다 못 걸었을 때, 슬롯을 얼마로 올려야 하는지 알아내려 한다 — 성공하면 **일반 안내를 꺼둔 상태에서도** 권장 `max_in_flight` 수치와 목표/달성 도착률이 그대로 보이는 것을 본다.

> **US4**: 운영자가 스텝들이 고만고만하게 빠른 run의 결과를 볼 때, 실제로 손볼 스텝이 있는지 판단하려 한다 — 성공하면 스텝 간 p95 격차가 1~2ms뿐인 run에서 느린-스텝 인사이트가 **아예 안 뜨고**(화면·CSV·XLSX·비교 뷰 전부), 격차가 큰 run에서만 **2위 대비 격차·배수와 함께** 뜨는 것을 본다.

> **rev1의 US1 조정은 철회됐다.** rev1은 `ok` run에서 "0줄 → 접힌 한 줄"로 US1을 바꾸고 `production_identity` 존치(D4)를 근거로 들었으나, 이는 **사용자가 명시적으로 삭제하기로 고른 항목을 되살린 것**이었다 — Q4에서 선택된 "빈 ok 배너" 옵션의 정의가 "이상 없음은 **배너 자체를 안 그린다**"였다. rev2는 승인본 US1(=0줄)을 그대로 복원한다. D4의 "유지"는 `limited`/`suspect` run의 접힌 상세 안에서 성립한다(§10-E에 귀결 기록).

## 1. 문제 (실측)

`RunDetailPage.tsx:237` → `ReportView.tsx:160-164`가 종료 리포트 상단에 네 블록을 세로로 쌓는다:

```
<ValidityBanner />      // Callout: 제목 "시험 유효성" + 이유 <ul>
<NarrativeBlock />      // PageSection: 주요 사건 / 말할 수 있는 것 / 말할 수 없는 것 (각 최대 5)
<VerdictPanel />        // criteria 있을 때만
<InsightPanel />        // 인사이트마다 사실 1줄 + `→` 조치 1줄
```

| # | 결함 | 근거 |
|---|---|---|
| P1 | `level === "ok"`(=이유 0건)이어도 **제목만 있는 빈 Callout**이 렌더된다 | `ValidityBanner.tsx:50-56` — 조기 반환은 `!validity`뿐(`:41`). 로드맵 §A11 회고 6에 잔재로 기록됨 |
| P2 | `주요 사건` 목록은 **같은 화면의 배너·인사이트를 코드로 재진술**한 것 | `validity.rs:178-187` — validity reason마다 `validity:{kind}`, 인사이트마다 `insight_event_code`(`:151-167`)를 push. 고유 정보 0 |
| P3 | 인사이트 `→` 조치문이 **일반 코칭과 계산된 권장치를 구분 없이** 같은 자리에 쌓인다 | `InsightPanel.tsx:60-80 actionFor` — `ko.insightActions`(7종 일반 코칭)와 `ko.saturation.*`(측정값+권장 `max_in_flight`)이 동일 렌더 경로(`:97-105`) |
| P4 | `slowest_step`에 **임계값이 전혀 없다** — 스텝이 1개뿐이거나 격차가 1ms여도 발행되고 문구는 "이 API가 **병목**입니다" | `insights.rs:145-158` + `ko.ts:1215` |

**P4의 파급(정정)**: `validity.rs:232-234`가 `slowest_step` 존재만 보고 `can_claim`에 `bottleneck_step`을 넣는데, 이 블록은 `:222`의 `if validity.level == "ok"` **안**에 있다. 즉 거짓 주장은 `ok` run에 한해 발생한다(`limited`/`suspect`는 애초에 주장하지 않음). 결함은 실재하나 rev1 서술은 이 게이트를 빠뜨렸다. **파생 결론: 게이트가 들어가면 `bottleneck_step`은 `any(kind == "slowest_step")`로 자동 연동되므로 `validity.rs`의 프로덕션 코드 변경은 0이고 §8.2는 순수 테스트 추가다.**

## 2. 범위 / 비범위

**범위**: 종료 리포트 조언 표면의 밀도(P1–P3) + 느린-스텝 인사이트의 발행 조건·문구(P4), 그리고 그 변화가 export 4표면·비교 뷰·내러티브에 일관 전파되는 것.

**비범위** (의도적): §10-A 기여도 기반 진짜 병목 · `production_identity`/`slo_gate` 문구 **삭제**(§3 D4 보류) · `ValidityBadge`(`RunDetailPage.tsx:132`) 및 헤더 배지 혼잡(§A11 회고 6 잔재) · `InsightPanel.message()`의 선재 인라인 리터럴 전반(§10-B) · 임계값 settings 승격(§10-C).

**분해 검토 결과**: 리뷰어가 8a(게이트)/8b(밀도) 분해를 권고했으나 **한 슬라이스 유지**로 결정(사용자, 2026-07-29). 분해 근거였던 "8b 미파악"은 리뷰가 §4.3·§8.4의 사이트를 전수 목록화해 해소됐고, 두 덩어리가 같은 라이브 스택·같은 `ko.ts`·같은 `InsightPanel`·같은 도메인 지식을 쓰므로 나누면 그 비용을 두 번 치른다(thinkboard-defaults 묶음 선례).

## 3. 결정

| id | 결정 | 근거 |
|---|---|---|
| D1 | **잘라내고 + 접는다** | 초보자 보호(A11 테제)를 잃지 않으면서 전문가 피로 제거 |
| D2 | 느린-스텝 자격 = **격차 기준**(절대 격차 ∧ 배수) | 사용자 원문 "1~2ms 차이"를 직접 인코딩. "골고루 느림"을 특정 스텝 문제로 오판하지 않음 |
| D3 | 조치문은 **패널 단위 접이식**(기본 숨김·영속) | 행마다 컨트롤을 달면 시각 노이즈가 되레 늘어남 |
| D4 | 영구 삭제 = **빈 ok 배너(=`ok`면 블록 자체 미렌더) · 주요 사건 섹션** 2건. `production_identity`·`slo_gate` 문구는 **삭제하지 않고** `limited`/`suspect`의 접힌 상세에 유지 | 사용자 Q4 선택 + "추천 외의 항목들은 조금 더 써보면서 생각해볼게" |
| D5 | 게이트는 **서버**, 접기·토글은 **UI** | 인사이트가 export 4표면의 단일 소스(`export.rs:86-105`)이고 `bottleneck_step`이 거기서 파생 — UI에서만 숨기면 화면은 조용한데 export·내러티브는 계속 "병목"이라 말한다 |
| D6 | `narrative.events`는 **서버에서도 제거** | 렌더처가 0이 되면 필드·계산 30줄·ko 14키·XLSX row 9가 유지 사각이 된다. §A13-g는 로드맵상 "지금은 착수하지 않음". YAGNI |
| D7 | 조치문 토글은 **일반 안내에만** — `ko.saturation.*`는 항상 표시 | 권장 `max_in_flight`는 전문가가 유일하게 원하는 조치문이고, `sut` arm은 "슬롯을 늘리지 말라"는 **반대 방향 경고**라 숨기면 위험 |
| D8 | 유효성 배너와 결과 해석을 **한 블록으로 병합** | 둘 다 같은 `validity` 파생인데 상자가 둘이라 그 자체로 "여러 줄"을 만든다 |
| D9 | "병목" 인과 주장 제거, 사실(격차·배수)만 진술 | §10-A가 비범위인 한 "병목"은 증명되지 않은 주장 |
| **D10** | **동률 top은 미발행이 의도된 동작** | §4.1 참조. 리뷰어 대안 (b)"`runner_up`=top보다 작은 것 중 최대"는 **기각** — 똑같이 느린 두 스텝 중 하나를 지목하게 되어 D2 취지를 정면으로 깬다 |

## 4. 서버 변경 (`crates/controller`)

### 4.1 느린-스텝 실질성 게이트 (`insights.rs`)

기존 `TAU_*` 블록(`insights.rs:311-313`) 근처에 상수 2개 추가:

```rust
/// 느린-스텝 인사이트 실질성 게이트 (spec §4.1).
const TAU_SLOW_GAP_MS: u64 = 20;   // 2위 스텝과의 p95 절대 격차 하한
const TAU_SLOW_RATIO: f64 = 1.5;   // 2위 스텝 대비 배수 하한
```

`derive_insights`의 `slowest_step` 블록(`:145-158`)을 교체:

- **top** = p95 최대 스텝 (기존 선정 규칙 유지 — `s.p95_ms > cur.p95_ms` strict라 동률이면 첫 스텝).
- **runner_up** = top을 제외한 나머지 중 p95 **최대**. 나머지가 없으면(스텝 1개) 미발행.
- 발행 조건 (둘 다 참):
  1. `top.p95_ms - runner_up.p95_ms >= TAU_SLOW_GAP_MS`
  2. `top.p95_ms as f64 >= TAU_SLOW_RATIO * runner_up.p95_ms as f64`

**나눗셈 금지가 요건이다.** `top / runner_up`은 `runner_up == 0`(localhost sub-ms에서 흔함)에서 0-나눗셈이다. 곱셈 형태는 `runner_up == 0`일 때 조건 2가 자연히 참이 되어 조건 1이 단독 판정한다(의도된 동작). 조건 1은 `saturating_sub` 또는 f64 연산으로 써서 향후 선정 규칙 변경 시 언더플로 패닉을 막는다.

**D10 — 동률 처리 (명시 결정)**: 동률 top이 둘 이상이면 `runner_up`도 같은 값이라 `gap == 0` → **항상 미발행**이다. 이는 버그가 아니라 D2의 직접 귀결이다 — 두 스텝이 똑같이 느리면 그중 하나를 "가장 느린 스텝"으로 지목하는 것 자체가 오도다. **파생: 기존 "동률이면 첫 스텝" 불변식은 `derive_insights` 출력으로 관측 불가가 된다**(동률은 출력이 없으므로). 그 테스트는 §8.1대로 **"동률 → 미발행"이라는 새 불변식**으로 재설정한다. 헬퍼 추출은 하지 않는다(관측 불가가 된 옛 불변식을 유지할 이유가 없다).

발행 시 필드: 기존 `step_id`/`metric="p95_ms"`/`value=top.p95_ms` + 신규 `runner_up_ms = Some(runner_up.p95_ms as f64)`.

`order_rank`(`:75-88`)의 `("slowest_step", _) => 8`은 무변경.

### 4.2 `Insight`에 `runner_up_ms` 가산

`insights.rs`의 `Insight` 구조체 **맨 끝**에 추가한다 — `export.rs:87-88` 주석이 "구조체 필드 순서와 일치"를 계약으로 못박으므로 중간 삽입 금지:

```rust
/// 2위 스텝의 p95(ms) — `slowest_step`에서만 Some. UI가 격차·배수를 로직 복제 없이 표시.
#[serde(skip_serializing_if = "Option::is_none")]
pub runner_up_ms: Option<f64>,
```

**`runner_up_ms: None`이 필요한 사이트 전수** (컴파일러가 잡지만 목록은 완전해야 한다 — prost-exhaustive 계열에서 반복해 데인 클래스):

| 사이트 | 형태 |
|---|---|
| `insights.rs:50-70` `Insight::new` | 완전 리터럴 |
| `validity.rs:284-302` 테스트 헬퍼 `insight()` | 완전 리터럴 |
| `export.rs:780` | 완전 리터럴 |
| `export.rs:801` | 완전 리터럴 |
| `export.rs:1038` 테스트 헬퍼 `insight()` | 완전 리터럴 |

`export.rs:1060`·`:1103`·`:1108`·`:1146`은 `..insight(…)` **spread**라 무영향(실측 확인).

**UI가 자체 계산하지 않고 와이어로 받는 이유**: 발행 여부는 서버가 (격차, 배수)로 판정하는데 UI가 2위를 독립 계산해 배수를 표시하면, 향후 서버의 2위 정의가 바뀔 때 화면 숫자가 발행 근거와 조용히 어긋난다("사전 권장 == 사후 인사이트 parity" 계열 드리프트).

### 4.3 `narrative.events` 제거 — 파급 전수

| # | 사이트 | 조치 | 실패 양상 |
|---|---|---|---|
| 1 | `validity.rs:33-38` `Narrative` 구조체 | `events: Vec<String>` 필드 삭제 | — |
| 2 | `validity.rs:151-167` `insight_event_code` | 함수 전체 삭제 | dead_code(`-D warnings`) |
| 3 | `validity.rs:177-187` events 계산 블록 | 삭제. `push_unique`는 can/cannot에서 계속 쓰므로 **존치**, `insights` 파라미터도 `:222-235`가 쓰므로 **존치** | — |
| 4 | `validity.rs:253-257` 반환 리터럴 | `events,` 줄 삭제 | 컴파일 에러 |
| 5 | `validity.rs:566-620` events 테스트 3건 | 삭제 (`events_validity_first_then_insights_max_5`·`events_dedup_multiple_no_request_step`·`events_status_class_codes`) | 컴파일 에러 |
| 6 | `validity.rs:744-751` `default_validity_is_ok_empty` | `n.events.is_empty()` 항 제거 | 컴파일 에러 |
| 7 | `export.rs:471-473` XLSX Summary row 9 | 삭제. row 9는 Summary 시트 **마지막** 행(다음은 Steps 시트 `:475-`)이라 인덱스 시프트 없음 | — |
| 8 | `export.rs:736-745` 테스트 내 `Narrative { events: vec![…], … }` | 리터럴에서 `events` 제거 | 컴파일 에러 |
| 9 | `export.rs:705-` `xlsx_summary_includes_validity_narrative_rows` | row 9 단언 제거 + 테스트명 `..._includes_validity_rows`로 정정 | — |
| 10 | `report.rs:2322-2327` — `assert!(rep.narrative.events.iter().any(…))` **단 하나** | 그 블록만 제거 | 컴파일 에러 |
| 10' | `report.rs:2329`·`:2335`·`:2357`·`:2363`·`:2383` | **무변경** — 전부 `can_claim`/`cannot_claim` 단언이고 D4가 "무변경"으로 못박은 `production_identity`/`sut_capacity`/`throughput_measured`/`functional_correctness` 골든이다. **실측: `.events`는 `report.rs` 전체에 정확히 1회(`:2324`)뿐** — rev2 표의 5-사이트 인용은 과대였고 그대로 따르면 건강한 단언 4개를 재작성하게 된다 | — |
| 11 | `ui/src/api/schemas.ts:419-423` `NarrativeSchema` | `events` 제거 | — |
| 12 | `ui/src/components/report/__tests__/NarrativeBlock.test.tsx` | **파일 삭제** (컴포넌트가 사라짐) | — |
| 13 | `ui/src/components/report/__tests__/ReportView.test.tsx` | narrative 픽스처 `events` 제거 + **`:392`가 참조하는 `ko.narrative.sectionAria`가 삭제되므로**(§6) 그 순서 테스트를 병합 후 구조로 재작성(→ §8.5 병합 불변식) | tsc 초과 속성 + 미해결 참조 |
| 14 | `ui/src/api/__tests__/schemas.test.ts` | 픽스처 `events` + `parsed.narrative?.events` 단언 제거 | tsc |
| 15 | `ui/src/pages/__tests__/RunDetailPage.test.tsx` | 픽스처 `events` 제거 | tsc |
| 16 | `ui/src/i18n/ko.ts` | `narrative.eventsHeading` + `narrative.event`(14키) + `narrative.sectionAria` 삭제(§6) | — |

`can_claim`/`cannot_claim` 로직·순서·`truncate(5)`·`production_identity` cap-replace(`:241-251`)는 **무변경**(D4).

### 4.4 export (`export.rs`)

- `INSIGHT_COLUMNS`를 `[&str; 15]` → `[&str; 16]`, 맨 끝에 `"runner_up_ms"`(`:89-105`).
- `insight_csv_cells`(`:108-128`) 끝에 `f(ins.runner_up_ms)` 1줄.
- `write_insight_xlsx_row`(`:132-`) 끝에 기존 블록과 **동일 형태**로:
  ```rust
  if let Some(v) = ins.runner_up_ms {
      ws.write_number(row, c(15), v).expect("w");
  }
  ```
  (rev1은 `.expect("w");`를 빠뜨려 `Result`가 블록 값이 되는 타입 에러 + `#[must_use]` → `-D warnings`였다.)
- 공유 writer라 이 두 곳이 단일/비교 × CSV/XLSX **4표면에 동시 반영**된다.
- 주석 갱신(같은 커밋): `export.rs:86-88`·`:107`·`:130-131`의 "15열"/"15개 셀" → 16, `:459`·`:706`의 "rows 7–9" → 7–8.
- **`crates/controller/CLAUDE.md`의 `INSIGHT_COLUMNS: [&str;13]` 표기는 현 시점에도 stale(실제 15)이다 — 이 슬라이스에서 16으로 정정**한다(문서 드리프트를 이번에 닫는다).

### 4.5 UI Zod

- `schemas.ts:380-397` `InsightSchema`에 `runner_up_ms: z.number().optional()` — Rust가 `skip_serializing_if`라 **omit**이지 null이 아니다(`:392` 주석이 이 규칙 명시).
- `schemas.ts:419-423` `NarrativeSchema`에서 `events` 제거.

## 5. UI 변경 (`ui/src`)

### 5.1 유효성·해석 병합 블록

`NarrativeBlock.tsx`를 삭제하고 그 내용을 `ValidityBanner`의 접이식 상세로 흡수한다. 파일·컴포넌트명은 `ValidityBanner` 유지.

**prop 계약 (M2)**:

```ts
export function ValidityBanner({
  validity,
  narrative,
}: {
  validity?: Validity | null;
  narrative?: Narrative | null;
})
```

`ReportView`가 둘 다 넘긴다. 렌더 규칙:

| 조건 | 동작 |
|---|---|
| `!validity` (구식 리포트: 키 부재) | `return null` — **가짜 ok 렌더 금지**(A11 D11) |
| `validity.level === "ok"` | `return null` — **US1의 0줄**(D4) |
| `limited` / `suspect` | 이유 `<ul>` 표시(현행 유지) + 상세 토글 |
| `narrative == null` 또는 can/cannot 둘 다 빈 배열 | **토글 자체 미렌더** — 열 것이 없는 토글은 노이즈 |
| `suspect` | 상세 **기본 펼침** |
| `limited` | 상세 **기본 접힘** |

- **`ok`면 `reasons` 유무와 무관하게 미렌더** — level 검사가 먼저 단락시킨다. `level === "ok"` ⟺ `reasons.length === 0`은 서버 불변식(`validity.rs:131-137`)이 보장하므로 정상 페이로드에선 차이가 없고, 그 불변식이 깨진 페이로드(`ok` + reasons 존재)는 이유가 **조용히 삼켜진다**(수용 — 서버가 유일한 생산자다). rev2의 "UI가 `reasons.length > 0`으로 게이트하므로 안 깨진다"는 근거는 `ok → return null` 도입으로 무효가 됐다.
- **접힘 구현 = 조건부 미렌더**(`{open && <상세/>}`, `hidden` 속성 아님). 이 저장소의 disclosure 이디엄(`ScenarioSnapshot`·`InspectorSection`)과 일치하며, §8.5의 "`canHeading` 정확히 1개" 단언이 **펼친 상태를 전제**한다는 뜻이기도 하다(접힘 상태에선 0개가 정상).
- **토글 DOM 위치 (M3)**: 이유 `<ul>` **아래**, `Callout`의 `children` 안. `Callout.title`(`:30`에서 `<p>`로 감싸짐) 내부에 넣지 않는다 — `ok`가 미렌더가 되어 "한 줄" 제약이 사라졌으므로 `Callout` 내부 구조에 의존할 이유가 없다.
- **토글은 가시 텍스트를 가진 `<button aria-expanded>`이고 `aria-label`을 붙이지 않는다.** 가시 텍스트 = `ko.narrative.title`("결과 해석") + caret. `aria-label`을 붙이면 접근명이 가시 텍스트를 덮어써 WCAG 2.5.3(Label in Name) 위반이며 이 저장소가 이미 두 번 적발한 클래스다.
- **접힘 상태는 영속하지 않는다** — level에서 매번 도출. 영속시키면 사용자가 `suspect` 경고를 영구히 숨길 수 있다(A11 테제 위반). §5.3의 조치문 토글은 영속하는데 이쪽은 안 하는 **비대칭은 의도적**이며 근거가 다르다(경고 은닉 위험 vs 개인 취향).
- `Callout`의 `variant`(`LEVEL_VARIANT`)·`role="region"`·`aria-label={ko.validity.bannerAria}`는 **무변경**.

`ReportView.tsx:160-164`는 `ValidityBanner → VerdictPanel → InsightPanel`이 된다(`NarrativeBlock` 줄 삭제). `:160`의 A11 주석과 `ui/CLAUDE.md`의 "ReportView order MUST be Banner→Narrative→Verdict→Insight" 노트를 **같은 커밋에서** 갱신한다(문서화된 불변식의 의도적 변경).

### 5.2 인사이트 조치문 토글 (`InsightPanel.tsx`)

- `actionFor`(`:60-80`) 반환을 `string | undefined` → `{ text: string; computed: boolean } | undefined`.
  - `computed: true` = `ko.saturation.slots`(+`slotsAtCap`) / `ko.saturation.sut`.
  - `computed: false` = `ko.insightActions.*` 전부. `load_gen_saturated`의 폴백 2경로(`:74` 신규 필드 부재, `:77` cause None)도 `ko.insightActions` 출처이므로 `false`.
- 렌더(`:97-105`): `computed`면 무조건 표시, 아니면 `showGeneric`일 때만.
- 토글 컨트롤: `PageSection` 제목 아래 **첫 자식**으로 우측 정렬 `<input type="checkbox">` + `<label>{ko.report.insightActionsToggle}</label>`. **`PageSection`의 `title`(=`<h3>`) 안에 넣지 않는다** — heading 안 대화형 요소 금지(근거: `ui/CLAUDE.md` HelpTip 항목의 "ⓘ 버튼을 `<h3>`/`<legend>` *안*에 넣지 말 것". rev1은 이 규범의 출처를 `ui/src/components/ui/CLAUDE.md` U3로 잘못 지목했다 — 그 U3는 `<label htmlFor>` 케이스다). 라벨이 접근명을 주므로 `aria-label` 불요.
- 인사이트 0건이면 패널이 `null`(`:83`)이라 토글도 안 뜬다 — 무변경.

### 5.3 조치문 표시 설정 영속

`editorPrefs`(`ui/src/scenario/editorPrefs.ts:14`, 키 `handicap:editor:inspector-sections:v1`)와 동형의 fail-soft 모듈:

- 키 `handicap:report:insight-actions:v1`, 값 `boolean`, **기본값 `false`(숨김)**.
- malformed·비-boolean·`localStorage` 접근 예외 → 기본값, throw 금지.
- 테스트 파일은 `beforeEach(() => window.localStorage.clear())` 필수(이 저장소 localStorage 누수 선례).

### 5.4 느린-스텝 문구 (`InsightPanel.tsx` `message()`)

`slowest_step` arm(`:42-43`)을 격차·배수 진술로 교체:

- 격차 `value - runner_up_ms`는 **항상** 표시.
- 배수 `value / runner_up_ms`는 **`runner_up_ms > 0`일 때만**. `0`이면 JS에서 `Infinity`가 되어 "Infinity배"가 렌더된다.
- `runner_up_ms` 부재(구식 리포트) → 현행 문구로 폴백.

문구는 `ko.ts` 경유(ADR-0035). `message()`의 다른 arm에 남은 선재 인라인 리터럴은 범위 밖(§10-B).

## 6. 문구 변경 (`ui/src/i18n/ko.ts`)

**신규 2 · 변경 2 · 삭제 17키.**

| 키 | 변경 |
|---|---|
| `ko.insightActions.slowest_step` | **변경** — `"이 API가 병목입니다 — …"` → `"다른 스텝보다 뚜렷하게 느립니다 — 스텝 표를 내보내 개발팀과 공유하세요."` (인과 주장 제거, D9) |
| `ko.narrative.can.bottleneck_step` | **변경** — `"상대적으로 느린(병목) 스텝을 …"` → `"상대적으로 느린 스텝을 식별할 수 있습니다"` |
| `ko.narrative.eventsHeading` | **삭제** |
| `ko.narrative.event` (14키) | **삭제** |
| `ko.narrative.sectionAria` | **삭제** — 병합 후 별도 region이 아니다(`Callout`의 `role="region" aria-label=시험 유효성` 안에 들어간다) |
| `ko.narrative.title` | **존치** — 상세 토글의 가시 텍스트로 재사용("결과 해석") |
| `ko.narrative.canHeading` / `cannotHeading` | **존치** — 상세 내부 h4 소제목 |
| `ko.report.insightActionsToggle` | **신규** — `"조치 안내 보기"` |
| `ko.report.slowestStep` | **신규** — 격차(+선택 배수) 문구 빌더 |

- **네임스페이스**: 신규 문구 빌더는 `ko.report.*`에 둔다. `ko.insight*` 접두는 이미 `insightCompare`(`:1195`)·`insightLabels`(`:1203`)·`insightActions`(`:1214`) 셋이 있어 `ko.insight`를 새로 만들면 오참조 위험이 크다.
- **부분문자열 충돌 스윕**: 신규 2문구를 기존 카탈로그 **전체**와 양방향 대조한다. 이 저장소는 신규↔신규만 대조하고 신규↔기존을 빠뜨려 `toHaveTextContent`(부분문자열 매칭) 단언이 엉뚱한 분기에서 통과한 전례가 있다. (사전 실측: `"조치"`·`"자세히"`는 `ui/src` 전체 0매치 — 현 시점 충돌 없음. plan 단계에서 최종 문구로 재실행할 것.)
- 조사는 병기형(`(으)로`/`(이)가`) — 변수 뒤 조사 고정 금지(ADR-0035).

## 7. 와이어 계약

| 항목 | 변경 | 하위호환 |
|---|---|---|
| `Insight.runner_up_ms` | 가산(`Option<f64>`, `skip_serializing_if`) | 구식 소비자 무영향. UI `.optional()` + 부재 시 폴백(§5.4) |
| `Narrative.events` | **제거** | 리포트는 매 요청 `build_report`로 fresh 생성(저장 리포트 없음). **실측 확인**: `report.rs:42-46`이 `#[serde(default)]`, `crates/controller/src`에 `deny_unknown_fields` **0건**, `testdata/compare_golden.json`의 report 객체엔 `narrative`/`validity` 키 **자체가 없다**(키 = `if_breakdown`/`run`/`scenario_yaml`/`status_distribution`/`steps`/`summary`/`windows`) — 골든 파싱은 어느 방향으로도 안 깨진다 |
| XLSX Summary row 9 | 제거 | Summary 시트 마지막 행 — 위 행 인덱스 불변 |
| `INSIGHT_COLUMNS` | 15 → 16열 | 선례 있음(사이징 3열). `insight_columns_are_single_source`가 락인 |
| migration / proto / store | **0-diff** | 인사이트·내러티브는 `build_report` 파생물 |

## 8. 테스트 계획

### 8.1 서버 — 게이트 경계 (`insights.rs` 신규)

경계는 **양쪽**을 잠근다(통과 케이스만 있으면 게이트를 지워도 green).

| 케이스 | p95 | 판정 | 기대 |
|---|---|---|---|
| 발행 | `[210, 50, 45]` | 격차 160≥20 ✓ · 210≥75 ✓ | 발행, `value=210`, `runner_up_ms=50` |
| 격차 미달 | `[3, 2, 1]` | 1<20 ✗ | 미발행 (US4 원문 케이스) |
| 배수 미달 | `[210, 190, 180]` | 20≥20 ✓ · 210<285 ✗ | 미발행 |
| 격차 경계 정확 | `[20, 0]` | 20≥20 ✓ · 20≥0 ✓ | 발행 |
| 격차 경계 −1 | `[19, 0]` | 19<20 ✗ | 미발행 |
| 배수 경계 정확 | `[90, 60]` | 30≥20 ✓ · 90≥90 ✓ | 발행 |
| 배수 경계 −1 | `[89, 60]` | 29≥20 ✓ · 89<90 ✗ | 미발행 |
| **D10 판별자** | `[120, 120, 40]` | 격차 0 ✗ | **미발행** |
| 스텝 1개 | `[500]` | 2위 부재 | 미발행 |
| 0-나눗셈 회귀 | `[300, 0]` | — | 발행 + **패닉/NaN/Infinity 없음** |

> **`[120,120,40]` 행은 생략 금지 — D10을 검증하는 유일한 픽스처다.** 기각안 (b)(`runner_up = max{p95 : p95 < top}`)로 구현하면 나머지 14개 픽스처가 **전부 GREEN**이라 두 구현이 구별되지 않는다(§8.2 row 2의 `[100,100]`도 (b)에선 "2위 부재"로 미발행이라 결과가 같다). 이 픽스처만 갈린다: (a) `runner_up=120` → 격차 0 → 미발행 / (b) `runner_up=40` → 격차 80·`120≥60` → **발행**. rev1이 실제로 (b) 방향으로 미끄러졌던 전례가 있으므로 이론적 위험이 아니다. `[100,100]`(§8.2)과 **병존**시킬 것 — 그건 "동률"이 아니라 "2위 부재"와 구별이 안 된다.
>
> **구현 주의**: `runner_up`은 **top을 인덱스로 제외**한 나머지의 최대다(값으로 제외하면 (b)가 된다).

### 8.2 서버 — 게이트 도입으로 RED가 되는 **기존** 테스트 6건

전수 확인 결과 아래 6건이 전부다(`error_hotspot_picks_top_error_share`(`:579`)·`no_error_hotspot_when_zero_errors`(`:606`)는 slowest_step을 단언하지 않아 GREEN 유지, saturation 테스트군(`:1017-1419`)은 `steps=&[]`라 무관).

> **주의**: 테스트 헬퍼 `step_err(id, errors)`(`insights.rs:573-577`)는 **p95를 10으로 하드코딩**한다. "스텝을 2개로 늘려라"를 문자 그대로 따르면 `[10,10]` → 격차 0 → 여전히 RED다. 아래 표는 **구체 p95 값**을 지정한다.

| 테스트 | 현재 | 왜 RED | 복구 픽스처 (검산) |
|---|---|---|---|
| `slowest_step_picks_max_p95` (`:624-642`) | `[50, 120, 90]` | 120 < 1.5×90=135 | `[step("a",50), step("b",210), step("c",90)]` → 격차 120 ✓ · 210≥135 ✓ · `step_id="b"`·`runner_up_ms=90`. **`:641`의 `assert_eq!(got[0].value, Some(120.0))`도 `Some(210.0)`으로 갱신** |
| `slowest_step_first_on_tie` (`:884-901`) | `[100, 100]` | 격차 0 (D10) | **테스트 재설정** — `slowest_step_suppressed_on_tie`로 개명, 같은 픽스처로 **미발행**을 단언. 옛 "첫 스텝" 불변식은 D10에 따라 관측 불가 |
| `insights_deterministic_order` (`:818-844`) | 스텝 1개 `step_err("a",50)`(p95 10) | 2위 부재 | `vec![step_err("a",50), step("b",40)]` → top=b(40)·2위=10 · 격차 30 ✓ · 40≥15 ✓ → 발행 → **기대 배열의 `("slowest_step", None)` rank-8 항을 그대로 보존**(rev1의 "항을 제거해도 된다"는 자기모순이었다 — 제거하면 락인이 사라진다) |
| `all_pass_run_has_slowest_and_slo_pass` (`:862-881`) | 스텝 1개 `step("a",80)` | 2위 부재 | `[step("a",80), step("b",40)]` → 격차 40 ✓ · 80≥60 ✓ · top=a 유지 → `kinds == ["slowest_step","slo_pass"]` 보존 |
| `error_heavy_run_yields_at_least_three` (`:846-859`) | 스텝 1개 `step_err("a",200)` | 인사이트 3→2 | `vec![step_err("a",200), step("b",40)]` → 발행 → 3개 유지. **단언을 3→2로 낮추지 말 것** — "에러 많은 run은 신호 3개 이상"이 이 테스트의 존재 이유 |
| `no_request_step_skipped_on_unparseable_yaml` (`:770-787`) | 스텝 1개 `step("a",10)`, `:786`이 `slowest_step` 존재 단언 | 2위 부재 | `&[step("a",10), step("b",40)]` → 격차 30 ✓ · 40≥15 ✓ → 발행 유지. 의도("YAML 파싱 실패해도 *다른* 인사이트는 산다") 보존 |

이 6건은 **의도가 살아 있는 테스트**다. 게이트를 통과시키려고 단언을 약화(개수 하향·항목 삭제)하지 말고 **픽스처를 현실적인 값으로 올린다**.

### 8.3 서버 — `validity.rs` / `export.rs`

- `bottleneck_step`이 `slowest_step` 부재 시 안 붙는지 — **프로덕션 코드 변경 0, 순수 테스트 추가**(§1 P4 정정).
- events 테스트 3건 삭제 후 나머지 골든(`golden_*`) green.
- `insight_columns_are_single_source`(`:1086-1096`)가 16열로 갱신되고 CSV 헤더와 정확 일치.
- **하드코딩 CSV 헤더 문자열 2건**(컴파일러 미검출 — 테스트 실패로만 발견): `export.rs:1070` `report_insights_csv_header_and_rows`, `export.rs:1123` `comparison_insights_csv_long_format`. 둘 다 끝에 `,runner_up_ms` 추가. 행 단언은 `starts_with`라 무영향.
- XLSX: `runner_up_ms` 열(col 15)에 값 있는 인사이트/없는 인사이트 각각. 빈 셀은 `None | Some(Data::Empty)` 양쪽 허용(기존 관행). 기존 col 13/14 단언(`:858-870`)은 인덱스 기반이라 무영향.
- Summary 시트에 `narrative_events_count` 행 **없음**.

### 8.4 UI — 기본-숨김 전환으로 RED가 되는 **기존** 테스트 4건

rev1이 통째로 빠뜨린 분석이다(`ui/src/components/report/__tests__/InsightPanel.test.tsx`).

| 테스트 | 왜 RED / 공허 | 조치 |
|---|---|---|
| `:37-50` "kind별 다음 행동 줄이 렌더된다" | `/스텝 표를 내보내…/`(`:43`)·`/5xx면 서버 측…/`(`:45`) 둘 다 `computed:false` → 기본 숨김 | 토글 ON 후 단언 |
| `:52-63` "cause 없음 — 폴백 행동 줄" | `ko.insightActions.load_gen_saturated`(§5.2가 `computed:false`로 분류) | 토글 ON 후 단언 |
| `:112-119` "slots — 필드 부재 폴백" | 같은 문구 | 토글 ON 후 단언 |
| `:65-71` `queryByText(/→/)).toBeNull()` | **공허해진다** — 기본 숨김이면 모든 인사이트에서 통과 | **토글 ON 상태**로 다시 세워야 이빨이 남는다 |

### 8.5 UI — 신규

| 대상 | 단언 |
|---|---|
| 병합 블록 `ok` | **미렌더**(US1 0줄) |
| 병합 블록 `limited` | 이유 `<ul>` 존재 + 상세 **접힘** |
| 병합 블록 `suspect` | 상세 **펼침** |
| 구식 리포트(`validity` 부재) | 미렌더 (가짜 ok 금지) |
| `narrative` 부재 / can·cannot 둘 다 빔 | 토글 미렌더 |
| **병합 불변식 (M5)** | **픽스처 = `suspect`(기본 펼침) + `can_claim` 비지 않음** — 접힘은 조건부 미렌더이고 `canHeading`은 `can_claim.length > 0`일 때만 그려지므로(`NarrativeBlock.tsx:29-31` 계승), 둘 중 하나라도 빠지면 0개가 되어 단언이 **공허해진다**. 그 픽스처에서 `getAllByText(ko.narrative.canHeading)`가 **정확히 1개**이고 그것이 유효성 region(`getByRole("region",{name: ko.validity.bannerAria})`) **내부**일 것. 별도 블록이 되살아나면 개수가 2가 되어 깨진다 — "은퇴 리터럴 부재" 대신 "살아있는 라벨 개수"로 표현한 형태 |
| 조치문 토글 off(기본) | `ko.insightActions.*` 부재 **그리고** `ko.saturation.*` 권장치 **존재** — **두 단언이 짝이어야 D7이 증명된다**(부재 단언만 두면 조치문 렌더를 통째로 지워도 통과) |
| 조치문 토글 on | 일반 안내 복귀 |
| 영속 | 토글 후 재마운트 시 유지 + malformed localStorage → 기본값(no-throw) |
| 느린-스텝 문구 | `runner_up_ms > 0` → 격차+배수 / `=== 0` → 격차만 + **`"Infinity"` 문자열 부재** |

**이빨 실증 의무**: 회귀 가드를 표방하는 것(§8.1 경계 10건 — **`[120,120,40]` D10 판별자 포함**, §8.5 병합 불변식·토글 off 이중 단언·Infinity 가드)은 **고의 회귀 주입 → RED → 원복 → GREEN**으로 증명한다. D10 판별자의 주입은 "`runner_up`을 기각안 (b) 방식으로 바꿔 RED 확인 → 원복"이다. 특히:

- **`ko.*` 보간 문구를 기대값으로 쓰는 단언은 자기참조**다(렌더와 기대가 같은 함수를 부름) → 느린-스텝 문구는 **렌더된 숫자**(`"160"`·`"4.2"`)를 별도 확인.
- `toHaveTextContent`는 **부분문자열 매칭**이라 전체일치가 필요하면 `/^…$/`.

## 9. 라이브 검증 (US 척추)

두 종류 run이 필요하다 — 격차 없는 run과 격차 큰 run. `live-verify` responder에 **스텝별 지연 분기**를 준다(`/fast` 즉시, `/slow` 200ms).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | `/fast` 3스텝 + status assert + SLO 기준 → run | 유효성 블록 **미렌더**(0줄), `주요 사건` 텍스트 부재 |
| US1' | assert·SLO 제거 → `limited` / 전 스텝 connection-refused → `suspect` | `limited`=이유 줄 + 상세 접힘 / `suspect`=상세 펼침 |
| US2 | 토글 on → 다른 run 상세로 이동 → 재확인 | 두 번째 리포트에서도 안내 유지(localStorage) |
| US3 | open-loop `target_rps` 과대 + `max_in_flight` 소량 → `dropped>0` | **토글 off 상태에서** 권장 `max_in_flight`·목표/달성 도착률 존재 |
| US4-a | `/fast`만 3스텝 (격차 1~2ms) | 인사이트 부재 + `report-insights.csv`에 `slowest_step` 행 부재 |
| US4-b | `/fast` 2 + `/slow` 1 | 인사이트 존재 + 격차·배수 표시 + CSV `runner_up_ms` 열에 2위 값 |

**마운트 화면 (정정)**: `ValidityBanner`·`InsightPanel`은 `ReportView`에서만 마운트되고 `ReportView`는 `RunDetailPage.tsx:237` **한 곳**이다. 비교 뷰(`ScenarioComparePage.tsx:237`)는 `InsightCompareMatrix`만 쓰므로 **게이트 파급만** 확인 대상이다(병합 블록의 마운트 화면이 아니다). rev1의 "모든 진입 화면(run 상세 + 비교 뷰)"은 부정확했다.

라이브 필수 사유: 리포트 파싱 경로 변경(Zod 2건)이라 S-D 갭에 해당한다 — RTL 픽스처는 서버가 실제로 보내는 형태(필드 omit)를 재현하지 못한다.

## 10. 알려진 한계 · 연기

**A. 기여도 기반 진짜 병목** (roadmap §B 신규 항목으로 기록) — p95-max는 "어느 스텝을 고치면 총 소요가 줄어드는가"에 답하지 못한다: `loop repeat: 10` 안의 p95 50ms 스텝은 반복당 500ms를 쓰고, `parallel` 분기 안 스텝은 형제가 더 느리면 벽시계를 안 늘린다(그래서 별도로 `group_latency`=자식 max가 있다, ADR-0033). 정공법은 총 소요(`mean × count`) 기반의 **별개 인사이트 kind**이며 parallel 보정·새 문구·export 열이 함께 온다. 어설프게 섞으면 지금 고치는 것과 같은 종류의 거짓 주장을 새로 만든다. **연기는 코드 주석이 아니라 로드맵 항목으로 남긴다.**

**B. `InsightPanel.message()`의 선재 인라인 한국어 리터럴** — `slo_failure`/`status_class` 등 arm이 `ko.ts`를 안 거친다(ADR-0035 선재 위반). 신규·변경 문구만 카탈로그 경유하고 나머지는 손대지 않는다(diff 확대·카피 드리프트 위험). 별도 정리 후보.

**C. 임계값 상수의 settings 승격** — `TAU_SLOW_GAP_MS`/`TAU_SLOW_RATIO`는 코드 상수다. 같은 파일의 기존 휴리스틱(`TAU_5XX`/`TAU_LAT`/`TAU_SPAN`)이 모두 상수인 선례를 따랐다. 도그푸딩에서 흔들리면 그때 승격.

**D. "골고루 느림" run은 완전 침묵** — 게이트 후 그런 run은 스텝 레벨 신호가 0개가 되고 "지목할 스텝이 없다"는 **긍정 문구도 없다**. US4가 "아예 안 뜨고"를 요구하므로 사양 위반은 아니나, "지목 불가를 말해주기"는 §10-A와 별개 후보로 기록해 둔다.

**E. `ok` run에서 can/cannot 도달 불가** — D4가 존치시킨 `production_identity`·`slo_gate`는 `ok` run에서 보이지 않는다(블록 자체가 미렌더). 이는 US1(0줄)과 D4(삭제 금지)를 동시에 만족시키는 유일한 지점이다. 도그푸딩 후 `ok`에도 접근 경로가 필요하다고 판단되면 헤더 `ValidityBadge`에 붙이는 방향이 자연스럽다(별도 슬라이스 — 지금은 §A11 회고 4 "배지 확산 기각"과 충돌하므로 신중히).

## 11. 검증 게이트

- `cargo fmt --check` · `cargo clippy -D warnings` · `cargo nextest`
- `pnpm lint && pnpm test && pnpm build` — `pnpm test`(esbuild)는 TS strict를 못 잡으므로 `build`까지 필수
- **보안 표면 게이트**: `finish-slice §0` grep을 **직접 실행**해 판정한다. 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드 파싱·trace/body 뷰어를 안 건드릴 것으로 **예상**하나 예상은 게이트가 아니다(선례: "N/A 예상"이라 적힌 slice가 `trace.rs`를 건드려 매치).
- **plan 작성 시 `tdd-guard` 스텝 순서 시뮬레이션**: `ui/src/i18n/ko.ts`도 watched production(`/ui/src/.+\.(ts|tsx)$`)이다. 각 task의 **첫 스텝이 production 편집이면 트리 clean 상태에서 `exit 2`** — 테스트 파일 편집을 먼저 두어야 한다.
- 최종 whole-branch `handicap-reviewer` APPROVE — 특히 서버 게이트 ↔ UI 표시 ↔ export 3표면의 일관성(교차-task 상호작용은 per-task 리뷰가 원리적으로 못 본다).
