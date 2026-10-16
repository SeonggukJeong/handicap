---
name: finish-slice
description: Use when a slice/feature is implemented in a worktree and ready to land on master — merge, cleanup, docs/memory recording, and next-task handoff time. 구현·최종 리뷰·라이브 검증이 끝나 master 합류와 마무리 기록이 필요할 때. 사용자가 /finish-slice로 호출하거나, subagent-driven 슬라이스의 마지막 단계로 orchestrator(model)가 직접 호출(아래 0) 전제 확인을 먼저 통과시킬 것).
---

# finish-slice — 슬라이스 완료 의식

CLAUDE.md에 흩어진 머지·마무리 체크리스트를 순서대로 실행한다. 과거 사고: conflict marker가 `.md` fast-path로 커밋됨(Slice 9c), Playwright png·`.playwright-mcp` 잔류, ExitWorktree "N commits discarded" 거부, **워크트리-격리 세션에서 `git -C <메인>` 거부로 ff-merge 불가**(extract-base64-decode 2026-10-16).

`<branch>` = 현재 워크트리 브랜치(`git branch --show-current`), `<메인>` = `/Users/sgj/develop/handicap`, `<WT>` = 워크트리 경로(`.claude/worktrees/<slug>`).

**순서 원칙**: 문서·함정 기록(§2–§3)은 **머지 전에 워크트리 안에서** 커밋한다(그래야 머지 한 번에 코드+기록이 같이 landed — build-log의 "finish head" SHA가 이것). 워크트리-격리 세션은 **메인 체크아웃을 겨누는 git 명령(`git -C <메인> …`)을 거부**하므로, 머지(§5)는 `ExitWorktree(keep)`로 세션을 메인에 되돌린 **뒤** 메인에서 실행한다. `ExitWorktree(remove)`는 머지 전에 부르면 커밋을 버리고, 머지 후엔 이미 세션이 메인에 있어 쓸 일이 없다 — 정리는 §6의 수동 명령으로.

## 0) 전제 확인 — 하나라도 빠졌으면 먼저 수행
- [ ] 최종 `handicap-reviewer` 리뷰 READY-TO-MERGE
- [ ] **보안 표면 게이트(path-gated — blanket 아님)**: 슬라이스 diff가 보안 민감 표면(요청 실행·템플릿/캐스트·env/데이터셋 바인딩·업로드 파싱·trace/body 뷰어 = SSRF·시크릿 누출·템플릿 인젝션이 사는 곳)을 건드리면 `security-reviewer` APPROVE 필수. 기계적으로 판정:
  ```bash
  git diff master...HEAD --name-only | grep -E \
    'crates/engine/src/(template|cast|extract|executor|dataset|trace)\.rs|crates/controller/src/binding\.rs|crates/controller/src/api/test_runs\.rs|crates/controller/src/datasets/|ui/src/components/scenario/TestRunPanel\.tsx|ui/src/pages/ScenarioImportPage\.tsx'
  ```
  매치 있음 → `security-reviewer` 실행, **clean APPROVE를 목표로 fix→(그 fix만) focused 재검토 반복**. ① 각 finding은 `receiving-code-review`로 타당성 먼저 판정 — 틀림·과설계·범위밖(예: §7 연기 항목)은 근거 1줄로 **기각**(맹종이 루프를 늘린다), 타당한 건 fix하며 APPROVE로 수렴. ② **무한 루프 valve: 루프가 5회를 초과하면(6라운드째) 자동 진행/포기 말고 사용자에게 질문** — 남은 finding 요약 + "더 돌릴지" 판단 요청(품질 목표는 유지, 무한만 차단). 매치 없음 → **build-log에 "보안 표면 무관(N/A)" 한 줄로 명시 스킵**(UI 폴리시·리포트·docs 슬라이스는 대부분 여기). (`scenario.rs` URL-검증 변경 등 set 밖이라도 요청 구성에 닿으면 판단으로 추가.) 이 게이트가 `security-reviewer`의 트리거 — "쓸지 기억"이 아니라 diff가 결정.
- [ ] **라이브 검증 1회** — 합격 기준: run 1개 생성→리포트 확인 + 브라우저 콘솔 Zod 에러 0 (S-D 함정: RTL·tsc는 서버-`null` Zod 미스매치를 못 잡음). UI 변경이면 Playwright로, 백엔드면 워크트리 *자체* 바이너리(`./target/debug/controller --db /tmp/x.db`, 먼저 `cargo build -p handicap-worker`)로 curl run. **단, production diff 0인 슬라이스(테스트/문서-only)는 성립 대상 없음 — 생략하고 근거를 build-log에 기록**(skip/todo 정리 2026-06-12).
- [ ] UI 변경 시: `cd ui && pnpm lint && pnpm test && pnpm build` (pre-commit은 cargo만 돌린다)

## 1) 정리 grep (워크트리 root에서)
```bash
grep -rn '^<<<<<<<\|^>>>>>>>' --include='*.md' . | grep -v node_modules   # 출력 없어야 함
rm -rf .playwright-mcp
ls *.png ui/*.png 2>/dev/null    # Playwright 스크린샷 잔류물이면 rm (커밋된 문서 이미지는 제외)
find crates -name '_tdd_keepalive.rs' -exec rm {} +                       # keepalive stub 제거
git status --porcelain                                                     # untracked 잔류물 0 확인
```

## 2) 문서 + 메모리 (워크트리 안에서 편집)
- `docs/build-log.md`에 한 단락 append (파이프라인·함정 출처·라이브 검증 결과 + **라이브로 증명된 US / 못 한 US 한 줄** — US 스파인, 규약 `docs/dev/user-story-spine.md`; `US: N/A` 슬라이스는 생략)
- 루트 CLAUDE.md의 상태 줄을 **한 줄 교체** (append 금지 — "어디까지 됐나"만): `grep -n '^\*\*상태:' CLAUDE.md`로 찾은 그 한 문단
- 새 ADR이 생겼으면 "알아둘 결정들" 인덱스에 번호순 **한 줄만**
- spec 앞머리 `상태` 줄을 완료로 갱신(코드 SHA 범위·연기 포인터).
- **`docs/roadmap.md` 완료 항목 마킹**: 이번 슬라이스가 roadmap의 후보/연기 항목을 닫았으면 그 불릿을 `~~취소선~~ + ✅ 완료(머지 SHA)`로 갱신 + `docs/roadmap-status.md` frontier 전진. **단 roadmap.md `## 현재 상태` 섹션은 건드리지 말 것** — 포인터-only로 동결됐다(2026-07-16 결정; "최신 완료 = X" 마커는 상태줄·build-log·MEMORY와 중복돼 드리프트하므로 재삽입 금지). roadmap-archive.md 완료 이력도 2026-06-28 스냅샷 동결이라 append 안 함.
- **이번 슬라이스의 연기·판단을 roadmap.md §B 새 블록으로**(사용자 지시 2026-10-16): SDD ledger(`.superpowers/sdd/`)는 gitignore라 워크트리와 함께 사라진다 — orchestrator ruling(미수정 finding·lock 미동기화·약한 테스트 유지 등)은 **틀렸을 때의 비용 + 구체 해소 경로**와 함께, 리뷰가 찾은 선재 버그·spec §7 연기(재개 신호)·보안/성능 nit·테스트 polish까지 묶어 기록. 선례 §B30.
- 자동메모리(`~/.claude/projects/-Users-sgj-develop-handicap/memory/` — repo 밖이라 커밋 대상 아님): 해당 작업의 기존 메모리 파일 우선 업데이트(없으면 생성) + `MEMORY.md` 인덱스 한 줄 갱신. **MEMORY.md가 ~24KB 한도에 근접했으면 새 `직전 =` 추가 시 직전/직전직전 verbose 항목을 한 줄로 압축하며 demote**(상세는 build-log에 이미 있음) — 4번째 verbose 항목 append나 매번 `/curate-memory` 대신 compress-on-demote가 가볍다(곡선 VU 표시 세션 2026-06-24: 23KB→13.5KB)

## 3) CLAUDE.md 함정 기록
`claude-md-management:revise-claude-md` 스킬 호출 — 이번 세션 함정을 **변경이 속한 도메인**의 CLAUDE.md(ui 변경이면 `ui/CLAUDE.md` 등, 크로스커팅만 루트)에 한 줄씩, 출처 태그 포함. 서사·사례가 긴 프로세스 함정은 `docs/dev/*.md`(예: `subagent-dispatch.md`)로.

- **문서 예산 확인**: `just doc-budget` — root 초과면 재분배를 먼저(`docs/dev/root-doc-maintenance.md` 절차), WARN이면 다음 슬라이스에 예고. 상태줄 FAIL(상한 초과)이면 `최신 =` 문구를 줄여 재실행. **§2가 아니라 여기(§3 끝)에서 돌린다** — §2의 상태줄 교체와 이 §3의 크로스커팅 함정 append가 root를 키우는 두 경로인데, §2에서 돌리면 **그 슬라이스 자신의 함정 추가**를 게이트가 못 본다.

## 4) 기록 커밋 (워크트리 안에서)
```bash
git add <§2·§3에서 고친 파일들>          # 경로 명시 — macOS 대소문자 함정 때문에 add 후 반드시 확인
git diff --cached --name-only             # 기대 목록과 일치·비어 있지 않음
git commit -F <scratchpad>/finish-msg.txt # 메시지는 파일로: 제목 + 빈 줄 + Co-Authored-By 트레일러
git log -1 --oneline                      # landed 확인
```
- `.md`만이면 pre-commit fast-path(수초). **커밋 명령은 단독 호출**(`cd … && git commit` 같은 복합 명령·두 번째 `-m`·en-dash는 워크트리-격리 검증기가 거부할 수 있다 — 그래서 `-F <파일>`).

## 5) ff-merge — `ExitWorktree(keep)` 후 메인에서
1. `ExitWorktree(action: "keep")` — 세션 cwd가 `<메인>`으로 돌아온다(워크트리·브랜치는 그대로).
2. 메인에서(각각 단독 명령, 파이프 금지):
```bash
git branch --show-current                         # master 여야 함
git status --porcelain -uno                       # 메인 클린 확인(출력 없음)
git merge-base --is-ancestor master <branch> && echo ff-ok
# ff-ok 아니면(세션 중 master 전진): 워크트리로 돌아가(EnterWorktree(path: <WT>)) git rebase master → §4 재확인 → 다시 1부터
git merge --ff-only <branch>
git log --oneline -5                              # landed 확인 — commit/merge는 파이프 금지(exit code 마스킹)
```
- 세션이 워크트리-격리가 아니라 `git -C <메인>`이 허용되면 1을 건너뛰고 워크트리 안에서 `git -C <메인> …`로 같은 명령을 돌려도 된다(그 경우 정리는 §6 대신 `ExitWorktree(remove, discard_changes: true)`).

## 6) 워크트리 정리 (메인에서, 머지 landed 확인 후)
```bash
git worktree remove <WT>                          # 1차 시도
```
- **"Directory not empty"로 실패하면**(rust-analyzer 등이 `target/flycheck0`에 계속 써서 — extract-base64-decode 2026-10-16) 등록은 해제됐어도 디렉토리가 남는다. 지우기 전에 **잔류물이 master에 없는 것인지 확인**:
  ```bash
  (cd <WT> && find . -type f -not -path './.git' | sed 's|^\./||' | sort) > /tmp/wt-left.txt
  git ls-files | sort > /tmp/wt-master.txt
  comm -23 /tmp/wt-left.txt /tmp/wt-master.txt     # 기대: .superpowers/sdd/·target/ 등 gitignore 잔류물뿐
  ```
  SDD ledger의 ruling이 §2에서 roadmap §B로 옮겨졌는지 확인한 뒤 `rm -rf <WT>`.
- 이어서 `git worktree prune` → `git branch -d <branch>`(머지됐으니 `-d`로 충분 — 거부되면 머지가 안 된 것이니 멈출 것) → `git worktree list`에 `<WT>` 부재 확인 → `rm -f /tmp/wt-*.txt`.

## 7) 다음 작업 추천 → 종료
`docs/roadmap-status.md`(현황판 — "추천 다음 작업" 열) + 필요 시 `docs/roadmap.md` + 메모리 `MEMORY.md`를 읽고 후보 2–3개를 근거와 함께 표로 제시. origin push는 하지 않는다(주기적 push는 별도 요청 시). 마지막 줄: "`/clear` 후 `/start-slice`로 시작하세요."
