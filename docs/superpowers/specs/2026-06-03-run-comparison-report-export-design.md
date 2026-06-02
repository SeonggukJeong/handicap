# A4b: Run 비교 + 리포트 Export (CSV/XLSX) — 설계

> 출처: 로드맵 §A4 "LoadRunner급 리포트 깊이". A4a(SLO verdict) 직후 후속.
> brainstorming 2026-06-03 (비주얼 컴패니언 사용). 후속 spec-plan-review 예정.

## 1. 목표 한 줄

종료된 run들을 **같은 시나리오 내에서 나란히 비교**(2–5개 화면, baseline 대비 Δ)하고, 단일 run 리포트와 비교 결과를 **CSV/XLSX로 export**해 사내 QA가 Excel로 가공·공유한다.

## 2. 범위 (IN / OUT)

### IN
- **A. Run 비교 (A4b 본체)**: 같은 시나리오의 종료(terminal) run 2–5개를 골라 매트릭스로 비교. baseline 열 지정 + 비-baseline 열에 Δ% 인라인. 비교 섹션 = **요약 지표 + 스텝별 p95/count/err + status 분포 + verdict**. **클라이언트 사이드** — 선택 run의 기존 `GET /api/runs/{id}/report`를 N개 받아 브라우저에서 조립(백엔드 비교 엔드포인트 없음).
- **B. Export (CSV + XLSX)**: 두 표면 — (1) **단일-run 리포트** export, (2) **비교** export. **컨트롤러 생성**(`csv` 재사용 + `rust_xlsxwriter` 추가, 데이터는 기존 `build_report` 재사용). 비교 export는 화면 5개 상한과 무관하게 다수 run 허용 = "많은 run 비교"의 오버플로 경로.

### OUT (의도적 연기 — §10에 출처)
- **D. 레이턴시 히스토그램/분위 곡선** (바로 다음 작은 슬라이스).
- **C. 트랜잭션 시간 분해**(DNS/TCP/TLS/TTFB) — 엔진 계측 필요, 더 큰 별도 슬라이스.
- **per-second 차트 오버레이**(여러 run 시계열을 한 차트에) — 비교 뷰 후속.
- **N 상한 사용자 설정화** — 이번엔 5 고정.
- **크로스-시나리오 비교** — 스텝 매칭 의미 없음, 범위 밖.
- **A4c 리포트 요약** — 별도 A4 하위 슬라이스.

## 3. 핵심 결정 (확정)

1. **하이브리드 아키텍처**: 비교 = 클라(기존 `/report` 재사용), export = 컨트롤러. **엔진·워커·proto·마이그레이션 무변경.**
2. **비교는 같은 시나리오 내, terminal run만.** 스텝이 `step_id`로 매칭돼야 의미 있고, runs 목록도 이미 per-scenario.
3. **화면 2–5개(상한 5 고정).** 5 초과 선택 시 화면 매트릭스 대신 "5개까지 — export로 전체 보기" 안내. **export는 다수 허용**(안전 상한 50).
4. **baseline 기본 = 가장 오래된(가장 왼쪽) run.** 헤더 클릭으로 변경. 비-baseline 열은 baseline 대비 Δ.
5. **델타 공식·방향은 한 곳(§4.3)에 정의해 클라(화면)와 서버(export)가 동일 적용** — 단 TS·Rust 이중 구현이므로 **공유 골든 fixture로 양쪽이 같은 숫자를 내는지 교차 검증**(§9, I1).
6. **CSV는 표면당 1개 표(헤드라인), XLSX는 멀티시트(전체).**
7. **구현 순서(슬라이스 내 2단계, spec-plan-review 권고)**: 먼저 **export(B)** — `rust_xlsxwriter` dep 이동·`build_report_for_run` 추출·서버 델타(§4.3)를 한 곳에 안착(단일-run export는 그 자체로 출하 가능). 그다음 **비교(A)** — 클라가 서버와 동일 골든 fixture로 미러.

## 4. 비교 데이터 모델 & 델타 의미론 (클라이언트)

### 4.1 입력
선택 run id 배열 + baseline id. 각 run의 `Report`(= 기존 `/report` 응답, 이미 UI `schemas.ts`의 `Report` Zod 스키마 존재)를 React Query로 병렬 fetch. **새 와이어 타입 0** — 비교는 `Report[]`의 순수 변환.

### 4.2 비교 모델 (UI 내부 타입, 와이어 아님)
```ts
type MetricKey = "p50_ms" | "p95_ms" | "p99_ms" | "rps" | "error_rate";
type Cell = { value: number | null; delta: Delta | null }; // value=null → 해당 run에 없음("—")
type Delta = { pct: number | null; polarity: "good" | "bad" | "neutral" };
// pct=null → baseline 값이 0(나눗셈 불가) → "—"/"신규"로 표기
type CompareRow = { label: string; baseValue: number | null; cells: Cell[] };
```
- **요약 섹션**: MetricKey별 1행 (+ verdict 행은 PASS/FAIL 텍스트 비교, 숫자 아님).
- **스텝 섹션**: step_id별 행, 지표 = p95(+ count/err 토글 또는 부가 열). step_id는 **모든 run의 합집합**; 특정 run에 없으면 `value=null`("—"), baseline에 없고 다른 run에만 있으면 "신규". **매칭은 step_id 정확 일치만**(URL/method 퍼지 매칭 없음 — 시나리오가 편집돼 step_id가 바뀌면 같은 논리 스텝도 별개로 보이는 의도된 보수적 동작, I3).
- **status 섹션**: status 클래스(또는 코드)별 행, 값 = run별 count.

### 4.3 델타 공식 (클라·서버 export 동일 — spec 권위 정의)
```
v_b = baseline 값, v_r = 대상 run 값
pct = (v_b == 0) ? null : (v_r - v_b) / v_b
polarity:
  - lower_is_better 지표 {p50_ms, p95_ms, p99_ms, error_rate}:
      v_r < v_b → good, v_r > v_b → bad, == → neutral
  - higher_is_better 지표 {rps}:
      v_r > v_b → good, v_r < v_b → bad, == → neutral
  - 중립 지표 {count, duration_seconds}: polarity 없음(색 없음)
verdict 행: candidate FAIL & baseline PASS → bad, candidate PASS & baseline FAIL → good, 그 외 neutral
```
- `error_rate` = `errors / count`(count==0이면 0). 요약 화면엔 % 표기, 모델은 분수.
- `pct=null`(baseline 0): value가 0이면 "동일", >0이면 "신규"/절대값 표기. **∞% 금지.**

## 5. 비교 UI

### 5.1 진입점 — `ui/src/pages/ScenarioRunsPage.tsx`
- 각 run 행에 체크박스(**terminal run만 활성**, running/pending은 disabled).
- terminal 게이팅은 **목록의 `status`** 로 판단(리포트 N개 fetch 불필요, M2).
- 선택 개수 표시 + **"비교 (N)" 버튼**. N=2~5면 비교 뷰로 이동, N>5면 "화면 5개까지, export로 전체" 안내(여전히 export 링크 제공).
- export도 **UI에서 50개 상한**으로 가드(URL 빌드 전, M4) — 50 초과 선택 시 export 버튼 비활성+안내. 서버 50 상한(§6.2)은 권위 백스톱.
- 이동: 클라 라우트 `/scenarios/{id}/compare?runs=a,b,c&baseline=a`(쿼리로 선택/baseline 전달).

### 5.2 비교 뷰 — 신규 `ui/src/pages/ScenarioComparePage.tsx` + `ui/src/components/compare/*`
- 헤더: 시나리오명 칩 + "N runs" + **CSV/XLSX export 버튼**(컨트롤러 비교 export 링크 트리거).
- 섹션(순서): **요약 매트릭스 → 스텝별 → status 분포**. 각 비-baseline 셀에 값 + Δ(▲▼, polarity 색).
- **baseline 전환**: 열 헤더 클릭 → `baseline` 쿼리 갱신 + 재계산(순수 함수라 즉시).
- **스텝 불일치 배너**: run들의 step_id 집합이 다르면 상단 경고("스텝 구성이 달라 일부만 비교").
- 프레젠테이셔널 분리: `compareReports(reports, baselineId)` **순수 함수**(테스트 용이) → `<CompareMatrix>` 렌더러. 스텝 라벨(name/method/url)은 기존 리포트와 동일하게 **`scenario_yaml` 스냅샷 파싱**(`flattenHttpSteps`/`findStepById` 재사용). 단 run마다 스냅샷이 다를 수 있으므로 **baseline run의 스냅샷을 라벨 권위로** 쓰고, baseline에 없는 step_id는 가장 처음 등장한 run의 스냅샷에서 라벨 보강.
- **export 다운로드 트리거**(I2): `<a download href>` 아님 — **fetch → blob → picker/blob-URL 저장**. 이유: Chrome Safe-Browsing 오프라인 시 `<a download>`가 transient 실패(ui/CLAUDE.md `DownloadJsonButton` 주석) + 컨트롤러 4xx(비-terminal/baseline∉ids/상한초과)를 사용자에게 못 알림. fetch 경로라야 **에러 배너** 노출 + `Content-Disposition` 파일명 사용. **`DownloadJsonButton` 컴포넌트 자체는 JSON 전용이라 재사용 불가 — picker/blob/revoke 패턴만 차용**(byte-blob용 공용 헬퍼로 일반화).

### 5.3 색·방향
"좋아짐=초록 / 나빠짐=빨강" (§4.3 polarity). 색만이 아니라 ▲▼ 기호도 동반(a11y — ui/CLAUDE.md 색-단독 금지 이디엄).

## 6. Export (controller)

### 6.1 의존성·데이터 원천
- CSV: 이미 워크스페이스에 있는 `csv` crate(데이터셋 파싱) 재사용 — 쓰기(`csv::Writer`)에도 사용.
- XLSX: **`rust_xlsxwriter`를 `[dev-dependencies]` → `[dependencies]`로 이동**(C1, Critical). 현재 워크스페이스에 **dev-only**로만 존재(`crates/controller/Cargo.toml`의 dev-dep 줄 + 워크스페이스 `Cargo.toml`의 `# dev-only` 주석) — 프로덕션 `export.rs`가 dev-dep을 못 써 그냥 두면 컴파일 실패한다. 단순 '추가'가 아니라 '이동'. 순수 Rust(transitive `zip`만), 네이티브 의존 0, 워크스페이스(edition 2024/MSRV 1.85)에서 이미 컴파일됨.
- 데이터: **기존 `build_report` 재사용** — 새 집계 0. 단 실제 시그니처는 5-arg `build_report(run, scenario_yaml, rows, loops, branches)`(`report.rs`)라 DB fetch 4회가 선행(`runs.rs:247-263`의 `report()` 핸들러가 하는 것). 이 **fetch+build 블록을 `build_report_for_run(db, run_id) -> Result<ReportJson>` 헬퍼로 추출**해 단일-run export·비교 export(run_id마다 N회)·기존 `report()` 핸들러가 공유(복붙 3× 방지, M1).

### 6.2 라우트 (axum, `app.rs`)
```
GET /api/runs/{id}/report.csv          # 단일 run
GET /api/runs/{id}/report.xlsx
GET /api/scenarios/{sid}/runs/compare.csv?run_ids=a,b,c&baseline=a   # 비교
GET /api/scenarios/{sid}/runs/compare.xlsx?run_ids=a,b,c&baseline=a
```
- 단일은 `/runs/{id}/` 하위 리터럴 세그먼트(`report.csv`)라 `{id}` 캡처와 무충돌.
- 비교는 **시나리오 하위에 배치** — `/runs/compare…`는 기존 `GET /runs/{id}`(`app.rs:43`)의 `{id}`에 잡히므로 회피 + "같은 시나리오 내" 강제(서버가 run_ids ⊆ scenario 검증)(axum path 함정 → controller CLAUDE.md).
- 응답: 알맞은 `Content-Type`(`text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) + `Content-Disposition: attachment; filename="run-{id}-report.csv"` 등.
- 검증(아니면 400/422): run terminal 아님, run_ids 빈 배열/시나리오 불일치/존재X, baseline ∉ run_ids, run_ids 개수 > 안전 상한(50).

### 6.3 단일-run 레이아웃
- **CSV** = **Steps 표**(스텝당 1행, 고정 열: `step_id, count, error_count, p50_ms, p95_ms, p99_ms`). 헤드라인 표. (status 분포는 가변 폭이라 CSV에 안 넣고 XLSX `Status` 시트로.)
- **XLSX 시트**: `Summary`(count/errors/rps/duration_seconds/p50·95·99 + verdict 있으면 criteria 행들) · `Steps` · `Windows`(ts_second,step_id,count,error_count,p50·95·99) · `Status`(분포) · `Branches`(if_breakdown 있을 때만: step_id,branch,count).

### 6.4 비교 레이아웃
- **CSV** = **요약 매트릭스**: 행=지표, 열=`baseline, run, Δ%, run, Δ%, …`. 헤더에 run id + baseline 표시.
- **XLSX 시트**: `Summary`(요약 매트릭스 + Δ%) · `Steps`(step_id × run의 p95, +선택 count/err) · `Status`(분포 비교) · `Runs`(run 메타: id, started_at, ended_at, vus, profile 요약).
- Δ%는 §4.3 공식 — 서버가 Rust로 동일 계산.

## 7. 엣지 케이스
- **비-terminal run**: UI 선택 불가 + 서버 export 거부(4xx).
- **스텝 불일치**(시나리오 편집): step_id 합집합, 없는 칸 "—" + 배너. baseline에 없는 step = "신규"(Δ 없음). **배너 발화 조건 = run들 step_id 집합의 합집합 ≠ 교집합**(I3).
- **baseline 값 0**: Δ% null → "—"/"신규"(§4.3). ∞ 금지.
- **HDR bad-blob**: `build_report`가 이미 한 윈도만 0 처리 → export·비교 자동 상속.
- **run 프로파일 상이**(VU 100 vs 200): 비교 허용 — 부하 단계 추세가 N-run의 목적. 제약 없음.
- **verdict/branch 부재 run**: 단일-run XLSX는 해당 시트/criteria 행 생략(criteria None, if_breakdown 빈 배열). **비교 매트릭스의 verdict 행은 유지하되**, verdict 부재 run의 셀만 "—"(값 있는 run만 PASS/FAIL 표기, M3).

## 8. UI 영향 (와이어/컴포넌트)
- **와이어 무변경** — `Report` 스키마 그대로 재사용. export는 파일 다운로드라 스키마 무관.
- 신규: `ui/src/compare/compareReports.ts`(순수) + `ui/src/pages/ScenarioComparePage.tsx` + `ui/src/components/compare/CompareMatrix.tsx`(+ 섹션 하위).
- 수정: `ScenarioRunsPage.tsx`(선택/비교 진입), `App` 라우팅(compare 라우트 추가), 리포트 페이지(`ReportView.tsx`)에 CSV/XLSX 다운로드 버튼 추가(기존 `DownloadJsonButton` 옆).
- export 트리거: 컨트롤러 링크라 `<a download href>` 또는 fetch→blob(오프라인 CSP·다운로드 함정 → ui/CLAUDE.md `DownloadJsonButton` 패턴 재사용).

## 9. 테스트 계획
- **UI**:
  - `compareReports` 순수 함수 단위 — 델타·polarity·baseline 전환·**0-base("—"/"신규")**·스텝 합집합/불일치.
  - `ScenarioComparePage`/`CompareMatrix` RTL — 매트릭스 렌더, baseline 클릭 재계산, 스텝불일치 배너, status 섹션, export 버튼 존재.
  - `ScenarioRunsPage` RTL — terminal만 체크 가능, 비교 버튼 카운트, 5초과 안내.
- **컨트롤러**:
  - 단일 CSV — `csv`로 파싱해 행/값 검증.
  - 단일 XLSX — **`calamine` 라운드트립**(이미 의존성!): 써서 다시 읽어 시트·셀 값 검증.
  - 비교 export — 2–3 fixture run에서 baseline Δ% 정확성, 시나리오 불일치/비-terminal/baseline∉ids 거부, content-type·disposition.
  - `build_report` 재사용이라 집계 회귀 위험 낮음 — export 직렬화 계층만 신규 테스트.
- **델타 공식 골든 크로스체크(I1, 필수)**: 작은 고정 fixture(2–3개 `Report` JSON + 기대 델타 매트릭스, repo에 체크인)를 **컨트롤러 Rust 테스트와 UI TS 테스트가 공유**해, 서버 계산과 클라 계산이 **같은 입력에 같은 숫자**(pct·polarity·`pct=null` 라벨)를 내는지 양쪽이 동일 fixture로 단언. TS·Rust 이중 구현 드리프트 방지(9d 7-layer wire-parity 정신). polarity/null 규칙은 §4.3 표를 진실의 원천으로.

## 10. 연기 항목 (roadmap §B/§A4로 누적)
- §A4: **A4c 리포트 요약**(별도), **D 히스토그램**(다음 슬라이스), **C 트랜잭션 분해**(엔진 계측, 큰 별도 슬라이스).
- §B(신규 B6 후속): per-second 차트 오버레이, N 상한 사용자 설정화, 크로스-시나리오 비교, 비교 export의 Δ 셀 색(XLSX 조건부 서식).

## 11. 영향 받는 파일 (예상)

### 프로덕션
- `crates/controller/Cargo.toml` + 워크스페이스 `Cargo.toml` — `rust_xlsxwriter`를 **dev-dep → 정식 dep로 이동**(`csv`·`calamine`은 기존 정식 dep), 워크스페이스 `# dev-only` 주석 갱신. C1.
- `crates/controller/src/report.rs` 또는 신규 `crates/controller/src/export.rs` — `report_to_csv`/`report_to_xlsx`/`comparison_to_csv`/`comparison_to_xlsx` 직렬화(순수, `build_report` 결과 입력).
- `crates/controller/src/api/runs.rs` — `report()` 핸들러의 fetch+build 블록을 `build_report_for_run(db, run_id)` 헬퍼로 추출(M1) + 단일 export 핸들러 2개.
- `crates/controller/src/api/scenarios.rs`(또는 runs.rs) — 비교 export 핸들러 2개 + run_ids 검증.
- `crates/controller/src/app.rs` — 라우트 4개.
- `ui/src/compare/compareReports.ts`, `ui/src/pages/ScenarioComparePage.tsx`, `ui/src/components/compare/*` — 신규.
- `ui/src/pages/ScenarioRunsPage.tsx`, `ui/src/App.tsx`(라우팅), `ui/src/components/report/ReportView.tsx`(export 버튼) — 수정.
- `ui/src/api/client.ts` — 비교 export URL 빌더(선택).

### 무변경
- 엔진(`crates/engine`), 워커, `crates/proto`, SQLite 마이그레이션, `runs`/`run_metrics` 스키마. (`build_report`·`Report` 스키마 그대로 재사용.)

## 12. ADR
- 신규 **ADR-0030**: "Run 비교 + 리포트 export" — 하이브리드(클라 비교 / 서버 export), 같은-시나리오·terminal-only, N 상한 5(설정화 연기), CSV=1표/XLSX=멀티시트, 엔진·proto·마이그레이션 무변경. CLAUDE.md "알아둘 결정들"에 한 줄 추가.
