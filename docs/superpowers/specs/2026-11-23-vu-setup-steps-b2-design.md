# 준비 스텝 슬라이스 B2 — 인쇄 본문·내보내기·비교·실행 중 준비 진행 (vu-setup-steps-b2) 설계

- 날짜: 2026-11-23
- 상태: 구현 완료 (코드 `c2e3cfc2`..`e7405fb3`, 라이브 US1–US5 통과). 판단·연기·확인 대기 = roadmap §B89.
- 유형: `user-path`
- 상위 설계: `2026-11-22-vu-setup-steps-design.md` §9(슬라이스 B의 셋째·넷째 줄). B1 = `2026-11-23-vu-setup-steps-b1-design.md`.
- 목업(시각 기준): `2026-11-23-vu-setup-steps-b2-mockups/b2-screens.html` — 사용자 승인 2026-11-23(「목업대로 진행」). 목업과 다르게 가는 곳은 §9에 모았다.
- 관련 결정: ADR-0062(준비 구간), ADR-0030(비교·내보내기 패리티), ADR-0051·0059(실행 중 표시는 기존 1초 폴링에), ADR-0009(라이브 대시보드 비목표).

## 사용자 스토리 (US)

- **US1**: QA가 준비 스텝이 있는 run의 인쇄 보고서를 제출한다 — 성공하면 「단계별 결과」 뒤의 「준비 스텝 결과」 절에 준비 성공·실패 수와 준비 스텝별 요청 수·오류·p50·p95·최대·상태 코드가 화면 리포트와 같은 숫자로 찍힌다. 준비가 실패한 run이면 실패 종류도 찍힌다.
- **US2**: QA가 준비 스텝이 있는 run을 CSV/XLSX로 내보낸다 — 성공하면 XLSX의 「Setup」 시트와 CSV의 준비 구획에 화면 리포트와 같은 준비 숫자가 있다.
- **US3**: QA가 준비 스텝이 있는 run 둘 이상을 비교한다 — 성공하면 화면 비교 표의 「준비 스텝」 묶음에서 준비 성공·실패 수와 준비 스텝별 p95·오류 수를 run별로 나란히 보고, 기준 run과 다른 칸에는 차이 표시가 붙는다. 비교 CSV/XLSX에도 같은 값이 있다. 인쇄 비교 보고서에는 준비 실패 수가 다를 때 그 차이가 한 줄로 찍힌다.
- **US4**: QA가 준비 스텝이 있는 run을 실행해 두고 run 상세 화면을 본다 — 성공하면 실행 중에 준비를 마친 VU 수와 실패한 VU 수가 1초마다 갱신되어 보이고, 실패가 생기면 그 줄이 경고색이 된다. run이 끝나면 그 줄은 사라진다.
- **US5**: QA가 준비 스텝이 없는 run을 인쇄·내보내기·비교·실행한다 — 성공하면 인쇄 쪽 배치, 내보낸 파일의 내용, 비교 표, 실행 중 화면이 지금과 같다.

## 1. 배경

준비 스텝 통계는 A1부터 리포트 JSON의 `setup` 블록(`crates/controller/src/report.rs` `SetupReport { ok, failed, interrupted, steps: [SetupStepReport { step_id, count, errors, p50_ms, p95_ms, max_ms, status_counts, failure_kinds }] }`)에 있고, 화면 리포트의 「준비 스텝」 구획(`ui/src/components/report/SetupSection.tsx`)만 그것을 그린다. 나머지 네 자리는 준비 숫자를 모른다.

지금 코드(2026-11-23, `5e67b335` 기준 — 아래 사실은 §10의 명령으로 확인):

- **인쇄 보고서**(`ui/src/print/`): `buildPrintDoc.ts`가 `report.setup`이 있으면 머리에 안내 한 줄(`meta.setupNote = ko.report.setup.summaryLine`)만 싣는다. `scenarioFacts.ts`는 준비 스텝 사실(`setupSteps`)을 이미 읽고 「대상 시스템」에 쓴다. 본문 블록(`standardBlocks`)에는 준비가 없다. 절 번호는 `ko.print.section`의 고정 글자다(`speed`가 있으면 `chartShifted`·`conditionsShifted`·`glossaryShifted`).
- **내보내기**(`crates/controller/src/export.rs`): `report_to_csv`는 본 스텝 표만, `report_to_xlsx`는 Summary·Steps·Windows·Status(+ 있을 때 Branches·Insights·계단·Other basis) 시트를 쓴다. `setup`을 읽는 코드는 테스트 픽스처의 `setup: None` 하나뿐이다.
- **비교**: 화면은 `ui/src/compare/compareReports.ts`(요약·스텝·상태 세 묶음) + `ui/src/components/compare/CompareMatrix.tsx`. 서버는 `comparison_to_csv`(요약 행렬)·`comparison_to_xlsx`(Summary·Steps·Runs·…). 델타 공식은 `testdata/compare_golden.json`으로 TS↔Rust 패리티를 지킨다. 인쇄 비교(`ui/src/print/compare/`)의 요약 줄은 `headline.ts` `cmpSummaryLines`가 만든다.
- **실행 중 화면**: `GET /api/runs/{id}`(`api/runs.rs` `get`)를 `useRun`이 1초마다 폴링한다. 계단 run은 이 응답에 `auto_stop_live`가 실린다(선례). 워커가 보낸 준비 결과 수는 배치마다 `run_section_outcomes`에 행으로 쌓인다(`store/section.rs`, `run_id` 색인 있음) — 실행 중에도 읽을 수 있다. `RunDetailPage.tsx`에는 준비 표시가 없다.

### 목표가 아닌 것

- 인쇄 **비교** 보고서의 「준비 스텝 비교」 절 — 사용자 결정(2026-11-23): 후속, 필요할 때. 이번에는 요약 한 줄만.
- 인쇄 **요약판**(한 쪽)에 준비 절 — 머리 안내 줄은 지금처럼 남는다.
- 준비 스텝의 1초 시계열, 실행 중 준비 스텝별 응답 시간(상위 설계 §11).
- 인사이트 CSV(`report-insights.csv`·`compare-insights.csv`)에 준비 열.
- 「모니터 가림 문구」·주기 재실행(다음 슬라이스들).

### 하면 안 되는 것

- 준비 숫자를 본 집계(요약·단계별 결과·판정·비교의 요약/스텝 묶음)에 섞는 것(ADR-0062 D7).
- 준비가 없는 run의 인쇄 쪽 배치·내보낸 파일 바이트·비교 표·run 조회 응답을 바꾸는 것(US5).
- 실행 중 표시를 위해 새 폴링·push를 만드는 것(ADR-0051·0059).
- 실행 중 줄에 추정 분모를 쓰는 것 — 모르면 분모를 쓰지 않는다(working-rules §9).

## 2. 접근

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 이미 있는 `report.setup`을 네 자리가 각자 읽는다. 인쇄·화면 비교는 UI가, 내보내기는 서버 `export.rs`가 `ReportJson.setup`에서 만든다. 실행 중 숫자만 run 조회 응답에 새 키로 싣는다. | 새 집계 0. 화면 리포트와 같은 원천이라 숫자가 어긋날 수 없다. |
| 나 | 준비 스텝을 `report.steps`에 구간 표시와 함께 섞고 각 자리가 걸러 쓴다. | 본 집계를 읽는 모든 소비처가 거르기를 빠뜨릴 수 있다(D7 위반 위험). 기각. |
| 다 | 실행 중 진행을 메트릭 폴링(`/metrics`)에 싣는다. | 그 응답은 초 단위 창 목록이라 run 단위 수치의 자리가 아니다. `auto_stop_live` 선례(run 조회)와 갈라진다. 기각. |

## 3. 인쇄 보고서 — 「준비 스텝 결과」 절 (US1)

표준판에만. `report.setup`이 있을 때만 생긴다.

### 3.1 위치·번호

- 위치: 「단계별 결과」 표와 그 부속(범례·주석 블록) **뒤**, 「단계별 응답 속도 구간」(있으면) **앞**.
- 번호: 「단계별 결과」가 2번이므로 준비 절은 3번이고, 뒤 절이 하나씩 밀린다. 지금의 고정 글자(`chart`/`chartShifted` 짝)로는 준비 × 속도 구간의 네 조합을 못 담으므로 **절 번호를 계산한다**. 계단 표는 번호 없는 제목(`StairPrintTable.tsx`의 h3)이라 번호와 무관하다.
  - `ko.print.section`의 `speed`·`chart`·`conditions`·`glossary`를 `(n: number) => string`으로 바꾸고 `*Shifted` 셋을 지운다. 새 키 `setup: (n) => …`. **`overview`(1)·`steps`(2)는 고정 글자로 둔다**(요약판·`VerdictSection`·`StepCodeTable`이 직접 읽는다).
  - `PrintDoc.sectionNo`(지금 `{chart, conditions, glossary}`)에 `setup`·`speed`를 더한다(없는 절은 `null`). `buildPrintDoc`이 있는 절만 순서(준비 → 속도 구간 → 그림 → 조건 → 용어)대로 3부터 센다.
  - `SpeedBandTable.tsx`의 `SpeedTableTitle`과 표 `aria-label`이 지금 `ko.print.section.speed`를 컴포넌트 안에서 직접 읽는다 — 제목 글자를 prop으로 받게 바꾼다(`doc.sectionNo.speed`).
  - 이 키를 읽는 테스트: `print/__tests__/speedBandTable.test.tsx`, `print/__tests__/PrintDocument.test.tsx`, 그리고 `print/__tests__/buildPrintDoc.test.ts`(속도 구간 있음/없음의 `sectionNo`를 리터럴로 `toEqual` — 「제목 글자 불변」의 기존 가드이므로 지우지 말고 새 키를 더해 확장한다). Rust 쪽 소비처는 없다(`crates/tui/tests/judge_parity_test.rs`는 `ko.monitor.*`만 읽는다). `crates/controller/src/report.rs`의 `speed_bands` doc 주석 「인쇄 보고서 3절」은 「응답 속도 구간 절」로 고친다.
  - 준비가 없는 run의 제목 글자는 지금과 한 글자도 다르지 않아야 한다(테스트: 속도 구간 있음/없음 두 경우의 제목 글자 — 렌더된 `SpeedTableTitle` 포함 — 를 리터럴로 고정).
- 제목: `{n}. 준비 스텝 결과`. 표가 다음 쪽으로 이어지면 기존 표들과 같은 ` (이어짐)`.

### 3.2 블록

`standardBlocks`에 둘을 더한다(쪽 배치는 `paginate` 그대로 — 표는 앞뒤 2행 규칙을 따른다).

| 블록 | 종류 | 내용 |
|---|---|---|
| `setup` | 표(`kind: "table"`) | 제목 + 머리 + 준비 스텝 행. 행이 0개일 수는 없다(준비 스텝이 없으면 `report.setup` 자체가 없다). |
| `setup:kinds` | atomic | 실패 종류 줄(§3.4). 실패 종류가 하나라도 있을 때만. |

요약 줄(§3.3)은 표의 **제목 블록 안**에 그린다. `paginate`는 표마다 `head = titleMm + headerMm`을 한 번 계산해 이어지는 조각에도 같은 값을 쓰고 `Block`에 `titleMm` 칸이 하나뿐이다(`paginate.ts`). 그래서 측정 id는 하나(`setup:title`)이고 그 높이는 `h2` + 요약 줄이다. 제목 컴포넌트(`SetupTableTitle({continued})`)는 `continued`가 아닐 때만 요약 줄을 그린다. 대가: 이어지는 쪽은 요약 줄 높이만큼 자리를 더 잡는다 — 넘치지 않고, 행이 조금 일찍 다음 쪽으로 넘어갈 뿐이다(`paginate`는 고치지 않는다).

새 표 id는 측정 시트와 쪽 렌더 **두 곳 모두**에 배선한다(`ui/CLAUDE.md` 인쇄 절의 함정 — 한쪽만 하면 2절 표로 그려진다).

### 3.3 요약 줄

closed/open은 `deriveLoadMode`(모드 판정의 단일 소스 — 계단·유지 구간 open도 open)로 정한다. 프로필을 읽지 못하면(`ProfileSchema.safeParse` 실패) closed 문구.

`total = ok + failed + interrupted`.

| 경우 | 글 |
|---|---|
| 실패 0·중단 0 | 「가상 사용자 **{ok}명**이 모두 준비를 마쳤습니다.」 |
| 실패 0·중단 > 0 | 「가상 사용자 {total}명 중 **{ok}명**이 준비를 마쳤습니다.」 |
| 실패 > 0 | 「가상 사용자 {total}명 중 **{ok}명**이 준비를 마쳤고 **{failed}명이 실패**했습니다. 실패한 사용자는 본 스텝을 실행하지 않았습니다.」 |
| 중단 > 0이면 그 뒤에 | 「{interrupted}명은 준비 도중 측정이 끝났습니다.」 |
| 항상 끝에 | 「준비 스텝은 사용자마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다.」 |

open-loop는 「가상 사용자 … 명」 대신 「슬롯 … 개」, 「사용자마다」 대신 「슬롯마다」, 「실패한 슬롯은 run에서 빠졌습니다.」. 문구는 `ko.print.setup`에 두고, 보고서 문체로 쓴다(working-rules §8). 숫자는 `fmtCount`.

### 3.4 표

열(본문 폭 180mm): `준비 스텝`(나머지) · `요청 수` 15 · `오류` 13 · `50% 응답 ms` 15 · `95% 응답 ms` 15 · `최대 ms` 15 · `응답 코드별 건수` 36.

- 이름 칸: `{번호} {이름}` + 둘째 줄에 요청 줄(메서드·경로). 이름·요청 줄은 본 스텝 표와 **같은 경로**로 만든다(`scenarioFacts.setupSteps` → 이름 3줄 clamp, 요청 줄은 `middleEllipsis`·기존 가림 규칙 `redact.ts`). 시나리오를 읽지 못하면 이름 자리에 `step_id`.
- 순서 = `report.setup.steps` 순서(= 시나리오의 준비 스텝 순서).
- 오류 > 0인 행은 `p-row--bad` 바탕, 오류 숫자는 `p-bad`. 본 스텝 표는 기준을 넘은 행에만 `p-row--bad`를 쓰고 기준 없는 오류는 `p-row--warn`인데, 준비 스텝에는 기준이 없고 오류 하나가 곧 그 사용자의 탈락이므로 **기준과 상관없이 bad**로 한다(의도된 차이).
- 응답 코드 칸: `코드: 건수`를 ` · `로 잇는다(순서는 코드 오름차순 — `"0"`이 맨 앞). 코드 `"0"`은 인쇄 본 스텝 표가 쓰는 낱말 「응답 없음」(`ko.print.table.none`)을 재사용한다. 칸이 좁아 줄이 바뀌어도 된다(행 높이는 측정).
- 요청 수 0인 준비 스텝(앞 스텝에서 모두 실패)의 응답 시간 칸은 `–`(재지 않은 것을 0으로 찍지 않는다 — 인쇄 절의 기존 규칙).
- 실패 종류 줄(`setup:kinds`): 「실패 종류: {이름} {건수} · …」 — 스텝들의 `failure_kinds`를 종류별로 합친다(화면 `SetupSection`과 같은 합). 이름은 `ko.report.errorKinds.labels`, 표에 없는 글자는 그대로(`Object.hasOwn`).

### 3.5 머리 안내 줄

`meta.setupNote`는 그대로 둔다(요약판은 이것뿐이고, 표준판에서도 첫 쪽에서 「요약·판정에 준비가 들어 있지 않다」를 알린다).

## 4. 내보내기 (US2)

`ReportJson.setup`이 `Some`일 때만. `None`이면 출력 바이트가 지금과 같다(테스트: 기존 픽스처 출력 고정).

기존 시트의 관례를 따른다 — 머리글은 영문 키, 숫자는 숫자 칸.

### 4.1 단일 run XLSX — `Setup` 시트

`Steps` 시트 바로 다음(시트 순서: Summary · Steps · **Setup** · Windows · …).

```
A1 setup_ok           B1 <ok>
A2 setup_failed       B2 <failed>
A3 setup_interrupted  B3 <interrupted>
(빈 행)
A5 step_id | name | count | error_count | p50_ms | p95_ms | max_ms | status_counts
A6… 준비 스텝 행 (status_counts는 "0: 1, 200: 47, 503: 2" — BTreeMap<String,_> 순서 = 글자 순)
(빈 행)
failure_kind | count          ← failure_kinds가 하나라도 있을 때만
<kind 글자 그대로> | <합>
```

`name`은 `report.scenario_yaml`을 `Scenario::from_yaml`로 읽어 준비 스텝 이름을 채운다(실패하면 빈 칸 — fail-soft, `insights.rs` 선례). 실패 종류는 와이어 글자 그대로(한국어 이름은 UI 카탈로그에만 있다).

### 4.2 단일 run CSV — 준비 구획

본 스텝 표 뒤에 빈 줄 하나를 두고:

```
setup_ok,setup_failed,setup_interrupted
47,3,0
setup_step_id,count,error_count,p50_ms,p95_ms,max_ms
<id>,50,3,92,410,5004
```

표마다 열 수가 다르므로 표 하나에 `csv::Writer` 하나를 쓴다 — `report_to_stairs_csv`의 선례대로 `into_inner()` → `push(b'\n')`(빈 줄) → 그 바이트 위에 새 `Writer`. `flexible`은 쓰지 않는다(csv 1.4는 빈 레코드를 빈 줄이 아니라 `""`로 쓴다). 준비 요약 표(3열)와 준비 스텝 표(6열)도 Writer를 나누되 그 사이에는 빈 줄을 두지 않는다. 준비가 없을 때의 출력이 바뀌지 않음을 테스트로 고정한다.

### 4.3 비교 내보내기

비교하는 run 가운데 **하나라도** 준비가 있을 때만.

- **비교 CSV**(요약 행렬): `basis` 행(있으면) **앞**에 `setup_ok`·`setup_failed` 두 행. 준비가 없는 run의 값 칸은 빈 칸. 델타 칸은 기준과 후보 **둘 다** 값이 있을 때만 채운다(XLSX와 같은 규칙).
- **비교 XLSX**: `Setup` 시트를 `Steps` 다음에 둔다. 행 = `setup_ok` · `setup_failed` · 준비 스텝마다 `<step_id> p95_ms` · `<step_id> error_count`. 열·Δ 열·색은 `Steps` 시트와 같은 규칙(기준과 후보 **둘 다** 값이 있을 때만 Δ, Δ 열 카운터는 무조건 전진 — `crates/controller/CLAUDE.md` 「per-step Δ presence 계약」).
- **행 이름과 `delta`에 넘기는 metric 글자는 따로다**: 행 이름은 위와 같고, `delta(metric, …)`에는 `setup_ok`·`setup_failed`·`p95_ms`·`setup_errors`를 넘긴다(§5.1의 극성 표). `delta("error_count", …)`로 부르면 「높을수록 좋음」으로 판정된다.
- 준비 스텝 행의 순서 = 화면 비교와 같다(§5.1).

## 5. run 비교 (US3)

### 5.1 화면 — `compareReports` + `CompareMatrix`

- `CompareResult`에 `setup: CompareRow[]`를 더한다. 비교하는 리포트 가운데 하나라도 `setup`이 있으면 채우고, 없으면 빈 배열(= 묶음이 안 그려진다 — `SectionRows`가 빈 배열이면 `null`).
- 행: `준비 성공`(metric `setup_ok`) · `준비 실패`(`setup_failed`) · 준비 스텝마다 `{이름} p95 ms`(`p95_ms`) · `{이름} 오류`(`setup_errors`).
- 준비 스텝 순서: 기준 run의 `setup.steps` 순서, 그 뒤에 다른 run에만 있는 스텝을 리포트 순서·그 안의 스텝 순서로(첫 등장 순). 본 스텝 묶음의 「id 정렬」을 따르지 않는 이유 — 준비 스텝은 실행 순서가 뜻이다(로그인 → 권한 조회).
- 준비가 없는 run의 칸은 값 `null`(「—」)·델타 없음. 기준 run에 그 값이 없으면 다른 칸도 델타 없음(본 스텝 묶음과 같은 규칙).
- 극성: `setup_failed`·`setup_errors`는 낮을수록 좋음, `setup_ok`는 높을수록 좋음, `p95_ms`는 기존대로. `computeDelta`의 `LOWER_IS_BETTER`와 Rust `export.rs::delta`의 같은 집합에 둘을 더한다.
- 패리티 픽스처: `testdata/compare_golden.json`의 `expected`는 지금 `summary` 하나뿐이고 양쪽 테스트가 그 행을 요약 값 함수로 돈다 — 준비 metric은 거기 넣을 수 없다. **새 블록 `expected.polarity: [{ metric, base, val, pct, polarity }]`**를 더하고(`setup_ok`·`setup_failed`·`setup_errors` 각각 늘어남·줄어듦·같음·기준 0), 양쪽 테스트에 이 배열을 `delta`/`computeDelta`에 직접 넣어 대조하는 루프를 더한다. 이렇게 해야 한쪽 집합만 고쳤을 때 그쪽 테스트가 RED가 된다(되돌려 확인으로 실증).
- 묶음 위치: 「스텝」 묶음과 「상태」 묶음 사이. 묶음 제목 「준비 스텝」(`ko.report.setup.title` 재사용).
- 이름표: 본 스텝과 같은 구조로 한다. `compareReports`는 `label = step_id`로 내고, `ScenarioComparePage`가 이름을 붙인다 — 지금 그 페이지의 이름 맵은 기준 run의 `flattenHttpSteps(model.steps)`만 훑어 준비 스텝이 빠져 있으므로 `setupSteps(model)`을 더한다. `compareReports`는 지금처럼 `ko`를 읽지 않는 순수 모듈로 두고 「준비 성공」·「준비 실패」 행도 `label`을 metric 글자(`setup_ok`·`setup_failed`)로 낸다 — 한국어 라벨은 페이지가 metric을 보고 붙인다(이름 맵은 `id`가 있는 스텝 행에만 쓴다). 이름이 비면 본 스텝과 같은 대체값(`METHOD url`), 기준 run의 시나리오에 없는 스텝이면 다른 run의 시나리오를 리포트 순서로 찾고, 끝내 없으면 `step_id`. 페이지가 metric에 따라 뒤에 「 p95 ms」/「 오류」를 붙인다.
- 행 key: `CompareMatrix`의 key가 `row.metric + row.label`이라 이름이 같은 준비 스텝 둘이면 겹친다. `CompareRow`에 선택 칸 `id?: string`(준비 스텝 행은 `step_id`)을 더하고 key를 `row.metric + (row.id ?? row.label)`로 한다 — 기존 행은 `id`가 없어 key가 그대로다.
- 차이 표시는 기존 `DeltaChip` 그대로(기준 0 → 「신규」/「동일」).
- `stepMismatch`(스텝 구성 다름 배너)는 본 스텝만 본다 — 지금 그대로.

### 5.2 인쇄 비교 — 요약 한 줄

`cmpSummaryLines`에 줄 하나: 두 run **모두** `setup`이 있고 `failed`가 다를 때만.

- 「준비에 실패한 사용자가 {a}명에서 {b}명으로 늘었습니다.」 / 「…줄었습니다.」(open-loop면 「슬롯이 {a}개에서 {b}개로」 — 두 run의 부하 방식이 다르면 「준비 실패가 {a}에서 {b}로 …」처럼 단위 없이).
- 조사는 `josa()`로, 문장은 조각 목록(`parts`)으로(`ui/CLAUDE.md` 인쇄 절의 규칙).
- 줄 id는 `5`(`CmpSummaryLine.id` 타입 `1|2|3|4`를 넓힌다), 위치는 **맨 뒤**. 짧은 판은 `HeadlineBox`가 id 1·4만 거르므로 이 줄은 자동으로 빠진다 — 그대로 둔다(짧은 판 불변).
- 「비교할 수 없음」(`answer === "incomparable"`) 갈래에서는 내지 않는다.
- 한쪽에만 준비가 있으면 줄을 내지 않는다(대조 표가 이미 「시나리오 다름」을 말한다).

## 6. 실행 중 준비 진행 (US4)

### 6.1 와이어

`RunResponse`에 새 키:

```json
"setup_live": { "ok": 37, "failed": 2, "interrupted": 0 }
```

- `Option<SetupLive>` + `#[serde(skip_serializing_if = "Option::is_none")]`(키 생략 — `null` 아님. 옆의 `auto_stop_live`와 같은 속성). UI Zod는 `.optional()`.
- `get` 핸들러가 **`status == Running`일 때만** `run_section_outcomes`에서 `section = 'setup'` 행의 합을 읽는다(새 store 함수 하나, `run_id` 색인). **행 수(`COUNT(*)`)를 함께 읽어 0이면 `None`** — `SUM`만 쓰면 행이 없어도 NULL 행 하나가 돌아와, `COALESCE`로 0을 만들면 준비 없는 모든 실행 중 run에 키가 실린다(US5 위반). 행이 없는 경우 = 준비가 없는 시나리오, 또는 아직 첫 배치 전.
- 끝난 run·대기 중 run·목록 응답에는 싣지 않는다.
- 비용: 실행 중인 run을 보고 있는 화면 하나당 초당 색인 조회 1회. 시나리오를 다시 파싱하지 않는다(준비 유무는 UI가 안다).

### 6.2 화면 — `RunDetailPage`

숫자 카드 줄 아래, 실행 중 그림(계단 패널·진행 차트) 위에 한 줄(목업 장면 2). 새 컴포넌트 `components/run/SetupLiveLine.tsx`.

- 보이는 조건: run이 `running` **이고** 그 run의 시나리오 **스냅샷**(`run.scenario_yaml` — `RunSchema`에 있다)에 준비 스텝이 하나 이상. 페이지가 지금 파싱하는 것은 스냅샷이 아니라 현재 시나리오(`useScenario` → `scenario.data.yaml`)이므로, 새 memo에서 `parseScenarioDoc(r.scenario_yaml)` → `setupSteps(model)`로 따로 읽는다(실행 도중 시나리오를 고쳐도 줄이 틀어지지 않게). 스냅샷을 읽지 못하면 줄을 그리지 않는다. `setup_live` 키가 없으면 0으로 그린다(「0 / 50명 완료」).
- 분모와 단위(`deriveLoadMode` — 모드 판정의 단일 소스):

| 부하 방식 | 글 | 막대 |
|---|---|---|
| 고정 VU(유지 구간 closed 포함) | `{ok} / {vus}명 완료` | 있음 |
| open-loop(고정·곡선·계단·유지 구간 open) | `{ok} / {max_in_flight} 슬롯 완료` | 있음 |
| VU 곡선 | `{ok}명 완료` | 없음 |

- open-loop의 분모는 설정한 슬롯 수다. 슬롯은 도착이 처음 그 슬롯을 쓸 때 준비하므로(ADR-0062), 도착이 적은 run은 끝까지 다 차지 않는다 — 숫자는 사실 그대로이고, 막대가 차지 않는 것이 결함은 아니다(roadmap에 남긴다).
- `max_in_flight`가 프로필에 없으면(옛 run) 분모·막대 없이 `{ok} 슬롯 완료`.

- 실패 > 0: 줄이 경고색(amber 테두리·바탕)이 되고 `실패 {n}명`(open-loop는 `실패 {n} 슬롯`)과 설명 한 줄이 붙는다 — 「준비에 실패한 사용자는 본 스텝을 실행하지 않습니다. 끝난 뒤 리포트의 「준비 스텝」에서 원인을 볼 수 있습니다.」(open-loop: 「준비에 실패한 슬롯은 run에서 빠집니다. …」).
- 막대: 완료분(accent)과 실패분(amber)을 이어 그린다. 합이 분모를 넘으면 100%에서 자른다. 장식이므로 `aria-hidden` — 숫자는 글에 있다.
- 1초마다 바뀌는 숫자를 스크린리더가 매번 읽지 않게 live region으로 만들지 않는다.
- run이 끝나면 조건이 거짓이 되어 사라진다(리포트의 「준비 스텝」 구획이 잇는다).
- 문구는 `ko.runDetail.setupLive`.

### 6.3 「명」의 뜻

분모 `vus`는 설정값이다. 워커가 여럿이어도 합은 같다(샤드의 합 = `vus`, open-loop 슬롯의 합 = `max_in_flight`). 풀 모드에서 용량 부족으로 줄여 실행한 run은 프로필에 줄인 값이 저장되므로 그대로 맞는다.

## 7. 준비가 없는 run이 바뀌지 않는다는 것 (US5)

| 자리 | 지키는 것 | 테스트 |
|---|---|---|
| 인쇄 | 블록 목록·절 제목 글자 불변 | `standardBlocks`의 블록 id 목록과 절 제목 글자를 준비 없는 픽스처(속도 구간 있음/없음)로 고정 |
| 내보내기 | CSV·XLSX 출력 불변 | 기존 픽스처의 CSV 바이트 고정, XLSX 시트 이름 목록 고정 |
| 비교 | `setup: []`, 묶음 미렌더, 골든 픽스처의 기존 항목 불변 | `compareReports` 결과·`CompareMatrix` DOM(묶음 제목 수) |
| 실행 중 | 응답에 `setup_live` 키 없음, 줄 미렌더 | `contains_key` 부재 단언(값 `null` 단언 금지 — `crates/controller/CLAUDE.md` 테스트 절), RTL |

## 8. 검증

### 자동

- 서버: `export.rs` — 준비 있는 픽스처의 Setup 시트 값(calamine 왕복)·CSV 구획 글자, 준비 없는 픽스처 불변, 비교 XLSX Setup 시트의 Δ presence(기준에 없음 → 빈 칸, 후보에 없음 → 빈 칸, 열 정렬 3-run). `delta` 극성 표에 `setup_failed`·`setup_errors`·`setup_ok`. 골든 픽스처 갱신.
- 서버: `get` — 실행 중 + 준비 결과 행 있음 → 키와 합(워커 둘의 행을 더한 값), 실행 중 + 행 없음 → 키 없음, 끝난 run → 키 없음.
- UI: 인쇄 — 요약 줄(성공만 · 중단만 · 실패 · 실패+중단 · open-loop), 표 행(오류 행 바탕·요청 0 행의 `–`·코드 `"0"` 낱말), 절 번호 네 조합, 블록 목록. 비교 — 행 순서(기준 순서 + 첫 등장), 준비 없는 run 칸 `null`, 극성. 실행 중 줄 — 조건·세 부하 방식·실패 경고·분모 초과 자르기·키 없을 때 0.
- 되돌려 확인(teeth check): 「준비 없으면 불변」 테스트들은 준비 가지를 무조건 타게 고쳐 RED를 본다. 문구 테스트는 `ko` 함수 자기참조를 피한다(숫자·리터럴 한 건 병기).

### 라이브 (`/live-verify`, US별)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 준비 스텝 2개 시나리오, 고정 VU 50, 로그인 응답기가 일부 503 → 인쇄 표준판 | 절 번호·요약 줄·표 숫자가 화면 리포트 「준비 스텝」과 같다. 쪽마다 본문 한계 안(rect), 헤드리스 PDF 쪽 수 = 화면 쪽 수 |
| US1 극단 | 준비 스텝 20개·긴 이름(60자)·상태 코드 6종·요청 수 6자리 | 표가 쪽을 넘어 이어지고 조각마다 2행 이상, 칸 밖으로 글자 안 넘침(`scrollWidth<=clientWidth`), Windows 글꼴 폭 흉내(`letter-spacing: 0.12em`)에서도 머리 칸 줄바꿈이 낱말 단위 |
| US2 | 같은 run을 CSV·XLSX로 | Setup 시트·CSV 구획 숫자 = 리포트 JSON `setup` |
| US3 | 준비 성공 run · 준비 일부 실패 run · 준비 없는 run 셋 비교 → 화면, 비교 XLSX, 앞 둘로 인쇄 비교 | 묶음 행·「—」·차이 표시, 시트 값, 인쇄 요약의 한 줄 |
| US4 | 로그인 응답기 지연 2초, VU 50 점진 시작 → run 상세 | 숫자가 1초마다 늘고 막대가 따른다. 실패가 나면 경고색. 끝나면 사라진다. VU 곡선·open-loop run에서 글이 표와 같다. 줄의 폭 390·768·1440에서 겹침 없음 |
| US5 | 준비 없는 시나리오로 run → 인쇄·CSV·XLSX·비교·실행 중 | master 바이너리의 출력과 CSV 바이트 같음, 인쇄 쪽 수·절 제목 같음, 응답에 `setup_live` 없음 |

응답 파싱(S-D): 실행 중 run의 실제 `GET /api/runs/{id}` 응답을 저장해 `RunSchema`로 읽는 일회 테스트.

목업 대조(working-rules §4): 인쇄 절과 실행 중 줄이 처음 그려지는 task 직후 컨트롤러를 띄워 목업과 나란히 본다.

## 9. 목업과 다르게 가는 곳

| 목업 | 이 설계 | 이유 |
|---|---|---|
| 인쇄 절 번호 「4.」 | 「3.」(뒤 절은 속도 구간 유무에 따라 계산) | 목업이 「단계별 결과」를 3번으로 그렸다. 실제는 2번 |
| 인쇄 표의 코드 0 낱말 「보내지 못함」 | 「응답 없음」 | 인쇄 본 스텝 표가 이미 쓰는 낱말 |
| XLSX 머리글 한국어(「준비 성공」·「이름」·「실패 종류」의 한국어 이름) | 영문 키(`setup_ok`·`name`·`failure_kind`, 종류는 와이어 글자) | 같은 파일의 다른 시트가 모두 영문 키. 한국어 이름표는 UI 카탈로그에만 있다 |
| CSV 구획 머리 `setup,ok,failed,interrupted` | `setup_ok,setup_failed,setup_interrupted` | 열 이름만으로 뜻이 서게 |
| 비교 표의 차이 표시 「▲3」·「▼6.0%」(빨강) | 기존 `DeltaChip` 그대로(기준 0 → 「▲신규」, 나빠진 쪽은 항상 「▲」) | 묶음 하나만 다른 표기를 쓰지 않는다 |

## 10. 사실 확인에 쓴 명령

- `grep -n -i 'setup' crates/controller/src/export.rs` → 1건(`setup: None`, 테스트 픽스처).
- `grep -n -i 'setup' ui/src/print/buildPrintDoc.ts ui/src/print/scenarioFacts.ts ui/src/print/components/ReportHeader.tsx ui/src/print/compare/fairness.ts` → 머리 안내 줄·사실 읽기·대조 판정뿐.
- `grep -n -i 'setup' ui/src/pages/RunDetailPage.tsx` → 0건. `grep -rn -i 'setup' ui/src/compare ui/src/components/compare ui/src/pages/ScenarioComparePage.tsx | grep -v 'userEvent.setup()'` → 구현 전 0건.
- `sed -n '120,140p' ui/src/print/paginate.ts` → 표마다 `head = titleMm + headerMm` 한 번. `sed -n '84,95p' ui/src/pages/RunDetailPage.tsx` → 파싱 대상이 `scenario.data?.yaml`. `sed -n '1088,1100p' crates/controller/src/export.rs` → 빈 줄 선례. `sed -n '84,90p' ui/src/print/compare/components/HeadlineBox.tsx` → 짧은 판은 id 1·4.
- `sed -n '197,210p' ui/src/api/hooks.ts` → `useRun` 1초 폴링. `grep -n 'auto_stop_live' crates/controller/src/api/runs.rs` → `get`이 실행 중 계단 run에만 싣는 선례.
- `cat crates/controller/src/store/migrations/0027_run_section_metrics.sql` → `run_section_outcomes`와 `run_id` 색인.
- `grep -n -A12 '^    section: {' ui/src/i18n/ko.ts` → 절 제목 고정 글자와 `*Shifted` 짝.

## 11. roadmap에 남길 것

- 인쇄 비교 보고서의 「준비 스텝 비교」 절(사용자 결정 2026-11-23: 필요할 때).
- 인쇄 요약판의 준비 표시(지금은 머리 안내 줄뿐).
- 실행 중 준비 스텝별 응답 시간·준비 시계열.
- 인사이트 CSV의 준비 열.
- open-loop 실행 중 줄의 분모(설정 슬롯 수)가 도착이 적은 run에서 끝까지 차지 않는 것.

## 12. 구현 순서에 대한 메모

네 영역(인쇄 / 내보내기 / 비교 / 실행 중)은 서로 독립이다. 한 슬라이스로 가되(사용자 결정) plan은 영역별로 task와 커밋을 나눈다.
