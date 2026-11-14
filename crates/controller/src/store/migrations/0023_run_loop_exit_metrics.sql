-- migration 0023: 조건 반복(while loop) 진입 종료 집계 (spec 2026-11-14-loop-while-report §3.3).
-- counts-only 델타 누적. pass_bucket 1..=20 = 그 회차, 21 = "21번째 이후".
-- outcome 0 완료 · 1 중단(최대 횟수) · 2 마치지 못함(run 종료·취소·오류로 끊김).
CREATE TABLE IF NOT EXISTS run_loop_exit_metrics (
  run_id      TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,   -- loop 스텝 id
  pass_bucket INTEGER NOT NULL,
  outcome     INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  pass_sum    INTEGER NOT NULL DEFAULT 0,   -- 칸으로 합치기 전 실제 회차 수의 합
  PRIMARY KEY (run_id, step_id, pass_bucket, outcome)
);
