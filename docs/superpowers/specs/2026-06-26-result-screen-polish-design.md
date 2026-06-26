# 결과화면 폴리시 — 반응형 그래프 + 다운로드 드롭다운 메뉴 (설계) (사용성 묶음 C-1 / §UX1 ④a·④b)

- **날짜**: 2026-06-26
- **상태**: 설계 승인(spec-plan-reviewer APPROVE) · plan 승인(REVIEW-GATE APPROVED) → 구현 대기 (STOP-gate: `/clear`→fresh 컨텍스트)
- **출처**: 사용자 요청 (roadmap §UX1 "사용성 묶음 C" 4종 중 ④a·④b). 묶음 C를 분할 — 이번 슬라이스는 **결과/리포트 화면 폴리시**(④a 그래프 정렬·④b 다운로드 그룹핑)만. ④c RunDialog 초보자 친화 재설계는 별도 전용 슬라이스로 연기(§7). **왜 지금**: 결과화면이 사용자가 가장 자주 보는 표면인데 그래프가 좌측 정렬 dead space로 어색하고, 다운로드 버튼 4개가 반복 노출돼 거슬린다.
- **연관**: `ui/src/components/report/ReportView.tsx`(소비처), `ui/src/components/StageCurvePreview.tsx`(반응형 차트 exemplar `:41-47`), `ui/src/components/report/DownloadJsonButton.tsx`(제거 대상), `ui/src/api/download.ts`(`downloadFile`), `ui/src/components/HelpTip.tsx`, `ui/src/components/Layout.tsx`(`:38` `max-w-6xl` 전제). ADR-0035(한국어 copy).
- **ADR**: 신규 불필요(UI-only 표시 폴리시·기존 패턴 재사용). ADR-0035(ko.ts 단일 소스) 적용.

---

## 1. 문제와 목표

결과 리포트 화면(`ReportView`)의 시계열·분포 차트들이 **고정 720px**(`StatusDistribution`은 480px)인데 콘텐츠 폭은 `max-w-6xl`(~1104px, `Layout.tsx:38`)이라, 모든 차트가 **좌측에 붙고 우측에 ~380px의 빈 공간**이 생겨 보기 불편하다. 또 헤더의 다운로드 버튼 4개(JSON·CSV·XLSX·인사이트 CSV)가 **평면 행으로 반복 노출**돼 시각적으로 거슬리고 초보자에겐 각 포맷이 뭔지 불분명하다.

- **목표**:
  1. (④a) 결과화면 차트를 **콘텐츠 폭을 채우는 반응형**으로 — 좌측 정렬 dead space 제거.
  2. (④b) 다운로드 버튼 4개를 **단일 드롭다운 메뉴**(`내려받기 ▾`)로 그룹핑 + 옆에 **초보자용 포맷 설명 HelpTip**.
- **비목표(연기)**: §7. RunDialog 재설계(④c)·비교 화면 차트 반응형·RunDetailPage 액션 버튼.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 결과 리포트의 5종 recharts 차트(`TimeSeriesChart`·`ActiveVuChart`·`PercentileCurveChart`·`LatencyHistogramChart`·`StatusDistribution`)가 프로덕션에서 콘텐츠 폭을 채우는 반응형으로 렌더된다 | 라이브 Playwright: 차트 SVG/컨테이너 폭 ≈ 콘텐츠 폭(좌측 dead space 없음) | |
| R2 | `MUST` 각 차트 컴포넌트는 `width`/`height`를 **기본값 없는 optional**로 받아, **둘 다** 주어지면 bare 차트(테스트 경로)·아니면 `ResponsiveContainer width="100%" height={그 차트의 기존 고정 height}`로 감싼다(`StageCurvePreview.tsx:41` 패턴 = `width!=null && height!=null` 게이트). 차트 children은 **한 번만** 렌더(중복 정의 금지) | 각 `*Chart.test.tsx`가 explicit `width`+`height`로 bare 렌더 단언 + 컴포넌트에 차트 children 단일 정의(리뷰) | |
| R3 | `MUST` `ReportView`는 차트에 `width`/`height`를 **넘기지 않는다**(프로덕션=반응형 경로). (현재 이미 width-free이므로 실제 작업은 *차트 컴포넌트의 기본값 제거*이며 이 행은 그 상태를 잠근다) | `ReportView.tsx` 차트 호출에 `width=`/`height=` 부재(grep/리뷰) | |
| R4 | `MUST` 결과화면의 4개 다운로드(JSON·CSV·XLSX·인사이트 CSV)는 **단일 드롭다운 메뉴**(`내려받기 ▾`) 하나로 그룹핑되고 기존 4개의 평면 버튼은 제거된다 | `ReportView.test`: 트리거 버튼 정확히 1개(`aria-haspopup="menu"`)·열기 전 `menuitem` 0개·열면 `menuitem` 4개. **은퇴 리터럴 "Download *" 참조 금지**(살아있는 구조로 단언) | |
| R5 | `MUST` `DownloadMenu`는 WAI-ARIA 메뉴버튼 — 트리거 `aria-haspopup="menu"`+`aria-expanded`, 항목 `role="menuitem"`, **키보드로 열면 첫 항목 포커스**, 닫힘(항목 선택·ESC·바깥 클릭·Tab-out), ESC 시 포커스 트리거 복귀, ↑/↓ 이동·Enter/Space 실행 | `DownloadMenu.test`: 토글·열림 시 항목 노출·키보드 열기→첫 항목 포커스·ESC/바깥클릭/Tab-out 닫힘·↑/↓·Enter·`onSelect` 호출·포커스 복귀 | |
| R6 | `MUST` 각 항목 선택 시 다운로드 동작은 기존과 **byte-identical** — JSON=`downloadJson("run-{id}.json", report)`, CSV/XLSX/인사이트=`downloadFile(기존 url, 기존 filename, 기존 MIME)`; 실패 시 기존 `dlErr` `role="alert"` 배너(`다운로드 실패: …`) 유지 | `ReportView.test`: 항목 클릭 시 `downloadFile` mock이 **기존 url/filename/MIME**로 호출, JSON은 `downloadJson` mock 호출; 실패 시 `role="alert"` | |
| R7 | `MUST` JSON 저장 로직(picker 우선 → blob 폴백 → 지연 revoke·`JSON.stringify(data,null,2)`·picker `accept {"application/json":[".json"]}`)을 **`ui/src/api/downloadJson.ts`**의 `downloadJson(filename, data)`로 추출하고, 유일 소비처가 `ReportView`이던 `DownloadJsonButton` 컴포넌트(+테스트)를 **제거**한다. `ReportView.test.tsx:1`·`RunDetailPage.test.tsx:9`의 잔존 `DownloadJsonButton` **주석 2곳을 reword**하고 양쪽 `createObjectURL` 폴리필은 **유지**(`downloadJson` blob 폴백·`downloadFile`이 여전히 사용) | `downloadJson` 헬퍼 테스트 — **동작 4케이스 이전**(picker 우선·blob 폴백·abort 무재발·non-abort 폴백) + **revoke 단언 신규**(fake timers로 1s 후 `revokeObjectURL` 호출); `renders as a button` 케이스는 헬퍼에 버튼 없어 드롭; `grep -rn DownloadJsonButton ui/src` = 0 | |
| R8 | `MUST` 드롭다운 **옆 단일** `<HelpTip>`(컴포넌트가 "?" 글리프 렌더·`role="note"` 팝오버)이 4개 포맷 특징을 간결히 설명(초보자용·메뉴 항목별 따로가 아님) | `ReportView.test`: `getByRole("button",{name:ko.report.downloadHelpAria})` 클릭 → 4개 포맷 설명 텍스트 노출 | |
| R9 | `MUST` 신규/변경 사용자 노출 문구(트리거 "내려받기"·HelpTip 라벨/본문·포맷 설명·항목 라벨 "인사이트 CSV")는 전부 `ko.ts` 경유, 기존 인라인 영어 "Download CSV/XLSX/JSON/인사이트 CSV" 라벨은 은퇴(ADR-0035) | `grep` ReportView/DownloadMenu에 인라인 `Download ` 영어 라벨 0; 문구는 `ko.report.download*` 참조 | |
| R10 | `MUST`(불변식) 백엔드·proto·migration·`schemas.ts`·리포트 파싱(Zod)·차트 데이터 변환 **0-diff/byte-identical** — 순수 표시 폴리시 | `git diff --name-only`가 `ui/src`·`docs`만; `schemas.ts`·`crates/`·`*.proto`·`*.sql` 0-diff | |

- **seam**: 없음 — 전부 UI-only 렌더/표시. R10이 "와이어/파싱 무변경" 불변식을 명시 소유.

---

## 3. 핵심 통찰 (설계 근거)

1. **반응형은 신규 라이브러리/구조가 아니라 기존 `StageCurvePreview` 패턴의 수평 전개다**(R2). `StageCurvePreview.tsx:41-47`는 이미 "`width != null && height != null`이면 bare `<LineChart width height>`(jsdom 테스트 — layout 없어 ResponsiveContainer가 size 0), 아니면 `<ResponsiveContainer width="100%" height={…}>`(프로덕션)"으로 동작한다. 5종 차트에 같은 분기를 적용하면 테스트는 explicit size로 돌고 프로덕션만 폭을 채운다. **게이트가 width AND height 둘 다이므로**, 현재 *둘 다 없이* 렌더하던 차트 테스트는 `width`+`height`를 **둘 다** 더해야 반응형(size-0) 경로를 안 탄다(R2 acceptance). 그리고 기본값(`width = 720`/`480`)을 제거해야 프로덕션(`ReportView`가 size 미전달, R3)이 반응형 경로를 탄다 — 기본값 제거는 prop **타입**(`width?: number`)을 안 바꾸므로 `tsc -b` 시그니처 변화 0(다른 테스트 파일은 타이핑으로 안 깨짐; 깨지는 건 같은 파일의 *런타임* 테스트뿐).
2. **children 중복 금지 + StageCurvePreview prop-threading 형태**(R2): `ActiveVuChart`는 `showByWorker` 분기로 서로 다른 `<LineChart>` 2종을 렌더한다. 반응형 분기를 각 변형마다 복붙하면 children이 두 번 정의돼 드리프트 위험 — 선택된 차트 엘리먼트를 **`width={width} height={height}`로 빌드한 const**(둘 다 undefined면 ResponsiveContainer가 주입)로 만든 뒤 `width&&height ? 그 엘리먼트 : <ResponsiveContainer>{엘리먼트}</ResponsiveContainer>` **한 곳**에서만 래핑(StageCurvePreview와 동일 형태 — `cloneElement` 불필요).
3. **메뉴 동작과 다운로드 액션을 분리한다**(R5 vs R6). `DownloadMenu`는 *메뉴 동작만*(열기/닫기/키보드/포커스/a11y) 캡슐화하는 범용-소형 컴포넌트(`{ label, items: {label,onSelect}[] }`)로 두고, **실제 다운로드와 에러 배너는 `ReportView`가 소유**한다. `DownloadMenu`는 다운로드 로직 무지(순수 UI)라 테스트가 쉽고, 기존 `dlErr` `role="alert"` 배너 흐름(R6)을 그대로 유지한다.
4. **JSON 저장 로직은 컴포넌트가 아니라 함수여야 메뉴 항목에서 호출 가능**(R7). 현 `DownloadJsonButton`은 picker+blob 로직을 `<button>` 안에 가두고 있어 메뉴 항목(`onSelect`)에서 못 부른다 → `ui/src/api/downloadJson.ts::downloadJson(filename, data)` 헬퍼로 추출(위치를 고정해야 `ReportView.test`가 `vi.mock` 대상으로 삼을 수 있다). 유일 소비처였던 버튼 컴포넌트는 제거되고, 기존 `DownloadJsonButton.test.tsx`의 **동작 4케이스**(picker 우선·blob 폴백·abort 무재발·non-abort 폴백)를 헬퍼 테스트로 이전해 보존한다 — `renders as a button` 케이스는 순수 함수에 버튼이 없어 드롭하고, **revoke 호출 단언은 신규 추가**한다(기존 테스트는 `revokeObjectURL`을 `beforeEach`에서 spy만 하고 단언하지 않으므로 "이전"이 아니라 신규). **주의**: 두 테스트의 `createObjectURL` 폴리필 주석만 `DownloadJsonButton`을 언급할 뿐 폴리필 자체는 계속 필요(헬퍼 blob 폴백·`downloadFile`)하므로 폴리필은 유지하고 주석만 reword(안 그러면 R7 grep-0 미충족).
5. **HelpTip은 페이지 컨텍스트라 안전**(R8). `ReportView`는 모달이 아니므로 `Modal` capture-phase ESC와 HelpTip bubble-phase ESC가 충돌하는 함정(`ui/CLAUDE.md`)이 없다. 트리거는 "?" 글리프 버튼이고 팝오버는 `role="note"`(툴팁 아님) — 테스트는 글자가 아니라 `label`(=aria-label) prop으로 셀렉트. 버튼은 `<h3>`/`<legend>` *밖* flex 형제로 배치(heading accname 오염 회피). 본문은 `w-56` 폭에 맞춰 4줄(`<span className="block">`), 전부 `ko` 참조(R9). 뷰포트 우단 근처면 HelpTip 자체 edge-flip이 처리.
6. **다운로드 형식·엔드포인트는 손대지 않는다**(R6/R10). 이번 슬라이스는 *어떻게 보여주고 고르게 하느냐*만 바꾼다 — 파일명/URL/MIME/JSON 직렬화는 byte-identical.

---

## 4. 변경 상세

### 4.1 5종 차트 반응형 전환 — 충족 R: `R1, R2`
대상: `ui/src/components/report/`의 `TimeSeriesChart.tsx`(height 220)·`ActiveVuChart.tsx`(220)·`PercentileCurveChart.tsx`(220)·`LatencyHistogramChart.tsx`(**240**)·`StatusDistribution.tsx`(**240**).
- `width = 720`/`width = 480` **기본값 제거** → `width?: number`/`height?: number`(optional, 기본 없음).
- 렌더: 차트 엘리먼트(LineChart/BarChart + children)를 `width`/`height` prop을 단 채 한 번 구성 후 — `width != null && height != null` ? 그 bare 엘리먼트 : `<ResponsiveContainer width="100%" height={그 차트의 기존 height(220/240)}>{엘리먼트}</ResponsiveContainer>`. **각 차트의 기존 height 상수를 그대로 사용**(220/240 — blanket 220 금지). `ActiveVuChart`는 `showByWorker` 분기로 고른 차트 변수를 단일 래핑(통찰 2).
- **빈-상태 분기는 래핑하지 않는다**: `LatencyHistogramChart`의 빈 buckets `<p>`(현 `:26-28`)·`StatusDistribution`의 빈 분포 `<p>`(현 `:18-20`)는 차트가 아니므로 ResponsiveContainer로 감싸지 말 것(BarChart만 감싼다).
- (`StatusDistribution`는 BarChart지만 동일 분기. 막대 수가 적어 넓어질 수 있으나 사용자 선택안 "전체 폭 채움" — 라이브에서 시각 확인.)

### 4.2 `DownloadMenu.tsx` 신규(WAI-ARIA 메뉴버튼) — 충족 R: `R5, R9`
- Props: `{ label: string; items: { label: string; onSelect: () => void }[] }` (+ 선택적 정렬 className).
- 트리거 `<button aria-haspopup="menu" aria-expanded={open}>{label} ▾</button>`, 팝오버 `<ul role="menu">`·각 항목 `<li role="none"><button role="menuitem" onClick={()=>{onSelect(); close();}}>`.
- 포커스: **키보드로 열면(Enter/Space/↓) 첫 항목에 포커스 진입**(↑/↓ 이동이 동작하도록). 닫힘: 항목 선택·ESC(+포커스 트리거 복귀)·document mousedown 바깥 클릭·Tab-out(focusout). 키보드: ↑/↓ 항목 포커스 이동·Enter/Space 실행·ESC 닫기.
- 위치: 트리거가 헤더 우측이라 `absolute right-0` 우측 정렬(폭 고정). `label`은 `ko.report.downloadMenu`(=“내려받기”).

### 4.3 `downloadJson.ts` 헬퍼 추출 + `DownloadJsonButton` 제거 — 충족 R: `R7`
- 신규 `ui/src/api/downloadJson.ts`의 `downloadJson(filename: string, data: unknown)`: 현 `DownloadJsonButton`의 `saveViaPicker`(picker `accept {"application/json":[".json"]}`)→`saveViaBlobUrl`(지연 revoke), 본문 `JSON.stringify(data, null, 2)` **그대로** 이전.
- `DownloadJsonButton.tsx` + `DownloadJsonButton.test.tsx` 삭제(소비처는 `ReportView`뿐). 동작 4케이스(picker 우선·blob 폴백·abort 무재발·non-abort 폴백)를 `downloadJson` 헬퍼 테스트로 이전; `renders as a button` 케이스는 드롭(헬퍼=버튼 없음), revoke 호출 단언은 신규 추가(`vi.useFakeTimers()`로 1s 후 `revokeObjectURL`).
- `ReportView.test.tsx:1`·`RunDetailPage.test.tsx:9`의 `DownloadJsonButton` 언급 주석을 reword(예: "…provide a no-op for the JSON/CSV blob download path") + **`createObjectURL` 폴리필은 유지**.

### 4.4 `ReportView.tsx` 헤더 재구성 — 충족 R: `R3, R4, R6, R8, R9`
- 차트 호출은 이미 `width`/`height`를 안 넘김 → **그대로 둔다**(R3 잠금, 추가 작업 없음). 실제 반응형 작업은 §4.1(컴포넌트 기본값 제거)이 담당.
- 다운로드 4-버튼 행(현 `:90-131`) → `<DownloadMenu label={ko.report.downloadMenu} items={[…]} />` + 옆 `<HelpTip label={ko.report.downloadHelpAria}>…</HelpTip>`.
- `items`: JSON=`downloadJson(\`run-${report.run.id}.json\`, report)`; CSV=`downloadFile(api.reportCsvUrl(id), \`run-${id}-report.csv\`, "text/csv")`; XLSX=`downloadFile(api.reportXlsxUrl(id), \`run-${id}-report.xlsx\`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")`; 인사이트=`downloadFile(api.reportInsightsCsvUrl(id), \`run-${id}-insights.csv\`, "text/csv")` — CSV/XLSX/인사이트는 `.catch((e)=>setDlErr(e.message))`(기존 `dlErr` 배너 유지·R6).
- 항목 라벨: `JSON`/`CSV`/`XLSX`(고유명사 유지)·`인사이트 CSV`(`ko.report.downloadInsightsCsv`). 트리거/HelpTip은 `ko.report.download*`(R9).
- 기존 `dlErr` state + `다운로드 실패: …` `role="alert"` 배너는 그대로(인라인 한국어·pre-existing·R9 영어 라벨 스코프 밖).

### 4.5 `ko.ts` 키 추가 — 충족 R: `R8, R9`
- `ko.report.downloadMenu = "내려받기"`, `downloadHelpAria`(HelpTip 버튼 aria-label, 예: "파일 형식 설명"), `downloadInsightsCsv = "인사이트 CSV"`(JSON/CSV/XLSX는 고유명사라 ko 불요).
- 포맷 설명 4종(초보자 한 줄, 구조화 키 `ko.report.downloadHelp.{json,csv,xlsx,insights}`):
  - `json`: "원시 전체 데이터 — 프로그램·재분석용"
  - `csv`: "표 형식 요약 — 엑셀·구글시트로 열기"
  - `xlsx`: "엑셀 통합문서 — 서식 포함"
  - `insights`: "자동 분석 결과만 표로"
- (문구는 구현 시 어휘만 다듬되 의미·키 구조 고정. `HelpTip` 본문은 각 줄 `<span className="block">`로 4줄.)

---

## 5. 무변경 / 불변식 (명시)

- **백엔드·proto·migration·`crates/` 0-diff** — UI-only.
- **`schemas.ts`·리포트 파싱(Zod) 0-diff** — 응답 구조 무변경 → S-D(응답파싱) 갭 부재.
- **다운로드 형식/엔드포인트/파일명/MIME/JSON 직렬화 byte-identical**(R6) — *어떻게 고르느냐*만 변경.
- **차트 데이터 변환(`bySecond`·per-worker 변환 등)·축·라인·범례·height byte-identical** — 래퍼만 추가. 빈-상태 `<p>` 분기 무변경.
- **비교 화면 차트(`CompareTimeSeriesChart`)·RunDetailPage 액션 버튼·RunDialog 무변경**(§7). 기존 `dlErr` 배너 텍스트 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | Playwright 헤드리스: 리포트 진입 후 차트 SVG/컨테이너 폭 ≈ 콘텐츠 폭 측정 | ✅ |
| R2 | 각 `*Chart.test.tsx`: explicit `width`**+`height`**로 bare 렌더(SVG 존재) 단언; children 단일 정의(리뷰). 편집 대상 = 비-빈-데이터 `it` **3파일/5개**(`PercentileCurveChart`×2·`LatencyHistogramChart`×2[svg+`"1.0 ms"`축]·`StatusDistribution`×1[svg]); 빈-상태 `it`(`<p>`)은 무수정. `TimeSeriesChart`/`ActiveVuChart`는 이미 `width=400 height=200` 전달 | |
| R3 | `ReportView.test`/grep: 차트 호출에 `width=`/`height=` 부재 | |
| R4 | `ReportView.test`: 트리거 1개·열기 전 `menuitem` 0·열면 4개 (은퇴 "Download *" 미참조) | |
| R5 | `DownloadMenu.test`: 토글·열림 항목 노출·키보드 열기→첫 항목 포커스·ESC/바깥클릭/Tab-out 닫힘·↑/↓·Enter·`onSelect`·포커스 복귀 | |
| R6 | `ReportView.test`: 각 항목 클릭 시 `downloadFile` mock이 기존 url/filename/MIME로 호출, JSON은 `downloadJson` mock 호출; 실패 시 `role="alert"` 배너 | |
| R7 | `downloadJson` 헬퍼 테스트(동작 4케이스 이전: picker 우선·blob 폴백·abort 무재발·non-abort 폴백 + revoke 신규 단언); `grep -rn DownloadJsonButton ui/src`=0(주석 reword 후) | |
| R8 | `ReportView.test`: `getByRole("button",{name:ko.report.downloadHelpAria})` 클릭 → 4개 포맷 설명 텍스트 노출 | |
| R9 | grep: ReportView/DownloadMenu 인라인 `Download ` 영어 0; 문구 `ko.report.download*` | |
| R10 | `git diff --name-only`가 `ui/src`·`docs`만; `schemas.ts`·`crates/`·`.proto`·`.sql` 0-diff | |

- **게이트**: `pnpm lint && pnpm test && pnpm build`(UI 최종 게이트). cargo/proto/migration 0-diff.
- **라이브 검증**: 자동 run-생성/report-파싱 회귀 측면은 **WAIVED**(production diff가 리포트 **표시-only**·`schemas.ts` 0-diff → S-D 갭 부재). **단 ④a 반응형 폭·④b blob 다운로드·메뉴 상호작용은 jsdom이 픽셀/레이아웃·다운로드를 미관측** → 머지 전 **Playwright 헤드리스 라이브 검증 필수**: ① 차트가 콘텐츠 폭을 채우는지(R1) ② `내려받기 ▾` 열고 한 항목 다운로드가 실제로 동작 ③ HelpTip 설명 노출(R8) ④ console Zod 0. step-waterfall 슬라이스 선례(시각은 contract 테스트로 못 닫음). `/live-verify`로 워크트리 자체 바이너리+리포트 있는 run 1개 준비.

---

## 7. 의도적 연기 (roadmap §UX1·§B11에 누적)

- **④c RunDialog 초보자 친화 재설계**: 개방형·대규모 — 별도 전용 슬라이스(깊은 brainstorming + frontend-design). 이번 분할의 핵심.
- **비교 화면 차트 반응형**(`CompareTimeSeriesChart` — 비교 페이지의 고정폭 시계열): 결과화면 범위 밖(다른 페이지). 일관성 위해 후속 후보로 roadmap에 기록. (비교 페이지는 이 5종 차트를 쓰지 않음 — `CompareTimeSeriesChart`만.)
- **`DownloadMenu` 범용화/재사용**(다른 페이지 메뉴): 현 소비처 1개라 YAGNI — 필요 시 후속.

---

## 8. 구현 순서 (plan 입력)

> UI-only 슬라이스라 cargo 게이트 무관(전부 `ui/`). `tdd-guard`(루트 C-1)는 **test-path 파일 편집을 먼저** 요구 → 각 task는 테스트 파일부터(pending RED diff) 후 src 편집. 기본값 제거는 prop 타입을 안 바꿔 `tsc -b` 시그니처 변화 0(통찰 1) — 깨지는 건 같은 파일 런타임 테스트(R2)뿐이라 차트별로 안전하게 묶을 수 있다.

1. **차트 반응형(R1·R2·R3)**: 5종 차트 기본값 제거 + ResponsiveContainer 분기(각 차트 고정 height 유지·빈-상태 `<p>` 미래핑) + 비-빈 차트 테스트 5개(3파일)에 `width=400 height=200` 보강. `ReportView`는 이미 width-free라 무수정(R3 확인만).
2. **`downloadJson` 헬퍼 추출 + `DownloadJsonButton` 제거(R7)**: `ui/src/api/downloadJson.ts` + 헬퍼 테스트(동작 4케이스 이전 + revoke 신규 단언) + 컴포넌트/테스트 삭제 + 2개 주석 reword(폴리필 유지). ReportView가 아직 버튼을 import하므로 4와 같은 green 커밋으로 fold.
3. **`DownloadMenu` 신규(R5·R9)** + `DownloadMenu.test`.
4. **`ReportView` 헤더 재구성(R4·R6·R8·R9)** + `ko.ts` 키(R8·R9) + `ReportView.test` 갱신(메뉴 상호작용·HelpTip·downloadFile/downloadJson mock). 2의 버튼 삭제와 함께 green.
5. **게이트 + 라이브 검증**(§6).
