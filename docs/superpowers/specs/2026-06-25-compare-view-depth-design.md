# Run 비교 뷰 깊이 — per-second 오버레이 + verdict 행 baseline-상대 polarity (A4b / roadmap §B7 연기 항목)

- **날짜**: 2026-06-25
- **상태**: 설계 승인(사용자 2026-06-25) → plan 대기
- **출처**: roadmap §B7(A4b run 비교 + export) 연기 항목 2종 — "per-second 차트 오버레이"(line 226)·"verdict 행의 baseline-상대 polarity"(line 229). **왜 지금**: LoadRunner급 리포트 깊이 트랙을 read-only·가산으로 전진(미래 깊이 작업이 의존할 스키마 무변경). 병렬 `noncurve-fanout` 세션과 **공유 컴포넌트(`ActiveVuChart`) 미수정**이라 컴포넌트 로직 겹침은 없으나, `ReportView.tsx`(R6 bySecond 추출)·`ko.ts`(양쪽 append)는 두 슬라이스가 함께 건드린다 → §5 머지 조율.
- **연관**: ADR-0030(run 비교+export 하이브리드·`compareReports.ts`↔`export.rs::delta` 골든 parity), ADR-0017(bySecond 도출은 UI 책임), `crates`/`ui` 함정 노트의 "Run 비교 + 리포트 export (A4b)" 섹션.
- **ADR**: 신규 불필요(ADR-0030 범위 내 additive·UI-only read-only). 와이어/엔진/스키마 무변경이라 결정 기록 불요.

---

## 1. 문제와 목표

비교 뷰(`ScenarioComparePage`)는 run간 **집계 표**(`CompareMatrix` — 메트릭 행 × run 열 + Δ%)만 보여준다. 두 가지가 빠져 있다: ① **시간축 비교가 없다** — "candidate run이 t=30s에 처리량은 유지하면서 지연만 튀었나(=SUT가 느려짐)" 같은 *상관*을 못 읽는다(단일-run 뷰엔 초당 차트가 있지만 여러 run을 겹치는 화면이 없다). ② **verdict 행이 baseline-무관** — 셀별 합격/불합격 텍스트만 떠서 "기준은 통과인데 이 run만 불합격(=회귀)"인지가 한눈에 안 보인다(Δ% 셀은 이미 polarity 색이 있는데 verdict 행만 없다).

- **목표**: (1) 비교 중인 2–5개 run의 초당 시계열을 메트릭별로 겹쳐 보는 **오버레이**(다중-선택 메트릭 피커, 선택된 메트릭마다 차트 1개를 세로로 쌓아 같은 경과초 X축 공유 → 처리량↔지연 동시 판독), (2) verdict 행에 **baseline-상대 polarity**(악화/개선) 표면화. 둘 다 이미 있는 `report.windows`·`report.verdict`만 읽는 read-only 가산.
- **비목표(연기)**: §7 참조. XLSX Δ 조건부 서식(백엔드+골든 parity 도메인)·per-step 오버레이·메트릭별 색 단독·active-VU 오버레이.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST per-second 오버레이를 `ScenarioComparePage`의 `CompareMatrix` 아래 신규 섹션으로 렌더한다(비교 run 2–5개). | `ScenarioComparePage.test.tsx`: 오버레이 섹션 region 존재 | |
| R2 | MUST 오버레이 차트는 **신규** `components/compare/CompareTimeSeriesChart.tsx`(Recharts 멀티-라인·`TimeSeriesChart` 패턴 미러)로 그리고 `ActiveVuChart.tsx`는 **수정하지 않는다**(compare 전용 컴포넌트 = 응집·격리; `ActiveVuChart`는 active-VU 전용). | `git diff --name-only`에 `ActiveVuChart.tsx` 부재 + `CompareTimeSeriesChart.test.tsx` | |
| R3 | MUST 메트릭 다중-선택 피커(req/s·p95 ms·errors)를 두고, **기본 req/s+p95 켬·errors 끔**; 선택된 메트릭마다 차트 1개를 세로로 쌓는다. | `ScenarioComparePage.test.tsx`: 기본 2차트·errors 체크 시 3차트·req/s 해제 시 1차트 | |
| R4 | MUST 각 run = 1 라인, X축 = **각 run 자기 시작점 t=0 기준 경과초**(ts_second − 그 run 첫 윈도 ts)로 정규화; 길이 다른 run은 빈 구간 `null`(연결 안 함). | `overlaySeries.test.ts`: 정규화·병합·null-gap 단언 | |
| R5 | MUST 오버레이 run 색은 **위치 인덱스 단일-소스 팔레트**(run 0=색A·run 1=색B…)이고, 라벨은 `CompareMatrix` 헤더가 쓰는 run 라벨과 **동일 텍스트**이며 기준 run은 범례에 "(기준)" 병기. (열↔라인 색 스와치 연동은 §7 연기.) | `overlaySeries.test.ts`(색·라벨·기준 표식) + 컴포넌트 범례 단언 | |
| R6 | MUST 단일-run `ReportView`의 `bySecond` 도출을 **공유 순수 헬퍼**로 추출하고 ReportView 동작은 byte-identical(시각/데이터 무변경). | `bySecond.test.ts`(특성화) + 기존 `ReportView.test.tsx` 무수정 통과 | |
| R7 | MUST verdict 행 baseline-상대 polarity를 순수 `verdictPolarity(baselinePassed: boolean \| null, candidatePassed: boolean \| null)`로 도출한다 — 기준 통과·cand 불합격→`bad`(악화) / 기준 불합격·cand 통과→`good`(개선) / 동일·한쪽 null→`neutral`. (`CompareResult.verdict.passed: (boolean\|null)[]`를 그대로 소비 — `Verdict` 객체 미사용·`CompareResult` shape 미확장.) | `compareReports.test.ts`: 진리표(2×2 + null) | |
| R8 | MUST polarity 렌더는 기존 합격/불합격 텍스트를 유지하고 `neutral`이 아닐 때만 글리프+라벨 칩(**▲ 악화=bad/red, ▼ 개선=good/green**, `DeltaChip` 시각언어·Δ셀 방향 관례 일치)을 더한다 — **색 단독 금지**(글리프+가시 라벨+aria 동반); 기준 열 셀은 neutral. | `CompareMatrix.test.tsx`: 회귀행 글리프/라벨 유무·기준 neutral·teeth-check | |
| R9 | MUST 전 신규 사용자-노출 문구(섹션 제목·피커 라벨·verdict `악화`/`개선` 가시 라벨·빈-데이터 안내)는 `ko.ts` 신규 키 경유(ADR-0035); 오버레이 차트 제목은 `ko.report.timeSeries*` 재사용. **Δ% 셀 전용 `ko.compare.worseAria/betterAria`는 verdict polarity에 재사용하지 않는다**(인자·문구 의미 불일치 — verdict는 가시 라벨 텍스트가 접근명 제공). | grep: 신규 인라인 영어/한국어 0 + ko 키 참조 | |
| R10 | MUST 엔진/proto/migration·`api/schemas.ts`·`api/client.ts` **0-diff**, run payload·report wire **byte-identical**(read-only — 기존 `windows`/`verdict`만 소비). | `git diff --name-only` = `ui/`(+docs) 한정·schemas.ts 부재 | |
| R11 | MUST 차트 컴포넌트는 `TimeSeriesChart`처럼 **고정-기본 `width`/`height`**(prop override 가능·ResponsiveContainer **없음**=jsdom size-0 함정 회피)를 쓰고 `<section aria-label>`로 region을 제공하며, 범례 항목 식별은 **텍스트/속성 필터**(인덱스 금지 — Recharts `<Legend>` `<li>` 함정). | `CompareTimeSeriesChart.test.tsx`(고정-기본 size·텍스트로 라인/범례 단언) | |
| R12 | MUST verdict polarity는 UI-only — `export.rs`·`testdata/compare_golden.json`·`computeDelta` Δ parity를 **건드리지 않는다**(기존 골든 parity 불변). | `export.rs`/golden 파일 0-diff | |

- **seam**: 없음. 이 슬라이스는 어떤 계약 경계(UI Zod↔serde / proto / migration / CSV·XLSX 와이어)도 건드리지 않는다(read-only·기존 파싱 필드 소비). 그래서 와이어 1:1 대조 대상이 없고 S-D 라이브 갭이 구조적으로 부재(R10).

---

## 3. 핵심 통찰 (설계 근거)

1. **하이브리드 피커가 순수 상위집합**(R3): "한 차트에 한 메트릭"(컴팩트)과 "처리량+지연 동시"(상관 판독)는 다중-선택+세로 스택으로 양립한다 — 선택을 하나로 줄이면 순수 단일-차트로 degrade. 멀티-라인 차트 컴포넌트는 **한 번만** 만들고 선택 메트릭마다 재사용하므로 추가 복잡도가 거의 0. errors 기본 끔은 흔한 0-값 빈 차트 클러터 회피.
2. **별도 컴포넌트 = 응집·격리**(R2): `ActiveVuChart`는 active-VU 전용이라 거기에 일반 메트릭 오버레이를 끼우면 책임이 섞인다 → compare 전용 `CompareTimeSeriesChart`를 `TimeSeriesChart` 패턴(고정-기본 width/height·`<section aria-label>` 래퍼·ResponsiveContainer 없음=jsdom 함정 회피)으로 신규 작성. 패턴만 차용(코드 공유 아님). (병렬 `noncurve-fanout` 세션은 `ActiveVuChart`를 안 건드리고 `ReportView`/`ko.ts`만 공유 — §5 조율.)
3. **read-only가 깊이 로드맵을 보호**(R10·R12): 세 입력(`windows`·`verdict`)이 이미 파싱돼 있어 스키마/엔진/proto/migration을 안 건드린다 → 미래 깊이 작업(새 메트릭·per-step 드릴다운)이 의존할 와이어를 무변경 유지 + 오버레이 컴포넌트·`overlaySeries`/`bySecond` 헬퍼는 남은 "run 비교 곡선 오버레이"·드릴다운이 재사용할 자산.
4. **X축은 자기-시작 정규화만 의미 있음**(R4): 비교 run은 wall-clock으로 며칠 떨어질 수 있어 절대 ts 정렬은 무의미 → 각 run을 `ts_second − 첫 윈도 ts`로 t=0 정렬해 경과초로 겹친다. 길이 다른 run은 `null` 갭(Recharts `connectNulls={false}`)으로 종료 후 라인이 끊긴다.
5. **polarity는 Δ셀과 같은 시각언어**(R8): Δ% 셀은 이미 `DeltaChip`이 polarity 색+▲/▼를 쓴다(색 단독 금지 함정 준수). verdict 행도 동일 관례(▲ 악화/▼ 개선·글리프+가시 라벨)를 따라 일관성 유지(가시 라벨 텍스트가 접근명 제공 — Δ% 전용 aria 헬퍼는 인자 의미가 달라 재사용 안 함, R9). 단 verdict polarity는 export에 안 들어가므로 **UI-only**(R12) — 기존 `computeDelta`↔`export.rs::delta` 골든 parity와 무관(별도 로직).
6. **`bySecond` 추출은 단일 소스화**(R6): 오버레이가 같은 초당 도출을 재현하면 단일-run 뷰와 드리프트할 수 있다 → 기존 `ReportView` 내부 `bySecond`를 공유 순수 헬퍼로 끌어내 양쪽이 같은 도출을 쓰게 한다(ADR-0017 "bySecond는 UI 책임" 유지). ReportView는 호출부만 바뀌고 동작 byte-identical(특성화 테스트로 락인).

---

## 4. 변경 상세

### 4.1 `ui/src/report/bySecond.ts` (신규 순수 헬퍼) — 충족 R: R6
- `ReportView.tsx`의 `type Sec`/`bySecond(report)`를 그대로 이동(스텝 합산 count/errors·스텝 max p95 — 기존 로직 보존). `ReportView`는 이 헬퍼를 import해 사용(내부 정의 삭제·동작 무변경).

### 4.2 `ui/src/compare/overlaySeries.ts` (신규 순수) — 충족 R: R4, R5
- `overlaySeries(reports: Report[], baselineIdx: number, metric: "rps" | "p95" | "errors")` → `{ rows: { elapsed: number; [runKey: string]: number | null }[]; runs: { key: string; label: string; color: string; baseline: boolean }[] }`.
- 각 run: `bySecond(report)` → 첫 윈도 ts로 경과초 정규화 → 메트릭 값 추출(`rps`=count·`p95`=p95_ms·`errors`=errors). 모든 run의 경과초 합집합을 `elapsed` 행으로 병합, 없는 run엔 `null`.
- run 색: 위치 인덱스 팔레트(단일 소스 상수). 라벨: **공유 헬퍼 `runShortLabel(id)`**(`=#`+마지막 6자) — 현재 `ScenarioComparePage.tsx:149`의 인라인 `#${id.slice(-6)}`를 헬퍼로 추출해 페이지의 `labels` 도출과 overlaySeries가 **같은 헬퍼**를 쓰게 한다(드리프트 방지, R5). run 식별자는 `report.run.id`. 기준은 `baseline: true`.

### 4.3 `ui/src/components/compare/CompareTimeSeriesChart.tsx` (신규) — 충족 R: R2, R11
- props `{ title; yLabel; rows; runs; width?; height? }`. **`TimeSeriesChart` 패턴 미러** — bare `<LineChart width={width ?? 720} height={height ?? 220}>`(고정-기본·**ResponsiveContainer 없음**=jsdom size-0 함정 회피), `<section aria-label>` 래퍼로 region role 제공. run당 `<Line dataKey={run.key} stroke={run.color} connectNulls={false} type="linear">`. `<Legend>` + run 라벨(텍스트 식별). X축 = `elapsed`(경과초). `<Tooltip>`은 hover라 jsdom 무관(formatter는 tsc/리뷰로 검증).

### 4.4 `ui/src/pages/ScenarioComparePage.tsx` — 충족 R: R1, R3, R5
- `CompareMatrix` 아래 오버레이 섹션 추가: 메트릭 다중-선택 피커(로컬 state·기본 `["rps","p95"]`) + 선택 메트릭마다 `CompareTimeSeriesChart`(=`overlaySeries(reports, baselineIdx, metric)`) 세로 스택. 빈 데이터(전 run 무윈도)면 안내 문구. 전 메트릭 해제 시 차트 0(피커만).
- 인라인 라벨 도출(`:149` `labels[id] = "#" + id.slice(-6)`)을 공유 `runShortLabel(id)`로 교체 — overlaySeries와 단일 소스(R5).

### 4.5 `ui/src/compare/compareReports.ts` — 충족 R: R7
- 순수 `verdictPolarity(baselinePassed: boolean | null, candidatePassed: boolean | null): "good" | "bad" | "neutral"` 추가 — `CompareResult.verdict.passed` 배열(이미 boolean으로 collapse됨, `compareReports.ts:13,75`)을 소비. 기준 통과·cand 불합격→`bad` / 기준 불합격·cand 통과→`good` / 그 외(동일·한쪽 null)→`neutral`. (`computeDelta`/`Delta`/골든 parity·`CompareResult` shape 무수정 — R12.)

### 4.6 `ui/src/components/compare/CompareMatrix.tsx` — 충족 R: R8
- verdict `<tr>`(현 154–167, `verdict.passed.map` 156–166): 각 candidate 열에 `verdictPolarity(baselinePassed, cellPassed)` 도출 → `!== "neutral"`이면 기존 합격/불합격 텍스트 옆에 글리프+가시 라벨 칩(▲ 악화/▼ 개선·`DeltaChip` 시각언어 재사용·**가시 라벨 텍스트가 접근명 제공** = Δ% 전용 aria 헬퍼 미사용, R9). 기준 열 = neutral(글리프 없음).

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R9
- 신규: 오버레이 섹션 제목·메트릭 피커 라벨 3종·verdict 가시 라벨 `악화`/`개선`·빈-데이터 안내. 재사용: 오버레이 차트 제목 `ko.report.timeSeries*`. (Δ% 셀 전용 `ko.compare.worseAria/betterAria`는 verdict polarity에 **재사용 안 함** — R9.)

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·migration 0-diff** — 어떤 부하/리포트 생성 경로도 안 건드린다.
- **`api/schemas.ts`·`api/client.ts`·`api/hooks.ts` 0-diff** — 기존 `ReportSchema.windows`·`ReportSchema.verdict`만 소비(신규 필드/스키마 0). run payload·report wire byte-identical(R10).
- **`crates/controller/src/export.rs`·`testdata/compare_golden.json` 0-diff** — verdict polarity는 UI-only, 기존 `computeDelta`↔`delta` Δ parity 불변(R12).
- **`ActiveVuChart.tsx` 0-diff** — 오버레이는 별도 컴포넌트(R2·병렬 충돌 회피).
- **`ReportView` 동작 byte-identical** — `bySecond` 추출은 위치 이동만, 시각/데이터 무변경(R6).
- 머지 diff = `ui/`(+docs) 한정.
- **병렬 `noncurve-fanout` 세션과 머지 조율**: 두 슬라이스가 `ui/src/components/report/ReportView.tsx`(이쪽=`bySecond` 추출·import 변경 / 저쪽=`WorkerBreakdownTable` import+JSX 슬롯)와 `ui/src/i18n/ko.ts`(양쪽 append)를 함께 건드린다 — 코드 hunk가 떨어져 있어 대개 auto-merge되나 `ko.ts` append는 충돌 가능. **둘째로 머지되는 쪽이 master에 rebase 후 UI 게이트(`pnpm lint && pnpm test && pnpm build`) 재실행**(루트 CLAUDE.md 머지 조율 관례). `ActiveVuChart.tsx`는 어느 쪽도 수정 안 함(R2).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `ScenarioComparePage.test.tsx` 오버레이 region 존재 | |
| R2 | `git diff --name-only`(ActiveVuChart 부재) + `CompareTimeSeriesChart.test.tsx` | |
| R3 | `ScenarioComparePage.test.tsx`: 기본 2차트·errors 토글 3차트·해제 1차트 | |
| R4 | `overlaySeries.test.ts`: 경과초 정규화·합집합 병합·`null` gap | |
| R5 | `overlaySeries.test.ts`: 색/라벨 인덱스 일관·`baseline` 표식 | |
| R6 | `bySecond.test.ts` 특성화 + 기존 `ReportView.test.tsx` 무수정 통과 | |
| R7 | `compareReports.test.ts`: verdictPolarity 진리표(PASS/FAIL 2×2 + null) | |
| R8 | `CompareMatrix.test.tsx`: 회귀행 ▲/악화·개선행 ▼·기준 neutral·teeth-check(일부러 뒤집어 FAIL 확인) | |
| R9 | grep: 신규 인라인 문구 0·ko 키 참조 | |
| R10 | `git diff --name-only`에 `schemas.ts`/`client.ts`/엔진/proto/migration 부재 | |
| R11 | `CompareTimeSeriesChart.test.tsx`: 고정-기본 size 렌더(ResponsiveContainer 없음)·범례를 텍스트로 단언(인덱스 금지) | |
| R12 | `export.rs`/`compare_golden.json` 0-diff(`git diff`) | |

- **라이브 검증**: **WAIVED 예상**. `schemas.ts` 0-diff·run-생성/리포트-파싱 경로 무관(read-only 표시) → S-D 갭(RTL fixture absent-not-null) 구조적 부재. RTL이 실 `windows`/`verdict` 배열 fixture로 결정적 커버. finish-slice에서 production diff가 ui-only·read-only임을 확인하고 근거를 build-log에 기록(최근 UI-only 슬라이스 관례).

---

## 7. 의도적 연기 (roadmap §B7에 누적)

- **XLSX Δ 조건부 서식(색)**: 백엔드 `export.rs`(`write_number`→`write_number_with_format`)+`testdata/compare_golden.json` parity 도메인이라 순수 UI 슬라이스에서 분리 — 작은 백엔드 follow-up(`rust_xlsxwriter` 색 포맷 지원·`delta()` polarity 재사용).
- **per-step 오버레이 / 메트릭 드릴다운**: 오버레이는 스텝-합산 `bySecond`만(단일-run 뷰와 동일 coarse). per-step 시계열은 별도(ADR-0017 OUT).
- **active-VU 오버레이**: 비교 run의 desired/actual VU 곡선 겹치기 — 별도(곡선 run 한정·`active_vu_series` 소비).
- **오버레이 색 단독 라인 구분 보조**(라인 dash 패턴·기준 강조 스타일): v1은 색+범례만. 색각 보조는 후속.
- **per-second 차트 N-run 상한 사용자 설정화**: 비교 자체가 2–5 run 게이트(A4b)라 오버레이도 그 상한 상속.
- **CompareMatrix 헤더 색 스와치(열↔라인 색 연동)**: v1 오버레이 라벨은 매트릭스 헤더 텍스트와 동일하지만 *색* 매핑은 없다(라인은 인덱스 팔레트). 열 헤더에 색 스와치를 더해 "파란 라인=어느 열"을 시각 연결하는 건 CompareMatrix 수정이라 별도(작은 후속).

---

## 8. 구현 순서 (plan 입력)

> UI-only 슬라이스라 cargo 게이트 무관 — 커밋 경계는 UI 게이트(`pnpm lint && pnpm test && pnpm build`)와 TDD-guard(test-편집을 src-편집보다 먼저 = pending RED diff, 루트 C-1·ui 함정)만 고려. 각 task는 독립 green 커밋.

1. **순수 헬퍼 + verdict polarity** (R4·R5·R6·R7): `bySecond.ts` 추출(+ReportView 호출부 전환·특성화) · `overlaySeries.ts` · `compareReports.ts::verdictPolarity`. 테스트 먼저(pending RED) → 구현 → green fold.
2. **차트 컴포넌트** (R2·R11): `CompareTimeSeriesChart.tsx` + 테스트(explicit size·텍스트 범례).
3. **배선** (R1·R3·R8·R9): `ScenarioComparePage` 오버레이 섹션+메트릭 피커 · `CompareMatrix` verdict polarity 렌더 · `ko.ts` 신규 키 · 페이지/매트릭스 RTL.

각 task 끝 `pnpm lint && pnpm test && pnpm build` green 후 커밋. R10/R12는 매 커밋 `git diff --name-only`로 가드(ui-only·schemas/export/golden 부재).
