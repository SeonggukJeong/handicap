-- step_templates: 재사용 스텝 시퀀스 스냅샷 (ADR-0036).
-- steps_yaml = 시나리오 `steps:` 배열과 동일 포맷의 YAML 텍스트.
-- 복사-삽입 시맨틱이라 어디서도 참조하지 않음 → DELETE 무가드 (environments와 동일).
-- created_at/updated_at = epoch milliseconds (now_ms — UI가 new Date(ms) 가정).
CREATE TABLE IF NOT EXISTS step_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  steps_yaml TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
