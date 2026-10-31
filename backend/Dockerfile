FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /project
ENTRYPOINT ["python3", "scripts/build_native.py"]
