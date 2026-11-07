#!/usr/bin/env bash
# handicap-tui Linux x86_64 빌드 (glibc 2.27 심볼 상한 — Ubuntu 19.04 대상).
# 검증된 도구 버전: zig 0.17.1 / cargo-zigbuild 0.24.1 (아래 상수).
# 산출물: target/x86_64-unknown-linux-gnu/release/handicap-tui
# 게이트: scripts/tui-linux-gates.sh <binary> (Linux 안에서 실행)
set -euo pipefail
ZIG_WANT="0.17.1"
ZBUILD_WANT="0.24.1"
cd "$(dirname "$0")/.."
zig_have="$(zig version 2>/dev/null || echo missing)"
zb_have="$(cargo-zigbuild --version 2>/dev/null | awk '{print $2}' || true)"
[ "$zig_have" = "$ZIG_WANT" ] || echo "경고: zig $zig_have (검증 버전 $ZIG_WANT)" >&2
[ "$zb_have" = "$ZBUILD_WANT" ] || echo "경고: cargo-zigbuild ${zb_have:-missing} (검증 버전 $ZBUILD_WANT)" >&2
# TUI_GLIBC 로 접미사 재정의 가능(게이트 이빨 실증용); 기본 2.27.
cargo zigbuild --release -p handicap-tui --target "x86_64-unknown-linux-gnu.${TUI_GLIBC:-2.27}"
