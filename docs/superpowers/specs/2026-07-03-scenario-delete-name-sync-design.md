# 시나리오 삭제 + 이름 라이브 표시/인라인 편집 + false-dirty 수정

- **날짜**: 2026-07-03 (개정 r2 — spec-plan-reviewer round 1 반영: 가드 in-tx 이동·liveName seeded 게이트·loadedVersion id-키드 핀·0005 주석 갱신+ADR. 스코프 분리 제안은 기각 — 사용자 결정으로 한 슬라이스 번들, plan이 삭제/에디터 task 그룹을 독립 green으로 담보)
- **출처**: 사용자 보고 2건(2026-07-03 조사 완료 — 메모리 `scenario-delete-and-name-sync-findings`): ① 시나리오 삭제 기능 부재(백엔드 DELETE 엔드포인트·UI 버튼 전무) ② YAML에서 이름(`name:`)을 바꿔도 에디터 화면에 반영 안 됨(sync 정상 — 라이브 표시 표면 자체가 없음). + 조사 중 발견 부수 버그: 에디터 로드 직후 무편집인데 저장 버튼 활성(false-dirty, U3 B1 함정).
- **사용자 결정(2026-07-03 brainstorming)**: ① 삭제 정책 = **2층 가드 + 전체 cascade**(활성 run → hard 409 / 그 외 참조 → soft 409 + 요약 → `?force=true` 시 run 이력·리포트 포함 전부 삭제; "run 이력 있으면 삭제 불가"·soft-delete 아카이브는 기각) ② 이름 = **라이브 표시 + 인라인 편집**(라이브-표시-만 기각) ③ 범위 = **false-dirty 포함, UI 검증 false-green(assert 맵 통과→서버 400 영어 노출)은 제외**(알려진 클래스·심각도 낮음 — 별도 후속) ④ 접근 4축(트랜잭션 cascade / 목록-행-만 삭제 / 연필 인라인 편집 / 선적재 패턴) 승인.
- **접근 비교(요약)**: cascade = 명시적 트랜잭션 삭제(store 함수) — **채택**. 마이그레이션으로 `ON DELETE CASCADE` 추가는 **기각**(SQLite는 기존 테이블 FK 변경 불가 — 테이블 재생성 필요, 위험 대비 이득 없음). 단 migration 0005 주석은 "미래 scenario-delete spec이 FK CASCADE를 **추가해야 한다**"고 지시하므로 — 이 spec이 그 지시를 app-레벨 cascade로 대체하는 결정이며, 주석도 함께 갱신한다(R11·§4.3, 미갱신 시 후속 슬라이스가 FK 마이그레이션 빚으로 오독). 삭제 진입점은 목록 행만(에디터 페이지 중복 진입점 기각 — 범위). 이름 편집은 h2 옆 연필→input 전환(항상-input 헤딩은 `<h2>` 시맨틱 상실로 기각).

## 1. 문제와 목표

**삭제**: 컨트롤러엔 시나리오 create/get/list/update만 있고(`app.rs:41-47` — `/scenarios/{id}`는 `get().put()`뿐) DELETE가 없다. UI 목록 행 액션도 복제/실행뿐. `scenarios(id)`를 참조하는 테이블은 `runs`(0001, 그 아래 run 메트릭 6테이블)·`run_presets`(0005 — 주석에 "scenario-delete 시 CASCADE 필요" 선기록)·`schedules`(0011, `schedule_events`는 `ON DELETE CASCADE` 보유)이고 커넥션이 `PRAGMA foreign_keys=ON`(store/mod.rs, 테스트로 락인)이라 참조를 남긴 삭제는 FK가 거부한다 — 삭제 정책이 필수 선결이다.

**이름**: 에디터 헤더 h2/브레드크럼은 서버 `data.name`만 렌더(`ScenarioEditPage.tsx:95-98`), store `model.name` 렌더처 0, `setName` 액션(`store.ts:125`) 미사용. YAML 모달에서 `name:`을 바꾸면 양방향 sync는 정상 동작(model에 반영)하지만 화면 어디에도 안 보여 사용자는 "이름 변경이 안 된다"로 인지한다. 저장하면 서버가 YAML에서 name을 재파싱해 반영되는 것(`api/scenarios.rs` update)은 기존대로.

**false-dirty**: `ScenarioEditPage`는 `baselineSeededRef`로 EditorShell **첫 onChange를 baseline으로 시드**하는데, U3 B1 함정(ui/CLAUDE.md)대로 첫 onChange는 로드된 YAML이 아니라 **mount-렌더에 캡처된 pre-load store 텍스트**(싱글톤 store — fresh면 `""`)다. 그래서 로드 직후 `originalYaml=""` vs canonical yamlText로 dirty=true → 저장 버튼이 무편집에 활성(무의미 저장 버전 bump·복제 시 불필요 dirty 다이얼로그). `ScenarioNewPage.chooseTemplate`(mount **전** `loadFromString` + canonical 양쪽 시드)가 미러할 안전 패턴.

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `DELETE /api/scenarios/{id}?force=<bool>` 추가(`app.rs` `/scenarios/{id}`에 `.delete()` 체인): 존재하지 않는 id → **404**. | controller API 테스트: 미존재 id 404. | HTTP API 신규 |
| R2 | MUST **hard 가드**: 이 시나리오의 `pending`/`running` run이 하나라도 있으면 `409 Conflict`(문자열 에러, 한국어) — **`force=true`여도 거부**(실행 중 부하의 발밑 삭제 방지; 데이터셋 hard 가드와 동일 정신, 단 판정은 `runs.scenario_id` 직접 SQL이라 profile_json 파싱 불요). **권위 판정은 cascade 트랜잭션 *안*의 `SELECT EXISTS`**(§3-5 레이스 봉쇄) — `delete_cascade`가 활성 run 발견 시 롤백 + 구분 가능한 에러 반환, 핸들러가 409로 매핑(핸들러-레벨 사전 체크는 두지 않음 — 단일 권위 지점). | API 테스트: running run 심고 force=true 포함 409 단언 + store 테스트: 활성 run 존재 시 `delete_cascade`가 에러 반환·전 테이블 무변이. | |
| R3 | MUST **soft 가드**(`force=false`일 때): run 이력 N·프리셋 M·스케줄 K를 카운트해 하나라도 >0이면 `409 ConflictJson {"error": <한국어 요약>, "runs": N, "presets": M, "schedules": K}` — UI 확인 다이얼로그의 재료(데이터셋 soft 409의 counts 변형; 프리셋처럼 목록 대신 **카운트만** — run 이력은 수백 건일 수 있어 목록 부적합). | API 테스트: 참조 조합별(runs만/presets만/schedules만/셋 다) JSON shape 단언. | 409 본문 shape = UI 계약 |
| R4 | MUST **cascade 삭제**(`store/scenarios.rs::delete_cascade(db, id)`, **단일 트랜잭션**): ① in-tx 활성 run `SELECT EXISTS` 가드(R2) → ② run 산하 메트릭 6테이블(`run_metrics`·`run_loop_metrics`·`run_if_metrics`·`run_group_metrics`·`run_phase_metrics`·`run_active_vu_metrics`, 각 `WHERE run_id IN (SELECT id FROM runs WHERE scenario_id=?)`) → `runs` → `run_presets` → `schedules`(`schedule_events`는 기존 `ON DELETE CASCADE`) → `scenarios` 순서로 삭제 후 204. **다른 시나리오의 데이터는 무손상**. | store 단위 테스트: 참조 그래프(run+메트릭 6종 행+프리셋+스케줄+이벤트) 전체 심고 삭제 → 해당 스코프 전 테이블 0행 + FK 위반 없음 + **타 시나리오 그래프 무손상** 단언. | |
| R5 | MUST UI `client.ts::deleteScenario(id, force)` — `deleteDatasetImpl` 미러(bespoke fetch): 204 → `{deleted:true}`; soft 409(본문에 숫자 `runs`/`presets`/`schedules`) → `{deleted:false, refs:{runs,presets,schedules}}`; hard 409(문자열 error만)·기타 비-2xx → `ApiError` throw. `hooks.ts::useDeleteScenario`는 `deleted===true`일 때만 `["scenarios"]` invalidate. | client/hooks RTL 테스트: 3 응답 분기 + invalidate 조건. | |
| R6 | MUST `ScenarioListPage` 행 액션(복제·실행 옆)에 **삭제** 버튼: ① 1차 `window.confirm`(시나리오명 포함) → `force=false` 호출, `deleted:true`면 끝 ② `deleted:false`면 2차 `window.confirm`(참조 요약 — "run 이력 N건·프리셋 M건·스케줄 K건이 함께 삭제됩니다") → `force=true` 재요청 ③ throw(hard 409 등)는 복제-실패 배너와 **동일 관용구의 별도 삭제-실패 `role="alert"` 배너**(페이지 상단 인접). 삭제 진행 중(pending) 행 버튼 disabled(더블클릭 방지 — 기존 clone.isPending 관용구). | RTL: 3 흐름(참조 0 즉시 삭제 / soft→force / hard 409 배너) + confirm 미승인 시 미호출 + pending disabled. | |
| R7 | MUST 에디터 헤더 h2·브레드크럼이 `model.name` **라이브 렌더** — 단 **R9 시드 게이트와 결합**: `liveName = seeded ? (editorModel?.name ?? data.name) : data.name`. store가 싱글톤이라 에디터 A→B 이동 시 시드 전 프레임의 `editorModel`은 **A의 stale non-null 모델**이므로, `editorModel?.name ?? data.name`만으론 B 페이지에 A 이름이 잠깐 뜬다 — seeded 게이트가 그 윈도를 서버명으로 덮는다. 깨진-YAML 윈도(`model===null`)도 서버명 폴백. | RTL: YAML/스토어 name 변경 → h2·브레드크럼 즉시 갱신; model=null 폴백; **stale-model 케이스**(store에 타 시나리오 모델 선주입 후 마운트 → 시드 전 표시가 `data.name`). | |
| R8 | MUST h2 옆 **연필 버튼 → 인라인 `<input>` 편집**: draft 시드=liveName, **Enter/blur 커밋**(trim 후 **빈 문자열이면 revert** — `ScenarioModel.name: min(1)`이라 빈 커밋은 doc/model 갈라짐[URL-min(1) 함정 동류]), 유효하면 `setName(trimmed)` 재사용 → YAML doc 반영 → 기존 dirty·저장 흐름 합류; **Escape 취소**(revert). 연필 활성 조건 = **`seeded && editorModel !== null`**(R7과 동일 stale/깨진-YAML 게이트), 아니면 disabled + title 안내. | RTL: 커밋→h2 갱신+dirty 활성 / 빈이름 revert / Escape revert / model=null·pre-seed disabled. | 신규 상태·스키마 0 |
| R9 | MUST **false-dirty 제거**: `ScenarioEditPage`가 data 도착 시(시나리오 **id당 1회**) `loadFromString(data.yaml)` → 그 시점 canonical store `yamlText`를 로컬 `yamlText`/`originalYaml` 양쪽에 시드 → **시드 완료 후에만 `EditorShell` 마운트**(게이트). `baselineSeededRef` 제거, `handleEditorChange`는 단순 `setYamlText`. 재시드는 **id 변경 시만**. **`loadedVersion`도 id-키드**: 시드 시점과 save 핸들러만 세팅, 같은 id의 백그라운드 refetch는 재-arm하지 않음 — 외부(타 탭) 버전 bump 후 저장은 `VersionMismatch` 에러로 표면화(올바른 optimistic-lock; silent 채택은 타 탭 변경을 덮어쓸 위험이라 기각). | RTL(회귀 — 현재 버그라 RED부터): 로드 직후 저장 버튼 **disabled**; 편집 후 enabled; 저장 후 다시 disabled. | |
| R10 | MUST **클라이언트 발신** 신규 사용자 노출 문구(confirm·배너·aria-label·연필 title 포함) 전부 `ko.ts` 카탈로그 경유(ADR-0035) — 카운트 문구는 함수 키. 서버 발신 에러 문구(hard 409 등)는 백엔드 한국어 리터럴을 배너가 passthrough(datasets 관용구 — ko.ts 범위 밖). | grep: 신규/변경 UI 파일 하드코딩 한국어/영어 문구 0(`'"[^"]*[가-힣]'` 스윕). | |
| R11 | MUST (불변식) 엔진·worker·proto·**신규 migration 0건**(테이블 변경 없음 — 단 `0005_run_presets.sql` **주석-only 갱신** 1건 포함: "FK CASCADE를 추가해야" 지시를 app-레벨 cascade 채택으로 교체; 러너가 `include_str!`+멱등 실행이라 checksum 불일치 위험 없음); `schemas.ts`·`scenario/model.ts`·`store.ts`·`yamlDoc.ts` **무변경**(이름 편집은 기존 `setName` 재사용); 시나리오 YAML 와이어 포맷 byte-identical. **production-src** backend diff = `app.rs` 라우트 + `api/scenarios.rs` 핸들러 + `store/` 헬퍼(`scenarios.rs` cascade + `runs.rs`/`presets.rs`/`schedules.rs`의 카운트)뿐(테스트 파일은 별도). | 머지 diff 경로 검사 + 기존 테스트 전부 green. | |
| R12 | MUST 게이트: cargo fmt/clippy/nextest + `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체)·`pnpm build` green + 머지 전 **라이브 검증**(§6 — 신규 API+UI 왕복이라 필수). | 게이트 green + §6 체크리스트 수행 기록. | |

## 3. 핵심 통찰 (설계 근거)

1. **FK 강제 ON이 cascade의 정합성 증명**: `PRAGMA foreign_keys=ON`(락인 테스트 존재)이라 삭제 순서가 틀리면 그 자리에서 FK 에러가 난다 — "참조 남긴 삭제"는 구조적으로 불가능하고, R4의 삭제 순서(자식→부모)가 곧 정합성 검증이다. 단 run 메트릭 테이블 일부(`run_loop_metrics` 등)는 FK 없이 `run_id` 컬럼만 가지므로 **FK만 믿으면 orphan이 남는다** — 6테이블 전수 삭제가 필수(FK 유무 불문).
2. **hard/soft 2층은 데이터셋 삭제의 검증된 패턴**: 활성 run은 force로도 못 지움(실행 중 부하 안전), 이력·프리셋·스케줄은 사용자 확인(soft 409→force)으로 지움. 차이 둘 — ① 판정 SQL이 단순(`runs.scenario_id` 직접, profile_json 파싱 불요) ② soft 409 본문이 목록이 아니라 **카운트**(run 이력은 수백 건 가능 — 프리셋 목록 방식 부적합).
3. **이름은 YAML이 소유** — 인라인 편집은 새 상태가 아니라 기존 양방향 sync(ADR-0003/0015)의 GUI 편집 하나 추가다: `setName` → yamlDoc `setIn` → 재파싱 → dirty → 기존 저장 버튼. 서버 반영도 기존 update 경로(YAML에서 name 재파싱) 그대로라 **신규 API·스키마 0**. 깨진-YAML 윈도에서 편집을 막는 이유도 같다 — 이름의 진실이 YAML인데 YAML이 파싱 불가면 쓸 곳이 없다.
4. **false-dirty의 근본 원인은 "첫 onChange = 로드 텍스트" 가정**: U3 B1대로 첫 onChange는 pre-load store 텍스트다. 고치는 방향은 가정을 고치는 것이 아니라 **가정이 성립하게 만드는 것** — mount 전에 store를 로드 텍스트로 선적재하면(=`chooseTemplate` 패턴) 첫 onChange가 무엇을 캡처하든 canonical과 일치한다. 선적재 시점의 canonical을 양쪽 시드하므로 `baselineSeededRef` 자체가 불필요해진다.
5. **삭제 레이스는 "in-tx 가드 + FK + WAL 단일-writer"의 3겹으로 봉쇄** (reviewer round 1이 가드-밖 인터리빙 적발): hard 가드를 핸들러(tx 밖)에 두면 "가드 SELECT 통과 → 새 run INSERT 커밋 → cascade가 그 pending run 행을 삭제 → 워커는 run 행 없이 부하 발사(메트릭 ingest FK 실패는 warn-only)"라는 **silent 좀비-부하 윈도**가 생긴다. 그래서 권위 가드를 `delete_cascade` 트랜잭션 **안**으로(R2/R4): ① tx 시작 후 삽입된 run은 in-tx EXISTS가 본다(→409) ② EXISTS와 DELETE 사이에 끼어드는 동시 쓰기는 SQLite WAL에서 busy/snapshot 에러로 tx 실패(→500, fail-loud — deferred BEGIN 특성, 수용) ③ cascade 커밋 *후*의 스케줄러 tick·`POST /api/runs`는 `scenarios` 행이 없어 `runs` INSERT가 FK로 실패 → 기존 tick 에러 경로 로깅(spawn 실패 → `errored`+`mark_outcome`), 다음 tick엔 스케줄 행도 소멸. 별도 락 불요.

## 4. 변경 상세

### 4.1 `crates/controller/src/app.rs` — 충족 R: R1
`/scenarios/{id}` 라우트에 `.delete(scenarios_api::delete)` 체인.

### 4.2 `crates/controller/src/api/scenarios.rs` — 충족 R: R1, R2, R3
`DeleteQuery{force: bool}`(datasets 미러, `#[serde(default)]`) + `delete(State, Path, Query)` 핸들러: 존재 확인(404) → soft 가드(force=false && 카운트 합>0 → `ApiError::ConflictJson`) → `store::scenarios::delete_cascade` 호출, 활성-run 구분 에러면 `ApiError::Conflict`(409)로 매핑 → 204. hard 가드의 권위 판정은 핸들러가 아니라 in-tx(§4.3 — 단일 권위 지점). 에러 문구는 datasets 관용구대로 핸들러 내 한국어 리터럴(백엔드는 ko.ts 범위 밖).

### 4.3 `crates/controller/src/store/scenarios.rs`(+ 카운트 헬퍼) — 충족 R: R2, R3, R4
`delete_cascade(db, id)` — `db.begin()` 트랜잭션: ① `SELECT EXISTS(… runs WHERE scenario_id=? AND status IN ('pending','running'))` — true면 롤백 + 활성-run 구분 에러 반환 ② §R4 순서 삭제 → 커밋. 카운트 쿼리(`runs`/`run_presets`/`schedules` per scenario_id)는 소속 store 모듈에 배치. `0005_run_presets.sql`의 "FK CASCADE 추가해야" 주석을 app-레벨 cascade 채택으로 갱신(주석-only, R11).

### 4.4 `ui/src/api/client.ts` + `ui/src/api/hooks.ts` — 충족 R: R5
`DeleteScenarioResult = {deleted:true} | {deleted:false, refs:{runs:number, presets:number, schedules:number}}` + `deleteScenarioImpl`(bespoke fetch — soft 409 판별은 `typeof body.runs === "number"`) + `useDeleteScenario`.

### 4.5 `ui/src/pages/ScenarioListPage.tsx` — 충족 R: R6, R10
행 액션 삭제 버튼 + 2단 confirm 흐름 + `role="alert"` 배너(복제-실패 배너 자리 공유 또는 인접 — 동일 관용구).

### 4.6 `ui/src/pages/ScenarioEditPage.tsx` — 충족 R: R7, R8, R9, R10
- `liveName` 도출 + h2/브레드크럼 교체.
- 연필 버튼 + 인라인 input(로컬 draft state, ExtractEditor 커밋 관용구 — Enter/blur 커밋·Escape revert·빈값 revert).
- 선적재 시드 effect + `EditorShell` 마운트 게이트 + `baselineSeededRef` 제거.

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R10
삭제 confirm 2종(함수 키 — 이름/카운트 보간)·삭제-실패 배너 프리픽스·삭제 버튼 라벨·연필 aria-label/title·이름 input aria-label 등 신규 키(서버 발신 에러 본문은 passthrough — R10).

### 4.8 `docs/adr/0045-scenario-delete-policy.md` (신규) — 결정 기록
시나리오 삭제 정책 ADR: 2층 가드(활성 run hard / 참조 카운트 soft+force) + 전체 cascade(run 이력·리포트 포함), soft-delete/아카이브·FK CASCADE 마이그레이션 기각 근거. 루트 CLAUDE.md "알아둘 결정들" 인덱스에 한 줄(마무리 단계).

## 5. 엣지케이스

| # | 케이스 | 판정/처리 |
|---|---|---|
| 1 | 활성 run 존재 + `force=true` | hard 409 우선 — force 무시(R2) |
| 2 | 참조 0(막 만든 시나리오) | 1차 confirm 후 즉시 204(soft 가드 카운트 0 → 통과) |
| 3 | 이미 삭제된 id 재요청(목록 stale·더블클릭) | 404 → UI `ApiError` 배너 + invalidate로 목록 자연 수습 |
| 4 | soft 409 조합(runs만/presets만/schedules만/셋 다) | 서버는 카운트 셋 다 항상 포함(0 포함), UI 확인 문구는 **0인 항목을 생략**해 렌더 |
| 5 | 스케줄러 tick이 삭제 직전 스케줄 로드 / `POST /api/runs` 동시 요청 | 커밋 후엔 run INSERT FK 실패 → tick 에러 로깅·다음 tick 소멸; 커밋 전엔 in-tx 가드(409) 또는 WAL busy/snapshot(500 fail-loud) — silent 경로 없음(§3-5) |
| 6 | cascade 스코프 | 타 시나리오의 run/프리셋/스케줄/메트릭 무손상(R4 테스트 단언) |
| 7 | YAML 깨진 상태(model=null) | 이름 폴백 표시(`data.name`) + 연필 disabled(R7/R8) |
| 8 | 빈/공백-only 이름 커밋 | revert — `min(1)` 갈라짐 방지(R8) |
| 9 | 이름에 따옴표·특수문자 | 기존 `setName` edit 경로(plainScalar quote-style 함정 기처리) — 신규 처리 없음 |
| 10 | 중복 이름으로 rename | 허용 — `scenarios.name`에 UNIQUE 없음(복제가 유니크명을 *생성*하는 건 UX지 제약 아님) |
| 11 | 복제 → `/scenarios/{newId}` navigate | id 변경 → 재시드(R9) — 새 시나리오 YAML로 클린 로드 |
| 12 | 저장 직후 | save 핸들러가 `originalYaml=next.yaml` 세팅(기존) — 재시드 불요, dirty=false |
| 13 | run 상세/비교 화면이 열린 채 타 탭에서 삭제 | GET 404 — RunDetail은 폴링이라 로딩 잔류(알려진 pre-existing 클래스, ui/CLAUDE.md "폴링 쿼리 404" 노트) — 비목표(§7) |

## 6. 라이브 검증 (머지 전 필수 — R12)

`/live-verify` 스택(워크트리 자체 바이너리 + 격리 DB + vite dev)에서:

1. **삭제 왕복**: 시나리오 생성 → run 1회 실행(이력) + 프리셋 1개 + 스케줄 1개 부착 → UI 목록에서 삭제 클릭 → 1차 confirm → **soft 409 요약 confirm**(카운트 문구 실측) → force 재요청 → 목록에서 소멸 + DB 잔존 0행(`sqlite3`로 6메트릭+runs+presets+schedules 카운트) 확인.
2. **hard 409**: 장시간 run 실행 중 삭제 시도 → 배너 문구 실측(force 경로 진입 불가).
3. **이름**: YAML 모달에서 `name:` 변경 → 헤더/브레드크럼 즉시 갱신 실측 → 연필 인라인 편집(커밋·Escape·빈값 revert) → 저장 → 목록/헤더 서버 반영.
4. **false-dirty**: 에디터 진입 직후 저장 버튼 **비활성**(현재 버그의 역-단언) → 편집 시 활성 → 저장 후 비활성.

## 7. 비목표

- 시나리오 soft-delete/아카이브·휴지통(기각 — §사용자 결정).
- 에디터 페이지 삭제 버튼(진입점은 목록만).
- 키보드 외 접근성 향상·이름 편집의 별도 서버 API(이름은 YAML 소유 — 저장 경로 유일).
- UI 검증 false-green(assert 맵 통과) 강화 — 별도 후속(§사용자 결정 ③).
- 삭제 undo·감사 로그(§B1 트랙), RunDetail 폴링-404 처리(엣지 #13).
