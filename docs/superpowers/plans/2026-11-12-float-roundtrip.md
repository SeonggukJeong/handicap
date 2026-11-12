# 소수 정확히 읽기 (`float_roundtrip`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워크스페이스 `serde_json`에 `float_roundtrip`을 켜서 모니터 판정·엔진 추출·캐스트가 응답 소수를 정확히 읽게 하고, 회귀 테스트·문서·속도 측정으로 지킨다.

**Architecture:** production 변경은 `Cargo.toml` 두 줄(루트·데스크톱). 나머지는 켜기 전 RED인 회귀 테스트(컨트롤러·엔진·TUI), 옛 동작을 적은 문서 정리, release 워커 A/B 속도 비교.

**Tech Stack:** Rust(serde_json 1.0.150, cargo nextest), 기존 테스트 헬퍼.

**Spec:** `docs/superpowers/specs/2026-11-12-float-roundtrip-design.md`

## Global Constraints

- 값 묶음(spec §3): `972.0979928970337`·`1.5e-300`·`4.5e250`. 서버 표기(`extract::stringify`) 기대 글자: `972.0979928970337`·`1.5e-300`·`4.5e+250`.
- `Cargo.lock`·`desktop/src-tauri/Cargo.lock` 내용 변화 0 — 다르면 STOP.
- 새 의존 금지(성질 테스트는 손 xorshift, 측정 crate는 스크래치패드·커밋 안 함).
- 기존 테스트가 깨지면 기대값을 맞추지 말고 "정확해진 결과인가" 판정·기록(spec §4) — 아니면 STOP.
- 서버 숫자 표기 규칙·`pick.rs` 코드·UI 코드 변경 금지(spec §1 끝·§2-3·§6).

## Review Focus

1. **`≤` 단언이 RED인 척** — 옛 오독은 실제보다 작아 `≤`는 지금도 통과한다. Task 1 테스트에 주석으로 "RED 아님"을 남기고 RED 담당에서 뺀다.
2. **성질 테스트에 NaN·무한대가 섞임** — `serde_json`은 `null`로 쓴다. 비트 패턴에서 만든 `f64`는 `is_finite()`만 쓴다(Task 1 Step 1).
3. **켜기 전 RED를 커밋으로 남기려는 시도** — 게이트가 막는다. RED 실증은 작업 트리에서, 커밋은 플래그·테스트·표 이동 한 번에(Task 1).
4. **속도 측정이 응답기 한계를 잰다** — 워커 CPU가 한계인지 확인 없이 RPS를 비교하면 공허한 통과(Task 3 Step 4).
5. **옛 워커 바이너리로 run** — 플래그를 바꾼 뒤 run 기반 확인 전에 워커를 다시 빌드(Task 3·라이브).

---

### Task 1: 플래그 켜기 + 회귀 테스트 (한 커밋)

**Files:**
- Modify: `Cargo.toml:40`
- Modify: `desktop/src-tauri/Cargo.toml:30`
- Modify (tests): `crates/controller/src/monitor/check.rs` (기존 `#[cfg(test)] mod tests`, 성공 조건 절 — `fn t_body` 아래)
- Modify (tests): `crates/engine/src/extract.rs` (기존 tests 모듈, `fn body_facts` 사용)
- Modify (tests): `crates/engine/src/cast.rs` (기존 tests 모듈)
- Create: `crates/engine/tests/float_roundtrip.rs`
- Modify: `crates/tui/tests/pick_test.rs:1028-1084` (`EXACT`·`MISREAD`·두 테스트)

**Interfaces:**
- Consumes: `check.rs` 테스트 헬퍼 `cond(step, Src, path, Op, value)`·`judge_c(&Scenario, Vec<Condition>, &ScenarioTrace)`·`t_body(body)`·`one_step()`·상수 `A`; `extract.rs` 테스트의 `body_facts(body)`·`evaluate(&xs, &facts)`·`Extract::Body { decode: None, claim: None, var, path }`; `cast.rs`의 `coerce_num(&str) -> Option<serde_json::Value>`.
- Produces: 없음(테스트만).

- [ ] **Step 1: 회귀 테스트 작성(플래그는 아직 끔)**

`check.rs` — `fn cond_float_exact_read()`:
```rust
// 값 묶음마다 (본문 글자, 서버 표기) — `shown`은 check.rs의 fn 이름이라 `want`
for (lit, want) in [("972.0979928970337","972.0979928970337"),("1.5e-300","1.5e-300"),("4.5e250","4.5e+250")] {
    let body = format!(r#"{{"v":{lit}}}"#);
    let t = t_body(&body);
    let ok = |op, val: &str| judge_c(&one_step(), vec![cond(A, Src::Body, "$.v", op, val)], &t);
    assert_eq!(ok(Op::Eq, lit).verdict, Verdict::Ok, "= {lit}");
    assert_eq!(ok(Op::OneOf, &format!("1, {lit}")).verdict, Verdict::Ok, "∈ {lit}");
    assert_eq!(ok(Op::Gte, lit).verdict, Verdict::Ok, "≥ {lit}");
    // ≤는 RED가 아니다: 옛 오독은 실제보다 작아 지금도 통과 — 함께 단언만
    assert_eq!(ok(Op::Lte, lit).verdict, Verdict::Ok, "≤ {lit}");
    let ne = ok(Op::Ne, lit);
    assert_eq!(ne.verdict, Verdict::Fail, "≠ {lit}");
    assert_eq!(ne.reason.as_deref(), Some(want), "≠ 사유 {lit}");
}
```
`extract.rs` — `fn body_float_extract_exact()`: 같은 세 값에서 `$.v` 추출 결과가 `want` 글자, 그리고 `out["v"].parse::<f64>() == lit.parse::<f64>()`.

`cast.rs` — `fn coerce_num_float_exact()`: 같은 세 `lit`에서 `coerce_num(lit).unwrap().as_f64() == Some(lit.parse::<f64>().unwrap())`.

`crates/engine/tests/float_roundtrip.rs` — `fn serde_json_reads_its_own_floats_exactly()`: xorshift64(시드 상수 `0x9E37_79B9_7F4A_7C15`)로 비트 20,000개 → `f64::from_bits`, `is_finite()`만. 각 `v`: `let s = serde_json::to_string(&v).unwrap();` → `serde_json::from_str::<f64>(&s).unwrap() == s.parse::<f64>().unwrap()`. 실패 첫 값의 `s`를 메시지에. 머리 주석: 이 테스트가 깨지면 `float_roundtrip`이 꺼진 것(spec §3).

`pick_test.rs`: `MISREAD`를 지우고 그 세 행을 `EXACT`에 GUI 글자로 — `("1.5e-300","1.5e-300")`·`("9.720979928970337e2","972.0979928970337")`·`("4.5e250","4.5e+250")`. `12345678901234567890` 행은 계속 마지막(문서 주석 "마지막 행만 뜻대로 다르다"가 참으로). `.chain(MISREAD)` 두 곳 제거. `number_text_reads_back_as_server_value` 주석에서 `float_roundtrip` 꺼짐 전제 문구를 "켜져 있어 서버 값 = 정확한 값"으로.

- [ ] **Step 2: 켜기 전 RED 확인**

Run(전부 `--no-fail-fast`): `cargo nextest run --no-fail-fast -p handicap-controller -E 'test(cond_float_exact_read)'` · `cargo nextest run --no-fail-fast -p handicap-engine -E 'test(body_float_extract_exact) | test(coerce_num_float_exact) | test(serde_json_reads_its_own_floats_exactly)'` · `cargo nextest run --no-fail-fast -p handicap-tui -E 'test(number_text_tables) | test(number_text_reads_back_as_server_value)'`
Expected: 6개 전부 FAIL. 하나라도 PASS면 STOP(그 테스트가 공허 — spec §3). 각 실패 메시지 첫 줄을 기록.

- [ ] **Step 3: 플래그 켜기**

루트 `Cargo.toml:40` → `serde_json = { version = "1", features = ["float_roundtrip"] }`. `desktop/src-tauri/Cargo.toml:30` → 같은 줄.

- [ ] **Step 4: GREEN + 부수 확인**

Run: Step 2의 세 명령 → 6개 PASS.
Run: `cargo tree -e features -i serde_json --workspace | grep float_roundtrip` → 1줄 이상. `cargo tree --locked --manifest-path desktop/src-tauri/Cargo.toml -e features -i serde_json | grep float_roundtrip` → 1줄 이상.
Run: `git diff --stat -- Cargo.lock desktop/src-tauri/Cargo.lock` → 빈 출력(아니면 STOP).
Run: `cargo nextest run --workspace --no-fail-fast` · `cargo test --workspace --doc` · `TZ=UTC cargo test -p handicap-tui` → 전부 통과. 깨진 기존 테스트는 Global Constraints대로 판정·보고.

- [ ] **Step 5: Commit (foreground, 600000ms)**

```bash
git add Cargo.toml desktop/src-tauri/Cargo.toml crates/controller/src/monitor/check.rs crates/engine/src/extract.rs crates/engine/src/cast.rs crates/engine/tests/float_roundtrip.rs crates/tui/tests/pick_test.rs
git diff --cached --name-only
git commit -F <메시지 파일>   # "fix: serde_json float_roundtrip — 응답 소수를 정확히 읽는다 (§B53 (3))"
git log -1 --oneline
```

---

### Task 2: 문서 정리

**Files:**
- Modify: `crates/tui/CLAUDE.md:38`
- Modify: `crates/engine/CLAUDE.md`, `crates/controller/CLAUDE.md` (한 줄씩 추가)
- Modify: `docs/superpowers/specs/2026-11-11-tui-2b-polish-design.md` (해소 표시)
- Modify: `docs/roadmap.md` §B53 (1) 첫 판단·(3) — 풀 워커 노트(spec §2-4)는 새 릴리즈 노트 파일 대신 (3) 해소 표시 안에 "다음 릴리즈 노트에 넣을 줄"로.

- [ ] **Step 1: 함정 줄 뒤집기** — `crates/tui/CLAUDE.md:38`을: "`serde_json`은 워크스페이스에서 `float_roundtrip`을 켠다 — 끄면 일부 소수(`1.5e-300`·`972.0979928970337`·`4.5e250`)를 1 ULP 다르게 읽어 모니터 판정·추출·캐스트가 어긋나고 TUI·GUI 조건 글자가 갈린다(회귀 테스트 `serde_json_reads_its_own_floats_exactly` 등이 RED로 알린다) (tui-2b-polish → float-roundtrip)". 엔진·컨트롤러 CLAUDE.md의 함정 목록 끝에 같은 뜻 한 줄(각 도메인의 테스트 이름 — 엔진 `body_float_extract_exact`·`coerce_num_float_exact`, 컨트롤러 `cond_float_exact_read`).
- [ ] **Step 2: 2b spec 해소 표시** — `grep -n 'float_roundtrip\|972\.0979928970336\|한 끝자리\|MISREAD\|다르게 읽\|§2\.1-4' docs/superpowers/specs/2026-11-11-tui-2b-polish-design.md`의 각 줄(또는 그 줄이 속한 항목) 끝에 `(2026-11-12 float-roundtrip으로 해소 — 이제 정확히 읽는다)`. 본문은 지우지 않는다.
- [ ] **Step 3: roadmap §B53** — (1) 첫 판단 머리에 `✅ 해소(float-roundtrip, 2026-11-12)`, (3) 첫 항목에 같은 표시 + 풀 워커 노트 한 줄(spec §2-4 문구). (1) 첫 판단의 옛 해소 문구 "표와 spec §2.1-4 삭제"(`grep -n '표와 spec §2.1-4 삭제' docs/roadmap.md`)는 취소선 + "→ 표는 `EXACT`로 옮김, 2b spec은 지우지 않고 해소 표시(float-roundtrip spec §2-4)".
- [ ] **Step 4: 확인** — `grep -rn 'MISREAD' crates docs/superpowers/specs/2026-11-12-float-roundtrip-design.md crates/*/CLAUDE.md` → `crates`에 0줄. `just doc-budget` → FAIL 아님.
- [ ] **Step 5: Commit** — staged = 위 문서만, docs-only fast-path.

---

### Task 3: 속도 확인 (orchestrator 직접 — spec §5)

**Files:** 스크래치패드만(커밋 없음). 결과 표는 finish-slice 때 build-log 단락에.

- [ ] **Step 1: (a) 파싱 측정** — 스크래치패드에 버리는 crate 2개(`serde_json = "=1.0.150"`, 하나는 `features = ["float_roundtrip"]`), 같은 본문(무작위 유한 `f64` 1,000개 배열, serde_json 출력 ≈ 20KB, 고정 시드)을 `from_slice::<Value>` 10,000회, `--release`. 1회당 µs 두 값과 차이를 기록.
- [ ] **Step 2: 워커 두 벌** — 워크트리에서 `cargo build --release -p handicap-worker` → `target/release/worker`를 스크래치패드 `worker-on`으로 복사. 작업 트리에서만 루트 `Cargo.toml:40`을 `serde_json = "1"`로 되돌리고 다시 빌드 → `worker-off`로 복사 → `git checkout -- Cargo.toml` 대신 Edit로 원복하고 `git diff --stat` 빈 출력 확인. 두 파일 `shasum`이 달라야 한다. 각 바이너리에 감싸개 스크립트 `run-worker-on.sh`·`run-worker-off.sh`(스크래치패드, `#!/bin/sh` + `exec /usr/bin/time -l <스크래치>/worker-on "$@"`, 실행 권한) — 컨트롤러는 run마다 워커를 새로 띄우고 run이 끝나면 워커가 스스로 끝나므로(`crates/controller/src/dispatcher/subprocess.rs:55-60`·:103) 워커 CPU 시간은 종료 시 `time -l`이 stderr(컨트롤러 stderr로 상속, :57-58)에 찍는 user+sys로 잰다. `--worker-bin`에는 이 스크립트를 준다.
- [ ] **Step 3: 응답기·시나리오** — 스크래치패드 버리는 axum 응답기(멀티스레드, 본문 `{"v":[…]}` = Step 1과 같은 생성기·시드의 유한 `f64` 1,000개, 시작 시 1회 생성, 지연 0 — (a)×(b) 상한 계산이 같은 본문 위에서 성립하게). `.claude/skills/live-verify/responder.py`는 단일 프로세스라 먼저 한계가 되기 쉽다. 시나리오: GET 1스텝 + `extract: [{var: x, from: body, path: "$.v[0]"}]`(태그는 `from` — `crates/engine/src/scenario.rs:395`, 예 :713-716; 그 밖 YAML 형식은 `docs/dev/live-verify-backend.md` — `version: 1`·ULID step id).
- [ ] **Step 4: 포화 찾기** — 먼저 `cargo build -p handicap-controller --bin controller`(플래그 켠 상태). 컨트롤러 `./target/debug/controller --db <스크래치>/perf.db --rest 127.0.0.1:8099 --grpc 127.0.0.1:8098 --worker-bin <스크래치>/run-worker-off.sh 2> <스크래치>/ctl-off.log`(포트 선점 확인 먼저). closed-loop VU 8→16→32→64, 각 15초. RPS가 더 안 오르는 VU를 고른다. 워커·응답기가 같은 기계의 코어를 나눠 쓰므로 "워커 CPU = 코어 한계"는 성립하지 않는다 — 포화 정의: 기계 CPU 유휴 ≈ 0(`top -l 2 -n 0`의 idle), 워커(`pgrep -x worker-off` — 프로세스 이름 정확 일치. `-f`는 컨트롤러의 `--worker-bin …` 명령줄까지 잡는다)가 가장 큰 CPU 사용자, 응답기 스레드를 늘려도 RPS가 안 오름(응답기 한계 아님). 응답기가 한계면 STOP → 사용자에게 보고.
- [ ] **Step 5: A/B 교차** — 그 VU, 30초, `off/on/off/on/off/on`(바이너리마다 컨트롤러 재시작, `--worker-bin`은 그 차례의 `run-worker-off.sh`/`run-worker-on.sh`, stderr는 run마다 따로 `<스크래치>/ctl-off-1.log`…`ctl-on-3.log` — 같은 파일에 `2>`하면 앞 run의 `time -l` 줄이 지워진다). 각 run의 `summary.rps`·`p50_ms`·`count` 기록 + **요청당 워커 CPU 시간**(그 run의 컨트롤러 로그에 `time -l`이 찍은 user+sys 초 ÷ `count`) — 기계 전체 경합에 덜 흔들리는 파싱 비용의 직접 측정.
- [ ] **Step 6: 판정** — `on` 평균 RPS ≥ `off` 최솟값이면 통과(요청당 CPU 시간 차이는 판정이 아니라 기록 — (a) 1회당 차이와 대조). 실패면 STOP → 수치(최악 조건임을 함께)와 함께 사용자에게. 결과 표를 스크래치패드 `perf-result.md`에.
- [ ] **Step 7: 정리** — 띄운 컨트롤러·응답기만 `pkill -f`로 종료(내 명령줄 패턴).

---

### 라이브 검증 (finish 전, spec §7)

`cargo build -p handicap-worker` 후 `/live-verify` — US1(GUI 모니터 세 값 + 표시 항목 + `≠` 사유)·US2(TUI tmux 같은 세 값 → 보드 파일 `value` 대조)·US3(에디터 test-run `{{v:num}}` + 로깅 echo 와이어). 결과는 build-log에 "증명된 US / 못 한 US".

REVIEW-GATE: APPROVED
