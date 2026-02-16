# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PixelCI is a visual regression testing platform that compares screenshots across builds to detect visual changes. It consists of three main workspaces:

- **api**: Backend API server built with Deepkit Framework
- **ui**: Frontend Vue.js application
- **cli**: Command-line tool for CI/CD integration

The system works by:

1. CLI uploads screenshots from CI jobs
2. API compares screenshots using pixel-matching against reference builds
3. UI displays results and allows approving/rejecting visual changes

## Development Commands

### Installation & Setup

```bash
# Install dependencies (from root)
yarn --immutable

# Set up local services (MySQL, Redis, S3)
# See packages/api/.env.development for required services
```

### API Development

```bash
cd packages/api

# Run migrations
yarn migrate

# Run development server (watches for changes)
yarn dev

# Run integration tests
yarn test:int

# Build for production
yarn build

# Start production build with debugging
yarn start:dist:debug
```

### UI Development

```bash
cd packages/ui

# Generate OpenAPI client from API
npx generate-openapi-client

# Run development server
yarn dev

# Build for production
yarn build

# Run E2E tests
yarn test:e2e

# Type checking
yarn typecheck
```

### CLI Development

```bash
cd packages/cli

# Build TypeScript
npx tsc

# Run CLI (requires PIXELCI_API_URL, PIXELCI_APP_ID; uses CI_JOB_TOKEN for auth)
node dist/index.js <screenshots-path>
```

### Root-level Commands

```bash
# Format all code
yarn format
```

## Architecture

### Database Schema (Deepkit ORM)

Core entities in `packages/api/src/entities/`:

- **AppEntity**: Visual testing application/project
- **BranchEntity**: Git branches being tracked
- **BuildEntity**: Individual CI builds with status (draft, processing, no changes, needs review, changes approved)
- **BuildScreenEntity**: Screenshot associated with a build (tracks approval status per screen)
- **ScreenEntity**: Named screenshot slot across builds
- **UserEntity**: User authentication
- **VcsIntegrationEntity**: Version control system integrations

Build statuses flow: `draft` → `processing` → `no changes` | `needs review` | `changes approved`

### Visual Comparison Logic

The `ProcessBuildJob` (api/src/jobs/ProcessBuild.job.ts) implements the core visual regression algorithm:

1. **Previous Build Comparison**: For non-default branches, compares against the last approved build on same branch
2. **Reference Build Comparison**: Compares against latest approved build on default branch
3. **Intermediate Approval Matching**: Checks if changes match any approved changes on other branches since reference build
4. **New Screen Detection**: Marks screens not in reference build as "new"
5. **Diff Storage**: Stores visual diff images to S3 when pixel difference exceeds threshold (default 1%)

The algorithm uses UUID7 time-ordering to temporally compare builds and screens even across different branches.

### API Structure

Controllers in `packages/api/src/controllers/`:

- **SessionController**: Authentication
- **AppsController**: App management
- **BranchesController**: Branch tracking
- **BuildsController**: Build creation, processing, approval
- **BuildScreensController**: Screenshot upload, retrieval
- **CiController**: CI token-based app resolution

Services in `packages/api/src/services/`:

- **PixelMatchService**: Pixel-by-pixel image comparison using pixelmatch library
- **S3Service**: Screenshot and diff image storage
- **VcsService**: Git integration abstraction
- **VcsGitLabService**: GitLab-specific implementation

### Frontend Structure

Vue 3 application with:

- **Screens**: `apps.vue`, `builds.vue`, `screens.vue`, `login.vue`
- **OpenAPI Client**: Auto-generated from API schema in `src/openapi-client-generated/`
- **State Management**: Pinia store in `src/store.ts`
- **Observability**: OpenTelemetry integration in `src/otel.ts`

### CLI Workflow

The CLI (cli/src/index.ts):

1. Detects CI environment (GitLab supported via `ci-gitlab.ts`)
2. Creates build via API
3. Uploads PNG screenshots with screen names
4. Triggers build processing
5. Polls for completion (5min timeout)
6. Exits with code 1 if changes need review

## Testing

### Integration Tests (API)

```bash
cd packages/api
yarn test:int
```

Located in `packages/api/tests/integration/`. Requires MySQL, Redis, and S3 (SeaweedFS) services running.

### E2E Tests (UI)

```bash
cd packages/ui
yarn test:e2e
```

Playwright-based tests in `packages/ui/tests/e2e/`. Automatically starts dev server.

### CI Pipeline

GitLab CI stages (`.gitlab-ci.yml`):

1. **test**: Runs integration tests, builds, starts API, runs E2E tests
2. **visual regression test**: Uses PixelCI itself to test UI screenshots
3. **build**: Creates Docker images for API and CLI
4. **deploy**: Rolling updates to Kubernetes

## Important Patterns

### Deepkit Framework

- Uses runtime type information via `@deepkit/type-compiler`
- Dependency injection throughout
- Database entities use decorators: `@entity.name()`, `& PrimaryKey`
- Controllers use `@http.GET()`, `@http.POST()` decorators

### OpenAPI Client Generation

The UI auto-generates type-safe API client:

```bash
npx generate-openapi-client
```

Generated files in `packages/ui/src/openapi-client-generated/` should not be manually edited.

### Worker Jobs

Background jobs in `packages/api/src/jobs/`:

- Use `@WorkerJob()` decorator
- Extend `BaseJob<TData>`
- Automatically handled by framework's worker system

### Environment Configuration

- Development: `packages/api/.env.development`, `packages/ui/.env`
- Production: `packages/api/.env.production`, `packages/ui/.env.production`
- Required services: MySQL, Redis, S3-compatible storage

## Key Files to Know

- `packages/api/src/app.ts`: Application bootstrap and module configuration
- `packages/api/src/jobs/ProcessBuild.job.ts`: Core visual regression logic
- `packages/ui/src/openapi-client.ts`: API client setup
- `packages/cli/src/index.ts`: CLI entry point
- `.gitlab-ci.yml`: Complete CI/CD pipeline definition
