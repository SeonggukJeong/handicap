# skip/todo UI 테스트 분류·정리 — 설계 (2026-06-12)

> roadmap §B5 잔여 항목. 출처: codex load-tester 평가(2026-06-02) "skip/todo UI 테스트 분류·정리".

## 1. 배경·현황

- §B5 기록 시점(2026-06-03) "todo 21 + skip 7"은 이후 슬라이스들이 일부 해소해, **2026-06-12 현재 ground truth = `it.todo` 18건(7파일), 실제 `.skip` 0건** (`pnpm test`: `753 passed | 18 todo (771)`. vitest 파일 라인의 "skipped"는 todo의 per-file 표기일 뿐).
- 18건 전부 과거 슬라이스(주로 Slice 2–4)의 tdd-guard pending stub이 그대로 커밋된 것. 이후 컴포넌트/API가 진화해 일부는 obsolete, 일부는 다른 테스트가 커버, 일부는 여전히 미커버.

## 2. 목표·비목표

**목표**: 스위트의 `it.todo`를 **0건**으로. 각 todo를 ① 살아있고 미커버 → 실제 테스트로 구현, ② obsolete/중복 커버 → 근거와 함께 삭제, 둘 중 하나로 처분한다.

**버그 정책(사용자 결정)**: 테스트 구현 중 드러나는 production 버그가 국소적(함수 1–2개)이면 같은 슬라이스에서 test-first로 수정, 크면 roadmap 연기 항목으로 기록만.

**비목표**: 신규 기능 테스트 추가(처분 매트릭스 밖), 테스트 인프라 개편, E2E/Playwright 추가, `pnpm test` 외 스위트(cargo) 변경. **UI-only — 엔진·워커·proto·controller·migration 무변경**(production 코드는 버그 정책 발동 시에만).

## 3. 접근 (사용자 확정: A안 "처분+정착")

죽은 파일은 삭제하고, 다시 쓰는 테스트는 canonical 파일로 합친다(in-place 최소 diff 기각 — 빈 껍데기 파일·역사적 파일명이 남음).

## 4. 처분 매트릭스 (18건 = 삭제 8 + 구현 10)

### 4.1 삭제 8건

| 대상 | 근거 |
|---|---|
| `src/__tests__/flowVars.test.ts` **파일 삭제** (todo 2) | 변수 추출(extract)은 엔진(Rust `template`/`extract` 테스트) 책임. UI에 추출 코드 없음(스캔은 `scanVars.ts`가 별도 담당·별도 테스트). |
| `src/__tests__/useRunReport.test.ts` **파일 삭제** (todo 3) | 파일 주석 스스로 "full coverage comes from RunDetailPage page test"라 명시했고 실현됨 — `RunDetailPage.test.tsx`가 running 중 `/report` 미fetch(=enabled 게이팅), terminal 시 ReportView 마운트, fetch 에러 alert를 커버. `staleTime: Infinity`·`queryKey`는 invalidation 소비처가 없는 구현 디테일. |
| `ScenarioPages.test.tsx`: "ScenarioNewPage renders EditorShell instead of textarea" (todo 1) | Slice 3에서 완료된 textarea→EditorShell 전환의 역사적 문구. `ScenarioNewPage.gallery.test.tsx`가 템플릿 선택 후 에디터 마운트를 커버. |
| `ScenarioPages.test.tsx`: "ScenarioNewPage Create button calls mutation with yamlText from EditorShell" (todo 1) | `ScenarioNewPage.gallery.test.tsx` "만들기를 누르면 선택한 템플릿 YAML로 POST /api/scenarios"가 커버. **삭제 전 확인 의무**: 그 테스트가 POST **body**(yaml 내용)를 단언하는지 확인, 안 하면 보강 후 삭제. |
| `ScenarioPages.test.tsx`: "ScenarioEditPage renders EditorShell initialized with scenario yaml" (todo 1) | `ScenarioEditPage.testrun.test.tsx`가 "버퍼 POST에 시나리오 yaml 포함"을 단언 — 에디터가 GET yaml로 초기화됨의 간접 증명. |

### 4.2 구현 10건

| # | 테스트 | 위치 | 핵심 단언 |
|---|---|---|---|
| 1–2 | TabBar | `TabBar.test.tsx` 제자리 | 두 탭 라벨 렌더 + active 탭 스타일 구분(예: `aria-selected`/클래스), inactive 탭 클릭 → `onChange(tab)` 호출 |
| 3–4 | HttpStepNode | `HttpStepNode.test.tsx` 제자리 | step name + method+URL 텍스트 렌더; `data.selected: true`일 때 선택 스타일 적용. React Flow v12 `NodeProps<Node<Data,"...">>` 시그니처로 직접 마운트(필요 시 `ReactFlowProvider` 래핑) |
| 5–7 | EditorShell | `EditorShell.test.tsx` 제자리 (기존 Monaco mock·store reset 재사용) | ① mount 시 `initialYaml`이 store에 로드(`yamlText`·model 파생) ② **onChange 계약 특성화**: 첫 onChange는 로드된 initialYaml이 아니라 mount-렌더에 캡처된 *pre-load* store 텍스트(U3 B1 함정, `ui/CLAUDE.md` 문서화 동작) — baseline-seeding 패턴이 의존하는 동작을 핀 고정 ③ YAML 탭 활성 시 inspector 미렌더(U3 placeholder 테스트의 보완 — inspector region/aside 부재 직접 단언) |
| 8–9 | yamlDoc setStepField | **`yamlDoc.test.ts`로 fold** 후 `yamlDoc-comments.test.ts` 파일 삭제 | ① stale stepId(트리에 없는 id) → **silent no-op**(`findStepPath` null → return, doc 직렬화 불변) ② object 값 → `doc.createNode` wrap으로 AST well-formed round-trip, primitive는 native setIn (yamlDoc.ts `case "setStepField"` 주석의 의도적 설계 핀 고정). 원 todo의 `findStepIndex`는 현존하지 않는 API — 같은 *행동*을 현 API로 재작성 |
| 10 | EditPage 저장 payload | **`ScenarioEditPage.save.test.tsx` 신설** (기존 `.clone`/`.testrun` 파일 분할 컨벤션) | 풀페이지 마운트(scenario GET mock) → 에디터 변경(dirty) → 저장 버튼 클릭 → `PUT /api/scenarios/{id}` 요청 body가 `{yaml, version}`(낙관적 락 버전 포함)임을 직접 단언. §B5 "고위험 시나리오 에디터" 갭 해소 — 기존 clone 테스트는 PUT *발생*만 간접 확인, payload 형태는 미단언 |

처분 합계 검산: 삭제 8(flowVars 2 + useRunReport 3 + ScenarioPages 3) + 구현 10(TabBar 2 + HttpStepNode 2 + EditorShell 3 + yamlDoc 2 + Save→PUT 1) = 18. ✓

## 5. 게이트·함정 (이 코드베이스 기준)

- **게이트**: pre-commit hook은 ui-only 커밋에서 cargo를 skip하므로 **`pnpm lint && pnpm test && pnpm build` 수동 실행이 유일 게이트**. 머지 전 인자 없는 전체 `pnpm test` 1회로 "todo 0" 확인(targeted green ≠ full green).
- **tdd-guard**: 모든 편집이 test-path 파일(`*.test.tsx?`)이라 자동 통과. production 수정은 버그 정책 발동 시에만 — 그 경우 RED 테스트가 같은 커밋에 이미 있으므로 green 커밋 fold 규칙과 자연 정합.
- **컨벤션 재사용**: `userEvent.setup()` per-it, `useScenarioEditor.setState(getInitialState())` reset, EditorShell의 `vi.mock("../MonacoYamlView")` 컴포넌트 mock, 풀페이지 테스트의 fetch route-by-URL mock 패턴(`.testrun`/`.clone` 참고).
- **단일 파일 반복은 `pnpm test <name>`(`--` 금지)**.
- **라이브 검증 불필요**: 와이어/응답 파싱/run 생성 경로 무변경(S-D Playwright 룰 비해당).

## 6. 마무리(머지) 단계

- 게이트 green 확인 후 master ff-merge(워크트리 → `git -C` 메인 머지 레시피).
- roadmap §B5 해당 줄을 완료로 갱신(현황 수치 18→0 명시) + `docs/build-log.md` 한 단락 append.
- ADR 불필요(additive 테스트 위생 작업). 루트 CLAUDE.md 상태줄 교체는 1줄.
