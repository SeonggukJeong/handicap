# 용량 포화 원인 귀속 + 지속 최대 RPS — `load_gen_saturated` 정밀화 (A9 마무리)

> 새 spec. **§2 요구사항 표(R-id)** 가 normative 척추 — plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-15
- **상태**: 설계 초안
- **출처**: roadmap §A9 연기 항목("원인(부하기 vs SUT) 자동 귀속" + "per-window dropped 정밀 핀포인트"의 경량 대체). **왜 지금**: A9 사이징 스토리의 마지막 조각 — 사후 `load_gen_saturated`가 `cause=capacity`로 뭉뚱그린 "부하기 워커 vs 대상 서버" 구분을 자동화하고, 그 과정에서 SUT-bound run에 워커 증설을 권하던 잠재 버그를 고친다.
- **연관**: ADR-0028(`derive_insights` 인사이트 패턴), ADR-0031(open-loop·`dropped`·단일워커), ADR-0038(멀티워커 fan-out·`recommended_workers`), spec `2026-06-14-load-gen-saturation-insight-design.md`(v1), `2026-06-14-capacity-sizing-recommendation-design.md`(slots/capacity 분기), `2026-06-15-mean-latency-proxy-upgrade-design.md`(`mean_ms` 프록시).
- **ADR**: 신규 불필요(ADR-0028 범위 내 additive — 인사이트 1종의 `cause` 값 집합 정밀화 + optional 필드 1개). 새 결정 없음.

---

## 1. 문제와 목표

현재 `load_gen_saturated`(open-loop `dropped>0`)는 슬롯이 충분한데도 포화하면 `cause="capacity"` 하나로 끝낸다. 그러나 "capacity"는 **부하 생성기(워커 CPU)가 한계**인 경우와 **대상 서버(SUT)가 한계**인 경우를 뭉뚱그린다 — 둘의 처방이 정반대다(전자=워커 증설로 해결, 후자=워커 늘려도 무익). 게다가 현재 코드는 **모든** capacity-bound run에 `recommended_workers`를 emit해, SUT-bound run에도 "워커를 늘려라"라는 **틀린 권장**을 낸다. 또한 사용자가 요청한 "포화 시작 시점 + 지속 최대 RPS"가 리포트에 직접 나오지 않는다(천장 `value`는 이미 있으나 framing 부재).

- **목표**: ① `cause=capacity`를 best-available 신호(5xx + 지연상승)로 `loadgen`/`sut`로 자동 귀속하고 `recommended_workers`를 `loadgen`에만 emit(SUT-bound 오권장 제거). ② 천장(`value`=peak)을 "지속 가능한 최대 RPS"로 framing + ramp run에 한해 포화 도달 시점(`onset_second`)을 표면화. **전부 읽기경로** — `derive_insights` 내부 로직 + UI 렌더만, 신규 인자/엔진/proto/migration 0.
- **비목표(연기)**: §7. per-window dropped 정밀 파이프라인(C안) + per-worker CPU/in-flight 계측은 안 한다(귀속은 단일 run 집계 기반 휴리스틱).

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `dropped>0` && 슬롯 충분(`max_in_flight ≥ required`) && **SUT-stress 감지**면 `cause="sut"`로 두고 `recommended_workers`를 **OMIT** 한다. | insights.rs unit: `saturated_sut_via_5xx`·`saturated_sut_via_latency_rise`에서 `cause=="sut"` && `recommended_workers==None` | |
| R2 | SUT-stress = **(5xx률 ≥ τ_5xx)** OR **(지연상승)**, **슬롯 충분 arm(`(Some(req),Some(m)) if m≥req`) 안에서만** 평가(폴백 None보다 뒤 — R10이 먼저 가른다). 5xx률 = `status_class_count(5xx)/http_response_total`(공유 헬퍼, transport `"0"` 분모·분류 제외). 지연상승 = 윈도를 ts로 정렬해 distinct 초 L개 중 `k=⌊L/3⌋`, early=앞 k초·late=뒤 k초로 분할, 각 third에서 "초별 최악-스텝 p95(=worker-merge 후 윈도 p95의 그 초 max)"의 **중앙값**을 구해 `late_median ≥ τ_lat × early_median`(`k≥1` && run span ≥ τ_span초 && `early_median>0`일 때만 평가, 아니면 false). | unit: 5xx만 있는 run→sut / late p95 1.5배↑ run→sut / 둘 다 미달→not sut(loadgen). τ_5xx·τ_lat·τ_span은 named const | |
| R3 | `dropped>0` && 슬롯 충분 && SUT-stress **없음**이면 `cause="loadgen"`로 두고 기존 수식대로 `recommended_workers`(`ceil(target×wc/peak)`, `> wc`일 때만, `peak>0` 가드)를 emit 한다. | unit: `saturated_loadgen_recommends_workers` — `cause=="loadgen"` && `recommended_workers==Some(M)`; `value`/`count`/`recommended` 불변 | |
| R4 | 슬롯 부족(`max_in_flight < required`)은 기존대로 `cause="slots"` + `recommended=required`, `recommended_workers` 없음 — 무변경. | 기존 `saturated_slots_recommends_when_underprovisioned` 그대로 GREEN | |
| R5 | `Insight.cause` 값 집합을 `{slots, loadgen, sut}`로(기존 `capacity` 제거), `Insight.onset_second: Option<i64>`(`skip_serializing_if`) 신규 1필드 추가. UI Zod가 둘 다 수용(`cause`는 이미 `z.string().optional()`; `onset_second` `.optional()`). | `cargo build --workspace --tests` + UI `ReportSchema.safeParse`(라이브 바이트)·schemas 테스트 | ✅ UI Zod ↔ serde |
| R6 | SHOULD: `onset_second = t_peak − min_ts`(t_peak=peak 최초 도달 초)를 **run이 ramp일 때만** emit. ramp 판정 = **early-third(앞 `⌊L/3⌋`초, R2와 동일 분할) 처리량의 중앙값** `< 0.5 × peak`(단일 warmup-dip 초에 안 흔들리게 중앙값; `by_sec` 비거나 L<3이면 omit). flat/고정-레이트 run은 omit. | unit: `onset_present_on_ramp`(by_sec 증가→Some)·`onset_omitted_on_flat`(전 구간≈peak→None)·`onset_omitted_on_warmup_dip`(첫 초만 낮고 나머지 peak→not ramp→None; **fixture는 L≥9로 — early-third(⌊L/3⌋≥3초)에 peak 다수 → median이 peak-지배. L 작으면 early-third가 dip 1초뿐이라 median=dip→오판**) | |
| R7 | `dropped==0`이면 `load_gen_saturated` 미emit → 리포트 byte-identical(closed-loop + 비포화 open-loop). | 기존 `no_saturation_when_dropped_zero`/`build_report_no_saturation_when_not_dropped` GREEN | |
| R8 | UI `InsightPanel.actionFor`가 `sut`(워커/슬롯 무익·서버 튜닝 안내, **worker rec 없음**)·`loadgen`(`recommended_workers` 있으면 worker 권장, 없으면 일반)·`slots`(기존) 분기를 렌더하고, `cause` undefined(None 폴백)는 기존 `ko.insightActions.load_gen_saturated` 유지. `message()`(`:25`)는 천장 framing + `onset_second` 있으면 포화 시점 절을 덧붙인다. | InsightPanel RTL: 3 cause 분기 + onset 절 + 폴백 | |
| R9 | 엔진/워커/proto/migration/`build_report` 시그니처/CSV/비교(multi-run) export/**report.rs 프로덕션·테스트·export.rs writer·로직·XLSX 시트** 무변경. XLSX Insights 시트의 `cause` 열은 writer 무변경으로 새 문자열(loadgen/sut) 자동 표기(`onset_second`는 v1 XLSX 미노출). **단 `export.rs`의 두 exhaustive `Insight {…}` 테스트 리터럴(`:512`/`:529`)엔 `onset_second: None,`을 fold해야 컴파일**(prost-exhaustive 트랩 — 같은 crate라 게이트가 잡음; `cause` 값은 `:540`=`"slots"`라 무변경). report.rs 테스트(`:1739`/`:1770`=`"slots"`)는 변경 불요. | `git diff --name-only` 경로 = `insights.rs`(코어)+`export.rs`(테스트 리터럴 2줄)+`report.rs`(주석만)+`ui/`; calamine 라운드트립 GREEN | |
| R10 | 폴백 보존: `mean_ms==0`(localhost sub-ms) 또는 `max_in_flight` 부재면 `cause=None`, `recommended`/`recommended_workers` 모두 None(귀속·사이징 불가). | 기존 `saturated_sizing_falls_back_when_latency_zero`/`_when_max_in_flight_absent` GREEN | |

- **seam(R5)**: 유일한 계약 경계 = UI Zod ↔ controller serde. `cause`는 이미 string이라 값 변경은 wire-break 없음; 신규 `onset_second`만 Zod `.optional()` 추가. 한쪽만 머지될 일 없도록 같은 슬라이스에서 동시 변경.

---

## 3. 핵심 통찰 (설계 근거)

1. **귀속은 본질적으로 휴리스틱이다 — 단일 run 집계로는 완전 분리 불가(C안 기각 근거).** `cause=capacity`는 `max_in_flight ≥ required = ceil(target × mean_sec)`(평균 지연 기준 슬롯 충분)인데도 `dropped>0`인 상태다. 드롭이 나려면 순간 동시 in-flight가 슬롯을 넘었어야 하고 = **지연이 평균 위로 튄 순간**이 있었다는 뜻. 그 지연 상승의 원인은 (a) SUT가 부하에 느려짐 또는 (b) 워커 CPU 경합이 측정 RTT를 부풀림 — **end-to-end RTT만으론 (a)/(b)를 못 가른다.** 유일한 ground-truth SUT 신호는 **5xx**(서버만 낸다). 그래서 R2는 5xx(강한 근거) + 지연상승(약한 근거, hedge)로 *라우팅*하되 단정하지 않는다(R8 문구가 "…로 보입니다" + "에러·지연 함께 높으면 SUT" cross-check 유지). per-worker CPU/in-flight 계측(C안)이 있어야 진짜 분리지만 그건 §7 연기.
2. **`recommended_workers`를 `loadgen`에만 거는 게 핵심 버그픽스(R1·R3).** 현재 코드는 capacity면 무조건 `ceil(target×wc/peak)`를 권한다. SUT-bound면 워커를 늘려도 서버가 천장이라 지속 RPS가 안 오르므로 그 권장은 사용자를 오도한다 — `sut`에서 OMIT 하는 게 R2 귀속의 실질 가치.
3. **신호는 전부 `derive_insights`가 이미 받는 인자 안에 있다(신규 인자 0).** 5xx률 = `status_distribution` + 기존 공유 헬퍼(`http_response_total`/`status_class_count`, B6·status_class와 단일 소스). 지연상승 = `windows`의 per-(ts,step) p95. onset = `windows`의 초별 count(이미 peak 계산에 쓰는 `by_sec`). `summary.mean_ms` = required. → `build_report` 시그니처·proto·migration 무변경(R9).
4. **onset은 best-effort 진단이라 SHOULD(R6).** 천장(`value`=peak)이 headline이고 onset은 "언제 천장에 닿았나"의 windows-only 근사 = `t_peak`. ramp run에서만 의미(고정-레이트는 첫 초부터 천장이라 onset≈0 무의미 → omit). 첫 초가 부분초(run이 초 중간에 시작)면 ramp로 오판할 수 있으나 그때 `t_peak`는 ~1초라 무해(틀리지 않음, 단지 덜 유용). 정밀 onset(첫 drop 초)은 per-window dropped 파이프라인이 필요 → §7.
5. **`cause` 값 집합 변경이 wire-break가 아닌 이유(R5).** `cause`는 `Option<String>`/`z.string().optional()`라 `capacity`→`loadgen`/`sut`는 직렬화 형태가 그대로다. UI는 분기 문자열만 바꾸면 됨. 기존 `capacity` 분기는 코드/문구에서 제거(잔존 시 죽은 분기).

---

## 4. 변경 상세

> 각 묶음 머리에 **충족 R** 태그.

### 4.1 `crates/controller/src/insights.rs::derive_insights` — `load_gen_saturated` arm — 충족 R: R1, R2, R3, R4, R6, R10
- 기존 `cause=capacity` arm = `(Some(_), Some(_))`(슬롯 충분: `m >= req`) 분기. **이 arm 안에서만** `loadgen`/`sut`로 재분기(R2/CC2 — `sut_stress`는 폴백 `_` arm 밖, 슬롯-충분 arm 내부에서만 평가):
  - `if sut_stress(status_distribution, windows)` → `ins.cause = "sut"`, **`recommended_workers` 미설정**(R1).
  - `else` → `ins.cause = "loadgen"`, **현재 `:246-255`의 `per_worker`/`m`/`> wc` 블록을 그대로(verbatim) 이 arm으로 이동**(R3/CC1 — `let per_worker = peak/wc; let m = ceil(target/per_worker); if m > wc {Some(m)}`. **`ceil(target×wc/peak)`로 다시 쓰지 말 것** — float 결합순이 달라 ±1 드리프트, `WorkerSizingHelper` parity·`saturated_loadgen_recommends_more_workers`의 `Some(3.0)`가 깨진다).
- `slots` arm(R4: `m < req` → `recommended=req`)·폴백 `_` arm(R10) 무변경.
- 신규 private `fn sut_stress(dist, windows) -> bool`(R2): ① `http_response_total>0 && status_class_count(5xx)/total ≥ TAU_5XX` ② OR `latency_rose(windows)`. named const `TAU_5XX: f64 = 0.01`.
- 신규 private `fn latency_rose(windows) -> bool`(R2): distinct 초 정렬 길이 `L`, `k=L/3`; `k<1 || (max_ts-min_ts) < TAU_SPAN(=6)`면 false. 초별 `max(step p95_ms)` 맵 → early=앞 k초·late=뒤 k초 → 각 **중앙값** → `early>0 && late ≥ TAU_LAT(=1.5)*early`. (p95는 worker-merge 후 값이고 "초별 최악 스텝"이라 단일 느린 스텝에 지배될 수 있음 — hedge 신호라 허용, FR1.)
- 신규 private `fn saturation_onset(by_sec, peak) -> Option<i64>`(R6): `by_sec` distinct 초 `L<3`면 None; early-third(앞 `L/3`초) 처리량 **중앙값** `≥ 0.5*peak`(flat)면 None; 아니면 `t_peak(=peak 최초 도달 ts) − min_ts`. (early-third 중앙값 사용 = 단일 warmup-dip 초 무시.)
- `by_sec`는 이미 peak 계산용으로 만든 맵 재사용. cause/slots/fallback 무관하게(saturated run이면) `ins.onset_second = saturation_onset(&by_sec, peak)` 한 번 설정.

### 4.2 `crates/controller/src/insights.rs::Insight` 구조체 — 충족 R: R5, F3
- `pub onset_second: Option<i64>` 필드 + `#[serde(skip_serializing_if = "Option::is_none")]` 추가. `Insight::new`에 `onset_second: None` 초기화.
- 필드 선언 순서: 기존 끝에 append(XLSX 시트 헤더는 export.rs가 명시 열거라 자동 노출 안 됨 — R9).
- **`cause` 필드 doc 주석(`:30`) 갱신**: `"slots" | "capacity"` → `"slots"(슬롯) | "loadgen"(부하기/워커) | "sut"(대상 서버)`(잔존 `capacity` 표기 제거 — §3 항목 5와 정합).

### 4.3 `ui/src/api/schemas.ts` — 충족 R: R5
- `InsightSchema`에 `onset_second: z.number().int().optional()` 추가. `cause`는 기존 `z.string().optional()` 그대로(값 변경 무관).

### 4.4 `ui/src/components/report/InsightPanel.tsx` — 충족 R: R8
- `actionFor`(`:49`): `cause==="slots"`(기존) / `cause==="loadgen"` → `recommended_workers!=null ? ko.saturation.loadgenWithWorkers(round) : ko.saturation.loadgen` / `cause==="sut"` → `ko.saturation.sut` / else(None) → `ko.insightActions.load_gen_saturated`(기존). 기존 `"capacity"` 분기 제거.
- **`message()`(`:25`, `descriptionFor` 아님 — 그런 함수는 없다, F1)**: `load_gen_saturated` case에 기존 headline 유지 + 천장 framing 문구 + `i.onset_second != null`이면 "약 N초 지점부터 포화" 절 추가(ko.ts 경유).

### 4.5 `ui/src/i18n/ko.ts` — 충족 R: R8
- `saturation`: 기존 `capacity`/`capacityWithWorkers` 제거 → `loadgen`/`loadgenWithWorkers`(부하기(워커) 한계 → `worker_count` 권장, 조사 병기) + 신규 `sut`(대상 서버 한계 → 워커·슬롯 증설 무익, 서버 용량/튜닝, hedge cross-check 유지).
- `message()`(§4.4) 소비용 천장 framing + onset 절 문자열(ADR-0035, `(으)로`/`(은)는` 병기).

### 4.6 `crates/controller/src/insights.rs` 기존 unit 테스트 마이그레이션 — 충족 R: R3, F2/MD1
- 현재 `cause=="capacity"`를 단언하는 **4개 테스트**를 새 arm 라우팅에 맞춰 갱신(전부 5xx·지연상승 신호 없음 → `loadgen`):
  - `saturated_capacity_when_slots_sufficient`(`:960`, 빈 windows·max_in_flight≥required) → `cause=="loadgen"`(`recommended_workers` None: peak=0 가드). 이름도 `saturated_loadgen_when_slots_sufficient`로.
  - `saturated_capacity_recommends_more_workers`(`:988`, windows peak=1000·span=0) → `cause=="loadgen"` && `recommended_workers==Some(3.0)`. 이름 `saturated_loadgen_recommends_more_workers`.
  - `saturated_peak_zero_omits_worker_rec`(`:1018`) → `cause=="loadgen"` && `recommended_workers==None`(peak=0).
  - `saturated_m_le_current_omits_worker_rec`(`:1045`) → `cause=="loadgen"` && `recommended_workers==None`(m≤wc).
- **R4/R10 테스트(slots·fallback)는 무변경 GREEN.** 신규 R1/R2/R6 테스트(§6)는 별도 추가.

### 4.7 `report.rs` 무변경 + `export.rs` 테스트 리터럴 fold (F2) — 충족 R: R9
- **report.rs 프로덕션 call site 무변경**(신규 인자 0). report.rs 인라인 테스트(`:1739`/`:1770`)는 `cause=="slots"`라 **그대로 GREEN — 변경 불요**.
- **export.rs**: XLSX writer는 `cause` 문자열 passthrough(자동 반영)·로직·시트 무변경, `onset_second` 열 미추가. **단 두 exhaustive `Insight {…}` 테스트 리터럴(`crate::insights::Insight {…}`, `:512`·`:529`, `xlsx_has_insights_sheet`)에 `onset_second: None,` fold 필수**(struct 필드 추가 = `missing field` 컴파일 에러, 같은 crate). `cause` 값(`:540`=`"slots"`)은 무변경.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·migration·`build_report` 시그니처 무변경** — 신규 인자 0, 모든 신호가 기존 `derive_insights` 인자 안.
- **`dropped==0` → byte-identical**(R7): closed-loop + 비포화 open-loop 리포트 변화 0.
- **`slots` cause·폴백(None) 동작 무변경**(R4·R10): 슬롯 부족 권장·`mean==0`/`max_in_flight` 부재 폴백 그대로.
- **`value`(peak)·`count`(dropped)·`recommended`(slots) 수식 무변경** — `loadgen`/`sut` 분기는 `recommended_workers`만 가른다.
- **CSV·비교(multi-run) export 무변경**(인사이트 미포함). **XLSX 단일-run Insights 시트**: `cause` 열은 새 문자열 자동 반영(writer/로직/시트 무변경), `onset_second` 열 미추가. (단 export.rs **테스트** 리터럴 2곳은 struct 컴파일 픽스로 `onset_second: None` fold — §4.7.)
- **5xx 분모 = `http_response_total`**(transport `"0"` 제외) — B6 `evaluate_criteria`·`status_class` 인사이트와 **공유 헬퍼 단일 소스**(인라인 복제 금지).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | unit `saturated_sut_via_5xx`·`saturated_sut_via_latency_rise`: `cause=="sut"` && `recommended_workers==None` | |
| R2 | unit: 5xx 1%↑ run→sut / late p95 1.5×↑ run→sut / 둘 다 미달→not sut(loadgen). const(τ_5xx/τ_lat/span) 경계 테스트 | |
| R3 | unit `saturated_loadgen_recommends_more_workers`(`:988` 이름변경): `cause=="loadgen"` && `recommended_workers==Some(3.0)`; value/count/recommended 불변. 그리고 `:960`/`:1018`/`:1045` → `loadgen`(§4.6) | |
| R4 | 기존 `saturated_slots_recommends_when_underprovisioned` GREEN | |
| R5 | `cargo build --workspace --tests`; UI schemas 테스트 + 라이브 `/report` `ReportSchema.safeParse`(신규 필드·새 cause 값) | ✅ |
| R6 | unit `onset_present_on_ramp`(by_sec 증가→Some)·`onset_omitted_on_flat`(전 구간≈peak→None)·`onset_omitted_on_warmup_dip`(첫 초만 낮음·**L≥9 fixture**→early-median≈peak→None)·windows 없음/L<3→None | |
| R7 | 기존 `no_saturation_when_dropped_zero`·`build_report_no_saturation_when_not_dropped` GREEN | |
| R8 | InsightPanel RTL: sut(worker rec 없음·서버 문구)·loadgen(worker rec)·slots·None 폴백 + onset 절 표시. **기존 capacity RTL 2개(`InsightPanel.test.tsx:93,107`)를 loadgen/sut로 교체**(capacity는 이제 None-폴백 분기라 옛 copy 미렌더). | |
| R9 | `git diff --name-only` 경로 한정 확인; calamine 라운드트립 GREEN(fixture 갱신) | |
| R10 | 기존 `saturated_sizing_falls_back_when_latency_zero`·`_when_max_in_flight_absent` GREEN | |

- **라이브 검증 필수**(report-parse 경로 변경 — 새 cause 값 + `onset_second` 필드가 `/report`→Zod 통과): `/live-verify` 스택 + **5xx-under-load responder**로 `cause=sut`(worker rec 없음) 재현, **지연 ramp responder**로 latency-rise→sut, 정상 빠른 responder + 슬롯충분 포화로 `cause=loadgen`(worker rec) 재현 + 실 `/report` 바이트 `ReportSchema.safeParse`(S-D 갭). `cause=loadgen`의 실서버 재현이 어려우면(컨트롤러 CLAUDE.md "capacity 분기 결정론 재현난") unit 락인으로 갈음하고 라이브는 sut + 파싱만 강제.

---

## 7. 의도적 연기 (roadmap §A9에 누적)

- **per-window dropped 정밀 파이프라인(C안 일부)**: 정확한 "첫 drop 초" + 초당 drops 차트. 엔진→proto→migration 0017→worker→report→UI 7-layer. onset은 windows-only 근사로 갈음(R6). 별도 슬라이스.
- **per-worker CPU/in-flight 계측(진짜 worker-vs-SUT 분리)**: 귀속의 ground-truth. 새 메트릭 파이프라인 필요 → C안 본체. 별도 슬라이스.
- **closed-loop 용량 인사이트**: closed-loop은 `dropped`가 없어 `load_gen_saturated` 미발동(달성 RPS << vus/지연 같은 worker-bound 감지엔 다른 신호 필요). 범위 밖.
- **`onset_second` XLSX/CSV 열**: v1 UI 진단 only. 필요 시 export 곁다리.
- **transport 실패(status `"0"`) SUT 신호화**: 부하기/서버 모호라 5xx만 ground-truth로 채택. 정밀화는 후속.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → ① 미사용 헬퍼만 ② RED 테스트만 단독 커밋 불가 → green fold 지점 명시.

1. **insights.rs 코어(R1–R4·R6·R10) — 1 green 커밋**: `Insight.onset_second` 필드 + `cause` doc 주석 갱신(R5/F3) + `sut_stress`/`latency_rose`/`saturation_onset` 헬퍼 + arm 분기(loadgen 블록은 `:246-255` verbatim 이동, CC1) + 신규 unit(`saturated_sut_via_5xx`·`saturated_sut_via_latency_rise`·`saturated_loadgen_*`·`onset_present_on_ramp`·`onset_omitted_on_flat`·`onset_omitted_on_warmup_dip`) + **§4.6의 기존 4 테스트(`:960`/`:988`/`:1018`/`:1045`) → loadgen 갱신**을 **한 커밋**(헬퍼만 추가=clippy dead_code, 테스트만=test 게이트 실패 → fold). report.rs/export.rs는 무변경(F2 — 손대지 않음).
2. **UI(R5 Zod + R8 + ko.ts) — 1 green 커밋**: `schemas.ts` `onset_second.int().optional()` + `InsightPanel` `actionFor`/`message()` 분기(capacity 제거) + `ko.ts` `saturation.loadgen`/`loadgenWithWorkers`/`sut`(capacity 제거)·onset 문구 + **RTL `InsightPanel.test.tsx:93,107` loadgen/sut 교체** + 신규 분기 테스트. `pnpm lint && pnpm test && pnpm build`.
3. **최종 리뷰 + 라이브 검증(§6)**: `handicap-reviewer`(wire 1:1) → `/live-verify`(sut 재현 + `/report` 파싱).
