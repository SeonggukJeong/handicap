---
name: mutation-audit
description: Run a SCOPED cargo-mutants mutation-testing audit to find where the test suite's coverage lies about correctness — surviving mutants = real test gaps. Use as an occasional, scoped audit of branch-heavy pure logic (engine crate first), NOT as a gate. Invoke via /mutation-audit [crate-or-file] or when asked to check test-suite strength / find untested branches / "coverage≠correctness" gaps. Defaults to the engine crate.
---

# mutation-audit — 테스트 스위트가 correctness를 속이는 지점 찾기

`cargo-mutants`(이미 설치됨, `~/.cargo/bin/cargo-mutants`)가 코드에 mutant(`>`→`>=`, `&&`→`||`, `return x`→`return Default`, 상수 제거 등)를 주입하고 테스트가 그걸 잡는지 본다. **살아남은(MISSED) mutant = line coverage는 통과하지만 테스트가 실제로 검증 안 하는 분기 = 진짜 테스트 구멍.** 이 repo의 명시 철학("coverage≠correctness", 루트 CLAUDE.md)을 기계적으로 검증하는 도구.

> **게이트가 아니라 *감사*다.** pre-commit/CI 필수 게이트로 넣지 말 것 — mutant 하나당 테스트 스위트를 1회씩 돌려 워크스페이스 전체면 수십 분~시간. 가끔, 스코프해서 돌린다.

## 언제

- 분기 많은 순수 로직을 추가/리팩터한 뒤 "내 테스트가 진짜 경계를 다 잡나?" 확인할 때.
- 엔진 크레이트(`crates/engine`)가 1순위 — `cast.rs`·`condition.rs`·`template.rs`·`extract.rs`·`pacing.rs`·`percentiles.rs`·`aggregator.rs`가 axum/sqlx 의존 없는 순수 분기라 mutation testing이 가장 잘 맞고 빠르다.
- controller의 `validate_run_config`/결정 지점도 후보지만 async/DB 의존이라 노이즈↑·느림 — 파일 단위로만.

## 어떻게 (반드시 스코프)

`$ARGUMENTS` = 크레이트명 또는 파일 경로(없으면 엔진 전체). **절대 무인자 워크스페이스 전체로 돌리지 말 것**(시간).

```bash
# 크레이트 1개 (기본: 엔진)
cargo mutants -p handicap-engine --timeout 120 2>&1 | tail -40

# 파일 1개 (빠른 집중 — 권장 시작점)
cargo mutants -p handicap-engine -f src/cast.rs --timeout 120 2>&1 | tail -40
cargo mutants -p handicap-engine -f src/condition.rs --timeout 120

# 먼저 몇 개나 생기는지 보기(테스트 안 돌리고 mutant 목록만)
cargo mutants -p handicap-engine --list | head -50
```

- `--timeout 120`: mutant이 무한루프(예: `<`→`<=`로 루프 조건 깨짐)에 빠질 때 컷오프(없으면 baseline의 자동 추정 사용 — 명시가 안전).
- 워커 바이너리 빌드 경합 회피: 다른 `cargo` 호출(pre-commit 백그라운드 커밋 등)과 동시에 돌리지 말 것(같은 `target/` 락).
- 워크트리에서 돌릴 땐 그 워크트리 root에서(자체 `target/`).

## 결과 해석

`cargo mutants` 요약: `caught`(테스트가 잡음=좋음) / **`missed`(살아남음=테스트 구멍)** / `unviable`(컴파일 실패 mutant=무시) / `timeout`(보통 무시).

**MISSED 각각을 판단** (`mutants.out/missed.txt` 또는 stdout):
1. **진짜 구멍** → 그 분기를 죽이는 테스트를 추가(TDD: RED 먼저 — 이 repo는 tdd-guard가 인라인 `#[cfg(test)]` 동봉을 허용). 예: 경계값(`rows < N` vs `rows <= N`), 빈/단일 케이스, 에러 분기.
2. **equivalent mutant**(의미상 동일해 어떤 테스트로도 못 죽임) → 무시(드묾). 코드 주석으로 근거 남기면 다음 감사 때 재논의 회피.
3. **의도적 미검증**(예: 로깅 문구, 성능 휴리스틱) → 무시.

핵심: missed 수를 0으로 만드는 게 목표가 아니라, missed를 **하나씩 보고 "이게 버그면 테스트가 잡나?"**에 답하는 것. high-impact 순수 로직(cast 엄격성·바인딩 행 게이트·메트릭 수식·조건 평가)의 missed부터.

## 정리

`cargo mutants`는 `mutants.out/`(+ `mutants.out.old/`) 디렉토리에 리포트를 남긴다 — **gitignore 안 돼 있으면 untracked 잔류**. 감사 후:
```bash
rm -rf mutants.out mutants.out.old
git status --porcelain   # 잔류 0 확인
```
(반복적으로 쓸 거면 `.gitignore`에 `mutants.out*/` 한 줄 추가 권장.)

## 비목표

- pre-commit/CI 게이트화(느림 — remote 붙는 날 CI에 *주간 schedule non-blocking job*으로는 가능).
- 워크스페이스 전체 일괄(스코프해서 크레이트/파일 단위로).
- missed=0 강박(equivalent mutant·의도적 미검증은 정상).
