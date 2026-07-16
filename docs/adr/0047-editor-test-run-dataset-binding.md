# 0047. 에디터 test-run 데이터셋 주입 — 서버측 바인딩(단일 요청·전역 상한·run 패리티)

- 상태: 채택됨 (2026-07-16, 설계 사용자 승인)
- 관련: [ADR-0026](0026-scenario-editor-test-run.md)(test-run in-process trace — 이 결정은 그 요청 계약의 additive 확장), [ADR-0022](0022-data-driven-datasets.md)(데이터셋 리소스·4정책 바인딩), [ADR-0013](0013-scenario-runconfig-separation.md)(바인딩이 Scenario가 아닌 run-config에 사는 이유), [ADR-0018](0018-per-vu-cookie-jar.md)(jar 공유 세만틱 근거). 설계: `docs/superpowers/specs/2026-07-16-editor-dataset-testrun-design.md`.

## 맥락

데이터셋 바인딩은 run `Profile`(profile_json)에 살고 test-run 요청(`TestRunRequest`)에는 실릴 자리가 없다 — 기존 test-run 설계(spec §6)가 데이터셋을 v1에서 의도적으로 제외했기 때문. 그래서 데이터 기반 시나리오는 에디터에서 검증 불가(변수가 빈 문자열 + `unbound_vars` 칩). 로드맵 §A12 도그푸딩 항목이 "원하는 1행 선택 주입 / 1VU 순차 진행(전체 또는 N행 검증)"을 요구한다.

두 실현 경로가 있었다: **(A) 서버측 바인딩** — `TestRunRequest`에 데이터셋 구성(dataset_id+mappings+모드)을 추가하고 컨트롤러가 행 로드·매핑 적용·행 루프를 소유. **(B) 클라이언트 주도** — 백엔드는 기존 spec §8-2의 `var_overrides` 맵만 추가(수 줄)하고, UI가 rows API로 행을 가져와 매핑을 TS에서 적용하며 순차 모드는 브라우저가 행마다 test-run을 N번 호출.

## 결정

**서버측 바인딩(A)을 채택한다.** `TestRunRequest`에 optional `dataset: {mode: single_row|sequential, bindings: Vec<{dataset_id, mappings, row_index?}>, start_row?, row_limit?}`를 추가하고, 컨트롤러가 검증·행 로드·매핑 적용(`binding.rs::apply_mappings` 재사용)을, 엔진 신규 래퍼 `trace_scenario_rows`가 클라이언트(cookie jar) 1회 빌드 + 전역 `max_requests` 예산·단일 wall-clock deadline 공유 행 루프를 소유한다.

- **클라 주도(B) 기각**: 순차 N행이 N개 독립 HTTP 요청이 되어 전역 상한이 사라지고(요청마다 wall-clock 120s씩 — 대용량 데이터셋에서 폭주), 매핑 적용이 TS에 중복돼 run과의 주입 패리티가 코드 이원화로 약해지며, 탭 이탈 시 어중간 중단·서버 로그 N건. `var_overrides` 자체는 독립 가치가 있어 §8-2 후속으로 유지(이번 스코프에서 기각이 아니라 연기).
- **모드는 정책 4종이 아니라 2종(single_row/sequential)**: per_vu/iter_random/unique는 멀티 VU·워커 분산 전제라 1 VU 단일 패스 trace에서 무의미하거나 오해 소지. sequential은 "1 VU·단일 워커 iter_sequential"과 정확히 일치하는 부분집합.
- **자동 same-name 매핑은 서버 소유**: `mappings` 빈 배열 = 전 컬럼→동명 변수 주입이 와이어 계약. 클라 계산이면 클라이언트마다 재구현·드리프트.
- **cookie jar는 sequential 행 간 공유**: 실제 run에서 1 VU는 iteration 간 jar를 유지하므로(ADR-0018), 행 간 세션 누적이 보이는 게 검증 도구로서 정직한 미러.
- **와이어는 Vec(멀티 바인딩), UI v1은 단일 데이터셋만 노출**: 후속 멀티 UI 확장 시 계약 무변경.

## 결과

- proto·worker·migration 0-diff — 데이터 흐름이 컨트롤러 in-process에서 끝난다(ADR-0026 유지). `dataset` 필드 없는 요청은 byte-identical.
- 응답은 single_row = 기존 `ScenarioTrace` 그대로(UI 렌더 무변경), sequential = 행별 `ScenarioTrace` 중첩 신규 형태 — 와이어 드리프트 면적을 신규 한 곳으로 제한.
- 데이터셋 값(비밀번호 컬럼 포함)이 test-run trace에 평문 노출 — 기존 env 노출과 동일 클래스이며 일관 마스킹은 §B1 보안 하드닝 트랙 소유. 이 슬라이스는 finish-slice 보안 게이트(`security-reviewer`) 필수 표면.
