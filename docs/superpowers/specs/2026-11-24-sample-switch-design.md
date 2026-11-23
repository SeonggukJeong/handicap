# 응답 시간 표본 슬라이스 B — 화면 표본 전환 단추 (sample-switch) 설계

- 날짜: 2026-11-24
- 상태: **구현 끝**(2026-11-24, 코드 `80055439`..`98b7f7f4`, 최종 리뷰 READY-TO-MERGE, 라이브 US2·6·7·8·9 통과, 판단·연기 roadmap §B92 — master 머지는 사용자 지시 대기). 구현 전 기록: spec-plan-reviewer 3차에 clean APPROVE(2026-11-24), plan `docs/superpowers/plans/2026-11-24-sample-switch.md`도 3차에 clean APPROVE. 목업 사용자 확인 2026-11-24 「고칠 건 딱히 안 보인다」. US·툴팁 문구·「없음」 문구 사용자 확인 2026-11-24. 검토 지적 처리 §10.
- 유형: `user-path`
- 출처: roadmap §A17 진행 순서 ①B. 슬라이스 A(`2026-11-23-passed-latency-design.md`, ADR-0063)가 서버의 `?sample=`까지 했고 화면 전환을 이 슬라이스로 넘겼다(A의 US2).
- 사용자 결정 (2026-11-24): ① 표본마다 「언제 고르고 무엇을 보는지」 설명을 툴팁으로 — 잘 모르는 사람도 고를 수 있게 ② 꼬리 몫 수치(Brooker 「Lorenz and Little」)는 미룬다(roadmap §A17 항목 6) ③ 「더 좋은 방법이 없으면 이대로」 — 검토 결과는 §3.
- 목업(시각 기준): 단추·안내 상자 = `2026-11-23-passed-latency-mockups/screens.html` 1·2. 툴팁·(?) 내용·구획 표지 = `2026-11-24-sample-switch-mockups/screens.html`.
- ADR: 없음(ADR-0063 범위 안 — 와이어·저장·숫자의 뜻이 바뀌지 않는다).
- 범위: **화면(`ui/`)만.** 서버·엔진·proto·DB 변경 없음.
- 작업 브랜치: `worktree-verdict-stats`. A ↔ B ↔ ② ↔ ③ ↔ ④ 사이에는 릴리즈하지 않는다.

## 사용자 스토리 (US)

- **US2**: QA가 실패가 섞인 run에서 실패가 즉시 거부인지 시간 초과인지 알고 싶다 — 성공하면 리포트에서 「실패한 요청」을 골랐을 때 요약·스텝별 표·시간대별 그래프·분포·워커별 응답 시간이 실패한 요청의 값으로 바뀐다(정상 40ms·즉시 실패 2ms인 run이면 p50이 40ms 근처 → 2ms 근처). 「모든 요청」을 고르면 실패를 섞은 값, 「통과한 요청」으로 돌아오면 처음 숫자다.
- **US9**: 표본이 무엇인지 모르는 QA가 표본 단추에 마우스를 올리거나 (?)를 누른다 — 성공하면 표본마다 「언제 고르는지」와 「무엇을 보는지」를 읽을 수 있고, 고른 뒤에는 표본 줄에 그 표본의 설명이 남는다.
- **US6**: QA가 표본을 바꾼 채 판정 표·인사이트·계단 표를 본다 — 성공하면 그 셋은 숫자와 결과가 그대로이고, 「응답 시간 숫자만 바꿔 보여 줍니다」 안내가 표본 줄에 보이며, 표본에 따라 값이 바뀌는 구획마다 지금 표본의 이름이 붙어 있다.
- **US7**: QA가 실패가 하나도 없는 run이나 스텝에서 「실패한 요청」을 고른다 — 성공하면 응답 시간 자리에 0이 아니라 「—」가 나오고 머리말 문장과 분포 구획은 「실패한 요청 없음」이라고 말한다.
- **US8**: QA가 표본을 바꾼 화면에서 기준(유지 구간 ↔ 전체 구간)을 바꾸거나 새로 고친다 — 성공하면 고른 표본이 유지되고 「다른 기준」 줄의 응답 시간도 같은 표본의 값이며 그 표본의 이름이 붙는다.

(US 번호는 슬라이스 A의 번호를 잇는다 — US1·3·4·5는 A. A의 US5 「이번 변경 전 run」은 그대로다: 단추 없이 표지만.)

## 1. 배경

### 1.1 지금 상태 (`f4228735` 기준 — 확인 명령 §9)

- 서버 `GET /api/runs/{id}/report?sample=passed|failed|all`: 요약·스텝·초별 창·분포 곡선·워커별 응답 시간이 고른 표본의 값이다. 판정·유효성·속도 구간·인사이트·계단은 요청한 표본에 따라 바뀌지 않는다(A의 R6·R7·R8 — 판정·느린 스텝은 기본 표본, 포화 원인의 지연 상승은 늘 모든 요청). 다른 기준 요약(`basis.other`)은 요청한 표본을 따른다. 고른 표본에 값이 없으면 리포트의 `latency`(분포)가 없다. 나눌 수 없는 run은 조용히 `all`. 모르는 값은 400.
- 리포트 JSON에 `sample: { selected, default, split }`가 항상 있다(Zod는 `.optional()` → `reportSample()`이 없으면 `all/all/false`).
- 화면 배관: `queryKeys.runReport(id, basis, sample)`·`useRunReport(id, terminal, basis, sample)`·`api.getRunReport(id, basis, sample)`가 표본 인자를 이미 받는다. `sameRunPlaceholder`가 같은 run의 이전 리포트를 불러오는 동안 보여 준다.
- `RunDetailPage`는 `?basis=`만 읽고 표본은 넘기지 않는다. `selectBasis`는 기본 기준이면 `basis`를 주소에서 지운다(`replace: true`).
- `SampleBar`(`ui/src/components/report/SampleBar.tsx`)는 표지 + (?) + 설명 한 줄. 단추 없음. `ReportView` 한 곳에서만 쓴다. `ReportView`는 `RunDetailPage` 한 곳에서만 쓴다.
- 「—」 규칙의 지금 모양: `StepStatsTable`만 `hasLatency`를 세 표본 모두에 쓴다. `Summary`·`ReportHeadline`은 `sample !== "all"`일 때만 쓴다(`all`이면 늘 값). `WorkerBreakdownTable`은 제 규칙이다(`passed` → `count − errors > 0`, `failed` → `errors > 0`, `all` → 늘 값 — 워커별 「보내지 않음」 수는 리포트에 없다).
- `StepPhaseBreakdown`: 단계 분해 데이터가 있는 run의 기본 보기는 「막대」(`waterfall`, `ko.report.phaseViewWaterfall`)이고 대기·다운로드 값(표본을 따르지 않는다)을 보인다. `StepStatsTable`(p50·p95·p99)은 「칩」 보기(`phaseViewChips`)에만 나온다. 단계 분해가 없는 run은 표만 나온다.
- `WorkerBreakdownTable`은 워커가 둘 이상일 때만 나온다. `PageSection`에는 제목 곁 칸(`titleAside`)이 있다. `helpTipPos.ts`의 `TIP_WIDTH_PX`는 224이고 `computeTipPos`가 그 폭으로 자리를 잡는다.
- 표본을 받아 「—」를 그리는 부품: `Summary`·`ReportHeadline`(`latency` prop), `StepStatsTable`·`StepPhaseBreakdown`·`WorkerBreakdownTable`(`sample` prop), `bySecond`(리포트의 `sample.selected`를 읽는다), `BasisBar`(`basisOtherLine(basis, sample)`).
- 틀린 곳(§B91 (4)): `ReportHeadline`은 `failed` 표본에서도 `ko.report.headlineLatency(null)` = 「통과한 요청 없음」이라 하고, 값이 있으면 「95%가 … 안에 응답」이라 한다. `basisOtherLine`은 `passed`일 때만 값 없음을 가린다.
- `Segmented`(`ui/src/components/ui/Segmented.tsx`)는 `role="radiogroup"` + 화살표 키. 선택지별 설명 칸은 없다. 화살표 키는 `onChange`만 부르고 **초점을 옮기지 않는다**(`focus()`·`ref` 없음 — 초점이 `tabIndex=-1`이 된 단추에 남는다). 쓰는 곳 셋: `BasisBar`·`run/RunDialog`·`run/LoadModelFields`. 묶음은 `inline-flex`라 줄바꿈하지 않는다. `HelpTip`은 누르면 열리는 도움말이다(「hover 전용 금지」 — 터치·키보드). `role="tooltip"`을 쓰는 부품은 없다.
- 인쇄 링크는 `?basis=`만 싣는다. CSV·XLSX 내보내기 주소는 표본을 받지 않는다. JSON 내려받기는 화면의 리포트 객체를 그대로 저장한다.
- `SlotSizingHelper`는 `sample=all`, `WorkerSizingHelper`·`VuSizingHelper`·`RunPrintPage`는 기본 표본으로 리포트를 읽는다.

### 1.2 왜

실패한 요청의 응답 시간과 실패를 섞은 응답 시간은 지금 API로만 볼 수 있다. 세 표본은 답하는 질문이 다르다:

| 표본 | 답하는 질문 | 보는 것 |
|---|---|---|
| 통과한 요청 | 성공했을 때 얼마나 빠른가 | 판정 기준, 사용자 체감 |
| 실패한 요청 | 어떻게 실패하는가 | 몇 ms = 즉시 거절, 시간 초과 값에 몰림 = 붙잡혔다가 실패. 스텝별·시간대별로 어디서·언제부터 |
| 모든 요청 | 서버가 요청을 얼마나 오래 붙잡았나 | 용량 판단(시간 초과가 연결·슬롯을 가장 오래 잡는다), 이전 run·다른 도구 숫자와 맞춰 보기 |

### 1.3 목표가 아닌 것

- 인쇄·CSV/XLSX 내보내기·비교를 고른 표본으로 뽑기(A의 결정 — 기본 표본 고정).
- 꼬리 몫 수치(roadmap §A17 항목 6).
- 준비 스텝·병렬 묶음·대기/다운로드·조건 반복 분리의 표본 전환(「실패 포함」 표지 그대로).
- 서버·리포트 형식 변경. 세 표본을 한 응답에 싣기.
- 실행 중 화면.

### 1.4 하면 안 되는 것

- 기본 표본이 아닌 응답 시간을 어느 표본인지 표시 없이 보여 주는 것(A §1.4의 연장 — 화면을 아래로 내린 뒤에도).
- 표본을 바꿨을 때 판정·인사이트·계단이 바뀐 것처럼 보이게 하는 것.
- 값이 없는데 0을 찍거나, 「실패한 요청」 표본에서 「통과한 요청 없음」·「…안에 응답」이라고 말하는 것.
- 설명을 마우스 올리기로만 읽을 수 있게 하는 것(터치·키보드).
- 표본 단추를 잠그는 것(실패가 없는 run에서도 고를 수 있고, 값이 없다고 말한다 — working-rules §5).

## 2. 요구사항 (R-id)

아래에서 **「바꿔 봄」** = 나눌 수 있는 run(`split`)에서 받은 표본이 기본 표본이 아님(`split && selected !== default`). 나눌 수 없는 run은 `selected`가 `all`이어도 「바꿔 봄」이 아니다.

| ID | 요구사항 | acceptance |
|---|---|---|
| R1 | MUST run 상세가 주소의 `?sample=`을 읽어 리포트를 그 표본으로 받는다. 받는 값은 `passed`·`failed`·`all`뿐이고 그 밖의 값은 없는 것으로 다룬다(서버에 보내지 않는다 — 400 화면 방지). `?basis=`와 함께 쓴다. | RTL(`RunDetailPage`): 주소 `?sample=failed` → 요청 URL에 `sample=failed` · `?sample=xyz` → 요청 URL에 `sample` 없음 · `?basis=whole&sample=all` → 둘 다. |
| R2 | MUST 표본을 고르면 주소를 고친다: 기본 표본(`report.sample.default`)이면 `sample`을 지우고, 아니면 넣는다. `replace: true`. `basis`를 건드리지 않는다. 기준을 고를 때도 `sample`을 건드리지 않는다. | RTL: 단추 누름 → 주소 · 기본으로 돌아오면 `sample` 없음 · 기준 전환 뒤 `sample` 유지(US8). |
| R3 | MUST 나눌 수 있는 run의 `SampleBar`는 표지 대신 단추 셋(「통과한 요청」·「실패한 요청」·「모든 요청」, `Segmented`)을 보인다. 눌린 단추 = **요청한 표본**(주소에서 읽어 검증한 값, 없으면 리포트의 `sample.default` — 주소에 `sample`이 없다는 것은 기본 표본을 요청했다는 뜻이다) — 불러오는 동안에도 방금 고른 단추가 눌려 있어 화살표 키를 이어 누를 수 있다(나눌 수 있는 run은 서버가 세 표본을 모두 준다). 나눌 수 없는 run은 지금 그대로(표지 + 설명, 단추 없음). 요청이 없는 run(`windows.length === 0`)은 줄이 없다. | RTL(`SampleBar`): split / not split / 창 없음 · 요청한 표본 ≠ 리포트 표본(불러오는 중)일 때 눌린 단추 = 요청한 표본 — 두 방향 모두(기본 → 실패, 실패 → 기본으로 돌아오는 중). |
| R4 | MUST 불러오는 동안(`isPlaceholderData`) 단추 묶음은 `aria-busy`이고 리포트 본문은 흐리다 — 기준 전환과 같은 처리(`pending`). 본문의 숫자·표지·문장과 표본 줄의 설명·안내 상자는 리포트의 `sample.selected`(실제로 받은 표본)를 따른다 — 불러오는 짧은 동안 눌린 단추(요청한 표본)와 설명(받은 표본)이 다른 것은 의도다(숫자와 그 설명이 늘 짝이 맞는다). | RTL: `pending` → `aria-busy="true"`. |
| R5 | MUST 표본 단추마다 설명이 있다: 「언제 고르나」 + 「무엇을 보나」(§5). **열림**: 마우스가 단추 위에 있거나 그 툴팁 위에 있을 때(단추에서 툴팁으로 옮겨 가는 짧은 틈을 견딘다), 또는 키보드로 초점이 왔을 때(`:focus-visible` — 마우스로 누른 뒤 초점이 남아서 떠 있지 않게). **닫힘**: 마우스가 단추·툴팁 둘 다에서 떠남 · 초점 떠남 · Esc(다음에 다시 올리거나 초점이 올 때까지 닫힌 채) · 스크롤·창 크기 변경. 한 번에 하나만 뜬다. 툴팁 폭은 224px(`TIP_WIDTH_PX`)이고 `computeTipPos`로 화면 안에 놓는다. **읽기 프로그램**: 단추마다 늘 그려져 있는 숨은 설명(`hidden`, 고정 id — plan 검토에서 `sr-only`를 바꿨다: 둘러보기 읽기에서 떠도는 글자로 읽히지 않는다)을 `aria-describedby`로 잇는다 — 숨은 설명은 단추의 **형제**로 둔다(단추 안에 두면 단추 이름에 섞인다). 보이는 툴팁은 `aria-hidden`이다(두 번 읽지 않게). | RTL: hover로 열림 · 마우스를 툴팁으로 옮겨도 열려 있음 · 둘 다 떠나면 닫힘 · 키보드 초점으로 열림 · Esc → 닫히고 다시 초점이 오면 열림 · `aria-describedby`가 가리키는 글 = 그 표본의 설명(닫혀 있어도). RTL은 키보드 길만 본다 — jsdom은 `:focus-visible`을 「초점 있음」으로 다뤄서 「마우스로 누른 뒤 떠 있지 않음」은 라이브로 확인한다. 라이브: 좁은 폭·화면 끝에서 화면 안(rect) · 단추를 누르고 마우스를 치우면 닫힘. |
| R6 | MUST 같은 설명 셋을 (?) 도움말(`HelpTip`, 누르면 열림)에서도 읽을 수 있다 — 터치. (?)에는 지금의 「통과」 뜻 풀이(A의 R27)도 남긴다. | RTL: (?) 누름 → 세 표본 이름·설명 + 「통과」 풀이. |
| R7 | MUST 표본 줄의 설명 한 줄이 받은 표본을 말한다: 통과 = 지금 문구, 실패 = `failedHint`, 모든(바꿔 봄일 때) = `allSelectedHint`. 나눌 수 없는 run은 지금 문구(`allHint`). | RTL. |
| R8 | MUST 「바꿔 봄」이면 표본 줄 아래에 안내 상자(`Callout`, 목업 2의 노란 상자 — 맞는 `variant`가 없으면 plan에서 고른다)를 보인다: `switchedNote`(§5). 아니면 없다. | RTL: failed·all에 있음, passed·나눌 수 없는 run에 없음. |
| R9 | MUST 「바꿔 봄」이면 표본에 따라 값이 바뀌는 구획에 표본 이름 표지(`Badge`)를 단다: ① 요약의 p50 카드 이름 곁(목업 3) ② 시간대별 p95 그래프 제목 ③ 응답 시간 분포 구획 제목 ④ 스텝별 **표**(`StepStatsTable` — 「칩」 보기 또는 단계 분해 없는 run) ⑤ 워커별 표 제목. 「바꿔 봄」이 아니면 하나도 달지 않는다(지금 화면과 같다). 표본을 따르지 않는 구획(판정·인사이트·계단·상태 코드 분포·오류 종류·요청 수/오류 그래프·「막대」 보기·「실패 포함」 구획)에는 달지 않는다. 구획의 `aria-label`은 바꾸지 않는다. plan에서 `ReportView`의 자식을 전수 확인해 「따른다/안 따른다」 표로 남긴다. | RTL: 구획별 표지 유무(failed / passed / 나눌 수 없는 run). |
| R9-1 | MUST 「바꿔 봄」이고 스텝 구획이 「막대」 보기일 때, 막대 위에 한 줄을 보인다: `waterfallNote`(§5 — 보기 이름은 `ko.report.phaseViewChips`에서 가져와 단추 이름과 늘 같다). | RTL. |
| R10 | MUST 머리말 문장(`ReportHeadline`)이 표본을 따른다 — **「바꿔 봄」일 때만** 바뀐다: 실패 = 값이 있으면 「실패한 요청의 95%가 {시간} 안에 실패」, 없으면 — 오류가 0건이면 「실패한 요청 없음」, 오류는 있는데 전부 「보내지 않음」이면 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」(`noFailedMeasured`). 모든 = 값이 있으면 「모든 요청의 95%가 {시간} 안에 끝남」, 없으면 「요청이 모두 보내기 전에 실패해 잰 시간이 없음」. 통과·나눌 수 없는 run은 지금 문구 그대로. 판정 콜아웃은 그대로다. | RTL: 표본 × 값 유무 + 나눌 수 없는 run(`selected: all`)의 문장이 지금과 같다 · 오류가 전부 「보내지 않음」인 `failed`. |
| R11 | MUST 「—」 규칙: 「바꿔 봄」이면 요약 카드·머리말·스텝별 표·시간대별 그래프(끊김)가 `hasLatency(counts, 받은 표본)`을 따른다 — `all`도(`count − notSent > 0`). 지금 `Summary`·`ReportHeadline`이 `all`을 건너뛰는 것은 나눌 수 없는 run에만 남긴다(옛 run 화면 불변). 워커별 표는 제 규칙 그대로다(§7). | RTL: 실패 0건 스텝이 섞인 `failed` 픽스처 — 각 자리 「—」·그래프 `null` · 전부 「보내지 않음」인 `all`(나눌 수 있는 run) → 「—」 · 나눌 수 없는 run은 지금 그대로. |
| R11-1 | MUST 「바꿔 봄」인데 리포트에 분포(`latency`)가 없으면 응답 시간 분포 구획을 숨기지 않고 제목 + 표지 + R10과 같은 「없음」 낱말(실패: 오류 0건 = 「실패한 요청 없음」, 전부 「보내지 않음」 = 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」 · 모든 = 「요청이 모두 보내기 전에 실패해 잰 시간이 없음」)을 보인다. 「바꿔 봄」이 아니면 지금처럼 구획이 없다. | RTL. |
| R12 | MUST 「다른 기준」 줄(`basisOtherLine`): 「바꿔 봄」이면 줄에 표본 이름을 붙이고, 값 없음을 가린다 — `failed`: `count === 0` 또는 `error_rate === 0`, `all`: `count === 0`. `passed`·나눌 수 없는 run은 지금 그대로. | 단위 테스트(`basisText`). |
| R13 | MUST 인쇄 링크·CSV·XLSX·인사이트 CSV·계단 CSV는 표본을 싣지 않는다(지금 그대로). JSON 내려받기는 지금처럼 화면의 리포트를 저장한다(파일 안 `sample` 블록이 표본을 말한다 — 이름은 바꾸지 않는다). | RTL: 「바꿔 봄」에서도 인쇄 링크·내보내기 주소에 `sample` 없음. |
| R14 | MUST 나눌 수 없는 run을 `?sample=failed` 주소로 열어도 지금 화면과 같다: 단추 없음, 「모든 요청 (실패한 요청 포함)」 표지, 안내 상자·구획 표지·「막대」 보기 안내 없음, 머리말 문장·요약 카드·「다른 기준」 줄이 지금과 같다. | RTL: `selected: all, default: all, split: false` + 주소 `sample=failed` — 위 항목 전부. |
| R15 | MUST 사이징 도우미 셋과 인쇄 화면이 읽는 표본은 바뀌지 않는다. run 상세에서 표본을 바꿔도 그 캐시와 섞이지 않는다(캐시 열쇠가 표본을 구분 — 이미 그렇다). | 기존 테스트 무수정 통과. |
| R16 | MUST 문구는 `ko.ts` 경유. 표본 이름에 「전체」를 쓰지 않는다. | `ko.report.sample` 블록 안에 「전체」가 「전체 구간」 말고 없음(plan에서 블록 범위를 정해 grep). |
| R17 | MUST `Segmented`에서 화살표 키로 고르면 초점도 고른 단추로 간다(툴팁이 초점을 따른다 — R5). 프리미티브를 고치므로 쓰는 곳 셋(`BasisBar`·`RunDialog`·`LoadModelFields`)이 함께 바뀐다 — 셋의 기존 테스트가 통과하고, 라이브에서 실행 창의 두 단추 묶음도 화살표 키로 한 번 본다. | RTL(`Segmented`): 화살표 → `document.activeElement` = 새로 고른 단추 · 세 소비처 테스트 통과. |
| R18 | MUST 폭 360px에서 표본 줄이 넘치지 않는다: 단추 묶음이 줄 폭을 넘으면 묶음 안에서 줄바꿈한다(`Segmented`의 `className`으로 — 다른 소비처 무영향). | 라이브: 360px·Windows 글꼴 폭을 가정한 +15% 글자 폭에서 가로 넘침 없음(rect). |

## 3. 접근

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 주소 `?sample=` → 리포트를 그 표본으로 다시 받는다. 기준 전환(`?basis=`)과 같은 방식. 표본마다 캐시. | 서버·형식 변경 없음. 새로 고침·링크에 남는다. 판정이 안 바뀌는 것은 서버가 보장한다. |
| 나 | 세 표본의 값을 나란히 놓은 표를 요약에 늘 보인다(전환 없음). | 요약은 한눈에 좋지만 그래프·스텝 표·분포는 여전히 전환이 필요하다. 리포트를 열 때마다 세 번 받거나 형식을 바꿔야 한다. 표본을 모르는 사람에게 숫자가 세 배로 는다. → 꼬리 몫과 함께 ④에서 「표본별 요약」으로 다시 볼 수 있다. |
| 다 | 화면 상태(`useState`)로만 들고 주소에 담지 않는다. | 새로 고침하면 사라지고 기준 전환과 방식이 달라진다. |
| 라 | 실패가 없는 run에서 「실패한 요청」 단추를 잠근다. | working-rules §5(잠금보다 허용 + 안내). 「실패한 요청 없음」이라고 말하는 쪽이 낫다. |

「가」에 검토에서 더한 것: ① 구획 표지(R9) — 표본 줄에서 멀어진 뒤에도 어느 표본인지 알게 ② 불러오는 동안 흐리게(R4) — 이전 표본의 숫자를 새 표본의 값으로 읽지 않게.

미리 받아 두기(단추에 마우스를 올리면 다른 표본을 미리 요청)는 넣지 않는다 — 리포트 빌드는 실패가 내내 있는 600초 × 5스텝 run에서 0.23초였고(§B91 (2), 1시간 run은 +0.7초쯤으로 추정, 유지 구간이 있는 run은 기준마다 한 번씩 두 번 만든다) 한 번 본 표본은 캐시에서 바로 뜬다. 툴팁을 읽으려고 올린 마우스마다 서버가 리포트를 만드는 것은 값이 맞지 않는다.

## 4. 화면

```
[유지 구간][전체 구간]                                   ← BasisBar
유지 구간 기준 … · 전체 구간 (실패한 요청): 200.0 RPS · p95 3 ms · 오류 60.2%
┌──────────────────────────────────────────────────────────────────────┐
│ 응답 시간 표본 [통과한 요청][실패한 요청][모든 요청] (?) 실패한 요청이 … │  ← SampleBar
└──────────────────────────────────────────────────────────────────────┘
┌ 응답 시간 숫자만 실패한 요청 기준으로 바꿔 보여 줍니다. … ┐              ← 「바꿔 봄」일 때만
… 머리말 문장 · 판정 · 인사이트 …
[총 요청][오류][평균 RPS][실행 시간][p50 〔실패한 요청〕][p95][p99]         ← 납작한 카드 격자, 표지는 p50 카드 하나
p95 응답 시간 〔실패한 요청〕 (그래프)
```

- 시각 기준은 목업이다. 문구는 §5가 정본이다(앞 목업 2의 「…·속도 구간·…」은 쓰지 않는다 — 속도 구간은 인쇄에만 있다).
- **`SampleBar`**: `report`·`requested`(요청한 표본)·`pending`·`onSelect`를 받는다. `ReportView`가 `RunDetailPage`에서 받아 넘긴다.
- **단추 툴팁**: `Segmented`의 선택지에 선택 칸 `description`을 더한다(없으면 툴팁·숨은 설명이 없다 — 다른 소비처의 DOM이 안 바뀐다). 자리 계산과 portal은 `HelpTip`을 따른다.
- **(?)**: 세 표본을 `<b>이름</b> — 설명` 줄로(내려받기 도움말과 같은 모양) + 「통과」 풀이.
- **요약 카드 표지**: p50 카드 하나(목업 3 — 사용자 확인). 좁은 폭에서 격자가 줄바꿈되어 p99가 다음 줄로 가도 표지는 p50에만 있다(카드 셋은 붙어 있고, 표본 줄·안내 상자가 바로 위에 있다).
- **`RunDetailPage`**: `sampleParam` 읽기(R1), `selectSample`(R2), `useRunReport(id, terminal, basis, sample)`.
- 진입 화면: run 상세 하나(`ReportView`가 마운트되는 유일한 곳). `Segmented`를 고치므로 실행 창(`RunDialog`·`LoadModelFields`)도 본다. 인쇄·비교·사이징 도우미는 안 바뀌는 것을 확인만 한다.

## 5. 문구 (`ko.report.sample` — 정본. 사용자 확인 2026-11-24)

| 열쇠 | 문구 |
|---|---|
| `failed` | 실패한 요청 |
| `allShort` | 모든 요청 |
| `switchAria` | 응답 시간 표본 고르기 |
| `whenPassed` | 성공한 요청이 얼마나 빠른지 볼 때 고릅니다. 판정 기준도 이 값으로 판정합니다. |
| `lookPassed` | p95·p99가 목표 안인지, 시간대별 그래프가 부하를 올릴 때 함께 올라가는지 봅니다. |
| `whenFailed` | 요청이 어떻게 실패하는지 볼 때 고릅니다. |
| `lookFailed` | 값이 몇 ms면 서버가 바로 거절한 것이고, 시간 초과 값에 몰려 있으면 서버가 붙잡고 있다가 실패한 것입니다. 스텝별 표에서 어느 요청이 느리게 실패하는지 봅니다. |
| `whenAll` | 서버가 요청을 얼마나 오래 붙잡고 있었는지 볼 때(용량 판단), 또는 이전 run·다른 도구의 숫자와 맞춰 볼 때 고릅니다. |
| `lookAll` | 평균과 p99를 봅니다. 시간 초과가 섞이면 통과한 요청보다 크게 나옵니다. |
| `failedHint` | 실패한 요청이 실패할 때까지 걸린 시간입니다. |
| `allSelectedHint` | 통과한 요청과 실패한 요청을 함께 계산한 응답 시간입니다. |
| `switchedNote(name)` | 응답 시간 숫자만 {name} 기준으로 바꿔 보여 줍니다. 판정·인사이트·계단 표는 바뀌지 않습니다. 인쇄·CSV·XLSX는 통과한 요청 기준입니다. |
| `waterfallNote` | 이 보기의 값은 표본을 따르지 않습니다. 표본별 응답 시간은 「칩」 보기에서 봅니다. |
| `passedHelpLead` | 「통과」는 (뒤에 한 칸 — (?) 마지막 줄에서 기존 `passedHelp` 앞에 붙는 주어. 목업 2) |
| `noFailed` | 실패한 요청 없음 |
| `noFailedMeasured` | 실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음 |
| `noMeasured` | 요청이 모두 보내기 전에 실패해 잰 시간이 없음 |
| 머리말 | 「실패한 요청의 95%가 {t} 안에 실패」 · 「모든 요청의 95%가 {t} 안에 끝남」 |

`allShort`는 단추·표지용이다. 기존 `all`(「모든 요청 (실패한 요청 포함)」)은 나눌 수 없는 run의 표지로 남는다. (?) 이름표(`helpLabel`)는 「응답 시간 표본 설명」으로 바꾼다. 「실패 포함」 표지 문구는 표본을 바꿔도 그대로 둔다(그 구획이 실패를 포함한다는 사실은 어느 표본에서도 참이다). 목업의 안내 상자 문구 끝(「인쇄·내보내기는…」)은 이 표의 「인쇄·CSV·XLSX는…」으로 읽는다.

## 6. 테스트·검증

- 단위·RTL: R1–R18의 acceptance. `ui/src`를 건드리는 모든 task에 UI 테스트 스텝. 툴팁 + `Segmented` 초점(R5·R17)은 제 task와 제 접근성 테스트를 갖는다.
- 회귀 가드로 쓰는 테스트는 되돌려 확인을 한다: R1(모르는 값을 서버에 안 보냄), R9(기본 표본에 표지 없음), R10·R14(옛 run의 머리말·화면 불변).
- 게이트: `pnpm lint && pnpm test && pnpm build`.
- 라이브(US-anchored, `/live-verify`):

| US | 절차 | 통과 신호 |
|---|---|---|
| US2 | **run 가**: 응답기 40%는 40ms 뒤 200, 60%는 즉시 500 + `assert: status 200`, VU 고정, **워커 2**(닫힌 루프는 VU가 워커 용량을 넘어야 나뉜다 — 워커당 VU 용량 `worker_capacity_vus`를 VU 수보다 작게 낮춰 만든다. 컨트롤러 실행 인자(`crates/controller/src/main.rs`) 또는 설정(`settings.rs`의 같은 열쇠)이고, 격리된 검증용 컨트롤러라 되돌릴 것은 없다), `max_p95_ms` 기준. 리포트에서 세 표본을 차례로 누른다 | p50: 통과 ≈ 40ms · 실패 ≈ 수 ms · 모든 ≈ 수 ms. 스텝별 표·p95 그래프·분포·워커 표가 함께 바뀐다. 통과로 돌아오면 처음 숫자. 주소에 `sample=` |
| US9 | run 가에서 단추마다 마우스 올리기 · 마우스를 툴팁 위로 · Tab과 화살표 · Esc · (?) 누르기 | 툴팁 셋의 문구 · 툴팁 위로 옮겨도 열려 있음 · 단추를 누르고 마우스를 치우면 닫힘 · 화살표로 초점과 툴팁이 함께 옮겨 감 · 화면 밖으로 안 나감(360px 포함, rect) · (?)에 셋 + 「통과」 풀이 |
| US6 | run 가에서 표본을 바꾼다. **run 나**(계단 run, 일부 즉시 실패)에서도 바꾼다 | run 가: 판정 표·인사이트의 글자가 표본 셋에서 같다(DOM 텍스트 대조) · 안내 상자 · 구획 표지 다섯(요약 p50·p95 그래프·분포·스텝별 표·워커별). run 나: 계단 표의 글자가 표본 셋에서 같다 |
| US7 | **run 다**: 전부 200. 「실패한 요청」 | 요약·스텝 표 「—」 · 그래프 끊김 · 머리말 「실패한 요청 없음」 · 분포 구획 「실패한 요청 없음」 · 0ms 없음 |
| US8 | **run 라**: 유지 구간이 있는 run(상승 시간 > 0), 일부 실패. 표본 = 실패 → 기준 전환 → 새로 고침 | 표본 유지 · 「다른 기준」 줄에 표본 이름과 그 표본의 값 |
| R9-1 | **run 마**: 단계 분해(`measure_phases`)를 켠 run에서 표본 = 실패 | 「막대」 보기에 안내 한 줄, 표지 없음 · 「칩」 보기에 표지 |
| (A의 US5) | 변경 전 DB 사본의 run을 `?sample=failed`로 연다 | 단추 없음 · 표지 「모든 요청 (실패한 요청 포함)」 · 상자·구획 표지 없음 · 머리말 문장이 `?sample` 없이 연 것과 같다 |
| R17 | 실행 창의 단추 묶음 둘에서 화살표 키 | 초점이 고른 단추로 간다, 동작 그대로 |

- 극단값: 폭 360px에서 표본 줄의 줄바꿈·넘침(R18), 긴 스텝 이름·스텝 수십 개에서 구획 표지의 겹침(rect 교차 실측), 툴팁이 화면 아래·오른쪽 끝에서 뒤집히는지.
- 안 바뀌는 화면 확인: 인쇄 미리보기(표본 줄 「통과한 요청」)·실행 창 슬롯 사이징.
- 보안 게이트: 요청 실행·템플릿·env·업로드·본문 뷰어를 건드리지 않는다. `finish-slice` §0 grep은 그래도 돌린다.
- 코드 리뷰 모델: 기본(Sonnet). path-gate 해당 없음.

## 7. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 틀렸을 때 비용 | 푸는 길 |
|---|---|---|---|
| 인쇄·CSV·XLSX를 고른 표본으로 | A의 결정. 인쇄 문서 전체에 표본 표시가 필요하다 | 실패한 요청의 시간은 화면과 JSON으로만 남긴다 | 인쇄 링크·내보내기 주소에 `sample` + 문서 머리 표시 |
| JSON 파일 이름에 표본·기준 | 지금 JSON 이름은 기준도 싣지 않는다 — 표본만 붙이면 어긋난다 | 표본이 다른 JSON 둘의 이름이 같다(파일 안 `sample`·`basis` 블록으로 구분) | 이름에 기준·표본을 함께 |
| 꼬리 몫(느린 1%가 응답 시간 합의 몇 %) | 새 통계 — 서버 계산·리포트 형식 | 용량 관점의 꼬리 영향은 눈으로 본다 | roadmap §A17 항목 6 |
| 세 표본 요약을 나란히 | 접근 「나」 | 표본을 바꿔 가며 본다 | ④에서 통계 칸과 함께 |
| 워커별 표의 「—」: 「보내지 않음」을 빼지 못한다 | 워커별 「보내지 않음」 수가 리포트에 없다 | 한 워커의 실패가 전부 「보내지 않음」이면 실패 표본에서 0이, 요청이 전부 「보내지 않음」이면 모든 표본에서 0이 찍힌다 | 서버가 워커별 `not_sent`를 싣기 |
| 「다른 기준」 줄: 실패가 전부 「보내지 않음」인 경우 | 다른 기준 요약에 「보내지 않음」 수가 없다 | 그 경우 줄에 0ms가 나온다 | 서버가 다른 기준 요약에 `not_sent`를 싣기 |
| 기준 단추(`BasisBar`)의 눌린 단추는 받은 기준을 따른다 | 서버가 「유지 구간」 요청을 「전체 구간」으로 바꿔 줄 수 있어 요청한 값을 그대로 누를 수 없다 | 불러오는 동안 화살표 키를 누르면 초점이 아직 안 눌린 단추에 간다(선택지가 둘이라 해가 작다) | 요청한 기준을 누르되 서버가 바꿔 준 경우만 받은 값으로 |
| 요약 카드 표지가 p50 하나 | 목업(사용자 확인) | 좁은 폭에서 p99 카드가 다음 줄로 가면 표지와 떨어진다 | 응답 시간 카드 셋 모두에 표지 |
| 구획 `aria-label`에 표본 | 구획 이름을 바꾸면 기존 테스트·읽기 흐름이 바뀐다 | 구획 단위로 건너뛰는 읽기 프로그램 사용자는 표지를 구획 안에서 듣는다 | `aria-label`에 표본 이름 |

## 8. 열린 것 (plan에서 정한다)

- 툴팁 부품의 구조(`Segmented` 안 / 별도 부품)와 틈 견디기 시간.
- 구획 표지를 넘기는 prop 모양(`titleAside`가 있는 곳 / 맨 `<h3>`인 곳).
- 안내 상자의 `Callout` variant.

## 9. 사실 확인 명령 (claims-ledger)

```bash
# 표본 배관이 이미 있다
grep -n "runReport\|sample" ui/src/api/hooks.ts
# run 상세는 basis만 읽는다
grep -n "searchParams\|useRunReport" ui/src/pages/RunDetailPage.tsx
# ReportView·SampleBar·useRunReport가 쓰이는 곳(전수)
grep -rn "<ReportView\|<SampleBar\|useRunReport(" ui/src | grep -v __tests__
# 표본을 받는 부품(전수)
grep -rln "ReportSampleName\|reportSample" ui/src | grep -v __tests__
# 「—」 규칙의 지금 모양
grep -n 'latency.sample !== "all"' ui/src/components/report/*.tsx
grep -n "function workerLatency" -A5 ui/src/components/report/WorkerBreakdownTable.tsx
# 머리말·다른 기준 줄의 지금 규칙
grep -n "headlineLatency" -A2 ui/src/i18n/ko.ts
grep -n "noValue" ui/src/components/report/basisText.ts
# role=tooltip 부품 없음
grep -rln 'role="tooltip"' ui/src | grep -v __tests__
# Segmented: 설명 칸 없음 · 초점 이동 없음 · 쓰는 곳
grep -n "type Option" ui/src/components/ui/Segmented.tsx
grep -n "focus()\|useRef" ui/src/components/ui/Segmented.tsx
grep -rln "<Segmented" ui/src | grep -v __tests__
# 툴팁 폭
grep -n "TIP_WIDTH_PX" ui/src/components/helpTipPos.ts
# 스텝 구획의 기본 보기 · 워커 표 조건 · 분포 구획 조건
grep -n 'useState<View>' ui/src/components/report/StepPhaseBreakdown.tsx
grep -n "breakdown.length < 2" ui/src/components/report/WorkerBreakdownTable.tsx
grep -n "report.latency ?" ui/src/components/report/ReportView.tsx
# 인쇄 링크·내려받기 이름
grep -n "print?basis\|nameTag\|downloadJson" ui/src/components/report/ReportView.tsx
# 서버: 나눌 수 없는 run은 all · 모르는 값 400 · 분포는 값이 있을 때만
grep -n "filter(|s| split" crates/controller/src/report.rs
grep -n "fn parse_sample" -A10 crates/controller/src/api/runs.rs
grep -n "let latency = if !shown_h.is_empty()" crates/controller/src/report.rs
```

## 10. 1차 검토 지적 처리 (2026-11-24)

| 지적 | 처리 |
|---|---|
| 「—」가 `hasLatency` 단일 소스가 아니다(요약·머리말은 `all` 건너뜀, 워커 표는 제 규칙) | §1.1에 사실대로. R11을 「바꿔 봄」 조건으로 다시 씀. 워커 표는 §7 |
| `Segmented`는 초점을 옮기지 않는다 · 쓰는 곳 셋 | §1.1에 사실로. R17을 MUST로, 세 소비처 명시 |
| 인사이트의 포화 원인은 모든 요청 표본 | §1.1 문장 고침 |
| 「최악 0.23초」 | §3 문장 고침 |
| 서버 주장에 확인 명령 없음 | §9에 더함 |
| R10이 옛 run의 머리말을 바꾼다 | 「바꿔 봄」(`split && selected !== default`)을 정의하고 R7–R12·R14를 그 조건으로 |
| 불러오는 동안 눌린 단추·초점이 어긋난다 | R3: 눌린 단추 = 요청한 표본 |
| 툴팁: 툴팁 위로 못 옮김 · `aria-describedby` · 누른 뒤 떠 있음 | R5에 열림·닫힘 규칙과 숨은 설명 |
| 단계 분해 run의 기본 보기(폭포)는 표본을 안 따른다 | R9 ④를 표 보기로 좁히고 R9-1(폭포 안내) |
| 값 없는 표본에서 분포 구획이 사라진다 | R11-1 |
| 툴팁 폭 256 vs 224 | 224로(목업 고침) |
| 360px에 단추 셋이 안 들어갈 수 있다 | R18(묶음 안 줄바꿈) |
| 안내 문구 「내보내기」 vs JSON | 「인쇄·CSV·XLSX는…」 |
| JSON 이름에 표본만 붙이면 기준과 어긋난다 | JSON 이름을 바꾸지 않는다(§7) |
| US6 「응답 시간을 보여 주는 구획마다」 | 「표본에 따라 값이 바뀌는 구획마다」. 「실패 포함」 문구는 그대로(§5) |
| 라이브 「구획 표지 다섯」의 run 모양 | §6에 run 가–마를 정함 |
| `all`에 값이 없을 때 0 | R10·R11·R12에서 가림(나눌 수 있는 run만) |
| §4 그림이 카드 격자와 다르다 · 좁은 폭의 p99 | 그림 고침. 표지 하나는 목업대로, §7에 비용 |
| R16 grep 범위 · 구획 `aria-label` | R16 고침 · `aria-label`은 안 바꾼다(R9, §7) |

### 2차 검토 지적 처리 (2026-11-24)

| 지적 | 처리 |
|---|---|
| 기본 표본으로 돌아올 때 눌린 단추가 늦다 | R3: 주소에 없으면 `sample.default` |
| 안내 문구의 「표」 보기는 없는 이름 | 화면 이름 「막대」·「칩」으로 — `waterfallNote`·§1.1·R9·R9-1·R14·§6 |
| 실패가 전부 「보내지 않음」이면 「실패한 요청 없음」은 거짓 | `noFailedMeasured` — R10·R11-1·§5 |
| `:focus-visible`은 jsdom으로 못 본다 | R5 acceptance + US9 라이브 줄 |
| 숨은 설명은 단추 밖에 | R5 |
| `BasisBar`는 불러오는 동안의 어긋남이 남는다 | §7 |
| 불러오는 동안 단추와 설명이 다르다 | R4에 의도로 적음 |
| run 가의 워커 2 만드는 법 | §6 |

### 사용자 지적 (2026-11-24) — 「없음」 문구

「응답 시간을 잰 실패한 요청 없음」은 「왜 안 쟀지?」로 읽힌다(사용자). 이유를 말하는 문구로 바꿨다: 실패 표본 = 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」, 모든 요청 표본 = 「요청이 모두 보내기 전에 실패해 잰 시간이 없음」. 「보내기 전에 실패」는 화면의 「보내지 않음」(앞 스텝 값 없음 등으로 요청을 보내지 못한 오류)과 같은 뜻이다.

사용자 확인(2026-11-24): 풀어 쓴 쪽이 낫다. 모든 요청 표본의 문구는 「보낸 요청이 왜 없지?」가 남아 실패 표본과 같은 꼴(「요청이 모두 보내기 전에 실패해 잰 시간이 없음」)로 다시 고쳤다.
