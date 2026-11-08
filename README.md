# PixelCI

A self-hosted visual regression testing platform for your GitLab CI/CD and GitHub Actions pipelines that automatically detects visual changes across branches and builds. (SaaS version coming soon.)

## What is PixelCI?

PixelCI helps teams catch unintended visual changes by comparing screenshots from your CI/CD pipeline against approved baseline images. It intelligently tracks changes across branches, automatically approves matching changes, and highlights differences that need human review.

## Key Features

- **Intelligent Change Detection**: Pixel-perfect comparison with configurable thresholds (default 1%)
- **Branch-Aware Comparisons**: Automatically compares against the right baseline for each branch
- **Cross-Branch Approval Tracking**: Changes approved on one branch are automatically recognized on others
- **Visual Diff Viewer**: Side-by-side comparison with highlighted differences
- **Self-Hosted**: Full control over your data and infrastructure
- **CI/CD Integration**: Seamless integration with GitLab CI and GitHub Actions
- **One-Click Approval**: Approve changes and automatically restart the failed CI job

## How It Works

1. **Upload Screenshots**: Your CI/CD pipeline uploads screenshots after each build
2. **Automatic Comparison**: PixelCI compares screenshots against approved baselines
3. **Smart Analysis**: Matches against previously approved changes on the same branch, the default branch baseline, and other branches
4. **Review & Approve**: When changes need review, the CI job fails with a direct link to the build. Team members review and approve changes through the web UI.
5. **CI Re-run**: Approving a build automatically restarts the failed CI job and redirects you to the pipeline

## Quick Start

See the [Deployment Guide](https://docs.pixelci.dev/deployment.html) for full setup instructions with Docker, Docker Compose, and Kubernetes.

## GitLab CI Integration

Add visual regression testing to your pipeline:

```yaml
visual-regression:
    stage: test
    image: ghcr.io/zyno-io/pixelci/cli:latest
    variables:
        PIXELCI_API_URL: https://pixelci.example.com
        PIXELCI_IMAGES_PATH: ./screenshots
    script:
        - pixelci
```

See the [GitLab Integration Guide](https://docs.pixelci.dev/gitlab-setup.html) for OAuth setup and detailed configuration.

## GitHub Actions Integration

Add visual regression testing to your workflow (requires `id-token: write`; no secrets needed):

```yaml
permissions:
    contents: read
    id-token: write

jobs:
    visual-regression:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: docker://ghcr.io/zyno-io/pixelci/cli:latest
              env:
                  PIXELCI_API_URL: https://pixelci.example.com
                  PIXELCI_APP_ID: <your-app-id>
                  PIXELCI_IMAGES_PATH: ./screenshots
```

See the [GitHub Integration Guide](https://docs.pixelci.dev/github-setup.html) for GitHub App setup and detailed configuration.

## Web UI

PixelCI provides a web interface for reviewing builds, comparing screenshots, and approving changes. See the [Usage Guide](https://docs.pixelci.dev/usage.html) for a walkthrough with screenshots.

## Architecture

- **Backend**: TypeScript, Deepkit Framework, MySQL, Redis
- **Frontend**: Vue 3, TypeScript, Pinia, TailwindCSS
- **Image Processing**: pixelmatch for pixel-by-pixel comparison
- **Storage**: S3-compatible object storage for screenshots and diffs

The single Docker image runs as either an API/UI server (`node . server:start`, default) or a background worker (`node . worker:start`). See the [Deployment Guide](https://docs.pixelci.dev/deployment#architecture-overview) for details.

## Roadmap

- [x] GitHub Actions integration
- [ ] Multi-user permissions and teams
- [ ] Baseline management UI
- [ ] Slack/Discord notifications
- [ ] Comparison history and analytics

## Contributing & Development

See the [Development Guide](DEVELOPMENT.md) for local setup, running tests, and building Docker images.

## Support

For issues, questions, or contributions, please open an issue on [GitHub](https://github.com/zyno-io/pixelci).

## License

This project is source-available. See [LICENSE.md](LICENSE.md) for details.

---

Built with ❤️ by Zyno Consulting
