# LAN 풀 운영 견고성 — 하트비트 임계값 런타임 가변 + 리퍼 하드닝 + 제어 에러 표면화 (LAN 분산 워커 후속, ADR-0041)

- **날짜**: 2026-06-22
- **상태**: 설계 승인(사용자 2026-06-22) → plan 대기
- **출처**: roadmap §현재 상태 LAN L7 연기 항목(`mutation-error toast(ops-settings 후속)`) + L6 연기 항목(D1 `send().await`→`try_send`·D2 interval-0 clamp·ops-settings 하트비트 임계값 런타임 가변). **왜 지금**: LAN 풀 기능 세트(L1–L7)가 기능적으로 완결됐으니, 운영자가 직접 연기로 적은 "재배포 없이 하트비트 조정 + 리퍼 견고성 + 제어 액션 에러 가시성" 갭을 한 슬라이스로 닫는다.
- **연관**: ADR-0041(LAN 분산 워커), L6 spec `2026-06-22-lan-worker-heartbeat-design.md`, L7 spec `2026-06-22-lan-worker-control-actions-design.md`, ops-config 관리자 spec `2026-06-16-ops-config-limits-admin-design.md`(ADR-0039).
- **ADR**: 신규 불필요(ADR-0041 LAN 분산 워커 + ADR-0039 ops-config 관리자 범위 내 additive — 하트비트 임계값을 기존 `SettingsState` 레지스트리에 편입·기존 리퍼/제어 경로 강화).

---

## 1. 문제와 목표

LAN 풀 하트비트 임계값 3종(ping interval·stale timeout·h2 keepalive)은 L6에서 **CLI 플래그로 시작 시 고정**돼 재배포 없이 못 바꾼다. 리퍼는 두 군데가 약하다: ① 각 워커 `Ping`을 bounded `mpsc(32)`에 `send().await`로 보내 backpressured half-open 워커가 sweep 전체를 head-of-line block 할 수 있다(L6 D1), ② interval 시드가 0이면 `tokio::time::interval(0)`이 tight-loop 한다(L6 D2). 그리고 L7 `/workers` 제어 액션(drain/undrain·exclude·capacity·label)은 mutation이 **fire-and-forget**(즉시 `closeAll()`·`onError` 없음)이라 실패가 화면에 전혀 안 뜬다.

- **목표**: (①) interval·stale를 ops-settings(`/settings`) 런타임 가변 + keepalive 읽기전용 표시, 리퍼가 매 sweep 임계값을 fresh 재읽기. (②) 리퍼 `try_send` + interval `.max(1)` clamp. (③) 제어 mutation 에러를 컨텍스트 인라인(모달/다이얼로그 내부 + undrain은 페이지 배너)으로 표면화.
- **비목표(연기)**: §7 참조. DB 영속 제어상태·스케줄러 config 가변화·일괄 동작·mTLS·자동 exclude.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| **① 하트비트 임계값 → ops-settings** | | | |
| R1 | MUST `SETTINGS` 레지스트리에 3행 추가 — `pool_heartbeat_interval_seconds`(mutable, 1–3600, default 10)·`pool_stale_timeout_seconds`(mutable, 2–86400, default 30)·`pool_keepalive_seconds`(readonly, default 20); 기존 3 CLI 플래그는 `SettingsState.build`의 시드로 전환. | `settings.rs` 단위(`registry_is_single_source` 확장: 3키 존재·range·mutable 플래그) + GET `/api/settings`에 3행 노출 | ✅ settings 레지스트리 → REST `SettingItem`/UI `SettingSchema`(additive 행, 스키마 무변경) |
| R2 | MUST 리퍼가 매 sweep마다 `state.settings`에서 interval·stale를 fresh 재읽어 적용(재배포 없이 다음 sweep에 반영). | 라이브: `/settings`로 interval 변경 → 리퍼 cadence 로그 간격 변화; stale 변경 → 새 임계값에 evict | |
| R3 | MUST 대시보드 엔드포인트(`GET /api/pool/workers`)의 `heartbeat_interval_seconds`/`stale_timeout_seconds`를 `state.settings`에서 읽고(=리퍼와 동일 단일 소스), `AppState`의 두 스칼라 필드(`heartbeat_interval_seconds`·`stale_timeout_seconds`)는 제거. | 통합: settings PUT 후 GET `/api/pool/workers` 응답의 임계값이 새 값 / `grep -c 'heartbeat_interval_seconds' app.rs` = 0(필드 제거) | ✅ 응답 DTO 동일(값만 settings 유래) |
| R4 | MUST `pool_keepalive_seconds`는 읽기전용 표시 — h2 keepalive는 transport-baked(startup 1회 고정·런타임 가변 아님). 표시값 = **컨트롤러 서버측** keepalive 설정(`args.pool_keepalive_seconds`, 서버 두 arm). **워커 클라이언트 keepalive는 별도 하드코딩 20s 상수**(`worker-core/src/client.rs:111-113`)라 비기본 시드면 표시값≠워커 협상값 가능 — 워커 상수 변경은 R14(worker 0-diff) 위반이라 범위 밖(§5 명시). | 통합: GET `/api/settings` keepalive `source:"readonly"`·value==컨트롤러 CLI값 | |
| R5 | MUST `stale > interval` 불변식을 **세 진입점 모두**에서 보존 — (a) PUT: `stale ≤ interval` 결과 쌍 400 거부(교차필드: sibling 현재 유효값), (b) DELETE-revert: 시드로 되돌린 결과 쌍이 `stale ≤ interval`이면 400 거부, (c) startup: `stale_seed ≤ interval_seed`면 `tracing::warn!` + stale 시드를 `interval_seed+1`로 clamp(build 전 main.rs). 전부 명확한 한국어 사유. | 통합: PUT/DELETE 양방향 400·유효순서 200; 단위: startup clamp(시드쌍) | |
| R6 | SHOULD `/settings`가 페이지 레벨에 (a) `stale < 2×interval`일 때 비차단 2× 여유 경고(저장 무관·R5와 별개), (b) 하트비트 키 전용 '다음 sweep 즉시 적용' 안내(전역 'next run' 배너 정정·F2) 표시. | RTL: `stale<2×interval` 경고 노출/`≥` 미노출; 하트비트 적용 안내 존재 | |
| R7 | MUST DB 오버라이드가 없으면 interval/stale/keepalive 유효값 == CLI 시드 == L6 동작(byte-identical) — 리퍼 cadence·stale evict·keepalive 무변화. | 단위(`effective_prefers_override`류 3키 시드 폴백) + 라이브 오버라이드 0 상태 cadence 동일 | |
| **② 리퍼 하드닝** | | | |
| R8 | MUST `pool_heartbeat_tick`의 Ping 전송을 `tx.try_send`로 — `Full`이면 skip(evict 안 함; last_seen 미갱신→다음 stale 체크 + h2 keepalive 자가치유), `Closed`이면 `pool_disconnect`(evict, 현 dead-tx와 동일). sweep이 한 워커에 head-of-line block 하지 않음. | 단위: 가득 찬 tx → entry 잔존(evict 안 됨)·닫힌 tx → evict | |
| R9 | MUST 리퍼 sleep 직전 유효 interval을 `.max(1)`로 clamp(시드 0이어도 tight-loop 불가). | 단위(`launch.rs`류 순수 헬퍼 또는 clamp 함수) clamp(0)→1·clamp(5)→5 | |
| R10 | MUST R8 변경이 R14 락 규율(스냅샷 락 안 `.await` 0 → 락 밖 send/evict)과 terminal-phase 가드(busy evict→`worker_disconnected`, double-terminal 0)를 보존. | 기존 가상시계 단위(`pool_heartbeat_tick` 테스트)가 try_send로 갱신 후 green | |
| **③ 제어 mutation 에러 표면화 (컨텍스트 인라인)** | | | |
| R11 | MUST exclude(alertdialog)·capacity/label(편집 모달)·drain(확인 다이얼로그) mutation 실패 시 그 다이얼로그/모달 안에 `role="alert"` 에러를 표시하고 **열린 채 유지**(현 fire-and-forget `closeAll()` 대신 `onSuccess: closeAll / onError: setError`). | RTL: mutation reject → 에러 문구 표시·다이얼로그 잔존; resolve → 닫힘 | |
| R12 | MUST undrain(메뉴-직접, 다이얼로그 없음) mutation 실패를 대시보드 상단 dismissible 인라인 배너(`role="alert"`)로 표시. | RTL: undrain reject → 페이지 상단 배너·닫기 버튼으로 사라짐 | |
| R13 | MUST ③의 모든 신규 사용자노출 문구(에러·배너·닫기 라벨·R6 경고)는 `ko.*` 카탈로그 경유(ADR-0035), 에러 영역 `role="alert"`(a11y). | `grep` 인라인 영어 0 + RTL accessible-name | |
| **불변식** | | | |
| R14 | MUST migration 0·proto 0·engine 0·worker 0 — 변경은 controller(`settings.rs`·`api/settings.rs`·`api/pool.rs`·`grpc/coordinator.rs`·`main.rs`·`app.rs`) + UI(`SettingsPage`·`WorkerDashboardPage`·`ko.ts`·schemas/hooks)만. | `git diff --stat`이 그 경로에 한정·`crates/proto`/`crates/engine`/`crates/worker` 0-diff | |

- **seam 묶음**: R1/R3은 기존 `SettingItem`↔`SettingSchema`·`PoolWorkersResponse`↔Zod 와이어를 **additive로만** 건드린다(새 키 행은 generic view를 타고, 응답 DTO 필드는 불변). 한쪽만 머지될 분할이 아니라 한 슬라이스라 드리프트 위험 낮음 — 최종 `handicap-reviewer`가 settings 3행 + 대시보드 임계값 소스를 1:1 확인.

---

## 3. 핵심 통찰 (설계 근거)

1. **keepalive는 transport-baked라 읽기전용이 유일 정합(R4)**. h2 keepalive는 tonic 서버가 startup에 빌드하는 연결 설정이라 런타임에 바꾸려면 전 워커를 재접속시켜야 한다 — interval/stale(리퍼가 매 tick 읽는 값)과 본질이 다르다. 기존 readonly 설정(`trace_body_cap_bytes`·`scheduler_tick_seconds`)과 동일 버킷에 둬 "산재 config 한 화면" 취지(ADR-0039)는 충족하되 변경은 막는다. 효과 값과 표시 값의 단일 소스 = `args.pool_keepalive_seconds`(h2 config 인자이자 readonly 시드).

2. **`stale ≤ interval`은 건강한 상태를 파괴하므로 하드블록(R5)**. 리퍼는 매 `interval`마다 sweep하고, 워커의 `last_seen`은 그 ping에 대한 pong으로만 갱신된다 → 임의 sweep 시점에 건강한 워커의 `last_seen` 나이 ≈ `interval`. `stale ≤ interval`이면 stale 체크(`age > stale`)가 건강한 워커에 발화 → idle은 evict→stream close→reconnect→재등록→다음 sweep 또 evict(매 interval **flap**), busy는 `pool_disconnect`가 `worker_disconnected`로 라우팅해 **진행 중 run을 falsely failed**. "느린 하트비트" 트레이드오프가 아니라 유용한 영역이 없는 오설정이라 비차단 경고로는 약하다 → PUT 400 하드블록. jitter(RTT+처리) 여유로 `stale ≥ 2×interval` 권장은 비차단 힌트(R6)로 분리(약간 위 영역은 위험하지만 합법).

3. **교차필드 검사는 generic settings 경로를 안 더럽히고 격리(R5)**. 기존 `validate(key,value)`(순수, range만)는 그대로 두고, PUT 핸들러가 두 하트비트 키에 한해 sibling의 현재 유효값(`state.settings.pool_*` 타입 accessor)과 비교하는 별도 검사를 추가 — 일반 cross-field 프레임워크가 아니라 2키 타깃 가드. 리퍼·대시보드·교차검사가 모두 같은 타입 accessor(`pool_heartbeat_interval_seconds()`/`pool_stale_timeout_seconds()`, 기존 `worker_capacity_vus()` 6종 미러)를 써 단일 소스(R2/R3).

4. **D1 `try_send` skip-on-Full은 자가치유라 안전(R8)**. 워커는 상시 `forward_inbound` 펌프로 inbound를 드레인하므로 `Full`은 워커가 안 읽는(wedged) 신호 → last_seen이 안 갱신돼 다음 sweep stale evict + h2 keepalive가 죽은 *연결*을 teardown. 그래서 Full에서 즉시 evict하지 않고 skip해도 결국 정리된다(과민 evict 회피). `Closed`만 현 dead-tx 의미대로 즉시 evict. **신규 evict 로직 0** — 분기만 `is_err()` → `try_send` match로.

5. **제어 mutation은 fire-and-forget이라 실패가 증발(R11/R12)**. 현 `RowActions`는 `patch.mutate(...)` 직후 동기 `closeAll()`·`onError` 없음 → 404(워커 사라짐)·네트워크 실패가 무증상. `SettingsPage`의 검증된 패턴(`mutate(arg, {onSuccess: clearX, onError: setRowError})` + `role="alert"` 인라인)을 재사용 — 새 토스트 primitive 0(코드베이스 일관·사용자 결정). 다이얼로그/모달이 있는 4액션은 그 안에 인라인(실패 시 열린 채 retry/cancel), undrain만 호스트가 없어 페이지 배너.

6. **CLI 시드는 range-check를 우회한다 — clamp/검증이 load-bearing(R9·R5c)**. `SettingsState::build`는 `db_overrides`만 `[min,max]`로 clamp하고(`settings.rs:170-186`) `cli_seeds`는 verbatim 통과시킨다. 그래서 레지스트리 `min:1`은 DB 오버라이드 0만 막을 뿐 `--pool-heartbeat-interval-seconds 0` 시드는 통과(R9 `.max(1)` clamp가 tight-loop 차단의 유일 방어), 마찬가지로 `stale_seed ≤ interval_seed` 시드도 통과(R5c startup clamp가 flapping 차단). 둘 다 "min이 이미 막는다"고 제거하면 안 됨.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/settings.rs` — 충족 R: R1, R4, R7
- `SETTINGS`에 3행 추가: `pool_heartbeat_interval_seconds`(mutable·min 1·max 3600·unit "초"·default 10)·`pool_stale_timeout_seconds`(mutable·min 2·max 86400·unit "초"·default 30)·`pool_keepalive_seconds`(mutable=false·min 0·max `i64::MAX`·unit "초"·default 20, 기존 readonly 행 `trace_body_cap_bytes`/`scheduler_tick_seconds` 패턴).
- **`group`은 기존 enum 재사용(`Group::Limits`) — 신규 variant 금지.** `SettingsPage`는 `group`이 아니라 `mutable`/`readonly`로 행을 분할하므로(`group`은 DTO 메타데이터·미렌더) `Group` enum에 `Pool`을 추가하면 UI Zod `SettingSchema.group` enum(`limits/test_run/scheduler`)까지 건드리는 불필요한 seam이 생긴다. 3행 모두 `Group::Limits`로 두면 additive-only(R14 SettingSchema 무변경).
- 타입 accessor 2종 추가(기존 `worker_capacity_vus()` 미러): `pub fn pool_heartbeat_interval_seconds(&self) -> u64 { self.get("pool_heartbeat_interval_seconds") as u64 }`, `pool_stale_timeout_seconds()` 동형. keepalive는 readonly라 accessor 불요(startup에서 CLI 인자 직접 사용).
- `build()`는 무변경(일반 시드 경로가 새 키를 자동 처리) — `cli_seeds`에 3키 추가는 main.rs(§4.5).

### 4.2 `crates/controller/src/api/settings.rs` — 충족 R: R5(a,b)
- 공유 헬퍼 `check_heartbeat_pair(interval: u64, stale: u64) -> Result<(), String>`(`settings.rs` 또는 핸들러 모듈) — `stale <= interval`이면 한국어 Err("stale 타임아웃은 ping 주기보다 커야 합니다 (먼저 stale를 올리세요)"). PUT·DELETE 둘 다 호출(단일 소스).
- **PUT** 핸들러: `validate(&key, value)?` 통과 후, 편집 키가 두 하트비트 키 중 하나면 *결과 쌍*으로 `check_heartbeat_pair` —
  - `pool_heartbeat_interval_seconds` 편집: `check_heartbeat_pair(value, settings.pool_stale_timeout_seconds())`.
  - `pool_stale_timeout_seconds` 편집: `check_heartbeat_pair(settings.pool_heartbeat_interval_seconds(), value)`.
  - Err면 400(`ApiError::BadRequest`, 서버 한국어 — `ko.ts` 아님; UI가 그대로 표시).
- **DELETE**(revert)도 교차검사 필요(reviewer FR2 — §4.2의 옛 "불요" 전제는 틀림): 시드로 되돌리면 *결과 쌍*이 sibling 현재 유효값과 `stale ≤ interval`이 될 수 있다(예: interval override 5 + stale override 8 상태에서 interval DELETE→시드 10 → 8 ≤ 10 위반). 편집 키가 하트비트 키면 revert 후 쌍(`key=시드, sibling=현재유효`)으로 `check_heartbeat_pair`, Err면 400(되돌리기 거부 + 안내). startup이 *시드 쌍 자체*는 valid 보장(§4.5)하나 *부분* revert는 여전히 위반 가능.

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R8, R10
- `pool_heartbeat_tick`의 `if tx.send(Ok(ping)).await.is_err() { pool_disconnect }` →
  ```
  match tx.try_send(Ok(ping)) {
      Ok(()) => {}
      Err(mpsc::error::TrySendError::Closed(_)) => self.pool_disconnect(&wid).await,
      Err(mpsc::error::TrySendError::Full(_)) => { /* backpressure: skip, stale-check + h2 keepalive 자가치유 */ }
  }
  ```
- 스냅샷/락 규율(R14)·stale evict 분기·`pool_disconnect` 라우팅은 무변경(R10). 시그니처 `(now, stale)` 유지(리퍼가 fresh stale 주입 — §4.5).

### 4.4 `crates/controller/src/api/pool.rs` — 충족 R: R3
- `GET /api/pool/workers` 응답 빌더가 `state.heartbeat_interval_seconds`/`state.stale_timeout_seconds`(제거됨) 대신 `state.settings.pool_heartbeat_interval_seconds()`/`pool_stale_timeout_seconds()`를 읽어 `heartbeat_interval_seconds`/`stale_timeout_seconds` 응답 필드에 실음(필드 자체 무변경 — UI Zod 0-diff).

### 4.5 `crates/controller/src/main.rs` + `app.rs` — 충족 R: R2, R3, R4, R5(c), R7, R9
- `app.rs`: `AppState`에서 `heartbeat_interval_seconds`/`stale_timeout_seconds` 두 필드 **제거**(컴파일러-driven, **≈50 literal 사이트** — 필드 선언 1[`app.rs`] + 프로덕션 세터 1[`main.rs`] + src test-fixture 2[`runs.rs`·`schedule/runner.rs`] + `tests/*.rs` ~43; 정확 split은 빌드가 확정). `api/pool.rs`의 *reader*는 §4.4에서 settings accessor로 교체(DTO 필드 `heartbeat_interval_seconds`/`stale_timeout_seconds`는 응답에 유지). `settings: SettingsState`는 유지.
- `main.rs` 시드 계산(2a): 3 CLI 플래그 유지. `cli_seeds` 구성 전 **R5(c) startup clamp** — `let interval_seed = args.pool_heartbeat_interval_seconds; let stale_seed = if args.pool_stale_timeout_seconds <= interval_seed { tracing::warn!(interval=interval_seed, stale=args.pool_stale_timeout_seconds, "stale ≤ interval 시드 — interval+1로 clamp"); interval_seed + 1 } else { args.pool_stale_timeout_seconds };` 그 뒤 `build`의 `cli_seeds`에 `("pool_heartbeat_interval_seconds", interval_seed as i64)`·`("pool_stale_timeout_seconds", stale_seed as i64)`·`("pool_keepalive_seconds", args.pool_keepalive_seconds as i64)`(R1/R4/R7). clamp는 display==effective 유지(silent 아님·`warn!` 라우드, [[load-divergence-explain-confirm]] 정신). build()는 seed range-check 안 함(§3.6)이라 이 clamp가 시드쌍 유일 startup 방어.
- 리퍼 spawn(behavior-change, 2b): 현 클로저는 `coord` clone + `interval`/`stale` Duration만 캡처 → **추가로 `state.settings.clone()` 캡처**(`SettingsState: Clone`, `settings.rs:144`). 루프 본체를 `tick.tick().await`(`tokio::time::interval`+`MissedTickBehavior::Skip`) → 매 iteration `let interval = settings.pool_heartbeat_interval_seconds(); let stale = settings.pool_stale_timeout_seconds();` fresh 재읽기 + `tokio::time::sleep(Duration::from_secs(interval.max(1)))`(R9) 후 `pool_heartbeat_tick(now, Duration::from_secs(stale))`(R2). catch-up 불요라 sleep-per-iter로 충분.
- h2 keepalive: 서버 두 arm·worker Endpoint 무변경 — 여전히 `args.pool_keepalive_seconds`(R4 transport-baked).

### 4.6 `ui/src/pages/SettingsPage.tsx` + `ui/src/i18n/ko.ts` — 충족 R: R6, R13
- 새 mutable 행 2개·readonly 행 1개는 generic `mutable`/`readonly` 분할이 자동 렌더(`SettingsPage`는 `group`이 아니라 `mutable`/`readonly`로 분할 — §4.1). `ko.opsSettings.label/desc/effect`에 3키 추가.
- **R6 표시는 *페이지 레벨*에 렌더(C2/F2)** — `MutableRow`는 자기 `s`/`draft`만 받아 sibling을 못 보므로, 두 하트비트 값을 둘 다 봐야 하는 표시는 `MutableRow` 밖, mutable `<ul>` 직후 페이지-레벨 note 영역에 둔다(`SettingsPage`는 `settings`+`drafts` 보유). ① **2× 여유 경고**(R6a): 현재 interval/stale(draft 우선, 없으면 value)로 `stale < 2×interval`이면 `ko.opsSettings.heartbeatMarginHint` 비차단 표시(저장 무관). ② **적용 시점 안내**(R6b/F2): 페이지 상단 전역 `applyNote` 배너("다음 run부터 적용")는 하트비트 키엔 틀리다(R2=다음 sweep 즉시) → 하트비트 전용 note `ko.opsSettings.heartbeatApplyNote`("진행 중인 풀에 다음 하트비트 점검부터 즉시 적용")를 같은 페이지-레벨 영역에 둬 전역 배너 오해 정정.
- 정리(reviewer nit): `SettingsPage.tsx:147`의 `{/* R12 — apply-note banner */}` 주석은 *ops-config* spec의 R-id 잔재(이 spec에서 R12는 WorkerDashboard undrain 배너) — 이 task에서 정정/제거해 R-id 혼동 방지.

### 4.7 `ui/src/pages/WorkerDashboardPage.tsx` + `ui/src/i18n/ko.ts` — 충족 R: R11, R12, R13
- `ConfirmDialog`/`EditModal`에 optional `error?: string | null`·`pending?: boolean` prop 추가 — `error`면 본문 아래 `role="alert"` 빨간 줄, `pending`이면 proceed/apply 버튼 비활성+"처리 중…".
- `RowActions`: 다이얼로그별 로컬 `actionError` state. 4 dialog/modal 액션(drain·exclude·capacity·label)의 `mutate`를 `{ onSuccess: closeAll, onError: (e) => setActionError(e.message) }`로 — 동기 `closeAll()` 제거(실패 시 열린 채). 다이얼로그 열 때/cancel 시 `actionError` 리셋. `pending`은 `patch.isPending`/`exclude.isPending`.
- undrain(메뉴-직접): 페이지 레벨 콜백 `onActionError(msg)`로 — `WorkerDashboardPage`가 `bannerError` state + 테이블 위 dismissible 배너(`role="alert"` + 닫기 버튼) 렌더. undrain `mutate`에 `{ onError: (e) => onActionError(e.message) }`.
- **신규 `ko.workers.*` 키(net-new — 기존 카탈로그에 없음, reviewer 확인)**: `actionError(msg)`(에러 fallback 문구·`e.message` 래핑)·`bannerDismiss`(배너 닫기 aria-label)·`pending`("처리 중…"). RTL `getByRole(...,{name})` 셀렉터가 이 키들에 lock.

---

## 5. 무변경 / 불변식 (명시)

- **proto·engine·worker·migration 0**(R14) — 이미 존재하는 `Ping`/`Pong`(L6 활성)·`settings` 테이블(0017)·`PoolWorkersResponse` DTO를 재사용. 새 와이어 메시지/컬럼 0.
- **keepalive 동작 byte-identical**(R4) — h2 keepalive는 여전히 CLI 인자로 startup 고정, 추가로 표시만.
- **워커 클라이언트 keepalive(20s 상수, `worker-core/src/client.rs:111-113`)는 안 건드림**(R4/R14·F1) — readonly 표시는 컨트롤러 서버측 설정만 반영, 워커 상수 변경은 worker 0-diff 위반이라 의도적 범위 밖(비기본 keepalive 시드 시 표시값≠워커 협상값은 알려진 한계).
- **DB 오버라이드 0 상태 byte-identical**(R7) — interval/stale 유효값 = CLI 시드 = L6 cadence/evict 임계값.
- **제어 mutation 성공 경로 무변경**(R11) — 성공 시 기존대로 `closeAll()` + `invalidateQueries`(hooks의 onSuccess). 변경은 실패 경로(에러 표면화)만.
- **`pool_heartbeat_tick` 시그니처/락 규율/terminal 가드 무변경**(R10) — Ping 전송 한 줄만 `try_send`로.
- **L3~L5 capacity 가드·L7 제어 3필드(drain/override/label) 의미 무변경** — 이 슬라이스는 임계값 소스·전송 방식·에러 표시만 건드림.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `settings.rs` 단위: `registry_is_single_source` 확장(3키)·새 키 range/mutable; GET `/api/settings` 통합에 3행 | |
| R2 | 라이브: `/settings` interval 변경 → 리퍼 로그 간격 변화(다음 sweep) | ✅ |
| R3 | 통합(in-process `pool_api` 하니스): settings PUT 후 `GET /api/pool/workers` 임계값 갱신; `grep -c` AppState 필드 0 | |
| R4 | 통합: GET `/api/settings` keepalive `source:"readonly"`·value==컨트롤러 CLI; 라이브 `/settings` 변경불가 표시 | ✅ |
| R5 | 통합(`api/settings` 테스트): PUT interval≥stale→400·stale≤interval→400·유효순서 200 | |
| R6 | RTL(`SettingsPage.test`): `stale<2×interval` 경고 노출·`≥` 미노출 | |
| R7 | 단위: 3키 시드 폴백(오버라이드 0→시드); 라이브 오버라이드 0 cadence 동일 | ✅ |
| R8 | 단위(가상시계 `pool_heartbeat_tick`): Full tx→entry 잔존·Closed tx→evict | |
| R9 | 단위: interval clamp(0)→1·(5)→5 | |
| R10 | 기존 가상시계 단위 try_send 갱신 후 green + busy evict→worker_disconnected | |
| R11 | RTL(`WorkerDashboardPage.test`): mutation reject(`vi.fn().mockRejectedValue`)→다이얼로그/모달 내 에러·잔존; resolve→닫힘 | |
| R12 | RTL: undrain reject→페이지 배너·닫기 동작 | |
| R13 | `grep` 인라인 영어 0 + RTL accessible-name(에러 region) | |
| R14 | `git diff --stat` 경로 한정·proto/engine/worker 0-diff | |

- **라이브 검증 필수**(R2/R7·R4 표시): 리퍼 interval 재읽기·spawn은 **main-only 와이어링**(통합/e2e 미커버 — L6/scheduler 노트)이라 실 controller+풀 2워커로 검증. `/live-verify` 스택 + 짧은 임계값(interval 2s/stale 6s)으로 cadence(R2)·evict·오버라이드 0 byte-identical(R7)·keepalive readonly 표시(R4) 관찰. **R3·R5는 in-process 통합으로 충분**(라이브 불요). ③ 제어 에러(R11/R12)는 RTL로 충분 — 같은 라이브 세션에서 강제 실패(범위밖 capacity·404 exclude)로 인라인/배너 1회 곁들이면 좋으나 게이트 아님.

---

## 7. 의도적 연기 (roadmap §현재 상태 LAN 항목에 누적)

- **DB 영속 제어상태**(L7 연기 그대로): drain/override/label은 여전히 in-memory(컨트롤러 재시작 시 소실). 영속하려면 안정 worker_id + migration 필요 — 별도 슬라이스.
- **스케줄러 config(tick/tz/disabled) 런타임 가변화**(ops-config §7): 다른 서브시스템(스케줄러)·tz 런타임 재설정은 추가 설계 필요. 이번 범위 밖(사용자 결정).
- **제어 mutation 성공 토스트/낙관적 UI**: 이번엔 에러 표면화만(성공은 기존 invalidate 새로고침). 성공 피드백 토스트는 토스트 primitive 도입 시.
- **일괄 제어 동작·예약 drain·자동 stale exclude·mTLS**: L1–L7 연기 그대로.
- **리퍼 interval `MissedTickBehavior` 정밀화**: sleep-per-iter로 단순화(catch-up 불요) — 정밀 tick 보정은 불요.

---

## 8. 구현 순서 (plan 입력)

이 repo는 cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼·RED-only 단독 커밋 불가, green fold 필요. 제안 task 경계:

1. **settings 레지스트리 3행 + accessor 2종 + `check_heartbeat_pair` PUT/DELETE 가드**(R1/R4/R5a,b/R7) — `settings.rs`(레지스트리·accessor `pool_heartbeat_interval_seconds()`/`pool_stale_timeout_seconds()`·`check_heartbeat_pair`·단위) + `api/settings.rs`(PUT·DELETE 교차검사·통합). 한 green 커밋. (accessor를 먼저 깔아야 2a/2b가 쓴다.)
2. **(2a, 순수 리팩터·byte-identical) AppState 2필드 제거 + 대시보드 settings 소스 + 3 시드 배선 + R5c startup clamp**(R3/R5c/R7/R14 일부) — `app.rs`(2필드 제거, 50 literal) + `api/pool.rs`(settings accessor 읽기) + `main.rs`(3 시드 + clamp). 리퍼는 아직 args Duration 사용(미변경) → 동작 byte-identical. 한 green 커밋(50-site churn을 동작 변경과 분리, mid-task truncation 위험↓).
3. **(2b, 동작 변경) 리퍼 try_send + interval clamp + settings 재읽기**(R2/R8/R9/R10) — `coordinator.rs`(try_send·가상시계 단위 갱신) + `main.rs`(리퍼 클로저 `settings.clone()` 캡처·sleep-per-iter 재읽기). 한 green 커밋.
4. **`/settings` UI 3행 + 페이지-레벨 2× 경고 + 하트비트 적용 안내**(R6/R13) — `SettingsPage.tsx`·`ko.ts`. UI 게이트.
5. **`/workers` 제어 에러 인라인 + undrain 배너**(R11/R12/R13) — `WorkerDashboardPage.tsx`·`ko.ts`. UI 게이트.

> Task 1–3은 cargo, 4·5는 UI — UI task는 test 파일 편집을 src보다 먼저(tdd-guard, ui CLAUDE.md). Task 3(2b)의 리퍼 재읽기/spawn은 main-only라 통합/e2e 미커버 → §6 라이브 필수(R2/R7). ③(Task 5)은 RTL-only로 충분(라이브 게이트 아님).
