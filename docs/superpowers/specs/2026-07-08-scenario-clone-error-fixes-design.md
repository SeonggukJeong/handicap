# 시나리오 복제 에러 처리 정리 — unhandled rejection 제거 + 하드코딩 문자열 ko.ts 이주 (roadmap §B12 사전 존재 버그 2건)

- **날짜**: 2026-07-08
- **상태**: 설계 승인(spec-plan-reviewer clean APPROVE, 2026-07-08, 2라운드) → plan 대기
- **출처**: `docs/roadmap.md` §B12 "pre-existing 버그 2건"(design-system-editor 라이브/리뷰 발견, 해당 슬라이스는 무접촉으로 연기). 사용자가 사용량 제한 때문에 아주 작은 슬라이스를 요청(2026-07-08) → 후보 3개 중 이 항목 선택.
- **연관**: `docs/superpowers/specs/2026-07-03-design-system-editor-design.md`(버그 최초 발견처, 무접촉), ADR-0035(ko.ts 단일 카탈로그).
- **ADR**: 신규 불필요 — ADR-0035 범위 내(문구 카탈로그 이주) + 순수 버그 수정. 계약/와이어 무변경.

---

## 1. 문제와 목표

`ScenarioEditPage.tsx`의 `cloneAndGo`는 세 호출부(`onCloneClick`의 non-dirty 즉시경로, 확인 모달 "저장 없이 복제", save-failed 모달 "저장본으로 복제")에서 전부 `void cloneAndGo(...)`로 fire-and-forget 호출된다. `clone.mutateAsync`가 reject하면 이 세 경로 중 어느 것도 catch하지 않아 unhandled promise rejection이 발생한다 — 이미 `ScenarioEditPage.clone.test.tsx:174-176`에 이 문제를 우회하는 주석이 박혀 있다("즉시-복제 경로는 void cloneAndGo(...)라 실패 시 미흡수 rejection이 남는다"). Vitest는 unhandled rejection을 "Unhandled Errors"로 잡아 개별 테스트는 green이어도 전체 실행을 실패 처리한다(실측 확인 — 아래 §6). 프로덕션에서도 브라우저 콘솔에 uncaught rejection이 남는다.

별도로, "복제 실패: {msg}" 에러 문구가 `ScenarioEditPage.tsx:239`와 `ScenarioListPage.tsx:60` 두 곳에 하드코딩돼 있어 ADR-0035(ko.ts 단일 카탈로그)를 위반한다 — 동형 패턴인 `ko.pages.deleteFailed: (msg) => \`삭제 실패: ${msg}\`` 함수 키가 이미 존재한다.

- **목표**: ① `cloneAndGo`의 모든 호출 경로가 실패해도 unhandled rejection을 만들지 않는다. ② 두 파일의 하드코딩 문자열을 `ko.pages.cloneFailed(msg)` 함수 키로 통합.
- **비목표(연기)**: 없음 — §7 참조(둘 다 이번 슬라이스로 완결, 파생 관찰 1건만 기록).

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `cloneAndGo`가 `clone.mutateAsync` 실패 시에도 호출자에게 rejection을 전파하지 않는다(3개 `void`-호출 경로 전부: 즉시경로·저장 없이 복제·저장본으로 복제) | 신규 테스트(not-dirty 경로 + `cloneShouldFail=true`)가 alert 렌더를 확인하고, `pnpm test ScenarioEditPage.clone` 실행이 "Unhandled Errors"/"Unhandled Rejection" 섹션 없이 exit 0 | |
| R2 | MUST 실패 시 기존 `clone.error` 기반 Callout(`role=alert`, `rounded-md`/`bg-red-50`)이 계속 렌더되고, 그 순간 열려 있던 복제 관련 모달(확인 다이얼로그·저장실패 다이얼로그)은 닫힌다 — `Modal`이 `fixed inset-0 z-50 bg-black/40` 풀스크린 backdrop(`Modal.tsx:66`)이라 모달이 열린 채로는 페이지-레벨 Callout이 그 뒤에 가려지기 때문 | 기존 "복제 실패 시 오류 Callout" 테스트 green 유지 + 그 시점에 `queryByRole("dialog")`가 null(모달 닫힘) 신규 단언 | |
| R3 | MUST `ScenarioEditPage.tsx`·`ScenarioListPage.tsx` 두 곳의 하드코딩 `"복제 실패: "` 리터럴을 `ko.pages.cloneFailed(msg)` 함수 키로 교체(`ko.pages.deleteFailed`와 동형 시그니처) | `grep '복제 실패' ui/src/pages/*.tsx` 가 두 컴포넌트 파일에서 0매치(정의는 `ko.ts`에만) | |
| R4 | MUST(불변식) 사용자에게 보이는 문구는 정확히 `"복제 실패: {msg}"`로 byte-identical 유지 | 기존/신규 텍스트 단언(`toHaveTextContent`류)이 그대로 통과 | |
| R5 | SHOULD "저장 후 복제" 흐름에서 저장은 성공하고 그 다음 clone만 실패하면, "저장 실패" 모달은 열리지 않고(R1 구현의 자연스러운 부작용) 대신 확인 모달이 닫히며 페이지-레벨 `clone.error` Callout만 남는다(R2가 요구하는 모달-닫힘의 이 경로 한정 표현 — 새 UI 아님) | 기존 "복제 실패 시 오류 Callout" 테스트에 save-failed 모달 텍스트(`/저장에 실패했습니다/`) 부재 단언을 추가(모달 자체 닫힘은 R2 단언이 커버) | |

- `seam?` 해당 없음 — UI 내부 에러 핸들링 + 문구 카탈로그 이주, 계약 경계(Zod↔serde/proto/migration) 무접촉.

---

## 3. 핵심 통찰 (설계 근거)

1. React Query의 `useMutation`은 `mutateAsync`가 반환하는 promise를 호출자가 catch하든 안 하든 내부 `error`/`isError` 상태를 mutationFn 실행 자체로 독립 갱신한다(`onError`/`settled` 콜백이 그 실행을 구동) — 그래서 `cloneAndGo` 내부에서 실패를 삼켜도 R2(기존 Callout)는 깨지지 않는다. 이 사실이 이 fix를 안전하게 만드는 핵심 전제.
2. 세 호출부 각각에 개별 try/catch를 붙이는 대신 `cloneAndGo` 자체에 **단일** try/catch를 둔다 — 세 호출부 모두와 `saveThenClone`(이미 자체 try/catch로 이 문제를 우회 중이던 네 번째 경로)까지 한 지점에서 커버되어 DRY하고, 향후 새 호출부가 추가돼도 자동으로 보호된다.
3. R5는 새 요구사항이 아니라 R1을 구현하는 유일한 정직한 방법(= `cloneAndGo`가 더 이상 throw하지 않음)에서 자연히 파생된다. 부작용으로 `saveThenClone`의 `catch`는 이제 순수하게 `update.mutateAsync` 실패만 잡게 되어, 기존에 존재했던 "clone 실패를 save 실패로 오분류"하는 잠재적 혼동(저장은 성공했는데 "저장에 실패했습니다" 모달이 뜨는 케이스)이 부수적으로 해소된다. 이건 별도로 설계한 UX 변경이 아니므로 R5는 SHOULD로 관찰·회귀 가드만 추가하고 그 이상 손대지 않는다.
4. `cloneAndGo`가 단순히 실패를 삼키기만 하면 안 된다 — `Modal.tsx:66`의 `fixed inset-0 z-50 bg-black/40` 풀스크린 backdrop이 페이지-레벨 Callout(z-index 없음, 일반 document flow)을 시각적으로 가린다. "저장 없이 복제"·"저장본으로 복제" 두 경로는 클릭 시점에 모달이 열려 있으므로, `setCloneDialog(null)` 없이 catch만 하면 클릭해도 아무 반응이 없어 보이고 에러는 backdrop 뒤에 숨는다(§4.1의 fix가 이 dismiss를 포함해야 R2/R5의 "Callout이 보인다"는 전제가 모든 경로에서 실제로 성립한다).

---

## 4. 변경 상세

### 4.1 `ui/src/pages/ScenarioEditPage.tsx` — 충족 R: `R1, R2, R3, R4, R5`
- `cloneAndGo`(현재 L102-107)를 try/catch로 감싼다: `await clone.mutateAsync(...)` 성공 시엔 기존과 동일하게 `setCloneDialog(null)` + `navigate(...)`, **실패 시에도 `setCloneDialog(null)`을 호출**해 열려 있던 모달을 닫은 뒤 return(그 다음 렌더에서 `clone.error && <Callout>`가 화면에 노출됨 — 모달이 닫혀 있어야 z-50 backdrop에 가리지 않는다). non-dirty 즉시경로는 애초에 모달이 없으므로 `setCloneDialog(null)`이 no-op.
- L239의 하드코딩 `복제 실패: {(clone.error as Error).message}` → `{ko.pages.cloneFailed((clone.error as Error).message)}`.

### 4.2 `ui/src/pages/ScenarioListPage.tsx` — 충족 R: `R3, R4`
- L60의 하드코딩 `복제 실패: {(clone.error as Error).message}` → `{ko.pages.cloneFailed((clone.error as Error).message)}`.
- 이 파일의 `onClone`은 `clone.mutate(...)`(fire-and-forget, non-async 버전)를 쓴다 — `mutate()`는 내부적으로 반환 promise를 만들지 않으므로 R1(unhandled rejection) 대상이 아니다. 문구 이주만 해당.

### 4.3 `ui/src/i18n/ko.ts` — 충족 R: `R3, R4`
- `ko.pages`에 `cloneFailed: (msg: string) => \`복제 실패: ${msg}\`` 함수 키를 `deleteFailed`(L394) 인근에 추가.
- `ui/src/i18n/__tests__/ko.test.ts`의 키 목록(존재한다면)에 `cloneFailed` 추가.

---

## 5. 무변경 / 불변식 (명시)

- 성공 경로(clone 성공 시 dialog 닫힘 + navigate)는 무변경.
- "복제" 확인 다이얼로그·"저장 실패" 다이얼로그(= `update.mutateAsync` 자체가 실패하는 케이스, `putShould409` 테스트)의 문구·트리거 조건은 무변경 — R5는 "save 성공 + clone 실패"라는 *다른* 케이스에서 save-failed 모달이 더 이상 열리지 않는다는 것만 다룬다.
- 엔진/컨트롤러/proto/migration 무접촉, 와이어 무변경.
- `ko.ts`의 다른 카탈로그 키(`deleteFailed` 등) 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `ScenarioEditPage.clone.test.tsx` 신규 케이스(not-dirty 경로 + `cloneShouldFail=true`) — fix 전 RED 실측: 동일 시나리오를 즉시경로로 재현하면 `pnpm test`가 "Unhandled Rejection" 섹션과 함께 비-zero exit(개별 assertion은 green이어도 실행 실패) — fix 후 GREEN(에러 섹션 없음). 테스트는 `await screen.findByRole("alert")`로 뮤테이션 settle까지 기다린 뒤 종료해야 rejection이 테스트 밖으로 새서 다른 파일에 오귀속되지 않는다 | |
| R2 | 기존 "복제 실패 시 오류 Callout(alert, 구체 클래스: rounded-md/bg-red-50)" 테스트 green 유지 + 그 시점 `screen.queryByRole("dialog")`가 null(열려 있던 확인 모달이 닫혔는지) 신규 단언 | |
| R3 | `grep '복제 실패' ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioListPage.tsx` 0매치 + `ko.ts`에 정의 1곳 | |
| R4 | 기존/신규 텍스트 단언(`"복제 실패: clone failed"` 등 정확 문자열) | |
| R5 | 기존 "복제 실패 시 오류 Callout" 테스트(dirty→저장 후 복제, `cloneShouldFail=true`)에 `screen.queryByText(/저장에 실패했습니다/)`가 null임을 추가 단언(모달 자체가 닫혔는지는 R2의 `queryByRole("dialog")` 단언이 같은 테스트에서 커버) | |

- 라이브 검증: **불필요**. run-생성/report-파싱/엔진 경로 무접촉(순수 UI 에러 핸들링 + 문구 카탈로그 이주) — 루트 CLAUDE.md 슬라이스 파이프라인 §5의 라이브-필수 트리거(run 생성·리포트 파싱·엔진 경로)에 해당하지 않음. 근거를 build-log에 기록.

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- `saveThenClone`의 "저장 실패" 모달 문구 자체가 애초에 clone 실패 사유까지 뭉뚱그려 보여주던 기존 UX(이번 R5로 그 케이스 자체가 사라짐)를 더 다듬는 것(예: save-failed 모달에 "clone도 실패했다면" 안내 추가)은 이번 스코프 밖 — 이번엔 버그 2건 제거만, 새 UX 설계 아님.

---

## 8. 구현 순서 (plan 입력)

> **순서 주의**: `ui/CLAUDE.md`의 `tdd-guard`는 watched production(`ui/src/**` non-test) 파일 편집 전에 pending(modified/untracked) test-path 파일을 요구한다 — 아래 순서는 테스트 파일 편집을 최우선으로 둬서 이 가드에 막히지 않게 한다.

1. 테스트 먼저(RED): `ScenarioEditPage.clone.test.tsx`에 R1/R2/R5 신규 케이스·단언 추가(문구 자체는 R4 불변식으로 바뀌지 않으므로 `ko.ts` 변경 전에 최종 문구 기준으로 작성 가능).
2. `ui/src/i18n/ko.ts`에 `cloneFailed` 키 추가(+ 존재하면 `ko.test.ts` 키 목록 갱신).
3. `ScenarioEditPage.tsx`: `cloneAndGo` try/catch(성공·실패 양쪽 `setCloneDialog(null)`) + 문구를 `ko.pages.cloneFailed`로 교체.
4. `ScenarioListPage.tsx`: 문구를 `ko.pages.cloneFailed`로 교체.
5. `pnpm lint && pnpm test && pnpm build` 전체 게이트 + `grep '복제 실패' ui/src/pages/*.tsx` 잔존 확인 → 단일 커밋.
