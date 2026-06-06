# 시나리오 복제/포크 — 설계

- **상태**: 설계 (구현 대기)
- **날짜**: 2026-06-06
- **출처**: `docs/roadmap.md` §B2'(시나리오 복제 — "실험용 시나리오 포크", 영역 A 범위 밖 독립 기능). 사용자 요청(2026-06-06): 당시 진행 중이던 A2-2(그룹/페이지 레이턴시) 작업과 충돌 없는 작업으로 선정 — **그 사이 A2-2가 master에 머지(`98ee401`→`96f7936`)되어 worktree 충돌 우려는 해소**, 이 슬라이스는 현 master 위에서 진행(§9 참조).
- **성격**: **UI-only**. 백엔드·proto·migration·store·엔진·워커 **무변경**.

---

## 1. 배경 / 동기

QA가 잘 동작하는 시나리오를 기반으로 변형(헤더 추가, URL 변경, 부하 다르게)을 실험하려면 매번 처음부터 다시 만들어야 한다. 기존 시나리오를 **복제**해 출발점으로 삼고 싶다 — "실험용 포크".

현재 시나리오 모델·API:

- `scenarios` 테이블: `id`(ULID) · `name` · `yaml` · `version`(1부터) · `created_at` · `updated_at`.
- **`name`은 별도 컬럼/입력이 아니라 `yaml`의 `name:` 필드에서 파싱**된다(`scenarios::insert`가 `scenario.name`을 저장하지만 출처는 YAML). 따라서 "이름만 바꾼 복제"는 **YAML의 `name:`을 수정**하는 것이다.
- REST: `POST /api/scenarios {yaml}`(생성, YAML 파싱) · `GET /api/scenarios`(목록, 각 항목에 **`yaml` 포함**) · `GET /api/scenarios/{id}` · `PUT /api/scenarios/{id} {yaml, version}`(낙관적 락).
- **시나리오 삭제 엔드포인트 없음** → 복제로 생긴 고아 참조 걱정 없음. `name`에 **UNIQUE 제약 없음** → 동명 허용(단 목록에서 혼란).
- 목록 응답이 이미 `yaml`을 싣고 있어(`ScenarioSchema.yaml`) **목록 경로 복제는 추가 fetch가 0**.
- UI: `ScenarioListPage`(Name/Version/Updated 테이블) · `ScenarioEditPage`(헤더 액션 Save/Runs + `EditorShell` + `TestRunSection`) · `ScenarioNewPage`.
- 재사용 가능한 접근성 모달 `ui/src/components/Modal.tsx`(test-run 본문 뷰어에서 도입) 존재.

## 2. 핵심 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | **즉시 복제(immediate duplicate)** — 클릭 한 번에 새 시나리오 생성 | 사용자 선택. "그냥 복사본 하나" 빠르게. |
| D2 | **순수 클라이언트** — 새 백엔드 없음 | 복제 = "YAML 복사 + 생성"이라 서버가 더할 게 없음(YAGNI). retry가 GET 재사용, A4b 하이브리드와 같은 "최소 표면" 기조. `yaml` Document API는 클라에만 있어 name munge도 클라가 깔끔. |
| D3 | **유일 `(copy)` 서픽스** 이름 | 동명 회피 → 목록에서 원본/복제 구분. UNIQUE 제약은 없으니 **best-effort 정돈**(실패해도 생성은 됨). |
| D4 | 목록 경로: 복제 후 **목록 유지 + 갱신** | 연속 복제·목록 작업 흐름. |
| D5 | 에디터 경로: 복제 후 **새 복제본 에디터로 이동** | 이미 에디터에 있는 사용자가 포크를 계속 작업하는 자연스러운 다음 스텝. |
| D6 | 진입점: **목록 행 + 에디터 헤더** 둘 다 | 사용자 선택. |
| D7 | 에디터 dirty 처리: **확인 다이얼로그**(저장 물어봄 → 저장 불가면 알리고 계속 물어봄) | 사용자 선택. 은밀한 자동저장도, 은밀한 무시도 아님 — 그 자리에서 결정. |

## 3. 범위 / 비범위

### 범위 (UI-only)

- `cloneName` 순수 함수(이름 dedup).
- `renameScenarioYaml` YAML Document API 헬퍼(`name:` 타겟 수정, 주석 보존).
- `useCloneScenario` 훅(munge + 기존 `createScenario` 재사용 + 목록 invalidate).
- `ScenarioListPage` 행 "복제" 액션.
- `ScenarioEditPage` 헤더 "복제" 버튼 + dirty 확인 다이얼로그.

### 비범위 / 연기

- 백엔드 clone 엔드포인트, proto, migration, store, 엔진, 워커 — **전부 무변경**.
- 이름 입력 프롬프트(자동 이름만).
- run 히스토리·프리셋·환경 복제(복제본은 **새 시나리오 id**라 scenario-scoped 리소스가 없는 게 정상 — 깨끗한 출발).
- 시나리오 **삭제** 기능(별개 슬라이스).
- 서버측 이름 UNIQUE 강제.

## 4. 이름 dedup 알고리즘 — `ui/src/scenario/cloneName.ts`

```
cloneName(sourceName: string, existingNames: string[]): string
```

1. **base 추출**: `sourceName`이 `^(.*) \(copy(?: (\d+))?\)$`에 매치하면 캡처한 base를 쓰고, 아니면 `sourceName` 전체가 base. (복제의 복제 시 `(copy) (copy)` 누적 방지 → `Foo (copy)` 복제는 `Foo (copy 2)`.)
2. **후보 생성**: `${base} (copy)` → 충돌 시 `${base} (copy 2)` → `(copy 3)` … 첫 빈 자리.
3. **충돌 판정**: `existingNames`(목록에 이미 로드된 scenarios의 `name`)와 **정확 일치**. 대소문자·공백 정규화 안 함(정확 비교).

| source | existing | 결과 |
|---|---|---|
| `Foo` | `[Foo]` | `Foo (copy)` |
| `Foo` | `[Foo, Foo (copy)]` | `Foo (copy 2)` |
| `Foo (copy)` | `[Foo, Foo (copy)]` | `Foo (copy 2)` |
| `Foo (copy 2)` | `[Foo, Foo (copy), Foo (copy 2)]` | `Foo (copy 3)` |
| `Bar` | `[Foo]` | `Bar (copy)` |

- 번호는 `(copy)`(N=1 암묵) → `(copy 2)` → … 1번엔 숫자 없음.
- **구현 주의("첫 빈 자리" 시맨틱)**: 후보 체인은 **항상 `(copy)`부터 위로 스캔** — 소스 이름에서 추출한 숫자로 `n`을 시드하지 말 것. 그래야 `cloneName("Foo (copy 2)", ["Foo (copy 2)"])` → `"Foo (copy)"`(base=`Foo`, 첫 빈 자리)처럼 중간 빈 슬롯이 있으면 더 **낮은** 번호도 채운다(규칙 일관, 단 직관에 반할 수 있음). 숫자 시드 방식이면 이 케이스가 깨진다.
- `existingNames`가 비었거나(에디터 경로에서 목록 미로딩) 부정확해도 **생성은 성공**(서버 UNIQUE 없음) — dedup은 정돈일 뿐. (에디터 경로는 §6.2의 게이팅으로 미로딩 시 버튼 disable.)

## 5. YAML 이름 수정 — `ui/src/scenario/yamlDoc.ts`에 추가

```
renameScenarioYaml(yamlText: string, newName: string): string
```

- `parseDocument(yamlText)` → `doc.setIn(["name"], plainScalar(newName))` → `String(doc)`.
- **이미 동일 패턴이 `yamlDoc.ts:97`에 존재**(`setName` edit 케이스가 `doc.setIn(["name"], plainScalar(edit.value))`) → `renameScenarioYaml`은 그 한 줄을 단일 진입 헬퍼로 감싼 것. `plainScalar()` 재사용 → **인용부호 상속 함정 회피**(`yaml` 패키지의 `setIn`은 기존 노드 quote style 상속 — CLAUDE.md 기록).
- **다른 키·주석 보존**(Document API targeted edit — 통째 교체 아님).
- `name:` 키가 없는 경우(이론상 없음 — 필수 필드)에도 `set`이 추가하므로 안전.
- 입력 YAML이 파싱 불가면 throw → 호출부가 잡아 에러 표시(소스는 저장된 유효 시나리오라 사실상 도달 불가).

## 6. 데이터 흐름 / 컴포넌트

### 6.0 공유 훅 — `useCloneScenario` (`ui/src/api/hooks.ts`)

```
const clone = useCloneScenario();
clone.mutateAsync({ sourceYaml, sourceName, existingNames }) → 생성된 Scenario
```

- 내부: `newName = cloneName(sourceName, existingNames)` → `newYaml = renameScenarioYaml(sourceYaml, newName)` → `api.createScenario(newYaml)`.
- `onSuccess`: **React Query v5 시그니처** `qc.invalidateQueries({ queryKey: queryKeys.scenarios() })`(목록 갱신) — bare `["scenarios"]` 리터럴 금지, 기존 `useCreateScenario`(`hooks.ts:47`)와 동일 형태. (v4의 `invalidateQueries(["scenarios"])`는 v5에서 안 먹음.)
- 반환값 = 생성된 `Scenario`(`id` 포함) — 에디터 경로가 navigate에 사용.
- `api.createScenario`는 이미 존재(`client.ts`). 신규 API 메서드 없음.

### 6.1 목록 경로 — `ScenarioListPage.tsx`

- 각 행 우측 셀에 "복제" 버튼(기존 "runs →" 링크와 같은 셀 그룹).
- 클릭: `existingNames = data.scenarios.map(s => s.name)` → `clone.mutateAsync({ sourceYaml: s.yaml, sourceName: s.name, existingNames })`.
- 성공: invalidate로 새 행 자동 등장(**화면 유지** = D4). navigate 없음.
- 실패: `role="alert"` 배너로 메시지. (소스가 유효해 사실상 안 나지만 방어.)
- 진행 중 행은 버튼 disable/“복제 중…” 표기(선택적, mutation `isPending`).

### 6.2 에디터 경로 — `ScenarioEditPage.tsx`

추가 상태:
- `const { data: scenarios } = useScenarios();`(React Query dedup — 목록과 공유) → `existingNames`.
- `cloneDialog` 상태: `null | { stage: "confirm" } | { stage: "save-failed", message: string }`.

헤더에 "복제" 버튼(Save/Runs 옆). 기존 페이지 신호:
- `dirty = originalYaml !== yamlText`(이미 계산됨).
- 페이지의 `yamlText`는 **항상 유효 직렬화 형태**(Monaco의 유효하지 않은 편집은 `EditorShell` 내부 `pendingYamlText`에 갇혀 페이지로 안 올라옴). 따라서 "저장 불가"는 **저장 시도 시 서버 거절**(version 충돌 409 등)로만 드러남 → **시도-후-감지**(validity 신호 별도 배선 불필요).

복제 클릭 플로우:

1. **`!dirty`** → 다이얼로그 없이 즉시 `cloneAndGo(data.yaml)`.
2. **`dirty`** → `cloneDialog = { stage: "confirm" }` 모달 오픈:
   - 문구: "변경사항이 저장되지 않았습니다. 복제 전에 저장할까요?"
   - **[저장 후 복제]** → `update.mutateAsync({ yaml: yamlText, version: loadedVersion })`:
     - 성공 → baseline 갱신(기존 Save onSuccess와 동일: `setLoadedVersion`/`setOriginalYaml`/`baselineSeededRef=true`) → `cloneAndGo(next.yaml)`(저장 결과의 yaml).
     - 실패 → `cloneDialog = { stage: "save-failed", message }`.
   - **[저장 없이 복제]** → `cloneAndGo(data.yaml)`(마지막 저장본; 편집은 dirty 유지).
   - **[취소]** → 닫기.
3. **`save-failed` 단계** 모달:
   - 문구: "저장에 실패했습니다: {message}. 마지막 저장본으로 복제를 계속할까요?"
   - **[저장본으로 복제]** → `cloneAndGo(data.yaml)`.
   - **[취소]** → 닫기.

`cloneAndGo(yaml)`:
```
const created = await clone.mutateAsync({ sourceYaml: yaml, sourceName: <yaml의 name>, existingNames });
navigate(`/scenarios/${created.id}`);   // D5
```
- **클론 소스는 항상 `data.yaml`(현재 로드된 저장본) 또는 `next.yaml`(방금 저장한 결과)** — 둘 다 서버가 준 유효 YAML이라 **`originalYaml`(EditorShell의 post-mount onChange로 seed되는 *정규화된 재직렬화*, mount 직후엔 `""`)을 클론 소스로 쓰지 않는다.** 이로써 "버튼은 클릭 가능한데 `originalYaml===""`인 post-mount 레이스"(`renameScenarioYaml("")` 실패)를 봉쇄. `originalYaml`은 오직 `dirty` 판정에만 쓴다. (저장 후엔 `useUpdateScenario`가 `setQueryData(scenario(id), updated)` 하므로 `data.yaml`도 최신 저장본을 따라간다 — `hooks.ts:59`.)
- `sourceName`은 받은 yaml에서 파싱(`parseScenarioDoc(yaml)` 또는 `parseDocument(yaml).get("name")`) — `data.name`을 따로 들고 다니지 않고 yaml 단일 출처로 일관 처리(저장-후-복제로 name이 바뀐 경우도 자동 정확).
- navigate 대상이 방금 만든 id라 그 에디터가 fresh로 로드됨.

**일관성 메모**: Monaco에 유효하지 않은 pending 편집이 있으면 "저장 후 복제"는 페이지가 가진 마지막 *유효* `yamlText`를 저장한다 — **기존 Save 버튼과 동일 동작**(유효하지 않은 pending 텍스트는 어차피 저장 불가). 새 제약이 아님.

## 7. 에러 처리

- `createScenario` 실패(이론상 거의 없음 — 소스가 유효 + 이름만 변경): 목록은 alert 배너, 에디터는 `clone.error`/다이얼로그 내 메시지.
- `update`(저장-후-복제) 실패: §6.2의 `save-failed` 단계로 전이(409 version 충돌 등).
- `renameScenarioYaml` throw(소스 파싱 실패): 호출부 try/catch → 에러 표시. 도달 거의 불가.
- 에디터 경로 `useScenarios()` 미로딩: 복제 버튼 disable(`scenarios === undefined`) → dedup 정확성 보장.

## 8. 테스트 (게이트: `pnpm lint && pnpm test && pnpm build`)

TDD 순서 — 테스트 파일 먼저(tdd-guard).

### 8.1 단위 — `cloneName`
- base 추출(plain / `(copy)` / `(copy N)` 접미사 벗기기), 1차 `(copy)`, 충돌 체인 `(copy 2)`/`(copy 3)`, 빈 existing, 무관 이름.

### 8.2 단위 — `renameScenarioYaml`
- `name:`만 바뀌고 다른 키·**주석 보존**, PLAIN scalar(인용부호 비상속) 라운드트립, `parseScenarioDoc`로 재파싱 시 새 name.

### 8.3 RTL — `ScenarioListPage`
- 복제 클릭 → `createScenario`가 **munged YAML(새 name 포함)**으로 호출됨 + 목록 invalidate(새 행), 화면 유지(navigate 없음). 실패 시 alert 배너.

### 8.4 RTL — `ScenarioEditPage`
- `!dirty` 복제 → 다이얼로그 없이 새 id로 navigate. **(EditorShell post-mount seed를 `await`한 뒤 클릭** — `originalYaml===""` 윈도가 RTL에선 실재하므로; 단 클론 소스는 `data.yaml`이라 `!dirty` 판정만 영향.)
- `dirty` 복제 → 확인 모달; **[저장 후 복제]** 성공 시 PUT 호출 + navigate; **[저장 없이 복제]** 시 PUT 없이 navigate(저장본 기준).
- 저장 실패 주입(`update` mock reject) → `save-failed` 모달 → **[저장본으로 복제]** → navigate.
- `useScenarios` 미로딩 시 버튼 disable.
- **fixture 주의**: 에디터 페이지가 이제 `useScenarios()`도 부르므로 RTL mock에 **`GET /api/scenarios`(목록) 라우트 추가** 필요(기존 `ScenarioEditPage.testrun.test.tsx`는 `/api/scenarios/{id}`만 mock — 목록 라우트 없으면 `useScenarios`가 fallback 에러로 떨어져 복제 버튼이 영영 disable). 테스트 파일은 vitest `include`(`src/**/__tests__/**`) 규약상 **`__tests__/` 디렉터리**에 둘 것(sibling `*.test.ts` 아님).

## 9. 충돌 분석 (A2-2와)

**선정 당시(2026-06-06)** A2-2(그룹/페이지 레이턴시)는 진행 중 worktree였고, 그와 파일이 겹치지 않는 작업으로 이 슬라이스를 골랐다. **그 사이 A2-2가 master에 머지(`98ee401`→`96f7936`, worktree 제거됨)** 되어 더 이상 동시 작업 충돌은 없고, 이 슬라이스는 그 위(현 master)에서 진행한다.

머지된 A2-2의 UI footprint(확인): `ui/src/api/schemas.ts` · `ui/src/components/report/GroupLatencyTable.tsx`(신규) · `ui/src/components/report/ReportView.tsx`(+백엔드 엔진/proto/워커/controller).

이 슬라이스가 건드리는 파일: `ui/src/scenario/cloneName.ts`(신규) · `ui/src/scenario/yamlDoc.ts` · `ui/src/api/hooks.ts` · `ui/src/pages/ScenarioListPage.tsx` · `ui/src/pages/ScenarioEditPage.tsx` (+ 각 `__tests__`). **A2-2 footprint와 교집합 0** — 특히 `hooks.ts`·`yamlDoc.ts`는 A2-2가 안 건드렸음(git 확인). migration 무관(이 슬라이스는 migration 없음).

## 10. 참고

- 기존 패턴: `useCreateScenario`(hooks.ts) · `plainScalar`/Document API(yamlDoc.ts) · `Modal.tsx`(접근성 모달) · `ScenarioSnapshot` 등.
- ADR 불필요(additive, 새 아키텍처 결정 없음 — 기존 ADR-0013 Scenario/RunConfig 분리·ADR-0015 YAML AST round-trip 범위 내).
- 함정: `ui/CLAUDE.md` Zod `.default()` 누출 / `yaml` setIn quote 상속 / RTL store reset / `useScenarios` async settle.
