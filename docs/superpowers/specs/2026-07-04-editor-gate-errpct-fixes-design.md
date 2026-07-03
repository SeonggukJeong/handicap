# 에디터 편집 게이트 + 에러율 floor — pre-existing 버그 2건 수정 (설계) (버그처리·UI-only)

- **날짜**: 2026-07-04
- **상태**: 설계 승인 (spec-plan-reviewer clean APPROVE, 2026-07-04, 3라운드) → plan 대기
- **출처**: 사용자 요청("pre-existing 버그 처리" → "연기된 버그성 갭"). **왜 지금**: A는 scenario-delete-name-sync 최종리뷰가 Minor로 남긴 잠복 정확성 버그(연필 게이트가 `editorYamlError` 미검사), B는 U5/report의 표시-정확성 버그(에러율/비율 `.toFixed(1)`이 nonzero를 "0.0%"로) — 둘 다 UI-only·검증 가능하여 한 슬라이스로 묶음.
- **연관**: `2026-07-03-scenario-delete-name-sync-design.md`(A 발견 출처·연필 인라인 편집), ADR-0044(FlowOutline 아웃라인), ADR-0043(디자인 시스템 — Callout).
- **ADR**: 신규 불필요. 버그 수정이며 기존 편집 모델(ADR-0044)·리포트 파생(ADR-0017) 범위 내.

## 범위 결정 (사용자, 2026-07-04)

- 버그 대상 = **연기된 버그성 갭** 중 **A(에디터 편집 게이트) + B(비율 floor)** 번들. (C=G2 k8s reaper는 macOS 검증 불가, D=legacy 테스트는 사용자 무영향으로 제외.)
- **A 동작 = 편집 차단**(아웃라인 편집 우선/버퍼 버리기 기각 — 작성중 YAML 손실 회피).
- **A 시각 비활성화 = 균형**(연필 + FlowOutline 드래그 + ValidationBanner 한 줄; 인스펙터/add-bar 개별 버튼은 store 가드 no-op + 배너로 커버, 전면 read-only 배선은 표면 과다로 제외).
- **B = 제네릭 floor를 *모든 동일-클래스 비율 **표시***에 적용**(사용자 "InsightPanel 포함 = generic floor 어디에나 안전"). r1 리뷰가 `Summary.dropPct`·`InsightCompareMatrix`(비교뷰 미러)를 추가 발견 → 포함(부분 적용은 단일-run↔비교뷰 불일치). **`ConnectionCostCard.reusePct`는 제외** — r2 리뷰가 그 값이 표시 텍스트이자 *CSS `style.width` 입력*(:30)임을 발견(floor 시 `width:"<0.1%"`=invalid CSS로 막대 깨짐)이고, 재사용율은 higher-better 지표라 0.0%가 오해 아닌 정상 상태(§3.3/§7).
- **A Save/Create 버튼 범위 밖**(버퍼 제출·서버 검증·비손상 클래스 — 구조적 편집과 별개).

---

## 1. 문제와 목표

**A.** YAML 모달 버퍼가 깨진 상태(`yamlError !== null`, `pendingYamlText`=깨진 텍스트, `doc`/`model`=last-good)에서 아웃라인/인스펙터/연필로 구조적 편집을 하면, store `dispatch`(거의 모든 편집의 단일 초크포인트)가 last-good `doc`에 편집을 적용·재직렬화 성공시켜 **`yamlError`를 조용히 `null`로 클리어**하면서 `pendingYamlText`(깨진 버퍼)는 그대로 둔다 → 편집이 "성공"했는데 YAML 모달을 다시 열면 `visibleText = pendingYamlText ?? yamlText`로 **편집을 반영 못 한 옛 깨진 버퍼**가 보이고 배너는 사라진 모순 상태. 형제 액션 `addStepExtract`(store.ts:259-263)는 이미 이 가드를 갖지만 `dispatch`/`reparentStep`엔 없다. (부수: `removeStep`은 dispatch 전에 selection을 clear하고, id-반환 add 액션은 dispatch가 no-op이어도 갓 생성한 id를 반환해 호출부 `select(id)`가 존재하지 않는 스텝을 가리킨다 — R1에서 함께 봉쇄.)

**B.** 리포트 비율을 `(x*100).toFixed(1)`로 찍어, 값이 실재하는데 0.05% 미만이면 **"0.0%"**(=0처럼)로 표시된다. 같은 반올림 함정이 에러율(`ReportHeadline`·`WorkerBreakdownTable`), 인사이트 pct(`InsightPanel`·비교뷰 미러 `InsightCompareMatrix`), 드롭율(`Summary.dropPct`)에 걸쳐 있다(재사용율 `ConnectionCostCard.reusePct`는 CSS width 입력이라 제외 — §3.3/§7).

- **목표**: (A) 깨진 YAML 상태에서 구조적 편집을 차단(store 가드=correctness·phantom-select 없음)하고 주요 어포던스를 시각 비활성화(발견성). (B) nonzero 비율이 표시 최소값(0.1%) 미만이면 "<0.1%"로 정직하게 표기 — 5개 동일-클래스 **표시** 지점 일괄(layout-입력 reusePct 제외).
- **비목표(연기)**: §7 참조. 전면 read-only·Save/Create 게이트·k8s reaper·legacy 테스트 통일.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | `MUST` `yamlError !== null`이면 어떤 구조적 편집도 상태(`model`/`doc`/`yamlText`/`yamlError`/`pendingYamlText`/`selectedStepId`)를 변이하지 않는다 — `dispatch`(316)·`reparentStep`(230)·`removeStep`(224) 진입 가드 + id-반환 add 액션 9종은 `null` 반환(호출부 `select(null)`=clean·phantom-select 없음) | RTL: yamlError 설정 후 `setName`/`moveStep`/`setStepField`/`removeStep`/`reparentStep`/`addStep`·`addLoopStep`·… 호출 → 6필드 불변 + add 반환 `null` 단언 + teeth(가드 제거 시 FAIL) | |
| R2 | `MUST` ScenarioEditPage 연필 rename 버튼은 `editorYamlError !== null`이면 비활성(`nameEditable`에 `&& editorYamlError === null`) | RTL(`ScenarioEditPage.name.test.tsx`): yamlError 상태 연필 `disabled`·기존 `renameDisabledTitle`(YAML 오류 문구) 노출 | |
| R3 | `MUST` FlowOutline 행 드래그는 `yamlError !== null`이면 비활성(`useSortable({disabled})` + 핸들 native `disabled`) | RTL(`FlowOutline.test.tsx`): editLocked 시 핸들 `disabled` + 라이브 held-drag 무이동 | ✅(held-drag) |
| R4 | `SHOULD` ValidationBanner는 `yamlError !== null`일 때 "편집 차단" 안내 한 줄 렌더(`ko.editor.editBlockedWhileInvalid` 신규 키) | RTL(`ValidationBanner.test.tsx`): yamlError 시 문구 존재 / yamlError 없이(step 문제만)면 부재 | |
| R5 | `MUST` 공유 `floorPct(pct)`(0–100): `pct > 0 && pct < 0.05`면 `"<0.1%"`, 아니면 `${pct.toFixed(1)}%` — nonzero가 표시 최소값 미만이면 floor | 단위(`format.test.ts`): `floorPct(0)="0.0%"`·`floorPct(0.03)="<0.1%"`·`floorPct(0.1)="0.1%"`·`floorPct(50)="50.0%"` + teeth | |
| R6 | `MUST` 동일-클래스 비율 **표시** 5지점이 `floorPct` 경유 — 에러율 2(`ReportHeadline`·`WorkerBreakdownTable`)는 `formatErrPct(errors,count)`=`count===0?"—":floorPct(errors/count*100)`, 나머지 3(`InsightPanel.pctStr`·`InsightCompareMatrix.repNumber`·`Summary.dropPct`)는 `floorPct(x*100)` | 컴포넌트: 각 지점 tiny-nonzero fixture → "<0.1%" 렌더 | |
| R7 | `MUST` 엔진/controller/proto/migration/worker/Zod 스키마(`schemas.ts`·`scenario/model.ts`)·`yamlDoc.ts`·`reorder.ts`·`dropRules`·`verdictFormat.ts`·`report/ConnectionCostCard.tsx`(reusePct=layout 입력, §7) 0-diff (와이어·파싱 무변경) | `git diff --stat`이 위 경로 미포함 | |
| R8 | `MUST` `yamlError === null`(정상 상태) 편집·비율(≥0.1%) 렌더는 R1~R6 전과 byte-identical(기존 편집·드래그·연필·리포트 무변화·add 정상 id 반환·`disabled` false 시 DOM 무속성) | 기존 store/FlowOutline/ScenarioEditPage/report 테스트 전량 green(무수정) + 정상값 렌더 불변 | |

- **seam 없음(계약)**: 어떤 R도 UI Zod↔serde / proto / migration / CSV·XLSX 경계를 건드리지 않는다(R7 명문화). B는 클라 렌더 파생, A는 클라 store/UI 게이트뿐. R3의 `✅`는 라이브 검증 필요 표식(계약 seam 아님).

---

## 3. 핵심 통찰 (설계 근거)

1. **store가 "일괄" 지점** — R1: 연필만 패치하면(finding 리터럴) 아웃라인 드래그·인스펙터 필드·add/reparent가 같은 버그를 그대로 갖는다(리뷰의 "아웃라인/인스펙터 전 편집이 같은 클래스"). 거의 모든 구조적 편집은 `dispatch`를 지나고(setName/moveStep/setStepField/setStepAssert/setStepExtract/setVariable/set*Cond/add*/branch/…), 예외는 트랜잭셔널 `reparentStep`·selection 부작용 있는 `removeStep`·id-반환 add 액션의 호출부 `select`뿐 → 이 몇 지점의 진입 가드가 전 편집을 no-op으로 덮는다(형제 `addStepExtract` 259-263 패턴의 일반화). id-반환 add가 `null`을 돌려주면 `select(null)`(select는 이미 `string|null` 허용, store.ts:75)로 clean 해제되어 phantom 스텝을 안 가리킨다(Inspector:64 self-heal에 의존하지 않는 결정적 봉쇄). R2/R3/R4의 UI 비활성화는 correctness가 아니라 **발견성**.
2. **차단이 버리기보다 안전** — 사용자 결정(편집 차단): `pendingYamlText`는 사용자의 작성중 YAML을 담으므로 `clearPendingYaml`로 조용히 버리면 데이터 손실. 차단하면 사용자는 **YAML 모달에서 해소**(고치거나 지우고 다시 씀) — 데드엔드 없음. 정상 상태 무영향(R8).
3. **`floorPct`는 제네릭 primitive, 부분 적용은 불일치를 낳는다** — R5/R6: nonzero인데 "0.0%"가 되는 건 에러율뿐 아니라 임의 비율에서 오해를 부른다. `pct>0`(계산된 pct 기준) 조건으로 표시 텍스트 어디에나 안전 적용. **부분 적용 금지**: `InsightCompareMatrix.repNumber`(비교뷰)는 `InsightPanel.pctStr`(단일-run·in-scope)의 문자 미러라, 하나만 고치면 같은 run에서 단일-run "<0.1%" vs 비교뷰 "0.0%" 불일치(이 코드베이스가 명시적으로 막는 클래스). `Summary.dropPct`(드롭율)도 동일 `.toFixed(1)` 패턴이므로 포함. **예외 `ConnectionCostCard.reusePct`(제외)**: r2 리뷰가 그 값이 표시 텍스트(:28)이자 progress-bar `style.width`(:30) 입력임을 발견 — floor하면 floor 케이스에서 `width:"<0.1%"`=invalid CSS로 막대가 깨진다. 재사용율은 higher-better 지표(0% 재사용=정상·비-오해, 에러/드롭처럼 "숨겨진 나쁜 값"이 아님)라 floor 이득도 미미 → 0-diff 유지(split[numeric width + floored text]도 가능하나 이득 대비 특수케이스 과다). `verdictFormat`은 `.toFixed(2)`라 0.05%는 정상 표시(다른 임계값·극소 <0.005%만 floor 대상이나 이번 스코프 밖)·`Summary`의 *에러 카드*(`summary.errors`)는 raw count라 무관(R7).

---

## 4. 변경 상세 (파일별)

### 4.1 `ui/src/scenario/store.ts` — 충족 R: `R1, R8`
- `dispatch(set, get, edit)`(316): 함수 최상단(현 `const doc = get().doc; if (!doc) return;` 인근, **`applyEdit` 이전**)에 `if (get().yamlError !== null) return;`. (`applyEdit`이 doc을 in-place 변이하므로 반드시 그 앞.)
- `reparentStep`(230): `if (!doc) return;` 뒤에 `if (get().yamlError !== null) return;`(트랜잭셔널 경로라 dispatch 미경유).
- `removeStep`(224): 함수 최상단(selection clear **이전**)에 `if (get().yamlError !== null) return;`(locked 삭제가 selection을 비우지 않게 — 정상 상태는 byte-identical).
- **id-반환 add 액션 9종**(`addStep`·`addLoopStep`·`addStepInLoop`·`addIfStep`·`addStepInBranch`·`addLoopInBranch`·`addIfInLoop`·`addParallelStep`·`addStepInParallelBranch`): 반환 타입 `string | null`로 확장 + 최상단 `if (get().yamlError !== null) return null;`(id 생성 이전). 호출부 무변경(`select`는 `string|null` 허용 → `select(null)` clean 해제).
- 비-id add(`addBranch`·`addElif`)·`removeBranch`·`removeElif`·`setLoopRepeat` 등 dispatch-only 액션은 dispatch 가드로 이미 no-op(추가 변경 불요).
- **`insertTemplateSteps`(275)는 10번째 id-반환 액션이나 store `null`-반환 대상 아님** — dispatch 가드로 model은 no-op이되 여전히 `prepared.firstId`를 반환해 호출부가 `select`하면 phantom이 될 수 있다. 그러나 삽입 버튼은 외부 `tplReady` 게이트(ScenarioEditPage:38·ScenarioNewPage:31, 둘 다 `editorYamlError === null`)로 locked 시 비활성 → 도달 불가. 즉 이 경로의 phantom-select 봉쇄는 **UI `tplReady` 게이트**가 담당(store null-반환이 아님) — R1의 "phantom-select 없음"이 이 액션에도 성립.
- `pendingYamlText`/`commitPendingYaml`/`clearPendingYaml`/`addStepExtract`/복구경로(`loadFromString`/`select`) 세만틱 무변경.

### 4.2 `ui/src/pages/ScenarioEditPage.tsx` — 충족 R: `R2`
- `nameEditable = seeded && editorModel !== null` → `&& editorYamlError === null` 추가(72). `editorYamlError` 이미 셀렉트됨(37). 연필 `disabled`/`title` 분기 재사용 — 기존 `ko.editor.renameDisabledTitle`(ko.ts:594, "YAML 파싱 오류를 먼저 해결…")이 그대로 맞음 → **신규 ko 키 불요**.

### 4.3 `ui/src/components/scenario/FlowOutline.tsx` — 충족 R: `R3, R8`
- 루트 `FlowOutline`(482)이 `const editLocked = useScenarioEditor((s) => s.yamlError) !== null` 셀렉트 → `OutlineRow`로 전달(기존 `drag`/`view` prop 재귀 확장).
- `OutlineRow`의 `useSortable({ ..., disabled: editLocked })`(270) + 드래그 핸들 `<button>`(314)에 **native `disabled={editLocked}`**(false면 React가 속성 자체를 omit=byte-identical, R8). `aria-disabled` 추가 금지(native disabled로 충분·`aria-disabled="false"` 직렬화 방지). `renderGroup`/`SortableContext`/`OutlineRowPreview`(드래그 중에만 렌더=locked 시 도달불가) 무변경.

### 4.4 `ui/src/components/scenario/ValidationBanner.tsx` + `ui/src/i18n/ko.ts` — 충족 R: `R4`
- `yamlError !== null`일 때 배너에 `<p>{ko.editor.editBlockedWhileInvalid}</p>` 한 줄(기존 `problemGateIntro`(:37) 인근). Callout variant/`role="status"`/기존 문제 목록 무변경(ADR-0043).
- `ko.editor.editBlockedWhileInvalid` 신규 키(예: "YAML 오류를 고칠 때까지 아웃라인·인스펙터 편집이 차단됩니다."). `ko.editor` 네임스페이스 존재·충돌 없음.

### 4.5 `ui/src/components/report/format.ts` — 충족 R: `R5, R6`
- `export function floorPct(pct: number): string { if (pct > 0 && pct < 0.05) return "<0.1%"; return `${pct.toFixed(1)}%`; }` 신규.
- `export function formatErrPct(errors: number, count: number): string { return count === 0 ? "—" : floorPct((errors / count) * 100); }` 신규.

### 4.6 비율 표시 5지점 적용 (6 검토·1 제외) — 충족 R: `R6`
- `report/ReportHeadline.tsx:17`: `errPct: summary.count === 0 ? "0%" : floorPct((summary.errors / summary.count) * 100)`(count===0 분기는 헤드라인이 `headlineNoRequests` 문장을 쓰므로 dead — 형식만 유지) — 또는 `formatErrPct(...)`(count===0→"—", 역시 dead).
- `report/WorkerBreakdownTable.tsx:42`: `{formatErrPct(w.errors, w.count)}`.
- `report/InsightPanel.tsx:17` `pctStr(v)`: `v === undefined ? "" : floorPct(v * 100)`.
- `compare/InsightCompareMatrix.tsx:28` `repNumber` pct 분기: `if (i.pct != null) return floorPct(i.pct * 100);`.
- `report/Summary.tsx:26,31`: `dropPct`는 표시 텍스트 전용(width 입력 아님) → 템플릿 `(${dropPct}%)`를 `(${floorPct(dropRate * 100)})`로(floorPct가 `%` 포함 → 리터럴 `%` 제거).
- `report/ConnectionCostCard.tsx`: **미변경**(§3.3/§7 제외 — reusePct는 `style.width` 입력이라 floor 시 막대 깨짐·higher-better 지표).

> **주의(구현)**: `floorPct`가 이미 `%`(또는 `<0.1%`)를 반환하므로, `${x}%`로 `%`를 직접 붙이던 호출부는 **리터럴 `%`를 제거**해야 이중 `%`가 안 생긴다. `Summary.dropPct`(:31 `(${dropPct}%)`→`(${floorPct(...)})`)만 해당 — `InsightCompareMatrix`는 `%`가 `repNumber` 반환 *안쪽*이라 소비처(:118)에 리터럴 `%` 없음=clean swap(byte-identical), `InsightPanel.pctStr`도 반환 안쪽.

---

## 5. 무변경 / 불변식 (명시)

- **엔진/controller/proto/migration/worker**: 0-diff(R7). cargo-영향 커밋 없음.
- **Zod 스키마**(`api/schemas.ts`·`scenario/model.ts`)·**yamlDoc.ts**·**reorder.ts**·**dropRules**: 0-diff(R7) — 편집 *결과* 형태 불변, 가드는 편집 *발동*만 막는다.
- **`verdictFormat.ts`**: 0-diff(R7) — `.toFixed(2)`로 0.05%를 정상 표시(다른 임계값). 극소(<0.005%) floor는 별개 클래스로 이번 스코프 밖.
- **`Summary`의 에러 카드**(`summary.errors` raw count, :14): 0-diff. (드롭율 `dropPct` :26만 R6 대상 — 혼동 주의.)
- **`ConnectionCostCard.reusePct`**: 0-diff(§3.3/§7 제외 — `style.width` 입력·higher-better 지표).
- **Save/Create 버튼**(ScenarioEditPage·ScenarioNewPage): 0-diff(§7 연기). Edit save는 last-good `yamlText` 전송이라 깨진 버퍼 무관·비손상.
- **FlowOutline add-bar / Inspector 구조 버튼 시각 상태**: 0-diff(§7) — store 가드가 no-op·add→null(phantom 없음)로 correctness를 보장하므로 개별 `disabled` 배선은 안 한다(배너가 발견성 커버).
- **정상 상태(`yamlError===null`) 거동**: byte-identical(R8) — 편집/드래그/연필/리포트(비율≥0.1%)·add 정상 id·`disabled` false DOM 무속성.
- `floorPct`가 정상값(pct≥0.05)을 받으면 `${pct.toFixed(1)}%` 그대로 → 기존 출력 불변.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `store.test.ts`(신규): yamlError 설정 → dispatch류·removeStep·reparentStep 상태 불변 + id-반환 add 9종 `null` 반환 + teeth(가드 제거→FAIL) | |
| R2 | `ScenarioEditPage.name.test.tsx`: yamlError 상태 연필 `disabled`·`renameDisabledTitle` 노출 | |
| R3 | `FlowOutline.test.tsx`: editLocked 시 핸들 `disabled`/useSortable disabled | ✅(held-drag 무이동) |
| R4 | `ValidationBanner.test.tsx`: yamlError 시 편집차단 문구 존재 / step-문제-only면 부재 | |
| R5 | `format.test.ts`(신규): `floorPct`/`formatErrPct` 경계값 + teeth | |
| R6 | `ReportHeadline`/`WorkerBreakdownTable`/`InsightPanel`/`InsightCompareMatrix`/`Summary`(dropPct) 테스트: tiny-nonzero fixture → "<0.1%" | |
| R7 | `git diff --stat` = `ui/src`(+ docs)만·위 0-diff 경로 부재 | |
| R8 | 기존 store/FlowOutline/ScenarioEditPage/report/compare 테스트 전량 green(무수정) + 정상 비율 렌더 불변 | |

- **B는 결정적**: `floorPct` 단위 + 컴포넌트 fixture로 닫는다 — 극소 비율을 라이브 run으로 재현할 필요 없음(단위가 권위).
- **A는 라이브 Playwright**(순수 UI·백엔드 불필요, `/scenarios/new` 클라-only 또는 저장 시나리오): 깨진 YAML 주입(모달 단일-토큰 편집으로 파스 깨기) → ① 연필 `disabled` ② 드래그 핸들 무이동(held-drag `getBoundingClientRect` 델타 0) ③ 배너 편집차단 문구 ④ 인스펙터 필드 편집 후 no-op(모델 불변) 실측. [[implementation-rigor-over-spec]] #5 — editor disable 상태는 DOM-존재만으로 PASS 금지(`disabled`/드래그 델타 실측).
- **정식 라이브 스택 불필요**(run-생성/report-파싱/엔진 경로 무변경) — Playwright는 UI 전용 dev 서버로 충분. `/live-verify` 미사용(근거 build-log에).

---

## 7. 의도적 연기 (roadmap §B12/§B13에 누적)

- **전면 read-only**(인스펙터 모든 구조 버튼/입력·FlowOutline add-bar 시각 disabled): store 가드가 correctness(no-op·phantom 없음)를, 연필/드래그/배너가 발견성을 커버하므로 개별 `disabled` 배선(표면·회귀 위험)은 미룬다. locked add-bar/Inspector-add는 clean no-op(add→null→`select(null)`) — 시각 표식만 없음.
- **선택 유지 비대칭(수용)**: locked `removeStep`은 selection 유지(진입 return), locked add는 selection을 `null`로 해제(`select(null)`) — 둘 다 "구조 무변화·phantom 없음"이라 무해한 minor 비대칭.
- **Save/Create 버튼 yamlError 게이트**: 제출 클래스(서버 검증·비손상)라 이번 구조적-편집 수정과 별개.
- **`ConnectionCostCard.reusePct` floor 제외(수용)**: reusePct는 표시 텍스트이자 progress-bar `style.width`(:30) 입력이라 floor 시 invalid CSS로 막대가 깨지고, 재사용율은 higher-better(0.0%=정상·비-오해)라 floor 이득 미미. split(numeric width + floored text)도 가능하나 이득 대비 특수케이스 과다 → 0-diff 유지. 필요 시 후속.
- **`verdictFormat` 극소(<0.005%) floor**: `.toFixed(2)`라 실사용 영향 미미, 별개.
- **G2 k8s register-전 reaper**(C)·**legacy EditPage StrictMode 통일**(D): macOS 검증 불가/사용자 무영향 — 별도.

---

## 8. 구현 순서 (plan 입력)

UI-only·cargo 무영향이라 각 task는 test-먼저(tdd-guard: RED 테스트 pending 후 src) → green fold 커밋. 제안 task 분할:

1. **store 가드 (R1, R8)** — `dispatch`+`reparentStep`+`removeStep` 진입 가드 + id-반환 add 9종 `null` 반환 + `store.test.ts` no-op/null 케이스(teeth). A의 correctness 코어·독립.
2. **`floorPct`/`formatErrPct` + 5지점 적용 (R5, R6)** — `format.ts` 헬퍼 + `format.test.ts` + 5 컴포넌트 배선·테스트(`Summary.dropPct` `%` 이중부착 확인). B 전체(순수·격리).
3. **연필 게이트 (R2)** — ScenarioEditPage `nameEditable` + `.name.test.tsx`.
4. **FlowOutline 드래그 비활성 (R3)** — editLocked 배선(native disabled) + 테스트.
5. **ValidationBanner 편집차단 문구 (R4)** — ko 키 + 배너 한 줄 + 테스트.
6. **최종 게이트** — `pnpm lint && pnpm test && pnpm build` 전량 + R7 `git diff --stat` + 라이브 Playwright(A).

(1·3·4·5는 A, 2는 B — 1 먼저(코어), 나머지 독립. 소슬라이스라 3–5를 한두 task로 묶어도 무방.)
