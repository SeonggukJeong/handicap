# mean 지연 프록시 전면 일관 업그레이드 — 사이징 프록시 p50→mean (A9 정밀화 스코프 C)

> **이 문서는 새 spec 템플릿(`_TEMPLATE.md`)의 dogfood다.** mean-프록시 슬라이스를 실제로 설계하면서 §2 요구사항 표(R-id)가 크로스커팅·parity 슬라이스에서 값을 내는지 검증하는 게 목적. `spec-plan-reviewer` 3라운드 → clean APPROVE + handicap-reviewer 최종 APPROVE + R3 라이브 검증 완료(2026-06-15).

- **날짜**: 2026-06-15
- **상태**: 구현 완료·머지 (Task 1–3, reviewer 3라운드 APPROVE + handicap-reviewer APPROVE + R3 라이브[mean_ms=55], 2026-06-15)
- **출처**: roadmap §A9 연기 항목 "mean 프록시 전면 일관 업그레이드(C)"(사용자 2026-06-15 "쓸만한 후속"). XLSX 사이징 3열 슬라이스(`2026-06-15-xlsx-insights-sizing-columns`) §6이 연기로 기록. 동기: 사이징 프록시가 **요청당 p50**이라 우편향(long-tail) 분포에서 `p50 < mean` → 체계적 **under-sizing**(권장 슬롯/워커가 실제 필요보다 작음). mean으로 바꾸면 평균 점유를 반영해 교정.
- **연관**: A9 사이징 권장 spec `2026-06-14-capacity-sizing-recommendation-design.md`(post-run `required` 프록시), open-loop 슬롯 사이징 헬퍼 `2026-06-14-open-loop-slot-sizing-helper-design.md`·worker_count 헬퍼 `2026-06-15-worker-count-sizing-helper-design.md`(create-time `recommendSlots` 프록시), ADR-0028(insights)·ADR-0038(worker_count).
- **ADR**: 신규 불필요 — 프록시 *값*만 p50→mean으로 교체(결정 구조 불변, 기존 ADR-0028/0038 범위 내). 단 "사이징 프록시 = mean"을 ADR-0028에 한 줄 보강 검토(plan 단계 판단).

---

## 1. 문제와 목표

사이징 처방(post-run `load_gen_saturated`의 `required`, create-time `recommendSlots`)은 둘 다 Little's Law `동시성 ≈ 도착률 × 지연`에서 **지연 프록시로 요청당 p50**을 쓴다(`insights.rs:229` `summary.p50_ms`, `sizing.ts:56` 호출자 앵커 `summary.p50_ms`). 우편향 지연 분포(흔함)에서 `p50 < mean`이라 평균 점유를 과소평가 → 권장값이 체계적으로 작아 실제로는 여전히 포화한다.

- **목표**: post-run·create-time **두 사이징 경로의 지연 프록시를 p50→mean으로 동시 교체**하되, 둘이 같은 프록시를 쓰는 **parity를 보존**한다. 이를 위해 `ReportSummary`에 `mean_ms`를 노출(엔진 HDR `overall.mean()`)하고 UI까지 배선.
- **비목표(연기)**: §7. 요약 — p95/tail 기반 프록시 옵션, per-step mean, mean을 리포트 차트/CSV/XLSX 열로 노출.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 이 표가 소유. parity(R5)·fallback(R6)은 긴 산문에서 가장 잘 증발하는 항목이라 1급 R로 올린다.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `ReportSummary`가 `overall` HDR 히스토그램의 `(mean()/1_000).round()`(µs→ms, u64)를 `mean_ms`로 직렬화한다 (MUST) | `report.rs` 단위테스트: 알려진 µs 분포에서 `summary.mean_ms` 기대 ms 단언 | ✅ wire: 리포트 JSON(engine→controller→UI) |
| R2 | post-run `insights.rs`의 `required` 프록시가 `p50_ms` 대신 `mean_ms`를 쓴다 (MUST) | `insights.rs` 테스트: mean=50ms·target=10000 → required=ceil(10000×0.05)=500 (기존 p50 테스트를 mean으로) | |
| R3 | UI Zod `ReportSummary` 스키마가 `mean_ms`(정수·비음수)를 수용한다 (MUST) | `schemas.ts` 테스트 + 라이브: 서버가 보낸 `mean_ms`가 파싱 통과 | ✅ wire: UI Zod ↔ serde |
| R4 | create-time open-loop 슬롯 사이징 앵커(`SlotSizingHelper.tsx:22`)가 `summary.p50_ms` 대신 `summary.mean_ms`를 `recommendSlots`에 먹인다 (MUST) | 컴포넌트 테스트: prior run의 mean_ms로 권장 슬롯 계산되는지 | |
| R5 | create-time `recommendSlots` 프록시 ≡ post-run `insights.rs` `required` 프록시 — **둘 다 mean, 같은 반올림** (MUST·불변식) | TS↔Rust 동일 입력(target, mean_ms)에서 같은 권장값 (기존 p50 parity 테스트를 mean으로) | |
| R6 | mean 판별 불가(빈 히스토그램 / `mean_ms == 0`)일 때 기존 `p50==0` 폴백과 동일 동작 — cause None·권장 없음·패닉 없음 (MUST·불변식) | `insights.rs` 테스트: mean_ms=0 → cause None(기존 p50==0 테스트와 동형) | |

- **R1·R3 = 한 와이어 계약의 양쪽** — plan에서 **같은 계약-task에 묶어 함께 머지**(한쪽만 = 와이어 드리프트, 루트 CLAUDE.md handicap-reviewer 1:1 대조 대상).
- **R5는 이 슬라이스의 존재 이유의 절반** — "post-run만 mean으로 바꾸면 parity가 체계적으로 깨져 비추천"(xlsx spec §6)이라 *반드시* 두 경로를 함께. parity를 R로 박지 않으면 plan이 한쪽만 바꿔도 커버리지 표가 통과해버린다.

---

## 3. 핵심 통찰 (설계 근거)

1. **`mean_ms`는 `u64`(반올림 ms) — 기존 summary 필드 타입(`p50_ms: u64`)·`recommendSlots(latencyMs: number)` 시그니처와 일치.** `overall.mean()`은 `f64`이고 **HDR이 µs 저장이라 µs 단위** → `(mean()/1_000.0).round()`로 ms(=`p50_ms`/`p95_ms`가 `percentiles_of`에서 `/1_000` 하는 것과 동일). 정수 ms로 두면: ① summary 필드 동질성(전부 정수 ms), ② R5(parity)에서 양쪽이 *같은 정수*를 쓰므로 TS/Rust 부동소수 차이가 개입 안 함. mean의 이점(우편향에서 mean≫p50, 보통 수십 ms 차)은 정수 반올림으로 손상 안 됨(서브-ms 손실은 R6 폴백이 흡수).
2. **R5를 만족시키려면 양쪽이 "같은 프록시 + 같은 반올림"** — `insights.rs`는 `summary.mean_ms as f64 / 1000.0`, `sizing.ts`는 호출자가 `summary.mean_ms`를 그대로 `latencyMs`로. 수식(`ceil(target × ms/1000)`)은 양쪽 불변, 입력 프록시만 p50→mean.
3. **순수 교체 — 새 계산은 `overall.mean()` 한 번뿐.** `overall` 히스토그램은 이미 `report.rs`에 존재(`:503` `percentiles_of(&overall)` 등 p50/p95/p99 산출에 쓰는 그것). mean은 빌드부(`:596`)에서 한 줄.
4. **R6: mean도 p50과 같은 0-가드 경로** — `insights.rs:228`의 "p50==0(localhost sub-ms) → 판별 불가, cause None" 가드를 mean_ms로 옮기기만. 새 분기 없음.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/report.rs` — 충족 R: R1
- `ReportSummary`(`:54` 부근 구조체)에 `pub mean_ms: u64` 필드 추가(p50_ms 인접).
- summary 빌드(`:596`)에 `mean_ms: (overall.mean() / 1_000.0).round() as u64`. **단위 주의(reviewer #1)**: HDR 히스토그램은 **µs** 저장(`p50_ms`/`p95_ms`도 `percentiles_of`에서 `/1_000`로 ms 변환) → `overall.mean()`도 µs라 **`/1_000.0` 후 반올림**해야 ms. (`overall.mean().round()`만 쓰면 1000× 과대 → R5 parity 붕괴.) 빈 히스토그램이면 `mean()`==0.0 → 0 → R6 폴백.
- **Blast radius(reviewer #2/#3)**: `ReportSummary` 비-optional 필드 추가 = 모든 struct-literal 갱신 필수.
  - **컴파일러-caught (4곳)**: `report.rs:596`(프로덕션) + 테스트 헬퍼 `report.rs:999`·`insights.rs:318` + 픽스처 `export.rs:414`. `cargo build --workspace --tests`가 "missing field"로 잡음.
  - **런타임-caught (1곳, 컴파일러 *못* 잡음)**: `testdata/compare_golden.json`의 summary 객체 2개 — `export.rs`의 `golden_summary_deltas_match`가 `from_str::<Vec<ReportJson>>`로 역직렬화하는데 non-optional 필드 누락은 **`serde_json` 런타임 패닉**(컴파일 OK). 골든 fixture에도 `mean_ms` 추가 필수.
  - **UI 픽스처 (~6곳)**: `ReportSummarySchema`가 `.strict()`라 full-report fixture를 쓰는 테스트(`reportLatency`·`ReportHeadline`·`ReportView`·`Summary`·`RunDetailPage`·`ScenarioComparePage`)에 `mean_ms` 추가 — `tsc` 아닌 `pnpm test`가 잡음.

### 4.2 `crates/controller/src/insights.rs` — 충족 R: R2, R6
- `:229` `let l_sec = summary.p50_ms as f64 / 1000.0;` → `summary.mean_ms`.
- `:228` 0-가드 주석/조건을 mean 기준으로(동작 동형).

### 4.3 `ui/src/api/schemas.ts` — 충족 R: R3
- `ReportSummarySchema`(`:327`, `p50_ms`는 `:333`)에 `mean_ms: z.number().int().nonnegative()` 추가(p50_ms 인접). 서버가 항상 방출(non-Option u64)하므로 `.optional()` 아님 — p50_ms와 동일 스타일. **`.strict()`면 R1만 머지 시 미지 키로 전 리포트 파싱이 깨지므로 R1과 반드시 함께**(seam, dogfood notes F4).

### 4.4 `ui/src/components/SlotSizingHelper.tsx` + `ko.ts` — 충족 R: R4
- **앵커 훅 `usePriorOpenRunAnchor` 전체를 mean으로**: 소스 `:22` `summary.p50_ms`→`summary.mean_ms`, 그리고 `p50Ms` 식별자(반환타입 `:16` `{ p50Ms }`, 대입 `:22`, 반환 `:24`, 소비처 `:63`/`:87`)를 `meanMs`로 리네임(`tsc -b`가 전 사이트 강제). 0-가드(`:24` `p50Ms > 0`)는 그대로 mean에 적용(R6와 일관).
- **`ko.ts:351` 사용자 문구(reviewer NEW)**: `fromPriorRun: (p50) => `지난 실행의 응답시간(p50 ${p50}ms) 기준 추정이에요.``가 "p50"을 표시하는데, mean을 먹이면 **표시가 프록시를 속인다**(ADR-0035 ko.ts 단일소스). "p50" 라벨을 mean-중립 문구로(예: "지난 실행 평균 응답시간 …ms 기준"). 인자명도 `p50`→`mean`.
- `sizing.ts`의 `recommendSlots` *시그니처·본문은 불변*(프록시는 호출자가 고름). 주석(`:51`/`:59`)의 "프록시(요청당 p50)"·stale 인용을 mean·`:229-231`으로 갱신.
- **WorkerSizingHelper는 무관**: `peakThroughput`/`recommendWorkers`(count 기반)라 latency 앵커 없음(dogfood notes G2).

---

## 5. 무변경 / 불변식 (명시)

- **`p50_ms`/`p95_ms`/`p99_ms` 및 다른 모든 소비자 무변경** — `mean_ms`는 **순수 가산**. 리포트 차트·CSV(`report_to_csv`)·XLSX 열·비교 export는 mean을 *추가하지 않는다*(§7 연기).
- **migration 없음** — `mean_ms`는 run_metrics(저장된 HDR 윈도우)에서 리포트 빌드 시 파생, DB 스키마 무관.
- **proto·워커·엔진 부하 생성 무변경** — `overall.mean()`은 컨트롤러 report.rs 집계 단계.
- **closed-loop VU 사이징(VuSizingHelper) 무변경** — 이 슬라이스는 open-loop 슬롯/워커 프록시만(VU 곡선 사이징은 별도 프록시 정책).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `report.rs` 단위: 알려진 분포 → `mean_ms` 기대값 | |
| R2 | `insights.rs` 단위: mean=50ms·target=10000 → required=500(기존 p50 케이스 이식) | |
| R3 | `schemas.ts` 단위 + 라이브 파싱 | ✅ |
| R4 | `SlotSizingHelper`/`WorkerSizingHelper` 컴포넌트 테스트 | |
| R5 | TS↔Rust parity: 같은 (target, mean_ms) → 같은 권장값(골든 fixture, 기존 p50 parity 테스트 이식) | |
| R6 | `insights.rs` 단위: mean_ms=0 → cause None(기존 p50==0 테스트 동형) | |

- **라이브 필수**(R3): `mean_ms`가 서버 응답경로로 UI Zod를 통과하는지 — RTL fixture는 absent-not-null이라 못 잡음(S-D 갭). `/live-verify`로 run 1회: open-loop run 생성 → 리포트 GET → `mean_ms` 파싱 + 사이징 헬퍼가 mean 앵커로 권장하는지.

---

## 7. 의도적 연기 (roadmap §A9에 누적)

- **p95/tail 프록시 옵션**: mean도 극단 long-tail은 과소평가. 사용자 선택형 프록시(mean/p95)는 별도 — v1은 mean 고정.
- **mean을 리포트 표면(차트·CSV·XLSX 열)에 노출**: 이 슬라이스는 `mean_ms`를 *사이징 프록시*로만 쓴다. 리포트 UI/export에 mean 열을 들일지는 별도(xlsx 슬라이스 패턴).
- **per-step mean**: summary(overall) mean만. step별 mean 프록시는 step-level SLO와 함께.

---

## 8. 구현 순서 (plan 입력)

`seam ✅`(R1 serde / R3 Zod)을 **함께** 머지해야 와이어가 안 깨진다. 커밋 경계:

1. **계약-먼저 (R1+R3 한 묶음)**: `report.rs` `mean_ms` 직렬화 + `schemas.ts` Zod 수용 — backend·UI 한 슬라이스라 게이트 둘 다 돈다. (R1 Rust 테스트 + R3 라이브 가능 상태.)
2. **사이징 프록시 교체 (R2+R5+R6)**: `insights.rs` p50→mean(+0-가드) + parity 테스트 이식. green fold(헬퍼/로직/테스트 단일 커밋 — dead-code/RED 단독 불가).
3. **create-time 앵커 (R4)**: `SlotSizingHelper`/`WorkerSizingHelper` 앵커 mean 교체 + 컴포넌트 테스트.
4. 라이브 검증(R3) → docs(roadmap §A9 완료 + build-log).
