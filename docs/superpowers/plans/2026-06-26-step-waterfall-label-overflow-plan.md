# 스텝 막대(waterfall) 라벨 overflow 수정 (구현 플랜)

- 설계: `docs/superpowers/specs/2026-06-26-step-waterfall-label-overflow-design.md`
- 브랜치: `worktree-step-waterfall-overflow` (base = master `46c2a13`)
- 범위: `ui/src/components/report/StepPhaseBreakdown.tsx` 막대 뷰 라벨 div 한 곳. **UI-only**, 단일 TDD task·단일 green 커밋. proto/migration/엔진/컨트롤러/`schemas.ts`/`ko.ts` 0-diff.

## 사전 준비 (구현 세션 시작 시)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/step-waterfall-overflow/ui
pnpm install   # 이미 완료돼 있으면 즉시 통과
```

## Task 1 — 막대 뷰 라벨 truncate + title (단일 green 커밋)

### 순서 (tdd-guard: ui-only는 test 편집을 src보다 *먼저* — ui/CLAUDE.md)

**Step 1 (테스트 먼저, RED)** — `ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`:
- 막대 뷰(기본 `view==="waterfall"`)로 렌더하되 **긴 라벨**을 가진 step meta를 준다(예: meta `name: "POST /kramycard/cache/ajax/setupList.json"`, `wait`/`download` p50 채워 `anyPhase` 참 → 표 fallback 회피).
- 단언: 그 라벨을 렌더하는 요소가 ① `truncate` 클래스를 가짐(`expect(labelEl).toHaveClass("truncate")`) ② `title` 속성이 전체 라벨과 동일(`expect(labelEl).toHaveAttribute("title", "POST /kramycard/cache/ajax/setupList.json")`). 라벨 요소는 텍스트로 찾고(`getByText(longName)`) 그 요소(또는 `.closest`로 라벨 div)를 검사 — 막대 div(`role="img"`)·ms div와 구분.
- 짧은 라벨 케이스도 `title`이 동일하게 붙는지(무해·일관) 1줄 단언 가능(옵션).
- **teeth-check**: src 수정 전 이 테스트가 RED(현재 `truncate`·`title` 없음)인지 로컬 확인 후 GREEN으로.
- 기존 막대/ms/토글/aria-label 단언은 그대로 통과(회귀 0) — 라벨 div className/title만 바뀌므로.

**Step 2 (src 수정, GREEN)** — `ui/src/components/report/StepPhaseBreakdown.tsx:66`:
- 라벨 div를
  ```jsx
  <div className="w-40 text-sm font-medium">{m?.name ?? s.step_id}</div>
  ```
  →
  ```jsx
  <div
    className="w-40 shrink-0 truncate text-sm font-medium"
    title={m?.name ?? s.step_id}
  >
    {m?.name ?? s.step_id}
  </div>
  ```
- `truncate`(ellipsis·nowrap·overflow-hidden) + `shrink-0`(flex 축소 방지) + `title`(호버 전체 텍스트). **그 외 라인 무변경**(막대·ms·토글·범례·`role="img"` aria-label·`anyPhase` fallback 전부 그대로).

**Step 3 (게이트)**:
- `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green(인자 없는 전체 test 1회 — ui/CLAUDE.md "targeted ≠ full").
- `git diff --stat`로 변경이 `StepPhaseBreakdown.tsx` + 그 테스트 파일 **두 개뿐**임을 확인(`schemas.ts`/`ko.ts`/엔진/proto 0-diff).

**Step 4 (단일 green 커밋)**: `fix(ui): 스텝 막대 뷰 라벨 truncate+title로 긴 URL 막대 겹침 해소`.
- 명시 경로로만 stage(`git add ui/src/components/report/StepPhaseBreakdown.tsx ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`·`-A` 금지 — `.superpowers/sdd/` 등 미커밋).
- `git commit` 단일 foreground blocking 호출(폴링·파이프 금지 — 루트 CLAUDE.md). ui-only라 pre-commit이 UI 게이트(`pnpm lint && test && build`) 실행(cargo skip). 직후 `git log -1 --stat`로 두 파일만 landed 확인.

### Acceptance

- [ ] 막대 뷰 라벨 div가 `truncate`(+`shrink-0`) 클래스 + `title`(전체 라벨) 보유 — RTL 단언 green.
- [ ] 긴 라벨이 막대와 겹치지 않음(말줄임·한 줄), 호버 시 전체 URL `title`. 짧은 라벨 시각 동일.
- [ ] "칩"(표) 뷰·막대 비율·ms·토글·aria-label·범례 무변경(기존 테스트 회귀 0).
- [ ] `pnpm lint/test/build` green. `StepPhaseBreakdown.tsx`+테스트 외 0-diff(엔진/proto/migration/`schemas.ts`/`ko.ts`).

## 최종 리뷰 (구현 세션, Task 후)

- 단일-task·UI-only·presentational 변경이라 **per-task = whole-branch 동일 diff → `handicap-reviewer` 1회**(클래스 정확성·기존 단언 회귀 0·0-diff 불변식·ui/CLAUDE.md truncate/flex 트랩 확인). 모델: diff가 작고 로직/와이어/동시성 무관이라 일반 task-reviewer 수준이나, 단일-task 머지라 `handicap-reviewer`로 통합(model: 1M 세션이면 명시 — 단 이 구현은 fresh 세션이라 상속 OK).
- **security-reviewer**: N/A — diff가 요청실행/템플릿/캐스트/env·dataset 바인딩/업로드/trace·body 뷰어 무관(리포트 라벨 CSS). finish-slice §0 grep 무매치 → build-log에 N/A 명시.
- **라이브 검증**: 자동 회귀 측면 WAIVED(리포트 표시-only·run-생성/report-파싱/Zod 무관·`schemas.ts` 0-diff=S-D 갭 부재) — **단 시각 수정은 Playwright 헤드리스 스크린샷 1장으로 확인 권장**(원 버그=시각 픽셀 겹침·contract 테스트는 픽셀 미관측): 긴 URL 시나리오로 run 1개 → 리포트 막대 뷰 스크린샷에서 라벨이 막대와 안 겹침 확인. 근거 build-log.

## 머지 후 (finish-slice)

1. ff-merge → master (+ origin 푸시는 사용자 확인 — 직전 windows 슬라이스처럼 outward-facing).
2. build-log 한 단락·roadmap(해당 후보가 있으면 제거)·CLAUDE 상태줄·메모리.
3. 함정: ui/CLAUDE.md에 "막대 뷰 고정폭 라벨은 truncate+title(긴 URL 겹침)·칩 표는 break-all" 한 줄.

## 리뷰 이력

- spec+plan: spec-plan-reviewer **APPROVE**(clean) — 모든 코드 클레임 검증(라벨 div `:66` 무overflow·flex row·3칼럼·anyPhase fallback·chips `break-all` `:93`·base `46c2a13`)·root-cause/fix 기계적 정확(고정폭+truncate+shrink-0)·scope 막대뷰 유일 offender(worker/branch 표는 table 셀이라 무겹침=정당 제외)·test contract 실현가능(getByText 충돌 없음·jsdom 픽셀 한계 인정)·`title` ko.ts 면제 in-repo 선례(WorkerBreakdownTable:36 `title={w.worker_id}`). non-blocking nit 3: ① spec 대조-citation 정밀화(chips 무겹침 진짜 이유=table 셀 자동폭, break-all은 URL칸 부가) → **반영** ② always-on title 무해(conditional=과설계) → 수용 ③ Playwright 시각 스크린샷 권장(원 버그=픽셀 겹침) → **반영**(라이브 검증 권장으로 격상).

REVIEW-GATE: APPROVED
