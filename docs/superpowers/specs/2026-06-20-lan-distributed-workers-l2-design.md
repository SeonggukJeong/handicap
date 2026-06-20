# LAN 분산 워커 L2 — 워커 대시보드 + RunDialog 풀 프리뷰 (읽기전용 가시성, ADR-0041 후속)

> **이 파일의 척추는 §2 요구사항 표(R-id)다.** plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-20
- **상태**: 설계 승인(사용자 2026-06-20 — 텍스트 설계 OK, 실화면은 라이브 검증서 확인) → plan 대기
- **출처**: roadmap §LAN 분산 / ADR-0041 §귀결 "L2 후보: 풀 상태 UI". **왜 지금**: L1이 백엔드 풀 제어판(상시 워커·use-all push·공유 토큰)을 깔았으나 curl/CLI로만 관측 가능 — 사내 QA가 "어느 PC가 붙었나/이 run이 워커를 쓰나"를 보려면 UI 가시성이 필요. L1의 가치를 비-CLI 사용자에게 연다.
- **연관**: ADR-0041(L1 — 풀 레지스트리·push 배정·토큰), ADR-0040(데스크톱 셸 — `ControllerBackend` 추상), ADR-0010(gRPC pull/등록), ADR-0027(fan-out), ADR-0035(ko.ts 한국어 카탈로그). spec/plan `2026-06-20-lan-distributed-workers-l1*`. 런북 `docs/dev/lan-workers.md`.
- **ADR**: 신규 불필요(ADR-0041 범위 내 additive — L2는 이미 결정된 "풀 상태 UI" 방향의 실현). 완료 시 ADR-0041 §귀결·roadmap 갱신.

---

## 1. 문제와 목표

L1은 워커 풀을 인메모리(`CoordinatorState.pool`)로 들고 run 발사 시 use-all push 배정한다. 하지만 **풀 상태를 보는 경로가 REST/UI에 전혀 없다** — 연결된 워커 목록·유휴/Busy·어느 PC인지(현재 worker_id는 랜덤 ULID)를 curl로도 못 본다. 운영자는 "내 office-pc-3 워커가 붙었나", run 발사 전 "지금 몇 대 쓸 수 있나"를 알 수 없다.

- **목표**: ① 읽기전용 풀 워커 대시보드(`/workers`) — 연결 워커를 hostname·유휴/Busy·capacity로 표시(폴링 새로고침). ② run 발사 전 RunDialog에 "연결된 유휴 워커 M대" 프리뷰. ③ 워커 식별성을 위해 hostname을 와이어로 전파.
- **비목표(연기)**: §7 참조. 제어 액션(disconnect/exclude/cap)·과부하 가드·mTLS·영속 worker_id·하트비트/last-seen·다중 동시 run·정확한 N 추정 프리뷰.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만. **흘리기 쉬운 불변식/byte-identical/fallback/seam을 특히 R로.**

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` `CoordinatorState`에 읽기 접근자 `pool_snapshot() -> Vec<PoolWorkerInfo>` 추가 — 풀 락 안에서 연결 워커별 `{worker_id, hostname, capacity_vus, assigned_run}`을 **복사**해 반환(`tx`는 절대 노출 안 함, 락을 `.await` 너머로 들지 않음, **정렬 hostname→worker_id 결정적**). `pool_idle_count` 옆. | 단위 `pool_snapshot_lists_idle_and_busy`(유휴+busy 혼합·busy의 run_id 정확·정렬 결정적) | |
| R2 | `MUST` 신규 `GET /api/pool/workers` → `{ pool_mode: bool, workers: [PoolWorkerSummary{worker_id, hostname, capacity_vus, busy, run_id: Option<String>}] }`. 핸들러는 `state.coord.is_pool_mode()` + `pool_snapshot()`만 읽음(`state.db` 미사용). **풀 모드 아니면 `{pool_mode:false, workers:[]}` 200**(404 아님 — UI가 안내 빈-상태 렌더). | 통합 `pool_workers_endpoint_lists`(`pool_register_idle` 등록 후 목록·`reserve_idle_pool` 직접 호출로 busy 마킹 후 `busy:true`/run_id 반영) / `pool_workers_endpoint_off_returns_empty`(비-풀 200·빈) | ✅ REST wire (UI Zod ↔ axum Json) |
| R3 | `MUST` proto `Register`에 `string hostname = 5` **가산**(additive — field 1~4 무변경). 워커가 채워 보내고 컨트롤러가 읽는다. 빈 hostname = 기존과 동치(byte-identical 보존). | proto 빌드 + `cargo build --workspace`; 빈 hostname = wire 무변화 | ✅ proto wire (worker↔controller) |
| R4 | `MUST` 워커가 **시작 시 1회**(`run`/`run_pool`에서) 자기 머신 hostname을 구해(신규 dep `gethostname`, **버전은 MSRV 1.85 빌드로 확정** §4.2·실패/비-UTF8이면 빈 문자열 폴백) `connect_with_backoff`→`connect_and_register`로 스레드해 `Register.hostname`에 실음(풀·legacy 양 경로). **토큰은 절대 로그에 안 남김**(S1/S2 회귀 가드 — hostname 로깅은 무방). | 단위/관찰: Register가 hostname 운반 / 라이브: 대시보드에 실 머신명 표시 | |
| R5 | `MUST` `PoolEntry`에 `hostname: String` 추가, `pool_register_idle(worker_id, tx, capacity_vus, hostname)` 시그니처에 hostname 1개 추가, register 핸들러(coordinator.rs:847)가 `reg.hostname` 전달. capacity_vus는 이미 저장됨. | 단위 `pool_register_stores_hostname` | |
| R6 | `MUST` 신규 `/workers` 대시보드 페이지(네비 '워커' 추가) — `usePoolWorkers()`(React Query, `refetchInterval` **함수형: `pool_mode`일 때만 ~3s, 아니면 `false`**[M2 — 비-풀 배포 무용 폴링 방지]) + `listPoolWorkers()`(신규 `ui/src/api/pool.ts` — **raw `fetch` + 인라인 Zod 스키마**, environments.ts 컨벤션)로 목록. 표: **hostname(주)** · worker_id(보조/툴팁) · 상태(유휴/실행 중 + run_id→`/runs/{id}` 링크) · capacity_vus(선언값 '미적용' 주석). 상단 유휴/Busy 카운트. | RTL `WorkerDashboardPage.test`(유휴/busy 행·카운트·run 링크) / 라이브: 2워커·hostname | ✅ REST wire (Zod ↔ R2) |
| R7 | `MUST` 빈-상태 2종: `pool_mode:false` → "컨트롤러가 풀 모드가 아닙니다" + 런북 안내; `pool_mode:true` & 워커 0 → "연결된 워커 없음" + 워커 기동 안내. 로딩(`role="status"`)/에러(`role="alert"`) 상태는 기존 페이지 컨벤션(EnvironmentsPage) 따름. | RTL 두 빈-상태 + 에러 상태(fetch 실패→`role="alert"`) 렌더 단언 | |
| R8 | `MUST` RunDialog는 **`pool_mode:true`일 때만** 같은 `usePoolWorkers`로 읽기전용 프리뷰 배너 표시: "연결된 유휴 워커 M대 — 이 run은 유휴 워커에 분산 실행됩니다(use-all)." **정확한 N(=min(유휴,부하상한))·과부하 경고는 미표시**(N은 컨트롤러가 발사 시 결정·과부하는 별도 후보). 비-풀 모드 RunDialog = **byte-identical**(배너 미표시, open-loop `worker_count` 입력 무변경). | RTL: pool-mode 배너 표시 / 비-풀 배너 부재 + open-loop worker_count 회귀 0 | |
| R9 | `MUST`(불변식) **byte-identical (조건부)**: `pool_mode` off **AND** hostname 빈 = pre-slice 동작. proto는 additive(`Register.hostname` 기본 빈), **migration 0 / 엔진 0**. 신규 REST 라우트는 read-only·풀-무관(off=빈 응답), UI 프리뷰는 `pool_mode` 게이트. | 기존 controller(통합·e2e)/worker/engine/UI 스위트 green·비-풀 RunDialog 스냅샷 불변. **단 coordinator.rs 인라인 단위테스트 11 call site는 `pool_register_idle` hostname 인자 추가(동작 불변·기계적 churn)** | ✅ proto additive |
| R10 | `SHOULD` 신규 UI 문구는 전부 `ko.nav.workers` + `ko.workers` 네임스페이스 경유(ADR-0035 — 인라인 한국어/영어 0). | grep: 신규 컴포넌트가 `ko.*` 참조·인라인 리터럴 0 | |
| R11 | `MUST`(라이브니스 결정+문서) 대시보드 "연결됨" = gRPC 스트림 열림 — 스트림 종료 시 기존 `pool_disconnect`가 풀에서 제거(L1). **하트비트 없음**. half-open(네트워크 단절)은 전송 타임아웃 전까지 유령 워커로 남을 수 있음 → 런북(`docs/dev/lan-workers.md`)에 한계 명시. | 런북 노트 + 라이브: 워커 kill → 폴링 주기 내 /workers서 사라짐 | |
| R12 | `MUST`(보안) `GET /api/pool/workers` 응답은 worker_id·hostname·capacity·run_id만 — **token·env/시크릿·데이터셋 내용 일절 미포함**. 풀 스냅샷이 `tx`(채널 핸들)를 노출하지 않음(R1). | security-reviewer + DTO에 token 필드 부재 grep | |

- **`seam?`** — 와이어 변경 2곳: **R3**(proto `Register.hostname` additive, worker↔controller) + **R2/R6**(REST `GET /api/pool/workers`, axum Json↔UI Zod). plan은 proto·REST를 각각 계약-먼저 task로 배치, 최종 `handicap-reviewer`가 양쪽 1:1 대조. DB/migration 없음(R9).

---

## 3. 핵심 통찰 (설계 근거)

1. **풀은 인메모리 공유 상태이고, REST는 이미 그 상태에 닿는다.** `AppState`(app.rs:17-31, 6필드: `db`·`coord`·dispatcher·ui_dir·settings·scheduler_tz)의 `coord: CoordinatorState`는 gRPC 서버가 쓰는 바로 그 `coord_state.clone()`(main.rs:248·269)이고 — `CoordinatorState`는 `#[derive(Clone)]`(140)·내부 `pool: Arc<Mutex<…>>`(156)라 clone이 같은 풀을 가리킨다 — `api/runs.rs`가 이미 `state.coord.reserve_idle_pool(…)`·`is_pool_mode()`를 호출한다(runs.rs:623,645). 따라서 대시보드 엔드포인트는 **새 상태 배선 0**: 읽기 접근자 `pool_snapshot()` 하나만 추가하고 핸들러가 `state.coord`로 읽는다. [R1·R2]

2. **스냅샷은 표시 필드만 복사한다 — `tx`는 절대 안 나간다.** `PoolEntry`(coordinator.rs:81-93)는 `tx: WorkerTx`(채널 핸들)를 들고 있으나, `PoolWorkerInfo`는 평범한 데이터 구조(String/u32/Option<String>)다. `pool_snapshot`은 풀 락을 잡고 문자열을 clone해 `Vec`로 빼낸 뒤 락을 즉시 놓는다(`.await` 너머로 락 유지 금지). `tx` 누출은 보안/생명주기 위험이라 R12가 명문 가드. [R1·R12]

3. **`pool_mode`를 응답에 실어 UI 분기를 단일화.** UI는 컨트롤러가 풀 모드인지 미리 모른다(subprocess/k8s 배포도 존재). 엔드포인트가 `pool_mode`를 함께 주면 대시보드(빈-상태 안내)와 RunDialog(프리뷰 표시 여부)가 **한 엔드포인트·한 훅**으로 분기한다. 비-풀 배포는 빈 대시보드+설명을 보고, RunDialog는 불변(R8/R9). 404 대신 `{pool_mode:false, workers:[]}` 200을 주는 이유 = "풀 모드 아님"은 에러가 아니라 정상 상태이고, UI가 그걸 구분해 안내 문구를 띄워야 하므로. [R2·R7·R8·R9]

4. **라이브니스 = 스트림 존재(하트비트 없음).** 워커 "연결됨"의 진실은 열린 gRPC 스트림이다 — L1의 `pool_disconnect`(coordinator.rs:325)가 스트림 종료 시 엔트리를 제거하므로 대시보드는 자연히 라이브 워커만 보여준다. 별도 하트비트/last-seen은 L2 가치 대비 복잡(워커 핑 루프 + 컨트롤러 staleness 판정)이라 연기. **정직한 한계**: half-open TCP(워커 PC 절전·네트워크 단절)는 전송 타임아웃 전까지 유령으로 남을 수 있음 → 런북에 명시(silent 아님, R11). [R11]

5. **RunDialog 프리뷰는 유휴 수 M만 신뢰성 있게 보인다 — 정확한 N을 UI가 계산하지 않는다.** 컨트롤러는 발사 시 N=min(유휴, 부하상한)을 정한다(부하상한 = closed:vus / open:min(max_in_flight,target_rps|peak) / curve:1, L1 §3.4). 이 공식을 UI에 복제하면 ① 백엔드와 드리프트 ② "과부하"(vus/N>capacity) 같은 별도 후보 영역으로 번진다. v1은 **"유휴 M대 — use-all로 분산"** 안내만(정확한 N은 발사 후 리포트/대시보드에서 관측). [R8]

6. **hostname은 비밀이 아니지만 token은 비밀이다.** hostname을 register 와이어·로그에 싣는 건 무방하나, L1 보안fix(S1/S2)가 막은 "토큰을 로그에 남기지 않기"는 새 코드에서도 유지해야 한다 — `connect_and_register`의 register 로그(client.rs:109)에 token을 추가하지 말 것. 엔드포인트 DTO도 token을 절대 포함하지 않는다. [R4·R12]

7. **per-resource 클라 파일 컨벤션을 따른다.** `ui/src/api/`는 리소스별 클라 파일(`environments.ts`·`presets.ts`·`schedules.ts`…)을 두므로 L2는 `pool.ts`를 추가한다(EnvironmentsPage/`environments.ts` 미러). 페이지는 `EnvironmentsPage` 구조(훅→로딩/에러/빈→표)를 따라 일관 UX. [R6]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/proto/proto/coordinator.proto` — 충족 R: R3, R9
- `Register`에 `string hostname = 5;` 추가(additive — field 1~4 무변경, 기존 워커는 빈 문자열 송신과 동치).

### 4.2 `crates/worker-core/src/{client.rs,reconnect.rs}` + `crates/worker/src/lib.rs` + `crates/worker/Cargo.toml` — 충족 R: R3, R4
- `connect_and_register(controller_url, worker_id, run_id, capacity_vus, token, hostname, cancel)`에 `hostname: &str` 인자 추가(client.rs:80) → `Register{…, hostname: hostname.to_string()}`(client.rs:100). register 로그(client.rs:109)는 **token 미포함 유지**(hostname 추가는 무방).
- **스레딩 사슬(정확히 3계층)**: `run`(lib.rs:474)·`run_pool`(lib.rs:512)이 `resolve_hostname()` 값을 `connect_with_backoff`(reconnect.rs:35)로 넘기고, 그게 `connect_and_register`(reconnect.rs:47)로 전달. `execute_assignment`(lib.rs:96)는 이미 연결된 link만 받아 register를 호출하지 않으므로 **hostname 인자 불필요**(추가 금지).
- 워커 시작 시 1회 `resolve_hostname()`: `gethostname`로 머신명 취득, 실패/비-UTF8이면 빈 문자열. **dep는 `crates/worker/Cargo.toml`에 추가**(hostname은 워커 lib에서 해석 — worker-core 아님), `[workspace.dependencies]`에 **`gethostname = "0.5"`**(0.5.0 resolve + 워커 빌드 green 실측 확인 2026-06-20). API `gethostname::gethostname() -> OsString` → `.to_str().map(str::to_owned).unwrap_or_default()`(비-UTF8/실패=빈). worker_id ULID 옆에서 한 번 계산해 전 재연결에 재사용.

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R1, R5
- `PoolEntry`(81-93)에 `hostname: String` 추가.
- `pool_register_idle(worker_id, tx, capacity_vus, hostname)`(300)에 hostname 인자 추가 → 엔트리에 저장. register 핸들러(847)가 `reg.hostname` 전달. **주의: 이 시그니처 변경은 coordinator.rs 인라인 단위테스트 11 call site에 4번째 인자(`String::new()`) 추가를 요함**(+ 프로덕션 핸들러 847은 `reg.hostname.clone()`; 기계적 churn·동작 불변, R9).
- 신규 데이터 구조 `pub struct PoolWorkerInfo { worker_id, hostname, capacity_vus, assigned_run: Option<String> }`(tx 없음).
- 신규 `pub async fn pool_snapshot(&self) -> Vec<PoolWorkerInfo>`(313 `pool_idle_count` 옆): 풀 락 잡고 각 엔트리를 `PoolWorkerInfo`로 복사·`Vec` 반환·락 해제(락을 await 너머로 안 듦). 정렬은 hostname→worker_id(결정적 표시).

### 4.4 `crates/controller/src/api/pool.rs`(신규) + `crates/controller/src/app.rs` — 충족 R: R2, R12
- 신규 `api/pool.rs`: `list_workers(State(state)) -> Json<PoolWorkersResponse>` — `pool_mode = state.coord.is_pool_mode()`; `workers = state.coord.pool_snapshot().await.into_iter().map(|i| PoolWorkerSummary{ worker_id:i.worker_id, hostname:i.hostname, capacity_vus:i.capacity_vus, busy:i.assigned_run.is_some(), run_id:i.assigned_run })`. `state.db` 미사용. DTO에 **token/env/dataset 일절 없음**(R12).
- `app.rs` 라우터에 `.route("/pool/workers", get(pool_api::list_workers))` 추가(environments 라우트 패턴, `/api` nest 하위). `mod pool;`·`use` 추가.

### 4.5 `ui/src/api/{pool.ts,hooks.ts}` + `ui/src/pages/WorkerDashboardPage.tsx` + `ui/src/routes.tsx` + `ui/src/components/Layout.tsx` — 충족 R: R6, R7, R10
- `pool.ts`(신규, **environments.ts 컨벤션 = raw `fetch` + 인라인 Zod + 자체 에러 헬퍼**; `schemas.ts`·`client.ts request<T>` 미사용 — `request<T>`는 비-export private): 인라인 `PoolWorkerSummarySchema`(worker_id/hostname: string·capacity_vus: number·busy: boolean·`run_id: z.string().nullable()`) + `PoolWorkersResponseSchema{ pool_mode: boolean, workers: array }` + `export async function listPoolWorkers()` = `await fetch(`${BASE}/pool/workers`)` → 비-ok 에러·`.parse`. **서버 `null`↔`.nullable()` 주의**(run_id는 absent 아님·null — `ui/CLAUDE.md` `.nullish()` 함정).
- `hooks.ts`: `queryKeys.poolWorkers()` + `usePoolWorkers()` = `useQuery({ queryKey, queryFn: listPoolWorkers, refetchInterval: (q) => (q.state.data?.pool_mode ? 3000 : false) })`(함수형 precedent hooks.ts:147 — 비-풀 응답 후 폴링 정지, M2).
- `WorkerDashboardPage.tsx`: EnvironmentsPage 구조(로딩 `role="status"`/에러 `role="alert"`/빈 R7 2종/표 R6 컬럼). busy 행 run_id → `<Link to={`/runs/${id}`}>`. 상단 유휴/Busy 카운트.
- `routes.tsx`: `{ path: "workers", element: <WorkerDashboardPage /> }`(18-32 children). `Layout.tsx`: 네비에 `<Link to="/workers">{ko.nav.workers}</Link>` 추가(12-32).

### 4.6 `ui/src/components/RunDialog.tsx` — 충족 R: R8, R9
- `usePoolWorkers()` 읽어 `data.pool_mode`면 유휴 수(`workers.filter(w=>!w.busy).length`) 기반 읽기전용 배너를 LoadModelFields 근처에 표시. `pool_mode` false면 **아무것도 렌더 안 함**(byte-identical). worker_count 입력·buildLoadProfile 무변경.

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R10
- `ko.nav.workers`(151 nav 블록) + 신규 `ko.workers` 네임스페이스(대시보드 제목·컬럼 라벨·상태 유휴/실행 중·capacity 미적용 주석·빈-상태 2종·RunDialog 프리뷰 문구·런북 링크 텍스트).

### 4.8 `docs/dev/lan-workers.md`(기존 갱신) — 충족 R: R11
- "풀 상태 보기" 절 추가: `/workers` 대시보드 사용법 + 라이브니스 한계(스트림 기반·하트비트 없음·half-open 유령 워커 캐비엇)·RunDialog 프리뷰.

---

## 5. 무변경 / 불변식 (명시)

- **엔진(`crates/engine`)·migration·DB 스키마·리포트 빌드·CSV/XLSX/비교·메트릭 머지·shard_split·토큰 검사 로직 전부 무변경.** 풀 레지스트리는 인메모리 → **migration 0**.
- proto는 **additive만**(`Register.hostname = 5`); 기존 message/field 무변경.
- **byte-identical (조건부, R9)**: `pool_mode` off **AND** hostname 빈 = pre-slice 동작. 신규 REST 라우트는 read-only(off=빈 응답), UI 프리뷰는 `pool_mode` 게이트. 비-풀 RunDialog·기존 페이지·기존 라우트 무변경.
- `AppState` 구조체 리터럴 무변경(`coord` 이미 존재, R1은 `CoordinatorState` 메서드만 추가) — AppState 관련 테스트 churn 0.
- L1 풀 발사/예약/배정/disconnect 경로(`reserve_idle_pool`/`assign_pool_workers`/`pool_disconnect`) **로직 무변경**. `pool_register_idle`은 hostname 인자 1개·`PoolEntry`는 필드 1개만 추가(동작 불변) — 단 coordinator.rs **인라인 단위테스트 11 call site**는 인자 추가 churn(byte-identical은 *동작* 주장, *테스트 무수정* 아님; R9·F1).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `pool_snapshot_lists_idle_and_busy`(유휴+busy 혼합·busy run_id 정확) | |
| R2 | `pool_workers_endpoint_lists` / `pool_workers_endpoint_off_returns_empty`(통합, environments_api_test 패턴) | ✅ |
| R3 | proto 빌드 + worker↔controller round-trip; 빈 hostname byte-identical | |
| R4 | Register가 hostname 운반(관찰) / 라이브: 대시보드 실 머신명 | ✅ |
| R5 | `pool_register_stores_hostname` | |
| R6 | `WorkerDashboardPage.test`(유휴/busy 행·카운트·run 링크) / 라이브 2워커 | ✅ |
| R7 | RTL 빈-상태 2종(풀-off / 풀-on 0대) | |
| R8 | RTL RunDialog(pool-mode 배너 / 비-풀 배너 부재·worker_count 회귀 0) | ✅ |
| R9 | 기존 controller/worker/engine/UI 스위트 green(무수정)·비-풀 RunDialog 스냅샷 불변 | |
| R10 | grep: 신규 컴포넌트 `ko.*` 참조·인라인 리터럴 0(orchestrator 직접 재실행) | |
| R11 | 런북 노트 + 라이브 워커 kill→폴링 내 사라짐 | ✅ |
| R12 | security-reviewer + DTO token 필드 부재 grep | |

- **라이브 검증 필수**(`/live-verify`): UI run-인접 경로(RunDialog) + 신규 응답-파싱(`/api/pool/workers` Zod) 변경 → S-D 갭(RTL fixture는 absent-not-null이라 서버 `null` run_id를 놓침). **localhost 풀 스택**: 컨트롤러 `--worker-mode pool --grpc 127.0.0.1:8081 --worker-token X` + `worker --controller http://127.0.0.1:8081 --token X`(`--run-id` 없이) ×2 → ① `/workers`에 2워커·hostname·유휴 ② run 발사 후 1대 Busy+run 링크 ③ RunDialog 프리뷰 "유휴 M대" ④ 워커 1 kill→사라짐 ⑤ 비-풀 컨트롤러서 `/workers` 빈-상태 안내. **cold-build 워커 race(CLAUDE.md S-A) 주의** — `cargo build -p handicap-worker` 워밍.
- **실화면 사용자 리뷰**(사용자 요청): 라이브 스택을 Playwright로 띄워 `/workers` 대시보드 + RunDialog 프리뷰 실제 모습을 사용자에게 보이고 의견 수렴 → 반영.

---

## 7. 의도적 연기 (roadmap §LAN 분산 / ADR-0041 §귀결에 누적)

- **제어 액션**(disconnect/exclude/per-worker cap): 읽기전용 v1 확정(사용자 2026-06-20). 제어는 제어→제어 gRPC·상태머신 필요 → 별도 슬라이스.
- **과부하 가드**(closed `vus/N > capacity` 경고/인사이트): roadmap 독립 후보. L2 프리뷰는 유휴 수만(정확 N·과부하 미계산, R8).
- **정확한 N 추정 프리뷰**: 컨트롤러 cap 공식 UI 복제 = 드리프트 위험 → 연기(§3.5).
- **mTLS(L3)** + **constant-time 토큰** · **영속 worker_id**(재시작 간 안정, dirs dep) · **하트비트/last-seen**(half-open 유령 워커 해소, R11) · **다중 동시 run 멀티플렉싱** · **워커 자동 발견**.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → green fold 지점 명시. seam(R3 proto·R2 REST)을 계약-먼저.

1. **백엔드 hostname + 스냅샷 + 엔드포인트**(R1·R2·R3·R4·R5·R12): proto `hostname=5` → 워커 송신(`gethostname` dep) + 컨트롤러 `PoolEntry.hostname`/`pool_register_idle` 시그니처 + `pool_snapshot`/`PoolWorkerInfo` → `api/pool.rs`+라우트. 단위(`pool_snapshot_*`/`pool_register_stores_hostname`)+통합(`pool_workers_endpoint_*`)을 같은 green 커밋들로(헬퍼-only/RED-only 단독 커밋 불가 — fold). **번들 게이트 주의**: bundle 멀티콜 arm은 고수준 `run_dispatch`만 부르므로(hostname은 내부 해석·시그니처 불변) 리플은 없으나, worker lib가 재컴파일되니 `--features bundle` 빌드는 확인.
2. **UI 데이터 레이어 + 대시보드**(R6·R7·R10): schemas/pool.ts/hooks → WorkerDashboardPage + routes + nav + ko.workers. RTL(행·빈-상태 2종).
3. **RunDialog 프리뷰**(R8·R9): pool-mode 게이트 배너. RTL(배너/부재).
4. **런북 + ko 마무리**(R11): lan-workers.md 갱신.
5. **라이브 검증**(§6) + 실화면 사용자 리뷰 → 반영. **finish-slice**(ADR-0041 §귀결·roadmap·build-log·도메인 CLAUDE.md 갱신).
