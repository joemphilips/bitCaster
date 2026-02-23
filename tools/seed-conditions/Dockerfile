FROM rust:1.85-bookworm AS builder

WORKDIR /build

# Copy CDK source (needed as path dependency)
COPY cdk/ cdk/

# Copy seed tool
COPY tools/seed-conditions/ tools/seed-conditions/

WORKDIR /build/tools/seed-conditions
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/tools/seed-conditions/target/release/seed-conditions /usr/local/bin/seed-conditions
ENTRYPOINT ["seed-conditions"]
