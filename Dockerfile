# syntax=docker/dockerfile:1

# ---------- Build stage ----------
# Compiles the (patched) Moonlight Web server for Linux from src/.
FROM rust:bookworm AS builder

WORKDIR /build

# rust-toolchain.toml pins the exact toolchain; rustup installs it automatically.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src

RUN cargo build --release

# ---------- Runtime stage ----------
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Linux server binary built above
COPY --from=builder /build/target/release/web-server /app/web-server
# Prebuilt web frontend served by the server (release mode -> "static")
COPY static /app/static

# Railway injects $PORT; default to 8080 for local runs
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "BIND_ADDRESS=0.0.0.0:${PORT:-8080} exec ./web-server"]
