# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build UI ----------
FROM node:20-bookworm AS ui-build
WORKDIR /work
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ./ui/
WORKDIR /work/ui
RUN pnpm install --frozen-lockfile
COPY ui/ ./
# Monaco editor + Recharts push Vite's chunk renderer past Node's default 2 GiB
# old-space limit; bump to 4 GiB so `vite build` doesn't OOM (heap limit hit
# during rendering chunks, exit 134). Docker Desktop has 7.75 GiB total so
# there's headroom.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build
# Verify dist exists (fail fast if Vite produced nothing).
RUN test -f dist/index.html

# ---------- Stage 2: build Rust ----------
FROM rust:1.85-bookworm AS rust-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler ca-certificates pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ ./crates/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/work/target \
    cargo build --release -p handicap-controller -p handicap-worker \
    && mkdir -p /out \
    && cp target/release/controller /out/controller \
    && cp target/release/worker /out/worker

# ---------- Stage 3: runtime ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 nonroot \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin nonroot
COPY --from=rust-build /out/controller /usr/local/bin/controller
COPY --from=rust-build /out/worker /usr/local/bin/worker
COPY --from=ui-build /work/ui/dist /srv/ui
USER 65532:65532
# No CMD / ENTRYPOINT — callers (K8s Deployment, K8s Job) specify `command:`.
