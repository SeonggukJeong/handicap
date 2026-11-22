# 준비 스텝 A2 입력 — UI `.steps` 전수 분류표

명령(실행 위치: 저장소 루트, A1 Task 12 구현 뒤):

```bash
grep -rnE '\.steps\b|"steps"' ui/src --include='*.ts' --include='*.tsx'
```

위 명령을 이 커밋 시점에 다시 돌린 결과: 521건 = 프로덕션 코드 파일 56개 + 테스트 파일 46개(`__tests__`·`.test.`), 파일 합계 102개(파일 수 명령: `grep -rlE … | wc -l`, 프로덕션만 `| grep -vcE '__tests__|\.test\.'`). 아래 표는 프로덕션 파일을 줄 단위로 분류한다. 테스트 파일의 매치는 전부 픽스처·단언이라 「시나리오와 무관」이 아니라 **각 대상 코드의 분류를 따른다**(대상이 A2면 그 테스트도 A2에서 고친다).

분류 — **모두**: 준비 스텝도 훑어야 하는 「모든 스텝」 · **본문**: 반복 본문만 · **무관**: 시나리오 스텝이 아님(리포트·계단·trace 행 등).
처리 — **A1**: 이 task에서 고쳤다 · **A2**: A2에서 고친다 · **-**: 고칠 것 없음.

## 시나리오 모델·YAML

| 파일:줄 | 분류 | 처리 | 비고 |
|---|---|---|---|
| `scenario/model.ts` `allSteps`·`setupSteps`(531,536) | 모두 | A1 | 새 헬퍼 |
| `scenario/model.ts:382,415,454,483` (`flattenHttpSteps`·`siblingsOrNull`·`findStepById`·`isInsideParallelBranch`의 분기 하강) | 무관 | - | parallel 분기 `.steps`. 호출부가 넘기는 목록이 기준 |
| `scenario/model.ts:398` `scenarioHasThink` | 모두 | A2 | 준비 스텝의 think_time도 「think 있음」(open-loop 무시 토글 노출)에 든다. D2 think 제거와 한 묶음 |
| `scenario/yamlDoc.ts` 29건 중 `normalizeForModel`(루트 `steps`) | 모두 | A1 | `setup` 허용 목록 추가(`normalizeSetup`) |
| `scenario/yamlDoc.ts` 나머지(`["steps", …]` 경로·`findStepPath`·`addStep`·`removeStep`·`moveStep`·`insertSteps` 등) | 모두 | A2 | 준비 스텝의 YAML 경로 `["setup","steps",i]`와 쓰기 규칙(처음 생길 때만 `setup:` 키, 마지막이 지워지면 키 삭제)은 A2 편집기 몫 |
| `scenario/store.ts:195` 다중 스텝 think 일괄 편집의 http leaf 교집합 | 모두 | A2 | |
| `scenario/store.ts:344,412,421` (`addBranch`·복제·삽입 위치) | 본문 | - | 본문 구조 편집. 준비 구획 편집은 A2에서 별도 액션 |
| `scenario/dropRules.ts:41,42,97` | 본문 | - | 끌어 옮기기 규칙. 준비 구획 드롭은 슬라이스 B |
| `scenario/thinkTime.ts:107,118` | 모두 | A2 | 현황판이 준비 스텝도 나열하고 think 일괄 편집에 포함 |
| `scenario/loopJudgeMeta.ts:19,23` | 본문 | - | loop만 찾는다. 준비 구간에는 loop이 없다 |
| `scenario/chipResults.ts:28` | 무관 | A2 | trace 행. 준비 행이 trace에 들어오므로 흐름 칩이 준비 행을 어떻게 다룰지(D11) A2에서 정함 |
| `scenario/trustPrefs.ts:75,93` | 모두 | A1 | 지문에 `setup:`을 준비 스텝이 있을 때만 더한다(없으면 옛 지문과 글자가 같다). 필드 집합 핀 테스트 갱신 |
| `scenario/problems.ts:57` | 모두 | A1 | id 겹침 검사 |
| `scenario/scanVars.ts` 17건 | 모두 | A1 | `scanEnvVars`·`scanFlowVars`·`buildVarRefIndex`·`collectProducedVars`·`flatExtractNames`·`jsonCastVarNames`는 준비 스텝까지, `undefinedVarRefs`는 준비 스텝을 별도 범위(선언 ∪ 준비 추출)로 판정. 분기·parallel 전용 함수(`namespacedProducerIndex`·`parallelExtractNames`·`collectBranchInternalRefs`·`parallelVarIdentities`)는 준비 구간에 parallel이 없어 변경 없음 |
| `scenario/trust.ts` (`isTrustApplicable`·`evaluateTrust`) | 모두 | A1 | `allSteps` 사용(이 grep에는 더는 안 걸린다) |

## 에디터 화면

| 파일:줄 | 분류 | 처리 | 비고 |
|---|---|---|---|
| `components/scenario/ValidationBanner.tsx:16` | 모두 | A1 | 준비 스텝을 `collectProblems`에 넘김 |
| `components/scenario/FlowOutline.tsx:536,537` | 본문 | A1 | 아웃라인은 본문 그대로, 준비 스텝 수 한 줄만 더함 |
| `components/scenario/FlowOutline.tsx:286` | 무관 | - | parallel 분기 |
| `components/scenario/VariablesPanel.tsx` (`steps={allSteps(model)}` 2곳) | 모두 | A1 | 사용처 목록·삭제 확인이 준비 스텝 이름을 찾도록 `allSteps` 사용(이 grep에는 더는 안 걸린다) |
| `components/scenario/VarUsagePopover.tsx` 사용처 점프 (`onJump` → `jumpToStep` → `select(setupId)`, `EditorShell`) | 모두 | A2 | 변수 사용처에 준비 스텝 id가 들어오는데, 점프하면 아웃라인도 Inspector도 못 찾는 준비 스텝 id를 선택한다(A1에서는 준비 스텝을 고를 수 없음). A2에서 준비 구획 행 선택·Inspector와 함께 해결 |
| `components/scenario/Inspector.tsx:68,158,201,1176` | 본문 | A2 | 준비 스텝을 고를 수 없는 동안(A1)은 대상 아님. A2에서 준비 스텝 선택 시 Inspector(기본값 칸 안내 등) |
| `components/scenario/TestRunSection.tsx:44` | 모두 | A2 | `traceSteps` — trace 행의 이름·조건 요약 찾기. 준비 행 이름 표시 |
| `components/scenario/TestRunPanel.tsx:267–339` | 무관 | A2 | trace 행 렌더. 준비 행에 「준비」 표시(D11) |
| `components/scenario/TestFlowChips.tsx:65` | 본문 | A2 | 흐름 칩에 준비 구간 칩을 낼지 A2에서 정함 |
| `components/scenario/EditorShell.tsx:34` | 본문 | A2 | 넓게 보기 칩 스트립 |
| `components/scenario/SaveTemplateDialog.tsx:27` | 본문 | - | 스텝 템플릿은 본문 스텝만(준비 스텝 템플릿은 비목표) |
| `components/scenario/YamlFileActions.tsx:44` | 본문 | A2 | 「내용 있음」 판정 — 준비만 있고 본문이 없는 시나리오를 빈 것으로 본다. A2에서 `setup` 포함 |
| `components/scenario/TrustBoard.tsx:93` | 무관 | - | `TrustCheck.steps`(검증 없는 스텝 목록). A1에서 `evaluateTrust`가 준비 스텝도 담으므로 준비 스텝 이름이 나온다 |

## 실행·사이징·모니터

| 파일:줄 | 분류 | 처리 | 비고 |
|---|---|---|---|
| `components/run/RunDialog.tsx:409` | 본문 | - | SLO 스텝 기준 후보 목록 — 반복 본문만(D2「SLO 스텝 기준의 대상 스텝」) |
| `components/run/ScheduleForm.tsx:78,146` | 본문 | - | 78: loop 유무, 146: SLO 스텝 후보(본문) |
| `pages/ScenarioRunsPage.tsx:120` | 본문 | - | loop 유무 |
| `components/run/LoadModelFields.tsx:214` | 본문 | - | 반복 요청 수 범위 — 사이징은 반복 본문(D2·D7) |
| `components/run/openLoopChecks.ts:52,115` | 본문 | - | 반복 시간 상한 |
| `components/run/sizing.ts:114,150` | 본문 | - | parallel 분기 하강 |
| `components/run/SlotSizingHelper.tsx:49–51` | 본문 | - | 반복 점유 시간. `total_ms − setup_ms` 보정(D7)은 A2 |
| `components/run/SlotSizingHelper.tsx:96`, `VuSizingHelper.tsx:68` | 무관 | A2 | trace 행 수 — 준비 행을 요청 수에서 뺀다(D7) |
| `components/run/VuSizingHelper.tsx:74` | 본문 | - | 정적 반복당 요청 수 |
| `components/run/runSummary.ts:31`, `StairFields.tsx:201` | 무관 | - | 계단 요약 `sm.steps`(계단 수) |
| `components/monitor/PanelEditor.tsx:126` | 모두 | A2 | 칸 설정의 스텝 선택·타임아웃·`loopMeta` — 모니터 점검은 준비 스텝도 지난다 |
| `components/monitor/CheckRecordDialog.tsx:65` | 모두 | A2 | 스텝 이름표 — 준비 행 이름 |
| `components/monitor/CheckRecordDialog.tsx:145–159` | 무관 | - | trace 행 |
| `components/monitor/PreviewResult.tsx:31,340` | 무관 | A2 | trace 행 렌더 |
| `pages/MonitorEditPage.tsx:197` | 모두 | A2 | `stepOptionsFor` — 칸 설정 스텝 목록 |
| `monitor/groups.ts:138` | 무관 | - | parallel 분기 |

## 리포트·인쇄·비교

| 파일:줄 | 분류 | 처리 | 비고 |
|---|---|---|---|
| `components/report/ReportView.tsx:98` (`stepMeta`) | 모두 | A1 | 준비 스텝 이름 포함 |
| `components/report/ReportView.tsx:104,116,127,128,137` (`ifMeta`·`groupMeta`·loop 뷰·타임아웃 꼬리) | 본문 | - | if·loop·그룹은 본문에만 있다. 타임아웃 재정의 꼬리(137)는 준비 스텝의 `timeout_seconds`를 안 본다 — A2에서 확인 |
| `components/report/ReportView.tsx:130,320` | 무관 | - | `report.steps` |
| `components/report/SetupSection.tsx` | 무관 | A1 | 새 구획(`report.setup.steps`) |
| `components/report/stair/*` (`stairFormat.ts`·`stairBandTypes.ts`·`StairTable.tsx`·`StairResultSection.tsx`) 계 17건 | 무관 | - | 계단 `stair.steps` |
| `pages/RunDetailPage.tsx:89` | 모두 | B | 진행 중 화면의 스텝 이름표 — 준비 행이 report에 없어 지금은 영향 없음, 준비 진행 표시를 더할 때 |
| `pages/ScenarioComparePage.tsx:131,143` | 본문 | - | 비교는 `report.steps`(본문). 준비 구획 비교는 비목표 |
| `compare/compareReports.ts:62–89` | 무관 | - | `report.steps` |
| `print/buildPrintDoc.ts:124,190,291` | 무관 | - | 124 `report.steps`, 190 facts, 291 계단. 머리 한 줄은 `meta.setupNote`(A1) |
| `print/scenarioFacts.ts:68,86` | 모두 | A2 | 인쇄 본문의 「대상 시스템」·스텝 사실표가 준비 스텝의 URL을 보지 않는다(준비가 다른 호스트면 누락). A2 |
| `print/stepTable.ts:175,177,180`, `print/compare/runModel.ts:38`, `print/compare/errorCells.ts:40` | 본문 | - | `report.steps`·facts. 인쇄 표에 준비 행은 비목표 |
| `print/compare/fairness.ts` 9건·`buildCompareDoc.ts:256,257` | 본문 | A2 | (2026-11-22 정정) 판정은 YAML 전체를 비교하므로 `setup` 내용 차이는 이미 「다름」으로 나온다. 고칠 것은 반대쪽 — 준비 스텝의 이름·메모만 달라도 「다름」이 되는 것(`stripScenarioNames`가 `setup.steps`의 이름을 안 지운다) |
| `print/speedBands.ts` 5건·`stairTable.ts`·`PrintDocument.tsx:168`·`StepCodeTable.tsx:47,48` | 무관 | - | 속도 구간·계단·절 제목 |
| `pages/TemplatesPage.tsx:31` | 본문 | - | 스텝 템플릿 |

## 요약

- A1에서 고친 「모두」: `model.ts` 헬퍼, `yamlDoc.ts` 읽기 허용, `scanVars.ts`, `trust.ts`, `trustPrefs.ts`, `problems.ts`/`ValidationBanner`, `VariablesPanel` 이름표, `ReportView` `stepMeta`.
- A2로 미룬 「모두」: `scenarioHasThink`, `yamlDoc.ts` 쓰기 경로·`store.ts` think 일괄 편집, `thinkTime.ts`, `PanelEditor`·`CheckRecordDialog`·`MonitorEditPage`, `TestRunSection`·`TestRunPanel`·`PreviewResult`(준비 행 표시), `YamlFileActions`, `RunDetailPage`, `print/scenarioFacts.ts`, `print/compare/fairness.ts`.
- 사이징 도우미의 `total_ms − setup_ms` 보정과 trace 요청 수 계산(D7)은 A2.
