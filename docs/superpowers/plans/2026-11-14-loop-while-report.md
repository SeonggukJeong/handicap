# 조건 반복 2차 — 리포트 표시 (loop-while-report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조건 반복이 있었던 run의 리포트에서 재시도·중단·끊긴 진입을 알아보게 한다(스텝 행 표지 + 풀이 줄 + 회차 분포 + 맨 위 안내).

**Architecture:** 엔진 `Aggregator`가 조건 반복 진입이 끝날 때마다 `(loop id, 회차 칸, 끝난 방식)` 건수와 회차 합을 세고, 기존 send 실패 종류 집계(`error_kind`)와 같은 길(`MetricFlush` → proto `MetricBatch` 필드 11 → 워커 → 컨트롤러 ingest → 새 테이블 upsert → `ReportJson.loop_exits`)로 나른다. 화면은 `loop_exits`와 시나리오 YAML로 계산한 뷰 모델 하나(`loopExitView.ts`)를 네 곳(표지·풀이 줄·분포 패널·맨 위 안내)이 쓴다. 집계가 없는 run은 전 계층 무변경.

**Tech Stack:** Rust(tokio, wiremock, sqlx/SQLite, prost), React/TypeScript(Zod, vitest + RTL, Tailwind).

**Spec:** `docs/superpowers/specs/2026-11-14-loop-while-report-design.md` — US 블록(헤딩 `## 사용자 스토리 (US)`부터 `## 1. 목표·비목표` 앞까지)을 매 task brief에 첨부한다.

REVIEW-GATE: APPROVED

(spec 4회차·plan 2회차 `spec-plan-reviewer` clean APPROVE, 2026-11-14)

## Global Constraints

- 워크트리: `/Users/sgj/develop/handicap/.claude/worktrees/loop-while-report` (브랜치 `worktree-loop-while-report`). subagent prompt 첫 줄에 이 `cd`를 쓴다.
- **R0**: 조건 반복 집계가 한 건도 없는 run은 `MetricBatch`·DB·리포트 JSON(`loop_exits` 키 없음)·리포트 화면 DOM이 지금과 같다. 기존 테스트를 고쳐서 통과시키지 않는다 — 기존 테스트가 깨지면 STOP하고 보고(예외: 구조체 리터럴·함수 인자에 새 필드/인자를 더하는 기계적 수정).
- 상수·와이어 값(byte-exact): `LOOP_EXIT_PASS_CAP = 20` · 회차 칸 = `passes.min(21)`(21 = "21번째 이후") · `outcome` 0 완료·1 중단·2 마치지 못함 · proto `MetricBatch.loop_exit_stats = 11` · 테이블 `run_loop_exit_metrics` · JSON 키 `loop_exits`/`entered`/`passes`/`exhausted`/`truncated`/`buckets`/`pass`/`completed`.
- 엔진 `runner.rs`의 조건 반복 가지는 **기록만 더한다** — 반환값·흐름·실행 순서를 바꾸지 않는다. `trace.rs`·`crates/tui/` 무변경.
- 건드리지 않는 것: `validity.rs`·`insights.rs`·내보내기 출력(`export.rs`의 production 코드)·인쇄(`ui/src/print/`)·비교(`ui/src/compare/`)·기존 ▸ 토글(`StepStatsTable`의 `loop_breakdown` 표).
- 문구는 전부 `ui/src/i18n/ko.ts` 경유. 문구 정본은 Task 6의 표(byte-exact).
- 숫자는 `toLocaleString("en-US")`, 비율은 `floorPct`(`ui/src/components/report/format.ts`).
- 인라인 Rust는 clippy `-D warnings` 통과(2-arm `match … _ => {}` 대신 `if let`).
- 커밋: 단일 foreground 호출(600000ms), 파이프 금지, 메시지는 `-F <파일>`, `--no-verify` 금지. cargo 게이트가 도는 동안 다른 `cargo` 금지. 워크트리-격리 세션은 `cd … && git …`·`$VAR` 경로·`$(…)`가 든 git 호출을 거부한다 — 단독 호출로.
- 커밋 전 `cargo fmt --all`(pre-commit이 `fmt --check`를 돈다 — 이 문서의 인라인 Rust는 rustfmt 줄바꿈을 맞추지 않았다). UI 파일은 편집 훅이 prettier를 돈다.
- Task 5 커밋과 Task 6 커밋 사이에서 브랜치를 머지·분할하지 않는다(서버가 `loop_exits`를 내는데 UI `ReportSchema`가 `.strict()`라 Task 6 전에는 그 리포트를 거부한다).
- `tdd-guard`: `crates/*/src`·`ui/src` production 파일을 고치기 전에 그 task의 테스트 파일을 먼저 쓴다(각 task Step 1).
- 이빨 실증: "**이빨**"이라고 적힌 스텝은 지정한 production 줄을 일시로 되돌려 RED를 확인하고 원복해 GREEN을 확인한 뒤, 보고서에 RED 출력 한 줄을 적는다.
- 줄번호는 저작 시점 `grep -n` 값이다. 편집 전에 같은 `grep -n`으로 다시 확인한다.
- 짝 맞추기 기준: 이 작업은 `error_kind` 길을 그대로 따른다. 각 task는 끝에 `grep -rn 'error_kind' <그 crate>`로 그 길의 지점을 열거해 `loop_exit` 짝이 빠진 곳이 없는지 확인한다(분류 함수 `classify_send_error`·`ErrorKind` enum·`export.rs`·`insights.rs`·`validity.rs`·`crates/tui`는 짝 대상이 아니다).

## Review Focus

spec이 암시하지만 놓치기 쉬운 입력. 괄호 안이 그 테스트가 든 task다.

1. 끝내 풀리지 않는 무제한 조건 반복 — 모든 진입이 "마치지 못함"이어도 재시도가 집계된다 (Task 2 지점 3, Task 6 `loopExitView`의 `retries`).
2. 회차 칸 경계 20/21/500과 `passes == 0`(기록 없음) (Task 1).
3. 조건 반복 집계만 든 주기 flush(완료된 초 창이 없는 틱)가 버려지지 않는다 — 가드 5곳 (Task 2 `*_flushes_loop_exits`).
4. 워커가 보낸 `pass_bucket: 0`·`9999`·`outcome: 7` (Task 4 ingest clamp·버림).
5. `repeat: 1` 조건 반복 — 재시도 0·중단만 있는 안내 문구, 표지 없음 (Task 6·8).
6. 루프 집계 상한 0인 run(`loop_breakdown` 빈 배열)의 표지 판정 갈래 (Task 6).
7. 본문 if 안에서 성공 회차에만 도는 스텝 — 표지가 붙지 않는다 (Task 6).
8. 시나리오 YAML 파싱 실패 — 이름은 id, 표지 없음, 나머지는 그린다 (Task 6).
9. `loop_exits`가 없을 때 `StepStatsTable`·`StepPhaseBreakdown`·`ReportView` DOM 불변 (Task 7·8).

---

### Task 1: 엔진 — `Aggregator` 집계 + `MetricFlush` 배선

**Files:**
- Create: `crates/engine/tests/loop_exit.rs` (이 task에서는 머리 주석과 재수출 컴파일 테스트 1개)
- Modify: `crates/engine/src/aggregator.rs` — 타입(`ErrorKindStat` 정의 뒤, 45행 부근)·`Aggregator` 필드(`error_kind_counts` 뒤, 159행)·`new`(178행)·메서드(`drain_error_kind_deltas` 뒤, 268행)·인라인 테스트(`drain resets` 테스트 뒤)
- Modify: `crates/engine/src/runner.rs` — `use`(16행), `MetricFlush`(128행 `error_kind_stats` 뒤), drain 6곳·가드 5곳(아래 표)
- Modify: `crates/engine/src/lib.rs:19-22` — 재수출
- Modify: `crates/engine/CLAUDE.md` — "오픈루프" 절 `error_kind_stats`(8번째 벡터) 불릿 뒤에 한 줄

**Interfaces:**
- Produces: `pub const LOOP_EXIT_PASS_CAP: u32 = 20` · `pub enum LoopExitOutcome { Completed, Exhausted, Truncated }` + `pub fn as_wire(self) -> u32` · `pub struct LoopExitStat { pub step_id: String, pub pass_bucket: u32, pub outcome: LoopExitOutcome, pub count: u64, pub pass_sum: u64 }` · `Aggregator::record_loop_exit(&mut self, loop_id: &str, passes: u32, outcome: LoopExitOutcome)` · `Aggregator::drain_loop_exit_deltas(&mut self) -> Vec<LoopExitStat>` · `MetricFlush.loop_exit_stats: Vec<LoopExitStat>`

- [ ] **Step 1: 테스트 파일을 먼저 만든다** — `crates/engine/tests/loop_exit.rs`

```rust
//! 조건 반복 리포트 집계(loop-while-report) — 진입이 끝난 회차·방식 건수가 flush에 실린다.
use handicap_engine::{LOOP_EXIT_PASS_CAP, LoopExitOutcome, LoopExitStat};

#[test]
fn loop_exit_wire_values_are_fixed() {
    assert_eq!(LOOP_EXIT_PASS_CAP, 20);
    assert_eq!(LoopExitOutcome::Completed.as_wire(), 0);
    assert_eq!(LoopExitOutcome::Exhausted.as_wire(), 1);
    assert_eq!(LoopExitOutcome::Truncated.as_wire(), 2);
    let s = LoopExitStat {
        step_id: "l".into(),
        pass_bucket: 21,
        outcome: LoopExitOutcome::Truncated,
        count: 1,
        pass_sum: 500,
    };
    assert_eq!(s.pass_bucket, LOOP_EXIT_PASS_CAP + 1);
}
```

- [ ] **Step 2: `aggregator.rs` 인라인 테스트를 쓴다** (`#[cfg(test)] mod tests` 안, `drain_error_kind` 테스트 뒤)

```rust
    #[test]
    fn loop_exit_buckets_cap_at_21_and_keep_real_pass_sum() {
        let mut a = Aggregator::new(0); // loop_breakdown_cap과 무관함을 0으로 보인다
        a.record_loop_exit("l1", 20, LoopExitOutcome::Completed);
        a.record_loop_exit("l1", 21, LoopExitOutcome::Completed);
        a.record_loop_exit("l1", 500, LoopExitOutcome::Completed);
        a.record_loop_exit("l1", 3, LoopExitOutcome::Exhausted);
        a.record_loop_exit("l1", 3, LoopExitOutcome::Exhausted);
        a.record_loop_exit("l1", 2, LoopExitOutcome::Truncated);
        a.record_loop_exit("l1", 0, LoopExitOutcome::Truncated); // 본문 시작 전 — 기록 없음
        let mut v: Vec<_> = a
            .drain_loop_exit_deltas()
            .into_iter()
            .map(|s| (s.step_id, s.pass_bucket, s.outcome.as_wire(), s.count, s.pass_sum))
            .collect();
        v.sort();
        assert_eq!(
            v,
            vec![
                ("l1".to_string(), 2, 2, 1, 2),
                ("l1".to_string(), 3, 1, 2, 6),
                ("l1".to_string(), 20, 0, 1, 20),
                ("l1".to_string(), 21, 0, 2, 521),
            ]
        );
        assert!(a.drain_loop_exit_deltas().is_empty(), "drain resets");
    }
```

- [ ] **Step 3: RED 확인** — `cargo test -p handicap-engine --lib loop_exit_buckets` → 컴파일 에러(`record_loop_exit` 없음).

- [ ] **Step 4: `aggregator.rs` 구현**

타입(`ErrorKindStat` 구조체 뒤):

```rust
/// 조건 반복(`while` loop) 진입 한 번이 끝난 회차 칸의 상한. 21 이상은 한 칸
/// (`LOOP_EXIT_PASS_CAP + 1`)으로 합친다. run 설정 `loop_breakdown_cap`과 무관한 고정 상수.
pub const LOOP_EXIT_PASS_CAP: u32 = 20;

/// 조건 반복 진입이 끝난 방식 (spec 2026-11-14-loop-while-report §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LoopExitOutcome {
    /// 조건이 거짓이 되어 끝남.
    Completed,
    /// 최대 횟수까지 조건이 참 — `EndIteration`.
    Exhausted,
    /// 스스로 끝나기 전에 밖에서 끊김(deadline·취소·본문의 비-`Continue` 흐름·`Err`).
    Truncated,
}

impl LoopExitOutcome {
    /// proto·DB 와이어 값. 0 완료 · 1 중단 · 2 마치지 못함.
    pub fn as_wire(self) -> u32 {
        match self {
            LoopExitOutcome::Completed => 0,
            LoopExitOutcome::Exhausted => 1,
            LoopExitOutcome::Truncated => 2,
        }
    }
}

/// A per-(loop_id, pass_bucket, outcome) delta since the last drain. counts-only.
/// `pass_sum`은 칸으로 합치기 전의 실제 회차 수 합이다(재시도 = pass_sum − count).
#[derive(Debug, Clone)]
pub struct LoopExitStat {
    pub step_id: String,
    pub pass_bucket: u32, // 1..=LOOP_EXIT_PASS_CAP, 또는 LOOP_EXIT_PASS_CAP + 1 = "그 이상"
    pub outcome: LoopExitOutcome,
    pub count: u64,
    pub pass_sum: u64,
}
```

`Aggregator` 필드(`error_kind_counts` 뒤):

```rust
    /// per-(loop_id, pass_bucket, outcome) 조건 반복 진입 종료 델타: (건수, 회차 합).
    loop_exit_counts: HashMap<(String, u32, LoopExitOutcome), (u64, u64)>,
```

`new`에 `loop_exit_counts: HashMap::new(),`.

메서드(`drain_error_kind_deltas` 뒤):

```rust
    /// 조건 반복 진입 한 번의 종료를 센다. `passes` = 시작한 본문 회차 수.
    /// 0이면(본문 시작 전에 끊김) 아무것도 세지 않는다.
    pub fn record_loop_exit(&mut self, loop_id: &str, passes: u32, outcome: LoopExitOutcome) {
        if passes == 0 {
            return;
        }
        let bucket = passes.min(LOOP_EXIT_PASS_CAP + 1);
        let e = self
            .loop_exit_counts
            .entry((loop_id.to_string(), bucket, outcome))
            .or_default();
        e.0 += 1;
        e.1 += u64::from(passes);
    }

    pub fn drain_loop_exit_deltas(&mut self) -> Vec<LoopExitStat> {
        std::mem::take(&mut self.loop_exit_counts)
            .into_iter()
            .map(|((step_id, pass_bucket, outcome), (count, pass_sum))| LoopExitStat {
                step_id,
                pass_bucket,
                outcome,
                count,
                pass_sum,
            })
            .collect()
    }
```

- [ ] **Step 5: `lib.rs` 재수출** — `pub use aggregator::{…}` 목록에 `LOOP_EXIT_PASS_CAP, LoopExitOutcome, LoopExitStat` 추가.

- [ ] **Step 6: `MetricFlush` + drain 6곳 + 가드 5곳** (`runner.rs`)

`MetricFlush`에 (`error_kind_stats` 뒤):

```rust
    /// Per-(loop_id, pass_bucket, outcome) 조건 반복 진입 종료 델타 (loop-while-report).
    /// 조건 반복이 없는 run은 항상 빈 Vec.
    pub loop_exit_stats: Vec<LoopExitStat>,
```

`use` 줄(16행)의 aggregator 목록에 `LoopExitStat` 추가.

지점은 `grep -n 'drain_error_kind_deltas\|error_kind.*is_empty()\|error_kind_stats' crates/engine/src/runner.rs`로 다시 확인한다(저작 시점 값):

| 실행 방식 | drain(튜플에 `g.drain_loop_exit_deltas()` 추가) | 가드(`|| !<이름>.is_empty()` 추가) | 리터럴(`loop_exit_stats: <이름>` 추가) |
|---|---|---|---|
| closed 주기 | 288 | 296 | 314 |
| closed 마지막 | 343 | 351 | 362 |
| VU 곡선 주기 | 1071 | 1080 | 1090 |
| VU 곡선 마지막 | 1233 | 1242 | 1253 |
| open 주기 | 1576 | 1584 (`has_data`) | 1602 |
| open 마지막 | 1745 | **없음**(조건 없이 보냄 — 1749행 주석에 `loop_exit_stats`도 가드 항이 없다고 한 구절 덧붙임) | 1760 |

각 drain 튜플의 구조 분해 이름에 주기는 `loop_exit_stats`, 마지막은 `final_loop_exits`를 더한다. 여섯 곳 모두 `g.drain_error_kind_deltas()` 바로 뒤에 `g.drain_loop_exit_deltas()`.

- [ ] **Step 7: GREEN 확인** — `cargo test -p handicap-engine --lib loop_exit_buckets` · `cargo test -p handicap-engine --test loop_exit` · `cargo build --workspace --tests`(다른 crate가 `MetricFlush {` 리터럴을 짓지 않음을 확인: `grep -rn 'MetricFlush {' crates --include='*.rs'`의 출력이 `crates/engine/src/runner.rs`뿐).

- [ ] **Step 8: `crates/engine/CLAUDE.md` 한 줄** — "`error_kind_stats`(8번째 벡터 …" 불릿 바로 뒤:

```markdown
- **`loop_exit_stats`(9번째 벡터, loop-while-report) = generic 패턴 그대로 6드레인+5가드** + 워커 forwarder 스킵 가드에 `&& loop_exit_stats.is_empty()`. 기록은 runner 조건 반복 가지의 다섯 지점(완료·중단·머리 deadline·머리 취소·본문 비-`Continue`/`Err`) — 흐름은 바꾸지 않고 `record_loop_exit`만 부른다. 회차 칸 상한 `LOOP_EXIT_PASS_CAP`(20)은 `loop_breakdown_cap`과 무관.
```

- [ ] **Step 9: 커밋** — `feat(engine): 조건 반복 진입 종료 집계 + MetricFlush 배선 (loop-while-report)`

---

### Task 2: 엔진 — 조건 반복 가지의 기록 다섯 지점

**Files:**
- Modify: `crates/engine/src/runner.rs:625-680` (조건 반복 가지) + `use`(16행에 `LoopExitOutcome`)
- Test: `crates/engine/tests/loop_exit.rs`

**Interfaces:**
- Consumes: Task 1의 `record_loop_exit`·`MetricFlush.loop_exit_stats`.

- [ ] **Step 1: 테스트를 쓴다** (`loop_exit.rs`에 추가)

도우미는 `crates/engine/tests/loop_while.rs`에서 **그대로 복사**한다: `ORDER_ID`·`plan`(15–36행)·`paths`·`count`·`wait_resp`·`ok_resp`·`scenario_yaml`·`WHILE_WAIT`·`mount_after`. 실행 도우미는 방식·취소를 받도록 새로 쓴다(`error_kind_flush.rs`의 `Mode`·`collect_flushes` 꼴):

```rust
#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

struct Out {
    ok: bool,
    flushes: Vec<MetricFlush>,
}

/// `cancel_after`가 Some이면 그 시간 뒤 취소 토큰을 취소한다.
async fn run_mode(yaml: &str, ms: u64, mode: Mode, cancel_after: Option<Duration>) -> Out {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let mut p = plan(ms);
    if let Mode::Open = mode {
        p.target_rps = Some(50);
        p.max_in_flight = Some(4);
    }
    if let Mode::Curve = mode {
        p.vu_stages = Some(vec![handicap_engine::Stage {
            target: 1,
            duration_seconds: (ms / 1000).max(1) as u32,
        }]);
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(1024);
    let cancel = CancellationToken::new();
    if let Some(d) = cancel_after {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            c.cancel();
        });
    }
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, p, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, p, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, p, tx, cancel)),
    };
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    let ok = h.await.expect("join").is_ok();
    Out { ok, flushes }
}

/// (pass_bucket, outcome 와이어 값) → (건수, 회차 합), 전 flush 합산.
fn exits(out: &Out) -> BTreeMap<(u32, u32), (u64, u64)> {
    let mut m: BTreeMap<(u32, u32), (u64, u64)> = BTreeMap::new();
    for s in out.flushes.iter().flat_map(|f| f.loop_exit_stats.iter()) {
        let e = m.entry((s.pass_bucket, s.outcome.as_wire())).or_default();
        e.0 += s.count;
        e.1 += s.pass_sum;
    }
    m
}

fn total_pass_sum(out: &Out) -> u64 {
    exits(out).values().map(|v| v.1).sum()
}

fn outcome_count(out: &Out, wire: u32) -> u64 {
    exits(out)
        .iter()
        .filter(|((_, o), _)| *o == wire)
        .map(|(_, v)| v.0)
        .sum()
}
```

테스트(이름·단언 그대로):

```rust
/// 지점 1: 2번 WAIT 뒤 OK → 첫 진입은 3번째에 완료, 이후 진입은 1번째에 완료.
#[tokio::test]
async fn site1_completed_records_pass_count() {
    let server = MockServer::start().await;
    Mock::given(path("/order")).respond_with(wait_resp()).up_to_n_times(2).mount(&server).await;
    Mock::given(path("/order")).respond_with(ok_resp()).mount(&server).await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 600, Mode::Closed, None).await;
    assert!(out.ok);
    let e = exits(&out);
    assert_eq!(e.get(&(3, 0)), Some(&(1, 3)), "{e:?}");
    assert!(e.get(&(1, 0)).is_some_and(|v| v.0 >= 1 && v.1 == v.0), "{e:?}");
    assert_eq!(outcome_count(&out, 1), 0);
}

/// 지점 2: 끝내 WAIT + 최대 3 → 중단은 전부 3번째 칸, 회차 합 = 3 × 건수.
#[tokio::test]
async fn site2_exhausted_records_max_passes() {
    let server = MockServer::start().await;
    Mock::given(path("/order")).respond_with(wait_resp()).mount(&server).await;
    mount_after(&server).await;
    let head = format!("{WHILE_WAIT}\n    repeat: 3");
    let y = scenario_yaml(&server.uri(), &head, "", false);
    let out = run_mode(&y, 600, Mode::Closed, None).await;
    assert!(out.ok);
    let e = exits(&out);
    let ex = e.get(&(3, 1)).copied().unwrap_or_default();
    assert!(ex.0 >= 1, "{e:?}");
    assert_eq!(ex.1, ex.0 * 3);
    assert_eq!(outcome_count(&out, 1), ex.0, "중단은 3번째 칸에만: {e:?}");
    assert_eq!(outcome_count(&out, 0), 0);
}

/// 지점 3: think time 없는 무제한 조건 반복이 deadline에 끊긴다 → 진입 1건이 "마치지 못함",
/// 회차 합 = 보낸 요청 수(끊긴 곳이 회차 머리이므로 시작한 회차는 전부 요청을 보냈다).
#[tokio::test]
async fn site3_deadline_at_pass_head_records_truncated() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp().set_delay(Duration::from_millis(20)))
        .mount(&server)
        .await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 400, Mode::Closed, None).await;
    assert!(out.ok);
    let reqs = count(&paths(&server).await, "/order") as u64;
    assert!(reqs >= 2, "reqs={reqs}");
    assert_eq!(outcome_count(&out, 2), 1, "{:?}", exits(&out));
    assert_eq!(outcome_count(&out, 0) + outcome_count(&out, 1), 0);
    assert_eq!(total_pass_sum(&out), reqs);
}

/// 지점 4: 요청이 진행 중일 때 취소 → 그 요청이 끝난 뒤 회차 머리의 취소 검사에서 끊긴다.
#[tokio::test]
async fn site4_cancel_at_pass_head_records_truncated() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp().set_delay(Duration::from_millis(30)))
        .mount(&server)
        .await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 5000, Mode::Closed, Some(Duration::from_millis(200))).await;
    assert!(!out.ok, "취소된 run은 Err(Aborted)");
    let reqs = count(&paths(&server).await, "/order") as u64;
    assert_eq!(outcome_count(&out, 2), 1, "{:?}", exits(&out));
    assert_eq!(total_pass_sum(&out), reqs);
}

/// 지점 5(비-Continue): 본문 think time 도중 deadline → 끊긴 회차 포함 1회, 요청 1건.
#[tokio::test]
async fn site5_deadline_during_think_records_started_pass() {
    let server = MockServer::start().await;
    Mock::given(path("/order")).respond_with(wait_resp()).mount(&server).await;
    let think = "        think_time: { min_ms: 2000, max_ms: 2000 }\n";
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, think, false);
    let out = run_mode(&y, 300, Mode::Closed, None).await;
    assert!(out.ok);
    assert_eq!(count(&paths(&server).await, "/order"), 1);
    assert_eq!(exits(&out).get(&(1, 2)), Some(&(1, 1)), "{:?}", exits(&out));
}

/// 지점 5(Err): 2번째 회차 렌더에서 캐스트 실패 → 에러는 전과 같이 전파(전 VU 실패 → run Err),
/// 그 진입은 (2번째 칸, 마치지 못함) 1건·회차 합 2·요청 1건.
#[tokio::test]
async fn site5_body_error_records_and_still_propagates() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT","n":"abc"}"#))
        .mount(&server)
        .await;
    let y = format!(
        r#"version: 1
name: while-cast
variables:
  base: "{base}"
  code: ""
  n: "1"
steps:
  - id: "01HX0000000000000000000001"
    name: poll
    type: loop
{WHILE_WAIT}
    do:
      - id: "{ORDER_ID}"
        name: order
        type: http
        request:
          method: POST
          url: "{{{{base}}}}/order"
          body: {{ json: {{ n: "{{{{n:num}}}}" }} }}
        assert: []
        extract:
          - {{ var: code, from: body, path: "$.code" }}
          - {{ var: n, from: body, path: "$.n" }}
"#,
        base = server.uri()
    );
    let out = run_mode(&y, 2000, Mode::Closed, None).await;
    assert!(!out.ok, "캐스트 실패는 VU를 죽이고 run은 AllVusFailed");
    assert_eq!(count(&paths(&server).await, "/order"), 1);
    assert_eq!(exits(&out), BTreeMap::from([((2, 2), (1, 2))]));
}

/// R0: while 없는 loop과 loop 없는 시나리오는 집계가 비어 있다.
#[tokio::test]
async fn plain_loop_and_flat_scenarios_record_nothing() {
    let server = MockServer::start().await;
    Mock::given(path("/order")).respond_with(ok_resp()).mount(&server).await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), "    repeat: 2", "", false);
    let out = run_mode(&y, 300, Mode::Closed, None).await;
    assert!(out.ok);
    assert!(out.flushes.iter().all(|f| f.loop_exit_stats.is_empty()));
}

/// 세 실행 방식: 주기 flush와 마지막 flush 양쪽에 실리고, 어떤 델타도 버려지지 않는다.
/// 본문이 스텝 하나라 `0 ≤ 회차 합 − 요청 수 ≤ 마치지 못함 건수`.
async fn assert_flushes_loop_exits(mode: Mode) {
    let server = MockServer::start().await;
    Mock::given(path("/order")).respond_with(ok_resp()).mount(&server).await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 3000, mode, None).await;
    assert!(out.ok);
    let loaded = out.flushes.iter().filter(|f| !f.loop_exit_stats.is_empty()).count();
    assert!(loaded >= 2, "주기+마지막 flush에 실려야 한다: {loaded}");
    let reqs = count(&paths(&server).await, "/order") as u64;
    let sum = total_pass_sum(&out);
    let trunc = outcome_count(&out, 2);
    assert!(sum >= reqs && sum - reqs <= trunc, "sum={sum} reqs={reqs} trunc={trunc}");
}

#[tokio::test]
async fn closed_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Closed).await;
}
#[tokio::test]
async fn curve_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Curve).await;
}
#[tokio::test]
async fn open_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Open).await;
}
```

`use` 줄은 필요한 것만: `std::collections::BTreeMap`, `std::sync::Arc`, `std::time::Duration`, `handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario, run_scenario_open_loop, run_scenario_vu_curve}`, tokio mpsc, `CancellationToken`, wiremock.

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test loop_exit` → `site*`·`*_flushes_loop_exits` 실패(집계가 비어 있음), `plain_loop_and_flat…`·`loop_exit_wire_values…`는 통과. (`site5_body_error…`의 YAML이 파싱되지 않으면 테스트 YAML만 고친다 — `crates/engine/tests/json_cast.rs`의 본문 표기를 따른다. 의미는 유지: 2번째 회차 렌더에서 `CastFailed`.)

- [ ] **Step 3: 구현** — `runner.rs` 조건 반복 가지를 아래로 바꾼다(기록 줄과 `match` 풀기 외에는 원문 그대로). `use` 16행 목록에 `LoopExitOutcome` 추가.

```rust
                if let Some(cond) = lp.while_.as_ref() {
                    // do-while: 본문을 먼저 돌리고 조건을 본다. 최대 횟수(repeat)에 닿으면
                    // 이번 반복을 끝낸다(EndIteration) — deadline/abort가 아니다.
                    // 진입이 끝나는 다섯 지점에서 리포트 집계만 남긴다(흐름 불변,
                    // spec 2026-11-14-loop-while-report §3.1).
                    let max = lp.max_passes();
                    let mut pass: u32 = 0;
                    loop {
                        if Instant::now() >= deadline {
                            if pass > 0 {
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass,
                                    LoopExitOutcome::Truncated,
                                );
                            }
                            return Ok(StepFlow::DeadlineReached);
                        }
                        if cancel.is_cancelled() {
                            if pass > 0 {
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass,
                                    LoopExitOutcome::Truncated,
                                );
                            }
                            return Ok(StepFlow::Aborted);
                        }
                        let res = Box::pin(execute_steps(
                            client,
                            &lp.do_,
                            iter_vars,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            Some(pass),
                            cancel,
                            rng,
                            measure_phases,
                            default_think,
                            req,
                            true,
                        ))
                        .await;
                        let flow = match res {
                            Ok(StepFlow::Continue) => StepFlow::Continue,
                            other => {
                                // 본문이 끊겼다(비-Continue 흐름 또는 Err) — 끊긴 회차까지 센다.
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass.saturating_add(1),
                                    LoopExitOutcome::Truncated,
                                );
                                return other;
                            }
                        };
                        debug_assert!(matches!(flow, StepFlow::Continue));
                        pass = pass.saturating_add(1);
                        let again = {
                            let ctx = TemplateContext {
                                vars: iter_vars,
                                env: env.as_ref(),
                                vu_id,
                                iter_id,
                                loop_index: Some(pass - 1),
                            };
                            eval_condition(cond, &ctx)
                        };
                        if !again {
                            agg.lock().await.record_loop_exit(
                                &lp.id,
                                pass,
                                LoopExitOutcome::Completed,
                            );
                            break;
                        }
                        if let Some(n) = max {
                            if pass >= n {
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass,
                                    LoopExitOutcome::Exhausted,
                                );
                                return Ok(StepFlow::EndIteration);
                            }
                        }
                        // 요청 없는 본문이어도 같은 실행기의 다른 task가 굶지 않게 한다.
                        tokio::task::yield_now().await;
                    }
                }
```

주의: `return other;`는 `Result<StepFlow>`를 그대로 돌려준다(`Ok(비-Continue)`와 `Err(e)` 둘 다) — 원문의 `.await?` + `other => return Ok(other)`와 같은 값이다. `flow` 변수와 `debug_assert!`가 clippy에 걸리면 `let flow = match …`를 `match res { Ok(StepFlow::Continue) => {} other => { …; return other; } }`로 줄인다. `agg.lock().await.record_loop_exit(…)`는 임시 가드가 그 문장 끝에서 놓인다(뒤의 `.await`에 가드를 들고 가지 않는다).

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-engine --test loop_exit` 전부 통과 · `cargo test -p handicap-engine --test loop_while`(1차 테스트 전부 그대로 통과 = 흐름 불변) · `cargo test -p handicap-engine`.

- [ ] **Step 5: 이빨** — 아래를 하나씩 되돌려 지정 테스트가 RED인지 확인하고 원복한다(보고서에 RED 한 줄씩):

| 되돌리는 줄 | RED가 되어야 하는 테스트 |
|---|---|
| 완료 기록(`Completed`) 삭제 | `site1_completed_records_pass_count` |
| 중단 기록(`Exhausted`) 삭제 | `site2_exhausted_records_max_passes` |
| 머리 deadline 기록 삭제 | `site3_deadline_at_pass_head_records_truncated` |
| 머리 취소 기록 삭제 | `site4_cancel_at_pass_head_records_truncated` |
| 본문 `other` 기록 삭제 | `site5_deadline_during_think…`, `site5_body_error…` |
| closed 주기 flush의 가드 항(Task 1) 삭제 | `closed_flushes_loop_exits` (델타가 버려져 `sum < reqs`) |
| VU 곡선 주기 drain(Task 1)을 `Vec::new()`로 | `curve_flushes_loop_exits` (`loaded < 2`) |
| open 주기 flush의 `has_data` 항 삭제 | `open_flushes_loop_exits` |

closed·VU 곡선의 **마지막** flush 가드 항은 이빨 테스트가 없다(마지막 flush에는 거의 항상 창이 함께 있다 — `error_kind`와 같은 구조 대칭으로만 보증). "본문 시작 전 끊김 → 0건"은 runner에서 결정적으로 만들 수 없어 Task 1의 `passes == 0` 단위 테스트가 본다. 회차 머리 검사와 본문 첫 스텝 검사 사이(await 없는 수 µs)에 deadline이 지나면 본문이 요청 없이 끊겨 `pass + 1`로 세는 경계가 있다 — spec §2의 부등식이 허용하는 범위다. 가드 항 삭제가 3회 실행에서 한 번도 RED가 안 되면(완료된 초 창이 매 틱 있어서) STOP하지 말고 그 사실을 보고서에 적는다 — 그 가드는 `error_kind`와 같은 구조 대칭으로만 보증된다.

- [ ] **Step 6: 커밋** — `feat(engine): 조건 반복 가지에서 진입 종료 기록 (loop-while-report)`

---

### Task 3: 컨트롤러 — migration 0023 + store + 시나리오 삭제 cascade

**Files:**
- Create: `crates/controller/src/store/migrations/0023_run_loop_exit_metrics.sql`
- Modify: `crates/controller/src/store/mod.rs` — const(44행 뒤)·execute(89행 뒤)
- Modify: `crates/controller/src/store/metrics.rs` — `ErrorKindRow` 블록(249–297행) 뒤에 새 블록, 인라인 테스트 끝
- Modify: `crates/controller/src/store/scenarios.rs:198-207` — 목록·주석
- Modify: `crates/controller/tests/scenario_delete_api_test.rs:82,167` — seed·단언 목록
- Modify: `crates/controller/CLAUDE.md` — "현 7개" → "현 8개"

**Interfaces:**
- Produces: `pub struct LoopExitRow { pub run_id: String, pub step_id: String, pub pass_bucket: i64, pub outcome: i64, pub count: i64, pub pass_sum: i64 }` · `insert_loop_exit_batch(db, &[LoopExitRow])` · `loop_exit_breakdown(db, run_id) -> Vec<LoopExitRow>`

- [ ] **Step 1: 번호 재확인** — `.claude/skills/new-migration/SKILL.md` §1의 스캔으로 다음 번호가 0023인지 확인(아니면 그 번호로 파일명·const·주석을 맞추고 보고).

- [ ] **Step 2: 테스트를 쓴다**

`store/metrics.rs` 인라인 테스트(끝에):

```rust
    #[tokio::test]
    async fn loop_exit_upsert_accumulates_count_and_pass_sum() {
        let db = pool().await;
        let r = |bucket: i64, outcome: i64, c: i64, s: i64| LoopExitRow {
            run_id: "r1".into(),
            step_id: "l1".into(),
            pass_bucket: bucket,
            outcome,
            count: c,
            pass_sum: s,
        };
        insert_loop_exit_batch(&db, &[r(2, 0, 3, 6), r(21, 2, 1, 40)]).await.unwrap();
        insert_loop_exit_batch(&db, &[r(2, 0, 2, 4)]).await.unwrap(); // 다른 flush·다른 워커의 델타
        let rows = loop_exit_breakdown(&db, "r1").await.unwrap();
        let got: Vec<_> = rows
            .iter()
            .map(|x| (x.pass_bucket, x.outcome, x.count, x.pass_sum))
            .collect();
        assert_eq!(got, vec![(2, 0, 5, 10), (21, 2, 1, 40)]);
        assert!(loop_exit_breakdown(&db, "r2").await.unwrap().is_empty());
    }
```

`scenario_delete_api_test.rs`: seed 목록(82행 뒤)에 `"INSERT INTO run_loop_exit_metrics(run_id,step_id,pass_bucket,outcome,count,pass_sum) VALUES(?,'S',1,0,1,1)",`, 단언 목록(167행 뒤)에 `"run_loop_exit_metrics",`.

- [ ] **Step 3: RED 확인** — `cargo test -p handicap-controller --lib loop_exit_upsert` → 컴파일 에러.

- [ ] **Step 4: 구현**

`0023_run_loop_exit_metrics.sql`:

```sql
-- migration 0023: 조건 반복(while loop) 진입 종료 집계 (spec 2026-11-14-loop-while-report §3.3).
-- counts-only 델타 누적. pass_bucket 1..=20 = 그 회차, 21 = "21번째 이후".
-- outcome 0 완료 · 1 중단(최대 횟수) · 2 마치지 못함(run 종료·취소·오류로 끊김).
CREATE TABLE IF NOT EXISTS run_loop_exit_metrics (
  run_id      TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,   -- loop 스텝 id
  pass_bucket INTEGER NOT NULL,
  outcome     INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  pass_sum    INTEGER NOT NULL DEFAULT 0,   -- 칸으로 합치기 전 실제 회차 수의 합
  PRIMARY KEY (run_id, step_id, pass_bucket, outcome)
);
```

`store/mod.rs`: `const MIGRATION_SQL_0023: &str = include_str!("migrations/0023_run_loop_exit_metrics.sql");` + `connect()`에 `sqlx::query(MIGRATION_SQL_0023).execute(&pool).await?; // migration 0023: run_loop_exit_metrics`. 확인: `grep -c MIGRATION_SQL_0023 crates/controller/src/store/mod.rs` = 2.

`store/metrics.rs`:

```rust
#[derive(Debug, Clone)]
pub struct LoopExitRow {
    pub run_id: String,
    pub step_id: String,  // loop 스텝 id
    pub pass_bucket: i64, // 1..=20, 21 = "21번째 이후"
    pub outcome: i64,     // 0 완료 · 1 중단 · 2 마치지 못함
    pub count: i64,
    pub pass_sum: i64,
}

pub async fn insert_loop_exit_batch(db: &Db, rows: &[LoopExitRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // 델타 누적(run_error_kind_metrics 동형) — 워커·flush마다의 증분을 더한다.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_loop_exit_metrics(run_id,step_id,pass_bucket,outcome,count,pass_sum) \
             VALUES(?,?,?,?,?,?) \
             ON CONFLICT(run_id,step_id,pass_bucket,outcome) DO UPDATE SET \
               count = count + excluded.count, \
               pass_sum = pass_sum + excluded.pass_sum",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(r.pass_bucket)
        .bind(r.outcome)
        .bind(r.count)
        .bind(r.pass_sum)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn loop_exit_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<LoopExitRow>> {
    let rows = sqlx::query(
        "SELECT step_id, pass_bucket, outcome, count, pass_sum FROM run_loop_exit_metrics \
         WHERE run_id = ? ORDER BY step_id, pass_bucket, outcome",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| LoopExitRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            pass_bucket: r.get("pass_bucket"),
            outcome: r.get("outcome"),
            count: r.get("count"),
            pass_sum: r.get("pass_sum"),
        })
        .collect())
}
```

`scenarios.rs`: 목록 끝에 `"run_loop_exit_metrics",`, 위 주석 "7테이블" → "8테이블". `crates/controller/CLAUDE.md`의 "명시 테이블 목록(현 7개)" → "(현 8개)".

- [ ] **Step 5: GREEN + 이빨** — `cargo test -p handicap-controller --lib loop_exit_upsert` · `cargo test -p handicap-controller --test scenario_delete_api_test`. **이빨**: `scenarios.rs` 목록에서 새 줄을 빼면 `scenario_delete_api_test`가 `run_loop_exit_metrics orphan`으로 RED → 원복.

- [ ] **Step 6: 커밋** — `feat(controller): run_loop_exit_metrics 테이블·저장·삭제 cascade (loop-while-report)`

---

### Task 4: proto + 워커 + 컨트롤러 ingest

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` — `MetricBatch`(74–85행)에 필드 11, `ErrorKindStat` 메시지 뒤에 `LoopExitStat`
- Modify: `crates/worker/src/lib.rs` — import(18행)·변환 호출(325행 뒤)·건너뜀 조건(337행 뒤)·리터럴(352행 뒤)·변환 함수(661행 블록 뒤)·인라인 테스트
- Modify: `crates/controller/src/grpc/coordinator.rs` — ingest(1613행 `error_kind` 블록 뒤)·`pb::MetricBatch {` 리터럴 3곳(2391·2431·2480행 부근, `error_kind_stats: …,` 줄 뒤 — 1692행 도우미는 무수정)·인라인 테스트

**Interfaces:**
- Consumes: Task 1 `MetricFlush.loop_exit_stats`·`LoopExitOutcome::as_wire`, Task 3 `LoopExitRow`·`insert_loop_exit_batch`·`loop_exit_breakdown`.
- Produces: proto `LoopExitStat { step_id=1, pass_bucket=2, outcome=3, count=4, pass_sum=5 }`.

이 task는 proto 필드 추가로 워커·컨트롤러의 `MetricBatch {` 리터럴이 함께 깨지므로 한 커밋이다.

- [ ] **Step 1: 테스트를 쓴다**

워커 인라인 테스트(`error_kind_stats_map_to_proto_wire_strings` 뒤):

```rust
    #[test]
    fn loop_exit_stats_map_to_proto_wire_values() {
        use handicap_engine::{LoopExitOutcome, LoopExitStat};
        let out = loop_exit_stats_to_proto(vec![
            LoopExitStat {
                step_id: "l1".into(),
                pass_bucket: 21,
                outcome: LoopExitOutcome::Truncated,
                count: 2,
                pass_sum: 90,
            },
            LoopExitStat {
                step_id: "l1".into(),
                pass_bucket: 3,
                outcome: LoopExitOutcome::Exhausted,
                count: 1,
                pass_sum: 3,
            },
        ]);
        assert_eq!(
            out.iter()
                .map(|s| (s.step_id.as_str(), s.pass_bucket, s.outcome, s.count, s.pass_sum))
                .collect::<Vec<_>>(),
            vec![("l1", 21, 2, 2, 90), ("l1", 3, 1, 1, 3)]
        );
    }
```

컨트롤러 `coordinator.rs` 인라인 테스트(기존 `error_kind`/`group_stats` ingest 테스트 옆, 같은 `seed_run`·`CoordinatorState::new` 꼴):

```rust
    #[tokio::test]
    async fn ingest_persists_loop_exits_and_sanitizes_worker_input() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let st = |bucket: u32, outcome: u32, count: u64, sum: u64| pb::LoopExitStat {
            step_id: "l1".to_string(),
            pass_bucket: bucket,
            outcome,
            count,
            pass_sum: sum,
        };
        let batch = pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            loop_exit_stats: vec![
                st(2, 0, 3, 6),
                st(0, 0, 1, 1),       // 범위 밖 칸 → 1로
                st(9999, 2, 1, 9999), // 범위 밖 칸 → 21로
                st(2, 7, 5, 10),      // 모르는 outcome → 버림
            ],
            ..Default::default()
        };
        ingest_metrics(&coord, &batch).await;
        ingest_metrics(&coord, &batch).await; // 두 번째 델타 — 누적
        let rows = crate::store::metrics::loop_exit_breakdown(&db, &run_id).await.unwrap();
        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.pass_bucket, r.outcome, r.count, r.pass_sum))
            .collect();
        assert_eq!(got, vec![(1, 0, 2, 2), (2, 0, 6, 12), (21, 2, 2, 19998)]);
    }
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-worker --lib loop_exit_stats_map` → 컴파일 에러.

- [ ] **Step 3: proto**

```proto
// 조건 반복(while loop) 진입 종료 델타 (loop-while-report). counts-only.
message LoopExitStat {
  string step_id = 1;      // loop 스텝 id
  uint32 pass_bucket = 2;  // 1..=20 = 그 회차, 21 = 21번째 이후
  uint32 outcome = 3;      // 0 완료 · 1 중단(최대 횟수) · 2 마치지 못함
  uint64 count = 4;
  uint64 pass_sum = 5;     // 실제 회차 수의 합
}
```

`MetricBatch`에 `repeated LoopExitStat loop_exit_stats = 11;  // 조건 반복 진입 종료 (delta, controller sums)`.

- [ ] **Step 4: 워커**

```rust
/// 조건 반복 진입 종료 delta (loop-while-report): engine `LoopExitStat` → proto wire.
fn loop_exit_stats_to_proto(stats: Vec<handicap_engine::LoopExitStat>) -> Vec<LoopExitStat> {
    stats
        .into_iter()
        .map(|s| LoopExitStat {
            step_id: s.step_id,
            pass_bucket: s.pass_bucket,
            outcome: s.outcome.as_wire(),
            count: s.count,
            pass_sum: s.pass_sum,
        })
        .collect()
}
```

forwarder: `let loop_exit_stats = loop_exit_stats_to_proto(flush.loop_exit_stats);` (325행 `error_kind_stats` 변환 뒤) · 건너뜀 조건에 `&& loop_exit_stats.is_empty()`(`error_kind_stats.is_empty()` 뒤, 위 주석에 "loop_exit도 같은 이유" 한 구절) · `MetricBatch` 리터럴에 `loop_exit_stats,` · proto import 목록(18행)에 `LoopExitStat`.

- [ ] **Step 5: 컨트롤러 ingest** (`error_kind` 블록 뒤)

```rust
    // 조건 반복 진입 종료(loop-while-report). 워커 입력은 믿지 않는다 — 칸은 1..=21로 누르고
    // 모르는 outcome은 버린다(loop당 행 수가 최대 63으로 묶인다).
    let loop_exit_rows: Vec<crate::store::metrics::LoopExitRow> = batch
        .loop_exit_stats
        .iter()
        .filter(|s| s.outcome <= 2)
        .map(|s| crate::store::metrics::LoopExitRow {
            run_id: batch.run_id.clone(),
            step_id: s.step_id.clone(),
            pass_bucket: i64::from(s.pass_bucket.clamp(1, handicap_engine::LOOP_EXIT_PASS_CAP + 1)),
            outcome: i64::from(s.outcome),
            count: s.count as i64,
            pass_sum: s.pass_sum as i64,
        })
        .collect();
    if !loop_exit_rows.is_empty() {
        if let Err(e) =
            crate::store::metrics::insert_loop_exit_batch(&state.db, &loop_exit_rows).await
        {
            warn!(run_id = %batch.run_id, error = %e, "loop_exit metrics insert failed");
        }
    }
```

(`handicap_engine`이 컨트롤러 의존성인지 `grep -n 'handicap-engine\|handicap_engine' crates/controller/Cargo.toml`로 확인 — `report.rs`가 이미 `handicap_engine::percentiles`를 쓴다.) 전 필드를 나열한 `pb::MetricBatch {` 리터럴 3곳(2391·2431·2480행 부근 — `error_kind_stats: …,` 줄 뒤, 2480 쪽은 `vec![pb::ErrorKindStat{…}]`)에 `loop_exit_stats: vec![],`. 1692행의 `metric_batch` 도우미는 `..Default::default()`라 고치지 않는다. 그 밖의 리터럴: `grep -rn 'MetricBatch {' crates --include='*.rs'`로 전수 확인.

- [ ] **Step 6: GREEN + 이빨** — `cargo build --workspace --tests` · `cargo test -p handicap-worker --lib loop_exit_stats_map` · `cargo test -p handicap-controller --lib ingest_persists_loop_exits`. **이빨**: ① ingest의 `.filter(|s| s.outcome <= 2)` 삭제 → RED ② `clamp` 삭제 → RED ③ 워커 건너뜀 조건의 새 항은 단위 테스트로 못 잡는다(forwarder 루프 안, `error_kind`도 같은 사정) — spec §5의 "워커가 건너뛰지 않음" 단위 테스트 대신 라이브 검증의 숫자 대조가 본다. 이 차이를 보고서에 적는다.

- [ ] **Step 7: 커밋** — `feat(proto,worker,controller): 조건 반복 진입 종료 집계 운반 (loop-while-report)`

---

### Task 5: 컨트롤러 — `ReportJson.loop_exits`

**Files:**
- Modify: `crates/controller/src/report.rs` — `ReportJson`(26행 `error_kinds` 뒤)·타입(`ErrorKindCount` 뒤, 117행)·`build_report` 인자(464행 뒤)·롤업(509행 뒤)·리터럴(968행 `error_kinds` 뒤)·테스트
- Modify: `crates/controller/src/api/runs.rs:1099-1112` — 조회·인자
- Modify: `crates/controller/src/export.rs:611` — 테스트 픽스처 리터럴에 `loop_exits: vec![],`
- Modify: `crates/controller/tests/report_test.rs` — `report_endpoint_includes_error_kinds_rollup`(194행) 뒤에 쌍둥이 테스트
- Modify: `build_report(` 호출부 전부(약 38곳, 대부분 `report.rs` 테스트) — 마지막 인자로 `&[]`

**Interfaces:**
- Consumes: Task 3 `LoopExitRow`·`loop_exit_breakdown`.
- Produces: JSON `loop_exits: [{ step_id, entered, passes, exhausted, truncated, buckets: [{ pass: number|null, completed, exhausted, truncated }] }]` — 빈 배열이면 키 생략.

- [ ] **Step 1: 테스트를 쓴다** (`report.rs` 테스트 모듈, `error_kinds_rollup_sorts_and_omits_when_empty` 뒤)

```rust
    fn minimal_report_with_loop_exits(rows: &[crate::store::metrics::LoopExitRow]) -> ReportJson {
        let run = run_row();
        build_report(&run, "", &[], &[], &[], &[], &[], &[], &[], &[], rows)
    }

    #[test]
    fn loop_exits_rollup_buckets_totals_and_omits_when_empty() {
        let row = |step: &str, bucket: i64, outcome: i64, count: i64, sum: i64| {
            crate::store::metrics::LoopExitRow {
                run_id: "r1".into(),
                step_id: step.into(),
                pass_bucket: bucket,
                outcome,
                count,
                pass_sum: sum,
            }
        };
        // SQL 순서(step_id, pass_bucket, outcome)대로.
        let rows = vec![
            row("la", 1, 0, 816, 816),
            row("la", 1, 2, 1, 1),
            row("la", 5, 0, 12, 60),
            row("la", 5, 1, 12, 60),
            row("la", 21, 0, 3, 90),
            row("la", 21, 2, 2, 80),
            row("lb", 1, 0, 4, 4),
        ];
        let rep = minimal_report_with_loop_exits(&rows);
        assert_eq!(rep.loop_exits.len(), 2);
        let la = &rep.loop_exits[0];
        assert_eq!(
            (la.step_id.as_str(), la.entered, la.passes, la.exhausted, la.truncated),
            ("la", 846, 1107, 12, 3)
        );
        assert_eq!(
            la.buckets
                .iter()
                .map(|b| (b.pass, b.completed, b.exhausted, b.truncated))
                .collect::<Vec<_>>(),
            vec![(Some(1), 816, 0, 1), (Some(5), 12, 12, 0), (None, 3, 0, 2)]
        );
        assert_eq!(rep.loop_exits[1].step_id, "lb");

        let json = serde_json::to_value(&rep).unwrap();
        let last = &json["loop_exits"][0]["buckets"][2];
        assert!(
            last.as_object().unwrap().contains_key("pass") && last["pass"].is_null(),
            "21번째 이후는 pass: null로 직렬화: {last}"
        );

        let empty = minimal_report_with_loop_exits(&[]);
        let s = serde_json::to_string(&empty).unwrap();
        assert!(!s.contains("loop_exits"), "empty must be omitted: {s}");
        // typed round-trip: 키가 없어도 역직렬화된다.
        let back: ReportJson = serde_json::from_str(&s).unwrap();
        assert!(back.loop_exits.is_empty());
    }
```

`report_test.rs`(`report_endpoint_includes_error_kinds_rollup` 뒤, 같은 도우미 `seed_run_with_metrics`·`make_app`):

```rust
/// store → report → HTTP 다리: `build_report_for_run`이 loop_exit 행을 읽어 넘긴다.
#[tokio::test]
async fn report_endpoint_includes_loop_exits() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, _scenario_yaml) = seed_run_with_metrics(&db).await;
    let row = |bucket: i64, outcome: i64, count: i64, sum: i64| LoopExitRow {
        run_id: run_id.clone(),
        step_id: "loopA".to_string(),
        pass_bucket: bucket,
        outcome,
        count,
        pass_sum: sum,
    };
    insert_loop_exit_batch(&db, &[row(1, 0, 5, 5), row(21, 2, 1, 40)])
        .await
        .unwrap();
    let app = make_app(db);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json["loop_exits"],
        serde_json::json!([{
            "step_id": "loopA", "entered": 6, "passes": 45, "exhausted": 0, "truncated": 1,
            "buckets": [
                {"pass": 1, "completed": 5, "exhausted": 0, "truncated": 0},
                {"pass": null, "completed": 0, "exhausted": 0, "truncated": 1}
            ]
        }])
    );
}
```

(import에 `LoopExitRow`·`insert_loop_exit_batch` 추가 — `ErrorKindRow` import 줄을 따른다.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --lib loop_exits_rollup` → 컴파일 에러.

- [ ] **Step 3: 구현**

`ReportJson`(`error_kinds` 필드 뒤):

```rust
    /// 조건 반복(while loop) 진입 종료 집계 (loop-while-report). 조건 반복 집계가 없으면
    /// 키 자체를 내지 않는다(기존 리포트 byte-identical).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loop_exits: Vec<LoopExit>,
```

타입(`ErrorKindCount` 뒤):

```rust
/// 조건 반복 하나의 진입 종료 집계. `entered` = 진입 건수(세 방식 합),
/// `passes` = 시작한 본문 회차 합(재시도 = passes − entered).
#[derive(Debug, Serialize, Deserialize)]
pub struct LoopExit {
    pub step_id: String,
    pub entered: u64,
    pub passes: u64,
    pub exhausted: u64,
    pub truncated: u64,
    pub buckets: Vec<LoopExitBucket>,
}

/// `pass`는 1부터 센 회차(`loop_index`는 0부터 — 다르다). `None` = 21번째 이후.
/// `null`을 그대로 직렬화한다(skip 없음).
#[derive(Debug, Serialize, Deserialize)]
pub struct LoopExitBucket {
    pub pass: Option<u32>,
    pub completed: u64,
    pub exhausted: u64,
    pub truncated: u64,
}
```

`build_report` 마지막 인자 `loop_exits: &[crate::store::metrics::LoopExitRow],`. 롤업(`error_kinds_rolled` 계산 뒤):

```rust
    // 조건 반복 진입 종료(loop-while-report): (step_id, pass_bucket)별로 세 방식을 한 칸에 모은다.
    // BTreeMap 키 순서 = step_id 오름차순, 칸 오름차순(21 = "21번째 이후"가 맨 끝).
    let mut exit_acc: BTreeMap<String, (u64, BTreeMap<i64, [u64; 3]>)> = BTreeMap::new();
    for r in loop_exits {
        let Ok(o) = usize::try_from(r.outcome) else {
            continue;
        };
        if o > 2 {
            continue;
        }
        let e = exit_acc.entry(r.step_id.clone()).or_default();
        e.0 += r.pass_sum.max(0) as u64;
        e.1.entry(r.pass_bucket).or_insert([0; 3])[o] += r.count.max(0) as u64;
    }
    let cap = i64::from(handicap_engine::LOOP_EXIT_PASS_CAP);
    let loop_exits_rolled: Vec<LoopExit> = exit_acc
        .into_iter()
        .map(|(step_id, (passes, by_bucket))| {
            let buckets: Vec<LoopExitBucket> = by_bucket
                .into_iter()
                .filter(|(_, c)| c.iter().sum::<u64>() > 0)
                .map(|(bucket, c)| LoopExitBucket {
                    pass: if bucket > cap { None } else { Some(bucket.max(1) as u32) },
                    completed: c[0],
                    exhausted: c[1],
                    truncated: c[2],
                })
                .collect();
            LoopExit {
                step_id,
                entered: buckets.iter().map(|b| b.completed + b.exhausted + b.truncated).sum(),
                passes,
                exhausted: buckets.iter().map(|b| b.exhausted).sum(),
                truncated: buckets.iter().map(|b| b.truncated).sum(),
                buckets,
            }
        })
        .filter(|l| l.entered > 0)
        .collect();
```

`ReportJson { … }` 리터럴(950행)에 `loop_exits: loop_exits_rolled,`. `export.rs:611` 픽스처에 `loop_exits: vec![],`.

`api/runs.rs::build_report_for_run`: `let loop_exits = crate::store::metrics::loop_exit_breakdown(db, run_id).await?;`(`error_kinds` 조회 뒤) + 마지막 인자 `&loop_exits`.

호출부: `cargo build --workspace --tests`가 "takes 11 arguments"로 알려 주는 곳마다 마지막에 `&[]`를 더한다(`grep -rn 'build_report(' crates/controller/src crates/controller/tests`로 전수 확인, 0 에러까지). 다른 인자의 값·순서는 건드리지 않는다.

- [ ] **Step 4: GREEN + 이빨** — `cargo test -p handicap-controller`(골든 `golden_summary_deltas_match` 포함 전부) . **이빨**: ① `skip_serializing_if`를 지우면 `loop_exits_rollup…`의 "empty must be omitted"가 RED → 원복 ② `build_report_for_run`의 마지막 인자를 `&[]`로 바꾸면 `report_endpoint_includes_loop_exits`가 RED → 원복.

- [ ] **Step 5: 커밋** — `feat(controller): 리포트 JSON에 loop_exits (loop-while-report)`

---

### Task 6: UI — 와이어 거울 + 뷰 모델 + 문구

**Files:**
- Create: `ui/src/components/report/loopExitView.ts`
- Create: `ui/src/components/report/__tests__/loopExitView.test.ts`
- Modify: `ui/src/api/schemas.ts` — `ErrorKindCountSchema` 정의 뒤에 스키마 2개, `ReportSchema`의 `error_kinds` 뒤에 필드, 타입 export
- (스키마 케이스 12는 `loopExitView.test.ts`에 함께 둔다 — `LoopExitSchema.safeParse` + `ReportSchema`는 `ui/src/api/__tests__/reportLatency.test.ts`의 최소 리포트 픽스처 꼴을 따른다)
- Modify: `ui/src/i18n/ko.ts` — `report:` 블록(1016행~)에 `loopExit` 하위 객체

**Interfaces:**
- Produces:

```ts
export type LoopExitRowKind = "first" | "retried" | "exhausted" | "truncated";
export type LoopExitRow = {
  kind: LoopExitRowKind;
  /** first/retried 줄의 회차(1부터). null = 21번째 이후. exhausted/truncated 줄은 null. */
  pass: number | null;
  count: number;
  /** 진입 대비 비율 0–100. */
  pct: number;
};
export type LoopExitView = {
  stepId: string;
  name: string;
  maxPasses: number | null;
  entered: number;
  passes: number;
  retries: number;
  /** 본문 실행 중 재시도 비율 0–100. */
  retryPct: number;
  exhausted: number;
  truncated: number;
  retriedStepIds: string[];
  rows: LoopExitRow[];
};
export function buildLoopExitViews(
  loopExits: LoopExit[] | undefined,
  steps: ReportStep[],
  scenarioSteps: ReadonlyArray<Step> | null,
): LoopExitView[];
/** 표지를 붙일 스텝 id 전체(모든 loop의 retriedStepIds 합집합). */
export function retriedStepIdSet(views: LoopExitView[]): ReadonlySet<string>;
/** 맨 위 안내 대상: retries ≥ 1 또는 exhausted ≥ 1, 재시도 비율 내림차순 → 중단 내림차순. */
export function noticeLoops(views: LoopExitView[]): LoopExitView[];
```

- [ ] **Step 1: 테스트를 쓴다** — `loopExitView.test.ts`. 시나리오 모델은 `parseScenarioDoc`로 YAML 문자열에서 만든다(형제 테스트의 import 깊이를 따른다). 케이스(각각 하나의 `it`):

1. **기본 계산**: `loop_exits = [{ step_id: L, entered: 1200, passes: 1812, exhausted: 12, truncated: 3, buckets: [{pass:1,completed:816,exhausted:0,truncated:1},{pass:2,completed:240,exhausted:0,truncated:0},{pass:3,completed:114,exhausted:0,truncated:0},{pass:5,completed:12,exhausted:12,truncated:0},{pass:null,completed:3,exhausted:0,truncated:2}] }]` → `retries === 612`, `floorPct(retryPct) === "33.8%"`, `name`은 YAML의 loop 이름, `maxPasses`는 YAML `repeat`.
2. **줄 순서와 분류**: rows = `first(pass 1, 816)` → `retried(pass 2, 240)` → `retried(pass 3, 114)` → `retried(pass 5, 12)` → `retried(pass null, 3)` → `exhausted(12)` → `truncated(3)`. 건수 0인 줄은 없다. `pct`는 `count / entered × 100`. 줄 건수 합 = `entered`(816+240+114+12+3+12+3 = 1,200).
3. **표지 — 회차별 요청 수가 있을 때**: 본문에 스텝 A(매 회차)와 if 안 스텝 B(성공 회차에만). `steps`의 A는 `loop_breakdown: [{loop_index:0,count:10,…},{loop_index:1,count:4,…}]`, B는 `[{loop_index:0,count:10,…}]` → `retriedStepIds`는 A만. 상한 초과 줄(`loop_index: null`, count 2)만 있는 스텝도 포함된다.
4. **표지 — 회차별 요청 수가 없을 때**(`loop_breakdown: []`): `retries > 0`이면 본문 http 스텝 전부, `retries === 0`이면 빈 배열.
5. **`repeat: 1` 중단만**: `entered 5, passes 5, exhausted 5` → `retries 0`, `retriedStepIds []`, `noticeLoops`에는 포함.
6. **마치지 못함만 있고 재시도 0**(`entered 3, passes 3, truncated 3`) → `noticeLoops`에 없음.
7. **끝내 안 풀린 무제한**(`entered 4, passes 400, truncated 4`, buckets `[{pass:null,completed:0,exhausted:0,truncated:4}]`) → `retries 396`, `noticeLoops`에 포함, rows는 `truncated(4)` 한 줄.
8. **시나리오 파싱 실패**(`scenarioSteps = null`) → `name === stepId`, `maxPasses === null`, `retriedStepIds === []`, rows는 그대로.
9. **if 분기 안의 조건 반복**(loop이 top-level if의 `then` 안) → 이름·본문 스텝을 찾는다.
10. **`loopExits`가 `undefined`/`[]`** → `[]`.
11. **`noticeLoops` 정렬**: 재시도 비율 10%·50%·50%(중단 0 / 3) → 50%·중단 3, 50%·중단 0, 10% 순.
12. **Zod**: `ReportSchema`(또는 `LoopExitSchema.safeParse`)가 `pass: null`을 받고, 모르는 키(`{…, extra: 1}`)와 소수 `pass: 1.5`를 거부한다. `loop_exits` 키가 없는 리포트도 통과.

- [ ] **Step 2: RED 확인** — `pnpm test loopExitView` (ui 디렉토리에서) → 모듈 없음.

- [ ] **Step 3: 스키마**

```ts
// 조건 반복 진입 종료 집계 (loop-while-report). 서버 skip_serializing_if = Vec::is_empty
// → 조건 반복 집계가 없으면 키 부재 → .optional(). pass는 1부터, null = 21번째 이후.
export const LoopExitBucketSchema = z
  .object({
    pass: z.number().int().nullable(),
    completed: z.number().int().nonnegative(),
    exhausted: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
  })
  .strict();
export const LoopExitSchema = z
  .object({
    step_id: z.string(),
    entered: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    exhausted: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    buckets: z.array(LoopExitBucketSchema),
  })
  .strict();
export type LoopExit = z.infer<typeof LoopExitSchema>;
```

`ReportSchema`에 `loop_exits: z.array(LoopExitSchema).optional(),`(`error_kinds` 뒤).

- [ ] **Step 4: `loopExitView.ts`**

```ts
import type { LoopExit, ReportStep } from "../../api/schemas";
import { findStepById, flattenHttpSteps, type Step } from "../../scenario/model";

// (타입 선언은 Interfaces 절 그대로)

function retriedSteps(
  bodyIds: string[],
  retries: number,
  byId: Map<string, ReportStep>,
): string[] {
  return bodyIds.filter((id) => {
    const breakdown = byId.get(id)?.loop_breakdown ?? [];
    if (breakdown.length === 0) return retries > 0; // 루프 집계 상한 0 — loop 단위로만 안다
    // 2번째 이후 회차(loop_index ≥ 1, 또는 상한 초과 줄 null)에서 요청된 스텝만.
    return breakdown.some((b) => b.loop_index !== 0 && b.count > 0);
  });
}

export function buildLoopExitViews(
  loopExits: LoopExit[] | undefined,
  steps: ReportStep[],
  scenarioSteps: ReadonlyArray<Step> | null,
): LoopExitView[] {
  if (!loopExits || loopExits.length === 0) return [];
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  return loopExits.map((le) => {
    const node = scenarioSteps ? findStepById(scenarioSteps, le.step_id) : null;
    const loop = node && node.type === "loop" ? node : null;
    const retries = Math.max(0, le.passes - le.entered);
    const bodyIds = loop ? flattenHttpSteps(loop.do).map((s) => s.id) : [];
    const pct = (n: number) => (le.entered > 0 ? (n / le.entered) * 100 : 0);
    const rows: LoopExitRow[] = [];
    for (const b of le.buckets) {
      if (b.completed > 0) {
        rows.push({
          kind: b.pass === 1 ? "first" : "retried",
          pass: b.pass,
          count: b.completed,
          pct: pct(b.completed),
        });
      }
    }
    if (le.exhausted > 0) {
      rows.push({ kind: "exhausted", pass: null, count: le.exhausted, pct: pct(le.exhausted) });
    }
    if (le.truncated > 0) {
      rows.push({ kind: "truncated", pass: null, count: le.truncated, pct: pct(le.truncated) });
    }
    return {
      stepId: le.step_id,
      name: loop?.name ?? le.step_id,
      maxPasses: loop?.repeat ?? null,
      entered: le.entered,
      passes: le.passes,
      retries,
      retryPct: le.passes > 0 ? (retries / le.passes) * 100 : 0,
      exhausted: le.exhausted,
      truncated: le.truncated,
      retriedStepIds: retriedSteps(bodyIds, retries, byId),
      rows,
    };
  });
}

export function retriedStepIdSet(views: LoopExitView[]): ReadonlySet<string> {
  return new Set(views.flatMap((v) => v.retriedStepIds));
}

export function noticeLoops(views: LoopExitView[]): LoopExitView[] {
  return views
    .filter((v) => v.retries >= 1 || v.exhausted >= 1)
    .sort((a, b) => b.retryPct - a.retryPct || b.exhausted - a.exhausted);
}
```

(`findStepById`가 if 분기 안의 loop까지 재귀하는지 케이스 9가 확인한다. 못 찾으면 그 함수는 고치지 말고 이 파일에 loop만 찾는 작은 재귀를 둔다. `Step` 타입 export 이름은 `ui/src/scenario/model.ts`에서 확인.)

- [ ] **Step 5: 문구** — `ko.ts`의 `report:` 블록에 `loopExit` 객체. **문구 정본(byte-exact)**:

| 키 | 값 |
|---|---|
| `badge` | `재시도 포함` |
| `summaryLabel` | `조건 반복 풀이` (풀이 줄 묶음의 `aria-label`) |
| `summaryLine(name, entered, retries, pct, exhausted)` | `` `조건 반복 「${name}」 — 진입 ${entered} · 재시도 ${retries} (본문 실행의 ${pct}) · 중단 ${exhausted}` `` |
| `summaryTruncated(n)` | `` ` · 마치지 못함 ${n}` `` |
| `summaryHelpLabel` | `조건 반복 풀이 도움말` |
| `summaryHelpEntered` | `진입 = 이 조건 반복에 들어간 횟수.` |
| `summaryHelpRetries` | `재시도 = 2번째 이후 본문 실행을 시작한 횟수.` |
| `summaryHelpExhausted` | `중단 = 최대 횟수까지 조건이 풀리지 않아 이번 시나리오 반복을 끝낸 횟수.` |
| `summaryHelpTruncated` | `마치지 못함 = run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊긴 횟수.` |
| `panelTitle` | `조건 반복` |
| `panelLabel` | `조건 반복 회차 분포` (섹션 `aria-label`) |
| `panelHeading(name, entered)` | `` `「${name}」 — 진입 ${entered}회가 몇 번째 시도에서 끝났나` `` |
| `rowNth(n)` | `` `${n}번째` `` |
| `rowOver` | `21번째 이후` |
| `rowExhausted` | `중단` |
| `rowTruncated` | `마치지 못함` |
| `rowValue(count, pct)` | `` `${count} · ${pct}` `` |
| `kindFirst` | `재시도 없이 끝남` |
| `kindRetried` | `재시도 후 끝남` |
| `exhaustedNote(n)` | `` `최대 ${n}번까지 조건이 풀리지 않아 이번 반복을 끝냄` `` |
| `exhaustedNoteNoMax` | `최대 횟수까지 조건이 풀리지 않아 이번 반복을 끝냄` |
| `truncatedNote` | `run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊김` |
| `legendFirst` | `1번째 = 재시도 없이 끝남` |
| `legendRetried` | `2번째 이후 = 재시도 후 끝남` |
| `barLabel(row, kind, count, pct)` | `` `${row}, ${kind}, ${count}건, ${pct}` `` — `kind`가 빈 문자열이면 `` `${row}, ${count}건, ${pct}` ``(중단·마치지 못함 줄은 라벨이 곧 분류라 되풀이하지 않는다) |
| `noticeLabel` | `조건 반복 해석 주의` (안내의 `aria-label`) |
| `noticeHeadRetry` | `해석 주의 · 조건 반복의 재시도가 섞여 있습니다` |
| `noticeHeadExhausted` | `해석 주의 · 최대 횟수에서 중단된 조건 반복이 있습니다` |
| `noticeRetryLine(name, passes, retries, pct)` | `` `「${name}」: 본문 실행 ${passes}회 중 ${retries}회(${pct})가 재시도` `` |
| `noticeExhaustedSuffix(n)` | `` ` · 최대 횟수에 걸려 중단된 반복 ${n}건` `` |
| `noticeExhaustedOnly(name, n)` | `` `「${name}」: 최대 횟수에 걸려 중단된 반복 ${n}건` `` |
| `noticeMore(n)` | `` `외 ${n}개 조건 반복` `` |
| `noticeTail` | `해당 스텝과 전체 응답 시간·초당 요청 수에는 재시도 응답이 포함돼 있습니다.` |

보간 인자는 **이미 형식화된 문자열**(`string`)이다(숫자는 `toLocaleString("en-US")`, 비율은 `floorPct`) — 컴포넌트가 형식화해 넘긴다. 예외 하나: `rowNth(n: number)`는 1–20의 회차 번호를 숫자로 받는다. `exhaustedNoteNoMax`의 전체 문장은 spec §4.3의 `최대 횟수까지 …`를 `exhaustedNote`와 같은 꼬리로 채운 것이다(해석).

- [ ] **Step 6: GREEN** — `pnpm test loopExitView` · `pnpm lint` · `pnpm build`.

- [ ] **Step 7: 이빨** — `retriedSteps`의 `b.loop_index !== 0`을 `true`로 바꾸면 케이스 3(B가 빠져야 함)이 RED → 원복. `noticeLoops`의 `|| v.exhausted >= 1`을 지우면 케이스 5가 RED → 원복.

- [ ] **Step 8: 커밋** — `feat(ui): 조건 반복 리포트 뷰 모델·스키마·문구 (loop-while-report)`

---

### Task 7: UI — 스텝 행 표지 + 풀이 줄

**Files:**
- Create: `ui/src/components/report/LoopExitSummary.tsx`
- Create: `ui/src/components/report/__tests__/LoopExitSummary.test.tsx`
- Modify: `ui/src/components/report/StepStatsTable.tsx` — `Props`(9행)·이름 칸(77–92행)
- Modify: `ui/src/components/report/StepPhaseBreakdown.tsx` — `Props`·`StepStatsTable` 호출 2곳(19·53행)·막대 보기 이름 칸(66–71행)
- Modify: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`·`StepPhaseBreakdown.test.tsx`

**Interfaces:**
- Consumes: Task 6 `LoopExitView`·`ko.report.loopExit.*`.
- Produces: `StepStatsTable`·`StepPhaseBreakdown`의 선택 prop `retriedStepIds?: ReadonlySet<string>` · `<LoopExitSummary views={LoopExitView[]} />`(빈 배열이면 `null`).

- [ ] **Step 1: 테스트를 쓴다**

`StepStatsTable.test.tsx`에:
- `retriedStepIds`에 든 스텝 행에만 `재시도 포함`이 보인다 — `within(row).getByText("재시도 포함")`, 다른 행은 `queryByText` 없음.
- prop이 없을 때와 `new Set()`일 때 `container.innerHTML`이 서로 같고, `재시도 포함`이 없다(DOM 불변).

`StepPhaseBreakdown.test.tsx`에(막대 보기 = `wait`/`download`가 있는 픽스처):
- 막대 보기에서 `retriedStepIds`에 든 스텝의 이름 칸 **안**에 표지가 있다 — 이름 요소(`getByTitle(이름)`)의 `closest` 고정 폭 칸(`w-40` 클래스)을 찾아 `within(cell).getByText("재시도 포함")`. 표지 요소는 `shrink-0` 클래스를 갖고, 이름 요소는 `truncate` 클래스와 `title`을 유지한다.
- 표 보기로 전환해도 표지가 보인다(prop이 `StepStatsTable`로 전달됨).
- 표지가 **없는** 행은 기존 DOM 그대로다: `getByTitle(그 이름)`이 곧 고정 폭 칸이다(`toHaveClass("w-40")`·`toHaveClass("truncate")`) — 표지가 있는 행에서는 `getByTitle(이름)`이 `w-40`을 갖지 않는다(안쪽 span). prop 없이 렌더한 `container.innerHTML`이 `retriedStepIds={new Set()}`과도 같다.

`LoopExitSummary.test.tsx`:
- 한 loop(`entered 1200, retries 612, retryPct 33.77…, exhausted 12, truncated 3`) → 텍스트 `조건 반복 「주문 재시도」 — 진입 1,200 · 재시도 612 (본문 실행의 33.8%) · 중단 12 · 마치지 못함 3`(리터럴 문자열로 단언 — `ko` 함수를 다시 부르지 않는다).
- `truncated 0` → 그 `listitem`이 `not.toHaveTextContent(/마치지 못함/)`(부분 글자는 `queryByText`로 못 잡는다 — 요소 전체 글자만 본다). 짝 확인: `truncated 3`인 뷰의 `listitem`은 `toHaveTextContent(/마치지 못함 3/)`. `exhausted 0` → `toHaveTextContent(/· 중단 0/)`.
- 두 loop → 두 줄(`getAllByRole("listitem")` 길이 2), 묶음은 `getByRole("list", { name: "조건 반복 풀이" })`.
- 도움말 버튼(`getByRole("button", { name: "조건 반복 풀이 도움말" })`)이 **하나**이고 클릭하면 `screen.getByRole("note")`에 네 문장이 있다.
- `views=[]` → `container`가 비어 있다.

- [ ] **Step 2: RED 확인** — `pnpm test StepStatsTable` · `pnpm test StepPhaseBreakdown` · `pnpm test LoopExitSummary`.

- [ ] **Step 3: 구현**

표지는 두 곳이 같은 모양을 쓰도록 `LoopExitSummary.tsx`에서 함께 export한다:

```tsx
export function RetryBadge() {
  return (
    <span className="ml-2 inline-block shrink-0 whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800">
      {ko.report.loopExit.badge}
    </span>
  );
}
```

`StepStatsTable`: `Props`에 `retriedStepIds?: ReadonlySet<string>`, 이름 칸의 `{m?.name ?? s.step_id}` 뒤에 `{retriedStepIds?.has(s.step_id) && <RetryBadge />}`. 그 밖의 DOM은 그대로.

`StepPhaseBreakdown`: `Props`에 같은 prop, `StepStatsTable` 호출 2곳에 전달. 막대 보기 이름 칸은 고정 폭 칸 안에서 이름이 먼저 줄도록:

```tsx
<div className="flex w-40 shrink-0 items-center text-sm font-medium">
  <span className="min-w-0 truncate" title={m?.name ?? s.step_id}>
    {m?.name ?? s.step_id}
  </span>
  {retriedStepIds?.has(s.step_id) && <RetryBadge />}
</div>
```

**단, 표지가 없는 행의 DOM은 지금과 같아야 한다(R0)** — 표지가 있을 때만 위 구조를 쓰고, 없으면 기존 `<div className="w-40 shrink-0 truncate text-sm font-medium" title=…>` 한 줄을 그대로 렌더한다(조건 분기). 기존 테스트의 `truncate`+`title` 단언은 그대로 통과해야 한다.

`LoopExitSummary`:

```tsx
export function LoopExitSummary({ views }: { views: LoopExitView[] }) {
  if (views.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="-mt-3 mb-6 flex items-start gap-1 text-sm text-slate-700">
      <ul aria-label={t.summaryLabel} className="min-w-0 space-y-1">
        {views.map((v) => (
          <li key={v.stepId} className="break-words">
            {t.summaryLine(v.name, n(v.entered), n(v.retries), floorPct(v.retryPct), n(v.exhausted))}
            {v.truncated > 0 && t.summaryTruncated(n(v.truncated))}
          </li>
        ))}
      </ul>
      <HelpTip label={t.summaryHelpLabel}>
        <span className="block">{t.summaryHelpEntered}</span>
        <span className="block">{t.summaryHelpRetries}</span>
        <span className="block">{t.summaryHelpExhausted}</span>
        <span className="block">{t.summaryHelpTruncated}</span>
      </HelpTip>
    </div>
  );
}
```

(`HelpTip`의 import 경로·prop 이름은 `StepPhaseBreakdown.tsx`의 사용을 따른다. 위 여백 `-mt-3`은 스텝 통계 블록의 `mb-6` 아래에 바짝 붙이려는 것이다 — 실제 간격은 라이브에서 `getBoundingClientRect`로 재고, 스텝 통계와의 간격이 8–16px이 아니면 값을 고친다. 도움말은 줄마다가 아니라 묶음에 하나.)

- [ ] **Step 4: GREEN** — 위 세 테스트 + `pnpm test`(전체) + `pnpm lint` + `pnpm build`.

- [ ] **Step 5: 이빨** — `StepStatsTable`의 `retriedStepIds?.has(…)`를 `true`로 → "다른 행에는 없음"·"DOM 불변" RED → 원복. `LoopExitSummary`의 `v.truncated > 0 &&`를 지우면 "`마치지 못함`이 없다" RED → 원복. `StepPhaseBreakdown` 막대 보기의 조건 분기를 없애고 항상 새 flex 구조로 → "표지 없는 행의 `getByTitle`이 `w-40`" RED → 원복.

- [ ] **Step 6: 커밋** — `feat(ui): 리포트 스텝 행 「재시도 포함」 표지 + 조건 반복 풀이 줄 (loop-while-report)`

---

### Task 8: UI — 회차 분포 패널 + 맨 위 안내 + `ReportView` 배선

**Files:**
- Create: `ui/src/components/report/LoopExitPanel.tsx` · `LoopRetryNotice.tsx`
- Create: `ui/src/components/report/__tests__/LoopExitPanel.test.tsx` · `LoopRetryNotice.test.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` — `useMemo` 하나(`groupMeta` 뒤, 90행 부근)·렌더 4곳
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx`
- Modify: `ui/src/components/report/CLAUDE.md` — 한 줄

**Interfaces:**
- Consumes: Task 6·7 전부.

- [ ] **Step 1: 테스트를 쓴다**

`LoopExitPanel.test.tsx`:
- Task 6 케이스 1의 뷰로 렌더 → 섹션 `getByRole("region", { name: "조건 반복 회차 분포" })`(jsdom이 region을 못 찾으면 형제 테스트의 폴백 관용을 따른다), 소제목 `「주문 재시도」 — 진입 1,200회가 몇 번째 시도에서 끝났나`.
- 줄 라벨이 순서대로 `1번째`, `2번째`, `3번째`, `5번째`, `21번째 이후`, `중단`, `마치지 못함`(`getAllByTestId("loop-exit-row-label")`의 텍스트 배열).
- 값 글자 `816 · 68.0%`(리터럴). 막대는 `getAllByRole("img")`, 첫 막대의 `aria-label`이 `1번째, 재시도 없이 끝남, 816건, 68.0%`, 두 번째가 `2번째, 재시도 후 끝남, 240건, 20.0%`, 중단 막대가 `중단, 12건, 1.0%`, 마치지 못함 막대가 `마치지 못함, 3건, 0.3%`(분류 글자를 되풀이하지 않는다).
- 막대 채움 폭: 첫 줄 채움 요소의 `parseFloat(style.width)`가 68에 가깝다(`toBeCloseTo(68, 5)` — `816/1200`), 두 번째 줄은 20.
- 중단 줄 아래 `최대 5번까지 조건이 풀리지 않아 이번 반복을 끝냄`, `maxPasses: null`이면 `최대 횟수까지 …`. 마치지 못함 줄 아래 `run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊김`.
- 범례: 그 run에 있는 분류만 — 위 뷰는 네 항목(`1번째 = 재시도 없이 끝남`·`2번째 이후 = 재시도 후 끝남`·`중단`·`마치지 못함`), `first` 줄만 있는 뷰는 한 항목.
- 네 분류의 채움 색이 서로 다르다(`toHaveStyle({ backgroundColor })`로 네 값이 모두 다른지).
- `views=[]` → 빈 `container`.

`LoopRetryNotice.test.tsx`:
- 재시도 있는 loop 1개 + 중단 → 머리 `해석 주의 · 조건 반복의 재시도가 섞여 있습니다`, 줄 `「주문 재시도」: 본문 실행 1,812회 중 612회(33.8%)가 재시도 · 최대 횟수에 걸려 중단된 반복 12건`, 꼬리 문장 있음.
- 중단이 0이면 그 `listitem`이 `not.toHaveTextContent(/최대 횟수에 걸려/)`(짝 확인: 중단 12인 뷰는 `toHaveTextContent(/최대 횟수에 걸려 중단된 반복 12건/)`).
- 안내는 `getByRole("region", { name: "조건 반복 해석 주의" })`로 찾는다.
- `repeat: 1` 뷰만 → 머리 `해석 주의 · 최대 횟수에서 중단된 조건 반복이 있습니다`, 줄 `「X」: 최대 횟수에 걸려 중단된 반복 5건`, **꼬리 없음**.
- 대상 5개 → 줄 3개 + `외 2개 조건 반복`. 순서는 `noticeLoops` 순.
- 대상 0개(`retries 0`·`exhausted 0`인 뷰만) → 빈 `container`.

`ReportView.test.tsx`에:
- `loop_exits` + `validity.level: "limited"`(`ok`이면 배너가 안 그려진다) + `verdict`가 든 리포트 → `compareDocumentPosition`으로 순서 단언(같은 파일 398–431행의 기존 순서 테스트 꼴): 유효성 배너 region < 안내 region(`조건 반복 해석 주의`) < 판정 패널 region < 스텝 heading < 풀이 줄 list(`조건 반복 풀이`) < 분포 패널 region(`조건 반복 회차 분포`).
- `loop_exits`가 없는 기존 픽스처 → `queryByText("재시도 포함")`·`queryByRole("list", { name: "조건 반복 풀이" })`·`queryByRole("region", { name: "조건 반복 회차 분포" })`·`queryByRole("region", { name: "조건 반복 해석 주의" })`가 전부 null(전체 글자·접근 이름으로 찾는다 — 부분 글자 `queryByText`는 항상 null이라 공허). 짝 확인: 위 `loop_exits` 픽스처에서는 같은 네 쿼리가 요소를 찾는다.
- `scenario_yaml`이 깨진 리포트 + `loop_exits` → 패널 소제목에 loop id가 보이고 throw 없음.

- [ ] **Step 2: RED 확인** — `pnpm test LoopExitPanel` · `pnpm test LoopRetryNotice` · `pnpm test ReportView`.

- [ ] **Step 3: 구현**

`LoopExitPanel`(요지 — 구조와 클래스는 이대로):

```tsx
const FILL: Record<LoopExitRowKind, string> = {
  first: "#64748b", // slate-500 — 차분한 색
  retried: "#f59e0b", // amber-500 — 주의
  exhausted: "#dc2626", // red-600 — 경고
  truncated: "#94a3b8", // slate-400 — 회색(막대 바탕 slate-100과 구분되게)
};

function rowLabel(r: LoopExitRow): string {
  const t = ko.report.loopExit;
  if (r.kind === "exhausted") return t.rowExhausted;
  if (r.kind === "truncated") return t.rowTruncated;
  return r.pass === null ? t.rowOver : t.rowNth(r.pass);
}
/** 막대 접근 이름에 넣을 분류 글자. 중단·마치지 못함 줄은 라벨이 곧 분류라 빈 문자열. */
function kindLabel(k: LoopExitRowKind): string {
  const t = ko.report.loopExit;
  if (k === "first") return t.kindFirst;
  if (k === "retried") return t.kindRetried;
  return "";
}

export function LoopExitPanel({ views }: { views: LoopExitView[] }) {
  if (views.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  const kinds = new Set(views.flatMap((v) => v.rows.map((r) => r.kind)));
  return (
    <PageSection ariaLabel={t.panelLabel} title={t.panelTitle}>
      {views.map((v) => (
        <div key={v.stepId} className="mb-4 last:mb-0">
          <h4 className="mb-2 break-words text-sm font-semibold">
            {t.panelHeading(v.name, n(v.entered))}
          </h4>
          <div className="space-y-1">
            {v.rows.map((r) => {
              const label = rowLabel(r);
              const pct = floorPct(r.pct);
              return (
                <div key={`${r.kind}-${r.pass ?? "x"}`}>
                  <div className="flex items-center gap-3 text-sm">
                    <div data-testid="loop-exit-row-label" className="w-24 shrink-0 whitespace-nowrap">
                      {label}
                    </div>
                    <div
                      role="img"
                      aria-label={t.barLabel(label, kindLabel(r.kind), n(r.count), pct)}
                      className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-slate-100"
                    >
                      <span
                        className="block h-full"
                        style={{ width: `${r.pct}%`, backgroundColor: FILL[r.kind] }}
                      />
                    </div>
                    <div className="w-36 shrink-0 whitespace-nowrap text-right tabular-nums">
                      {t.rowValue(n(r.count), pct)}
                    </div>
                  </div>
                  {r.kind === "exhausted" && (
                    <p className="ml-[108px] text-xs text-slate-500">
                      {v.maxPasses === null ? t.exhaustedNoteNoMax : t.exhaustedNote(n(v.maxPasses))}
                    </p>
                  )}
                  {r.kind === "truncated" && (
                    <p className="ml-[108px] text-xs text-slate-500">{t.truncatedNote}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {(["first", "retried", "exhausted", "truncated"] as const)
          .filter((k) => kinds.has(k))
          .map((k) => (
            <li key={k} className="flex items-center whitespace-nowrap">
              <span
                aria-hidden="true"
                className="mr-1 inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: FILL[k] }}
              />
              {k === "first"
                ? t.legendFirst
                : k === "retried"
                  ? t.legendRetried
                  : k === "exhausted"
                    ? t.rowExhausted
                    : t.rowTruncated}
            </li>
          ))}
      </ul>
    </PageSection>
  );
}
```

(색 값은 저작 시점 선택이다 — 라이브에서 네 채움 색 각각이 막대 바탕(`bg-slate-100`)과 대비 3:1 이상인지 계산해 확인하고(못 미치면 더 짙은 단계로), 인접 줄끼리 구분되는지 보고, 디자인 시스템에 같은 뜻의 토큰이 있으면 그것으로 바꾼다. `ml-[108px]` = 라벨 칸 96px + 간격 12px. 라이브에서 풀이 글자의 왼쪽이 막대의 왼쪽과 맞는지 `getBoundingClientRect().left`로 잰다. 값 칸 `w-36`은 `9,999,999 · 100.0%`가 들어가는지 라이브에서 `scrollWidth <= clientWidth`로 잰다.)

`LoopRetryNotice`:

```tsx
const MAX_LINES = 3;

export function LoopRetryNotice({ views }: { views: LoopExitView[] }) {
  const targets = noticeLoops(views);
  if (targets.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  const anyRetry = targets.some((v) => v.retries >= 1);
  const shown = targets.slice(0, MAX_LINES);
  const more = targets.length - shown.length;
  return (
    <Callout
      variant="warn"
      role="region"
      aria-label={t.noticeLabel}
      className="mb-6"
      title={anyRetry ? t.noticeHeadRetry : t.noticeHeadExhausted}
    >
      <ul className="list-disc space-y-0.5 pl-5">
        {shown.map((v) => (
          <li key={v.stepId} className="break-words">
            {v.retries >= 1
              ? t.noticeRetryLine(v.name, n(v.passes), n(v.retries), floorPct(v.retryPct)) +
                (v.exhausted >= 1 ? t.noticeExhaustedSuffix(n(v.exhausted)) : "")
              : t.noticeExhaustedOnly(v.name, n(v.exhausted))}
          </li>
        ))}
        {more > 0 && <li>{t.noticeMore(n(more))}</li>}
      </ul>
      {anyRetry && <p className="mt-2">{t.noticeTail}</p>}
    </Callout>
  );
}
```

(`role`·`aria-label`·`className="mb-6"`은 `ValidityBanner.tsx:93-97`과 같은 꼴이다.)

`ReportView`:

```tsx
  const loopExitViews = useMemo(() => {
    const parsed = parseScenarioDoc(report.scenario_yaml);
    return buildLoopExitViews(
      report.loop_exits,
      report.steps,
      "model" in parsed ? parsed.model.steps : null,
    );
  }, [report.scenario_yaml, report.loop_exits, report.steps]);
  const retriedStepIds = useMemo(() => retriedStepIdSet(loopExitViews), [loopExitViews]);
```

렌더: `<ValidityBanner … />` 바로 뒤 `<LoopRetryNotice views={loopExitViews} />` · `<StepPhaseBreakdown steps=… meta=… retriedStepIds={retriedStepIds} />` 바로 뒤 `<LoopExitSummary views={loopExitViews} />` · `<BranchStatsTable … />` 바로 뒤 `<LoopExitPanel views={loopExitViews} />`. `loop_exits`가 없으면 `loopExitViews`는 `[]`이고 세 컴포넌트가 `null`, `retriedStepIds`는 빈 집합이다 — `StepPhaseBreakdown`은 빈 집합에서 기존 DOM을 낸다(Task 7).

`ui/src/components/report/CLAUDE.md`에 한 줄(목록 끝):

```markdown
- **조건 반복 리포트 표시는 `loopExitView.ts` 한 곳에서 계산 — 표지·풀이 줄·분포 패널·맨 위 안내가 같은 뷰를 쓴다** (loop-while-report): 표시는 `report.loop_exits`에 그 loop 항목이 있을 때만(YAML에 조건 반복이 있어도 집계가 없으면 0개 — 옛 run 불변). `pass`는 1부터(`loop_breakdown.loop_index`는 0부터). 「재시도 포함」은 `loop_breakdown`에 2번째 이후 회차 요청이 있는 스텝에만(루프 집계 상한 0이면 loop 단위 폴백). 막대 보기의 표지는 고정 폭 이름 칸 **안**(밖에 두면 행마다 막대 폭이 달라진다).
```

- [ ] **Step 4: GREEN** — `pnpm lint && pnpm test && pnpm build`(전체).

- [ ] **Step 5: 이빨** — `LoopRetryNotice`의 `{anyRetry && …}`를 무조건 렌더로 → "`repeat: 1` 꼬리 없음" RED → 원복. `LoopExitPanel` 범례의 `.filter((k) => kinds.has(k))` 삭제 → "한 항목" RED → 원복. `ReportView`에서 `<LoopRetryNotice>`를 `<VerdictPanel>` 뒤로 옮기면 순서 단언(안내 < 판정 패널) RED → 원복.

- [ ] **Step 6: 커밋** — `feat(ui): 조건 반복 회차 분포 패널 + 맨 위 해석 주의 (loop-while-report)`

---

## 구현 뒤 (task 밖 — orchestrator)

1. **전체 게이트**: `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace`, `pnpm lint && pnpm test && pnpm build`, `cargo build -p handicap-worker`(라이브용 워커 바이너리).
2. **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — proto ↔ 워커 변환 ↔ ingest ↔ 테이블 ↔ `LoopExit` ↔ Zod, 가드 5곳, R0, `error_kind` 길과의 짝). `finish-slice` §0 grep으로 보안 게이트 판단.
3. **라이브 검증**(`/live-verify`, spec §5 표 그대로 — US1–US4 + fan-out 1회 + open-loop 1회 + 극단값):
   - 응답기: 요청마다 일정 비율로 `{"code":"WAIT"}`/`{"code":"OK"}`를 주는 것, 끝내 WAIT만 주는 것, 같은 가상 사용자(`?vu=${vu_id}` 쿼리로 구분)에게 25번째 요청부터 OK를 주는 것.
   - 숫자 대조: 본문 스텝 하나인 run에서 `0 ≤ passes − 스텝 요청 수 ≤ truncated`, 분포 줄 건수 합 = `entered`.
   - 화면: 표 보기·막대 보기(`measure_phases: true` run)의 표지, 풀이 줄과 스텝 통계의 간격, 패널 풀이 글자와 막대의 왼쪽 정렬, 값 칸 잘림 없음, 좁은 창 폭. 극단값: 조건 반복 3개 이상·이름 60자·23줄 분포·진입 수백만.
   - US4: 조건 반복 없는 run과 이 작업 전 DB의 run에서 `loop_exits` 키 없음·새 요소 0개.
   - 실 `/report` JSON을 저장해 `ReportSchema.safeParse` 통과 확인(throwaway 테스트, 커밋 안 함).
4. **마무리**(`/finish-slice`): ADR-0056에 "리포트 집계" 절, build-log 단락, roadmap 새 §B 블록(번호는 `grep -n '^### B' docs/roadmap.md` 마지막 +1 — spec §8 연기 목록 + 구현 중 판단), 현황판·상태 줄, 1차 spec 부록 A에 "2차에서 '잘린 진입도 센다'로 바뀜" 한 줄.
