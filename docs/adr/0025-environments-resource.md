# ADR-0025 — 환경(Environments): env-namespace 전용 top-level 재사용 리소스 + 클라이언트 오버레이 스냅샷

* Status: Accepted
* Date: 2026-05-31
* Deciders: handicap maintainers
* Tags: environments, env-namespace, rest-api, controller, ui

## Context

RunDialog의 env 입력창에 `BASE_URL`·인증 호스트·API 키를 run마다 손으로 다시 입력해야 한다.
영역 A(run 프리셋, ADR-0024)는 **한 시나리오 안에서의** run 설정 재사용을 풀었지만,
시나리오를 **가로지르는** env 재사용은 미해결로 남았다. dev/staging/prod 같은 환경 묶음을
한 번 등록해 두고 아무 시나리오의 run에서나 골라 쓰고 싶다.

설계 명세: `docs/superpowers/specs/2026-05-31-global-variables-environments-design.md`.
구현 계획: `docs/superpowers/plans/2026-05-31-area-b1-environments-resource.md`(B-1, 리소스+관리 UI),
`docs/superpowers/plans/2026-05-31-area-b2-rundialog-env-overlay.md`(B-2, RunDialog 오버레이).

## Decision Drivers

- 자주 쓰는 `${ENV}` 값(BASE_URL/인증 호스트/API 키)을 한 번 등록해 시나리오를 가로질러 재사용.
- 기존 `POST /api/runs` 계약(평탄 `env` 맵)을 바꾸지 않아야 한다.
- 환경 수정/삭제가 과거 run·preset 설정을 깨뜨리면 안 된다.
- presets/datasets 리소스 패턴을 그대로 미러해 백엔드 위험을 낮춘다.

## Considered Options

1. **named environments = top-level 독립 리소스 + 클라이언트 병합 오버레이** (채택)
   — `environments` 테이블(scenario_id/FK 없음), 서버 생성 ULID, `UNIQUE(name)`→409.
   RunDialog가 선택 환경(base) + per-run override를 **클라에서 병합**해 기존 평탄 `env`로 제출.

2. **`scenario.variables`(모델만 존재) 확장 + 시나리오 YAML 임베딩**
   — 환경이 시나리오에 묶여 cross-scenario 재사용 불가. ADR-0013(시나리오는 git/YAML,
   run config는 DB) 위반. 거절.

3. **run/preset이 environment_id를 참조(정규화)**
   — 환경 수정/삭제가 과거 run·preset의 실행 의미를 소급 변경. 참조 가드·cascade 필요.
   스냅샷 모델이 더 단순하고 "과거 설정 불변" 보장. 거절.

4. **서버 측 병합(`POST /api/runs`가 environment_id를 받아 서버에서 병합)**
   — run-create 계약 변경 + 서버에 환경 해석 책임 추가. 클라 병합이 §7(시나리오 에디터
   test-run) 재사용 이음새에도 유리. 거절.

## Decision

**named environments = env-namespace 전용 top-level 독립 리소스 + 클라이언트 오버레이 스냅샷.**

### 스코프

- `${ENV}` 네임스페이스만. `{{var}}` 흐름변수 전역 등록은 범위 밖(별도 slice).

### 스키마 (migration 0006)

```sql
CREATE TABLE IF NOT EXISTS environments (
    id          TEXT PRIMARY KEY,   -- ULID (Crockford base32), 서버 생성
    name        TEXT NOT NULL,
    vars_json   TEXT NOT NULL,      -- map<string,string> JSON
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_name ON environments(name);
```

- **scenario_id/FK 없음** — top-level, cross-scenario. presets와의 핵심 차이.
- 서버 생성 ULID, `UNIQUE(name)` 위반 = 409.
- `CREATE TABLE IF NOT EXISTS` — controller 재시작 무한 안전(0003/0004/0005와 동일).
- migration 번호는 디스크 max+1로 도출 — 머지 시점 in-flight 9d(`run_if_metrics`)와의
  충돌은 리넘버(순수 순서 라벨, 두 테이블 disjoint)로 해소. **실제 사용 번호 = 0006**.

### REST API

| 메서드 | 경로 | 동작 |
|---|---|---|
| `POST` | `/api/environments` | 생성. `validate_env`. UNIQUE 위반 → 409. |
| `GET`  | `/api/environments` | 목록(id/name/**var_count**, vars 본문 없음). |
| `GET`  | `/api/environments/{id}` | 전체(vars 포함). |
| `PUT`  | `/api/environments/{id}` | full-body 덮어쓰기. 검증 재적용. |
| `DELETE` | `/api/environments/{id}` | 삭제. 204. **무가드.** |

- `EnvironmentSummary`(var_count, vars 없음) vs `EnvironmentResponse`(vars 포함) 분리 —
  목록은 요약, get은 전체.
- **참조 가드 불필요** → DELETE 무가드. 스냅샷 오버레이라 어떤 run/preset도 environment_id를
  참조하지 않으므로 환경 삭제가 과거 설정을 깨뜨릴 경로가 없다(presets의 데이터셋 soft-guard와 대비).

### 오버레이 (B-2): 클라이언트 병합 + 스냅샷

- 선택 환경 vars = **base**, RunDialog env 입력 = **override**(우선). 우선순위: 환경 < per-run override.
- RunDialog가 `resolveEnv(base, overrides)`로 클라에서 병합해 기존 평탄 `env` 맵으로 제출 →
  **`POST /api/runs` 무변경**. run/preset은 해석값 스냅샷을 저장.
- 환경 미선택 = override-only = pre-B2 submit과 byte-identical(하위 호환 + prefill 보존).
- `resolveEnv`(순수 함수) + `<EnvironmentPicker>`(standalone controlled)는 RunDialog와 분리 —
  §7 시나리오 에디터 test-run 재사용 이음새.

### 검증 (CRUD 엔드포인트 한정)

- 이름: trim 후 non-empty + UNIQUE.
- var 키: `${KEY}`로 쓸 수 있어야 함 — non-empty, 공백·`}`·`:` 금지(`:`는 `:-` 기본값
  구분자에 대한 보수적 가드).
- 예약 시스템 변수명(vu_id/iter_id/loop_index)은 **거절하지 않음** — 엔진이 시스템 값으로
  해석하므로 UI가 soft warning만 노출.

## Consequences

**Positive**
- presets/datasets 리소스의 near-verbatim 미러라 백엔드 위험 낮음(신규 패턴 0개).
- 환경 삭제가 자유로움(과거 run/preset 설정은 스냅샷이라 불변) — 의도된 동작.
- `POST /api/runs` 계약 불변 — 워커·엔진·proto·runs 테이블 무변경.
- 클라 병합 이음새(`resolveEnv` + standalone picker)가 §7 test-run에 재사용 가능.

**Negative / Trade-offs**
- 스냅샷이라 환경을 수정해도 과거 run/preset에 소급 반영 안 됨(정규화 참조 모델이라면 됐을 것) —
  "과거 설정 불변"이 더 중요하다고 판단.
- env 값 평문 저장(기존 runs/presets와 동일 한계) — 민감값 마스킹은 후속.

## 명시적 연기 (Out of scope)

- **민감값 마스킹** — env 값 평문 저장.
- **`{{var}}` 흐름변수 전역 등록** — env-namespace만 다룸.
- **시나리오 에디터 환경 선택 test-run**(spec §7) — `resolveEnv`/`<EnvironmentPicker>` 재사용 예정.
- **JSON 숫자 주입** — env 값은 문자열만.

## Links

- ADR-0013 (Scenario/RunConfig 분리) — 독립 리소스 결정의 근거
- ADR-0014 (`{{var}}`/`${ENV}` 변수 표기 분리) — env-namespace 스코프 근거
- ADR-0024 (run 프리셋) — scenario-scoped 자매 리소스(이쪽은 top-level + 무가드로 대비)
- Spec `docs/superpowers/specs/2026-05-31-global-variables-environments-design.md`
- Plan `docs/superpowers/plans/2026-05-31-area-b1-environments-resource.md`(B-1)
- Plan `docs/superpowers/plans/2026-05-31-area-b2-rundialog-env-overlay.md`(B-2)
