# Getting Started

PixelCI is a self-hosted visual regression testing platform. It compares screenshots from your CI/CD pipeline against approved baselines and flags visual changes for review.

## How It Works

1. **Upload Screenshots** — your CI pipeline uploads screenshots after each build
2. **Automatic Comparison** — PixelCI compares them against approved baselines
3. **Smart Analysis** — matches against previously approved changes across branches
4. **Review & Approve** — team members review changes in the web UI
5. **Build Status** — CI passes if all changes are approved, fails if review is needed

## Quick Start

### 1. Deploy PixelCI

Run the server with Docker:

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

Then run migrations:

```bash
docker exec pixelci node . migrate:run
```

See the [Deployment Guide](./deployment.md) for Docker Compose, Kubernetes, and full configuration reference.

### 2. Set Up Authentication

PixelCI authenticates users through your VCS provider. See the [GitLab Setup Guide](./gitlab-setup.md) (GitLab OAuth) or the [GitHub Setup Guide](./github-setup.md) (GitHub App) to configure login and create your first app.

### 3. Add to Your CI Pipeline

```yaml
visual-regression:
    stage: test
    image: ghcr.io/zyno-io/pixelci/cli:latest
    variables:
        PIXELCI_API_URL: https://pixelci.example.com
    script:
        - pixelci ./screenshots
```

On GitHub Actions, use the container step instead (with `permissions: id-token: write`):

```yaml
- uses: docker://ghcr.io/zyno-io/pixelci/cli:latest
  env:
      PIXELCI_API_URL: https://pixelci.example.com
      PIXELCI_APP_ID: <your-app-id>
      PIXELCI_IMAGES_PATH: ./screenshots
```

See the [GitLab Setup Guide](./gitlab-setup.md#part-2-ci-pipeline-integration) or [GitHub Setup Guide](./github-setup.md#part-2-github-actions-integration) for detailed CI configuration.

### 4. Review Results

Open the PixelCI web UI to review builds, compare screenshots, and approve changes. See the [Usage Guide](./usage.md) for a walkthrough.

## License

PixelCI is **source-available** under the PixelCI Source Available License, Version 1.1. It is free for internal use within your organization. A [commercial license](mailto:support@sgnl24.com) is required to offer it as a hosted service, distribute it, or embed it in products sold to others. The CLI and the MCP server are licensed separately under the MIT License.
