# 글로벌 변수 = 환경(Environments) 설계 (영역 B)

* Status: 구현 중 — B-1(환경 리소스 + 관리 UI) 완료 / B-2(RunDialog 오버레이) 예정. ADR-0025.
* Date: 2026-05-31
* 관련 ADR: ADR-0013(Scenario↔Run config 분리), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0011(SQLite 저장소), ADR-0024(run 프리셋 = scenario-scoped 독립 리소스), ADR-0025(환경 리소스 결정 기록)
* 후속 ADR: ADR-0025 (환경 = env-namespace 전용 top-level 재사용 리소스 + 클라이언트 오버레이 스냅샷)
* 로드맵: `docs/roadmap.md` §A6 (영역 B — 글로벌 변수). 영역 A(run 프리셋 + retry)의 자매 기능.

## 1. 개요 · 목표

**문제**: `BASE_URL`·인증 호스트·API 키처럼 **여러 시나리오에서 반복 사용**하는 env 값을, run 을 돌릴 때마다 RunDialog 의 env 입력창에 **매번 손으로 다시 입력**해야 한다. 영역 A(run 프리셋)는 *한 시나리오 안*에서 설정 재사용을 풀었지만, **시나리오를 가로지르는 env 값 재사용**은 여전히 통증으로 남는다.

**목표**: 자주 쓰는 env 값을 **이름 붙은 환경(environment)** 으로 한 번 등록해 두고, 아무 시나리오의 run 에서나 골라 주입한다. `prod`/`staging`/`local` 처럼 환경을 전환하면 그 환경의 env 한 묶음이 통째로 채워진다.

**핵심 결정** (brainstorming 2026-05-31 확정):

- **스코프 = env 네임스페이스(`${ENV}`)만.** `{{var}}` 흐름 변수(extract/dataset/`scenario.variables`)는 시나리오 authoring 관심사라 범위 밖(§8). `BASE_URL` 통증과 정확히 일치하고, env 는 이미 run-time 주입이라 시나리오를 안 건드린다.
- **모델 = 이름 붙은 환경(named environments).** 각 환경 = `name` + `{key: value}` env 묶음. 플랫 단일값 라이브러리(환경 전환 시 매번 값 편집 필요)보다 "시나리오별 다른 `BASE_URL`" 을 자연스럽게 표현.
- **환경 = top-level(cross-scenario) 독립 리소스.** 환경은 본질적으로 시나리오를 가로지른다(`prod` 는 모든 시나리오 공용). 프리셋(scenario-scoped, ADR-0024)과 달리 scenario-scoped 아님.
- **오버레이 = 클라이언트 병합 + 스냅샷.** 선택한 환경 = base 레이어, RunDialog 의 기존 env 입력창 = override 레이어. 우선순위 **`환경 vars < per-run env 입력`**. RunDialog 가 **클라이언트에서 병합**해 기존 `POST /api/runs` 의 평탄 `env` 맵으로 제출 → run-create 계약 **무변경**. run/preset 은 **해석된 값을 스냅샷**으로 저장(환경을 나중에 수정해도 과거 run/preset 불변).
- **참조 가드 불필요.** 스냅샷 모델이라 run/preset 이 환경을 `environment_id` 로 참조하지 않는다 → 환경 DELETE 는 무가드(데이터셋 delete soft-guard 같은 게 필요 없음).
- **선택 위치(v1) = RunDialog 만.** 시나리오별 "기본 환경" 기억은 영역 A 프리셋(scenario-scoped, env 해석값 저장)이 이미 커버. ADR-0013(env = run config) 존중.
- **확장성**: 추후 "시나리오 수정 화면에서 환경 선택 → 시나리오 1회 test-run" 기능이 들어올 예정(§7). v1 의 환경 선택 컴포넌트 + env 병합 유틸을 **RunDialog 와 분리된 재사용 단위**로 만들어, 그 기능이 그대로 끌어 쓰게 한다.

**기존 코드 사실 확인** (구현 전 코드 대조):

- ✅ **env 는 이미 run-time 주입, 시나리오 YAML 밖.** 엔진 `template.rs::render` 가 `${NAME}`/`${NAME:-default}` 를 `TemplateContext.env`(`BTreeMap<String,String>`) 로 해석(`crates/engine/src/template.rs:22,115-123`). `${vu_id}`/`${iter_id}`/`${loop_index}` 시스템 변수도 같은 `${...}` 문법이지만 예약어라 환경 키와 충돌 안 함(§5 키 제약 참조).
- ✅ **run-create env 계약 존재(영역 A1).** `CreateRunRequest.env: HashMap<String,String>`(비문자열 env→422), `RunResponse` 가 `env: serde_json::Value` 노출. RunDialog 가 평탄 `env` 맵을 제출. → 환경 오버레이는 이 평탄 맵 **클라이언트 병합 결과**를 그대로 제출, 백엔드 무변경.
- ✅ **RunDialog env 입력창 존재.** `envEntries: EnvEntry[]`(`{key,value}`) 상태 + 행 추가/편집/삭제 + `aria-label="Environment variables"` 섹션(`ui/src/components/RunDialog.tsx:40,55-56,305+`). → 이 입력창이 **override 레이어**가 되고, 환경 dropdown 이 그 위에 붙는다.
- ✅ **재사용 가능한 env 헬퍼 선례.** `ui/src/api/runPrefill.ts` 가 `envValueToRecord`/`normalizeProfile`/`RunPrefill` 을 RunDialog·RunDetail 공유 유틸로 분리. → `resolveEnv` 병합 유틸도 같은 자리/패턴.
- ✅ **CRUD 페이지 + 클라이언트 선례.** `ui/src/pages/DatasetsPage.tsx`(목록/생성/삭제), `ui/src/api/presets.ts`(스키마+bare-fetch 클라이언트+React Query 훅). → `EnvironmentsPage`/`api/environments.ts` 가 그대로 미러.
- ✅ **마이그레이션 등록 패턴.** `store/mod.rs` 가 `const MIGRATION_SQL_000N = include_str!(...)`(`:24-28`) + `connect()` 의 순차 `.execute()`(`:43-54`). 최고 = 0005 → 신규 **0006**. **SQL 파일 + const + execute 라인 셋 다** 필요(파일만 두면 적용 안 됨 — 영역 A2 0005 교훈).
- ✅ **라우팅 패턴.** `app.rs` 가 라우트를 빌드 후 `.nest("/api", api)`(`:71`). presets `/scenarios/{id}/presets`·`/presets/{id}`(`:60-69`), datasets `/datasets`·`/datasets/{id}`(`:46-59`). → `/environments`·`/environments/{id}` 추가. **주의(파일 위치 분리, 리뷰 I-2)**: `pub mod environments;` 는 `api/mod.rs`(`:1-4` 의 `pub mod` 목록)에, 별칭 import `environments as environments_api` 는 **`app.rs`**(`:8-10` 의 `datasets as datasets_api, presets as presets_api, …` 목록)에 추가 — 두 줄이 서로 다른 파일이다.

## 2. 데이터 모델 — migration 0006 (신규)

`crates/controller/src/store/migrations/0006_environments.sql`:

```sql
CREATE TABLE IF NOT EXISTS environments (
    id          TEXT PRIMARY KEY,   -- ULID (Crockford base32)
    name        TEXT NOT NULL,
    vars_json   TEXT NOT NULL,      -- map<string,string> JSON
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_name ON environments(name);
```

- **`UNIQUE(name)`** — 환경은 top-level 이라 이름 전역 유일. dropdown 이 이름으로 구분. **중복 이름 POST = 409(덮어쓰기 아님, 리뷰 I-3)**, 편집은 `PUT /{id}`(presets `map_db_err` 와 동일 — **upsert 안 함**). UI 는 이름 충돌 시 자동 덮어쓰기를 하지 않고 "이미 존재하는 이름" 으로 409 를 안내. `CREATE UNIQUE INDEX IF NOT EXISTS` 로 멱등.
- **scenario_id 컬럼 없음** — 환경은 cross-scenario(프리셋과 다름).
- **FK 없음** — 어떤 시나리오·run·preset 도 참조 안 함(스냅샷 모델).
- **마이그레이션 등록**: `store/mod.rs` 에 `const MIGRATION_SQL_0006 = include_str!("migrations/0006_environments.sql")` 추가 + `connect()` 의 `.execute()` 목록에 한 줄(0005 뒤). `pub mod environments;` 도 추가.
- **저장소 모듈** `crates/controller/src/store/environments.rs`: `insert`(ULID = `ulid::Ulid::new().to_string()`, 서버 생성 — 클라이언트/UUID 금지, `runs.rs`/`presets.rs` 와 동일), `get`, `list`, `update`, `delete`. `EnvironmentRow { id, name, vars: serde_json::Value (또는 BTreeMap<String,String>), created_at, updated_at }`. **`referencing_*`·delete-guard 없음** — 참조하는 리소스가 없으므로(데이터셋 8c→A2 soft-guard 패턴 불필요).

## 3. REST API — 신규 `crates/controller/src/api/environments.rs`

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/environments` | 생성. body `{ name, vars }`. 이름 trim 비어있지 않음, 키 검증(§5). UNIQUE(name) 위반 → 409. 201 + 생성 결과. |
| GET | `/api/environments` | 목록 (id, name, var 개수, created_at/updated_at). |
| GET | `/api/environments/{id}` | 전체 (vars 맵 포함). RunDialog 선택 시 base 채우기·편집 선행 GET. |
| PUT | `/api/environments/{id}` | full-body 덮어쓰기 `{ name, vars }`. 검증 재적용. UNIQUE(name) 위반 → 409. |
| DELETE | `/api/environments/{id}` | 삭제. 204. **무가드** — 참조 리소스 없음. |

- 라우팅: `app.rs` 에 `/environments`(POST/GET), `/environments/{id}`(GET/PUT/DELETE) 추가. `api/mod.rs` 에 `pub mod environments;` 추가; 별칭 `environments as environments_api` 는 **`app.rs` 의 import 목록**에 추가(§1 주의 — `api/mod.rs` 아님).
- DTO: `EnvironmentBody { name: String, vars: BTreeMap<String,String> }`, `EnvironmentResponse { id, name, vars, created_at, updated_at }`, `EnvironmentSummary { id, name, var_count, created_at, updated_at }`. UNIQUE 위반 → 409 매핑(presets `map_db_err` 패턴 재사용).
- **`POST /api/runs` 무변경** — env 는 평탄 `map<string,string>` 그대로. 환경 병합은 클라이언트(§4).

## 4. UI

**환경 관리 페이지** (`ui/src/api/environments.ts` + `ui/src/pages/EnvironmentsPage.tsx`):

- `environments.ts`: `EnvironmentSchema`(`{id, name, vars: z.record(z.string()), created_at, updated_at}`)·`EnvironmentSummarySchema` + bare-fetch 클라이언트(create/list/get/update/delete) + React Query 훅(`useEnvironments`/`useEnvironment`/`useCreateEnvironment`/`useUpdateEnvironment`/`useDeleteEnvironment`). `presets.ts` 패턴 미러.
- `EnvironmentsPage.tsx`: 목록 + 생성/편집(name + `{key,value}` 행 추가/편집/삭제) + 삭제. `DatasetsPage.tsx` 미러. **두 곳 다 등록(M-3)**: 라우트는 `ui/src/routes.tsx`(`createBrowserRouter([...])` 의 라우트 객체 목록)에 `/environments`, 네비 링크는 `ui/src/components/Layout.tsx`(`<Link to="/datasets">` 옆)에 `<Link to="/environments">` — 하나만 하면 페이지 도달 불가 또는 링크 부재.
- **캐시 무효화(M-5)**: `useCreate/Update/DeleteEnvironment` 는 성공 시 `queryKeys.environments()`(+ 해당 `environment(id)`) 무효화 — `useCreatePreset`/`useDeletePreset` 선례(`hooks.ts`).

**RunDialog 환경 선택 + 오버레이**:

- Env 섹션 상단에 **환경 dropdown** 추가. 옵션 = "(없음)" + 환경 이름들. 기본 = 없음.
- **레이어드 상태**: `selectedEnvId: string | null`(신규) + 기존 `envEntries: EnvEntry[]`(이제 **override 레이어**, 기존 UI 무변경).
- **렌더링(base 편집 불가 + override 시드 — 리뷰 I-4)**: 환경 선택 시 그 vars 를 **읽기 전용 base 리스트**로 표시("from `staging`" 라벨). 그 아래 기존 편집 가능한 override 리스트(`envEntries`). base 행은 직접 편집하지 않는다 — 대신 각 base 행에 **"override" 버튼** → 그 key(+현재 value)로 override 항목을 시드하고 거기서 편집. base 값을 영구히 바꾸려면 Environments 페이지에서 환경 자체를 수정.
- **key 충돌 표시**: override key 가 base key 와 같으면 base 행은 "재정의됨"(취소선/회색), override 행은 "BASE_URL 재정의" 로 표시.
- **병합·제출**: `resolveEnv(selectedEnv?.vars ?? {}, envEntries)` = `{ ...base, ...overridesRecord }`(override 승; override 리스트 내 중복 key 는 마지막 승 — 현재 제출 루프 `env[k]=value` 와 동일, `RunDialog.tsx:121-125`). 결과를 기존 평탄 `env` 맵으로 제출 → **스냅샷**.
- **환경 전환(E→E2)**: base 만 교체, `envEntries`(override)는 그대로 유지. 새 base 에 없는 override key 는 그냥 일반 env 값으로 계속 적용(고아 문제 없음 — override 는 base 유무와 무관하게 항상 `resolveEnv` 에 포함).
- **prefill 상호작용**: 프리셋/retry 로 열 때(`initial.env`, 해석된 스냅샷)는 `envEntries`(override)에 그 값을 채우고 환경 = 없음. 즉 **base 없는 override-only** — A1 prefill 경로와 byte-identical(스냅샷이 이미 해석값이라 "override 대상이 없어도" 일관). 양립.

**상호작용 표**:

| 경우 | base(환경) | override(`envEntries`) | 제출 `resolveEnv` |
|---|---|---|---|
| 환경 없음 | — | 사용자 행 | override 만 (= 현재 동작, byte-identical) |
| 환경 선택, override 0 | E.vars(읽기전용) | — | E.vars |
| 환경 + base key override | E.vars(해당 key 재정의 표시) | `{key∈base, value}` | `{…E.vars, key:value}` |
| 환경 + 신규 key override | E.vars | `{key∉base}` | `{…E.vars, newKey:value}` |
| 환경 전환 E→E2 | E2.vars | override 유지 | `{…E2.vars, …overrides}` |
| prefill(프리셋/retry) | — | 해석 스냅샷 | 스냅샷(override-only) |

**와이어프레임**:

```
환경: [ staging ▾ ]
  from staging (읽기전용):
    BASE_URL = https://staging.example     [override]
    API_KEY  = sk-staging-…                [override]
  override (이 run 한정):
    BASE_URL = https://staging-2.example   ✎  ×   (← BASE_URL 재정의)
    [+ key] [+ value] [추가]
```

**재사용 이음새**(§7 확장 대비):

- `resolveEnv(base: Record<string,string>, overrides: EnvEntry[]): Record<string,string>` — 순수 함수, `runPrefill.ts` 헬퍼 옆(또는 `ui/src/api/envOverlay.ts`). override 승.
- `<EnvironmentPicker>` — `selectedEnvId` 보유 + 선택 환경 vars 노출하는 자족 컴포넌트. **RunDialog 와 분리** → 미래 시나리오 에디터 test-run 이 그대로 import.

## 5. 검증 · 엣지 케이스

- **이름**: trim 후 비어있지 않음(빈 이름 400). `UNIQUE(name)` 위반 → 409(UI "이미 존재하는 이름" 안내).
- **var 키**: 비어있지 않은 식별자, 공백·`}` 금지, 그리고 `:-`(엔진 기본값 구분자 — `template.rs:111` `inner.find(":-")`) 포함 금지 — 그래야 `${NAME}` 으로 실제 해석된다. (구현은 보수적으로 `:` 자체를 막아도 됨. 단 정확히는 bare `:`(예 `NS:FOO`, `:-` 아님)는 해석되므로, `:` 전체 금지를 택하면 사유는 "`:-` 회피용 보수 조치" 로 둘 것 — 리뷰 M-2.) 예약 시스템 변수(`vu_id`/`iter_id`/`loop_index`)와 같은 이름은 경고(엔진이 시스템 값으로 우선 해석 → env 값 무시됨, `template.rs:115-123`). v1 은 거부까지는 안 하고 검증 경고만(authoring 친화).
- **검증 위치(리뷰 I-1)**: env 키/이름 검증은 **environments CRUD 엔드포인트**(`POST`/`PUT /api/environments`)에서만 강제된다. **`POST /api/runs` 는 env 를 검증하지 않는다** — `validate_run_config`(`runs.rs:47-100`)는 vus/duration/loop_cap/data_binding 만 보고 env 는 안 본다. 서버측 유일한 env 제약은 axum `Json` 추출기가 비문자열 값을 거부하는 **422 경계**뿐. 따라서 RunDialog 에서 **직접 입력한 override key 는 키 검증을 우회**한다(현재도 RunDialog 는 임의 key 허용, `RunDialog.tsx:122-125`) — 키 검증은 환경 authoring 보조이지 run-create hard gate 가 아니다.
- **var 값**: 문자열만(이미 A1 `CreateRunRequest.env: HashMap<String,String>` + Zod `z.record(z.string())` 가 경계에서 강제. 환경 CRUD 의 `vars: BTreeMap<String,String>` 도 비문자열 값이면 추출 단계 422).
- **빈 환경**(vars 0개): 허용(자리표시). dropdown 에 그대로 노출.
- **환경 삭제**: 자유(참조 없음). 과거 run/preset 은 스냅샷이라 영향 없음(의도된 동작 — 저장된 설정은 저장 시점 값 유지).
- **민감값 마스킹**: 범위 밖(값 평문 저장 = 현재 `runs.env_json` 과 동일. 기존 후속, roadmap B1).

## 6. 테스트 전략 (TDD)

**Rust (controller)**:
- `store/environments.rs` insert→get→list→update→delete + `UNIQUE(name)` 위반 409; vars JSON round-trip.
- migration 0006 멱등(`CREATE … IF NOT EXISTS` 두 번 적용 OK) + `connect()` 가 실제 적용.
- API 통합(`tests/environments_api_test.rs`): 생성→목록→GET→PUT(이름 변경/vars 교체)→DELETE; 중복 이름 409; 빈 이름 400.
- **fixture/ULID(리뷰 M-4)**: 환경 id 는 서버가 생성하므로 클라이언트 ULID 불필요. 단 시나리오/run fixture 가 필요하면 그 ULID 는 Crockford base32(`I`/`L`/`O`/`U` 제외)여야 ULID 파서를 통과한다(`crates/engine/CLAUDE.md` — `01HX000000000000000000000L` 류 INVALID).
- **TDD-guard(프로세스)**: 새 `store/environments.rs`/`api/environments.rs`/`*.tsx` 는 작업트리에 pending test 파일이 있어야 PreToolUse 훅을 통과(루트 `CLAUDE.md`) — 테스트 파일 먼저.

**UI (vitest + RTL)**:
- EnvironmentsPage CRUD(목록 렌더, 생성, vars 행 편집, 삭제).
- `environments.ts` 스키마 round-trip + `data` null/누락 방어.
- RunDialog: 환경 선택 시 base 표시 + override 우선순위; 환경 전환 시 override 유지; 제출 페이로드 = 병합 평탄 env.
- `resolveEnv` 단위(override 승, base-only, override-only, 빈 입력).
- 게이트: `pnpm build`(`tsc -b`) — **full(`EnvironmentSchema`, vars 포함) ↔ summary(`EnvironmentSummarySchema`, vars 제외) 분리 타입 일치**(`presets.ts` 의 `Preset`/`PresetSummary` 선례)가 `useEnvironment(id)` vs `useEnvironments()` 반환 타입에서 어긋나지 않는지 확인. **참고(리뷰 M-1)**: `z.record(z.string())` 는 `Record<string,string>` 로 깔끔하게 추론되며, `ProfileSchema` 류의 **중첩 `.default()` 누출**(ui/CLAUDE.md, `runPrefill.ts:17-29`)은 `EnvironmentSchema` 에 **해당 없음**(중첩 default 자체가 없음) — 그 함정과 혼동 말 것.

## 7. 확장성 (v1 미구현, 설계만 고려)

추후 **"시나리오 수정 화면에서 환경 선택 → 시나리오 1회 test-run"** 기능 예정. 그 기능은:
- v1 의 `<EnvironmentPicker>` + `resolveEnv` 를 **그대로 재사용**(RunDialog 비결합이라 가능).
- test-run 도 결국 `POST /api/runs`(또는 전용 ephemeral run 경로)로 평탄 env 제출 → 백엔드 추가 변경 최소.
- v1 은 시나리오에 환경을 **결합하지 않는다**(ADR-0013) — test-run 기능이 와도 선택은 에디터 세션-로컬(또는 그 슬라이스가 정할 별도 저장)이고, 시나리오 YAML 은 env 선택을 안 담는다.

## 8. 슬라이스 분할 (구현 계획용 — 리뷰 권장)

백엔드 절반은 presets/datasets 의 near-verbatim 복제(저위험)이고, 진짜 새 UX 위험은 RunDialog 2-레이어 base/override(§4 I-4) 한 곳에 몰려 있다. A1/A2 분할 선례를 따라 두 plan 으로 나누길 권장(필수 아님):

- **B-1 — 환경 리소스 + 관리 UI** (저위험, 순수 미러): migration 0006 + `store/environments.rs` + CRUD REST(`api/environments.rs` + 라우팅) + `api/environments.ts` + `EnvironmentsPage` + 라우트/네비. run-create·RunDialog 무변경.
- **B-2 — RunDialog 환경 오버레이** (유일한 신규 UX, 설계 위험 집중): `<EnvironmentPicker>` + `resolveEnv` + base/override 렌더(§4 상호작용 표) + 제출 병합. B-1 의 클라이언트/훅 재사용.

## 9. 범위 밖 · 후속 (별도 spec)

- **`{{var}}` 흐름 변수 전역 등록 / `scenario.variables` UI** — 시나리오 authoring 기능(다른 데이터 모델·우선순위 표면). 별도 slice. roadmap.
- **시나리오 에디터 환경 선택 + 단일 test-run** — §7. 별도 slice(이 spec 은 확장 가능하게만 설계).
- **민감값 마스킹** — env 값이 로그/리포트/UI 에 노출되지 않게. 기존 후속(roadmap B1).
- **환경별 묶음 상속/오버라이드(Postman globals+environments 풀 모델)** — v1 은 단일 환경 선택 + RunDialog override 의 경량 하이브리드로 충분. 필요 시 후속.
- **per-scenario 기본 환경 포인터** — 프리셋(영역 A)이 시나리오별 env 기억을 이미 커버. 필요해지면 별도 추가.
```
