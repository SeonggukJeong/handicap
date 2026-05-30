CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL,     -- ["email","pw",...] 순서 보존
  row_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,     -- 원본 파일 바이트 수
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_id TEXT NOT NULL,
  idx INTEGER NOT NULL,           -- 0-based
  row_json TEXT NOT NULL,         -- {"email":"a@ex.com",...}
  PRIMARY KEY (dataset_id, idx)
);
