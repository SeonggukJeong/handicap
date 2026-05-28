# Slice 5 — UI 수동 점검 (Report 화면)

Slice 4의 점검 환경(`docs/dev/ui-slice-4-manual-check.md`)을 그대로 사용. wiremock + cargo dev + vite dev.

## 사전

Slice 4 매뉴얼의 **사전 — wiremock stub 등록** 절차로 `/login` + `/me` (또는 `/profile`) stub을 띄운다.

## §1 — 토큰 시나리오로 리포트 생성

1. `/scenarios/new` 에서 토큰 인증 시나리오를 만든다 (Slice 4 §1 그대로).
2. `Run` 다이얼로그: `vus=2`, `duration=10`, `ramp_up=2`, `env: BASE_URL=http://localhost:9090`.
3. 실행 페이지에서 라이브 진행률이 갱신되는 것 확인 (Steps · Env · Profile · Metric windows).
4. 10초 + α 뒤 status 가 `completed` 로 바뀌면 **페이지가 자동으로 Report 뷰로 전환** 되는지 확인.
5. Report 뷰 각 섹션 확인:
   - Summary: 7장 카드 (count · errors · rps · duration · p50 · p95 · p99). 모든 숫자가 0이 아님.
   - Time series 3개: Requests/sec, p95 응답시간, Errors/sec. SVG가 그려졌고 점이 시간순으로 정렬.
   - Status codes 바 차트: `200` 막대가 보임. 5xx 가 있으면 빨강(현재 단일색이지만 향후 확장).
   - Per-step stats 테이블: 각 스텝의 이름·method·resolved URL·요청수·에러수·p50/p95/p99.
   - Scenario YAML (run-time snapshot): 토글 버튼으로 펼침. 실행 시점의 YAML이 그대로 보임.
   - **Download JSON** 버튼: 클릭 시 `run-{id}.json` 파일이 다운로드 됨. 열어서 `summary.count`, `windows[]`, `steps[]` 가 들어있는지 확인.

## §2 — 세션(쿠키) 시나리오로 리포트 생성

Slice 4 §2의 세션 시나리오를 같은 흐름으로 실행. Report 뷰가 동일하게 그려져야 한다. `cookie_jar: auto` 가 scenario_yaml snapshot에 그대로 포함되는지 확인 (snapshot은 실행 시점이라 이후 시나리오 편집이 영향을 주면 안 됨).

## §3 — Failed / Aborted 런의 리포트

1. wiremock stub을 의도적으로 깨거나(`DELETE /__admin/mappings`) 잘못된 URL로 시나리오 실행 → status `failed` 또는 모든 요청 5xx.
2. Report 뷰가 여전히 정상 렌더되고 `summary.errors > 0`, status_distribution에 5xx가 보이는지 확인.
3. 긴 시나리오를 시작 후 즉시 Abort → status `aborted` → Report 뷰가 partial 데이터로 렌더되는지 확인 (count > 0 if any requests fired).

## §4 — 게이트

- `pnpm lint && pnpm test && pnpm build` 통과
- `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` 통과
- CLAUDE.md 의 "Slice 5 결과:" 단락 추가됨

## 알려진 한계

- p95 시계열은 한 초의 step 간 max를 보여줌. 정확한 per-step 시계열은 ADR-0017 OUT의 "백분위 히스토그램" 항목과 함께 후속.
- Report 페이지 URL은 `/runs/:id` 그대로 (별도 `/runs/:id/report` 분리는 의도적 — 같은 URL이 progress↔report 전환).
- Recharts 차트의 dark mode 대응은 후속.
