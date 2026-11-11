# 지금 점검 (`r`) (tui-check-now) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 모니터에서 `r`을 누르면 주기를 기다리지 않고 **실제 점검**이 한 번 돌아 막대·상태·기록에 남고, 칸 설정에서 누르면 그 회차의 자세히 화면이 열린다.

**Architecture:** 컨트롤러 점검 루프(`unit_loop`)의 주기 대기에 깨우기 신호(`tokio::sync::Notify`)를 더하고, 감독자 `check_now` + REST `POST /api/monitor-boards/{id}/panels/{panel_id}/check-now`로 연다. TUI는 기존 조회 작업자로 그 길을 부르고, 결과를 머리 줄 알림(모니터) 또는 대기 창 → 1b 자세히 화면(칸 설정)으로 잇는다. 새 화면은 없다.

**Tech Stack:** Rust(edition 2024), tokio 1.52.3(`Notify::notify_waiters`), axum 0.8(`{…}` 경로), ratatui `TestBackend`, wiremock.

**Spec:** `docs/superpowers/specs/2026-11-11-tui-check-now-design.md` — **§2 동작 규칙 1–7, §3, §4가 정본**. 구현자는 자기 task가 가리키는 절을 반드시 읽는다. 이 plan과 spec이 다르면 **STOP**하고 보고(임의로 한쪽을 고르지 말 것).

spec·plan 모두 `spec-plan-reviewer` clean APPROVE(spec 3라운드, plan 2라운드 — 2026-11-11).

REVIEW-GATE: APPROVED

**US 블록(매 brief 첨부):** spec의 `## 사용자 스토리 (US)` 헤딩부터 다음 `## ` 헤딩 앞까지.

## Global Constraints

- 범위: `crates/controller`(`monitor/supervisor.rs`·`api/monitor_boards.rs`·`app.rs`) + `crates/tui` + 문서. **엔진·proto·DB(마이그레이션)·`ui/` 0-diff.**
- 깨우는 쪽은 **`notify_waiters()`만**(`notify_one()` 금지 — 허가가 저장되어 점검 중 요청이 다음 회차를 예약한다, spec 규칙 3).
- `kick.notified()`는 **결과를 버퍼에 넣기 전에** 만든다(spec §3.1 — 테스트로 지킬 수 없는 순서. 이유를 적은 주석 필수, 리뷰 초점).
- `check_now`는 **`existing_slot`만** 쓴다(모르는 id로 슬롯을 만들지 않는다).
- TUI 화면 문구는 **`text.rs` 상수만** — 서버 응답의 문자열을 화면·로그에 싣지 않는다(`Fetched::CheckNow`는 상태 코드만 든다).
- 새 문구는 spec §4.1 표와 **글자 그대로**. `ko.ts` 대응 없음(TUI 전용 — `mirrored_text_exists_in_ko_ts` 목록에 넣지 않는다).
- 대기 번호(`check_seq`)는 **`App` 필드**(프로세스 안에서 줄지 않음). `EditUi`에 두지 않는다.
- 각 task = 독립 green 커밋. 커밋·검증은 단일 FOREGROUND 호출, `| tail`/`| head` 금지, `--no-verify` 금지, 커밋 메시지는 `-F <파일>`.
- 줄 번호는 이 plan을 쓴 시점(`2c4fdba`) 값 — 편집 전에 `grep -n`으로 다시 확정한다.

## Review Focus

1. `unit_loop`: `notified()` 생성 위치(push 전)·`notify_waiters`·바닥 대기 순서(깨우기 수신 **뒤** `sleep_until(floor)`)·취소가 세 갈래 모두에서 즉시 먹는가. → Task 1 테스트 6개 + 이빨 실증 3개.
2. `check_now` 락: `view` 락을 푼 뒤 버퍼 락, 버퍼 락을 푼 뒤 `notify_waiters`. 겹쳐 잡지 않는다. → Task 2.
3. 응답 `last_at_ms`가 **항상 키로 존재**(`null` 직렬화). → Task 2 `contains_key` 단언.
4. TUI: 칸 설정에서 보낸 결과가 대기 번호로만 받아들여지는가(창을 닫은 뒤·다른 번호·모니터발 결과는 편집 상태 불변). → Task 5.
5. 자세히를 여는 시점: 화면이 **정확히** `Screen::Settings`일 때만(종료 확인창이 떠 있으면 미룸). → Task 5.
6. 자세히 `Esc`: 온 곳으로. `errors`가 없는 채 `Screen::Errors`로 가는 길이 없는가. → Task 5.
7. 머리 줄 알림 우선순위: 지금 점검 알림(5초) > 파일 알림, 5초 뒤 파일 경고 복귀. → Task 4.
8. 기존 동작 회귀: 시작 오류 화면 `r` = 다시 시도, 입력줄 `r` = 글자, 1b 오류 보기 → 자세히 → `Esc` → 목록.

## File Map

| 파일 | Task | 무엇 |
|---|---|---|
| `crates/controller/src/monitor/supervisor.rs` | 1, 2 | `unit_loop` 깨우기·`CHECK_NOW_MIN_GAP`, `BoardView.kicks`, `CheckNow`, `check_now` + 인라인 테스트 |
| `crates/controller/src/api/monitor_boards.rs` | 2 | `CheckNowResponse`, `check_now` 핸들러 |
| `crates/controller/src/app.rs` | 2 | 라우트 1개 |
| `crates/controller/tests/monitor_boards_api_test.rs` | 2 | REST 테스트 |
| `crates/tui/src/wire.rs`·`api.rs` | 3 | 거울·루프백 메서드 |
| `crates/tui/src/app.rs` | 3, 4, 5 | 조회 작업자 요청, 키·동작·알림, 대기 창·자세히 연결 |
| `crates/tui/src/text.rs` | 4, 5 | 새 문구 |
| `crates/tui/src/view/monitor.rs` | 4 | 키 줄·머리 줄 알림 |
| `crates/tui/src/inspect.rs` | 5 | `RecordOrigin`, `RecordState.origin` |
| `crates/tui/src/view/settings.rs` | 5 | `OverlayView::Checking` 한 줄 |
| `crates/tui/tests/*.rs` | 3–5 | 테스트 |
| 문서 | 6 | 상위 spec·목업·매뉴얼·함정 |

---

### Task 1: 점검 루프 깨우기 (`unit_loop`)

spec §2 규칙 1–5·7, §3.1. **path-gate: 동시성 — code-quality 리뷰는 `model: opus`.**

**Files:**
- Modify: `crates/controller/src/monitor/supervisor.rs` — `unit_loop`(`grep -n "pub(crate) async fn unit_loop"`), `panel_loop`(테스트 도우미), `spawn_unit`·`spawn_loop`, `reconcile_slot`의 `spawn_unit(` 호출, 인라인 `mod tests`.

**Interfaces:**
- Produces: `pub(crate) const CHECK_NOW_MIN_GAP: Duration`; `unit_loop(interval, members, check, token, kick: Arc<tokio::sync::Notify>)`; `spawn_unit(..., kick: Arc<Notify>)`(8번째 인자, `#[allow(clippy::too_many_arguments)]`); `spawn_loop(..., kick)`. `reconcile_slot`은 실행 단위(plan)마다 `Arc::new(Notify::new())` 하나를 만들어 `spawn_unit`에 넘긴다(**이 task에서는 보관하지 않는다** — 보관은 Task 2. 안 읽는 필드를 먼저 만들면 `dead_code`로 clippy 실패).

- [ ] **Step 1: 실패하는 테스트 작성** (인라인 `mod tests`, 기존 `// ---- panel_loop (paused time, fake check, no SQLite) ----` 구획 뒤에 새 구획. 기존 도우미 `Starts`·`res`·`pair`·`new_buf`·`tokio::time::Instant` 재사용)

테스트 도우미부터 — 기존 `panel_loop`를 깨우기 인자를 받는 `panel_loop_kick`으로 일반화하고 `panel_loop`는 새 `Notify`를 넘겨 부르게 한다(기존 `panel_loop` 호출 6곳 무수정). 기존 `unit_loop(` 직접 호출 1곳(`unit_loop_pushes_all_members_same_at`)은 끝 인자 `Arc::new(tokio::sync::Notify::new())` 추가.

```rust
// ---- 지금 점검 깨우기 (paused time) ----

/// 점검이 `dur` 동안 돌고 시작 시각을 남기는 칸 1개 루프.
fn spawn_kick_loop(
    interval: Duration,
    dur: Duration,
) -> (Starts, Arc<tokio::sync::Notify>, CancellationToken, JoinHandle<()>) {
    let t0 = Instant::now();
    let starts: Starts = Arc::default();
    let s2 = starts.clone();
    let check = move || {
        let s = s2.clone();
        async move {
            s.lock().unwrap().push(t0.elapsed());
            tokio::time::sleep(dur).await;
            pair(res(0, Verdict::Ok))
        }
    };
    let kick = Arc::new(tokio::sync::Notify::new());
    let token = CancellationToken::new();
    let h = tokio::spawn(panel_loop_kick(
        interval,
        BUFFER_CAP,
        check,
        new_buf(),
        token.clone(),
        kick.clone(),
    ));
    (starts, kick, token, h)
}

fn secs(v: &[u64]) -> Vec<Duration> {
    v.iter().map(|s| Duration::from_secs(*s)).collect()
}

async fn stop_and_starts(starts: &Starts, token: CancellationToken, h: JoinHandle<()>) -> Vec<Duration> {
    token.cancel();
    h.await.unwrap();
    starts.lock().unwrap().clone()
}

#[tokio::test(start_paused = true)]
async fn kick_while_waiting_runs_early_and_resets_schedule() {
    // 규칙 1·5: 주기 60초, 점검 1초. 10초에 깨우면 10초에 시작, 다음 정기는 70초.
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(60), Duration::from_secs(1));
    tokio::time::sleep(Duration::from_secs(10)).await;
    kick.notify_waiters();
    tokio::time::sleep(Duration::from_millis(65_500)).await; // t = 75.5초
    assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 10, 70]));
}

#[tokio::test(start_paused = true)]
async fn kick_respects_min_gap() {
    // 규칙 2: 점검 0.1초, 0.3초에 깨우면 다음 시작은 정확히 1초(버리지 않고 미룬다).
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
    tokio::time::sleep(Duration::from_millis(300)).await;
    kick.notify_waiters();
    tokio::time::sleep(Duration::from_millis(4_700)).await; // t = 5초
    assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 1]));
}

#[tokio::test(start_paused = true)]
async fn kick_during_check_is_dropped() {
    // 규칙 3: 점검 5초, 2초(점검 중)에 깨움 → 추가 회차 없음, 다음은 정기 60초.
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(60), Duration::from_secs(5));
    tokio::time::sleep(Duration::from_secs(2)).await;
    kick.notify_waiters();
    tokio::time::sleep(Duration::from_millis(63_500)).await; // t = 65.5초
    assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 60]));
}

#[tokio::test(start_paused = true)]
async fn repeated_kicks_while_waiting_run_once() {
    // 규칙 4: 대기 중 연달아 3번 → 1회.
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
    tokio::time::sleep(Duration::from_secs(10)).await;
    kick.notify_waiters();
    kick.notify_waiters();
    kick.notify_waiters();
    tokio::time::sleep(Duration::from_secs(20)).await; // t = 30초
    assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 10]));
}

#[tokio::test(start_paused = true)]
async fn kicks_never_beat_one_second_interval() {
    // 주기 1초: 0.3초·1.3초·2.3초에 깨워도 시작 간격은 1초 그대로.
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(1), Duration::from_millis(100));
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(300)).await;
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await; // t = 3.5초
    assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 1, 2, 3]));
}

#[tokio::test(start_paused = true)]
async fn cancel_while_waiting_for_min_gap_stops_at_once() {
    // 깨운 뒤 바닥(1초)을 기다리는 중 취소 → 다음 회차 없이 끝난다.
    let (starts, kick, token, h) = spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
    tokio::time::sleep(Duration::from_millis(300)).await;
    kick.notify_waiters();
    tokio::time::sleep(Duration::from_millis(200)).await; // t = 0.5초 — 바닥 대기 중
    token.cancel();
    tokio::time::timeout(Duration::from_millis(1), h).await.expect("루프가 즉시 끝나야 한다").unwrap();
    assert_eq!(starts.lock().unwrap().clone(), secs(&[0]));
}
```

(위 코드는 `cargo fmt`가 줄을 다시 나눈다 — 그대로 둔다. `JoinHandle`은 파일 머리의 `tokio::task::JoinHandle` 그대로.)

기대 RED: `panel_loop_kick`이 없어 컴파일 실패.

- [ ] **Step 2: `unit_loop` 구현** — spec §3.1 코드 그대로. 요점:
  - 상수 `pub(crate) const CHECK_NOW_MIN_GAP: Duration = Duration::from_secs(1);`(문서 주석 포함)를 `STOP_GRACE` 근처에.
  - 인자 `kick: Arc<tokio::sync::Notify>` 추가.
  - `check()` select **뒤**, 결과 push `for` **앞**에 `let kicked = kick.notified(); tokio::pin!(kicked);` + 왜 여기인지 주석(spec §3.1 "결과를 본 뒤에 온 요청을 놓치지 않게" + 순서를 바꾸면 생기는 틈).
  - 대기 select 세 갈래(`biased`): 취소 → `sleep_until(started + interval)` → `async { kicked.as_mut().await; tokio::time::sleep_until(started + interval.min(CHECK_NOW_MIN_GAP)).await }`.
  - 머리 문서 주석에 "지금 점검으로 깨우면 주기를 기다리지 않는다(바닥 1초, 점검 중 요청은 버린다)" 추가.
  - 테스트 도우미: `panel_loop_kick(interval, bar_count, check, buf, token, kick)`(본문 = 지금 `panel_loop` + `kick` 전달), `panel_loop`는 `panel_loop_kick(…, Arc::new(tokio::sync::Notify::new()))` 호출. 둘 다 `#[cfg(test)]`.
- [ ] **Step 3: 호출 사슬에 `kick` 전달** — `spawn_loop(..., kick)` → `unit_loop(..., kick)`, `spawn_unit(..., kick)`(두 갈래 모두 `spawn_loop`에 넘김, 함수 위에 `#[allow(clippy::too_many_arguments)]`), `reconcile_slot`의 plan 루프 안에서 `let kick = Arc::new(tokio::sync::Notify::new());`를 만들어 `spawn_unit(`의 끝 인자로.
- [ ] **Step 4: 검증** — `cargo test -p handicap-controller --lib monitor::supervisor`(새 6개 + 기존 전부 GREEN) → `cargo clippy -p handicap-controller --all-targets -- -D warnings`.
- [ ] **Step 5: 이빨 실증(각각 고의 회귀 → RED 확인 → 원복 → GREEN, 결과를 리포트에)**
  1. 깨우기 갈래를 select에서 지움 → `kick_while_waiting_runs_early_and_resets_schedule` RED(`[0, 60]`).
  2. 바닥 대기(`sleep_until(floor)`)를 지움 → `kick_respects_min_gap` RED(`[0, 0.3]`).
  3. 테스트의 `notify_waiters()`는 그대로 두고 **`kicked` 생성을 `check()` 앞(루프 머리)으로 옮김** → `kick_during_check_is_dropped` RED(점검 중 요청이 살아남아 5초에 추가 회차 — `[0, 5, 65]`). 이것이 "점검 중 요청은 버린다"를 지키는 테스트가 공허하지 않다는 증거다. (실제 깨우는 호출이 `notify_one`으로 바뀌는 회귀는 Task 2 Step 4가 잡는다.)
- [ ] **Step 6: 커밋** — `feat(controller): 점검 루프에 지금 점검 깨우기 — 바닥 1초·점검 중 요청은 버림`.

---

### Task 2: 감독자 `check_now` + REST

spec §2 규칙 6, §3.2, §3.3. **보안 표면(요청 실행 길) — 최종 단계에서 `security-reviewer` 대상.**

**Files:**
- Modify: `crates/controller/src/monitor/supervisor.rs` — `BoardView`(`grep -n "^struct BoardView"`), `reconcile_slot`, `impl MonitorSupervisor`(`record` 아래), 인라인 테스트.
- Modify: `crates/controller/src/api/monitor_boards.rs` — `record` 핸들러 아래에 `CheckNowResponse`·`check_now`.
- Modify: `crates/controller/src/app.rs` — `…/panels/{panel_id}/records/{at_ms}` 라우트(`grep -n "records/{at_ms}"`) 다음에 라우트 추가.
- Test: `crates/controller/tests/monitor_boards_api_test.rs`.

**Interfaces:**
- Consumes: Task 1의 `spawn_unit(..., kick)`.
- Produces:
  - `pub enum CheckNow { Requested { last_at_ms: Option<i64> }, Off, NoPanel }`(`#[derive(Debug, Clone, Copy, PartialEq, Eq)]`), `pub fn check_now(&self, board_id: &str, panel_id: &str) -> CheckNow`(동기).
  - `#[derive(Debug, Serialize)] pub struct CheckNowResponse { pub last_at_ms: Option<i64> }`(`skip_serializing_if` 없음).
  - `POST /api/monitor-boards/{id}/panels/{panel_id}/check-now` → 200 `{"last_at_ms": …}` / 404 / 409 `{"error":"점검이 꺼져 있습니다"}`.

- [ ] **Step 1: 실패하는 테스트 작성**

(a) 감독자 인라인 테스트(기존 `enabled_board`·`wait_results`·`P1`·`P2`·`G1`·`S1`·`S2`·`group`·`step_panel`·`enabled_cfg` 재사용. 실시간 — 가상 시계 금지: sqlx 풀과 충돌):

```rust
// ---- check_now ----

#[tokio::test]
async fn check_now_off_and_no_panel() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let sup = MonitorSupervisor::default();
    // 모르는 보드: Off, 슬롯을 만들지 않는다.
    assert_eq!(sup.check_now("nope", P1), CheckNow::Off);
    assert!(sup.existing_slot("nope").is_none());
    // 꺼진 보드(reconcile 전 = 실행 중 아님): Off.
    let row = monitor_boards::insert(&db, "off", &board(&[P1])).await.unwrap();
    assert_eq!(sup.check_now(&row.id, P1), CheckNow::Off);
    // 켜진 보드의 없는 칸: NoPanel.
    let id = enabled_board(&db, "on", &[P1]).await;
    sup.reconcile(&db, &id).await.unwrap();
    wait_results(&sup, &id, &[P1]).await;
    assert_eq!(sup.check_now(&id, P2), CheckNow::NoPanel);
}

#[tokio::test]
async fn check_now_runs_long_interval_panel_early() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let sup = MonitorSupervisor::default();
    let mut cfg = board(&[P1]);
    cfg.panels[0].interval_seconds = 3600;
    let id = enabled_cfg(&db, &cfg).await;
    sup.reconcile(&db, &id).await.unwrap();
    // 순서 전제: 첫 결과가 들어온 뒤에 요청한다(점검 중 요청은 버려진다 — 규칙 3).
    let first = wait_results(&sup, &id, &[P1]).await;
    let last = first.panels[P1].results.last().unwrap().at_ms;
    assert_eq!(
        sup.check_now(&id, P1),
        CheckNow::Requested { last_at_ms: Some(last) }
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let s = sup.snapshot(&id).await.unwrap();
        if s.panels[P1].results.len() == 2 {
            assert!(s.panels[P1].results[1].at_ms > last);
            break;
        }
        assert!(std::time::Instant::now() < deadline, "지금 점검 회차가 오지 않음");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn check_now_group_runs_all_members_once() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let sup = MonitorSupervisor::default();
    let mut g = group(G1, "no-such-scenario");
    g.interval_seconds = 3600;
    let cfg = BoardConfig {
        groups: vec![g],
        panels: vec![
            step_panel(P1, "no-such-scenario", Some(G1), S1),
            step_panel(P2, "no-such-scenario", Some(G1), S2),
        ],
        ..BoardConfig::default()
    };
    let id = enabled_cfg(&db, &cfg).await;
    sup.reconcile(&db, &id).await.unwrap();
    wait_results(&sup, &id, &[P1, P2]).await;
    assert!(matches!(sup.check_now(&id, P2), CheckNow::Requested { .. }));
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let s = sup.snapshot(&id).await.unwrap();
        let (a, b) = (&s.panels[P1].results, &s.panels[P2].results);
        if a.len() == 2 && b.len() == 2 {
            assert_eq!(a[1].at_ms, b[1].at_ms, "묶음은 한 회차를 나눠 쓴다");
            break;
        }
        assert!(a.len() <= 2 && b.len() <= 2, "한 번만 돌아야 한다");
        assert!(std::time::Instant::now() < deadline, "묶음 회차가 오지 않음");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn check_now_during_running_check_adds_no_round() {
    // 규칙 3의 **실제 호출 경로** 가드: `check_now`가 `notify_one`(허가 저장)을 쓰면 점검이 끝난 뒤 한 번 더 돈다.
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::any())
        .respond_with(wiremock::ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)))
        .mount(&server)
        .await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let sup = MonitorSupervisor::default();
    let sid = insert_scenario(&db, &server.uri()).await;
    let mut cfg = board(&[P1]);
    cfg.panels[0].scenario_id = sid;
    cfg.panels[0].interval_seconds = 3600;
    let id = enabled_cfg(&db, &cfg).await;
    sup.reconcile(&db, &id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await; // 첫 점검(1.5초)이 도는 중
    assert!(sup.snapshot(&id).await.unwrap().panels[P1].running);
    assert_eq!(sup.check_now(&id, P1), CheckNow::Requested { last_at_ms: None });
    wait_results(&sup, &id, &[P1]).await;
    tokio::time::sleep(Duration::from_millis(2500)).await; // 바닥 1초가 지나고도 남는 시간
    assert_eq!(
        sup.snapshot(&id).await.unwrap().panels[P1].results.len(),
        1,
        "점검 중 요청은 회차를 예약하지 않는다"
    );
}
```

묶음 실행 단위의 주기는 **묶음의** `interval_seconds`다(`grep -n "interval_seconds: g.interval_seconds" crates/controller/src/monitor/unit.rs`) — 그래서 묶음 테스트(`check_now_group_runs_all_members_once`)의 픽스처는 묶음 값만 3600으로 둔다(칸 값 1은 쓰이지 않는다).

(b) REST(`monitor_boards_api_test.rs`, 기존 `make_app`·`send`·`mock`·`create_scenario`·`new_board`·`url`·`wait_results` 재사용):

```rust
#[tokio::test]
async fn check_now_404_409_200() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 3600).await;
    let id = b["id"].as_str().unwrap();
    let pid = b["config"]["panels"][0]["id"].as_str().unwrap();
    let path = |board: &str, panel: &str| format!("/api/monitor-boards/{board}/panels/{panel}/check-now");

    // 없는 보드 → 404.
    let (st, _) = send(&app, Method::POST, &path("01J00000000000000000000000", pid), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 꺼진 보드 → 409 + 문구.
    let (st, v) = send(&app, Method::POST, &path(id, pid), None).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"], "점검이 꺼져 있습니다");

    let (st, _) = send(&app, Method::POST, &url(id, "/start"), None).await;
    assert_eq!(st, StatusCode::OK);
    // 순서 전제: 첫 결과 뒤에 요청.
    let first = wait_results(&app, id, 1).await;
    let last = first["panels"][0]["results"][0]["at_ms"].as_i64().unwrap();
    // 켜진 보드의 없는 칸 → 404.
    let (st, _) = send(&app, Method::POST, &path(id, "01J00000000000000000000000"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 200: 키가 항상 있다(값은 그 칸의 마지막 결과 시각).
    let (st, v) = send(&app, Method::POST, &path(id, pid), None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v.as_object().unwrap().contains_key("last_at_ms"), "{v}");
    assert_eq!(v["last_at_ms"].as_i64(), Some(last));
    // 주기 3600초인데 2초 안에 결과 1 → 2.
    let st2 = tokio::time::timeout(Duration::from_secs(2), wait_results(&app, id, 2))
        .await
        .expect("지금 점검 회차가 2초 안에 와야 한다");
    assert!(st2["panels"][0]["results"][1]["at_ms"].as_i64().unwrap() > last);
}
```

생성 응답에는 서버가 채운 칸 id가 들어 있다(`grep -n '\["panels"\]\[0\]\["id"\]' crates/controller/tests/monitor_boards_api_test.rs` — 기존 테스트가 같은 경로를 읽는다).

- [ ] **Step 2: 감독자 구현** — `BoardView`에 `kicks: HashMap<String, Arc<tokio::sync::Notify>>`. `reconcile_slot`: plan 루프에서 Task 1의 `kick`을 그 plan의 **모든 칸 id**로 `kicks`에 넣고(`members` 만드는 `panels.iter()`에서 함께), `BoardView { started_at_ms, bufs, kicks }`. `check_now`: spec §3.2 순서 그대로 — ① `existing_slot`(없으면 `Off`) ② `view` 락: `None`이면 `Off`, `bufs.get(panel_id)`·`kicks.get(panel_id)` 둘 다 복제(없으면 `NoPanel`), 락 해제 ③ 버퍼 락: `results.back().map(|r| r.at_ms)`, 락 해제 ④ `notify_waiters()` ⑤ `Requested { last_at_ms }`. 문서 주석에 순서의 이유(spec §3.2).
- [ ] **Step 3: REST 구현** — 핸들러:

```rust
/// 지금 점검 — 그 칸이 속한 실행 단위를 깨운다(spec tui-check-now §3.3). 본문 없음.
pub async fn check_now(
    State(state): State<AppState>,
    Path((id, panel_id)): Path<(String, String)>,
) -> Result<Json<CheckNowResponse>, ApiError> {
    let row = monitor_boards::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if !row.enabled {
        return Err(ApiError::Conflict(CHECK_OFF.into()));
    }
    match state.monitor.check_now(&id, &panel_id) {
        CheckNow::Requested { last_at_ms } => Ok(Json(CheckNowResponse { last_at_ms })),
        CheckNow::Off => Err(ApiError::Conflict(CHECK_OFF.into())),
        CheckNow::NoPanel => Err(ApiError::NotFound),
    }
}
```

`const CHECK_OFF: &str = "점검이 꺼져 있습니다";`. 라우트: `.route("/monitor-boards/{id}/panels/{panel_id}/check-now", post(monitor_boards_api::check_now))`.
- [ ] **Step 4: 이빨 실증** — `check_now`의 `notify_waiters()`를 `notify_one()`으로 바꾸면 `check_now_during_running_check_adds_no_round`가 RED(결과 2개) → 원복 GREEN. 결과를 리포트에(spec §7의 `notify_one` 이빨은 이 테스트가 맡는다 — Task 1의 루프 테스트는 테스트가 직접 깨우므로 이 호출을 못 지킨다).
- [ ] **Step 5: 검증** — `cargo test -p handicap-controller --lib monitor::supervisor` + `cargo test -p handicap-controller --test monitor_boards_api_test` + `cargo clippy -p handicap-controller --all-targets -- -D warnings`. `crates/tui`가 컨트롤러를 in-process로 쓰므로 `cargo build --workspace --tests`도.
- [ ] **Step 6: 커밋** — `feat(controller): 지금 점검 REST — POST …/panels/{panel_id}/check-now`.

---

### Task 3: TUI 루프백 메서드·거울·조회 작업자 요청

spec §4.2-1, §4.5.

**Files:**
- Modify: `crates/tui/src/wire.rs`, `crates/tui/src/api.rs`, `crates/tui/src/app.rs`(`FetchReq`·`Fetched`·`spawn_fetch_worker`·`SubViews::accept`).
- Test: `crates/tui/tests/edit_api_test.rs`(in-process), `crates/tui/tests/record_test.rs`(작업자).

**Interfaces:**
- Consumes: Task 2의 REST 길.
- Produces:
  - `wire::CheckNowResponse { pub last_at_ms: Option<i64> }` — `#[derive(Debug, Clone, Deserialize)] #[serde(deny_unknown_fields)]`.
  - `Api::check_now(&self, board_id: &str, panel_id: &str) -> Result<CheckNowResponse, ApiError>` — `POST`, 제한 `POLL_TIMEOUT`.
  - `pub type CheckReply = Result<Option<i64>, Option<u16>>;`(성공 = `last_at_ms`, 실패 = HTTP 상태만).
  - `FetchReq::CheckNow { board_id: String, panel_id: String, wait: Option<u64> }`, `Fetched::CheckNow { board_id: String, panel_id: String, wait: Option<u64>, result: CheckReply }`.
  - `SubViews::accept`는 `Fetched::CheckNow { .. } => false`(이 결과는 `App`이 `accept` 전에 가로챈다 — Task 4·5).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `edit_api_test.rs` `check_now_round_trip_real_controller`(`#[tokio::test(flavor = "multi_thread")]`, 기존 `target`·`start` 재사용): 세션 시작 → 첫 결과가 올 때까지 `s.api.status(board)` 폴링(최대 5초, 100ms 간격) → `s.api.check_now(board, panel)`이 `Ok`이고 `last_at_ms`가 `Some`(그 시점 `/status`의 마지막 결과 `at_ms` 이상) → 없는 칸 id로 부르면 `Err`이고 `status == Some(404)` → 끝에 `s.shutdown().await`(그 파일의 기존 테스트처럼). (꺼진 보드의 409는 여기서 만들 수 없다 — `Session`은 REST 주소를 밖에 주지 않고 `Api`에 정지 메서드가 없다. 409 응답 자체는 Task 2 REST 테스트가, 409 → 화면 문구는 Task 4·5의 순수 함수 테스트가, 실제 경로는 라이브 §8 US4(c)가 덮는다.)
  - `record_test.rs` `fetch_worker_check_now_reports_status_only`: 작업자에 `FetchReq::CheckNow { wait: Some(7) }` → `Fetched::CheckNow { wait: Some(7), result: Ok(Some(_)) }`. 없는 칸으로 한 번 더 → `result: Err(Some(404))`. (`Fetched`는 `Debug`만 있으므로 `match`/`matches!`로.)
- [ ] **Step 2: 구현** — `wire.rs` 거울, `api.rs` 메서드(`start`와 같은 모양 + `parse::<CheckNowResponse>`), `app.rs` 요청·결과 갈래와 작업자 arm(`api.check_now(..).await.map(|r| r.last_at_ms).map_err(|e| e.status)`), `accept`의 새 arm.
- [ ] **Step 3: 검증** — `cargo test -p handicap-tui --test edit_api_test --test record_test` + `cargo clippy -p handicap-tui --all-targets -- -D warnings`.
- [ ] **Step 4: 커밋** — `feat(tui): 지금 점검 루프백 메서드·조회 작업자 요청`.

---

### Task 4: 모니터 화면의 `r` + 머리 줄 알림

spec §4.1(모니터·도움말 행), §4.2. US1·US3·US4의 TUI 쪽.

**Files:**
- Modify: `crates/tui/src/text.rs`, `crates/tui/src/app.rs`(`Action`·`handle_key`·`App`·`pump`·`apply`·`monitor_screen`·`start_session`·`run`의 `App { … }` 리터럴), `crates/tui/src/view/monitor.rs`(`HeaderNotice`·`render_header_view`·`render_with_keys`).
- Test: `crates/tui/tests/app_test.rs`, `crates/tui/tests/view_test.rs`.

**Interfaces:**
- Consumes: Task 3의 `FetchReq::CheckNow`·`Fetched::CheckNow`·`CheckReply`.
- Produces:
  - `text::KEYS_CHECK_NOW`·`CHECK_NOW_SENT`·`CHECK_OFF`·`CHECK_NOW_FAILED`, `HELP_KEYS: [(&str, &str); 11]`(`r` 줄은 `e` 줄 앞).
  - `Action::CheckNow`.
  - `HeaderNotice::{CheckSent(i64), CheckOff, CheckFailed}`.
  - (`app.rs`) `pub fn check_notice(result: &CheckReply, now_ms: i64) -> HeaderNotice`(`Ok(_)` → `CheckSent(now_ms)`, `Err(Some(409))` → `CheckOff`, 그 밖 → `CheckFailed`).
  - (`app.rs`) `pub fn shown_notice(check: Option<&HeaderNotice>, file: Option<&HeaderNotice>) -> Option<HeaderNotice>`(`check.or(file).cloned()`).
  - `App.check_alert: Option<(HeaderNotice, Instant)>`(함수 `check_notice`와 이름이 겹치지 않게).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `app_test.rs`: ① 모니터에서 `r`·`R`·`ㄱ` → `Action::CheckNow`, `Ctrl+R` → `Action::None`(기존 `key`·`ch`·`ctrl` 도우미) ② `Screen::Error(err())`에서 `r` → `Action::Retry` 그대로(기존 `error_screen_r_retries` 유지 확인 + 오류 보기·자세히·요청·응답·도움말에서 `r` → `Action::None`) ③ `check_notice`: `Ok(Some(1))`·`Ok(None)` → `CheckSent(now)`, `Err(Some(409))` → `CheckOff`, `Err(Some(404))`·`Err(None)` → `CheckFailed` ④ `shown_notice`: 둘 다 있으면 지금 점검 알림, 지금 점검 알림이 없으면 파일 알림, 둘 다 없으면 `None`.
  - `view_test.rs`: ① 모니터 키 줄 — 조각 순서는 `b 테두리`, **`r 지금 점검`**, (`Tab 다음 보드`), `←↑↓→ 칸 이동`, `e 오류 보기`, `Enter 칸 설정`, `? 도움말`, `q 종료`. 기존 리터럴 단언(`grep -n "칸 이동  e 오류 보기" crates/tui/tests/view_test.rs` — 8줄 전부)을 새 조합으로 갱신하고 새 단언을 더한다. 기대값(키 줄 = 폭−1 칸에 앞 조각부터 통째로 뺌, 한글 2칸으로 손계산한 값 — 다르면 STOP): 80칸·보드 1개 = `r 지금 점검  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료`(`b 테두리` 없음) / 80칸·보드 2개 = `Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료`(**지금과 같다** — `r`·`b` 조각 없음) / 90칸·보드 2개 = `r 지금 점검  Tab 다음 보드  ←↑↓→ 칸 이동  …` / 97칸 이상(테스트는 100칸)·보드 2개 = 8조각 전부 / 90칸 이상·보드 1개 = 7조각 전부. 80칸보다 넓은 폭을 쓰는 기존 단언은 그 폭의 새 조합으로. 어느 폭에서도 잘린 조각(`…`)이 없다. **뜻이 뒤집히는 기존 테스트 2개**: `key_bar_has_border_key`(80칸·보드 1개에서 `b 테두리`가 **보인다**를 확인)와 `render_key_bar_single_board_omits_tab`의 `b 테두리` 단언 — 리터럴만 바꾸면 "테두리 안내 없음" 테스트가 된다. 테두리 안내 확인은 **90칸**으로 옮겨 살리고(`b 테두리  r 지금 점검  ←↑↓→ 칸 이동  …`), 80칸은 새 조합 단언으로 따로 둔다 ② 머리 줄(`header_with` 도우미): `CheckSent(ms)` → `지금 점검 HH:MM:SS` 초록, `Saved`와 같은 폭 단계에서 같은 순서로 빠진다(기존 `header_notice_saved_and_failed`의 폭 루프를 두 알림에 대해 돌린다); `CheckOff` → 빨강 `점검이 꺼져 있습니다`, `CheckFailed` → 빨강 `지금 점검을 요청하지 못했습니다`, 둘 다 기존 파일 경고와 같은 축약 ③ 도움말: `HELP_KEYS.len() == 11`(기존 `== 10` 단언 갱신), `r` 줄이 그려진다, **80×24·짧은 경로에서 키 11줄 + 경고 줄 + 백업 줄이 모두 보인다**(기존 도움말 렌더 테스트의 도우미 사용 — `grep -n "render_help" crates/tui/tests/view_test.rs`).
- [ ] **Step 2: 문구** — `text.rs`에 spec §4.1 표의 4개 상수(`KEYS_CHECK_NOW`·`CHECK_NOW_SENT`·`CHECK_OFF`·`CHECK_NOW_FAILED`)와 `HELP_KEYS` 한 줄(배열 길이 11).
- [ ] **Step 3: 키·동작** — `Action::CheckNow`; `handle_key` 모니터 갈래 `KeyCode::Char('r') => Action::CheckNow`; `App::apply`의 `Action::CheckNow` arm = `OpenErrors`와 같은 조건(`toggle_allowed` + 보드·선택 칸)에서 `send_fetch(FetchReq::CheckNow { board_id, panel_id, wait: None })`.
- [ ] **Step 4: 알림** — `HeaderNotice` 3갈래; `render_header_view`의 `warn` match에 `CheckOff`·`CheckFailed`, `saved` match에 `CheckSent(ms)`(문구만 `text::CHECK_NOW_SENT`). `App.check_alert` 필드(+ `run`의 리터럴 초기값 `None`, `start_session`에서 `None`); `pump`: 조회 결과 루프에서 `Fetched::CheckNow { wait: None, result, .. }`이면 `self.check_alert = Some((check_notice(&result, now_ms()), Instant::now()))`, `changed = true`(`accept`에 넘기지 않는다). `wait: Some(_)`은 **이 task에서는 버린다**(Task 5가 받는다 — 주석으로 표시). 5초(`SAVED_NOTICE`) 지나면 비우고 `changed = true`. `monitor_screen`의 `notice`는 `shown_notice(self.check_alert.as_ref().map(|(n, _)| n), self.file_notice.as_ref())`.
- [ ] **Step 5: 키 줄** — `render_with_keys`의 모니터 조각 목록에서 `text::KEYS_CHECK_NOW`를 **`KEYS_BORDER` 바로 뒤**(`KEYS_NEXT_BOARD` 앞)에. 주석(`앞 조각부터 통째로 빠진다`)에 "새 조각이 `Tab 다음 보드`를 밀어내지 않게 그 앞에" 한마디.
- [ ] **Step 6: 검증** — `cargo test -p handicap-tui` 전체 + clippy.
- [ ] **Step 7: 커밋** — `feat(tui): 모니터에서 r 지금 점검 — 머리 줄 알림·키 줄·도움말`.

---

### Task 5: 칸 설정의 `r` → 대기 창 → 자세히

spec §4.1(칸 설정·자세히 행), §4.3, §4.4. US2.

**Files:**
- Modify: `crates/tui/src/app.rs`(`Overlay`·`EditAction`·`edit_key`·`overlay_key`·`edit_apply`·`edit_keys`·`overlay_view`·`KeyCtx`·`sub_keys`·`SubViews`·`App`), `crates/tui/src/inspect.rs`(`RecordState`), `crates/tui/src/view/settings.rs`(`OverlayView`·그리기 한 줄), `crates/tui/src/text.rs`.
- Test: `crates/tui/tests/app_test.rs`, `crates/tui/tests/settings_test.rs`(overlay 표), `crates/tui/tests/inspect_test.rs`(`rstate` 도우미에 필드).

**Interfaces:**
- Consumes: Task 3·4.
- Produces:
  - `text::CHECK_WAITING`·`KEYS_TO_SETTINGS`.
  - `pub enum CheckWait { Sent, After(Option<i64>) }`(`#[derive(Debug, Clone, Copy, PartialEq, Eq)]` — `Overlay`가 `Clone + PartialEq + Eq`), `Overlay::Checking { seq: u64, wait: CheckWait }`(`kind()` = `"Checking"`).
  - `EditAction::CheckNow`(메뉴의 `r`), `EditAction::CheckCancel`(대기 창의 `Esc`).
  - `pub fn start_check(ui: &mut EditUi, seq: &mut u64) -> FetchReq` — `*seq += 1`, 대기 창을 띄우고 `FetchReq::CheckNow { wait: Some(*seq), .. }`를 돌려준다.
  - `pub fn check_reply(ui: &mut EditUi, seq: u64, result: CheckReply) -> bool` — 창이 `Checking { seq, wait: Sent }`일 때만 반영(`Ok(last)` → `After(last)`, `Err(Some(409))` → `Notice(CHECK_OFF)`, 그 밖 → `Notice(CHECK_NOW_FAILED)`)하고 `true`, 아니면 `false`(상태 불변).
  - `pub fn check_ready(ui: &EditUi, results: &[CheckResult]) -> Option<CheckResult>` — 창이 `Checking { wait: After(last), .. }`이고 `results.last()`의 `at_ms > last`(또는 `last`가 `None`)이면 그 결과.
  - `inspect::RecordOrigin { Errors, Settings }`(`#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]`, `#[default] Errors`), `RecordState.origin`.
  - `SubViews::open_record_from_settings(&mut self, clicked: CheckResult) -> Option<(Screen, FetchReq)>` — `edit`의 보드·칸으로 `record`를 만들고(`origin: Settings`) `body = None`, `edit.overlay = None`. `edit`가 없으면 `None`.
  - `SubViews::back(Screen::Record)` — `origin`이 `Settings`면 `record`·`body`만 비우고 `Some(Screen::Settings)`, 아니면 지금과 같다.
  - `KeyCtx.record_from_settings: bool`, `sub_keys(Record)`가 `KEYS_TO_SETTINGS`/`KEYS_TO_LIST`를 고른다.
  - `OverlayView::Checking`, `App.check_seq: u64`.

- [ ] **Step 1: 실패하는 테스트 작성** (`app_test.rs` — 기존 `ek`·`ui_with`·`result`·`ch`·`key`·`ctx` 도우미)
  1. 키: 메뉴(`Screen::Settings`, 창 없음)에서 `r`·`ㄱ` → `EditAction::CheckNow`; `EditList`·`EnvVars`·`ScenarioVars`에서 `r` → `EditAction::None`; 입력줄 창에서 `r` → `EditAction::Input(..)`(글자); 대기 창에서 `Esc` → `CheckCancel`, `q` → `AskQuit`, `Ctrl+C` → `AskQuit`, `r`·`Enter`·`1` → `None`.
  2. `start_check`: 두 번 부르면 번호가 1, 2이고 창이 `Checking { seq: 2, wait: Sent }`, 돌려준 요청의 `wait == Some(2)`·보드·칸이 `ui`의 것.
  3. `check_reply`: 맞는 번호 + `Ok(Some(5))` → `After(Some(5))`·`true`; `Err(Some(409))` → `Notice(text::CHECK_OFF)`; `Err(None)` → `Notice(text::CHECK_NOW_FAILED)`; 번호가 다름·창이 없음·창이 이미 `After`·창이 `Saving` → `false`이고 창 불변.
  4. `check_ready`: `After(Some(10))` + 결과 `[5, 10]` → `None`, `[5, 10, 11]` → `at_ms == 11`; `After(None)` + `[]` → `None`, `[3]` → 3; `Sent` → `None`; 창 없음 → `None`.
  5. 자세히 전환: `views.edit = Some(ui_with(Checking…))` → `open_record_from_settings(result(11))` → `Screen::Record`, 요청이 `FetchReq::Record { at_ms: 11, .. }`, `views.errors.is_none()`, `views.edit`의 창이 `None`이고 `cursor` 그대로; `back(&Screen::Record)` → `Some(Screen::Settings)`, `record`·`body` `None`, `edit` `Some`; 그 뒤 `back(&Screen::Settings)` → `Monitor`, `edit` `None`. 회귀: 오류 목록에서 연 자세히의 `back` → `Screen::Errors`(기존 `sub_views_transitions` 유지). `edit`가 없을 때 `open_record_from_settings` → `None`.
  6. 요청·응답 왕복: 칸 설정에서 연 자세히 → `open_body` → `back(Body)` → `Record` → `back(Record)` → `Settings`.
  7. 키 줄: `sub_keys(&Screen::Record, KeyCtx { record_from_settings: true, .. })`의 마지막 조각이 `KEYS_TO_SETTINGS`, `false`면 `KEYS_TO_LIST`; `edit_keys`의 메뉴 갈래에 `KEYS_CHECK_NOW`가 `KEYS_NUMBER` 뒤·`KEYS_EDIT` 앞; 대기 창일 때 `edit_keys` → `[KEYS_BACK]`. 방어 경로 `sub_keys(&Screen::Settings, …)`에는 `KEYS_CHECK_NOW`가 **없다**.
  8. 5분 복귀: `idle_drop`이 대기 창을 버린다(`Saving`은 남는 기존 단언 옆에).
  9. `settings_test.rs`의 overlay 표(`grep -n "OverlayView::Saving, text::SAVING" crates/tui/tests/settings_test.rs`)에 `(OverlayView::Checking, text::CHECK_WAITING, vec![])` 행.
  10. **종료 확인 중 미룸**(순수 함수로 뺀다): `pub fn check_open_allowed(screen: &Screen) -> bool` = `matches!(screen, Screen::Settings)` — `Screen::Settings` → `true`, `Screen::QuitConfirm(Box::new(Screen::Settings))`·`Screen::EditList`·`Screen::Monitor` → `false`.
- [ ] **Step 2: 상태·키** — `text.rs` 2상수; `CheckWait`; `Overlay::Checking` + `kind`; `EditAction` 2갈래; `edit_key`: 메뉴 갈래에 `KeyCode::Char('r') if menu => EditAction::CheckNow`(숫자 키 arm 근처); `overlay_key`: `Overlay::Checking { .. }` → `quit_key`면 `AskQuit`, `norm == KeyCode::Esc`(Ctrl 없음)면 `CheckCancel`, 그 밖 `None`; `edit_apply`: `CheckNow`는 `None | Back | AskQuit` 무동작 갈래에(호출 쪽 `run_edit`이 처리), `CheckCancel`은 `PickCancel | ConfirmNo | CloseNotice` 갈래에; `start_check`·`check_reply`·`check_ready`·`check_open_allowed`.
- [ ] **Step 3: 자세히 온 곳** — `inspect.rs` `RecordOrigin`·`RecordState.origin`(기존 리터럴 `app.rs` `open_record`·`inspect_test.rs` `rstate`에 `origin: RecordOrigin::Errors`); `open_record_from_settings`; `back` 분기; `KeyCtx.record_from_settings`(리터럴 사이트 전부 — `grep -rn "KeyCtx {" crates/tui`: `app.rs` 2곳 + `app_test.rs`. `draw_sub`의 값 = `self.views.record.as_ref().is_some_and(|r| r.origin == RecordOrigin::Settings)`); `sub_keys`.
- [ ] **Step 4: 그리기** — `OverlayView::Checking`; `overlay_view`의 `Overlay::Checking { .. } => OverlayView::Checking`; `view/settings.rs`의 `OverlayView::Saving` 줄 옆에 `Checking` → `overlay_text(text::CHECK_WAITING, muted, w)`; `edit_keys`: `Overlay::Checking { .. } => vec![text::KEYS_BACK]`, 메뉴 갈래에 `KEYS_CHECK_NOW`.
- [ ] **Step 5: `App` 연결** — `check_seq: u64`(초기 0, `start_session`에서 **비우지 않는다** — 줄지 않아야 한다); `run_edit`: `EditAction::CheckNow`면 `start_check(ui, &mut self.check_seq)` → `send_fetch`(작업자가 없으면 — `fetch_req`가 `None` — 창을 띄우지 않는다: `send_fetch` 전에 `self.fetch_req.is_some()` 확인); `pump`: Task 4에서 버리던 `Fetched::CheckNow { wait: Some(n), result, .. }`를 `check_reply(ui, n, result)`로(받았으면 `changed = true`). 이어서 `check_open_allowed(&self.screen)`이고 편집 상태가 있으면 `check_ready(ui, &self.panel_results(&ui.board_id, &ui.panel_id))` → `Some(clicked)`이면 `self.views.open_record_from_settings(clicked)` → 화면 전환 + `send_fetch(req)` + `changed = true`. (`pump`는 종료 확인창이면 안쪽 화면으로 갈라 `pump_settings`를 부르지만, 이 여는 판정은 **`self.screen` 자체**로 한다.)
- [ ] **Step 6: 검증** — `cargo test -p handicap-tui` 전체 + clippy + `cargo build --workspace --tests`.
- [ ] **Step 7: 커밋** — `feat(tui): 칸 설정에서 r 지금 점검 → 그 회차 자세히`.

---

### Task 6: 문서

spec §6. production diff 0.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`, `docs/superpowers/specs/2026-11-11-tui-2a-mockups/01-screens.html`, `docs/dev/tui-monitor.md`, `crates/tui/CLAUDE.md`, `crates/controller/CLAUDE.md`, `docs/superpowers/specs/2026-11-11-tui-check-now-design.md`(상태 줄).

- [ ] **Step 1: 상위 spec 개정** — `grep -n "미리 실행\|preview\|PreviewResponse" docs/superpowers/specs/2026-11-07-tui-monitor-design.md`의 **모든 줄**을 하나씩 판정해 spec §6 첫 불릿대로 고친다: US4·US9 문장 교체, §0 표 2a-2 행(`미리 실행(그 칸 스텝만)` → `지금 점검(r) — tui-check-now 설계`)·2b 행, §5.2 키 표에 `r` 행, §6 "나눔" 문단, §6.5 본문을 포인터로 교체, §6.6·§6.7·§8·§9·§12의 언급에 "tui-check-now로 대체" 표시. "TUI가 미리 실행을 부른다"는 뜻이 아닌 줄(서버 엔드포인트 목록·GUI 설명)은 그대로. 고친 뒤 같은 grep을 다시 돌려 남은 줄마다 "그대로 둔 이유"를 커밋 메시지에 한 줄씩.
- [ ] **Step 2: 목업** — `01-screens.html` 머리 문단(`<p class="cap">2b(다음): …` 줄 근처)에 한 줄: `§6 미리 실행은 tui-check-now 설계의 r 지금 점검으로 대체(2026-11-11) — 아래 그림은 승인 당시 기록`.
- [ ] **Step 3: 매뉴얼** — `docs/dev/tui-monitor.md` §3 키 표에 `r` 행(모니터: 선택 칸 지금 점검 / 칸 설정: 점검 후 그 회차 자세히), §4-2에 항목 하나(칸 설정에서 `r` → `점검 결과를 기다리는 중…` → 자세히, `Esc`로 칸 설정에 돌아옴, 묶음 칸은 스텝 전부 + `◀ 이 칸`), §4-1 앞이나 §4 본문에 한 단락(지금 점검은 실제 점검이라 막대·기록에 남는다 · 묶음 칸은 같은 묶음이 함께 돈다 · 한 칸은 1초에 한 번보다 자주 돌지 않는다 · 점검 중에 누르면 그 점검 하나로 끝난다 · 머리 줄 `지금 점검 HH:MM:SS`). `Esc` 행의 경로 설명에 "칸 설정에서 연 자세히 → 칸 설정" 추가.
- [ ] **Step 4: 함정 한 줄씩** — `crates/controller/CLAUDE.md` 운영 모니터 절: "지금 점검 깨우기는 `notify_waiters`(허가 저장 없음)이고 `notified()`는 결과 push **전에** 만든다 — 순서를 바꾸면 깨우기가 사라지는 틈, 테스트로 못 잡음 (tui-check-now)". `crates/tui/CLAUDE.md`: 구현·라이브에서 실제로 밟은 함정이 있으면 한 줄(없으면 건드리지 않는다).
- [ ] **Step 5: 이 spec 상태 줄** — `- 상태: 설계` → `- 상태: 구현 완료(코드 <첫 커밋>..<끝 커밋>), 라이브·마무리는 finish-slice`.
- [ ] **Step 6: 커밋** — `docs: tui-check-now — 상위 설계·매뉴얼 개정`.

---

## Task 뒤 (orchestrator — 순서 고정, 생략 금지)

1. **최종 whole-feature 리뷰** `handicap-reviewer`(BASE = Task 1 직전 커밋). 초점: 위 Review Focus 8개 + 와이어 1:1(`CheckNowResponse` ↔ `wire::CheckNowResponse`) + "옛 동작에 기대던 소비자"(GUI `MonitorPage`는 `/status`만 읽는다 — 회차가 주기보다 촘촘히 올 수 있게 된 것이 GUI 막대·`N분 전` 축 계산을 깨지 않는지, `--check` 경로).
2. **보안 게이트** — `finish-slice` §0 grep을 직접 돌린다. 매치하면(요청 실행 길 — 매치 예상) `security-reviewer` APPROVE 필수. 초점: spec §9(증폭 한도 = 초당 1회, 본문 없는 POST의 교차 사이트 도달, 응답·화면에 서버 문자열 없음).
3. **라이브 검증** — spec §8 표 전부 + 극단값(tmux, 요청 도착 시각을 남기는 응답기, `crates/tui/CLAUDE.md`의 tmux·in-process REST 방법). 워크트리(이 체크아웃) 자체 바이너리로.
4. **`/finish-slice`** — build-log·roadmap(§B 새 절 + "다음 = 2a-2 미리 실행" 문구 교체)·현황판·루트 상태 줄·"증명된 US / 못 한 US" 한 줄.

## 사실 근거 (이 plan이 기대는 코드 사실 — 디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| `panel_loop` 호출 6곳·`unit_loop` 직접 호출 1곳(테스트) | `grep -n "panel_loop(\|unit_loop(" crates/controller/src/monitor/supervisor.rs` |
| 테스트 도우미 `Starts`·`res`·`pair`·`new_buf`·`enabled_board`·`enabled_cfg`·`group`·`step_panel`·`wait_results` 실존 | `grep -n "type Starts\|fn res(\|fn pair(\|fn new_buf(\|fn enabled_board(\|fn enabled_cfg(\|fn group(\|fn step_panel(\|fn wait_results(" crates/controller/src/monitor/supervisor.rs` |
| REST 테스트 도우미 실존 | `grep -n "^fn make_app\|^async fn send\|^async fn mock\|^async fn create_scenario\|^async fn new_board\|^fn url\|^async fn wait_results" crates/controller/tests/monitor_boards_api_test.rs` |
| `spawn_unit` 인자 7개(→ 8) | `grep -n "^fn spawn_unit" -A9 crates/controller/src/monitor/supervisor.rs` |
| `too_many_arguments` 선례 | `grep -rn "clippy::too_many_arguments" crates/ --include=*.rs` |
| `Fetched`를 전부 나열하는 곳 = `SubViews::accept` | `grep -n "Fetched::" crates/tui/src/app.rs` |
| `Overlay`를 전부 나열하는 곳 = `kind`·`overlay_key`·`edit_keys`·`overlay_view` | `grep -n "Overlay::Saving" crates/tui/src/app.rs` — 나오는 줄들 가운데 이 네 함수 안의 것(나머지는 일부만 보는 `matches!`·생성) |
| `KeyCtx {` 리터럴 사이트 | `grep -rn "KeyCtx {" crates/tui` |
| `RecordState {` 리터럴 사이트 | `grep -rn "RecordState {" crates/tui` |
| `HeaderNotice` match 2곳(warn·saved) | `grep -n "HeaderNotice::" crates/tui/src/view/monitor.rs` |
| 모니터 키 줄 리터럴 단언 8줄 | `grep -n "칸 이동  e 오류 보기" crates/tui/tests/view_test.rs` |
| `HELP_KEYS` 길이 단언·배열 타입 | `grep -rn "HELP_KEYS" crates/tui/src/text.rs crates/tui/tests/view_test.rs` |
| TUI 테스트 픽스처 보드 = 칸 1개·주기 1초 | `python3 -c "import json;d=json.load(open('crates/tui/tests/fixtures/bundle_template.json'));print([(p['interval_seconds'],p.get('group_id')) for b in d['boards'] for p in b['config']['panels']])"` |
| `App`의 `save_seq`(대기 번호가 따를 선례) | `grep -n "save_seq" crates/tui/src/app.rs` |
