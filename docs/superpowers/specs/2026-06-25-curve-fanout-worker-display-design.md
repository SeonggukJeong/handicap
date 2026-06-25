# 곡선 fan-out 워커 표시 — closed-loop VU 곡선 fan-out run의 워커 수 + per-worker active-VU 분해 (B9 — ADR-0037 §9 연기 항목)

- **날짜**: 2026-06-25
- **상태**: 설계 승인(사용자 2026-06-25) → plan 대기
- **출처**: roadmap §B9 연기 누적("per-stage 워커 분해 리포트·worker-count UI 표시"). **왜 지금**: closed-loop VU 곡선 비-풀 fan-out 샤딩(2026-06-23)으로 곡선 run이 N대 워커로 분산 실행되지만, 그 사실도·각 워커의 추종 여부도 UI에 **전혀 안 보인다**. merged `active_vu_series`는 `actual`이 `desired`에 못 미쳐도 *어느 워커가* 꺾였는지 구분 못 함(SUM 머지) — 분산 곡선 run의 관측성 공백을 닫는다.
- **연관**: ADR-0037(closed-loop VU 곡선), ADR-0027(멀티워커 fan-out), active-VU 시계열(`2026-06-13-active-vu-timeseries`), closed-curve 워커 샤딩(`2026-06-23-closed-curve-worker-sharding`), 곡선 run VU 표시(`2026-06-24-curve-vu-display`).
- **ADR**: 신규 불필요(ADR-0037/0027 범위 내 additive·read-path). migration/proto/engine/worker 0.

---

## 1. 문제와 목표

곡선 fan-out run은 컨트롤러가 `ceil(peak/cap)`대 워커로 분산 실행하지만, RunDetailPage·리포트 어디에도 "몇 대로 돌았나"가 없고, `ActiveVuChart`의 `actual`은 워커 합계(SUM)라 `desired` 미달 시 **한 워커의 문제인지 전 fleet의 SUT 한계인지** 구분이 불가능하다. per-worker 데이터(`run_active_vu_metrics`, worker_id 포함 PK)는 **이미 DB에 있고** read 시 SUM으로 머지되어 버려질 뿐이다.

- **목표**: 곡선 fan-out run(N≥2)의 RunDetailPage에서 ① 워커 수("N개 워커로 분산 실행") ② per-worker desired/actual 분해를 토글로 제공 — 데이터는 비-SUM read로 복구, migration/proto/engine/worker 0, 기존 모든 리포트 byte-identical.
- **비목표(연기)**: §7. per-worker **지연**(p95/p99) 분해(Scope 3)·run 목록 워커 배지·non-곡선 fan-out·worker_count override 노브.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 새 store 읽기 `active_vu_by_worker(db, run_id)`가 `run_active_vu_metrics`를 **SUM 없이** per-(worker_id, ts_second) 행(desired/actual 보존)으로, **legacy `''` 행 제외**(`worker_id <> ''` — migration 0018 backfill/SUM-output에서만 생기는 sentinel), worker_id→ts_second 정렬해 반환한다. | `cargo test` store 단위(2워커 + legacy `''` 행 fixture → 워커별 분리·정렬·`''` 제외) | |
| R2 | MUST `ReportJson`에 `active_vu_by_worker: Vec<WorkerActiveVuSeries>`(`WorkerActiveVuSeries { worker_id: String, samples: Vec<ActiveVuSample> }`)를 가산하되 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`로 비면 직렬화 생략한다. | serde 직렬화 테스트(빈 → 키 부재·채움 → 배열) | ✅ wire: UI Zod ↔ serde |
| R3 | MUST per-worker 필드는 곡선 run에 한해(§4.2b caller가 `is_vu_curve()`로 fetch 게이트 — 비-곡선은 active-VU 행 0이라 fetch skip) `build_report` 내부 **distinct non-empty worker_id ≥ 2**일 때만 채운다(그 외 = 빈 Vec). | `cargo test` build_report 게이트 2케이스(단일워커 곡선 slice[distinct 1]=빈·곡선 N≥2 slice=채움) | |
| R4 | MUST 기존 모든 리포트(단일워커·비-곡선·fixed)의 **직렬화 JSON byte-identical** + 기존 merged `active_vu_series`(SUM) read·DTO·**assertion 무변경**(9번째 인자 추가로 build_report **호출부**만 trailing `&[]` 기계적 추가). | 골든 JSON·기존 assertion diff 0(호출부 `&[]` churn 제외) | |
| R5 | MUST 표시 워커 수 N과 차트 워커 선 묶음은 **`active_vu_by_worker` 단일 소스**에서만 도출(별도 count 필드·쿼리 없음). | UI는 `byWorker.length`/`byWorker` 외 워커 수 소스 미사용(코드 검토·RTL) | |
| R6 | MUST UI Zod `active_vu_by_worker: z.array(WorkerActiveVuSeriesSchema).optional()`(`.strict()` 유지·repo 선례 `active_vu_series`/`if_breakdown`와 동일)로 서버 absent를 수용하고, 소비처가 `?? []`로 정규화(서버 skip이라 null 미전송). | Zod 단위(absent → undefined·채운 payload 파싱) + `pnpm build` 타입 통과 | ✅ wire: UI Zod ↔ serde |
| R7 | MUST `ActiveVuChart`가 `active_vu_by_worker` 비면 토글 미렌더(기존 화면 byte-identical), ≥2면 `[합계 | 워커별]` 토글을 **기본 합계**로 노출한다. | RTL(단일=토글 없음·≥2=토글·기본 합계 라인=기존) | |
| R8 | MUST 워커별 뷰가 워커당 desired(점선)+actual(실선)을 워커별 색상으로, **서수 라벨 "워커 {n}"**(worker_id 오름차순 정렬 → 결정적)로 렌더한다. | RTL(N개 워커 → 2N 라인·"워커 1"/"워커 2" 라벨·정렬 결정성) | |
| R9 | MUST 멀티워커일 때 캡션 "{n}개 워커로 분산 실행"을 **두 뷰 공통**으로 노출한다. | RTL(합계·워커별 양쪽에 캡션 텍스트) | |
| R10 | MUST 전 신규 사용자 문구(합계·워커별·워커 {n}·캡션·aria/title)를 **ko.ts 경유**(ADR-0035)로만 출력. | grep: 신규 컴포넌트에 인라인 한국어 리터럴 0 | |
| R11 | MUST 머지 diff가 **controller read-path(store fn + report 필드/게이트) + `ui/`(+docs)** 에 한정 — engine/worker/proto/`.sql` migration 0-diff. | `git diff --name-only master..HEAD` 범위 확인 | |
| R12 | SHOULD 워커별 뷰가 raw worker_id를 title/tooltip으로 노출(서수 라벨 보조). | RTL(라인/범례 title에 worker_id) | |

- **seam 양쪽**: R2(serde 직렬화) ↔ R6(UI Zod 수용) — 같은 계약. plan에서 함께 머지(한쪽만 = 와이어 드리프트). 단일 슬라이스라 둘 다 이 spec이 소유.

---

## 3. 핵심 통찰 (설계 근거)

1. **count는 overlay에 종속.** 워커 수 단독은 약한 확인 메트릭이고, 유용한 건 "어느 워커가 desired를 못 따라갔나"의 per-worker overlay다. 그래서 N을 **별도로 영속/계산하지 않고**(migration·COUNT(DISTINCT) 모두 기각) overlay를 그리는 바로 그 per-worker read의 길이로 도출한다(R5) — count와 차트가 구조적으로 항상 일치, 두 번째 진실원천 부재. fan-out은 fail-fast라 "계획 N vs 관측 N" 갈림의 가치가 낮아 영속 N(planned)의 이점이 약하다.
2. **데이터는 이미 있다.** `run_active_vu_metrics`는 worker_id를 PK에 갖고 per-worker desired/actual 행을 보관(migration 0018). 기존 read만 `SUM…GROUP BY ts_second`로 머지한다 — 비-SUM read 1개(R1) 추가로 복구. **migration/proto/engine/worker 0**(R11).
3. **per-worker desired가 불균등 share를 정직하게 답한다.** 비-풀 fan-out은 `shard_split`(균등), LAN 풀(L5)은 `proportional_split`(capacity 비례·불균등)이라 워커 actual을 서로 비교하는 것만으론 풀 케이스 판정 불가. 각 워커가 *자기* desired-share를 보고하므로(R1) per-worker desired(점선) vs actual(실선)로 두 경로 모두 판정(R8).
4. **곡선 한정은 caller, 단일워커 배제는 count.** 엔진은 `record_active_vu`를 `run_scenario_vu_curve`에서만 호출하므로 비-곡선 run은 active-VU 행이 **0개** — 그래서 곡선 한정은 §4.2b caller가 `is_vu_curve()`로 fetch 자체를 skip해 달성(쿼리 비용도 절약)하고, `build_report` 내부 게이트는 **distinct non-empty worker_id ≥ 2** 하나뿐(R3). 단일워커 곡선 run은 worker_id로 **하나의 non-empty ULID**를 기록(subprocess가 N=1도 ULID 발급, never `''`) → distinct 1 → 게이트 미달 → 빈 Vec → `skip_serializing_if`로 직렬화 생략 → 기존 리포트 **byte-identical**(R4). (`worker_id=''`는 migration 0018 backfill·SUM-read 출력에서만 나오는 legacy sentinel이라 §4.1 `<> ''` 필터는 그 legacy 행만 제외 — production ingest엔 안 나옴.) 비-곡선 fixed fan-out은 active-VU 차트 자체가 없어 bare count만 가능(저가치)이므로 제외.
5. **기본 byte-identical + opt-in 토글.** 합계 뷰를 기본으로 두어 단일워커/기존 화면 무변화, 워커별은 토글 opt-in(R7) — 이 repo의 "default byte-identical" 규율 + 기존 transaction-timing 워터폴↔칩 토글 이디엄과 일치.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/store/metrics.rs` — 충족 R: R1
- 신규 `active_vu_by_worker(db, run_id) -> sqlx::Result<Vec<ActiveVuRow>>`:
  `SELECT ts_second, worker_id, desired, actual FROM run_active_vu_metrics WHERE run_id = ? AND worker_id <> '' ORDER BY worker_id, ts_second`.
  **기존 `ActiveVuRow` 재사용**(이미 `run_id/ts_second/desired/actual/worker_id` 보유 — `metrics.rs:351`). `<> ''`는 migration 0018 backfill로 생긴 legacy 행만 거른다(production ingest는 항상 non-empty ULID 기록). 기존 `active_vu_series`(SUM read, worker_id="" 반환)는 **무변경**.

### 4.2 `crates/controller/src/report.rs` — 충족 R: R2, R3, R4
- `ReportJson`에 `active_vu_by_worker: Vec<WorkerActiveVuSeries>` 가산 + `#[serde(default, skip_serializing_if = "Vec::is_empty")]`(기존 `active_vu_series`는 skip 없음 — 신규 필드만 생략해야 byte-identical).
- 신규 struct `WorkerActiveVuSeries { worker_id: String, samples: Vec<ActiveVuSample> }`(samples는 기존 `ActiveVuSample` 재사용).
- `build_report`에 **9번째 위치 슬라이스 인자** `active_vu_by_worker: &[ActiveVuRow]` 추가(8번째 `active_vu`와 동일 패턴, `report.rs:412`). 본문: distinct non-empty worker_id ≥ 2면 worker_id별 group → worker_id 정렬 순 `Vec<WorkerActiveVuSeries>` 채움, 아니면 빈 Vec(곡선 한정은 §4.2b caller가 담당하므로 내부 `is_vu_curve` 불필요). merged `active_vu_series` 빌드는 **무변경**.
- **call-site churn(정확한 지도)**: `build_report` 호출부는 **27곳 = `report.rs` 단위 테스트 26곳 + `runs.rs:933`(build_report_for_run)** → 신규 인자에 trailing **`&[]`**(테스트는 per-worker 미사용·기계적). **별개 churn**: `export.rs:487` `report_with_steps`의 `ReportJson { … }` **struct 리터럴**에 `active_vu_by_worker: vec![]` 추가(컴파일 강제 — `#[serde(default)]`는 리터럴에 무력, 컨트롤러 CLAUDE.md 트랩). `coordinator.rs:935`는 **`build_report_for_run`을 호출**(build_report 아님)하고 `report.verdict`만 읽으므로 **무변경**. 미사용-인자/리터럴 churn은 read-path 단일 green 커밋에 fold.

### 4.2b `crates/controller/src/api/runs.rs` — 충족 R: R1, R3 (caller fetch)
- `build_report_for_run`(`runs.rs:921`)이 run row의 `profile.is_vu_curve()`(로컬명 `row`)일 때만 §4.1 `active_vu_by_worker(db, run_id)`를 fetch(비-곡선은 쿼리 skip → `&[]`), `build_report`의 9번째 인자로 전달. (기존 `active_vu = active_vu_series(...)`(`runs.rs:931`)는 그대로.)

### 4.3 `ui/src/api/schemas.ts` — 충족 R: R6
- `WorkerActiveVuSeriesSchema = z.object({ worker_id: z.string(), samples: z.array(ActiveVuSampleSchema) }).strict()`.
- `ReportSchema`(`schemas.ts:401`)에 `active_vu_by_worker: z.array(WorkerActiveVuSeriesSchema).optional()` 추가(서버 skip → absent → `undefined`). 기존 `active_vu_series`(`schemas.ts:411`)·`if_breakdown`와 동일한 `.optional()` 선례 — 소비처(§4.4)가 `?? []`로 `[]` 정규화. (top-level `.default()`는 `request<T>`로 `T | undefined` 누출 위험[ui/CLAUDE.md, `pnpm build`만 잡음]이라 회피.)

### 4.4 `ui/src/components/report/ActiveVuChart.tsx` — 충족 R: R5, R7, R8, R9, R12
- props에 `byWorker: WorkerActiveVuSeries[]` 추가(부모 ReportView가 `report.active_vu_by_worker ?? []` 주입 — R6 `.optional()` 정규화 지점).
- `byWorker.length === 0` → 기존 단일 차트만(토글·캡션 없음·byte-identical).
- `≥ 1`(서버가 ≥2일 때만 채우므로 사실상 ≥2) → `byWorkerView` 상태(bool, 기본 false=합계) 토글 + 캡션 `ko.report.activeVuFanout(byWorker.length)`.
  - 합계: 기존 desired/actual 라인.
  - 워커별: worker_id 정렬 순으로 워커당 desired(점선)+actual(실선), 팔레트 색상, 범례 라벨 `ko.report.activeVuWorkerLabel(i+1)`, 범례 `<li title=worker_id>`(R12).
- N = `byWorker.length` 단일 소스(R5).

### 4.5 `ui/src/i18n/ko.ts` (기존 `report:` 네임스페이스 — 신규 키는 기존 `activeVuTitle`/`activeVuDesired`/`activeVuActual` 근처) — 충족 R: R10
- `report.activeVuViewTotal="합계"`, `report.activeVuViewByWorker="워커별"`, `report.activeVuViewToggleLabel="VU 곡선 보기 방식"`, `report.activeVuWorkerLabel=(n)=>`워커 ${n}``, `report.activeVuFanout=(n)=>`${n}개 워커로 분산 실행``(기존 `vusCurvePeak` 함수-키 패턴과 동일·`activeVu*` prefix로 기존 차트 키와 군집).

---

## 5. 무변경 / 불변식 (명시)

- **migration 0 · proto 0 · engine 0 · worker 0**(R11). `run_active_vu_metrics` 스키마·`MetricBatch`·엔진 부하경로·워커 무변경 — 기존 per-worker 행을 read만 한다.
- merged `active_vu_series`(SUM read·`ActiveVuSample` DTO·`ActiveVuChart` 기존 라인) **무변경**(R4).
- 기존 모든 리포트(단일워커 곡선·fixed closed·open·비-곡선 fan-out)는 `active_vu_by_worker` 생략 → JSON **byte-identical**, 화면 무변화(R4·R7).
- run 목록(ScenarioRunsPage)·`RunVuCell`·run-생성 payload·`runs` 테이블 **무변경**.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | store 단위: 2워커 + legacy `''` 행 fixture → 워커별 분리·정렬·`''` 제외 | |
| R2 | serde: 빈 Vec → 키 부재 / 채운 Vec → 배열 직렬화 | ✅(필드 파싱) |
| R3 | build_report 게이트 2케이스(단일 곡선 slice[distinct 1]=빈·곡선 N≥2=채움) | |
| R4 | 골든 JSON·기존 assertion diff 0(27 호출부 trailing `&[]` + export.rs 리터럴 `vec![]` churn 제외) | |
| R5 | 코드 검토 + RTL: 워커 수 = `byWorker.length`만 | |
| R6 | Zod 단위: absent → undefined·채운 payload 파싱·`.strict()` 거부 + `pnpm build` 타입 | ✅ |
| R7 | RTL: 단일=토글 없음·≥2=토글·기본 합계=기존 라인 | |
| R8 | RTL: N워커 → 2N 라인·"워커 1/2" 라벨·정렬 결정성 | |
| R9 | RTL: 두 뷰 캡션 "{n}개 워커로 분산 실행" | |
| R10 | grep: 신규 컴포넌트 인라인 한국어 0 | |
| R11 | `git diff --name-only` = controller read-path + ui/(+docs)만 | |
| R12 | RTL: 라인/범례 title=worker_id | |

- **라이브 검증 필수**(S-D 갭 — 리포트-파싱 경로에 신규 필드 추가): `/live-verify`로 subprocess **2-워커 곡선 run**(`--worker-capacity-vus`로 peak>cap→N=2 강제, closed-curve-sharding 레시피 재사용) → `POST /api/runs` 곡선 페이로드 → 종료 후 `GET /report`에 `active_vu_by_worker`(2 워커) → RunDetailPage 토글+워커별 2N 라인+"2개 워커로 분산 실행" 캡션·Zod 0. **UI 빌드 필요**라 controller `--ui-dir ui/dist` 포함(백엔드-only 워크트리 아님). 단일워커 곡선 run으로 **toggle 부재(byte-identical)** 교차확인.

---

## 7. 의도적 연기 (roadmap §B9에 누적)

- **per-worker 지연(p95/p99) 분해 (Scope 3)**: 사용자 결정(2026-06-25) — 1안(워커 수+VU overlay) 먼저, 부족 시 후속. per-worker HDR(`run_metrics` worker_id) 비-SUM 복구 + 신규 리포트 섹션/테이블이라 별도 슬라이스.
- **run 목록 워커 배지**: bare count는 차트 없는 목록에서 정보 가치가 낮고(사용자 동의), 거기 넣으면 영속/N+1 압박 발생 → 별도 후속.
- **non-곡선 fan-out 워커 표시**(closed-fixed vus>cap·open worker_count>1): active-VU 차트 자체가 없어 bare count만 가능 → 저가치, 제외.
- **closed-loop `worker_count` override 노브**: authoring/config 표면(이 슬라이스는 관측성) → 별도.
- **per-stage 워커 분해**(stage 경계별 워커 기여): 시계열 overlay로 시간축 분해는 충족, stage-경계 집계 테이블은 별도.

---

## 8. 구현 순서 (plan 입력)

> 단일 슬라이스(분할 없음). cargo-영향 read-path와 ui/는 별 커밋 가능하나 seam(R2↔R6)은 함께 머지.

1. **Task A (controller read-path, 단일 green 커밋)**: §4.1 store fn(R1) + §4.2 report 필드/struct/내부 게이트(R2·R3·R4) + §4.2b caller fetch-gate(R3) + 단위 테스트(R1·R3) + serde 테스트(R2) + 27 `build_report` 호출부 trailing `&[]` + `export.rs:487` 리터럴 `vec![]`(컴파일 강제). 헬퍼+호출+테스트+churn을 한 커밋으로 fold(미사용 헬퍼 dead_code·RED-only 게이트 회피). 기존 골든/assertion diff 0 확인(R4).
2. **Task B (UI, 단일 green 커밋)**: §4.3 Zod(R6) + §4.5 ko(R10) + §4.4 `ActiveVuChart` 토글/워커별/캡션(R5·R7·R8·R9·R12) + RTL. R2 직렬화와 R6 수용이 같은 계약이라 Task A·B 함께 머지.
3. **라이브 검증**(§6) → finish-slice(build-log·roadmap §B9·CLAUDE 상태줄·메모리).
