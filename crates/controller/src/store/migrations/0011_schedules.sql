-- 예약/반복 run 정의 (top-level 리소스, environments 패턴).
-- CREATE ... IF NOT EXISTS는 멱등(재실행 안전), 0003/0004/0005/0007과 동일.
-- runs 테이블·proto·엔진·워커 무변경. profile_json/env_json은 Profile/맵 스냅샷.
CREATE TABLE IF NOT EXISTS schedules (
    id            TEXT PRIMARY KEY,        -- ULID, server-generated
    name          TEXT NOT NULL,
    scenario_id   TEXT NOT NULL REFERENCES scenarios(id),
    profile_json  TEXT NOT NULL,           -- Profile 스냅샷 (runs/presets와 동일 직렬화)
    env_json      TEXT NOT NULL,           -- ${ENV} 오버레이 (평탄 맵)
    trigger_kind  TEXT NOT NULL,           -- 'once' | 'cron'
    cron_expr     TEXT,                    -- trigger_kind='cron'일 때
    run_at        INTEGER,                 -- trigger_kind='once'일 때 (epoch ms)
    enabled       INTEGER NOT NULL DEFAULT 1,
    next_run_at   INTEGER,                 -- 루프 쿼리 키 (계산값; NULL=발사 예정 없음)
    last_run_id   TEXT,                    -- 마지막 발사한 run (겹침 체크·링크)
    last_fired_at INTEGER,
    last_status   TEXT,                    -- 'fired'|'skipped_overlap'|'missed'|'error' (목록 표시 요약)
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
    kind        TEXT NOT NULL,             -- 'fired'|'skipped_overlap'|'missed'|'error'
    run_id      TEXT,                      -- kind='fired'
    detail      TEXT                       -- 에러 메시지 / skip·miss 사유
);
CREATE INDEX IF NOT EXISTS idx_schedule_events_sched ON schedule_events(schedule_id, at DESC);
