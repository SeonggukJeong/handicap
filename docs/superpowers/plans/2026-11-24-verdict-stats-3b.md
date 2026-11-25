# verdict-stats ③b — 새 판정 항목 입력·인쇄·비교 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ③a가 서버·와이어·판정 표에 넣은 새 판정 항목(평균·최대·임의 백분위)을 실행 창·스케줄 폼에서 입력·검사·다시 열기 할 수 있게 하고, 인쇄 판정 행과 비교 화면·인쇄 비교가 새 항목과 응답 시간 판정 규칙(`latency_rule`) 차이를 알게 한다.

**Architecture:** UI만 바꾼다(서버 코드 0 — `percentile_name.rs`의 테스트 한 줄만). 입력은 `profileForm.ts`의 순수 함수(`criteriaStateFrom`·`buildCriteria`·새 `criteriaErrors`)가 단일 소스이고, 실행 창·스케줄 폼은 기준 칸을 칸마다 `useState`로 들고 있던 것을 `CriteriaState` 객체 하나로 바꿔 「새 칸을 한 곳에서 빠뜨려 프리셋 불러오기가 조용히 버리는」 종류(§B95 (1)①)를 없앤다. 인쇄 거울(`print/verdict.ts`)은 서버 `evaluate_criteria`의 행 순서를 따라 하고, 비교 안내는 두 규칙(상태 코드·응답 시간)을 한 함수가 한 문장으로 낸다.

**Tech Stack:** TypeScript(React·Zod·vitest·RTL), Rust 테스트 한 줄.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-23-verdict-stats-a-design.md` — 이 plan은 ③b(R17·R18·R20·R21)와 ③a가 넘긴 §B95 (1) ①–④다. 요구 ID(R*)는 spec 것. 시각 기준 = 목업 `docs/superpowers/specs/2026-11-23-verdict-stats-a-mockups/a-screens.html` **1번**(판정 기준 입력, Task 2).

US(spec 「사용자 스토리 (US)」에서 ③b가 끝까지 닿게 하는 것): **US1**(평균 기준 입력 → 판정 표·인쇄 KPI 「평균」 카드의 목표 — 화면 요약의 「평균」 카드는 ③c R22), **US2**(p90·최대 기준 입력 → 판정 표·배지), **US3**(스텝 평균·최대·백분위 기준), **US6 뒷부분**(변경 전 프리셋·스케줄이 같은 칸이 채워진 채 열림). US4·US5·US10·US11은 ③a·③c 몫.

## Global Constraints

- 서버 검증(`crates/controller/src/api/runs.rs` `validate_criteria`)과 같은 규칙을 UI가 먼저 건다 — UI가 서버보다 엄하면 안 된다(R5·R18):
  - 새 시간 값(run 「평균」·「최대」·백분위 행의 ms·스텝 `mean_ms`/`max_ms`/`p<N>_ms`의 기준): 유한·0 이상·60,000 이하·소수 3자리까지. 「소수 3자리까지」 = `Math.abs(x * 1000 - Math.round(x * 1000)) < 1e-6`.
  - 백분위 N: `percentileMetricName(text) !== null`(0 < N < 100·소수 3자리까지·정본 문법, `ui/src/api/percentileName.ts`).
  - run 백분위 행(ms 찬 행만 — 아래 줄): N이 50·95·99면 거절(먼저), 같은 N 두 번 거절(다음 — ms 찬 행끼리만 비교), 보내는 행 10개 초과 거절.
  - 스텝 「백분위」 N의 정본 이름이 `p50_ms`·`p95_ms`·`p99_ms`면(`"95.0"` 입력 포함) 그 이름으로 보내고 기준 값에 새 검사를 걸지 않는다(기존 항목과 같은 대우).
  - 기존 칸(`max_p50_ms` 등·기존 스텝 8항목)의 검사는 바꾸지 않는다 — 지금 UI는 이 칸들에 HTML `min`·`max` 말고 검사가 없고, 그대로 둔다.
  - 받아들인 차이(검토 지적 8 — **보류, 사용자 「애매하긴 하네」**): 숫자 칸에 `"090"`·`"1e1"`처럼 쓰면 UI 문법(`percentileName.ts` `NUMBER_RE`)이 범위 오류를 낸다 — 서버는 숫자만 받으므로 UI가 이 글자에서만 더 엄하다. 이번엔 문법을 둘로 나누지 않는다. 상세·푸는 길은 맨 아래 「§B에 옮길 판단」 (1).
- 백분위 행: **기준 ms 칸이 빈 행은 보내지 않고 검사도 하지 않는다**(새 행 N 기본 `"90"`만 채워진 행이 실행을 막지 않게). ms 칸이 찬 행은 N이 비면 오류.
- 서버 결과 행 순서(인쇄 거울이 따라 할 것, `crates/controller/src/report.rs` `time_rows` 정렬): 평균(키 0) → 백분위(고정 p50·p95·p99 + 목록, N×1000 오름차순, 같은 키면 고정 먼저) → 최대(키 `u32::MAX`) → `error_rate` → `4xx_rate` → `5xx_rate` → `4xx_count` → `5xx_count` → `rps` → `min_window_rps` → 스텝 기준(입력 순).
- 새 화면 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035). 화면 낱말 「응답 시간」(띄어 씀). 인쇄(`ko.print.*`)는 지금 낱말 「응답시간」을 따른다(띄어쓰기 통일은 ④ — spec §6.7).
- 인쇄 본문 숫자(KPI 카드 값 `summary.mean_ms` 등)는 정수 그대로(US11). 판정 행 실측만 서버 `actual`을 `fmtMsExact`로.
- 와이어·서버 동작 0-diff: `crates/` 변경은 `percentile_name.rs` 테스트 모듈 한 곳뿐.
- UI 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`. `crates/`를 건드린 커밋(Task 1)은 cargo 게이트가 돌아 수 분 — `git commit`은 `run_in_background`, `| tail` 금지, `--no-verify` 금지, 커밋 전 `git diff --cached --name-only`, 메시지는 `-F <파일>`.
- `ui/src/`를 건드리는 task는 `tdd-guard`가 UI 쪽 pending test를 요구한다 — 각 task의 첫 스텝이 테스트다.

## Review Focus

1. **불러오기 경로가 새 칸을 조용히 버리는 것** — 실행 창의 「다시 실행」 프리필·프리셋 불러오기, 스케줄 폼의 수정 열기 셋 다에서 `max_mean_ms`·`max_max_ms`·`max_percentiles_ms`·스텝 `mean_ms`/`p90_ms`가 칸에 채워지고, 아무것도 안 바꾸고 다시 보내면 같은 와이어가 나가야 한다. Task 1(세 경로 와이어 왕복 RTL) + Task 2(칸 값 단언).
2. **보이지 않는 칸의 잘못된 값이 이유 없이 실행을 막는 것** — 간단 모드·「판정·고급」 접힘(실행 창), 「SLO 기준」 접힘(스케줄 폼)에서 기준 오류가 있으면 버튼이 막히고 이유 상자에 한 줄이 떠야 한다. Task 3 RTL.
3. **새 백분위 행(N=90, ms 빈칸)이 실행을 막는 것** — 「+ 백분위 기준 추가」만 누르고 둔 행은 보내지도 막지도 않는다. Task 1 단위 + Task 2 RTL(추가만 하고 실행 → 와이어에 기준 없음) + Task 3 RTL(실행 단추 활성).
4. **스텝 「백분위」 95의 왕복** — 「백분위」+95로 보내면 와이어는 `p95_ms`이고 다시 열면 「p95(ms)」로 보인다(R17). 「백분위」 99.9 → `p99.9_ms` → 「백분위」+99.9. Task 1 단위.
5. **인쇄 판정 행 순서가 서버와 어긋나는 것** — 목록 N이 고정 칸 사이에 끼는 경우(p90·p99.9 목록 + 고정 p95·p99 + 평균·최대)에서 `expandCriteria` 순서가 서버 순서와 같아야 한다. 서버 순서는 `report.rs` 테스트의 결과로 확인한 값을 Task 4 테스트에 박는다(아래 Task 4 Step 1).
6. **「+ 추가」 두 번 뒤 둘째 행만 채우면 같은 N으로 막히는 것** — 새 행은 늘 N 90으로 시작하므로, 보내지 않는 빈 행을 같은 N 비교에 넣으면 서버가 받을 값을 UI가 막는다. Task 1 단위(`[{p:"90",ms:""},{p:"90",ms:"5"}]` → 오류 없음).
7. **타입 변경이 화면을 깨뜨린 채 커밋되는 것** — `CriteriaState` 필수 칸 추가는 두 화면·두 컴포넌트·테스트 리터럴을 `tsc -b`에서 깨뜨린다. Task 1이 호출자까지 한 커밋(`pnpm build` 게이트).
8. **옛 run 라이브 대조를 이미 새 규칙인 바이너리로 하는 것** — 지금 master는 ②a·③a를 품어 run이 규칙 2로 만들어진다. 옛 run은 태그 `v0.16.0`(`e2c07745`) 바이너리로 만든다(Task 6 Step 4).

## 사실 확인 명령 (claims-ledger — 디스패치 전 orchestrator가 다시 돌린다)

```bash
grep -n "fn validate_criteria" -A 130 crates/controller/src/api/runs.rs        # UI 검사 규칙의 원본(R5)
grep -n "time_rows" crates/controller/src/report.rs                            # 행 순서 키 0 / milli / u32::MAX + 안정 정렬
grep -n "fn rule2_order" -A 40 crates/controller/src/report.rs                 # Task 4가 거울로 쓰는 서버 순서 단언
grep -n "noVerdictText" -A 8 ui/src/components/report/ReportHeadline.tsx        # criteriaHasAny 거짓 → sloHint
grep -n "fn numbers_table" -A 9 crates/controller/src/percentile_name.rs        # input.parse::<f64>().unwrap() — 공백 입력이면 panic
grep -n "trim" ui/src/api/percentileName.ts                                     # 지울 trim 한 곳
grep -n "useState(initCriteria\|setMaxP50\|criteriaSetters" ui/src/components/run/RunDialog.tsx ui/src/components/run/ScheduleForm.tsx
grep -n "const canSubmit\|blockedReasons\|onClick={savePreset}\|function renamePreset" ui/src/components/run/RunDialog.tsx
grep -n "const canSubmit\|blockedReasons\|setStepCriteria(\[\])" ui/src/components/run/ScheduleForm.tsx
grep -n "export function criteriaHasAny\|export function expandCriteria\|CARD_METRIC\|fmtCriterionPair(" ui/src/print/verdict.ts ui/src/print/sentences.ts
grep -rn "criteriaHasAny" ui/src --include='*.tsx' --include='*.ts' | grep -v __tests__   # verdict.ts 자신 + ReportHeadline.tsx
grep -rn "statusRuleNotice\|statusRuleLine" ui/src --include='*.ts' --include='*.tsx' | grep -v __tests__
grep -n "const same =" -A 2 ui/src/print/compare/speedCompare.ts                 # 규칙을 보지 않는 같은 경계 판정
grep -rln "criteria\|speed_bands" ui/src/compare ui/src/pages/ScenarioComparePage.tsx   # 비어 있음: 화면 비교는 기준을 읽지 않는다
git rev-parse --short 'v0.16.0^{commit}'                                        # e2c07745
git merge-base --is-ancestor 58ed2318 v0.16.0; echo $?                           # 1 = ②a가 v0.16.0에 없다
git merge-base --is-ancestor fa8abe79 v0.16.0; echo $?                           # 1 = ③a가 v0.16.0에 없다
grep -n "names.slice(0, 2)" ui/src/print/compare/headline.ts                     # 머리말은 차이 이름 앞 둘만
grep -n "canSubmit =" -A 4 ui/src/components/run/ScheduleForm.tsx                # 이름·시나리오·트리거가 먼저 필요
grep -n "statusRule: o.statusRule" ui/src/print/compare/__tests__/scene.ts       # latencyRule을 같은 모양으로
```

---

### Task 1: 입력 모델 + 두 화면의 기준 상태 하나 — 새 칸 왕복·검사 (R17·R18 모델, §B95 (1)①④)

**Files:**
- Modify: `ui/src/components/run/profileForm.ts`
- Modify: `ui/src/components/run/RunDialog.tsx`, `ui/src/components/run/ScheduleForm.tsx`(기준 상태를 객체 하나로 — 아래 Step 3)
- Modify: `ui/src/components/run/CriteriaFields.tsx`(키 타입만: `StringCriteriaKey`를 `profileForm`에서 가져온다 — `percentiles` 배열 칸이 문자열 입력으로 들어가지 않게), `ui/src/components/run/StepCriteriaFields.tsx`(`add()` 새 행에 `p: ""`만)
- Modify: `ui/src/api/percentileName.ts`(`percentileMetricName`의 `trim` 제거)
- Modify: `testdata/percentile_metric_cases.json`(`numbers`에 `{"input": " 90", "name": null}`)
- Modify: `crates/controller/src/percentile_name.rs`(테스트 `numbers_table`만: 숫자로 못 읽는 입력 = 거절)
- Modify: `ui/src/i18n/ko.ts`(새 `criteria` 묶음의 오류 문구)
- Test: `ui/src/components/run/__tests__/profileForm.test.ts`, `ui/src/api/__tests__/percentileName.test.ts`(표를 읽으므로 새 줄이 자동으로 들어간다), `ui/src/components/run/__tests__/StepCriteriaFields.test.tsx`(행 리터럴 세 곳에 `p: ""`), `ui/src/components/run/__tests__/RunDialog.test.tsx`, `ui/src/components/run/__tests__/ScheduleForm.test.tsx`

`CriteriaState`·`StepCriterionDraft`에 필수 칸을 더하는 순간 두 화면의 객체 리터럴·setter 표와 두 컴포넌트가 `tsc -b`에서 깨진다(`tsconfig`가 `src` 전체 — 테스트 파일 포함). 그래서 타입 변경과 그 호출자를 한 커밋에 둔다. 화면에 새 칸을 그리는 것은 Task 2.

**Interfaces:**
- Produces:
  - `type PercentileDraft = { p: string; ms: string }`
  - `StepCriterionDraft`에 `p: string` 추가(「백분위」 행의 N; 다른 항목이면 `""`). 「백분위」 행의 `metric`은 표지 `"percentile"`.
  - `CriteriaState`에 `maxMean: string; maxMax: string; percentiles: PercentileDraft[]`. `EMPTY_CRITERIA`도.
  - `export type StringCriteriaKey = Exclude<keyof CriteriaState, "stepCriteria" | "percentiles">`(`profileForm.ts` — `CriteriaFields`가 지금 자기 파일에 두는 같은 이름 타입을 이것으로 바꾼다).
  - `NEW_PERCENTILE_ROW: PercentileDraft = { p: "90", ms: "" }`, `MAX_PERCENTILE_ROWS = 10`.
  - `type CriteriaErrors = { maxMean?: string; maxMax?: string; percentiles: Array<{ p?: string; ms?: string }>; percentilesList?: string; steps: Array<{ p?: string; threshold?: string }> }` — 배열 길이는 각 입력 배열과 같다.
  - `criteriaErrors(s: CriteriaState): CriteriaErrors`, `hasCriteriaErrors(e: CriteriaErrors): boolean`.
  - `criteriaStateFrom`·`buildCriteria`·`criteriaHasValue`·`criteriaActiveCount`가 새 칸을 안다(시그니처 불변).
  - 두 화면: `const [criteria, setCriteriaState] = useState<CriteriaState>(…)` 하나(Task 2·3이 이 이름을 쓴다).

- [ ] **Step 1: 실패하는 테스트 쓰기** — `profileForm.test.ts`에 `describe("새 판정 항목")`:
  - `buildCriteria`: `maxMean "3000"`·`maxMax "10000.5"` → `max_mean_ms: 3000`·`max_max_ms: 10000.5`. 백분위 행 `[{p:"90",ms:"2500"},{p:"99.9",ms:"8000"},{p:"90",ms:""}]` → `max_percentiles_ms: [{percentile:90,max_ms:2500},{percentile:99.9,max_ms:8000}]`(ms 빈 행 빠짐). 행이 모두 ms 빈칸이면 키 없음(`"max_percentiles_ms" in c`가 거짓). 스텝 `{metric:"mean_ms",threshold:"500"}`·`{metric:"max_ms",…}` 그대로, `{metric:"percentile",p:"90",threshold:"1200"}` → `metric:"p90_ms"`, `{metric:"percentile",p:"95",…}` → `"p95_ms"`, `{metric:"percentile",p:"99.90",…}` → `"p99.9_ms"`.
  - `criteriaStateFrom`: 위 와이어 → 같은 칸(`maxMean "3000"`, 백분위 행 `{p:"90",ms:"2500"}`·`{p:"99.9",ms:"8000"}`), 스텝 `p90_ms` → `{metric:"percentile",p:"90"}`, `p99.9_ms` → `{metric:"percentile",p:"99.9"}`, `p95_ms` → `{metric:"p95_ms",p:""}`(기존 항목으로 열림), `mean_ms` → `{metric:"mean_ms",p:""}`. 기존 테스트의 스텝 행 기대값에 `p: ""`를 더한다.
  - 왕복: 새 칸을 모두 쓴 `Criteria` `c`에 대해 `buildCriteria(criteriaStateFrom(c))`가 `c`와 `toEqual`.
  - `criteriaHasValue`: `maxMean`만 → 참, 백분위 행 `{p:"90",ms:""}`만 → 거짓, `{p:"90",ms:"1"}` → 참. `criteriaActiveCount`: `maxMean`+`maxMax`+ms 찬 백분위 2행+빈 행 1 → 4.
  - `criteriaErrors`(문구는 `ko.criteria.*`로 비교):
    - `maxMean "60000.001"` → `maxMean === ko.criteria.errTime`; `"-1"`·`"1.0005"`·`"abc"`도 같은 오류; `""`·`"60000"`·`"1.005"` → 오류 없음.
    - 백분위 `{p:"50",ms:"1"}` → `percentiles[0].p === ko.criteria.errPercentileFixed("50")`(글자 「p50은 …」), `{p:"95",ms:"1"}` → 「p95는 …」(조사가 숫자를 따른다); `{p:"100",ms:"1"}`·`{p:"90.0001",ms:"1"}` → `errPercentileRange`; `{p:"",ms:"1"}` → `errPercentileMissing`; `[{p:"90",ms:"1"},{p:"90.0",ms:"2"}]` → `percentiles[1].p === errPercentileDuplicate("90")`(첫 행은 오류 없음); **`[{p:"90",ms:""},{p:"90",ms:"5"}]` → 오류 없음**(보내지 않는 첫 행은 같은 N 비교에 들지 않는다 — 「+ 추가」 두 번 뒤 둘째 행만 채운 경우); `{p:"90",ms:"70000"}` → `percentiles[0].ms === errTime`; `{p:"150",ms:""}` → 오류 없음(보내지 않는 행).
    - ms 찬 행 11개(N 1..11) → `percentilesList === ko.criteria.errPercentilesMax`(화면은 10행에서 추가 단추를 막으므로 이 경우는 단위 테스트로만 고정 — R18 「10개 초과」).
    - 스텝 `{metric:"percentile",p:"",threshold:"5"}` → `steps[0].p === errPercentileMissing`; `{metric:"percentile",p:"95",threshold:"70000"}`·`{metric:"percentile",p:"95.0",threshold:"70000"}` → 오류 없음(정본 이름이 기존 항목이면 새 검사 없음); `{metric:"percentile",p:"90",threshold:"70000"}` → `steps[0].threshold === errTime`; `{metric:"mean_ms",threshold:"0.0005"}` → `errTime`; `{metric:"p95_ms",threshold:"70000"}` → 오류 없음; threshold 빈 행 → 오류 없음.
    - `hasCriteriaErrors(criteriaErrors(EMPTY_CRITERIA)) === false`, 위 오류 하나라도 있으면 참.
  - `RunDialog.test.tsx` `describe("새 판정 항목 다시 열기")`(새 칸은 아직 화면에 안 그려도 상태에 남아 그대로 나가야 한다 — Review Focus 1):
    - 「다시 실행」 프리필(`initial.profile.criteria` = `max_mean_ms`·`max_max_ms`·`max_percentiles_ms` 2행·스텝 `mean_ms`·`p99.9_ms`·`p95_ms`): 그대로 실행하면 본문 `profile.criteria`가 프리필과 `toEqual`, 「판정·고급」이 펼쳐져 있다.
    - 프리셋 불러오기(같은 기준의 프리셋 목 응답) → 그대로 실행 → 같은 `criteria`.
    - `minWindowRps`를 채우면 closed-loop에서 `rpsWarmup`이 상승 시간으로 채워지는 기존 테스트가 그대로 통과(상태 리팩터 회귀).
  - `ScheduleForm.test.tsx`: 수정 열기(`init.criteria`에 새 칸 전부) → 그대로 저장하면 같은 `criteria`, 「SLO 기준」 섹션이 펼쳐져 있다. 시나리오를 바꾸면 `step_criteria`만 빠지고 `max_mean_ms`·`max_percentiles_ms`는 남는다.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/profileForm.test.ts src/components/run/__tests__/RunDialog.test.tsx src/components/run/__tests__/ScheduleForm.test.tsx` → 새 케이스 FAIL(컴파일 오류 포함).
- [ ] **Step 3: 구현 — 모델** — 위 Interfaces대로. 시간 값 검사 함수 하나(`timeValueError(text): string | undefined`)를 모든 새 시간 칸이 쓴다. 백분위 행 검사: **ms 칸이 빈 행은 건너뛴다(오류 없음·같은 N 비교에도 넣지 않음)**. ms 칸이 찬 행은 순서대로 N 빈칸 → 범위(`percentileMetricName === null`) → 50·95·99 → 같은 N(앞의 *ms 찬* 행들의 정본 이름 집합) → ms 시간 값. 스텝 「백분위」 행: N 빈칸·범위 오류는 같은 문구, 정본 이름이 `p50_ms`·`p95_ms`·`p99_ms`면 기준 값에 **새 검사를 걸지 않는다**(지금 UI는 기존 항목 기준을 검사하지 않는다 — 바꾸지 않음), 그 밖이면 `timeValueError`. `buildCriteria`는 `percentileMetricName`이 null인 행을 건너뛴다(검사가 막으므로 방어). 오류 문구 `ko.criteria`: `errTime: "0 이상 60,000 이하, 소수 셋째 자리까지 적어 주세요."`, `errPercentileRange: "백분위는 0보다 크고 100보다 작은 수(소수 셋째 자리까지)로 적어 주세요."`, `errPercentileMissing: "백분위를 적어 주세요."`, `errPercentileFixed: (n) => \`p${n}${josa(\`p${n}\`, "은/는")} 위의 「최대 p${n}(ms)」 칸을 쓰세요.\``(`ui/src/i18n/josa.ts` — 숫자 끝 받침을 안다), `errPercentileDuplicate: (n) => \`p${n} 기준이 이미 있습니다.\``, `errPercentilesMax: "백분위 기준은 10개까지입니다."`. `errPercentileFixed`·`errPercentileDuplicate`의 `n`은 정본 이름에서 뽑은 N 글자(`"90.0"` 입력이어도 `"90"`).
- [ ] **Step 3b: 구현 — 두 화면 상태** — 두 화면 모두 기준 칸 `useState` 12개(`maxP50` … `stepCriteria`)와 `criteriaSetters` 객체를 지우고 `const [criteria, setCriteriaState] = useState<CriteriaState>(initCriteria)` 하나로 — 칸이 늘 때마다 `useState`·`loadPreset`·조립·setter 네 곳을 맞춰야 하던 것(spec §6.1)이 한 곳이 된다. 문자열 칸 `setCriteria(key: StringCriteriaKey, val)`는 `setCriteriaState((c) => …)` 한 번 안에서 기존 교차 규칙(`minWindowRps`를 채우고 `rpsWarmup`이 비었고 closed-loop면 `rpsWarmup = String(rampUp)`)까지 처리. 스텝 `onChange`는 `stepCriteria`만 바꾼다. `RunDialog` `loadPreset`의 칸별 setter 12줄 → `setCriteriaState(pc)`. `ScheduleForm` 시나리오 변경의 `setStepCriteria([])` → `setCriteriaState((c) => ({ ...c, stepCriteria: [] }))`. 조립용 `criteriaState` 객체 리터럴은 지우고 `criteria`를 그대로 쓴다. `CriteriaFields`는 `StringCriteriaKey`를 `profileForm`에서 가져오고 `onChange`의 키 타입도 `(key: StringCriteriaKey, val: string) => void`로 좁힌다(지금 `keyof CriteriaState` — 좁은 화면 핸들러를 넓은 prop에 넘기면 strict에서 TS2322; 이것이 Task 2의 최종 시그니처와 같다. 렌더 불변), `StepCriteriaFields` `add()`는 `p: ""`를 더한다.
- [ ] **Step 4: §B95 (1)④ — 공백** — `percentileMetricName`에서 `.trim()`을 지운다. `testdata/percentile_metric_cases.json` `numbers`에 `{"input": " 90", "name": null}`. `percentile_name.rs` `numbers_table`의 `let n: f64 = input.parse().unwrap(); let got = to_milli(n).map(|_| percentile_metric_name(n));`를 `let got = input.parse::<f64>().ok().filter(|n| to_milli(*n).is_some()).map(percentile_metric_name);`로(숫자로 못 읽는 입력 = 거절, 표 뜻 그대로).
- [ ] **Step 5: 통과 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/profileForm.test.ts src/api/__tests__/percentileName.test.ts src/components/run/__tests__/RunDialog.test.tsx src/components/run/__tests__/RunDialog.steady.test.tsx src/components/run/__tests__/RunDialog.trust.test.tsx src/components/run/__tests__/ScheduleForm.test.tsx src/components/run/__tests__/StepCriteriaFields.test.tsx` PASS. `cargo nextest run -p handicap-controller percentile_name` PASS.
- [ ] **Step 6: 되돌려 확인** — ① `criteriaStateFrom`에서 `max_percentiles_ms` 읽기를 지우면 왕복 테스트 RED, 원복. ② `loadPreset`의 `setCriteriaState(pc)`를 지우면 프리셋 불러오기 테스트 RED, 원복. ③ 같은 N 비교에 ms 빈 행을 넣으면 `[{p:"90",ms:""},{p:"90",ms:"5"}]` 테스트 RED, 원복. ④ `trim`을 되살리면 `percentileName.test.ts`의 `" 90"` 줄 RED, 원복. ⑤ `numbers_table`을 옛 `unwrap()`으로 되돌리면 Rust 테스트가 panic, 원복.
- [ ] **Step 7: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋(cargo 게이트 — background): `feat(ui): 판정 기준 입력 모델에 평균·최대·백분위 + 검사, 기준 상태를 객체 하나로`.

### Task 2: 입력 칸 — 평균·최대·다른 백분위·스텝 새 항목 (R17 화면, 목업 1번)

**Files:**
- Modify: `ui/src/components/run/CriteriaFields.tsx`, `ui/src/components/run/StepCriteriaFields.tsx`, `ui/src/components/run/RunDialog.tsx`, `ui/src/components/run/ScheduleForm.tsx`(새 props 넘기기만), `ui/src/i18n/ko.ts`(`ko.criteria` 칸 글자)
- Test: `ui/src/components/run/__tests__/CriteriaFields.test.tsx`(새 파일), `ui/src/components/run/__tests__/StepCriteriaFields.test.tsx`, `ui/src/components/run/__tests__/RunDialog.test.tsx`, `ui/src/components/run/__tests__/ScheduleForm.test.tsx`

컴포넌트 props가 바뀌면 두 화면이 같은 커밋에서 따라와야 `tsc -b`가 green이라 화면의 props 넘기기도 이 task다. 막기·이유(R18 화면)는 Task 3.

**Interfaces:**
- Consumes: Task 1의 `CriteriaState`·`StringCriteriaKey`·`PercentileDraft`·`NEW_PERCENTILE_ROW`·`MAX_PERCENTILE_ROWS`·`CriteriaErrors`·`criteriaErrors`, 두 화면의 `criteria`·`setCriteriaState`.
- Produces:
  - `CriteriaFields` props: `{ value: CriteriaState; errors: CriteriaErrors; onChange: (key: StringCriteriaKey, val: string) => void; onPercentilesChange: (rows: PercentileDraft[]) => void }`.
  - `StepCriteriaFields` props에 `errors: CriteriaErrors["steps"]` 추가.
  - 두 화면: `const criteriaErrs = useMemo(() => criteriaErrors(criteria), [criteria])`(Task 3이 이 값으로 막는다).

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `CriteriaFields.test.tsx`: 칸 순서 — 레이블 「평균 응답 시간(ms)」·「최대 응답 시간(ms)」이 「최대 p50(ms)」보다 앞(DOM 순서), 그 뒤 도움말 `ko.criteria.meanHelp` 글자. 「+ 백분위 기준 추가」 → `onPercentilesChange([NEW_PERCENTILE_ROW])`. 행이 있으면 `aria-label` 「백분위 1」·「기준 1」 칸과 「백분위 기준 1 삭제」 단추; 삭제 → 그 행을 뺀 배열. 행이 10개면 추가 단추 `disabled` + `ko.criteria.maxRowsHint`. `errors.maxMean`이 있으면 그 글자가 보이고 칸이 `aria-invalid="true"`·`aria-describedby`가 그 글자 id. `errors.percentiles[0].p`·`.ms`·`percentilesList`도 각각 보인다.
  - `StepCriteriaFields.test.tsx`: 항목 선택 옵션 순서가 「평균(ms)」·「최대(ms)」·「백분위(ms)」·「p50(ms)」… . 「백분위(ms)」를 고르면 `onChange`가 받은 행이 `{metric:"percentile", p:"90"}`(p가 비어 있었으면 90으로 채움), 그 행이면 `aria-label` 「스텝 기준 1 백분위」 칸이 보이고 단위 글자 「ms」. 「평균(ms)」을 고른 행 → 단위 「ms」. `errors[0].p`·`errors[0].threshold` 글자가 그 행 아래에 보인다. 새 행 추가 기본값은 지금처럼 `p95_ms`(+`p: ""`).
  - `RunDialog.test.tsx` `describe("새 판정 항목 입력")`:
    - 새 run: 「판정·고급」을 펼쳐 평균 `3000`, 「+ 백분위 기준 추가」 뒤 기준 1에 `2500`, 스텝 기준 추가 → 「백분위(ms)」·임계값 `1200` → 실행 → `createRun` 본문 `profile.criteria`가 `{max_mean_ms:3000, max_percentiles_ms:[{percentile:90,max_ms:2500}], step_criteria:[{metric:"p90_ms",op:"max",threshold:1200,target:…}]}`와 `toEqual`.
    - 추가만 한 백분위 행(ms 빈칸) → 본문에 `criteria` 키 없음(다른 기준도 없을 때).
    - Task 1의 「다시 실행」 프리필 케이스에 칸 단언을 더한다: 「평균 응답 시간(ms)」 칸 값 `3000`, 「백분위 1」 `90`·「기준 1」 `2500`, 스텝 `p99.9_ms` 행이 「백분위(ms)」+`99.9`, 스텝 `p95_ms` 행이 「p95(ms)」(Review Focus 4).
  - `ScheduleForm.test.tsx`: 새 스케줄 — 「SLO 기준 (선택)」을 펼쳐 최대 `10000`·백분위 99.9 ≤ `8000` → 저장 본문 `profile.criteria`가 `{max_max_ms:10000, max_percentiles_ms:[{percentile:99.9,max_ms:8000}]}`. Task 1의 수정 열기 케이스에 칸 값 단언을 더한다.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/CriteriaFields.test.tsx src/components/run/__tests__/StepCriteriaFields.test.tsx src/components/run/__tests__/RunDialog.test.tsx src/components/run/__tests__/ScheduleForm.test.tsx` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — 목업 1번이 시각 기준(점선 테두리 = 새로 생기는 것):
  - `CriteriaFields`: 격자 맨 앞에 평균·최대 칸(`step="any"`, `min="0"`, `max="60000"`), 격자 아래 `<p className="mt-1 text-xs text-slate-500">{ko.criteria.meanHelp}</p>`(문구는 spec §6.1 그대로: 「평균은 느린 응답 몇 건이 있어도 낮게 나올 수 있습니다. 대부분의 사용자가 겪는 속도를 보려면 p95를 함께 거세요.」). 그 아래 `mt-3` 묶음: 제목 `ko.criteria.percentilesTitle`(「다른 백분위 기준 (선택)」, 스텝 기준 제목과 같은 `text-sm font-medium text-slate-600`), 행 = `p [N 칸 w-[72px]] ≤ [ms 칸 w-24] ms ×`(목업 `.row` — `flex items-center gap-2`), 「+ 백분위 기준 추가」(스텝 「+ 스텝 기준 추가」와 같은 `text-sm text-accent-600 hover:underline`). 행 아래 오류 `<p id=… className="text-xs text-red-600">`. 기존 칸 레이블·순서는 그대로.
  - `StepCriteriaFields`: `METRICS` 앞에 `mean_ms`·`max_ms`·`percentile` 셋(단위 `ms`). 「백분위」 행은 항목 선택 뒤에 `p [N 칸 w-16]`. 행 아래 오류 글자.
  - 새 글자는 전부 `ko.criteria`(`meanLabel` 「평균 응답 시간(ms)」·`maxLabel` 「최대 응답 시간(ms)」·`meanHelp`·`percentilesTitle`·`addPercentile` 「+ 백분위 기준 추가」·`percentileAria(i)` 「백분위 i」·`percentileMsAria(i)` 「기준 i」·`removePercentile(i)` 「백분위 기준 i 삭제」·`stepMean` 「평균(ms)」·`stepMax` 「최대(ms)」·`stepPercentile` 「백분위(ms)」·`stepPercentileAria(i)` 「스텝 기준 i 백분위」·`maxRowsHint` 「백분위 기준은 10개까지 걸 수 있습니다」 — 추가 단추가 막혔을 때 옆에 보인다). 기존 하드코딩 글자는 건드리지 않는다.
  - 두 화면: `onPercentilesChange={(rows) => setCriteriaState((c) => ({ ...c, percentiles: rows }))}`, `criteriaErrs`를 두 컴포넌트에 `errors`로 넘긴다(이 task에서는 막지 않는다).
- [ ] **Step 4: 통과 확인** — Step 2의 네 파일 + `RunDialog.steady.test.tsx`·`RunDialog.trust.test.tsx` PASS.
- [ ] **Step 5: 되돌려 확인** — `StepCriteriaFields`의 「백분위」 선택 시 `p` 기본 `"90"` 채움을 지우면 그 테스트 RED, 원복.
- [ ] **Step 6: 목업 대조** — 실행 창 「판정·고급」을 띄워(`pnpm dev` + 목 API 또는 Task 6 스택) 목업 1번과 칸 순서·행 모양·도움말 자리를 나란히 본다. 다른 점은 고치거나 `.superpowers/sdd/live-3b.md`에 이유를 남긴다(working-rules §4 — 첫 렌더 task 직후 대조).
- [ ] **Step 7: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. `feat(ui): 판정 기준 입력 칸에 평균·최대·다른 백분위·스텝 새 항목`.

### Task 3: 실행 창·스케줄 폼 — 잘못된 값 막기·이유 (R18 화면)

**Files:**
- Modify: `ui/src/components/run/RunDialog.tsx`, `ui/src/components/run/ScheduleForm.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/run/__tests__/RunDialog.test.tsx`, `ui/src/components/run/__tests__/ScheduleForm.test.tsx`

**Interfaces:**
- Consumes: Task 1 `hasCriteriaErrors`, Task 2 `criteriaErrs`.
- Produces: 없음(화면 끝).

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `RunDialog.test.tsx` `describe("새 판정 항목 막기")`:
    - 평균 `70000` → 실행 단추·「프리셋으로 저장」 단추 `disabled`, 칸 아래 `ko.criteria.errTime`, 「프리셋으로 저장」 줄 아래 `ko.criteria.presetBlocked`. 프리셋을 불러온 상태면 「이름 변경」도 `disabled`. 값을 `3000`으로 고치면 셋 다 풀린다.
    - 추가만 한 백분위 행(N 90·ms 빈칸)만 있으면 실행 단추 활성(Review Focus 3).
    - 숨은 오류: 평균 `70000`을 넣고 「판정·고급」을 접으면 이유 상자에 `ko.validation.criteria`; 펼치면 그 줄이 없다(칸 아래 오류가 보이므로). 간단 모드로 바꿔도 이유 상자에 그 줄. 이유 상자는 제목(`ko.runDialog.blockedReasonsIntro`)으로 찾는다 — 실행 창엔 `role="status"` 상자가 여럿이다(신뢰도 안내 등).
  - `ScheduleForm.test.tsx`(스케줄 폼의 `canSubmit`은 이름·시나리오·트리거가 다 있어야 참이라, 그것부터 채워야 막기가 공허하지 않다): 이름·시나리오·cron을 채워 저장 단추가 **활성**임을 먼저 단언 → 「SLO 기준」을 펼쳐 백분위 행 `p=95`·ms `1` → `disabled` + `ko.criteria.errPercentileFixed("95")` → p를 `90`으로 고치면 다시 활성. 오류 상태로 섹션을 접으면 이유 상자(제목으로 찾음)에 `ko.validation.criteria`, 펼치면 없음.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/RunDialog.test.tsx src/components/run/__tests__/ScheduleForm.test.tsx` → 새 케이스 FAIL.
- [ ] **Step 3: 구현**
  - `const criteriaInvalid = hasCriteriaErrors(criteriaErrs);`. 실행 창 `canSubmit`은 맨 앞 `!poolConflict && !criteriaInvalid && (…지금 식…)`(모든 갈래에 한 번에), 스케줄 폼 `canSubmit`도 앞에 `!criteriaInvalid &&`.
  - 「프리셋으로 저장」·「이름 변경」 `disabled`에 `|| criteriaInvalid`(「이름 변경」도 `currentInput()`으로 폼 전체를 PUT하므로 같이 막는다). 「프리셋으로 저장」 줄 아래 `criteriaInvalid`면 `<p className="text-xs text-red-600">{ko.criteria.presetBlocked}</p>`(「판정 기준에 고칠 값이 있어 프리셋으로 저장할 수 없습니다.」).
  - 이유 상자: 실행 창 `blockedReasons`에 `...((mode === "simple" || !advancedOpen) && criteriaInvalid ? [ko.validation.criteria] : [])`, 스케줄 폼에 `...(!sloOpen && criteriaInvalid ? [ko.validation.criteria] : [])`. `ko.validation.criteria` = 「판정 기준에 고칠 값이 있습니다 — 판정 기준 칸의 붉은 안내를 확인하세요.」
- [ ] **Step 4: 통과 확인** — 두 파일 PASS.
- [ ] **Step 5: 되돌려 확인** — ① 실행 창 `canSubmit`의 `!criteriaInvalid`를 지우면 막기 테스트 RED, 원복. ② 스케줄 폼 `canSubmit`의 `!criteriaInvalid`를 지우면 스케줄 막기 테스트 RED, 원복. ③ 이유 상자 줄(두 화면 각각)을 지우면 숨은 오류 테스트 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. `feat(ui): 실행 창·스케줄 폼이 잘못된 판정 기준을 막고 이유를 보인다`.

### Task 4: 인쇄 판정 거울 (R20 인쇄, §B95 (1)②)

**Files:**
- Modify: `ui/src/print/verdict.ts`(`criteriaHasAny`·`expandCriteria`·`criterionName`·`CARD_METRIC`·`kpiCards`·`otherCriteriaRows`), `ui/src/print/format.ts`(`fmtCriterionPair`), `ui/src/print/sentences.ts`(`verdictLine`), `ui/src/i18n/ko.ts`(`ko.print.criteria`)
- Test: `ui/src/print/__tests__/verdict.test.ts`, `ui/src/print/__tests__/format.test.ts`, `ui/src/print/__tests__/sentences.test.ts`, `ui/src/components/report/__tests__/ReportHeadline.test.tsx`, `ui/src/print/compare/__tests__/fairness.test.ts`(기준 카드 1건)

**Interfaces:**
- Consumes: `parsePercentileMetric`·`percentileMetricName`(`ui/src/api/percentileName.ts`).
- Produces: `fmtCriterionPair(metric, actual, threshold, capped = false): PairText` — `capped`이고 `metric`이 `_ms`로 끝나면 `actual` 앞에 「≥ 」, `tiny: false`. `KpiCard.key "mean"`의 목표가 `mean_ms` 기준을 읽는다.

- [ ] **Step 1: 서버 순서 확인** — 기대 순서는 손으로 쓰지 않고 서버 테스트를 거울로 쓴다: `grep -n "fn rule2_order" -A 40 crates/controller/src/report.rs`. 그 테스트의 기준(`max_mean_ms`, `max_p99_ms`, `max_p50_ms`, 목록 `[99.9, 90.0]`(넣은 순서 그대로), `max_max_ms`, `max_error_rate`, 스텝 `mean_ms` 대상 `"A"`)과 단언 `["mean_ms","p50_ms","p90_ms","p99_ms","p99.9_ms","max_ms","error_rate","mean_ms"]`을 UI 테스트에 그대로 옮긴다(서버 코드·테스트 변경 없음).
- [ ] **Step 2: 실패하는 테스트 쓰기**
  - `verdict.test.ts`: `criteriaHasAny({max_mean_ms: 1})`·`({max_max_ms: 1})`·`({max_percentiles_ms:[{percentile:90,max_ms:1}]})` → 참, `({max_percentiles_ms: []})` → 거짓. `expandCriteria(Step 1의 기준)`의 `metric` 배열 = Step 1 배열(마지막 행 `target === "A"`), 백분위 목록 행 `threshold` = `max_ms`. 고정 p95와 목록 p90·p99.9를 함께 둔 기준에서도 `p90 → p95 → p99.9` 순서. `criterionName("mean_ms")` = `{name:"평균 응답시간",subj:"이"}`, `"max_ms"` = `{name:"최대 응답시간",subj:"이"}`, `"p99.9_ms"` = `{name:"99.9% 응답시간",subj:"이"}`, `"p95_ms"`는 지금 값 그대로. `kpiCards`: 기준에 `max_mean_ms: 3000`, 판정 행 `{metric:"mean_ms",threshold:3000,actual:3120.5,passed:false,direction:"max",target:null}` → `mean` 카드 `target`에 「3,000ms 이하」와 「3,120.5ms」가 들고 `bad: true`, 카드 `value`는 `fmtMs(summary.mean_ms)`(정수) 그대로. 그 기준 행은 `otherCriteriaRows`에 없다. `capped: true`인 `max_ms` 행 → `otherCriteriaRows`의 `actual`이 「≥ 60,000ms」.
  - `format.test.ts`: `fmtCriterionPair("max_ms", 60000, 10000, true).actual === "≥ 60,000ms"`, `tiny === false`; `capped` 생략 시 지금 결과와 같음; `fmtCriterionPair("error_rate", 0.1, 0.05, true)`는 「≥」 없음.
  - `sentences.test.ts`: 첫 미달 행이 `capped` `mean_ms`면 문장에 「평균 응답시간이 기준을 넘었습니다 (측정 ≥ 1,842.613ms, 기준 1,000ms 이하)」.
  - `fairness.test.ts`(인쇄 비교 기준 카드가 `expandCriteria`를 거쳐 새 칸을 보는지): 앞 run `{max_mean_ms: 3000}`·뒤 run `{max_mean_ms: 2000}` → 기준 카드 `same: false`, 줄 `F.criteriaDiff(1)`. (이 파일의 `fair()` 헬퍼 그대로.)
  - `ReportHeadline.test.tsx`: 기준이 `{max_mean_ms: 3000}`뿐이고 `verdict`가 없는 완료 run(요청 > 0)이면 머리말에 `ko.report.headlineNotEvaluable`(「판정하지 않음 — 기준은 있었지만 …」)이 보이고 `ko.report.sloHint`는 없다(지금은 `criteriaHasAny`가 새 칸을 몰라 `sloHint` — `ReportHeadline.tsx` `noVerdictText`, §B95 (1)②의 화면 쪽 증상).
- [ ] **Step 3: 실패 확인** — `cd ui && pnpm vitest run src/print/__tests__/verdict.test.ts src/print/__tests__/format.test.ts src/print/__tests__/sentences.test.ts src/components/report/__tests__/ReportHeadline.test.tsx src/print/compare/__tests__/fairness.test.ts` FAIL.
- [ ] **Step 4: 구현**
  - `criteriaHasAny`: `max_mean_ms`·`max_max_ms` 값 있음, `max_percentiles_ms` 길이 > 0도 참.
  - `expandCriteria`: 시간 행을 `(key, spec)` 목록으로 모아 안정 정렬 — 평균 0, 고정 p50·p95·p99는 50000·95000·99000, 목록은 `Math.round(percentile * 1000)`(이름은 `percentileMetricName(String(percentile))`, null이면 건너뜀), 최대 `Number.MAX_SAFE_INTEGER`. 고정 칸을 목록보다 먼저 넣어 같은 키면 고정이 앞(서버와 같음). 나머지 행은 지금 순서.
  - `criterionName`: 표 → `mean_ms`·`max_ms`(표에 추가) → `parsePercentileMetric`이면 `k.criteria.percentileName(n)`(`${n}% 응답시간`, subj 「이」) → 모름.
  - `CARD_METRIC`에 `mean: "mean_ms"`.
  - `kpiCards`·`otherCriteriaRows`·`sentences.ts` `verdictLine`이 `fmtCriterionPair(…, row.capped ?? false)`.
- [ ] **Step 5: 통과 확인** — `pnpm vitest run src/print` PASS(스냅샷이 바뀌면 바뀐 줄이 새 항목뿐인지 읽고 갱신).
- [ ] **Step 6: 되돌려 확인** — `expandCriteria`의 정렬을 빼고 「고정 → 목록」 순서로 두면 순서 테스트 RED, 원복.
- [ ] **Step 7: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. `feat(ui): 인쇄 판정 행이 평균·최대·백분위와 서버 순서를 안다`.

### Task 5: 비교 — 규칙 안내 하나로·인쇄 비교 조건 행·속도 구간 (R20 비교, R21, §B95 (1)③)

**Files:**
- Modify: `ui/src/compare/statusRuleNotice.ts`(함수 `statusRuleNotice` → `ruleNotice`), `ui/src/pages/ScenarioComparePage.tsx`, `ui/src/print/compare/fairness.ts`(`statusRuleLine` → `ruleLine`, 조건 행·`diffNames`), `ui/src/print/compare/components/FairCards.tsx`, `ui/src/print/compare/speedCompare.ts`, `ui/src/i18n/ko.ts`
- Test: `ui/src/compare/__tests__/statusRuleNotice.test.ts`, `ui/src/print/compare/__tests__/fairness.test.ts`, `ui/src/print/compare/__tests__/speedCompare.test.ts`, `ui/src/print/compare/__tests__/fixtures.ts`(`MkReportArgs.latencyRule?: 1 | 2` → `run.latency_rule`, `statusRule` 줄과 같은 모양; `fairness.test.ts`의 `Opts`·`model()`에도 `latencyRule`), `ui/src/print/compare/__tests__/scene.ts`(`SceneRun.latencyRule` 전달), `ui/src/print/compare/__tests__/headline.test.ts`(두 규칙이 다 다르고 부하 크기도 다른 비교의 머리말 4번 줄에 「판정 규칙」과 부하 이름이 함께 보인다 — 1건), `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`(규칙이 섞인 두 run → 안내 `Callout`에 `bothRulesNotice` 한 문장 — 새 케이스 1건)

**Interfaces:**
- Consumes: `reportStatusRule`·`reportLatencyRule`(`ui/src/api/schemas.ts`).
- Produces: `ruleNotice(reports: Array<Pick<Report, "run">>): string | null` — 상태 코드 규칙만 다르면 `ko.compare.statusRuleNotice`(지금 글자), 응답 시간 규칙만 다르면 `ko.compare.latencyRuleNotice`, 둘 다 다르면 `ko.compare.bothRulesNotice`, 같으면 null. `Fairness.ruleLine: string | null`(옛 `statusRuleLine`).

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `statusRuleNotice.test.ts`: 기존 넷을 `ruleNotice`로 + 응답 시간만 다름(`latency_rule` 2 vs 키 없음) → `latencyRuleNotice`, 둘 다 다름 → `bothRulesNotice`(한 문장 — 상태 코드 문장과 응답 시간 문장이 둘 다 나오지 않는다), 같은 run 셋 중 하나만 다른 경우.
  - `fairness.test.ts`: `fair({latencyRule: 2}, {})` → `condRows`에 레이블 「응답 시간 판정 규칙」 행(`before` `C.latencyRuleText[2]`, `after` `C.latencyRuleText[1]`, `differs: true`), `diffNames[0] === F.latencyRuleName`, `ruleLine === latencyRuleNotice`. 둘 다 2면 그 행·이름 없음. 상태 코드만 다르면 지금처럼 `diffNames[0] === F.statusRuleName`. **둘 다 다르면 `diffNames[0] === F.rulesName`(「판정 규칙」) 하나뿐이고 `F.statusRuleName`·`F.latencyRuleName`은 `diffNames`에 없다**, `ruleLine === bothRulesNotice`, 조건 행은 둘 다 있다. 기존 `statusRuleLine` 단언은 `ruleLine`으로.
  - `speedCompare.test.ts`: 두 run의 `overall`이 `slow_ms` 43·basis 같음인데 뒤 run만 `latency_rule: 2`(+`slow_us: 43000`) → `same === false`, `warn === C.warnRule`. 둘 다 규칙 2·같은 경계면 `same === true`(지금 동작). 이 파일은 `scene.ts` `sceneModel`로 run을 만든다 — `SceneRun`에 `latencyRule?: 1 | 2`를 더하고 `mkReport`에 넘긴다(`statusRule: o.statusRule` 줄과 같은 모양).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/compare/__tests__/statusRuleNotice.test.ts src/print/compare/__tests__/fairness.test.ts src/print/compare/__tests__/speedCompare.test.ts src/print/compare/__tests__/headline.test.ts src/pages/__tests__/ScenarioComparePage.test.tsx` → 새 케이스 FAIL.
- [ ] **Step 3: 구현**
  - `ruleNotice`: 두 규칙을 각각 「모두 같은가」로 보고 위 표대로. `ScenarioComparePage`의 `ruleNote`가 이 함수를 쓴다(안내 자리·`Callout` 그대로).
  - `fairness.ts`: 응답 시간 규칙도 읽고(`reportLatencyRule(before.report)`·`(after.report)` — `compareScenario`에 넘기는 `rules`는 상태 코드 전용이라 따로 둔다), 지금의 `if (ruleDiffers) diffNames.unshift(F.statusRuleName);`를 다음으로 바꾼다:
    ```ts
    const ruleName =
      ruleDiffers && latencyDiffers ? F.rulesName
      : ruleDiffers ? F.statusRuleName
      : latencyDiffers ? F.latencyRuleName
      : null;
    if (ruleName) diffNames.unshift(ruleName);
    ```
    둘 다 다를 때 이름 하나로 합치는 이유: 인쇄 머리말(`print/compare/headline.ts` `names.slice(0, 2)`)은 앞 두 이름만 쓰는데, 옛 run ↔ 새 run 비교는 늘 두 규칙이 함께 다르므로(R21) 이름 둘을 따로 넣으면 부하 크기 같은 진짜 차이가 「외 N」으로 밀린다 — 안내 문장을 하나로 합친 R21과 같은 처리(내 판단, build-log·§B에 기록). 조건 행은 상태 코드 행 뒤에 `if (latencyDiffers) addRow(C.latencyRule, C.latencyRuleText[lb], C.latencyRuleText[la], true, false)`. `statusRuleLine` → `ruleLine: ruleNotice([before.report, after.report])`. `FairCards.tsx` 두 곳.
  - `speedCompare.ts`: `const ruleSame = reportLatencyRule(before.report) === reportLatencyRule(after.report)`. `same`에 `&& ruleSame`. `warn`: `same`이면 null, 경계·basis·fast가 같은데 규칙만 다르면 `C.warnRule`, 그 밖은 `C.warn`.
  - 문구(`ko.ts`): `compare.latencyRuleNotice` = 「선택한 run 가운데 응답 시간 판정 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 응답 시간 기준을 ms 정수로 내려 비교했습니다(예: 43.9 ms가 「≤ 43 ms」를 통과) — 기준 ±1 ms 안쪽의 판정과 응답 속도 구간 건수를 그대로 견주지 마세요.」, `compare.bothRulesNotice` = 「선택한 run 가운데 판정 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았고, 응답 시간 기준을 ms 정수로 내려 비교했습니다 — 오류율과 기준 ±1 ms 안쪽의 판정을 그대로 견주지 마세요.」, `print.cmp.fair.latencyRuleName` = 「응답 시간 판정 규칙」, `print.cmp.fair.rulesName` = 「판정 규칙」, `print.cmp.cond.latencyRule` = 「응답 시간 판정 규칙」, `print.cmp.cond.latencyRuleText` = `{1: "ms 정수로 내려 비교", 2: "µs까지 정확히 비교"}`, `print.cmp.speed.warnRule` = 「▲ 두 측정은 응답 시간 경계를 세는 규칙이 달라(이전 run은 ms 정수로 내려 셈) 구간을 그대로 비교할 수 없습니다.」
- [ ] **Step 4: 통과 확인** — `pnpm vitest run src/compare src/print/compare src/pages` PASS.
- [ ] **Step 5: 되돌려 확인** — `speedCompare`의 `&& ruleSame`을 지우면 규칙 테스트 RED, 원복. `ruleNotice`의 「둘 다」 갈래를 지우면 bothRules 테스트 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. `feat(ui): 비교 화면·인쇄 비교가 응답 시간 판정 규칙 차이를 알린다`.

### Task 6: 라이브 검증 (US1·US2·US3·US6 입력 경로, 진입 화면 전부, 극단값)

**Files:** 없음(검증만 — 결함이 나오면 해당 task 파일을 고치는 fix 커밋). 기록은 build-log 단락(finish-slice에서).

- [ ] **Step 1: 스택** — `/live-verify`로 이 워크트리 바이너리 + 지연 응답기(경로별 지연: `/fast` 10 ms·`/slow` 40 ms, 90%/10% 섞는 경로 하나) + 새 DB. UI는 `just ui-build` 뒤 `--ui-dir ui/dist`.
- [ ] **Step 2: US1·US2·US3** — 실행 창(새 run)에서 평균 ≤ 30(40 ms 응답기 → ✗)·최대·p90·p99.9 목록·스텝 평균/백분위 기준을 넣고 실행 → 리포트 판정 표에 행 이름·순서(spec R11)·실측, 목록 배지 툴팁, 인쇄 미리보기 판정 행이 같은 행·순서·글자(평균 행은 인쇄 KPI 「평균」 카드 목표로 — 화면 요약 「평균」 카드는 ③c라 이번엔 없다). 머리말이 「판정 …」을 낸다(평균 기준만 건 run도 `sloHint` 아님).
- [ ] **Step 3: 진입 화면 전부**(working-rules §4) — 실행 창: 새 run·「다시 실행」·프리셋 저장 → 새로 열어 프리셋 불러오기(칸 채워짐 + 그대로 실행한 run의 `profile.criteria`가 같음). 스케줄 폼: 새로·수정. 각 화면에서 잘못된 값 하나(평균 70000, 백분위 95)로 버튼이 막히고 이유가 보이는지.
- [ ] **Step 4: US6** — 옛 DB는 태그 `v0.16.0`(`e2c07745` — ②a `58ed2318`·③a `fa8abe79` 이전, `git merge-base --is-ancestor`로 확인) 바이너리로 만든다: `git worktree add <scratchpad>/v016 v0.16.0` → 거기서 절대경로 `CARGO_TARGET_DIR`로 따로 두 번 `cargo build -p handicap-controller --bin controller`, `cargo build -p handicap-worker`(한 명령에 `--bin controller`를 주면 워커가 안 빌드된다) → 옛 컨트롤러는 `--worker-bin <CARGO_TARGET_DIR>/debug/worker`로 띄운다(기본값이 상대경로 `target/debug/worker`라 못 찾으면 run이 즉시 실패) → 같은 응답기로 프리셋·스케줄·run 하나씩(옛 기준만, run은 경계가 정수인 `max_p95_ms`). 그 DB를 이 워크트리 바이너리로 열어: 프리셋·스케줄 칸이 그대로 채워지는지, 옛 run의 판정 표·배지가 그대로인지. 같은 시나리오에 새 run 하나를 더해 비교 화면 → 안내 한 문장(`bothRulesNotice`), 인쇄 비교 조건 표에 두 규칙 행·머리말 「판정 규칙」 하나, 속도 구간 비교 `warnRule`(경계가 같으면). 끝나면 `git worktree remove`.
- [ ] **Step 5: 극단값**(working-rules — 최대 개수·긴 글자) — 백분위 행 10개(N `99.999` 같은 긴 값) + 스텝 기준 6개(긴 스텝 이름) + 모든 오류 글자를 띄운 상태에서 실행 창(폭 `max-w-2xl` 기본과 좁은 창 640px)·스케줄 폼의 칸·단추·오류 글자 rect가 서로 겹치거나 잘리지 않는지 `getBoundingClientRect`로 잰다. 판정 표·인쇄 판정 행(목록 10행 + 스텝 6행)도 같은 방식.
- [ ] **Step 6: 숫자 칸 글자 실측** — 「§B에 옮길 판단」 (1)의 전제를 실제 브라우저로 확인한다: 실행 창 백분위 N 칸과 스텝 「백분위」 N 칸에 `090`·`1e1`·`90.`·`+90`을 각각 입력하고 ① 칸의 `value`(`input.value`) ② 보이는 오류 문구 ③ 실행 단추 상태를 적는다(Chrome 기준, Safari도 되면). 결과를 (1)의 「실측」 줄에 채운다.
- [ ] **Step 7: 기록** — 통과 신호·못 본 것을 `.superpowers/sdd/live-3b.md`에 남겨 finish-slice가 build-log로 옮긴다.

---

## §B에 옮길 판단 (finish-slice가 이 슬라이스의 roadmap §B 항목 「(0) 확인 대기」로 옮긴다 — 승인 아님)

**(1) 숫자 칸의 정본이 아닌 글자 — 보류 (검토 지적 8, 2026-11-24, 사용자: 「숫자 칸은 애매하긴 하네. 잘 적어둬」)**
- **무엇**: 백분위 N 칸(run 「다른 백분위 기준」 행·스텝 「백분위」 행, 둘 다 `type="number"`)에 `090`·`1e1`처럼 수로는 맞지만 정본 글자가 아닌 것을 쓰면, UI는 문법 `NUMBER_RE`(`ui/src/api/percentileName.ts`)로 거절해 「백분위는 0보다 크고 100보다 작은 수(소수 셋째 자리까지)로 적어 주세요」를 띄우고 실행·저장을 막는다. 서버는 JSON 숫자만 받으므로(90·10) 받았을 값이다 — R5 「UI가 서버보다 엄하면 안 된다」의 유일한 예외.
- **왜 이렇게 뒀나**: 드문 입력 / 오류가 보이고 값이 조용히 빠지지 않는다 / 「입력 글자 → 이름」 문법을 공유 표(`testdata/percentile_metric_cases.json` `numbers`) 하나로 유지 — 폼만 따로 정규화하면 그 표의 뜻과 폼 동작이 갈린다.
- **애매한 점**: 오류 문구가 이유를 틀리게 말한다 — `090`은 범위 안인데 「0보다 크고 100보다 작은 수」라고 한다. 사용자는 무엇을 고쳐야 할지 헷갈린다.
- **비용**: 그런 글자를 쓴 사람은 맞지 않는 안내를 보고 한 번 더 고쳐 써야 한다. 값이 틀리게 저장되지는 않는다.
- **전제(미검증)**: 「브라우저가 `type="number"` 칸에 `090`·`1e1`을 그 글자 그대로 `value`로 둔다」는 검토자의 주장이다 — Task 6 Step 6에서 실측. 브라우저가 이미 `90`으로 바꿔 준다면 이 항목은 사라진다.
- **실측** (2026-11-25, Chrome, 실제 키 입력 `pressSequentially`, Safari 미확인): 실행 창 백분위 N 칸 — `090` → `value` `"090"` 그대로, 오류 「백분위는 0보다 크고 100보다 작은 수(소수 셋째 자리까지)로 적어 주세요.」, 실행 막힘 / `1e1` → `"1e1"` 그대로, 같은 오류, 막힘 / `90.` → `"90"`(브라우저가 정리), 오류 없음 / `+90` → `"90"`(브라우저가 정리), 오류 없음. 스텝 「백분위」 N 칸 `1e1` → 같은 결과. ⇒ 전제는 `090`·`1e1`에서 참(글자 그대로 남아 이유가 틀린 오류를 본다), `90.`·`+90`은 문법까지 오지 않는다. **사용자 결정 (2026-11-25): (나)** — 「실제로 그렇게 입력할 일은 잘 없다보니 일단 추천 방향으로」. 문법은 그대로, 수가 범위 안인데 글자 모양만 다르면 `ko.criteria.errPercentileFormat` 「90처럼 앞의 0·지수 표기 없이 적어 주세요.」(`profileForm.ts` `percentileNameError`). R5 예외(UI가 이 글자에서만 서버보다 엄함)는 남는다.
- **푸는 길**: (가) 폼에서 `String(Number(text))`로 바꾼 뒤 문법을 건다 — 서버와 같아지지만 공유 표와 폼 동작이 갈린다(표에 「폼 입력」 줄을 따로 둬야 한다). (나) 오류 문구를 둘로 나눈다 — 수가 범위 밖이면 지금 문구, 수는 맞는데 글자 모양만 다르면 「90처럼 앞의 0·지수 표기 없이 적어 주세요」 — 문법은 그대로, 이유만 정확히. (다) 지금대로. 내 추천은 (나)(작고, R5 예외는 남지만 안내가 정직해진다) — 사용자 결정 대기.

## 연기 (이 plan에서 하지 않음 — spec §10 그대로)

③c(R22–R24: 평균 카드·스텝 표 통계·µs 표시), ④(인쇄 본문·CSV/XLSX·비교 화면의 통계 칸, 「응답시간」 띄어쓰기), 표준편차·최소 판정 등 spec §10 전부. 기존 칸(`max_p50_ms` 등)의 60,000 상한 검사도 spec §10(US6) — UI도 추가하지 않는다.
