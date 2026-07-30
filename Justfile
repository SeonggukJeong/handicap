default: build

build:
    cargo build --workspace

test:
    cargo test --workspace

fmt:
    cargo fmt --all

lint:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

# Install the version-controlled git hooks (run once per fresh clone).
# Points core.hooksPath at the tracked .githooks/ dir so the layered pre-commit
# gate travels with the repo instead of living only in the untracked .git/hooks/.
# Relative path → resolves per-worktree, so every worktree gets the gate too.
install-hooks:
    git config core.hooksPath .githooks
    chmod +x .githooks/*
    @echo "git hooks installed (core.hooksPath=.githooks)"

run-controller:
    RUST_LOG=info,handicap_controller=debug,handicap_engine=debug cargo run -p handicap-controller --bin controller -- --db ./handicap.db --rest 127.0.0.1:8080 --grpc 127.0.0.1:8081 --worker-bin target/debug/worker

# Direct worker run for manual testing (controller normally spawns it)
run-worker run_id worker_id:
    RUST_LOG=info,handicap_worker=debug,handicap_engine=debug cargo run -p handicap-worker -- --controller http://127.0.0.1:8081 --run-id {{run_id}} --worker-id {{worker_id}}

ui-install:
    cd ui && pnpm install --frozen-lockfile

ui-dev:
    cd ui && pnpm dev

ui-build:
    cd ui && pnpm build

ui-lint:
    cd ui && pnpm lint

ui-test:
    cd ui && pnpm test

# Run the controller with the UI dir set (build the UI first if needed).
run-controller-with-ui:
    @if [ ! -f ui/dist/index.html ]; then just ui-build; fi
    RUST_LOG=info,handicap=debug cargo run -p handicap-controller --bin controller -- \
      --db ./handicap.db \
      --rest 127.0.0.1:8080 \
      --grpc 127.0.0.1:8081 \
      --worker-bin target/debug/worker \
      --ui-dir ui/dist

build-image image='handicap:dev':
    IMAGE={{image}} ./scripts/build-image.sh

helm-lint:
    helm lint deploy/helm/handicap

chart-snapshot:
    ./deploy/helm/handicap/tests/snapshot_test.sh

deploy-kind:
    ./scripts/deploy-kind.sh

e2e-kind:
    ./scripts/e2e-kind.sh

kind-down:
    kind delete cluster --name handicap

bench-throughput vus='200' duration='30':
    VUS={{vus}} DURATION={{duration}} ./scripts/bench-throughput.sh

# 릴리즈 버전 bump: 사람이 맞추는 3개 파일 + 생성물 락 2개 + 정합 검사(R7).
# 커밋·태그·push는 하지 않는다(사람이 확인 후 수행).
bump-version ver:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 - "{{ver}}" <<'PY'
    import pathlib, re, sys
    ver = sys.argv[1]
    assert re.fullmatch(r'\d+\.\d+\.\d+', ver), f"bad version: {ver!r} (v 접두·prerelease 불가, 예: 0.8.0)"

    def toml_section_set(path, section):
        p = pathlib.Path(path)
        s = p.read_text()
        m = re.search(r'^\[' + re.escape(section) + r'\][^\[]*', s, re.M)
        assert m, f"{path}: [{section}] 섹션 없음"
        pat = r'^version\s*=\s*"[^"]*"'
        # 개수를 먼저 센다 — subn(count=1)의 n은 최대 1이라 *중복*을 못 잡는다.
        hits = len(re.findall(pat, m.group(0), re.M))
        assert hits == 1, f"{path}: [{section}] 안 version 줄이 {hits}개(1개여야 함)"
        block = re.sub(pat, f'version = "{ver}"', m.group(0), count=1, flags=re.M)
        p.write_text(s[:m.start()] + block + s[m.end():])
        print(f"  {path} [{section}] -> {ver}")

    toml_section_set("Cargo.toml", "workspace.package")
    toml_section_set("desktop/src-tauri/Cargo.toml", "package")

    conf = pathlib.Path("desktop/src-tauri/tauri.conf.json")
    s = conf.read_text()
    vpat = r'("version"\s*:\s*)"[^"]*"'
    vhits = len(re.findall(vpat, s))
    assert vhits == 1, f'tauri.conf.json: "version" 키가 {vhits}개(1개여야 함)'
    s2 = re.sub(vpat, lambda m: m.group(1) + f'"{ver}"', s, count=1)
    conf.write_text(s2)
    print(f"  desktop/src-tauri/tauri.conf.json -> {ver}")
    PY
    echo "락 재생성…"
    cargo metadata --format-version 1 >/dev/null
    cargo metadata --manifest-path desktop/src-tauri/Cargo.toml --format-version 1 >/dev/null
    scripts/check-release-versions.sh "v{{ver}}"
    echo
    echo "다음: git add -u && git commit -m 'chore(release): {{ver}} 버전 bump' && git tag -a v{{ver}} && git push origin master v{{ver}}"

# root CLAUDE.md 재분배 이동 검증(R6·R16·R17·R18): manifest 선언 대비 실제 이동·불릿 비감소·토큰 차분.
doc-coverage BASE="17369d32":
    python3 scripts/check-doc-coverage.py {{BASE}}
