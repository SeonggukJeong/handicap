# 조건 반복 1차 — 문구 표 (정본, byte-exact)

plan `docs/superpowers/plans/2026-11-13-loop-do-while.md`의 task들이 공유하는 문구. 구현자는 이 표의 글자를 그대로 `ui/src/i18n/ko.ts`의 **`ko.editor` 묶음**에 아래 키 이름으로 넣는다(판정 줄 문구도 `ko.editor` — 모니터 화면은 같은 키를 재사용한다). 변수 뒤 조사는 병기형.

## 에디터 (`ko.editor`)

| 키 | 값 |
|---|---|
| `loopCondSection` | `반복 조건` |
| `loopCondAdd` | `조건 추가` |
| `loopCondRemove` | `조건 삭제` |
| `loopCondIntro` | `본문을 한 번 실행한 뒤 이 조건이 참이면 다시 실행합니다.` |
| `fieldRepeatMax` | `최대 반복 횟수` |
| `loopRepeatUnlimitedHint` | `비우면 run이 끝날 때까지 반복합니다. 그동안 이 가상 사용자는 천천히 줄이는(graceful) 감소 구간에서 상한 시간이 없으면 빠지지 않고, 도착률 기준에서는 자리를 계속 차지합니다.` |
| `loopKeepThink` | `이 반복 안의 think time은 항상 적용` |
| `loopKeepThinkHelpLabel` | `think time 항상 적용 도움말` |
| `loopKeepThinkHelp` | `도착률 기준 실행·시험 실행·운영 모니터처럼 think time을 무시하는 실행에서도 이 반복 안에서는 쉽니다. 운영 모니터에서는 재시도와 대기 시간만큼 점검 제한 시간을 넉넉히 잡으세요.` |
| `loopLenientExtractHelp` | `이 반복 안에서는 응답에 없는 값을 빈 값으로 두고 에러로 세지 않습니다. 요청이 실패한 스텝이 뽑는 값도 빈 값이 됩니다.` |
| `loopCondLabelMax(n)` | `조건 반복 · 최대 ${n}` |
| `loopCondLabelUnlimited` | `조건 반복 · 무제한` |
| `loopWarnNoThink` | `대기 없이 재시도합니다. 응답이 빠르면 초당 수백 번 다시 요청할 수 있습니다. 반복 안 스텝에 think time을 넣으세요.` |
| `loopWarnThinkNotKept` | `think time을 무시하는 실행(도착률 기준·시험 실행·운영 모니터)에서는 대기 없이 재시도합니다.` |
| `loopWarnRetryOnFailure` | `요청이 실패해 값을 못 뽑아도 조건이 참이라 계속 반복합니다. '대기 값과 같다'처럼 값을 받았을 때만 참이 되는 조건을 권합니다.` |
| `loopWarnUnlimitedSuffix` | `최대 횟수도 없어 run이 끝날 때까지 이어집니다.` |
| `loopWarnIconAria(name)` | `${name} 반복 조건 주의` |
| `gateLoopRepeatRequired(path)` | `${path}: 반복 조건이 없으면 반복 횟수가 필요합니다` |
| `gateLoopKeepThinkNeedsWhile(path)` | `${path}: keep_think는 반복 조건(while)이 있을 때만 쓸 수 있습니다` |
| `varRefLoopCond` | `반복 조건` |

## 시험 실행·모니터 판정 줄 (`ko.editor`)

| 키 | 값 |
|---|---|
| `loopJudgeAgain` | `조건이 참 → 다시 실행` |
| `loopJudgeDone` | `조건이 거짓 → 다음 스텝` |
| `loopJudgeExhausted(n)` | `최대 ${n}회 → 이번 반복 종료` |
| `loopJudgePass(i)` | `${i}회차` |
| `endedByLoop(name)` | `조건 반복 「${name}」이(가) 최대 횟수까지 풀리지 않아 여기서 끝났습니다.` |

## 실행 화면 (기존 open-loop think 무시 문구에 덧붙임 — 위치: `grep -n "think time 무시 중 (open-loop 기본)" ui/src/i18n/ko.ts`)

기존 값 `think time 무시 중 (open-loop 기본) — 도착률로만 부하를 제어합니다. 적용하려면 켜세요.` 뒤에 한 문장 추가:
` 조건 반복 안의 think time은 반복 설정에 따라 그대로 적용됩니다.`

## Rust 쪽 문자열

| 위치 | 값 |
|---|---|
| `monitor/check.rs` `REASON_LOOP_EXHAUSTED` | `조건 반복이 최대 횟수까지 풀리지 않음` |
| TUI `inspect.rs` 판정 줄 again/done/exhausted | `조건 참 → 다시` / `조건 거짓 → 다음 스텝` / `최대 횟수 → 반복 종료` |
