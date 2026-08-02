# store→proto 매핑 회귀 가드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `store::Profile → pb::Profile`(컨트롤러)와 `pb::Profile → RunPlan`(워커) 두 매핑을 인라인 struct 리터럴에서 순수함수로 추출하고, 필드 전치·placeholder를 잡는 표 테스트로 잠근다.

**Architecture:** 두 홉의 리터럴을 **표현식 그대로** 순수함수(`to_proto_profile` / `to_run_plan`)로 옮기고 호출부를 한 줄로 대체한다. 프로덕션 거동 0-diff. 테스트의 핵심은 개수가 아니라 3중 컴파일-강제 장치(exhaustive 입력 픽스처 / exhaustive 기대 리터럴 / `..` 없는 전 필드 구조분해)와, 필드마다 서로 다른 sentinel 값으로 같은-타입 이웃 전치를 RED로 만드는 것이다.

**Tech Stack:** Rust (edition 2024, MSRV 1.85), prost 생성 타입(`handicap_proto::v1`), `handicap_engine::RunPlan`, `cargo nextest`.

**Spec:** `docs/superpowers/specs/2026-08-02-store-proto-mapping-design.md`

## Global Constraints

- **프로덕션 거동 0-diff.** 두 추출 모두 표현식 이동뿐 — 새 분기·새 값·새 호출 금지. UI 0-diff · migration 0 · `.proto` 0-diff.
- **`..Default::default()` 금지** — 테스트 입력 픽스처(`store::Profile` 20필드 / `pb::Profile` 15필드)와 컨트롤러 기대값(`pb::Profile`)은 전 필드를 명시한다. 이게 미래 필드 추가를 컴파일 에러로 바꾸는 장치다. 픽스처 위에 금지 주석 필수.
- **sentinel 값 유일성** — 어떤 두 수치 필드도 같은 값을 갖지 않는다. **파생값 `RunPlan.duration`(= `vu_stages`의 duration 합 = 332)도 유일성 검사에 포함**하며, 자기 구성요소(155·177)와 충돌하지 않도록 `vu_stages`는 반드시 **원소 2개**다(1개면 합 = 그 원소라 정의상 충돌).
- **bool 판별은 C1+C3 조합** — bool은 두 값뿐이라 한 케이스로 3개(`measure_phases`·`apply_scenario_think_time`·`ramp_down_immediate`)를 구분할 수 없다. C1 = `(mp=true, ast=false, rdi=false)`, C3 = `rdi=true`.
- **커밋 규율(레포)**: 이 plan의 커밋 스텝은 implementer가 실행한다 → **단일 FOREGROUND 호출(timeout 600000ms)**. background+폴링/Monitor 대기 **금지**(truncate·미완주 사고 이력 — 루트 `CLAUDE.md` "implementer의 commit·검증은 단일 FOREGROUND 호출"). `run_in_background`는 *orchestrator 자신의* 커밋에만 해당한다. **`git commit … | tail`/`| head` 파이프 금지**(종료코드 마스킹, git-guard가 deny). `--no-verify` 금지. `git add` 후 `git diff --cached --name-only`로 staged 확인.
- **tdd-guard 실행 가능성(검증함)**: 훅(`.claude/hooks/tdd-guard.sh`)은 ① 편집 대상 `.rs`가 디스크에 `#[cfg(test)]`를 갖거나 ② **편집 내용 자체가 `#[cfg(test)]`를 도입**하면 통과시킨다(`:63-77`, "the write IS the test"). 따라서 인라인 테스트를 담은 새 `.rs` Write는 통과한다. **그러나 `#[cfg(test)]`가 없는 src 편집(예: `grpc/mod.rs`에 `pub mod profile;` 한 줄)은 차단된다** — pending 스캔이 **test-path 파일만**(`/tests/*.rs`·`_test.rs`·`*.test.tsx`…) 인정하기 때문. 이 경우에만 keepalive가 필요하다(Task 1 Step 0). 문서화된 함정 C-1(`docs/dev/commit-gates-and-git-workflow.md`).

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/grpc/profile.rs` | `store::Profile → pb::Profile` 순수 매핑 + 그 단위 테스트 | **신규** |
| `crates/controller/src/grpc/mod.rs` | 모듈 등록 | `pub mod profile;` 1줄 |
| `crates/controller/src/api/runs.rs` | `spawn_run`에서 리터럴 제거 → 호출 1줄 | 741–781 대체 |
| `crates/worker/src/lib.rs` | `to_run_plan` 추출 + 스테일 주석 삭제 + 그 단위 테스트 | 227–301 대체, 헬퍼 뒤 함수 추가 |
| `crates/controller/CLAUDE.md` | 매핑 함정 항목을 현황으로 갱신 | 1항목 |
| `docs/build-log.md` | "~17필드" 정정 | 1줄 |

**`to_run_plan` 배치 제약(load-bearing):** 반드시 **`pub async fn run(` (`lib.rs:490`) 이후**, 기존 헬퍼(`proto_connect_timeout`, `lib.rs:636`) 옆에 둔다. `execute_assignment`(127) 와 `pub async fn run(`(490) **사이에 두면 Task 2의 결선 게이트 awk 리전에 들어가 거짓 실패**한다.

---

### Task 1: 컨트롤러 `to_proto_profile` 추출 + 표 테스트

**Files:**
- Create: `crates/controller/src/grpc/profile.rs`
- Modify: `crates/controller/src/grpc/mod.rs`
- Modify: `crates/controller/src/api/runs.rs:741-781`

**Interfaces:**
- Produces: `pub(crate) fn to_proto_profile(p: &crate::store::runs::Profile) -> handicap_proto::v1::Profile` — Task 3의 R1·R2·R3a·R4·R7이 이 함수에 회귀를 심는다.
- Consumes: 없음.

- [ ] **Step 0: tdd-guard keepalive를 만든다 (Step 2가 차단되는 것을 막는다)**

Step 1의 `profile.rs` Write는 내용에 `#[cfg(test)]`가 있어 훅을 통과하지만, **Step 2의 `grpc/mod.rs` 편집은 차단된다**(그 파일엔 `#[cfg(test)]`가 없고 pending 스캔은 test-path 파일만 센다). 실측 확인된 차단이다.

```bash
cat > crates/controller/tests/_tdd_keepalive.rs <<'EOF'
// tdd-guard keepalive — 이 task의 src 편집을 언블록하기 위한 임시 파일.
// Step 10 커밋 **전에** 반드시 삭제한다.
#[test]
fn keepalive() {}
EOF
```

- [ ] **Step 1: 테스트만 담은 새 모듈을 만든다 (아직 프로덕션 함수 없음)**

`crates/controller/src/grpc/profile.rs` 를 아래 내용으로 생성:

```rust
//! `store::Profile` → `pb::Profile` 와이어 매핑. `spawn_run`에서 추출한 순수
//! 함수라 15필드를 단위 테스트로 잠글 수 있다(추출 전엔 0건이었다).

use crate::store::runs::Profile;
use handicap_proto::v1 as pb;

#[cfg(test)]
mod tests {
    // 테스트는 부모 모듈의 임포트(`Profile`·`pb`)를 glob으로 받는다.
    use super::*;

    /// C1 sentinel 픽스처 — **필드마다 서로 다른 값**.
    ///
    /// ⚠ `..Default::default()`를 절대 추가하지 말 것. 20필드를 전부 명시하는
    /// 것이 이 픽스처의 목적이다: `store::Profile`에 필드가 추가되면 여기서
    /// 컴파일 에러가 나서 "이 값이 와이어로 가야 하는가"를 판단하게 만든다.
    /// (`store::Profile`은 `Default`를 파생하지 않으므로 그 탈출구는 타입
    /// 레벨에서 이미 닫혀 있다 — 유지할 것.)
    ///
    /// bool 3종은 C1에서 `(measure_phases=true, apply_scenario_think_time=false,
    /// ramp_down→false)`, C3에서 `ramp_down→true`로 갈려 임의의 bool 전치가
    /// 최소 한 케이스에서 RED가 된다.
    ///
    /// ⚠ `target_rps` + `stages` + `vu_stages`를 **동시에** 채운 것은
    /// **의도**다. 실제 run에선 `validate_run_config`가 거부하는 조합이지만,
    /// 순수 매핑 함수는 검증을 하지 않고, 세 필드를 모두 채워야 같은-타입
    /// 이웃 전치(`stages`↔`vu_stages` 등) 판별력이 최대가 된다.
    /// "잘못된 픽스처"로 보고 고치지 말 것.
    fn c1_profile() -> Profile {
        Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: Some(handicap_engine::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: Some(vec![handicap_engine::Stage {
                target: 122,
                duration_seconds: 133,
            }]),
            measure_phases: true,
            // 원소 2개 필수: 1개면 워커측 파생 duration(합)이 그 원소와 같아져
            // sentinel 유일성이 깨진다. 합 = 155 + 177 = 332.
            vu_stages: Some(vec![
                handicap_engine::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                handicap_engine::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ]),
            ramp_down: Some(handicap_engine::RampDown::Graceful),
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
            worker_count: Some(211),
            apply_scenario_think_time: false,
        }
    }

    /// C1: 전 필드 sentinel. 통째 `assert_eq!`가 같은-타입 이웃 전치
    /// (`target_rps`↔`max_in_flight`, u32 5종, `stages`↔`vu_stages`,
    /// 중첩 struct 내부)를 전부 RED로 만든다 — 오늘 이걸 잡는 방어가 없다.
    ///
    /// ⚠ 기대 리터럴에도 `..Default::default()` 금지(prost가 `Default`를
    /// 파생하므로 문법상 가능하지만, 붙이면 proto 필드 추가 시 컴파일 강제가
    /// 사라진다).
    #[test]
    fn c1_all_fields_map_to_distinct_sentinels() {
        let expected = pb::Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            think_time: Some(pb::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: vec![pb::Stage {
                target: 122,
                duration_seconds: 133,
            }],
            measure_phases: true,
            vu_stages: vec![
                pb::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                pb::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
        };
        assert_eq!(to_proto_profile(&c1_profile()), expected);
    }

    /// 통째 비교는 실패 시 구조체 전문을 뱉어 "어느 필드"를 지목하지 못한다.
    /// US1이 약속한 관찰(실패 메시지가 필드를 지목)을 위해 필드별 단언을
    /// 병행한다 — exhaustive 리터럴(위)은 컴파일 강제용으로 유지.
    #[test]
    fn c1_per_field_assertions_name_the_field() {
        let got = to_proto_profile(&c1_profile());
        assert_eq!(got.vus, 11, "vus");
        assert_eq!(got.ramp_up_seconds, 22, "ramp_up_seconds");
        assert_eq!(got.duration_seconds, 33, "duration_seconds");
        assert_eq!(got.loop_breakdown_cap, 44, "loop_breakdown_cap");
        assert_eq!(got.http_timeout_seconds, 55, "http_timeout_seconds");
        assert_eq!(got.think_time.map(|t| t.min_ms), Some(66), "think_time.min_ms");
        assert_eq!(got.think_time.map(|t| t.max_ms), Some(77), "think_time.max_ms");
        assert_eq!(got.think_seed, Some(88), "think_seed");
        assert_eq!(got.target_rps, Some(99), "target_rps");
        assert_eq!(got.max_in_flight, Some(111), "max_in_flight");
        assert_eq!(got.stages.len(), 1, "stages.len");
        assert_eq!(got.stages[0].target, 122, "stages[0].target");
        assert_eq!(
            got.stages[0].duration_seconds, 133,
            "stages[0].duration_seconds"
        );
        assert!(got.measure_phases, "measure_phases");
        assert_eq!(got.vu_stages.len(), 2, "vu_stages.len");
        assert_eq!(got.vu_stages[0].target, 144, "vu_stages[0].target");
        assert_eq!(
            got.vu_stages[0].duration_seconds, 155,
            "vu_stages[0].duration_seconds"
        );
        assert_eq!(got.vu_stages[1].target, 166, "vu_stages[1].target");
        assert_eq!(
            got.vu_stages[1].duration_seconds, 177,
            "vu_stages[1].duration_seconds"
        );
        assert!(!got.ramp_down_immediate, "ramp_down_immediate");
        assert_eq!(
            got.graceful_ramp_down_seconds,
            Some(188),
            "graceful_ramp_down_seconds"
        );
        assert_eq!(
            got.connect_timeout_seconds,
            Some(199),
            "connect_timeout_seconds"
        );
    }
}
```

- [ ] **Step 2: 모듈을 등록한다**

`crates/controller/src/grpc/mod.rs` 를 아래로 교체:

```rust
pub mod coordinator;
pub mod profile;
pub mod shard;
```

- [ ] **Step 3: 컴파일 실패(RED)를 확인한다**

Run: `cargo test -p handicap-controller --lib grpc::profile 2>&1 | head -30`
Expected: FAIL — ``cannot find function `to_proto_profile` in this scope`` (**2회** — 이 시점의 테스트는 2개다. C2·C3는 Step 7에서 추가된다). 이게 RED다.

- [ ] **Step 4: `api/runs.rs:741-781`의 리터럴을 함수로 옮긴다**

`crates/controller/src/grpc/profile.rs` 의 모듈 레벨 `use` 아래, `#[cfg(test)] mod tests` **위에** 아래를 추가:

```rust
/// `spawn_run`이 워커에 보낼 `PendingAssignment.profile`을 만든다.
///
/// store 20필드 중 15개가 와이어로 간다. 의도적 미매핑 5개:
/// `data_binding`/`data_bindings`(→ `PendingDataBinding` 경유) ·
/// `criteria`(컨트롤러측 SLO 판정) · `worker_count`(컨트롤러가 register 시
/// 분할) · `apply_scenario_think_time`(워커는 strip된 YAML을 받는다).
pub(crate) fn to_proto_profile(p: &Profile) -> pb::Profile {
    pb::Profile {
        vus: p.vus,
        ramp_up_seconds: p.ramp_up_seconds,
        duration_seconds: p.duration_seconds,
        loop_breakdown_cap: p.loop_breakdown_cap,
        http_timeout_seconds: p.http_timeout_seconds,
        think_time: p.think_time.map(|t| pb::ThinkTime {
            min_ms: t.min_ms,
            max_ms: t.max_ms,
        }),
        think_seed: p.think_seed,
        target_rps: p.target_rps,
        max_in_flight: p.max_in_flight,
        stages: p
            .stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| pb::Stage {
                target: s.target,
                duration_seconds: s.duration_seconds,
            })
            .collect(),
        measure_phases: p.measure_phases,
        vu_stages: p
            .vu_stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| pb::Stage {
                target: s.target,
                duration_seconds: s.duration_seconds,
            })
            .collect(),
        ramp_down_immediate: matches!(p.ramp_down, Some(handicap_engine::RampDown::Immediate)),
        graceful_ramp_down_seconds: p.graceful_ramp_down_seconds,
        connect_timeout_seconds: p.connect_timeout_seconds,
    }
}
```

- [ ] **Step 5: 호출부를 한 줄로 대체한다**

`crates/controller/src/api/runs.rs` 의 741–781행(`profile: handicap_proto::v1::Profile {` ~ 닫는 `},`)을 아래 한 줄로 교체:

```rust
        profile: crate::grpc::profile::to_proto_profile(profile),
```

교체 후 `assignment` 리터럴은 이렇게 된다:

```rust
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: worker_yaml,
        profile: crate::grpc::profile::to_proto_profile(profile),
        env: env.clone(),
        data_bindings,
    };
```

- [ ] **Step 6: 테스트 통과(GREEN)를 확인한다**

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: PASS — 2 tests.

- [ ] **Step 7: C2(부재/기본)와 C3(`ramp_down` 3상태)를 추가한다**

`mod tests` 안, 기존 테스트 뒤에 추가:

```rust
    /// C2: 전부 부재/기본 — 변환 규칙의 반대 방향.
    /// `stages: Some(vec![])`가 `vec![]`로 접히는지(빈 Vec ≡ 부재 규약,
    /// `is_open_loop`/`is_vu_curve` 판별과 일관) 확인한다.
    #[test]
    fn c2_absent_and_defaults() {
        let p = Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 0,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: Some(vec![]),
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
        };
        let expected = pb::Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 0,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
        };
        assert_eq!(to_proto_profile(&p), expected);
    }

    /// C3: `Option<RampDown>` 3상태 → `bool`.
    /// `None`은 C2가, `Some(Graceful)`은 C1이 덮으므로 여기선 세 상태를
    /// 한자리에서 대조해 규칙을 못박는다.
    #[test]
    fn c3_ramp_down_three_states() {
        let mut p = c1_profile();

        p.ramp_down = None;
        assert!(
            !to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=None → false"
        );

        p.ramp_down = Some(handicap_engine::RampDown::Graceful);
        assert!(
            !to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=Graceful → false"
        );

        p.ramp_down = Some(handicap_engine::RampDown::Immediate);
        assert!(
            to_proto_profile(&p).ramp_down_immediate,
            "ramp_down=Immediate → true"
        );
    }
```

- [ ] **Step 8: 전부 통과 확인**

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: PASS — 4 tests.

- [ ] **Step 9: 결선 게이트 ① 실행 (리터럴 소멸 + 호출 존재)**

```bash
awk '/^#\[cfg\(test\)\]/{exit} /(v1|pb)::Profile[[:space:]]*\{/{c++} END{print c+0}' \
    crates/controller/src/api/runs.rs
awk '/^#\[cfg\(test\)\]/{exit} /to_proto_profile\(/{c++} END{print c+0}' \
    crates/controller/src/api/runs.rs
```
Expected: 첫 명령 **`0`**(추출 전 baseline은 `1`이었다 — 0이 아니면 인라인 리터럴이 남아있다), 둘째 **`1`**(프로덕션 호출 1개 = 결선).

> 둘째도 리전 스코프다(Task 2 Step 6과 대칭). 오늘은 `api/runs.rs`의 테스트 리전에 이 함수 호출이 없어 전역 `grep -c`도 1을 내지만, 그 파일에 호출하는 테스트가 생기면 조용히 약해진다.

- [ ] **Step 10: keepalive 삭제 → 전체 게이트 → 커밋**

먼저 Step 0의 keepalive를 지운다(남기면 커밋에 섞인다):

```bash
rm crates/controller/tests/_tdd_keepalive.rs
```

게이트를 파이프 없이 돌려 종료코드를 명시 캡처. **plan의 인라인 코드는 rustfmt canonical이 아니므로 `cargo fmt`가 재포맷하는 것이 정상이다**(회귀 아님) — write 후 `--check`로 확인한다:

```bash
cargo fmt ; echo "fmt exit=$?"
cargo fmt --check ; echo "fmt-check exit=$?"
cargo clippy --workspace --all-targets -- -D warnings ; echo "clippy exit=$?"
cargo nextest run --workspace ; echo "nextest exit=$?"
```
Expected: 넷 다 `exit=0`. (doctest는 pre-commit이 별도로 돌리므로 커밋 시 커버된다.)

그다음 커밋 — **단일 FOREGROUND 호출(timeout 600000ms)**, background/폴링 금지, 파이프 금지:

```bash
git add crates/controller/src/grpc/profile.rs crates/controller/src/grpc/mod.rs crates/controller/src/api/runs.rs
test ! -e crates/controller/tests/_tdd_keepalive.rs ; echo "keepalive-gone exit=$?"   # 0이어야 한다
git diff --cached --name-only
git commit -m "refactor(controller): store→proto Profile 매핑을 to_proto_profile로 추출 + 표 테스트

api/runs.rs의 인라인 pb::Profile 리터럴(15필드)을 grpc/profile.rs 순수함수로
이동. 표현식 그대로라 거동 0-diff.

테스트 4건: C1 전 필드 sentinel(통째 assert_eq + 필드별 단언 병행) · C2
부재/기본(Some(vec![])→vec![] 접힘) · C3 ramp_down 3상태.

입력 픽스처와 기대 리터럴 모두 ..Default::default() 없이 전 필드 명시 —
필드 추가 시 매핑 단언 옆에서 컴파일 에러가 나게 하는 것이 목적."
```

커밋 후 `git log -1`로 landed 확인.

---

### Task 2: 워커 `to_run_plan` 추출 + 스테일 주석 삭제 + 표 테스트

**Files:**
- Modify: `crates/worker/src/lib.rs:227-301` (주석 삭제 + 리터럴 → 호출)
- Modify: `crates/worker/src/lib.rs` (`proto_connect_timeout` 뒤에 `to_run_plan` 추가)
- Modify: `crates/worker/src/lib.rs` `#[cfg(test)] mod tests` (테스트 추가)

**Interfaces:**
- Consumes: 없음(Task 1과 독립 — 서로 다른 크레이트).
- Produces: `fn to_run_plan(profile: &pb::Profile, vu_count: u32, vu_offset: u32, env: BTreeMap<String, String>, data_bindings: Vec<Arc<DataSet>>) -> RunPlan` — Task 3의 R3b·R5·R6이 이 함수에 회귀를 심는다.

> **시그니처 근거(바꾸지 말 것):** `profile`은 **참조**다. `lib.rs:305`의 `info!(ramp_up_s = profile.ramp_up_seconds, …)`가 리터럴 **뒤에서** `profile`을 다시 읽는다. 값으로 받으면 그 로그가 깨진다(로그를 `plan.ramp_up.as_secs()`로 바꾸면 컴파일은 되지만 호출부를 건드리게 되므로 채택 안 함). `env`·`data_bindings`는 리터럴 이후 미사용이라 값으로 받는다.
>
> **알려진 한계 — `vu_count`/`vu_offset` 위치 인자 전치는 이 단위 테스트가 못 잡는다.** 추출 전엔 이름 있는 필드 매핑(`vus: assignment.vu_count` / `vu_offset: assignment.vu_offset`)이었으나 추출 후엔 같은 타입(`u32`)·같은 출처의 인접 **위치 인자 2개**가 된다. 단위 테스트는 함수를 직접 부르므로(233/244를 명시 전달) 호출부 전치를 원리적으로 못 본다.
> - `&pb::RunAssignment`를 받아 필드명을 함수 안에 남기는 대안은 **불가능**하다 — `lib.rs:144`의 `let profile = assignment.profile.expect(…)`가 `assignment`를 **partial move**시켜 이후 전체 차용이 안 된다(우회하려면 `.clone()`이 필요해 "표현식 이동뿐" 불변식을 깬다).
> - **대신 기존 e2e가 이 전치를 잡는다**(메커니즘 확인함):
>   - **open-loop fan-out** — `crates/controller/tests/multi_worker_fanout_e2e.rs:531-539`가 `vu<10`과 `vu>=10` 요청이 **둘 다** 도달했는지 단언한다. 스왑하면 worker 0 = `(vus=0, vu_offset=10)`, worker 1 = `(vus=10, vu_offset=10)` → **두 워커의 `vu_offset`이 모두 10**이 되어 `vu<10` 요청이 아예 발생하지 않는다. (주의: 이 경로는 `plan.vus`를 **쓰지 않는다** — 슬롯풀은 `max_in_flight`가 정하고(`runner.rs:1299-1300`, `(0..max_in_flight)`) vu id는 `vu_offset.saturating_add(slot as u32)`다(`crates/engine/src/runner.rs:1427`, open-loop 함수는 `:1276`부터 — `:895`는 VU-곡선 경로라 무관). "worker 0의 vus가 0이라 요청이 사라진다"는 설명은 **틀렸다**.)
>   - **closed-loop** — 더 단순하고 강한 근거: closed-loop은 `plan.vus`만큼 VU를 띄우므로 스왑으로 `vus=0`이 되면 요청이 0건이 되어 어떤 closed-loop e2e든 깨진다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`crates/worker/src/lib.rs` 의 `mod tests` 안, **맨 끝**에 추가:

```rust
    /// C1 sentinel `pb::Profile` — Task 1의 컨트롤러 픽스처가 만들어내는 것과
    /// 같은 값들. 필드마다 다르다.
    ///
    /// ⚠ `..Default::default()` 금지 — 15필드 전부 명시하는 것이 목적이다
    /// (proto 필드 추가 시 여기서 컴파일 에러가 나야 한다).
    ///
    /// ⚠ `target_rps` + `stages` + `vu_stages`를 **동시에** 채운 것은 **의도**다.
    /// 실제 run에선 `validate_run_config`가 거부하는 조합이지만, 순수 매핑
    /// 함수는 검증을 하지 않고, 세 필드를 모두 채워야 같은-타입 이웃 전치
    /// 판별력이 최대가 된다. "잘못된 픽스처"로 보고 고치지 말 것.
    fn c1_pb_profile() -> pb::Profile {
        pb::Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            think_time: Some(pb::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: vec![pb::Stage {
                target: 122,
                duration_seconds: 133,
            }],
            measure_phases: true,
            // 원소 2개 필수 — 파생 duration(합=332)이 자기 구성요소와
            // 겹치지 않아야 sentinel 유일성이 유지된다.
            vu_stages: vec![
                pb::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                pb::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
        }
    }

    fn c1_dataset() -> Arc<DataSet> {
        Arc::new(DataSet {
            policy: BindingPolicy::PerVu,
            seed: 255,
            rows: vec![BTreeMap::from([("k".to_string(), "v".to_string())])],
        })
    }

    /// C1(워커): 전 필드 sentinel.
    ///
    /// `..` 없는 **전 필드 구조분해**가 핵심 장치다 — `RunPlan`에 필드가
    /// 추가되면 이 패턴이 컴파일 에러를 낸다. (`RunPlan`은 `PartialEq`를
    /// 파생하지 않고, `Vec<Arc<DataSet>>` 때문에 파생시키려면 엔진
    /// 프로덕션 타입까지 손대야 하므로 통째 비교 대신 이 방식을 쓴다.)
    /// 구조분해한 바인딩은 **전부 단언**한다 — 안 하면 `unused_variables`가
    /// `-D warnings`(게이트가 `--all-targets`)로 실패한다.
    #[test]
    fn c1_worker_all_fields_map_to_distinct_sentinels() {
        let env = BTreeMap::from([("E".to_string(), "1".to_string())]);
        let ds = c1_dataset();
        let plan = to_run_plan(
            &c1_pb_profile(),
            233,
            244,
            env.clone(),
            vec![Arc::clone(&ds)],
        );

        let RunPlan {
            vus,
            ramp_up,
            duration,
            env: plan_env,
            loop_breakdown_cap,
            vu_offset,
            data_bindings,
            http_timeout,
            think_time,
            think_seed,
            target_rps,
            max_in_flight,
            stages,
            measure_phases,
            vu_stages,
            ramp_down,
            graceful_ramp_down,
            connect_timeout,
        } = plan;

        assert_eq!(vus, 233, "vus는 assignment.vu_count에서 온다");
        assert_eq!(vu_offset, 244, "vu_offset");
        assert_eq!(ramp_up, Duration::from_secs(22), "ramp_up");
        // 파생값: run_duration_secs가 vu_stages 우선 → 155 + 177 = 332.
        // (입력 duration_seconds=33이 아니다.)
        assert_eq!(duration, Duration::from_secs(332), "duration(vu_stages 합)");
        assert_eq!(plan_env, env, "env");
        assert_eq!(loop_breakdown_cap, 44, "loop_breakdown_cap");
        assert_eq!(data_bindings.len(), 1, "data_bindings.len");
        assert!(
            Arc::ptr_eq(&data_bindings[0], &ds),
            "data_bindings는 같은 Arc를 그대로 전달해야 한다"
        );
        assert_eq!(http_timeout, Duration::from_secs(55), "http_timeout");
        assert_eq!(
            think_time.map(|t| (t.min_ms, t.max_ms)),
            Some((66, 77)),
            "think_time"
        );
        assert_eq!(think_seed, Some(88), "think_seed");
        assert_eq!(target_rps, Some(99), "target_rps");
        assert_eq!(max_in_flight, Some(111), "max_in_flight");
        assert_eq!(
            stages.map(|v| v.iter().map(|s| (s.target, s.duration_seconds)).collect::<Vec<_>>()),
            Some(vec![(122, 133)]),
            "stages"
        );
        assert!(measure_phases, "measure_phases");
        assert_eq!(
            vu_stages.map(|v| v.iter().map(|s| (s.target, s.duration_seconds)).collect::<Vec<_>>()),
            Some(vec![(144, 155), (166, 177)]),
            "vu_stages"
        );
        assert_eq!(ramp_down, RampDown::Graceful, "ramp_down");
        assert_eq!(
            graceful_ramp_down,
            Some(Duration::from_secs(188)),
            "graceful_ramp_down"
        );
        assert_eq!(
            connect_timeout,
            Some(Duration::from_secs(199)),
            "connect_timeout"
        );
    }
```

> `RampDown`은 `derive(PartialEq)`라 `assert_eq!`가 된다(`engine/src/runner.rs:40`).

- [ ] **Step 2: 컴파일 실패(RED)를 확인한다**

Run: `cargo test -p handicap-worker --lib c1_worker 2>&1 | head -20`
Expected: FAIL — `cannot find function `to_run_plan` in this scope`.

- [ ] **Step 3: `to_run_plan`을 추가한다 (배치 주의)**

`crates/worker/src/lib.rs` 의 `proto_connect_timeout` 함수 **바로 뒤**(현재 641행 근처, `error_kind_stats_to_proto` 앞)에 삽입한다. **`pub async fn run(`(490) 이후여야 한다** — 그 앞에 두면 Step 6의 게이트 awk 리전에 들어가 거짓 실패한다.

```rust
/// proto `Profile` + shard 배정 → 엔진 `RunPlan`.
///
/// `execute_assignment`에서 추출한 순수 매핑이라 18필드를 단위 테스트로
/// 잠글 수 있다(추출 전엔 0건이었다). `profile`은 참조 — 호출부가 리터럴
/// 뒤에서 `profile.ramp_up_seconds`를 로그로 다시 읽기 때문이다.
fn to_run_plan(
    profile: &pb::Profile,
    vu_count: u32,
    vu_offset: u32,
    env: BTreeMap<String, String>,
    data_bindings: Vec<Arc<DataSet>>,
) -> RunPlan {
    RunPlan {
        vus: vu_count,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(run_duration_secs(profile)),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        vu_offset,
        // N independent bindings: field 10 (data_bindings) when present, else the
        // legacy field-5 binding as a 1-element list. 로딩은 호출부
        // (`execute_assignment`)가 하고 여기엔 결과만 전달된다.
        data_bindings,
        // proto default 0 (absent field from an old controller) → fall back to 30s
        // so the byte-identical invariant holds; current controllers send 1..=600.
        http_timeout: Duration::from_secs(u64::from(if profile.http_timeout_seconds == 0 {
            30
        } else {
            profile.http_timeout_seconds
        })),
        think_time: profile.think_time.map(|t| handicap_engine::ThinkTime {
            min_ms: t.min_ms,
            max_ms: t.max_ms,
        }),
        think_seed: profile.think_seed,
        // Open-loop: proto optional uint32 → Option<u32>. Some(rps) selects the
        // open-loop execution path in the caller; None → closed-loop run_scenario.
        target_rps: profile.target_rps,
        max_in_flight: profile.max_in_flight,
        // S-D: map proto stages to engine Stage structs; empty → None (closed/fixed path).
        stages: if profile.stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
        measure_phases: profile.measure_phases,
        // VU-curve: map proto vu_stages → engine Stage vec; empty → None (closed/flat path).
        vu_stages: if profile.vu_stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .vu_stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
        ramp_down: if profile.ramp_down_immediate {
            RampDown::Immediate
        } else {
            RampDown::Graceful
        },
        // §B9: graceful ramp-down 상한(초) → Duration. 부재 = 무상한.
        graceful_ramp_down: proto_graceful_ramp_down(profile),
        // E3: connect 단계 전용 타임아웃. 부재/0 = None = 빌더 호출 없음(byte-identical).
        connect_timeout: proto_connect_timeout(profile),
    }
}
```

- [ ] **Step 4: 호출부를 교체하고 스테일 주석을 삭제한다**

`crates/worker/src/lib.rs` 의 227–301행을 아래로 교체:

```rust
    let is_open_loop = proto_is_open_loop(&profile);
    let is_vu_curve = proto_is_vu_curve(&profile);

    let plan = to_run_plan(
        &profile,
        assignment.vu_count,
        assignment.vu_offset,
        env,
        datasets,
    );
```

> **주석을 왜 고치지 않고 지우는가:** 227–228의 "partial field moves (profile.think_time) … make `&profile` invalid after"는 **오늘 이미 거짓**이다. `pb::ThinkTime`이 `derive(Clone, Copy, …)`라 `Option<ThinkTime>: Copy`이고, 리터럴의 나머지 읽기는 전부 Copy 스칼라이거나 `.iter()`/`.is_empty()` 차용이라 partial move가 일어나지 않는다. 추출 후엔 `is_open_loop`/`is_vu_curve`가 `lib.rs:438/440`(`let run_res = if is_vu_curve { … } else if is_open_loop {`)에서 쓰이는 평범한 지역 변수일 뿐이고, 위치를 강제하는 제약이 아예 없다. 거짓 주석을 다른 거짓 주석으로 바꾸지 말고 삭제한다.

302–307행의 `info!` 블록은 **그대로 둔다**(`profile`을 참조로 넘겼으므로 무손상 — `:305`가 `ramp_up_s = profile.ramp_up_seconds`를 읽는 그 줄이다).

- [ ] **Step 5: 테스트 통과(GREEN) 확인**

Run: `cargo test -p handicap-worker --lib c1_worker`
Expected: PASS.

- [ ] **Step 6: 결선 게이트 ② 실행**

```bash
awk '/^async fn execute_assignment\(/{inside=1} inside && /^pub async fn run\(/{exit} \
     inside && /RunPlan[[:space:]]*\{/{c++} END{print c+0}' crates/worker/src/lib.rs
awk '/^async fn execute_assignment\(/{i=1} i&&/^pub async fn run\(/{exit} \
     i&&/to_run_plan\(/{c++} END{print c+0}' crates/worker/src/lib.rs
```
Expected: 첫 명령 **`0`**(baseline은 `1`이었다 — 인라인 리터럴 소멸), 둘째 **`1`**(`execute_assignment` 안의 호출 1개 = 결선).

> 둘째도 리전 스코프여야 한다. 파일 전역 `grep -c 'to_run_plan('`은 테스트가 4회 호출하므로 ~6이 나와 **프로덕션 호출을 빼먹어도 통과**한다(공허한 신호).
>
> **왜 파일 전역 카운트를 쓰지 않는가:** Step 1이 도입한 `let RunPlan { … } = plan;` 구조분해가 `RunPlan {`에 매치되므로 전역 `grep -c`류는 슬라이스 후 값이 늘어 구조적으로 통과 불가다. 리전 스코프 awk만 쓸 것.

- [ ] **Step 7: C2·C3(워커)·C4를 추가한다**

`mod tests` 안에 추가:

```rust
    /// C2(워커): 전부 부재/기본.
    ///
    /// ⚠ 기대값이 입력의 직역이 **아니다**: `http_timeout_seconds = 0`은
    /// 0-폴백으로 **30초**가 되고(`Duration::ZERO`를 기대하면 엉뚱한 이유로
    /// RED), 모든 stage 리스트가 비어 `duration`은 `duration_seconds`로
    /// 폴백하며, `ramp_down_immediate=false` → `Graceful`이다.
    #[test]
    fn c2_worker_absent_and_defaults() {
        let p = pb::Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 7,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
        };
        let plan = to_run_plan(&p, 0, 0, BTreeMap::new(), vec![]);

        assert_eq!(plan.stages, None, "빈 stages → None");
        assert_eq!(plan.vu_stages, None, "빈 vu_stages → None");
        assert_eq!(plan.think_time, None, "think_time");
        assert_eq!(plan.think_seed, None, "think_seed");
        assert_eq!(plan.target_rps, None, "target_rps");
        assert_eq!(plan.max_in_flight, None, "max_in_flight");
        assert_eq!(plan.graceful_ramp_down, None, "graceful_ramp_down");
        assert_eq!(plan.connect_timeout, None, "connect_timeout");
        assert!(!plan.measure_phases, "measure_phases");
        assert_eq!(plan.ramp_down, RampDown::Graceful, "ramp_down");
        assert_eq!(plan.duration, Duration::from_secs(7), "duration은 폴백");
        assert!(plan.data_bindings.is_empty(), "data_bindings");
        // 0-폴백. C4와 중복이지만 spec §4.2가 명시적으로 요구한다 — 이 단언이
        // 없으면 위 ⚠ 주석이 존재하지 않는 커버리지를 사칭한다.
        assert_eq!(
            plan.http_timeout,
            Duration::from_secs(30),
            "http_timeout 0-폴백"
        );
    }

    /// C3(워커): `bool` 2상태 → `RampDown`.
    ///
    /// **이 케이스가 없으면 `ramp_down: RampDown::Graceful` 하드코딩 회귀가
    /// 전 케이스를 통과한다** — C1·C2가 둘 다 `false`쪽이기 때문이다.
    /// 이 슬라이스가 겨냥하는 placeholder 실패 모드 그 자체다(R6).
    #[test]
    fn c3_worker_ramp_down_immediate_maps_to_immediate() {
        let mut p = c1_pb_profile();
        p.ramp_down_immediate = true;
        let plan = to_run_plan(&p, 1, 0, BTreeMap::new(), vec![]);
        assert_eq!(plan.ramp_down, RampDown::Immediate, "true → Immediate");
        // 다른 bool이 이 자리를 대신 채우고 있지 않은지 교차 확인.
        assert!(plan.measure_phases, "measure_phases는 여전히 true");
    }

    /// C4: `http_timeout_seconds == 0` → 30초 폴백(옛 컨트롤러 호환).
    /// `!= 0` 경로는 C1(55초)이 덮는다.
    #[test]
    fn c4_worker_http_timeout_zero_falls_back_to_30s() {
        let mut p = c1_pb_profile();
        p.http_timeout_seconds = 0;
        let plan = to_run_plan(&p, 1, 0, BTreeMap::new(), vec![]);
        assert_eq!(plan.http_timeout, Duration::from_secs(30));
    }
```

- [ ] **Step 8: 전부 통과 확인**

Run: `cargo test -p handicap-worker --lib`
Expected: PASS — 기존 테스트 + 신규 4건.

- [ ] **Step 9: 전체 게이트 + 커밋**

**plan의 인라인 코드는 rustfmt canonical이 아니므로 `cargo fmt`가 재포맷하는 것이 정상이다**(회귀 아님):

```bash
cargo fmt ; echo "fmt exit=$?"
cargo fmt --check ; echo "fmt-check exit=$?"
cargo clippy --workspace --all-targets -- -D warnings ; echo "clippy exit=$?"
cargo nextest run --workspace ; echo "nextest exit=$?"
```
Expected: 넷 다 `exit=0`.

커밋 — **단일 FOREGROUND 호출(timeout 600000ms)**, background/폴링 금지, 파이프 금지:

```bash
git add crates/worker/src/lib.rs
git diff --cached --name-only
git commit -m "refactor(worker): pb::Profile→RunPlan 매핑을 to_run_plan으로 추출 + 표 테스트

execute_assignment의 인라인 RunPlan 리터럴(18필드)을 순수함수로 이동.
표현식 그대로라 거동 0-diff. profile은 참조로 받는다 — 리터럴 뒤 info!가
profile.ramp_up_seconds를 다시 읽기 때문.

227-228의 partial-move 주석 삭제: pb::ThinkTime이 Copy라 오늘도 partial
move는 일어나지 않는다(주석이 이미 거짓이었다). 추출 후엔 is_open_loop/
is_vu_curve의 위치를 강제하는 제약이 아예 없다.

테스트 4건: C1 전 필드 sentinel(.. 없는 전 필드 구조분해 = RunPlan 필드
추가 시 컴파일 에러) · C2 부재/기본(http_timeout 0→30s 파생 주의) ·
C3 ramp_down_immediate=true→Immediate · C4 0-폴백."
```

---

### Task 3: 이빨 실증 (고의 회귀 → RED → 원복 → GREEN) 10건

**Files:** 임시 편집만 — **커밋되는 변경 없음**. 각 회귀는 확인 즉시 원복한다.

**Interfaces:**
- Consumes: Task 1의 `to_proto_profile`, Task 2의 `to_run_plan`.
- Produces: R1~R9 결과 표 — **Task 4 Step 4로 이관**해 커밋에 영속시킨다(이 task 자체는 커밋 없음).

> **왜 필요한가:** 회귀 가드를 표방하는 테스트는 이빨을 실증해야 한다(레포 규율 — plan이 지시한 테스트도 공허할 수 있다). 각 항목마다 회귀를 심고 **RED를 눈으로 확인**한 뒤 원복하고 GREEN을 확인한다.
>
> **0-diff 불변식과의 화해:** R7·R8·R9는 각각 `store/runs.rs`·`.proto`·`engine/src/runner.rs`를 **일시 편집**한다. Global Constraints의 "`.proto` 0-diff"는 **커밋 diff** 기준이며, 세 편집은 확인 즉시 원복되어 Step 11의 `git status --porcelain`이 빈 출력임을 기계 보증한다.
>
> **주의:** 이빨 실증은 **결선을 증명하지 않는다.** 구현자가 리터럴을 복사해 함수를 만들고 인라인을 안 지워도 R1~R9는 전부 정상 동작한다. 결선은 Task 1 Step 9 / Task 2 Step 6의 게이트가 담보한다.

- [ ] **Step 1: R1 — `connect_timeout_seconds: None` 하드코딩 (E3 실제 사고 재현)**

`grpc/profile.rs`의 `to_proto_profile`에서 `connect_timeout_seconds: p.connect_timeout_seconds,` → `connect_timeout_seconds: None,`

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: **FAIL** — `c1_all_fields_map_to_distinct_sentinels` 와 `c1_per_field_assertions_name_the_field`(후자가 `"connect_timeout_seconds"` 라벨로 지목).

원복 후 Run 재실행 → PASS.

- [ ] **Step 2: R2 — `target_rps` ↔ `max_in_flight` 전치**

`to_proto_profile`에서 `target_rps: p.max_in_flight,` / `max_in_flight: p.target_rps,`로 교체(둘 다 `Option<u32>`라 **컴파일은 통과한다** — 이게 요점).

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: **FAIL**.

원복 → PASS.

- [ ] **Step 3: R3a — 컨트롤러 `stages` ↔ `vu_stages` 전치**

`to_proto_profile`의 `stages:` 블록과 `vu_stages:` 블록의 소스 필드를 서로 바꾼다(`p.stages` ↔ `p.vu_stages`).

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: **FAIL**.

원복 → PASS.

- [ ] **Step 4: R3b — 워커 `stages` ↔ `vu_stages` 전치**

워커측은 컨트롤러와 로직이 다르다(`if profile.stages.is_empty() { None } else { Some(…) }` 분기). R3a만으로는 이 분기가 실증되지 않는다.

`to_run_plan`의 `stages:` / `vu_stages:` 블록에서 읽는 필드를 서로 바꾼다.

Run: `cargo test -p handicap-worker --lib c1_worker`
Expected: **FAIL**.

원복 → PASS.

- [ ] **Step 5: R4 — bool 이웃 전치 (`measure_phases ← apply_scenario_think_time`)**

`to_proto_profile`에서 `measure_phases: p.measure_phases,` → `measure_phases: p.apply_scenario_think_time,`

> C1이 `measure_phases=true` ∧ `apply_scenario_think_time=false`로 갈라놨기 때문에 잡힌다. 픽스처가 `apply_scenario_think_time`의 serde 기본값(`true`)을 썼다면 이 회귀는 **통과했을 것**이다 — 명시 `false`가 이빨의 근거다.

Run: `cargo test -p handicap-controller --lib grpc::profile`
Expected: **FAIL**.

원복 → PASS.

- [ ] **Step 6: R5 — 워커 `http_timeout` 0-폴백 제거**

`to_run_plan`의 `http_timeout:` 을 `Duration::from_secs(u64::from(profile.http_timeout_seconds))` 로 단순화(폴백 분기 삭제).

Run: `cargo test -p handicap-worker --lib c4_worker`
Expected: **FAIL** (0 → 30초가 아니라 0초가 된다).

원복 → PASS.

- [ ] **Step 7: R6 — 워커 `ramp_down` 하드코딩**

`to_run_plan`의 `ramp_down:` 블록 전체를 `ramp_down: RampDown::Graceful,` 로 교체.

Run: `cargo test -p handicap-worker --lib c3_worker`
Expected: **FAIL**.

> 이 회귀는 C1·C2만으로는 잡히지 않는다(둘 다 `Graceful`을 기대한다). C3(워커)가 있어야만 RED가 된다 — 그 의존이 이 실증의 요점이다.

원복 → PASS.

- [ ] **Step 8: R7 — ①의 강제력 (신규 필드 = 컴파일 에러)**

`crates/controller/src/store/runs.rs` 의 `Profile` struct에 더미 필드를 추가:

```rust
    #[serde(default)]
    pub dummy_teeth_probe: bool,
```

Run — **lib 유닛만 결정적으로**(R9와 같은 이유: `crash_recovery_test.rs`·`export_routes_test.rs`·`dispatcher_subprocess_test.rs`·`report_test.rs`가 `Profile {`를 지어 통합 테스트가 먼저 실패하면 lib-test가 안 지어진다):

```bash
cargo test -p handicap-controller --lib --no-run 2>&1 \
  | grep -cE '^\s*--> crates/controller/src/grpc/profile\.rs'
```
Expected: **2 이상** — `c1_profile()`과 `c2_absent_and_defaults`의 `Profile {` 리터럴 2곳(픽스처가 늘면 그만큼 는다). **`0`이면 픽스처가 강제 대상이 아니다 = 공허**다.

> **통과 신호가 "컴파일 에러 발생"이 아닌 이유:** `store::Profile`은 `Default`를 파생하지 않아 기존 픽스처 헬퍼(`unique_profile`·`profile_with` 등)도 이미 exhaustive다. 따라서 더미 필드를 넣으면 **이 슬라이스가 없어도** 컴파일 에러가 난다. 새 픽스처가 그 강제 대상에 포함되는지를 봐야 실증이 공허하지 않다.
>
> R8의 컨트롤러 신호와 달리 여기선 "경로가 나오면" 그 자체로 충분하다 — `to_proto_profile`은 `store::Profile`을 **읽기만** 하고 생성하지 않으므로, 그 파일의 히트는 반드시 픽스처의 것이다.

더미 필드 원복 후 `cargo test -p handicap-controller --lib --no-run` → 성공 확인.

- [ ] **Step 9: R8 — ②의 강제력 (proto 필드 추가 = 양쪽 픽스처 컴파일 에러)**

US2는 "`store::Profile` **또는** `pb::Profile`에 필드를 추가할 때"를 약속한다. R7이 앞의 절반이면 R8이 뒤의 절반이다.

`crates/proto/proto/coordinator.proto` 의 `message Profile` 마지막(`connect_timeout_seconds = 15;` 뒤)에 추가:

```proto
  optional uint32 dummy_teeth_probe = 16;
```

Run — **두 크레이트를 따로, `--no-run`으로**(전체 워크스페이스 빌드는 첫 실패 후 스케줄링을 멈춰 원하는 유닛이 안 지어질 수 있다):

```bash
# 컨트롤러: 에러 위치(-->) 줄만 센다
cargo test -p handicap-controller --lib --no-run 2>&1 \
  | grep -cE '^\s*--> crates/controller/src/grpc/profile\.rs'
# 워커
cargo test -p handicap-worker --lib --no-run 2>&1 \
  | grep -cE '^\s*--> crates/worker/src/lib\.rs'
```

Expected: 컨트롤러 **`3` 이상**, 워커 **`1` 이상**.

> **컨트롤러 신호가 "존재"가 아니라 "개수"인 이유(공허 방지):** 추출 후 `grpc/profile.rs`에는 **프로덕션 `to_proto_profile` 본문**(= 이전한 기존 exhaustive 리터럴)과 픽스처가 **함께** 산다. proto 필드를 더하면 프로덕션 본문만으로도 그 경로가 에러 목록에 뜨므로, "경로가 나온다"는 신호는 **새 픽스처가 강제 대상인지 판별하지 못한다**(R7이 피하려던 바로 그 함정). 기대 `3` = 프로덕션 본문 1 + C1 기대 리터럴 1 + C2 기대 리터럴 1. **`1`이면 프로덕션 본문뿐 = 픽스처가 강제 대상이 아니다 = 공허**다.
>
> 워커 쪽은 "존재"로 충분하다 — 워커 프로덕션엔 `pb::Profile` 리터럴이 없고 기존 테스트 픽스처 9개는 전부 `..Default::default()`라(`lib.rs:786`~`945`) 그 경로 히트는 반드시 신규 픽스처(`c1_pb_profile`/`c2_worker_absent_and_defaults`)의 것이다.

`.proto` 원복 후 `cargo test -p handicap-controller --lib --no-run && cargo test -p handicap-worker --lib --no-run` → 성공 확인.

- [ ] **Step 10: R9 — ③의 강제력 (`RunPlan` 필드 추가 = 구조분해 컴파일 에러)**

`crates/engine/src/runner.rs` 의 `pub struct RunPlan` 마지막 필드(`connect_timeout`) 뒤에 추가:

```rust
    pub dummy_teeth_probe: bool,
```

Run — **워커 lib 유닛만 결정적으로 짓는다**:

```bash
cargo test -p handicap-worker --lib --no-run 2>&1 | grep -c 'E0027'
```
Expected: **1 이상** — `E0027`(pattern does not mention field). 이게 `..` 없는 전 필드 구조분해가 실제로 강제력을 갖는다는 증거다.

> **`cargo build --workspace --tests`를 쓰지 말 것:** `RunPlan` 필드 추가는 **~35개 컴파일 유닛**을 깨뜨린다(엔진 통합 테스트 20파일 + `worker/tests/abort_and_env.rs` + 프로덕션 리터럴). cargo는 첫 실패 후 새 유닛 스케줄링을 멈추므로, 워커 lib-test가 아예 안 지어져 `grep -c 'E0027'`가 **0**이 나올 수 있다(거짓 FAIL). `-p handicap-worker --lib`는 의존이 engine/proto/worker-core **lib**뿐이고 셋 다 정상 컴파일되므로 결정적이다.
>
> **다른 유닛 수십 개가 E0063으로 빨개지는 것은 정상이다** — 프로덕션 `to_run_plan` 리터럴의 E0063은 추출 전에도 나던 것이라 신호가 아니다. **E0027이 이 슬라이스가 새로 만든 강제력**이다.

`runner.rs` 원복 후 `cargo test -p handicap-worker --lib --no-run` → 성공 확인.

- [ ] **Step 11: 작업트리가 깨끗한지 확인**

Run: `git status --porcelain`
Expected: **출력 없음**(모든 회귀가 원복됐다). 출력이 있으면 원복 누락 — 반드시 해소할 것.

- [ ] **Step 12: 결과 표를 Task 4로 넘긴다**

R1~R9(10건) 각각의 RED/에러 확인 여부를 표로 정리해 **Task 4의 build-log 단락과 커밋 메시지에 싣는다**. 이 task 자체는 커밋할 파일 변경이 없으므로, 결과가 subagent 리포트에만 남으면 컨텍스트 리셋 후 "Task 3이 돌았나"를 판정할 수 없다(레포 규율: 재개 판정의 진실의 원천은 **git 커밋** — TodoWrite/subagent report 불신).

---

### Task 4: 함정 문서 갱신 + spec 요구 기록 2건 + 이빨 실증 결과 표

**Files:**
- Modify: `crates/controller/CLAUDE.md` (매핑 함정 항목 — 파일 마지막 불릿)
- Modify: `docs/build-log.md:677` (연기 항목 정정)
- Modify: `docs/build-log.md` (이 슬라이스 단락 append — Step 4)

**Interfaces:**
- Consumes: Task 3 Step 12의 R1~R9 결과 표.
- Produces: 없음(docs-only — pre-commit fast-path).

- [ ] **Step 1: `crates/controller/CLAUDE.md`의 매핑 함정 항목을 통째로 갱신한다**

현재 항목(파일 마지막 불릿, `**\`store::Profile\` → \`pb::Profile\` 매핑…` 으로 시작)은 숫자(`~17`)뿐 아니라 **"어느 것도 테스트가 없다"**·**"기계적 해법이 필요해지면 `to_proto_profile` 추출이 …(E3에서는 의도적으로 기각)"** 서술 전체가 이 슬라이스 후 거짓이 된다. 아래로 **교체**:

```markdown
- **`store::Profile` → `pb::Profile` 매핑은 `grpc/profile.rs::to_proto_profile` 순수함수 — 표 테스트 4건이 15필드를 잠근다** (store-proto-mapping, E3 연기 해소): 과거엔 `api/runs.rs`의 `PendingAssignment` 리터럴 안에 인라인이라 **~17필드 중 어느 것도 테스트가 없었다**(유일 픽스처 `base_assignment()`가 `pb::Profile`을 직접 지어 매핑을 우회). 지금은 C1(전 필드 sentinel — 필드마다 다른 값이라 같은-타입 이웃 전치가 RED)·C2(부재/기본)·C3(`ramp_down` 3상태)가 잠근다. 워커 반대편(`pb::Profile → RunPlan`)도 `worker/src/lib.rs::to_run_plan`으로 대칭 추출됐다. **필드를 추가할 때**: 두 픽스처가 `..Default::default()` 없이 전 필드를 명시하므로 컴파일 에러가 매핑 단언 옆에서 나서 "와이어로 가야 하나"를 강제로 판단하게 된다 — **그 픽스처에 `..Default::default()`를 붙여 에러를 회피하지 말 것**(강제력이 사라진다). 남은 잔여 위험은 **같은 작성자가 양쪽 기대값을 쓴다**는 편향이다(양쪽이 각자 정확해도 proto 필드의 *의미*를 둘 다 오해하면 green) — 그 계층은 라이브 검증만 잡는다(E3의 `connect_timeout` vs `timeout` kind 갈림이 그 예). `ReportJson.run.profile`은 같은 DB 행의 재직렬화라 **영속 확인은 원리적으로 와이어를 증명하지 못한다**는 점도 그대로다. **아직 무테스트로 남은 이웃**: 같은 `spawn_run` 블록의 `PendingDataBinding` 매핑(`slot_count` 3분기).
```

- [ ] **Step 2: `docs/build-log.md:677`의 "~17필드"를 정정한다**

해당 줄의 연기 항목 서술에서 `store→proto 매핑 무테스트(~17필드 전반 — …)` 부분을 아래로 교체:

```markdown
store→proto 매핑 무테스트(실제 15필드 — `fn to_proto_profile(&Profile) -> pb::Profile` 추출이 기계적 해법이나 5라운드 리뷰된 plan 밖 프로덕션 리팩터라 **이번 슬라이스에서 기각**; **2026-08-02 store-proto-mapping 슬라이스가 해소**)
```

- [ ] **Step 3: spec이 요구한 기록 2건을 build-log 슬라이스 단락에 넣는다**

spec §2.2와 §6.1이 **build-log 기록을 명시적으로 요구**한다. `docs/build-log.md` 끝에 이 슬라이스 단락을 append하며 아래를 포함한다.

> ⚠ **`/finish-slice`는 새 단락을 만들지 말고 이 단락에 이어 쓸 것.** 파이프라인 6단계도 build-log 슬라이스 단락을 쓰므로, 못박아두지 않으면 같은 슬라이스 단락이 둘 남는다.

```markdown
**연기(build-log 기록, spec §2.2)**: 같은 `spawn_run` 블록의 **데이터바인딩 매핑**
(`PendingDataBinding` 생성 + `slot_count` 3분기: `vu_curve_max` / `max_in_flight` /
`vus`)은 여전히 무테스트다 — 관심사가 다르고(데이터셋 행 배분 ≠ 부하 노브 배선)
이번 슬라이스에서 의도적으로 제외했다. 생성 사이트는 `api/runs.rs`의 그 블록
하나뿐이고 전용 테스트 0건. · **크로스-크레이트 라운드트립 단위 테스트**는
기술적으로 가능하나(`controller/Cargo.toml`이 이미 `handicap-worker`를 optional
의존) 채택하지 않았다 — prost가 양쪽에 같은 이름 필드를 생성해 번역 층이 없고,
진짜 잔여 위험인 "같은 작성자가 양쪽 기대값을 쓴다"는 편향을 라운드트립도 못
줄이며, e2e가 이미 더 강한 링크다. · **`vu_count`/`vu_offset` 호출부 위치 전치**는
새 단위 테스트가 원리적으로 못 잡는다(함수를 직접 호출하므로) — 기존 e2e가 커버한다:
closed-loop은 `plan.vus=0`이 되어 VU가 0개(요청 0건)가 되고, open-loop
`multi_worker_fanout_e2e.rs:531-539`는 **두 워커의 `vu_offset`이 모두 10**이 되어
`vu<10` 요청이 사라진다(open-loop 경로는 `plan.vus`를 쓰지 않는다 — 슬롯풀은
`max_in_flight`, vu id는 `vu_offset + slot`, `engine/src/runner.rs:1427`).

**라이브 검증 생략 근거(spec §6.1)**: 이 슬라이스는 `spawn_run`(run-생성 경로)과
`execute_assignment`(엔진 경로) **프로덕션 코드를 바꾸므로** 파이프라인 5단계의
"production diff 0" 면제 조항이 문자 그대로는 적용되지 않는다. 그럼에도 생략한
근거 = ① 변경의 성질이 표현식 이동뿐(새 분기·새 값·새 호출 0) ② 실 워커
바이너리를 spawn하는 e2e 6개 파일이 정규 게이트에서 그 두 경로를 관통하므로
추출이 결선을 깨면 **라이브보다 먼저 실패한다** ③ 결선 자체는 리전 스코프 grep
게이트(§5)가 기계 검증한다. (이빨 실증은 결선의 근거가 **아니다** — 함수 내용만
증명한다.)
```

- [ ] **Step 4: 이빨 실증 결과 표를 같은 단락에 싣는다**

Task 3 Step 12의 R1~R9 결과를 표로 append한다(형식: `R# | 홉 | 고의 회귀 | 관측 결과`). 이 표가 커밋에 남아야 컨텍스트 리셋 후 Task 3 완료를 판정할 수 있다.

- [ ] **Step 5: 커밋**

docs-only라 pre-commit fast-path(수초). **단일 FOREGROUND 호출**, 파이프 금지:

```bash
git add crates/controller/CLAUDE.md docs/build-log.md
git diff --cached --name-only
git commit -m "docs: store→proto 매핑 함정 갱신 + 연기·라이브생략 근거·이빨 실증 결과

CLAUDE.md 항목은 숫자(~17→15)뿐 아니라 '어느 것도 테스트가 없다'·'추출은
E3에서 의도적 기각' 서술 전체가 거짓이 됐다 → 현황(추출 완료·표 테스트·
잔여 위험은 작성자 편향·픽스처에 ..Default::default() 금지)으로 교체.

build-log에 spec 요구 기록 3건: 연기(데이터바인딩 slot_count 무테스트·
라운드트립 기각 근거·vu_count/vu_offset 위치 전치는 fanout e2e가 커버) ·
라이브 검증 생략 근거(production diff는 0이 아니다 — e2e 6파일이 근거) ·
이빨 실증 R1~R9 결과 표(커밋에 남겨야 재개 시 판정 가능)."
```

---

## Self-Review

**1. Spec coverage**

| spec 요구 | 반영 |
|---|---|
| §2.1 `to_proto_profile` (신규 `grpc/profile.rs`, `pub(crate)`) | Task 1 Step 4 |
| §2.1 `to_run_plan` (`&pb::Profile`, 크레이트-사설) | Task 2 Step 3 |
| §3.2 스테일 주석 **삭제** | Task 2 Step 4 |
| §4.1 ① exhaustive 입력 픽스처 + 금지 주석 | Task 1 Step 1, Task 2 Step 1 |
| §4.1 ② exhaustive 기대 리터럴 + **필드별 단언 병행** | Task 1 Step 1 (테스트 2건) |
| §4.1 ③ `..` 없는 전 필드 구조분해 + 전부 단언 + `Arc::ptr_eq` | Task 2 Step 1 |
| §4.2 케이스×홉 배정 (C1 양쪽·C2 양쪽·C3 양쪽·C4 워커) | Task 1 Steps 1·7 / Task 2 Steps 1·7 |
| §4.2 sentinel 유일성 + 파생값 + `vu_stages` 2원소 | Global Constraints, Task 1 Step 1 |
| §4.2 C1 bool 배정 + `apply_scenario_think_time` 명시 `false` | Task 1 Step 1 |
| §4.2 C2 워커 파생 기대값(0→30s 등) | Task 2 Step 7 — `http_timeout` 30초 단언 **포함**(C4와 중복이나 spec이 명시 요구) |
| §4.2 C1 픽스처 의미론 "의도임을 명시" | Task 1 Step 1 · Task 2 Step 1 (두 픽스처 doc 주석) |
| §5 결선 완료 게이트 (리전 스코프 + 호출 존재) | Task 1 Step 9, Task 2 Step 6 (둘 다 리전 스코프 — 전역 카운트 금지) |
| §5 함정 문서 갱신(`CLAUDE.md` 항목 통째 + `~17`→`15`) | Task 4 Steps 1–2 |
| §6 이빨 실증 R1~R9(10건) + R7·R8·R9 좁힌/결정적 신호 | Task 3 (결과 표는 Task 4 커밋에 영속) |
| §2.2 데이터바인딩 연기 **build-log 기록** | Task 4 Step 3 |
| §6.1 라이브 검증 생략 **근거를 build-log에** | Task 4 Step 3 |
| §7 한계 — `vu_count`/`vu_offset` 위치 전치 | Task 2 함수 doc + Task 4 Step 3 (fanout e2e가 커버) |

**2. Placeholder scan:** "TBD"/"적절히"/"유사하게" 없음. 모든 코드 스텝에 실제 코드 블록이 있고, 두 task가 같은 패턴을 쓰는 곳도 복붙 대신 각자 전문을 실었다(task를 순서 밖으로 읽어도 자족).

**3. Type consistency:** `to_proto_profile(&Profile) -> pb::Profile` — Task 1 정의와 Task 3 R1·R2·R3a·R4 참조 일치. `to_run_plan(&pb::Profile, u32, u32, BTreeMap<String,String>, Vec<Arc<DataSet>>) -> RunPlan` — Task 2 정의와 Task 3 R3b·R5·R6 참조 일치. `RunPlan` 18필드 구조분해 이름이 `engine/src/runner.rs:49-104` 선언과 1:1. `DataSet { policy, seed, rows }` pub 필드 3개 일치. `handicap_engine::{ThinkTime{min_ms,max_ms}, Stage{target,duration_seconds}, RampDown{Graceful,Immediate}}` 일치. 워커 `mod tests`가 `use super::*`이므로 `BTreeMap`·`Arc`·`Duration`·`RampDown`·`RunPlan`·`DataSet`·`BindingPolicy`·`pb`·`run_duration_secs`가 전부 스코프 안(`lib.rs:1-20` 임포트).

---

REVIEW-GATE: PENDING
