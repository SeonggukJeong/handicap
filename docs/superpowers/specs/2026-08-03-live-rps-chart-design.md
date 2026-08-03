# 실행 중 라이브 RPS·에러 궤적 차트 (live-rps-chart) — 설계

- **날짜**: 2026-08-03
- **유형 태그**: user-path
- **범위**: UI-only (`ui/src`) + 신규 ADR 1건 + 문서. 백엔드/proto/엔진/스토어/migration **0-diff**.
- **관련 결정**: ADR-0009(라이브 대시보드 MVP 제외 — 유지·정밀화), ADR-0012(워커 1초 윈도우 사전 집계), ADR-0017(리포트 1s 시계열). 신규 **ADR-0051**(아래 §6).

## 사용자 스토리 (US)

- **US1**: QA가 부하 run을 걸어두고 자리를 비웠다 돌아온 상황에서 Run 상세 페이지를 열어 실행 중 부하 추이를 파악하려 한다 — 성공하면 run 시작부터 현재까지의 **초당 요청 수 궤적 전체가 시간축 그래프**로 보이고(지금은 누적 평균 카드 1개뿐), 계속 지켜보지 않았어도 ramp-up 상승·정체·급락 같은 변화를 그래프에서 읽어낸다.
- **US2**: 운영자가 실행 중인 run에서 대상 시스템의 열화 징후를 감시하는 상황에서 — 성공하면 **초당 에러 그래프**에서 에러가 언제부터 나기 시작했는지를 run 종료 전에 보고, 계속 둘지 즉시 중단할지를 그 자리에서 결정한다.
- **US3**: QA가 run 종료 직후 사후 분석으로 넘어가는 상황에서 — 성공하면 라이브에서 보던 궤적과 **같은 1초 단위 데이터 기준의 리포트 시계열**이 이어져(동일한 모양), 라이브 표시와 사후 리포트 사이의 불일치를 보지 않는다.

## 1. 문제

run 진행 중 Run 상세 페이지는 누적 평균 RPS 카드 하나만 1초마다 갱신한다(`ui/src/pages/RunDetailPage.tsx:107` `rps = totalCount / durationSeconds`, `:234` 카드 렌더). 시간축 궤적은 종료 후 리포트에서야 보인다(`ui/src/components/report/ReportView.tsx:184-198` — RPS·p95·에러 3종 `TimeSeriesChart`). 따라서 사람이 계속 지켜보지 않으면 실행 중 부하가 어떻게 변했는지(ramp-up이 계획대로 올랐는지, 에러가 언제 시작됐는지) 알 수 없다.

## 2. 사실 기반 (claims ledger — 각 주장 옆 확인 명령, 디스패치 전 재실행 대상)

| # | 사실 | 확인 명령 (worktree 루트) |
|---|---|---|
| F1 | UI는 run이 terminal이 아닌 동안 `/api/runs/{id}/metrics`를 **1초마다 이미 폴링** 중 (`refetchInterval: paused ? false : 1000`) | `grep -n -A 8 "export function useRunMetrics" ui/src/api/hooks.ts` → hooks.ts:196-204 |
| F2 | 응답 `windows` 원소 = `{ts_second(int, unix epoch), step_id, count, error_count, status_counts}` | `grep -n -A 8 "WindowSummarySchema = " ui/src/api/schemas.ts` → schemas.ts:223-230 |
| F3 | 서버 `store::metrics::summary`가 **워커별 행을 (ts_second, step_id)로 이미 merge**해서 반환 — 클라에 같은 (초, 스텝) 중복 행은 오지 않는다. 같은 초의 **스텝 간** 행은 여러 개 온다 | `grep -n -A 30 "pub async fn summary" crates/controller/src/store/metrics.rs` → metrics.rs:65-95 |
| F4 | metrics 핸들러에 run 상태 게이트 없음 — running 중 조회가 정상 경로(404는 run 부재 시만) | `grep -rn -A 8 "pub async fn metrics" crates/controller/src/api/runs.rs` → runs.rs:975-983 |
| F5 | `TimeSeriesChart`는 `{ts_second, value}[]`를 받아 첫 ts를 0으로 접는 재사용 컴포넌트, jsdom 테스트는 explicit `width`/`height` 필요(프로덕션은 ResponsiveContainer) | `sed -n '13,47p' ui/src/components/report/TimeSeriesChart.tsx` |
| F6 | 리포트 시계열 제목 키 = `ko.report.timeSeriesRequests`("초당 요청 수 (RPS)")·`timeSeriesErrors`("초당 에러") — 라이브 제목은 별도 키로 구분 필요 | `grep -n "timeSeriesRequests\|timeSeriesErrors" ui/src/i18n/ko.ts` → ko.ts:975,977 |
| F7 | RunDetailPage 비-terminal 분기(`:246-`)에 삽입 지점 존재 — `EnvBlock`(:261) 앞. 라이브 섹션은 `!terminal` 게이트로 이 분기 안에 둔다 | `sed -n '244,262p' ui/src/pages/RunDetailPage.tsx` |
| F8 | 순수 도출 모듈 선례 = `ui/src/runs/runFilterSort.ts`(+`__tests__/`) — 신규 헬퍼도 `ui/src/runs/`에 둔다 | `ls ui/src/runs/` |
| F9 | 리포트 시계열 도출 `ui/src/report/bySecond.ts`도 **있는 초만**(무-트래픽 초 미채움)·스텝 간 합산·오름차순 정렬 — `liveBySecond`는 입력 타입(`WindowSummary`, 레이턴시 없음)과 후미 트림만 다른 라이브판 | `cat ui/src/report/bySecond.ts` (22줄 전체) |

## 3. 설계

### 3.1 데이터 도출 — 순수 헬퍼 `ui/src/runs/liveSeries.ts`

```ts
export type LiveSecond = { ts_second: number; count: number; errors: number };
export const LIVE_TRIM_TRAILING_SECONDS = 2;
export function liveBySecond(windows: WindowSummary[]): LiveSecond[]
```

- `ts_second`별로 `count`·`error_count`를 합산(**스텝 간** 합산 — 워커 간 merge는 서버가 선처리, F3), 오름차순 정렬.
- **후미 트림**: `max_ts − LIVE_TRIM_TRAILING_SECONDS`보다 큰 초를 제외. 최신 1–2초는 워커 flush(1초 주기)·전송 지연으로 미완성 카운트라, 트림 없이는 차트 우단이 항상 급락한 것처럼 보인다(착시). 기준은 브라우저 시계가 아니라 **데이터 내 max ts**(서버·클라 시계 skew 무관, 결정적, 테스트 용이).
- 빈 입력 → `[]`. 중간 무-트래픽 초(윈도우 행 없음)는 **채우지 않는다** — 리포트 `bySecond`(F9)와 동일 정책이라 라이브·리포트 궤적 모양이 일치(US3). `bySecond`를 직접 재사용하지 않는 이유: 입력 타입이 다르고(`ReportWindow`는 p95 포함, `WindowSummary`는 status_counts 포함) 후미 트림은 라이브 전용 — 5줄짜리 접기를 억지로 공유하면 리포트 경로에 라이브 관심사가 샌다.

### 3.2 표시 — RunDetailPage 라이브 섹션

- 위치: 비-terminal 분기 안, `EnvBlock` 앞(F7). 게이트 `{!terminal && (…)}`.
- 내용: `PageSection`(제목 `ko.runDetail.liveSectionTitle` — "실시간 궤적" 계열, 리포트 제목과 구분되는 문구) 아래 `TimeSeriesChart` 2개:
  - 초당 요청 수: `data = live.map(s => ({ts_second: s.ts_second, value: s.count}))`, yLabel "req/s"
  - 초당 에러: `value: s.errors`, yLabel "errors"
- 도출은 `useMemo(() => liveBySecond(metrics.data?.windows ?? []), [metrics.data])` — **새 fetch 0**, 기존 1초 폴링(F1) 재사용.
- 트림 후 0점(시작 직후·pending)이면 차트 대신 플레이스홀더 텍스트(`ko.runDetail.liveCollecting` — "수집 중…" 계열). 라이브 섹션 자체는 running 진입 시점부터 렌더(빈 화면 깜빡임 방지).
- 신규 문구는 전부 `ko.ts` 신규 키(ADR-0035). 신규↔기존 카탈로그 **양방향 포함관계 grep** 필수(`toHaveTextContent` 부분문자열 함정 — ui/CLAUDE.md).
- 접이식 아님(항상 노출): 이 차트는 running 화면의 **주 목적 콘텐츠**(US1)이지 선택적 부가 정보가 아니다 — [[ui-optional-sections-collapsible]]의 "optional 섹션 접이식" 선호는 적용 대상 아님(그 선호의 대상은 선택 폼 섹션·대량 데이터 테이블).

### 3.3 종료 전환

terminal이 되면 기존 분기 로직대로 라이브 섹션은 사라지고 `ReportView`(리포트 시계열 3종)가 이어받는다 — 같은 1s windows 데이터 기반이라 궤적 모양이 연속(US3). 이 슬라이스는 terminal 분기·ReportView를 **건드리지 않는다**.

## 4. 비목표

- 레이턴시(p50/p95) 라이브 — windows에 없음(F2), 백엔드 diff 필요 → 수요 확인 후 후속.
- per-step 라이브 분해, 라이브 status 분포 차트.
- SSE/WebSocket/서버 push — ADR-0009 기각 유지.
- 서버/proto/스토어 변경 일절, 리포트 화면·ScenarioRunsPage 변경.
- `/metrics` 응답 크기 최적화(run 길이 비례 증가) — 선재 특성, 이 슬라이스는 표시만 추가.

## 5. 에러·엣지

- pending(워커 배정 전): windows 빈 배열 → 플레이스홀더(§3.2).
- metrics fetch 실패: 신규 처리 없음 — 카드·스텝 표도 같은 데이터를 쓰는 선재 거동 유지.
- terminal 직후 report 로딩/실패 구간: 라이브 섹션은 `!terminal` 게이트라 미렌더 — 기존 로딩/에러 배너 거동 불변.
- 곡선/open-loop run: profile 무관(windows만 소비) — 모드별 분기 없음.

## 6. ADR-0051 — 실행 중 진행 차트 (ADR-0009 정밀화)

- **결정**: 이미 수집·영속·폴링되는 1s windows의 **클라이언트 표시**(in-run 진행 차트)는 허용한다. ADR-0009가 기각한 것(스트리밍 인프라·서버 push·전용 라이브 대시보드·APM 대체)은 **불변** — 이 기능은 신규 데이터 경로를 만들지 않는다.
- ADR-0009 파일은 수정하지 않고 신규 ADR이 관계를 서술(MADR 관례), 루트 CLAUDE.md 인덱스에 한 줄 추가.

## 7. 테스트 계획

- **`liveSeries` 단위** (`ui/src/runs/__tests__/liveSeries.test.ts`): 스텝 간 합산 · 오름차순 정렬(입력 역순) · 후미 트림(max_ts−2 초과 제외 — 트림 상수를 0으로 바꾸면 RED가 되는 케이스로 이빨 실증) · 빈 입력 `[]` · 전 초가 트림되는 짧은 run(≤2초 데이터→`[]`).
- **RunDetailPage RTL**: ① running fixture + windows → 라이브 섹션 제목·두 차트 region 존재(recharts SVG는 jsdom size-0이라 존재 단언은 `PageSection` region/제목으로 — report/CLAUDE.md 함정 준수) ② terminal fixture → 라이브 섹션 부재 ③ windows 빈 running → 플레이스홀더 텍스트.
- **게이트(두 상태)**: baseline(변경 전) `pnpm lint && pnpm test && pnpm build` green(현행 그대로) → 변경 후 동일 3종 green + 신규 테스트 포함.
- **라이브 검증(`/live-verify`, US 앵커)**:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | responder+controller+worker로 30s+ run 생성, 실행 중 `/runs/{id}` 열고 t+5s·t+15s 스크린샷 | RPS 차트의 점 개수/우단 x가 증가(궤적이 자란다), 평균 카드가 아닌 시간축 그래프 |
| US2 | 도중부터 5xx를 섞는 responder(또는 지연 후 에러 모드 전환)로 run | 에러 차트에서 에러 시작 시점이 0이 아닌 x 위치에 나타남 |
| US3 | 같은 run 종료 후 리포트 시계열과 라이브 마지막 스크린샷 대조 | 두 그래프의 궤적 모양(피크 위치·상승 구간)이 일치 |

## 8. 알려진 한계 (수용)

- 트림 상수 2초는 휴리스틱 — 워커 flush 지연이 그보다 크면 우단 1점이 낮게 보일 수 있다(다음 폴링에서 자연 보정). 튜너블 상수로 두고 도그푸딩 후 재평가.
- 중간 무-트래픽 초를 채우지 않으므로 x축이 실제 경과시간 대비 압축될 수 있다(요청이 완전히 멈춘 구간) — 리포트 시계열과 동일한 선재 표현이라 US3(일치)이 우선.
