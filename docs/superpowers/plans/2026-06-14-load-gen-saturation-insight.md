# A9 부하 생성기 포화 인사이트 (`load_gen_saturated`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop run이 요청한 도착률을 못 냈을 때(run-total `dropped > 0`) 리포트에 `load_gen_saturated` 인사이트 1종을 자동 표면화하고, 관측 최대 처리량과 다음 행동을 초보자 친화 한국어로 보여준다.

**Architecture:** 기존 A4c 인사이트 파이프라인(ADR-0028)에 인사이트 종류 1개를 가산한다. 백엔드 `derive_insights`에 `dropped: u64` 파라미터 1개를 추가해 `dropped > 0`이면 `windows`에서 계산한 peak per-second throughput을 천장값으로 담은 인사이트를 push하고, UI는 기존 `InsightPanel`의 `message()` 분기 + `ko.insightActions` 카탈로그(ADR-0035)에 한 항목씩 더해 렌더한다. proto·migration·engine·worker·UI Zod 스키마 **무변경**, `dropped == 0`이면 리포트 **byte-identical**.

**Tech Stack:** Rust(controller crate, `insights.rs`/`report.rs`) + TypeScript/React(`InsightPanel.tsx`/`ko.ts`, vitest).

**Spec:** `docs/superpowers/specs/2026-06-14-load-gen-saturation-insight-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/insights.rs` | 인사이트 도출(순수) | `derive_insights`에 `dropped: u64` 파라미터 + peak 계산 + `load_gen_saturated` push · `order_rank`에 rank 3 삽입+이하 +1 시프트 · 단위 테스트 | 
| `crates/controller/src/report.rs` | 리포트 빌드 | `derive_insights(...)` 호출부(`:557`)에 `run.dropped as u64` 인자 · 배선 테스트 2건 |
| `ui/src/i18n/ko.ts` | 한국어 문구 카탈로그(ADR-0035) | `insightActions.load_gen_saturated` 키 |
| `ui/src/components/report/InsightPanel.tsx` | 인사이트 렌더러 | `message()` switch에 `load_gen_saturated` case |
| `ui/src/components/report/__tests__/InsightPanel.test.tsx` | 렌더 테스트 | 신규 case 테스트 |

**커밋 경계 = 2 (CLAUDE.md 게이트에 맞춤):**
- **Task 1(Rust)** = 단일 green 커밋. pre-commit이 cargo-영향 커밋마다 전체 워크스페이스(`build`/`clippy`/`test --workspace`)를 돌리고 dead-code/RED-단독 커밋을 막으므로, 시그니처 변경+로직+호출부+모든 테스트를 **한 커밋으로 fold**한다(로컬에서 RED→GREEN 확인하되 커밋은 1회).
- **Task 2(UI)** = 단일 커밋. UI 게이트 `pnpm lint && pnpm test && pnpm build`.
- **Task 3** = 라이브 검증(커밋 없음) + 머지.

**TDD-guard 주의:** `insights.rs`·`report.rs`는 디스크에 이미 `#[cfg(test)] mod tests`가 있어 편집이 자동 통과(C-1 함정 비해당 — 새 src 파일/ lib.rs 편집 없음). UI는 `InsightPanel.test.tsx`(test-path)에 **테스트를 먼저** 추가하면 같은 워크트리의 `ko.ts`·`InsightPanel.tsx` 편집이 unblock된다.

---

## Task 1: 백엔드 — `load_gen_saturated` 인사이트 + 리포트 배선 (단일 green 커밋)

**Files:**
- Modify: `crates/controller/src/insights.rs`
- Modify: `crates/controller/src/report.rs:557` (호출부) + 테스트

> **TDD 메모:** `derive_insights` 시그니처에 인자를 더하면 기존 19개 테스트 호출부가 전부 arity 컴파일 에러를 낸다. 그래서 "한 테스트만 RED"가 불가능 — **컴파일 RED(새 동작 미구현·arity 불일치) → 전체 구현 → GREEN** 순으로 가고, 메모리/CLAUDE.md 관례대로 **커밋은 1회**.

- [ ] **Step 1: 신규 단위 테스트를 `insights.rs`의 `mod tests`에 추가 (아직 컴파일 안 됨)**

`insights.rs`의 `#[cfg(test)] mod tests` 안, 기존 `win(...)` 헬퍼 근처에 카운트 지정 윈도 헬퍼를 추가:

```rust
    fn win_count(ts: i64, step_id: &str, count: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: step_id.to_string(),
            count,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: 1,
            p99_ms: 1,
        }
    }
```

그리고 신규 테스트 3건 추가:

```rust
    #[test]
    fn load_gen_saturated_when_dropped() {
        // dropped>0 (open-loop 포화) -> value = peak per-second throughput,
        // count = dropped. peak = 초당 step count 합의 최대(평균 아님).
        let windows = vec![
            win_count(0, "a", 3),
            win_count(0, "b", 4), // ts0 합 = 7
            win_count(1, "a", 10), // ts1 합 = 10 (peak)
        ];
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "", 5);
        let s = got
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present");
        assert_eq!(s.severity, "warning");
        assert_eq!(s.value, Some(10.0)); // peak, not 7 not average
        assert_eq!(s.count, Some(5)); // dropped
    }

    #[test]
    fn no_saturation_when_dropped_zero() {
        let windows = vec![win_count(0, "a", 100)];
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "", 0);
        assert!(got.iter().all(|i| i.kind != "load_gen_saturated"));
    }

    #[test]
    fn saturation_falls_back_to_summary_rps() {
        // dropped>0 인데 windows가 비면 천장은 summary.rps(반올림)로 폴백.
        // summary() 헬퍼는 rps:0.0이라 0이 아닌 값을 명시해야 동어반복(==0) 회피.
        let mut s = summary();
        s.rps = 1234.6;
        let got = derive_insights(&s, &[], &[], &BTreeMap::new(), None, "", 3);
        let sat = got
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present");
        assert_eq!(sat.value, Some(1235.0)); // 1234.6.round()
        assert_eq!(sat.count, Some(3));
    }
```

- [ ] **Step 2: 기존 19개 `derive_insights(...)` 테스트 호출부에 `, 0` 추가 + 순서/주석 테스트 갱신**

`mod tests` 안의 기존 모든 `derive_insights(...)` 호출(19곳)에 마지막 인자 `0`을 더한다(비포화). 예:

```rust
// 변경 전: derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, "")
// 변경 후: derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, "", 0)
```

`insights_deterministic_order` 테스트는 **dropped를 7로** 주고 기대 순서에 `load_gen_saturated`를 5xx 다음에 삽입:

```rust
        let got = derive_insights(&s, &steps, &windows, &d, Some(&v), "", 7);
        let order: Vec<(&str, Option<&str>)> = got
            .iter()
            .map(|i| (i.kind.as_str(), i.status_class.as_deref()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("slo_failure", None),
                ("status_class", Some("5xx")),
                ("load_gen_saturated", None),
                ("error_hotspot", None),
                ("status_class", Some("4xx")),
                ("status_temporal", Some("5xx")),
                ("slowest_step", None),
            ]
        );
```

`all_pass_run_has_slowest_and_slo_pass` 테스트는 호출부에 `, 0`을 더하고 stale 주석을 정정:

```rust
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), Some(&v), "", 0);
        let kinds: Vec<&str> = got.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["slowest_step", "slo_pass"]); // order_rank 8 then 9
```

- [ ] **Step 3: 컴파일 RED 확인**

Run: `cargo test -p handicap-controller --no-run 2>&1 | tail -30`
Expected: FAIL — `derive_insights`가 아직 6-인자라 arity mismatch (`this function takes 6 arguments but 7/8 ... were supplied`). 이게 RED 게이트.

- [ ] **Step 4: `derive_insights` 시그니처에 `dropped: u64` 추가 + 포화 인사이트 push**

`insights.rs`의 함수 시그니처(현 `:62`)에 마지막 파라미터 추가:

```rust
pub fn derive_insights(
    summary: &ReportSummary,
    steps: &[ReportStep],
    windows: &[ReportWindow],
    status_distribution: &BTreeMap<String, u64>,
    verdict: Option<&Verdict>,
    scenario_yaml: &str,
    dropped: u64,
) -> Vec<Insight> {
```

함수 본문의 `out.sort_by_key(order_rank);` **바로 앞**에 포화 인사이트 블록 추가:

```rust
    // load_gen_saturated: open-loop run이 요청한 도착률을 못 냈다(슬롯 부족으로
    // 발사 못한 요청 = dropped). dropped는 open-loop 스케줄러만 증가시키므로
    // (closed-loop은 항상 0) `dropped > 0`이 자동으로 open-loop에 한정된다.
    // 관측 천장 = peak per-second throughput(초별 step count 합의 최대) — whole-run
    // summary.rps는 ramp에서 0부터 평균돼 천장을 과소평가하므로 안 씀. 원인(부하기
    // vs SUT)은 dropped만으로 단정 불가라 UI 행동 줄에서 사용자에게 위임(spec §2).
    if dropped > 0 {
        let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
        for w in windows {
            *by_sec.entry(w.ts_second).or_insert(0) += w.count;
        }
        let peak = by_sec
            .values()
            .copied()
            .max()
            .unwrap_or_else(|| summary.rps.round() as u64);
        let mut ins = Insight::new("load_gen_saturated", "warning");
        ins.value = Some(peak as f64);
        ins.count = Some(dropped);
        out.push(ins);
    }
```

- [ ] **Step 5: `order_rank`에 rank 3 삽입 + 이하 +1 시프트**

`order_rank`(현 `:48`)의 match를 교체:

```rust
fn order_rank(i: &Insight) -> u8 {
    match (i.kind.as_str(), i.status_class.as_deref()) {
        ("slo_failure", _) => 1,
        ("status_class", Some("5xx")) => 2,
        ("load_gen_saturated", _) => 3,
        ("no_request_step", _) => 4,
        ("error_hotspot", _) => 5,
        ("status_class", Some("4xx")) => 6,
        ("status_temporal", _) => 7,
        ("slowest_step", _) => 8,
        ("slo_pass", _) => 9,
        _ => 99,
    }
}
```

- [ ] **Step 6: `report.rs` 호출부에 `run.dropped as u64` 전달**

`report.rs`의 `derive_insights(...)` 호출(현 `:557`)에 마지막 인자를 추가(`RunRow.dropped`는 `i64`라 cast):

```rust
    let insights = crate::insights::derive_insights(
        &summary,
        &steps,
        &windows,
        &status_dist,
        verdict.as_ref(),
        scenario_yaml,
        run.dropped as u64,
    );
```

- [ ] **Step 7: `report.rs`에 배선 테스트 2건 추가**

`report.rs`의 `#[cfg(test)] mod tests`에 추가(`run_row()`/`win(...)`/`build_report(...)` 헬퍼 재사용 — build_report 시그니처는 8-인자 그대로):

```rust
    #[test]
    fn build_report_surfaces_saturation_insight() {
        // dropped>0 -> load_gen_saturated. value = peak per-second(=두 번째 초 9), count = dropped.
        let mut run = run_row();
        run.dropped = 7;
        let rows = vec![
            win(100, "s", 4, 0, r#"{"200":4}"#, &[10_000, 10_000, 10_000, 10_000]),
            win(101, "s", 9, 0, r#"{"200":9}"#, &[10_000; 9]),
        ];
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        let sat = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present when dropped>0");
        assert_eq!(sat.value, Some(9.0)); // 두 번째 초가 peak (4가 아니라 9)
        assert_eq!(sat.count, Some(7));
    }

    #[test]
    fn build_report_no_saturation_when_not_dropped() {
        let run = run_row(); // dropped: 0
        let rows = vec![win(100, "s", 5, 0, r#"{"200":5}"#, &[10_000; 5])];
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        assert!(rep.insights.iter().all(|i| i.kind != "load_gen_saturated"));
    }
```

- [ ] **Step 8: GREEN 확인 (controller 단위/통합 + clippy)**

Run: `cargo test -p handicap-controller 2>&1 | tail -30`
Expected: PASS (신규 5 테스트 포함 전부 통과).

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -15`
Expected: 경고 0.

- [ ] **Step 9: 워크스페이스 워밍 + 단일 foreground 커밋**

cold-build flake 예방 워밍(CLAUDE.md):

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
```

그 다음 **단일 foreground 커밋**(CLAUDE.md A4b: `run_in_background:false`, timeout 600000ms, 폴링 금지 — pre-commit이 전체 워크스페이스 게이트를 돈다, 파이프 금지):

```bash
git add crates/controller/src/insights.rs crates/controller/src/report.rs
git commit -m "feat(controller): A9 load_gen_saturated 포화 인사이트

open-loop run-total dropped>0이면 '목표 도착률 미달성' 인사이트 emit
(value=peak per-second throughput, count=dropped). derive_insights에 dropped
파라미터 1개 가산, order_rank rank 3 삽입(이하 +1 시프트, 상대순서 보존),
report.rs 호출부 run.dropped as u64. dropped==0이면 byte-identical.
proto/migration/engine/worker 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

커밋 직후 `git log -1 --oneline`로 landed 확인(파이프 마스킹 함정 회피).

---

## Task 2: UI — InsightPanel 렌더 + ko 행동 문구 (단일 커밋)

**Files:**
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx` (테스트 먼저 — TDD-guard unblock)
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/report/InsightPanel.tsx`

작업 디렉토리: `cd /Users/sgj/develop/handicap/.claude/worktrees/a9-saturation-insights/ui`

- [ ] **Step 1: 실패하는 RTL 테스트 추가**

`InsightPanel.test.tsx`의 `describe("InsightPanel", ...)` 안에 추가:

```tsx
  it("load_gen_saturated 헤드라인과 다음 행동을 렌더한다", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 7500, count: 320 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    // 헤드라인: 초당 최대 N건 + 못 보낸 요청 M건 (천단위 구분)
    expect(
      screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/),
    ).toBeInTheDocument();
    // 다음 행동 줄
    expect(
      screen.getByText(/대상 서버의 한계, 아니면 테스트 도구/),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: RED 확인**

Run: `pnpm test InsightPanel`
Expected: FAIL — 헤드라인/행동 텍스트 미존재(`message()` default가 `i.kind`="load_gen_saturated"를 그대로 렌더, 행동 줄 없음).

- [ ] **Step 3: `ko.ts`에 행동 문구 추가**

`ko.ts`의 `insightActions` 객체(현 `:309`)에 키 추가:

```ts
    load_gen_saturated:
      "에러·지연(latency)이 함께 높으면 대상 서버의 한계, 아니면 테스트 도구(워커 CPU·동시 실행 수 max_in_flight)를 늘려 다시 실행하세요.",
```

- [ ] **Step 4: `InsightPanel.tsx`의 `message()`에 case 추가**

`InsightPanel.tsx`의 `message()` switch(현 `:25`), `default:` 앞에 추가(기존 메시지처럼 마침표 없음):

```ts
    case "load_gen_saturated":
      return `목표한 부하를 다 걸지 못했어요 — 초당 최대 ${n(i.value)}건까지만 보냈고, 보내려다 못 보낸 요청이 ${n(i.count)}건 있어요`;
```

- [ ] **Step 5: GREEN 확인**

Run: `pnpm test InsightPanel`
Expected: PASS (신규 + 기존 테스트 전부).

- [ ] **Step 6: 전체 UI 게이트**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: lint 경고 0, 전체 vitest PASS, `tsc -b && vite build` 성공. (단일 파일 green ≠ 전체 green — 머지 전 인자 없는 전체 1회, CLAUDE.md.)

- [ ] **Step 7: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(ui): load_gen_saturated 인사이트 렌더(헤드라인+다음 행동)

InsightPanel message() case + ko.insightActions 항목(ADR-0035). 초보자
친화 평이한 한국어 — '테스트 도구'/'대상 서버', latency/max_in_flight
인라인 병기. UI Zod 스키마 무변경(kind=z.string).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

커밋 직후 `git log -1 --oneline`로 landed 확인. (UI 커밋은 pre-commit이 UI 게이트 자동 실행 — `ui/node_modules` 있으면.)

---

## Task 3: 라이브 검증 + 머지 (커밋 없음)

**목적:** RTL/`tsc -b`가 못 잡는 실제 `/report` 응답 파싱·실브라우저 렌더를 머지 전에 1회 확인(S-D 갭 차단). spec §7.4.

- [ ] **Step 1: 격리 스택 기동**

워크트리 root에서(상대경로 바이너리 — 메인 stale 회피, CLAUDE.md):

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
# 200-responder
python3 -c "import http.server,socketserver; \
h=http.server.BaseHTTPRequestHandler; \
exec('class H(h):\n def do_GET(s):\n  s.send_response(200); s.end_headers(); s.wfile.write(b\"ok\")\n def log_message(*a): pass'); \
socketserver.ThreadingTCPServer(('127.0.0.1',9099),H).serve_forever()" &
just ui-build  # 또는 cd ui && pnpm build (dist 최신화)
./target/debug/controller --db /tmp/a9-sat.db --ui-dir ui/dist &
```

- [ ] **Step 2: 포화 유발 open-loop run (작은 `max_in_flight`로 dropped 강제)**

시나리오 1개 생성(url = `http://127.0.0.1:9099/`) 후, 일부러 좁은 슬롯풀 + 높은 target으로 open-loop run:

```bash
# 시나리오 생성(루트 CLAUDE.md jq -Rs 패턴) → scenario_id 확보
# run: open-loop 곡선. 스테이지 키는 duration_seconds(엔진 Stage 필드명),
#   profile.duration_seconds는 곡선 모드 필수=0(>0이면 stages와 상호배타 400, ui/CLAUDE.md).
#   max_in_flight=2 + target 4000 = 슬롯 부족 → dropped>0 보장.
curl -sX POST http://127.0.0.1:8080/api/runs \
  -H 'content-type: application/json' \
  -d '{"scenario_id":"<ID>","profile":{"duration_seconds":0,"max_in_flight":2,"stages":[{"target":50,"duration_seconds":5},{"target":4000,"duration_seconds":10}],"vus":0},"env":{}}'
```

- [ ] **Step 3: `/report` JSON에서 인사이트 확인**

run terminal 후 `GET /api/runs/{id}/report`(curl→python 직결, CLAUDE.md 셸 함정):

```bash
curl -s http://127.0.0.1:8080/api/runs/<RUN_ID>/report | python3 -c "import sys,json; r=json.load(sys.stdin); \
print('dropped=', r['dropped']); \
print([i for i in r['insights'] if i['kind']=='load_gen_saturated'])"
```
Expected: `dropped` > 0, 그리고 `load_gen_saturated` 인사이트 1건(`value`≈관측 천장 RPS, `count`==dropped, `severity`=="warning").

- [ ] **Step 4: 실브라우저 InsightPanel + closed-loop 대조**

- 브라우저로 리포트 페이지 열어 핵심 인사이트에 평이한 한국어 두 줄(헤드라인 + "→ 다음 행동")이 앰버 카드로 뜨는지 + 콘솔 Zod 에러 0 확인(Playwright `browser_console_messages`).
- 같은 시나리오를 **closed-loop**(`{"vus":5,"duration_seconds":5}`)로 1회 돌려 `load_gen_saturated`가 **부재**(byte-identical 경로)인지 확인.
- 정리: `kill` 백그라운드 프로세스, `rm -rf .playwright-mcp` + 루트 png(있으면).

- [ ] **Step 5: 머지 준비**

- `handicap-reviewer`(최종 whole-feature 리뷰)로 와이어/일관성 재확인.
- master ff-merge(CLAUDE.md 토폴로지: 워크트리에서 `git -C /Users/sgj/develop/handicap merge --ff-only worktree-a9-saturation-insights`, 사전 ancestor/clean 확인) → 확인 후 `ExitWorktree(remove, discard_changes:true)`.
- roadmap §A9를 "완료"로, build-log 한 단락 append, 루트 CLAUDE.md 상태 줄 갱신, MEMORY.md 인덱스 항목.

---

## Self-Review (작성자 체크)

- **Spec 커버리지:** §3.1 트리거(`dropped>0`)=T1 Step4 · §3.2 peak/폴백=T1 Step4 + 테스트 3건 · §3.4 order_rank 시프트=T1 Step5 + deterministic_order=T1 Step2 · §4 UI 문구 2종=T2 · §5 파일 4개 전부 매핑 · §6 byte-identical(dropped==0 미emit)=`no_saturation_*`/`build_report_no_saturation_*` · §7 테스트 전부 태스크화 · §7.4 라이브=T3. 갭 없음.
- **Placeholder:** 모든 코드 스텝에 실제 코드 존재. `<ID>`/`<RUN_ID>`는 런타임 산출 값(라이브 절차의 정상 변수).
- **타입 일관성:** `dropped: u64`(파라미터) ↔ `run.dropped as u64`(`RunRow.dropped: i64` cast) ↔ `Insight.count: Some(dropped)`(u64) 일관. `value: Some(peak as f64)`(`Insight.value: Option<f64>`) 일관. UI `n(i.value)`/`n(i.count)`는 기존 헬퍼. ko 키 `load_gen_saturated` ↔ `message()` case ↔ `ACTIONS[i.kind]` 일치.
