# LAN 워커 제어 액션 — 대시보드에서 풀 워커 drain·exclude·capacity·label (ADR-0041 후속, LAN 분산 워커 L7 범위)

- **날짜**: 2026-06-22
- **상태**: 설계 승인(사용자 2026-06-22) + spec-plan-reviewer clean APPROVE(round 2) → plan 대기
- **출처**: roadmap LAN L2/L3/L6 연기 항목("제어 액션 disconnect/exclude/cap") + 사용자 선택(2026-06-22 start-slice). **왜 지금**: L1–L6로 풀·대시보드·4-모드 과부하 가드·하트비트가 완결됐고, 남은 운영 격차는 *능동 제어* — 운영자가 점검 전 워커를 빼거나(drain), 오작동 워커를 즉시 내보내거나(exclude), 부하 배분을 손으로 조정(capacity)할 수 없다. 읽기전용 대시보드(L2)에 쓰기 동작을 더하는 자연스러운 다음 단계.
- **연관**: ADR-0041(LAN 분산 워커), `2026-06-20-lan-distributed-workers-l1/l2/l3-*`, `2026-06-21-…-l4/l5-*`, `2026-06-22-lan-worker-heartbeat-*`(L6 — `pool_disconnect` busy fail-fast·Ping/Pong 펌프·R14 락 규율·`last_seen` 재사용), `docs/dev/lan-workers.md`(운영 런북).
- **ADR**: 신규 불필요(기존 ADR-0041 범위 내 additive — 풀은 in-memory·push 권위 모델 그대로, 제어 상태도 in-memory). 새 와이어(proto `Disconnect`·REST 제어 엔드포인트)는 additive·byte-identical-off.

---

## 1. 문제와 목표

L2 대시보드는 풀 워커를 **읽기전용**으로만 보여준다 — 운영자가 워커를 손으로 제어할 방법이 없다. 점검하려면 그 PC의 워커 프로세스를 직접 `kill`해야 하고(그러면 L6 하트비트가 stale-evict하지만 그 사이 진행 중 run은 실패), 오작동 워커를 풀에서 빼거나 약한 PC의 부하 몫을 줄일 수단이 없다.

- **목표**: `/workers` 대시보드에서 워커별 **4종 제어** — (1) **drain/undrain**(새 run 배정 중단·진행 중 run은 완주, 되돌리기 가능), (2) **exclude**(즉시 풀에서 제거 + 워커 프로세스 깔끔 종료, busy면 run fail-fast), (3) **capacity override**(워커별 용량을 런타임에 수동 조정), (4) **label**(운영자 메모). 제어 상태는 in-memory(PoolEntry)이고 idempotent re-register에 보존된다. drain·override는 **L3–L5 과부하 가드와 RunDialog 프리뷰에 정확히 반영**돼 화면 숫자와 실제 배정이 항상 일치한다. 로그인이 없는 대신 **모든 제어 동작에 결과/위험 경고 문구**를 띄운다.
- **비목표(연기)**: §7 참조. DB 영속(컨트롤러 재시작 시 초기화)·인증/RBAC·일괄 동작(전체 drain)·자동 exclude·영속 worker_id.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `PoolEntry`에 제어 3필드 `drained: bool`(기본 false)·`capacity_override: Option<u32>`(기본 None)·`label: Option<String>`(기본 None)와 `effective_capacity_vus() = capacity_override.unwrap_or(capacity_vus)` 헬퍼를 추가한다(in-memory, 신규 테이블 0). | `cargo test` coordinator 단위(기본값·effective 헬퍼) | |
| R2 | `pool_register_idle`(현 blind-insert → **get-or-update**)는 기존 worker_id 엔트리의 제어 3필드를 **보존**하되 `tx`/`hostname`/`capacity_vus`/`last_seen`는 **갱신**하고 `assigned_run`은 기존대로 `None` 리셋한다(reconnect/post-run 재등록이 drain/override/label을 지우지 않음·stale tx 미잔존); 신규 엔트리는 기본값. **기본필드(미제어) 재등록은 옛 blind-insert와 동작 동일**(R14). | `cargo test`: 재등록 후 ① 제어3필드 유지 ② **tx 갱신**(stale tx 아님) ③ assigned_run None ④ 무제어 재등록=옛 동작 | |
| R3 | 용량 계산 3경로(`pool_achievable_capacity`·`reserve_idle_pool_capacity`·legacy `reserve_idle_pool`)는 **drained 워커를 idle 후보에서 제외**하고 남은 워커에 **`effective_capacity_vus()`**를 사용한다(`capacity_split` 입력 포함). 정상 경로와 `?force` 양쪽 모두 drained를 건너뛴다. | `cargo test`: drained 1대 제외 시 achievable 감소·override 반영·`?force`도 drained 미배정 | |
| R4 | **(불변식)** RunDialog 풀 프리뷰(유휴 N대·총 용량 N VU)는 `!drained && idle` 워커에 effective capacity를 합산 — **서버 409 가드(R3)와 동일 규칙** — 프리뷰 == 가드 산식이 by construction 일치한다. | UI 단위(프리뷰 산식) + 라이브: drain한 워커가 프리뷰·409 양쪽에서 동시에 빠짐 | |
| R5 | proto `ServerMessage`에 `Disconnect { string reason = 1; }`를 oneof **field 5**(Ping=3·DatasetBatch=4 다음)로 additive 추가; 미사용 시 와이어 byte-identical. | `cargo build`(prost codegen) + proto 필드번호 검토 | ✅ proto |
| R6 | `pool_exclude(worker_id, reason)`: 풀 락 안에서 엔트리 제거 + `(tx, assigned_run)` 캡처 → 락 **밖**에서(R14 규율) busy면 기존 `worker_disconnected` fail-fast 재사용(run `failed`), 캡처한 tx로 `Disconnect`를 **`try_send`**(non-blocking best-effort — half-open 워커 head-of-line block 회피). **terminal 정합**: 컨트롤러 `failed`가 권위이고, 워커가 이후 보낼 `Aborted`/스트림-drop은 L6 terminal-phase 가드(비클로버)가 흡수 → double-terminal·영영-running 0. | `cargo test`: idle exclude → 풀에서 사라짐; busy exclude → run `failed`; 라이브: busy exclude 후 run `failed` 단일 terminal | |
| R7 | 워커는 `Disconnect` 수신 시 **프로세스-레벨 cancel 토큰**을 cancel → `run_pool` 루프 `is_cancelled()` break·진행 중 child 토큰 abort → **재접속 없이 프로세스 깔끔 종료**(SIGTERM cancel 경로 재사용). `Disconnect`는 **두 곳**에서 처리: ① **idle-wait 루프**(`worker-core/src/client.rs:134–158` — 현재 미지 메시지는 catch-all `other =>`로 reconnect → idle exclude가 되살아남, 새 arm 필수) ② **`forward_inbound` 펌프**(`client.rs:52` — in-run/로딩 드레이너, busy exclude용). 프로세스 토큰을 `forward_inbound`에 **clone 주입**(시그니처 +1 param, spawn site `client.rs:164` + 테스트 2곳 `:272`/`:386`). | `cargo test`(idle 루프·forward_inbound 각 Disconnect→cancel) + 라이브: idle/busy exclude 후 워커 프로세스 exit·재등록 0 | ✅ worker |
| R8 | REST 2종: `PATCH /api/pool/workers/{id}` body `{drained?, capacity_override?: number\|null, label?: string\|null}`(부분 갱신·null=해제·`capacity_override`는 **`1..=1_000_000` 순수 sanity 상한**[capacity_split 오버플로 가드 — fan-out `worker_capacity_vus` 설정도, 워커 선언 `capacity_vus`도 **아님**; 운영자가 의도적으로 올리거나 내릴 수 있음]·label 길이 상한 200 검증·미존재/비-풀 404) + `POST /api/pool/workers/{id}/exclude` body `{reason?}`(미존재 404). PATCH는 갱신된 summary 200 반환. | curl: PATCH 각 필드 200·범위밖 400·없는 id 404; exclude 200/404 | ✅ REST |
| R9 | `PoolWorkerSummary` DTO에 `drained: bool`·`capacity_override: Option<u32>`·`label: Option<String>` additive(token/env/tx 비노출 유지 — L-시리즈 R12); UI Zod는 `drained: z.boolean()`(항상 직렬화)·`capacity_override`/`label`은 **`.nullable()`**(서버가 `null` emit — `.optional()`/`.nullish()` 금지, S-D 갭). | `safeParse` 통과(서버 `null` 수용) + 와이어 1:1 대조(handicap-reviewer) | ✅ REST↔Zod |
| R10 | `/workers` 행마다 제어 메뉴(drain/undrain·용량 조정·label·exclude) + 시각 표면(drained "비우는 중" 배지·override "N (수동)" 표기·label 표시). **exclude는 차단형 확인창**이고 busy 워커면 *"run XXX 실행 중 — 제외 시 해당 run이 실패합니다"* 경고를 추가한다([[load-divergence-explain-confirm]]). | RTL: 메뉴·배지·확인창 분기 + 라이브 Playwright 3표면 | |
| R11 | **(보완 통제 — 로그인 부재 대체, R13)** 모든 제어 동작은 누를 때 **결과/위험 경고 문구**를 띄운다: exclude=파괴적 차단형 확인(워커 종료+run 실패 가능+재실행 필요), drain=결과 안내 확인(새 배정 중단·진행 run 유지·되돌리기 가능), capacity/label=편집 모달 내 "부하 배분에 즉시 반영" 안내. 우발/무권한 클릭을 사람이 한 번 더 차단. | RTL: 각 동작의 경고 카피 존재 단언 | |
| R12 | 신규 UI 문구·배지·확인창·경고·에러는 전부 `ko.ts`(`ko.workers.*` 확장) 경유(ADR-0035, 인라인 한국어/영어 0). | grep: 신규 인라인 문자열 0 | |
| R13 | 제어 엔드포인트는 기존 무인증 trusted-LAN 자세를 따른다(도구 전체·대시보드가 무인증 — 단일 엔드포인트만 인증은 불완전·비일관). DTO는 시크릿 비노출(R9). 인증/RBAC는 §A10로 연기하고 R11 경고를 v1 보완 통제로 둔다. | security-reviewer: 시크릿 비노출·우회 없음·경고 통제 확인 | |
| R14 | **(byte-identical)** 제어 미적용(전 워커 기본값: drained=false·override=None) + 풀 미사용 시 용량 산식·와이어·리포트 전부 byte-identical; migration 0; proto `Disconnect` 미사용=byte-identical; 풀-off 엔드포인트는 기존대로 404/비-풀 응답. | 비-풀·무제어 nextest 전수 green + 풀 무제어 라이브 byte-identical | |

- **seam 묶음**: R5(proto Disconnect)·R7(worker 소비)는 같은 와이어 — 함께 머지. R8(REST)·R9(DTO)·UI Zod는 같은 계약 — 함께 머지(한쪽만=드리프트).

---

## 3. 핵심 통찰 (설계 근거)

1. **worker_id는 프로세스 수명 동안 안정적**(`resolve_pool_worker_id` 정의 `worker/src/lib.rs:84`, `run_pool`이 루프 *밖* `:514`에서 1회 호출·매 reconnect 재사용). 그래서 worker_id를 키로 한 제어 상태가 reconnect(post-run·h2 teardown)에 살아남는다 — R2(보존)만 지키면. `--worker-id`로 프로세스 재시작에도 고정 가능. 컨트롤러 재시작만 in-memory 풀을 비운다(§7 영속 연기의 근거). 이것이 in-memory 채택(아키텍처 A)을 정당화한다 — 풀 멤버십 자체가 ephemeral인데 override만 DB 영속하면 철학 불일치.
2. **drain은 컨트롤러-측 veto로 충분**(R3) — 워커에 메시지 불필요. 가드 3경로의 idle 필터에 `!drained`만 더하면 새 배정에서 빠지고 진행 중 run은 무관(running run은 가드를 안 거침). exclude만 워커를 실제로 떼어내야 하므로 proto가 필요하다(R5/R7).
3. **exclude는 컨트롤러-측 제거만으로 불완전** — 풀 엔트리만 지우면 워커 reconnect 루프가 재등록해 *되살아난다*. 깨끗한 제거는 워커가 스스로 종료해야 하고(R7), 그것이 additive `Disconnect`(R5)다. busy fail-fast는 L6 `pool_disconnect`(idle 제거/busy `worker_disconnected`)를 그대로 재사용해 신규 종료 로직을 만들지 않는다(R6). **단 `Disconnect` 소비는 한 곳이 아니다**(spec-plan-reviewer F2 교정): `forward_inbound`(`worker-core/src/client.rs:52`)는 첫 assignment **이후** spawn되는 in-run 드레이너라 idle 워커(가장 흔한 exclude 대상)는 그 펌프 밖의 idle-wait 루프(`client.rs:134–158`)에 있다. 그래서 idle-wait 루프(현 catch-all `other =>`가 reconnect를 유발)와 `forward_inbound` **둘 다** `Disconnect` arm을 가져야 한다(R7·M2). 둘 다 같은 프로세스 토큰을 cancel → `run_pool`이 break.
4. **프리뷰≡가드 불변식(R4)**이 정합성의 핵심 — drain/override가 한쪽(서버 409)에만 반영되고 프리뷰엔 안 되면 운영자가 보는 숫자와 실제 배정이 갈라진다([[load-divergence-explain-confirm]]). 둘 다 "**`!drained` idle에 effective capacity 합산**" 한 규칙에서 파생시켜 by construction 일치시킨다.
5. **R14 락 규율 준수**(L6 선례): `pool_exclude`는 락 안에서 스냅샷(tx clone·busy 여부)만 뜨고 `.await`(send/fail-fast)는 락 밖. `try_send`(non-blocking)로 half-open 워커가 reaper처럼 head-of-line block 하지 않게 한다(L6 D1 연기를 이 신규 경로에선 선제 적용).
6. **로그인 부재의 보완 통제 = 경고 문구(R11)** — 인증을 단일 엔드포인트에만 붙이는 건 비일관(전체 REST·대시보드가 무인증)이라 §A10 프로그램으로 미루되, 파괴적 동작은 차단형 확인창의 명시적 위험 카피로 사람이 한 번 더 거른다(사용자 요청 2026-06-22).

---

## 4. 변경 상세

### 4.1 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R1, R2, R3, R6
- `PoolEntry`(81–98)에 `drained`/`capacity_override`/`label` 필드 + `effective_capacity_vus()` 메서드.
- `pool_register_idle`(336): 기존 엔트리면 제어 3필드 보존하고 tx/hostname/last_seen/capacity_vus만 갱신·`assigned_run=None`(R2); 신규면 기본값.
- `pool_achievable_capacity`(447)·`reserve_idle_pool_capacity`(469)·`reserve_idle_pool`(253): idle 필터에 `!drained` 추가, `capacity_split`/take에 `effective_capacity_vus()` 사용(R3).
- `pool_snapshot`(369): 필터 없이 전 워커 + 제어 3필드를 `PoolWorkerInfo`에 실어 노출(R9 데이터원). drained/busy 워커도 표시.
- 신규 `pool_exclude(worker_id, reason)`(R6): 락 안 제거+캡처 → 락 밖 busy fail-fast(`worker_disconnected` 재사용)+`tx.try_send(Disconnect)`.
- 신규 `pool_set_control(worker_id, drained?, capacity_override?, label?)` mutator(PATCH 백엔드, 부분 갱신·미존재 → false/None 반환으로 404 라우팅).

### 4.2 `crates/proto/proto/coordinator.proto` — 충족 R: R5
- `ServerMessage` oneof에 `Disconnect disconnect = 5;` + `message Disconnect { string reason = 1; }`.

### 4.3 `crates/worker-core/src/client.rs` + `crates/worker/src/lib.rs` — 충족 R: R7
- **두 처리 사이트**(F2/M2):
  - **idle-wait 루프**(`client.rs:134–158`): 새 `ServerMessage::Disconnect` arm → `warn!(reason)` + `cancel.cancel()`(이 루프는 이미 process `cancel: &CancellationToken` 보유) → `Err(WorkerError::Cancelled)` 반환. 현재 미지 메시지는 `other =>`(:150)로 `NoAssignment`→reconnect를 유발하므로 명시 arm이 없으면 idle exclude가 되살아난다.
  - **`forward_inbound`**(`client.rs:52`, spawn `:164`): 시그니처에 `CancellationToken` param 추가(현 `(inbound, fwd_tx, shutdown, out_tx)`) → spawn site에서 process 토큰 `.clone()` 주입 → 테스트 호출부 2곳(`:272`, `:386`) 갱신. `Disconnect` arm → `warn!` + `token.cancel()`(in-run exclude → child run 토큰 동반 cancel → 시나리오 abort).
- `run_pool` 루프(`worker/src/lib.rs:520`)의 `is_cancelled()` break(:521) + `Err(Cancelled)` arm(:543)이 재접속 차단·프로세스 종료. terminal 정합은 R6(컨트롤러 `failed` 권위·L6 terminal 가드 흡수).

### 4.4 `crates/controller/src/api/pool.rs` + `app.rs` — 충족 R: R8, R9
- `PoolWorkerSummary`에 drained/capacity_override/label 추가.
- `PATCH /pool/workers/{id}`(`patch_worker`): body Zod-대응 DTO·범위검증(`capacity_override`는 **`1..=1_000_000` sanity 상한**[capacity_split 오버플로 가드·fan-out `worker_capacity_vus` 설정/워커 선언값과 무관 — C1 교정]·label 길이 상한 200)·`pool_set_control` 호출·갱신 summary 200·미존재 404.
- `POST /pool/workers/{id}/exclude`(`exclude_worker`): `pool_exclude` 호출·200/404.
- `app.rs` 라우트 2종 등록.

### 4.5 `ui/src/` — 충족 R: R4, R9, R10, R11, R12
- `api/pool.ts` Zod: PoolWorkerSummary에 `drained: z.boolean()`·`capacity_override: z.number()…nullable()`·`label: z.string().nullable()` 추가(R9 — `.optional()`/`.nullish()` 금지).
- `api/hooks.ts`: `usePatchPoolWorker`·`useExcludePoolWorker`(풀 쿼리 invalidate).
- `WorkerDashboardPage.tsx`: 행 액션 메뉴(⋯)·drained 배지·"N (수동)" 용량·label·exclude 확인창(busy 경고 R10)·drain/capacity/label 경고 카피(R11)·용량/label 편집 모달.
- RunDialog 풀 프리뷰(`RunDialog.tsx:543–574`): 현 `!w.busy` 합산 `Math.max(w.capacity_vus,1)`를 → **`!w.drained && !w.busy`** 필터 + `Math.max(w.capacity_override ?? w.capacity_vus, 1)` 합산으로 교체(R4 — 서버 가드 R3의 `effective_capacity_vus` over `!drained` idle과 같은 의미 = by-construction parity).
- `i18n/ko.ts`: `ko.workers.*` 확장(액션·배지·확인·경고·에러 — R12).

---

## 5. 무변경 / 불변식 (명시)

- **엔진(`crates/engine`)·migration·메트릭/리포트 파이프라인 무변경** — 제어는 컨트롤러 풀 상태 + 워커 종료 경로만.
- **proto는 `Disconnect` additive만** — 기존 메시지/필드번호 불변, 미사용 시 byte-identical(R14).
- **L3–L5 과부하 가드 산식**: drained=false·override=None이면 effective==declared·필터 통과 → byte-identical(R14). 의도적 변화는 drain/override 적용 시에만.
- **`pool_register_idle` get-or-update 핫패스**: 모든 풀 워커가 거치는 함수이나, 제어 기본값(미설정)에서는 옛 blind-insert와 결과 동일(`assigned_run=None` + fresh tx/hostname/capacity). 명시 테스트로 lock-in(R2 acceptance ④·R14).
- **풀-off·legacy(per-run·k8s) 모드**: 제어 엔드포인트는 풀 미모드 404, 워커는 풀 미등록이라 영향 0.
- **시크릿**: DTO에 token/env/tx 계속 비노출(R9/R13).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | coordinator 단위: 기본값·`effective_capacity_vus` | |
| R2 | coordinator 단위: 재등록 후 제어필드 보존·assigned_run None | |
| R3 | coordinator 단위: drained 제외·override 반영·`?force` drained 미배정 | |
| R4 | UI 단위(프리뷰 산식) + 라이브: drain → 프리뷰·409 동시 반영 | ✅ |
| R5 | `cargo build` prost codegen + 필드번호 | |
| R6 | coordinator 단위: idle/busy exclude 라우팅 + 라이브: busy exclude → run `failed` 단일 terminal(double-terminal·영영-running 0) | ✅ |
| R7 | worker 단위(idle 루프·forward_inbound 각 Disconnect→cancel) + 라이브: idle/busy exclude 후 프로세스 exit·재등록 0 | ✅ |
| R8 | curl: PATCH 필드별 200·범위밖 400·404; exclude 200/404 | ✅ |
| R9 | `safeParse` + 와이어 1:1(handicap-reviewer) | ✅ |
| R10 | RTL: 메뉴·배지·busy 확인 분기 + Playwright | ✅ |
| R11 | RTL: 각 동작 경고 카피 단언 | |
| R12 | grep: 신규 인라인 문자열 0 | |
| R13 | security-reviewer: 시크릿 비노출·우회 0·경고 통제 | |
| R14 | 비-풀/무제어 nextest 전수 green + 무제어 풀 라이브 byte-identical | ✅ |

- **라이브 필수**(`/live-verify`): 실 pool 2워커로 drain→프리뷰/409 반영, exclude(idle·busy mid-run)→워커 exit·run failed, capacity override→가드 반영, Playwright 3표면 + 경고창. run-생성/가드 경로를 건드리므로 S-D 갭 차단 위해 머지 전 라이브 1회 필수.

---

## 7. 의도적 연기 (roadmap LAN 절에 누적)

- **DB 영속 제어 상태**: 컨트롤러 재시작 시 drain/override/label 초기화 수용(풀 멤버십 자체가 ephemeral — 통찰 #1). 영속하려면 `pool_worker_overrides` 테이블 + 영속 worker_id 선행(별도 슬라이스).
- **인증/RBAC**: 무인증 trusted-LAN 유지(R13), R11 경고를 보완 통제로. 제대로 된 인가는 roadmap **§A10**(RBAC/보안 하드닝 프로그램·이 spec 밖 외부 참조).
- **일괄 동작**(전체 drain·태그 일괄 exclude)·**자동 exclude**(L6 reaper가 이미 stale-evict; 수동 exclude는 비-stale 오작동용)·**예약 drain**·**capacity override 영속**·**mTLS 채널 기밀성**.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼/RED-only 단독 커밋 불가, green fold 지점 명시. seam(R5/R7 proto·R8/R9 REST↔Zod)은 양쪽 같은 커밋.

1. **T1 — coordinator 제어 상태**: `PoolEntry` 3필드+`effective_capacity_vus`+`pool_register_idle` 보존(R1/R2) + 가드 3경로 `!drained`/effective(R3) + `pool_set_control` mutator. 단위 테스트 fold(green 커밋).
2. **T2 — proto Disconnect + exclude(컨트롤러·워커)**: proto field 5(R5) + `pool_exclude`(R6, busy `worker_disconnected` 재사용·`try_send`·terminal 정합) + 워커 **두 사이트** Disconnect→cancel(R7: idle-wait 루프 새 arm + `forward_inbound` `CancellationToken` param 주입[spawn `:164`+테스트 2곳]). seam 한 커밋. **이 task에 exclude 프로토콜 복잡도가 격리됨**(F2/F3/FR4) — T1(인메모리 제어, 무-와이어)과 분리돼 리스크 국한.
3. **T3 — REST 엔드포인트 + DTO**: PATCH/exclude 라우트·검증·`PoolWorkerSummary` 3필드(R8/R9). curl 검증.
4. **T4 — UI**: Zod·hooks·대시보드 액션/배지/확인창·경고 카피(R10/R11/R12) + RunDialog 프리뷰 `!drained`/effective(R4). UI 게이트(lint/test/build).
5. **라이브 검증**(`/live-verify`) → finish-slice.
