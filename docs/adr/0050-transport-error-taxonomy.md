# transport send-실패 분류(taxonomy): 8종 kind 와이어 계약 + counts-only 운반

- Status: accepted
- Date: 2026-08-01
- Slice: error-taxonomy E1 (머지 `2a154db0`), spec `docs/superpowers/specs/2026-08-01-error-taxonomy-design.md`

## Context and Problem Statement

부하 중 transport 실패는 리포트에서 status=0 한 버킷으로 뭉개져 "타임아웃·503 급증"의 정체(수신측 소켓 고갈? DNS? 테스터 자신의 포트 고갈?)를 말하지 못했다. 앵커 사고(2026-08-01 사용자): 수신측 소켓 부족이 원인이었는데 테스터엔 타임아웃·503만 보여 원인 파악이 과도하게 오래 걸렸다. 어디서 분류하고, 무엇을 운반하며, 에러 원문은 어떻게 다루나?

## Decision

- **분류 지점 단일화**: 엔진 executor의 send-Err arm 한 곳에서 `classify_send_error(&reqwest::Error)` → `ExecOutcome.error_kind`, runner의 유일 기록 지점에서 Aggregator 누적. 불변식: send-실패 1건 = 윈도 status "0" 1건 = error_kind 1건.
- **kind 8종 와이어 계약(snake_case verbatim)**: `connect_refused` `connection_reset` `connect_timeout` `timeout` `dns` `tls` `local_port_exhaustion` `other` — proto·DB·report JSON·UI Zod 전 레이어에서 동일 문자열.
- **분류 규칙 5단(best-effort)**: ① 에러 체인의 첫 *매핑되는* io::ErrorKind(AddrNotAvailable→port_exhaustion / ConnectionRefused / ConnectionReset|BrokenPipe — 비매핑 kind는 fall-through로 계속 walk) ② `is_timeout()`(±`is_connect()`로 connect_timeout 분리) ③ `"dns error"` 문자열(is_connect 한정) ④ `"connection closed before message completed"`(keep-alive 조기 종료 → connection_reset) ⑤ tls/certificate/handshake(소문자) — 미스매치는 `Other` 안전 폴백(오분류보다 미분류). 규칙 1·2·4는 실-reqwest 통합 테스트로 핀 고정.
- **counts-only 델타 운반**: `MetricFlush.error_kind_stats`(6드레인/5가드 + 워커 빈-배치 스킵 가드 신항) → proto `MetricBatch.error_kind_stats = 10` → `run_error_kind_metrics` UPSERT 가산(PK `run_id,step_id,kind` — delta형이라 멀티워커 fan-out 머지 무료, `delete_cascade` 7번째 테이블) → `build_report` run-level 롤업(count desc → kind asc) → `ReportJson.error_kinds`(**비면 키 생략**) → UI 분류표(비면 미렌더). transport 에러 0인 run은 전 레이어 byte-identical.
- **에러 원문 비운반**: 최상위 `reqwest::Error`의 `Display`/`Debug`는 URL(크레덴셜 포함 가능)을 렌더 — 분류·테스트 진단 출력에서 금지, 체인은 `e.source()`부터 각 링크의 개별 `to_string()`만. 원문 문자열은 어떤 신규 sink(DB/report/UI)에도 싣지 않는다.
- **비율 분모 = 분류 합**(status=0 총합 아님): 구/신 워커 혼합 fan-out에서도 표가 자기일관(합 100%). E1 단독 run에선 두 값이 항등.

## Considered Options

- rustls/hyper/socket2 직접 의존 다운캐스트 분류 — **기각**(신규 의존 0 원칙, 문자열 best-effort + Other 폴백으로 충분).
- 에러 원문 문자열 영속/표면화 — **기각**(크레덴셜 표면; kind만 운반).
- trace/test-run(에디터) 표면 동시 확장 — **E1 연기**(분류는 부하 경로 전용, `HttpTrace` 무변경).

## Consequences

- proto field 10 additive + 빈 벡터 스킵이라 신/구 워커·컨트롤러 혼합에 안전.
- E2(onset·원인 후보 인사이트)·E3(connect_timeout 노브)가 이 계약 위에 쌓인다. E1 연기 항목(특히 `e.without_url()` 2곳 fold — pre-existing 시크릿 표면)은 `docs/roadmap.md` §B27.
