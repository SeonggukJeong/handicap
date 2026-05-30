# Run 프리셋 + Retry 설계 (영역 A)

* Status: Draft (brainstorming 완료, 구현 전)
* Date: 2026-05-30
* 관련 ADR: ADR-0013(Scenario↔Run config 분리), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0011(SQLite 저장소), ADR-0022(data-driven 바인딩)
* 후속 ADR: 구현 시 새 ADR 추가 (run 프리셋 = 독립 리소스 결정, 다음 가용 번호)

## 1. 개요 · 목표

**문제**: run 을 한 번 돌린 뒤 같은 설정으로 다시 돌리려면 RunDialog 의 VUs·duration·ramp-up·loop cap·env 변수·data binding 을 **매번 손으로 다시 입력**해야 한다. 시간 소모가 크고 오타가 난다.

**목표**: run 설정(프로파일 + 변수)을 재사용한다. 두 경로:

1. **이름 붙인 Run 프리셋** — run 설정 전체(`Profile` + env 맵)를 이름과 함께 시나리오 하위에 저장하고, RunDialog 에서 골라 한 번에 채운다. retry 의 큐레이트 버전.
2. **과거 run Retry** — 이미 실행했던 임의의 run 을 그 설정 그대로 다시 실행한다. 별도 저장 없이 `runs` 이력을 재사용.

**핵심 결정** (brainstorming 확정):

- **저장 단위 = run 설정 전체** (변수 + VUs/duration/ramp/loop cap/data binding). 변수만이 아니라 프로파일까지 한 묶음 → retry 와 자연스럽게 합쳐진다.
- **프리셋 = 시나리오별(scenario-scoped)**. `data_binding` 은 그 시나리오 YAML 의 `{{var}}`/컬럼에 매핑돼 있고, `loop_breakdown_cap` 은 loop 가 있을 때만 의미가 있으며, env 는 그 시나리오가 참조하는 `${ENV}` 를 채운다 — 전부 시나리오 종속.
- **구현 = 별도 `run_presets` 테이블 + 1급 REST 리소스** (접근 1). retry 는 신규 저장 없이 기존 `runs` 행을 읽는다. 프리셋(큐레이트) 과 runs(이력) 의 책임을 분리.
- **이 기능은 영역 A 단독 spec**. 영역 B(글로벌 변수)·시나리오 복제는 별도 spec(§8).

**기존 코드 사실 확인** (설계 단순화 근거):

- `GET /api/runs/{id}` 응답이 **이미 `profile`(Profile) + `env`(serde_json::Value) 를 포함**한다 (`crates/controller/src/api/runs.rs:172,264-265`, `RunRow` 가 `profile`/`env`/`scenario_yaml` 보유 `store/runs.rs:56-66`). → **retry prefill 은 신규 엔드포인트·저장 0개**.
- **시나리오 DELETE 엔드포인트가 없다** (`/scenarios/{id}` 는 get/put 만, `app.rs:35-36`). → 프리셋이 시나리오 삭제로 고아가 될 경로가 없으므로 cascade 불필요.
- `/scenarios/{id}/runs` 라우팅 패턴이 이미 있다 (`app.rs:38`, `runs_api::list_for_scenario`) → `/scenarios/{id}/presets` 가 그대로 들어맞는다.
- run-create 검증 게이트(`runs.rs:43-98`: vus/duration ≥ 1, `loop_cap_ok`, binding 검증)를 **프리셋 저장 시점에 재사용**해 저장 즉시 launchable 보장.

## 2. 데이터 모델 — migration 0005 (idempotent)

`crates/controller/src/store/migrations/0005_run_presets.sql`:

```sql
CREATE TABLE IF NOT EXISTS run_presets (
    id           TEXT PRIMARY KEY,                       -- ULID
    scenario_id  TEXT NOT NULL REFERENCES scenarios(id),
    name         TEXT NOT NULL,
    profile_json TEXT NOT NULL,    -- runs.profile_json 과 동일 직렬화 (Profile)
    env_json     TEXT NOT NULL,    -- runs.env_json 과 동일 직렬화 (map<string,string>)
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_presets_scenario ON run_presets(scenario_id);
```

- `CREATE TABLE IF NOT EXISTS` — migration 0003/0004 와 동일한 멱등 패턴.
- 기존 `Profile` 구조체(`store/runs.rs:45-54`) + env 직렬화를 **그대로 재사용** → 신규 serde 타입 0개. `#[serde(default)]` 진화 패턴 자동 상속(프로파일에 향후 새 필드가 붙어도 기존 프리셋 행 호환).
- 이름 중복 DB 제약 없음(같은 이름 여러 개 허용; UI 가 중복 시 안내만). scenario delete 경로 없으니 `ON DELETE CASCADE` 생략.
- 저장소 모듈 `crates/controller/src/store/presets.rs`: `insert`, `get`, `list_by_scenario`, `update`, `delete`. `RunRow` 와 평행한 `PresetRow { id, scenario_id, name, profile: Profile, env: serde_json::Value, created_at, updated_at }`.

## 3. REST API — 신규 `crates/controller/src/api/presets.rs`

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/scenarios/{id}/presets` | 생성. body `{ name, profile, env }`. **run-create 검증 게이트 재사용** → 저장 시점 launchable 보장. 201 + 생성된 프리셋. |
| GET | `/api/scenarios/{id}/presets` | 그 시나리오의 프리셋 목록 (id, name, vus/duration 요약, created_at/updated_at). |
| GET | `/api/presets/{id}` | 전체(profile + env). prefill 용. |
| PUT | `/api/presets/{id}` | 이름 변경 + profile·env 덮어쓰기. 본문은 POST 와 동일 형태. 검증 게이트 재적용. |
| DELETE | `/api/presets/{id}` | 삭제. 204. |

라우팅은 `app.rs` 에 `/scenarios/{id}/presets`(POST/GET), `/presets/{id}`(GET/PUT/DELETE) 추가.

**프리셋으로 run 실행 = 신규 엔드포인트 없음**: UI 가 프리셋(또는 과거 run)을 로드 → RunDialog 채움 → 기존 `POST /api/runs` 제출. 기존 검증 게이트가 그대로 적용되어 프리셋/retry 가 검증을 우회하지 않는다.

**검증 게이트 추출**: 현재 `runs::create` 안에 인라인된 검증 로직(vus/duration, `loop_cap_ok`, binding 해석/검증)을 **재사용 가능한 함수로 추출**해 `runs::create` 와 `presets::create`/`update` 가 공유한다. 단, binding 검증은 데이터셋 존재·컬럼 매핑을 확인하므로 시나리오 YAML + 데이터셋 메타가 필요 — 추출 함수는 그 입력(scenario_id, profile)을 받는다.

## 4. Retry (신규 저장 0)

`runs` 행이 이미 `profile`+`env`+`scenario_yaml` 을 보유하므로 retry 는 그것을 읽어 재사용한다. run 목록(`/scenarios/{id}/runs`)·run 상세에 두 진입점:

- **"다시 실행"** (기본) → 그 run 의 profile+env 로 **RunDialog prefill(편집 가능)**. 프리셋 불러오기와 동일한 UI 경로. 확인/수정 후 기존 `POST /api/runs` 제출.
- **"동일 설정 즉시 재실행"** (빠름) → 그 run 의 profile+env 로 곧장 `POST /api/runs`. 검증 실패(시나리오 변경 등) 시 에러를 토스트로 표면화.

**시나리오 변경 경고**: run 의 `scenario_yaml` 스냅샷 ≠ 현재 라이브 시나리오 YAML 이면 prefill/즉시재실행 시 경고 배지를 띄운다("이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있음"). 비교를 위해 `GET /api/runs/{id}` 응답에 `scenario_yaml` 을 노출(현재 응답 구조체 `runs.rs:172` 부근에 필드 추가; 소폭). 이로써 brainstorming 에서 제기된 "retry 가 변경된 시나리오에서 실패" 우려를 사용자에게 사전 경고한다.

## 5. UI

기존 RunDialog(`ui/src/components/RunDialog.tsx`) 가 프리셋 관리의 단일 화면이다(별도 페이지 없음).

**RunDialog 추가 요소**:
- 상단 **"프리셋 불러오기" 드롭다운** — 그 시나리오의 프리셋 목록. 선택 시 vus/duration/ramp/loopcap/env/binding 폼 전부를 채운다(이후 자유 편집).
- **"프리셋으로 저장" 버튼** — 현재 폼 상태를 이름 입력받아 `POST /api/scenarios/{id}/presets`.
- 드롭다운 항목별 **삭제 / 이름변경** 인라인 액션.

**Run 상세** (`RunDetail`):
- **"다시 실행"** + **"동일 설정 즉시 재실행"** 버튼.
- **"이 run 설정을 프리셋으로 저장"** 버튼 — 완료된 run 의 profile+env 를 이름 붙여 저장(RunDialog 외 두 번째 저장 진입점).

**클라이언트**: presets CRUD 용 React Query 훅을 기존 dataset 클라이언트 패턴(`ui/src/api/`)으로 추가. Zod 스키마는 기존 `ProfileSchema`/`DataBindingSchema`(`ui/src/api/schemas.ts`) 를 재사용한 `PresetSchema { id, name, profile, env, ... }`.

**`pnpm build` 게이트 주의**: discriminated union(binding)·Zod default 누출은 `pnpm test` 가 못 잡으므로 UI 변경 후 `cd ui && pnpm build` 까지 수동 실행(CLAUDE.md).

## 6. 검증 · 엣지 케이스

- **프리셋 저장/수정 시 run-create 게이트 재사용**: 미구현 정책(`unique`)·없는 데이터셋·빈 데이터셋·없는 컬럼·loop cap 범위(0..=10000) 위반·vus/duration < 1 → 400. 저장 즉시 launchable.
- **실행 시점 재검증**: 프리셋/retry 로 만든 run 도 기존 `POST /api/runs` 게이트를 다시 통과(시나리오가 그새 변했을 수 있음). 이중 방어.
- **시나리오 변경**: §4 경고 배지로 사전 고지. 실제 깨진 binding 은 run-create 400 으로 차단.
- **env 평문 저장**: 현재 `runs.env_json` 과 동일(민감값 마스킹은 기존 후속 항목 `docs/followups-after-mvp1.md`, 범위 밖).
- **이름**: trim 후 비어있지 않음(빈 이름 400). 중복 이름 허용.
- **빈 env / no binding**: 정상. byte-identical 하게 동작.
- **프리셋 0개**: 드롭다운 비활성/빈 상태 표시.

## 7. 테스트 전략 (TDD)

**Rust** (test-first, tdd-guard 준수):
- `store/presets.rs` 단위: insert→get→list_by_scenario→update→delete round-trip; Profile/env JSON round-trip.
- API 통합(wiremock 불필요, controller in-process): 프리셋 생성 → 목록 → `GET /presets/{id}` → 그 profile+env 로 `POST /api/runs` 200; 잘못된 binding 으로 프리셋 생성 시 400; 빈 이름 400; DELETE 후 404.
- migration 0005 멱등성(두 번 적용해도 OK).
- `GET /api/runs/{id}` 응답에 `scenario_yaml` 포함 확인.

**UI** (RTL + vitest):
- RunDialog 프리셋 불러오기 → 폼 필드 채워짐; "프리셋으로 저장" → POST 호출.
- RunDetail "다시 실행" → RunDialog 가 그 run 의 profile+env 로 prefill; 시나리오 변경 시 경고 배지.
- PresetSchema round-trip(Profile/DataBinding 재사용 검증).

## 8. 범위 밖 · 후속 (별도 spec)

- **시나리오 복제** — run retry 가 변경된 시나리오에서 실패하는 상황을 줄이는 보강책으로 제안됨. 그러나 이건 **시나리오 관리** 기능(scenarios CRUD/UI 표면)이지 run 재사용이 아니므로 **별도 spec**. `docs/roadmap.md` 후속 항목으로 기록.
- **영역 B — 글로벌 변수** (BASE_URL 등 전역 등록 → 아무 시나리오에서 선택). run 프리셋과 변수 라이브러리는 다른 데이터 모델·다른 UX 표면 → 별도 spec. `scenario.variables`(모델은 있으나 UI 없음)·env 우선순위(ADR-0014)와의 관계를 그 spec 에서 설계.
- **민감값 마스킹** (기존 후속 항목).
- **cross-scenario 전역 프리셋** (현재는 scenario-scoped 만).
