# 데스크톱 부하기 모드 2b (설치 ID·접속 코드·셸) Implementation Plan

<!-- REVIEW-GATE: APPROVED -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설치판 앱의 「모드 전환」 화면에서 서버의 접속 코드를 복사·붙여넣어 부하기로 합류하고, 부하기 PC가 자기 연결 상태(연결 중·대기·실행 중·다시 시도 중·제외됨·끊김)를 보며, 부하기 ID가 설치마다 하나가 되게 한다.

**Architecture:** 접속 코드·설치 ID·설정 칸은 `crates/desktop-core`의 순수 함수(게이트 안 nextest). 셸(`desktop/src-tauri`)은 `ShellState`에 컨트롤러 실행(`running`)과 별개로 부하기 실행(`worker: Option<WorkerRun>`)을 두고, 2a의 `handicap_worker::run_pool_desktop` + `pool_status::StatusTracker`로 상태를 메모리에 유지한다. 역할 전환은 지금 `switch`의 정지 → 시작 → 저장 골격을 `switch_with(설정 편집)`으로 일반화해 부하기 접속·끊기·다시 접속이 같은 길을 탄다. `role.html`이 새 IPC로 코드 복사·코드 검사·대상 확인·상태 화면을 그린다.

**Tech Stack:** Rust(Tauri v2, tokio, tokio-util `CancellationToken`), `handicap-worker`(2a `run_pool_desktop`·`pool_status`), controller `in-process`, 정적 HTML/JS(`role.html` + jsdom 점검), React/TS(Vitest·RTL).

**Spec:** `docs/superpowers/specs/2026-11-17-desktop-worker-mode-design.md` — 이 plan은 **2b 절(R0b·R1·R2·R5·R6·R7·2b 검증)**과 §7 「2b plan」 순서, roadmap §B65 (3) 첫 항(`aborted` 사유 화면 표시)·(4) 보안 연기 D1–D4를 구현한다. 2a 코드(`crates/worker-core/src/pool_status.rs`, `crates/worker/src/lib.rs` `run_pool_desktop`)는 무변경.

## Global Constraints

- 설정 `version: 1` 유지, 칸만 더한다: `role: "worker"`, `worker{code, connected}`, 최상위 `install_id`. 1차 파일(이 칸들 없음)은 기본값으로 읽힌다. (R0b)
- migration·REST·proto 추가 0. 2a 크레이트(`worker`·`worker-core`·`controller`·`engine`) 무변경.
- 접속 코드는 **비밀**: `role_state`·로그(`eprintln!`)·`Debug`에 없다. 요청형 IPC(`connect_code`) 응답에만. 코드 해석 오류 문구는 입력을 되풀이하지 않는다. (R2·D4)
- 서버가 보낸 글자(시나리오 이름·거절 사유·run id)는 `role.html`에서 `textContent`로만, `<bdi>` 안에, `overflow-wrap: anywhere`. `innerHTML` 금지. (D1)
- 부하기 상태 화면의 「연결됨」 주소는 코드의 목록이 아니라 `PoolEvent::Accepted{addr}`의 실제 주소. (D3)
- 부하기 용량 1000(1차 `SELF_WORKER_CAPACITY_VUS`), 정지 대기 상한 5초(1차 `SELF_WORKER_STOP_TIMEOUT`), 상태 화면 폴링 1초.
- 설치 ID = OS CSPRNG 128비트 소문자 hex 32자(1차 `generate_token` 재사용). 쓸 수 있는 ID = 32–64자 ∧ ASCII 영숫자(상한 64는 이 plan의 판단 — 손으로 고친 거대한 값이 워커 ID로 서버에 가지 않게). 아니면 조용히 새로 만든다. (R1)
- 서버 「이 PC도 부하 내기」와 부하기 역할 워커 모두 `worker_id = install_id`. 서버 자기 부하기는 지금처럼 `run_pool_until`(루프백, 탐침 불필요 — 2a spec R4 「2b가 결정」: 바꾸지 않음).
- 「PC 이름을 읽지 못해 쓸 수 없습니다」(`MSG_NO_HOSTNAME`)와 `self_worker_unavailable`은 사라진다(R0b 의도된 차이 ②).
- desktop 크레이트는 게이트 밖: 커밋 전 `just ui-build`(워크트리에 `ui/dist` 없으면 1회) 후 `cd desktop/src-tauri && cargo fmt && cargo build && cargo clippy -- -D warnings && cargo test`. PostToolUse 포맷 훅이 edition 2024로 재정렬하므로 `cargo fmt`가 마지막 편집 뒤에 와야 한다. desktop은 tdd-guard·spec-review-guard 대상 밖이라 테스트 먼저 순서는 각 task가 스스로 지킨다.
- 워크스페이스(`crates/`)·`ui/` 변경은 pre-commit 게이트가 돈다. 커밋은 FOREGROUND 600000ms 단일 호출, `| tail` 금지, `--no-verify` 금지. `git add`는 그 task의 Files 경로만.
- `role.html`을 고친 task는 `node desktop/tests/role-page.check.cjs` → 마지막 줄 `ALL PASS`, exit 0.

## Review Focus

1. **실행 중인 부하기에서 「접속 끊기」** → 확인 창(「실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다」), 확인하면 서버 run이 `aborted` + R8 사유("worker <id> stopped mid-run — run aborted…"), 저장 `connected:false` — Task 4 `disconnect_while_running_aborts_run_with_r8_message` + Task 6 jsdom 확인 창 경우.
2. **실행 중에 서버 「제외」** → 상태 「제외됨」(유예의 「연결됨 · 대기」 아님), `connected:false` 저장, 앱을 다시 켜도 재접속 안 함 — Task 4 `exclusion_shows_excluded_and_saves_disconnected` + `boot_worker_disconnected_starts_nothing`.
3. **앱 시작 시 저장된 코드가 깨짐**(손으로 고침·다른 버전) → 컨트롤러도 부하기도 없이 역할 화면, 「접속 끊김」 + 안내 「저장된 접속 코드를 읽지 못했습니다 — 새 코드를 붙여넣어 주세요」 — Task 4 `boot_worker_unreadable_code_shows_notice`.
4. **메신저가 앞뒤에 공백·줄바꿈을 붙인 코드 / 공격자가 루프백·메타데이터 주소를 넣은 코드** → 앞은 받아들이고 뒤는 형식 오류 — Task 1 `trims_surrounding_whitespace`·`rejects_disallowed_target_ips`.
5. **부하기 역할에서 상태 조회·로그에 코드나 토큰이 새는 것** → `role_state` JSON에 없음 — Task 5 `role_state_never_contains_code_or_token`.

---

### Task 0: 세 인스턴스 스파이크 (orchestrator 직접, 코드 무변경)

**목적:** spec 2b 검증 「같은 맥에서 데스크톱 앱 세 인스턴스」가 가능한지와 computer-use 조작 가능 범위를 실측. 결과가 Task 7(라이브) 방식을 정한다.

**STOP 조건(구현 진입 전 사용자 확인):** ⓐ 같은 번들 실행 파일을 env만 달리해 세 번 띄우면 둘째 이후가 안 뜨거나 첫 창을 앞으로 가져오기만 함 ⓑ 세 창 중 하나를 골라 클릭·입력할 수 없음(겹친 창을 옮길 수도 없음). ⓑ만이면 STOP 대신 「부하기 쪽 조작은 사용자 확인」으로 Task 7을 고쳐 적고 사용자에게 알린다.

**Files:** 없음(커밋 없음). 기록 `.superpowers/sdd/desktop-worker-mode-2b-spike.md`(커밋 금지).

- [ ] **Step 1: 번들** — `just ui-build && cd desktop/src-tauri && cargo tauri build --debug --bundles app`. Expected: `target/debug/bundle/macos/Handicap.app/Contents/MacOS/desktop` 존재.
- [ ] **Step 2: 세 인스턴스** — 스크래치 디렉터리 `s/`·`w1/`·`w2/`를 만들고 `s/desktop-role.json`에 `{"version":1,"role":"server","server":{"token":null,"grpc_port":8081,"self_worker":true}}`. 각각 `HANDICAP_DESKTOP_CONFIG_DIR=<dir> HANDICAP_DB=<dir>/h.db <번들 실행 파일>`을 `run_in_background`로(먼저 `lsof -nP -iTCP:8081 -sTCP:LISTEN`이 비었는지 읽는다). Expected: 프로세스 3개 생존(`pgrep -fl "Handicap.app/Contents/MacOS/desktop"`), 서버 인스턴스 로그에 gRPC `0.0.0.0:8081`.
- [ ] **Step 3: 조작** — `request_access(["com.handicap.desktop"])` 뒤 screenshot으로 창 셋을 확인, 제목 표시줄 드래그로 겹친 창을 옮겨 셋 다 보이게, 각 창에서 「모드 전환」 링크 클릭이 그 창에만 반영되는지. 끝나면 `pkill -f "Handicap.app/Contents/MacOS/desktop"`(이 패턴이 다른 세션 프로세스를 잡지 않는지 `pgrep -fl`로 먼저 읽는다).
- [ ] **Step 4: 기록** — STOP 해당 여부, 창 배치 방법, 걸린 함정을 기록 파일에. ⓐⓑ 해당 시 사용자에게 보고하고 대기.

---

### Task 1: desktop-core 접속 코드 (R2 형식·해석기, D2)

**Files:**
- Create: `crates/desktop-core/src/code.rs` (인라인 `#[cfg(test)]`)
- Create: `crates/desktop-core/examples/connect_code.rs` (라이브 검증용 코드 생성기)
- Modify: `crates/desktop-core/src/lib.rs` (`pub mod code;`)

**Interfaces:**
- Produces:
  - `pub struct ConnectCode { pub ips: Vec<Ipv4Addr>, pub port: u16, pub token: String }` — `Clone, PartialEq`, `Debug`는 손으로(token `[REDACTED]`).
  - `pub fn encode(c: &ConnectCode) -> String` — 검사 없이 그대로 만든다(호출자가 `is_allowed_target_ip`로 거르고 `MAX_CODE_IPS`로 자른다).
  - `pub fn decode(raw: &str) -> Result<ConnectCode, CodeError>`
  - `pub enum CodeError { Format, UnknownVersion }` — `Debug, Clone, Copy, PartialEq, Eq` + `Display`: `Format` = `"접속 코드 형식이 아닙니다"`, `UnknownVersion` = `"접속 코드 형식이 아닙니다 — 앱 버전이 다를 수 있습니다"`.
  - `pub fn is_allowed_target_ip(ip: Ipv4Addr) -> bool` — 거절: 첫 옥텟 0(0.0.0.0/8)·루프백·링크로컬·멀티캐스트·브로드캐스트.
  - `pub const MAX_CODE_IPS: usize = 16; pub const MAX_CODE_LEN: usize = 4096; pub const MAX_CODE_TOKEN_LEN: usize = 256;`

**형식(이 plan이 고정):** `HANDICAP1-` + 페이로드의 소문자 hex. 페이로드 = `[n: u8][IPv4 4바이트 × n][port: u16 BE][token 길이: u16 BE][token ASCII 바이트][CRC-32 IEEE(앞 전부) u32 BE]`. CRC는 코드 안 비트 단위 구현(다항식 `0xEDB88320`, 새 의존성 없음 — CRC-32는 32비트 이하 연속 오류를 전부 잡으므로 hex 한 글자(4비트) 변조는 반드시 걸린다). 해석 순서: `raw.len() > MAX_CODE_LEN` → `Format` → `trim()` → `HANDICAP`로 시작 안 함 → `Format` → 그 뒤 `-` 앞까지가 ASCII 숫자 1글자 이상이 아니면 `Format`, `"1"`이 아니면 `UnknownVersion` → hex 해석(대소문자 무관, 홀수 길이·비hex → `Format`) → CRC 불일치·길이 불일치(남는 바이트 포함) → `Format` → `n ∈ 1..=16`·`port ≠ 0`·`is_usable_token(token) ∧ token.len() ≤ 256`·모든 IP `is_allowed_target_ip` 아니면 `Format`.

- [ ] **Step 1: 실패하는 테스트** (`code.rs` `mod tests`)
  - `crc32_known_vector`: `crc32(b"123456789") == 0xCBF43926`.
  - `round_trip_one_and_sixteen_ips`: IP 1개(`192.168.0.12`)·16개(`10.0.0.1`..`10.0.0.16`), port 8081, token `"ab".repeat(16)` → `decode(&encode(c)) == Ok(c)`; `encode` 결과가 `"HANDICAP1-"`로 시작하고 나머지가 소문자 hex.
  - `every_single_char_change_is_rejected`: 위 1개짜리 코드의 **모든 위치** i에 대해 그 글자를 다른 글자로 바꾼 코드(본문 hex 자리는 **값이 다른** hex 숫자 — 대문자로 바꾸기는 같은 값이라 변조가 아니다(본문 대소문자 무관), 접두 자리는 `'X'`)가 `Err(_)`. 버전 숫자 `1`→`2`는 `Err(UnknownVersion)`.
  - `truncation_is_rejected`: 본문을 끝에서 1·2·8글자 자른 코드 → `Err(Format)`.
  - `trims_surrounding_whitespace`: `format!("  \n{code}\r\n\t")` → `Ok`; 가운데 공백 하나 끼운 코드 → `Err(Format)`.
  - `uppercase_body_is_accepted`: 본문만 대문자로 → `Ok(같은 값)`.
  - `unknown_version_and_bad_prefix`: `"HANDICAP2-00"` → `UnknownVersion`; `"HANDICAP-00"`·`"HANDICAPx-00"`·`"handicap1-…"`·`""` → `Format`.
  - `length_cap`: `MAX_CODE_LEN + 1`바이트 입력(유효 코드 + 공백 패딩) → `Format`.
  - `rejects_bad_fields`: 손으로 만든 페이로드(테스트 헬퍼 `raw_code(bytes)`가 CRC를 붙여 hex로)로 — IP 0개·17개·port 0·token 31글자·token에 `;`·token 257글자·남는 바이트 1개 → 전부 `Format`. token 256글자는 `Ok`.
  - `rejects_disallowed_target_ips`: `127.0.0.1`·`0.0.0.0`·`0.1.2.3`·`169.254.169.254`·`224.0.0.1`·`255.255.255.255` 중 하나라도 들어간 코드 → `Format`; `8.8.8.8`(사설 아님)은 `Ok`(경고는 화면 몫).
  - `debug_redacts_token`: `format!("{c:?}")`에 토큰 없음·`[REDACTED]` 있음.
  - `error_display_never_echoes_input`: 토큰이 든 유효 코드의 한 글자를 바꾼 입력의 `decode(..).unwrap_err().to_string()`에 그 토큰·입력 문자열이 없음.
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-desktop-core code::` → 컴파일 실패(함수 없음).
- [ ] **Step 3: 구현** — 위 Interfaces·형식대로. `encode`/`decode`의 바이트 배치는 공통 상수 없이 함수 안에서(헬퍼 `crc32(&[u8]) -> u32`는 `pub(crate)`).
- [ ] **Step 4: 예제** — `examples/connect_code.rs`: 인자 `<ip,ip,…> <port> <token>` → `encode` 결과를 stdout 한 줄(검사 없음 — 라이브에서 토큰만 다른 코드를 만들 때 씀). 인자 개수가 틀리면 사용법 한 줄을 stderr, exit 2.
- [ ] **Step 5: GREEN** — `cargo nextest run -p handicap-desktop-core` 전체 PASS + `cargo run -q -p handicap-desktop-core --example connect_code -- 192.168.0.12 8081 $(printf 'ab%.0s' {1..16})` 출력이 `HANDICAP1-`로 시작.
- [ ] **Step 6: 커밋** — `feat(desktop-core): 부하기 접속 코드 형식·해석기(검사값·대상 IP 거절)`

### Task 2: desktop-core 설정 — 부하기 역할·설치 ID (R0b·R1·R6 설정)

**Files:**
- Modify: `crates/desktop-core/src/config.rs`

**Interfaces:**
- Consumes: `token::generate_token`.
- Produces:
  - `pub enum Role { Local, Server, Worker }`
  - `#[derive(Clone, PartialEq, Default)] pub struct WorkerSettings { pub code: Option<String>, pub connected: bool }` — `Debug`는 손으로(code `Some` → `"[REDACTED]"`).
  - `DesktopConfig`에 `pub worker: WorkerSettings`, `pub install_id: Option<String>` 추가(`Default` = 둘 다 기본).
  - `pub fn is_usable_install_id(s: &str) -> bool` — 32–64바이트 ∧ 전부 ASCII 영숫자.
  - `pub fn ensure_install_id<R: rand::RngCore + rand::CryptoRng>(c: &mut DesktopConfig, rng: &mut R) -> String` — 쓸 수 있으면 그대로, 아니면 `generate_token`으로 바꿔 넣고 그 값을 돌려준다.
- 직렬화: `"role": "worker"`, `"install_id": <str|null>`, `"worker": {"code": <str|null>, "connected": <bool>}`. 해석: `worker`·`install_id` 칸이 없거나 타입이 틀리면 칸마다 기본값(경고 없음 — `server` 칸과 같은 규칙). `install_id`는 문자열이면 형식과 무관하게 그대로 읽는다(고치는 것은 `ensure_install_id` 몫).

- [ ] **Step 1: 테스트 먼저** — 기존 `unknown_role_is_local_with_warning_keeping_server_settings`의 역할 문자열을 `"worker"` → `"robot"`으로(이제 `worker`는 아는 역할). 새 테스트:
  - `worker_round_trip`: `Role::Worker` + `worker{code: Some("HANDICAP1-ab"), connected: true}` + `install_id: Some("ab".repeat(16))` → `parse(serialize(c)) == c`, 경고 없음.
  - `first_version_file_reads_with_defaults`: 1차 모양 `{"version":1,"role":"server","server":{"token":"…","grpc_port":8093,"self_worker":false}}` → `worker == WorkerSettings::default()`·`install_id == None`·경고 없음.
  - `worker_role_string_parses`: `{"version":1,"role":"worker"}` → `Role::Worker`, 경고 없음, `connected == false`.
  - `wrong_typed_worker_fields_default`: `"worker":{"code":5,"connected":"yes"}`·`"install_id":7` → 기본값, 경고 없음.
  - `debug_redacts_worker_code`: code에 `"HANDICAP1-deadbeefdeadbeef"`를 둔 `DesktopConfig`·`WorkerSettings`의 `Debug`에 `deadbeef` 없음·`[REDACTED]` 있음, `code: None`이면 `code: None`.
  - `install_id_rules`: `is_usable_install_id` — `"a".repeat(31)`✗ `"a".repeat(32)`✓ `"a".repeat(64)`✓ `"a".repeat(65)`✗ `""`✗ `"가".repeat(32)`✗ 32글자 중 `-` 하나✗.
  - `ensure_install_id_keeps_or_replaces`: 쓸 수 있는 값은 그대로 반환·불변; `None`·`Some("")`·`Some("short")`이면 새 32글자 소문자 hex로 바뀌고 반환값 == 저장값; 두 번 부르면 같은 값.
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-desktop-core config::` → 실패.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN** — `cargo nextest run -p handicap-desktop-core` 전체 PASS.
- [ ] **Step 5: 커밋** — `feat(desktop-core): 설정에 부하기 역할·접속 코드·설치 ID 칸`

> desktop 크레이트는 이 시점에 `Role::Worker` 미처리 `match`로 빌드가 깨진다 — Task 3이 고친다. Task 2 커밋 뒤 Task 3 전까지 desktop 빌드를 시도하지 않는다(게이트 밖).

### Task 3: 셸 구조 — 실행 갈래·설치 ID·서버 자기 부하기 ID (R1·R6 구조)

**Files:**
- Modify: `desktop/src-tauri/src/role.rs`
- Modify: `desktop/src-tauri/src/commands.rs` (`Role::Worker` 매핑·`self_worker_unavailable` 제거 — DTO 추가는 Task 5)
- Modify: `desktop/src-tauri/src/config_store.rs` (tests `server_cfg` 구조체 리터럴에 새 칸 — `..DesktopConfig::default()`)

**Interfaces:**
- Consumes: Task 2 `Role::Worker`·`ensure_install_id`.
- Produces (Task 4·5가 씀):
  - `pub enum Started { Controller(Running), Nothing }` — `start_running`의 새 반환형(`Result<Started, String>`). 이 task에선 `Role::Worker` 갈래가 임시로 `Ok(Started::Nothing)`(Task 4가 실제 시작으로 바꾸고 `Worker(WorkerRun)` 변형·`ShellState.worker`를 더한다).
  - `fn install(st: &mut ShellState, s: Started)` — `Controller(r)` → `st.running = Some(r)`, `Nothing` → `st.running = None`.
  - `boot`의 성공 반환값: `Controller(r)` → `r.base_url`, `Nothing` → `launch::role_page_url()`.
  - `pub async fn switch_with<F>(shell: &Shell, edit: F) -> Result<(), String> where F: FnOnce(&mut DesktopConfig) -> Result<(), String>` — **첫 잠금 블록 안에서** `switching` 검사 뒤 `let mut attempt = st.config.clone(); edit(&mut attempt)?;`(실패면 아무것도 멈추지 않고 그 `Err` — `switching`도 세우지 않는다) → 그다음 지금 `switch`의 몸통(`switching = true`·take → 정지 → 문 → `start_running(attempt)` → 실패 시 `restore_after_failure` → 저장). `pub async fn switch(shell, target: Role)` = `switch_with(shell, |c| { c.role = target; Ok(()) })`(시그니처 유지 — 기존 테스트 무수정).
  - 서버 역할 전용 안내 정리 조건: 지금 `if target == Role::Local` → `if attempt.role != Role::Server`(부하기로 가도 지운다). `start_error` 세우기 조건 `target == Role::Server` → `attempt.role == Role::Server`.
- 설치 ID: `start_running`의 `Role::Server` 갈래가 `self_worker` 토글과 **무관하게 항상** `ensure_install_id(config, &mut OsRng)`(spec R1 「처음 서버 … 역할로 시작할 때」)로 ID를 얻고, 토글이 켜져 있으면 `spawn_self_worker(shell, actual, &token, id)`. hostname 검사·`MSG_NO_HOSTNAME`·`Notices.self_worker_unavailable` 삭제. `set_self_worker(true)`도 `ensure_install_id(&mut st.config, …)` 값 사용(바뀌었으면 그 뒤 `persist`가 같이 저장). `Env.hostname`은 남긴다(Task 5가 화면 표시에 씀).

- [ ] **Step 0: 컴파일 수선** — Task 2 뒤 desktop은 `Role::Worker` 미처리 `match`(`commands.rs:61`·`role.rs:188`)·구조체 리터럴(`config_store.rs` tests `server_cfg`, `role.rs` tests `server()`, `commands.rs` tests `server_state_with_token`)로 빌드가 깨져 있다. `Started`·`install`·`boot` 반환값·`Role::Worker => Ok(Started::Nothing)`·`"worker"` 매핑·리터럴 `..DesktopConfig::default()`만 넣어 `cd desktop/src-tauri && cargo test`가 **기존 테스트 전부 green**인 상태를 먼저 만든다(커밋하지 않음 — Step 5에 함께). 이래야 Step 2의 RED가 컴파일 실패가 아니라 새 테스트의 실패다.
- [ ] **Step 1: 테스트 먼저** (`role.rs` tests)
  - 헬퍼 `self_worker_registered`가 `"test-host"` 대신 **그 셸의 `config.install_id`**를 찾도록 바꾼다(`run_then_stop`의 배정 대기도 같은 값).
  - `self_worker_registers_with_hostname` → `self_worker_id_is_install_id`: 등록 후 `self_worker.worker_id == config.install_id.unwrap()`, `is_usable_install_id`, 저장 파일의 `install_id`도 같은 값.
  - `empty_hostname_skips_self_worker` → `empty_hostname_still_runs_self_worker`: hostname `String::new`로도 자기 부하기가 등록된다.
  - `install_id_survives_role_round_trip`: 서버 boot → ID a → 혼자 쓰기 → 서버 → 다시 등록한 자기 부하기 ID == a.
  - `local_boot_does_not_create_install_id`: 혼자 쓰기 boot 뒤 `install_id == None`.
  - `broken_install_id_is_replaced`: 설정 `install_id: Some("x")`로 서버 boot → 새 32글자 ID, 저장됨.
- [ ] **Step 2: RED** — `cd desktop/src-tauri && cargo test role::` → 위 새 테스트가 단언 실패(컴파일은 Step 0으로 통과).
- [ ] **Step 3: 구현** — Interfaces대로. `boot`·`switch_with`·`restore_after_failure`는 `Started`를 받아 `install`로 설치. `commands.rs`에서 `self_worker_unavailable` 칸·안내 문구 관련 코드와 테스트 단언을 제거(키 목록 테스트에서도 뺀다).
- [ ] **Step 4: GREEN** — desktop 게이트(Global Constraints) 전부 PASS.
- [ ] **Step 5: 커밋** — `refactor(desktop): 역할 시작을 실행 갈래로, 자기 부하기 ID = 설치 ID`

### Task 4: 셸 부하기 역할 — 시작·상태·끊기·다시 접속·제외·종료 (R5 상태·R6)

**Files:**
- Modify: `desktop/src-tauri/src/role.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`Env` 생성에 `code_ips_override: None`)
- Modify: `desktop/src-tauri/src/commands.rs` (tests `state()`의 `Env`에 같은 칸)

**Interfaces:**
- Consumes: Task 1 `decode`·`ConnectCode`, Task 2 `WorkerSettings`·`ensure_install_id`, Task 3 `Started`·`switch_with`·`install`, 2a `handicap_worker::{run_pool_desktop, PoolTarget}`·`handicap_worker::pool_status::{StatusTracker, PoolEvent, PoolState, EventSink}`.
- Produces (Task 5가 씀):
  - `pub struct WorkerRun { pub generation: u64, pub parent: CancellationToken, pub handle: JoinHandle<()>, pub tracker: Arc<std::sync::Mutex<StatusTracker>>, pub servers: Vec<SocketAddr>, pub worker_id: String }` — `servers` = 코드의 `ip:port`(「연결 중」 표시용, 비밀 아님).
  - `Started::Worker(WorkerRun)` 변형과 `ShellState.worker: Option<WorkerRun>`(초기 `None`); `install`이 `Worker(w)` → `st.worker = Some(w)`·`running = None`, `Controller` → `worker = None`, `Nothing` → 둘 다 `None`.
  - `pub fn worker_state(w: &WorkerRun, now: Instant) -> Option<PoolState>` — 핸들이 끝났는데 추적기 상태가 `Excluded`가 아니면 `None`(= 끊김), 아니면 `Some(tracker.state(now))`.
  - `pub async fn connect_worker(shell: &Shell, code: String) -> Result<(), String>` = `switch_with(|c| { decode(&code).map_err(|e| e.to_string())?; c.role = Worker; c.worker.code = Some(code); c.worker.connected = true; Ok(()) })` — 해석 실패면 아무것도 멈추지 않고 그 문구로 `Err`.
  - `pub async fn disconnect_worker(shell) -> Result<(), String>` = `switch_with(|c| { 부하기 역할 아님 → Err(MSG_NOT_WORKER); c.worker.connected = false; Ok(()) })`.
  - `pub async fn reconnect_worker(shell) -> Result<(), String>` = `switch_with(|c| { 부하기 역할 아님 → Err(MSG_NOT_WORKER); 저장된 code가 `decode` 안 됨(없음 포함) → Err(MSG_CODE_UNREADABLE); c.worker.connected = true; Ok(()) })` — 역할 검사·해석이 `switch_with` 첫 잠금 안에서 일어나므로 검사와 전환 사이에 틈이 없고, 깨진 코드로 「다시 접속」을 눌러도 아무것도 바뀌지 않는다.
  - `pub const MSG_NOT_WORKER: &str = "부하기 모드에서만 쓸 수 있습니다";`
  - `restore_after_failure`: 이전 역할이 부하기인데 그 시작도 실패하면 혼자 쓰기로 떨어지지 않고 **부하기 역할 + 아무것도 안 돌림**(`Started::Nothing`, 메모리 config `connected` 그대로 — 저장 안 함)으로 되살린다. 혼자 쓰기 강제 복구는 이전 역할이 서버일 때만(지금 동작).
  - `pub const MSG_CODE_UNREADABLE: &str = "저장된 접속 코드를 읽지 못했습니다 — 새 코드를 붙여넣어 주세요";`
  - `Notices.worker_code_unreadable: bool`.
  - `Env.code_ips_override: Option<Vec<Ipv4Addr>>` — **테스트 전용**(운영 `None`): 있으면 해석한 코드의 IP 대신 이 목록으로 접속(코드 해석기가 루프백을 거절하므로 테스트 컨트롤러에 닿기 위함). `Env`를 만드는 곳 전부(`lib.rs`, `role.rs` tests `build`·`failed_switch_restoring_server_on_new_port_persists_it`, `commands.rs` tests `state`)에 칸 추가.
- 동작:
  - `start_running`의 `Role::Worker`: `connected == false` → `Ok(Started::Nothing)`. `connected` ∧ 코드 해석 실패(없음 포함) → `Err(MSG_CODE_UNREADABLE)`. 성공 → `ensure_install_id` → `spawn_desktop_worker(shell, code, id)` → `Ok(Started::Worker(..))`, `notices.worker_code_unreadable = false`.
  - `spawn_desktop_worker`: 세대 번호(`NEXT_GENERATION` 공유), `parent` 토큰, 사건 받는 쪽 `Arc::new(move |ev| tracker.lock().unwrap_or_else(|e| e.into_inner()).apply(&ev, Instant::now()))`, `PoolTarget{ ips: override 또는 code.ips, port, token, worker_id: id, capacity_vus: SELF_WORKER_CAPACITY_VUS }`를 `run_pool_desktop(target, parent.clone(), sink)`로 spawn. 그 태스크는 반환 뒤 추적기 상태가 `Excluded`이면 `on_worker_excluded(shell, generation)` — 현재 세대일 때만 `config.worker.connected = false` + `persist`(`st.worker`는 그대로 둬 「제외됨」이 보이게). 에러 반환은 `eprintln!("desktop: 부하기가 에러로 끝남: {e:#}")`(타깃·코드 덤프 금지).
  - 정지: `stop_worker(w)` = `parent.cancel()` → `SELF_WORKER_STOP_TIMEOUT` bounded 대기, 초과 시 abort(`stop_self_worker`와 같은 모양). `switch_with`의 정지 단계는 `st.running.take()`(→ `stop_running`)와 `st.worker.take()`(→ `stop_worker`)를 **둘 다** 꺼내 정지. `shutdown`도 둘 다.
  - `boot`: 역할이 부하기 ∧ `connected` ∧ 저장된 code가 `decode` 안 되면 **`start_running`을 부르기 전에** `notices.worker_code_unreadable = true`로 두고 `Ok(launch::role_page_url())`(아무것도 돌지 않음 — 문자열 비교로 에러를 가르지 않는다). 그 밖의 부하기 역할 boot는 `start_running` → `Worker`/`Nothing` → 역할 화면 주소. `install_id`가 새로 생겼으면 지금처럼 저장.
  - 안내 정리: `switch_with` 성공 시 `attempt.role != Worker`이거나 `attempt.role == Worker ∧ connected`이면 `worker_code_unreadable = false`(다른 역할 화면에 부하기 안내가 남지 않게).
  - 설치 시점 제외: `install`(boot·`switch_with` 마지막 잠금)이 `Worker(w)`를 넣을 때 `w.handle.is_finished()` ∧ 추적기 상태 `Excluded`이면(설치 전에 제외가 도착해 감시 블록의 세대 검사가 빗나간 경우) 그 자리에서 `config.worker.connected = false`로 두고 저장한다. `install`은 `st.config`에 새 config를 넣은 **뒤**에 부른다 — boot·`switch_with`·복구 경로 모두(앞에서 부르면 뒤따르는 `st.config = attempt`가 `connected:true`로 덮어써 재시작 때 다시 붙는다).

- [ ] **Step 1: 테스트 먼저** (`role.rs` tests). 공통 헬퍼: `pool_controller(token) -> RunningController`(`run_in_process` 풀 모드, gRPC `127.0.0.1:0`, 자체 임시 DB), `worker_cfg(port, token, connected) -> DesktopConfig`(역할 부하기, 코드 = `encode(ConnectCode{ips:[10.255.0.1], port, token})`, `server.grpc_port = free_port()` — 서버로 전환하는 테스트가 8081을 잡지 않게), 셸 env `code_ips_override = Some(vec![127.0.0.1])`, `wait_state(s, pred)`(5초 폴링으로 `worker_state`).
  - `boot_worker_starts_worker_without_controller`: boot → `Ok(url)`가 `role.html`로 끝남, `running.is_none()`, `worker.is_some()`, 상태가 `Idle{addr}`(addr 포트 = 컨트롤러 gRPC 포트), 컨트롤러 `pool_workers()`에 `install_id`가 있음, `install_id` 저장됨.
  - `boot_worker_disconnected_starts_nothing`: `connected:false` → 둘 다 `None`, `Ok(role page)`, 컨트롤러 풀에 없음.
  - `boot_worker_unreadable_code_shows_notice`: `connected:true`, code `"HANDICAP1-zz"` → `Ok(role page)`, 둘 다 `None`, `notices.worker_code_unreadable`, 저장 파일의 code는 그대로.
  - `connect_worker_from_local_stops_controller_and_saves`: 혼자 쓰기 boot → `connect_worker(code)` → `running.is_none()`·`Idle`, 저장 = 역할 부하기·그 code·`connected:true`.
  - `connect_worker_rejects_bad_code_without_switching`: 혼자 쓰기 boot → `connect_worker("nope")` = `Err("접속 코드 형식이 아닙니다")`, 역할·컨트롤러 그대로, 저장 무변화.
  - `disconnect_then_reconnect`: 부하기 boot(Idle) → `disconnect_worker` → `worker.is_none()`·저장 `connected:false`·컨트롤러 풀에서 사라짐(5초 안) → `reconnect_worker` → `Idle`·`connected:true`.
  - `disconnect_while_running_aborts_run_with_r8_message`: 부하기 Idle → 컨트롤러 REST로 `spawn_target(Some(100ms))`를 치는 run(vus 1, 60s) 생성 → 상태 `Running{run_id,..}`(run_id == 만든 run) → `disconnect_worker` → 그 run 행 `status == "aborted"`, `message`가 `"stopped mid-run — run aborted"`를 포함. (`spawn_target`·`run_then_stop`의 시나리오/run 생성 코드를 헬퍼로 뽑아 재사용.)
  - `exclusion_shows_excluded_and_saves_disconnected`: 부하기 Idle → `POST /api/pool/workers/{install_id}/exclude` body `{}` → 상태 `Excluded`(5초 안), 저장 `connected:false`, `worker`는 `Some`(끝난 핸들).
  - `switch_from_worker_to_server_stops_worker`: 부하기 Idle → `switch(Role::Server)` → `worker.is_none()`·`running` 풀 모드·저장 역할 서버, 테스트 컨트롤러 풀에서 사라짐.
  - `wrong_token_retries_with_auth_failed`: 코드 토큰을 컨트롤러와 다른 32글자로 → 상태 `Retrying{reason: AuthFailed, ..}`(5초 안).
  - `shutdown_stops_worker_within_bound`: 부하기 Idle → `shutdown` 6초 안에 끝남 → `worker.is_none()`.
  - `connect_while_switching_is_rejected`: 문(gate)으로 멈춘 전환 중 `connect_worker` → `Err("이미 전환 중입니다")`.
  - `reconnect_with_unreadable_code_does_not_switch`: 부하기 + `connected:true` + 깨진 code로 boot(안내 상태) → `reconnect_worker` = `Err(MSG_CODE_UNREADABLE)`, 역할 부하기·`running`·`worker` 둘 다 `None` 그대로(혼자 쓰기로 떨어지지 않음).
  - `failed_worker_start_restores_worker_nothing_not_local`: 부하기 `connected:false` boot(성공, 아무것도 안 돎) **뒤에** `s.state.lock().await.env.fail_start = Some(Role::Worker)`(boot 전에 세우면 `start_running` 첫머리 검사 `role.rs:185`가 boot부터 실패시킨다) → `reconnect_worker` = `Err` → 역할 부하기·둘 다 `None`(혼자 쓰기 컨트롤러 없음).
  - `change_code_while_connected_moves_to_new_server`: 테스트 컨트롤러 A·B(토큰 다름) → A 코드로 부하기 Idle → `connect_worker(B 코드)` → A 풀에서 `install_id` 사라지고 B 풀에 나타남(5초 안), 저장 code = B 코드.
  - `worker_reboot_keeps_install_id`: 같은 설정 디렉터리로 부하기 셸 boot → ID a 등록 → `shutdown` → 새 셸(같은 디렉터리) boot → 컨트롤러 풀에 같은 a.
  - `leaving_worker_clears_unreadable_notice`: 깨진 code 안내 상태에서 `switch(Role::Local)` → `notices.worker_code_unreadable == false`.
- [ ] **Step 2: RED** — `cd desktop/src-tauri && cargo test role::` → 실패.
- [ ] **Step 3: 구현** — Interfaces·동작대로. 잠금 규칙(desktop/CLAUDE.md): spawn·정지·대기는 잠금 밖, 잠금 안에선 `take()`·설치·저장만. 사건 받는 쪽은 std `Mutex`만 잡는다(셸 `tokio` 잠금 금지 — 동기 콜백).
- [ ] **Step 4: GREEN** — desktop 게이트 PASS.
- [ ] **Step 5: 커밋** — `feat(desktop): 부하기 역할 — 코드로 접속·상태 추적·끊기·다시 접속·제외`

### Task 5: 셸 IPC — 상태 DTO·접속 코드·코드 검사·부하기 명령 (R2 서버 쪽·R7)

**Files:**
- Modify: `desktop/src-tauri/src/commands.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`generate_handler!`에 새 명령)

**Interfaces:**
- Consumes: Task 1 `encode`·`decode`·`is_allowed_target_ip`·`MAX_CODE_IPS`, Task 4 `worker_state`·`connect_worker`·`disconnect_worker`·`reconnect_worker`·`Notices.worker_code_unreadable`.
- Produces (role.html과 1:1 — Task 6이 씀):
  - `RoleStateDto` 변경: `role` 값에 `"worker"`; 추가 `install_id: Option<String>`, `hostname: String`(`Env.hostname()`), `worker: Option<WorkerStatusDto>`(역할이 부하기일 때만 `Some`); `self_worker_unavailable` 없음(Task 3). `NoticesDto`에 `worker_code_unreadable: bool`.
  - `WorkerStatusDto { state: &'static str, servers: Vec<String>, addr: Option<String>, run_tail: Option<String>, scenario_name: Option<String>, reason: Option<&'static str>, reason_detail: Option<String>, retry_in_secs: Option<u64> }`. `state` ∈ `connecting|idle|running|retrying|excluded|disconnected`, `reason` ∈ `unreachable|auth_failed|rejected|protocol`(rejected일 때만 `reason_detail`).
  - `pub fn worker_status_from(state: Option<&PoolState>, servers: &[SocketAddr], now: Instant) -> WorkerStatusDto` — 순수. `None` → `disconnected`. `run_tail` = run_id의 끝 6글자(char). `retry_in_secs` = `retry_at - now`의 올림 초(지났으면 0). `servers` = `ip:port` 문자열. `build_role_state`의 출처: `st.worker`가 있으면 `worker_status_from(worker_state(w, now).as_ref(), &w.servers, now)`, 없으면 `worker_status_from(None, <저장된 코드가 해석되면 그 주소들, 아니면 빈 목록>, now)`.
  - `pub fn connect_code_for(s: &ShellState, ips: &[Ipv4Addr]) -> Result<String, String>` — 서버 역할 아님 → `"서버 모드에서만 만들 수 있습니다"`; 후보(`candidate_ipv4s(ips)` → `is_allowed_target_ip` 거름 → 앞 16개) 0개 → `"이 PC의 망 주소를 찾지 못했습니다"`; 토큰 `is_usable_token` 아님 → `"접속 토큰이 없습니다"`; 아니면 `encode`(포트 = `config.server.grpc_port`).
  - `#[derive(Serialize)] pub struct CodePreviewDto { pub ips: Vec<String>, pub port: u16, pub non_private: bool }`, `pub fn preview_code(raw: &str) -> Result<CodePreviewDto, String>`(토큰 없음).
  - IPC(전부 첫 문장 `require_shell`): `connect_code()`(서버 실행 중 아님 → `"서버가 실행 중이 아닙니다"`), `check_code(code: String)`, `connect_worker(code: String)`, `disconnect_worker()`, `reconnect_worker()`. `dismiss_notice` kind에 `"worker_code_unreadable"`. `parse_target`은 계속 `local`·`server`만(부하기는 코드가 필요해 `connect_worker`로만).
- [ ] **Step 1: 테스트 먼저** (`commands.rs` tests)
  - `worker_status_mapping`: `Connecting`·`Idle`·`Running{run_id:"01HX…ABCDEF", scenario_name:Some("결제")}`(→ `run_tail "ABCDEF"`)·`Running{run_id:"abc", None}`(→ `"abc"`)·`Retrying{AuthFailed, now+1500ms}`(→ `retry_in_secs 2`)·`Retrying{Rejected("x"), now-1s}`(→ `0`, `reason_detail "x"`)·`Excluded`·`None`(→ `disconnected`) 각각 필드 단언.
  - `role_state_worker_fields`: 부하기 역할 상태(워커 없음, 저장 code 유효) → `role "worker"`, `worker.state "disconnected"`, `worker.servers == ["10.255.0.1:8081"]`, `hostname`·`install_id` 채움; 서버 역할이면 `worker == None`.
  - `role_state_never_contains_code_or_token`: 부하기 역할 + code(토큰 `"deadbeef".repeat(4)`) + 서버 토큰(`"cafebabe".repeat(4)`) → `serde_json::to_string(&build_role_state(..))`에 `deadbeef`·`cafebabe`·`HANDICAP1-` 없음(기존 `role_state_never_contains_token` 유지).
  - `role_state_json_keys_match_role_html`: 키 목록 갱신(`install_id`·`hostname`·`worker` 추가, `self_worker_unavailable` 제거) + notices `worker_code_unreadable` + **부하기 역할 픽스처**로 `worker` 객체 키 8개.
  - `connect_code_rules`: 혼자 쓰기 → 거절; IP 없음·루프백만 → `"이 PC의 망 주소를 찾지 못했습니다"`; 토큰 `"tok"` → `"접속 토큰이 없습니다"`; IP 20개(10.0.0.1–20) → `decode(코드).ips.len() == 16`, 앞 16개 순서 유지, 포트 8093·토큰 일치.
  - `preview_code_hides_token`: 유효 코드 → `ips`·`port`, `non_private == false`(사설) / `8.8.8.8` 코드 → `true`; JSON에 토큰 없음; 잘못된 코드 → `Err("접속 코드 형식이 아닙니다")`.
  - `dismiss_clears_each_kind`에 `worker_code_unreadable` 추가.
- [ ] **Step 2: RED** — `cd desktop/src-tauri && cargo test commands::` → 실패.
- [ ] **Step 3: 구현** — `role_state` 명령은 잠금 안에서 `build_role_state`(부하기 상태는 `Instant::now()`로). `connect_code`는 `list_local_ipv4s()` 후 잠금 안에서 `connect_code_for`. `connect_worker`·`disconnect_worker`·`reconnect_worker`는 `role::` 함수 위임(잠금은 그쪽이 관리).
- [ ] **Step 4: GREEN** — desktop 게이트 PASS.
- [ ] **Step 5: 커밋** — `feat(desktop): 부하기 상태·접속 코드·코드 검사 IPC`

### Task 6: 「모드 전환」 화면 — 접속 코드 복사·부하기로 접속·부하기 상태 (R2 화면·R5·R6 확인 창, D1)

**Files:**
- Modify: `desktop/src/role.html`
- Modify: `desktop/tests/role-page.check.cjs`

**Interfaces:**
- Consumes: Task 5 DTO·명령 이름 그대로.
- 화면(문구는 이 표 그대로 — spec R2·R5·R6):

| 요소 id | 내용 |
|---|---|
| `#mode` | 부하기 역할: 「현재 모드: 부하기 (서버가 보내는 테스트를 실행합니다)」 — 부하기 역할에선 `app_url` 없이도 보인다 |
| `#switch` | 부하기 역할: 「혼자 쓰기로 돌아가기」 |
| `#switch-server` (새) | 부하기 역할에서만: 「서버로 열기」 |
| `#server` 안 새 칸 | 제목 「부하기 PC 접속 코드」, `#code`(한 줄 말줄임 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`), `#code-copy` 「복사」 + `#code-copy-msg`(1차 `copyMsg`와 같은 피드백), `#code-err`(connect_code 오류 문구 그대로), 안내 「부하기 PC의 앱에서 「모드 전환」 → 「부하기로 접속」에 붙여넣으세요 — 같은 버전의 앱이어야 합니다」 |
| `#cmd-box` (새 `<details>`, 기본 닫힘) | summary 「명령으로 붙이기 (포터블 exe·터미널)」 — 1차의 IP 라디오·`#no-ip`·OS·명령·복사·OS 안내를 그 안으로. `#ip-public`·`#plaintext`·`#sw`·`#firewall`은 밖 |
| 포트 변경 안내 | 「… 로 열었습니다 — 부하기들에 새 접속 코드(또는 명령)를 주세요」 |
| `#join` (새 `<details>`, 기본 닫힘) | 혼자 쓰기·서버·부하기 모든 역할. summary: 부하기 역할 「다른 접속 코드로 바꾸기」, 그 밖 「부하기로 접속」. 안: `#code-in`(textarea, `aria-label="접속 코드"`), 안내 「서버 PC의 「모드 전환」 화면에서 복사한 접속 코드를 붙여넣으세요」, `#join-btn` 「부하기로 접속」, `#join-err` |
| `#worker` (새, 부하기 역할만) | `#w-state`, `#w-detail`, `#w-ident` 「이 PC: <hostname> · 워커 ID <install_id>」(작게 — `install_id`가 `null`이면 「이 PC: <hostname>」만), `#w-disconnect` 「접속 끊기」(connecting·idle·running·retrying), `#w-reconnect` 「다시 접속」(excluded·disconnected, 단 `servers`가 비면 숨김 — 읽을 코드가 없으면 `#join`으로) |
| 부하기 안내 | `notices.worker_code_unreadable` → 「저장된 접속 코드를 읽지 못했습니다 — 새 코드를 붙여넣어 주세요」(닫기 kind `worker_code_unreadable`) |

- `#w-state`/`#w-detail` 문구: connecting 「서버에 연결하는 중…」 / `servers` 「, 」 연결 · idle 「연결됨 · 대기 중」 / `addr` · running 「테스트 실행 중」 + (`scenario_name` 있으면 「 · 」+이름) + 「 · #」+`run_tail` / `addr` · retrying 「다시 시도 중 — 」+이유 / 「N초 뒤 다시 시도」(`retry_in_secs`가 0이면 「다시 시도하는 중…」 — 추적기는 다음 시도가 끝날 때까지 직전 실패를 유지한다, `pool_status.rs` `last_fail`) · excluded 「서버에서 제외됨 — 서버 「워커」 화면에서 제외했습니다」 · disconnected 「접속 끊김」. 이유: unreachable 「서버에 연결할 수 없습니다 — 서버 PC가 켜져 있고 서버 모드인지, 방화벽이 막지 않는지 확인해 주세요」 / auth_failed 「접속 코드의 토큰이 맞지 않습니다 — 서버 화면에서 새 코드를 받아 주세요」 / rejected 「서버가 접속을 거절했습니다: 」+`reason_detail` / protocol 「서버와 통신하지 못했습니다 — 두 PC의 앱 버전이 같은지 확인해 주세요」. 서버 글자(`scenario_name`·`run_tail`·`reason_detail`·`addr`·`servers`)는 `<bdi>` 요소의 `textContent`로; `#w-state, #w-detail, #w-ident { overflow-wrap: anywhere; }`.
- 확인 창 일반화: `askConfirm(lines: string[], okLabel: string)` — `#confirm-text`를 `<p>`에서 `<div>`로 바꾸고(`aria-labelledby` 유지 — `<p>` 안 `<p>`는 잘못된 HTML) 줄마다 `<p>`(textContent)로 채우고 `#confirm-ok` 글자를 `okLabel`로. 1차 전환 확인은 `askConfirm(["실행 중인 테스트 N개가 중단됩니다"], "중단하고 전환")`(기존 점검 문자열 그대로 통과).
- 흐름:
  - `#join-btn`: `check_code({code})` 실패 → `#join-err`에 오류 문자열, 끝. 성공 → 줄 = [「이 서버에 부하기로 접속합니다: 」 + `ips.map(ip+":"+port).join(", ")` + 「 — 이 서버가 보내는 테스트를 이 PC가 실행합니다」] + (`non_private`면 「사설 망 주소가 아닙니다 — 회사 망 밖의 서버일 수 있습니다」) + (역할이 부하기가 아니면 「이 PC의 시나리오 화면·예약 실행·운영 모니터가 멈춥니다(다른 역할로 돌아오면 다시 켜집니다)」, 그리고 `active_run_count` > 0이면 「실행 중인 테스트 N개가 중단됩니다」) + (부하기 역할이고 최신 `role_state`의 `worker.state === "running"`이면 「실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다」) → `askConfirm(줄, "접속")` → 덮개 「부하기로 접속하는 중…」 + `connect_worker({code})` + `delay(600)` → 성공이면 `#code-in` 비우고 `#join` 닫음, 실패면 「전환하지 못했습니다: 」+사유.
  - 부하기 역할의 `#w-disconnect`·`#switch`·`#switch-server`: 먼저 `role_state`를 새로 읽어 `worker.state === "running"`이면 `askConfirm(["실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다"], 끊기면 "중단하고 끊기" / 전환이면 "중단하고 전환")`, 취소 = IPC 없음. 덮개 문구: 「접속을 끊는 중…」 / 「혼자 쓰기로 돌아가는 중…」 / 「서버 모드로 전환 중…」. `#w-reconnect`: 확인 없이 덮개 「다시 접속하는 중…」 + `reconnect_worker`.
  - 서버 역할: `ips.join(",") + "|" + grpc_port` 키가 바뀌거나 처음 그릴 때 `connect_code` 호출 → `#code`·`#code-copy` 활성/오류 표시(1차 `updateCommand`와 같은 경합 방지 키).
  - 폴링: 1초 간격 하나로 — 부하기 역할은 매 틱, 서버 역할·전환 중은 3틱마다(1차 3초 유지). 덮개·확인 창·토글 진행 중·숨김이면 건너뜀.
  - 코드 값(`#code`·`#code-in`)은 `console`·오류 줄에 쓰지 않는다.
- [ ] **Step 1: 점검 먼저** (`role-page.check.cjs`) — 가짜 invoke에 `connect_code`(→ `"HANDICAP1-" + "ab".repeat(40)`), `check_code`(state.preview 또는 reject `"접속 코드 형식이 아닙니다"`), `connect_worker`/`disconnect_worker`/`reconnect_worker`(state.after로 교체) 추가, `base()`에 `install_id`·`hostname`·`worker: null`·`notices.worker_code_unreadable:false` 추가, `self_worker_unavailable` 제거(해당 경우 블록 삭제). 새 경우:
  - 서버: `#code` 글자 = 가짜 코드, `#cmd-box`가 `open`이 아님, `#code-copy` 클릭 → jsdom 실패 문구; 포트 안내 새 문구; `connect_code` 거절(「이 PC의 망 주소를 찾지 못했습니다」) → `#code-err` 그 글자·`#code-copy` disabled.
  - 부하기 상태 6종 각각 `#w-state`·`#w-detail` 글자, 버튼 표시(`#w-disconnect`/`#w-reconnect`), `#back` 숨김, `#mode` 부하기 문구, `#switch`·`#switch-server` 글자, `#join` summary 「다른 접속 코드로 바꾸기」.
  - rejected 사유·시나리오 이름에 `<img src=x onerror=…>`를 넣어도 `#w-state` 안에 `img` 요소 0개, 글자 그대로 보임; 그 글자가 `bdi` 안.
  - 혼자 쓰기에서 잘못된 코드 → `#join-err` 「접속 코드 형식이 아닙니다」, `connect_worker` 호출 0.
  - 혼자 쓰기에서 좋은 코드(runs 2, non_private true) → 확인 창 줄 4개(대상·사설 아님·멈추는 것·「실행 중인 테스트 2개가 중단됩니다」) 글자 일치, ok 글자 「접속」; 취소 → `connect_worker` 0; 확인 → `connect_worker` 인자 `{code}` = 붙여넣은 값, 덮개 문구.
  - 부하기 running에서 `#w-disconnect` → 확인 창 한 줄 「실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다」·ok 「중단하고 끊기」; 취소 → `disconnect_worker` 0; 확인 → 1. 부하기 idle에서 `#w-disconnect` → 확인 창 없이 호출.
  - 부하기 running에서 `#switch-server` → 확인 창 ok 「중단하고 전환」 → 확인 → `switch_role {target:"server"}`.
  - excluded에서 `#w-reconnect` → `reconnect_worker` 호출, 확인 창 없음.
  - 부하기 역할 폴링이 ~1초: 로드 뒤 1.2초 동안 `role_state` 호출 ≥ 2. 서버 역할은 같은 1.2초 동안 로드 호출 1번뿐(3초 유지).
  - 다시 그려도 입력이 안 날아감: 부하기 역할에서 `#join`을 열고 `#code-in`에 글자를 넣은 뒤 1.2초(폴링 1회 이상) → 여전히 `open`, 값 그대로. 혼자 쓰기·서버 역할에서도 `refresh()` 한 번 뒤 같은 단언.
  - retrying `retry_in_secs: 0` → `#w-detail` 「다시 시도하는 중…」; `install_id: null` → `#w-ident` 「이 PC: <hostname>」; disconnected + `servers: []` → `#w-reconnect` 숨김.
  - 안내 `worker_code_unreadable` 문구 + 닫기 kind.
  - 어떤 호출 인자에도 `token` 키 없음(기존), `console` 출력(가상 콘솔 `log`/`error`)에 `HANDICAP1-` 없음.
- [ ] **Step 2: RED** — `node desktop/tests/role-page.check.cjs` → FAIL 다수.
- [ ] **Step 3: 구현** — 표·흐름대로. 확인 창·덮개는 지금처럼 `#app` 밖.
- [ ] **Step 4: GREEN** — `node desktop/tests/role-page.check.cjs` → `ALL PASS`, exit 0. desktop 게이트(빌드가 `role.html`을 번들) PASS.
- [ ] **Step 5: 커밋** — `feat(desktop): 「모드 전환」에 접속 코드 복사·부하기로 접속·부하기 상태 화면`

### Task 7: React UI — 제외 확인 문구·중단 사유 표시 (R0b ④·§B65 (3))

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`workers.excludeConfirmBody`, 새 `runDetail.abortReason: "중단 사유"`)
- Modify: `ui/src/pages/RunDetailPage.tsx:315-319`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`, `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`

**Interfaces:** 없음(화면만).
- `excludeConfirmBody` = 「이 워커를 풀에서 제외하고 워커 프로그램을 종료합니다. 다시 추가하려면 해당 PC에서 워커를 직접 재실행해야 합니다. 앱의 「부하기로 접속」으로 붙은 PC는 그 PC의 앱에서 「다시 접속」을 누르면 됩니다.」
- `RunDetailPage`: `status === "aborted"` ∧ 비지 않은 `message`면 `<Callout variant="warn" className="mb-4"><span className="font-semibold">{ko.runDetail.abortReason}:</span> {r.message}</Callout>`(failed 갈래·`role="alert"` 무변경).
- [ ] **Step 1: 테스트 먼저**
  - `RunDetailPage.test.tsx`: `shows aborted-run reason` — 기존 failed 경우 픽스처 모양으로 `status: "aborted"`, `message: "worker w0 stopped mid-run — run aborted (other workers stopped)"` → `await screen.findByText(/중단 사유/)`와 그 메시지 글자; `hides aborted reason when message is null` — `message: null` → `queryByText(/중단 사유/)` 없음(리포트 404 대기 뒤). 되돌려 확인(teeth check): `RunDetailPage.tsx` 변경 전 첫 테스트 RED 확인.
  - `WorkerDashboardPage.test.tsx`: 제외 확인 창을 연 기존 경우에 `expect(screen.getByText(/「다시 접속」을 누르면 됩니다/)).toBeInTheDocument()` 한 줄.
- [ ] **Step 2: RED** — `cd ui && pnpm test -- RunDetailPage WorkerDashboardPage` → 새 단언 FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN** — `cd ui && pnpm lint && pnpm test && pnpm build` PASS.
- [ ] **Step 5: 커밋** — `feat(ui): 중단된 run의 사유 표시, 제외 확인에 버튼 접속 PC 안내`

### Task 8: 라이브 검증 (orchestrator 직접 — Task 0 결과의 방식)

**Files:** 없음(기록 `.superpowers/sdd/desktop-worker-mode-2b-live.md`, 커밋 금지 — 결과 요약은 마무리 때 build-log).

- [ ] **Step 1: 번들** — Task 0 Step 1 명령(최신 코드). 서버 인스턴스 `S` + 부하기 `W1`·`W2`(각 설정 디렉터리·DB 분리, 같은 맥 = 같은 호스트 이름), 응답기 `/live-verify` 스킬의 latency 응답기(100ms).
- [ ] **Step 2: US1** — `S` 「서버로 열기」 → 접속 코드 「복사」 → `W1` 「부하기로 접속」 펼침·붙여넣기 → 확인 창에 대상(이 맥 LAN IP:8081)·멈추는 것 줄 → 「접속」 → `W1` 「연결됨 · 대기 중」+주소, `S` 「워커」 화면에 `W1` 줄. `S`를 혼자 쓰기 → 서버로 열기(15초 안) 동안 `W1`이 「연결 중」·「다시 시도 중」을 보이지 않음(1초 간격 screenshot 기록). run 1개 끝난 뒤에도 대기 유지.
- [ ] **Step 3: US2** — `W2`도 접속. run(vus 2, 60s) 중 `W1` 「테스트 실행 중 · <시나리오 이름> · #<끝 6자>」 → `W1` 「접속 끊기」 → 확인 창 → 「취소」 = 무변화(여전히 실행 중) → 다시 「접속 끊기」 → 확인 → `S` run `aborted` + 실행 화면 「중단 사유: worker … (other workers stopped)」, 응답기 요청 수가 멈춤(`W2` 부하 정지).
- [ ] **Step 4: US3** — 코드 한 글자 바꿔 붙여넣기 → 「접속 코드 형식이 아닙니다」. `S` 앱 종료 → `W1` 15초 뒤 「다시 시도 중 — 서버에 연결할 수 없습니다」 → `S` 다시 실행 → 손대지 않고 「연결됨 · 대기 중」. `connect_code` 예제로 토큰만 다른 코드 → 「다시 시도 중 — 접속 코드의 토큰이 맞지 않습니다…」(첫 실패부터 몇 초 안). `S` 「워커」 화면에서 `W1` 제외 → 「서버에서 제외됨…」 → `W1` 앱 재시작 → 「접속 끊김」, `S` 화면에 다시 안 나타남.
- [ ] **Step 5: US4** — `W1`·`W2` 모두 접속 → `S` 「워커」 화면 두 줄(같은 호스트 이름, 다른 워커 ID = 각자 `#w-ident` ID) → run → 두 줄 다 배정. `W2`에 「비우기」·라벨 → `W2` 앱 종료·재실행 → 같은 ID로 돌아오고 「비우기」·라벨 유지.
- [ ] **Step 6: 극단값** — 실제 앱: 시나리오 이름 80자(한글·공백 없는 영문 둘 다) run → `W1` 상태 줄과 `S` 워커 화면을 `getBoundingClientRect` 대신 screenshot + 창 폭 최소(사용자가 줄일 수 있는 폭)에서 잘림·겹침 확인. 실제로 만들 수 없는 값(거절 사유 200자·IP 16개 확인 창·32자 ID 옆 긴 PC 이름)은 Playwright(**WebKit 엔진** — Chromium보다 WKWebView에 가깝다)로 `role.html`을 `file://`에서 열고 jsdom 점검과 같은 가짜 `__TAURI_INTERNALS__`를 init script로 넣어 360px·760px 폭에서 `#w-state`·`#w-detail`·`#w-ident`·`#confirm-text` rect가 부모 안에 있고 서로 겹치지 않음을 측정(엔진이 WKWebView와 다르다는 한계를 기록에 적는다).
- [ ] **Step 7: 판정** — US1–US4 행마다 통과/실패와 증거를 기록. 실패는 고친 뒤 해당 행 재실행(고친 코드는 해당 task 범위의 새 커밋 + 그 task 테스트).

### Task 9: 문서 (R8 문서·§8)

**Files:**
- Create: `docs/adr/0058-desktop-worker-mode.md` (MADR — 접속 코드(복사 전용·`HANDICAP1-`+hex+CRC-32·대상 IP 거절)·설치 ID·in-process `run_pool_desktop` + 상태 통로·대안 기각(손 입력 PIN·자식 프로세스·컨트롤러 유지))
- Modify: `CLAUDE.md` 「알아둘 결정들」에 한 줄 `- **0058** 데스크톱 부하기 모드: 복사 전용 접속 코드(검사값) + 설치 ID + in-process 데스크톱 풀 루프 상태 화면`
- Modify: `docs/dev/lan-workers.md` §0 — 「부하기로 접속」 절차, 접속 코드는 비밀(토큰 포함 — 공개 채널 금지), 부하기 ID = 설치 ID(같은 PC가 명령 경로로 붙으면 다른 대), PC 이미지 복제 한계(「복제 전엔 서버·부하기로 켜지 말 것, 켰다면 `desktop-role.json`의 `install_id` 줄 삭제」), 이전 버전 앱으로 내렸다가 다시 올리면 설정 파일이 `install_id`·`worker` 칸 없이 다시 쓰여 새 ID가 된다(1차 직렬화기 `config.rs` `serialize_config`), 상태 문구 표, 제외 뒤 「다시 접속」.
- Modify: `desktop/CLAUDE.md` — 이 슬라이스에서 실제로 밟은 함정만(Task 0·8 기록에서; 없으면 추가 안 함).

- [ ] **Step 1: 작성** — 위 내용. `just doc-budget` PASS(WARN이면 root 한 줄을 줄인다).
- [ ] **Step 2: 커밋** — `docs: 데스크톱 부하기 모드 2b — ADR-0058·LAN 안내·셸 함정`

마무리(`/finish-slice`, 이 plan 밖): build-log 단락·root 상태줄·현황판·roadmap §B 새 블록(spec §5 판단 중 2b 몫·이 plan의 판단[설치 ID 상한 64·서버 자기 부하기 `run_pool_until` 유지·확인 창 비사설 문구·`code_ips_override` 테스트 전용 칸]·`HANDICAP_WORKER_TOKEN` 재연기 「명령 경로 토큰 노출이 보고될 때」·§B64 (3) 대기 목록에 「Windows 설치판 부하기 모드 → 맥 서버」·§8 (2b) 릴리즈 노트 줄 + 「서버의 「이 PC도 부하 내기」 부하기 ID가 PC 이름에서 설치 ID로 바뀌어, 워커 화면의 그 줄 라벨·「비우기」 설정이 한 번 초기화됩니다」)·보안 리뷰(필수 — 코드 운반·저장·표시, 해석기, 대상 확인, IPC 범위).
