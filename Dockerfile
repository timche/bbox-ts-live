# syntax=docker/dockerfile:1

# ---- Build stage: compile a single self-contained binary with Bun ----
FROM oven/bun:1 AS build
WORKDIR /app

# Install dependencies against the lockfile first for better layer caching.
# --ignore-scripts skips the `prepare` (lefthook install) hook, which needs a
# .git dir that isn't present in the build context.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Compile the app into a standalone executable that embeds the Bun runtime,
# so the runtime image needs neither Bun nor node_modules. The `build` script
# marks `cpu-features` (an optional ssh2 native addon that isn't built here)
# external so the bundler doesn't resolve the missing `.node` binary.
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- Runtime stage: minimal glibc base with just the binary ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# No ca-certificates needed: the watcher reaches Broadcast Box over the private
# network via plain HTTP (TLS is terminated at the reverse proxy for public
# traffic), and Bun's compiled binary bundles its own root store for the rare
# case that BROADCAST_BOX_API_URL points at a public-CA HTTPS endpoint.
COPY --from=build /app/teamspeak-stream-live /usr/local/bin/teamspeak-stream-live

# Run as the non-root user provided by the base image.
USER nobody

ENTRYPOINT ["/usr/local/bin/teamspeak-stream-live"]
