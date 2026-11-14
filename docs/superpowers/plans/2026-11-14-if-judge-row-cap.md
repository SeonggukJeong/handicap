# if 판정 줄 상한 (if-judge-row-cap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 요청 없이 판정만 도는 시나리오가 시험 실행·모니터에서 컨트롤러 메모리와 실행기 스레드를 잡지 못하게 한다.

**Architecture:** 엔진 단일 패스 trace(`crates/engine/src/trace.rs`)에 if 판정 줄 수 상한(요청 상한 비례)·판정 줄 바이트 예산·진행 없는 반복 끊기·양보 지점 3곳을 넣는다. 컨트롤러 모니터는 잘림 사유를 고르는 두 곳이 도우미 하나를 쓰고 새 사유 `판정 줄 상한 초과`를 낸다. UI는 시험 실행 잘림 문구와 사유 폭 후보 표만 바꾼다. trace 와이어 모양·proto·마이그레이션·부하 run 경로(`runner.rs`)는 건드리지 않는다.

**Tech Stack:** Rust(tokio, wiremock 테스트), React/TypeScript(vitest + RTL).

**Spec:** `docs/superpowers/specs/2026-11-14-if-judge-row-cap-design.md` — US 블록(헤딩 `## 사용자 스토리 (US)`)을 매 task brief에 첨부한다.

REVIEW-GATE: APPROVED

(spec 3회차·plan 2회차 `spec-plan-reviewer` clean APPROVE, 2026-11-14)

## Global Constraints

- 워크트리: `/Users/sgj/develop/handicap/.claude/worktrees/if-judge-row-cap` (브랜치 `worktree-if-judge-row-cap`). subagent prompt 첫 줄에 이 `cd`를 쓴다.
- `ScenarioTrace`·`StepTrace`·`RowsTrace`에 필드를 더하지 않는다(TUI 와이어 거울이 `deny_unknown_fields`).
- `crates/engine/src/runner.rs`·`crates/tui/`·proto·마이그레이션 무변경.
- 상수(spec §2.1·§2.2에서 그대로): if 줄 상한 `max(1000, max_requests × 10)`(포화 곱) · 조건 반복 상한 `MAX_LOOP_JUDGE_ROWS = 200`(무변경) · 바이트 예산 `(if 줄 상한 + 200) × 4096` · 줄 어림 = 가변 글자 `str::len` 합 + 줄당 64 + `BranchEval`당 32.
- 사유 글자(와이어, byte-exact): `판정 줄 상한 초과`.
- 시험 실행 잘림 문구(byte-exact): `상한 도달 — 일부만 실행됨 (요청 수·판정 줄 수 또는 시간 상한)`.
- 어느 상한에도 닿지 않고 무진행 회차가 없는 시나리오의 trace는 이전과 같다(spec §2.5 R0). 기존 테스트를 고쳐서 통과시키지 않는다 — 기존 테스트가 깨지면 STOP하고 보고.
- 인라인 Rust는 clippy `-D warnings` 통과(2-arm `match … _ => {}` 대신 `if let`).
- 커밋: 단일 foreground 호출, 파이프 금지, 메시지는 `-F <파일>`, `--no-verify` 금지. cargo 게이트가 도는 동안 다른 `cargo` 금지.
- 이빨 실증: "**이빨**"이라고 적힌 스텝은 지정한 production 줄을 일시로 되돌려 RED를 확인하고 원복해 GREEN을 확인한 뒤, 보고서에 RED 출력 한 줄을 적는다.
- 줄번호는 저작 시점 `grep -n` 값이다. 편집 전에 같은 `grep -n`으로 다시 확인한다.

## Review Focus

spec이 암시하지만 놓치기 쉬운 입력. 각 줄의 테스트는 괄호 안 task에 들어 있다.

1. parallel 분기 안의 if가 상한에 닿음 — 분기 재귀가 잘려도 병합은 돌고 패닉이 없어야 한다 (Task 1 `trace_if_rows_capped_inside_parallel`).
2. `max_requests = u32::MAX` — 상한은 포화, 바이트 예산은 u64에서 계산해 넘침 없음 (Task 1·2의 포화 단언).
3. 순차 데이터 실행에서 if 줄 수가 행 사이에 이월 — 행마다 초기화하면 예산이 행 수만큼 불어난다 (Task 1 순차 테스트 2개).
4. 조건 원문이 멀티바이트(한글) — 글자 수가 아니라 바이트로 세고, 자르지 않으므로 경계 패닉이 없다 (Task 2 `judge_row_bytes_counts_variable_text`).
5. 진행 없는 반복 안에 parallel 병합만 있는 경우 — 끊겨도 병합 결과는 남는다 (Task 3 `trace_no_progress_loop_keeps_parallel_merge`).

---

### Task 1: 엔진 — if 판정 줄 수 상한 + 순차 행 시작 검사

**Files:**
- Modify: `crates/engine/src/trace.rs` — 상수·함수(44행 `MAX_LOOP_JUDGE_ROWS` 아래), `TraceState`(129행), 초기화 2곳(200행·245행 `judge_rows: 0,`), 행 시작 검사(252행), `Step::If` 가지(572행), 인라인 테스트 모듈 끝
- Test: 같은 파일 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `pub fn if_judge_row_cap(max_requests: u32) -> u32` · `TraceState.if_rows: u32`(전 행 공유, `trace_once`에서 초기화하지 않음)

- [ ] **Step 1: 실패하는 테스트를 쓴다** (테스트 모듈 끝, `trace_sequential_rows_continue_after_exhausted` 뒤)

```rust
    // ---------- if 판정 줄 상한 (if-judge-row-cap) ----------
    const IF_ID: &str = "01HX0000000000000000000009";

    /// loop(repeat) → 항상 거짓 if. spec §1.1.
    fn spin_if_yaml(repeat: u64) -> String {
        format!(
            r#"version: 1
name: ifspin
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: {repeat}
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        )
    }

    fn if_rows(t: &ScenarioTrace) -> usize {
        t.steps.iter().filter(|s| s.kind == StepKind::If).count()
    }

    #[test]
    fn if_judge_row_cap_scales_with_max_requests() {
        assert_eq!(if_judge_row_cap(0), 1000);
        assert_eq!(if_judge_row_cap(50), 1000);
        assert_eq!(if_judge_row_cap(100), 1000);
        assert_eq!(if_judge_row_cap(200), 2000);
        assert_eq!(if_judge_row_cap(10_000), 100_000);
        assert_eq!(if_judge_row_cap(u32::MAX), u32::MAX);
    }

    #[tokio::test]
    async fn trace_if_rows_capped() {
        let sc = Scenario::from_yaml(&spin_if_yaml(1_000_000)).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(started.elapsed() < StdDuration::from_secs(5));
        assert_eq!(if_rows(&t), 1000);
        assert_eq!(t.steps.len(), 1000);
        assert!(t.truncated);
    }

    #[tokio::test]
    async fn trace_if_row_cap_boundary() {
        let o = t_opts(false, 50, StdDuration::from_secs(30));
        let t = trace_scenario(&Scenario::from_yaml(&spin_if_yaml(1000)).unwrap(), &o).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(!t.truncated, "정확히 상한 번째 줄에서 끝난 시나리오는 잘림이 아니다");
        let t = trace_scenario(&Scenario::from_yaml(&spin_if_yaml(1001)).unwrap(), &o).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(t.truncated);
    }

    #[tokio::test]
    async fn trace_if_row_cap_proportional() {
        let sc = Scenario::from_yaml(&spin_if_yaml(1500)).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 200, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 1500);
        assert!(!t.truncated);
    }

    #[tokio::test]
    async fn trace_if_rows_capped_inside_parallel() {
        let yaml = format!(
            r#"version: 1
name: par-if
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: 2000
    do:
      - id: "{ORDER_ID}"
        name: par
        type: parallel
        branches:
          - name: A
            steps:
              - id: "{IF_ID}"
                name: never
                type: if
                cond: {{ left: "1", op: eq, right: "2" }}
                then: []
"#
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(t.truncated);
    }

    /// http(/first) → `tail`. 순차 2행 — 1행이 판정 줄 예산을 정확히 바닥내면 2행은 시작하지 않는다.
    async fn rows_after_exact_budget(tail: &str) -> (RowsTrace, usize) {
        let server = MockServer::start().await;
        Mock::given(wm_path("/first"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let yaml = format!(
            r#"version: 1
name: seq-edge
steps:
  - id: "{AFTER_ID}"
    name: first
    type: http
    request: {{ method: GET, url: "{}/first" }}
    assert: []
{tail}"#,
            server.uri()
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let seeds = vec![(0u64, BTreeMap::new()), (1u64, BTreeMap::new())];
        let rt =
            trace_scenario_rows(&sc, &t_opts(false, 50, StdDuration::from_secs(30)), &seeds).await;
        let sent = server.received_requests().await.unwrap().len();
        (rt, sent)
    }

    #[tokio::test]
    async fn trace_rows_stop_before_row_when_if_budget_exhausted() {
        let tail = format!(
            r#"  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: 1000
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        );
        let (rt, sent) = rows_after_exact_budget(&tail).await;
        assert_eq!(rt.rows.len(), 1, "2행은 미실행");
        assert!(!rt.rows[0].trace.truncated, "1행은 잘리지 않고 끝났다");
        assert_eq!(if_rows(&rt.rows[0].trace), 1000);
        assert!(rt.truncated);
        assert_eq!(sent, 1, "2행의 요청이 나가지 않았다");
    }

    #[tokio::test]
    async fn trace_rows_stop_before_row_when_loop_judge_budget_exhausted() {
        let tail = format!(
            r#"  - id: "{LOOP_ID}"
    name: edge
    type: loop
    while: {{ left: "${{loop_index}}", op: lt, right: "199" }}
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        );
        let (rt, sent) = rows_after_exact_budget(&tail).await;
        assert_eq!(rt.rows.len(), 1, "2행은 미실행");
        let t = &rt.rows[0].trace;
        assert!(!t.truncated);
        let loops: Vec<_> = t.steps.iter().filter(|s| s.kind == StepKind::Loop).collect();
        assert_eq!(loops.len(), MAX_LOOP_JUDGE_ROWS as usize);
        assert_eq!(loops.last().unwrap().branch.as_deref(), Some("done"));
        assert!(rt.truncated);
        assert_eq!(sent, 1);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-engine trace::tests`
Expected: 컴파일 에러 `cannot find function if_judge_row_cap`.

- [ ] **Step 3: 구현한다** (`crates/engine/src/trace.rs`)

  1. `MAX_LOOP_JUDGE_ROWS` 아래에 `pub fn if_judge_row_cap(max_requests: u32) -> u32` — `max_requests.saturating_mul(10).max(1000)`. 문서 주석: if 판정 줄의 전 행 공유 상한, 요청 상한에 비례, 배수 10·바닥 1000의 근거는 spec §2.1.
  2. `TraceState`에 `if_rows: u32`(주석: 지금까지 넣은 if 판정 줄 수 — 전 행 공유 예산). 초기화 2곳에 `if_rows: 0,`. `trace_once`의 리셋 목록에는 넣지 않는다.
  3. `Step::If` 가지의 **첫 문장**(조건 평가 블록보다 앞)으로:
     ```rust
     if state.if_rows >= if_judge_row_cap(opts.max_requests) {
         state.truncated = true;
         return;
     }
     ```
     그리고 `state.steps.push(StepTrace { … kind: StepKind::If … })` 바로 뒤에 `state.if_rows += 1;`.
  4. `trace_scenario_rows`의 행 시작 검사 조건에 두 항을 더한다:
     `|| state.if_rows >= if_judge_row_cap(opts.max_requests) || state.judge_rows >= MAX_LOOP_JUDGE_ROWS`. 그 위 주석과 함수 문서 주석("예산이 행 시작 전에 소진되면")에 판정 줄 수 예산 2종을 적는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-engine`
Expected: 전부 PASS(기존 `trace_judge_rows_capped*`·`trace_sequential_rows_continue_after_exhausted` 포함).

- [ ] **Step 5: 이빨**

  - 3의 If 가지 상한 검사를 주석 처리 → `trace_if_rows_capped`·`trace_if_row_cap_boundary`·`trace_if_rows_capped_inside_parallel` RED → 원복.
  - 4의 두 항을 지움 → `trace_rows_stop_before_row_when_if_budget_exhausted`·`…loop_judge_budget_exhausted` RED(`rows.len() == 2`) → 원복 → 전체 GREEN.

- [ ] **Step 6: 커밋** — `feat(engine): if 판정 줄 수 상한 — 요청 상한 비례 + 순차 행 시작 검사 (if-judge-row-cap)`

---

### Task 2: 엔진 — 판정 줄 바이트 예산 + `judge_rows_exhausted`

**Files:**
- Modify: `crates/engine/src/trace.rs` — 함수 3개(`if_judge_row_cap` 아래), `TraceState`, 초기화 2곳, `Step::If` 가지, while 가지(`state.judge_rows += 1;` 533행 부근), 문서 주석 3곳(20·22·109행)
- Test: 같은 파일 인라인

**Interfaces:**
- Consumes: Task 1 `if_judge_row_cap`, `TraceState.if_rows`
- Produces:
  - `pub fn judge_row_bytes(row: &StepTrace) -> u64`
  - `pub fn judge_byte_budget(max_requests: u32) -> u64`
  - `pub fn judge_rows_exhausted(steps: &[StepTrace], max_requests: u32) -> bool` — Task 4가 `handicap_engine::trace::judge_rows_exhausted` 경로로 쓴다(`lib.rs` 무변경)
  - `TraceState.judge_bytes: u64`(전 행 공유)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
    // ---------- 판정 줄 바이트 예산 ----------
    fn judge_row(kind: StepKind, left: &str) -> StepTrace {
        StepTrace {
            step_id: "ab".into(),
            kind,
            loop_index: None,
            branch: Some("none".into()),
            request: None,
            response: None,
            extracted: BTreeMap::new(),
            unbound_vars: vec!["x".into(), "yz".into()],
            error: None,
            branch_eval: vec![BranchEval {
                branch: "then".into(),
                passed: false,
                leaf: Some(crate::condition::LeafEval {
                    left: left.into(),
                    op: CompareOp::Eq,
                    right: Some("r".into()),
                    left_value: Some("lv".into()),
                    right_value: None,
                    left_unbound: false,
                }),
            }],
            timed_out: false,
        }
    }

    fn judge_bytes_sum(t: &ScenarioTrace) -> u64 {
        t.steps
            .iter()
            .filter(|s| matches!(s.kind, StepKind::If | StepKind::Loop))
            .map(judge_row_bytes)
            .sum()
    }

    #[test]
    fn judge_row_bytes_counts_variable_text() {
        // 64 + step_id 2 + branch 4 + unbound 1+2 + (32 + "then" 4 + "한" 3 + "r" 1 + "lv" 2)
        assert_eq!(judge_row_bytes(&judge_row(StepKind::If, "한")), 115);
    }

    #[test]
    fn judge_byte_budget_scales_without_overflow() {
        assert_eq!(judge_byte_budget(50), 1200 * 4096);
        assert_eq!(judge_byte_budget(10_000), 100_200 * 4096);
        assert_eq!(judge_byte_budget(u32::MAX), (u32::MAX as u64 + 200) * 4096);
    }

    #[test]
    fn judge_rows_exhausted_cases() {
        let small_if = || judge_row(StepKind::If, "1");
        let small_loop = || judge_row(StepKind::Loop, "1");
        let n = |k: usize, f: &dyn Fn() -> StepTrace| (0..k).map(|_| f()).collect::<Vec<_>>();
        assert!(judge_rows_exhausted(&n(1000, &small_if), 50));
        assert!(!judge_rows_exhausted(&n(1000, &small_if), 200), "상한 2,000");
        assert!(!judge_rows_exhausted(&n(999, &small_if), 50));
        assert!(judge_rows_exhausted(&n(200, &small_loop), 50));
        assert!(judge_rows_exhausted(&n(200, &small_loop), 10_000), "조건 반복 상한은 비례 안 함");
        let mut mixed = n(999, &small_if);
        mixed.extend(n(199, &small_loop));
        assert!(!judge_rows_exhausted(&mixed, 50), "두 예산은 합치지 않는다");
        let big = "a".repeat(1_300_000);
        let huge = (0..4).map(|_| judge_row(StepKind::If, &big)).collect::<Vec<_>>();
        assert!(judge_rows_exhausted(&huge, 50), "5.2 MB > 예산 4.9 MB");
        assert!(!judge_rows_exhausted(&huge[..3], 50));
        assert!(!judge_rows_exhausted(&[], 50));
    }

    #[tokio::test]
    async fn trace_if_rows_byte_budget() {
        let big = "a".repeat(40_000);
        let yaml = spin_if_yaml(1_000_000).replace(r#"left: "1""#, &format!(r#"left: "{big}""#));
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(t.truncated);
        assert!(if_rows(&t) < 1000, "줄 수 상한보다 먼저 닿는다: {}", if_rows(&t));
        let budget = judge_byte_budget(50);
        let sum = judge_bytes_sum(&t);
        let last = judge_row_bytes(t.steps.last().unwrap());
        assert!(sum > budget, "넘긴 줄이 trace에 남는다");
        assert!(sum - last <= budget, "초과분은 줄 하나");
        assert!(judge_rows_exhausted(&t.steps, 50));
    }

    #[tokio::test]
    async fn trace_while_rows_byte_budget() {
        let big = "a".repeat(40_000);
        let yaml = format!(
            r#"version: 1
name: bigwhile
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    while: {{ left: "{big}", op: ne, right: "x" }}
    do: []
"#
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(t.truncated);
        assert!(t.ended_by_loop.is_none());
        let n = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert!(n < MAX_LOOP_JUDGE_ROWS as usize, "줄 수 상한보다 먼저 닿는다: {n}");
        assert!(judge_bytes_sum(&t) > judge_byte_budget(50));
    }
```

`BranchEval`·`CompareOp`는 파일 상단 `use`로 이미 들어와 있다(`use super::*`).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-engine trace::tests`
Expected: 컴파일 에러 `cannot find function judge_row_bytes`.

- [ ] **Step 3: 구현한다**

  1. `judge_row_bytes`: `64 + step_id.len() + branch(있으면).len() + Σ unbound_vars[i].len() + Σ branch_eval (32 + branch.len() + 잎이 있으면 left·right·left_value·right_value 각 len)`. `request`·`response`·`extracted`·`error`는 세지 않는다(판정 줄에는 없다).
  2. `judge_byte_budget`: `(if_judge_row_cap(max_requests) as u64 + MAX_LOOP_JUDGE_ROWS as u64) * 4096`.
  3. `judge_rows_exhausted`: `steps`를 한 번 훑어 If 줄 수·Loop 줄 수·두 종류의 `judge_row_bytes` 합을 구하고, `if 줄 수 ≥ if_judge_row_cap` **또는** `Loop 줄 수 ≥ MAX_LOOP_JUDGE_ROWS` **또는** `합 > judge_byte_budget`.
  4. `TraceState.judge_bytes: u64`, 초기화 2곳 `judge_bytes: 0,`. `trace_once`에서 리셋하지 않는다.
  5. 비공개 도우미 `fn charge_judge_row(state: &mut TraceState, opts: &TraceOptions) -> bool` — `state.steps`의 마지막 줄 어림을 `judge_bytes`에 더하고(`saturating_add`) `judge_bytes > judge_byte_budget(opts.max_requests)`를 돌려준다.
  6. `Step::If` 가지: `state.if_rows += 1;` **다음에** `if charge_judge_row(state, opts) { state.truncated = true; return; }`(분기 자식 재귀보다 앞). 순서 고정: 줄 수 증가가 바이트 return보다 먼저다(안 그러면 넘긴 줄이 줄 수에서 빠진다).
  7. while 가지: `state.judge_rows += 1;` 다음, `if !again { break; }`보다 앞에 같은 두 줄. 이때 `ended_by_loop`은 세우지 않는다.
  8. 문서 주석: `TraceOptions.max_requests`에 "if 판정 줄 상한과 판정 줄 바이트 예산도 이 값에 비례한다", `TraceOptions.max_wall`에 "판정 줄 상한에 먼저 닿으면 그 전에 끊긴다", `ScenarioTrace.truncated`를 "`max_requests`·판정 줄 상한(줄 수·바이트) 또는 시간 상한이 패스를 끊었을 때 true"로, `trace_once` 문서 주석(287–289행)의 이월 목록에 `if_rows`·`judge_rows`·`judge_bytes`를.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-engine`
Expected: 전부 PASS.

- [ ] **Step 5: 이빨** — 6의 If 쪽 `charge_judge_row` 두 줄을 주석 처리 → `trace_if_rows_byte_budget` RED → 원복. 7의 while 쪽을 주석 처리 → `trace_while_rows_byte_budget` RED → 원복 → 전체 GREEN.

- [ ] **Step 6: 커밋** — `feat(engine): 판정 줄 바이트 예산 + judge_rows_exhausted (if-judge-row-cap)`

---

### Task 3: 엔진 — 진행 없는 반복 끊기 + 양보 지점

**Files:**
- Modify: `crates/engine/src/trace.rs` — while 없는 loop 가지(`for i in 0..lp.plain_repeat()` 543행 부근), `Step::If` 가지 머리, while 가지; `crates/engine/CLAUDE.md` test-run trace 절(37행 헤딩 아래 목록 끝)
- Test: `trace.rs` 인라인

**Interfaces:**
- Consumes: Task 1의 If 가지 상한 검사 위치, Task 2의 `charge_judge_row` 위치

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
    // ---------- 진행 없는 반복 끊기 + 양보 ----------
    const EMPTY_SPIN: &str = r#"version: 1
name: emptyspin
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 4000000000
    do: []
"#;

    const NESTED_EMPTY_SPIN: &str = r#"version: 1
name: nested
steps:
  - id: "01HX0000000000000000000001"
    name: outer
    type: loop
    repeat: 4000000000
    do:
      - id: "01HX0000000000000000000002"
        name: inner
        type: loop
        repeat: 4000000000
        do: []
"#;

    #[tokio::test]
    async fn trace_no_progress_loop_ends_at_once() {
        for y in [EMPTY_SPIN, NESTED_EMPTY_SPIN] {
            let sc = Scenario::from_yaml(y).unwrap();
            let started = std::time::Instant::now();
            let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(2))).await;
            assert!(started.elapsed() < StdDuration::from_secs(1), "{:?}", started.elapsed());
            assert!(t.steps.is_empty());
            assert!(!t.truncated);
            assert!(t.ok);
        }
    }

    #[tokio::test]
    async fn trace_no_progress_loop_keeps_parallel_merge() {
        let yaml = r#"version: 1
name: par-merge
variables:
  x: "v"
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 4000000000
    do:
      - id: "01HX0000000000000000000002"
        name: par
        type: parallel
        branches:
          - name: A
            steps:
              - id: "01HX0000000000000000000003"
                name: zero
                type: loop
                repeat: 0
                do:
                  - id: "01HX0000000000000000000004"
                    name: never
                    type: http
                    request: { method: GET, url: "http://127.0.0.1:1/never" }
                    extract:
                      - { var: x, from: body, path: "$.x" }
"#;
        let sc = Scenario::from_yaml(yaml).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(2))).await;
        assert!(started.elapsed() < StdDuration::from_secs(1), "{:?}", started.elapsed());
        assert!(!t.truncated);
        assert!(t.steps.is_empty());
        assert_eq!(t.final_vars.get("A.x").map(String::as_str), Some("v"));
    }

    #[tokio::test]
    async fn trace_progress_loop_runs_every_iteration() {
        let sc = Scenario::from_yaml(&spin_if_yaml(7)).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 7);
        let idx: Vec<_> = t.steps.iter().map(|s| s.loop_index).collect();
        assert_eq!(idx, (0..7).map(Some).collect::<Vec<_>>());
        assert!(!t.truncated);
    }

    /// 단일 스레드 런타임에서 trace가 도는 동안 옆 task가 몇 번 돌았는지.
    async fn side_ticks_during_trace(yaml: &str) -> (ScenarioTrace, u64) {
        use std::sync::atomic::{AtomicU64, Ordering};
        let counter = Arc::new(AtomicU64::new(0));
        let c = counter.clone();
        let side = tokio::spawn(async move {
            loop {
                c.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        });
        let sc = Scenario::from_yaml(yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        side.abort();
        (t, counter.load(Ordering::Relaxed))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_if_rows_yield_to_other_tasks() {
        // loop 없이 최상위 if 300개 — If 가지의 양보만 관찰된다.
        let mut y = String::from("version: 1\nname: flat-ifs\nsteps:\n");
        for i in 0..300 {
            y += &format!(
                "  - id: \"01HX00000000000000000{i:05}\"\n    name: n{i}\n    type: if\n    cond: {{ left: \"1\", op: eq, right: \"2\" }}\n    then: []\n"
            );
        }
        let (t, n) = side_ticks_during_trace(&y).await;
        assert_eq!(if_rows(&t), 300);
        assert!(n > 100, "옆 task가 굶었다: counter={n}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_plain_loop_iterations_yield_to_other_tasks() {
        // 보내기 전에 실패하는 http(상대 주소) — 회차마다 줄은 생기지만 send가 멈추지 않는다.
        let y = r#"version: 1
name: failing-http
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 40
    do:
      - id: "01HX0000000000000000000002"
        name: bad
        type: http
        request: { method: GET, url: "/x" }
        assert: []
"#;
        let (t, n) = side_ticks_during_trace(y).await;
        assert_eq!(t.steps.len(), 40);
        assert!(t.steps.iter().all(|s| s.error.is_some()));
        assert!(n >= 30, "옆 task가 굶었다: counter={n}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_while_passes_yield_to_other_tasks() {
        let y = r#"version: 1
name: empty-while
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    while: { left: "1", op: eq, right: "1" }
    do: []
"#;
        let (t, n) = side_ticks_during_trace(y).await;
        let rows = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert_eq!(rows, MAX_LOOP_JUDGE_ROWS as usize);
        assert!(t.truncated, "기존 동작 그대로");
        assert!(n > 100, "옆 task가 굶었다: counter={n}");
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-engine trace::tests`
Expected: `trace_no_progress_loop_ends_at_once`·`trace_no_progress_loop_keeps_parallel_merge` FAIL(2초 시간 상한에서 잘림), 양보 테스트 3개 FAIL(`counter=0`류). **구현 중 실측 확정**: `trace_plain_loop_iterations_yield_to_other_tasks`가 양보 없이도 통과하면(= 상대 주소 요청의 `send().await`가 실제로는 멈춘다) 이 테스트가 공허하다 — STOP하고 보고(plan·spec §2.3 ②의 전제 정정 대상). `trace_progress_loop_runs_every_iteration`은 PASS(회귀 가드).

- [ ] **Step 3: 구현한다**

  1. while 없는 loop 가지: 회차 본문 재귀 **앞**에 `let before = (state.steps.len(), state.requests);`, 재귀와 기존 `if state.truncated || state.ended_by_loop.is_some() { return; }` **뒤**에:
     ```rust
     // 줄도 요청도 안 만든 회차는 다음 회차도 같다 — 남은 회차를 돌지 않는다(잘림 아님).
     if (state.steps.len(), state.requests) == before {
         break;
     }
     // 보내기 전에 실패하는 http만 든 본문은 줄을 만들면서도 멈추지 않는다.
     tokio::task::yield_now().await;
     ```
  2. `Step::If` 가지: Task 1의 상한 검사 **직후**에 `tokio::task::yield_now().await;`(주석: 큰 조건·비싼 `matches`가 줄 수만큼 실행기 스레드를 쥐지 않게).
  3. while 가지: Task 2의 `charge_judge_row` 두 줄 **직후**(`if !again`보다 앞)에 `tokio::task::yield_now().await;`.
  4. `crates/engine/CLAUDE.md` test-run trace 절 끝에 한 줄:
     `- **판정 줄은 세 겹으로 묶인다 — if 줄 수(`if_judge_row_cap` = max(1000, 요청 상한×10))·조건 반복 줄 수(200)·판정 줄 어림 바이트(`judge_byte_budget`); 줄도 요청도 안 만든 while 없는 loop 회차는 남은 회차를 건너뛴다(잘림 아님)** — 건너뛰기의 전제는 "그런 회차가 한 일은 parallel 병합뿐이라 다음 회차도 같다"이고, 손 YAML로 ① 분기 추출 이름에 점을 넣으면 회차마다 이름이 늘고 ② parallel 분기마다 요청 단위 생성기가 씨앗을 한 번씩 뽑는 것이 건너뛰어진다(둘 다 수용, UI로는 못 만든다). `ScenarioTrace`에 "어느 상한인지" 필드를 더하지 말 것(TUI 거울 `deny_unknown_fields`) — 모니터는 `judge_rows_exhausted`로 줄에서 다시 계산한다 (if-judge-row-cap)`

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-engine`
Expected: 전부 PASS(`crates/engine/tests/` 통합 테스트 포함 — 무진행 회차에 기대던 기존 테스트가 있으면 여기서 드러난다. 깨지면 STOP·보고).

- [ ] **Step 5: 이빨**
  - 1의 `break` 블록 주석 처리 → `trace_no_progress_loop_*` 2개 RED → 원복.
  - 1의 `break` 조건을 `state.requests == before.1`만 보게 바꿈 → `trace_progress_loop_runs_every_iteration` RED(if 줄 1개) → 원복.
  - 1의 `yield_now` 주석 처리 → `trace_plain_loop_iterations_yield_to_other_tasks` RED → 원복.
  - 2의 양보 주석 처리 → `trace_if_rows_yield_to_other_tasks` RED → 원복.
  - 3의 양보 주석 처리 → `trace_while_passes_yield_to_other_tasks` RED → 원복 → 전체 GREEN.

- [ ] **Step 6: 커밋** — `fix(engine): 진행 없는 반복 끊기 + if·조건 반복 판정의 양보 지점 (if-judge-row-cap)`

---

### Task 4: 컨트롤러 — 모니터 사유 `판정 줄 상한 초과`

**Files:**
- Modify: `crates/controller/src/monitor/check.rs` — 상수(33행 `REASON_LOOP_EXHAUSTED` 근처), 도우미(128행 `reason_timeout` 아래), `judge`의 잘림 가지(622–634행)
- Modify: `crates/controller/src/monitor/step_judge.rs` — `use` 목록(16–20행), 규칙 5(595–610행)
- Test: 두 파일 인라인

**Interfaces:**
- Consumes: Task 2 `handicap_engine::trace::judge_rows_exhausted(&[StepTrace], u32) -> bool`
- Produces: `pub const REASON_JUDGE_ROW_CAP: &str = "판정 줄 상한 초과";` · `pub(crate) fn truncated_reason(trace: &ScenarioTrace, timeout_secs: u32) -> String`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`check.rs` 테스트 모듈(`truncated_time_reason` 뒤):

```rust
    fn judge_rows(kind: StepKind, n: usize, left: &str) -> Vec<StepTrace> {
        (0..n)
            .map(|_| StepTrace {
                step_id: "01HX00000000000000000000ZZ".into(),
                kind: kind.clone(),
                loop_index: None,
                branch: Some("none".into()),
                request: None,
                response: None,
                extracted: BTreeMap::new(),
                unbound_vars: vec![],
                error: None,
                branch_eval: vec![handicap_engine::BranchEval {
                    branch: "then".into(),
                    passed: false,
                    leaf: Some(handicap_engine::LeafEval {
                        left: left.into(),
                        op: handicap_engine::scenario::CompareOp::Eq,
                        right: Some("2".into()),
                        left_value: None,
                        right_value: None,
                        left_unbound: false,
                    }),
                }],
                timed_out: false,
            })
            .collect()
    }

    #[test]
    fn truncated_judge_row_cap_reason() {
        // if 줄 수 상한
        let mut t = tr(judge_rows(StepKind::If, 1000, "1"));
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), "판정 줄 상한 초과");
        // 조건 반복 줄 수 상한
        let mut t = tr(judge_rows(StepKind::Loop, 200, "1"));
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), REASON_JUDGE_ROW_CAP);
        // 바이트 예산
        let mut t = tr(judge_rows(StepKind::If, 4, &"a".repeat(1_300_000)));
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), REASON_JUDGE_ROW_CAP);
    }

    #[test]
    fn truncated_reason_order() {
        // 요청 줄 50 + if 줄 1,000 → 요청 수 상한이 먼저
        let mut steps: Vec<StepTrace> = (0..50).map(|_| st(A, Some(resp(200, 1)), None)).collect();
        steps.extend(judge_rows(StepKind::If, 1000, "1"));
        let mut t = tr(steps);
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), "요청 수 상한(50) 초과");
        // 판정 줄이 상한 미만 → 시간 초과
        let mut steps = judge_rows(StepKind::If, 999, "1");
        steps.extend(judge_rows(StepKind::Loop, 199, "1"));
        let mut t = tr(steps);
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), "시간 초과(5초)");
    }
```

`step_judge.rs` 테스트 모듈(`truncated_not_run_reason` 뒤). 규칙 4 `exclusion_row`는 조상 if(`IF`)와 id가 같은 If 줄만 보므로, 다른 id(`LP`)의 If 줄·Loop 줄은 규칙 5까지 내려온다:

```rust
    #[test]
    fn truncated_not_run_judge_row_cap_reason() {
        let judge = |kind: StepKind, n: usize| -> Vec<StepTrace> {
            (0..n)
                .map(|i| {
                    let mut s = li(st(LP, None, None), i as u32);
                    s.kind = kind.clone();
                    s.request = None;
                    s.branch = Some("none".into());
                    s
                })
                .collect()
        };
        // 조건 반복 줄 200, if 줄 1,000 — 각각 같은 사유
        for rows in [judge(StepKind::Loop, 200), judge(StepKind::If, 1000)] {
            let mut steps = vec![ok(L1, 1)];
            steps.extend(rows);
            let mut t = tr(steps);
            t.truncated = true;
            let r = run(&base(), &panels(&[H]), &t);
            assert_eq!(r[0].verdict, Verdict::Fail);
            assert_eq!(r[0].reason.as_deref(), Some("판정 줄 상한 초과"));
        }
        // 상한 미만이면 그대로 시간 초과
        let mut steps = vec![ok(L1, 1)];
        steps.extend(judge(StepKind::Loop, 199));
        steps.extend(judge(StepKind::If, 999));
        let mut t = tr(steps);
        t.truncated = true;
        let r = run(&base(), &panels(&[H]), &t);
        assert_eq!(r[0].reason.as_deref(), Some("시간 초과(21초)"));
    }
```

(구현 중 실측 확정: `base()` 시나리오에서 `H` 패널이 규칙 5까지 내려오는지는 기존 `truncated_not_run_reason`과 같은 모양이라 그렇다고 본다. 다른 규칙이 먼저 잡으면 STOP·보고.)

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-controller monitor::`
Expected: 컴파일 에러 `cannot find value REASON_JUDGE_ROW_CAP`.

- [ ] **Step 3: 구현한다**

  1. `check.rs`에 상수 `REASON_JUDGE_ROW_CAP`.
  2. `check.rs`에 `truncated_reason`: 요청 줄(`StepKind::Http`) 수 ≥ `MONITOR_MAX_REQUESTS` → `REASON_REQUEST_CAP` / `handicap_engine::trace::judge_rows_exhausted(&trace.steps, MONITOR_MAX_REQUESTS)` → `REASON_JUDGE_ROW_CAP` / 그 외 `reason_timeout(timeout_secs)`. 문서 주석에 순서와 "가공 전 trace로 부른다(`build_record_body`가 `branch_eval`을 비우기 전)"를 적는다.
  3. `judge`의 잘림 가지를 `truncated_reason(trace, panel.timeout_seconds)` 한 번 호출로 바꾼다.
  4. `step_judge.rs` 규칙 5의 `if trace.truncated { … }` 안을 `truncated_reason(trace, flow_cap_secs)`로 바꾸고 `use` 목록에서 안 쓰게 된 이름(`MONITOR_MAX_REQUESTS`·`REASON_REQUEST_CAP`·`reason_timeout` 중 실제로 안 쓰이는 것만 — 컴파일러 경고로 확정)을 정리하고 `truncated_reason`을 더한다. 테스트 모듈의 `use`는 따로다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller`
Expected: 전부 PASS(기존 `truncated_request_cap_reason`·`truncated_time_reason`·`truncated_not_run_reason` 포함).

- [ ] **Step 5: 이빨** — `truncated_reason`의 둘째 가지를 지움 → `truncated_judge_row_cap_reason`·`truncated_not_run_judge_row_cap_reason` RED → 원복 → GREEN.

- [ ] **Step 6: 커밋** — `feat(controller): 모니터 잘림 사유에 판정 줄 상한 초과 (if-judge-row-cap)`

---

### Task 5: UI — 시험 실행 잘림 문구 + 사유 폭 후보

**Files:**
- Modify: `ui/src/i18n/ko.ts`(874행 `testRunFail` 근처), `ui/src/components/scenario/TestRunPanel.tsx:269`, `ui/src/monitor/reasons.ts`, `docs/dev/ui-area-c-manual-check.md:217`
- Test: `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`, `ui/src/monitor/__tests__/reasons.test.ts`

**Interfaces:**
- Produces: `ko.editor.testRunTruncated`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`TestRunPanel.test.tsx`의 `renders the truncated banner and a per-step summary`(58행 단언 다음 줄)에:

```ts
    // 원인 셋(요청 수·판정 줄 수·시간)을 적는다 — 글자 조각을 리터럴로(ko 참조는 자기 참조).
    expect(screen.getByText(/판정 줄 수/)).toBeInTheDocument();
    expect(screen.queryByText(/max_requests/)).not.toBeInTheDocument();
```

`reasons.test.ts` 첫 `it` 다음에:

```ts
  it("판정 줄 상한 사유가 크기 프로브 후보에 든다", () => {
    expect(WIDEST_REASON_CANDIDATES).toContain("판정 줄 상한 초과");
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd ui && pnpm test -- TestRunPanel.test reasons.test`
Expected: 두 새 단언 FAIL.

- [ ] **Step 3: 구현한다**

  1. `ko.ts` `editor`에 `testRunTruncated: "상한 도달 — 일부만 실행됨 (요청 수·판정 줄 수 또는 시간 상한)",`.
  2. `TestRunPanel.tsx:269`의 글자를 `{ko.editor.testRunTruncated}`로.
  3. `reasons.ts` 목록에 `"판정 줄 상한 초과",`(`"조건 반복 최대 횟수 도달"` 다음).
  4. `ui-area-c-manual-check.md:217`의 인용을 새 문구로.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 통과. `reasons.test.ts`의 "어떤 후보도 기존 최대 폭보다 길지 않다"도 그대로 PASS(`판정 줄 상한 초과` 10글자 ≤ 14).

- [ ] **Step 5: 커밋** — `feat(ui): 시험 실행 잘림 문구에 판정 줄 수·모니터 사유 폭 후보 추가 (if-judge-row-cap)`

---

## 구현 뒤 (task 밖 — orchestrator)

- 최종 리뷰: `handicap-reviewer`(초점: `trace_steps`↔`execute_steps` lockstep에서 이번 변경이 trace 전용인 이유, 무진행 끊기에 기대던 타 크레이트 소비자, 모니터 `build_record_body` 전후 순서). trace/body 뷰어·요청 실행 경로라 `/finish-slice` §0 grep과 무관하게 `security-reviewer`도 돌린다(이 슬라이스의 출처가 보안 리뷰 P1).
- 라이브 검증: spec §6 표(US1–US4) 그대로. 재현 스크립트는 spec §1의 YAML 2개. baseline 비교(US4)는 master `5cea1bac` 바이너리가 필요하다 — 메인 체크아웃 `target/debug/controller`가 그 커밋인지 `git -C`가 아니라 메인에서 직접 확인하고, 아니면 US4는 "이 브랜치에서 기존 테스트 전부 통과 + 혼합 시나리오 응답에 새 잘림 없음"으로 대신하고 그 사실을 build-log에 적는다.
- 기록(`/finish-slice`): build-log 한 단락, roadmap §B58 (0)·(2) 해당 항목 해소 표시 + 새 §B 블록(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1)에 spec §7 연기 5건과 §2.3 한계를 비용·해소 경로와 함께, 상태 줄 교체, 현황판 전진.
