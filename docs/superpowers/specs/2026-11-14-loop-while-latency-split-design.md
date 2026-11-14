# 조건 반복 3차 — 응답 시간 분리 설계

- 날짜: 2026-11-14 · 브랜치 `worktree-loop-while-latency-split` · 유형 `user-path`
- 상태: 완료 (2026-11-15, 코드 `3b122944`..`84e407e2`). 구현 중 더한 것: 건수 0인 갈래의 백분위 0 강제·합산 포화, 막대 보기에서 `loop_split` 없는 스텝의 DOM을 작업 전 그대로 고정하는 테스트. 판단·연기 → roadmap §B61.
- 앞 작업: 조건 반복 1차(`2026-11-13-loop-do-while-design.md`, ADR-0056)·2차(`2026-11-14-loop-while-report-design.md`). 이 문서는 2차가 미뤄 둔 목업 C를 확정한다.
- 목업: `docs/superpowers/specs/2026-11-13-loop-do-while-mockups/report-options.html`의 C안.
- 관련 결정: ADR-0056(조건 반복)·0012(워커가 사전 집계)·B7-C 구간별 응답 시간 길(`phase_stats`).

## 사용자 스토리 (US)

원문(사용자, 2026-11-14): "응답 시간 분리가 맞아, 목업 C 그대로 진행해". 사용자 승인 2026-11-14.

- **US1 (성공 응답만의 응답 시간)**: QA가 조건 반복이 있었던 run에서 진짜 성공 호출이 얼마나 빨랐는지 알려 한다 — 성공하면 「재시도 포함」 스텝 행 아래 「└ 반복을 끝낸 응답」 줄에서 그 응답들만의 요청 수·에러·p50·p95·p99를 본다(목업 예: 1,200건, p50 182ms).
- **US2 (대기 응답의 응답 시간)**: QA 또는 운영자가 재시도 응답이 스텝 숫자를 얼마나 끌어내렸는지 알려 한다 — 성공하면 그 아래 「└ 재시도로 이어진 응답」 줄에서 같은 칸을 보고(목업 예: 612건, p50 12ms), 두 줄의 요청 수 합이 스텝 행의 요청 수와 같다.
- **US3 (기존 리포트 불변)**: QA가 조건 반복이 없는 run, 재시도가 한 번도 없었던 run, 이 작업 전에 만든 run의 리포트를 연다 — 성공하면 화면과 리포트 JSON이 지금과 똑같다(나뉜 줄이 없다).

**사용자가 승인한 구체화 네 가지** (2026-11-14)

1. 나누는 기준은 회차다. 조건이 풀려 반복을 끝낸 회차의 응답 = 「반복을 끝낸 응답」, 그 밖의 회차 = 「재시도로 이어진 응답」. 본문에 스텝이 여럿이면 스텝마다 같은 기준으로 나뉜다.
2. 최대 횟수에 걸려 중단된 진입의 마지막 회차, run 종료·중지·오류로 끊긴 회차의 응답은 「재시도로 이어진 응답」 쪽이다. 「반복을 끝낸 응답」은 조건이 풀린 회차의 응답만 담는다.
3. 화면 리포트에만 표시한다. CSV·XLSX·인쇄·run 비교·SLO 판정·유효성 등급은 건드리지 않는다.
4. 2차의 표지·풀이 줄·회차 분포·맨 위 안내는 그대로 둔다.

## 1. 목표·비목표

**목표**: 워커가 조건 반복 본문에서 받은 응답의 응답 시간을 "그 회차가 어떻게 끝났는지"에 따라 두 갈래로 따로 모으고, 리포트 화면이 스텝 행 아래 두 줄로 보여 준다.

**지킬 조건 (R0)**: 조건 반복(`while`이 있는 loop)이 없는 시나리오의 run은 전 계층에서 지금과 같다 — 워커가 보내는 `MetricBatch` 바이트, DB 행, 리포트 JSON 글자, 리포트 화면 DOM. 처리량도 측정 오차 안에서 같다(§6.4).

**비목표**

- CSV·XLSX 내보내기·인쇄 보고서·run 비교에 나뉜 값 넣기(승인 3). 리포트 JSON 내려받기에는 `loop_split`이 자연히 들어간다.
- SLO 판정·유효성 등급·인사이트에 "반복을 끝낸 응답"의 응답 시간을 쓰기.
- 초 단위 시계열·응답 시간 분포 차트를 두 갈래로 나누기. 스텝 표의 숫자만 나눈다.
- 갈래별 상태 코드 분포·전송 실패 종류. 요청 수와 에러 수만 낸다.
- 시험 실행·운영 모니터·TUI. trace 경로(`trace.rs`)는 `Aggregator`를 쓰지 않으며 건드리지 않는다.
- 2차 화면 요소(표지 규칙·풀이 줄·분포 패널·맨 위 안내)의 변경(승인 4).

## 2. 무엇을 나누는가

조건 반복 본문에서 기록된 http 응답 한 건(= 지금 `Aggregator::record`가 한 번 불리는 것)마다, 그 응답이 속한 **회차**가 끝나는 시점에 갈래를 정한다.

| 회차가 끝난 방식 | 엔진이 세는 갈래 | 화면 줄 |
|---|---|---|
| 본문이 끝까지 돌고 조건이 거짓(반복 종료) | 끝냄 | 반복을 끝낸 응답 |
| 본문이 끝까지 돌고 조건이 참 → 다음 회차로 | 이어짐 | 재시도로 이어진 응답 |
| 본문이 끝까지 돌고 조건이 참인데 최대 횟수 → `EndIteration` | 끊김 | 재시도로 이어진 응답 |
| 본문이 `Continue`가 아닌 흐름이나 `Err`를 돌려줌(run 종료 시각·취소·오류) | 끊김 | 재시도로 이어진 응답 |

- 엔진은 세 갈래로 세고, 화면은 "이어짐 + 끊김"을 한 줄(「재시도로 이어진 응답」)로 합쳐 보여 준다(승인 2).
- **"이어짐"을 "끊김"과 따로 세는 이유**: 두 줄을 보여 줄지는 "이어짐"이 1건 이상인지로 정한다(§3.3). "끊김"만으로 보여 주면, 모든 반복이 1번째 회차에서 끝난 run에서도 run 종료 시각이 본문의 think time 도중에 온 회차 하나 때문에 두 줄이 나타난다 — 재시도가 없었는데 "재시도로 이어진 응답 3건"이 보이고(US3 위반), 바로 아래 2차 풀이 줄의 "재시도 0"과 어긋난다. "이어짐 ≥ 1"은 2차의 재시도 정의(2번째 이후 회차를 시작함)와 같은 뜻이다.

- 회차 단위다. 본문에 http 스텝이 여럿이면 한 회차의 응답 전부가 같은 갈래로 간다.
- 응답 한 건은 정확히 한 갈래에 한 번 들어간다(예외: 아래 회차 표본 상한). 그래서 스텝마다 `끝낸 응답 요청 수 + 재시도 요청 수 = 스텝 요청 수`, 에러 수도 같다.
- 응답 시간 값은 `Aggregator::record`에 넣는 값과 같다(`outcome.latency`, µs). 에러 여부도 같은 값(`outcome.error.is_some()`).
- 조건 반복 안의 while 없는 loop·if·parallel은 바깥 조건 반복의 회차에 속한다. 조건 반복 안의 조건 반복(손으로 쓴 YAML만 가능 — UI 모델이 막는다)은 안쪽 조건 반복의 회차로 나눈다.
- **회차 표본 상한** `LOOP_SPLIT_PASS_SAMPLE_CAP = 1024`(엔진, 고정): 한 회차에서 1,024건을 넘는 응답은 갈래에 넣지 않는다(스텝 행 숫자는 그대로). UI로 만든 시나리오는 한 회차의 응답 수가 본문 http 스텝 수를 넘지 않으므로 닿지 않는다. 손으로 쓴 YAML(조건 반복 안에 횟수가 큰 loop)에서만 닿으며, 그때는 두 줄의 합이 스텝 요청 수보다 작다. 회차가 끝나기 전에는 갈래를 알 수 없어 응답을 버퍼에 쥐고 있어야 하므로, 메모리를 묶기 위한 상한이다.
- 값은 응답 시간과 건수뿐이다. 응답 본문·변수 값·주소는 싣지 않는다.

## 3. 운반 길 — 기존 구간별 응답 시간 길을 그대로 쓴다

새 통신 필드·새 DB 테이블·새 드레인 벡터를 만들지 않는다. 다운로드·대기 시간이 다니는 `phase_stats` 길(`Aggregator::record_phase` → `MetricFlush.phase_stats` → proto `PhaseStat` → `run_phase_metrics` → `build_report`)에 구간 이름 여섯 개를 더한다.

| 구간 이름 (`phase`) | 담는 것 |
|---|---|
| `loop_final` | "끝냄" 회차 응답 전부의 응답 시간 |
| `loop_retry` | "이어짐" 회차 응답 전부의 응답 시간 |
| `loop_cut` | "끊김" 회차 응답 전부의 응답 시간 |
| `loop_final_err`·`loop_retry_err`·`loop_cut_err` | 각 갈래에서 에러인 응답의 응답 시간 |

- 에러 수는 `*_err` 구간의 `count`로 읽는다(`PhaseStat`에는 에러 칸이 없다). `*_err`의 히스토그램은 쓰지 않는다.
- 이 길을 고른 이유(내 결정): `phase`는 이미 "스텝 하나의 이름 붙은 응답 시간 분포"이고, `dns`·`connect`·`wait`를 같은 방식으로 더한 선례가 있다(엔진 CLAUDE.md "새 phase 문자열은 기존 채널 재사용"). 전용 길을 새로 내면 2차처럼 proto 필드·migration·드레인 6곳·송신 가드 5곳·워커 건너뜀 가드·삭제 연쇄 목록을 다시 건드려야 한다. 대가: ① 에러 수를 구간 이름으로 실어 나르는 것이 약간 어색하고, 에러 응답마다 히스토그램 기록이 한 번 더 든다. ② 조건 반복이 있는 run은 `measure_phases`를 켜지 않아도 `run_phase_metrics` 행이 쌓인다 — 워커마다, flush(500ms)마다 본문 스텝 하나에 최대 3행(에러가 있으면 최대 6행), 행마다 히스토그램 BLOB. 리포트를 만들 때 그만큼 더 풀어 합친다. `*_err` 행의 BLOB은 저장만 되고 읽히지 않는다. §6.4에서 DB 크기와 리포트 생성 시간을 잰다.
- 모르는 구간 이름은 지금 컨트롤러의 모든 소비처가 무시한다(`build_report`는 `download`·`wait`·`dns`·`connect`만 이름으로 고른다). 그래서 새 워커 + 옛 컨트롤러는 리포트가 지금과 같고, 옛 워커 + 새 컨트롤러는 나뉜 줄이 없다.
- 구간 이름 여섯 개는 엔진 `aggregator.rs`의 `pub const` 한 곳에 두고, 컨트롤러 `build_report`도 그 상수를 가져다 쓴다(컨트롤러는 이미 엔진에 의존한다). 문자열을 두 번 적지 않는다.
- `measure_phases`와 무관하다. `measure_phases`는 runner가 다운로드·대기·dns·connect 기록을 부를지 정하는 스위치이고, 새 여섯 구간은 그 스위치 밖에서 조건 반복 가지가 직접 기록한다.

### 3.1 엔진 (`runner.rs`, `aggregator.rs`)

- `execute_steps`의 마지막 인자 `in_cond_loop: bool`을 `cond_pass: Option<&PassSamples>`로 바꾼다. "조건 반복 본문 안인가"는 `cond_pass.is_some()`이다(너그러운 추출 판단은 이 값으로). 인자 수는 그대로다.
  - `PassSamples` = `std::sync::Mutex<Vec<PassSample>>`, `PassSample`은 스텝 id·`latency_us: u64`·`is_error: bool`. parallel 분기가 `join_all`로 같은 참조를 함께 쓰므로 `&mut`가 아니라 잠금이다. 잠금은 `await`를 넘겨 쥐지 않는다(넘기면 VU task를 `spawn`하는 곳에서 컴파일이 안 된다). 잠금이 오염됐으면 `into_inner`로 계속 쓴다(panic 금지).
  - 스텝 id를 `String`으로 복사할지 빌려 쓸지(`&str`)는 구현자 재량. 요청마다 할당을 줄이는 쪽을 권한다 — §6.4 처리량 비교가 본다.
  - 재귀가 아닌 호출부(지금 `false`를 넘기는 곳)는 `None`. if·while 없는 loop·parallel 가지는 받은 값을 그대로 넘긴다(여기서 `None`을 넘겨도 컴파일되므로 §6.1-9·10이 지킨다). 조건 반복 가지는 진입마다 자기 `PassSamples`를 만들어 본문에 `Some(&…)`로 넘긴다.
  - `trace.rs::trace_steps`의 `in_cond_loop: bool`은 그대로 둔다(집계 없음).
- `Step::Http` 가지: 지금 `a.record(...)`를 부르는 블록에서, `cond_pass`가 `Some`이고 버퍼 길이가 상한 미만이면 표본 한 건을 넣는다. `None`이면 검사 한 번 말고는 하는 일이 없다.
- 조건 반복 가지: 회차가 끝나는 네 경우(§2 표)에서 버퍼를 비워 `Aggregator`에 옮긴다.
  - 본문이 `Continue` → 조건 평가 → 거짓이면 `loop_final`, 참이고 다음 회차로 가면 `loop_retry`, 참인데 최대 횟수면 `loop_cut`.
  - 본문이 비-`Continue`/`Err` → `loop_cut`.
  - 버퍼가 비어 있으면 잠금을 잡지 않는다. 진입이 끝나는 경우에는 지금 있는 `record_loop_exit`와 같은 잠금 안에서 함께 기록한다.
  - 머리의 종료 시각·취소 검사 지점에서는 버퍼가 항상 비어 있다(앞 회차 끝에서 비웠다). 할 일 없음.
  - 회차마다 새 `Vec`를 할당하지 않게 한다(예: 가지가 가진 빈 `Vec`와 맞바꾼 뒤 비우기). 방법은 구현자 재량.
  - 흐름(반환 값·순서·`yield_now`)은 바꾸지 않는다.
- `Aggregator`: `record_loop_split(step_id, 갈래(끝냄·이어짐·끊김 enum), latency_us, is_error)` 한 메서드가 `record_phase`를 한 번(에러면 두 번) 부른다. 구간 이름 여섯 개는 `aggregator.rs`의 `pub const`. 드레인·`MetricFlush`·송신 가드는 무변경(`phase_stats`에 실려 나간다).

### 3.2 워커·통신·저장

무변경. `phase_stats_to_proto`류 변환, 건너뜀 가드(`phase_stats.is_empty()`), proto `PhaseStat`, `insert_phase_batch`, `run_phase_metrics`, 시나리오 삭제 연쇄가 그대로 새 구간을 나른다.

### 3.3 컨트롤러 (`report.rs::build_report`)

- `phases` 행 중 여섯 구간을 스텝별로 모은다. `loop_final`은 `final`로, `loop_retry`와 `loop_cut`은 둘 다 `retry`로 히스토그램을 `merge_into`로 합치고 `count`를 더한다. `*_err`는 `count`만 더한다. 음수 `count`는 0으로 본다. 깨진 히스토그램 BLOB은 지금 `download`와 똑같이 다룬다 — 히스토그램만 합치지 않고 `count`는 더한다.
- `ReportStep`에 필드 하나:

```json
"loop_split": {
  "final": { "count": 1200, "error_count": 0, "p50_ms": 182, "p95_ms": 420, "p99_ms": 488 },
  "retry": { "count": 612,  "error_count": 0, "p50_ms": 12,  "p95_ms": 31,  "p99_ms": 44 }
}
```

- **`loop_retry`(이어짐) 건수 합이 1 이상인 스텝에만** 낸다(`loop_cut`은 이 판단에 들어가지 않는다 — §2). 그 밖에는 키 자체가 없다(`Option` + `skip_serializing_if`). 그래서 재시도가 한 번도 없었던 run의 리포트 JSON은, 끊긴 회차나 최대 횟수 1의 중단이 있어도 지금과 글자까지 같다(US3). `final.count`가 0이어도(끝내 풀리지 않은 조건 반복) 이어짐이 1건 이상이면 두 갈래를 다 낸다. JSON의 `retry`는 이어짐 + 끊김이다.
- JSON 키는 `final`·`retry`다. `final`은 Rust 예약어라 필드에 `#[serde(rename = "final")]`(또는 `r#final`)이 필요하다.
- 백분위는 스텝 행과 같은 `percentiles_of`로 구한다(µs → ms 변환 규칙 동일). `count`가 0인 갈래의 백분위는 0.
- `error_count`는 `count`를 넘지 않게 자른다(워커가 보낸 값 방어).
- `report.steps`에 없는 스텝(요청 창이 없는 스텝)의 구간 행은 버린다.
- 정렬·`summary`·`windows`·`latency`·`validity`·`insights`·`verdict`·`export.rs`는 무변경. `ReportStep` 리터럴을 만드는 곳에는 `loop_split: None`을 더한다.

## 4. 화면

### 4.1 스텝 표 (`StepStatsTable.tsx`)

`s.loop_split`이 있는 스텝 행 바로 아래에 두 줄을 항상 보이게 넣는다(▸ 토글 뒤가 아니다). 순서는 스텝 행 → 끝낸 응답 → 재시도 → (열려 있으면) 기존 회차별 요청 수 표.

| 칸 | 끝낸 응답 줄 | 재시도 줄 |
|---|---|---|
| 스텝 | `└ 반복을 끝낸 응답` + 도움말 | `└ 재시도로 이어진 응답` |
| 메서드·URL | 빈 칸 | 빈 칸 |
| 요청 | `final.count` | `retry.count` |
| 에러 | `final.error_count` | `retry.error_count` |
| p50·p95·p99 ms | 값. `count`가 0이면 `—` | 값 |
| 대기·다운로드 칸(있을 때) | 빈 칸 | 빈 칸 |

- 숫자 형식은 같은 표의 스텝 행을 따른다(지금 스텝 행은 천 단위 쉼표가 없다 — 그대로 맞춘다. 표 전체에 쉼표를 넣는 일은 §B60 (0)의 기존 연기).
- 두 줄은 스텝 행보다 옅게 보인다(글자 `text-slate-600`, 이름 칸 들여쓰기). 줄 사이 경계선은 스텝 행과 같은 것을 쓴다.
- 도움말(끝낸 응답 줄의 이름 옆 `HelpTip` 하나): 두 갈래의 뜻. 문구는 §4.3. 버튼 이름에 스텝 이름을 넣어 스텝마다 다르게 한다.
- `└`는 장식이다 — `aria-hidden` 요소에 넣어 화면 낭독기가 읽지 않게 한다(막대 보기 글자 줄도 같다).
- 표지 「재시도 포함」과의 관계: 표지는 2차 규칙 그대로(2번째 이후 회차에서 요청된 스텝), 두 줄은 `loop_split`이 있을 때. 둘은 대개 함께 나오지만 따로 나올 수 있다 — 성공 회차에만 도는 if 안 스텝은 표지만 있고 두 줄이 없다(이어짐 회차의 응답이 0건 — 그 행의 응답이 전부 끝낸 응답이라는 뜻이라 §B60 (1)의 혼동을 오히려 덜어 준다). 1번째 회차에서만 도는 if 안 스텝은 두 줄만 있을 수 있다.

### 4.2 막대 보기 (`StepPhaseBreakdown.tsx`, `measure_phases` run의 기본 보기)

`s.loop_split`이 있는 스텝의 막대 줄 아래에 글자 두 줄을 넣는다.

```
└ 반복을 끝낸 응답 · 1,200건 · 에러 0 · p50 182 · p95 420 · p99 488 ms
└ 재시도로 이어진 응답 · 612건 · 에러 0 · p50 12 · p95 31 · p99 44 ms
```

- `text-xs text-slate-600`, 이름 칸 폭만큼 들여쓰지 않고 줄 전체를 쓴다. 좁은 폭에서는 줄바꿈된다(가로 넘침 금지).
- `count`가 0인 갈래는 백분위 자리에 `—`.
- 보기 전환 버튼 「칩」을 누르면 §4.1 표가 그대로 나온다(버튼 이름은 「막대」·「칩」).
- 건수·에러 수는 천 단위 쉼표를 넣는다(`toLocaleString("en-US")` — 바로 아래 풀이 줄 `LoopExitSummary`와 같은 형식). 위 예시는 `1,200건`·`612건`으로 읽는다.

### 4.3 문구 (`ko.ts` `report.loopExit` 아래)

| 키 | 문구 |
|---|---|
| `splitFinal` | `반복을 끝낸 응답` |
| `splitRetry` | `재시도로 이어진 응답` |
| `splitHelpLabel(name)` | `「${name}」 나뉜 응답 시간 설명` |
| `splitHelpFinal` | `반복을 끝낸 응답 = 조건이 풀려 반복이 끝난 회차에서 받은 응답.` |
| `splitHelpRetry` | `재시도로 이어진 응답 = 그 밖의 회차에서 받은 응답. 최대 횟수에 걸려 중단된 회차와 run 종료·중지·오류로 끊긴 회차도 여기에 들어갑니다.` |
| `splitBarLine(label, count, errors, p50, p95, p99)` | `${label} · ${count}건 · 에러 ${errors} · p50 ${p50} · p95 ${p95} · p99 ${p99} ms` (앞의 `└ `는 컴포넌트가 `aria-hidden`으로 붙인다) |

표의 이름 칸은 `aria-hidden`인 `└ ` + `splitFinal`/`splitRetry`.

### 4.4 스키마 (`ui/src/api/schemas.ts`)

`ReportStepSchema`(`.strict()`)에 `loop_split: LoopSplitSchema.optional()`. `LoopSplitSchema` = `{ final, retry }`, 각 `{ count, error_count, p50_ms, p95_ms, p99_ms }`(음이 아닌 정수), 둘 다 `.strict()`. 서버는 없을 때 키를 아예 내지 않으므로 `.optional()`이면 된다(`null`을 보내지 않는다).

## 5. 문서

- ADR-0056 "리포트 집계" 절에 응답 시간 분리 한 문단(갈래 규칙·구간 이름 여섯 개·"이어짐 ≥ 1" 표시 조건·회차 표본 상한).
- `crates/engine/CLAUDE.md`: `in_cond_loop` 한 줄을 `cond_pass`로 고치고, "조건 반복 가지가 회차 끝에 `loop_final`/`loop_retry`/`loop_cut`(+`_err`)를 `record_phase`로 기록 — `measure_phases`와 무관" 한 줄.
- `ui/src/components/report/CLAUDE.md`: 두 줄은 `loop_split`이 있을 때만, 표지와 따로 나올 수 있다는 한 줄.
- roadmap §B61(새 블록, 작성 시 `grep -n '^### B' docs/roadmap.md`로 마지막 +1 확인) — §7.

## 6. 검증 계획

### 6.1 엔진 (`crates/engine/tests/`, 2차의 `loop_exit.rs`와 같은 틀)

1. 대기 2번 뒤 성공하는 응답기 + 본문 http 스텝 하나, 반복 N회: `loop_final` 건수 = N, `loop_retry` 건수 = 2N, 두 합 = 그 스텝의 창 요청 수 합.
2. 끝내 풀리지 않음 + 최대 횟수 3: `loop_final` 없음, `loop_retry` = 2 × 진입 수, `loop_cut` = 진입 수.
3. 본문에 http 스텝 둘: 두 스텝 모두 회차 기준으로 나뉜다(스텝마다 final = N, retry = 2N).
4. 에러 응답(상태 단언 실패)이 섞임: `*_err` 건수 = 그 갈래의 에러 수, 세 `*_err` 합 = 창 `error_count` 합.
5. run 종료 시각에 끊김(무제한 + 끝내 안 풀림): `loop_final` 없음, `loop_retry` + `loop_cut` 합 = 창 요청 수 합.
5-1. 1번째 회차에서 항상 풀림 + 본문 think time 도중 run 종료: `loop_retry` 없음(끊긴 회차는 `loop_cut`). 최대 횟수 1 + 끝내 안 풀림: `loop_retry` 없음, `loop_cut` = 진입 수.
6. 조건 반복이 없는 시나리오(flat·while 없는 loop·if·parallel): 모든 flush의 `phase_stats`가 비어 있다(R0).
7. 회차 표본 상한: 조건 반복 안에 횟수 1,100짜리 loop → 한 회차에서 1,024건만 갈래에 들어간다.
8. 단위: `record_loop_split`이 구간 이름과 건수를 맞게 기록.
9. 조건 반복 본문의 if 안 http 스텝(UI로 만들 수 있는 꼴): 그 스텝도 나뉘고 합 등식이 성립. if 가지가 `cond_pass` 대신 `None`을 넘기게 고의로 바꿔 RED를 확인한다.
10. 조건 반복 본문의 parallel 분기 안 http 스텝(손 YAML)·while 없는 loop 안 http 스텝: 같은 확인(parallel·loop 가지의 전달).

정확한 건수를 단언하는 테스트(1·2·3)는 run 종료에 끊기는 회차가 없는 틀을 쓴다(`loop_exit.rs`처럼 unique 데이터셋으로 정해진 반복 수 뒤에 VU가 스스로 끝나게). 그렇게 못 하면 합에 `loop_cut`을 넣는다.

회귀 가드를 표방하는 단언(1의 합 등식, 6의 R0)은 고의로 깨뜨려 RED를 확인한 뒤 되돌린다.

### 6.2 컨트롤러 (`report.rs` 테스트)

1. 여섯 구간 행 → `loop_split` 값(건수·에러·백분위), 여러 행(다른 flush·다른 워커)이 합쳐진다.
2. `loop_final`만 있거나 `loop_final` + `loop_cut`만 있고 `loop_retry`가 없거나 0건 → 키 없음, 직렬화 문자열에 `loop_split`이 없다. `loop_retry` 1건 + `loop_cut` 2건 → `retry.count` 3.
3. 구간 행이 전혀 없는 리포트를 직렬화한 문자열에 `loop_split`이 없다. 기존 테스트는 `ReportStep` 리터럴에 `loop_split: None`을 더하는 것 말고 단언을 고치지 않고 통과한다. (리포트 JSON 전체를 글자 단위로 비교하는 골든 파일은 없다 — "글자까지 같다"의 확인은 이 단언과 §6.4의 작업 전 바이너리 대조가 맡는다.)
4. `loop_final` 없음 + `loop_retry` > 0 → 두 갈래 다 나오고 final 백분위 0.
5. `error_count` > `count`인 입력 → `count`로 잘린다. 깨진 BLOB → `count`는 더해지고 히스토그램만 빠진다.
6. `download`·`wait`·`dns`·`connect` 결과가 새 구간 행이 섞여도 그대로다.

### 6.3 화면 (RTL)

1. `loop_split`이 있는 스텝: 두 줄이 스텝 행 바로 아래에 순서대로, 칸 값이 맞다. 없는 스텝: 줄 없음, 표 DOM이 이 작업 전과 같다.
2. `final.count` 0 → 백분위 `—`.
3. ▸ 토글을 열면 두 줄 아래에 회차별 표.
4. 대기·다운로드 칸이 있을 때 칸 수가 맞다(행마다 `td` 수 동일).
5. 막대 보기: 글자 두 줄, 없는 스텝은 없음.
6. 스키마: `loop_split` 없는 리포트·있는 리포트 둘 다 파싱, 모르는 키는 거절.
7. 접근성: 나뉜 스텝이 둘이면 도움말 버튼 이름이 서로 다르다. `└`는 `aria-hidden` 요소 안에 있다(표·막대 보기 둘 다).

### 6.4 라이브 (`/live-verify`)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1·US2 | 본문에 http 스텝 하나 + if 안 http 스텝 하나(성공 회차에만 도는 것)를 둔다. 대기 응답(빠름)과 성공 응답(느림, 예: 지연 150ms)을 구분해 주는 응답기 + 조건 반복 시나리오로 run. 리포트 열기 | 스텝 행 아래 두 줄. 끝낸 응답 p50 ≈ 응답기의 성공 지연, 재시도 p50 ≈ 대기 지연. if 안 스텝은 표지만 있고 두 줄이 없다(§4.1). 두 줄 요청 수 합 = 스텝 요청 수, 에러 합 = 스텝 에러 수 |
| US1·US2 | 같은 시나리오를 워커 2대 fan-out, 도착률 기준(open-loop), `measure_phases: true`로 각각 | 합 등식이 성립. `measure_phases` run은 막대 보기에 글자 두 줄, 「칩」으로 바꾸면 표 두 줄 |
| US2 | 끝내 풀리지 않는 조건 반복(최대 횟수 3) | 끝낸 응답 0건·백분위 `—`, 재시도 = 스텝 요청 수 |
| US3 | 조건 반복 없는 시나리오 run, 조건 반복은 있지만 재시도가 0인 run(본문에 think time을 두어 run 종료에 끊기는 회차가 생기게 한다), 작업 전 바이너리로 만든 DB의 run | 리포트 JSON에 `loop_split` 없음, 화면 두 줄 없음. 조건 반복 없는 run의 리포트 JSON은 작업 전 바이너리의 것과 run id·시각·측정값을 뺀 구조가 같다 |
| 전 화면 | 리포트가 뜨는 곳(run 상세) + 인쇄 보고서 + run 비교 | 두 줄은 run 상세에만. 인쇄·비교는 지금과 같고 오류 없음(`loop_split`이 든 리포트를 읽어도) |
| 극단값 | 긴 스텝 이름(공백 없는 80자)·요청 수 7자리·좁은 창 | 겹침·잘림·가로 넘침 없음(`getBoundingClientRect`로 확인) |
| 성능 | 작업 전 바이너리(커밋 `6bef7e79`, 세션 임시 폴더에 보관. 없으면 그 커밋에서 다시 빌드)와 작업 후 바이너리로 ① flat 시나리오 ② 조건 반복 시나리오를 같은 VU·같은 응답기로 각 3회 | ①은 RPS 차이가 회차 간 흔들림 안. ②도 흔들림 안이거나, 차이가 있으면 수치를 build-log와 §B61에 적고 사용자에게 알린다. ②에서 run 하나의 `run_phase_metrics` 행 수·DB 파일 크기 증가·리포트 응답 시간(`GET /api/runs/{id}/report`)도 작업 전과 나란히 적는다 |

### 6.5 게이트

`cargo fmt --check`·`cargo clippy -- -D warnings`·`cargo nextest`·doctest·`pnpm lint && pnpm test && pnpm build`. 최종 `handicap-reviewer`. 보안 표면은 `finish-slice` §0 grep이 정한다(이 작업은 요청 실행 경로의 `runner.rs`를 건드리므로 매치할 수 있다 — 매치하면 `security-reviewer`).

## 7. 연기·기록 (roadmap §B61)

- 내보내기(CSV·XLSX)·인쇄·비교에 나뉜 값 없음. 연기 조건: "나뉜 응답 시간은 화면 리포트에만"이라고 말하는 동안. 해소: `loop_split`을 `export.rs`·`ui/src/print/`·`ui/src/compare/`에(§B60 (0)의 `loop_exits` 연기와 함께).
- SLO 판정이 "반복을 끝낸 응답"의 응답 시간을 볼 수 없음. 해소: criteria에 갈래 선택.
- 갈래별 시계열·분포 차트·상태 코드·전송 실패 종류 없음.
- 회차 표본 상한을 넘는 손 YAML은 두 줄의 합이 스텝 요청 수보다 작다. 화면은 이를 알리지 않는다. 해소: 넘친 건수를 세는 구간을 하나 더 두고 줄 아래에 안내.
- 합 등식이 깨지는 다른 경우(화면은 알리지 않는다): ① 같은 스텝 id가 조건 반복 안팎에 둘 다 있는 YAML(YAML 보기에서 스텝을 붙여 넣으면 가능 — id 중복을 막는 곳이 없다): 바깥 요청은 스텝 행에만 더해진다. ② LAN 풀에서 옛 워커와 새 워커가 섞임(등록 때 버전 검사가 없다): 옛 워커 몫이 두 줄에서 빠진다. ③ 워커가 run 도중 죽거나 연결이 끊김: 진행 중이던 회차의 표본이 빠진다(요청 창은 이미 앞선 flush로 나갔다). 해소: 두 줄의 합이 스텝 요청 수와 다르면 줄 아래에 "일부 응답은 나뉘지 않았습니다" 안내.
- 조건 반복이 있는 run의 `run_phase_metrics` 행·BLOB 증가(§3 대가 ②). 해소: 컨트롤러가 받을 때 `(run, step, phase)`로 합쳐 한 행으로 두거나, `*_err`는 BLOB 없이 건수만.
- 에러 수를 `*_err` 구간의 `count`로 나르는 방식. 갈래별로 더 많은 값이 필요해지면 전용 길(proto 메시지·테이블)로 옮긴다.
- 릴리즈 노트 한 줄: 조건 반복 스텝의 응답 시간이 "반복을 끝낸 응답 / 재시도로 이어진 응답"으로 나뉘어 보인다.

## 8. 보안 메모

새로 나르는 값은 응답 시간(µs 히스토그램)과 건수, 엔진 상수인 구간 이름뿐이다. 응답 본문·변수 값·주소·헤더는 버퍼에도 통신에도 들어가지 않는다(`PassSample`은 스텝 id·시간·에러 여부). 컨트롤러는 워커가 보낸 `phase` 문자열을 지금도 검사 없이 저장하며(선재), 리포트는 정해진 이름만 읽는다.

## 9. 사실 주장과 확인 명령

| 주장 | 확인 명령 |
|---|---|
| `build_report`가 구간을 이름으로만 고른다(`download`·`wait`·`dns`·`connect`) | `grep -n 'p.phase ==\|"dns" =>\|"connect" =>' crates/controller/src/report.rs` |
| `phase_breakdown`의 소비처는 `api/runs.rs` 한 곳 | `grep -rn 'phase_breakdown(' crates --include='*.rs'` |
| `execute_steps` 호출부(정의 포함 8줄 — 비재귀 3·재귀 4) | `grep -n 'execute_steps(' crates/engine/src/runner.rs` |
| `in_cond_loop`를 쓰는 곳(runner 6줄, trace 6줄) | `grep -n 'in_cond_loop' crates/engine/src/runner.rs crates/engine/src/trace.rs` |
| `Aggregator::record` 호출은 runner의 Http 가지 한 곳 | `grep -n 'a\.record(' crates/engine/src/runner.rs` |
| 워커 건너뜀 가드에 `phase_stats.is_empty()`가 이미 있다 | `grep -n 'phase_stats.is_empty()' crates/worker/src/lib.rs` |
| `ReportStep` 리터럴 위치(4곳: 운영 1·테스트 3) | `grep -rnE '^\s*ReportStep \{' crates/controller` |
| `ReportStepSchema`가 `.strict()` | `sed -n 280,301p ui/src/api/schemas.ts` |
| 새 이름이 기존 코드와 겹치지 않는다 | `grep -rn 'loop_split\|loop_final\|loop_retry\|loop_cut\|PassSample' crates ui/src` (작업 전 1건 — `coordinator.rs`의 무관한 테스트 이름 `split_curve_only_open_loop_splits_each_stage`) |
| TUI는 리포트 스텝을 거울로 두지 않는다 | `grep -rn 'loop_breakdown\|ReportStep' crates/tui/src` (0건) |
| 보기 전환 버튼 이름은 「막대」·「칩」 | `grep -n 'phaseViewWaterfall\|phaseViewChips' ui/src/i18n/ko.ts` |
| 조건 반복 본문에 if를 둘 수 있다(UI 모델) | `grep -n 'LoopBodyStep' ui/src/scenario/model.ts` |
| flush 주기 500ms | `grep -n 'from_millis(500)' crates/engine/src/runner.rs` |
| 막대 보기는 `anyPhase`일 때만, 아니면 표 | `sed -n 19,25p ui/src/components/report/StepPhaseBreakdown.tsx` |

## 10. 결정 기록

| 결정 | 누가 | 이유 |
|---|---|---|
| 목업 C 그대로, 회차 기준, 중단·끊김은 재시도 쪽, 화면만, 2차 요소 불변 | 사용자 (2026-11-14) | US 승인 |
| 기존 `phase_stats` 길 재사용, 구간 이름 여섯 개 | 설계자 | §3 |
| `in_cond_loop: bool` → `cond_pass: Option<&PassSamples>` | 설계자 | 인자 수를 늘리지 않고 회차 버퍼를 본문에 전달 |
| 엔진은 세 갈래(끝냄·이어짐·끊김), 화면은 이어짐+끊김을 한 줄로. 이어짐 ≥ 1일 때만 `loop_split` | 설계자 (spec 리뷰 2회차 지적) | US3 — 끊긴 회차만으로 두 줄이 뜨지 않게. 2차의 재시도 정의와 일치 |
| 회차 표본 상한 1,024 | 설계자 | 버퍼 메모리 상한. UI 시나리오는 닿지 않음 |
| 두 줄은 토글 없이 항상 표시 | 설계자 | 목업 C가 그렇게 그렸다 |
| 표 두 줄의 숫자는 쉼표 없이(목업 C는 `1,200`) | 설계자 | 같은 표의 스텝 행이 쉼표 없이 적는다 — 한 칸 안에서 형식이 갈리지 않게. 표 전체 쉼표는 §B60 (0) 연기. 막대 보기 글자 줄은 쉼표를 넣는다 |
| 깨진 BLOB은 `count`만 더함 | 설계자 | `download`와 같은 규칙 |
| 막대 보기에는 글자 두 줄 | 설계자 | `measure_phases` run의 기본 보기에서도 보여야 한다 |
