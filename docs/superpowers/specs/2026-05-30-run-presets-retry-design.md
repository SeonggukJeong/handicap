# Run 프리셋 + Retry 설계 (영역 A)

* Status: A1 (Retry) 구현 완료 (2026-05-31). A2 (프리셋 CRUD) 미착수. (brainstorming + spec-plan-review 반영)
* Date: 2026-05-30 (개정 2026-05-31)
* 관련 ADR: ADR-0013(Scenario↔Run config 분리), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0011(SQLite 저장소), ADR-0022(data-driven 바인딩)
* 후속 ADR: 구현 시 새 ADR 추가 (run 프리셋 = 독립 리소스 결정, 다음 가용 번호)

## 1. 개요 · 목표

**문제**: run 을 한 번 돌린 뒤 같은 설정으로 다시 돌리려면 RunDialog 의 VUs·duration·ramp-up·loop cap·env 변수·data binding 을 **매번 손으로 다시 입력**해야 한다. 시간 소모가 크고 오타가 난다.

**목표**: run 설정(프로파일 + 변수)을 재사용한다. 두 경로:

1. **과거 run Retry** — 이미 실행했던 임의의 run 을 그 설정 그대로 다시 실행한다. 별도 저장 없이 `runs` 이력을 재사용.
2. **이름 붙인 Run 프리셋** — run 설정 전체(`Profile` + env 맵)를 이름과 함께 시나리오 하위에 저장하고, RunDialog 에서 골라 한 번에 채운다. retry 의 큐레이트 버전.

**핵심 결정** (brainstorming + spec-review 확정):

- **저장 단위 = run 설정 전체** (변수 + VUs/duration/ramp/loop cap/data binding).
- **프리셋 = 시나리오별(scenario-scoped)**. `data_binding`·`loop_breakdown_cap`·env 가 전부 시나리오 종속.
- **구현 = 별도 `run_presets` 테이블 + 1급 REST 리소스**. retry 는 신규 저장 없이 기존 `runs` 행을 읽는다.
- **두 하위 슬라이스로 분할**(§8): **A1 = Retry**(DB 변경 0, RunDialog prefill 이음새 구축), **A2 = 프리셋 CRUD**(A1 의 검증된 prefill 경로 위에 빌드). prefill 리팩터·검증 게이트 추출이라는 두 엔지니어링 리스크를 분리한다.
- 영역 B(글로벌 변수)·시나리오 복제는 별도 spec(§9).

**기존 코드 사실 확인** (spec-review 로 코드 대조 검증 완료):

- ✅ `GET /api/runs/{id}` 응답이 **이미 `profile`+`env` 를 JSON 본문에 포함**한다. 핸들러 `get` 가 `Json(to_response(row))` 반환(`crates/controller/src/api/runs.rs:172`), `RunResponse` DTO(`runs.rs:19-30`)에 `pub profile: Profile`·`pub env: serde_json::Value`, `to_response` 가 복사(`runs.rs:259-271`). store leak 아님. UI Zod `RunSchema` 도 이미 파싱. → **retry prefill 은 신규 엔드포인트·저장 0개**.
- ✅ **시나리오 DELETE 엔드포인트 없음** (`/scenarios/{id}` 는 get/put 만, `app.rs:34-36`; `store/scenarios.rs` 에 delete 함수 없음). → 프리셋 고아화 경로 없음, cascade 불필요. **단 §2 의 FK 결합 주석 참조** — 미래 scenario-delete spec 이 추가되면 그때 presets 에 `ON DELETE CASCADE` 필요.
- ✅ `/scenarios/{id}/runs` 라우팅 존재(`app.rs:38`). `api` 라우터는 `/api` 하위 nest(`app.rs:59`) → `/api/scenarios/{id}/presets` 경로 맞음.
- ✅ `scenario_yaml` 은 **현재 `GET /api/runs/{id}` 응답에 없다** (`RunRow.scenario_yaml` 은 있으나 `to_response`·`RunResponse` 가 제외, `runs.rs:19-30,259-271`). report 응답엔 있으나 terminal run 전용. → §4 경고용으로 **추가 필요**.
- ✅ 최고 마이그레이션 = 0004 → 신규 0005. `connect()` 가 각 마이그레이션을 `include_str!` + 순차 execute(`store/mod.rs:23-26,41-51`). → **0005 SQL 파일 + `connect()` 등록 라인 둘 다** 필요(파일만 두면 동작 안 함).
- ⚠️ run-create 검증 게이트(`runs.rs:43-98`)는 **PendingDataBinding 해석과 얽혀** 있음(§3 참조).

## 2. 데이터 모델 — migration 0005 (A2)

`crates/controller/src/store/migrations/0005_run_presets.sql`:

```sql
CREATE TABLE IF NOT EXISTS run_presets (
    id           TEXT PRIMARY KEY,                       -- ULID (Crockford base32)
    scenario_id  TEXT NOT NULL REFERENCES scenarios(id), -- cascade 생략: §1 FK 결합 주석
    name         TEXT NOT NULL,
    profile_json TEXT NOT NULL,    -- runs.profile_json 과 동일 직렬화 (Profile)
    env_json     TEXT NOT NULL,    -- map<string,string> JSON (§5 env 제약 참조)
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_presets_scenario_name
    ON run_presets(scenario_id, name);
```

- **`UNIQUE(scenario_id, name)`** (결정 #11) — 같은 시나리오 안에서 이름 유일. 드롭다운이 이름으로 명확히 구분되고, 같은 이름 저장 = 업서트(덮어쓰기) 흐름이 자연스러움. `CREATE UNIQUE INDEX IF NOT EXISTS` 로 멱등 유지.
- 기존 `Profile` 구조체(`store/runs.rs:45-54`)+env 직렬화를 **그대로 재사용** → 신규 serde 타입 0개. `#[serde(default)]` 진화 패턴 자동 상속.
- **마이그레이션 등록**: `store/mod.rs` 에 `const MIGRATION_SQL_0005 = include_str!(...)` 추가 + `connect()` 의 순차 execute 목록에 한 줄 추가(0003/0004 패턴). SQL 파일만으로는 적용 안 됨.
- **FK 결합 주석**(spec-review #16): pool 이 `foreign_keys(true)`(`store/mod.rs:36`). 지금은 scenario 삭제가 없어 cascade 불필요하나, 미래 scenario-delete(§9, roadmap 후보) 추가 시 그 spec 이 presets 에 `ON DELETE CASCADE` 를 더해야 FK 위반이 안 난다 — 마이그레이션 주석에 명시.
- 저장소 모듈 `crates/controller/src/store/presets.rs`: `insert`(ULID 는 `ulid::Ulid::new().to_string()` — `runs.rs:76` 와 동일, 클라이언트 생성/UUID 금지), `get`, `list_by_scenario`, `upsert_or_update`, `delete`. `PresetRow { id, scenario_id, name, profile: Profile, env: serde_json::Value, created_at, updated_at }`.

## 3. REST API (A2) — 신규 `crates/controller/src/api/presets.rs`

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/scenarios/{id}/presets` | 생성. body `{ name, profile, env }`. **검증 전용 함수 호출**(아래). 같은 이름 존재 시 409(또는 업서트 — §UI 가 명시적 덮어쓰기로 처리). 201 + 생성 결과. |
| GET | `/api/scenarios/{id}/presets` | 목록 (id, name, vus/duration 요약, created_at/updated_at). |
| GET | `/api/presets/{id}` | 전체(profile+env). prefill·인라인 rename 의 선행 GET 용. |
| PUT | `/api/presets/{id}` | full-body 덮어쓰기 `{ name, profile, env }`. 검증 재적용. |
| DELETE | `/api/presets/{id}` | 삭제. 204. |

라우팅: `app.rs` 에 `/scenarios/{id}/presets`(POST/GET), `/presets/{id}`(GET/PUT/DELETE) 추가.

**검증 게이트 추출**(spec-review #6 — "함수 추출"의 정확한 형태):
현재 `runs::create` 의 검증은 `validated_binding` 블록(`runs.rs:58-98`)이 `Some((b, meta))` 를 반환해 해석 블록(`runs.rs:121-145`)이 `meta` 로 `PendingDataBinding`(seed=`row.id`, 슬라이싱)을 만드는 데 **재사용**된다(TOCTOU 회피, `crates/controller/CLAUDE.md`). 프리셋 저장 경로엔 `row.id` 가 없고 `PendingDataBinding` 도 필요 없다. 따라서:
- **검증 전용 함수**를 분리: `async fn validate_run_config(state: &AppState, scenario_id: &str, profile: &Profile) -> Result<(), ApiError>` — vus/duration ≥ 1, `loop_cap_ok`, binding 검증(데이터셋 존재·컬럼 매핑·`iter_*` 시 `state.dataset_max_rows` 초과). DB 접근(`store::datasets::get_meta`)·`state.dataset_max_rows` 가 필요하므로 **`&AppState` 를 받는다**(단순 `(scenario_id, profile)` 아님).
- `PendingDataBinding` 해석(seed/슬라이싱)은 **`runs::create` 에만** 남긴다. `runs::create` 는 `validate_run_config` 호출 후 meta 를 다시 들고 와 해석(또는 validate 가 meta 를 옵션 반환하도록 살짝 조정 — 단 presets 경로는 meta 를 무시).

**PUT vs 인라인 rename**(spec-review #12): 목록 응답엔 profile+env 전체가 없으므로(요약만) 인라인 rename 은 full-body PUT 을 안전하게 못 만든다. → **인라인 rename UX = 먼저 `GET /presets/{id}` 로 전체를 받아 name 만 바꿔 PUT**. 별도 PATCH 엔드포인트 추가 안 함(엔드포인트 최소화).

**프리셋으로 run 실행 = 신규 엔드포인트 없음**: UI 가 프리셋(또는 과거 run)을 로드 → RunDialog 채움 → 기존 `POST /api/runs` 제출. 기존 검증 게이트가 그대로 재적용.

**데이터셋 DELETE 가드 확장**(spec-review #14, 결정): 데이터셋 DELETE(`api/datasets.rs`, `datasets_api::delete`)는 현재 진행중/대기 run 만 `runs::dataset_in_use` 로 hard 409. 프리셋 참조는 **invisible**. → soft 가드 추가:
- 진행중/대기 run 참조 → **hard 409**(기존 유지).
- 프리셋만 참조(active run 없음) → **soft 409 + 참조 프리셋 목록 본문**, `?force=true` 쿼리로 override 시 삭제 허용. (`store/presets.rs::referencing_dataset(dataset_id) -> Vec<{preset_id, name, scenario_id}>` 추가.)
- UI: soft 409 받으면 "N개 프리셋이 이 데이터셋을 참조 중 — 그래도 삭제?" 확인 → 승인 시 `?force=true` 재요청.

## 4. Retry (A1) — 신규 저장 0

`runs` 행이 이미 `profile`+`env`+`scenario_yaml` 보유. retry 는 그것을 읽어 재사용.

- run 목록(`/scenarios/{id}/runs`)·run 상세에 두 진입점:
  - **"다시 실행"**(기본) → 그 run 의 profile+env 로 **RunDialog prefill(편집 가능)**(§5 prefill 이음새). 확인/수정 후 기존 `POST /api/runs` 제출.
  - **"동일 설정 즉시 재실행"**(빠름) → 그 run 의 profile+env 로 곧장 `POST /api/runs`. 검증 실패(시나리오 변경 등) 시 에러 토스트.
- **시나리오 변경 경고**: `GET /api/runs/{id}` 응답에 **`scenario_yaml` 필드 추가**(`RunResponse` + `to_response` + UI `RunSchema`). run 의 스냅샷 ≠ 현재 라이브 시나리오 YAML 이면 prefill/즉시재실행 시 경고 배지("이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있음"). (이 경고는 **run retry 전용** — 프리셋은 스냅샷이 없다, §6 참조.)

## 5. UI

**RunDialog prefill 이음새 구축**(A1, spec-review #8 — 현재 prefill 경로 없음):
- 현재 RunDialog props = `{ scenarioId, hasLoop, scenario, onCreated, onCancel }`, 모든 폼값이 하드코딩 `useState`(`vus=2,duration=5,rampUp=0,loopCap=256,envEntries=[],binding=null`, `RunDialog.tsx:24-32`).
- **신규 prop `initial?: { profile: Profile; env: Record<string,string> }`** 추가, 각 `useState` 를 `initial` 로 시드. `initial` 변경 시 재시드(retry/프리셋 전환 반영).
- **env 디코드**(spec-review #9): 저장된 env 는 `serde_json::Value`, 폼은 `{key,value}[]`. prefill 시 Value→entries 디코드. **비문자열 값은 백엔드가 어차피 silent drop**(`runs.rs:111-116`) 하므로, 프리셋/run env 를 **API 경계에서 `map<string,string>` 로 제약·정규화**(비문자열 거부 또는 문자열화). UI Zod 도 `z.record(z.string())` 로 좁힘.
- **DataBindingPanel 재수화**(spec-review #8 의 난점): 패널은 `scenario` 기반 내부 상태 + `onChange={setBinding}`(`RunDialog.tsx:199-204`). 저장된 `data_binding` 을 패널 UI 에 주입하려면 패널에 `initialBinding?` prop 추가 + 시나리오의 현재 `{{var}}`(`scanFlowVars`)에 대해 **로드 시 재검증**(아래 §6 stale 매핑). 또는 `key={presetId}` remount.
- **`data_binding` null/undefined 처리**(spec-review #10): `ProfileSchema.data_binding` 은 `.nullish()`, 페이로드는 `binding ?? undefined`. 프리셋 GET 이 `data_binding: null` 을 줄 수 있으므로 `PresetSchema`(ProfileSchema 재사용)가 null↔undefined↔missing 삼분기를 일관 처리. `pnpm build`(`tsc -b`)가 최종 게이트(CLAUDE.md "Zod default 누출"/discriminated union).

**RunDialog 프리셋 관리**(A2): 상단 "프리셋 불러오기" 드롭다운(선택 시 위 prefill 경로로 전 폼 채움) + "프리셋으로 저장"(이름 입력 → POST; 같은 이름이면 덮어쓰기 확인) + 항목별 삭제 / 이름변경(rename = GET 후 name 만 바꿔 PUT, §3).

**Run 상세**(A1 버튼 + A2 저장): "다시 실행" + "동일 설정 즉시 재실행" + "이 run 설정을 프리셋으로 저장"(완료 run 의 profile+env 를 이름 붙여 POST — 두 번째 저장 진입점).

**클라이언트**: presets CRUD React Query 훅(기존 dataset 클라이언트 패턴 `ui/src/api/`). `PresetSchema { id, name, profile, env, created_at, updated_at }`(기존 `ProfileSchema`/`DataBindingSchema` 재사용).

## 6. 검증 · 엣지 케이스

- **검증 = save-time + run-create 이중**(spec-review #7): `validate_run_config` 가 프리셋 저장 시 명백한 오류(미구현 `unique` 정책·없는 데이터셋·빈 데이터셋·없는 컬럼·loop cap 0..=10000·vus/duration<1)를 잡는다. 단 이는 **저장 시점 보장일 뿐 영구 launchable 보장이 아니다** — 데이터셋이 나중에 삭제될 수 있다(§3). **실행 시점의 `POST /api/runs` 게이트가 권위 있는 최종 방어.**
- **프리셋은 라이브 시나리오 추종(스냅샷 없음)**(spec-review #13/#15 결정): 프리셋은 `scenario_yaml` 을 저장하지 않는다 — 의도적으로 현재 시나리오를 따라간다. 따라서 run retry 의 "시나리오 변경 경고"는 프리셋엔 없다. 대신:
  - 프리셋 **로드 시 DataBindingPanel 이 현재 `{{var}}`/컬럼에 대해 재검증** → 사라진 변수/컬럼을 참조하는 매핑을 **stale 로 하이라이트**(저장은 됐지만 지금은 못 씀을 즉시 표시). 최종은 run-create 400.
  - 프리셋의 `data_binding.dataset_id` 가 **삭제된 데이터셋**이면(§3 force 삭제 경로) 로드 시 **"이 프리셋의 데이터셋이 삭제됨" 알림**(결정 #14).
- **이름**: trim 후 비어있지 않음(빈 이름 400). `UNIQUE(scenario_id,name)` 위반 → 409(UI 는 덮어쓰기 확인으로 유도).
- **env 평문 저장**: 현재 `runs.env_json` 과 동일(민감값 마스킹은 기존 후속, 범위 밖).
- **빈 env / no binding**: 정상, byte-identical.
- **프리셋 0개**: 드롭다운 빈 상태 표시.

## 7. 테스트 전략 (TDD)

**A1 (Rust)**: `GET /api/runs/{id}` 응답에 `scenario_yaml` 포함 통합 테스트.
**A1 (UI, RTL+vitest)**: RunDialog `initial` prop → 전 폼 필드 시드(vus/duration/ramp/loopcap/env entries/binding); env Value→entries 디코드(비문자열 drop); RunDetail "다시 실행" → prefill; scenario_yaml 불일치 시 경고 배지.

**A2 (Rust)**: `store/presets.rs` insert→get→list→update→delete + UNIQUE(scenario_id,name) 위반 409; Profile/env JSON round-trip; `validate_run_config` 단위(잘못된 binding/loop cap/빈 이름); API 통합(생성→목록→GET→그 profile+env 로 `POST /api/runs` 200); 데이터셋 DELETE soft 가드(프리셋 참조 시 409, `?force=true` 삭제); migration 0005 멱등 + `connect()` 적용 확인.
**A2 (UI)**: 프리셋 불러오기 → 폼 채움; "프리셋으로 저장" POST; DataBindingPanel 재수화 + stale 매핑 하이라이트; 삭제된 데이터셋 프리셋 로드 알림; PresetSchema round-trip + `data_binding` null 처리(`pnpm build` 통과).

## 8. 하위 슬라이스 분할

리뷰 권장에 따라 두 plan 으로 나눈다(각자 `docs/superpowers/plans/`).

**A1 — Retry** (DB 변경 0, 고가치·저위험 절반):
- `RunResponse` + `to_response` + UI `RunSchema` 에 `scenario_yaml` 추가.
- RunDialog `initial` prop + env Value→entries 디코드 + DataBindingPanel `initialBinding` 재수화 (prefill 이음새 — A2 가 재사용).
- env 를 `map<string,string>` 로 제약(API + Zod).
- RunDetail "다시 실행"/"즉시 재실행" 버튼 + 시나리오 변경 경고.
- 목적: **DB 무변경 diff 로 prefill 리팩터(#8)를 먼저 검증**, A2 의 기반 마련.
- **구현 계획**: `docs/superpowers/plans/2026-05-31-area-a1-run-retry.md` (7 tasks, DB 무변경). **구현 완료 2026-05-31** — commit `b7e362a`(controller)…`82427a9`(run-detail), 7개 커밋.

**A2 — Run 프리셋 CRUD** (A1 위에 빌드):
- migration 0005(`run_presets`, UNIQUE index) + `connect()` 등록 + `store/presets.rs`.
- `validate_run_config` 추출(#6) + `api/presets.rs` CRUD + 라우팅.
- 데이터셋 DELETE soft 가드 확장(#14) + `presets::referencing_dataset`.
- RunDialog 프리셋 드롭다운/저장/삭제/rename + RunDetail "프리셋으로 저장".

## 9. 범위 밖 · 후속 (별도 spec)

- **시나리오 복제** — retry 가 변경된 시나리오에서 실패하는 상황의 보강책으로 제기됐으나 **시나리오 관리** 기능(scenarios CRUD/UI)이라 별도 spec. `docs/roadmap.md` B2′ 에 기록.
- **영역 B — 글로벌 변수**(BASE_URL 등 전역 등록). 별도 데이터 모델·UX → 별도 spec. roadmap A6.
- **민감값 마스킹**(기존 후속).
- **cross-scenario 전역 프리셋**(현재 scenario-scoped 만).
