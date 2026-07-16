---
name: start-slice
description: Use when starting a new slice of work, typically right after a context reset — picking the next task and preparing an isolated worktree. 컨텍스트 초기화 직후 다음 작업 선택·worktree 준비가 필요할 때 사용자가 /start-slice로 호출.
disable-model-invocation: true
---

# start-slice — 슬라이스 시작 부트스트랩

작업 선택 → worktree 생성 → baseline 빌드 → 설계 핸드오프. 과거 사고(A1): 새 워크트리엔 `ui/node_modules`·`target/`이 없어 첫 subagent가 deps 없음으로 즉사.

## 1) 작업 후보 제시
`docs/roadmap.md`(post-MVP1 단일 진입점) + 메모리 `MEMORY.md`(🎯/🔄 = 예정·진행 중)를 읽고 후보 2–3개를 근거(가치·의존성·크기)와 함께 표로 제시 → `AskUserQuestion`으로 선택받기. **가치는 3칸으로 구조화**(US 스파인 — 규약 `docs/dev/user-story-spine.md`): ① 누가(행위자 어휘 4종) ② 지금 막힘(솔루션 동사 금지 — "API 추가" ❌) ③ 완료 시 달라지는 관찰, + 유형 태그(user-path·correctness-bug·internal-polish·platform). 3칸 원천은 `docs/roadmap.md` §A/§B 상세 발췌 — **못 채워도 자동 제외/강등 금지**, 미충족 표시 후 사용자에게 그대로 제시(손-큐레이트 `docs/roadmap-status.md` 추천 권위 불변).

**준비 상태 판정은 파일 실존으로** (메모리·roadmap 서술이 서로 어긋날 수 있다): `docs/superpowers/specs/`·`docs/superpowers/plans/`에 해당 작업의 문서가 실제로 있는지 `ls`로 확인하고, 있으면 그 작업을 "spec/plan ready" 1순위 후보로 표기. **기존 워크트리도 확인**: 이전 세션이 spec/plan만 쓰고 STOP했으면(§4) 문서가 워크트리 브랜치에만 있다 — `ls .claude/worktrees/*/docs/superpowers/specs/ .claude/worktrees/*/docs/superpowers/plans/`까지 봐야 ready 판정이 정확하다.

## 2) worktree 생성·진입
- `.claude/settings.local.json`의 **top-level** `"worktree": {"baseRef": "head"}` 확인 — **없으면 추가** (remote 미설정이라 기본 `fresh`=`origin/<default>`가 실패).
- 해당 작업의 워크트리가 **이미 있으면**(이전 세션이 spec/plan 작성 후 STOP) 새로 만들지 말고 `EnterWorktree(path: .claude/worktrees/<기존-slug>)`로 재진입.
- 없으면 `EnterWorktree`로 `.claude/worktrees/<작업-slug>` 생성·진입 (master 최신 HEAD에서 분기).

## 3) baseline 빌드 — subagent 띄우기 전 필수
```bash
cd ui && pnpm install && cd ..   # 전역 store라 수초
cargo build --workspace          # UI-only 슬라이스여도 필수: pre-commit이 전체 cargo 게이트 + cold-build flake 예방
```

## 4) 설계 핸드오프 — spec/plan 파일 실존 기준으로 분기
- spec **과** plan 둘 다 **세션 시작 시점부터 있음** → `superpowers:subagent-driven-development`로 곧장 구현.
- spec만 있음(또는 상위 spec §가 이 슬라이스를 이미 정의 — 예: 영역 U의 spec §8) → `superpowers:writing-plans`부터.
- 둘 다 없음 → `superpowers:brainstorming`부터. **brainstorming 산출 첫 게이트 = spec 착수 전 US 초안(2–5개, 규약 `docs/dev/user-story-spine.md` — 버그는 재현/기대/실측, 내부-only는 `US: N/A — 이유` 대체 가)을 사용자에게 단독 제시·승인** — 요구 왜곡을 spec 전에 잡는 지점(플러그인 brainstorming 스킬이 아니라 이 불릿이 규칙 정본). 이후 spec(앞머리 `사용자 스토리 (US)` 고정 헤딩 블록 필수) → plan 순으로 쓰되, **각 문서를 `spec-plan-reviewer`가 `APPROVE`할 때까지 반복 검토**(1회로 끝내지 말 것):
  1. 문서를 `spec-plan-reviewer`에 넘긴다 — **plan 리뷰 디스패치엔 동반 spec 경로를 병기**(리뷰어가 "US 대비 task 누락"을 대조할 수 있게).
  2. **finding 무비판 반영 금지** — 각 finding을 코드/요구사항에 대조해 *타당성*부터 판단(`superpowers:receiving-code-review` 태도): 타당+범위 내 → 반영 / 틀림·과설계·범위 밖 → 반영 안 함 + **기각 근거 1줄 기록**(push back). 애매하면 사용자에게 확인.
  3. 하나라도 반영했으면 **수정본을 같은 reviewer에 재검토 의뢰**(이 하니스엔 subagent resume 없음 → finding 처리 결과를 담은 새 self-contained 호출). Verdict가 **`APPROVE`** 될 때까지 2–3을 반복 — `APPROVE-WITH-FIXES`/`NEEDS-REWORK`는 *미통과*다.
  4. 라운드 상한 3–4회. 미수렴(reviewer가 같은 류를 계속 제기 / 내가 다수 finding을 근거로 기각해 교착)이면 그 disagreement를 사용자에게 요약해 판단을 받는다.
  spec이 `APPROVE`된 뒤에 plan을 쓰고, plan도 같은 루프로 `APPROVE`까지.
- **REVIEW-GATE 마커 — clean `APPROVE` 후에만.** plan이 reviewer로부터 **clean `APPROVE`**(`APPROVE-WITH-FIXES`/`NEEDS-REWORK`는 미통과)를 받으면, plan 파일에 `REVIEW-GATE: APPROVED` 한 줄(또는 `<!-- REVIEW-GATE: APPROVED -->`)을 추가한다 — 이 마커가 "spec+plan 둘 다 루프 통과" 신호이고, **없으면 `.claude/hooks/spec-review-guard.sh`가 `crates/*/src`·`ui/src` 편집을 차단**한다. 마커는 reviewer verdict를 못 보는 훅의 프록시이므로(= tdd-guard와 같은 신뢰 모델), **미통과 상태에서 마커를 다는 건 위조**다. 가드는 EOL-앵커 정확매치라 `APPROVE-WITH-FIXES`/`APPROVED WITH FIXES` 같은 부분문자열은 통과 못 한다.
- **STOP 게이트 — 이 세션에서 spec/plan을 새로 썼다면 구현으로 자동 진입 금지.** plan까지 reviewer 승인(+위 마커)이 끝나면: ① spec/plan을 워크트리 브랜치에 커밋(docs-only라 pre-commit fast-path로 수초), ② 사용자에게 "`/clear` 후 `/start-slice` 재실행 → spec/plan ready 경로로 구현 진입"을 안내하고 **턴 종료**. spec/plan 작성으로 비대해진 컨텍스트를 그대로 끌고 구현에 들어가지 않는다 — 구현은 항상 fresh 컨텍스트에서 시작. ("곧장 구현" 분기는 위 첫 줄처럼 세션 시작 시점에 파일이 이미 존재했던 경우만.)
- **내(orchestrator)가** 이후 띄우는 모든 subagent prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>`을 직접 써 넣는다(CLAUDE.md Subagent dispatch 노하우 — subagent 스킬이 대신 해주지 않는다).
