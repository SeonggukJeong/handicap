# 0046. open-loop 부하 단위 — target_rps는 반복(도착)/초로 공식화

- 상태: 채택됨 (2026-07-12)
- 관련: [ADR-0031](0031-open-loop-arrival-rate-execution-model.md)(open-loop 도입 — 이 결정이 그 단위 의미를 공식화), [ADR-0032](0032-multi-stage-open-loop-rate-curve.md)(stages 곡선 — stage `target`도 같은 단위), [ADR-0038](0038-multi-worker-open-loop.md)(fan-out — `max_in_flight` 총량 분할의 사용자-가시 함의). 설계: `docs/superpowers/specs/2026-07-12-open-loop-slot-sizing-design.md`(슬라이스 ①). 결정 배경 실측: 2026-07-12 재현 세션(아래 맥락).

## 맥락

엔진 open-loop 스케줄러(`runner.rs::run_scenario_open_loop`)는 `target_rps` 틱마다 **시나리오 반복 1회**(`run_arrival` — 모든 스텝 + per-step think time, 슬롯 1개를 반복 내내 점유)를 발사한다. 즉 실제 단위는 **반복(도착)/초**다. 그런데 ① UI 라벨은 "RPS — 초당 요청 수"로 약속하고(`ko.ts`), ② 슬롯 권장(`sizing.ts::recommendSlots`)·사후 포화 인사이트 `required`(`insights.rs`)는 **요청 1건의 평균 지연**을 점유시간으로 쓴다. 실측 재현(100ms responder·target 20·15s): 2-스텝 시나리오는 슬롯 충분 시 요청 39.7/s(라벨 대비 2배 초과), 헬퍼 권장 슬롯으론 dropped 40%; think 1s 시나리오는 목표의 13%(2.7 RPS)로 plateau하며 인사이트가 `cause=loadgen`+워커 증설(7→20 발산)을 권장 — 그러나 open-loop fan-out은 `max_in_flight`를 워커 수로 **분할**하므로 워커 증설로 RPS 불변(2.7→2.7). 반복 점유시간 기반 슬롯 23으로는 목표 도달(19.9 RPS·dropped 0).

단위를 확정해야 공식·라벨·리포트를 정합시킬 수 있다.

## 결정

**open-loop `target_rps`·stage `target`의 공식 단위 = 반복(도착)/초.** 요청/초는 결과를 읽는 단위(리포트 RPS)로만 유지한다.

- **요청/초 공식화 기각**: 엔진이 요청/초를 정확히 페이싱하려면 `target ÷ K`(K=반복당 요청 수) 환산이 필요한데, `if` 분기 시나리오에서 K는 실행 전 확정 불가(분기별 요청 수 상이) — 정적 근사는 데이터 의존 오차로 "설정과 다른 부하 silent 발생"을 재도입하고([[load-divergence-explain-confirm]] 제품 원칙 위반), 피드백 제어는 진동·재현성 저하·dropped 의미 오염. 주류 open-loop 도구(k6 `constant-arrival-rate`=iterations/s, Gatling open model=users/s, Artillery=arrivals/s) 전부 반복/초이고, 사내 QA 관례 어휘 TPS(초당 트랜잭션)와도 정합. 반복/초는 슬롯만 충분하면 **정확히 약속·달성·검증 가능**한 유일한 단위(미달분은 전량 `dropped` 계수).
- **사이징·진단은 반복 점유시간 기반으로 교정**(슬라이스 ①): `required = ceil(목표 도착률 × 점유시간)`, 점유시간은 실측 `max_in_flight ÷ 달성 도착률`(포화 중 항등식 — think·멀티스텝·분기 자동 반영). cause는 2-way(slots/sut)로 축소 — loadgen(워커 CPU)은 현 텔레메트리로 판별 불가(측정 지연이 CPU 포화와 동반 상승해 잔차 신호 소멸)라 사후 `recommended_workers`와 함께 제거, 워커 텔레메트리 추가 후 재도입.
- **표면 정합은 2슬라이스 분할**: ①(공식·귀속·헬퍼) → ②(목표 입력 라벨에서 "RPS" 제거→"도착률(초당 반복)", 설정 시 "≈ 요청 N/s" 라이브 환산 병기, 리포트 목표/달성 도착률 표기). 전문가·초보자 모두 해석에 어려움이 없어야 한다(사용자 요구): 설정은 약속 가능한 단위로, 확인은 익숙한 단위로.
- **와이어 필드명 `target_rps`는 호환 유지**(YAML/API/profile_json/proto) — 개명은 표시 계층에서만. closed-loop(VU 기반)·리포트 RPS·closed VU 사이징 헬퍼(요청/초 관측 기반 역산)는 무변경.

## 결과

- 엔진 0-diff(현 동작의 공식화). 단일 스텝 시나리오는 두 단위가 일치해 기존 사용 영향 없음.
- 곡선 run의 실측 점유시간은 저율 구간 유휴가 섞여 과대(=권장 슬롯 상한) 추정 — 안전 방향이며 "(상한 추정)" 병기, per-second dropped 시리즈 도입 시 정밀화.
- 사전 권장(UI 헬퍼)과 사후 인사이트의 parity는 "포화 prior run의 recommended passthrough"로 by-construction 격상.
