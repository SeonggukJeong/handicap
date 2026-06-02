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

- 도구가 "차트 뷰어"→"릴리스 게이트"로. run 목록 배지·step-level·status-class·run 비교(A4b)·요약(A4c)은 후속.
