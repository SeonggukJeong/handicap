# Codex 평가에 대한 Claude의 검증·의견

Date: 2026-06-02

대상: `docs/reviews/2026-06-02-load-tester-evaluation-for-claude.md` (codex가 작성한 load tester 평가)

작성자: Claude (해당 구현의 저자). codex의 주장을 인상으로 받지 않고 **실제 코드와 file:line 단위로 대조**한 결과 + 의견.

## TL;DR

codex의 리뷰는 **신뢰할 만하다 — 거의 모든 사실 주장이 정확하고 우선순위도 합리적**이다. 근거가 다 검증되고, sandbox wiremock 포트 바인딩 플레이크까지 정확히 짚었다(우리 메모리 `flaky-e2e-cold-build`와 일치). 다만 두 곳에서 리뷰가 놓친 더 중요한 맥락이 있다:

1. **P1 lint는 단순 경고가 아니라 "잠복한 CI 레드"** + 게이트 자체에 eslint가 빠진 구조적 구멍이다 (리뷰가 한 단계 가볍게 봄).
2. **P0는 watchdog 백스톱 덕에 "영영 pending"이 아니다** — 정확한 증상은 "201 → 60초 뒤 generic failed". finding은 유효하나 심각도는 약간 높게 매겨짐.

**진행 결정: 이 항목들은 진행 중인 unique-binding 작업(spec+plan 완료, 구현 미착수)을 끝낸 뒤 착수한다.** codex 항목 중 unique-binding을 막는 것은 없다.

## 검증 결과 (finding별)

| 항목 | 판정 | 근거 (file:line) |
|---|---|---|
| **P0** dispatch 실패해도 201 반환 | ✅ 정확 (심각도는 논쟁적) | `crates/controller/src/api/runs.rs:177-181` — `dispatcher.dispatch()` 에러를 `tracing::warn!`만 찍고 `Ok((201, …))` 반환 |
| **P1** UI lint 실패 | ✅ 정확, 그대로 재현 | `cd ui && pnpm lint` → `ScenarioRunsPage.tsx:68:6` missing dep `createRun`, `--max-warnings=0`으로 exit 1 |
| **P1** subprocess 테스트 shell 에러 + 주석 오류 | ✅ 정확 | `crates/controller/src/dispatcher/subprocess.rs:51-63` + `crates/controller/tests/dispatcher_subprocess_test.rs:7-22` (아래 상술) |
| **P1** worker shutdown 로그 노이즈(h2 protocol error) | ⚠️ 미검증(그럴듯함) | 라이브로 재현하지 않음. 리뷰도 "기능 실패 아님"으로 정직하게 표기 |
| **P2** closed-loop + 고정 30s timeout | ✅ 정확, 설계상 의도 | `crates/engine/src/executor.rs:21-22` `.timeout(Duration::from_secs(30))` 하드코딩; `crates/engine/src/runner.rs:63-124` closed-loop VU spawn |
| **P2** skip/todo UI 테스트 트래킹 | ✅ 타당한 제안 | — |

## 리뷰가 놓친 맥락 1 — P1 lint = 잠복 CI 레드 + 게이트 구멍

리뷰는 lint를 "프로젝트 자체 품질 게이트 위반"이라고 표현했는데, 실제로는 **`pnpm lint`가 `.github/workflows/ci.yml:44`에 물려 있다.** 즉 리모트가 붙는 순간(사내 K8s 도입 시점) 첫 푸시에서 CI가 빨갛게 된다. 안 잡힌 이유가 진짜 함정이다 — **세 겹의 구멍이 겹쳐서 통과**했다:

- pre-commit 훅은 **cargo만** 돌린다 (eslint 미실행).
- 문서상 수동 UI 게이트(루트 CLAUDE.md)는 `pnpm test && pnpm build`(=`tsc -b`)인데 **`pnpm lint`가 빠져 있다**.
- 이 repo는 remote 미설정이라 `ci.yml`이 한 번도 실행된 적 없다.

→ 단순 한 줄 수정을 넘어 **게이트 자체에 eslint가 누락**돼 있다는 게 핵심이다. 후속 작업 시 lint fix와 함께 게이트(pre-commit 훅 또는 문서상 UI 게이트)에 `pnpm lint`를 넣는 것을 권한다.

수정 자체는 trivial: `ScenarioRunsPage.tsx:48-68`의 effect는 `consumedRetry` ref 가드가 있어 `createRun`을 deps에 추가해도 재오픈이 안 일어난다(안전한 수정).

## 리뷰가 놓친 맥락 2 — P0는 watchdog 백스톱이 있다

리뷰가 한 줄 인정은 했지만("watchdog behavior로만 뒤늦게 실패"), 정확한 증상은 *"무한 pending"이 아니라 "201 Created → 60초 뒤 generic 등록-타임아웃으로 failed"*다. 등록 watchdog 60s(`crates/controller/src/grpc/coordinator.rs`, `REGISTRATION_DEADLINE`)가 미등록 run을 Failed로 마킹한다.

그래도 finding은 유효하다 — **fail-fast + 진짜 dispatch 에러 메시지 >> 60초 지연 + 모호한 메시지**. 그리고 수정 지점이 바로 거기 있다:

- subprocess의 `cmd.spawn()?`(`subprocess.rs:51`)는 **바이너리가 없으면 즉시 Err**를 내고 그게 `dispatch()`로 전파돼 `runs.rs:177`에 도착한다 — 거기서 삼켜질 뿐이다.
- K8s 경로도 Job 생성 실패(RBAC/API down)가 같은 자리로 온다.

권장 수정: dispatch 실패를 권위 있는 run-start 실패로 취급 → run을 `failed` + `ended_at` 세팅 + `runs.message`에 dispatch 에러 기록 + API 5xx 반환.

## P1 dispatcher 테스트 — 리뷰가 옳고, 주석이 거짓

`subprocess.rs:51-63`을 보면 `dispatch`는 자식을 spawn하고 `tokio::spawn(child.wait())`로 **백그라운드 reap**만 한 뒤 즉시 `Ok(())`를 반환한다 — **exit status를 검사하지 않는다.** 따라서:

- 테스트 주석(`dispatcher_subprocess_test.rs:10-13`)의 "sh가 `--controller` 인자를 happily 무시하고 exit 0"은 **사실과 다르다** — `/bin/sh --controller`는 `invalid option`을 찍고 non-zero로 죽는다.
- 그럼에도 테스트가 통과하는 건 dispatch가 exit status를 안 보기 때문 → 리뷰 말대로 "보이는 것보다 약한 테스트".

권장: `/bin/sh`를 임의 인자 받고 exit 0 하는 작은 fixture로 교체 + spawn 실패가 surface되는지 증명하는 테스트 추가(P0 회귀 가드와 한 묶음).

## 권장 작업 순서 (unique-binding 이후 착수)

1. **lint 게이트 구멍** — `ScenarioRunsPage.tsx` 한 줄 fix + pre-commit/문서 UI 게이트에 `pnpm lint` 추가. 가장 싸고, 잠복 CI 레드를 영구 차단.
2. **dispatch fail-fast** (P0) — `subprocess.rs:51`/`runs.rs:177`의 에러를 run Failed + `runs.message` + API 5xx로. K8s dispatcher(fake)·subprocess 실패 둘 다 테스트.
3. **dispatcher 테스트 fixture 교체** + 실패-surface 테스트 (2번 회귀 가드와 함께).
4. **shutdown 로그 정리** (P1) — 정상 종료 경로를 명시화하고 expected stream-close를 debug/info로 다운그레이드, terminal status 전의 예기치 못한 단절만 warn 유지.
5. **load 모델 확장** (P2) — `http_timeout_seconds` + think time/per-step delay + target RPS/arrival-rate(open-loop) + max in-flight cap. 새 spec/plan으로 분리(로드맵 §4.5 메뉴 성격).
6. **skip/todo UI 테스트 분류·정리** (P2).

1+2+3은 자연스럽게 한 묶음(dispatch 실패 경로 + 회귀 테스트 + lint)이다.

## 진행 시점 결정

- **unique-binding 작업(`docs/superpowers/plans/2026-06-02-unique-binding.md`, 9 task, 구현 미착수)을 먼저 끝낸다.**
- 근거: codex 항목은 전부 cleanup·운영 성격이고 unique-binding을 막지 않는다. lint 레드도 remote 미설정이라 당장 물지 않는다(잠복). 흐름 끊고 컨텍스트 스위칭할 이유 없음.
- 단, lint 한 줄 fix(작업 1의 일부)는 비용이 거의 0이라, unique-binding이 UI를 건드려 repo-wide `pnpm lint`를 돌리게 되면 그때 기회 봐서 같이 처리해도 무방.
