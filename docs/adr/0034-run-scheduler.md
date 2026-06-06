# 0034. Run 스케줄러 (예약/반복 실행)

- 상태: 채택
- 날짜: 2026-06-06

## 맥락

종료 run을 매번 손으로 `POST /api/runs` 하지 않고 특정 일시(once) 또는 반복(cron)으로
자동 발사하고 싶다. 반복 발사가 SLO verdict(A4a)·run 비교(A4b)·insights(A4c)와 맞물려
성능 회귀 감시 루프가 된다. (spec: `2026-06-06-run-scheduler-design.md`)

## 결정

- **아키텍처**: 컨트롤러 내장 주기 `tokio::spawn` 루프(외부 K8s CronJob·사이드카 기각).
  컨트롤러는 db+coord+dispatcher를 쥔 always-on 조정자라 새 인프라 0.
- **트리거**: once(epoch ms) | cron(**5-field 표준 crontab**) 2종. UI 프리셋(매일/매주/간격)은
  클라에서 5-field cron으로 컴파일, 고급 탭은 raw cron. cron 파서 `croner`, `validate_trigger`가
  필드수==5 강제(croner는 6·7-field도 파싱하므로).
- **TZ**: 컨트롤러 단일 IANA TZ(`--scheduler-timezone`, 기본 `Asia/Seoul`, `chrono-tz`).
  `chrono::Local`은 stock 컨테이너에서 조용히 UTC라 명시. main.rs가 1곳에서 파싱해
  `AppState.scheduler_tz`로 주입(루프 + REST가 단일 소스 공유). per-schedule TZ는 연기.
- **의미론**: 겹침=skip(`skipped_overlap` 이벤트), 놓친 발사(다운)=버리고 전진(cron, grace
  300s) / once는 grace 무관 1회 발사 후 비활성. 모든 주목 이벤트를 append-only
  `schedule_events`에 기록(알림 레이어의 이음새).
- **발사 코어**: `api::runs::spawn_run`(34a 추출)을 REST `create`와 스케줄러 루프가 공유.
  매 발사 시 `validate_run_config` 재호출(생성 후 무효화 잡음 — TOCTOU 의도).
- **profile/시나리오**: profile/env는 스케줄 자체 스냅샷(profile_json/env_json), 시나리오 YAML은
  발사 시점 현재본 스냅샷(runs.insert 기존 동작).
- **저장**: migration 0011(`schedules` + `schedule_events`, `CREATE TABLE IF NOT EXISTS`).
  runs/proto/엔진/워커 무변경.
- **검증 HTTP 코드**: trigger 검증 위반·과거 once = **400**(test-run 전용 422 컨벤션 비위반),
  UNIQUE(name) = 409, 없는 시나리오 = 404.
- **동시성**: 단일 인스턴스(ADR-0011), leader election 없음. 단일 루프 + 틱당 순차.

## 연기

알림(이메일/슬랙/웹훅, 이음새=`schedule_events`)·per-schedule TZ(+DST 정책)·catch-up 모드·
`runs.schedule_id` 역링크·이벤트 보존정책·프리셋에서 시드·멀티 컨트롤러.

## 결과

QA가 매니페스트 없이 반복 부하를 예약(제품 전제 ADR-0001). 백엔드(34a/34b) 완결 후
UI(34c)로 노출. 34a = 순수 트리거 엔진(`schedule/trigger.rs`) + `spawn_run` 추출. 34b =
영속화(migration 0011 + `store/schedules.rs`) + 컨트롤러 내장 `run_scheduler` 루프
(`schedule/runner.rs`) + CRUD/preview-next/events REST(`api/schedules.rs`) + main.rs CLI 3종
(`--scheduler-tick-seconds`/`--scheduler-timezone`/`--scheduler-disabled`) 배선.
