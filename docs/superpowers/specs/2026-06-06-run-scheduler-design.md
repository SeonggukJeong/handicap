# Run 스케줄러 (예약/반복 실행) — 설계

- 날짜: 2026-06-06
- 영역: 신규 운영 자동화 축 (roadmap §A 후보에 없던 신규 항목 — load fidelity·reporting depth와 직교)
- 출처: 사용자 요청(2026-06-06) — "특정 시각에 시작하거나 일정 간격으로 반복하는 스케줄러". brainstorming 2026-06-06.
- 선행: 영역 A(run 프리셋, ADR-0024) + B(환경, ADR-0025) + A4a/b/c(SLO verdict·run 비교·insights) 머지 완료 — 스케줄러는 이 발사 경로와 리포트 스택을 **재사용**한다(새 워커/엔진 로직 0).

## 1. 목표 한 줄

종료 run을 손으로 매번 `POST /api/runs` 하지 않고, **(1) 특정 일시에 1회** 또는 **(2) 반복(매일/매주/간격/cron)** 으로 부하 run을 자동 발사한다. 반복 발사가 이미 머지된 SLO verdict(A4a)·run 비교(A4b)·insights(A4c)와 맞물려 **성능 회귀 감시 루프**가 된다.

## 2. 범위

### IN

- 신규 `schedules` 리소스(top-level CRUD, environments 패턴) + `schedule_events` append-only 이벤트 로그. migration **0011**(`CREATE TABLE IF NOT EXISTS` 2개).
- 트리거 모델 2종(저장): **once**(epoch ms 일시) / **cron**(표현식). UI 프리셋(매일·매주·N분/시간 간격)은 클라에서 cron 문자열로 컴파일, 고급 탭은 raw cron, 1회는 once.
- 컨트롤러 내장 **주기 스케줄러 루프**(`tokio::spawn` 1개, main.rs) — 틱마다 due 조회 → 기존 발사 경로로 run 생성.
- 발사 코어 **공유 헬퍼 `spawn_run`** 추출: `api::runs::create`의 insert→data_binding 해석→enqueue→dispatch 블록(`runs.rs:254-369`)을 REST 핸들러와 스케줄러가 공유.
- 의미론: **겹침=skip**, **놓친 발사(다운)=버리고 전진**(once만 1회 늦게 발사 후 비활성화), **모든 주목 이벤트 기록**(fired/skipped_overlap/missed/error → `schedule_events`).
- `POST /api/schedules/preview-next` — 트리거 → 다음 N개 발사 시각(cron 평가 서버 단일 소스, UI가 cron 재구현 안 함).
- UI `/schedules` 페이지(목록 + 생성/편집 폼 + enable 토글 + 삭제 + 다음 발사 미리보기), profile 입력은 RunDialog 컴포넌트 재사용.
- 신규 워크스페이스 의존성 `cron` + `chrono`(서버 로컬 TZ).

### OUT (연기 — roadmap §<신규>에 누적)

- **알림(이메일/슬랙/웹훅)** — 사용자가 명시적으로 "마지막에" 둔 후속. **이음새 = `schedule_events`**(이미 fired/skip/miss/error를 기록하므로 알림 레이어가 그 위에 얹기만 하면 됨). v1은 기록·표시까지.
- **per-schedule 타임존** — v1은 서버 로컬(`chrono::Local`) 단일 TZ. 컬럼 자체를 안 둔다(미사용 컬럼 회피, YAGNI). 후속에서 `timezone` 컬럼 추가.
- **catch-up 모드**(놓친 발사 1회/전부 따라잡기) — v1은 skip-missed만.
- **`runs.schedule_id` 역링크 배지**(run 목록/상세에 "예약됨" 표기) — v1은 `schedule_events.run_id`로 schedule→runs만. runs 테이블 무변경.
- **이력/이벤트 보존정책**(오래된 이벤트·예약 run 정리) — 누적 시 별도 슬라이스.
- **프리셋에서 시드**(기존 run_preset의 profile+env를 폼에 채우기) — 편의, 후속.
- **멀티 컨트롤러 인스턴스 / leader election** — ADR-0011(단일 인스턴스 SQLite) 가정 유지. 루프가 유일 발사자.
- **closed-loop 곡선·step-level 트리거 등** — 범위 밖.

## 3. 핵심 결정 (확정 — brainstorming 2026-06-06)

| 결정 | 값 | 이유 |
|---|---|---|
| 아키텍처 | **컨트롤러 내장 주기 루프** (외부 K8s CronJob·별도 사이드카 기각) | 컨트롤러는 db+coord+dispatcher를 쥔 always-on 조정자. 새 인프라 0, subprocess/K8s 양쪽 동작. 비개발 QA가 매니페스트를 안 짜도 됨(제품 전제 ADR-0001). |
| 트리거 저장 모델 | **once \| cron 2종** | cron이 달력(매일/매주)·클럭정렬 간격(`*/N`)을 이미 포함. 3종 분리 대신 파서·next-fire 계산 1곳. |
| UI 트리거 빌더 | 프리셋(매일·매주·간격) → **cron 문자열 컴파일**(클라) + 고급 raw cron + 1회 once | 사용자에겐 "다 있음", 코드는 단순. cron *생성*은 trivial(클라), cron *평가*는 서버(DST·정확성). |
| 겹침 정책 | **skip** (이전 run이 pending/running이면 이번 발사 건너뜀) | 부하 run은 길어 겹치면 자원·측정 오염. skip + `skipped_overlap` 이벤트 → 사람이 인지·조치. |
| 놓친 발사(다운) | **버리고 전진**(cron) / **1회 늦게 발사 후 비활성**(once) | next_run_at을 항상 `now` 기준 재계산 = 가장 단순. 늦은 cron run은 다른 시간대를 재므로 가치↓. once는 사용자 의도라 1회 챙김(create 시 과거 거부라 다운-미스만 발생). |
| on-time vs missed | grace 윈도(`SCHEDULER_MISS_GRACE`, 기본 300s) | 짧은 재시작(틱 지연)은 정상 발사, 장기 다운은 missed. grace ≥ 틱 간격이라 틱 지연을 missed로 오분류 안 함. |
| 이벤트 기록 | **append-only `schedule_events`** (last_* 컬럼 아님) | 사용자가 두 번 강조 — 알림/이력의 단일 소스. `last_*` 요약 컬럼은 목록 표시용으로 병행(빠른 렌더). |
| 발사 코어 | **`spawn_run` 공유 헬퍼 추출** | `create`의 fire 블록을 REST·스케줄러가 공유(복붙·드리프트 방지). 작업 중 코드 개선. |
| profile 출처 | **스케줄 자체 스냅샷**(profile_json + env_json) | runs/presets와 동일 직렬화. 프리셋 참조(라이브 추종)는 후속 편의. 시나리오 YAML은 **발사 시점 스냅샷**(runs.insert가 현재 YAML 복사 — 라이브 추종, 기존 동작과 일관). |
| cron 문법 | **5-field 표준 crontab**(분 시 일 월 요일, seconds 미사용) | QA가 고급 탭에 치는 건 표준 5-field. `cron`(zslayton) 크레이트는 6-7 field라 §9.2 UI의 5-field를 거부 → `croner`/`saffron`(5-field) 채택(리뷰 MAJOR-13). |
| TZ | **컨트롤러 단일 TZ `--scheduler-timezone`**(IANA, 기본 `Asia/Seoul`, `chrono-tz`) | `chrono::Local`은 stock 컨테이너에서 조용히 UTC → "매일 02:00"이 11:00 KST에 발사되는 함정(리뷰 MINOR-8). 명시 IANA TZ로 cron 평가. per-schedule TZ 연기(글로벌 단일 TZ만, 컬럼 미추가). |
| 동시성 | 단일 루프, 틱당 순차 처리, 틱 비중첩 | ADR-0011 단일 인스턴스. `interval.tick().await` 한 루프라 틱 겹침 없음. |

## 4. 데이터 모델 (migration 0011, `store/migrations/0011_schedules.sql`)

두 테이블을 한 파일에(`CREATE TABLE IF NOT EXISTS` — Slice 6/8b 멱등 패턴). runs 테이블·proto·엔진·워커 무변경.

```sql
-- 예약/반복 run 정의 (top-level 리소스, environments 패턴).
CREATE TABLE IF NOT EXISTS schedules (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    scenario_id   TEXT NOT NULL REFERENCES scenarios(id),
    profile_json  TEXT NOT NULL,            -- Profile 스냅샷 (runs/presets와 동일 직렬화)
    env_json      TEXT NOT NULL,            -- ${ENV} 오버레이 (평탄 맵)
    trigger_kind  TEXT NOT NULL,            -- 'once' | 'cron'
    cron_expr     TEXT,                     -- trigger_kind='cron'일 때
    run_at        INTEGER,                  -- trigger_kind='once'일 때 (epoch ms)
    enabled       INTEGER NOT NULL DEFAULT 1,
    next_run_at   INTEGER,                  -- 루프 쿼리 키 (계산값; NULL=발사 예정 없음)
    last_run_id   TEXT,                     -- 마지막 발사한 run (겹침 체크·링크)
    last_fired_at INTEGER,
    last_status   TEXT,                     -- event kind와 동일 어휘: 'fired'|'skipped_overlap'|'missed'|'error' (목록 표시 요약)
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name);
-- 루프가 매 틱 'enabled AND next_run_at <= now'를 조회 → 부분 인덱스.
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_run_at) WHERE enabled = 1;

-- append-only 이벤트 로그 (알림/이력의 단일 소스).
CREATE TABLE IF NOT EXISTS schedule_events (
    id          TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL,              -- 'fired'|'skipped_overlap'|'missed'|'error'
    run_id      TEXT,                       -- kind='fired'
    detail      TEXT                        -- 에러 메시지 / skip·miss 사유
);
CREATE INDEX IF NOT EXISTS idx_schedule_events_sched ON schedule_events(schedule_id, at DESC);
```

- **마이그레이션 배선**(`store/mod.rs`): 파일 마이그레이션은 **비연속** — 0001–0007 + 0010만 const, **0008/0009는 Rust-guarded 함수라 const 없음**(리뷰 CRITICAL-2). 0010이 최신 파일 마이그레이션이므로 **0011이 다음 번호가 맞다**. `const MIGRATION_SQL_0011 = include_str!("migrations/0011_schedules.sql")` 추가 + `connect()`의 `MIGRATION_SQL_0010` execute(`:63`) **뒤**에 `sqlx::query(MIGRATION_SQL_0011).execute(&pool).await?;`. **rebase 함정**(controller CLAUDE.md): `MIGRATION_SQL_0011` const 1개당 execute 1줄이 짝인지 육안 확인(`grep -c MIGRATION_SQL`는 const+execute+테스트를 합산해 부적합 — 짝 확인용 아님). master가 세션 중 0011 선점하면 리넘버.
- **`schedule_events` cascade는 앱 레벨도 병행**: FK `ON DELETE CASCADE`를 두되, datasets 패턴처럼 DELETE 핸들러가 `DELETE FROM schedule_events WHERE schedule_id=?`를 트랜잭션으로 먼저 실행(FK 의존 안 함, dataset_rows 함정과 동일).
- profile_json/env_json은 `Profile`/맵 직렬화라 새 profile 필드 추가 시 자동 호환(`#[serde(default)]` 패턴, Slice 7-1).

## 5. 트리거 엔진 (`schedule/trigger.rs` — 순수, 단위 테스트)

```rust
pub enum Trigger {
    Once { run_at: i64 },          // epoch ms
    Cron { expr: String },
}

/// `now`(epoch ms) 직후의 다음 발사 시각. None = 계산 불가(잘못된 cron;
/// validate_trigger 통과분은 항상 Some). once는 항상 Some(run_at).
pub fn next_fire_after(t: &Trigger, now_ms: i64) -> Option<i64>;

/// 다음 N개 (preview 엔드포인트용). cron은 Schedule::upcoming, once는 1개.
pub fn next_fires(t: &Trigger, now_ms: i64, count: usize) -> Vec<i64>;

/// 생성/수정 시 검증. cron 파싱 실패·once run_at 과거 → Err(메시지).
pub fn validate_trigger(t: &Trigger, now_ms: i64) -> Result<(), String>;
```

- **cron 평가**: **5-field 표준 crontab**(분 시 일 월 요일, seconds 미사용)을 파싱하는 크레이트 — `croner`(5/6/7 유연) 또는 `saffron`(5-field 표준); plan에서 버전 핀 + MSRV 1.85/edition 2024 호환 확인. ⚠ `cron`(zslayton)은 **6-7 field**라 §9.2 UI가 emit하는 5-field 문자열을 거부하므로 **쓰지 않는다**(리뷰 MAJOR-13). `now_ms` → 설정 TZ(`chrono-tz`, `--scheduler-timezone`, 기본 `Asia/Seoul`)의 `DateTime<Tz>`로 변환 후 next 계산. UI 빌더·고급 raw·preview 전부 5-field로 통일. v1 기본 TZ(Asia/Seoul)는 DST 없음 — per-schedule TZ 후속 슬라이스가 DST gap/overlap 정책을 정한다(리뷰 MAJOR-14).
- **once**: `next_fire_after` = `Some(run_at)`. 발사 후 루프가 `next_run_at=NULL`+`enabled=0`으로 만들어 재발사 차단.
- `validate_trigger`: cron 파싱 불가 → 메시지; once `run_at <= now` → "예약 시각은 미래여야 합니다"(다운-미스 외엔 과거 once 불가 → 늦은-발사 폭주 방지).

## 6. 발사 코어 추출 (`api/runs.rs` 리팩터 — REST·스케줄러 공유)

현재 `create`(`runs.rs:243-372`)의 8단계 중 2–8을 헬퍼로 추출:

```rust
/// 검증된 run을 발사: insert → data_binding 해석 → enqueue → dispatch.
/// dispatch 실패 시 run을 failed로 마크하고 Err(이미 cancel_dispatch_failed+mark_failed 수행).
/// REST `create`(권위 게이트 후 호출)와 스케줄러 루프가 공유.
pub(crate) async fn spawn_run(
    state: &AppState,
    scenario: &scenarios::ScenarioRow,     // 이미 fetch (scenarios::get → Option<ScenarioRow>; `.id`/`.yaml`만 읽음 — 리뷰 CRITICAL-1)
    profile: &Profile,
    validated_meta: Option<datasets::DatasetMeta>,  // validate_run_config 반환 (TOCTOU 재사용)
    env: &std::collections::HashMap<String, String>,
) -> Result<runs::RunRow, ApiError>;
```

- 본문 = 현 `create`의 `runs.rs:254-369`(env serialize → `runs::insert` → data_binding match → `PendingAssignment` → `n`(`is_open_loop`?1:`coord.worker_count_for`) → `coord.enqueue` → `dispatcher.dispatch` + 실패 teardown). `fold_seed`도 그대로.
- **env 소유권**(리뷰 MAJOR-4): `spawn_run`이 `serde_json::to_value(env)`(저장용)·`env.clone()`(proto용)을 **둘 다 내부에서** 수행. `create`는 `&body.env`만 넘기고 추출 후 `env_value`를 독립 참조하지 않아야 byte-identical 성립.
- **REST `create`**: `scenarios::get` → `validate_run_config` → `spawn_run(...)` → 201. **외부 동작·응답 byte-identical**(순수 추출). 기존 통합 테스트(api_test/data_binding/presets/datasets + run_dispatch_failure)가 그대로 GREEN인 것이 게이트.
- **스케줄러**: `scenarios::get`(None→error 이벤트) → `validate_run_config`(Err→error 이벤트) → `spawn_run`(Err→error 이벤트; Ok→fired 이벤트 + last_run_id). dispatch 실패는 run이 이미 failed로 DB에 남고 스케줄러는 error 이벤트 기록(run은 시나리오 run 목록에 보임).

## 7. 스케줄러 루프 (`schedule/runner.rs`)

```rust
/// main.rs가 startup에 1회 spawn. interval.tick()마다 process_due_schedules 호출.
pub async fn run_scheduler(state: AppState, tick: Duration);

/// 한 틱: due 스케줄을 순차 처리. 주입 now로 결정론적 테스트(반환=처리 요약).
pub(crate) async fn process_due_schedules(state: &AppState, now_ms: i64) -> TickSummary;
```

**main.rs 배선**(리뷰 MAJOR-6 — `app::router(state)`(`:127`)가 `state`를 **move**하므로 `AppState { … };` 리터럴 직후 `:126`–`:127` **사이**에, `state.clone()`로 spawn. `AppState: Clone`이고 db 풀/`CoordinatorState`(Arc)/`SharedDispatcher`(Arc)라 clone은 cheap. listener 전):
```rust
if !args.scheduler_disabled {
    tokio::spawn(handicap_controller::schedule::run_scheduler(
        state.clone(),
        Duration::from_secs(args.scheduler_tick_seconds),
        args.scheduler_timezone.clone(),
    ));
}
```
신규 CLI `--scheduler-tick-seconds`(기본 30) + `--scheduler-timezone`(IANA, 기본 `Asia/Seoul`) + `--scheduler-disabled`(기본 false). **e2e 드라이버는 `--scheduler-disabled`를 넘긴다**(리뷰 MAJOR-7 — 빈 schedules 테이블 틱은 무해한 no-op이지만 short e2e 동안 30s 루프가 풀 커넥션 점유를 피함). 기존 controller 통합 테스트는 `main.rs`가 아니라 `router`/`make_app`를 직접 구성하므로 루프가 안 뜸 — 무영향.

**`process_due_schedules(state, now)` 알고리즘**(틱당):
1. `SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= now`.
2. 각 due 스케줄:
   - **missed 판정**: `now - next_run_at > MISS_GRACE_MS`(기본 300_000)?
     - **cron + missed** → 발사 안 함. `missed` 이벤트, `last_status='missed'`, `next_run_at = next_fire_after(now)` 전진. continue.
     - **once + missed** → 아래 발사로 진행(1회 늦게 발사). **once의 missed 판정은 cosmetic**(리뷰 MAJOR-10) — once는 due면 grace와 무관하게 늘 발사되고, missed/on-time은 기록 이벤트 `kind`(missed vs fired)만 바꾼다.
   - **겹침 체크**: `last_run_id`가 있고 `runs::get(last_run_id)`가 `Some(status ∈ {pending, running})` → `skipped_overlap` 이벤트, `last_status='skipped_overlap'`, `next_run_at = next_fire_after(now)` 전진(once면 NULL+비활성). continue. **`last_run_id` 없음 또는 `runs::get`이 `None`(행 부재) → 겹침 아님, 발사 진행**(리뷰 MINOR-16).
   - **발사**: `scenarios::get` → `validate_run_config` → `spawn_run`.
     - Err(시나리오 없음/검증 실패/dispatch 실패) → `error` 이벤트 + `last_error` + `last_status='error'`. cron은 `next_run_at` 전진(다음 슬롯 재시도 — 에러 이벤트가 사람에게 노출). once는 `enabled=0`+`next_run_at=NULL`(소진).
     - Ok(row) → `fired` 이벤트(run_id) + `last_run_id`/`last_fired_at`/`last_status='fired'`. `next_run_at`: cron→`next_fire_after(now)`, once→NULL+`enabled=0`.
3. 모든 DB 쓰기는 스케줄 row UPDATE + 이벤트 INSERT(`store/schedules.rs` 헬퍼).

- **틱 비중첩**: 단일 `interval.tick().await` 루프, 틱당 동기 처리 → 틱 겹침 없음. 발사 자체(enqueue+dispatch)는 빠른 비동기. 스케줄 수는 소량이라 순차 OK.
- **재시작 안전**: `mark_orphans_failed`(startup) 후 첫 틱(≤30s)에 due 처리. grace=300s가 짧은 재시작을 정상 발사로 흡수.
- **매 발사 재검증은 의도**(리뷰 MAJOR-5): `validate_run_config`를 발사 시점에 다시 호출 — 생성 후 데이터셋 삭제·`unique` 정책의 워커수 변화 등으로 무효화되면 `error` 이벤트(여기선 TOCTOU가 바람직). 시나리오 YAML은 발사 시점 현재본 스냅샷(§3).
- **이벤트는 슬롯당 1건**(리뷰 MAJOR-9): 장기 겹침/장기 다운이면 슬롯마다 `skipped_overlap`/`missed`가 쌓인다(예: 10분 겹침 + 매분 cron = 10건). 사람 인지를 위한 의도된 가시성 — 누적 정리는 후속 보존정책(OUT).

## 8. CRUD REST API (`api/schedules.rs` + `store/schedules.rs`, presets/environments 템플릿)

라우트(`app.rs`, environments 패턴):
```rust
.route("/schedules", post(schedules_api::create).get(schedules_api::list))
.route("/schedules/{id}", get(schedules_api::get).put(schedules_api::update).delete(schedules_api::delete))
.route("/schedules/{id}/events", get(schedules_api::events))
.route("/schedules/preview-next", post(schedules_api::preview_next))
```

- **`POST /schedules`** `{name, scenario_id, profile, env, trigger:{kind, cron_expr|run_at}, enabled}` → 검증(시나리오 존재→404; `validate_run_config`→400; `validate_trigger`→**400** 잘못된 cron/과거 once) → `next_run_at = next_fire_after(now)` 계산 → insert → 201. UNIQUE(name) → 409(`map_db_err`).
- **`GET /schedules`** → 목록(요약: name·scenario·trigger·next_run_at·enabled·last_status). `GET /schedules/{id}` → 상세 + 최근 이벤트 N개. `PUT /schedules/{id}` → 전체 교체 + `next_run_at` 재계산(enabled 포함). **소진된 once 재활성**(리뷰 MINOR-15): `run_at`이 과거인 채 enable하면 `validate_trigger`가 400 — run_at을 미래로 갱신해야 통과. `DELETE /schedules/{id}` → events 선삭제 + 삭제.
- **`GET /schedules/{id}/events`** → 이벤트 이력(at DESC).
- **`POST /schedules/preview-next`** `{trigger, count}` → `{next: [epoch_ms,...]}`(`validate_trigger` 후 `next_fires`). UI가 cron 평가를 서버에 위임(단일 소스).
- **라우트 우선순위**(리뷰 MINOR-12): `/schedules/preview-next`(리터럴)는 `/schedules/{id}`(캡처)의 형제 — axum 0.8 matchit이 static을 우선해 `{id}="preview-next"`로 안 샌다(A4b `report.csv` 함정과 동형). 회귀 테스트로 락인(§11).
- 검증 게이트는 `validate_run_config`(runs/presets 공유) + `validate_trigger`. preset처럼 profile 검증 재사용. **trigger 검증은 400**(controller/CLAUDE.md "422는 test-run 전용, 레거시는 400" 컨벤션 준수 — 리뷰 422-vs-400).

## 9. UI (`ui/`)

### 9.1 와이어 스키마 — `ui/src/api/schemas.ts`

```ts
const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), run_at: z.number() }),
  z.object({ kind: z.literal("cron"), cron_expr: z.string() }),
]);
const ScheduleSchema = z.object({
  id: z.string(), name: z.string(), scenario_id: z.string(),
  profile: ProfileSchema, env: z.record(z.string()),
  trigger: TriggerSchema, enabled: z.boolean(),
  next_run_at: z.number().nullish(),               // 서버 null 허용(.nullish, S-D 함정)
  last_run_id: z.string().nullish(), last_fired_at: z.number().nullish(),
  last_status: z.string().nullish(), last_error: z.string().nullish(),
  created_at: z.number(), updated_at: z.number(),
});
```
- **`.nullish()` 필수**(서버가 `null`을 보냄 — `.optional()`은 null 거부, S-D가 전 슬라이스 깨뜨린 함정). `ProfileSchema` 재사용.

### 9.2 페이지 — `ui/src/pages/SchedulesPage.tsx` (EnvironmentsPage 미러)

- **목록**: name·시나리오·**트리거 요약**("매일 02:00" / "15분마다" / cron 원문)·다음 발사 시각·last_status 배지·enabled 토글·편집/삭제. (last_run 리포트 링크는 **상세 뷰** — `ScheduleSummary`에 `last_run_id`가 없어 목록에선 못 건다, §9.3 #3 참고.)
- **생성/편집 폼 `ScheduleForm`**:
  - name + 시나리오 피커.
  - **트리거 빌더**(라디오): `[1회 일시]`(datetime-local→`{kind:once,run_at}`) · `[매일]`(time→`M H * * *`) · `[매주]`(요일 다중+time→`M H * * D,D`) · `[간격]`(N분→`*/N * * * *` / N시간→`0 */N * * *`) · `[고급]`(raw cron). 프리셋 4종은 **클라에서 cron 문자열 생성**(trivial), 최종 제출은 `{kind, cron_expr|run_at}`.
  - **라이브 "다음 발사" 미리보기**: `POST /schedules/preview-next`(debounce) → 다음 3개 시각 표시. cron 평가 클라 재구현 금지(서버 단일 소스).
  - **profile + env**: RunDialog의 추출 컴포넌트 재사용 — `LoadModelFields`(부하 모델 2축) + SLO criteria 섹션 + `DataBindingPanel` + `<EnvironmentPicker>`/`resolveEnv`. (스케줄은 자체 profile 스냅샷 — §3.)
  - enabled 토글.
- **React Query 훅**(environments 패턴): `useSchedules`/`useSchedule`/`useCreateSchedule`/`useUpdateSchedule`/`useDeleteSchedule`/`usePreviewNext`(무invalidation, ephemeral).
- 라우팅: 앱 네비에 "/schedules" 추가(EnvironmentsPage 등록 지점 미러).

### 9.3 34c 구현 결정 (brainstorming 2026-06-06 — §9.1/9.2 위 3개 확정)

34c 착수 brainstorming에서 §9.2가 느슨하게 남긴 3개 결정을 확정. 셋 다 백엔드(34a/34b) 무변경, 순수 UI.

1. **profile 폼 = 공유 추출(RunDialog 순수 리팩터)**. §9.2의 "RunDialog 추출 컴포넌트 재사용"을 구체화 — 실측상 `LoadModelFields`/`DataBindingPanel`/`EnvironmentPicker`는 이미 추출됐지만 **`buildProfile`/`buildCriteria`/SLO 기준 섹션 JSX는 RunDialog(794줄) 안에 인라인**이다. 이를 신규 `ui/src/components/profileForm.ts`(순수 `buildProfile`/`buildCriteria`, 명시 인자) + 프레젠테이셔널 `<CriteriaFields>`(SLO 입력, aria-label 보존)로 추출하고 **RunDialog도 그것을 import**해 ScheduleForm과 공유(중복 0). **게이트 = RunDialog 제출 payload byte-identical + 기존 RunDialog RTL green** — 이 repo의 검증된 전례(`LoadModelFields` 추출=부하 모드 선택기 슬라이스, `EnvironmentPicker` 추출=B-2; 둘 다 "payload byte-identical + aria-label 보존으로 RunDialog RTL 무변경")를 그대로 따른다. 계획상 **맨 앞 task**(나머지가 이 공유 모듈에 의존). SLO 섹션의 collapsible disclosure(`sloOpen`/`criteriaHasValue` 자동 펼침)는 **각 부모가 소유**하고 `<CriteriaFields>`는 입력만 — RunDialog의 접이식 동작 보존(ui/CLAUDE.md "선택적 섹션 접이식" 함정). **byte-identical 게이트가 성립하려면 부모-소유로 남겨야 하는 것**(reviewer 권고): RunDialog의 11개 SLO `useState` 문자열(`maxP50`…`rpsWarmup`)·`sloOpen`/`criteriaHasValue`·`sloActiveCount`·그리고 **`minWindowRps` onChange가 `loadModel==="closed"`일 때 `rampUp`에서 `rpsWarmup`을 자동 시드하는 cross-field 부수효과**(`RunDialog.tsx:623-632`)는 부모에 남긴다 — `<CriteriaFields>`는 값/onChange만 받는 순수 입력, `buildCriteria(profileForm.ts)`는 11개 문자열을 **명시 인자**로 받는다(loadModel.ts의 `buildLoadProfile(state)` 패턴). ScheduleForm은 closed-loop cross-field seed가 무의미하면(자체 부하 모드 상태) 그 부수효과를 안 배선하면 되므로 공유 입력 컴포넌트는 그 로직을 품지 않는다.
2. **트리거 빌더 = 5모드 전부**(1회/매일/매주/간격/고급raw, §9.2 그대로). 프리셋 4종(매일/매주/간격)은 **클라에서 5-field cron 문자열 컴파일**(trivial), 1회는 `{kind:once,run_at}`, 고급은 raw cron. cron *평가*(다음 발사·DST·정확성)는 전부 `preview-next` 서버 단일 소스 — UI는 cron을 **생성만** 하고 평가/파싱은 재구현 안 함. 매주(요일 다중선택)가 가장 fiddly하나 컴파일은 `M H * * D,D` 문자열 조립이라 순수 함수로 단위 테스트.
3. **이벤트 이력 = 편집/상세 뷰 타임라인**. 백엔드 `GET /schedules/{id}/events`(append-only, at DESC, 최대 100)를 상세/편집 진입 시 fetch해 타임라인으로 렌더 — kind 배지(`fired`/`skipped_overlap`/`missed`/`error`) + 시각 + `fired`면 **per-event `run_id` 리포트 링크** + `error`/skip이면 `detail` 사유. **목록(SchedulesPage)엔 `last_status` 배지만**(요약 `ScheduleSummary`는 `last_status`/`last_fired_at`만 — `last_run_id` 없음). **last_run 리포트 링크는 상세 뷰**가 `ScheduleResponse.last_run_id`로 건다(목록 행 링크는 백엔드 무변경 불변식 위반이라 의도적으로 뺀다 — 필요하면 `ScheduleSummary`에 `last_run_id` 추가하는 후속 1줄 백엔드 변경). 전체 타임라인은 상세에서만(이벤트는 `/{id}/events` 전용 — 목록/단건 GET에 inline 금지). `useScheduleEvents(id)` 훅은 무invalidation read(ephemeral 성격이나 schedule 변경 시 재조회되게 query key는 schedule id 종속). >100 이벤트는 v1 표시-only(잘림, 페이지네이션 없음 — §7 "슬롯당 1건" 누적은 후속 보존정책).

이 3개로 §12 영향 파일에 `ui/src/components/profileForm.ts`·`<CriteriaFields>`·`TriggerBuilder.tsx`·이벤트 타임라인 컴포넌트가 추가되고, `RunDialog.tsx`가 **변경(순수 추출 import)** 목록에 든다(34c 유일한 기존-파일 리팩터).

## 10. 검증

- `validate_run_config`(profile, 기존) + 신규 `validate_trigger`(cron 파싱·once 미래). cron 위반·과거 once = **400(`BadRequest`)** — controller/CLAUDE.md "422는 test-run 엔드포인트 전용, 레거시는 400 유지" 컨벤션 준수(runs/presets/environments와 일관, 리뷰 422-vs-400). UNIQUE(name) = 409.
- 백엔드가 최종 권위. UI는 즉시 피드백(빈 cron·과거 일시 비활성)만.

## 11. 테스트 계획

- **엔진/워커/proto**: 변경 없음.
- **controller unit**:
  - `schedule/trigger.rs`: `next_fire_after` once(미래/과거)·cron(매일/매주/간격 다음 발생); `next_fires` N개; `validate_trigger` 잘못된 cron·과거 once 거부; 서버 로컬 TZ 경계.
  - `store/schedules.rs`: insert/get/list/update/delete round-trip(environments 미러) + UNIQUE(name) 위반 + events INSERT/조회 + cascade(스케줄 삭제 시 events 사라짐).
  - **`process_due_schedules(state, now)` 결정론적**(주입 now, `NoopDispatcher`):
    - cron due → run row 생성 + `fired` 이벤트 + `next_run_at` 전진.
    - cron missed(now ≫ next_run_at + grace) → run **미생성** + `missed` 이벤트 + 전진.
    - 겹침(last_run_id가 pending/running) → run 미생성 + `skipped_overlap` 이벤트 + 전진.
    - once due → run 생성 + **`enabled=0`** + `next_run_at=NULL`.
    - once missed → run 생성(1회 늦게) + 비활성화.
    - 발사 검증 실패(없는 데이터셋 등) → `error` 이벤트 + `last_error`; cron 전진/once 비활성.
  - `spawn_run` 추출 후 **`create` 회귀**: 기존 run-create 통합 테스트(api_test/data_binding/presets) 그대로 GREEN(byte-identical 추출 증명). dispatch 실패 → 500 + run failed(기존 `run_dispatch_failure_test` 유지).
  - API: `POST /schedules` 201·UNIQUE 409·잘못된 cron 400·과거 once 400; `preview-next` 다음 N개; CRUD round-trip; **`/schedules/preview-next` 라우트가 `{id}` 캡처에 안 가려짐**(리뷰 MINOR-12).
- **UI(vitest/RTL)**: ScheduleSchema round-trip(trigger discriminated union·null 필드); 트리거 빌더 프리셋→cron 문자열 컴파일(매일/매주/간격); preview-next 표시; 폼 제출 본문; 목록 렌더·enable 토글. **`.nullish()` 서버-null fixture**(absent 아님, S-D 함정).
- **게이트**: `cargo build/clippy/test --workspace`(pre-commit) + `cd ui && pnpm lint && pnpm test && pnpm build`(수동). **라이브 검증**(머지 전): ① `preview-next` 곡선; ② 짧은 cron(예: `* * * * *` 매분) 또는 1초 뒤 once 스케줄 생성 → 틱 후 run 생성 + `fired` 이벤트 확인 → 즉시 비활성/전진 확인(시간 의존이라 `process_due_schedules` 직접 호출 단언이 1차, 라이브는 보조). 실 `/schedules` 응답이 `ScheduleSchema.parse` 통과(S-D 갭 차단).

## 12. 영향 받는 파일(예상)

### 신규
- `crates/controller/src/store/migrations/0011_schedules.sql` — 2 테이블 + 인덱스.
- `crates/controller/src/store/schedules.rs` — `ScheduleRow`/`ScheduleEventRow` + CRUD + events.
- `crates/controller/src/schedule/mod.rs` · `schedule/trigger.rs`(순수) · `schedule/runner.rs`(루프 + `process_due_schedules`).
- `crates/controller/src/api/schedules.rs` — CRUD + preview-next 핸들러.
- `ui/src/pages/SchedulesPage.tsx` · `ui/src/components/ScheduleForm.tsx` · `ui/src/components/TriggerBuilder.tsx`(5모드 빌더 + cron 컴파일) · `ui/src/components/ScheduleEventTimeline.tsx`(상세 뷰 이벤트 이력) · `ui/src/api/schedules.ts`(클라이언트 + React Query 훅).
- **`ui/src/components/profileForm.ts`**(순수 `buildProfile`/`buildCriteria`, 명시 인자) · **`ui/src/components/CriteriaFields.tsx`**(SLO 입력 프레젠테이셔널, aria-label 보존) — RunDialog에서 순수 추출(§9.3 #1), RunDialog·ScheduleForm 공유.

### 변경
- `crates/controller/src/store/mod.rs` — `MIGRATION_SQL_0011` const + execute(0010 뒤). `mod schedules` 선언.
- `crates/controller/src/lib.rs` — `pub mod schedule;` 노출(main.rs spawn용).
- `crates/controller/src/api/runs.rs` — `spawn_run` 추출, `create`가 호출(순수 리팩터).
- `crates/controller/src/api/mod.rs` — `pub mod schedules;`.
- `crates/controller/src/app.rs` — schedules 라우트 4줄 + import.
- `crates/controller/src/main.rs` — `--scheduler-tick-seconds`/`--scheduler-timezone`/`--scheduler-disabled` 인자 + (AppState literal과 `app::router(state)` move 사이) `tokio::spawn(run_scheduler(...))`. e2e 드라이버는 `--scheduler-disabled` 전달.
- `crates/controller/Cargo.toml` (+ 워크스페이스 `Cargo.toml`) — cron 파서(`croner`/`saffron`, 5-field) + `chrono` + `chrono-tz` 의존성(MSRV 1.85/edition 2024 호환 확인, plan 핀).
- `ui/src/api/schemas.ts` — `ScheduleSchema`/`ScheduleSummarySchema`/`TriggerSchema`/`ScheduleEventSchema`(`.nullish()` null 필드). 앱 네비/라우터(`routes.tsx`/`Layout.tsx`) — `/schedules` 등록.
- `ui/src/components/RunDialog.tsx` — **유일한 기존-파일 리팩터**: 인라인 `buildProfile`/`buildCriteria`/SLO JSX를 `profileForm.ts`/`<CriteriaFields>`로 추출하고 import(§9.3 #1). 제출 payload byte-identical + 기존 RunDialog RTL green이 게이트.

### 무변경
proto · 엔진 · 워커 · runs/run_metrics/loop/if/group 메트릭 테이블 · `ReportJson`/`Profile`(직렬화 재사용) · dispatcher trait.

## 13. ADR

신규 **ADR-0034**(Run 스케줄러): 컨트롤러 내장 주기 루프 + once|**5-field cron** 통합 트리거(UI 프리셋이 5-field cron으로 컴파일, `croner`/`saffron`) + 컨트롤러 단일 TZ(`--scheduler-timezone`, 기본 `Asia/Seoul`, `chrono-tz` — `chrono::Local`=컨테이너 UTC 함정 회피) + skip-overlap + skip-missed(once 1회 늦게) + append-only `schedule_events`(알림 이음새) + 단일 인스턴스(leader election 없음) + `spawn_run` 공유 발사 코어 + trigger 검증 400(test-run 422 컨벤션 비위반) + migration 0011. 연기: 알림·per-schedule TZ(+DST 정책)·catch-up·보존정책·프리셋 시드. CLAUDE.md "알아둘 결정들"에 ADR-0034 한 줄 + roadmap 갱신.

## 14. 리뷰 반영 (2026-06-06 spec-plan-reviewer)

`spec-plan-reviewer`가 인용 앵커를 다수 CONFIRMED하고(create 243-372/fire 254-369/validate_run_config/fold_seed/PendingAssignment/worker_count_for/0010 execute :63/try_join :148/RunStatus/ApiError/cron·chrono 미존재/UI 컴포넌트 존재) 아래 findings를 반영:
- **CRITICAL-1 (없는 타입)**: `spawn_run`의 `scenarios::Scenario` → **`scenarios::ScenarioRow`**(`scenarios::get`이 반환하는 실제 타입, `.id`/`.yaml`만 읽음). §6.
- **MAJOR-13 (cron 필드수 silent breakage)**: `cron`(zslayton) 6-7 field가 UI의 5-field crontab을 거부 → **5-field 파서(`croner`/`saffron`)로 확정**, 필드수=5로 §3/§5/§9 통일. 미해결 "plan에서 고정" 펀트 제거.
- **MINOR-8/MAJOR-14 (TZ silently UTC)**: `chrono::Local`=stock 컨테이너 UTC → **`--scheduler-timezone`(IANA, 기본 `Asia/Seoul`, `chrono-tz`)** 로 명시 평가. §3/§5/§12/§13. DST는 v1 UTC/Seoul 무관, per-schedule TZ 후속이 정의.
- **CRITICAL-2/MAJOR-2 (마이그레이션 const 비연속)**: "0001..0010 consts" 오개념 정정 — 0008/0009는 Rust-guarded(const 없음), 0011이 다음. `grep -c MIGRATION_SQL`는 짝 확인용 아님(18 반환). §4.
- **MAJOR-6 (spawn 배치)**: `app::router(state)`가 state move → AppState literal과 `:127` **사이**에 `state.clone()` spawn. §7.
- **MAJOR-4 (env 소유권)**: `spawn_run`이 `to_value`+`clone`을 내부 수행, `create`는 `&body.env`만 — byte-identical 조건 명시. §6.
- **MAJOR-5/MINOR-16 (재검증·None last_run)**: 매 발사 `validate_run_config` 재호출(TOCTOU 의도), `last_run_id`/`runs::get` None=겹침 아님. §7.
- **MAJOR-7 (e2e 루프)**: e2e 드라이버 `--scheduler-disabled`. §7/§12.
- **MAJOR-9/MAJOR-10/MINOR-11 (이벤트 의미)**: 슬롯당 1 이벤트(누적 정리는 후속); once-missed는 cosmetic(kind만); `last_status` 어휘를 event `kind`와 통일(`skipped_overlap`). §3/§4/§7.
- **MINOR-12 (라우트 우선순위)**: `/schedules/preview-next` vs `{id}` static-우선 + 회귀 테스트. §8/§11.
- **MINOR-15 (소진 once 재활성)**: PUT 시 과거 once는 400, run_at 미래로 갱신 필요. §8.
- **422-vs-400 컨벤션**: trigger 검증을 **400**으로(test-run 전용 422 컨벤션 비위반). §8/§10.
- **scope 분할**: 큰 슬라이스 → §15로 34a/34b/34c 분할(spawn_run 추출을 단독 선행).

## 15. 분할 (subagent-driven, 의존성 순서 a→b→c)

리뷰 권고(Slice 8/A3 선례)대로 3 하위 슬라이스로 분할. 각자 spec 동일, plan 별도.

- **34a — 백엔드 코어**(이 plan 대상): cron 파서 + `chrono`/`chrono-tz` 의존성 + `schedule/trigger.rs`(순수 `next_fire_after`/`next_fires`/`validate_trigger`, 단위 테스트) + **`spawn_run` 추출**(`api/runs.rs` 순수 리팩터 — 최고위험, 기존 통합 테스트 byte-identical GREEN이 게이트라 **단독 선행 착지**). 트리거 엔진은 `pub`(lib API)이라 소비자 없어도 dead_code 아님.
- **34b — 영속화 + 루프 + REST**: migration 0011 + `store/schedules.rs`(CRUD+events) + `schedule/runner.rs`(`process_due_schedules`+`run_scheduler`) + main.rs 배선(CLI 3종) + `api/schedules.rs`(CRUD+preview-next) + 라우트. 백엔드 완결(curl 검증).
- **34c — UI**: `SchedulesPage` + `ScheduleForm`(트리거 빌더 4 프리셋 컴파일 + 라이브 preview) + RunDialog 컴포넌트 재사용 + React Query 훅 + 라우팅 + Zod 스키마. 라이브 run 1회.
