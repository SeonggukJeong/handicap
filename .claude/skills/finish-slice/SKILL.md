---
name: finish-slice
description: Use when a slice/feature is implemented in a worktree and ready to land on master — merge, cleanup, docs/memory recording, and next-task handoff time. 구현·최종 리뷰·라이브 검증이 끝나 master 합류와 마무리 기록이 필요할 때. 사용자가 /finish-slice로 호출하거나, subagent-driven 슬라이스의 마지막 단계로 orchestrator(model)가 직접 호출(아래 0) 전제 확인을 먼저 통과시킬 것).
---

# finish-slice — 슬라이스 완료 의식

CLAUDE.md에 흩어진 머지·마무리 체크리스트를 순서대로 실행한다. 과거 사고: conflict marker가 `.md` fast-path로 커밋됨(Slice 9c), Playwright png·`.playwright-mcp` 잔류, ExitWorktree "N commits discarded" 거부.

`<branch>` = 현재 워크트리 브랜치(`git branch --show-current`), `<메인>` = `/Users/sgj/develop/handicap`.

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
- `docs/build-log.md`에 한 단락 append (파이프라인·함정 출처·라이브 검증 결과 + **라이브로 증명된 US / 못 한 US 한 줄** — US 스파인, 규약 `docs/dev/user-story-spine.md`; `US: N/A` 슬라이스는 생략)
- 루트 CLAUDE.md의 상태 줄을 **한 줄 교체** (append 금지 — "어디까지 됐나"만): `grep -n '^\*\*상태:' CLAUDE.md`로 찾은 그 한 문단
- 새 ADR이 생겼으면 "알아둘 결정들" 인덱스에 번호순 **한 줄만**
- **`docs/roadmap.md` 완료 항목 마킹**: 이번 슬라이스가 roadmap의 후보/연기 항목을 닫았으면 그 불릿을 `~~취소선~~ + ✅ 완료(머지 SHA)`로 갱신 + `docs/roadmap-status.md` frontier 전진. **단 roadmap.md `## 현재 상태` 섹션은 건드리지 말 것** — 포인터-only로 동결됐다(2026-07-16 결정; "최신 완료 = X" 마커는 상태줄·build-log·MEMORY와 중복돼 드리프트하므로 재삽입 금지). roadmap-archive.md 완료 이력도 2026-06-28 스냅샷 동결이라 append 안 함.
- 자동메모리(`~/.claude/projects/-Users-sgj-develop-handicap/memory/`): 해당 작업의 기존 메모리 파일 우선 업데이트(없으면 생성) + `MEMORY.md` 인덱스 한 줄 갱신. **MEMORY.md가 ~24KB 한도에 근접했으면 새 `직전 =` 추가 시 직전/직전직전 verbose 항목을 한 줄로 압축하며 demote**(상세는 build-log에 이미 있음) — 4번째 verbose 항목 append나 매번 `/curate-memory` 대신 compress-on-demote가 가볍다(곡선 VU 표시 세션 2026-06-24: 23KB→13.5KB)

## 5) CLAUDE.md 함정 기록
`claude-md-management:revise-claude-md` 스킬 호출 — 이번 세션 함정을 **변경이 속한 도메인**의 CLAUDE.md(ui 변경이면 `ui/CLAUDE.md` 등, 크로스커팅만 루트)에 한 줄씩, 출처 태그 포함.

## 6) 다음 작업 추천 → 종료
`docs/roadmap.md` + 메모리 `MEMORY.md`를 읽고 후보 2–3개를 근거와 함께 표로 제시. 마지막 줄: "`/clear` 후 `/start-slice`로 시작하세요."
