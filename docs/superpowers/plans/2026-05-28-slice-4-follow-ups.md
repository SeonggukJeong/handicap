# Slice 4 — Follow-up 작업 기록

Slice 4 본체(Task 1–16)가 끝난 뒤, final code review(Opus가 전체 diff를 본 단계)에서 잡힌 권고 항목과 후속 학습을 별도로 처리한 기록.

본 문서는 "왜 추가로 손댔는가 / 무엇이 달라졌는가 / 다음 슬라이스가 어디를 더 가야 하는가"를 남긴다.

**브랜치:** `worktree-slice-4-extract-flowvars`
**기준 base:** `04f5ebc` (plan 커밋)
**Slice 4 본체 끝:** `e8ccb98`
**Follow-up 끝:** `4e35f91`

---

## Final review에서 잡힌 항목과 처리 매핑

| 권고 (review의 분류) | Follow-up | 커밋 |
|---|---|---|
| Aborted 상태가 worker의 Completed로 덮어쓰기 (Critical) | Task 10 fix + F3 (PHASE_ABORTED) | `51914d1`, `a8c1fe2` |
| clippy gate 통과 안 됨 (`assign_op_pattern` on runner.rs) | Task 10 fix + F2 (pre-commit hook) | `51914d1`, `bf3b729` |
| 실제 워커로 abort 흐름을 검증하는 e2e 테스트가 없다 (Important) | F4 | `f942dcb` |
| `ExtractEditor`가 타이핑 중 yamlText를 깜빡이게 함 (Important) | F5 | `4a59fcb` |
| 워커 종료 직전 `sleep(200ms)` race smell (Minor) | F6 | `4e35f91` |
| Manual runbook §1의 wiremock URL 오타 (Minor) | F1 | `bf3b729` |

권고 중 Slice 4 안에서 다루기로 한 항목은 모두 처리됨. 남은 Minor 관찰 사항(아래 "추가로 학습한 것"의 마지막 단락 참조)은 다음 슬라이스 후보.

---

## F1 — Manual runbook의 BASE_URL 오타

`docs/dev/ui-slice-4-manual-check.md` §1이 `BASE_URL=http://localhost:9090/__admin/mappings`를 권하고 있었음. `__admin`은 wiremock의 관리 API 경로지 stub serve root가 아니다. 따라가면 시나리오가 `/login`을 실제로 못 침. → `BASE_URL=http://localhost:9090`로 정정.

---

## F2 — Pre-commit hook에 `cargo clippy` 추가

Slice 4 본체 진행 중 `runner.rs::next_spawn = next_spawn + Duration::from_secs(1)` (`+=`로 써야 함)가 모든 단위 테스트를 통과하고도 prod 코드에 들어갔다. 원인: pre-commit hook이 `cargo fmt --check + build + test`만 돌고 clippy를 안 돌리고 있었음. Task 10 fix에서 `+=`로 고치며 hook에 clippy를 추가:

- workspace coherent 모드: `cargo clippy --workspace --all-targets -- -D warnings`
- per-crate fallback 모드: 각 crate마다 동일한 clippy 명령

추가로 `cargo clippy --all-targets`이라 테스트 코드의 clippy 위반도 잡힌다 (Task 7 proptests의 `expect_fun_call` 같은 류 — c3fd8d0에서 이미 한 번 잡혔다).

Hook 파일은 `.git/hooks/pre-commit`(git common dir, 모든 worktree 공유)에 있어 트래킹되지 않는다 — 그래서 CLAUDE.md의 "검증 자동화" 절에 새 contract를 명시했고, 새 머신은 거기서 본다.

---

## F3 — `PHASE_ABORTED` proto enum 추가

### 왜

본체 Task 10에서 abort 흐름을 1차로 닫았지만, worker는 여전히 `EngineError::Aborted`에 대해 `Phase::Completed`를 controller로 보내고 있었다. controller의 RunStatus handler가 그걸 받으면 `set_status(Completed, ended_at=now)`를 부르고, SQL UPDATE는 직전에 REST endpoint가 찍어둔 `status='aborted'`를 덮어쓴다. Task 10 fix(51914d1)에서 `WHERE status != 'aborted'` SQL guard로 회피했지만 **wire-level contract는 여전히 거짓말** — worker는 abort한 뒤 "완료"라고 말하고 있다.

### 무엇이 바뀜

- `crates/proto/proto/coordinator.proto`: `RunStatus.Phase`에 `PHASE_ABORTED = 4` 추가
- `crates/worker/src/main.rs`: 인라인 match를 `fn phase_for_result(&Result<(), EngineError>) -> (i32, String)`로 추출하고 `EngineError::Aborted`를 `Phase::Aborted`로 매핑. 인라인 `#[cfg(test)] mod tests`에 3개 단위 테스트 추가 (Aborted/Completed/Failed 각각의 매핑).
- `crates/controller/src/grpc/coordinator.rs`: RunStatus handler에 `else if s.phase == Phase::Aborted as i32 { set_status(..., RunStatus::Aborted, ...) }` 분기 추가.

SQL guard는 **belt-and-suspenders**로 그대로 유지. 둘 다 회귀하지 않는 한 abort 상태는 보존된다.

### 학습

- 같은 결과를 두 가지 다른 메커니즘이 보장할 때 둘 다 살려두는 게 안전하다. F4에서 발견한 것처럼 e2e 테스트에서 하나만 깨도 다른 하나가 막아주는 패턴이 belt-and-suspenders다.
- proto enum 값 추가는 backward-compat 안전 — 기존 클라이언트가 `PHASE_ABORTED`를 모르면 unspecified로 떨어진다. controller가 새 값을 모르는 worker로부터 메시지를 받을 일은 없으므로 호환성 문제 없음.

---

## F4 — 실제 worker subprocess로 e2e abort 테스트

### 왜

`api_test::abort_run_marks_run_aborted`는 worker가 *없는* 상태에서 REST abort를 친다. 즉 "pending → aborted" DB 전이만 검증. `worker::tests::abort_and_env::cancelled_token_aborts_run`은 worker side에서 사전-cancel된 토큰으로 엔진 흐름만 본다. **REST → controller → gRPC → live worker → engine cancel → controller가 final state로 'aborted'를 보는** 전체 경로를 검증하는 테스트는 없었다.

### 무엇이 바뀜

`crates/controller/tests/e2e_test.rs`에 `abort_e2e_marks_run_aborted` 추가. 패턴:
1. 워커 바이너리 빌드 + 인-프로세스 controller(REST + gRPC) 띄움
2. 50ms delay wiremock 타겟
3. 30s 시나리오 생성/실행 → `status=running` 관찰
4. POST `/api/runs/{id}/abort` (200 확인)
5. 10s 안에 `status=aborted` 도달 검증 — 만약 `completed`나 `failed`로 떨어지면 즉시 panic (회귀 클래스 fast-fail)

### 학습 — e2e test가 실제로 검증하는 경로

RED를 만들기 위해 임시로 worker의 `phase_for_result`에서 Aborted 분기를 Completed로 되돌렸을 때 **테스트가 통과해버렸다**. 왜? REST endpoint가 가장 먼저 DB에 `'aborted'`를 찍는데, h2 stream은 worker의 RunStatus가 도달하기 전에 닫혀버려서 controller가 그 메시지를 못 본다. 그래서 controller가 잘못된 Completed 매핑을 할 기회가 없다. 결과: REST 경로 단독으로 abort 상태가 보존됨.

**진짜 RED를 만들려면 양쪽을 동시에 깨야 했다**: (1) REST handler에서 `mark_aborted` 제거 + (2) `phase_for_result` 회귀. 그래야 worker가 Completed를 보내고 controller가 그걸 받아 'aborted'를 덮어쓰는 시나리오가 재현된다. 그 상태에서 panic 메시지:

```
run ended in 'completed' instead of 'aborted' — abort flow regression
```

이게 belt-and-suspenders의 본 의미다. 한쪽이 깨져도 다른 쪽이 막아준다. F4 테스트는 두 safeguard가 동시에 사라진 회귀를 잡는 마지막 그물.

다음 슬라이스에 시사: REST handler에 `mark_aborted` 콜은 abort UX의 핵심 — worker가 닿지 않을 때(예: worker crash)도 사용자가 abort 버튼으로 run을 종료시킬 수 있어야 한다. 그래서 이 양다리는 "둘 다 있어야 하는 안전 그물"이지 "둘 중 하나면 되는 중복"이 아님.

---

## F5 — `ExtractEditor` commit-on-blur

### 왜

`ui/src/components/scenario/Inspector.tsx::ExtractEditor`는 매 키 입력마다 `setStepExtract`를 불러 store를 업데이트했다. 사용자 입장:

1. 빈 row 추가 → `{ var: "", from: "body", path: "$." }`
2. var에 `t` → `tok` → `token` 입력 → 매 키마다 store update → 매번 Zod 검증
3. var는 채워졌지만 path가 sentinel `"$."`일 때 `commitDrafts` 필터에서 통과 (`length > 0`) → yamlText에 `extract: [{var: token, path: $.}]`이 깜빡 보임
4. path를 클리어해서 새로 타이핑하려고 select-all → path가 `""`로 비는 순간 row 전체가 filter에서 빠짐 → yamlText에서 사라짐
5. 새 path 입력 → 다시 yamlText에 나타남

**"YAML이 깜빡인다."** 거기에 더해 Slice 3의 `baselineSeededRef` dirty-flag 휴리스틱이 매 키 변경마다 yamlText 차이를 감지해 Save 버튼이 거짓-활성된다.

### 무엇이 바뀜

- `setRow`를 `updateDraft`(로컬만 갱신) + `commitFromBlur`(onBlur에서 store 업데이트)로 분리
- 각 `<input>`에 `onBlur={commitFromBlur}` 핸들러 추가
- `<select>`의 from-change는 **구조적 변경**이므로 즉시 commit (path/name 필드의 형상이 바뀌니 사용자가 보고 있는 것과 store가 어긋나면 안 됨)
- `remove`도 즉시 commit (구조적 변경)
- `append`는 commit 안 함 (새 row의 var/path가 비어 있으므로 어차피 검증 통과 못 함 + 사용자가 곧 채울 것)

추가로 `commitDrafts` 필터를 `path !== "$."`로 강화 — sentinel만 있는 row는 "아직 안 채운 row"로 취급. 사용자가 var만 입력하고 tab해서 빠져나가도 미완 row가 yaml에 새지 않음.

### 검증

2개 RED 테스트 추가:
1. `does not write to yamlText on every keystroke (commit-on-blur)` — focus 잡힌 동안 var/path를 다 입력해도 yamlText는 변하지 않고, tab해서 blur할 때만 반영
2. `does not blink on partial path edit of an existing row` — 기존 row의 path를 clear하고 다시 입력하는 도중에도 직전 commit된 값이 yamlText에 유지됨

기존 3개 ExtractEditor 테스트는 모두 user.tab을 마지막에 호출하기 때문에 그대로 통과.

---

## F6 — Worker shutdown sleep 제거

### 왜

`crates/worker/src/main.rs:160`에 있던 `tokio::time::sleep(Duration::from_millis(200))`는 final `RunStatus`를 보낸 직후 "controller가 받을 시간 주기"용 fixed delay였다. Review의 표현: "future flake source." 200ms가 모자란 환경(슬로우 CI, set_status가 디스크 fsync에 걸리는 SQLite)에서는 메시지 유실 가능, 200ms가 남는 환경에서도 매번 200ms 손해.

### 처음 시도와 실패

순진하게 `drop(tx)`만 두고 sleep 제거 → `full_slice_1_e2e`와 `two_step_with_env_e2e`가 깨졌다. 원인: tokio runtime이 main 종료와 함께 모든 spawned task를 cancel하는데, tonic의 내부 gRPC 송신 머신도 거기 포함된다. HTTP/2 DATA frame과 END_STREAM이 wire에 flush되기 전에 task가 cancel되어 controller 측에서:

```
h2 protocol error: error reading a body from connection
```

이 떨어지고, `RunStatus(Completed)`를 받지 못함. 즉 mpsc 채널 안에서는 메시지가 drain됐지만 OS 소켓 send까지는 안 갔다.

### 최종 해법

```rust
drop(tx);  // outbound stream drain + END_STREAM
let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
```

`inbound_fwd`는 controller로부터 오는 메시지를 receive하는 background task다. 이 task는 controller가 **자기 쪽 inbound leg를 닫을 때** 완료된다. controller는 worker의 outbound stream에 EOF를 본 뒤(즉 우리 final 메시지 처리 후)에야 자기 쪽을 닫는다. 따라서 `inbound_fwd.await` 완료 = "far end가 우리의 stream 종료를 본 시점" = "final 메시지가 안전하게 전달됨."

이건 fixed-time이 아니라 **protocol-level sync point**다. happy path는 보통 수 ms 안에 완료. 2s timeout은 controller가 응답 안 할 때 worker가 영구 hang 안 하게 막는 백스톱(기존 200ms sleep의 worst case와 동등하거나 더 길지만 happy path가 훨씬 빠름).

### 검증

`channel_semantics_buffered_messages_survive_sender_drop` 테스트로 tokio mpsc invariant 명시: send → drop(tx) → 버퍼된 메시지는 receiver가 drain한 뒤에야 None 반환. 이게 새 코드가 기대는 contract. 세 e2e 테스트(full_slice_1, two_step_with_env, abort_e2e)는 모두 green 유지.

### `client.rs` 변경

`WorkerLink._inbound_fwd: JoinHandle<()>`(underscore prefix로 "alive for side effects")를 `inbound_fwd`(public)로 노출. main이 await 가능해야 sync point가 의미를 가짐.

---

## F2/F6 후속에서 학습한 것들 (CLAUDE.md "Slice 4 함정들"에 반영 예정)

1. **mpsc drain vs network deliver는 다른 보장이다.** `tx.send(...).await`는 채널 버퍼 안에 들어갔다는 뜻이지 wire에 나갔다는 뜻이 아니다. tokio runtime이 main 종료와 함께 spawned task들을 cancel하면 wire에 못 나간 채로 끝날 수 있다. gRPC bidi stream의 깨끗한 shutdown은 양쪽이 협조해야 함 (sender drop → outbound EOF → 상대가 처리 후 자기 쪽 close → 우리 inbound EOF).

2. **belt-and-suspenders가 실제로 동작하는 것을 e2e로 확인하기 어려울 수 있다.** 두 safeguard 모두 정상 동작하는 시스템에서, 단일 safeguard만 breaking change로 만들면 다른 쪽이 막아준다 → 테스트는 통과한다. 이걸 RED로 만들어 검증하려면 의도적으로 양쪽을 동시에 깨야 한다. 이런 종류의 테스트가 catch하는 건 "두 safeguard가 동시에 사라지는 회귀"지 "단일 safeguard가 부서지는 회귀"가 아니다.

3. **`#[serde(tag = "from")]` 같은 internally-tagged enum은 proto enum과 매핑 관점에서도 깔끔하다.** F3에서 `Phase::Aborted = 4`를 추가하면서 worker 측의 `phase_for_result` 매핑 함수를 자연스럽게 뽑아낼 수 있었다. 향후 새 phase 추가(예: `Phase::Paused`)도 이 함수에 한 줄이면 됨.

4. **clippy `--all-targets`는 비싸지만 가치 있다.** workspace coherent 모드에서만 한번 도는 데 5–10s 추가. Slice 4 본체에서 두 번 prod-코드에 들어간 회귀(`assign_op_pattern`, `expect_fun_call`)는 모두 `--all-targets` 켜지 않으면 못 잡았을 것들이다. 코스트 대비 효과 좋음.

5. **UI editor의 commit timing은 dirty-flag 휴리스틱과 결합해서 사용자 인지 비용을 키운다.** 키 입력마다 yamlText가 바뀌면 Slice 3의 `baselineSeededRef` 비교가 매번 다른 결과를 줘서 Save 버튼이 계속 활성/비활성을 오가는 식으로 보인다. commit-on-blur는 이걸 자연스럽게 줄이는 동시에 partial-row blink도 같이 잡는 일석이조.

---

## 남은 권고 (이번 슬라이스에서는 처리 안 함)

Final review가 "Minor" / "Observations"로 분류했고 따로 우선순위가 높지 않은 항목들:

- **`worker/src/main.rs`의 `tokio-util` 직접 의존성 중복.** `handicap-engine` 재export로 충분하지만 worker가 explicit dep를 가져 약간 redundant. 의도된 격리. 그대로 둠.
- **`controller::api::runs::create`에서 non-string env 값 silent drop.** ADR-0014 contract지만 warning log가 없어 디버그가 어려울 수 있음. 차후 슬라이스에서 추가 가능.
- **`extract.rs::evaluate_extracts`의 `body_json.as_ref().unwrap()` 패턴.** clippy `or_insert_with` 제안 가능. 의미상 안전한 unwrap이고 가독성 트레이드오프라 그대로 둠.
- **proptest `arb_step` URL이 `{{var}}` 패턴을 생성하지만 그 `var`를 scenario.variables에 안 넣음.** 결과적으로 parse identity만 검증하고 render는 별도 proptest가 봄. 의도된 분리지만 commented assertion으로 명시해두는 게 미래에 헷갈리지 않음.
- **`Body { from: body, path: ... }` extract는 JSON body만 지원.** HTML/XML 응답에서는 `body not JSON: ...` 에러. Slice 5 (리포트)나 future Slice (regex/XPath extract)의 일.

다음 슬라이스(5: charts/HTML report, 6: K8s deploy)로 넘기거나, 별도 cleanup 슬라이스를 잡을 때 처리.
