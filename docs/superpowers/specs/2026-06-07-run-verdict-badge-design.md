# Run verdict 영속화 + pass/fail 배지 — 설계

- **날짜**: 2026-06-07
- **상태**: 설계 승인됨 (구현 대기)
- **출처**: roadmap §B6 "run 목록 pass/fail 배지 (fast-follow)" — A4a(ADR-0028) SLO verdict + Run 스케줄러(ADR-0034)의 후속. 종료 run의 verdict를 영속화해 목록/타임라인에서 한눈에 본다.
- **영역**: 컨트롤러(migration 0012 + 코디네이터 finalize 훅 + read-path) + UI. **엔진·워커·proto 무변경.** ADR 신규 불필요(ADR-0028 범위 내 additive).

---

## 1. 배경·동기

A4a(ADR-0028)가 run-level SLO criteria(p50/p95/p99·error_rate·status-class·min_rps·per-window RPS)와 pass/fail **verdict**를 도입했지만, verdict는 **`/report` 페이지에서 on-demand로만 계산**된다(영속화 없음 — `build_report`가 매 요청 `evaluate_criteria` 재실행). 따라서:

- 런(run) **목록**(`ScenarioRunsPage`)엔 메트릭이 없어 pass/fail을 못 보여준다.
- Run 스케줄러(ADR-0034)가 예약/반복 run을 **무인 발사**하지만, 결과를 보려면 매 run의 리포트를 일일이 열어야 한다 — "성능 회귀 감시 루프"의 마지막 한 칸이 비어 있다.

이 슬라이스는 **종료(Completed) 시점에 verdict를 한 번 계산해 영속화**하고, 세 표면(run 목록 / 스케줄 이벤트 타임라인 / run 상세 헤더)에 배지로 노출한다.

## 2. 목표 / 비목표

### 목표
- 종료 run의 verdict를 DB에 영속화(`runs.verdict_json`).
- run 목록·스케줄 이벤트 타임라인·run 상세 헤더에 PASS/FAIL/— 배지.
- FAIL 배지에 실패 기준 요약 tooltip.
- 무인 스케줄 run도 목록/타임라인에서 즉시 pass/fail 가시.

### 비목표 (YAGNI / 연기)
- **백필 없음**: 이 기능 출하 *전*에 종료된 run은 `verdict_json = NULL` → 배지 "—". (리포트 페이지는 여전히 재계산하므로 데이터 손실 없음. 시작 시 N회 report-build 백필은 비용 대비 가치 없음.)
- verdict 기준 **필터/정렬**, 크로스-시나리오 대시보드.
- **스케줄 *요약* 행**의 last-run verdict(목록 행) — 이번엔 이벤트 *타임라인*만.
- baseline-상대 polarity 색.
- `build_report` 변경 없음 — 리포트 페이지는 그대로 재계산.

## 3. 아키텍처 개요

```
[worker final flush + Completed]                (변경 없음)
        ↓ (gRPC bidi, in-order)
coordinator stream loop: MetricBatch→ingest_metrics().await, RunStatus→record_phase().await
        ↓ (모든 워커 Completed → 단일 finalization)
record_phase :: Finalize::Completed  ──(신규 훅)──▶ build_report_for_run → .verdict
        ↓ set_status(Completed)                              ↓ Some(Verdict)
        └─────────────────────────────────────────▶ UPDATE runs SET verdict_json
                                                              │
  read paths:                                                 │
   runs::get / list_by_scenario  → RunRow.verdict ◀───────────┤ (verdict_json 파싱)
   schedules::recent_events (LEFT JOIN runs) → Event.verdict ◀─┘ (read-time 해석)
        ↓ to_response / api
   RunResponse.verdict / Event.verdict  (JSON, null=absent)
        ↓ Zod (.nullish(), 기존 VerdictSchema 재사용)
   <VerdictBadge> × 3 표면
```

### 핵심 불변식
**영속 verdict == on-demand `/report` verdict (항상).** 둘 다 동일한 순수 함수 `report::evaluate_criteria`를 동일한 *종료 후 불변* 메트릭 위에서 실행한다. finalize 시점에 모든 워커의 final 메트릭이 이미 ingest됐음이 보장된다(§4.2). 그러므로 두 값은 절대 갈리지 않으며, `build_report`는 변경하지 않는다(리포트 페이지는 계속 재계산, 영속 사본은 목록/타임라인/헤더만 먹인다).

## 4. 컴포넌트 상세

### 4.1 데이터 모델 — migration 0012 `runs.verdict_json`
- nullable `TEXT` 컬럼. **Rust-guarded `ALTER TABLE ADD COLUMN`**(`ensure_runs_verdict_json`), `store/mod.rs::connect()`에서 기존 `ensure_runs_dropped`(0009) 뒤에 배선. `runs.dropped`(0009)/`runs.message`(0002)와 동형 — **별도 `.sql` 파일 없음**(인라인 가드 fn, `pragma_table_info('runs')` count 검사 후 ALTER).
- **저장 shape = 전체 `report::Verdict` JSON**(`{passed: bool, criteria: [{metric, direction, threshold, actual, passed}]}`). bool만이 아니라 전체를 저장하는 이유: FAIL tooltip이 실패 기준을 보여주려면 `criteria[]`가 필요 + 향후 재사용. 비용 수백 바이트/완료 run.
- `NULL` = verdict 없음(criteria 비활성 / 전부 skip / 비-Completed / 백필 전 종료 run).
- **proto·엔진·워커·`profile_json` 무변경** — verdict는 profile 필드가 아니라 컨트롤러측 *결과*라 실제 컬럼이 필요(profile serde-default 트릭 불가).

### 4.2 계산·영속 — 코디네이터 `Finalize::Completed`
`grpc/coordinator.rs::record_phase`의 `Finalize::Completed` arm(단일 멀티워커 finalization 지점, 현재 `set_status(Completed)` + `cleanup_dispatcher` 호출):
- `set_status(Completed)` 직후 `crate::api::runs::build_report_for_run(&self.db, run_id).await` 호출 → `.verdict` 추출.
  - 이 헬퍼는 이미 멀티워커 HDR merge(`(ts,step)` 머지 + count SUM)를 캡슐화 → 영속 verdict가 `/report` verdict와 같은 코드 경로를 타 **일관성 보장**. 추가로 계산되는 insights/latency/group은 버리지만 HDR merge 대비 무시 가능 비용(완료당 1회, hot path 밖).
- `Some(verdict)`면 `runs::set_verdict(&self.db, run_id, &verdict)`(신규 store fn) → `UPDATE runs SET verdict_json = ? WHERE id = ?`. `None`이면 NULL 유지(write 안 함).
- **fail-soft**: `build_report_for_run` 에러(드물게 HDR 손상 등)는 `warn!` + skip — **finalize를 절대 막지 않는다**(run은 이미 Completed로 전이됨). `let _ =` / `if let Ok(rep)` 패턴.
- verdict는 **Completed run에만** 붙는다. `Failed`/`Aborted`(다른 finalize arm·`worker_disconnected`·reaper·REST abort) arm은 **건드리지 않음** — 오늘의 `build_report`(`RunStatus::Completed`일 때만 verdict)와 동일 의미.

**메트릭 완전성 보장(§3 불변식의 근거)**: 코디네이터 스트림 루프는 메시지를 순차 처리하고 inline `await`한다 — `MetricBatch → ingest_metrics().await`, 그 다음 `RunStatus → record_phase().await`(coordinator.rs ~678–688). 워커는 final flush를 보낸 *뒤* Completed phase를 보낸다. 멀티워커는 마지막 워커의 Completed에서 finalize가 발동하므로, 그 시점엔 전 워커의 final 메트릭이 ingest 완료. 즉 finalize-time 계산은 "완료 직후 `/report` fetch"와 동일한 데이터 가용성을 갖는다.

### 4.3 Read path
- **`RunRow`**(`store/runs.rs`)에 `verdict: Option<Verdict>` 추가. `verdict_json` 컬럼을 `serde_json::from_str::<Verdict>` 파싱(파싱 실패는 `None`으로 관대 처리 — 손상 행이 목록을 깨지 않게). `get` + `list_by_scenario` 둘 다 SELECT 컬럼 목록에 `verdict_json` 추가 + 매핑. `insert`의 RunRow 리터럴엔 `verdict: None`.
  - 타입 커플링: `Verdict`는 `crate::report`에 정의, `RunRow`는 `store::runs`. 같은 crate라 모듈 순환 참조 무관(Rust intra-crate 허용; `report`가 이미 `store::runs::Criteria`를 import하는 역방향과 공존).
- **`RunResponse`**(`api/runs.rs:22`)에 `verdict: Option<Verdict>` 추가. **단일 변환 사이트** `to_response()`(:613)에 `verdict: r.verdict` 한 줄. (run 목록 `GET /api/scenarios/{id}/runs` + 단건 `GET /api/runs/{id}` 둘 다 이 경로.)
- **스케줄 이벤트**: `store/schedules.rs::recent_events`의 쿼리를 `LEFT JOIN runs r ON r.id = schedule_events.run_id`로 확장, `r.verdict_json` SELECT. `ScheduleEventRow`에 `verdict: Option<Verdict>` 추가(파싱은 read-time — verdict는 발사 후 늦게 완성되므로 이벤트에 저장 불가, JOIN으로 항상 최신 해석). api 응답 Event DTO에 `verdict` 노출.
  - non-fired 이벤트(skipped_overlap 등 run_id=NULL) / pending·running·백필 전 run → `verdict = null`.

### 4.4 Wire / Zod
- **기존 `VerdictSchema` 재사용**(`ui/src/api/schemas.ts:296`, 이미 `ReportSchema.verdict`에서 사용 중). 신규 Zod 타입 0.
- `RunSchema`(schemas.ts:139, run 객체 스키마)에 `verdict: VerdictSchema.nullish()` 추가.
- `ScheduleEventSchema`(schemas.ts:124, `ScheduleEventTimeline`이 쓰는 와이어 스키마)에 `verdict: VerdictSchema.nullish()` 추가.
- **`.nullish()` 필수**(`.optional()` 아님): 서버 `Option<Verdict>`는 `#[serde] None → null`로 직렬화(skip_serializing_if 없음). `.optional()`이면 서버 `null` 거부 → 파싱 깨짐(문서화된 함정). RunDetail은 기존 `report.verdict`(이미 `.nullish()`) 재사용이라 추가 없음.

### 4.5 UI — 공유 `VerdictBadge` × 3 표면
- **`<VerdictBadge verdict={Verdict | null | undefined} />`** 프레젠테이셔널 컴포넌트(신규): `verdict?.passed === true` → 녹색 **PASS**, `=== false` → 적색 **FAIL**, null/undefined → 중립 **—**. `StatusBadge` 패턴 미러. FAIL일 때 `title` 속성에 실패 기준 요약(`criteria.filter(c=>!c.passed)` → `"p95_ms 320 > 300"` 류, direction에 따라 `>`/`<`).
- **`ScenarioRunsPage`**: 테이블에 "결과" 열 추가(Status 열 인근). `<VerdictBadge verdict={r.verdict} />`. (기존 `?retry=` effect deps·선택 게이트 로직 무접촉 — 그 파일의 exhaustive-deps 함정 회피.)
- **`ScheduleEventTimeline`**: fired 이벤트의 run 링크 옆에 `<VerdictBadge verdict={event.verdict} />`.
- **`RunDetailPage`**: 상단 헤더에 배지. **이미 로드된 `report.verdict`** 소스(종료 run은 report fetch 완료 — 추가 fetch 0). 하단 전체 `VerdictPanel`은 유지. 진행 중/비-Completed면 verdict 없음 → 배지 미표시 또는 "—".

## 5. 와이어 1:1 대조표

| 레이어 | run verdict | event verdict |
|---|---|---|
| DB | `runs.verdict_json TEXT NULL` (0012) | `runs.verdict_json` via LEFT JOIN |
| store | `RunRow.verdict: Option<Verdict>` | `ScheduleEventRow.verdict: Option<Verdict>` |
| api struct | `RunResponse.verdict` (`to_response`) | Event DTO `.verdict` |
| JSON | `verdict: {passed,criteria[]} \| null` | `verdict: {…} \| null` |
| Zod | `RunSchema.verdict: VerdictSchema.nullish()` | `ScheduleEventSchema.verdict: VerdictSchema.nullish()` |
| UI | `<VerdictBadge verdict={r.verdict}/>` | `<VerdictBadge verdict={ev.verdict}/>` |

`Verdict` JSON shape(전 레이어 공유, 기존): `{ "passed": bool, "criteria": [{ "metric": str, "direction": "max"|"min", "threshold": f64, "actual": f64, "passed": bool }] }`.

## 6. 엣지 케이스 / 불변식

- **백필 전 종료 run**: `verdict_json = NULL` → 목록/타임라인 "—". 리포트 페이지는 재계산이라 정상 표시(forward-only 배지, 손실 없음).
- **criteria 없음 / 전부 skip**(예: 짧은 run + min_window_rps만): verdict `None` → NULL → "—"(criteria 없음과 동일 중립 표시).
- **Failed/Aborted run**: verdict 미영속(NULL). 배지 "—". (Status 배지가 이미 실패를 표현.)
- **fail-soft**: finalize의 verdict 계산 실패는 run을 Completed로 두고 verdict만 NULL — finalize 차단 금지.
- **손상 `verdict_json`**: read 시 파싱 실패 → `None`(관대) → 목록 깨지지 않음.
- **N=1/멀티워커 동일**: `build_report_for_run`이 워커 머지를 처리하므로 N과 무관.

## 7. 테스트 전략

- **store**(`store/runs.rs`, `store/mod.rs`): `ensure_runs_verdict_json` 멱등(두 번 호출 OK); `set_verdict` 후 `get`/`list_by_scenario`가 verdict round-trip; 손상 JSON → `None`.
- **coordinator**(`grpc/coordinator.rs` 인라인 test): `Finalize::Completed`가 criteria run에 verdict 영속 / no-criteria run엔 NULL; report 빌드 실패 시 fail-soft(run은 Completed, verdict NULL); `Failed`/`Aborted` arm은 verdict 미영속. (기존 `finalize_*` 테스트 패턴 재사용 + `set_dispatcher` 미설정 no-op.)
- **schedules**(`store/schedules.rs`): `recent_events` JOIN이 fired run의 verdict 해석 / run_id NULL·미완료 run은 verdict NULL.
- **e2e**(`controller/tests/e2e_test.rs`): 기존 verdict e2e가 있으면 확장 — 워커 subprocess → 완료 → `GET /runs/{id}`(또는 목록)에 verdict 포함 단언.
- **UI**(RTL + vitest): `VerdictBadge` 3상태(PASS/FAIL/—) + FAIL tooltip; 각 표면이 배지 렌더; `RunSchema`/`EventSchema` `.nullish()` 파싱(서버 `null` fixture).
- **라이브(필수, S-D 갭 차단)**: 실제 controller+worker로 criteria run 1회 → 목록 PASS/FAIL 배지 + `/report` verdict와 일치(불변식) + 콘솔 Zod 0 확인. RTL fixture는 *absent*를 줘서 `.optional()`↔서버-`null` 미스매치를 못 잡으므로 라이브 1회 필수.

## 8. 마이그레이션·게이트 노트

- **migration 0012** = Rust-guarded ALTER(`ensure_runs_verdict_json`), `connect()` 배선. `.sql` const 추가 아님 → `grep -c MIGRATION_SQL` 교차검증 무관(0008/0009와 동류). 0011(schedules)이 마지막 `.sql`.
- **`RunResponse`에 필드 추가 = `to_response` 1곳 + RunRow 리터럴(`insert`)** — 컴파일러가 잡음. RunRow에 필드 추가 시 SELECT 3사이트(`get`/`list_by_scenario`) 컬럼 목록·매핑 동반(컴파일러는 SELECT 컬럼 누락을 못 잡으니 수동 확인).
- UI 커밋 전 `pnpm lint && pnpm test && pnpm build`(`tsc -b`) — `.nullish()` 누출·exhaustive-deps.
- 비-`.md` 커밋은 pre-commit이 전체 workspace 빌드 → background 커밋, warm(`cargo build -p handicap-worker`) 후 커밋(cold-build flake 회피).

## 9. ADR

신규 ADR 불필요 — ADR-0028(run-level SLO verdict) 범위 내 additive 확장(verdict 영속화 + 표면). CLAUDE.md "알아둘 결정들" ADR-0028 줄 + roadmap §B6에 완료 한 줄 추가.
