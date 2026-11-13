# 조건 반복(loop + `while`) 설계 — 1차: 실행·에디터

- 날짜: 2026-11-13 · 브랜치 `worktree-loop-do-while` · 유형 `user-path`
- 상태: 검토 4회차 (1–3회차 `APPROVE-WITH-FIXES` 반영본)
- 관련 결정: ADR-0020(loop)·0023(조건 트리·lenient 평가)·0026/0047(시험 실행)·0049(실행 전 신뢰도)·0053(운영 모니터)
- **작업 분할 (사용자 결정 2026-11-13)**: 1차(이 문서) = 조건 반복 자체(US1–US3). 2차 = 리포트(US4, 부록 A의 초안으로 별도 spec). 3차 = 응답 시간 분리(목업 C). 1·2차를 모두 끝낸 뒤 릴리즈한다.

## 사용자 스토리 (US)

원문(사용자, 2026-11-13): "하나의 계정을 공유해서 반복 호출할 때 성공일 때도 있지만, 동시 요청에 의한 대기 응답을 받을 때도 있음. 이때는 기다렸다가 다시 요청을 하고 싶은데, 그럴 수가 없어." 대기 응답은 상태 코드 200이고 본문의 코드 값만 다르다.

- **US1**: QA가 여러 가상 사용자가 계정 하나를 공유하는 시나리오에서, 서버가 본문 코드로 "대기"를 알려 올 때 기다렸다가 같은 요청을 다시 보내려 한다 — 성공하면 시험 실행과 실제 run에서 대기 응답 뒤 think time만큼 쉬고 같은 스텝이 다시 호출되며, 성공 코드를 받는 즉시 다음 스텝으로 넘어가는 것을 본다.
- **US2**: QA가 서버가 끝내 대기만 주는 경우에도 run을 통제하려 한다 — 성공하면 최대 횟수를 정한 loop은 그 횟수에서 이번 시나리오 반복을 끝내고 다음 반복이 처음부터 시작되며, 최대 횟수를 비운 loop은 run 종료 시각까지 계속 재시도하다 run과 함께 멈추는 것을 본다.
- **US3**: QA가 에디터에서 조건 반복을 만들다가 부하를 왜곡하는 설정(본문에 think time이 없음, 요청이 실패해도 참이 되는 조건)을 하려 한다 — 성공하면 저장·실행 전에 에디터에서 무엇이 문제이고 어떻게 고치는지 알려 주는 경고를 본다.
- (US4 — 리포트에서 재시도 섞임을 알아본다 — 는 사용자 승인된 스토리이며 2차 작업의 것이다. 부록 A.)

## 1. 목표·비목표

**목표**: loop 스텝에 선택적 반복 조건을 붙여 "본문 1회 실행 → 조건 확인 → 참이면 다시"(do-while)를 표현한다.

**지킬 조건 (R0)**: `while`이 없는 loop과 기존 시나리오 YAML은 전 계층에서 지금과 똑같이 동작한다 — 엔진 실행 순서(`repeat: 0` = 0회 포함), YAML round-trip 글자, 워커→컨트롤러 메트릭, 리포트 JSON, 시험 실행 trace JSON, UI 화면·신뢰도 지문.

**비목표**
- 본문 실행 *전에* 조건을 보는 while — 사용자 판단: 나중에 if 스텝과 결합해 해결.
- loop 전용 대기 시간 설정 — 사용자 결정: 기존 스텝 think time으로 해결. 성공 뒤에도 한 번 쉬는 것은 수용.
- 리포트 표시(2차)·응답 시간 분리(3차)·내보내기/인쇄/비교 반영(후속) — §9.
- 중첩 규칙 변경. 현재 UI 게이트(loop 본문 = http | if, if 분기 안 loop 본문 = http)를 그대로 둔다.
- 1차에서는 메트릭 와이어(proto)·DB·리포트 JSON을 건드리지 않는다. 그래서 "최대 횟수로 중단된 반복"은 1차 동안 리포트에 드러나지 않는다(2차가 채움).

## 2. 시나리오 모델 (YAML 와이어)

```yaml
- id: 01J...
  name: 주문 재시도
  type: loop
  repeat: 5             # while이 있으면 "최대 회차", 생략하면 무제한
  do:
    - { ...주문 요청 http 스텝: extract로 code를 뽑고 think_time 지정 }
  while:                # 선택. if 스텝의 cond와 같은 조건 트리
    left: "{{code}}"
    op: eq
    right: "WAIT"
  keep_think: false     # 선택. 생략 = true. while이 있을 때만 의미
```

| `while` | `repeat` | 뜻 |
|---|---|---|
| 없음 | N (필수) | 지금과 같음: N회 무조건 반복 (`0` = 0회, 기존 그대로) |
| 있음 | N (≥1) | 본문 실행 뒤 조건이 참이면 다시, 최대 N회차 |
| 있음 | 없음 | 본문 실행 뒤 조건이 참이면 다시, 횟수 제한 없음 |
| 없음 | 없음 | 잘못된 시나리오. UI Zod가 거부. 엔진은 1회 실행(lenient — 엔진은 authoring 검증을 하지 않는 기존 관례) |
| 있음 | 0 | UI Zod가 거부(`min(1)`). 엔진은 `max(1)`로 취급(do-while은 최소 1회) |

- **엔진 `LoopStep`** (`crates/engine/src/scenario.rs`):
  - `repeat: u32` → `repeat: Option<u32>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`)
  - 새 `while_: Option<Condition>` (`#[serde(rename = "while", default, skip_serializing_if = "Option::is_none")]`)
  - 새 `keep_think: bool` (`#[serde(default = "default_true", skip_serializing_if = "is_true")]`)
  - `deny_unknown_fields` 유지. 필드 선언 순서는 `id, name, repeat, do, while, keep_think`(직렬화 순서 = 위 예시). `repeat: 3`만 있는 기존 YAML은 다시 쓰면 같은 글자가 나온다(R0).
- **`keep_think` (사용자 결정 2026-11-13, 선택지 (가))**: "이 반복 안의 think time은 think time을 무시하는 실행에서도 적용한다." loop마다 정하고 기본 켜짐. 적용 대상은 §3.4.
- **UI Zod** (`ui/src/scenario/model.ts`의 `LoopStepModel`·`NestedLoopStepModel`): `repeat: z.number().int().min(1).optional()`, `while: ConditionModel.optional()`, `keep_think: z.boolean().optional()`. `.default()` 금지(중첩 default 누출 함정).
  - 두 모델은 discriminatedUnion 멤버라 모델 자체에 `.refine`을 붙일 수 없다(`model.ts`의 "ZodEffects can't be a discriminatedUnion member" 주석). **교차 검사는 이미 있는 `StepModel`의 `superRefine` 한 곳**에서 한다: 최상위 loop과 if 분기(`then`/`elif[].then`/`else`) 안의 loop을 순회해 ① `while` 없고 `repeat` 없음 → `"<path>: repeat required when loop has no while"` ② `while` 없는데 `keep_think` 있음 → `"<path>: keep_think needs while"`. `problems.ts`에 두 문구의 한국어 매핑을 `repeat must be >= 1` 매핑과 같은 형식으로 추가한다.
- 새 YAML을 옛 워커가 읽으면 `deny_unknown_fields`로 실패해 run이 즉시 `failed`가 된다(엔진 모델을 바꾸는 모든 슬라이스 공통, 루트 CLAUDE.md). 릴리즈 노트 한 줄(§9).

## 3. 엔진 실행 의미

### 3.1 loop arm (`runner.rs::execute_steps`)

`while`의 유무로 **경로를 나눈다**.

```
while 없음:   for i in 0..repeat.unwrap_or(1) { 기존 본문 그대로 }      # 코드 변경은 unwrap_or뿐 (R0)

while 있음:
  max = repeat.map(|n| n.max(1))        # None = 무제한
  pass = 0u32
  loop:
    deadline/cancel 확인 (기존과 같은 두 줄)
    본문 실행(loop_index = pass)          # flow가 Continue가 아니면 그대로 반환
    pass = pass.saturating_add(1)
    조건 평가: eval_condition(while, ctx{vars: 본문 실행 뒤 iter_vars, loop_index: Some(pass-1)})
    거짓 → break → Continue (다음 스텝으로)
    참 & max = Some(n) & pass >= n → return EndIteration
    참 그 외 → tokio::task::yield_now().await; 다시
```

- 조건 평가는 if 스텝과 같은 `eval_condition`(lenient: 못 뽑은 변수는 빈 문자열, 평가가 run을 죽이지 않음).
- `yield_now`는 본문이 요청도 대기도 하지 않는 경우(예: 분기가 안 탄 if만 있는 본문)에 한 VU가 실행기를 독점하지 않게 한다.
- 무제한 loop은 매 회차 앞의 deadline 확인으로 run 종료 시각에 `DeadlineReached`로 멈춘다(US2). 새 종료 장치를 만들지 않는다.

### 3.2 조건 반복 본문의 추출 규칙 (`while` 본문 한정)

**문제 둘** (둘 다 코드로 확인):
- 추출은 전부 아니면 전무다. `extract::evaluate`는 항목 하나라도 실패하면 전체를 `Err`로 돌려주고, 실행기는 그것을 스텝 에러로 만들며 아무 값도 내놓지 않는다. 주문 스텝이 `code`와 성공 응답에만 있는 값(주문 번호)을 함께 뽑으면, 대기 응답마다 추출 실패 → `code`도 안 뽑힘 → 첫 대기 응답에서 반복이 끝나고, 대기 응답이 에러로 집계된다.
- 요청이 실패하면 추출이 일어나지 않고 `iter_vars.extend`는 이전 값을 지우지 않는다. 1회차에 `code=WAIT`을 받고 2회차가 연결 실패면 `code`는 여전히 `WAIT`이라 `eq WAIT`이 계속 참이다.

**규칙** (사용자 결정 2026-11-13, 선택지 (가)): `while`이 있는 loop의 본문 안(그 안의 if 분기, 엔진 경로에서만 가능한 중첩 loop 포함 — 표지는 아래로 상속)의 http 스텝은 **너그러운 추출**을 한다.
1. **추출 직전까지 `error`가 없으면**(지금 추출이 시작되는 조건 `error.is_none()` 그대로) 추출 항목을 하나씩 평가한다. 뽑힌 값은 그대로 쓰고, 못 뽑은 항목(경로 없음·헤더 없음·본문이 JSON이 아님·디코드 실패)은 그 변수를 **빈 문자열**로 둔다. 추출 실패는 스텝 에러로 세지 않는다.
2. **추출 전에 이미 `error`가 있으면**(전송 실패·시간 초과·응답 본문 읽기 실패·status assert 실패·시험 실행 경로의 요청 빌드 에러) 추출을 하지 않고, 그 스텝이 선언한 추출 변수를 전부 빈 문자열로 둔다. 스텝 에러 집계는 지금과 같다. 예: status assert가 걸린 503 응답은 본문에 `code: WAIT`이 있어도 `code`가 빈 값이 된다(에러 응답을 근거로 재시도하지 않는다).
- 지우지 않고 빈 문자열로 두는 이유: 조건 평가에서 빈 값과 없는 값은 같고(`exists` = 비어 있지 않음), 요청 템플릿의 엄격 렌더는 없는 변수에서 엔진 에러(VU 종료)를 내기 때문이다.
- 성공한 회차의 값은 다음 회차로 그대로 넘어간다(다음 페이지 위치를 이어 받는 식의 반복이 가능해야 한다). 단 그 회차에 다시 평가된 변수는 위 규칙대로 덮인다.
- 대가(문서·도움말에 적는다): ① 조건 반복 안에서는 "성공 응답인데 값이 빠진" 경우가 그 스텝의 에러로 잡히지 않고, 그 값을 쓰는 다음 스텝에서 드러난다. ② loop 전부터 있던 값도 덮인다 — 본문 스텝이 `token`을 다시 뽑다 실패하면 뒤 요청에는 빈 토큰이 실린다(조건 반복 밖에서는 이전 값이 유지된다).
- `while` 없는 loop·loop 밖 스텝은 지금 그대로다(R0: 엄격 추출, 실패 시 이전 값 유지).
- 구현 형태: `extract.rs`에 항목별 결과를 내는 너그러운 평가 함수를 추가하고(기존 `evaluate`는 불변), `execute_step`·`execute_step_traced`가 "조건 반복 본문 안" 표지를 받아 고른다. 표지는 `execute_steps`/`trace_steps`의 새 인자로 내려 준다. runner와 trace 양쪽에 같은 규칙. 기존 `execute_step`·`execute_step_traced`는 엄격 모드의 얇은 래퍼로 남기고 추출 모드를 받는 함수를 따로 둔다(기존 테스트 호출 21곳 무수정). 빈 값 채우기는 runner·trace의 http arm에서 "선언된 extract 변수 중 결과에 없는 이름에 `""`" 한 가지 동작으로 규칙 1·2를 함께 덮는다.
- 요청 단위 재평가(`ReqGen::mark_written`)는 지금처럼 **실제로 뽑힌 이름만** 넘긴다. 빈 값으로 덮은 이름은 넣지 않는다(넣으면 이름이 겹친 생성 변수의 재생성이 멈춘다). 그래서 순서는 `mark_written(뽑힌 이름)` → 빈 값 채우기 → `iter_vars.extend`다(trace 경로는 지금 `mark_written` 뒤 `extend` 순서라 그 사이에 넣는다).
- 시험 실행 trace의 http 행 `extracted`에는 빈 값으로 둔 변수도 `""`로 실린다(사용자가 "못 뽑혔다"를 볼 수 있게).

### 3.3 `StepFlow::EndIteration` (새 변형)

"이번 시나리오 반복을 여기서 끝낸다. 실패가 아니다. 다음 반복은 정상적으로 시작한다."

- `execute_steps` 안의 재귀 호출부(loop·if arm)는 지금처럼 `Continue`가 아니면 그대로 위로 올린다.
- **parallel arm**: 분기들은 지금처럼 전부 끝까지 기다린 뒤 합친다. 우선순위 `Aborted > DeadlineReached > EndIteration > Continue`. `EndIteration`이면 페이지 레이턴시를 기록하지 않는다(deadline/abort에서 안 하는 것과 같은 이유).
- **최상위 호출자 3곳** (`grep -n "execute_steps(" crates/engine/src/runner.rs` → 재귀 3 + 최상위 3):
  - closed-loop VU 루프: `Continue`와 같게(run-level think time 뒤 다음 반복).
  - VU 곡선 루프: `Continue` 가지와 같게.
  - open-loop 한 반복 실행(`let _ = execute_steps(`): 결과를 버리므로 변경 없음.
- `failed` 카운터·`EngineError`·메트릭은 건드리지 않는다(1차 범위).

### 3.4 `keep_think`가 지키는 곳 (think time을 무시하는 세 경로)

대상 = `while`이 있고 `keep_think`가 true인 loop의 본문 http 스텝(그 안 if 분기 포함). "유효 think" = 스텝 `think_time`, 없으면 시나리오 `default_think_time`.

| 경로 | 지금 | 바뀌는 것 |
|---|---|---|
| open-loop run, "think time 무시"(기본) — `controller/src/api/runs.rs::maybe_strip_think` | 루트와 모든 스텝의 think를 지운 YAML을 워커에 보냄 | 대상 스텝은 **유효 think를 스텝에 적어 넣고**(루트 기본값을 지우기 전에 복사) 지우지 않는다. 그 외는 지금처럼 지운다. 대상 loop이 없으면 결과가 지금과 같다(R0) |
| 에디터 시험 실행, think 미적용(기본) — `trace.rs` `opts.apply_think_time == false` | 대기 없음 | 대상 스텝은 대기한다(기존 대기 코드와 같은 `min(deadline - now)` 절단) |
| 운영 모니터 점검 — `monitor/check.rs`가 `apply_think_time: false`로 trace 호출 | 대기 없음 | trace 규칙을 그대로 받는다(사용자 결정 2026-11-13, 선택지 (A)) |

- **운영 모니터에서 알아 둘 것** (코드 변경 없음, 에디터 도움말·매뉴얼에 적는다):
  - 응답 시간 기준이 **특정 스텝**(`LatencySource::Step`)인 칸은 그 스텝의 마지막 응답 시간만 보므로 대기가 들어가지 않는다. 조건 반복 안 스텝을 기준으로 잡으면 재시도 끝의 마지막 응답 시간이 표시된다.
  - 기준이 **전체**(`LatencySource::Total`, 새 칸 기본값)인 칸은 `trace.total_ms`를 쓰므로 재시도와 대기가 포함된다("이 흐름을 끝내는 데 걸린 시간").
  - 점검 시간 상한(`max_wall`: 칸 `timeout_seconds`, 묶음은 `unit.rs`가 스텝별 제한을 합친 값)은 스텝이 한 번씩 돈다고 보고 잡힌 값이다. 재시도와 대기가 이를 넘으면 그 점검은 시간 초과 실패다. 조건 반복이 든 시나리오는 제한 시간을 넉넉히 잡아야 한다.
- `keep_think: false`면 세 경로 모두 지금 동작(대기 없이 재시도)이고, 에디터가 이를 경고한다(§5 경고 1).
- closed-loop run과 "think time 적용"을 켠 실행은 원래 think를 적용하므로 `keep_think`와 무관하다.

### 3.5 시험 실행 trace (`trace.rs`)

- loop arm에 §3.1·§3.2와 같은 의미를 넣는다. `while` 없는 loop은 trace 출력이 지금과 같다(R0).
- **회차 판정 행**: `while`이 있는 loop은 매 회차 뒤 행 하나를 남긴다.
  - `StepKind`에 `Loop` 추가(와이어 `"loop"`). 행 필드: `step_id` = loop id, `loop_index` = 그 회차, `branch` = `"again"`(조건 참 → 다시) | `"done"`(조건 거짓 → 다음 스텝) | `"exhausted"`(최대 횟수 → 이번 반복 끝), `branch_eval` = `[BranchEval{branch:"while", passed, leaf}]`(if 판정과 같은 구조, `${`가 든 쪽 값을 저장하지 않는 기존 `captured` 가림 그대로), 나머지는 if 판정 행과 같이 비움.
- **상한**: 판정 행은 `state.requests`와 별도로 세고 `MAX_LOOP_JUDGE_ROWS = 200`을 넘으면 `state.truncated = true`로 끝낸다(요청 없는 본문이 `max_requests`에 걸리지 않고 도는 경우의 CPU·메모리 상한). 기존 `max_requests`·`max_wall` 상한은 그대로 적용된다.
- **`exhausted` 신호**: `trace_steps`는 값을 반환하지 않으므로 `TraceState`에 `ended_by_loop: Option<String>`(loop id)을 두고, 설정되면 `truncated`와 같은 방식으로 바깥 재귀를 빠져나온다. 결과 `ScenarioTrace`에 `ended_by_loop: Option<String>`(`#[serde(default, skip_serializing_if = "Option::is_none")]`)으로 싣는다(`RowTrace`는 `trace: ScenarioTrace`를 품고 있어 따로 두지 않는다). `ok` 계산식은 바꾸지 않는다. 데이터셋 sequential 모드에서는 다음 행으로 넘어간다.
- **`StepKind::Loop`을 알아야 하는 소비처** (명령: `grep -rn "StepKind" crates ui/src --include='*.rs' --include='*.ts' --include='*.tsx' -l`; plan에서 전수 확정):
  - UI `StepKindSchema`(`ui/src/api/schemas.ts`) — `"loop"` 추가(없으면 응답 파싱 실패). `ended_by_loop`는 `.optional()`.
  - UI 시험 실행 패널: 판정 행을 if 판정 행과 같은 자리에 한 줄로("조건이 참 → 다시 실행" / "조건이 거짓 → 다음 스텝" / "최대 N회 → 이번 반복 종료"). `ended_by_loop`가 있으면 결과 머리에 "조건 반복 「이름」이 최대 횟수까지 풀리지 않아 여기서 끝났습니다" 안내. 결정 잎 값의 화면 표시는 하지 않는다(UI는 지금 `branch_eval`을 파싱하지 않는다 — 추출 값은 http 행에 이미 보인다).
  - UI `chipResults.ts`: loop 판정 행은 칩 결과 계산에서 건너뛴다.
  - TUI `inspect.rs`의 `StepKind` match: `Loop` 가지 추가(if 판정과 같은 줄 형식, 문구만 다름).
  - GUI 모니터 `ui/src/components/monitor/CheckRecordDialog.tsx`(지금 `kind !== "if"`인 행을 전부 http 행으로 그림)·`PreviewResult.tsx`(모든 행을 http 행으로 그림): loop 판정 행은 판정 줄로 그린다(빈 요청 행이 되지 않게).
  - 운영 모니터(`monitor/check.rs`·`step_judge.rs`·`record.rs`): 지금도 `== Http`/`== If`로만 걸러 쓰므로 loop 판정 행은 자연히 건너뛴다(코드 변경 없이 테스트로 고정). `ended_by_loop`가 있으면 그 점검은 **실패**(검사 위치는 기존 `trace.truncated`·`trace.error` 검사 바로 뒤 — 둘이 동시에 서는 일은 없지만 순서를 테스트로 고정), 사유 "조건 반복이 최대 횟수까지 풀리지 않음"(요청 상한 초과 사유 `REASON_REQUEST_CAP`와 같은 방식의 새 사유 상수).

## 4. loop 횟수를 읽는 다른 코드 (전수)

`repeat`이 `Option`이 되고 `while`이 생기면서 손봐야 하는 곳. 명령: `grep -rn "Step::Loop\|LoopStep {\|\.repeat\b" crates --include='*.rs'`, `grep -rn "\.repeat\b" ui/src --include='*.ts' --include='*.tsx' | grep -v __tests__` (plan에서 다시 돌려 확정).

| 위치 | 지금 | 바꿀 것 |
|---|---|---|
| `engine/src/runner.rs` loop arm | `for i in 0..lp.repeat` | §3.1 |
| `engine/src/trace.rs` loop arm | 같은 꼴 | §3.5 |
| `controller/src/insights.rs::collect_unconditional` (`validity.rs`도 공유) | `l.repeat == 0`이면 본문을 "조건부"로 | `l.while_.is_none() && l.repeat == Some(0)` — while이 있으면 본문은 항상 1회 이상 |
| `controller/src/api/runs.rs::strip_steps_think` | loop 본문 재귀 | §3.4 |
| 엔진 테스트 리터럴·proptest 생성기(`scenario.rs` 테스트, `tests/proptests.rs`) | `repeat: N` | `Some(N)` + 새 필드. round-trip proptest 생성기에 `while`·`keep_think` 조합 추가 |
| `ui/src/components/run/sizing.ts`, `openLoopChecks.ts` | `s.repeat * …`로 반복 시간·요청 수 추정 | 조건 반복은 하한 쪽 계산(최소 요청 수·기대 시간)에 **1회차**, 상한 쪽 계산(`iterationRequestRange`의 max, `iterationTimeUpperBoundSeconds`)에 `repeat`이 있으면 그 값·없으면 1회차를 쓴다. 무제한의 상한은 정의되지 않으므로 1회차로 두는 것은 알려진 한계다(§9) |
| `ui/src/components/scenario/Inspector.tsx` (자식 버튼 `loop ×N`, `LoopInspector` 횟수 draft) | `step.repeat` | §5 |
| `FlowOutline.tsx`, `TestFlowChips.tsx` | `× {step.repeat}` | §5 |
| `ui/src/scenario/trustPrefs.ts` `canonSteps` | `loop(${s.repeat}\|do:…)` | `while`이 없으면 **지금 글자 그대로**(R0 — 바뀌면 loop 시나리오 전체의 "시험 실행 확인됨"이 stale). `while`이 있으면 뒤에 `\|while:<JSON>\|keep:<0/1>`을 붙이고 `repeat` 없음은 `inf` |
| `ui/src/scenario/yamlDoc.ts` (`setLoopRepeat` 처리, loop 복제) | `repeat` 복사·설정 | `while`·`keep_think` 통과, `undefined`는 키 삭제 |
| `ui/src/scenario/scanVars.ts` (`buildVarRefIndex`, `undefinedVarRefs`) | loop arm은 `walk(s.do)`만 | `while`의 `{{변수}}`를 참조로 센다. **본문을 훑은 뒤에** 판정한다(조건은 본문 뒤에 평가되므로, loop 위치에서 판정하면 본문이 뽑는 변수를 "정의 전 사용"으로 잘못 잡는다) |
| `ui/src/scenario/stepRefLabel.ts`의 loop 분기 | "현재 도달 불가" | while 참조의 라벨("반복 조건")을 낸다 |

## 5. 에디터 (UI)

- **loop 인스펙터** (`Inspector.tsx::LoopInspector`): 「반복 조건」 접이식 구역(기본 접힘, 조건이 있으면 펼침 — 사용자 선호).
  - 조건 없음: "조건 추가" 버튼. 누르면 `{left:"", op:"eq", right:""}`를 넣는다.
  - 조건 있음: 기존 `ConditionEditor`(if 스텝과 같은 것) + "조건 삭제" + 체크 「이 반복 안의 think time은 항상 적용」(= `keep_think`, 기본 켜짐, 옆에 도움말: "도착률 기준 실행·시험 실행·운영 모니터처럼 think time을 무시하는 실행에서도 이 반복 안에서는 쉽니다. 운영 모니터에서는 재시도와 대기 시간만큼 점검 제한 시간을 넉넉히 잡으세요"). 같은 구역에 추출 규칙 한 줄 도움말: "이 반복 안에서는 응답에 없는 값을 빈 값으로 두고 에러로 세지 않습니다".
  - 조건을 삭제하면 `while`·`keep_think` 키를 지우고, 횟수가 비어 있으면 1을 채운다.
- **횟수 칸**: 조건이 없으면 지금처럼 「반복 횟수」(필수). 조건이 있으면 라벨이 「최대 반복 횟수」로 바뀌고 비울 수 있으며, 비우면 안내: "비우면 run이 끝날 때까지 반복합니다. 그동안 이 가상 사용자는 천천히 줄이는(graceful) 감소 구간에서 상한 시간이 없으면 빠지지 않고, 도착률 기준에서는 자리를 계속 차지합니다."
- **아웃라인·칩** (`FlowOutline.tsx`, `TestFlowChips.tsx`, 인스펙터 자식 버튼): 조건 없음 `× 5`(변경 없음) / 조건 있음 `조건 반복 · 최대 5` 또는 `조건 반복 · 무제한` + 조건 요약(`summarizeCondition` 재사용).
- **store/yamlDoc**: 새 `setLoopWhile(loopId, cond | undefined)`·`setLoopKeepThink(loopId, boolean)`, 기존 `setLoopRepeat`의 인자를 `number | undefined`로 확장. `undefined`(그리고 `keep_think: true`)는 키 삭제로 깨끗한 YAML. 새 키는 `do` 뒤에 붙는다(§2 예시 순서). 무제한에서 횟수를 다시 넣으면 `repeat`이 맵 끝에 붙는데, 키 순서는 의미가 없으므로 그대로 둔다(엔진이 다시 쓰는 YAML은 §2 순서). 읽기 경로(정규화)에 `while`·`keep_think` 통과 — 없으면 쓰기 전용이 된다(`disabled` 선례).
- **경고 (US3)** — 조건 반복 loop에 한해, 인스펙터의 반복 조건 구역 안과 아웃라인 행의 주의 아이콘으로. 저장·실행을 막지 않는다.
  1. **쉬지 않는 재시도**: 본문의 http 스텝 중 유효 think(스텝 `think_time` 또는 시나리오 기본, `{0,0}`은 없음으로 봄)를 가진 것이 하나도 없을 때. "대기 없이 재시도합니다. 응답이 빠르면 초당 수백 번 다시 요청할 수 있습니다. 반복 안 스텝에 think time을 넣으세요."
     - think는 있는데 `keep_think`가 꺼져 있을 때는 약한 안내: "think time을 무시하는 실행(도착률 기준·시험 실행·운영 모니터)에서는 대기 없이 재시도합니다."
  2. **실패해도 반복**: 조건을 "본문이 뽑는 변수 = 빈 문자열"로 놓고 평가했을 때 **확실히 참**이면. "요청이 실패해 값을 못 뽑아도 조건이 참이라 계속 반복합니다. '대기 값과 같다'처럼 값을 받았을 때만 참이 되는 조건을 권합니다."
     - 순수 함수 `condWhenBodyVarsEmpty(cond, bodyExtractVars): true | false | "unknown"`(새 파일 `ui/src/scenario/condEmptyEval.ts`). `bodyExtractVars`는 **본문 직계 http 스텝**이 뽑는 이름만이다(본문 안 if 분기에서만 뽑는 변수는 분기가 안 탄 회차에 이전 값이 남으므로 제외). 잎의 양쪽에 그 밖의 `{{변수}}`나 `${…}`가 있으면 그 잎은 `unknown`, `all`/`any`는 3값 논리로 합친다. `true`일 때만 경고한다. §3.2 덕분에 이 모델이 엔진의 실제 동작과 맞는다(못 뽑은 변수·실패한 스텝의 추출 변수는 빈 값).
     - 연산자 10종의 "왼쪽이 빈 문자열" 결과는 엔진 `eval_compare`를 따른다. 같은 표를 엔진 단위 테스트와 UI 테스트 양쪽에 둔다. 예외: `matches`는 정규식 문법이 JS와 Rust에서 달라, 패턴이 JS에서 컴파일되지 않으면 `unknown`으로 둔다.
  - 최대 횟수가 비어 있고 경고 1 또는 2가 있으면 끝에 "최대 횟수도 없어 run이 끝날 때까지 이어집니다"를 덧붙인다.
- **실행 화면 문구**: RunDialog의 open-loop "think time 무시" 설명(`ko.ts`)에 "조건 반복 안은 설정에 따라 예외" 한 구절을 더한다(화면 구조 변경 없음).
- 모든 문구는 `ko.ts` 경유(ADR-0035), 버튼 접근명은 보이는 글자를 포함한다.

## 6. 무제한 반복과 다른 부하 기능 (문서화, 코드 변경 없음)

- VU 곡선 graceful ramp-down: 상한(`graceful_ramp_down_seconds`)이 없으면 무제한 재시도 중인 VU는 감소 구간에서 빠지지 않는다. 이는 "긴 반복"에 대한 기존 동작과 같고, 그 상한 옵션이 해법이다.
- open-loop: 무제한 재시도 중인 반복이 슬롯을 쥐고 있어 `dropped`(원인 slots)가 는다. 기존 표시로 드러난다.
- 둘 다 §5의 무제한 안내 문구로 알리고, 매뉴얼에 한 단락을 둔다.

## 7. 검증 계획

- **엔진 단위**
  - do-while 의미 표: 조건 즉시 거짓 = 1회차 / 3회차에 거짓 / 최대 도달 → `EndIteration` / 무제한 + deadline / `while` + `repeat: 0` → 1회차.
  - R0: `while` 없는 loop의 요청 순서·`${loop_index}` 불변, **`repeat: 0` = 본문 0회**, 기존 loop YAML round-trip 글자 동일, 새 필드 생략 규칙.
  - §3.2: status assert 실패 + 본문에 WAIT → `code` 빈 값(재시도 안 함) / 대기 응답에 없는 값을 함께 뽑아도 `code`는 뽑히고 스텝 에러 0 / 1회차 WAIT → 2회차 연결 실패 → 조건 거짓으로 빠져나옴 / 성공 회차의 값은 다음 회차로 넘어감 / `while` 없는 loop은 지금처럼 엄격 추출(하나 실패 = 스텝 에러, 이전 값 유지) / 이름이 겹친 요청 단위 생성 변수는 계속 재생성.
  - parallel 안 `EndIteration` 우선순위. closed-loop에서 `EndIteration` 뒤 다음 반복이 처음 스텝부터 시작.
  - trace: 판정 행 `again/done/exhausted`, `ended_by_loop`, 판정 행 상한, `keep_think` 대기(시간 pause 테스트).
- **회귀 가드는 이빨 실증**: "`repeat: 0` 불변"·"`EndIteration`이 다음 반복을 시작시킨다"·"while 없는 loop trace 불변" 테스트는 고의로 망가뜨려 RED를 확인한다.
- **컨트롤러**: `maybe_strip_think` — 대상 loop 본문만 think 보존(루트 기본값 복사 포함), 대상이 없으면 출력 불변 / `collect_unconditional` 새 조건 / 모니터 `ended_by_loop` → 실패 사유, 판정 행 건너뛰기.
- **UI**: Zod 표(§2 다섯 줄) + superRefine 두 문구 · yamlDoc 키 삭제·순서 · 인스펙터 라벨 전환·체크 · 경고 2종(+엔진과 같은 연산자 표) · scanVars(while 참조, 본문 뒤 판정) · 신뢰도 지문(while 없으면 글자 불변) · 사이징 1회차 · `StepKindSchema`에 loop.
- **라이브 (US 척추)**: 응답기가 요청마다 처음 K번은 `{"code":"WAIT"}`, 이후 `{"code":"OK","orderId":"…"}`를 주고, 주문 스텝은 `code`와 `orderId`를 **함께** 뽑도록 해서(성공 응답에만 있는 값 — §3.2)

  | US | 절차 | 통과 신호 |
  |---|---|---|
  | US1 | ① 에디터 시험 실행(think 적용 선택은 끈 채 — `keep_think` 기본값 검증) ② closed-loop run ③ open-loop run("think time 무시" 기본) | ① 판정 행 `again`×K → `done`, 다음 스텝 도달 ②③ 응답기 로그에서 같은 VU의 재요청 간격 ≥ think time, OK 뒤 다음 스텝 요청 |
  | US2 | 항상 WAIT + 최대 3 / 항상 WAIT + 무제한 | 최대 3: 반복당 그 스텝 요청 정확히 3건 뒤 첫 스텝부터 다시(응답기 로그 순서). 시험 실행은 `exhausted` 행 + 안내. 무제한: run이 설정 시간에 `completed`로 끝남 |
  | US3 | think 없는 조건 loop / `ne OK` 조건 / `keep_think` 끔 | 경고가 각각 보이고, 고치면 사라짐. 저장·실행은 막히지 않음 |
  - §3.2 라이브: 응답기를 WAIT 1회 뒤 연결 거부로 바꿔 무제한 `eq WAIT` loop이 빠져나오는지.
  - R0 대조: `while` 없는 기존 loop 시나리오의 시험 실행 trace·run 결과가 master와 같음.
  - 운영 모니터: 조건 반복 시나리오를 칸에 걸어 정상(재시도 뒤 통과, 대기 적용 — 스텝 기준 칸의 응답 시간에 대기가 안 들어가고 전체 기준 칸에는 들어감)과 `exhausted`(실패 사유 표시) 확인. 기록 보기·미리 실행 화면과 TUI 점검 상세 화면에서 판정 줄 확인.
  - loop 인스펙터가 뜨는 모든 진입 화면(새 시나리오·저장된 시나리오 편집, 최상위 loop·if 분기 안 loop)에서 확인. 극단값: 조건 요약 최장·loop 이름 최장에서 아웃라인 행이 잘리지 않고 읽힘.

## 8. 보안 메모

- 조건의 템플릿 평가는 기존 `eval_condition` 경로 재사용이고, 판정 행은 기존 `captured` 가림을 그대로 탄다. 새 영속 sink는 없다(1차는 DB·메트릭 무변경). trace 판정 행은 시험 실행 응답과 모니터 기록(메모리 링버퍼)에 실린다 — if 판정 행과 같은 경로·같은 가림.
- 요청 실행 경로를 건드리므로 `finish-slice` §0 grep과 무관하게 `security-reviewer`를 돌린다(무제한 재시도 = 대상 서버에 대한 부하 증폭, 판정 행 상한 포함).

## 9. 연기·기록 (roadmap §B 새 블록 = 마지막 번호 +1, 작성 시 `grep -n '^### B' docs/roadmap.md`로 확인)

- **2차: 리포트(US4)** — 사용자 결정(2026-11-13): 1차 직후 순차. 초안은 부록 A. 연기 조건: "1차만 머지된 동안 리포트에 재시도·중단 표시 없음 — 1·2차를 모두 끝낸 뒤 릴리즈".
- **3차: 목업 C**(응답 시간 분리) — 사용자 결정: 2차 뒤 순차.
- **내보내기(CSV/XLSX)·인쇄 보고서·run 비교**에 조건 반복 정보 — 사용자 결정(2026-11-13, 다시 묻지 않는다): 후속. 연기 조건: "화면 리포트에만 표시".
- `keep_think`를 실행할 때마다 고르는 방식(선택지 (나)) — 사용자: "일단 (가)". 도그푸딩 뒤 재평가.
- 본문 실행 전에 조건을 보는 while — 사용자 판단: if 결합으로 추후.
- 시험 실행 화면에 판정 근거 값(결정 잎) 표시 — 이번엔 결과 문구만.
- 무제한 조건 반복의 실행 전 부하 추정 상한 — 1회차로 계산(§4). cost-if-wrong: 사이징 도움말이 재시도가 많은 시나리오의 반복 시간을 낮게 본다. 해소: 2차의 실측 회차 분포를 사이징에 넘긴다.
- 운영 모니터의 점검 시간 상한이 재시도를 고려하지 않음 — 도움말로 안내(§3.4). 해소 후보: 조건 반복의 최대 횟수 × (스텝 제한 + think 상한)을 상한 합에 반영.
- 릴리즈 노트: "조건 반복이 든 시나리오는 워커도 새 버전이어야 합니다" 한 줄.

## 10. 사실 주장과 확인 명령

| 주장 | 명령 |
|---|---|
| `execute_steps` 호출은 재귀 3 + 최상위 3 | `grep -n "execute_steps(" crates/engine/src/runner.rs` |
| `StepFlow`는 3종 | `grep -n -A5 "^enum StepFlow" crates/engine/src/runner.rs` |
| `LoopStep.repeat`은 필수 `u32`, `deny_unknown_fields` | `grep -n -B3 -A6 "pub struct LoopStep" crates/engine/src/scenario.rs` |
| `from_yaml`은 serde만 | `grep -n -A3 "pub fn from_yaml" crates/engine/src/scenario.rs` |
| 추출은 `error.is_none()`일 때만 | `grep -n "error.is_none() && !step.extract.is_empty()" crates/engine/src/executor.rs` |
| 추출은 첫 실패에서 전체 `Err` | `grep -n -B3 -A3 "On the first failure" crates/engine/src/extract.rs` |
| 모니터 응답 시간 기준 2종(Total = `trace.total_ms`, Step = 그 스텝 마지막 응답) | `grep -n -A8 "let latency_ms = match &panel.latency_source" crates/controller/src/monitor/check.rs` |
| `exists`/`empty`는 빈 문자열 기준 | `grep -n "CompareOp::Exists => \|CompareOp::Empty => " crates/engine/src/condition.rs` |
| open-loop + think 무시일 때만 strip | `grep -n -A4 "^fn maybe_strip_think" crates/controller/src/api/runs.rs` |
| trace는 `apply_think_time`일 때만 대기 | `grep -n "if opts.apply_think_time" crates/engine/src/trace.rs` |
| 모니터는 `apply_think_time: false` | `grep -n "apply_think_time: false" crates/controller/src/monitor/check.rs` |
| `StepKind`는 `Http`·`If` 2종 | `grep -n -A8 "pub enum StepKind" crates/engine/src/trace.rs` |
| `collect_unconditional`의 `l.repeat == 0` | `grep -n "l.repeat == 0" crates/controller/src/insights.rs` |
| UI loop 모델 2곳 | `grep -n "repeat: z" ui/src/scenario/model.ts` |
| `.repeat`을 읽는 UI 코드 | `grep -rn "\.repeat\b" ui/src --include='*.ts' --include='*.tsx' \| grep -v __tests__` |
| 연산자 10종 | `grep -n -A11 "pub enum CompareOp" crates/engine/src/scenario.rs` |

## 11. 결정 기록

**사용자 결정**: 대기는 think time으로 / 최대 횟수 선택(비우면 무제한) / 최대 도달 시 이번 반복 종료·다음 반복 시작 / 경고 2종 / `keep_think`는 loop마다(선택지 (가)), 기본 켜짐, 운영 모니터에도 적용(A) / 조건 반복 안에서는 못 뽑은 값 = 빈 값·에러 아님(가) / 1차·2차 분할 / 리포트는 A+B+맨 위 안내(재시도가 있으면 항상) / 내보내기·인쇄·비교는 후속.

**내가 정한 것**
1. YAML 키 이름 `while`·`keep_think`, 최대 횟수는 기존 `repeat` 재사용(생략 = 무제한), 새 키는 `do` 뒤.
2. 요청이 실패한 스텝의 추출 변수도 빈 값으로 둔다(§3.2 규칙 2 — 규칙 1은 사용자 결정).
3. 중단(`EndIteration`)은 실패·에러로 세지 않는다.
4. 시험 실행에 회차 판정 행(`kind: "loop"`)을 추가하고 200행 상한을 둔다. 모니터에서 `exhausted`는 실패.
5. 실행 전 부하 추정에서 조건 반복은 1회차로 계산한다.
6. 경고는 저장·실행을 막지 않는 주의 표시.

---

## 부록 A. 2차(리포트, US4) 설계 초안 — 이 문서의 범위 밖, 2차 spec의 출발점

- **US4**: QA 또는 운영자가 조건 반복이 있었던 run의 리포트를 읽으려 한다 — 성공하면 해당 스텝 행의 「재시도 포함」 표시, loop별 "진입 N · 재시도 M · 중단 K" 풀이, 몇 번째 회차에서 끝났는지의 분포, 재시도가 있었을 때 리포트 맨 위의 해석 주의 안내를 본다. 목업: `docs/superpowers/specs/2026-11-13-loop-do-while-mockups/report-options.html`.
- **집계(counts-only)**: `while` loop에 들어갔다가 끝난 한 번마다 `(loop id, 회차 칸, 중단 여부)`로 한 건 + 실제 회차 합. 회차 칸은 20까지 따로, 그 이상은 "21회차 이상" 한 칸(고정 상수, `loop_breakdown_cap`과 별개). deadline/취소로 잘린 진입은 세지 않는다.
- **길**: if 분기 집계와 같은 꼴 — 엔진 `Aggregator` → `MetricFlush`(리터럴·drain·빈 flush 건너뛰기 조건 3모드 전부) → proto `MetricBatch` 새 반복 필드(11) → 워커 → 컨트롤러 ingest(`MetricBatch` 리터럴 전부) → 새 테이블(누적 upsert, `/new-migration`, 시나리오 삭제 cascade 목록) → `ReportJson.loop_exits`(`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) → UI Zod `.optional()`.
- **화면**: A(스텝 행 표시 + loop 단위 풀이 한 줄) · B(회차 분포 막대, 색+글자 구분) · 맨 위 안내(재시도 1회 이상 또는 중단 1건 이상이면 항상 — 사용자 결정). 서버 유효성 등급·인사이트는 건드리지 않고 화면에서 계산.
- **라이브 숫자 대조**는 deadline에 잘린 진입 때문에 "VU 수 이내 오차"로 정의.
