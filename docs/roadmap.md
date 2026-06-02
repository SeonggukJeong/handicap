# Post-MVP1 로드맵 (data-driven 이후)

> **이 문서의 목적**: MVP1 슬라이스 1–6 + Slice 7(loop) + 7-1(loop breakdown) + Slice 8(data-driven 8a/8b/8c)이 모두 끝난 시점에서, **다음에 무엇을 할지 고를 때 가장 먼저 보는 단일 진입점**. 후보 슬라이스 + 각 슬라이스에서 의도적으로 연기한 자잘한 항목들을 한곳에 모은다.
>
> **언제 갱신**: 슬라이스를 하나 선택해 시작하면 그 슬라이스를 "진행 중"으로 표시하고, 끝나면 "완료"로 옮긴다. 새로 연기한 항목이 생기면 아래 §B에 출처 슬라이스와 함께 누적한다.
>
> **연관 문서**:
> - 후보의 원천 메뉴 = MVP1 spec **§4.5 "의도적으로 MVP 외 (다음 단계의 첫 후보)"** → `docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md:513`
> - 기술 부채/소소한 후속(슬라이스 무관, batch 정리 대상) = `docs/followups-after-mvp1.md` (이 문서와 역할 분리: 저긴 *tech debt*, 여긴 *feature 로드맵*)
> - 결정 기록 = `docs/adr/`
> - 슬라이스 작업 흐름 = brainstorming → `docs/superpowers/specs/<날짜>-<이름>-design.md` → `docs/superpowers/plans/<날짜>-<이름>.md` → subagent-driven 구현

---

## 현재 상태 (2026-06-01)

- **완료**: 슬라이스 1–6 (MVP1 전부) + Slice 7 (loop 노드) + Slice 7-1 (loop_index별 요청수 breakdown) + Slice 8a/8b/8c (data-driven 전체) + **Slice 9a/9b/9c/9d (Conditional `type: if` 노드 전체 — 분기별 메트릭 breakdown 포함)** + **영역 A (Run 프리셋 + Retry, ADR-0024)** + **영역 B (환경/Environments, ADR-0025)**. 열린 9 이전 슬라이스 작업 없음.
- **완료**: **A3 (멀티 워커 fan-out)** — **A3a(조정 인프라) + A3b(메트릭 머지) + A3c(K8s Indexed Job + dispatcher cleanup 배선 + Helm) 전부 구현+머지 완료(2026-06-02, subagent-driven) → 영역 A3 완결**. 계획된 fan-out(반응형 HPA 아님), A3a(조정)→A3b(메트릭 머지)→A3c(K8s Indexed Job) 3분할. spec `docs/superpowers/specs/2026-06-01-multi-worker-fanout-design.md`, ADR-0027. 상세 §A3. 연기(§B2''): per-deploy 워커 resource Helm values, 반응형 HPA, best-effort/degraded, `unique` 바인딩.
- **완결**: **영역 C (시나리오 에디터 test-run, A6 후속·spec §7 실현)** — **C-1(백엔드) + C-2(UI) 둘 다 구현+머지 완료(2026-06-01, subagent-driven)**. C-1: 컨트롤러 in-process 엔진 trace(`trace_scenario`) + top-level `POST /api/test-runs`(ephemeral) + `render_collecting`/`execute_step_traced`/`select_branch` 추출 + `ApiError::Unprocessable`(422) + if/elif 조건 미바인딩 변수 결정 행 표시(follow-up 확장). **C-2(UI)**: ScenarioTrace Zod 스키마(엔진 `trace.rs`와 와이어 1:1) + `api.createTestRun`/`useTestRun`(ephemeral 무invalidation) + 프레젠테이셔널 `TestRunPanel`(http/if 행·분기 라벨·`#loop_index`·미바인딩 앰버·truncated 배너·펼침 req/resp) + `ScenarioEditPage` 배선(`<EnvironmentPicker>`/`resolveEnv` 재사용, live `yamlText` 버퍼 전송 — 미저장에도 동작). spec §5-1 if 행 **조건 요약**은 `summarizeCondition`을 `CanvasView`→`scenario/model.ts`로 추출 공유하고 `ScenarioEditPage`가 `parseScenarioDoc(yamlText)`로 `steps`를 주입해 렌더(ScenarioTrace엔 조건 텍스트 없음). 5커밋(4 plan task + 조건요약 follow-up), task별 2단계 리뷰 + 최종 handicap-reviewer READY-TO-MERGE(와이어 1:1 검증), UI 294 pass + `tsc -b` clean. **후속(연기)**: 응답기반 extract authoring(§8-1), 수동 변수 오버라이드(§8-2), 워커경로 runner(§8-3), 민감값 마스킹, test-run 히스토리. spec: `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md`, plan: `docs/superpowers/plans/2026-06-01-scenario-editor-test-run-c2-ui.md`.

---

## A. 후보 슬라이스 (spec §4.5 메뉴)

우선순위가 아니라 후보 목록이다. spec §4.5의 한 줄을 각 후보에 그대로 매핑하고, 이 코드베이스 기준의 착수 메모를 덧붙인다.

### A1. Conditional 노드 — **완료 (9a+9b+9c+9d 전부 머지)**
- **spec 근거**: §4.5 "HTTP 외 다른 노드 종류 (loop, **conditional**, parallel, …)".
- **성격**: control-flow 노드. Slice 7 loop가 깐 인프라(재귀 `Step` 트리, internally-tagged enum `#[serde(tag="type")]`, `execute_steps(steps, ctx)` 재귀 인터프리터, React Flow 컨테이너 노드)를 그대로 재사용하는 가장 자연스러운 다음 수.
- **참고**: ADR-0020 (control-flow 노드: loop 패턴). spec §2 모델 노트 "후속 단계의 `loop`/`conditional` 노드는 모델에 `type` 추가, 내부 `do: [...]` 중첩 — 캔버스에서는 컨테이너 노드로 시각화" (`...mvp1-design.md:287`).
- **결정·진행**: spec `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md`, ADR-0023. 4분할 전부 완료 — **9a(엔진: 평탄 if/elif/else + 재귀 조건 트리 + lenient 평가)**, **9b(UI authoring: Zod `ConditionModel`/`IfStepModel` + 캔버스 if 컨테이너 + 재귀 조건 빌더 inspector)**, **9c(상호 1레벨 중첩 if↔loop: two-tier Zod 게이트 + 재귀 캔버스 에미터 + `findStepById` + 게이트 중첩 버튼)**, **9d(분기별 메트릭 breakdown: `run_if_metrics` + `ReportJson.if_breakdown` + `BranchStatsTable` — Slice 7-1 패턴 재사용, cap/sentinel 없음, counts-only, 최상위 배열)**.

### A2. Parallel 노드
- **spec 근거**: §4.5 "… loop, conditional, **parallel** …".
- **성격**: control-flow 노드(동시 분기). 단일 VU 안에서 여러 스텝을 병렬 실행.
- **착수 시 주의**: VU 실행 모델(ADR-0016, tokio task per VU)과의 상호작용 설계 필요 — VU당 추가 동시성이 메트릭 집계(per-step 윈도)와 cookie jar(ADR-0018, VU별 jar) 공유에 주는 영향.

### A3. 멀티 워커 fan-out (계획된 분산 실행) — **✅ 완료 (A3a+A3b+A3c 머지 완료 — 영역 A3 완결)**
- **spec 근거**: §4.5 "다중 워커 자동 스케일링 (워커는 1대 고정)". spec §1 "OUT — 명시적으로 후속" 3단계 항목(`...mvp1-design.md:127`).
- **성격**: 스케일아웃. §4.3 성능 목표(5,000 RPS)는 단일 워커로 이미 ~20,000 RPS 달성(Slice 6 baseline)이라, 이건 처리량보다 **분산 실행/조정** 슬라이스에 가깝다.
- **결정**: "자동 스케일" = **반응형 HPA 가 아니라 계획된 fan-out**(run 시작 시 N=ceil(총VU÷capacity) 고정, 워커 mid-run 합류/이탈 없음 — 부하 생성기는 "정해진 VU 안정 생성"이 목적). spec `docs/superpowers/specs/2026-06-01-multi-worker-fanout-design.md`, ADR-0027.
- **분할(spec §9)**: **A3a**(컨트롤러 per-run 멀티워커 상태머신 + proto RunAssignment shard 필드 + 엔진 글로벌 vu_id + subprocess N-spawn) ✅ **머지 완료(2026-06-02, subagent-driven 8 task; 코드리뷰가 잡은 완료-집계 race 1건 수정 — terminal 워커 entry 보존)** → **A3b**(메트릭 머지: run_metrics PK 에 worker_id, 워커별 행+읽기 시점 HDR merge, migration 0008) ✅ **머지 완료(2026-06-02, subagent-driven 6 task; 읽기 3 사이트 summary/windows_with_hdr/build_report 가 (ts,step)로 HDR merge+count SUM, loop/if 는 증분 누적이라 무변경)** → **A3c**(K8s Indexed Job parallelism=completions=N + dispatcher cleanup 배선 + Helm `worker.capacityVus`) ✅ **머지 완료(2026-06-02, subagent-driven 6 task; `build_job_spec` 가 worker_count→Indexed Job + worker-id 라벨/arg 제거(Pod 가 JOB_COMPLETION_INDEX 로 파생), `CoordinatorState` 가 `Arc<OnceLock<SharedDispatcher>>` 로 finalize 5 사이트서 cleanup 호출, Guaranteed QoS(req==limit 250m/256Mi) + soft topology/anti-affinity, e2e-kind N=2 단언(완료 시 Job 삭제라 run 진행 중 Job 형상 관측); per-deploy 워커 resource Helm values 는 §B2'' 연기)**. A3a+A3b 한 세트 출하(A3a 단독은 메트릭 keep-first 손실).
- **잠금 해제**: 8c에서 `unique` 바인딩 정책을 "멀티-워커 전역 커서 필요"로 거부했는데(아래 §B1), 이 인프라가 깔린 뒤 **후속** 하위 슬라이스에서 컨트롤러 중앙 커서로 푼다(spec §6.4 설계 스텁 — A3 본체는 unique 여전히 거부, fail-fast 만).
- **참고**: ADR-0019 (워커 dispatcher 추상화 — subprocess/K8s Job), ADR-0010 (gRPC pull/등록 모델). 컨트롤러의 run→워커 분배(VU split, 메트릭 머지)가 핵심.
- **반응형 HPA (연기)**: CPU/메트릭 기반 run 중 스케일은 부하 생성기엔 부자연(VU 수 흔들리면 측정 흔들림). 되살리려면 동적 멤버십·VU 재분배·부분 메트릭 머지 설계부터. → 별도 후보.

### A4. LoadRunner급 리포트 깊이
- **spec 근거**: §4.5 "LoadRunner급 리포트 깊이 (run 비교·SLA·트랜잭션 분해)". §3.3 "MVP 리포트 OUT" 의 트랜잭션 분해·워터폴·히스토그램·CSV/Excel export(`...mvp1-design.md:446`).
- **성격**: controller(리포트 빌드) + UI 중심. 엔진/워커 변경 적음(트랜잭션 시간 분해 DNS/TCP/TLS/TTFB는 엔진 계측 필요 — 그 하위 항목만 엔진 손댐).
- **참고**: ADR-0017 (MVP 리포트 스코프 — "run간 비교·SLA는 후속"을 명시). run 간 비교 = 다중 run 선택 UI + 델타 뷰, SLA = pass/fail 임계 정의 + 판정.
- **A4a (run-level SLO / pass-fail criteria) ✅ 완료 (2026-06-03, subagent-driven 8 task)**: 종료된 run 리포트에 run-level criteria(p50/p95/p99·error_rate·min_rps) pass/fail verdict. profile_json 스냅샷 저장(무마이그레이션) + completed-only on-demand `build_report` verdict(B2) + `validate_run_config` 검증 + RunDialog SLO 입력(%↔분수, 프리셋 포함) + 리포트 `VerdictPanel`. ADR-0028. spec `docs/superpowers/specs/2026-06-03-a4a-slo-pass-fail-criteria-design.md`, plan `docs/superpowers/plans/2026-06-03-a4a-slo-pass-fail-criteria.md`. A4b(run 비교)·A4c(요약)는 후속.

### A5. Run 설정 재사용 — Run 프리셋 + Retry (영역 A) — **✅ 완료 (A1 + A2 머지, ADR-0024)**
- **성격**: QoL/UX 슬라이스(§4.5 메뉴 밖, 사용자 요청 발). run 을 한 번 돌린 뒤 같은 설정을 매번 손으로 재입력하는 통증 해소.
- **spec**: `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md` (brainstorming 2026-05-30 + spec-plan-review 반영 2026-05-31).
- **요지**: 별도 `run_presets` 테이블(scenario-scoped, UNIQUE(scenario_id,name), migration 0005) + REST CRUD + RunDialog "프리셋 불러오기/저장" + 과거 run "다시 실행"(prefill) / "즉시 재실행". retry 는 `GET /api/runs/{id}` 가 이미 노출하는 profile+env 재사용 → 신규 저장 0. 시나리오 변경 시 경고 배지(run retry 한정; 프리셋은 라이브 추종).
- **두 하위 슬라이스로 분할**(spec §8): **A1 = Retry**(DB 변경 0, RunDialog prefill 이음새 구축 — 현재 RunDialog 는 prefill prop 이 없어 리팩터 필요), **A2 = 프리셋 CRUD**(검증 게이트 `validate_run_config` 추출 + 데이터셋 DELETE soft 가드 확장 포함).
- **다음 단계**: A1 부터 writing-plans 로 구현 계획 작성.

### A6. 글로벌 변수 = 환경(Environments) (영역 B) — **✅ 완료 (B-1 + B-2 머지)**
- **성격**: BASE_URL 등 자주 쓰는 변수를 전역 등록 → 아무 시나리오에서나 골라 주입. 영역 A 의 자매 기능(같은 "재입력 통증" 원천).
- **결정·진행**: spec `docs/superpowers/specs/2026-05-31-global-variables-environments-design.md`, ADR-0025. 2분할 모두 머지 — **B-1(환경 리소스 + 관리 UI: migration 0007 `environments` 테이블 + CRUD REST + `EnvironmentsPage` + 클라/hooks)**, **B-2(RunDialog 환경 오버레이: `resolveEnv` 순수 병합 + standalone `<EnvironmentPicker>` — env 미선택 = pre-B2 byte-identical, `POST /api/runs` 무변경)**.
- **후속(연기)**: 민감값 마스킹(roadmap B1), `{{var}}` 흐름변수 전역 등록, 시나리오 에디터 환경 선택 test-run(spec §7 — `resolveEnv`/`<EnvironmentPicker>` 재사용 이음새 준비됨).
- **해소된 설계 질문**: 스코프 = `${ENV}` 네임스페이스만(`{{var}}` 흐름변수는 범위 밖). 주입 시점 = 클라이언트 병합 스냅샷(`POST /api/runs` 무변경, 우선순위 환경 < per-run override). 환경 묶음 = named environments(top-level 독립 리소스, scenario_id/FK 없음, 무가드 DELETE).

### (메뉴에 있으나 당장 후보 아님)
- WebSocket 노드 (§4.5) — REST 부하 도구의 1차 스코프 밖.
- 인증·RBAC·사용자 계정 (§4.5) — 사내 단일 테넌트 가정에선 후순위.
- 라이브 대시보드 (§4.5) — **ADR-0009로 MVP 범위에서 영구 제외**(종료 후 리포트 + APM). 되살리려면 ADR 재검토부터.

---

## B. 슬라이스에서 의도적으로 연기한 자잘한 항목

각 항목은 출처 슬라이스 기준으로 "왜 연기했나 + 어느 슬라이스에서 자연히 풀리나"를 적는다. 어느 슬라이스를 하든 그 슬라이스 plan 작성 시 이 목록을 훑어 관련 항목을 흡수한다.

### B1. Slice 8c (data-driven) 연기 항목
- ~~**`unique` 바인딩 정책**~~ — **✅ 완료 (2026-06-02)**: 정적 disjoint 슬라이스(`shard_split`) + stop-VU on exhaust 방식. ADR-0022 갱신. 연기: `on_exhaust: fail` opt-in 토글.
- **민감값 마스킹**: 데이터셋 값이 로그/리포트/UI에 노출되지 않게(비밀번호 컬럼 등). 8c는 값 비로깅까지만. → 보안 강화 슬라이스 또는 A4(리포트) 곁다리.
- ~~**JSON 숫자 주입**~~ — **✅ 완료 (2026-06-03, ADR-0029)**: flow `{{var:num}}`/`{{var:bool}}`(+`:str`) 캐스트 토큰으로 JSON body 문자열 leaf를 number/bool로 coerce(순수 단일 토큰 leaf만, leaf 레벨 파싱이라 `template.rs` 무변경, 엄격 실패=`CastFailed`, UI Zod 검증). 연기: `:json`/변수 기반 null·`${env}` 토큰 캐스트·form/raw/URL 캐스트.
- **Helm `datasetMaxRows` 노출**: 8c가 추가한 `--dataset-max-rows` CLI 플래그를 Helm values로. → **A3** 또는 deploy 정리 시.
- **바인딩 throughput 실측 벤치**: `just bench-throughput` 하네스가 `data_binding` profile을 못 구동(8c 이전 작성). 8c는 해석적 no-op 논증만. → 벤치 하네스 개선 + binding 시나리오 추가.

### B2. Slice 8b (데이터셋 리소스) 연기 항목
- **UploadPanel 미리보기 요청 시퀀싱 없음**: 빠르게 옵션 바꾸면 미리보기 응답이 경합할 수 있음(최신 요청만 반영하는 abort/seq 없음). → UI 폴리시 슬라이스.

### B2'. Run 프리셋(영역 A) 연기 항목
- **시나리오 복제**: run retry 가 변경된 시나리오에서 검증 실패하는 상황을 줄이는 보강책으로 brainstorming(2026-05-30)에서 제기됨. 그러나 이건 **시나리오 관리** 기능(scenarios CRUD/UI)이지 run 재사용이 아니라 영역 A 범위 밖 → **별도 spec**. 독립적으로 가치(실험용 시나리오 포크). → 시나리오 관리 슬라이스 또는 단독 spec.

### B2''. A3 (멀티 워커 fan-out) 연기 항목
출처 brainstorming/spec-review(2026-06-01). spec `2026-06-01-multi-worker-fanout-design.md` §11.
- **반응형 HPA**: 위 §A3 "반응형 HPA (연기)" 참조. run 중 동적 스케일.
- **best-effort / degraded 모드 + per-run 토글**: 워커 일부 실패해도 run 지속(나머지 완주 → "부분 완료" 표기). A3 는 **fail-fast** 만(샤드 누락 = 요청 부하 미생성 = 명시적 실패가 안전). 토글(`on_worker_failure: fail|continue`)은 profile 필드 한 줄이지만, "continue" 경로의 기계장치(degraded 상태 enum·per-shard 커버리지 추적·리포트/UI 배지)가 살집이라 별도. profile 이음새만 비워둠. → 보안/리포트 곁다리 또는 단독.
- **운영 상한 관리자 화면**: `--worker-capacity-vus`·`loop_breakdown_cap`·`--dataset-max-rows` 등 op-config 상한을 모아 설정하는 관리자 UI. 현재는 CLI 플래그/Helm values 산재. → QoL 슬라이스.
- **per-deploy 워커 cpu/mem Helm values (full-plumbing)**: A3c 는 충실도 최소안으로 `WorkerResources::default()`(Guaranteed QoS, modest 250m/256Mi)를 코드 기본값으로 박고 `worker.capacityVus`(N 레버)만 Helm value 로 노출했다. 워커 req/limit 자체를 deploy 마다 Helm values 로 올리는 배선(values + controller 플래그 + dispatcher→`build_job_spec` 주입)은 연기 — `WorkerResources` 구조체·이음새가 이미 있어 순수 가산(throwaway 0). 프로덕션 고처리량 도입 시. → "운영 상한 관리자 화면"과 묶을 수도.
- ~~**`unique` 바인딩(중앙 커서)**~~ — **✅ 완료 (2026-06-02)**: 전역 커서 대신 정적 disjoint 슬라이스(`shard_split`) + stop-VU on exhaust 방식으로 구현. spec `docs/superpowers/specs/2026-06-02-unique-binding-design.md`, plan `docs/superpowers/plans/2026-06-02-unique-binding.md`, ADR-0022 갱신. 연기(이 슬라이스 내): `on_exhaust: fail` opt-in 토글.
- **컨트롤러 재시작 부분 복구**: 멀티워커 run 도 재시작 시 통째 `failed`(현 동작·fail-fast 정합). 부분 진행 복구는 안 함. → 필요 시 per-shard 상태 영속화 슬라이스.

### B4. Header/Form 벌크 입력 연기 항목
출처: 스펙 `2026-06-01-header-form-bulk-entry-design.md` §7 + 사용자 결정(2026-06-01).
- **disabled 행 토글**: Postman처럼 KV(헤더/폼) 행을 지우지 않고 체크박스로 잠시 끄기. 행마다 `enabled: bool`이 필요해 `Record<string,string>` 모델 확장이 선행(YAML·엔진 `BTreeMap` 와이어도 같이). 사용자가 "해볼 만하다"고 판단 → KeyValueGrid 후속 UI 슬라이스(모델 확장 포함, 별도 spec).
- ~~**JSON body "Format/Prettify" 버튼**~~ — **✅ 완료 (2026-06-01)**: `JsonBodyField`(`Inspector.tsx`)에 Format 버튼 추가 — `JSON.parse → stringify(.,2) → setText` + 파싱값 persist(onBlur commit과 `store` 헬퍼 공유). 외부 prettier 의존 없음. RTL 3 tests.
- **(de-scoped) 멀티값 헤더(같은 key 반복)**: 사용자 판단 "헤더 중복 입력 필요성 낮음" → 후보 제외. 필요해지면 모델 확장(별도 spec).
- **raw body 에디터**: 변경 이유 없음 — 임의 텍스트라 textarea가 적합. 건드리지 않음.

### B5. codex 평가 후속 (2026-06-03)
출처: codex load-tester 평가 + Claude 검증 `docs/reviews/2026-06-02-load-tester-evaluation-assessment.md`. **항목 1–4 구현+머지 완료**(master `5e59048` lint 게이트 / `fffec3e` dispatch fail-fast P0 / `fee8041` shutdown 로그). 잔여 2건:
- **open-loop / arrival-rate 부하 모델 + per-step·per-scenario timeout (P2)**: 현 엔진은 closed-loop 전용(VU가 시나리오 허용 한도까지 루프) + HTTP timeout 30s 하드코딩(`engine/src/executor.rs`). target RPS·think time·`http_timeout_seconds`·max in-flight cap을 profile 필드로 추가, closed-loop는 기본 유지. **별도 spec/plan 필요**(§A 후보급, "정밀 성능 테스트" 영역) — `executor.rs`/`runner.rs` + proto `Profile` + RunDialog까지 걸친다.
- **skip/todo UI 테스트 분류·정리**: `pnpm test`에 todo 21 + skip 7. 의도적 연기 / flaky / obsolete / harness-blocked로 분류 후 고위험(시나리오 에디터·리포트) 우선 구현. → UI 폴리시 곁다리.

### B6. A4a (run-level SLO criteria) 연기 항목
- **run 목록 pass/fail 배지** (fast-follow): 목록엔 메트릭이 없어 영속화(`verdict_json` 컬럼 + 완료 시 평가, migration) 또는 목록용 경량 요약 캐시 필요. v1은 리포트 페이지만.
- **step-level criteria**: 특정 스텝 p95 등 — step_id 셀렉터 + loop/if 중첩 step_id 매칭.
- **status-class criteria** (생 5xx_count 등): `status_distribution` 기반. error_rate가 status assertion 없는 raw 4xx/5xx를 못 잡는 한계를 푼다.
- **per-window 최소 RPS**: 지속 RPS 바닥 (v1 min_rps는 평균 rps 기준).
- **일반 연산자 모델** (`{metric, op, threshold}` 자유 조합): 출력 shape는 이미 일반형이라 입력만 마이그레이션. (A4b run 비교·A4c 요약은 A4 영역의 별도 슬라이스.)

### B3. 슬라이스 무관 tech-debt
- → **`docs/followups-after-mvp1.md` "열린 항목"** 으로 관리(현재 열린 항목 A = subprocess 워커 비정상 종료 시 run이 `running`에 멈추는 status-transition 갭). 이 로드맵 문서와 중복 적지 않는다.

---

## 사용법 (다음 세션이 봐야 할 곳)

1. **"다음 뭐 하지?"** → 이 문서 §현재 상태 + §A.
2. 슬라이스 정하면 → `superpowers:brainstorming` 으로 시작 → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
3. plan 작성 중 → 이 문서 §B에서 그 슬라이스가 흡수할 연기 항목을 체크(특히 control-flow면 Slice 7 ADR-0020/0021 패턴 재사용).
4. 슬라이스 끝나면 → 이 문서 §A에서 "완료"로, 새 연기 항목은 §B에 추가, 새 ADR 번호 + CLAUDE.md 인덱스 갱신.
