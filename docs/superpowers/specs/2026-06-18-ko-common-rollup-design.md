# `ko.common 한국어화 일괄 롤업` — `잔존 하드코딩 UI 문구를 ko.ts 카탈로그로 전수 이전` (편의 트랙 §B10)

- **날짜**: 2026-06-18
- **상태**: 설계 승인(사용자 2026-06-18) → plan 대기
- **출처**: roadmap §B10 연기 항목("ko.common 한국어화 일괄 롤업"). 직전 두 슬라이스(스텝 템플릿 관리·응답기반 extract)가 명시적으로 가리킨 마지막 편의 후보. **왜 지금**: U2/U3/U4/B7-C가 매번 "ko.common 도입 시 일괄"로 미뤄 UI가 half-catalog 상태(영어·인라인 한국어 혼재) — ADR-0035의 "한국어 우선 + `ko.ts` 단일 소스"를 미완으로 둔 마지막 구멍이고, 누적될수록 청소 비용이 커진다.
- **연관**: ADR-0035(UI 문구 한국어 통일 + `ko.ts` 카탈로그), `ui/src/i18n/ko.ts`(현 카탈로그 24 네임스페이스), 직전 슬라이스 spec/plan `2026-06-18-step-template-management*`(`aria-label`도 ko.ts 경유 선례).
- **ADR**: 신규 불필요(ADR-0035 범위 내 — 카탈로그 단일 소스를 *완성*할 뿐 새 정책 아님). `ko.ts` 헤더 컨벤션 한 줄만 강화.

---

## 1. 문제와 목표

UI 전반에 하드코딩 영어 문구(**100+개, 28+ 파일** — aria-label/title/placeholder만 세도 28 파일, JSX 본문 텍스트·인라인 한국어 포함 시 더 많음)와 카탈로그를 거치지 않은 인라인 한국어가 혼재한다(half-catalog). ADR-0035는 "신규·변경 문구는 `ko.ts` 경유, 기존 미변경 문구의 소급 추출은 비목표"였는데 — 그 비목표가 누적돼 RunDetailPage·Inspector 같은 핵심 화면이 영어로 남았다. 이 슬라이스는 그 비목표를 **이번 한 번** 뒤집어 잔존 문구를 전수 이전하고, 카탈로그를 ADR-0035의 단일 소스로 *완성*한다.

> **정규 범위는 §4 목록이 아니라 R1의 grep이다(exhaustive-by-construction).** §4는 *예시 인벤토리*이고, 무엇이 "끝"인지는 R1 acceptance grep(잔존 0)이 기계적으로 정의한다 — 구현자는 §4가 아니라 **grep을 몰아** 작업한다. spec-plan-reviewer가 §4를 정의 목록으로 오인할 위험을 적발(2026-06-18): §4만 따르면 명시 안 된 ~10 파일(RunDialog 잔존 aria·TriggerBuilder·BulkEditPanel·ExtractConfirmRow·GroupLatencyTable·ScenarioSnapshot·InsightPanel·ReportView·VerdictPanel·ScheduleForm·UploadPanel·VariablesPanel·ScheduleEventTimeline 등)이 누락돼 R1 grep에서 fail한다.

- **목표**: ui/src의 모든 사용자 노출 하드코딩 문구(본문·버튼·표 헤더·placeholder·`aria-label`·`title`·로딩/에러 배너)를 `ko.ts` 경유 한국어로 통일. 기술 고유명사는 원어 유지. production 동작 byte-identical.
- **비목표(연기)**: §7 참조. en.ts/이중언어 토글·자동 lint 가드·신규 문구 추가·기능 변경.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 순수 UI 문구 슬라이스라 **계약 경계(seam)를 건드리는 R이 없다** — R5가 그 "와이어 무변경" 불변식을 명문화한다.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST: ui/src의 모든 하드코딩 사용자 노출 문구(영어 + 카탈로그 밖 인라인 한국어) — 본문 텍스트·버튼 라벨·표 헤더·placeholder·`aria-label`·`title`·로딩/에러/빈상태 배너 — 를 `ko.ts` 경유로 치환(전수, R3 예외 제외). **이 R의 grep이 정규 범위 — §4 목록이 아니라 grep을 몰아 작업한다.** | **정규**: ui/src(테스트 제외)에 잔존 영어/인라인 문구 0 — grep `aria-label="[A-Za-z]`·`title="[A-Z][a-z]`·`placeholder` 영어 + JSX 영어 본문/인라인 한국어 수동 sweep, R3 토큰만 잔존 허용. + 각 변경 화면 RTL이 한국어로 단언 | |
| R2 | MUST: `ko.common` 네임스페이스를 신설하되 **의미가 어디서나 동일한 크로스커팅 동작/상태만** 담는다(예: 로딩·실패·찾을 수 없음·저장·취소·닫기·삭제·편집·추가·제거·위로/아래로 이동·중단·파싱). 도메인 한정 라벨(Name/Method/Timeout/VUs/Duration/Errors/Created/표 헤더 등)은 **단어가 겹쳐도** 도메인 네임스페이스(`editor`/`report`/`runDetail`)에 둔다. | `ko.common` 존재 + 도메인 라벨은 도메인 키에 위치(코드리뷰 대조) | |
| R3 | MUST: 기술 고유명사·리터럴 토큰은 영어 유지(ADR-0035 "원어 유지") — `VU`/`RPS`/`p50·p95·p99`, HTTP 메서드 값(GET/POST 등), `YAML`, `URL`, `Set-Cookie`(헤더명), `#`(기호 헤더). **placeholder 규칙**: 예시 *값*(`${BASE_URL}`·`staging`·`http://localhost:9090`·`var_name`/`new_var`/`left`/`right` 같은 샘플 변수명·URL)은 리터럴 유지하되, placeholder 안의 영어 *라벨 조각*(예: `value (e.g. https://…)`의 `value (e.g. …)`)은 한국어화. | 토큰/예시값은 `ko.ts` 미이전, 라벨 조각은 이전(코드리뷰 + grep) | |
| R4 | MUST: 의미가 같은 *제네릭* 배너/보간 문구는 **단일 `common` 키로 통일** — 페이지·리소스 로드 배너 `Failed to load:`·`Failed:` → `common.failedToLoad(msg)` 함수 키(기존 `saveFailed`/`loadFailed`/`rangeHint` 선례), `Not found.`/`Loading…`은 각각 단일 `common` 키. **기존 도메인 실패 키**(`stepTemplates.loadFailed`/`deleteFailed`/`saveFailed`)는 도메인-특정 문구라 **그대로 두고 마이그레이션 안 함**(독립 편집 표면이라 phrasing 우연 일치는 중복 아님). 이미 ko 키가 존재하는데 인라인으로 박힌 문구(예: `Data binding` aria ↔ `ko.binding.sectionTitle`)는 **기존 키 재사용**(중복 키 신설 금지). | `common` 제네릭 키 1개씩 + 인라인 중복 신설 0 + 도메인 키 미변경(코드리뷰) | |
| R5 | MUST(불변식): production 동작 byte-identical — 엔진/proto/controller/migration/run-생성/리포트-파싱/와이어/run 페이로드 전부 무변경. 머지 diff = `ui/`(+ 마무리 `docs/`) 한정. | `git diff --stat master..` = `ui/` + docs only; `crates/`·`*.proto`·`*.sql` 무변경 | |
| R6 | MUST: 문구를 바꾼 모든 곳의 RTL 셀렉터(`getByRole(...,{name})`·`getByText`·`getByLabelText`)를 한국어로 lockstep 갱신하고 `pnpm lint && pnpm test && pnpm build` 전부 green. **함정**: 대소문자무시 정규식 셀렉터(`/Add/i`·`/repeat/i`·`/No env vars/i`)는 한국어화 후 *조용히 안 맞으니*(에러 아님) exact-string뿐 아니라 regex 셀렉터까지 갱신. | 3 게이트 green(`pnpm lint` `--max-warnings=0` 포함) | |
| R7 | SHOULD: `ko.ts` 헤더 주석의 "기존 미변경 문구 소급 추출은 비목표" 한 줄을 "모든 사용자 노출 문구(`aria-label` 포함)는 `ko.ts` 경유 — 인라인 영어/한국어 금지(R3 기술 토큰 예외)"로 갱신. 자동 lint 가드는 비목표(§7). | `ko.ts` 헤더 diff | |
| R8 | MUST(불변식): **라벨/텍스트/`aria-label`/`title`만 번역**하고 인접한 와이어 값(`<option value=…>`의 `value`·`Tab` 상태 `tab=`·enum/discriminant 키·`data-testid`)은 절대 건드리지 않는다 — 라벨과 값이 같은 문자열로 겹쳐도(HTTP 메서드 `value={m}` 등) 값은 원형 보존. | grep: `value=`/`tab=`/enum 키 무변경(코드리뷰 — R5 byte-identical의 의미 보강) | |

---

## 3. 핵심 통찰 (설계 근거)

1. **`common`은 "동작/상태"만, "라벨"은 도메인으로 (R2)** — 단어가 같다고(`Name`이 스텝 필드 라벨이자 run 목록 열 헤더) 한 키로 묶으면 무관한 두 화면이 결합돼, 한쪽 문구만 바꿔야 할 때 다른 쪽이 끌려간다. `common`은 *의미가 진짜 동일*한 UI chrome(저장/취소/로딩/실패)에만 한정해 결합도를 최소화한다. 대안(최대 dedup)은 키 수를 줄이지만 이 결합 비용 때문에 기각.
2. **기술 토큰을 한국어화하면 오히려 오역 (R3)** — `VU`/`RPS`/`p95`/HTTP 메서드 값/`${BASE_URL}`은 ADR-0035가 "원어 유지 + 설명 병기"로 이미 정한 부류. 라벨(설명)만 한국어, 토큰 자체는 원어. `glossary`가 이미 설명을 들고 있다.
3. **byte-identical 보장이 라이브 검증을 면제 (R5)** — 순수 문구 치환이라 run-생성/응답-파싱/엔진 경로를 안 건드린다. S-D 갭(RTL fixture가 absent-not-null이라 서버 응답경로 버그를 놓침)은 *와이어가 바뀔 때만* 위험한데 여기선 와이어가 불변이므로 무관 → 라이브 waive(직전 두 `ui/`-only 슬라이스 선례). 대신 R5를 diff-stat으로 기계 확인한다.
4. **RTL lockstep이 유일한 회귀 벡터 (R6)** — `getByRole({name})`/`getByText`가 옛 영어/인라인 문구를 매치하던 테스트는 문구를 바꾸는 순간 빨개진다. 그래서 문구 변경과 테스트 셀렉터 갱신은 **같은 task·같은 커밋**(스텝 템플릿 관리 슬라이스에서 `aria-label`→ko 전환 시 셀렉터 동시 갱신한 선례).

---

## 4. 변경 상세

> 파일군 단위(인벤토리 기준). 각 묶음은 "문구 치환 + 그 파일의 RTL 셀렉터 한국어 갱신"을 한 단위로 본다.
> **§4는 illustrative — 정규 범위는 R1 grep**(§1 인용). 아래 명시 외에도 grep이 찾는 모든 잔존을 포함한다. 보간 aria는 **함수 키**로(기존 `removeBinding(n)`/`renameAria(name)` 선례): `Toggle loop breakdown for ${name}`·`Toggle branch breakdown for ${name}`·`Remove env ${key}`·`Elif ${i+1}`·`Remove assertion/extract/elif ${idx}`·`Add step to ${label}`/`Add loop to ${label}` 등.

### 4.1 `ko.ts` `common` 네임스페이스 신설 + 헤더 컨벤션 — 충족 R: `R2, R4, R7`
`export const ko`에 `common` 키 추가: `loading`, 실패 보간 `failedToLoad(msg)`(단순 `Failed:`도 이 키로 통일 — 별도 `failed` 키 만들지 않음), `notFound`, `save`/`saving`, `cancel`, `close`, `delete`/`deleteTitle`, `edit`, `add`, `remove`, `moveUp`/`moveDown`, `abort`/`aborting`, `parsing`, `waitingFirstBatch` 등(인벤토리 확정 목록은 plan이 고정). 헤더 주석 1줄 갱신(R7).

### 4.2 페이지 로딩/에러 배너 (~21곳) — 충족 R: `R1, R4`
`DatasetsPage`/`ScenarioRunsPage`/`RunDetailPage`/`TemplatesPage`/`SettingsPage`/`SchedulesPage`/`ScenarioEditPage`/`ScenarioListPage`/`EnvironmentsPage` + `ScheduleEventTimeline`/`DataBindingPanel`/`InsertTemplateModal`의 `Loading…`/`Failed to load:`/`Failed:`/`Not found.`/`Loading runs…` → `ko.common.*`. `Loading runs…`는 의미가 약간 다르면 도메인 키(`report`/page) 고려.

### 4.3 `Inspector.tsx` — 충족 R: `R1, R2`
필드 라벨(Name/Method/Timeout (s)/Think min·max (ms)/Repeat/Then/Else) → `ko.editor.*`; 버튼/`title`(Move up·down/Delete/Delete step·loop·if·parallel) → `ko.common.*`; `aria-label`(Add branch/Add step to loop body/Add if to loop body) → `ko.editor.*`; 빈상태(No assertions/No extracts/No steps) → `ko.editor.*`.

### 4.4 `RunDetailPage.tsx` + run 목록/report 컴포넌트 — 충족 R: `R1, R2`
RunDetailPage 카드(VUs/Duration/Total requests/Errors/Avg RPS/Created/Profile/Metric windows/Waiting for first batch…/No metrics recorded./No env vars were sent.) + 표 헤더(#/Name/Method/URL/Requests/Errors/Second/Step/Count/Status codes) + Abort/Aborting…/Starting… + `aria-label`(Profile/Steps/Env) → `ko.runDetail.*`/`ko.report.*`/`ko.common.*`. `#`·`URL`은 R3로 유지. `ScenarioRunsPage` 열 헤더(Status/VUs/Duration/Created) → `ko.report.*`. report 컴포넌트(`BranchStatsTable` Branch decisions / `StatusDistribution` Status codes·No status data. / `LatencyHistogramChart` No latency data. / `StepStatsTable` Steps·Per-step stats / `PercentileCurveChart`·차트 aria / `CompareMatrix` Summary·Steps·Status / `TestRunPanel` Request·Response headers·Set-Cookie[R3]) → `ko.report.*`.

### 4.5 EnvironmentPicker + 3 소비처 (테스트 cascade 격리) — 충족 R: `R1, R2, R6`
`EnvironmentPicker.tsx`: 빈상태(No env vars/이 환경엔 변수가 없습니다)·aria(Environment variables/select environment/new env key·value/`Remove env ${key}`[함수키]/env key·value ${idx})·본문(override/Env/Add/from … (읽기 전용)/override (이 run 한정)/재정의됨/재정의) → `ko.common`/도메인. placeholder `BASE_URL`·`http://localhost:9090`은 R3 유지. **이 컴포넌트의 aria는 소비처 RTL 셀렉터로 쓰임** — primary lockstep 타깃은 `EnvironmentPicker.test.tsx`(자체)와 `RunDialog.test.tsx`(`getByLabelText("env key 0")`/`/Remove env BASE_URL/i`/`/Environment variables/i`). `ScheduleForm.test.tsx`·`TestRunSection.test.tsx`는 picker를 *렌더만* 하고 aria를 단언 안 해 안 깨지지만(render-only), 같은 커밋에서 함께 확인(R6). plan에서 **독립 task**로 격리(spec-plan-reviewer 지적).

### 4.6 나머지 (grep-driven) — 충족 R: `R1, R2, R4`
`TabBar`(Canvas→캔버스, YAML 유지[R3]) / `UploadPanel`(Name/Parsing…/Save dataset) / `DataBindingPanel`(Data binding aria → 기존 `ko.binding.sectionTitle` 재사용[R4]·Loading… option) / `RunDialog`(잔존 aria `load preset`/`preset name` — 본문은 이미 `ko.runDialog`) / `TriggerBuilder`·`ScheduleForm`·`ScheduleEventTimeline`·`BulkEditPanel`·`ExtractConfirmRow`·`VariablesPanel` / report 잔여(`GroupLatencyTable`·`ScenarioSnapshot`·`InsightPanel`·`ReportView`·`VerdictPanel` 의 영어/인라인). **§4가 illustrative라, R1 grep이 잡는 그 외 전부 포함.** 모든 변경 파일의 RTL 셀렉터 한국어 lockstep(R6).

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·controller·migration·CSV/XLSX export·run 페이로드·리포트 JSON 스키마**: 전부 무변경(R5). 머지 diff = `ui/`(+ 마무리 `docs/`) 한정.
- **R3 기술 토큰**: `VU`/`RPS`/`p50·p95·p99`/HTTP 메서드 값/`YAML`/`URL`/`Set-Cookie`/`#`/`${BASE_URL}` placeholder는 그대로(이전 안 함).
- **기존 `ko.ts` 24 네임스페이스의 키**: 의미 동일 인라인 문구는 신설 말고 **재사용**(R4) — 키 부풀리기 금지.
- **컴포넌트 동작·DOM 구조·테스트 *의도***: 문구만 바뀌고 로직·렌더 트리는 동일(셀렉터 텍스트만 갱신).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | 인벤토리 파일 대상 grep(잔존 영어/인라인 0, R3 토큰·테스트 제외) + 변경 화면 RTL 한국어 단언 | |
| R2 | `ko.common` 존재 + 도메인 라벨이 도메인 키(코드리뷰 대조) | |
| R3 | 기술 토큰 미이전 확인(코드리뷰 + grep) | |
| R4 | 통일 키 1개 + 의미중복 키 0(grep/리뷰); `Data binding` 등 기존 키 재사용 | |
| R5 | `git diff --stat master..` = `ui/`+docs only; `crates/`·`*.proto`·`*.sql` 무변경 | |
| R6 | `pnpm lint && pnpm test && pnpm build` 전부 green(`--max-warnings=0`); regex 셀렉터까지 갱신 | |
| R7 | `ko.ts` 헤더 diff | |
| R8 | grep으로 `<option value=…>`·`tab=`·enum/discriminant 키 무변경 확인(코드리뷰) | |

- **라이브 검증 waived** — R5(production byte-identical: run-생성/응답-파싱/엔진 경로 무변경)가 S-D 갭을 무관하게 만든다. 직전 두 `ui/`-only 슬라이스(스텝 템플릿 관리·응답기반 extract) 선례. 근거를 build-log에 명시.

---

## 7. 의도적 연기 (roadmap §B10에 누적)

- **en.ts / 이중언어 토글**: 카탈로그 *구조*는 en.ts를 나중에 더할 수 있게 유지하되, 이번엔 영어 카탈로그·언어 스위치를 만들지 않는다(ADR-0035가 "i18n 라이브러리·토글 비목표"로 못박음).
- **자동 lint 가드**(하드코딩 JSX 문자열 차단 ESLint/테스트 규칙): 사용자 결정(2026-06-18) — 컨벤션 문서(R7)로만. 오탐 allowlist/escape 비용 회피. 재발 시 별도 슬라이스 후보.
- **신규 문구·기능 변경**: 순수 이전만. 새 문장·새 UI 없음.
- **delimiter 옵션 라벨·기타 애매 케이스**: 구현 중 case-by-case 판정(기본은 한국어 라벨, 기술 토큰이면 R3 유지). 큰 결정 아님 — plan task에서 처리.

---

## 8. 구현 순서 (plan 입력)

> 순수 `ui/` 슬라이스라 cargo 게이트 무관(UI 게이트만). 각 task = "한 *테스트-결합 클러스터* 문구 치환 + 그 파일들의 RTL 셀렉터 한국어 갱신" → 독립 green 커밋(`pnpm lint && pnpm test && pnpm build`). **클러스터 경계는 파일이 아니라 테스트 결합도**(spec-plan-reviewer 지적: 한 컴포넌트 aria가 여러 소비처 테스트를 깬다 — 그 묶음을 한 커밋에).

1. **T1**: `ko.common` 네임스페이스 신설 + `ko.ts` 헤더 컨벤션 갱신(R2/R4/R7). (다른 task가 참조할 키를 먼저 깐다 — 이 커밋은 ko.ts만 바뀌고 소비처 0이라 미사용 키 경고 없음[TS `as const` 객체라 dead-key lint 없음].)
2. **T2**: 페이지 로딩/에러 배너(9 페이지 + ScheduleEventTimeline/DataBindingPanel/InsertTemplateModal의 Loading/Failed/Not found ~21곳, R1/R4) + 셀렉터.
3. **T3**: `Inspector.tsx`(필드 라벨·버튼·빈상태·조건 빌더 aria·함수키 aria, R1/R2) + `Inspector.test.tsx` 셀렉터.
4. **T4**: `RunDetailPage` + `ScenarioRunsPage` + report 컴포넌트(StepStats/BranchStats/StatusDistribution/Latency*/Percentile*/CompareMatrix/TestRunPanel/GroupLatency/ScenarioSnapshot/InsightPanel/ReportView/VerdictPanel)(R1/R2/R8) + 그 테스트 셀렉터.
5. **T5 (격리)**: `EnvironmentPicker.tsx` + **3 소비처 테스트 동시 갱신**(`RunDialog.test`/`ScheduleForm.test`/`TestRunSection.test`, R1/R6) — §4.5. aria cascade라 단독 task.
6. **T6**: 나머지 grep-driven(TabBar/UploadPanel/DataBindingPanel aria/RunDialog 잔존 aria/TriggerBuilder/ScheduleForm/BulkEditPanel/ExtractConfirmRow/VariablesPanel)(R1/R2/R4) + 셀렉터 + **R1 전수 grep을 하드 게이트로 실행**(잔존 0·R3 토큰만 허용) + R5 `git diff --stat`(ui/+docs only)·R8(`value=`/`tab=` 무변경) 확인.
7. **T7**: 마무리 docs(build-log·roadmap §B10·CLAUDE 상태줄) — finish-slice에서.
