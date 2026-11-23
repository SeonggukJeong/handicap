---
name: why
description: Use when asked WHY something in handicap is the way it is — a code shape, a behavior, a threshold/constant, a rule, a hook, a UI wording — "왜 이렇게 했지", "이건 왜 이래", "왜 X 대신 Y", "이 규칙 왜 있어", design rationale, the history behind a past regression. Answers from the repo's written record (ADR, roadmap §B, build-log, specs/plans, git history, CLAUDE.md 함정) with citations, marks inference as inference, and says what the record does not answer. Not for "how does X work now" — read the code for that.
---

# why — 기록에서 근거 찾기

코드는 *무엇*을 하는지만 말한다. *왜*는 이 리포의 기록에 흩어져 있다. 코드를 읽고 그럴듯한 이유를 지어내지 말고 기록을 찾아 인용한다. (발상: pstack `why`, Lauren Tan, MIT — 이 리포의 기록 체계에 맞춰 다시 씀.)

## 1. 대상 고정

파일·함수·상수·규칙 이름 하나로 좁힌다. 질문이 모호하면 내 해석을 한 줄로 밝히고 진행한다(사용자가 고쳐 준다).

## 2. 코드에서 커밋으로

- 처음 들어온 커밋: `git log -S'<식별자>' --oneline -- <경로>` (가장 아래 줄)
- 함수 이력: `git log -L :<함수>:<파일> --oneline`
- 줄 출처: `git blame -w -C -L <a>,<b> <파일>`
- 커밋 메시지에서 **슬라이스 이름·`§B` 번호·`ADR-` 번호·`(Slice N)` 태그**를 뽑아 다음 단계 검색어로 쓴다.

## 3. 결정 기록 (위일수록 권위가 높다)

| 기록 | 들어 있는 것 | 찾는 법 |
|---|---|---|
| `docs/adr/` | 결정과 기각한 대안 | `grep -ln '<키워드>' docs/adr/` — 머리의 대체(supersede) 표시 확인 |
| `docs/roadmap.md` §B | 판단·비용·연기·`사용자 결정(날짜)` | `grep -n '<키워드>' docs/roadmap.md` → 그 `### B` 블록 전체를 읽기 |
| `docs/superpowers/specs/`·`plans/` | 설계 당시 의도·비목표 | 슬라이스 이름으로 `grep -ln` |
| `docs/build-log.md` | 구현 결과·함정 출처·라이브 검증 | 슬라이스 이름으로 `grep -n` |
| 루트·도메인 `CLAUDE.md`, `docs/dev/working-rules.md`, `docs/dev/*.md` | 함정·규칙과 그 출처 태그 | `grep -rn` |
| `docs/roadmap-archive.md` | 완료 이력 | `grep -n` |

자동메모리(`~/.claude/projects/…/memory/`)는 로컬에만 있고 cloud 세션에는 없다. 있으면 서사 보조로만 쓰고, 근거는 repo 기록으로 댄다.

## 4. 기록끼리 어긋나면

날짜가 늦은 쪽과 **코드가 지금 하는 일**을 대조한다. 어긋남은 감추지 말고 답에 적는다(옛 ADR이 대체됐거나, 결정 뒤 코드가 달라졌을 수 있다).

## 답 형식

- **답**: 한두 문장.
- **근거**: 기록 인용 — `파일:줄` 또는 커밋 해시 + 원문 짧게.
- **추론**: 기록에 직접 없고 내가 이어 붙인 것은 `추론:`으로 따로 표시.
- **기록에 없음**: 기록이 답하지 않는 부분. 채워 넣지 않는다.
- **지금도 유효한가** (해당할 때): 그 결정의 전제가 아직 코드에 살아 있는지. 전제가 사라졌으면 그렇다고 쓰고, 바꾸려면 어디(§B·ADR)를 고쳐야 하는지.
