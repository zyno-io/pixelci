# Deployment Guide

This guide covers self-hosting PixelCI — the API/UI server, background workers, and required infrastructure.

## Prerequisites

- **PostgreSQL 15+** — stores apps, builds, branches, screens, and user data
- **Redis** — job queue (BullMQ) and caching
- **S3-compatible storage** — screenshots and diff images (AWS S3, MinIO, SeaweedFS, etc.)

## Docker Quick Start

**1. Start the server**

```bash
docker run -d \
  --name pixelci \
  -p 7924:7924 \
  -e APP_ENV=production \
  -e ENABLE_JOB_RUNNER=true \
  -e AUTH_JWT_SECRET=your-secret-key \
  -e REDIS_HOST=redis \
  -e REDIS_PREFIX=pixelci \
  -e PG_HOST=postgres \
  -e PG_USER=pixelci \
  -e PG_PASSWORD_SECRET=your-password \
  -e PG_DATABASE=pixelci \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_ACCESS_KEY_ID=your-access-key \
  -e S3_ACCESS_SECRET=your-secret-key \
  -e S3_BUCKET=pixelci \
  ghcr.io/zyno-io/pixelci:latest
```

Setting `ENABLE_JOB_RUNNER=true` makes the server also process build comparison jobs. For production deployments with higher throughput, you can run a [separate worker process](#separate-worker-process) instead.

**2. Run database migrations**

```bash
docker exec pixelci node . migrate:run
```

**3. Access the web interface**

Visit `http://localhost:7924`. On first launch, the onboarding wizard will guide you through creating your first VCS integration and logging in.

## Docker Compose

A complete setup with PostgreSQL, Redis, and PixelCI:

```yaml
services:
    pixelci:
        image: ghcr.io/zyno-io/pixelci:latest
        ports:
            - '7924:7924'
        environment:
            APP_ENV: production
            ENABLE_JOB_RUNNER: 'true'
            AUTH_JWT_SECRET: your-secret-key
            REDIS_HOST: redis
            REDIS_PREFIX: pixelci
            PG_HOST: postgres
            PG_USER: pixelci
            PG_PASSWORD_SECRET: your-password
            PG_DATABASE: pixelci
            S3_ENDPOINT: https://s3.amazonaws.com
            S3_REGION: us-east-1
            S3_ACCESS_KEY_ID: your-access-key
            S3_ACCESS_SECRET: your-secret-key
            S3_BUCKET: pixelci
        depends_on:
            postgres:
                condition: service_healthy
            redis:
                condition: service_healthy

    postgres:
        image: postgres:18
        environment:
            POSTGRES_USER: pixelci
            POSTGRES_PASSWORD: your-password
            POSTGRES_DB: pixelci
        volumes:
            - postgres-data:/var/lib/postgresql
        healthcheck:
            test: ['CMD-SHELL', 'pg_isready -U pixelci -d pixelci']
            interval: 5s
            timeout: 3s
            retries: 10

    redis:
        image: redis:7-alpine
        healthcheck:
            test: ['CMD', 'redis-cli', 'ping']
            interval: 5s
            timeout: 3s
            retries: 10

volumes:
    postgres-data:
```

After starting:

```bash
docker compose up -d
docker compose exec pixelci node . migrate:run
```

Then visit `http://localhost:7924`. The onboarding wizard will guide you through initial setup.

## Running Migrations

Migrations must be run whenever you deploy a new version:

```bash
# Docker
docker exec pixelci node . migrate:run

# Docker Compose
docker compose exec pixelci node . migrate:run

# Kubernetes
kubectl exec deploy/pixelci-server -- node . migrate:run
```

## Environment Variable Reference

### General

| Variable  | Required | Default | Description                                                |
| --------- | -------- | ------- | ---------------------------------------------------------- |
| `APP_ENV` | Yes      | —       | Environment name (use `production` for deployed instances) |

### Authentication

| Variable          | Required | Default | Description                      |
| ----------------- | -------- | ------- | -------------------------------- |
| `AUTH_JWT_SECRET` | Yes      | —       | Secret key for JWT token signing |

### PostgreSQL

| Variable                     | Required | Default | Description                                            |
| ---------------------------- | -------- | ------- | ------------------------------------------------------ |
| `PG_HOST`                    | Yes      | —       | PostgreSQL server hostname                             |
| `PG_PORT`                    | No       | `5432`  | PostgreSQL server port                                 |
| `PG_USER`                    | Yes      | —       | PostgreSQL username                                    |
| `PG_PASSWORD_SECRET`         | Yes      | —       | PostgreSQL password                                    |
| `PG_DATABASE`                | Yes      | —       | PostgreSQL database name (uses the `public` schema)    |
| `PG_SSL`                     | No       | `false` | Connect over TLS                                       |
| `PG_SSL_REJECT_UNAUTHORIZED` | No       | `true`  | Verify the server certificate when `PG_SSL` is enabled |
| `PG_CONNECTION_LIMIT`        | No       | `10`    | Maximum pooled connections (`5` outside production)    |
| `PG_IDLE_TIMEOUT_SECONDS`    | No       | `60`    | Idle connection timeout (`5` outside production)       |

PixelCI creates its tables at startup (migrations) and at runtime (the job queue's `_jobs` table), so `PG_USER` needs `CREATE` on the `public` schema. On PostgreSQL 15+ only the database owner has that by default; the simplest setup is `CREATE DATABASE pixelci OWNER pixelci;`. PixelCI expects the server default `READ COMMITTED` isolation level.

### Redis

| Variable              | Required | Default      | Description                                           |
| --------------------- | -------- | ------------ | ----------------------------------------------------- |
| `REDIS_HOST`          | Yes\*    | —            | Redis server hostname                                 |
| `REDIS_PORT`          | No       | `6379`       | Redis server port                                     |
| `REDIS_PREFIX`        | No       | package name | Prefix for all Redis keys (recommended: `pixelci`)    |
| `REDIS_SENTINEL_HOST` | Yes\*    | —            | Redis Sentinel hostname (alternative to `REDIS_HOST`) |
| `REDIS_SENTINEL_PORT` | No       | `26379`      | Redis Sentinel port                                   |
| `REDIS_SENTINEL_NAME` | Yes\*    | —            | Redis Sentinel master name (required with sentinel)   |

\* Provide either `REDIS_HOST` or `REDIS_SENTINEL_HOST` + `REDIS_SENTINEL_NAME`.

### S3 Storage

| Variable           | Required | Default | Description     |
| ------------------ | -------- | ------- | --------------- |
| `S3_ENDPOINT`      | Yes      | —       | S3 endpoint URL |
| `S3_REGION`        | Yes      | —       | S3 region       |
| `S3_ACCESS_KEY_ID` | Yes      | —       | S3 access key   |
| `S3_ACCESS_SECRET` | Yes      | —       | S3 secret key   |
| `S3_BUCKET`        | Yes      | —       | S3 bucket name  |

### Workers

| Variable            | Required | Default | Description                                 |
| ------------------- | -------- | ------- | ------------------------------------------- |
| `ENABLE_JOB_RUNNER` | No       | `false` | Enable the job runner on the server process |

### Access Control

By default, PixelCI filters app reads (both the web UI and the [`/api/ext` API](/llm-access#rest-api)) by whether the requesting user or token can access the app's project in the VCS provider — so users only see the apps their GitLab or GitHub account can access. The API server needs outbound HTTPS to your VCS provider (GitLab, or `github.com` / `api.github.com` for GitHub).

::: warning
On github.com, any GitHub user with access to an installation of your GitHub App can log in. Combined with `ENFORCE_VCS_PROJECT_ACCESS=false`, that makes public read open to them. Keep enforcement on for private deployments.
:::

| Variable                     | Required | Default | Description                                                                                                                                                |
| ---------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENFORCE_VCS_PROJECT_ACCESS` | No       | `true`  | Gate app reads by VCS project access. Set `false` to make every authenticated user able to read every app (e.g. for environments without a reachable VCS). |

### Tuning

| Variable                           | Required | Default | Description                                                                                                                                                                   |
| ---------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_PIXEL_MATCH_THRESHOLD`    | No       | `0.2`   | Per-pixel color sensitivity for comparison (0–1, smaller = more sensitive). Higher values reduce false positives from sub-pixel text rendering and anti-aliasing differences. |
| `DEFAULT_PIXEL_DIFF_PCT_THRESHOLD` | No       | `1`     | Percentage of total pixels that must differ to flag a screen as changed (e.g. `0.5` for 0.5%)                                                                                 |

## Architecture Overview

PixelCI uses a single Docker image (`ghcr.io/zyno-io/pixelci`) for all components. Build comparison jobs are processed by a worker, which can run either within the server process or as a separate process.

### Single-process mode

Set `ENABLE_JOB_RUNNER=true` on the server. The server handles both HTTP requests and background jobs. This is the simplest setup and works well for most teams.

### Separate worker process

For higher throughput or to isolate job processing from the API, run the worker as a separate container using the same image with a different command:

```bash
docker run -d \
  --name pixelci-worker \
  -e APP_ENV=production \
  -e AUTH_JWT_SECRET=your-secret-key \
  -e REDIS_HOST=redis \
  -e REDIS_PREFIX=pixelci \
  -e PG_HOST=postgres \
  -e PG_USER=pixelci \
  -e PG_PASSWORD_SECRET=your-password \
  -e PG_DATABASE=pixelci \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_ACCESS_KEY_ID=your-access-key \
  -e S3_ACCESS_SECRET=your-secret-key \
  -e S3_BUCKET=pixelci \
  ghcr.io/zyno-io/pixelci:latest \
  node . worker:start
```

When using a separate worker, do **not** set `ENABLE_JOB_RUNNER` on the server.

## Kubernetes

For Kubernetes deployments, you can either:

- **Single-process**: One Deployment with `ENABLE_JOB_RUNNER=true`, exposed via a Service/Ingress on port 7924
- **Separate worker**: Two Deployments sharing the same image — the server (default command) and a worker (override command to `node . worker:start`)

Run migrations via `kubectl exec` against the server deployment after each upgrade:

```bash
kubectl exec deploy/pixelci-server -- node . migrate:run
```

All deployments share the same environment variables. Use Kubernetes Secrets for sensitive values (`AUTH_JWT_SECRET`, `PG_PASSWORD_SECRET`, S3 credentials).
