# 실행 중 라이브 RPS·에러 궤적 차트 (live-rps-chart) — 설계

- **날짜**: 2026-08-03 (R1 리뷰 반영 개정)
- **유형 태그**: user-path
- **범위**: UI-only (`ui/src`) + 신규 ADR 1건 + 문서. 백엔드/proto/엔진/스토어/migration **0-diff**.
- **관련 결정**: ADR-0009(라이브 대시보드 MVP 제외 — 아래 §6 참고: 이 슬라이스는 그 "후속은 옵션 2 정도" 한 줄을 **넘어서는 확장**이다), ADR-0012(워커 1초 윈도우 사전 집계), ADR-0017(리포트 1s 시계열). 신규 **ADR-0051**(§6).

## 사용자 스토리 (US)

- **US1**: QA가 부하 run을 걸어두고 자리를 비웠다 돌아온 상황에서 Run 상세 페이지를 열어 실행 중 부하 추이를 파악하려 한다 — 성공하면 run 시작부터 현재까지의 **초당 요청 수 궤적 전체가 시간축 그래프**로 보이고(지금은 누적 평균 카드 1개뿐), 계속 지켜보지 않았어도 ramp-up 상승·정체·급락 같은 변화를 그래프에서 읽어낸다.
- **US2**: 운영자가 실행 중인 run에서 대상 시스템의 열화 징후를 감시하는 상황에서 — 성공하면 **초당 에러 그래프**에서 에러가 언제부터 나기 시작했는지를 run 종료 전에 보고, 계속 둘지 즉시 중단할지를 그 자리에서 결정한다.
- **US3**: QA가 run 종료 직후 사후 분석으로 넘어가는 상황에서 — 성공하면 라이브에서 보던 궤적과 **같은 1초 단위 데이터 기준의 리포트 시계열**이 이어져(동일한 모양), 라이브 표시와 사후 리포트 사이의 불일치를 보지 않는다.

## 1. 문제

run 진행 중 Run 상세 페이지에는 시간축 궤적이 없다. 유일한 RPS 표시인 "평균 RPS" 카드는 `totalCount / durationSeconds`인데(`ui/src/pages/RunDetailPage.tsx:106-107,234`) 분모가 **경과 시간이 아니라 계획된 총 길이**(`profileDurationSeconds`)라, 실행 중에는 진짜 평균조차 아니고 "진행률×평균"으로 계속 낮게 표시되며 우상향한다. 궤적은 종료 후 리포트에서야 보인다(`ui/src/components/report/ReportView.tsx:184-198` — RPS·p95·에러 3종 `TimeSeriesChart`). 따라서 사람이 계속 지켜보지 않으면 실행 중 부하가 어떻게 변했는지(ramp-up이 계획대로 올랐는지, 에러가 언제 시작됐는지) 알 수 없다.

## 2. 사실 기반 (claims ledger — 각 주장 옆 확인 명령, 디스패치 전 재실행 대상)

| # | 사실 | 확인 명령 (worktree 루트) |
|---|---|---|
| F1 | UI는 run이 terminal이 아닌 동안 `/api/runs/{id}/metrics`를 **1초마다 이미 폴링** 중 (`refetchInterval: paused ? false : 1000`) | `grep -n -A 8 "export function useRunMetrics" ui/src/api/hooks.ts` → hooks.ts:196-204 |
| F2 | 응답 `windows` 원소 = `{ts_second(int, unix epoch), step_id, count, error_count, status_counts}` | `grep -n -A 8 "WindowSummarySchema = " ui/src/api/schemas.ts` → schemas.ts:223-230 |
| F3 | 서버 `store::metrics::summary`가 **워커별 행을 (ts_second, step_id)로 이미 merge**해 `acc.into_values()`(BTreeMap=정렬) 반환 — 클라에 같은 (초, 스텝) 중복 행은 오지 않는다. 같은 초의 **스텝 간** 행은 여러 개 온다 | `sed -n '65,105p' crates/controller/src/store/metrics.rs` |
| F4 | metrics 핸들러에 run 상태 게이트 없음 — running 중 조회가 정상 경로(404는 run 부재 시만) | `grep -rn -A 8 "pub async fn metrics" crates/controller/src/api/runs.rs` → runs.rs:975-983 |
| F5 | `TimeSeriesChart`는 `{ts_second, value}[]`를 받아 첫 ts를 0으로 접는 재사용 컴포넌트, jsdom 테스트는 explicit `width`/`height` 필요(프로덕션은 ResponsiveContainer). `PageSection sub ariaLabel={ko.report.timeSeriesAria(title)}` 래핑이라 SVG 없이도 region 존재 | `sed -n '13,47p' ui/src/components/report/TimeSeriesChart.tsx` |
| F6 | 리포트 시계열 제목 키 = `ko.report.timeSeriesRequests`("초당 요청 수 (RPS)")·`timeSeriesErrors`("초당 에러") | `grep -n "timeSeriesRequests\|timeSeriesErrors" ui/src/i18n/ko.ts` → ko.ts:975,977 |
| F7 | RunDetailPage 본문은 `terminal && report.data ? <ReportView/> : (else 가지)` — **else 가지는 `!(terminal && report.data)`** 다(비-terminal 분기가 아님). terminal run도 리포트 로딩(`:253`)/실패(`:248`) 중엔 else 가지에 들어온다. 삽입 지점은 else 가지 안 `EnvBlock`(:261) 앞 | `sed -n '244,262p' ui/src/pages/RunDetailPage.tsx` |
| F8 | 순수 도출 모듈 선례 = `ui/src/runs/runFilterSort.ts`(+`__tests__/`) — 신규 헬퍼도 `ui/src/runs/`에 둔다 | `ls ui/src/runs/` |
| F9 | 리포트 시계열 도출 `ui/src/report/bySecond.ts`도 **있는 초만**(무-트래픽 초 미채움)·스텝 간 합산·오름차순 정렬 — `liveBySecond`는 입력 타입(`WindowSummary`, 레이턴시 없음)과 후미 트림만 다른 라이브판 | `cat ui/src/report/bySecond.ts` (22줄 전체) |
| F10 | **엔진은 완성된 초만 내보낸다**: `Aggregator::drain_completed`는 `ts < up_to_second`만 드레인("most recent (live) bucket keeps accumulating"), flusher 주기는 500ms×3경로, 워커는 즉시 gRPC 전달, 컨트롤러 주석 "Each window is a complete per-second snapshot emitted once per worker". 단일 워커에서 `/metrics`의 마지막 행은 완성값이고, 아직 안 끝난 초는 **행 자체가 없다**. 부분합이 보일 수 있는 유일한 라이브 벡터 = **멀티워커 도착 skew**(워커별 flush 지터 ≤~500ms+전송 — 최신 초의 merge 합이 일부 워커 도착 전일 수 있음). run 종료 시 `drain_all`(runner.rs:331·:1000·:1502, 3경로)의 마지막 부분 초는 terminal 이후라 라이브 표시와 무관 | `sed -n '145,155p;374,388p' crates/engine/src/aggregator.rs` · `grep -n "from_millis(500)" crates/engine/src/runner.rs` → :268,:824,:1325 · `sed -n '20,26p' crates/controller/src/store/metrics.rs` |
| F11 | ADR-0009 옵션 2 = "진행률·현재 RPS·에러 카운트 **수치만, 차트는 종료 후**", Consequences가 "라이브 차트 라이브러리 등 인프라 전부 제외" + 후속은 "옵션 2 정도로" 명시. roadmap.md:147("영구 제외… ADR 재검토부터")·:190("명시적 비목표: 라이브 대시보드 경쟁")이 동반 갱신 대상 | `sed -n '1,50p' docs/adr/0009-no-live-dashboard-mvp.md` · `sed -n '145,149p;188,192p' docs/roadmap.md` |
| F12 | else 가지의 메트릭 윈도우 표가 무데이터 상태 문구를 이미 담당: `terminal ? noMetrics("기록된 메트릭이 없습니다.") : waitingFirstBatch("첫 배치 대기 중…")` — 라이브 섹션에 별도 플레이스홀더 불요 | `grep -n "waitingFirstBatch\|noMetrics" ui/src/pages/RunDetailPage.tsx ui/src/i18n/ko.ts` → RunDetailPage.tsx:336, ko.ts:1161-1162 |
| F13 | 신규 ko 값 **"라이브 궤적"**은 기존 카탈로그 쌍따옴표 리터럴 880개와 **양방향** 포함관계 없음 — 유일 매치는 공백 1글자 리터럴 `" "`(모든 다단어 문구에 포함되는 구조적 예외, 검사 무의미). 참고: 초안 후보 "실행 궤적 (라이브)"는 기존 값 "실행"(`ko.runDetail.heading`, :1169 — 이 페이지 h2)·"행"(:1375)을 포함해 **탈락**(R2 NF1) | `python3 -c "import re;t=open('ui/src/i18n/ko.ts',encoding='utf-8').read();lits=set(re.findall(r'\"([^\"\n]+)\"',t));n='라이브 궤적';print([s for s in lits if s!=n and (s in n or n in s)])"` → `[' ']` |

## 3. 설계 (normative 항목은 **N-id** — plan·리뷰 인용 앵커)

### 3.1 데이터 도출 — 순수 헬퍼 `ui/src/runs/liveSeries.ts`

```ts
export type LiveSecond = { ts_second: number; count: number; errors: number };
export const LIVE_TRIM_TRAILING_SECONDS = 1;
export function liveBySecond(windows: WindowSummary[]): LiveSecond[]
```

- **N1**: `ts_second`별 `count`·`error_count` 합산(**스텝 간** 합산 — 워커 간 merge는 서버 선처리, F3), 오름차순 정렬, 무-트래픽 초 미채움(F9의 `bySecond`와 동일 정책 — US3의 모양 일치 근거). `bySecond` 직접 재사용은 안 함: 입력 타입이 다르고(`ReportWindow`는 p95 포함) 트림은 라이브 전용.
- **N2 (후미 트림 = 1초)**: `max_ts` 행을 표시에서 제외. **근거는 멀티워커 도착 skew뿐이다(F10)** — 단일 워커 행은 도착 즉시 완성값이지만, fan-out run에서는 최신 초의 merge 합이 일부 워커 도착 전 부분합일 수 있어 우단이 순간 급락처럼 보였다가 다음 폴링에 회복하는 흔들림이 생긴다. 1초 트림이 이를 제거한다. 워커 수 분기(멀티워커일 때만 트림)는 **하지 않는다** — 분기 오류 위험 대비 단일 워커의 비용이 "완성 초 1개를 1초 늦게 표시"뿐이라 균일 적용이 싸다. 기준은 브라우저 시계가 아니라 데이터 내 `max_ts`(시계 skew 무관·결정적).
- **N3**: 빈 입력 → `[]`. 트림으로 전량 제거되는 1초짜리 데이터도 `[]`.

### 3.2 표시 — RunDetailPage 라이브 섹션

- **N4 (위치·수명)**: else 가지(F7 — `!(terminal && report.data)`) 안, `EnvBlock`(:261) 앞. **별도 status 게이트 없음** — 가지 위치 자체가 게이트다. 즉 pending(데이터 없음→N5로 미렌더)·running뿐 아니라 **terminal+리포트 미적재(로딩/실패) 구간에도 남는다**. 근거: [중단] 직후 차트가 즉시 사라지면 US2(그 자리에서 결정)와 충돌하고, 리포트 fetch 실패 시 궤적을 영영 못 보게 된다. 같은 가지의 메트릭 표가 이미 terminal을 의도적으로 지원(F12)하는 것과 동일 규칙. `report.data` 도착 순간 가지가 뒤집혀 ReportView가 대체.
- **N5 (빈 시리즈 미렌더)**: `liveBySecond` 결과가 0점이면 섹션 통째 미렌더. 대기 안내는 기존 메트릭 표의 `waitingFirstBatch`가 담당(F12) — **신규 플레이스홀더 키를 만들지 않는다**(유사 문구 2개 동시 노출 방지).
- **N6 (구성·카피)**: `PageSection`(title=`ko.runDetail.liveSectionTitle` = **"라이브 궤적"**, ariaLabel 동일 값) 안에 `TimeSeriesChart` 2개. (초안 "실행 궤적 (라이브)"는 F13 양방향 sweep에서 기존 값 "실행"·"행" 포함으로 탈락 — 단방향 grep이 이를 놓쳤던 것이 R2 NF1.) 차트 제목·yLabel·aria는 **리포트 키 재사용**: `ko.report.timeSeriesRequests`("초당 요청 수 (RPS)", yLabel "req/s")·`ko.report.timeSeriesErrors`("초당 에러", yLabel "errors") — 라이브·리포트는 상호배타 분기라 동일 화면 공존이 없고, 같은 제목이 US3(연속성)을 오히려 강화한다. **신규 ko 키는 `liveSectionTitle` 1개뿐**(F13 사전 sweep 통과 — 구현 시 신규↔기존 양방향 포함관계 전수 재sweep, ui/CLAUDE.md `toHaveTextContent` 부분문자열 함정).
- **N7 (도출 배치)**: `useMemo(() => liveBySecond(metrics.data?.windows ?? []), [metrics.data])` — **훅 구역**(기존 `stepTotals` useMemo `:78-88` 인접, early return `:90-92` **위**). 새 fetch 0 — 기존 1초 폴링(F1) 재사용.
- 접이식 아님(항상 노출): running 화면의 주 목적 콘텐츠(US1)이지 선택 부가 정보가 아니다 — [[ui-optional-sections-collapsible]]의 대상(선택 폼 섹션·대량 데이터 테이블) 아님.

### 3.3 종료 전환

`report.data` 도착 시 ReportView(시계열 3종)가 대체한다. 같은 1s windows 기반(F9·report.rs도 (ts,step) 워커 병합)이라 **겹치는 구간의 궤적 모양은 일치**한다. 단 우단은 설계상 다르다: 라이브는 꼬리 1초 트림(N2), 리포트는 `drain_all`의 마지막 부분 초까지 포함 — US3 검증 기준은 "겹치는 구간 일치 + 라이브 우단이 리포트보다 ≤2초 짧음"(§7 표).

## 4. 비목표

- 레이턴시(p50/p95) 라이브 — windows에 없음(F2), 백엔드 diff 필요 → 수요 확인 후 후속.
- per-step 라이브 분해, 라이브 status 분포 차트.
- SSE/WebSocket/서버 push·신규 차트 라이브러리 — ADR-0009 기각 유지(recharts는 리포트용으로 이미 번들).
- 서버/proto/스토어 변경 일절, 리포트 화면·ScenarioRunsPage 변경.
- `/metrics` 응답 크기 최적화(run 길이 비례 증가) — 선재 특성, 이 슬라이스는 표시만 추가.

## 5. 에러·엣지

- pending(워커 배정 전): windows 빈 배열 → N5로 섹션 미렌더, 메트릭 표 `waitingFirstBatch`가 안내.
- metrics fetch 실패: 신규 처리 없음 — 카드·스텝 표도 같은 데이터를 쓰는 선재 거동 유지.
- terminal+리포트 미적재: 섹션 유지(N4) — 기존 로딩/에러 배너와 공존. 이 구간엔 끝난 run 위에 "라이브 궤적" 제목이 수 초 남는다 — 수용(리포트 도착 즉시 대체, R2 NF3).
- 트래픽 정체(midrun stall): `max_ts`가 멈추므로 트림이 마지막 실데이터 1초를 계속 숨긴다 — 기존 stall 배너(`RunDetailPage.tsx:206`)가 정체 자체를 알리므로 수용(§8).
- 곡선/open-loop run: profile 무관(windows만 소비) — 모드별 분기 없음.

## 6. ADR-0051 — 실행 중 진행 차트 (ADR-0009의 후속-범위 한 줄을 확장)

- **결정**: 이미 수집·영속되고 이미 1초 폴링 중인 1s windows의 **클라이언트 표시**(in-run 진행 차트)를 허용한다. 이는 ADR-0009가 후속 한도로 남긴 "옵션 2 정도(수치만, 차트는 종료 후)"를 **넘어서는 확장**이므로 정직하게 그 한 줄을 supersede한다고 서술한다(F11). 유지되는 것: WebSocket/SSE·시계열 DB·서버 push·전용 라이브 대시보드·APM 대체는 여전히 비목표 — **이 기능은 신규 데이터 경로도, 신규 라이브러리도 만들지 않는다**(recharts·폴링·windows 전부 기존).
- **동반 문서 갱신**(이 슬라이스 범위): ① `docs/roadmap.md:147` — "영구 제외" 불릿에 ADR-0051 범위 분리 반영(in-run 진행 차트 출하, 스트리밍 대시보드는 계속 제외) ② `docs/roadmap.md:190` — 비목표 문구에 "(in-run 진행 차트는 ADR-0051로 허용)" 주석 ③ 루트 `CLAUDE.md` 라이브 대시보드 문장(line 9)에 ADR-0051 병기 ④ 루트 CLAUDE.md "알아둘 결정들"에 0051 한 줄.

## 7. 테스트 계획

- **`liveSeries` 단위** (`ui/src/runs/__tests__/liveSeries.test.ts`): 스텝 간 합산 · 오름차순 정렬(입력 역순) · 후미 트림(max_ts 행 제외) · 빈 입력 `[]` · 1초짜리 입력 전량 트림 `[]`. **트림 테스트의 기대 `ts` 값은 하드코딩 리터럴로 쓰고 `LIVE_TRIM_TRAILING_SECONDS` import 금지** — 상수를 기대값 계산에 쓰면 상수를 0으로 바꿔도 기대가 같이 움직여 영원히 GREEN(자기참조 공허, [[plan-mandated-vacuous-tests]] 클래스). 이빨 실증 = 상수를 일시 0으로 → 트림 케이스 RED → 원복 GREEN.
- **RunDetailPage RTL** (기존 fixture 패턴 `RunDetailPage.test.tsx:583-655` 참고). **존재-단언 fixture는 서로 다른 `ts_second` ≥2 필수** — N2 트림이 `max_ts` 행을 제거하므로 단일 초 fixture는 N3·N5 합성으로 섹션이 절대 렌더되지 않는다(기존 파일의 1~2행 windows fixture를 그대로 복사하면 원인 안 보이는 실패):
  1. running + windows(`ts_second` 2종 이상) → 섹션 title("라이브 궤적") + 차트 region 2개 존재(recharts SVG는 jsdom size-0 — 존재 단언은 F5의 PageSection region/제목으로).
  2. **terminal + report.data 적재** → 섹션 부재(ReportView 가지 — 섹션을 삼항 밖으로 호이스팅하면 RED가 되는 배치 이빨).
  3. **terminal + report 에러 + windows(`ts_second` 2종 이상)** → 섹션 존재(N4 수명 핀 — `!terminal` 게이트를 넣는 회귀를 잡는다).
  4. running + windows 빈 배열 → 섹션 부재(N5).
- **게이트(두 상태)**: baseline 실측 완료 — `pnpm lint`=0 · `pnpm test`=0(**211 files / 2439 tests passed**) · `pnpm build`=0 (`/tmp/live-rps-chart-ui-baseline.log`, 파이프 없는 exit 캡처). 변경 후 동일 3종 green + 신규 테스트 포함.
- **라이브 검증(`/live-verify`, US 앵커)**: 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker` 선행) + `just ui-build`로 fresh `ui/dist` + `./target/debug/controller --db /tmp/live-rps-chart.db --ui-dir ui/dist --rest 127.0.0.1:8095 --grpc 127.0.0.1:8094`(8080 회피 — 남의 프로세스 함정) + python responder.

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 30s+ run 생성, 실행 중 `/runs/{id}` 열고 t+5s·t+15s 스크린샷 | RPS 차트의 점 개수/우단 x가 증가(궤적이 자란다), 시간축 그래프로 표시 |
| US2 | 도중부터 5xx를 섞는 responder로 run | 에러 차트에서 에러 시작 시점이 0이 아닌 x 위치에 나타남 |
| US3 | 같은 run 종료 후 리포트 시계열과 라이브 마지막 스크린샷 대조 | **겹치는 구간**의 피크 위치·상승 구간 일치 + 라이브 우단이 리포트보다 ≤2초 짧음(트림 1초+마지막 부분 초) |
| N4 | run 실행 중 [중단] 클릭 직후 관찰 | 리포트 렌더 전까지 라이브 섹션이 남아 있고, 리포트 도착 시 대체됨 |

## 8. 알려진 한계 (수용)

- 트림 1초(N2): 트래픽 정체 시 마지막 실데이터 1초가 계속 숨는다(stall 배너가 정체를 별도 고지) · 단일 워커에선 완성 초 1개가 1초 늦게 보인다. 튜너블 상수 — 도그푸딩 후 재평가.
- 중간 무-트래픽 초를 채우지 않으므로 x축이 실제 경과시간 대비 압축될 수 있다 — 리포트 시계열과 동일한 선재 표현이라 US3(일치)이 우선.
- 멀티워커 skew가 1초를 넘는 극단 상황(네트워크 지연 등)에선 우단 1점이 낮게 보일 수 있다 — 다음 폴링에서 자연 보정.
