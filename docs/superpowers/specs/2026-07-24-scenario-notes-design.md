# 시나리오 공유 메모(notes) — 설계

- 날짜: 2026-07-24 · 슬라이스: `scenario-notes` · 유형: **user-path**
- 확정 목업: [assets/2026-07-24-scenario-notes-mockup-v4.html](assets/2026-07-24-scenario-notes-mockup-v4.html) (브레인스토밍 비주얼 컴패니언 v4 — 사용자 확정본)

## 사용자 스토리 (US)

- **US1**: QA가 만든 시나리오를 팀원에게 넘기기 전에 수정 페이지에서 공유 주의점(운영 환경 금지·필요 환경변수·선행 데이터셋 준비 등)을 메모로 작성한다 — 성공하면 저장 후 재진입 시 에디터 상단 Callout에 그 메모가 그대로 다시 보인다.
- **US2**: QA(팀원)가 동료가 만든 시나리오를 수정 페이지에서 열면 아무 조작 없이도 상단에 공유 메모가 즉시 보인다 — 성공하면 "운영 환경 금지" 같은 주의점을 열자마자 읽을 수 있다.
- **US3**: QA가 메모가 화면을 차지해 방해될 때 접는다 — 성공하면 접힌 상태에서도 첫 줄 미리보기 한 줄은 남고, 펼치면 전문이 다시 보인다.
- **US4**: QA가 시나리오를 YAML 내보내기/가져오기(또는 git)로 팀원에게 전달한다 — 성공하면 YAML에 `notes` 필드가 포함되어, 가져온 쪽 수정 페이지에도 같은 공유 메모가 표출된다.

## 배경·결정 요약 (브레인스토밍 확정)

| 축 | 결정 | 근거 |
|---|---|---|
| 저장 위치 | 시나리오 YAML `notes` 필드 (DB 컬럼 아님) | 공유 경로(같은 서버 열람·YAML 내보내기·git) 전부에 메모가 따라감 — ADR-0013(시나리오=git/YAML) 정합 |
| 범위 | 시나리오 단위 1개 (스텝별 없음) | "공유 시 주의점" 용도에 충분, YAGNI |
| 표출 | 메모 있으면 에디터 상단 Callout **항상** 표출 + 접기 가능 | 주의점은 숨기면 무의미 · 사용자 확정 |
| 색상 | **accent(indigo) — 기존 `Callout` `info` 변형** | amber는 검증 에러·경고와 시각 충돌("너무 시선을 끈다" 피드백). 신규 변형 0 |
| 빈 상태 진입점 | 본문 상단 얇은 "＋ 공유 메모 추가" 라인 | 표출될 그 자리에 진입점(위치 학습)·헤더 버튼 줄 비대 없음 — 사용자 선택 B |
| 접힘 | 한 줄 축소 + **첫 줄 미리보기** · localStorage 시나리오별 기억 | 접어도 핵심 경고 단서 유지 — 사용자 선택 A |
| 높이 | 초기 `min(내용, 6줄)` + 네이티브 `resize: vertical` 양방향 · **상한 없음·기억 없음** | `max-height` 클램프는 늘리기를 막는다(목업 v3에서 사용자가 발견). 새로고침 시 기본 복귀 |
| 길이 제한 | **없음** (maxLength·카운터 두지 않음) | 자연 상한이 이미 존재(아래 R6) — 에러 경로 0. 사용자 확정 |
| 실행 격리 | 엔진은 `notes`를 **운반-전용**으로 파싱만 | run 시 워커까지 실려 가지만 사용처 0 — 부하 트래픽에 구조적으로 미포함. run 스냅샷은 저장본과 동일(strip 안 함 — 재현성) |
| 표출 표면 | 수정 페이지(`/scenarios/{id}`·`/scenarios/new`)만 | RunDialog·목록은 비목표(후속 후보) — 사용자 선택 |

## 요구사항

- **R1 — 모델**: 시나리오 YAML 최상위 optional `notes`(멀티라인 문자열). 없으면 직렬화 안 됨(기존 시나리오 byte-identical).
- **R2 — 표출**: `notes`가 비어있지 않으면 에디터 최상단에 accent Callout("📝 공유 메모")을 항상 렌더. 본문은 `white-space: pre-wrap`(개행 보존), React 기본 이스케이프(HTML 주입 불가).
- **R3 — 접기**: [접기] → 한 줄(아이콘+제목+첫 줄 미리보기+[펼치기])로 축소. 접힘 여부는 localStorage에 시나리오 id별 기억(fail-soft — `editorPrefs.ts` 이디엄). 신규 페이지(id 없음)는 세션 내 컴포넌트 상태만.
- **R4 — 그 자리 편집**: [편집] → Callout 내부가 textarea로 전환. [완료]=store 커밋(페이지 dirty — 실제 저장은 페이지 [저장]), [취소]=파기. **빈 문자열·공백-only로 완료하면 YAML에서 `notes` 키 삭제**(`""`≡없음 통일). 실수 이탈로 인한 입력 유실 방지는 기존 저장-안-됨 이탈 가드가 페이지 레벨에서 커버(신규 가드 없음).
- **R5 — 빈 상태**: `notes` 없으면 Callout 대신 얇은 점선 라인 "＋ 공유 메모 추가 — 팀원에게 전할 주의점을 남겨두세요" → 클릭 시 R4 편집 모드로.
- **R6 — 저장 용량 가드(신규 · 앵커=사용자 원문 요청 "2MB 넘으면 수정하라고 알려주기")**: 시나리오 생성/수정 API 호출 직전, 직렬화된 요청 body가 **2MiB(2,097,152B) 이상**이면 fetch 없이 한국어 에러를 throw — 기존 에러 Callout 경로로 표출, 현재 크기(MB) 포함. 문구는 `ko.ts` 카탈로그 경유(ADR-0035). **서버 상태코드 매핑은 두지 않는다** — 클라 임계(≥2,097,152B)가 서버 초과 기준(>2,097,152B)과 같거나 더 엄격해 UI 경로는 항상 사전 차단되고(서버 거부에 도달 불가), curl 직접 경로는 `client.ts`를 안 타므로 매핑이 닿을 수 없는 죽은 코드다. axum `Json` extractor의 실제 초과 상태코드(413 vs 400 — controller CLAUDE.md의 multipart-400 선례상 400일 수 있음)는 이 슬라이스 무관으로 미확정 유지.
- **R7 — 높이**: 표시 모드 본문은 마운트/내용 변경 시 `height = min(scrollHeight, 6줄≈9.5rem)`로 초기화, CSS `resize: vertical` + `overflow-y: auto`, **max-height 없음**(양방향 드래그). 편집 textarea도 동일 초기화+resize.
- **R8 — YAML 양방향**: YAML 모달에서 `notes:` 직접 추가/수정/삭제 시 GUI Callout이 즉시 동기화(기존 store 양방향 sync 위). GUI 편집도 YAML 텍스트에 반영.

## 데이터 모델·와이어

**엔진** (`crates/engine/src/scenario.rs`): `Scenario`(line 13)에 필드 추가 —

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub notes: Option<String>,
```

- `Scenario`는 `#[serde(deny_unknown_fields)]`(scenario.rs:12)라 **필드 추가는 필수다** — 안 하면 notes 있는 YAML이 컨트롤러 저장 검증(엔진 파싱)에서 422로 거부된다. "엔진 0-diff" 대안은 성립 불가.
- 필드 위치는 `default_think_time` 뒤(UI 모델 순서와 미러). **엔진 diff는 필드 1개 + 테스트 리터럴 1줄**: `crates/engine/tests/proptests.rs:235`의 필드 열거 `Scenario { … }` 리터럴(레포 유일 — grep 검증)에 `notes: None` 추가 필요(누락 시 컴파일 에러로 강제).
- **운반-전용**: runner/trace/템플릿 어디서도 읽지 않는다(실행 로직 0-diff). `{{var}}`·`${ENV}` 문자열이 메모에 있어도 템플릿 엔진에 들어가지 않으므로 아무 효과 없음.
- 컨트롤러 src·proto·DB migration **0-diff**(YAML은 `scenarios.yaml` TEXT로 통째 저장). run 스냅샷(`runs.scenario_yaml`)에도 그대로 실림 — strip 없음(재현성).
- **워커 재빌드 footgun**(기존 문서화): 구버전 워커 바이너리는 `deny_unknown_fields`로 notes YAML 파싱 실패 → run 즉시 failed. 새 위험 아님 — 루트 CLAUDE.md "cargo build -p handicap-worker 필수" 항목이 이미 커버.

**UI 모델** (`ui/src/scenario/model.ts`): `notes: z.string().optional()` (시나리오 루트). 빈 문자열은 모델에 넣지 않는다 — 커밋 시 정규화(공백-only → undefined).

**yamlDoc** (`ui/src/scenario/yamlDoc.ts`): `default_think_time`의 set/delete 이디엄(yamlDoc.ts:148–157)과 동일 — `setNotes` edit: 값 있으면 `doc.setIn(["notes"], …)`(멀티라인은 yaml 라이브러리가 block scalar로 직렬화), undefined면 `doc.deleteIn(["notes"])`.

**store** (`ui/src/scenario/store.ts`): `setNotes(value: string | undefined)` 액션 — `setDefaultThinkTime` 디스패치 이디엄(store.ts:163–165) + 액션 셀렉터 맵 노출(store.ts:472). dirty 전파는 기존 경로 그대로.

## UI 컴포넌트

**신규 `ScenarioNotesCallout`** (`ui/src/components/scenario/`) — 4상태(표출/접힘/편집/빈 진입)를 한 컴포넌트에:

- 배치: `EditorShell`(EditorShell.tsx:17) 반환 트리 **최상단, `ValidationBanner` 위** — `/scenarios/{id}`·`/scenarios/new` 둘 다 EditorShell 경유라 자동 커버(ScenarioNewPage.tsx:6). **라이브 검증은 두 마운트 경로 모두에서**(live-verify-all-mount-paths 교훈).
- 시각: `Callout` `info` 변형(`ui/src/components/ui/Callout.tsx` — accent-200/50/800) 재사용. `ko.ts` 신설 키 일괄: 제목("📝 공유 메모")·빈 진입 라인 문구·접기/펼치기/편집/완료/취소 라벨 및 aria-label·용량 가드 메시지 — aria 포함 전부 카탈로그 경유(ADR-0035). 접힘/펼침·편집 버튼은 aria-label 분리(WCAG Label-in-Name).
- 렌더 술어: `notes?.trim()`이 비어있지 않을 때만 Callout, 아니면 빈 진입 라인 — YAML 모달 유래 `notes: ""`도 "없음"으로 렌더(빈 Callout 금지). **`model === null`(YAML 파싱 불가)이면 컴포넌트 전체 render null**(죽은 진입 라인 노출 금지).
- **yamlError 게이트(레포 함정 — think-time-defaults S1)**: `yamlError !== null`이면 store dispatch가 no-op이라 커밋이 조용히 삼켜져 재시드 때 되돌아간다 — [편집]·[완료]·빈 진입 라인은 `disabled={yamlError !== null}`(기존 VariablesPanel·FlowOutline 이디엄), 접기/펼치기(read-only 로컬 상태)는 활성 유지.
- 접힘 localStorage: `handicap:scenario-notes-collapsed:v1` 단일 키에 `{ [scenarioId]: true }` 맵(fail-soft try/catch — editorPrefs 이디엄). 정리는 **현재 시나리오 키 한정** — 로드 시 그 시나리오의 notes가 없으면 그 키만 제거(전역 스캔 없음). scenarioId는 EditorShell에 없으므로 컴포넌트가 react-router `useParams`로 직접 취득(신규 페이지는 id 부재 → 세션 상태 폴백, prop 배선 0).
- resize: `useLayoutEffect`로 `style.height = min(scrollHeight, 9.5rem)` 세팅(내용 변경 시 재계산), CSS `resize-y overflow-y-auto`. jsdom은 레이아웃 미구현 — 높이 로직은 라이브/시각 검증 담당, RTL은 상태 전이만.

**저장 용량 가드** (`ui/src/api/client.ts`): 시나리오 create/update의 **엔드포인트 래퍼 레벨**(`deleteScenarioImpl`(client.ts:172)식 per-endpoint — 공용 `request()`에 두면 타 라우트 오매핑)에서 `new Blob([JSON.stringify(body)]).size >= 2 * 1024 * 1024`면 fetch 전에 `Error(ko.…(sizeMb))` throw → 페이지의 기존 `update.error`/`create.error` Callout이 표출. **사실 근거**: 컨트롤러 body limit 상향(256MiB, app.rs:35)은 데이터셋 라우트(app.rs:78·82)에만 적용 — 시나리오 라우트는 axum 기본 2,097,152B. SQLite TEXT 자체 상한은 ~1GB(SQLITE_MAX_LENGTH 기본)라 실질 상한은 body limit 쪽.

## 엣지 케이스

- 공백-only 메모 완료 → 키 삭제(R4) — YAML에 빈 `notes:` 잔재 없음.
- YAML 모달로 `notes: ""`(빈 문자열·공백-only) 입력 → 모델 정규화로 "메모 없음" 취급(빈 Callout 렌더 금지, 빈 진입 라인 표출). YAML 텍스트의 키 자체는 손대지 않음(사용자 소유 영역) — 키 삭제 정규화는 GUI 편집 완료 시에만.
- 신규 페이지에서 메모 작성 → 저장 전 YAML에만 존재, 저장하면 동일 동작. 접힘 기억은 세션 한정(id 없음).
- 클라 가드 우회(curl 직접 POST) 대용량 → 서버 기존 거부 동작 그대로(axum 기본 limit — 상태코드는 이 슬라이스 무관, R6은 UI 사전 차단만).

## 비목표 (후속 후보)

- RunDialog·시나리오 목록·run 상세에서의 메모 표출 (\"run 직전 주의 전달\"은 후속 슬라이스 후보)
- 스텝별 메모, 마크다운/서식, 작성자·타임스탬프 메타, 메모 이력
- 높이·접힘 상태의 서버 저장(멀티 브라우저 동기화)
- run 발사 시 notes strip(재현성 훼손 대비 이득 없음 — 위 결정 표)

## 테스트 전략

- **Rust(engine)**: ① notes 없는 기존 YAML 라운드트립 byte-identical ② notes 있는 YAML parse→serialize 보존(멀티라인 block scalar) ③ 미지 키 여전히 deny(회귀 가드).
- **UI(RTL/vitest)**: 4상태 전이(표출→접기→펼치기→편집→완료/취소), 공백-only 완료 시 store에서 키 삭제, YAML 모달 왕복(R8), 사이즈 가드(2MiB 초과 body에서 fetch 미발생+문구), Zod 모델 optional 라운드트립, **yamlError 상태에서 편집·추가 affordance disabled**(무음 유실 가드). **회귀 가드 표방 테스트는 고의 회귀→RED→원복→GREEN 실증**([[plan-mandated-vacuous-tests]]).
- **라이브(/live-verify, US 척추)**:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | `/scenarios/{id}`에서 메모 작성→[완료]→[저장]→새로고침 | Callout에 같은 내용 표출 |
| US2 | 다른 세션(시크릿 창)으로 같은 시나리오 열기 | 조작 없이 상단에 메모 보임 |
| US3 | [접기]→새로고침 / [펼치기] | 접힘+첫 줄 미리보기 유지 → 전문 복귀 |
| US4 | YAML 모달 내보내기→신규 가져오기(또는 `/scenarios/new` 붙여넣기) | 가져온 편집 화면에 같은 메모 표출 |
| R6 | 대용량 YAML로 저장 시도 | fetch 없이 한국어 한도 문구(또는 413 매핑) |
| 마운트 경로 | `/scenarios/new`에서 빈 진입 라인→작성→저장 | 저장된 시나리오 재진입 시 표출 |

- **run 무영향 확인**: notes 있는 시나리오로 run 1회 — 정상 완료 + echo 서버 와이어에 notes 문자열 부재(운반-전용 증명).
