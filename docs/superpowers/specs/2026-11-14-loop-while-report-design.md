# 조건 반복 2차 — 리포트 표시 설계

- 날짜: 2026-11-14 · 브랜치 `worktree-loop-while-report` · 유형 `user-path`
- 상태: 완료 (2026-11-14, 코드 `930e1b3d`..`e295d3c8`). 구현 중 바뀐 것: §4.1 표지 주석 정정(성공 회차에만 도는 if 안 스텝도 그 회차가 2번째 이후면 표지), 분포 막대 색(라이브 대비 실측). 판단·연기 → roadmap §B60.
- 앞 작업: 조건 반복 1차(`docs/superpowers/specs/2026-11-13-loop-do-while-design.md`, ADR-0056) — 이 문서는 그 부록 A 초안을 확정한다. **부록 A와 다른 점 하나**: 부록 A는 "deadline/취소로 잘린 진입은 세지 않는다"였지만, 이 문서는 잘린 진입도 따로 센다(§2 — 이유 포함).
- 관련 결정: ADR-0021(loop 집계는 counts-only)·0023(if 분기 집계)·0050(send 실패 종류 집계 — 이번 작업이 그대로 따르는 운반 길)·0056(조건 반복)
- 목업: `docs/superpowers/specs/2026-11-13-loop-do-while-mockups/report-options.html` (A·B·맨 위 안내를 채택, C는 3차)

## 사용자 스토리 (US)

원문(사용자, 2026-11-13, 1차 spec): 대기 응답은 상태 코드 200이라 성공 응답과 같은 스텝 행에 섞인다. 리포트에서 그 섞임을 알아볼 수 있어야 한다. 사용자 승인 2026-11-14.

- **US1 (스텝 행 표시와 풀이)**: QA가 조건 반복이 있었던 run의 스텝별 통계를 읽으려 한다 — 성공하면 조건 반복 본문 스텝 행에 「재시도 포함」 표시가 붙고, 그 아래에서 "1,812건 = 첫 시도 1,200 + 재시도 612 (34%) · 최대 횟수에 걸려 중단된 반복 12건" 풀이를 본다.
- **US2 (회차 분포)**: QA 또는 운영자가 계정 경합이 얼마나 심했는지 알려 한다 — 성공하면 조건 반복마다 "몇 번째 시도에서 끝났나" 막대를 건수·비율과 함께 본다. 재시도 없이 끝남, 재시도 후 끝남, 중단은 색과 글자로 구분되고, 21번째 이후는 한 줄로 합쳐진다.
- **US3 (맨 위 해석 주의)**: 리포트를 처음 여는 사람이 응답 시간·초당 요청 수를 그대로 믿으려 한다 — 성공하면 재시도가 1회 이상이거나 중단이 1건 이상인 run에서는 항상, 리포트 맨 위에서 어느 스텝의 요청 몇 %가 재시도인지와 그 숫자에 재시도가 섞여 있다는 안내를 본다.
- **US4 (기존 리포트 불변)**: QA가 조건 반복이 없는 run이나 2차 이전에 만든 run의 리포트를 연다 — 성공하면 화면과 리포트 JSON이 지금과 똑같다.

**US 문장은 승인된 그대로 두고, 본문이 구체화하면서 달라진 표현 네 가지**(설계 중 사용자에게 알림 — 최종 확인은 spec 인계 때):
1. US1의 풀이는 등식이 아니라 loop 단위 `진입 1,200 · 재시도 612 (본문 실행의 33.8%) · 중단 12 · 마치지 못함 3` 꼴이다(§4.2, §7-3·4).
2. US1의 표지는 실제로 2번째 이후 회차에서 요청된 본문 스텝에만 붙는다(§4.1).
3. US2·US3에 네 번째 분류 "마치지 못함"(run 종료·중지·오류로 조건 반복 도중에 끊긴 진입)이 더해진다. 그 진입의 재시도도 US3 안내의 "재시도"에 들어간다(§2).
4. US3 안내의 비율은 "스텝의 요청 몇 %"가 아니라 조건 반복 단위 "본문 실행 중 몇 %가 재시도"다(§4.4, §7-3). 본문이 스텝 하나이면 두 값은 거의 같다(요청을 보내기 전에 끊긴 회차만큼만 다르다).

## 1. 목표·비목표

**목표**: 워커가 조건 반복의 "진입 한 번이 본문을 몇 번 돌리고 어떻게 끝났는지"를 건수로 세어 컨트롤러에 보내고, 리포트 화면이 그 건수로 US1–US3을 그린다.

**지킬 조건 (R0)**: 조건 반복 집계가 한 건도 없는 run은 전 계층에서 지금과 같다 — 워커가 보내는 `MetricBatch` 바이트, 빈 flush를 건너뛰는 판단, DB 행, 리포트 JSON 글자(`loop_exits` 키 자체가 없음), 리포트 화면 DOM.

**비목표**
- 응답 시간을 "반복을 끝낸 응답 / 재시도로 이어진 응답"으로 나누기(목업 C) — 3차.
- CSV·XLSX 내보내기·인쇄 보고서·run 비교 — 사용자 결정(2026-11-13, 다시 묻지 않는다): 후속. 화면 리포트에만 표시한다. (리포트 JSON 내려받기는 리포트 JSON 그대로라 `loop_exits`가 자연히 들어간다.)
- 서버 유효성 등급(`validity`)·인사이트(`insights`)·SLO 판정에 재시도를 반영하지 않는다. 맨 위 안내는 화면이 `loop_exits`로 계산한다.
- 시험 실행·운영 모니터·TUI — trace 경로는 `Aggregator`를 쓰지 않으며 이번에 건드리지 않는다.
- 실행 중(진행 차트) 표시 — 리포트가 만들어진 뒤에만 보인다.
- 기존 스텝 행의 ▸ 토글(회차별 요청 수, `loop_breakdown`)은 그대로 둔다(§4.6).
- 실측 회차 분포를 사이징 도움말에 넘기기(1차 §9 연기) — 이번에도 연기(§8).

## 2. 무엇을 세는가

조건 반복(`while`이 있는 loop)에 **들어가 본문을 한 번이라도 시작한 진입**을 한 건으로 센다. 끝난 방식은 셋이다.

| 끝난 방식 (`outcome`) | 뜻 | 회차 수 p |
|---|---|---|
| 0 완료 | 본문을 p번 돌린 뒤 조건이 거짓 | 돌린 횟수 |
| 1 중단 | 본문을 최대 횟수 n번 돌린 뒤에도 조건이 참 → `EndIteration` | n |
| 2 마치지 못함 | 조건 반복이 스스로 끝나기 전에 밖에서 끊김 — run 종료 시각, 취소(사용자 중지·VU 곡선의 감소로 물러난 가상 사용자), 본문이 `Continue`가 아닌 흐름이나 `Err`를 돌려줌 | **시작한** 본문 횟수(끊긴 그 회차 포함) |

- 한 건마다 `(loop id, 회차 칸, outcome)` 건수 +1, 회차 합 +p.
- **회차 칸**: p가 1–20이면 p, 21 이상이면 21 한 칸("21번째 이후"). 상수 `LOOP_EXIT_PASS_CAP = 20`(엔진, 고정). run 설정 `loop_breakdown_cap`과 무관하다 — 그 값이 0(끄기)이어도 이 집계는 된다.
- **회차 합**은 칸과 별도로 실제 p를 더한다. 그래서 21번째 이후가 합쳐져도 "재시도 = 회차 합 − 진입 건수"가 정확하다.
- **마치지 못함을 세는 이유**: 최대 횟수가 없는 조건 반복이 끝내 풀리지 않으면 모든 진입이 run 종료에 끊긴다(1차 US2의 바로 그 경우). 이 진입들을 버리면 본문 요청의 거의 전부가 재시도인데도 집계가 0건이라 US3 안내가 안 뜬다. 또 가장 오래 재시도한 진입이 빠져 재시도 비율이 낮게 나온다.
- **세지 않는 것**: 본문을 시작하기 전에 끊긴 진입(p = 0 — 요청도 없다).
- **스텝 요청 수와의 관계**: 본문이 http 스텝 하나이고 분기가 없으면 `회차 합 − 그 스텝 요청 수`는 0 이상, "마치지 못함" 건수 이하다(끊긴 회차는 요청을 보내기 전에 끊겼을 수 있다). 본문에 스텝이 여럿이거나 if가 있으면 스텝별 요청 수는 회차 합보다 작을 수 있다.
- 안쪽 조건 반복이 중단되어 `EndIteration`이 바깥 조건 반복을 뚫고 나가면 바깥은 "마치지 못함"으로 센다. loop 안 loop은 UI 모델이 막으므로 손으로 쓴 YAML에서만 생긴다(그런 YAML은 화면에서 시나리오 파싱이 실패해 이름 대신 id로 보인다).
- 값은 건수뿐이다. 응답 본문·변수 값·주소는 싣지 않는다.

## 3. 운반 길 (send 실패 종류 집계와 같은 꼴)

기존 `error_kind` 길(ADR-0050)을 한 칸씩 따라간다. 구현 계획은 `grep -rn 'error_kind' crates`로 그 길의 모든 지점을 열거해 짝을 맞춘다.

### 3.1 엔진

- `aggregator.rs`: `pub const LOOP_EXIT_PASS_CAP: u32 = 20;` · `pub enum LoopExitOutcome { Completed, Exhausted, Truncated }`(와이어 값 0·1·2) · `pub struct LoopExitStat { step_id: String, pass_bucket: u32, outcome: LoopExitOutcome, count: u64, pass_sum: u64 }` · `Aggregator`에 `loop_exit_counts: HashMap<(String, u32, LoopExitOutcome), (u64, u64)>` · `record_loop_exit(&mut self, loop_id: &str, passes: u32, outcome: LoopExitOutcome)`(`passes == 0`이면 아무것도 안 함, 칸 = `passes.min(LOOP_EXIT_PASS_CAP + 1)`) · `drain_loop_exit_deltas(&mut self) -> Vec<LoopExitStat>`.
- `runner.rs::execute_steps`의 조건 반복 가지(`if let Some(cond) = lp.while_.as_ref()`), 기록 지점 다섯 곳:
  1. 조건이 거짓이어서 `break` 직전 → `(pass, Completed)`
  2. `pass >= n`이어서 `EndIteration` 반환 직전 → `(pass, Exhausted)`
  3. 회차 머리의 deadline 반환 직전 → `(pass, Truncated)`(pass는 끝낸 회차 수 — `pass > 0`일 때만, 잠금을 잡기 전에 검사)
  4. 회차 머리의 취소 반환 직전 → `(pass, Truncated)`(같은 `pass > 0` 검사)
  5. 본문 호출이 비-`Continue` 흐름 또는 `Err`를 돌려줘 그대로 반환하기 직전 → `(pass.saturating_add(1), Truncated)`(끊긴 회차 포함). `?`를 `match`로 풀어 `Err`에서도 기록한 뒤 같은 에러를 돌려준다.
  잠금은 if 가지의 `record_branch`처럼 블록으로 감싸 곧바로 놓는다. 흐름·반환값·실행 순서는 바꾸지 않는다.
- `MetricFlush`에 `loop_exit_stats: Vec<LoopExitStat>` 추가. drain 6곳(세 실행 방식 × 주기·마지막) 모두에서 싣고, **"비어 있으면 보내지 않음" 가드 5곳 전부**에 `loop_exit_stats`가 비었는지를 더한다 — 세 방식의 주기 flush + closed·VU 곡선의 마지막 flush(open-loop의 마지막 flush는 조건 없이 보낸다). `crates/engine/CLAUDE.md`의 "6드레인+5가드" 규칙 그대로.
- `lib.rs`에서 `LoopExitStat`·`LoopExitOutcome`·`LOOP_EXIT_PASS_CAP` 재수출.

### 3.2 proto·워커

- `coordinator.proto`: `message LoopExitStat { string step_id = 1; uint32 pass_bucket = 2; uint32 outcome = 3; uint64 count = 4; uint64 pass_sum = 5; }`(`outcome` 0 완료·1 중단·2 마치지 못함) · `MetricBatch`에 `repeated LoopExitStat loop_exit_stats = 11;`.
- 워커 `lib.rs`: 변환 함수 + "전부 비었으면 건너뜀" 조건에 `&& loop_exit_stats.is_empty()` + `MetricBatch` 리터럴에 필드.
- 버전 섞임: 조건 반복을 실행할 수 있는 워커는 1차 이후 것뿐이고 1·2차는 같이 릴리즈하므로, 필드 없는 워커가 조건 반복을 도는 경우는 릴리즈 전 개발 빌드뿐이다(그 run은 표시 없이 US4와 같은 모습). 옛 컨트롤러는 모르는 필드를 무시한다.

### 3.3 컨트롤러

- migration **0023** `run_loop_exit_metrics`(`/new-migration`으로 번호 재확인), `0020` 꼴: `run_id TEXT NOT NULL, step_id TEXT NOT NULL, pass_bucket INTEGER NOT NULL, outcome INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, pass_sum INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, step_id, pass_bucket, outcome)`. `CREATE TABLE IF NOT EXISTS`(멱등 `.sql`).
- `store/metrics.rs`: `LoopExitRow` · `insert_loop_exit_batch`(충돌 시 `count`·`pass_sum` 누적 — 여러 워커·여러 flush의 델타가 합쳐진다) · `loop_exit_breakdown(db, run_id)`(`ORDER BY step_id, pass_bucket, outcome`).
- `grpc/coordinator.rs` ingest: `batch.loop_exit_stats` → `insert_loop_exit_batch`(실패는 다른 집계처럼 `warn!`). 워커 입력은 믿지 않는다 — `pass_bucket`은 `1..=21`로 `clamp`, `outcome`이 0–2 밖인 항목은 버린다(행 수가 loop당 최대 63으로 묶인다).
- `store/scenarios.rs`의 시나리오 삭제 cascade 목록에 `run_loop_exit_metrics` 추가(ADR-0045) + 그 테스트. 목록 위 주석 "7테이블"과 `crates/controller/CLAUDE.md`의 "현 7개"를 8로.
- 코드의 `pb::MetricBatch { … }` 리터럴 전부에 새 필드(prost 구조체는 전 필드 나열).

### 3.4 리포트 JSON

`ReportJson`에 `error_kinds` 바로 뒤:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub loop_exits: Vec<LoopExit>,
```

```json
"loop_exits": [
  { "step_id": "<loop id>", "entered": 1200, "passes": 1812, "exhausted": 12, "truncated": 3,
    "buckets": [
      { "pass": 1, "completed": 816, "exhausted": 0, "truncated": 1 },
      { "pass": 5, "completed": 12,  "exhausted": 12, "truncated": 0 },
      { "pass": null, "completed": 3, "exhausted": 0, "truncated": 2 }
    ] }
]
```
(`buckets`는 일부 칸만 적은 예시다.)

- `entered` = 건수 합(세 방식 전부), `passes` = 회차 합, `exhausted`·`truncated` = 그 방식의 건수 합.
- `buckets`: 건수가 있는 칸만, `pass` 오름차순. `pass`는 **1부터**(기존 `loop_index`는 0부터 — 다르다). "21번째 이후"는 `pass: null`로 맨 끝이고 `null`을 그대로 직렬화한다(`skip_serializing_if` 없음).
- 배열은 `step_id` 오름차순. 행이 없으면 키를 내지 않는다(R0).
- `build_report`에 인자 `loop_exits: &[LoopExitRow]` 추가 — 호출부(코드·테스트) 전부 갱신. `api/runs.rs`의 `build_report_for_run`이 `loop_exit_breakdown`을 읽어 넘긴다(이 함수는 리포트 JSON·내보내기·종료 시 판정 저장이 같이 쓴다 — 새 조회가 실패하면 기존 조회 실패와 같은 경로로 처리된다).
- `ReportJson { … }` 리터럴을 짓는 곳(`export.rs`의 테스트 픽스처 포함)에 `loop_exits: vec![]`. 내보내기 **출력**과 `validity`·`insights`는 바꾸지 않는다.

## 4. 화면

`ReportView` 한 곳에서만 그린다(`RunDetailPage`가 유일한 마운트). 모든 표시는 `report.loop_exits`에 그 loop의 항목이 있을 때만 나온다 — 시나리오 YAML에 조건 반복이 있어도 집계가 없으면 아무것도 안 그린다(US4).

숫자는 `toLocaleString("en-US")`, 비율은 기존 `floorPct`(소수 한 자리, 예 `33.8%`). 이 문서의 예시 숫자는 그 형식으로 적었다. 문구는 전부 `ko.ts` 경유(ADR-0035)이고 아래 예시 문장이 문구 정본이다.

### 4.1 계산 (순수 함수 `loopExitView.ts`)

입력: `report.loop_exits`, `report.steps`, 파싱된 시나리오 모델. 출력: loop마다
- `name`(loop 스텝 이름, 못 찾으면 `step_id`), `maxPasses`(YAML `repeat`, 없으면 `null`),
- `entered`, `retries = passes − entered`, `retryPct = retries / passes × 100`(passes 0이면 0), `exhausted`, `truncated`,
- `retriedStepIds` — 「재시도 포함」을 붙일 스텝. 그 loop `do` 안의 http 스텝(`flattenHttpSteps(loop.do)` — if 분기 안 포함) 중:
  - 그 스텝의 `loop_breakdown`이 비어 있지 않으면: `loop_index`가 0이 아닌 줄(상한 초과 줄 `null` 포함)의 요청 수 합이 1 이상인 스텝만(= 실제로 2번째 이후 회차에서 요청된 스텝. 1번째 회차에서만 요청된 스텝은 빠진다 — 성공 회차에만 도는 if 안 스텝도 그 회차가 2번째 이후였으면 표지가 붙는다),
  - 비어 있으면(run의 루프 집계 상한이 0): `retries > 0`인 loop의 본문 스텝 전부.
- `rows` = 분포 줄(4.3).

시나리오 파싱이 실패하면 이름은 `step_id`, `retriedStepIds`는 빈 집합(표지만 빠지고 나머지는 그린다).

### 4.2 US1 — 스텝 행 표지 + 풀이

- **표지**: `retriedStepIds`에 든 스텝의 이름 옆에 작은 표지 **「재시도 포함」**. 표 보기(`StepStatsTable`의 이름 칸)와 막대 보기(`StepPhaseBreakdown`의 행 이름 — 구간 측정을 켠 run의 기본 보기) 둘 다. 막대 보기에서는 표지를 고정 폭 이름 칸(`w-40`) **안**에 둔다 — 칸 안에서 이름이 먼저 말줄임되고 표지는 줄지 않는다. 칸 밖에 두면 표지가 있는 행만 막대가 좁아져 행 사이 막대 정렬이 어긋난다.
- **풀이 줄**(새 `LoopExitSummary`): 스텝별 통계 바로 아래, 보기 전환과 무관하게 항상(`ReportView`에서 `StepPhaseBreakdown` 다음에 렌더). loop마다 한 줄:
  `조건 반복 「주문 재시도」 — 진입 1,200 · 재시도 612 (본문 실행의 33.8%) · 중단 12 · 마치지 못함 3`
  - ` · 마치지 못함 3`은 1건 이상일 때만 붙는다. 중단이 0이어도 `· 중단 0`은 쓴다(자리 고정).
  - 줄 끝 도움말(HelpTip): "진입 = 이 조건 반복에 들어간 횟수. 재시도 = 2번째 이후 본문 실행을 시작한 횟수. 중단 = 최대 횟수까지 조건이 풀리지 않아 이번 시나리오 반복을 끝낸 횟수. 마치지 못함 = run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊긴 횟수."
- `StepStatsTable`·`StepPhaseBreakdown`에는 선택 prop(`retriedStepIds?: ReadonlySet<string>`)만 더한다. 없거나 비면 DOM은 지금과 같다.

### 4.3 US2 — 회차 분포 패널 (새 `LoopExitPanel`)

- 위치: `BranchStatsTable` 바로 뒤(제어 흐름 집계끼리 이웃). `loop_exits`가 비면 렌더하지 않는다.
- 제목 `조건 반복`, loop마다 소제목 `「주문 재시도」 — 진입 1,200회가 몇 번째 시도에서 끝났나`.
- 줄(건수 > 0인 것만, 이 순서). 한 줄 = 라벨 · 막대(폭 = 건수/진입) · `816 · 68.0%`:
  1. `1번째` — 완료 건수(분류: 재시도 없이 끝남)
  2. `2번째` … `20번째`, `21번째 이후` — 그 칸의 완료 건수(분류: 재시도 후 끝남)
  3. `중단` — 모든 칸의 중단 합. 줄 아래 풀이 `최대 5번까지 조건이 풀리지 않아 이번 반복을 끝냄`(`maxPasses`가 `null`이면 `최대 횟수까지 …`)
  4. `마치지 못함` — 모든 칸의 마치지 못함 합. 줄 아래 풀이 `run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊김`
- 색과 글자 둘 다로 구분한다: 네 분류에 색을 하나씩 주고, 패널 아래 범례가 색 조각 + 글자로 대응을 적는다(`1번째 = 재시도 없이 끝남` · `2번째 이후 = 재시도 후 끝남` · `중단` · `마치지 못함`, 그 run에 있는 분류만). 막대는 `role="img"` + `aria-label`에 라벨·분류·건수·비율(예 `2번째, 재시도 후 끝남, 240건, 20.0%`).
- 색은 디자인 시스템 토큰·기존 리포트 팔레트에서 고른다(재시도 없음 = 차분한 색, 재시도 후 = 주의 색, 중단 = 경고 색, 마치지 못함 = 회색).
- 한 loop의 줄은 최대 23줄이라 접지 않고 그대로 보인다.

### 4.4 US3 — 맨 위 해석 주의 (새 `LoopRetryNotice`)

- 위치: `ValidityBanner` 바로 아래(유효성 → 재시도 주의 → 판정 순).
- 조건: `retries ≥ 1` 또는 `exhausted ≥ 1`인 loop이 하나라도 있으면 항상(사용자 결정 — 비율 문턱 없음). 없으면 렌더하지 않는다. `마치지 못함`만 있고 재시도·중단이 0인 loop은 대상이 아니다.
- 내용(`Callout` 주의 모양):
  - 머리: 재시도 합이 1 이상이면 `해석 주의 · 조건 반복의 재시도가 섞여 있습니다`, 재시도는 0이고 중단만 있으면 `해석 주의 · 최대 횟수에서 중단된 조건 반복이 있습니다`.
  - loop마다 한 줄(재시도 비율 내림차순, 같으면 중단 내림차순, 최대 3줄, 넘치면 `외 N개 조건 반복`):
    - 재시도가 있으면 `「주문 재시도」: 본문 실행 1,812회 중 612회(33.8%)가 재시도` + 중단이 있으면 ` · 최대 횟수에 걸려 중단된 반복 12건`
    - 재시도가 0이고 중단만 있으면(`repeat: 1`) `「주문 재시도」: 최대 횟수에 걸려 중단된 반복 12건`
  - 꼬리(재시도 합이 1 이상일 때만): `해당 스텝과 전체 응답 시간·초당 요청 수에는 재시도 응답이 포함돼 있습니다.`
- 서버 `validity` 등급과 `ReportHeadline`은 바꾸지 않는다.

### 4.5 와이어 거울

`ui/src/api/schemas.ts`: `LoopExitBucketSchema`(`pass: z.number().int().nullable()`, 세 건수)·`LoopExitSchema` 둘 다 `.strict()`(`ReportSchema`가 `.strict()`), `ReportSchema`에 `loop_exits: z.array(LoopExitSchema).optional()`(서버가 빈 배열을 생략).

### 4.6 기존 회차별 요청 수 토글과의 관계

조건 반복 본문 스텝은 지금도 `loop_index`별 요청 수가 모이고(루프 집계 상한이 0이 아니면), 스텝 행의 ▸ 토글이 그것을 0부터 센 `loop_index` 표로 보여 준다. 이번 작업은 그 토글을 바꾸지 않는다. 둘은 다른 것을 센다 — 토글은 **스텝 요청 수를 회차별로**, 새 패널은 **진입이 끝난 회차를**. 4.1의 표지 판정만 그 데이터를 읽는다. 토글 라벨을 1부터 세는 "N번째"로 맞추는 일은 §8 연기.

## 5. 검증 계획

**단위·통합(이빨 실증 포함 — 고의로 망가뜨려 RED를 본 뒤 되돌린다)**
- 엔진 `Aggregator`: 칸 경계(20 → 20, 21 → 21, 500 → 21)·회차 합은 실제 값·`passes == 0`은 기록 없음·drain 뒤 비움.
- 엔진 runner — 기록 지점마다 결정적인 테스트 하나씩, 각각 "그 지점의 기록을 지우면 RED"를 실증한다:
  - 지점 1: 2번째에 풀림 → `(id, 2, 완료)` 1건·합 2.
  - 지점 2: 최대 3에서 안 풀림 → `(id, 3, 중단)` 1건·합 3.
  - 지점 3: think time 없는 본문 + 끝내 안 풀리는 무제한 조건 반복 + 짧은 deadline + 고정 지연 응답기 → 회차 머리에서 끊겨 `마치지 못함`, 회차 합 = 보낸 요청 수.
  - 지점 4: 회차 사이에 취소 토큰을 취소 → `마치지 못함`.
  - 지점 5 (`Err`): 2번째 회차에서 캐스트가 실패하는 본문 스텝 → 에러가 전과 같이 전파되고(가상 사용자 종료 또는 에러 결과) `(id, 2, 마치지 못함)` 1건.
  - 지점 5 (비-`Continue`): 본문 think time 도중 deadline 또는 취소 → `(끝낸 회차 + 1, 마치지 못함)`.
  - 본문 시작 전 끊김 → 0건. `while` 없는 loop·조건 반복 없는 시나리오 → `loop_exit_stats` 빈 채.
  - 조건 반복 집계만 든 flush가 버려지지 않음(가드 5곳).
  - 1차의 기존 조건 반복 테스트 전부 green(반환 흐름 불변).
- 워커: 변환 + 조건 반복 집계만 있는 flush를 건너뛰지 않음.
- 컨트롤러: upsert 누적(두 번 넣으면 합)·`pass_bucket` clamp·범위 밖 `outcome` 버림·시나리오 삭제 cascade·`build_report`의 칸 합산과 정렬·`pass: null` 직렬화·행이 없으면 JSON에 `loop_exits` 글자가 없음.
- UI: `loopExitView` 계산(표지 판정 두 갈래 포함)·세 컴포넌트 렌더·`loop_exits`가 없을 때 `ReportView`/`StepStatsTable`/`StepPhaseBreakdown` DOM 불변·Zod가 `pass: null`을 받고 모르는 키를 거부.

**라이브(`/live-verify`, 필수 — 엔진·리포트 경로)**

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 일정 비율로 대기 응답을 주는 응답기 + 본문 스텝 하나·최대 5회 조건 반복 시나리오로 run → 리포트. 구간 측정을 켠 run도 1회(막대 보기) | 본문 스텝 행에 「재시도 포함」(표 보기·막대 보기), 통계 아래 풀이 줄. `0 ≤ 회차 합 − 스텝 요청 수 ≤ 마치지 못함` |
| US2 | 같은 run + 무제한 조건 반복 run(같은 가상 사용자에게 25번째 요청부터 성공을 주는 응답기) | 분포 줄의 건수 합 = 진입, 중단 줄이 응답기 설정과 맞는 규모, 무제한 run에서 `21번째 이후` 한 줄 |
| US3 | ① 같은 run ② 끝내 대기만 주는 응답기 + 무제한 조건 반복 run ③ 재시도가 한 번도 없는 조건 반복 run | ①② 안내가 뜬다(②는 `마치지 못함`뿐이어도 재시도 비율이 높게). ③ 안내·표지는 없고 풀이 줄·분포 `1번째 100.0%`는 보인다 |
| US4 | 조건 반복 없는 시나리오 run + 이 작업 전 DB에 있던 run의 리포트 | `loop_exits` 키 없음, 화면에 새 요소 0개 |

- 여러 워커(fan-out) run 1회: 워커별 델타가 합쳐져 `entered`가 전체 진입 수와 맞는지.
- open-loop run 1회: 집계가 실리고 숫자 관계가 유지되는지.
- 극단값(작업 규칙 §4): 조건 반복 3개 이상·이름 60자·23줄 분포·진입 수백만 단위 숫자에서 겹침·잘림 없음을 사각형 교차와 `scrollWidth`로 실측. 좁은 창 폭에서도, 막대 보기의 표지도.

## 6. 보안 메모

새로 옮기는 값은 loop 스텝 id와 건수뿐이다(응답·변수·주소 없음). 워커 → 컨트롤러 입력 `pass_bucket`은 clamp, `outcome`은 범위 검사, `step_id`는 기존 집계들과 같은 취급(검증 없이 저장 — 선재). 워커가 지어낸 `step_id`로 행을 불릴 수 있는 것은 `run_if_metrics`·`run_error_kind_metrics`와 같은 선재 성질이며 이번에 넓히지 않는다. `finish-slice` §0 grep이 최종 판단한다.

## 7. 문서·결정 기록

- ADR-0056에 "리포트 집계" 절을 덧붙인다(새 ADR 없음 — 운반 방식은 ADR-0021/0050의 counts-only를 그대로 따름).
- `crates/controller/CLAUDE.md`(cascade 목록 수)·`crates/engine/CLAUDE.md`(드레인·가드 목록에 한 줄).

**사용자 결정(다시 묻지 않는다)**: 화면은 A+B+맨 위 안내 · 안내는 재시도가 있으면 항상 · 내보내기/인쇄/비교는 후속 · US 4개(2026-11-14).

**내가 정한 것**
1. run 종료·취소 등으로 끊긴 진입도 `마치지 못함`으로 센다(부록 A 초안과 다름 — §2의 이유).
2. 「재시도 포함」 표지는 실제로 2번째 이후 회차에서 요청된 스텝에만(회차별 요청 수가 있으면 그것으로, 없으면 재시도가 있는 loop의 본문 스텝 전부).
3. 풀이·안내의 비율은 loop 단위 "본문 실행 중 재시도 비율"(= 재시도 / 회차 합). 목업의 "요청의 34%"는 본문이 스텝 하나일 때만 같은 값이다.
4. 스텝 요청 수를 "첫 시도 + 재시도"로 푸는 등식(목업 A)은 쓰지 않고 loop 단위 "진입 · 재시도 · 중단"으로 쓴다(1차 부록 A의 표현) — 본문 스텝이 여럿이면 등식이 성립하지 않는다.
5. 비율 형식은 기존 `floorPct`(소수 한 자리).
6. 분포 패널은 접지 않는다(loop당 최대 23줄). 안내는 최대 3줄 + "외 N개".
7. 중단만 있고 재시도가 0인 경우(`repeat: 1`)의 안내 문구.
8. 풀이 줄을 표 안이 아니라 스텝 통계 아래 별도 블록으로(막대 보기에서도 보이게).
9. 리포트 JSON 모양·테이블 이름·`outcome` 숫자 값.
10. 새 줄의 숫자는 천 단위 쉼표를 쓴다. 기존 스텝 표의 요청 수 칸(쉼표 없음)은 R0라 그대로 둔다.

## 8. 연기 (roadmap §B 새 블록 — 번호는 작성 시 `grep -n '^### B' docs/roadmap.md` 마지막 +1)

- 3차: 응답 시간 분리(목업 C).
- 내보내기(CSV·XLSX)·인쇄·비교에 조건 반복 집계 — 연기 조건: "화면 리포트에만 표시".
- 실측 회차 분포를 사이징 도움말에(1차 §9) — 해소: `loop_exits.passes / entered`를 반복당 요청 수 추정에.
- 유효성 등급·인사이트에 재시도 반영(예: 중단 비율이 높으면 `limited`) — 수요가 보이면.
- 실행 중 표시.
- 기존 ▸ 토글의 `loop_index` 라벨(0부터)을 새 패널의 "N번째"(1부터)와 맞추기, 스텝 표 요청 수 칸의 천 단위 쉼표 — 기존 화면 변경이라 따로.

## 9. 사실 주장과 확인 명령

| 주장 | 명령 |
|---|---|
| `MetricBatch`의 마지막 필드 번호는 10 | `grep -n 'message MetricBatch' -A12 crates/proto/proto/coordinator.proto` |
| 다음 migration 번호는 0023 | `ls crates/controller/src/store/migrations/` + `grep -oE 'migration [0-9]{4}' crates/controller/src/store/mod.rs` |
| 조건 반복 가지의 반환 지점은 `runner.rs`의 `if let Some(cond) = lp.while_.as_ref()` 안 다섯 곳 | `grep -n 'lp.while_.as_ref()' -A60 crates/engine/src/runner.rs` |
| drain 6곳·가드 5곳 | `grep -n 'drain_error_kind_deltas' crates/engine/src/runner.rs` (6) · `grep -n 'error_kind.*is_empty()' crates/engine/src/runner.rs` (가드 5줄 + open-loop 마지막 flush의 "가드 없음" 주석 1줄) |
| 워커의 "전부 비었으면 건너뜀" 조건 | `grep -n 'error_kind_stats.is_empty()' crates/worker/src/lib.rs` |
| 시나리오 삭제 cascade 목록 | `grep -n 'run_error_kind_metrics' crates/controller/src/store/scenarios.rs` |
| `ReportView` 마운트는 한 곳 | `grep -rn '<ReportView' ui/src --include='*.tsx'` (테스트 제외 1건) |
| `StepStatsTable` 호출은 `StepPhaseBreakdown`의 2곳, 막대 보기는 표를 안 그린다 | `grep -n '<StepStatsTable' ui/src/components/report/*.tsx` |
| `error_kinds`는 `skip_serializing_if = "Vec::is_empty"` + UI `.optional()` | `grep -n 'error_kinds' crates/controller/src/report.rs ui/src/api/schemas.ts` |
| 조건 반복 본문은 `loop_index = Some(pass)`로 기록된다 | `grep -n 'Some(pass)' crates/engine/src/runner.rs` |
| trace 경로는 `Aggregator`를 쓰지 않는다 | `grep -n 'Aggregator\|record_branch' crates/engine/src/trace.rs` (머리 주석 "no Aggregator" 1줄뿐) |
