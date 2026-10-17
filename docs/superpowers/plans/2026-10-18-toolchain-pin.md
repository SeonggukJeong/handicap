# Rust 툴체인 정확 버전 고정 + 릴리즈 CI-녹색 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust 컴파일러를 6곳에서 정확 버전 `1.99.1`로 고정하고(정합 검사·`just bump-rust` 포함), 릴리즈 `publish` 잡이 태그 커밋의 ci 녹색을 확인한 뒤에만 게시하게 한다.

**Architecture:** 원천 `rust-toolchain.toml` + 거울 5곳(워크플로 4·Dockerfile 1). 판정 로직은 YAML이 아니라 레포 bash 스크립트 2개(`scripts/check-rust-toolchain.sh`·`scripts/check-ci-green.sh`)에 두고 워크플로는 호출만 한다(release-hygiene 선례 — 로컬 양방향 실행 검증 가능).

**plan 작성 시 사전 실측(가설 아님 — 그래도 구현 시 Step 검증을 그대로 재실행할 것)**: Task 1 Step 1 스크립트를 현 트리에 돌려 Step 2 기대 출력과 일치 · Step 3의 python 블록을 스크래치 복사본에서 `1.99.1`/`1.97.0` 왕복 + Dockerfile 0건 시 무기록 중단 확인 · Task 2 Step 1 스크립트로 Step 2 (a)–(d)·Step 3 (b)–(f) 기대 출력 일치(실 `gh` + 스텁). `actionlint` baseline exit 0.

**Tech Stack:** bash(3.2 호환), python3(Justfile 인라인 — `bump-version` 레시피 관례), GitHub Actions, `gh` CLI(`--jq`), rustup.

**Spec:** `docs/superpowers/specs/2026-10-18-toolchain-pin-design.md` (spec-plan-reviewer APPROVE, 2라운드)

**Plan review:** spec-plan-reviewer clean APPROVE (3라운드 — R1 가드-거부 명령 형태·검증-후-일괄기록 실증 부재, R2 원복 순서·sweep 기대값 2건 반영).

REVIEW-GATE: APPROVED

## Global Constraints

- 고정 버전 = **`1.99.1`** (spec §1). `rust-version = "1.85"`(MSRV)는 건드리지 않는다.
- 스크립트: `#!/usr/bin/env bash` + `set -euo pipefail` + **bash 3.2 호환**(mapfile·연관배열·빈 배열 `"${a[@]}"` 금지 — set -u에서 unbound) + git 모드 `100755`.
- 정합 검사 출력 형식은 `check-release-versions.sh`와 같다: `printf 'ok        %-44s %s\n'` / `printf 'MISMATCH  %-44s %s …\n'`, 불일치 전부 출력 후 exit 1.
- JSON 파싱은 `gh … --jq`(외부 `jq` 의존 없음 — 단 로컬 스텁 검증은 `/usr/bin/jq` 사용).
- 문서에 버전 **리터럴을 쓰지 않는다**("`rust-toolchain.toml`의 고정 버전") — 예외: spec·plan·build-log·roadmap.
- 커밋 메시지는 `-F <파일>`로, 끝에 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git commit … | tail` 파이프·`--no-verify` 금지. 커밋 후 `git log -1 --oneline`로 landed 확인.
- **워크트리 격리 세션의 Bash 가드 — 명령 형태 규칙** (plan 작성·리뷰 중 실측, 거부되면 그 단계가 통째로 안 돈다):
  - 문자열 `.github`가 든 명령은 "git 복합 명령"으로 오인돼 거부될 수 있다(`actionlint .github/workflows/ci.yml` 거부) → 워크플로 편집은 **Edit 도구**, 린트는 **인자 없는 `actionlint`**(자동 탐색), 워크플로 검색은 **Grep 도구**.
  - **git 명령은 항상 단독 호출**: `git … ; echo exit=$?`·`git diff > f && cmp …`·여러 git 줄을 한 호출에 묶기 → 거부. 종료코드는 툴이 보고하므로 `echo exit=$?`를 붙이지 않는다. diff 저장은 리다이렉트 대신 `git diff --output=<파일>`(단독), 비교는 별도 호출 `cmp <a> <b> && echo same`.
  - 환경변수 확장(`PATH=…:$PATH`)이 든 명령은 거부("value computed at runtime") → 리터럴 PATH를 쓰거나, 여러 케이스는 **러너 `.sh` 파일을 Write로 만들어 `bash <파일>` 1회 호출**.
  - 스크립트·`just`·`cargo` 직접 호출 뒤 `; echo exit=$?`는 허용된다.

## Review Focus

1. **단축/대문자 SHA 입력** — `gh run list --commit <단축>`은 `[]`라 "run 없음"으로 오판된다 → 게이트는 `^[0-9a-f]{40}$` 아니면 exit 2(Task 2 Step 2 (d)(e)).
2. **같은 SHA에 run 여러 개**(옛 success + 새 failure, 또는 dispatch 재실행) — 배열 순서와 무관하게 **`createdAt` 최신 1개**가 판정 → 스텁 fixture를 최신이 배열 *앞*인 것과 *뒤*인 것 **둘 다** 넣어 정렬을 실증(`.[0]`·`.[-1]` 어느 쪽 오구현도 한 케이스에서 RED — Task 2 Step 3 (d)(d')(g)).
3. **publish 도달 시 ci가 아직 in_progress** — 대기 후 success면 통과, 상한 초과면 실패(Task 2 Step 3 검증 (b)(c)).
4. **`bump-rust`에 존재하지 않는/형식 틀린 버전, 그리고 python 단계의 부분 실패** — 파일이 하나도 안 바뀐다. 셸 검증 단계 거부(Step 6 (d))만으로는 "검증-후-일괄기록"이 실증되지 않는다(python 이전에 끝나므로 파일별 즉시 기록 구현도 통과) → Dockerfile 0건으로 python assert를 일으켜 `rust-toolchain.toml`(첫 기록 대상)이 안 바뀌었음을 확인(Step 6 (e)).
5. **Windows release 잡의 `Effective toolchain` 스텝은 pwsh**(기본 셸) — `rustc --version && cargo --version`의 `&&`는 pwsh 7에서 유효(spec 리뷰 확인). 로컬 재현 불가 → 머지 후 다음 태그에서 실측, build-log에 "미실측" 기록.

---

### Task 1: 6곳 고정 + 정합 검사 + `just bump-rust` + 실효 버전 출력

**Files:**
- Create: `scripts/check-rust-toolchain.sh` (mode 100755)
- Modify: `Justfile` (새 레시피 `bump-rust` — `bump-version` 레시피 바로 뒤, `doc-coverage` 주석 앞)
- Modify: `rust-toolchain.toml:2`
- Modify: `.github/workflows/ci.yml` (checkout 뒤 정합 검사 스텝, `:14` 버전, 그 뒤 Effective toolchain 스텝)
- Modify: `.github/workflows/release.yml:71`·`:182` (버전 + 각 뒤 Effective toolchain 스텝)
- Modify: `.github/workflows/e2e-kind.yml:14` (버전 + Effective toolchain 스텝)
- Modify: `deploy/Dockerfile:20`(FROM)·`:27-32`(cargo build RUN — `:29` `cargo build` 앞에 `rustc --version` 줄)

**Interfaces:**
- Produces: `scripts/check-rust-toolchain.sh`(인자 없음, exit 0/1) — Task 3 문서가 이름으로 참조. `just bump-rust <X.Y.Z>` — Task 3 문서가 참조.

- [ ] **Step 0: 툴체인·캐시 준비 (orchestrator가 디스패치 전에 해도 됨)**

Run: `rustup toolchain list`
Expected: `1.99.1-aarch64-apple-darwin`과 `1.97.0-aarch64-apple-darwin`이 목록에 있다(없으면 `rustup toolchain install 1.99.1 --component rustfmt --component clippy`).

- [ ] **Step 1: 정합 검사 스크립트 작성**

`scripts/check-rust-toolchain.sh`:

```bash
#!/usr/bin/env bash
# Rust 툴체인 고정 정합 검사(spec toolchain-pin §3.2).
# 원천 = rust-toolchain.toml의 channel(정확 버전 X.Y.Z여야 한다 — `stable` 금지).
# 거울 = .github/workflows/*.yml의 모든 `dtolnay/rust-toolchain@<ref>` + deploy/Dockerfile의 모든 `FROM rust:<ver>-…`.
# 불일치를 전부 출력한 뒤 1로 종료한다(check-release-versions.sh 관례). 승급은 `just bump-rust <ver>`.
# bash 3.2 호환(mapfile/연관배열 금지).
set -euo pipefail
cd "$(dirname "$0")/.."   # 전 경로가 repo-root 상대다

fail=0
channel="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' rust-toolchain.toml | head -n 1)"

if printf '%s\n' "$channel" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf 'ok        %-44s %s\n' "rust-toolchain.toml channel" "$channel"
else
  printf 'MISMATCH  %-44s %s (정확 버전 X.Y.Z여야 함)\n' "rust-toolchain.toml channel" "${channel:-<없음>}"
  fail=1
fi

check() { # <file:line> <actual>
  if [ "$2" = "$channel" ]; then
    printf 'ok        %-44s %s\n' "$1" "$2"
  else
    printf 'MISMATCH  %-44s %s (기대 %s)\n' "$1" "${2:-<없음>}" "$channel"
    fail=1
  fi
}

# <label> <grep-ERE> <sed-ERE 추출식> <file...> — 출현마다 check, 0개면 실패(검사 공허 방지).
# `/dev/null`을 붙여 파일이 1개여도 grep이 파일명을 찍게 한다. while은 heredoc으로 먹여
# 서브셸을 피한다(파이프면 fail=1이 사라진다).
mirrors() {
  local label="$1" pat="$2" extract="$3" n=0 hit loc ver
  shift 3
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    loc="$(printf '%s\n' "$hit" | cut -d: -f1,2)"
    ver="$(printf '%s\n' "$hit" | cut -d: -f3- | sed -E "$extract")"
    check "$loc" "$ver"
    n=$((n + 1))
  done <<EOF
$(grep -nE "$pat" "$@" /dev/null || true)
EOF
  if [ "$n" -eq 0 ]; then
    printf 'MISMATCH  %-44s %s\n' "$label" "출현 0개 — 패턴이 바뀌어 검사가 공허하다"
    fail=1
  fi
}

mirrors ".github/workflows/*.yml" 'dtolnay/rust-toolchain@' \
  's/.*dtolnay\/rust-toolchain@([^[:space:]]+).*/\1/' .github/workflows/*.yml
mirrors "deploy/Dockerfile" '^FROM[[:space:]]+rust:' \
  's/^FROM[[:space:]]+rust:([^-[:space:]]+).*/\1/' deploy/Dockerfile

exit "$fail"
```

Run: `chmod +x scripts/check-rust-toolchain.sh`

- [ ] **Step 2: 고정 전 상태에서 실패 확인 (RED — baseline)**

Run: `scripts/check-rust-toolchain.sh; echo exit=$?`
Expected: 첫 줄 `MISMATCH  rust-toolchain.toml channel  stable (정확 버전 X.Y.Z여야 함)`, 워크플로 4줄은 `ok … stable`(채널 `stable`과 같으므로), Dockerfile 줄은 `MISMATCH  deploy/Dockerfile:20  1.85 (기대 stable)`, `exit=1`.

- [ ] **Step 3: `bump-rust` 레시피 작성**

`Justfile`의 `bump-version` 레시피(마지막 줄 `echo "다음: git add -u && …"`) 바로 뒤, 빈 줄 하나 두고 삽입:

```just
# Rust 툴체인 승급: rust-toolchain.toml(원천) + 워크플로 dtolnay 거울 + Dockerfile FROM을 한 번에.
# 전부 검증한 뒤 전부 쓴다(검증 실패 시 파일 무변경). 새 clippy lint는 승급 커밋 안에서 고친다.
bump-rust ver:
    #!/usr/bin/env bash
    set -euo pipefail
    ver="{{ver}}"
    if ! printf '%s\n' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "bad version: '$ver' (X.Y.Z만 — v 접두·stable·1.99 불가, 예: 1.99.1)" >&2
      exit 2
    fi
    echo "거울 대상 실존 확인…"
    git ls-remote --exit-code https://github.com/dtolnay/rust-toolchain "refs/heads/$ver" >/dev/null \
      || { echo "dtolnay/rust-toolchain@$ver 브랜치 없음 — Rust 릴리즈 직후면 수일 내 생긴다" >&2; exit 1; }
    curl -sf -o /dev/null "https://hub.docker.com/v2/repositories/library/rust/tags/$ver-bookworm" \
      || { echo "rust:$ver-bookworm 태그 없음 — 릴리즈 직후이거나 bookworm 태그 중단(Dockerfile 베이스 결정 필요)" >&2; exit 1; }
    python3 - "$ver" <<'PY'
    import pathlib, re, sys
    ver = sys.argv[1]
    plan = []  # (path, new_text, count) — 전부 계산한 뒤에만 쓴다

    def compute(path, pat, repl, exact=None):
        p = pathlib.Path(path)
        new, n = re.subn(pat, repl, p.read_text(), flags=re.M)
        if exact is not None:
            assert n == exact, f"{path}: 매치 {n}개({exact}개여야 함)"
        else:
            assert n >= 1, f"{path}: 매치 0개"
        plan.append((p, new, n))

    compute("rust-toolchain.toml", r'^(channel\s*=\s*)"[^"]*"', lambda m: m.group(1) + f'"{ver}"', exact=1)
    total = 0
    for p in sorted(pathlib.Path(".github/workflows").glob("*.yml")):
        new, n = re.subn(r'(dtolnay/rust-toolchain@)\S+', lambda m: m.group(1) + ver, p.read_text())
        if n:
            plan.append((p, new, n))
            total += n
    assert total >= 1, "워크플로: dtolnay/rust-toolchain@ 매치 0개"
    compute("deploy/Dockerfile", r'^(FROM\s+rust:)[^-\s]+', lambda m: m.group(1) + ver)

    for p, new, n in plan:
        p.write_text(new)
        print(f"  {p}: {n}곳 -> {ver}")
    PY
    scripts/check-rust-toolchain.sh
    rustup toolchain install "$ver" --component rustfmt --component clippy
    echo
    echo "다음: 승급 커밋 → pre-commit이 새 clippy로 전체 cargo 게이트를 돈다(새 lint는 같은 커밋에서 수정)."
    echo "에어갭 빌드 머신은 반입 아카이브를 새 버전으로 다시 만들 것(docs/dev/install-rhel-airgapped.md §4.3)."
```

주의: just shebang 레시피는 레시피 들여쓰기(4칸)를 벗겨 실행한다 — `bump-version`의 heredoc과 같은 형태이므로 python 블록도 4칸 들여쓴 그대로 둔다. python f-string의 `{ver}`·`{n}`은 just 보간(`{{…}}`)과 충돌하지 않는다.

- [ ] **Step 4: 레시피로 고정 적용 (dogfood)**

Run: `just bump-rust 1.99.1; echo exit=$?`
Expected: `rust-toolchain.toml: 1곳`, `.github/workflows/ci.yml: 1곳`, `.github/workflows/e2e-kind.yml: 1곳`, `.github/workflows/release.yml: 2곳`, `deploy/Dockerfile: 1곳` → 정합 검사 `ok` 6줄 → rustup "unchanged"(이미 설치) → `exit=0`.

- [ ] **Step 5: 실효 버전 출력 + CI 정합 검사 스텝 추가 (Edit 도구)**

`.github/workflows/ci.yml` `rust` 잡 — checkout 바로 뒤(protoc 설치 앞)에:

```yaml
      # 툴체인 고정 정합(원천 rust-toolchain.toml ↔ 워크플로·Dockerfile 거울). 툴체인 불필요라 맨 앞.
      - name: Toolchain pin consistency
        run: scripts/check-rust-toolchain.sh
```

그리고 `dtolnay/rust-toolchain@1.99.1` 스텝(`with: components: …` 포함) 바로 뒤에:

```yaml
      # `+` 없는 rustc = rust-toolchain.toml로 해석된, cargo가 실제로 쓰는 버전(액션 자체 출력은 `rustc +<ver>`라 공허).
      - name: Effective toolchain
        run: rustc --version && cargo --version
```

같은 `Effective toolchain` 스텝(주석 포함)을 `.github/workflows/release.yml`의 두 `dtolnay/rust-toolchain@1.99.1` 스텝 뒤(windows-installer는 `uses:` 줄 바로 뒤, macos-dmg는 `with: targets: …` 블록 뒤)와 `.github/workflows/e2e-kind.yml`의 `dtolnay/rust-toolchain@1.99.1` 줄 뒤에 넣는다(총 4곳).

`deploy/Dockerfile`의 cargo build RUN(`:27-32`, `:29`가 `cargo build`)을:

```dockerfile
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/work/target \
    rustc --version \
    && cargo build --release -p handicap-controller -p handicap-worker \
    && mkdir -p /out \
    && cp target/release/controller /out/controller \
    && cp target/release/worker /out/worker
```

Run: `actionlint; echo exit=$?`
Expected: `exit=0` (baseline도 0 — plan 작성 시 실측).

Run: `grep -c "name: Effective toolchain" .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/e2e-kind.yml` (거부되면 Grep 도구로 같은 검색)
Expected: `ci.yml:1`, `release.yml:2`, `e2e-kind.yml:1`.

- [ ] **Step 6: 정합 검사·`bump-rust` 양방향 검증 (실행만, 커밋 대상 아님)**

기준 diff 저장(단독 호출): `git diff --output=/tmp/toolchain-pin-before.patch`

**원복 확인 절차(이하 "cmp 확인")** — 두 번의 단독 호출: ① `git diff --output=/tmp/toolchain-pin-cur.patch` ② `cmp /tmp/toolchain-pin-before.patch /tmp/toolchain-pin-cur.patch && echo same` → `same`.

(a) GREEN: `scripts/check-rust-toolchain.sh; echo exit=$?` → `ok` 6줄(`rust-toolchain.toml channel`, `ci.yml:<줄>`, `e2e-kind.yml:<줄>`, `release.yml:<줄>` ×2, `deploy/Dockerfile:20`) · `exit=0`.

(b) 각 거울 RED — 한 번에 하나씩 Edit로 바꾸고 실행 후 원복:
- `rust-toolchain.toml` channel → `"stable"`: 첫 줄 MISMATCH + 거울 5줄 MISMATCH(`기대 stable`), `exit=1`.
- `e2e-kind.yml`의 `@1.99.1` → `@1.98.0`: 그 줄만 `MISMATCH … 1.98.0 (기대 1.99.1)`, `exit=1`.
- `deploy/Dockerfile` `FROM rust:1.99.1-bookworm` → `FROM rust:1.85-bookworm`: 그 줄만 MISMATCH, `exit=1`.
- 0건 가드(워크플로): 워크플로 4곳의 `dtolnay/rust-toolchain@` → `dtolnay/rust-toolchainX@`(Edit, 4곳): `MISMATCH  .github/workflows/*.yml  출현 0개 …`, `exit=1`.
- 0건 가드(Dockerfile): `FROM rust:` → `FROM rustX:`: `MISMATCH  deploy/Dockerfile  출현 0개 …`, `exit=1`.
매 원복 후 cmp 확인 → `same`.

(c) `bump-rust` 왕복: `just bump-rust 1.97.0; echo exit=$?` → `ok` 6줄(1.97.0)·`exit=0` → `just bump-rust 1.99.1; echo exit=$?` → `ok` 6줄·`exit=0` → cmp 확인 → `same`. **이 사이 cargo를 돌리지 말 것**(1.97.0으로 빌드 캐시가 오염된다).

(d) `bump-rust` 셸 단계 거부 + 무기록: `just bump-rust v1.99.1; echo exit=$?`, `just bump-rust stable; echo exit=$?`, `just bump-rust 1.99; echo exit=$?` → 각각 `bad version`·`exit=2`(just는 레시피 종료코드를 그대로 전파 — 실측 `error: recipe \`r\` failed with exit code 2`·`exit=2`). `just bump-rust 1.999.0; echo exit=$?` → `dtolnay/rust-toolchain@1.999.0 브랜치 없음`·`exit=1`. 네 번 모두 뒤에 cmp 확인 → `same`.

(e) **검증-후-일괄기록 실증(python 단계 부분 실패)**: Edit로 `deploy/Dockerfile`의 `FROM rust:1.99.1-bookworm`을 `FROM rustX:1.99.1-bookworm`으로 → `just bump-rust 1.97.0; echo exit=$?` → `AssertionError: deploy/Dockerfile: 매치 0개`·실패 → `rust-toolchain.toml`이 여전히 `channel = "1.99.1"`인지 확인(Read 또는 `grep -n channel rust-toolchain.toml`) — 1.97.0이면 파일별 즉시 기록 구현이라 **FAIL**. 이어 이빨 실증: python 블록을 임시로 "compute 직후 즉시 `p.write_text`" 형태로 바꿔 같은 케이스 재실행 → `rust-toolchain.toml`이 `1.97.0`으로 바뀜(RED)을 확인 → 레시피 원복 → **Dockerfile `FROM rust:` 먼저 원복**(`FROM rustX:`가 남은 채 `bump-rust`를 돌리면 원복된 레시피가 정상적으로 무기록 중단해 `rust-toolchain.toml`이 1.97.0에 머문다) → `just bump-rust 1.99.1; echo exit=$?`로 파일 복귀·`exit=0` → cmp 확인 → `same`.

- [ ] **Step 7: 새 툴체인으로 캐시 워밍 (pre-commit 시간 단축 — 각각 FOREGROUND, timeout 600000)**

Run: `cargo build --workspace; echo exit=$?` → `exit=0` (1.99.1 첫 빌드라 전체 재컴파일)
Run: `cargo build -p handicap-worker --bin worker; echo exit=$?` → `exit=0`
Run: `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?` → `exit=0`. **실패(새 lint)하면 STOP하고 orchestrator에 보고** — master는 CI에서 1.99.1 clippy clean으로 실측됐으므로(spec §1) 실패는 전제 붕괴 신호다. 고치는 커밋은 `crates/*/src` 편집이라 tdd-guard·별도 판단이 필요하다.
Run: `cargo nextest run --workspace --no-run; echo exit=$?` → `exit=0` (pre-commit의 nextest가 쓸 테스트 타깃 워밍 — clippy `--all-targets`는 테스트 바이너리를 만들지 않는다)
Run: `cargo fmt --all -- --check; echo exit=$?` → `exit=0`

- [ ] **Step 8: 커밋 (FOREGROUND, timeout 600000 — `rust-toolchain.toml` staged라 pre-commit 전체 cargo 게이트)**

각각 **단독 호출**로: `git add -u` → `git add scripts/check-rust-toolchain.sh` → `git diff --cached --name-only`.
Expected staged: `.github/workflows/ci.yml`, `.github/workflows/e2e-kind.yml`, `.github/workflows/release.yml`, `Justfile`, `deploy/Dockerfile`, `rust-toolchain.toml`, `scripts/check-rust-toolchain.sh` (7개, 그 외 없음).
Run: `git ls-files -s scripts/check-rust-toolchain.sh` → 모드 `100755`.

커밋 메시지 파일(`/tmp/toolchain-pin-msg1.txt`):
```
build(rust): 툴체인 1.99.1 정확 고정 + 정합 검사 + just bump-rust

rust-toolchain.toml(원천)·워크플로 dtolnay 4곳·Dockerfile FROM을 같은 정확 버전으로.
scripts/check-rust-toolchain.sh가 6곳 불일치를 ci rust 잡 첫 스텝에서 잡고,
just bump-rust <ver>가 검증-후-일괄기록으로 승급한다. 각 잡에 toolchain 파일로
해석된 rustc --version 출력(US4). spec 2026-10-18-toolchain-pin §3.1–3.3.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
Run(단독): `git commit -F /tmp/toolchain-pin-msg1.txt` → pre-commit cargo 게이트 통과·툴이 보고하는 종료코드 0.
Run(단독): `git log -1 --oneline` → 위 제목.

---

### Task 2: 릴리즈 publish CI-녹색 게이트 + ci `workflow_dispatch`

**Files:**
- Create: `scripts/check-ci-green.sh` (mode 100755)
- Modify: `.github/workflows/release.yml` (헤더 구조 주석 `:7-8`, `publish` 잡 — Task 1 이전 `:216`, Task 1의 삽입 6줄 뒤 ~`:222`; 줄번호가 아니라 텍스트 매칭으로 편집)
- Modify: `.github/workflows/ci.yml:2-5` (`on:`에 `workflow_dispatch:`)

**Interfaces:**
- Consumes: 없음(Task 1과 독립 — 같은 release.yml을 다른 줄에서 편집).
- Produces: `scripts/check-ci-green.sh <40-hex sha>` → exit 0(녹색)/1(빨강·없음·대기초과·gh실패)/2(usage). env `CI_GATE_POLL_SECONDS`(기본 30)·`CI_GATE_MAX_WAIT_SECONDS`(기본 1800)·`GITHUB_REPOSITORY`(있으면 `--repo`). Task 3 문서가 이름·동작을 참조.

- [ ] **Step 1: 게이트 스크립트 작성**

`scripts/check-ci-green.sh`:

```bash
#!/usr/bin/env bash
# 릴리즈 publish 게이트(spec toolchain-pin §3.4): 태그 커밋의 ci 워크플로 **최신 run**이
# success일 때만 0. 진행 중이면 대기하고, 빨강·run 없음·대기 초과·gh 실패는 사유+해소법과 함께 1.
# 읽기 전용(gh run list만). bash 3.2 호환. 테스트용 env: CI_GATE_POLL_SECONDS·CI_GATE_MAX_WAIT_SECONDS.
set -euo pipefail

# 40자 전체 SHA만 받는다 — `gh run list --commit <단축>`은 []를 돌려 "run 없음"으로 오판된다.
if [ $# -ne 1 ] || ! printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "usage: $0 <40자 commit SHA>   (단축 SHA 불가 — gh가 []를 돌려준다)" >&2
  exit 2
fi
sha="$1"
poll="${CI_GATE_POLL_SECONDS:-30}"
max_wait="${CI_GATE_MAX_WAIT_SECONDS:-1800}"

# 최신 run 1개(createdAt 기준 — 배열 순서에 기대지 않는다)를 "status conclusion url" 한 줄로. run 0개면 빈 줄.
latest_run() {
  gh run list ${GITHUB_REPOSITORY:+--repo "$GITHUB_REPOSITORY"} \
    --workflow ci --commit "$sha" --limit 20 \
    --json status,conclusion,createdAt,url \
    --jq 'sort_by(.createdAt) | last
          | if . == null then ""
            else "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.url)" end'
}

start=$SECONDS
while :; do
  if ! out="$(latest_run)"; then
    echo "gh run list 실패 — fail-closed. 워크플로에서 403이면 publish 잡 permissions의 actions: read 누락." >&2
    exit 1
  fi
  if [ -z "$out" ]; then
    cat >&2 <<EOF
ci run 없음: $sha
ci는 push의 head 커밋에서만 돈다 — 한 push에 여러 커밋을 올리면 중간 커밋엔 run이 없다.
해소: gh workflow run ci --ref <태그>  → 녹색 확인 → 이 publish 잡만 재실행.
EOF
    exit 1
  fi
  status="${out%% *}"
  rest="${out#* }"
  conclusion="${rest%% *}"
  url="${rest#* }"
  if [ "$status" = "completed" ]; then
    if [ "$conclusion" = "success" ]; then
      echo "ci green: $url"
      exit 0
    fi
    cat >&2 <<EOF
ci $conclusion: $url
해소: flake면 ci 재실행 → 녹색 확인 → 이 publish 잡만 재실행 / 진짜 실패면 수정 커밋 + 새 태그.
EOF
    exit 1
  fi
  waited=$((SECONDS - start))
  if [ "$waited" -ge "$max_wait" ]; then
    echo "ci 대기 상한 ${max_wait}s 초과(status=$status): $url — ci가 끝난 뒤 이 publish 잡만 재실행." >&2
    exit 1
  fi
  echo "ci $status — ${poll}s 후 재조회(경과 ${waited}s/${max_wait}s): $url"
  sleep "$poll"
done
```

Run: `chmod +x scripts/check-ci-green.sh`

- [ ] **Step 2: 실 `gh`로 양방향 검증 (읽기 전용 조회)**

(a) `scripts/check-ci-green.sh 11735f432ef912156132924ff5d1d17cc50641a5; echo exit=$?` → `ci green: https://github.com/SeonggukJeong/handicap/actions/runs/…`·`exit=0`
(b) `scripts/check-ci-green.sh 854a22dee875c27c3f68b9a889a958de04a5743e; echo exit=$?` → `ci failure: …` + 해소 안내·`exit=1`
(c) `scripts/check-ci-green.sh 29b34d8027e8cefe733e9c026c6886251e1d3f95; echo exit=$?` → `ci run 없음` + `gh workflow run ci --ref` 안내·`exit=1`
(d) `scripts/check-ci-green.sh 11735f43; echo exit=$?` → usage·`exit=2`
(e) `scripts/check-ci-green.sh 11735F432EF912156132924FF5D1D17CC50641A5; echo exit=$?` → usage·`exit=2`(대문자 — gh도 소문자만 매치)
(f) `--repo` 경로(CI가 실제로 타는 분기): `GITHUB_REPOSITORY=SeonggukJeong/handicap scripts/check-ci-green.sh 11735f432ef912156132924ff5d1d17cc50641a5; echo exit=$?` → `ci green: …`·`exit=0`

- [ ] **Step 3: `gh` 스텁으로 대기·정렬·실패 경로 검증 (러너 파일 1회 호출)**

스텁은 호출 번호별 fixture JSON을 **스크립트가 넘긴 `--jq` 식 그대로** `/usr/bin/jq -r`로 거른다(실 필터를 그대로 시험). Bash 가드가 `$PATH` 확장을 거부하므로 케이스 전부를 러너 파일에 넣고 **리터럴 PATH**로 부른다. Write 도구로 `/tmp/toolchain-pin-gatetest.sh`:

```bash
#!/usr/bin/env bash
# check-ci-green.sh 스텁 검증 러너(plan toolchain-pin Task 2 Step 3). 실행: bash /tmp/toolchain-pin-gatetest.sh
set -uo pipefail
G=/Users/sgj/develop/handicap/.claude/worktrees/toolchain-pin/scripts/check-ci-green.sh
D=/tmp/toolchain-pin-ghstub
SP=/tmp/toolchain-pin-ghstub/bin:/usr/bin:/bin   # 리터럴 PATH — 스텁 gh가 먼저, jq/grep/sleep은 /usr/bin·/bin
rm -rf "$D"; mkdir -p "$D/bin"
cat > "$D/bin/gh" <<'EOF'
#!/usr/bin/env bash
d=/tmp/toolchain-pin-ghstub
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/count"
[ -f "$d/fail" ] && { echo "stub: gh failure" >&2; exit 1; }
expr=""
while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && { expr="$2"; shift; }; shift; done
f="$d/$n.json"; [ -f "$f" ] || f="$d/last.json"
/usr/bin/jq -r "$expr" < "$f"
EOF
chmod +x "$D/bin/gh"
X=0123456789abcdef0123456789abcdef01234567
IP='[{"status":"in_progress","conclusion":"","createdAt":"2026-10-18T00:00:00Z","url":"u-run"}]'
OK='[{"status":"completed","conclusion":"success","createdAt":"2026-10-18T00:00:00Z","url":"u-run"}]'
reset() { rm -f "$D/count" "$D/fail" "$D"/*.json; }
run() { PATH="$SP" CI_GATE_POLL_SECONDS="$1" CI_GATE_MAX_WAIT_SECONDS="$2" "$G" "$X"; echo "exit=$?"; }

echo "== (a) 스텁이 쓰이는가"; PATH="$SP" command -v gh
echo "== (b) 대기→통과";      reset; echo "$IP" > "$D/1.json"; echo "$IP" > "$D/2.json"; echo "$OK" > "$D/last.json"; run 0 60; echo "count=$(cat "$D/count")"
echo "== (c) 대기 상한";      reset; echo "$IP" > "$D/last.json"; run 1 2
echo "== (d) 최신이 앞(최신=failure)"; reset
echo '[{"status":"completed","conclusion":"failure","createdAt":"2026-10-18T02:00:00Z","url":"u-new"},{"status":"completed","conclusion":"success","createdAt":"2026-10-18T01:00:00Z","url":"u-old"}]' > "$D/last.json"; run 0 60
echo "== (d') 최신이 뒤(최신=failure)"; reset
echo '[{"status":"completed","conclusion":"success","createdAt":"2026-10-18T01:00:00Z","url":"u-old"},{"status":"completed","conclusion":"failure","createdAt":"2026-10-18T02:00:00Z","url":"u-new"}]' > "$D/last.json"; run 0 60
echo "== (e) run 없음";       reset; echo '[]' > "$D/last.json"; run 0 60
echo "== (f) gh 실패";        reset; touch "$D/fail"; echo "$OK" > "$D/last.json"; run 0 60
rm -rf "$D"
```

Run: `bash /tmp/toolchain-pin-gatetest.sh`
Expected(plan 작성 시 같은 케이스 실측과 일치):
- (a) `/tmp/toolchain-pin-ghstub/bin/gh`
- (b) `ci in_progress — 0s 후 재조회(경과 Ns/60s): u-run` 2줄(N은 0 또는 1 — `$SECONDS` 해상도) + `ci green: u-run` · `exit=0` · `count=3`
- (c) 재조회 줄 2개 안팎 + `ci 대기 상한 2s 초과(status=in_progress): u-run …` · `exit=1`
- (d) `ci failure: u-new` · `exit=1`
- (d') `ci failure: u-new` · `exit=1`
- (e) `ci run 없음: 0123…4567` + `gh workflow run ci --ref` 안내 · `exit=1`
- (f) `stub: gh failure` + `gh run list 실패 — fail-closed …` · `exit=1`

(g) **이빨 실증(정렬)** — 두 오구현이 각각 한 케이스에서 RED가 되는지:
- 스크립트의 `sort_by(.createdAt) | last`를 Edit로 `.[-1]`로 바꿔 러너 재실행 → (d)가 `ci green: u-old`·`exit=0`(오판 = RED). 원복.
- 같은 자리를 `.[0]`으로 바꿔 러너 재실행 → (d')가 `ci green: u-old`·`exit=0`(오판 = RED). 원복.
- 원복 후 러너 재실행 → (d)(d') 둘 다 `ci failure: u-new`.

- [ ] **Step 4: 워크플로 배선 (Edit 도구)**

`.github/workflows/ci.yml` `on:` 블록을:

```yaml
on:
  push:
    branches: [main, master]
  pull_request:
  # 릴리즈 publish 게이트의 "run 없음" 해소 경로: gh workflow run ci --ref <태그>
  # (ci는 push의 head 커밋에서만 돌아, 한 push의 중간 커밋엔 run이 없다).
  workflow_dispatch:
```

`.github/workflows/release.yml` 헤더 주석 `# 구조(spec R8): preflight(버전 정합, 수 초) → … → publish(artifact 다운로드 → gh release).`의 `publish(artifact 다운로드 → gh release)`를 `publish(CI 녹색 게이트 → artifact 다운로드 → gh release)`로 바꾼다.

`publish` 잡을 다음 형태로(기존 `needs`·`if`·`runs-on`·checkout·download·Publish 스텝은 그대로, 굵은 부분만 추가):

```yaml
  publish:
    needs: [windows-installer, macos-dmg]
    if: always() && needs.windows-installer.result == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 45 # CI 게이트 대기 상한 30분 + 게시 여유
    # job-level permissions는 top-level을 통째로 대체한다 → contents: write도 다시 적는다.
    # actions: read는 CI 게이트(gh run list)용 — 서드파티 액션이 도는 빌드 잡엔 주지 않으려고 여기에만.
    permissions:
      contents: write
      actions: read
    steps:
      # 노트 파일(docs/release-notes/v<ver>.md)을 읽어야 하므로 publish도 체크아웃한다.
      - uses: actions/checkout@v5
        with:
          ref: ${{ inputs.tag || github.ref }}

      # 빨간 CI 위 릴리즈 차단(v0.9.0 사고). 게시보다 앞이라 실패 시 아무것도 안 나간다.
      # SHA는 github.sha가 아니라 checkout 후 HEAD — workflow_dispatch에서 github.sha는
      # 디스패치 브랜치 커밋이라 엉뚱한 커밋을 검사하게 된다(preflight 주석과 같은 함정).
      - name: CI green gate
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: scripts/check-ci-green.sh "$(git rev-parse HEAD)"

      - uses: actions/download-artifact@v7
        …(기존 그대로)
```

Run: `actionlint; echo exit=$?` → `exit=0`.

- [ ] **Step 5: 커밋 (cargo 경로 없음 → fast-path)**

각각 **단독 호출**로: `git add -u` → `git add scripts/check-ci-green.sh` → `git diff --cached --name-only`.
Expected staged: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/check-ci-green.sh` (3개).
Run: `git ls-files -s scripts/check-ci-green.sh` → `100755`.

메시지(`/tmp/toolchain-pin-msg2.txt`):
```
ci(release): publish 잡 CI-녹색 게이트 + ci workflow_dispatch

scripts/check-ci-green.sh가 태그 커밋의 ci 최신 run을 확인한다(진행 중이면
대기, 빨강·없음·gh 실패는 사유+해소법과 함께 실패 — 게시 전). publish 잡에
job-level actions: read, timeout 45분. ci에 workflow_dispatch를 열어 "run 없음"
해소 경로(gh workflow run ci --ref <태그>)를 만든다. spec §3.4.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
Run(단독): `git commit -F /tmp/toolchain-pin-msg2.txt` → 종료코드 0. Run(단독): `git log -1 --oneline`.

---

### Task 3: 문서 sweep

**Files:** (모두 Modify)
- `CLAUDE.md:48`
- `docs/dev/commit-gates-and-git-workflow.md:15`
- `docs/dev/tauri-desktop-build.md:11`·`:53`·`:71`·`:83`
- `docs/dev/install-rhel.md:8`·`:87`
- `docs/dev/install-rhel-airgapped.md:116`·§4.3(`:140-150`)
- `docs/dev/single-exe-build.md:236-239`
- `README.md:486`

**Interfaces:**
- Consumes: Task 1의 `scripts/check-rust-toolchain.sh`·`just bump-rust`, Task 2의 `scripts/check-ci-green.sh`(이름·동작).

규칙: **버전 숫자를 쓰지 않는다**(`rust-toolchain.toml`의 고정 버전을 가리킨다). 줄번호는 편집 직전 `grep -n`으로 재확인(앞 편집으로 밀릴 수 있다).

- [ ] **Step 1: 루트 `CLAUDE.md:48`**

48행 첫 문장부터 `…GB급 untracked 빌드가 생긴다; roadmap §B32 R-e).`까지를 다음으로 교체(뒤의 `**\`just install-hooks\`는 필수다** …`는 그대로):

```
`rust-toolchain.toml`이 **정확한 Rust 버전**을 고정하고(원천) CI 워크플로 4곳의 `dtolnay/rust-toolchain@<ver>`·`deploy/Dockerfile`의 `FROM rust:<ver>-…`가 같은 버전을 거울로 명시한다 — 로컬 pre-commit clippy = CI clippy(과거 `stable` 채널만 고정해 v0.9.0이 빨간 CI 위에서 나갔다). 승급은 **`just bump-rust <X.Y.Z>`**(6곳 검증-후-일괄기록 + 정합 검사; 새 lint는 그 승급 커밋에서 수정) — 한 곳만 손으로 고치면 ci `rust` 잡 첫 스텝 `scripts/check-rust-toolchain.sh`가 실패한다. 릴리즈 `publish` 잡은 태그 커밋의 ci 녹색을 확인한 뒤에만 게시한다(`scripts/check-ci-green.sh`). 다른 버전 시험: `CARGO_TARGET_DIR="$PWD/target/clippy-<ver>" rustup run <ver> cargo clippy --workspace --all-targets -- -D warnings`(**절대경로 필수** — 상대경로면 `cargo test`의 e2e가 워커를 빌드할 때 크레이트 디렉토리 기준으로 재해석돼 `crates/*/target/`에 GB급 untracked 빌드가 생긴다).
```

Run: `python3 scripts/check-doc-budget.py; echo exit=$?` → 마지막 줄 `OK: root …/51,200 B … FAIL 0 …`·`exit=0`(파이프 금지 — 게이트 종료코드 마스킹).

- [ ] **Step 2: `docs/dev/commit-gates-and-git-workflow.md:15`**

15행 전체(`**CI(\`ci.yml\`)의 \`dtolnay/rust-toolchain@stable\`은 항상 최신 stable을 받고, …` 문단)를 다음으로 교체:

```
**툴체인은 정확 버전으로 고정돼 있다** (toolchain-pin 2026-10-18; 이전 함정 2026-07-11·2026-10-16): 과거엔 `rust-toolchain.toml`이 `stable` 채널만 지정해 CI(`dtolnay/rust-toolchain@stable` = 실행 시점 최신 stable)와 로컬(마지막 `rustup update` 시점 stable)의 clippy가 갈렸고, 새 stable이 lint를 늘릴 때마다 **로컬 pre-commit은 통과·CI Clippy만 `-D warnings`로 red**가 됐다(1.97 `question_mark`·`manual_filter`, 1.99 `result_large_err`·`result_unit_err`·`double_must_use` — 후자는 v0.9.0이 빨간 CI 위에서 릴리즈됨). 지금은 `rust-toolchain.toml`(원천)·워크플로 4곳·`deploy/Dockerfile`이 같은 정확 버전이고 `scripts/check-rust-toolchain.sh`가 ci 첫 스텝에서 정합을 강제한다. **승급 = `just bump-rust <X.Y.Z>`** → 승급 커밋에서 pre-commit이 `rust-toolchain.toml` staged로 전체 cargo 게이트를 새 clippy로 돈다 → 새 lint는 그 커밋에서 수정. **첫 crate 에러에서 clippy가 멈추므로 한 건 고치면 뒤에 가려진 위반이 더 드러날 수 있다** — clean(exit 0)까지 반복. 승급 주기 2~3개월 또는 필요 시.
```

- [ ] **Step 3: `docs/dev/tauri-desktop-build.md`**

- `:11` `(워크스페이스 toolchain; \`rust-toolchain.toml\`이 고정)` → `(\`rust-toolchain.toml\`이 정확 버전을 고정 — rustup이 자동 선택·설치)`.
- `:53` `publish` 불릿에서 `` `download-artifact`를 `` 앞에 삽입: `먼저 **CI 녹색 게이트**(\`scripts/check-ci-green.sh "$(git rev-parse HEAD)"\` — 태그 커밋의 ci 최신 run이 success여야 통과, 진행 중이면 최대 30분 대기, 빨강·run 없음·gh 실패는 사유+해소법과 함께 실패해 아무것도 게시되지 않는다; job-level \`permissions: contents: write, actions: read\`)를 통과한 뒤 `.
- `:71` 문단 교체:

```
**릴리즈 전 master CI 녹색 확인 (보조, 2026-10-17 도입 → 2026-10-18 publish 게이트로 강제)**: `publish` 잡이 태그 커밋의 ci 녹색을 기계로 확인하므로(위 잡 그래프) 빨간 CI 위 게시는 구조적으로 막힌다(v0.9.0 사고의 재발 방지). 태그 전 `gh run list --workflow ci --branch master --limit 3`으로 미리 보면 18분 빌드 낭비를 피한다. **게이트가 "ci run 없음"으로 실패하면**: ci는 push의 head 커밋에서만 돌므로 태그가 한 push의 중간 커밋을 가리킨 경우다 → `gh workflow run ci --ref <태그>` → 녹색 확인 → 실패한 `publish` 잡만 재실행. **게이트가 배선 문제로 실패하면**(예: 권한 누락 403): master를 고친 뒤 release를 `workflow_dispatch`(입력 `tag`)로 재실행 — 워크플로 정의는 디스패치한 master 것이 쓰인다. 단 각 잡은 `ref: <태그>`를 체크아웃하므로 **`check-ci-green.sh` 스크립트 자체의 버그**는 새 태그가 필요하다. 툴체인은 `rust-toolchain.toml`의 정확 버전으로 고정돼 로컬 pre-commit clippy = CI clippy(승급은 `just bump-rust`).
```

- `:83` "소급 적용 안 됨" 불릿 끝에 문장 추가: ` 같은 이유로 CI 녹색 게이트(\`scripts/check-ci-green.sh\`) 도입 이전 태그를 재발행하면 그 트리엔 스크립트가 없어 **18분 빌드 뒤 \`publish\`에서** 실패한다(preflight가 아니라 게시 직전이라 늦게 실패).`

- [ ] **Step 4: `docs/dev/install-rhel.md`**

- `:8` `- **Rust** stable (edition 2024 / MSRV 1.85) — \`rust-toolchain.toml\`이 채널·컴포넌트 고정` → `- **Rust** — \`rust-toolchain.toml\`이 정확 버전·컴포넌트 고정(edition 2024 / MSRV 1.85)`.
- `:87` `\`rust-toolchain.toml\`이 stable + rustfmt + clippy를 고정하므로, 이후 \`cargo\` 호출만으로 올바른 toolchain을 잡는다.` → `\`rust-toolchain.toml\`이 정확한 Rust 버전 + rustfmt + clippy를 고정하므로, 레포 안에서 \`cargo\`를 처음 호출하면 rustup이 그 버전을 자동 설치·선택한다(위 \`--default-toolchain stable\`은 레포 밖 기본값일 뿐).`

- [ ] **Step 5: `docs/dev/install-rhel-airgapped.md`**

- `:116` 불릿 끝에 추가: ` — 미러에 \`rust-toolchain.toml\`의 **정확한 버전**이 있어야 한다(\`stable\` 채널만 미러링하면 고정 버전과 어긋나 설치 실패).`
- §4.3 첫 문장 `가장 간단한 방법은 연결 머신의 \`~/.rustup\` + \`~/.cargo\`를 통째로 옮기는 것:` 바로 앞에 문단 삽입:

```
**레포는 정확한 Rust 버전을 고정한다**(`rust-toolchain.toml`의 `channel`) — 연결 머신의 기본 `stable`이 그 버전과 다르면 반입한 `~/.rustup`엔 필요한 툴체인이 없어 폐쇄망 빌드가 실패한다. 아카이브 **전에** 연결 머신의 레포 루트에서 `rustup toolchain install "$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)" --component rustfmt --component clippy`를 실행한다(버전 승급 때마다 아카이브를 다시 만든다).
```

- [ ] **Step 6: `docs/dev/single-exe-build.md:236-239`**

```yaml
      - name: Setup Rust (stable-msvc)
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: stable-x86_64-pc-windows-msvc
```
→
```yaml
      # 버전은 레포 rust-toolchain.toml의 고정 버전과 같게(정합은 scripts/check-rust-toolchain.sh가 .github/workflows만 검사 — 이 샘플은 대상 아님).
      - name: Setup Rust (MSVC)
        uses: dtolnay/rust-toolchain@<rust-toolchain.toml의 channel>
```

(`windows-latest`의 기본 호스트가 MSVC라 `toolchain:` 입력 불필요 — release.yml의 windows 잡도 입력 없이 MSVC로 빌드한다.)

- [ ] **Step 7: `README.md:486`**

`# 요구: Rust stable (edition 2024 / MSRV 1.85) + protoc + just + Node≥20/pnpm` → `# 요구: rustup(rust-toolchain.toml의 고정 버전을 자동 설치) + protoc + just + Node≥20/pnpm`.

- [ ] **Step 8: sweep 검증**

Run: `grep -rn 'dtolnay/rust-toolchain@stable\|채널(`stable`)만\|stable만 고정\|`stable`만\|stable (edition\|stable + rustfmt + clippy를 고정\|B32 R-e(미결정)\|워크스페이스 toolchain' CLAUDE.md README.md docs/dev/`
Expected: **정확히 1줄** — `docs/dev/commit-gates-and-git-workflow.md:15`(Step 2 교체문의 과거형 이력 서술 "`dtolnay/rust-toolchain@stable` = 실행 시점 최신 stable"). 그 외 매치는 sweep 누락. (plan 작성 시 baseline 실측 = 8줄: `README.md:486`·`CLAUDE.md:48`·`tauri-desktop-build.md:11`·`:71`·`commit-gates…:15`·`install-rhel.md:8`·`:87`·`single-exe-build.md:237`.)

삽입형 편집은 옛 문자열이 없어 위 grep으로 누락을 못 잡는다 → 양성 검사(각각 1줄 이상 매치):
Run: `grep -n "아카이브 \*\*전에\*\*" docs/dev/install-rhel-airgapped.md` (§4.3 삽입)
Run: `grep -n "정확한 버전" docs/dev/install-rhel-airgapped.md` (`:116` 추가 — 정확히 1줄; §4.3 문단은 "정확한 Rust 버전"이라 미매치, 위 `아카이브 **전에**`가 담당)
Run: `grep -n "CI 녹색 게이트" docs/dev/tauri-desktop-build.md` (`:53` 삽입)
Run: `grep -n "18분 빌드 뒤" docs/dev/tauri-desktop-build.md` (`:83` 추가)

Run: `grep -rnE "1\.99\.[0-9]" CLAUDE.md README.md docs/dev/; echo exit=$?`
Expected: 매치 0줄·`exit=1`(baseline도 0줄 — 이 검사는 *새로 들어간* 버전 리터럴만 잡는 가드다; Global Constraints "버전 리터럴 금지").

Run: `python3 scripts/check-doc-budget.py; echo exit=$?` → `FAIL 0`·`exit=0`.

- [ ] **Step 9: 커밋 (docs-only fast-path)**

각각 **단독 호출**로: `git add -u` → `git diff --cached --name-only`.
Expected staged: `CLAUDE.md`, `README.md`, `docs/dev/commit-gates-and-git-workflow.md`, `docs/dev/install-rhel-airgapped.md`, `docs/dev/install-rhel.md`, `docs/dev/single-exe-build.md`, `docs/dev/tauri-desktop-build.md` (7개).

메시지(`/tmp/toolchain-pin-msg3.txt`):
```
docs: 툴체인 정확 고정·bump-rust·publish CI 게이트 반영

"stable 채널만 고정" 서술을 정확 버전 고정(버전 리터럴 없이 rust-toolchain.toml
지시)·just bump-rust·check-rust-toolchain.sh·check-ci-green.sh로 교체. 에어갭
설치는 아카이브 전 고정 버전 설치, 게이트 "run 없음" 해소법·소급 불가 명시.
(crates/worker-core/tests/error_size.rs:2의 "stable만 고정" 주석은 그 테스트가
생긴 시점의 이력 서술이라 그대로 둔다.)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
Run(단독): `git commit -F /tmp/toolchain-pin-msg3.txt` → 종료코드 0. Run(단독): `git log -1 --oneline`.

---

## 머지 후 실측 (finish-slice에서)

- master push 후 `gh run list --workflow ci --branch master --limit 1` → success, 그 run 로그에 `Toolchain pin consistency` `ok` 6줄 + `Effective toolchain`의 `rustc 1.99.1`(US1·US2·US4 증명). 확인: `gh run view <id> --log | grep -E "^.*(ok        |rustc 1\.)"`.
- release 경로(US3·Windows pwsh `&&`·Docker `rustc --version`)는 다음 실제 태그/이미지 빌드에서 — build-log에 "미실측, 다음 릴리즈에서 확인"으로 기록. 시험용 태그를 만들지 않는다.
- roadmap §B32 R-e 해소 · 현황판 데스크톱·릴리즈 행 frontier 전진 · build-log 단락 · MEMORY 활성 작업 갱신.
