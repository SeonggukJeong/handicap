# 디자인 시스템 확산 4차 — 표시 섹션·배지 깊은 토큰 이주 (설계) (§B12 / design-system-results-screens 후속)

- **출처**: `docs/roadmap-status.md` UX·디자인 시스템 테마 추천("결과·표시 화면 깊은 Section/카드·표시 입력 토큰화") + `docs/roadmap.md` §B12 "나머지 화면 깊은 토큰 이주". 확산 1차(design-system-spread, 폼 4그룹)·2차(design-system-results-screens, 블록 알림 20개→Callout)·3차(design-system-editor, 에디터/Inspector)·Button-accent 이주에 이은 **4차**.
- **착수 실측(2026-07-11)이 현황판 전제를 반증**: 추천 문구의 전제("토대 이미 존재 — 토대 변경 없이 이주")와 달리, 결과·표시 화면군에서 **기존 토대만으로 byte-identical 이주 가능한 표면은 사실상 0**이었다. report/ 계열은 전부 plain `<section aria-label>`+`<h3 text-lg>`(기존 `Section` fieldset이 못 싣는 룩 — `ui/src/components/ui/CLAUDE.md` 적용 금지 명시), 워커 배지는 `Badge`와 `font-medium`/`ml-2` 한 끗 차이(현 Badge는 weight 고정·className 미수용), 표시 입력 잔여는 checkbox 2곳뿐(프리미티브 부재). → 사용자 결정으로 스코프 재정의(아래).
- **ADR**: **신규 없음.** ADR-0043("UI 디자인 시스템 점진 채택")의 실행. additive 토대 확장(신설 `PageSection`·`Badge` prop 2종)은 3차의 `size?:'sm'`·button-accent의 `Textarea` 신설과 같은 부류(점진 채택 내 additive 확장 — 새 결정 아님).

## 범위 결정 (사용자, 2026-07-11)

1. **제약**: 토대 additive 확장 허용 + 화면 이주는 **byte-identical**(1~3차 원칙 유지). 시각 정규화(픽셀 변화) 불허.
2. **스코프**: ① 표시 섹션 프리미티브 신설 + 캐넌 섹션 이주 ② Badge 확장 + 워커 배지 이주. **비포함**: Checkbox 프리미티브(잔여 2곳 전부 무스타일 native — YAGNI)·Input/Select 컴팩트 variant+RunListControls 해동(별도 B12 항목·크기 큼).
3. **접근**: 신설 `PageSection`(1안) — 기존 폼 `Section`은 0-diff(2안 variant 확장은 폼 화면군을 회귀 표면에 넣어 기각, 3안 공유 상수는 구조 강제력 없어 기각).
4. §1(프리미티브 API)·§2(이주 20곳/동결/fold-in 1건)은 visual companion 목업으로, §3(검증)은 터미널로 승인.

---

## 1. 문제와 목표

**문제**: 결과·표시 화면군(report/ 18컴포넌트·RunDetail·compare·WorkerDashboard)의 섹션 헤딩 구조와 상태 배지가 화면마다 손-복붙된 raw JSX다. 캐넌이 실재하지만(메인 h3 캐넌 12곳·차트 h4 캐넌 5곳·배지 캐넌 3곳) 코드로 잠겨 있지 않아, 새 리포트 섹션이 헤딩 크기/마진을 어긋나게 들어와도(예: InsightPanel 하드코딩 제목, ReportView 레이턴시 섹션의 mb-6 누락 같은 기존 드리프트) 잡을 장치가 없다.

**목표**: 두 캐넌을 additive 프리미티브로 인코딩(`PageSection`·`Badge` 확장)하고, 캐넌에 정확히 맞는 사이트만 byte-identical 이주. 캐넌에서 벗어난 사이트(bespoke 헤더·카드·disclosure)는 **근거를 명기하고 동결**(억지로 욱여넣지 않는다 — 1~3차와 같은 보수성).

**비목표(연기)**: §7. Checkbox 프리미티브·컴팩트 variant·bespoke 헤더 흡수 prop·`Section` 카드 variant/`InspectorSection` 통합(여전히 후행)·데이터 식별/severity/verdict 색 토큰화.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 전부 UI-only 표시/구조 재구성. 와이어/뮤테이션/모델 계약 변경 없음. **byte-identical의 정의(R3~R5 공통)**: 렌더 DOM의 태그·aria 속성·클래스 *집합*·computed style이 이주 전과 동일. 클래스 문자열의 *순서*는 프리미티브 조립 순서에 따라 달라질 수 있고(예: Badge `ml-2`가 끝으로 이동), `<section>`의 "클래스 부재 → `class=\"\"`"(ReportView 레이턴시)는 computed 동일로 수용 — 이 두 가지가 유일하게 허용되는 DOM 문자열 차이다.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 신설 `ui/src/components/ui/PageSection.tsx` — props `{ariaLabel: string; title: ReactNode; sub?: boolean; className?: string; children?: ReactNode}`, 렌더 `<section aria-label={ariaLabel} className={className ?? "mb-6"}>` + (sub 미지정: `<h3 className="text-lg font-semibold mb-2">{title}</h3>` / `sub`: `<h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>`) + children. `className`은 **통째 교체**(append 아님 — 실측상 섹션 클래스가 `mb-6`/`mb-6 text-sm`/`mt-8`/없음으로 갈려 append면 byte-identical 불가) | 단위 테스트: 두 캐넌의 태그·정확 클래스 문자열·aria-label·className 교체 규칙(기본 `mb-6`·`""` 전달 시 빈 class) 단언 | |
| R2 | `MUST` `Badge` additive 확장 — `weight?: "semibold"\|"medium"`(기본 `semibold`)·`className?: string`(끝에 append), **기본값 경로의 클래스 문자열은 기존과 정확히 동일**(trailing space 포함 여부까지 기존 `Badge.test.tsx` 단언으로 락) | 기존 `Badge.test.tsx` 무수정 GREEN + weight/className 조합 신규 단언 | |
| R3 | `MUST` **메인 캐넌(h3) 12곳**을 `PageSection`으로 이주(§4.1 명단 — aria-label 키로 식별) — byte-identical(위 정의) | 각 파일 diff에 `PageSection` 적용 §4.1대로; 기존 해당 테스트 무수정 GREEN | |
| R4 | `MUST` **차트 서브 캐넌(h4) 5곳**을 `PageSection sub`로 이주(§4.2 명단) — byte-identical | 동상 | |
| R5 | `MUST` **워커 배지 3곳**(drained·ephemeral·stale)을 `Badge`로 이주 — `tone="warn"\|"neutral"` + `weight="medium"` + `className="ml-2"`(§4.3 매핑) — byte-identical(클래스 집합 동일·`ml-2` 위치만 끝으로) | `WorkerDashboardPage` diff + 기존 테스트 무수정 GREEN + 배지 클래스 집합 단언 | |
| R6 | `MUST`(불변식) **기존 토대 동결** — `ui/src/components/ui/{Section,Input,Select,Callout,Field,Segmented,Textarea}.tsx`·`tailwind.config.ts`·`Button.tsx`·`Modal.tsx` **0-diff**(이 슬라이스의 토대 diff는 `PageSection.tsx` 신설 + `Badge.tsx` additive 2 prop뿐) | `git diff --name-only`에 동결 경로 부재 | |
| R7 | `MUST`(불변식) **동결 사이트 무접촉** — StepPhaseBreakdown·CompareOverlaySection·ConnectionCostCard·ScenarioSnapshot·ReportHeadline·VerdictPanel·ActiveVuChart 멀티워커 헤더 분기·RunDetail metricWindows bare h3·RunListControls·RunDetail 버튼 열·WorkerDashboard 다이얼로그/드롭다운·데이터 식별/severity/verdict/compare Δ 색 전부(§4.4 근거표). 파일 단위가 아니라 **사이트 단위**(ActiveVuChart는 단일워커 분기만, ReportView는 레이턴시 섹션만 이주) | diff 리뷰: 동결 사이트 라인 무변경 | |
| R8 | `MUST` InsightPanel h3 하드코딩 `핵심 인사이트` → 신규 `ko.report.insightsTitle`(값 동일) 경유(ADR-0035, pre-existing 위반 fold-in — 렌더 출력 동일) | `grep -rn '핵심 인사이트' ui/src --include='*.tsx'` 0(ko.ts만 잔존) | |
| R9 | `MUST`(불변식) 와이어/모델 0-diff — `crates/`·proto·migration·`ui/src/api/**` 0-diff(cargo 게이트 비대상 확인) | `git diff --name-only`가 `ui/src/components|pages|i18n`+docs만 | |
| R10 | `MUST` 기존 테스트 **무수정 GREEN**이 byte-identical의 1차 증거 — 이주로 기존 단언(헤딩 텍스트·aria-label·getByRole)이 깨지면 위반 신호로 취급(단언을 고치지 말고 이주를 고친다). 기존 클래스/구조 단언이 없는 대표 사이트에 정확 단언 신규 추가(F1 pending-diff 겸 tdd-guard unblock) | `pnpm test` 전체 GREEN + 신규 단언 diff | |
| R11 | `SHOULD` 라이브 검증(경량) — 실 run 리포트 렌더에서 `getComputedStyle` 실측: h3 `fontSize 18px·fontWeight 600`·h4 `14px·#334155(rgb(51,65,85))`·이주 섹션 `marginBottom 24px`·워커 배지 `fontWeight 500` + 전/후 스크린샷 | `/live-verify` 절차 기록(수치 포함) | |
| R12 | `MUST`(불변식) 신규 하드코딩 한글 0(신규 문자열 자체가 없음 — R8은 이주)·신규 `blue-*`/`indigo-*` 컨트롤 색 리터럴 0 | diff 스윕(python sweep — `'"[가-힣]'` grep의 비한글-선두 누락 함정 회피) | |

---

## 3. 핵심 통찰 (설계 근거)

- **캐넌은 실측으로 정의됐다 — per-file 매핑이 아니라 규칙**: "‘`<section aria-label>` 직속 첫 자식이 정확히 `<h3 className="text-lg font-semibold mb-2">`(또는 h4 서브 캐넌)’인 사이트 → `PageSection`". 1차 확산의 교훈(per-file 매핑이 Environments/Templates 누락)대로, §4 명단은 이 규칙의 **닫힌 전수 적용 결과**이고 최종 `handicap-reviewer`+orchestrator가 같은 규칙 grep을 재실행해 누락을 잡는다(§6).
- **bespoke 헤더는 프리미티브에 안 싣는다**: 변형 사이트들의 헤더 행 클래스가 전부 다르다(StepPhaseBreakdown `mb-2 flex items-center justify-between`·CompareOverlaySection `flex flex-wrap items-center gap-4 mb-4`·ConnectionCostCard `mb-1 flex items-center`+text-base). 한 prop으로 byte-identical 흡수가 불가능 → `headerExtra` 같은 prop은 YAGNI 기각, 사이트 동결(§7 연기).
- **`className` 통째-교체 설계**: 섹션 래퍼 클래스의 실측 분포(`mb-6` 대다수·`mb-6 text-sim`류 2·`mt-8` 1·없음 1)가 "기본 mb-6 + 예외는 명시 교체"를 요구한다. append 설계는 ReportView 레이턴시(클래스 없음)·InsightCompareMatrix(`mt-8`)에서 byte-identical을 깬다.
- **Badge weight가 확장의 전부인 이유**: 워커 배지 3곳의 raw 클래스는 Badge BASE·tone과 `font-medium` vs `font-semibold` 단 하나만 다르다(색·padding·radius 전부 일치 실측). weight prop 없이 이주하면 굵기 회귀(byte-identical 위반), className으로 `font-medium`을 얹으면 `font-semibold`와 동시 존재해 CSS 순서에 좌우되는 취약 상태 — weight prop이 유일하게 안전.

---

## 4. 변경 상세

> 사이트 식별은 aria-label/제목 키 기준(라인 번호는 2026-07-11 HEAD 참고용 — drift 가능).

### 4.1 메인 캐넌(h3) 12곳 → `<PageSection ariaLabel=… title=…>` — 충족 R: `R3`

| 파일 | 사이트(aria-label) | className 인자 |
|---|---|---|
| `components/report/Summary.tsx` | `ko.report.summaryLabel` | (기본) |
| `components/report/StepStatsTable.tsx` | `ko.report.perStepStatsLabel` | (기본) |
| `components/report/StatusDistribution.tsx` | `ko.report.statusDistributionLabel` | (기본) |
| `components/report/BranchStatsTable.tsx` | `ko.report.branchDecisionsLabel` | (기본) |
| `components/report/WorkerBreakdownTable.tsx` | `ko.report.workerBreakdownLabel` (title은 함수형 `workerBreakdownTitle(n)` — ReactNode라 그대로) | (기본) |
| `components/report/GroupLatencyTable.tsx` | `ko.report.pageLoadLatencyLabel` | (기본) |
| `components/report/InsightPanel.tsx` | `ko.report.insightsLabel` (+R8 제목 ko 키 이주) | (기본) |
| `components/report/ReportView.tsx` | `ko.report.latencyTitle` 레이턴시 섹션 | `""` (기존 클래스 없음) |
| `components/compare/InsightCompareMatrix.tsx` | `ko.insightCompare.title` | `"mt-8"` |
| `pages/RunDetailPage.tsx` | `ko.runDetail.profileLabel` | `"mb-6 text-sm"` |
| `pages/RunDetailPage.tsx` | `ko.runDetail.stepsLabel` | (기본) |
| `pages/RunDetailPage.tsx` | `ko.runDetail.envLabel` | (기본) |

### 4.2 차트 서브 캐넌(h4) 5곳 → `<PageSection sub …>` — 충족 R: `R4`

`components/report/TimeSeriesChart.tsx`(`timeSeriesAria(title)`) · `PercentileCurveChart.tsx`(`latencyPercentileCurveLabel`) · `LatencyHistogramChart.tsx`(`latencyHistogramLabel`, 제목은 `latencyDistTitle`) · `ActiveVuChart.tsx` **단일워커 분기만**(`activeVuTitle` — 멀티워커 분기는 토글 flex 헤더라 동결 R7) · `components/compare/CompareTimeSeriesChart.tsx`(`timeSeriesAria(title)`). 전부 className 기본.

### 4.3 워커 배지 3곳 → `Badge` — 충족 R: `R5`

`pages/WorkerDashboardPage.tsx`: `drainedBadge`→`tone="warn"`·`ephemeralBadge`→`tone="neutral"`·`stale`→`tone="warn"`, 셋 다 `weight="medium" className="ml-2"`. (raw `bg-amber-100 text-amber-800`=warn·`bg-slate-100 text-slate-600`=neutral 정확 일치 실측.)

### 4.4 동결 사이트 근거표 — 충족 R: `R7`

| 사이트 | 동결 근거 |
|---|---|
| StepPhaseBreakdown 헤더 | `justify-between` 헤더 행에 HelpTip+`role=group` 토글 — bespoke |
| CompareOverlaySection | `flex-wrap gap-4 mb-4` 헤더 행에 메트릭 checkbox fieldset — bespoke·`mt-8` 섹션 |
| ConnectionCostCard | 카드 섹션(`rounded-xl border p-5 shadow-sm`)+`text-base` 헤딩+HelpTip — 캐넌 밖·카드 variant는 후행 |
| ScenarioSnapshot | disclosure 버튼 헤더(접이식) |
| ReportHeadline | verdict 색 박스(헤딩 없음) — verdict 색 도메인 |
| VerdictPanel | 카드 섹션+헤더 행 quirk(행·h3 이중 `mb-2`)+verdict 색 도메인 |
| ActiveVuChart 멀티워커 분기 | `[합계\|워커별]` 토글 flex 헤더 — bespoke |
| RunDetail `metricWindowsTitle` h3 | **섹션 래퍼 부재(bare h3)** — PageSection화는 `<section aria-label>` *신설*=DOM/a11y 트리 변경이라 byte-identical 위반 |
| RunDetail 버튼 열·WorkerDashboard 다이얼로그/드롭다운 | `Button`/`Modal` 룩과 padding/hover 상이 — byte-identical 불가(시각 정규화 불허) |
| RunListControls·데이터 식별/severity/verdict/Δ 색 | 기존 동결 그대로(2차 R9·R13/ui CLAUDE.md) |

### 4.5 문구 — `ui/src/i18n/ko.ts` — 충족 R: `R8`

`ko.report.insightsTitle: "핵심 인사이트"` 신규 1키. 그 외 ko.ts 0-diff.

---

## 5. 무변경 / 불변식 (명시)

- 기존 폼 `Section`·나머지 프리미티브·`tailwind.config.ts`·`Button`·`Modal` 0-diff(R6). `Badge`만 additive.
- 이주 사이트의 헤딩 텍스트·aria-label·DOM 순서·계층(h3/h4 레벨 포함) 전부 불변 — a11y 트리 동일.
- 와이어/모델/API/차트 데이터 경로 0-diff(R9). 동결 사이트·색 도메인 무접촉(R7).
- 신규 클래스 리터럴은 전부 기존 앱에 이미 존재하는 것들(JIT purge 신규 위험 0 — 단 R11 computed-style 실측이 accent-migration 함정대로 이를 재확인).

## 6. 테스트 / 검증

- **프리미티브 단위**: `PageSection.test.tsx` 신규(R1 acceptance 전체) + `Badge.test.tsx` 확장(R2 — 기존 단언 무수정).
- **사이트 lockstep**: 기존 report/compare/RunDetail/WorkerDashboard 테스트 **무수정 GREEN**(R10). 대표 사이트 정확 클래스 단언 신규(Summary·TimeSeriesChart·워커 배지 1곳 권장 — plan에서 확정).
- **규칙 전수 grep(orchestrator 직접 재실행 — subagent self-report 불신)**: 대상 화면군(`components/report/`·`components/compare/`·`pages/{RunDetail,ScenarioCompare,ScenarioRuns,ScenarioList,WorkerDashboard}Page.tsx`)에서 ① `text-lg font-semibold mb-2` 잔존 = §4.4 동결 목록(VerdictPanel·RunDetail metricWindows bare h3)뿐 ② `text-sm font-semibold text-slate-700` 잔존 = ActiveVuChart 멀티워커 분기뿐 ③ raw 배지 캐넌(`rounded px-1.5 py-0.5 text-xs font-medium`) 잔존 0 ④ `핵심 인사이트` ui/src 잔존 = ko.ts뿐.
- **게이트**: `pnpm lint && pnpm test && pnpm build`(전체) → 최종 `handicap-reviewer`(cross-page 일관성은 per-task 리뷰 사각 — 1차 확산 실증) → 라이브 R11.
- **라이브 검증(R11)**: run-생성/report-파싱/Zod 계약 무접촉(프레젠테이션-only)이라 S-D 갭 비해당이지만, [[implementation-rigor-over-spec]]대로 DOM-존재가 아닌 **computed-style 수치 실측**(§2 R11 수치) + 스크린샷. 리포트가 실데이터를 그려야 하므로 `/live-verify` 스택(controller+worker+run 1개)으로.
- **tdd-guard 사전조치**: 각 task는 test-파일 편집(pending diff)을 src 편집보다 먼저(2차 spec §8 F1 패턴 그대로).

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- **Checkbox 프리미티브**: 표시 입력 잔여 2곳(ScenarioRuns 비교 선택·CompareOverlay 메트릭)이 전부 무스타일 native — 래퍼 가치 낮음(YAGNI). 스타일드 checkbox 수요가 생기면 재검토.
- **Input/Select 컴팩트 variant + RunListControls 해동**: 기존 B12 항목 그대로 — 별도 슬라이스.
- **bespoke 헤더 흡수(`headerExtra` 류 prop)**: 변형 사이트 헤더 행 클래스가 전부 상이해 byte-identical 불가 — 헤더 행 캐넌이 자연 수렴하면 재검토.
- **VerdictPanel·ConnectionCostCard·ScenarioSnapshot·ReportHeadline PageSection화**: §4.4 근거 — 카드 variant·disclosure 흡수·verdict 색 정책과 함께.
- **`Section` 카드 variant + `InspectorSection` 통합**: 여전히 후행(B12 기존 항목 유지).
- **PageSection의 화면군 밖 확산**(폼/에디터 화면의 plain `<section>`): 이번은 결과·표시 화면군만 — 규칙이 검증되면 후속 확산에서.
- **현황판 전제 교정**: `roadmap-status.md` UX·디자인 시스템 행의 "토대 이미 존재(brainstorming 가벼움)" 전제는 이 슬라이스 착수 실측으로 반증됨 — finish-slice에서 frontier 문구 갱신 시 반영.

---

## 8. 구현 순서 (plan 입력)

> 전부 `ui/`(+`ko.ts`)·`docs/` — cargo 게이트 비대상(UI 게이트 `pnpm lint && pnpm test && pnpm build`). 각 task 독립 커밋. R6/R7/R9 0-diff가 전 task 공통 불변식.

1. **`PageSection` 신설** + 단위 테스트(R1) — 소비처 없음(다음 task부터 소비).
2. **`Badge` additive 확장** + 단위 테스트(R2 — 기존 `Badge.test.tsx` 무수정 GREEN 확인 포함).
3. **report/ 메인 캐넌 8곳 이주**(Summary·StepStats·StatusDistribution·BranchStats·WorkerBreakdown·GroupLatency·InsightPanel[+R8 ko 키]·ReportView) — 기존 테스트 lockstep + 대표 단언(F1).
4. **차트 서브 캐넌 5곳 이주**(TimeSeries·PercentileCurve·LatencyHistogram·ActiveVu 단일워커·CompareTimeSeries).
5. **RunDetail 3곳 + InsightCompareMatrix 이주**.
6. **워커 배지 3곳 이주**(R5).
7. **전체 게이트 + §6 규칙 grep(orchestrator 재실행) + 라이브 검증(R11)**.
8. **마무리 문서**: roadmap §B12 완료 이동+연기 적재(§7)·roadmap-status frontier 갱신(전제 교정 포함)·build-log 단락·루트 CLAUDE.md 상태줄·`ui/src/components/ui/CLAUDE.md`에 PageSection 용도 한 줄(폼 Section과 구분).
