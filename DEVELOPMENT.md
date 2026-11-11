# Development Guide

## Prerequisites

- **Node.js** 22+
- **Yarn** (managed via Corepack — run `corepack enable` once)
- **Docker** (for local PostgreSQL, Redis, and S3 services)

## Getting Started

```bash
# Install dependencies
yarn --immutable

# Start local services (PostgreSQL, Redis, SeaweedFS S3)
yarn services:up

# Run database migrations
yarn migrate

# Start the API and UI dev servers (in separate terminals)
yarn dev:api    # http://localhost:7924
yarn dev:ui     # http://localhost:7925
```

To stop local services:

```bash
yarn services:down
```

## Running Tests

All test commands work the same locally and in CI. Services (PostgreSQL, Redis, S3) must be running first.

### API Tests

```bash
yarn test:api           # build + unit tests + integration tests (used by CI)
yarn test:api:unit      # unit tests only (no services required)
yarn test:api:int       # integration tests only (services required)
```

Integration tests automatically create an isolated database and use a separate Redis prefix (`pixelci_test`), so there are no conflicts with your dev data.

### CLI: Unit Tests

```bash
yarn test:cli
```

Compiles TypeScript and runs unit tests. No services required.

### UI: E2E Tests

```bash
yarn test:e2e
```

This handles the full setup automatically:

1. Builds the API
2. Runs any pending migrations
3. Seeds the E2E test user
4. Starts an API server if one isn't already running
5. Generates the OpenAPI client
6. Runs Playwright tests (starts the UI dev server if needed)

If you already have `yarn dev:api` running, the script detects it and skips starting a second server.

## Project Structure

```
packages/
  api/     Backend API (Deepkit Framework, port 7924)
  ui/      Frontend (Vue 3 + Vite, port 7925)
  cli/     CI/CD CLI tool
resources/
  dev/     Docker Compose and service configs
scripts/
  test-e2e.sh   E2E test orchestration
```

## OpenAPI Client

The UI uses a generated OpenAPI client. The generated files are gitignored, so you need to regenerate after pulling changes that modify the API schema:

```bash
# Requires the API dev server to be running
cd packages/ui && npx generate-openapi-client
```

## Code Formatting

Pre-commit hooks (via Lefthook) automatically run oxlint and Prettier on staged files. To format manually:

```bash
yarn format
```
