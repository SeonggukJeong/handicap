# 0028. Run-level SLO/pass-fail criteria (리포트 verdict)

- 상태: 채택
- 날짜: 2026-06-03

## 맥락

ADR-0017이 "run간 비교·SLA는 후속"으로 연기. A4a로 SLA(pass/fail)를 실현.
리포트는 "무엇이 일어났나"는 답하지만 "합격인가"는 못 답함.

## 결정

- run-level criteria만(p50/p95/p99·error_rate·min_rps). step-level/status-class는 후속.
- criteria를 `store::runs::Profile`(profile_json)에 스냅샷 저장 — 마이그레이션·proto·엔진·워커 무변경. 프리셋 자동 포함.
- completed run에 한해 `build_report`가 on-demand로 verdict 계산(B2). 멀티워커 finalize 경로 미접촉, 완료-시점 race 없음.
- 고정 per-metric 모델, 출력(`Verdict`/`CriterionResult`)은 A2 일반 연산자/step-level 대비 일반형.
- error_rate = 엔진 `error_count`(transport+assertion+extract 실패) / count. 생 4xx/5xx는 status assertion 없으면 미포함 — 한계 문서화, status-class 후속의 근거.

## 결과

- 도구가 "차트 뷰어"→"릴리스 게이트"로. run 목록 배지·step-level·run 비교(A4b)·요약(A4c)은 후속.

## B6 확장 (2026-06-06): status-class + per-window RPS criteria

A4a의 두 연기 항목(§결과의 status-class)을 한 슬라이스로 추가. fixed-field `Criteria` + 일반형 `Verdict` 출력을 그대로 확장 — **엔진·워커·proto·마이그레이션 무변경, 출력 스키마(`Verdict`/`CriterionResult`) 무변경**(신규 metric 행은 `metric: string`이라 자동 통과).

- **status-class**: `max_4xx_rate`/`max_5xx_rate`(분수) + `max_4xx_count`/`max_5xx_count`(u64). rate 분모 = **HTTP 응답 수**(status 첫 글자 1–5, transport 실패 `"0"` 제외) = insights `status_class` 분모와 **공유 헬퍼**(`report::http_response_total`/`status_class_count`)로 단일화 → VerdictPanel·InsightPanel 숫자 일치(divergence 방지). error_rate(엔진 실패 비율)가 못 잡는 raw 4xx/5xx를 status_distribution으로 직접 평가.
- **per-window 최소 RPS**: `min_window_rps`(per-second 총 RPS의 정상상태 최소값) + 수식자 `rps_warmup_seconds`. 첫·마지막 부분초를 **항상 제외** + 앞 warmup초 trim. eligible 윈도 부족(짧은 run·과대 warmup)이면 **criterion skip**(거짓 FAIL 금지), 전 기준 skip이면 verdict `None`. warmup prefill은 RunDialog closed-loop만(open-loop은 수동 — ramp=0 주입 시 거짓 FAIL).
- `rps_warmup_seconds`는 수식자라 `has_any`/`sloActiveCount`/`criteriaHasValue`에서 제외(그것만으론 verdict 미생성).
- `Criteria`는 `profile_json` serde-default라 마이그레이션 0. `validate_criteria`가 rate 0..=1+유한, min_window_rps>=0+유한 검증(count/warmup은 타입으로 충분).
- 라이브 검증: 200/404/500 stub closed-loop run(6455 req)에서 `/report.verdict`가 5행(4xx_rate/5xx_rate/4xx_count/5xx_count/min_window_rps 고정 순서) 정확 산출 + 실 응답이 UI `ReportSchema.parse` 통과(S-D 갭 차단).
