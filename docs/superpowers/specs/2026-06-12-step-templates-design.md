# 스텝 템플릿 (저장/복사-삽입) 설계

- **날짜**: 2026-06-12
- **상태**: 설계 승인 (brainstorming 섹션별 사용자 승인 완료)
- **출처**: 사용자 요청 — "여러 시나리오를 조합해 긴 시나리오처럼 run" 아이디어에서 출발, 참조 기반 조합의 설계 부담(참조 추종·변수/쿠키 핸드오프·run 시점 합성·id 충돌)을 피해 **스텝 템플릿화(복사-삽입 스냅샷)** 로 단순화하기로 결정.
- **ADR**: 신규 **ADR-0036** (스텝 템플릿 = 독립 top-level 리소스 + 복사-삽입 스냅샷, 참조 동기화 기각) 추가 예정.

## 1. 목적

공통 플로우(예: 로그인 = `POST /login` → `GET /me`)를 시나리오마다 손으로 다시 만드는 통증 해소. QA 한 명이 만든 플로우를 팀 전체가 재사용한다.

- 에디터에서 **최상위 스텝 시퀀스(1개 이상)** 를 이름 붙여 서버에 저장.
- 아무 시나리오 에디터에서나 불러와 **복사-삽입**: 복사 = 스냅샷(원본 추종 없음), 삽입 시 모든 스텝(중첩 자식 포함)에 **새 ULID 발급**.
- 각 스텝은 http/loop/if/parallel **서브트리 통째**로 담긴다.

## 2. 비목표 (v1)

- **변수 파라미터화 UI** — `{{var}}`/`${ENV}` 토큰은 그대로 복사. 삽입 후 기존 검증 배너(U4)·⚠ 배지·변수 치트시트(U3)가 안내. 책임 분리: 템플릿은 텍스트 스냅샷일 뿐.
- **참조 기반 동기화** (원본 템플릿 수정이 삽입본에 전파) — 기각. 필요해지면 별도 슬라이스(시나리오 조합)로.
- **컨테이너(loop/if/parallel) 내부로의 삽입** — 최상위 삽입만.
- **내장(built-in) 스텝 템플릿** — U3 시나리오 갤러리와 별개, 사용자 정의만.
- **별도 관리 페이지(`/templates`)** — 삽입 모달 내 최소 관리(삭제)로 시작. 팀 라이브러리가 커지면 EnvironmentsPage 미러로 확장(roadmap 연기 항목으로 기록, 사용자 결정 2026-06-12).
- 템플릿 버전/히스토리, import/export, 검색/태그.

## 3. 결정 요약

| 질문 | 결정 |
|---|---|
| 템플릿 단위 | 최상위 스텝 시퀀스 `Step[]` (1개 이상, 서브트리 포함) |
| 저장 위치 | 서버 top-level 리소스 (`step_templates` 테이블, 팀 공유) — environments 패턴 미러 |
| 접근 방식 | 전용 리소스 (대안 "기존 시나리오에서 스텝 가져오기"는 시나리오 목록 오염·조각 네이밍 불가로 기각) |
| 복사 의미론 | 스냅샷 + 삽입 시 전 스텝 새 ULID |
| 이름 충돌 | `UNIQUE(name)` → 409 → UI "덮어쓰기?" 확인 → `PUT` |
| 관리 표면 | 삽입 모달 내 최소 관리(삭제). 별도 페이지는 연기 |
| 변경 범위 | **엔진·워커·proto 무변경.** 컨트롤러 store/api 각 1파일 + migration 0015, UI 모달 2개 + store Edit 1종 |

## 4. 백엔드

### 4.1 데이터 모델 — migration `0015_step_templates.sql`

(0014는 Rust-guarded `ensure_run_group_metrics_branch` — SQL 파일 번호는 0015가 다음.)

```sql
CREATE TABLE IF NOT EXISTS step_templates (
  id TEXT PRIMARY KEY,              -- 서버 생성 ULID (Ulid::new())
  name TEXT NOT NULL UNIQUE,        -- 충돌 → 409
  description TEXT NOT NULL DEFAULT '',
  steps_yaml TEXT NOT NULL,         -- 스텝 배열 YAML (시나리오 steps: 와 동일 포맷)
  step_count INTEGER NOT NULL,      -- 최상위 스텝 수 (서버가 저장 시 파싱해 계산, 목록 표시용)
  created_at INTEGER NOT NULL,      -- epoch seconds (environments와 동일)
  updated_at INTEGER NOT NULL
);
```

### 4.2 REST API — `api/step_templates.rs` (environments 미러)

| 라우트 | 동작 |
|---|---|
| `POST /api/step-templates` | 생성. body `{name, description?, steps_yaml}` → 201 full. 이름 중복 **409**(`ApiError::Conflict`, 한국어 메시지 — environments 패턴), 검증 실패 **422** |
| `GET /api/step-templates` | `{templates: [Summary…]}` — Summary = `{id, name, description, step_count, created_at, updated_at}` (steps_yaml 제외) |
| `GET /api/step-templates/{id}` | full = Summary + `steps_yaml`. 없으면 404 |
| `PUT /api/step-templates/{id}` | 전체 교체 `{name, description?, steps_yaml}` (덮어쓰기·이름변경). 다른 행과 이름 충돌 409, 없으면 404 |
| `DELETE /api/step-templates/{id}` | 204. **무가드** — 복사 시맨틱이라 어디서도 참조하지 않음 (environments 무가드 삭제와 동일 논리) |

### 4.3 서버 검증 (최소)

- `steps_yaml`이 엔진 serde로 `Vec<engine::scenario::Step>` 파싱 성공 **+ 비어있지 않음** → 아니면 422.
- 그 이상(스텝 id ULID 유효성, UI 중첩 규칙)은 안 봄 — 삽입 시 클라가 id를 전부 재발급하고, 엄격 검증은 UI Zod 게이트 담당(기존 lenient-engine / strict-UI 스탠스).
- `step_count`는 파싱된 `Vec<Step>`의 `len()` (최상위만).

## 5. UI

### 5.1 저장 흐름 — "템플릿으로 저장"

- **진입점**: 에디터 헤더 버튼, EditPage·NewPage 둘 다 (U4 "미리 1회 실행" 두-페이지 배선 패턴 재사용).
- **활성 조건**: 버퍼가 모델-가용일 때만 (`parseScenarioDoc(yamlText)` ok — U4 검증 배너와 같은 게이트). 게이트 에러면 비활성 + 사유 툴팁.
- **다이얼로그**: 이름(필수) + 설명(선택) + **최상위 스텝 체크박스 목록**(스텝 이름·타입 표시). 기본 체크 = 선택 중인 스텝이 있으면 그 스텝의 최상위 조상만, 없으면 전체. 체크 0개면 저장 비활성.
- **소스 = 라이브 에디터 버퍼**(저장본 아님 — test-run과 동일 의미론). 체크된 스텝의 YAML 노드를 현재 Document에서 추출해 스텝 배열 YAML로 직렬화 — **주석 보존**(`renameScenarioYaml`과 같은 Document API 접근).
- **409 처리**: "같은 이름 템플릿이 있습니다 — 덮어쓰기?" 확인 → 그 템플릿 id로 `PUT`.
- 신규 문구 전부 `ko.ts` 카탈로그 경유 (ADR-0035).

### 5.2 삽입 흐름 — "템플릿 삽입"

- **진입점**: 에디터 헤더 버튼 → 모달: 템플릿 목록(이름/설명/스텝 수/수정일) + 행별 삭제 버튼(확인 후 DELETE — 최소 관리).
- **선택 시**: `GET /api/step-templates/{id}` → `steps_yaml`을 **UI Zod 게이트로 검증**(strict-UI, 검증 전용 파싱). 불통(예: curl로 생성된 야생 템플릿이 UI 2단 중첩 규칙 위반)이면 "이 템플릿은 에디터 규칙과 호환되지 않습니다" 에러 표시, 삽입 중단.
- **ULID 재발급 (노드 레벨)**: 삽입은 모델 객체가 아니라 **YAML 노드 이식**으로 한다(주석 보존). 따라서 id 재발급도 이식되는 노드에 적용: 순수 헬퍼 `reissueStepIdsInFragment(fragment)` — 템플릿 YAML을 `parseDocument`한 스텝 시퀀스를 **구조-인지 재귀**(http 자신 / loop `do[]` / if `then`·`elif[].then`·`else` / parallel `branches[].steps`)로 walk 하며 각 스텝 맵의 `id`만 `newStepId()`로 교체. ⚠ "모든 `id` 키 일괄 교체"는 금지 — `headers`에 `id`라는 이름의 헤더 키가 있으면 오염된다(구조-인지 walk가 이를 배제).
- **삽입 위치**: 선택 중인 스텝의 **최상위 조상 바로 뒤**, 선택 없으면 맨 끝 append.
- **반영**: 새 Edit variant `insertSteps(afterTopIndex | end, stepsYaml)`를 `applyEdit`에 추가 — 템플릿 YAML을 `parseDocument` → `reissueStepIdsInFragment` → 노드를 시나리오 Document의 `steps` 시퀀스에 이식. **템플릿 안 주석도 보존.**
- **삽입 후**: 첫 삽입 스텝 자동 선택(기존 add 액션 UX), dirty 플래그는 기존 edit 경로가 자동 처리.

### 5.3 클라이언트 계층

- `ui/src/api/stepTemplates.ts`: Zod 스키마 (`StepTemplateSummarySchema`, `StepTemplateSchema`) + fetch 함수 5종. 목록 응답은 `{templates: […]}` 래퍼.
- React Query hooks: `useStepTemplates`(목록), `useCreateStepTemplate`/`useUpdateStepTemplate`/`useDeleteStepTemplate`(invalidate 목록). 단건 GET은 삽입 시점 1회성 fetch(ephemeral, useTestRun 패턴).

## 6. 엣지 케이스

| 케이스 | 동작 |
|---|---|
| 템플릿이 참조하는 `{{var}}`가 대상 시나리오에 없음 | as-is 복사, 기존 ⚠/검증 배너가 안내 (v1 책임 분리) |
| 빈 시나리오(steps 없음)에 삽입 | 맨 끝 append와 동일 (steps 배열 생성) |
| 다른 사용자가 방금 삭제한 템플릿 선택 | GET 404 → 모달에 에러 + 목록 갱신 |
| steps_yaml 안 스텝 이름 중복 | 허용 (시나리오도 스텝 이름 중복 허용 — id가 식별자) |
| dirty 미저장 상태에서 템플릿 저장 | 허용 — 버퍼 기준 스냅샷이므로 문제없음 |
| 같은 템플릿을 같은 시나리오에 2회 삽입 | 허용 — 매번 새 ULID라 충돌 없음 |

## 7. 테스트

- **Rust**: store CRUD 단위(UNIQUE 위반 포함) + api 201/409/422/404/204 — environments 테스트 미러.
- **UI(vitest/RTL)**:
  - 저장 다이얼로그: 체크박스 기본값(선택 유/무), 0개 비활성, 409 → 덮어쓰기 흐름.
  - 삽입 모달: 목록 렌더, 삭제, 404 에러.
  - `reissueStepIdsInFragment`: 중첩 4타입 전부 교체 + 발급 id 전부 유일 + 주석·여타 필드 보존 + `headers`의 `id` 키 비오염.
  - `applyEdit` `insertSteps`: 주석 보존 round-trip, 삽입 위치(선택 뒤/맨 끝/빈 시나리오).
  - Zod 게이트 fail(호환 안 되는 템플릿) 표시.
- **머지 전 라이브(Playwright)**: 시나리오 A에서 2스텝 플로우 저장 → 시나리오 B에 삽입 → run 1회 완주 + 콘솔 Zod 0 (S-D 갭 규칙).

## 8. 구현 표면 (plan 입력)

- **컨트롤러**: `store/step_templates.rs`(신규), `api/step_templates.rs`(신규), `store/mod.rs` migration 0015 배선, 라우터 등록.
- **UI**: `api/stepTemplates.ts`(신규), hooks, `SaveTemplateDialog`(신규), `InsertTemplateModal`(신규), 에디터 헤더 버튼 2페이지, `scenario/store.ts`+`yamlDoc.ts` `insertSteps` Edit, `reissueStepIdsInFragment`(scenario 모듈), `ko.ts` 신규 문구.
- **무변경**: 엔진(타입 재사용만)·워커·proto·기존 migration.

## 9. 연기 항목 (roadmap §B에 기록)

- 별도 관리 페이지 `/templates` (EnvironmentsPage 미러 — 이름변경/내용 미리보기 포함).
- 변수 파라미터화(삽입 시 placeholder 치환 다이얼로그).
- 컨테이너 내부 삽입, 내장 스텝 템플릿, 버전/히스토리, import/export, 검색/태그.
- 참조 기반 시나리오 조합(별도 spec — 이번 결정으로 대체된 원 아이디어).
