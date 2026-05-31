# ADR-0024 — Run 프리셋: scenario-scoped 독립 리소스 + Profile 재사용 + 라이브 시나리오 추종

* Status: Accepted
* Date: 2026-05-31
* Deciders: handicap maintainers
* Tags: run-preset, profile, rest-api, controller, ui, data-driven

## Context

ADR-0013(Scenario↔Run Config 분리)에서 시나리오와 run 설정(Profile + env)은 분리한다고
결정했다. 반복적으로 같은 run 설정을 쓰는 QA·운영 팀이 매번 VUs/duration/ramp-up/loop
cap/env/data-binding을 재입력해야 하는 문제가 생겼다. 영역 A(run 재사용) spec에서
두 경로를 정의했다: A1 = retry(과거 run 이력 재사용), A2 = 이름 붙인 프리셋(CRUD).

설계 명세: `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`.
구현 계획: `docs/superpowers/plans/2026-05-31-area-a2-run-presets.md`.
구현 완료: 커밋 범위 `3194f37..2f9bd58` (9개 구현 커밋, 2026-05-31).

## Decision Drivers

- 같은 시나리오에서 자주 쓰는 run 설정을 이름을 붙여 저장·재사용할 수 있어야 한다.
- 프리셋은 `profile_json` + `env_json`으로 run 설정 전체를 담아야 한다(VUs/duration/
  ramp-up/loop cap/data-binding/env 포함).
- 기존 `Profile` serde 타입과 runs 테이블 패턴을 그대로 재사용해 신규 타입 0개로 구현.
- run-create 검증 게이트는 권위 있는 최종 방어여야 한다(저장 시점의 일회성 보장 부족).
- 데이터셋 DELETE가 조용히 프리셋을 고아화하지 않도록 soft-guard 필요.

## Considered Options

1. **독립 `run_presets` 테이블 + scenario-scoped REST 리소스** (채택)
   — `profile_json`/`env_json` JSON 컬럼, `UNIQUE(scenario_id, name)` 인덱스.
   기존 `Profile` serde 재사용. `validate_run_config` 공유 게이트.

2. **runs 테이블에 `is_preset` 플래그 + `name` 컬럼 추가**
   — run이 아닌 개체에 run 이력이 섞여 목록/필터/삭제 경계 모호.
   run 집계·리포트 로직과의 의도치 않은 결합. 거절.

3. **시나리오 YAML에 preset 블록 임베딩**
   — ADR-0013(시나리오는 git/YAML, run config는 DB) 위반.
   대용량 시나리오 YAML이 되고 git diff에 부하 설정이 섞임. 거절.

4. **`scenario_yaml` 스냅샷 포함**
   — 프리셋 로드 후 라이브 시나리오와 diff가 생겨 "시나리오 변경 경고"(A1 retry
   전용)를 프리셋에도 적용해야 하는 복잡도. 프리셋의 의도(라이브 추종)와 맞지 않음. 거절.

## Decision

**독립 `run_presets` 테이블 + scenario-scoped 1급 REST 리소스.**

### 스키마 (migration 0005)

```sql
CREATE TABLE IF NOT EXISTS run_presets (
    id           TEXT PRIMARY KEY,
    scenario_id  TEXT NOT NULL REFERENCES scenarios(id),
    name         TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    env_json     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_presets_scenario_name
    ON run_presets(scenario_id, name);
```

- `UNIQUE(scenario_id, name)`: 같은 시나리오 안에서 이름 유일. 중복 이름 저장 = UI가
  덮어쓰기 확인 → PUT. 서버 `UNIQUE` 위반 = 409 백스탑.
- `profile_json`/`env_json`: 기존 `runs` 테이블과 동일 직렬화(`Profile` serde 재사용).
  `#[serde(default)]` 진화 패턴 자동 상속 — Profile에 새 필드 추가 시 migration 불필요.
- **ON DELETE CASCADE 없음**: 현재 scenario DELETE 엔드포인트가 없어 고아화 경로 없음.
  미래에 scenario-delete 추가 시 해당 spec에서 `ON DELETE CASCADE` 마이그레이션 필요.

### REST API

| 메서드 | 경로 | 동작 |
|---|---|---|
| `POST` | `/api/scenarios/{id}/presets` | 생성. `validate_run_config` 호출. UNIQUE 위반 → 409. |
| `GET`  | `/api/scenarios/{id}/presets` | 목록(id/name/vus/duration 요약). |
| `GET`  | `/api/presets/{id}` | 전체(profile+env). 프리셋 로드 선행 GET. |
| `PUT`  | `/api/presets/{id}` | full-body 덮어쓰기. 검증 재적용. |
| `DELETE` | `/api/presets/{id}` | 삭제. 204. |

프리셋으로 run 실행 = 신규 엔드포인트 없음 — UI가 프리셋을 로드해 RunDialog를 채우면
기존 `POST /api/runs`가 그대로 실행(검증 게이트 재적용).

### 검증 게이트 공유 (`validate_run_config`)

`runs::create`에 있던 검증 로직을 `pub(crate) validate_run_config(&AppState, &Profile)`로
추출해 preset-save와 공유한다. 함수는 `Option<DatasetMeta>`를 반환해 resolution이 두 번째
`get_meta` 없이 meta를 재사용(TOCTOU 회피). preset 경로는 반환 meta를 무시(저장만).
run-create가 권위 있는 최종 방어: 데이터셋 삭제 등 저장 후 변경은 실행 시점에 다시 거절.

### 프리셋은 라이브 시나리오를 추종 (스냅샷 없음)

프리셋은 `scenario_yaml`을 저장하지 않는다. A1 retry의 "시나리오 변경 경고"는 프리셋엔
없다. 대신:
- 프리셋 로드 시 DataBindingPanel이 현재 `{{var}}`/컬럼에 대해 재검증.
- 삭제된 데이터셋을 참조하는 프리셋 로드 시 "데이터셋 삭제됨" 알림.

### 데이터셋 DELETE soft-guard

데이터셋 DELETE에 2층 가드:

1. **active run 참조(pending/running)**: hard 409, `?force=true`로 override 불가.
2. **프리셋만 참조(active run 없음)**: soft 409 + 참조 프리셋 목록 본문(`presets` 배열),
   `?force=true` 쿼리로 삭제 허용.

`ApiError::ConflictJson(Value)`를 도입해 soft 409 본문을 `{error}` 래핑 없이 그대로 반환.
기존 `Conflict(String)`은 여전히 `{error}` 래핑 유지.

## Consequences

**Positive**
- `Profile` serde 타입 재사용 — 신규 serde 구조체 0개. `#[serde(default)]` 진화 패턴 자동 상속.
- `validate_run_config` 공유로 preset-save와 run-create 양쪽에서 일관된 검증.
- scenario-scoped URL(`/api/scenarios/{id}/presets`)이 직관적. 단독 관리(`/api/presets/{id}`)도 가능.
- `UNIQUE(scenario_id, name)` 인덱스가 서버 측 이름 충돌을 DB 레벨에서 강제.
- 데이터셋 soft-guard로 프리셋이 참조 중인 데이터셋의 조용한 고아화 방지.
- migration 0005는 `CREATE TABLE IF NOT EXISTS` — controller 재시작 무한히 안전.

**Negative / Trade-offs**
- 프리셋이 라이브 시나리오를 추종하므로 시나리오 변경 후 프리셋 실행이 예상과 다를 수 있음.
  DataBindingPanel 재검증과 run-create 게이트로 최악 케이스(존재하지 않는 열 참조)는 차단.
- ON DELETE CASCADE 없음 — scenario-delete 기능 추가 시 반드시 cascade 마이그레이션 필요.
- `ApiError::ConflictJson` 도입으로 409 응답 형식이 두 가지(래핑/비래핑) — 소비처는 본문 구조를 알고 파싱해야 함.

## 명시적 연기 (Out of scope)

- **cross-scenario 전역 프리셋** — 현재 scenario-scoped만.
- **프리셋 공유·export** — 사내 팀 간 preset 공유.
- **scenario DELETE** — 추가 시 ON DELETE CASCADE 마이그레이션 필요(상기).
- **민감값 마스킹** — env/profile 값은 평문 저장(기존 runs 테이블과 동일 한계).

## Links

- ADR-0013 (Scenario/RunConfig 분리) — 독립 리소스 결정의 근거
- ADR-0022 (data-driven 데이터셋) — `profile_json` `#[serde(default)]` 패턴 + dataset-delete guard precedent
- Spec `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`
- Plan `docs/superpowers/plans/2026-05-31-area-a2-run-presets.md`
