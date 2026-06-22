# LAN 풀 제어상태 영속화 — drain·capacity·label을 컨트롤러 재시작 너머로 (ADR-0041 후속, LAN 운영 후속)

- **날짜**: 2026-06-23
- **상태**: 설계 승인(사용자 2026-06-23) + spec-plan-reviewer clean APPROVE(round 2) → 사용자 spec 리뷰 대기
- **출처**: roadmap LAN L7 §7 연기 항목("DB 영속 제어 상태 — `pool_worker_overrides` 테이블 + 영속 worker_id 선행, 별도 슬라이스") + 사용자 선택(2026-06-23 start-slice, "LAN 운영 후속" → 범위 "제어상태 영속화"). **왜 지금**: L7이 능동 제어 4종(drain/exclude/capacity/label)을 깔았지만 전부 in-memory라 **컨트롤러 재시작(재배포·크래시·머신 재부팅) 시 초기화**된다 — 정비 위해 drain한 워커가 재시작 후 조용히 rotation에 복귀해 부하를 받는 footgun. L7이 "ephemeral 수용"으로 의도적 연기한 그 갭을, 사용자가 선택한 안정-식별자 모델로 닫는다.
- **연관**: ADR-0041(LAN 분산 워커), `2026-06-22-lan-worker-control-actions-design.md`(L7 — `PoolEntry` 제어 3필드·`pool_set_control`·`pool_register_idle` get-or-update R2·`pool_exclude`), `2026-06-22-lan-worker-heartbeat-design.md`(L6 — R14 락 규율·`pool_disconnect`), `2026-06-16-ops-config-limits-admin-design.md`(settings PUT/DELETE의 "DB await 먼저, 동기 스냅샷 나중" 락-회피 선례), `docs/dev/lan-workers.md`(운영 런북).
- **ADR**: 신규 불필요(기존 ADR-0041 범위 내 — L7 §7이 이 슬라이스를 *계획된 후속*으로 명시). 새 와이어(proto `Register.stable_id`·migration 0019·DTO `stable`)는 전부 additive·byte-identical-off. ADR-0041 §귀결/연기 한 줄 갱신.

---

## 1. 문제와 목표

L7 제어 상태(`PoolEntry.drained`/`capacity_override`/`label`)는 in-memory 전용이라 컨트롤러 재시작이 풀을 비우면 전부 사라진다. 운영자가 점검 전 워커 X를 drain → 컨트롤러 재배포 → 워커 X가 fresh 유휴 풀 멤버로 재등록돼 *조용히* 다시 부하를 받는다 — 운영자 의도를 silent하게 되돌린다. 핵심 난점은 **재부착의 키**다: 풀은 worker_id로 키잉되지만 기본 풀 worker_id는 프로세스 시작마다 새 랜덤 ULID(`resolve_pool_worker_id`, `worker/src/lib.rs:84`)라, 영속한 drain이 재시작 후 같은 키로 다시 나타나지 않으면 무용하다.

- **목표**: operator가 `--worker-id`로 **안정 식별자**를 준 풀 워커의 제어상태(drain·capacity_override·label)를 `pool_worker_overrides` 테이블에 영속하고, 그 워커가 (재시작·컨트롤러 재시작 후) 처음 재등록할 때 DB에서 **재부착**한다. 안정 id가 없는 익명(랜덤 ULID) 워커는 **byte-identical**(현 동작)이고 대시보드에 "일시적"으로 표시해 "영속이 silent하게 안 됨"을 정직하게 드러낸다.
- **비목표(연기)**: §7 참조. exclude 영속(denylist/자동 재-exclude)·orphan 행 자동 GC·RBAC/auth(§A10)·일괄 동작·예약 drain·per-stage 라이브니스·mutation-error toast·worker 자가-id-파일(대안 식별 모델).

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | proto `Register`에 `bool stable_id = 6;`을 additive 추가(미설정=false=byte-identical); 워커 `run_pool`은 `stable = args.worker_id.is_some()`(=`--worker-id` 명시 여부)를 산출해 `Register{stable_id}`로 보낸다. **`stable: bool`은 `connect_with_backoff`(`reconnect.rs:35`)→그 클로저(`:49`)→`connect_and_register`(`client.rs:101`/literal `:125`)로 관통**(워커가 직접 부르는 건 `connect_with_backoff`다 — `lib.rs:484` `run`=false, `:524` `run_pool`=stable). | `cargo build`(prost codegen) + worker 단위(`run_pool` explicit-id→true·익명→false) + 필드번호 검토 | ✅ proto |
| R2 | migration 0019 `pool_worker_overrides(worker_id TEXT PRIMARY KEY, drained INTEGER NOT NULL DEFAULT 0, capacity_override INTEGER, label TEXT, updated_at INTEGER NOT NULL)`를 `CREATE TABLE IF NOT EXISTS`(`MIGRATION_SQL_0019` const + `connect()` execute, 0007/0010/0011 패턴)로 추가하고, store 함수 `get_pool_override`/`upsert_pool_override`/`delete_pool_override`를 둔다. `updated_at`은 v1에서 **write-only**(GC·read-back 없음 — 후속 GC/디버깅용 메타, §7). | `cargo test`: store 라운드트립(get→upsert→get→delete→get None) + migration 멱등 | ✅ migration |
| R3 | `PoolEntry`에 `stable: bool`을 추가하고 `pool_register_idle`이 `reg.stable_id`로 세팅한다; **stable=false 워커는 영속 경로(R4)가 no-op**이라 익명 워커는 와이어·DB·동작 byte-identical. | `cargo test`: 익명 register → DB 행 0·write 경로 미진입 | |
| R4 | **(쓰기)** `pool_set_control`은 in-memory 변경(L7 현행)을 끝낸 뒤 락 안에서 `(e.stable, e.drained, e.capacity_override, e.label.clone())`를 캡처하고, **락 drop 후** stable이면 영속한다: 결과가 전부 기본값(drained=false ∧ override=None ∧ label=None)이면 `delete_pool_override`, 아니면 `upsert_pool_override(worker_id, …, now_ms())`. **DB write가 에러면 in-memory는 이미 적용됐으나 500을 surface**(silent 영속실패 금지 — `pool_set_control` 반환을 `bool`→`anyhow::Result<bool>`로: `Ok(true)`=적용+영속·`Ok(false)`=풀에 없음(404)·`Err`=적용됐으나 영속 실패(500, "재시작 시 유실 가능" 문구); 익명은 DB 미접촉이라 항상 `Ok`). **DB `.await`는 풀 락 밖**(L6/settings 선례 — 락 안엔 스냅샷만, `.await` 0). | `cargo test`: stable mutate→행 upsert·return-to-default→행 삭제·익명→행 0; curl: 정상 200·없는 id 404 | |
| R5 | **(읽기/재부착)** `pool_register_idle`은 stable 워커면 풀 락을 **잡기 전**에 `get_pool_override(self.db, worker_id)`(await)를 읽고, 제어 3필드를 **INSERT(엔트리-부재) 분기에서만** 적용한다(행 없으면 기본값). INSERT는 ① 컨트롤러 재시작 후 최초 등록 **②** L6 리퍼가 *컨트롤러 가동 중* half-open 워커를 evict한 뒤의 재접속(`pool_disconnect`→`remove`→재-Register) 둘 다에 발생 — 두 경우 모두 DB 재적용이 옳다(②는 오히려 L7 잠복 갭[리퍼-evict된 drained 워커가 컨트롤러 가동 중에도 undrained로 복귀]을 닫는 보너스). **UPDATE(warm reconnect, 엔트리 존재) 분기는 L7 R2 in-memory 보존 그대로**(byte-identical) — drain-vs-reconnect 경합 회피. **DB read가 에러면 fail-soft**: 기본값으로 진행 + `warn!`(register를 깨지 않음 — `?` 전파 금지, ingest/insights fail-soft 선례). evict-gap에 들어온 PATCH는 `pool_set_control`이 엔트리 부재로 `Ok(false)`→404를 주므로 operator가 명시적으로 재시도(silent 아님). | `cargo test`: insert 분기 DB 재부착·update 분기 in-memory 보존(DB 미적용)·read-error fail-soft | ✅ DB read(pre-lock) |
| R6 | **(불변식)** `pool_exclude`는 override 행을 **건드리지 않는다** — exclude는 즉시 제거(워커 종료, L7 R6)지 durable 상태가 아니다. exclude된 stable 워커의 persisted drain은 그대로 남아 operator가 워커를 재실행하면 재부착된다. 자동 재-exclude/denylist는 비목표(§7). | `cargo test`: exclude 후 override 행 불변(존재 시 유지) | |
| R7 | `PoolWorkerInfo`/`PoolWorkerSummary` DTO에 `stable: bool`을 additive 추가(token/env/tx 비노출 유지 — L-시리즈 R12); UI Zod는 `stable: z.boolean()`(항상 직렬화·nullable 아님). | `safeParse` 통과 + 와이어 1:1 대조(handicap-reviewer) | ✅ REST↔Zod |
| R8 | `/workers` 행마다 durable(stable)/일시적 인디케이터를 보이고, **익명(non-stable) 워커**의 제어 메뉴(drain/용량/label)에 "안정 id 없음 → 컨트롤러 재시작 시 제어상태 미유지(`--worker-id` 지정 필요)" 힌트를 띄운다. 기존 drained 배지·"N (수동)" 용량·label 렌더는 무변경(stable 워커는 재시작 후 자동으로 persisted 값 반영). **`stable`은 신규 *required* Zod 필드라 워커 객체/`PoolWorkersResponse`를 만드는 기존 RTL fixture 전부가 깨진다(ui/CLAUDE.md L6 노트) → 같은 task에서 일괄 갱신.** | RTL: 인디케이터·익명 힌트 분기 + 라이브 Playwright | |
| R9 | 신규 UI 문구(인디케이터·힌트)는 전부 `ko.ts`(`ko.workers.*` 확장) 경유(ADR-0035, 인라인 한국어/영어 0). | grep: 신규 인라인 문자열 0 | |
| R10 | **(byte-identical)** 전 워커 익명(현 기본·`--worker-id` 미지정) + 풀 미사용 시: stable=false 도처·DB write/read-적용 0·DTO stable=false·proto field 6 default false → L7과 **동작·와이어·리포트** 동일. **단 migration 0019는 (모든 마이그레이션처럼) 배포 무관 무조건 실행** → 모든 DB가 *빈* `pool_worker_overrides`를 얻는다(스키마-레벨 변화 O, 0017 settings 선례와 동일). byte-identical은 동작/와이어 레벨이고, **read/write 로직만 `stable`로 게이트**(off=테이블 미접촉). | 비-풀·익명 nextest 전수 green + 익명 풀 라이브 byte-identical | |
| R11 | **(멱등/복구)** migration은 `CREATE TABLE IF NOT EXISTS`로 재실행 안전, store upsert/get/delete는 멱등; **재시작-복구 테스트**: stable 워커 제어 설정(DB write) → 그 풀 엔트리 제거(warm DB로 컨트롤러 재시작 모사) → 재등록(INSERT) → 제어상태가 DB에서 재적용(R5)됨을 단언. | `cargo test`: restart-recovery 시나리오 | |
| R12 | **(보안/trusted-LAN)** 신규 REST 표면 0(L7 `PATCH /api/pool/workers/{id}`·exclude 재사용); `pool_worker_overrides`는 시크릿 무보관(worker_id·drain·cap·label·ts만); `stable_id`는 비-시크릿·비보안민감; 영속은 기존(register-시 토큰 검사·제어는 REST-only) 경로로만 트리거; 무인증 trusted-LAN 자세 무변경(§A10). | security-reviewer: 테이블 시크릿 0·우회 0·비-peer-triggerable | |

- **seam 묶음**: R1(proto stable_id + 워커 송신)은 한 와이어 — 함께 머지. R2(migration+store)는 R3~R5(coordinator 소비)와 같은 green 커밋(미사용 store fn=clippy dead_code, 루트 CLAUDE.md). R7(DTO)·UI Zod는 같은 계약 — 함께 머지(한쪽만=드리프트).

---

## 3. 핵심 통찰 (설계 근거)

1. **식별 = operator 지정 `--worker-id`, 워커가 안정성을 스스로 안다.** `resolve_pool_worker_id(explicit)`는 `explicit.is_some()`로 "operator가 안정 id를 줬는가"를 이미 안다(`worker/src/lib.rs:84`). 그래서 두 번째 식별자도, 파일 I/O도 없이 **additive proto bool 1개**(`stable_id`)가 영속을 게이트한다(R1). 컨트롤러는 stable일 때만 영속/재부착하고(R3~R5), 익명 워커는 byte-identical + 대시보드에 "일시적" 표면화(R8) — "drain이 재시작 후 silent하게 안 살아남는" footgun을 사용자에게 정직하게 드러낸다(전원-영속이 키를 못 맞춰 silent 미동작하는 §대안 기각 사유).
2. **재부착은 INSERT(엔트리-부재) 분기에서만 — DB는 (재)attach 복구원, in-memory가 엔트리 생존 동안의 권위.** stable 워커는 매 mutation이 DB를 쓰므로 **직렬 mutation 하에선** DB==in-memory다. warm reconnect(엔트리 존재)에 DB를 재적용하면 ① drain-vs-reconnect 경합(operator가 재접속과 같은 순간 drain → reconnect의 DB read가 mutate의 write를 앞질러 옛 값으로 덮음)이 열리고 ② warm 경로가 L7 R2와 갈린다. 그래서 **엔트리-부재(INSERT) 분기에서만 DB 적용**하고 UPDATE는 L7 R2 in-memory 보존 그대로(R5). INSERT는 컨트롤러 재시작뿐 아니라 **L6 리퍼가 컨트롤러 가동 중 half-open 워커를 evict한 뒤의 재접속**에도 발생 — 두 경우 모두 DB 재적용이 옳고, 후자는 L7 잠복 갭(리퍼-evict된 drained 워커가 컨트롤러 가동 중에도 undrained로 복귀)을 닫는 보너스다. **동시(concurrent) 같은-워커 PATCH는 예외**: 두 PATCH의 락-밖 DB write가 in-memory 변경과 다른 순서로 resolve될 수 있어(last-write-to-DB ≠ last-write-to-memory) DB==in-memory가 깨질 수 있다(단일 operator·단일 워커엔 사실상 비발생). v1은 last-write-wins 수용 + §5 한계 명시(직렬화 기계장치 비도입 — YAGNI).
3. **exclude는 durable 아님(R6).** exclude는 워커를 *지금* 종료(L7 R6 `Disconnect`)하는 일회성 동작이지 "계속 빼둬라"가 아니다. "계속 빼둬라"는 drain(연결 유지·rotation 제외)이 표현하고 그게 영속 대상이다. exclude를 영속하려면 denylist + 재접속 시 재-exclude 기계장치가 필요(별도 feature) → override 행은 `pool_set_control`만 쓰고 exclude는 안 건드린다. exclude된 drained 워커를 재실행하면 drain이 재부착되는 건 의도된 일관 동작.
4. **R14 락 규율(L6/settings 선례).** `pool_set_control`은 락 안에서 in-memory 변경 + `(stable, 결과 3필드)` 스냅샷만 뜨고, `delete`/`upsert`(`.await`)는 락 drop 후(R4). `pool_register_idle`의 DB read는 락 잡기 *전*(R5). 풀 락을 DB `.await` 너머로 들고 가지 않는다.
5. **return-to-default가 행을 삭제 → 테이블 청결("행 없음 = 기본값").** decommission된 stable 워커는 유한(명명 워커 수) 행을 남기지만, undrain+override해제+label삭제로 행이 지워진다. 자동 GC는 v1 비목표(§7) — 명명 워커는 operator가 알고 관리한다.

---

## 4. 변경 상세

### 4.1 `crates/proto/proto/coordinator.proto` + `crates/worker-core/src/{reconnect.rs,client.rs}` + `crates/worker/src/lib.rs` — 충족 R: R1
- proto: `message Register`에 `bool stable_id = 6;`(token=4·hostname=5 다음).
- **`stable: bool`을 3단으로 관통**(워커는 `connect_and_register`를 직접 안 부른다 — `connect_with_backoff` 경유):
  - `connect_and_register`(`client.rs:101`)에 `stable: bool` param → `Register{… stable_id: stable}`(literal `client.rs:125`, 유일 literal 사이트).
  - `connect_with_backoff`(`reconnect.rs:35`)에 `stable: bool` param 추가(`cancel` 뒤) → 클로저(`reconnect.rs:49`)가 `connect_and_register(…, stable)`로 전달. `retry_with_backoff`(`:84`)는 connector-agnostic이라 무변경.
  - 호출부: `run`(`lib.rs:484` `connect_with_backoff(…)`) → `false`; `run_pool`(`lib.rs:524`) → `let stable = args.worker_id.is_some();`(`run_pool` 루프 *밖* 1회 산출, `resolve_pool_worker_id`의 explicit-우선과 정합). 테스트 호출부 없음(`reconnect_backoff_test.rs`는 `retry_with_backoff`+합성 connector·`client.rs:316`는 루프 인라인 — 둘 다 real fn 미호출).

### 4.2 `crates/controller/src/store/` (migration 0019 + `pool_overrides.rs`) — 충족 R: R2
- `migrations/0019_pool_worker_overrides.sql`(`CREATE TABLE IF NOT EXISTS pool_worker_overrides(...)`) + `MIGRATION_SQL_0019` const + `connect()` execute 라인(`grep -c MIGRATION_SQL`로 const==execute 교차검증, 리넘버 함정).
- `store/pool_overrides.rs`: `PoolOverride{drained,capacity_override,label}` + `get_pool_override(db, worker_id) -> anyhow::Result<Option<PoolOverride>>`·`upsert_pool_override(db, worker_id, drained, capacity_override, label, now_ms) -> anyhow::Result<()>`(`INSERT … ON CONFLICT(worker_id) DO UPDATE`)·`delete_pool_override(db, worker_id) -> anyhow::Result<()>`.
- **에러 정책(M1/M2)**: `get_pool_override`(register read)는 호출측에서 **fail-soft**(Err→기본값+`warn!`, register 미중단·`?` 금지). `upsert`/`delete`(set_control write)의 Err는 `pool_set_control`이 **surface**(아래 §4.3 — 500).

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R3, R4, R5, R6
- `PoolEntry`(81)에 `stable: bool`(register/set_control이 *읽으므로* dead_code 0). `PoolWorkerInfo`(112)의 `stable` + `pool_snapshot` 노출은 **T3에 fold** — R7 display 노출 seam(`PoolWorkerInfo`→`Summary`→Zod)을 한 커밋에 묶어 wire 1:1을 명확히 하려는 cleanliness 선택(`PoolWorkerInfo`는 pub-reachable struct라 미read 필드가 dead_code를 강제하진 *않음* — 분리해도 컴파일은 됨).
- `pool_register_idle`(351): 시그니처에 `stable: bool` 추가(prod 호출부 `coordinator.rs:1163`에 `reg.stable_id`). stable이면 **락 전** `get_pool_override(&self.db, worker_id).await`(Err→fail-soft 기본값+`warn!`); **INSERT(엔트리-부재) 분기**에서 행(또는 기본값)으로 `drained`/`capacity_override`/`label` 세팅(R5), **UPDATE(엔트리-존재) 분기**는 현행 보존(L7 R2). `stable` 필드 저장. **함정: 이 arity 변경은 ~38 호출부 churn**(prod 1 + `coordinator.rs` 인라인 `#[cfg(test)]` ~37 + `tests/pool_api_test.rs:93`) — prost/AppState-literal과 동급 컴파일러-driven, **한 green 커밋**.
- `pool_set_control`(488): 락 안 mutate 후 `(e.stable, e.drained, e.capacity_override, e.label.clone())` 스냅샷 캡처(`e.stable`이 write 게이트·`Option<u32>`는 Copy·`label`만 clone) → 락 drop → stable이면 전부-기본값→`delete_pool_override`, else `upsert_pool_override(…, now_ms())`(R4). **반환 타입 `bool`→`anyhow::Result<bool>`**: `Ok(true)`=적용+영속·`Ok(false)`=풀에 없음·`Err`=적용됐으나 영속 실패(익명은 DB 미접촉→항상 Ok).
- `pool_exclude`(514): **무변경**(override 행 미접촉, R6).
- (T3) `PoolWorkerInfo`(112)에 `stable: bool` + `pool_snapshot`(400)이 실어 노출 — DTO/Zod와 같은 커밋(R7 seam).

### 4.4 `crates/controller/src/api/pool.rs` — 충족 R: R4(T2), R7(T3)
- (T2, R4) `patch_worker`(99): `pool_set_control`의 새 `Result<bool>`를 매핑 — `Ok(true)`→갱신 summary 200·`Ok(false)`→404·`Err`→500(`ApiError::Internal`, "제어 적용됨·영속 실패" 문구, M2). 시그니처 변경이 강제하므로 **T2 같은 커밋**(컴파일 의존). 기존 200/404/400 REST 계약 보존 + 500은 additive 에러 케이스.
- (T3, R7) `PoolWorkerSummary`에 `stable: bool` + `From<PoolWorkerInfo>` 매핑(위 `PoolWorkerInfo.stable`과 같은 커밋 = R7 데이터원이 여기서 처음 읽힘). **신규 엔드포인트 0**(PATCH/exclude는 L7 그대로).

### 4.5 `ui/src/` — 충족 R: R8, R9
- `api/pool.ts` Zod: `PoolWorkerSummary`에 `stable: z.boolean()`.
- `WorkerDashboardPage.tsx`: 행 durable/일시적 인디케이터; 익명 워커 제어 메뉴(drain/용량/label)에 "안정 id 없음 → 재시작 시 미유지(`--worker-id`)" 힌트. 기존 drained 배지·"N (수동)"·label 무변경.
- `i18n/ko.ts`: `ko.workers.*` 확장(인디케이터·힌트 — R9).

---

## 5. 무변경 / 불변식 (명시)

- **엔진(`crates/engine`)·메트릭/리포트 파이프라인·스케줄러 무변경** — 영속은 컨트롤러 풀 상태 + DB 1테이블 + 워커 register 1 bool.
- **L7 제어 엔드포인트 무변경** — `PATCH /api/pool/workers/{id}`·exclude 라우트·검증·DTO 검증 그대로. `pool_set_control` *내부*만 영속 추가, `pool_exclude`는 완전 무변경(R6).
- **warm reconnect(UPDATE) 경로 byte-identical** — L7 R2 보존 그대로, DB 미적용(R5/통찰 #2).
- **익명 워커·풀-off byte-identical**(R10, 동작/와이어 레벨) — proto field 6 default false·write/read-적용 0. migration 0019는 무조건 실행되나(스키마-레벨 빈 테이블 추가) 로직은 `stable` 게이트.
- **시크릿**: DTO에 token/env/tx 계속 비노출(R7/R12), override 테이블에 시크릿 0.
- **알려진 한계(v1 수용·§7 외)**: ① 동시 같은-워커 PATCH는 DB write 순서가 in-memory와 갈릴 수 있다(last-write-to-DB wins, 단일 operator엔 비발생 — insight #2). ② DB write 실패 시 in-memory는 적용된 채 500이 반환된다("적용됨·영속 실패" — operator 재시도로 수렴). 둘 다 직렬화/롤백 기계장치는 YAGNI로 비도입.
- **신규 ADR 0** — ADR-0041 범위 내 계획된 후속.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `cargo build` prost + worker 단위(`run_pool` explicit→true·익명→false) + 필드번호 | |
| R2 | store 단위: get/upsert/get/delete 라운드트립 + migration 멱등 | |
| R3 | coordinator 단위: 익명 register → DB 행 0·write 미진입 | |
| R4 | coordinator 단위: stable mutate→upsert·return-to-default→delete·익명→0 | |
| R5 | coordinator 단위: insert 분기 DB 재부착·update 분기 in-memory 보존 | |
| R6 | coordinator 단위: exclude 후 override 행 불변 | |
| R7 | `safeParse`(stable 수용) + 와이어 1:1(handicap-reviewer) | ✅ |
| R8 | RTL: 인디케이터·익명 힌트 + Playwright | ✅ |
| R9 | grep: 신규 인라인 문자열 0 | |
| R10 | 비-풀·익명 nextest 전수 green + 익명 풀 라이브 byte-identical | ✅ |
| R11 | coordinator 단위: restart-recovery(설정→엔트리 제거→재등록→재부착) + 리퍼-evict→재접속 재부착(R5 INSERT 분기 ②) | |
| R12 | security-reviewer: 테이블 시크릿 0·우회 0·비-peer-triggerable | |

- **라이브 필수**(`/live-verify`): 실 pool에서 ① **stable 워커**(`--worker-id w1`) drain → 컨트롤러 재시작 → 워커 재등록 → **여전히 drained**(프리뷰·409 가드에 반영) ② **익명 워커** drain → 재시작 → **undrained 복귀** + 대시보드 "일시적" 표시 ③ capacity_override/label 재시작 생존(stable) ④ **리퍼-evict 재부착**: 짧은 stale 임계값으로 stable 워커 drain → `kill -STOP`로 half-open evict → `kill -CONT` 재접속 → **컨트롤러 가동 중에도 drained 재부착**(R5 ②·L7 잠복 갭 닫힘) ⑤ Playwright 인디케이터·익명 힌트. register/풀-배정 경로를 건드리므로 S-D 갭 차단 위해 머지 전 라이브 1회 필수.

---

## 7. 의도적 연기 (roadmap LAN 절에 누적)

- **exclude 영속(denylist/자동 재-exclude)**: exclude는 일회성 종료(통찰 #3). "재접속해도 계속 빼둬라"는 denylist + 재-exclude 기계장치 = 별도 feature.
- **orphan 행 자동 GC**: v1은 return-to-default가 행 삭제(통찰 #5). decommission된 stable 워커의 잔류 행은 유한(명명 워커 수)이라 age-기반 GC는 후속.
- **worker 자가-id-파일(대안 식별 모델)**: 사용자 선택은 operator 지정 `--worker-id`. 파일-영속 자동 id(operator 설정 불요)는 worker-측 파일 I/O·경로/권한·임시 컨테이너 손실 caveat가 있어 v1 밖.
- **인증/RBAC**: 무인증 trusted-LAN 유지(R12), §A10 프로그램으로.
- **일괄 동작·예약 drain·per-stage 라이브니스·mutation-error toast**: L6/L7 §7 연기 그대로, 본 슬라이스와 메커니즘 무관한 독립 QoL.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 store fn(clippy dead_code)·RED-only 단독 커밋 불가 → green fold 지점 명시. seam(R1 proto·R7 REST↔Zod)은 양쪽 같은 커밋.

1. **T1 — proto `stable_id` + 워커 송신 (R1, seam)**: proto field 6 + `stable` param을 `connect_with_backoff`(`reconnect.rs:35`+클로저)→`connect_and_register`(`client.rs`)로 관통 + `run`/`run_pool` 호출부(F1). 컨트롤러는 아직 안 읽음 → additive·byte-identical·green 단독.
2. **T2 — migration 0019 + store + coordinator 영속 배선 (R2/R3/R4/R5/R6/R11)** *(persistence 메커니즘만 — snapshot 노출 제외)*: 0019 sql+const+execute(`grep -c MIGRATION_SQL` const==execute 검증) + `pool_overrides.rs` get/upsert/delete + `PoolEntry.stable`(register/set_control이 읽음) + `pool_register_idle`(read pre-lock·apply-on-INSERT·read-error fail-soft·**~38 호출부 arity churn**) + `pool_set_control`(persist post-lock·반환 `Result<bool>`). store fn이 이 커밋서 호출부 획득→dead_code 회피 → **한 green 커밋**. **`coordinator.rs`/`api/pool.rs`는 pending test 부재라 src 편집 unblock 위해 `crates/controller/tests/_tdd_keepalive.rs` 선배치**(explicit-path add·커밋 금지·slice 끝 rm — L7 선례). coordinator 단위(익명 no-DB·INSERT 재부착[기존 snapshot 필드로 관측]·리퍼-evict 재부착·exclude 행 불변) + restart-recovery + store 라운드트립 fold. **`pool_set_control`→`Result<bool>` 변경이 호출부 `patch_worker`(api/pool.rs)의 200/404/500 매핑을 같은 커밋서 강제**(컴파일 의존, §4.4 R4) — DTO `stable` 필드만 T3.
3. **T3 — `stable` 노출 seam (R7) + UI (R8/R9)** *(PoolWorkerInfo→Summary→Zod 노출을 한 커밋에 = R7 wire 1:1 — cleanliness, dead_code 강제 아님)*: `PoolWorkerInfo.stable` + `pool_snapshot` 노출 + `PoolWorkerSummary.stable` + `From` + `patch_worker`의 `Result<bool>`→200/404/500 매핑 + UI Zod `stable: z.boolean()`(**required 필드라 워커-객체 RTL fixture 전수 갱신**) + 대시보드 인디케이터/익명 힌트 + `ko.workers.*`. curl(stable 노출·500 경로) + UI 게이트(lint/test/build).
4. **라이브 검증**(`/live-verify`: stable drain→재시작→drained 생존·익명→복귀·리퍼-evict 재부착·Playwright) → finish-slice.
