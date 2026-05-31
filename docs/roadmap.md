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

## 현재 상태 (2026-05-31)

- **완료**: 슬라이스 1–6 (MVP1 전부) + Slice 7 (loop 노드) + Slice 7-1 (loop_index별 요청수 breakdown) + Slice 8a/8b/8c (data-driven 전체) + **Slice 9a/9b/9c/9d (Conditional `type: if` 노드 전체 — 분기별 메트릭 breakdown 포함)**. 열린 9 이전 슬라이스 작업 없음.
- **진행 중**: 없음. 다음 후보는 아래 §A 참고.

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

### A3. 멀티 워커 + 자동 스케일(HPA)
- **spec 근거**: §4.5 "다중 워커 자동 스케일링 (워커는 1대 고정)". spec §1 "OUT — 명시적으로 후속" 3단계 항목(`...mvp1-design.md:127`).
- **성격**: 스케일아웃. §4.3 성능 목표(5,000 RPS)는 단일 워커로 이미 ~20,000 RPS 달성(Slice 6 baseline)이라, 이건 처리량보다 **분산 실행/조정** 슬라이스에 가깝다.
- **잠금 해제**: 8c에서 `unique` 바인딩 정책을 "멀티-워커 전역 커서 필요"로 거부했는데(아래 §B1), 이 슬라이스에서 컨트롤러 중앙 커서로 풀 수 있다.
- **참고**: ADR-0019 (워커 dispatcher 추상화 — subprocess/K8s Job), ADR-0010 (gRPC pull/등록 모델). 컨트롤러의 run→워커 분배(VU split, 메트릭 머지)가 핵심.

### A4. LoadRunner급 리포트 깊이
- **spec 근거**: §4.5 "LoadRunner급 리포트 깊이 (run 비교·SLA·트랜잭션 분해)". §3.3 "MVP 리포트 OUT" 의 트랜잭션 분해·워터폴·히스토그램·CSV/Excel export(`...mvp1-design.md:446`).
- **성격**: controller(리포트 빌드) + UI 중심. 엔진/워커 변경 적음(트랜잭션 시간 분해 DNS/TCP/TLS/TTFB는 엔진 계측 필요 — 그 하위 항목만 엔진 손댐).
- **참고**: ADR-0017 (MVP 리포트 스코프 — "run간 비교·SLA는 후속"을 명시). run 간 비교 = 다중 run 선택 UI + 델타 뷰, SLA = pass/fail 임계 정의 + 판정.

### A5. Run 설정 재사용 — Run 프리셋 + Retry (영역 A) — **spec 작성+리뷰 완료, 구현 전**
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
- **`unique` 바인딩 정책**: 행을 VU/반복 간 중복 없이 전역 소진. 멀티-워커 전역 커서가 필요해 단일 워커 8c에선 API에서 거부. → **A3(멀티 워커·HPA)에서 자연히 풀림**.
- **민감값 마스킹**: 데이터셋 값이 로그/리포트/UI에 노출되지 않게(비밀번호 컬럼 등). 8c는 값 비로깅까지만. → 보안 강화 슬라이스 또는 A4(리포트) 곁다리.
- **JSON 숫자 주입**: `{"age": {{age}}}`에서 값을 string이 아닌 number로. 8a/8c는 문자열 leaf만 치환(`render_json_value`). → body 템플릿팅 후속(엔진 `executor.rs`).
- **Helm `datasetMaxRows` 노출**: 8c가 추가한 `--dataset-max-rows` CLI 플래그를 Helm values로. → **A3** 또는 deploy 정리 시.
- **바인딩 throughput 실측 벤치**: `just bench-throughput` 하네스가 `data_binding` profile을 못 구동(8c 이전 작성). 8c는 해석적 no-op 논증만. → 벤치 하네스 개선 + binding 시나리오 추가.

### B2. Slice 8b (데이터셋 리소스) 연기 항목
- **UploadPanel 미리보기 요청 시퀀싱 없음**: 빠르게 옵션 바꾸면 미리보기 응답이 경합할 수 있음(최신 요청만 반영하는 abort/seq 없음). → UI 폴리시 슬라이스.

### B2'. Run 프리셋(영역 A) 연기 항목
- **시나리오 복제**: run retry 가 변경된 시나리오에서 검증 실패하는 상황을 줄이는 보강책으로 brainstorming(2026-05-30)에서 제기됨. 그러나 이건 **시나리오 관리** 기능(scenarios CRUD/UI)이지 run 재사용이 아니라 영역 A 범위 밖 → **별도 spec**. 독립적으로 가치(실험용 시나리오 포크). → 시나리오 관리 슬라이스 또는 단독 spec.

### B3. 슬라이스 무관 tech-debt
- → **`docs/followups-after-mvp1.md` "열린 항목"** 으로 관리(현재 열린 항목 A = subprocess 워커 비정상 종료 시 run이 `running`에 멈추는 status-transition 갭). 이 로드맵 문서와 중복 적지 않는다.

---

## 사용법 (다음 세션이 봐야 할 곳)

1. **"다음 뭐 하지?"** → 이 문서 §현재 상태 + §A.
2. 슬라이스 정하면 → `superpowers:brainstorming` 으로 시작 → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
3. plan 작성 중 → 이 문서 §B에서 그 슬라이스가 흡수할 연기 항목을 체크(특히 control-flow면 Slice 7 ADR-0020/0021 패턴 재사용).
4. 슬라이스 끝나면 → 이 문서 §A에서 "완료"로, 새 연기 항목은 §B에 추가, 새 ADR 번호 + CLAUDE.md 인덱스 갱신.
