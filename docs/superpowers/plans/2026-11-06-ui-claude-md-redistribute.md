# ui/CLAUDE.md 재분배 1차 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog 계열 23개 소스와 23개 테스트를 `ui/src/components/run/`으로 **동작 변경 없이** 옮긴다(§B17). ui/CLAUDE.md 불릿 35개와 compare 3개를 실수 지점 기준으로 하위 문서에 **원문 그대로** 옮긴다. ui/CLAUDE.md는 113,306 B에서 ≤ 92,160 B(예상 ≈ 88.5 KB + 머리말)가 되고, 이동·보존·회귀를 기계로 증명한다.

**Architecture:** 3겹이다.
- **검증 도구를 먼저 만들고 이동 전 기준값을 저장한다**(Task 1).
- **소스 이동 1 커밋**(Task 2).
- **문서 이동**: 게이트 확장(Task 3) → relocate/refix 실행(Task 4) → 배선(Task 5) → 라이브(Task 6).

각 검증은 base·변경 후 **두 상태**의 기대값을 가진다.

**Tech Stack:** Python 3 스크립트(`scripts/`), git, pnpm/vitest/vite(`ui/`), just.

**Spec:** `docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-design.md`

**정본 동반 파일(전부 `docs/superpowers/specs/` — byte-exact, 손으로 옮겨 적지 말 것)**

| 파일 | 내용 |
|---|---|
| `2026-11-06-ui-claude-md-redistribute-bullet-map-final.tsv` | 확정 분류. 191행 = ui 180 + compare 11, `#` 꼬리에 산출·refix·D7 사전스캔. 열 `src_file line kind bytes anchor dest_file mistake_sites substitutions reason` |
| `2026-11-06-ui-claude-md-redistribute-refix.tsv` | refix 행 2개. manifest 행 형식 그대로이며 기계 추출·치환 검증됨(+106 B·+7 B) |
| `2026-11-06-ui-claude-md-redistribute-d7-adjudication.tsv` | D7 판정 12행. 키 = (base file, anchor, 매치 텍스트) |
| `2026-11-06-ui-claude-md-redistribute-importers.py` | V6. `python3 -I <파일> ui/src` |

## Global Constraints

- base = `57830b90`. 모든 "base 기대값"은 이 커밋 기준이다.
- **ui/src 의미 변경 0.** 이동 파일은 모듈 지정자 문자열만 바꾼다. 대상 6형: `import … from`·`export … from`·`import("…")`·`vi.mock("…")`·`vi.importActual("…")`·`typeof import("…")`.
- 코드·주석·포맷·export 이름·barrel·별칭 변경 금지. **prettier 실행 금지.**
- **`ui/src/**/*.ts(x)`에 Edit/Write 도구 사용 금지.** `.claude/hooks/format.sh`가 Edit/Write 뒤에 `prettier --write`를 자동 실행해 줄을 다시 감싼다. 그러면 V2가 깨지고 V1의 줄 번호 키가 밀린다. 지정자 재작성은 전부 scratchpad python으로 한다. 이 경로는 tdd-guard·spec-review-guard도 거치지 않는다(둘 다 Write/Edit 훅). spec §2.3의 `it.todo` 폴백은 불필요하다.
- **TSV는 `line.split('\t')`로만 읽는다.** `csv` 모듈은 따옴표로 시작하는 anchor(ui 119·121)를 벗겨 망가뜨린다.
- 불릿 이동은 **byte-identical**이다. 예외는 manifest에 선언한 치환 쌍뿐이다. 불릿 쪼개기·병합·재분류 금지(재분류 필요 = STOP → 사용자).
- ui/CLAUDE.md 상한 **92,160 B**(사용자 결정).
- 하위 문서 신설은 `ui/src/components/run/CLAUDE.md`·`ui/src/scenario/CLAUDE.md` **두 개만**이다. 확정 분류상 비는 섹션이 없으므로 헤딩 삭제 조건부 스텝은 발동하지 않는다.
- 게이트·커밋에 `| tail`/`| head` 금지. 판정은 `; echo "exit=$?"`, 커밋 후 `git log -1`. `--no-verify` 금지.
- 파일 복원은 `git restore -- <파일>`로 한다. `git checkout`은 git-guard가 ask로 막는다.
- 워크트리 루트: `/Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute`. 이동 전 기준값은 `.superpowers/sdd/baseline/`(gitignore)에 둔다.
- RED 실증은 **지정 FAIL 문구가 출력에 있어야** 인정한다.
- per-task 리뷰는 `model: opus`로 받는다(spec §6).

## Review Focus

1. **`vi.mock` 경로가 틀려도 테스트가 통과하는 경우** — Task 1 V1 이빨 + Task 2 V1.
2. **이동 파일 안 "밖을 가리키는" import 깊이 오류** — V1 + `tsc -b`.
3. **옮긴 불릿 속 상대 참조 깨짐** — Task 4 D7 + 배치 규칙.
4. **불릿 소실·중복** — Task 3 D3 자체 테스트 + Task 4 실데이터.
5. **V2 마스킹이 너무 넓어 실변경을 가림** — Task 1 V2 이빨.

---

### Task 1: Part A 검증 도구 + 이동 전 기준값 보존

**Files:**
- Create: `scripts/check-ui-specifiers.py`
- Create: `docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-move-table.tsv`
- Output(커밋 안 함): `.superpowers/sdd/baseline/{specifiers.json, vitest.json, empty-move.tsv, dist/, dist2/}`

**Interfaces:**
- Produces
  - `python3 scripts/check-ui-specifiers.py snapshot <out.json>`
    - `ui/src` 아래 모든 `.ts/.tsx`의 상대 지정자(`./`·`../`)를 해석해 JSON으로 저장한다.
    - 키 `"<repo-rel file>:<line>:<k>"`(그 줄의 k번째 상대 지정자, 0부터), 값 `{"spec": str, "target": repo-rel path | null}`.
    - 해석 순서: `<spec>`, `.ts`, `.tsx`, `/index.ts`, `/index.tsx` 중 실재 첫 매치.
    - 추출 정규식 3개(지정자 = 그룹 2): `from\s+(['"])(\.{1,2}/[^'"]+)\1` · `import\(\s*(['"])(\.{1,2}/[^'"]+)\1` · `vi\.(?:mock|importActual|doMock)\(\s*(['"])(\.{1,2}/[^'"]+)\1`.
  - `… compare <base.json> <move-table.tsv>`
    - base 키의 파일 경로와 target을 move table로 사상(옛→새, 표에 없으면 항등)한 뒤 현재 snapshot과 비교한다.
    - 출력: `FAIL [V1] 미해석: <key> <spec>` · `FAIL [V1] 대상 불일치: <key> base=<t1> now=<t2>` · `FAIL [V1] 키 누락: <key>` · `FAIL [V1] 키 추가: <key>`.
    - 끝 줄 `OK: 지정자 N개` 또는 `FAIL: …`. FAIL이면 exit 1.
  - `… identity <base-ref> <move-table.tsv>` — V2.
    - **마스킹 = V1 정규식 3개가 잡은 지정자 스팬(그룹 2)만** `§SPEC§`로 치환한다. 그 외 문자 하나도 건드리지 않는다.
    - move table 각 (옛, 새)마다 `git show <base-ref>:<옛>` vs 작업트리 `<새>`를 마스킹 후 byte 비교한다.
    - 이동 안 한 파일: move table `old`·`new`에 없는 `ui/src` 파일 중 base와 내용이 다른 것(`git diff --name-only <base-ref> -- ui/src`에서 move table 경로 제외) 각각을 `git show <base-ref>:<파일>` vs 작업트리로 같은 마스킹 후 byte 비교한다. 소비처 수 C = 이 비교 대상 수다.
    - 출력 `FAIL [V2] 내용 변경: <파일>`, 끝 줄 `OK: 이동 M · 소비처 C`.
  - `… testset <base.json> <now.json>`
    - vitest `--reporter=json` 두 파일의 `(basename(testResults[].name), assertionResults[].fullName, status)` 다중집합을 비교한다.
    - 출력 `FAIL [V3] 사라짐: …`/`FAIL [V3] 생김: …`, 끝 줄 `OK: 파일 F · 테스트 T`(F = `testResults` 항목 수).
  - move table TSV: 헤더 `old<TAB>new`, 46행이다.
    - 소스 23: `ui/src/components/<N>.<ext>` → `ui/src/components/run/<N>.<ext>`.
    - 테스트 23: `ui/src/components/__tests__/<T>` → `ui/src/components/run/__tests__/<T>`.
    - 이름은 spec §1 표대로다. RunDialog 테스트 2개와 `scaleVuStages.test.ts`를 포함하고, CriteriaFields·loadShapes는 테스트가 없다.

- [ ] **Step 1: move table 작성 + 확인**
  - `python3 -c "r=open('docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-move-table.tsv').read().split('\n');import os;rows=[l.split('\t') for l in r[1:] if l];print(len(rows),sum(not os.path.exists(o) for o,n in rows))"` → `46 0`
- [ ] **Step 2: `check-ui-specifiers.py` 구현**(4개 서브커맨드)
  - 사전조건 기록: bare side-effect import(`import "./x"`)는 정규식 밖이다. `grep -rnE "^import ['\"]\." ui/src`로 이동 집합 내 0건을 확인한다(실측 2건 `main.tsx`·`PrintDocument.tsx`, 둘 다 이동 안 함).
- [ ] **Step 3: base 자기 대조**(빈 move table = 헤더만, `.superpowers/sdd/baseline/empty-move.tsv`)
  - `python3 scripts/check-ui-specifiers.py snapshot .superpowers/sdd/baseline/specifiers.json; echo "exit=$?"` → `exit=0`
  - `… compare .superpowers/sdd/baseline/specifiers.json .superpowers/sdd/baseline/empty-move.tsv; echo "exit=$?"` → `OK: 지정자 N개`, `exit=0`(N 기록, 미해석 0)
  - `… identity 57830b90 .superpowers/sdd/baseline/empty-move.tsv; echo "exit=$?"` → `OK: 이동 0 · 소비처 0`, `exit=0`
- [ ] **Step 4: 이빨 3종**(작업트리 일시 변조 → 지정 문구 확인 → `git restore -- <파일>` → `git status --porcelain ui/src` 빈 출력)
  - 이빨 변조는 전부 scratchpad python 또는 `sed -i ''`로 한다(Edit 금지 — prettier 훅).
  - V1: `RunDialog.test.tsx`의 `vi.mock("../VuSizingHelper"` → `"../SlotSizingHelper"` → compare(빈 표)에 `FAIL [V1] 대상 불일치`. 같은 곳을 `"../NoSuchFile"`로 바꾸면 `FAIL [V1] 미해석`.
  - V2: `ui/src/pages/RunDetailPage.tsx:34`의 `{ RunVuCell }` → `{ RunVuCel1 }`(같은 줄 비-지정자 토큰) → `identity 57830b90 empty-move.tsv`에 `FAIL [V2] 내용 변경: ui/src/pages/RunDetailPage.tsx`.
  - V3: baseline vitest JSON 사본에서 `assertionResults` 1건을 지운 파일로 `testset` → `FAIL [V3] 사라짐`. 이건 Step 5 뒤에 실행한다.
- [ ] **Step 5: 테스트·번들 기준값**
  - `cd /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/ui && pnpm vitest run --reporter=json --outputFile=/Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/.superpowers/sdd/baseline/vitest.json; echo "exit=$?"` → `exit=0`
  - `cd /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute && python3 scripts/check-ui-specifiers.py testset .superpowers/sdd/baseline/vitest.json .superpowers/sdd/baseline/vitest.json` → `OK: 파일 255 · 테스트 3387`
  - `cd /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/ui && pnpm build; echo "exit=$?"` → `exit=0` → `cp -R /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/ui/dist /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/.superpowers/sdd/baseline/dist`(절대경로 — Bash cwd 유지 함정)
  - **결정성 확인:** 한 번 더 `pnpm build` → 같은 방식으로 `…/baseline/dist2`.
    - 두 트리를 V5 정규화(파일명·내용의 `-[A-Za-z0-9_-]{8}\.(js|css)` → `-HASH.\1`) 후 비교해 동일이어야 한다.
    - 비결정이면 STOP하고 보고한다(V5를 쓸 수 없다).
- [ ] **Step 6: V6 base 기대값** — `python3 -I docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-importers.py ui/src` → 정확히 11줄
- [ ] **Step 7: 커밋** — `git add scripts/check-ui-specifiers.py docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-move-table.tsv && git diff --cached --name-only` → 2개 → `git commit -m "chore(scripts): ui 소스 이동 검증 도구(V1·V2·V3) + move table"`

### Task 2: Part A — RunDialog 계열 `components/run/` 이동 (단일 커밋)

**Files:**
- Move(git mv): move table 46행
- Modify(지정자만, scratchpad python으로): 이동 46개 + 소비처 7개
  - `components/scenario/TestRunSection.tsx:13`
  - `pages/RunDetailPage.tsx:34`
  - `pages/ScenarioRunsPage.tsx:20,21,25`
  - `pages/SchedulesPage.tsx:12,13,14`
  - `print/conditions.ts:4`
  - `runs/profileSummary.ts:2`
  - `runs/runFilterSort.ts:2`

**Interfaces:**
- Consumes: Task 1 스크립트·기준값·move table.
- Produces: `ui/src/components/run/`(소스 23)·`run/__tests__/`(테스트 23).

- [ ] **Step 1: `git mv`** — `mkdir -p ui/src/components/run/__tests__` 후 move table 46행 전부 → `git status --porcelain | grep -c '^R'` → `46`
- [ ] **Step 2: 지정자 재작성**(scratchpad python, **Edit/Write 금지**)
  - 대상: 이동 파일 + 소비처 7개 파일의 각 상대 지정자.
  - 규칙: base snapshot의 target을 move table로 사상하고, 파일의 새 위치에서 본 상대경로(`./` 또는 `../` 접두, 확장자 없음 — base 표기 형식 유지)로 바꾼다. 문자열 리터럴 안만 치환하고 줄 수는 불변이다.
- [ ] **Step 3: V1** — `python3 scripts/check-ui-specifiers.py compare .superpowers/sdd/baseline/specifiers.json docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-move-table.tsv; echo "exit=$?"` → `OK: 지정자 N개`(Task 1과 같은 N), `exit=0`
- [ ] **Step 4: V2** — `… identity 57830b90 docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-move-table.tsv; echo "exit=$?"` → `OK: 이동 46 · 소비처 7`, `exit=0`
- [ ] **Step 5: V6** — importers 스크립트 → **0줄**(base 11). 그리고 `ls ui/src/components/__tests__ | grep -cE '^(DataBindingPanel|EnvironmentPicker|loadModel|LoadModelFields|LoadShapePreview|openLoopChecks|profileForm|RunDialog|RunListControls|runSummary|RunVuCell|scaleVuStages|ScheduleEventTimeline|ScheduleForm|sizing|SlotSizingHelper|StageCurvePreview|StepCriteriaFields|TriggerBuilder|triggerCron|VuSizingHelper|WorkerSizingHelper)\.'` → `0`(base 23)
- [ ] **Step 6: V3** — `cd /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/ui && pnpm vitest run --reporter=json --outputFile=/Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute/.superpowers/sdd/now-vitest.json; echo "exit=$?"` → `cd /Users/sgj/develop/handicap/.claude/worktrees/ui-claude-md-redistribute && python3 scripts/check-ui-specifiers.py testset .superpowers/sdd/baseline/vitest.json .superpowers/sdd/now-vitest.json; echo "exit=$?"` → `OK: 파일 255 · 테스트 3387`, `exit=0`
- [ ] **Step 7: V4** — `cd ui && pnpm lint && pnpm test && pnpm build; echo "exit=$?"` → `exit=0`
- [ ] **Step 8: V5** — baseline `dist`와 새 `ui/dist`를 Task 1 Step 5 정규화로 비교 → 전 파일 동일. 다르면 **STOP**하고 diff 요약을 보고한다(orchestrator 판정 — 코드 차이면 V2 결함).
- [ ] **Step 9: 커밋**
  - `git add -A ui/src && git diff --cached --name-only` → 53줄(46 이동 + 7 소비처). `git diff --cached -M --stat`의 rename 46.
  - `git commit -m "refactor(ui): RunDialog 계열 23개 소스·테스트를 components/run/으로 이동 (§B17, 경로 문자열만)"`를 FOREGROUND로 실행한다(UI 게이트, timeout 600000).
  - `git log -1 --oneline`.

### Task 3: 문서 이동 게이트 확장 + D3/D7 스크립트 + 자체 테스트

**Files:**
- Modify: `scripts/check-doc-coverage.py`, `Justfile`
- Create: `scripts/check-bullet-conservation.py`(D3+D4), `scripts/check-doc-refs.py`(D7), `scripts/test_doc_gates.py`
- Rename: `scripts/doc-move-manifest.tsv` → `scripts/doc-move-manifest-claude-md-optimize.tsv`(`git mv`, 내용 불변)

**Interfaces:**
- manifest 행 형식(Task 4가 생성)
  - `relocate<TAB><anchor><TAB><dest_file><TAB>-<TAB>0[<TAB><old><TAB><new>]*`
  - `refix<TAB><anchor><TAB><file><TAB>-<TAB>0(<TAB><old><TAB><new>)+`
  - move·merge는 기존 5컬럼이다.
- `check-doc-coverage.py <base> [source] [manifest]` — manifest 생략·빈 문자열이면 `scripts/doc-move-manifest.tsv`다.
- `check-bullet-conservation.py <base> [--map <final.tsv>]`
  - manifest 2개: 활성 `scripts/doc-move-manifest.tsv` = 소스 `ui/CLAUDE.md`, `scripts/doc-move-manifest.compare.tsv` = `ui/src/compare/CLAUDE.md`. refix는 자기 `<file>`에 속한다.
  - base 문서 집합 = `ui/CLAUDE.md` + `git ls-tree -r --name-only <base> ui/src`의 `*/CLAUDE.md`. 현재 집합 = `ui/CLAUDE.md` + `glob('ui/src/**/CLAUDE.md', recursive=True)`.
  - 대상 줄은 `- `·`  - ` 시작 줄이다.
  - `--map`: final TSV를 `split('\t')`로 읽는다. `dest_file`이 STAY·DELETE-IF-EMPTY가 아닌 행의 `mistake_sites` 각 경로가 `dirname(dest_file)` 하위(`ui/CLAUDE.md`면 `ui/`)여야 한다.
- `check-doc-refs.py <base> <adjudication.tsv>`
  - ① **§ 해석(작업트리 전체 ui 문서)** — ②와 **별도의 참조 범위 추출**을 쓴다.
    - 범위: `§` 바로 뒤가 `"`이면 닫는 `"`까지의 내용(따옴표 제거). 아니면 첫 `(`·`)`·`,` 또는 줄 끝까지를 잘라 trim한다.
    - 제외: 범위가 숫자 또는 `[A-Z]\d`로 시작하면 기계 대조에서 뺀다.
    - 대상 헤딩: `§` 앞에 `.md` 경로가 있으면(뒤따르는 backtick·공백 허용) 그 파일의 헤딩, 아니면 ui 문서 6개의 헤딩이다.
    - 일치: spec 규칙 (a) 헤딩 짧은 제목(첫 ` (`·` /` 앞)이 범위의 접두사(조사 꼬리 허용) 또는 (b) 범위가 헤딩 전체의 접두사.
    - 출력 `FAIL [D7] § 해석 실패: <file>:<line> <범위>`.
  - ② **판정 커버리지**: 두 manifest의 relocate·refix 대상 줄의 **base 텍스트**에서 정규식 `(?<![\w가-힣])(위 |아래 |이 섹션|위쪽|아래쪽)|§[^\s,)·(]+|"[^"]+" 섹션`의 각 매치가 adjudication TSV에 (file, anchor, match) 행으로 있어야 한다.
  - adjudication 행 중 대상 줄에 쓰이지 않은 행은 FAIL도 아니고 `판정` 수에도 넣지 않는다(manifest 0행인 base 실행에서 12행 전부 미사용 = 정상).
  - **범위 축소 명시:** 잔류 줄이 옮겨진 내용을 가리키는 경우는 ②의 기계 대상이 아니다. final TSV `# (c)` "STAY lines" 판정과 refix.tsv로 처리했다(리뷰 대상).
- manifest 파일이 없으면 D3·D7은 0행으로 취급한다(Task 3 Step 7 ~ Task 4 사이). coverage의 `MANIFEST_MIN` FAIL은 유지한다.
- Justfile: `doc-coverage BASE="57830b90" FILE="ui/CLAUDE.md" MANIFEST=""` → `python3 scripts/check-doc-coverage.py {{BASE}} {{FILE}} "{{MANIFEST}}"`. `doc-gates-selftest:` → `python3 scripts/test_doc_gates.py`.
- FAIL 문구(이 접두로 시작)

  | 코드 | 문구 |
  |---|---|
  | 컬럼 | `FAIL [manifest] 컬럼 <n>개(<kind>: <기대>)` — 예 `컬럼 6개(relocate: 5+2k)` |
  | relocate | `FAIL [relocate] base 불릿 <n>개(1이어야 함)` · `FAIL [relocate] 연속 줄 가진 불릿` · `FAIL [relocate] 목적지에 치환 적용 줄 없음` · `FAIL [relocate] 치환 old <n>회(1이어야 함)` · `FAIL [relocate] 소스에 원 줄 잔존` |
  | refix | `FAIL [refix] base 줄 <n>개(1이어야 함)` · `FAIL [refix] 치환 결과 줄 없음` · `FAIL [refix] 원 줄 잔존` · `FAIL [refix] 치환 old <n>회(1이어야 함)` |
  | D3 | `FAIL [D3] base 불릿 중복(사전조건)` · `FAIL [D3] 한 줄에 치환 행 2개` · `FAIL [D3] 미귀속: <file>:<line>` · `FAIL [D3] 중복 귀속(<n>회): <file>:<line>` |
  | D4 | `FAIL [D4] mistake_site가 목적지 밖: <src>:<line> <site>` |
  | D7 | `FAIL [D7] § 해석 실패: <file>:<line> <ref>` · `FAIL [D7] 미판정: <file>:<line> <match>` |

- [ ] **Step 1: 자체 테스트 먼저** — `scripts/test_doc_gates.py`
  - 각 케이스: `tempfile.TemporaryDirectory()`에서 `git init` → base fixture를 `git -c user.name=t -c user.email=t -c commit.gpgsign=false commit`으로 커밋 → 작업트리 변형 → 대상 스크립트를 절대경로·`cwd=<tmp>`로 실행 → 기대 FAIL 접두 포함/불포함과 exit를 단언한다.
  - fixture: `ui/CLAUDE.md`(섹션 2·불릿 4, 하나는 `  - ` 연속 줄), `ui/src/compare/CLAUDE.md`, 빈 `scripts/doc-coverage-allowlist.txt`, manifest들.
  - 케이스 15
    1. 정상 relocate(치환 0·1) → OK
    2. 목적지 1 B 변조 → `목적지에 치환 적용 줄 없음`
    3. 소스 부활 → `소스에 원 줄 잔존`
    4. relocate 행 삭제 → `FAIL [R17]` (1이 GREEN이라 의미가 있다)
    5. 미선언 참조 수정 → 2 문구
    6. corpus 함수 import → `ui/src/components/run/CLAUDE.md` 포함 단언
    7. 연속 줄 불릿 relocate → `연속 줄 가진 불릿`
    8. 치환 컬럼 홀수 → `컬럼 6개(relocate:`
    9. base에 없는 old → `치환 old 0회`
    10. 섹션 통째 relocate → `[R17]` 없음
    11. refix 정상·원 줄 잔존
    12. 3번째 인자 manifest
    13. D3 미귀속·중복 귀속·한 줄 치환 행 2개
    14. D4 위반
    15. D7 ①의 범위 추출 규칙 그대로: 약어 `§폼 UX` → 해석 실패, `§"폼·입력 UX"` → 일치(b), `§다단계 ramp UI의` → 일치(a), `` `x.md` §헤딩 `` → 그 파일 대조. ② 미판정 1건 포함
  - Run: `python3 scripts/test_doc_gates.py; echo "exit=$?"` → exit 1, RED 13~14/15. 케이스 4는 기존 R17로 이미 FAIL이 나오고, 케이스 8의 옛 문구 `(5여야 함)`은 새 형식 단언에서 RED다. 출력에서 각 케이스 판정을 기록한다.
- [ ] **Step 2: `check-doc-coverage.py` 확장** — spec §4.1.
  - corpus에 `glob("ui/src/**/CLAUDE.md", recursive=True)`를 더한다.
  - 컬럼 검증을 kind별로 나눈다.
  - relocate ①–④, refix를 구현한다. `relocated_floor[base 섹션]`을 두고 R17 바닥 = b − merged − relocated, 바닥 0 섹션은 실종 면제다.
  - 3번째 인자를 받는다. 기존 move·merge·토큰·R18은 불변이다.
- [ ] **Step 3: `check-bullet-conservation.py`**(D3+D4) — 위 Interfaces.
- [ ] **Step 4: `check-doc-refs.py`**(D7) — 위 Interfaces ①②.
- [ ] **Step 5: 자체 테스트 GREEN** — `python3 scripts/test_doc_gates.py; echo "exit=$?"` → `OK: 케이스 15/15`, `exit=0`
- [ ] **Step 6: D7 base 실측** — `python3 scripts/check-doc-refs.py 57830b90 docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-d7-adjudication.tsv; echo "exit=$?"` → `FAIL [D7] § 해석 실패`가 정확히 1건(`ui/CLAUDE.md:131 폼 UX`), 미판정 0(manifest 대상 없음 — adjudication 12행 전부 미사용), `exit=1`
- [ ] **Step 7: manifest 이력화 + Justfile** — `git mv scripts/doc-move-manifest.tsv scripts/doc-move-manifest-claude-md-optimize.tsv`. 이후 Task 4 전까지 `just doc-coverage`는 `FAIL [manifest] 활성 manifest 0행`이 정상이다. Justfile 레시피 변경 + 주석을 현행화한다.
- [ ] **Step 8: 커밋** — `git add scripts/check-doc-coverage.py scripts/check-bullet-conservation.py scripts/check-doc-refs.py scripts/test_doc_gates.py Justfile && git diff --cached --name-only` → 6줄(rename은 `git mv`가 이미 stage — 새 이름 1줄) → `git commit -m "chore(scripts): doc-coverage relocate·refix·보조 manifest + D3/D7 검사 + 자체 테스트"`

### Task 4: Part B — 확정 분류대로 원문 이동 + 하위 문서 2개 신설

**Files:**
- Create: `ui/src/components/run/CLAUDE.md`, `ui/src/scenario/CLAUDE.md`, `scripts/doc-move-manifest.tsv`, `scripts/doc-move-manifest.compare.tsv`
- Modify: `ui/CLAUDE.md`, `ui/src/compare/CLAUDE.md`, `ui/src/components/scenario/CLAUDE.md`, `ui/src/components/report/CLAUDE.md`, `ui/src/components/ui/CLAUDE.md`

**Interfaces:**
- Consumes: final TSV·refix.tsv·adjudication.tsv, Task 3 스크립트, Task 2의 `ui/src/components/run/`.

**이동 목록(final TSV `# (d)` — 바꾸면 STOP).** 줄번호는 base 기준이고, 실행 시 anchor로 찾는다.
- run/ ← ui 76·79·85·87·88·91·92·96·105·107·111·112·113·127·129·132 + compare 16·17
- scenario/ ← ui 17·41·44·46·47·49·84·118·119·120·121·123·128·179
- components/scenario ← ui 72·73·74
- report ← ui 110
- components/ui ← ui 194
- ui/CLAUDE.md `## API client / React Query / fetch` 섹션 끝 ← compare 15

- [ ] **Step 1: 사실 재확인(두 상태 중 첫째)**
  - final TSV(`split('\t')`)의 이동 38행 anchor가 base 5개 문서 전체에서 각 1줄만 매치한다 → `unique 38/38`.
  - `python3 scripts/check-bullet-conservation.py 57830b90 --map docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-bullet-map-final.tsv; echo "exit=$?"` → manifest 0행이라 전 줄 항등 귀속 `OK: base 불릿 270 · 귀속 270`, D4 위반 0, `exit=0`.
- [ ] **Step 2: 새 하위 문서 머리말**(정확히 이 문면)

  `ui/src/components/run/CLAUDE.md`:

  ```markdown
  # Run 설정·스케줄 폼 (`ui/src/components/run/`) 함정

  이 파일은 `ui/src/components/run/` 파일을 **Read 도구로 열 때** 자동 로드되는 2단계 중첩 CLAUDE.md다(Bash grep/cat로는 로드되지 않는다). 전역 규칙은 루트 `CLAUDE.md`, UI 공통은 `ui/CLAUDE.md` 참고.

  > RunDialog·LoadModelFields·DataBindingPanel·EnvironmentPicker·Criteria·sizing helper·ScheduleForm·TriggerBuilder·RunVuCell·RunListControls를 다룬다. `api/schemas.ts`·`pages/`·`runPrefill`에도 실수 지점이 걸친 run 함정은 `ui/CLAUDE.md`에 남아 있다(실수 지점 기준 — 2026-11 재분배, `docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-design.md` §3.2).
  ```

  `ui/src/scenario/CLAUDE.md`:

  ```markdown
  # 시나리오 모델 계층 (`ui/src/scenario/`) 함정

  이 파일은 `ui/src/scenario/` 파일을 **Read 도구로 열 때** 자동 로드되는 2단계 중첩 CLAUDE.md다(Bash grep/cat로는 로드되지 않는다). 전역 규칙은 루트 `CLAUDE.md`, UI 공통은 `ui/CLAUDE.md`, 에디터 컴포넌트 함정은 `ui/src/components/scenario/CLAUDE.md` 참고.

  > Zod 모델(`model.ts`)·캐스트(`cast.ts`)·변수 스캔(`scanVars.ts`)·YAML 문서(`yamlDoc.ts`)·store·검증 배너 매핑(`problems.ts`)을 다룬다. 실수 지점이 컴포넌트·pages에도 걸친 함정은 `ui/CLAUDE.md` 또는 `components/scenario/CLAUDE.md`에 남아 있다.
  ```

- [ ] **Step 3: manifest 2개 생성**(scratchpad 일회성 python, `split('\t')`)
  - final TSV 이동 행 → `relocate` 행. 소스 `ui/CLAUDE.md` 35행은 활성 manifest로, compare 3행은 `.compare`로 간다.
  - `substitutions`(` ;; ` 구분, `old⟶new`) → TAB 쌍. 실제는 ui 84 한 행뿐이다.
  - 활성 manifest 끝에 `docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-refix.tsv`의 데이터 2행을 **그대로** 붙인다.
  - 헤더 `#` 2줄: 슬라이스·base `57830b90`·검사 명령.
  - 결과: 활성 37행, compare 3행.
- [ ] **Step 4: 줄 이동 실행**(scratchpad python, `assert count==1`). **배치 규칙(지키지 않으면 adjudication의 `true` 판정이 거짓이 된다):**
  - run/: 받은 줄을 원 섹션 헤딩 문자열 그대로의 `##` 섹션 3개(`## 폼·입력 UX / 진단 표시 (RunDialog, RunDetail)`·`## 다단계 ramp UI (RunDialog stages 편집·미리보기, S-D)`·`## 데이터 바인딩 패널 (8c, \`DataBindingPanel\`)` — base ui/CLAUDE.md의 헤딩 줄을 그대로 복사)로 묶고, **base 순서**로 둔다(129가 132보다 위). compare 16·17은 그 뒤 `## 풀 용량 409 clamp (LAN L4·L5)`에 둔다. 섹션 사이 빈 줄 1개.
  - scenario/: 원 섹션 헤딩 그대로 묶고 base 순서로 둔다.
  - components/scenario: 72–74를 **문서 끝 새 섹션** `## 폼·입력 UX 이관분 (ui/CLAUDE.md에서, 2026-11)`에 둔다(중간 삽입 금지).
  - components/ui: 194를 마지막 섹션 끝에 둔다.
  - report: 110을 마지막 섹션 끝에 둔다.
  - compare 15: ui/CLAUDE.md API client 섹션의 마지막 불릿 다음에 둔다.
  - 194 삭제로 빈 줄 2개가 인접하면 하나를 지운다.
- [ ] **Step 5: refix 적용** — refix.tsv 2행을 같은 방식으로 적용한다(치환 순서대로, 각 old `count==1`).
- [ ] **Step 6: 게이트(두 상태 중 둘째)**
  - `just doc-coverage; echo "exit=$?"` → `OK: manifest 37행`, `exit=0`
  - `python3 scripts/check-doc-coverage.py 57830b90 ui/src/compare/CLAUDE.md scripts/doc-move-manifest.compare.tsv; echo "exit=$?"` → `OK: manifest 3행`, `exit=0`
  - `python3 scripts/check-bullet-conservation.py 57830b90 --map docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-bullet-map-final.tsv; echo "exit=$?"` → `OK: base 불릿 270 · 귀속 270`, `exit=0`
  - `python3 scripts/check-doc-refs.py 57830b90 docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-d7-adjudication.tsv; echo "exit=$?"` → `OK: § 해석 N · 판정 12`, `exit=0`(`§폼` 해소)
  - `wc -c ui/CLAUDE.md` → 88,469(= 113,306 − 26,360 + 1,417 + 106; 빈 줄 정리로 −1 가능)
- [ ] **Step 7: 실데이터 이빨** — run/CLAUDE.md의 옮긴 줄 하나에서 1 B를 바꿔 `just doc-coverage` → `FAIL [relocate] 목적지에 치환 적용 줄 없음`. 원복 후 OK.
- [ ] **Step 8: 커밋** — `git add ui/CLAUDE.md ui/src/compare/CLAUDE.md ui/src/components/scenario/CLAUDE.md ui/src/components/report/CLAUDE.md ui/src/components/ui/CLAUDE.md ui/src/components/run/CLAUDE.md ui/src/scenario/CLAUDE.md scripts/doc-move-manifest.tsv scripts/doc-move-manifest.compare.tsv && git diff --cached --name-only` → 9개 → `git commit -m "docs(ui): 실수 지점 기준으로 불릿 38개를 하위 문서에 원문 이동 (run/·scenario/ 신설)"`
- **리뷰 brief 추가(D6):** 리뷰어는 이동 행 무작위 5개·잔류 행 무작위 5개의 실수 지점을 코드에서 재판정한다(spec §5.2 D6).

### Task 5: 배선 + 예산 기준값 + 절차 문서 + roadmap

**Files:**
- Modify: `ui/CLAUDE.md`(머리 하위 문서 목록 문단·유지 규칙 문단), `ui/src/components/scenario/CLAUDE.md`(머리말), `CLAUDE.md`, `scripts/check-doc-budget.py`, `docs/dev/root-doc-maintenance.md`, `docs/roadmap.md`, `docs/roadmap-status.md`

- [ ] **Step 1: ui/CLAUDE.md 머리 하위 문서 목록 문단**(`> **하위 도메인 문서**`로 시작하는 줄)을 6개로 다시 쓴다.
  - 기존 4개 + `ui/src/components/run/CLAUDE.md`(키워드: RunDialog·LoadModelFields·DataBindingPanel·sizing helper·ScheduleForm·TriggerBuilder·409 clamp·StageCurvePreview·RunVuCell) + `ui/src/scenario/CLAUDE.md`(키워드: Zod 모델·cast·scanVars·yamlDoc·store·검증 배너 매핑).
  - "RunDialog/DataBindingPanel/sizing helper 등은 … 선행돼야 함." 문장은 삭제한다.
  - 끝에 "하위 문서는 그 디렉토리 파일을 Read 도구로 열 때 로드된다(Bash grep으론 안 됨)."를 넣는다.
- [ ] **Step 2: components/scenario 머리말** — final TSV `# (b)`의 `components/scenario/CLAUDE.md:5` 치환문 그대로(old `순수 모델-only 편집 시엔 이 파일을 수동 참고할 것`, `count==1`).
- [ ] **Step 3: 예산 기준값**(Step 1·2 뒤)
  - 1차 실측 `python3 -c "import os,math;s=os.path.getsize('ui/CLAUDE.md');print(s, math.ceil((s+8192)/1024)*1024)"`
  - ui/CLAUDE.md 유지 규칙 문단의 `~120KB` → `~<ABS_WARN/1024>KB`.
  - **재실측**(이 편집이 크기를 바꾼다) — 이 값이 최종이다. 산출값이 달라지면 숫자를 다시 쓰고 재실측해 수렴시킨다.
  - `check-doc-budget.py`
    - `BASELINES["ui/CLAUDE.md"]` = 최종 실측
    - 하위 문서 6개를 각 `os.path.getsize`로 추가: `ui/src/components/run/CLAUDE.md`·`ui/src/scenario/CLAUDE.md`·`ui/src/components/scenario/CLAUDE.md`·`ui/src/components/report/CLAUDE.md`·`ui/src/components/ui/CLAUDE.md`·`ui/src/compare/CLAUDE.md`
    - `BASELINES_MIN = 12`
    - `ABS_WARN["ui/CLAUDE.md"]` = 산출값
    - 절대-임계값 주석의 `ui/CLAUDE.md:9` → `ui/CLAUDE.md 유지 규칙 문단`
- [ ] **Step 4: root CLAUDE.md** 도메인 함정 인덱스 `ui/CLAUDE.md` 행 끝 설명에 `; 하위 6개 문서 목록은 ui/CLAUDE.md 머리`를 덧붙인다.
- [ ] **Step 5: `docs/dev/root-doc-maintenance.md`** 현행화(spec §4.4)
  - kind 4종 형식, 보조 manifest·이름 규약(점 접미=활성 보조, 대시 slug=이력)
  - 래칫 대상 12·`BASELINES_MIN(12)`, `ABS_WARN` ui 새 값
  - 하위 문서 Read-로드, `just doc-gates-selftest`
  - sweep: `grep -n 'BASELINES_MIN\|(6)\|2종\|6개 도메인' docs/dev/root-doc-maintenance.md` 결과의 낡은 서술을 0으로 만든다.
- [ ] **Step 6: roadmap**
  - `docs/roadmap.md` §B17 헤딩 다음 줄에 `- ✅ 해소(2026-11, ui-claude-md-redistribute) — \`components/run/\` 이동 + \`run/CLAUDE.md\` 신설.`(본문 재작성 금지)
  - 새 `### B44. ui/CLAUDE.md 재분배 2차 — 잔류 불릿 서사 압축 (2026-11-07) 연기 항목`(`grep -n '^### B' docs/roadmap.md` 마지막 = B43 확인). 항목마다 cost-if-wrong + 해소 경로:
    - 잔류 압축(≤ 60 KiB)
    - 경계 5행(86·94·177·178·188 — 1차는 사용자 결정으로 잔류)
    - 병합 2건(205→24·162↔useThinkTimePair)
    - 코드 주석 포인터(`grep -rn 'ui/CLAUDE.md' ui/src`, 예 `PercentileCurveChart.tsx:42`)
    - compare 11·13·14·18 오배치
    - **2차 안전 방침 정본 포인터**: `docs/superpowers/specs/2026-11-07-ui-claude-md-phase2-policy.md`(2a 서사 이관 / 2b 추상화 승격 분리, 승격 조건 ≥3 사례 + 사용자 승인, S1–S6 안전장치). §B44 본문에 이 경로를 그대로 적는다.
  - `docs/roadmap-status.md` 문서·기록 시스템 행: `**[대기 중] ui/CLAUDE.md 래칫 WARN**`부터 `manifest 절차 슬라이스로.`까지(양끝 포함, 한 줄 안 연속 구간)를 `**ui/CLAUDE.md 재분배 1차 완료**(ui-claude-md-redistribute — §B17 \`components/run/\` 이동·불릿 38 원문 이동·relocate/refix 게이트) · 다음 = **2차 압축**(roadmap §B44, 목표 ≤ 60 KiB).`로 교체한다(python 스플라이스: 시작·끝 마커 각 `count==1`, 시작 < 끝).
- [ ] **Step 7: 게이트**
  - `just doc-budget; echo "exit=$?"` → `FAIL 0 / WARN 0`, ui/CLAUDE.md ≤ 92,160
  - `just doc-coverage; echo "exit=$?"` → OK. 머리 문단 편집으로 토큰 FAIL이 나면 해당 토큰이 다른 문서에 실재하는지 확인하고 보고한다(allowlist 추가는 orchestrator 승인 필요).
  - `python3 scripts/check-bullet-conservation.py 57830b90 --map docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-bullet-map-final.tsv` → OK
  - `python3 scripts/check-doc-refs.py 57830b90 docs/superpowers/specs/2026-11-06-ui-claude-md-redistribute-d7-adjudication.tsv` → OK
  - `just doc-gates-selftest` → OK
- [ ] **Step 8: 커밋** — `git add ui/CLAUDE.md ui/src/components/scenario/CLAUDE.md CLAUDE.md scripts/check-doc-budget.py docs/dev/root-doc-maintenance.md docs/roadmap.md docs/roadmap-status.md && git diff --cached --name-only` → 7개 → `git commit -m "docs: ui 하위 문서 배선 + 예산 기준값(BASELINES 12) + 절차 문서 + roadmap §B17 해소·§B44 2차 등록"`

### Task 6: 라이브 검증 (orchestrator, `/live-verify` — 커밋 없음)

- [ ] **Step 1:** `/live-verify` 스택을 기동한다. 워크트리 자체 바이너리(`cargo build -p handicap-worker` + controller)와 `ui/dist`를 쓴다.
- [ ] **Step 2:** spec §5.3 7개 화면을 확인한다. 각 화면 콘솔 에러 0, 요소 실측(rect·텍스트)으로 판정한다.
  - RunDialog: 간단/상세, closed 고정·open·곡선 미리보기, run 완료→리포트
  - run 목록 정렬·필터·VU 칸
  - run 상세
  - 시나리오 비교
  - 스케줄 생성: 부하 입력·트리거·cron 미리보기·타임라인
  - 에디터 시험 실행: 편집·새 시나리오 페이지
  - `/runs/:id/print`
- [ ] **Step 3:** US4 PROVEN/FAIL을 build-log 초안에 기록한다(`/finish-slice`가 사용).

REVIEW-GATE: APPROVED
