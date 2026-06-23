# 실패 run 진단 사유(message) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 `Failed` run이 non-null `message`(실패 사유)를 갖게 한다 — 워커가 보낸 실제 엔진 에러를 표면화하고, 워커 사유가 없는 두 경로는 합성 진단 문구를 남긴다. + 이 갭을 "열린 버그"로 오기재한 스테일 문서 정정.

**Architecture:** `coordinator.rs`의 세 message-less `Failed` 전이(`record_phase` 워커-보고 Failed·`worker_disconnected`·`fail_incomplete_registration`)를 message-기록 `runs::mark_failed_if_active`로 교체. `record_phase`에 `message: &str` 파라미터를 더해 핸들러(`:1316`)가 이미 받고 버리던 워커 `RunStatus.message`(proto field 3)를 관통시킨다. proto·worker·engine·migration·UI 무변경(전부 기존 자산 재사용).

**Tech Stack:** Rust (tonic gRPC coordinator, sqlx SQLite store), 인라인 `#[cfg(test)]` 단위 테스트.

## Global Constraints

- **메시지 언어 = 영어** (기존 `mark_failed`/reaper 컨벤션 일치, i18n은 후속). spec R1/R2/R3.
- **세 Failed 전이는 전부 `runs::mark_failed_if_active`**(가드 `WHERE status IN ('pending','running')`, race-safe, terminal run 비클로버). 기존 `set_status(Failed, …)`를 *교체*. spec R4.
- **proto·worker·engine·migration·UI 무변경** — `RunStatus.message`(field 3)·`runs.message`(migration 0002)·`RunSchema.message`·`RunDetailPage`("실패 사유:")는 전부 기존. 머지 diff = `crates/controller`(+docs)만. spec R6/R7.
- **Completed/Aborted/Running `set_status` 호출 무변경**(실패 사유 없음). spec R6.
- **메시지 길이 cap** = char-safe ≤`MESSAGE_MAX_CHARS=1000`, 초과 시에만 `…` 마커. spec R5.
- **Task 1은 단일 green 커밋** — 미사용 헬퍼(dead_code)·RED-only 테스트 단독 커밋이 워크스페이스 게이트에 막히므로 헬퍼+배선+14 호출부+테스트를 한 커밋으로 fold. spec §8.
- TDD-guard: `coordinator.rs`는 인라인 `#[cfg(test)] mod tests`가 *이미* 있어 src 편집 자동 통과(키프얼라이브 불요).

---

### Task 1: 세 Failed 경로에 진단 message 부여 + record_phase message 관통

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs`
  - 헬퍼 추가(모듈 스코프, `impl CoordinatorState` 위 또는 근처)
  - `record_phase` 시그니처(`:838`) + `Finalize::Failed` arm(`:932-943`)
  - `worker_disconnected` fail 블록(`:981-997`)
  - `fail_incomplete_registration`(`:1003-1038`)
  - 프로덕션 핸들러 호출부(`:1316`)
  - 13개 인라인 테스트 `.record_phase(` 호출부 + 신규 단위 테스트 5종(`mod tests`, `:1553+`)
- Test: 같은 파일 인라인 `mod tests`

**Interfaces:**
- Consumes (기존): `runs::mark_failed_if_active(db, id, msg) -> sqlx::Result<bool>`(`store/runs.rs:407`, 가드 UPDATE + message)·`runs::get(db, id) -> Option<RunRow>`(`RunRow.message: Option<String>`, `:233`)·테스트 헬퍼 `seed_run(&db) -> String`(pending run)·`fake_tx()`·`base_assignment()`·`coord.enqueue(run_id, assignment, expected, total_vus, None)`·`coord.register(&run_id, wid, tx)`.
- Produces: `record_phase(&self, run_id: &str, worker_id: &str, phase: i32, message: &str)`(4-arg)·module-private `truncate_message(&str) -> String`·`failure_message(worker_id: &str, raw: &str) -> String`·const `MESSAGE_MAX_CHARS: usize = 1000`.

- [ ] **Step 1: 헬퍼 + 상수 추가**

`coordinator.rs` 모듈 스코프(다른 free fn `fan_out_abort` 근처)에 추가:

```rust
/// Free-form failure reasons persisted to `runs.message` (engine errors can be
/// long). Bound length so the DB column / UI row stays sane.
const MESSAGE_MAX_CHARS: usize = 1000;

/// Char-boundary-safe truncation. Appends `…` ONLY when truncated; returns the
/// input unchanged when it is within the cap.
fn truncate_message(s: &str) -> String {
    match s.char_indices().nth(MESSAGE_MAX_CHARS) {
        Some((byte_idx, _)) => format!("{}…", &s[..byte_idx]),
        None => s.to_string(),
    }
}

/// Build the persisted reason for a worker-reported `Phase::Failed`: the worker's
/// own `RunStatus.message` (the real engine error) when present, else a synthetic
/// fallback. Always length-bounded (R1 fallback + R5).
fn failure_message(worker_id: &str, raw: &str) -> String {
    if raw.trim().is_empty() {
        format!("worker {worker_id} reported failure")
    } else {
        truncate_message(raw)
    }
}
```

- [ ] **Step 2: `record_phase` 시그니처 + Failed arm**

`:838` 시그니처에 `message: &str` 추가:

```rust
pub async fn record_phase(&self, run_id: &str, worker_id: &str, phase: i32, message: &str) {
```

`Finalize::Failed(siblings)` arm(`:932-943`)을 교체:

```rust
            Finalize::Failed(siblings) => {
                let reason = failure_message(worker_id, message);
                let _ = runs::mark_failed_if_active(&self.db, run_id, &reason).await;
                fan_out_abort(run_id, &siblings, "sibling worker failed — fail-fast").await;
                self.cleanup_dispatcher(run_id).await;
            }
```

(Completed/Aborted arm은 무변경 — `set_status` 그대로.)

- [ ] **Step 3: 프로덕션 핸들러가 `s.message` 관통**

`:1316`을 교체:

```rust
                            state.record_phase(&s.run_id, wid, s.phase, &s.message).await;
```

- [ ] **Step 4: `worker_disconnected` fail 블록**

`:981-997`의 `if let Some(siblings)` 블록을 교체:

```rust
        if let Some(siblings) = siblings {
            let reason = truncate_message(&format!(
                "worker {worker_id} disconnected before completing the run"
            ));
            let _ = runs::mark_failed_if_active(&self.db, run_id, &reason).await;
            fan_out_abort(
                run_id,
                &siblings,
                "worker disconnected before completing — fail-fast",
            )
            .await;
            self.cleanup_dispatcher(run_id).await;
        }
```

- [ ] **Step 5: `fail_incomplete_registration` — 카운트 캡처 + message**

`:1003-1038` 전체를 교체(락 블록이 `(siblings, registered, expected)`를 캡처):

```rust
    pub async fn fail_incomplete_registration(&self, run_id: &str) {
        let result = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else {
                return;
            };
            if rw.terminal || rw.workers.len() as u32 >= rw.expected {
                None
            } else {
                rw.terminal = true;
                let registered = rw.workers.len();
                let expected = rw.expected;
                let siblings = rw.workers.values().map(|e| e.tx.clone()).collect::<Vec<_>>();
                Some((siblings, registered, expected))
            }
        };
        if let Some((siblings, registered, expected)) = result {
            let reason = truncate_message(&format!(
                "only {registered}/{expected} workers registered before the registration deadline"
            ));
            let _ = runs::mark_failed_if_active(&self.db, run_id, &reason).await;
            fan_out_abort(
                run_id,
                &siblings,
                "not all workers registered before deadline",
            )
            .await;
            self.cleanup_dispatcher(run_id).await;
        }
    }
```

- [ ] **Step 6: 13개 기존 테스트 `.record_phase(` 호출부에 message 인자 추가**

`mod tests`(`:1553+`)의 모든 `.record_phase(&run_id, "wN", pb::run_status::Phase::X as i32)` 호출에 4번째 인자를 더한다:
- `Phase::Completed` / `Phase::Aborted` 호출 → `, ""`
- `Phase::Failed` 호출(예 `finalize_failed_calls_dispatcher_cleanup` `:1639` 외 Failed 사이트) → `, "engine error"`

찾기: `grep -n "\.record_phase(" crates/controller/src/grpc/coordinator.rs`. 컴파일러가 빠뜨린 호출부를 "this method takes 4 arguments"로 전부 잡는다.

- [ ] **Step 7: 신규 단위 테스트 5종 추가**

`mod tests` 끝(다른 `#[tokio::test]` 뒤)에 추가:

```rust
    #[tokio::test]
    async fn record_phase_failed_persists_worker_message() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(
                &run_id,
                "w0",
                pb::run_status::Phase::Failed as i32,
                "Http(\"connection refused\")",
            )
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(row.message.as_deref(), Some("Http(\"connection refused\")"));
    }

    #[tokio::test]
    async fn record_phase_failed_empty_message_falls_back() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32, "")
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.message.as_deref(), Some("worker w0 reported failure"));
    }

    #[tokio::test]
    async fn worker_disconnected_records_failure_message() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        // w0 is still in `Started` (non-terminal) phase → crash fail-fast.
        coord.worker_disconnected(&run_id, "w0").await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(
            row.message.as_deref(),
            Some("worker w0 disconnected before completing the run")
        );
    }

    #[tokio::test]
    async fn incomplete_registration_records_failure_message() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        // expected = 2 but only w0 registers → incomplete at deadline.
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 8, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.fail_incomplete_registration(&run_id).await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(
            row.message.as_deref(),
            Some("only 1/2 workers registered before the registration deadline")
        );
    }

    #[test]
    fn truncate_message_is_char_safe() {
        // ≤ cap: returned unchanged, no marker.
        assert_eq!(truncate_message("boom"), "boom");
        // > cap ASCII: first MAX chars + marker.
        let long = "x".repeat(MESSAGE_MAX_CHARS + 50);
        let out = truncate_message(&long);
        assert_eq!(out.chars().count(), MESSAGE_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
        // > cap multibyte: must not panic, must stay valid UTF-8 (char boundary).
        let multi = "가".repeat(MESSAGE_MAX_CHARS + 50);
        let out = truncate_message(&multi);
        assert_eq!(out.chars().count(), MESSAGE_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
    }
```

- [ ] **Step 8: 컴파일 + 테스트 + clippy 확인**

먼저 워커 워밍(루트 CLAUDE.md cold-build flake 예방), 그다음:

Run:
```bash
cargo build -p handicap-worker --bin worker
cargo build -p handicap-controller --tests
cargo nextest run -p handicap-controller grpc::coordinator
cargo clippy -p handicap-controller --all-targets -- -D warnings
```
Expected: build 0 에러(빠진 `.record_phase(` 호출부 있으면 여기서 "takes 4 arguments"로 적발)·5 신규 테스트 + 기존 coordinator 테스트 전부 PASS·clippy 0 warning.

- [ ] **Step 9: 전체 워크스페이스 게이트(머지 안전)**

Run:
```bash
cargo nextest run --workspace
```
Expected: 전부 PASS(무변경 불변식 R6 — proto/worker/engine 미변경이라 다른 crate 회귀 0).

- [ ] **Step 10: Commit (단일 green 커밋, foreground, 폴링 금지)**

```bash
git add crates/controller/src/grpc/coordinator.rs
git commit -m "$(cat <<'EOF'
feat(controller): Failed run에 진단 사유 message 부여 (G3)

세 message-less Failed 전이(record_phase 워커-보고·worker_disconnected·
fail_incomplete_registration)를 set_status→mark_failed_if_active로 교체해
사유 message를 영속. record_phase에 message 파라미터를 더해 핸들러가 이미
받던 워커 RunStatus.message(엔진 실제 에러)를 관통. proto/worker/engine/
migration/UI 무변경. spec 2026-06-23-run-failure-reason-message.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
git log -1 --stat
```
Expected: 커밋 landed(파이프 없이 — exit code 가시성), diff = `coordinator.rs` 1파일.

**Acceptance (이 task가 닫는 R):** R1(워커 message 영속 + 빈→fallback)·R2(disconnect 합성)·R3(registration 합성 + 카운트)·R4(전부 mark_failed_if_active)·R5(char-safe cap)·R6(proto/worker/engine/migration diff 0·nextest green)·R7(ui/ diff 0·migration 불변)·R9(14 호출부·clippy 0). 검증 = Step 8/9 출력.

---

### Task 2: 스테일 문서 정정 (R8)

**Files:**
- Modify: `CLAUDE.md`(root, 로컬 dev 실행 함정 §)
- Modify: `docs/roadmap.md`(§B3)
- Modify: `crates/controller/CLAUDE.md`(Dispatch 실패 처리 §)

> **참고**: docs-only 커밋이라 pre-commit fast-path(cargo 게이트 skip). finish-slice의 build-log/상태줄 갱신과 **별개** — 여기선 *오기재 정정*만.

- [ ] **Step 1: root `CLAUDE.md` — status-transition 갭 footgun 정정**

`CLAUDE.md`의 "로컬 dev 실행 함정"에서 worker-exit 함정 항목을 찾는다(현재 "**증상 함정**: 워커가 죽어도 run은 `failed`로 안 가고 `running`에 멈춘 채 요청수 0 — … status-transition 갭 = `docs/followups-after-mvp1.md` "열린 항목 A""). 정정:
- 워커 *종료*(exit/disconnect) 시 run이 `failed`로 즉시 전이됨을 명시(2026-06-05 reaper + worker_disconnected fail-fast). "영영 running + 0 req"는 이제 등록 후 *hung*(살아있지만 무진행) 워커에 한정(G1 — 별도 후속).
- 더 이상 "열린 항목 A"로 가리키지 않게(followups가 권위 — "열린 항목 없음"). 실패 run은 이제 `message`(실패 사유)를 가지므로 controller 로그뿐 아니라 run 상세에서도 사유 확인 가능.

- [ ] **Step 2: `docs/roadmap.md` §B3 정정**

§B3("슬라이스 무관 tech-debt")의 "현재 열린 항목 A = subprocess 워커 비정상 종료 시 run이 `running`에 멈추는 status-transition 갭" 문장을 제거하고 followups/`:44`와 정합("열린 항목 없음")시킨다. **stale 라인은 §B3 본문(~:244) 한 곳** — `docs/roadmap.md:44`는 이미 "열린 항목 없음"이라 둘이 모순이다(`:44`는 옳으니 건드리지 말 것). 잔존 G1(hung 워커 진행 라이브니스)·G2(k8s register-전 사망 reaper)를 후속 후보로 한 줄 추가.

- [ ] **Step 3: `crates/controller/CLAUDE.md` "Dispatch 실패 처리" § 두 줄 정정**

- "set_status엔 message 컬럼이 없어 watchdog/fail-fast 경로는 message가 NULL이다" → "이제 세 Failed 경로(record_phase 워커-보고·worker_disconnected·fail_incomplete_registration)가 `mark_failed_if_active`로 사유 message를 남긴다(record_phase는 워커 `s.message` 관통)".
- "`mark_failed`는 단일 run에 `message`를 남기는 **유일한** 헬퍼" → 정정("`mark_failed`/`mark_failed_if_active` 둘 다 message를 남긴다; set_status는 message 컬럼 비경유"). 이 진술은 *이미* 거짓 — 2026-06-05 reaper가 `mark_failed_if_active`로 message를 남겨왔다(이 슬라이스는 세 번째 사이트를 추가). 정정문은 그 reaper 선례를 반영.

- [ ] **Step 4: 잔존-문구 grep 확인**

Run:
```bash
grep -rn "열린 항목 A\|영영 running\|유일한 헬퍼" CLAUDE.md docs/roadmap.md crates/controller/CLAUDE.md
```
Expected: grep 결과는 **0이 아니다**(직접 grep으로 라인 확인). "열린 항목 A"는 *해소/구-followups* 맥락 — `docs/followups-after-mvp1.md:14`(처리 기록 헤더)·`docs/roadmap.md:44`(완료 엔트리, 같은 줄에 "열린 항목 = 없음")·`crates/controller/CLAUDE.md:119`("구 followups 열린 항목 A") — 에서, "영영 running"은 `docs/roadmap.md:20`(L6 완료 서술)·`:44`(해소 서술)에서 정당하게 살아남는다. 그 줄들은 옳으니 *건드리지 말 것*(literal하게 전부 지우면 안 됨). *열린 버그*로 가리키던 stale 라인 — root `CLAUDE.md:104`·roadmap §B3 본문 `:244` — 만 사라져야 한다(`roadmap.md:44`는 이미 "없음"이라 옳음 → 보존). "유일한 헬퍼"는 단일 occurrence(`crates/controller/CLAUDE.md:120`)라 정정 후 clean 0.

- [ ] **Step 5: Commit (docs-only fast-path, foreground)**

```bash
git add CLAUDE.md docs/roadmap.md crates/controller/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: status-transition 갭 스테일 포인터 정정 (G3 — 이미 수정됨)

heading "stuck running" 버그는 2026-06-05 수정 완료(followups "열린 항목
없음")인데 root CLAUDE.md·roadmap §B3가 아직 "열린 항목 A"로 가리키던 드리프트
정정 + 잔존 G1(hung 워커)/G2(k8s) 후속 명시. controller CLAUDE.md의
"message=NULL"·"유일한 헬퍼" 절도 이번 슬라이스에 맞춰 갱신.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
git log -1 --stat
```
Expected: 커밋 landed, diff = 3 docs 파일.

**Acceptance (이 task가 닫는 R):** R8(스테일 포인터 0·"유일한 헬퍼" 잔존 0). 검증 = Step 4 grep.

---

## 라이브 검증 + 최종 리뷰 (구현 후, finish-slice 전)

> Task 1/2 머지 전. plan 실행 subagent가 아니라 orchestrator가 수행.

- **라이브 검증 필수**(run 상태 전이 경로 — S-D 갭): `/live-verify`로 실 controller+worker 기동 후
  - ① **워커-보고 실패**: connection-refused URL(또는 `assert status:200`인데 SUT 500) 시나리오 run → `GET /api/runs/{id}`의 `message`에 엔진 사유(R1). 실 `/report`/run 객체가 `RunSchema.parse` 통과(S-D 갭).
  - ② **비-terminal 단절**: run 중 워커 프로세스 `kill` → run `failed` + `message`에 합성 disconnect 문구(R2).
- **최종 리뷰**: `handicap-reviewer`(R4 가드 불변식·R6 무변경·14 호출부 완전성·wire 무변경) + `security-reviewer`(spec §3.3 path-gate — `record_phase` `s.message` 영속이 URL/시크릿을 노출하는 표면; redaction 비목표 확인·R5 cap 검토).

---

<!-- REVIEW-GATE: APPROVED -->
<!-- spec-plan-reviewer: spec round1 APPROVE-WITH-FIXES → fixes → round3 clean APPROVE; plan round1 clean APPROVE + grep-guard 인용 ground-truth 정정 후 round3 clean APPROVE (2026-06-23). -->

