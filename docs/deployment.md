# Deployment Guide

This guide covers self-hosting PixelCI — the API/UI server, background workers, and required infrastructure.

## Prerequisites

- **PostgreSQL 15+** — stores apps, builds, branches, screens, and user data
- **Redis** — job queue (BullMQ) and caching
- **S3-compatible storage** — screenshots and diff images (AWS S3, MinIO, SeaweedFS, etc.)

## Docker Quick Start

**1. Start the server**

```bash
# Generate the setup token and keep it: you type it into the onboarding wizard
SETUP_TOKEN=$(openssl rand -hex 32)
echo "$SETUP_TOKEN"

# Generate the secret that encrypts VCS secrets at rest ONCE, and save it (see "Secrets Encryption" below).
# Never regenerate it: a new secret cannot decrypt what the old one encrypted.
[ -f pixelci-secrets.env ] || echo "CRYPTO_SECRET=$(openssl rand -hex 32)" > pixelci-secrets.env
. ./pixelci-secrets.env

docker run -d \
  --name pixelci \
  -p 7924:7924 \
  -e APP_ENV=production \
  -e ENABLE_JOB_RUNNER=true \
  -e AUTH_JWT_SECRET=your-secret-key \
  -e PUBLIC_URL=https://pixelci.example.com \
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
  -e SETUP_TOKEN="$SETUP_TOKEN" \
  -e CRYPTO_SECRET="$CRYPTO_SECRET" \
  ghcr.io/zyno-io/pixelci:latest
```

`PUBLIC_URL` is the address users reach PixelCI at (for a local trial, `http://localhost:7924`). The OAuth callback you register with GitLab or GitHub must be exactly `${PUBLIC_URL}/login`.

Setting `ENABLE_JOB_RUNNER=true` makes the server also process build comparison jobs. For production deployments with higher throughput, you can run a [separate worker process](#separate-worker-process) instead.

**2. Run database migrations**

```bash
docker exec pixelci node . migrate:run
```

**3. Access the web interface**

Visit `http://localhost:7924`. On first launch, the onboarding wizard asks for your `SETUP_TOKEN` and guides you through creating your first VCS integration and logging in.

## Docker Compose

A complete setup with PostgreSQL, Redis, and PixelCI:

Set `SETUP_TOKEN` and `CRYPTO_SECRET` in an `.env` file next to the compose file. Generate each value once, write it into the file, and keep a copy elsewhere; never regenerate `CRYPTO_SECRET` (see [Secrets Encryption](#secrets-encryption)):

```bash
grep -q "^SETUP_TOKEN=" .env 2>/dev/null || echo "SETUP_TOKEN=$(openssl rand -hex 32)" >> .env
grep -q "^CRYPTO_SECRET=" .env 2>/dev/null || echo "CRYPTO_SECRET=$(openssl rand -hex 32)" >> .env
```

```yaml
services:
    pixelci:
        image: ghcr.io/zyno-io/pixelci:latest
        ports:
            - '7924:7924'
        environment:
            APP_ENV: production
            ENABLE_JOB_RUNNER: 'true'
            SETUP_TOKEN: ${SETUP_TOKEN}
            CRYPTO_SECRET: ${CRYPTO_SECRET}
            AUTH_JWT_SECRET: your-secret-key
            PUBLIC_URL: https://pixelci.example.com
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

Then visit `http://localhost:7924`. The onboarding wizard (which asks for `SETUP_TOKEN`) will guide you through initial setup.

## Kubernetes (Helm)

The chart in [`resources/helm/chart`](https://github.com/zyno-io/pixelci/tree/main/resources/helm/chart) runs the API server and a worker as separate Deployments, and runs migrations in a pre-upgrade job. Its defaults point at nothing, so supply your own values:

```yaml
image: ghcr.io/zyno-io/pixelci:<version>
ingress:
    host: pixelci.example.com
    tls:
        enabled: true
        secretName: pixelci-tls
env:
    PUBLIC_URL: https://pixelci.example.com
    REDIS_HOST: redis
    REDIS_PREFIX: pixelci
    PG_HOST: postgres
    PG_USER: pixelci
    PG_DATABASE: pixelci
    S3_ENDPOINT: https://s3.amazonaws.com
    S3_REGION: us-east-1
    S3_BUCKET: pixelci
secret:
    # Existing Secret holding CRYPTO_SECRET, AUTH_JWT_SECRET, SETUP_TOKEN,
    # PG_PASSWORD_SECRET, S3_ACCESS_KEY_ID and S3_ACCESS_SECRET.
    name: pixelci-secrets
```

```bash
helm upgrade --install pixelci resources/helm/chart -f my-values.yaml
```

Resource requests and limits default to sizes measured on a production instance. Both the server (review previews, thumbnails) and the worker (comparisons) decode full screenshots, so if yours are near the 25 MP cap, raise `resources.limits.memory` and `worker.resources.limits.memory`.

## Running Migrations

Migrations must be run whenever you deploy a new version:

```bash
# Docker
docker exec pixelci node . migrate:run

# Docker Compose
docker compose exec pixelci node . migrate:run

# Kubernetes without the Helm chart (the chart runs them for you)
kubectl exec deploy/<server deployment> -- node . migrate:run
```

Some upgrades migrate data the new version depends on (for example, encrypting stored VCS secrets). To avoid errors between starting the new version and migrating, run the migrations with the new image before starting it, with the same environment as the server:

```bash
# Docker
docker run --rm --env-file pixelci.env ghcr.io/zyno-io/pixelci:<new version> node . migrate:run

# Docker Compose (after updating the image tag)
docker compose run --rm pixelci node . migrate:run && docker compose up -d
```

The Helm chart does this for you: it runs the migrations in a pre-upgrade job.

## Environment Variable Reference

### General

| Variable  | Required | Default | Description                                                |
| --------- | -------- | ------- | ---------------------------------------------------------- |
| `APP_ENV` | Yes      | —       | Environment name (use `production` for deployed instances) |

### Authentication

| Variable                        | Required | Default | Description                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_JWT_SECRET`               | Yes      | —       | Secret key for JWT token signing (also used to sign the OAuth login state)                                                                                                                                                                                                                                                         |
| `PUBLIC_URL`                    | Yes      | —       | Public origin of PixelCI, e.g. `https://pixelci.example.com` (no path). Login fails without it. The OAuth callback registered with GitLab or GitHub must be exactly `${PUBLIC_URL}/login`. It is also the issuer of PixelCI's own [MCP OAuth server](#mcp-oauth): `https` is required for that (plain `http` only on `localhost`). |
| `GITLAB_JOB_TOKEN_AUTH_ENABLED` | No       | `true`  | Accept GitLab `CI_JOB_TOKEN`s (validated by calling GitLab's `/api/v4/job`). Set `false` to accept only [GitLab ID tokens](gitlab-setup.md) (`id_tokens: PIXELCI_ID_TOKEN`); job tokens then get a 401 and are never sent to GitLab                                                                                                |
| `GITLAB_ID_TOKEN_AUDIENCES`     | No       | —       | Extra accepted `aud` values for GitLab ID tokens, comma-separated. The `PUBLIC_URL` origin is always accepted; add others when the CLI's `PIXELCI_API_URL` differs from it. Each is accepted with or without a trailing slash                                                                                                      |

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

Redis also backs the rate limits on the [MCP OAuth](#mcp-oauth) endpoints. If it is unreachable the limits fail open (requests are allowed and a warning is logged).

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

### First-run Setup

| Variable      | Required           | Default | Description                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN` | Yes, for first run | unset   | Secret you type into the onboarding wizard to create the first VCS integration and to claim the first admin account. At least 16 characters; unset or shorter disables first-run setup. Keep it set until the first admin exists (the first login with the token claims admin); after that you can remove it. |

Without this token, anyone who can reach a fresh instance could register their own VCS integration and become admin, so setup is refused until it is configured.

### Secrets Encryption

| Variable        | Required | Default | Description                                                                                  |
| --------------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `CRYPTO_SECRET` | Yes      | unset   | Key for encrypting VCS secrets at rest (AES-256-GCM): a 32-byte string or 64 hex characters. |

PixelCI encrypts these fields in the database: each VCS integration's `clientSecret` and GitHub App `privateKey`, and each user's stored VCS session tokens (access and refresh). Without the secret, a database dump or backup does not reveal them.

`CRYPTO_SECRET` is required in every environment: the server, worker and `migrate:run` refuse to start without it. The `encrypt_secrets` migration encrypts any secrets already in the database when it first runs.

Generate a secret once (use your own; never reuse a secret from an example or from `.env.development`):

```bash
openssl rand -hex 32
```

Save the output straight into your secret manager or `.env` file. **Do not regenerate it** (for example by re-running a command that builds it inline): a new secret silently replaces the old one and everything already encrypted becomes unreadable. Back it up separately from the database: the database alone cannot be decrypted without it. Every process that runs PixelCI (server, separate worker, migration jobs) needs the same value.

Key rotation is not supported yet.

**If the secret is lost**

Encrypted values cannot be recovered. Until the integration secrets are replaced, nobody can sign in: every sign-in needs the integration's client secret, so the admin UI is out of reach too. Recover from the command line:

1. Set a new `CRYPTO_SECRET` everywhere (server, worker, migration jobs).
2. Store each integration's secrets again, using the values from your GitLab application or GitHub App. Find the integration ids with `SELECT id, name, platform FROM "vcsIntegrations";`. The value is read from stdin and encrypted with the new secret; it is never printed:

    ```bash
    # GitLab and GitHub: the OAuth client secret
    printf '%s' '<client secret>' | node . secrets:set-integration <integration id> clientSecret
    # GitHub App only: the private key (PEM)
    node . secrets:set-integration <integration id> privateKey < key.pem
    ```

3. Clear all stored user sessions, which the old secret encrypted. Users sign in again; nothing else is lost:

    ```sql
    UPDATE users SET "vcsSession" = NULL WHERE "vcsSession" IS NOT NULL;
    ```

Until step 2 is done, anything that needs an integration fails with a server error, and the log names the integration (never the secret). An admin who is still signed in can instead re-enter the secrets under **VCS Integrations** (admin menu): an integration whose stored secrets cannot be decrypted accepts an update that supplies every unreadable value.

### Access Control

By default, PixelCI filters app reads (both the web UI and the [`/api/ext` API](/llm-access#rest-api)) by whether the requesting user or token can access the app's project in the VCS provider — so users only see the apps their GitLab or GitHub account can access. The API server needs outbound HTTPS to your VCS provider (GitLab, or `github.com` / `api.github.com` for GitHub).

::: warning
On github.com, any GitHub user with access to an installation of your GitHub App can log in. Combined with `ENFORCE_VCS_PROJECT_ACCESS=false`, that makes public read open to them. Keep enforcement on for private deployments.
:::

| Variable                     | Required | Default | Description                                                                                                                                                |
| ---------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENFORCE_VCS_PROJECT_ACCESS` | No       | `true`  | Gate app reads by VCS project access. Set `false` to make every authenticated user able to read every app (e.g. for environments without a reachable VCS). |

Reviewing screens and approving builds needs more than read access: the user must be a PixelCI admin, or hold at least the app's **Who Can Approve Builds** role on the project (set per app by an admin; default: write access, i.e. Developer in GitLab or Write in GitHub). With `ENFORCE_VCS_PROJECT_ACCESS=false`, only PixelCI admins can review and approve.

### MCP OAuth

PixelCI is its own OAuth 2.1 authorization server for MCP clients such as claude.ai, Claude Desktop and Claude Code (see [LLM Access](/llm-access)). The issuer is `PUBLIC_URL`, so it must be an `https` origin with no path (plain `http` is accepted only on `localhost`, for development). If `PUBLIC_URL` is unsuitable, or `MCP_OAUTH_ENABLED` is `false`, the OAuth and discovery endpoints answer `404` and `/api/mcp` accepts only personal access tokens.

Make sure your reverse proxy forwards `/.well-known/*`, `/api/oauth/*` and `/api/mcp` to the API like everything else, and sets the client address header so the per-IP limits see real client IPs (`USE_REAL_IP_HEADER=true` behind a trusted proxy). claude.ai connects from Anthropic's servers, so for it the instance must be reachable from the public internet.

| Variable                        | Required | Default | Description                                                                                           |
| ------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `MCP_OAUTH_ENABLED`             | No       | `true`  | Offer OAuth sign-in for MCP clients. Set `false` to allow personal access tokens only.                |
| `OAUTH_DCR_MAX_PER_IP_PER_HOUR` | No       | `20`    | Dynamic client registrations allowed per client IP per hour (over the limit gets `429`)               |
| `OAUTH_DCR_MAX_PER_HOUR`        | No       | `200`   | Dynamic client registrations allowed across all callers per hour                                      |
| `OAUTH_CIMD_ENABLED`            | No       | `true`  | Accept clients identified by a metadata URL (see below). Set `false` to allow registered clients only |

Clients may also identify themselves with an `https` URL whose published metadata document PixelCI fetches (Client ID Metadata Documents). This needs outbound HTTPS from the API to arbitrary public hosts (port 443 only; private, loopback and link-local addresses, redirects and responses over 5 KB are refused), so allow that egress if you restrict it. Fetches are rate limited per URL (`OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN`, 10), per host (`OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN`, 30) and overall (`OAUTH_CIMD_MAX_FETCHES_PER_HOUR`, 300). Only public clients (no secret) are supported.

Users can review and revoke what they have approved under **Connected apps**. Access tokens last one hour, refresh tokens expire after 30 days unused, and a connection is capped at 90 days; it also ends when the user's GitLab or GitHub sign-in expires. Cleanup of expired state runs hourly in the worker.

### Tuning

| Variable                           | Required | Default | Description                                                                                                                                                                                                                       |
| ---------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_PIXEL_MATCH_THRESHOLD`    | No       | `0.2`   | Per-pixel color sensitivity for comparison (0–1, smaller = more sensitive). Higher values reduce false positives from sub-pixel text rendering and anti-aliasing differences. Instance default; apps and screens can override it. |
| `DEFAULT_PIXEL_DIFF_PCT_THRESHOLD` | No       | `0.01`  | Real percentage of total pixels (0–100) that must differ to flag a screen as changed (e.g. `0.01` = 0.01% of pixels). Instance default; apps and screens can override it.                                                         |
| `DEFAULT_PIXEL_SHIFT_TOLERANCE`    | No       | `1`     | Radius in pixels within which shifted content (e.g. text nudged by 1px) is not counted as a difference. `0` disables. Instance default; apps and screens can override it.                                                         |

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
  -e CRYPTO_SECRET="$CRYPTO_SECRET" \
  ghcr.io/zyno-io/pixelci:latest \
  node . worker:start
```

When using a separate worker, do **not** set `ENABLE_JOB_RUNNER` on the server.

### On Kubernetes

The [Helm chart](#kubernetes-helm) uses the separate-worker layout: Deployments `<release>` (server) and `<release>-worker`, sharing one environment, with migrations in a pre-upgrade job. With your own manifests, either run one Deployment with `ENABLE_JOB_RUNNER=true`, or two Deployments of the same image with the worker's command set to `node . worker:start`. Keep sensitive values (`AUTH_JWT_SECRET`, `PG_PASSWORD_SECRET`, S3 credentials, `CRYPTO_SECRET`) in Kubernetes Secrets.
