---
name: start-slice
description: Use when starting a new slice of work, typically right after a context reset — picking the next task and preparing an isolated worktree. 컨텍스트 초기화 직후 다음 작업 선택·worktree 준비가 필요할 때 사용자가 /start-slice로 호출.
disable-model-invocation: true
---

# start-slice — 슬라이스 시작 부트스트랩

작업 선택 → worktree 생성 → baseline 빌드 → 설계 핸드오프. 과거 사고(A1): 새 워크트리엔 `ui/node_modules`·`target/`이 없어 첫 subagent가 deps 없음으로 즉사.

## 1) 작업 후보 제시
`docs/roadmap.md`(post-MVP1 단일 진입점) + 메모리 `MEMORY.md`(🎯/🔄 = 예정·진행 중)를 읽고 후보 2–3개를 근거(가치·의존성·크기)와 함께 표로 제시 → `AskUserQuestion`으로 선택받기.

**준비 상태 판정은 파일 실존으로** (메모리·roadmap 서술이 서로 어긋날 수 있다): `docs/superpowers/specs/`·`docs/superpowers/plans/`에 해당 작업의 문서가 실제로 있는지 `ls`로 확인하고, 있으면 그 작업을 "spec/plan ready" 1순위 후보로 표기.

## 2) worktree 생성·진입
- `.claude/settings.local.json`의 **top-level** `"worktree": {"baseRef": "head"}` 확인 — **없으면 추가** (remote 미설정이라 기본 `fresh`=`origin/<default>`가 실패).
- `EnterWorktree`로 `.claude/worktrees/<작업-slug>` 생성·진입 (master 최신 HEAD에서 분기).

## 3) baseline 빌드 — subagent 띄우기 전 필수
```bash
cd ui && pnpm install && cd ..   # 전역 store라 수초
cargo build --workspace          # UI-only 슬라이스여도 필수: pre-commit이 전체 cargo 게이트 + cold-build flake 예방
```

## 4) 설계 핸드오프 — spec/plan 파일 실존 기준으로 분기
- spec **과** plan 둘 다 있음 → `superpowers:subagent-driven-development`로 곧장 구현.
- spec만 있음(또는 상위 spec §가 이 슬라이스를 이미 정의 — 예: 영역 U의 spec §8) → `superpowers:writing-plans`부터.
- 둘 다 없음 → `superpowers:brainstorming`부터. 이후 spec → `spec-plan-reviewer` 검토 → 반영 루프 → plan → 같은 루프.
- **내(orchestrator)가** 이후 띄우는 모든 subagent prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>`을 직접 써 넣는다(CLAUDE.md Subagent dispatch 노하우 — subagent 스킬이 대신 해주지 않는다).
