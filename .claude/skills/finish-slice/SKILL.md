---
name: finish-slice
description: Use when a slice/feature is implemented in a worktree and ready to land on master — merge, cleanup, docs/memory recording, and next-task handoff time. 구현·최종 리뷰가 끝나 master 합류와 마무리 기록이 필요할 때 사용자가 /finish-slice로 호출.
disable-model-invocation: true
---

# finish-slice — 슬라이스 완료 의식

CLAUDE.md에 흩어진 머지·마무리 체크리스트를 순서대로 실행한다. 과거 사고: conflict marker가 `.md` fast-path로 커밋됨(Slice 9c), Playwright png·`.playwright-mcp` 잔류, ExitWorktree "N commits discarded" 거부.

`<branch>` = 현재 워크트리 브랜치(`git branch --show-current`), `<메인>` = `/Users/sgj/develop/handicap`.

## 0) 전제 확인 — 하나라도 빠졌으면 먼저 수행
- [ ] 최종 `handicap-reviewer` 리뷰 READY-TO-MERGE
- [ ] **라이브 검증 1회** — 합격 기준: run 1개 생성→리포트 확인 + 브라우저 콘솔 Zod 에러 0 (S-D 함정: RTL·tsc는 서버-`null` Zod 미스매치를 못 잡음). UI 변경이면 Playwright로, 백엔드면 워크트리 *자체* 바이너리(`./target/debug/controller --db /tmp/x.db`, 먼저 `cargo build -p handicap-worker`)로 curl run.
- [ ] UI 변경 시: `cd ui && pnpm lint && pnpm test && pnpm build` (pre-commit은 cargo만 돌린다)

## 1) 정리 grep (워크트리 root에서)
```bash
grep -rn '^<<<<<<<\|^>>>>>>>' --include='*.md' . | grep -v node_modules   # 출력 없어야 함
rm -rf .playwright-mcp
ls *.png ui/*.png 2>/dev/null    # Playwright 스크린샷 잔류물이면 rm (커밋된 문서 이미지는 제외)
find crates -name '_tdd_keepalive.rs' -exec rm {} +                       # keepalive stub 제거
git status --porcelain                                                     # untracked 잔류물 0 확인
```

## 2) ff-merge (워크트리 안에서, cd·checkout 없이)
```bash
git -C <메인> status --porcelain -uno          # 메인 클린 확인
git -C <메인> merge-base --is-ancestor master <branch> && echo ff-ok
# ff-ok 아니면(세션 중 master 전진): 워크트리에서 git rebase master 후 재확인
#   (워크트리는 메인과 같은 repo ref를 공유 — 로컬 master가 그대로 보인다)
git -C <메인> merge --ff-only <branch>
git -C <메인> log --oneline -3                  # landed 확인 — commit/merge는 파이프 금지(exit code 마스킹)
```

## 3) 워크트리 정리
머지 landed 확인 **후** `ExitWorktree(remove)` — 생성 base 기준 "N commits discarded"로 거부되면 `discard_changes: true`로 재호출(커밋은 이미 master에 안전).

## 4) 문서 + 메모리
- `docs/build-log.md`에 한 단락 append (파이프라인·함정 출처·라이브 검증 결과)
- 루트 CLAUDE.md의 상태 줄을 **한 줄 교체** (append 금지 — "어디까지 됐나"만): `grep -n '^\*\*상태:' CLAUDE.md`로 찾은 그 한 문단
- 새 ADR이 생겼으면 "알아둘 결정들" 인덱스에 번호순 **한 줄만**
- 자동메모리(`~/.claude/projects/-Users-sgj-develop-handicap/memory/`): 해당 작업의 기존 메모리 파일 우선 업데이트(없으면 생성) + `MEMORY.md` 인덱스 한 줄 갱신

## 5) CLAUDE.md 함정 기록
`claude-md-management:revise-claude-md` 스킬 호출 — 이번 세션 함정을 **변경이 속한 도메인**의 CLAUDE.md(ui 변경이면 `ui/CLAUDE.md` 등, 크로스커팅만 루트)에 한 줄씩, 출처 태그 포함.

## 6) 다음 작업 추천 → 종료
`docs/roadmap.md` + 메모리 `MEMORY.md`를 읽고 후보 2–3개를 근거와 함께 표로 제시. 마지막 줄: "`/clear` 후 `/start-slice`로 시작하세요."
