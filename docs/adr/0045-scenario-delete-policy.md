# 0045. 시나리오 삭제 정책 — 2층 가드 + 앱-레벨 전체 cascade

- 상태: 채택됨 (2026-07-03)
- 관련: [ADR-0022](0022-data-driven-datasets.md)(데이터셋 삭제 2층 가드 — 이 결정이 미러한 패턴), [ADR-0024](0024-run-presets-independent-resource.md)(프리셋 — cascade 대상), [ADR-0034](0034-run-scheduler.md)(스케줄 — cascade 대상), [ADR-0011](0011-mvp-storage-sqlite.md)(SQLite). 설계: `docs/superpowers/specs/2026-07-03-scenario-delete-name-sync-design.md`. 주요 파일: `crates/controller/src/store/scenarios.rs::delete_cascade`, `crates/controller/src/api/scenarios.rs::delete`.

## 맥락

시나리오는 최상위 리소스인데 삭제 수단이 없었다(사용자 보고 2026-07-03). `scenarios(id)`는 `runs`(그 아래 run 메트릭 6테이블)·`run_presets`·`schedules`(+`schedule_events`)가 참조하고 커넥션이 `foreign_keys=ON`이라, 참조를 남긴 삭제는 FK가 거부한다 — 삭제 정책이 선결이다. run 이력은 리포트의 원천이라 무경고 소실은 안 되고, 반대로 "이력 있으면 삭제 불가"는 쓰던 시나리오를 사실상 영구 불멸로 만든다.

## 결정

**데이터셋 삭제(ADR-0022)의 2층 가드를 시나리오로 확장하되, cascade는 앱-레벨 단일 트랜잭션으로 구현한다.**

- **hard 가드**: 활성(pending/running) run이 참조하면 `force`와 무관하게 409 — 실행 중 부하의 발밑 삭제 금지. 권위 판정은 **cascade 트랜잭션 안의 재확인**(핸들러 체크는 advisory fast-fail — 가드↔트랜잭션 사이에 커밋된 run의 silent 좀비-부하 윈도 봉쇄), 잔여 인터리빙은 WAL busy/snapshot(fail-loud 500)과 커밋-후 FK 거부가 막는다.
- **soft 가드**: run 이력·프리셋·스케줄 카운트를 409 JSON으로 반환, UI가 요약 confirm 후 `?force=true`로 전체 cascade(run 이력·리포트 포함).
- **cascade는 앱-레벨**: `DELETE` 순서 = run 메트릭 6테이블 → runs → run_presets → schedules(events는 기존 FK CASCADE) → scenarios. `ON DELETE CASCADE` 마이그레이션은 기각 — SQLite는 기존 테이블 FK 변경이 불가(테이블 재생성 필요)하고, 메트릭 테이블 일부는 FK 자체가 없어 어차피 명시 삭제가 필요하다. migration 0005의 "FK CASCADE를 추가해야" 주석은 이 결정으로 대체(주석 갱신).
- **soft-delete/아카이브 기각**: 목록/조회/run 생성/스케줄러 전 경로 필터가 필요한 과설계 — 사내 도구 규모에 안 맞음(사용자 결정).

## 결과

- 시나리오 CRUD 완결. 참조 카운트가 사용자 확인의 재료가 되고, 활성 run 안전이 서버에서 강제된다.
- run 이력 삭제는 되돌릴 수 없다 — soft 409 confirm이 유일한 방어(감사 로그·undo는 §B1 트랙).
- 드문 spurious 409/500(advisory와 in-tx 판정 사이·EXISTS와 DELETE 사이 동시 쓰기)은 재시도 가능·무손상으로 수용.
