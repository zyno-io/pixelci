# GitLab Integration Guide

This guide covers two things: setting up GitLab OAuth for user login, and integrating PixelCI into your GitLab CI pipeline.

## Part 1: GitLab OAuth Setup

PixelCI uses GitLab as an OAuth provider for user authentication.

### 1. Create a GitLab OAuth Application

In your GitLab instance:

- **Self-managed GitLab**: Go to **Admin > Applications**
- **GitLab.com**: Go to **User Settings > Applications**

Fill in:

- **Name**: `PixelCI`
- **Redirect URI**: `https://<your-pixelci-domain>/login` (must be exactly `${PUBLIC_URL}/login`, where `PUBLIC_URL` is the server's configured public origin)
- **Confidential**: Yes
- **Scopes**: `openid`, `api`

Save and note the **Client ID** and **Client Secret**.

### 2. Create a VCS Integration

On first launch, PixelCI shows an onboarding wizard that walks you through creating your first VCS integration. Enter the **Setup Token** (the `SETUP_TOKEN` environment variable you configured on the server; at least 16 characters), then your GitLab instance URL, Client ID, and Client Secret from step 1. If `SETUP_TOKEN` is unset or too short, first-run setup is disabled.

### 3. Log In

After creating the integration, click the GitLab login button to sign in.

<img src="/images/login-light.png" alt="Login page" class="light-only">
<img src="/images/login-dark.png" alt="Login page" class="dark-only">

While no admin exists, a user who signs in with the setup token (remembered from the onboarding wizard, or typed on the login page) is promoted to admin; without it they stay a regular user. Keep `SETUP_TOKEN` set until that has happened.

## Part 2: CI Pipeline Integration

### 1. Create an App in PixelCI

In the PixelCI web UI, click **Add App**. Search for your GitLab project by name or paste its URL, then set the app name and default branch.

### 2. Add PixelCI to Your `.gitlab-ci.yml`

```yaml
visual-regression:
    stage: test
    image: ghcr.io/zyno-io/pixelci/cli:latest
    id_tokens:
        PIXELCI_ID_TOKEN:
            aud: https://pixelci.example.com # the server's PUBLIC_URL
    variables:
        PIXELCI_API_URL: https://pixelci.example.com
        PIXELCI_APP_ID: <your-app-id>
        PIXELCI_IMAGES_PATH: ./path/to/screenshots
        GIT_DEPTH: 0 # full history: PixelCI compares your branch with the default branch where it forked
    script:
        - pixelci
```

You can find the app ID in the PixelCI web UI on the app settings page.

Authentication uses a [GitLab ID token](https://docs.gitlab.com/ci/secrets/id_token_authentication/) (GitLab 15.7 or later): a short-lived JWT that GitLab signs for the job. No API keys or stored secrets are needed. The `aud` must be your PixelCI `PUBLIC_URL` (or one of the extra values in `GITLAB_ID_TOKEN_AUDIENCES` on the server, e.g. when `PIXELCI_API_URL` is an internal address).

Without `id_tokens:` the CLI falls back to GitLab's built-in `CI_JOB_TOKEN`, so existing pipelines keep working. Job tokens are validated by calling your GitLab instance, which needs the project's job-token permissions to allow it; ID tokens avoid that call entirely. Server admins can turn job-token auth off with `GITLAB_JOB_TOKEN_AUTH_ENABLED=false`, after which only ID tokens are accepted.

Every app is bound to a single GitLab project (its numeric project ID, set automatically when you pick the project in **Add App**). PixelCI only accepts tokens from that project. An app without a bound project rejects all CI tokens with a 401; recreate it from the web UI to bind it.

### 3. CLI Environment Variables

| Variable                  | Required | Description                                                                                                                        |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PIXELCI_API_URL`         | Yes      | URL to your PixelCI server                                                                                                         |
| `PIXELCI_APP_ID`          | Yes      | App ID from the PixelCI web UI                                                                                                     |
| `PIXELCI_ID_TOKEN`        | No       | GitLab ID token from `id_tokens:` (see above). When set, it is used instead of `CI_JOB_TOKEN`                                      |
| `PIXELCI_IMAGES_PATH`     | No       | Path to screenshots directory (alternative to passing as argument)                                                                 |
| `PIXELCI_TIMEOUT_MINUTES` | No       | How long to wait for the build result (default `15`, range 1-120)                                                                  |
| `PIXELCI_SHARD`           | No       | `<index>/<total>` (1-based) when the suite is split across parallel jobs, e.g. `2/4`. Requires a server with sharded-build support |
| `PIXELCI_BASE_COMMIT`     | No       | Full commit hash to treat as where the build forked from the default branch, instead of finding it with git (see below)            |
| `PIXELCI_GIT_FETCH`       | No       | Set to `false` to stop the CLI running `git fetch` (see below). Anything else, or unset, lets it fetch when it needs history       |

Exit code `0` only for `no changes` and `changes approved`. Every other outcome exits `1`: `needs review`, `changes rejected`, `failed`, a timeout, an API error, and any status this CLI version doesn't recognise. Transient API errors (network failures, HTTP 408/425/429/5xx) are retried with backoff before failing.

### 4. How It Works

The CLI authenticates with one of two tokens, using `CI_PROJECT_URL` to locate the project:

- **ID token (`PIXELCI_ID_TOKEN`, preferred).** The API verifies the token's signature against your GitLab instance's public keys (`/oauth/discovery/keys`), checks the issuer, audience and expiry, and requires its `project_id` claim to match the app's project. Branch, commit hash and job ID come from the token's claims. An ID token carries no commit title or author, so the CLI sends them from `CI_COMMIT_TITLE` and `CI_COMMIT_AUTHOR`; they are used for display only. PixelCI makes no call to GitLab to validate it.
- **Job token (`CI_JOB_TOKEN`).** The API validates the token directly with your GitLab instance on build creation (`/api/v4/job`) and extracts branch and commit information from the job metadata.

If a transient problem prevents validation (GitLab unreachable, or its keys can't be fetched), the API answers 503 and the CLI retries.

The CLI then:

1. Creates a build via the API (validates the CI token)
2. Uploads all PNG files as screens
3. Triggers build processing
4. Polls for completion (15-minute timeout by default; see `PIXELCI_TIMEOUT_MINUTES`)
5. Exits with code 0 (pass) or 1 (anything else), printing a direct link to the build in PixelCI

### 5. Git History and the Baseline

PixelCI compares a branch with the default branch where the branch forked from it (the merge base), not with the default branch's newest build. The CLI works that out from git, so the job needs the history:

- Set `GIT_DEPTH: 0` on the job, as above, to fetch full history. The CLI image includes git.
- In a merge request pipeline the CLI uses the merge request's own base commit (the target branch's tip, or the diff base), so MR builds compare against what the MR will merge into.
- A shallow clone can still work: unless `PIXELCI_GIT_FETCH=false`, the CLI fetches the default branch and deepens the clone as far as it needs, using the job's own credentials (the job token from the checkout). It never prompts.
- With `GIT_STRATEGY: none`, or no repository in the job, there is no history to read. The CLI warns and PixelCI compares against the latest approved default-branch build; the review page shows a notice saying so.
- If the default branch's build for the fork point is still running or isn't approved, the nearest approved ancestor is used, so a pending change on the default branch shows up in your review too.

`PIXELCI_BASE_COMMIT` overrides the search: set it to a full 40 or 64 character commit hash and the CLI treats that commit as the fork point (it still reads the commits before it from git when it can). A value that isn't a full hash is ignored with a warning. `PIXELCI_GIT_FETCH=false` makes the CLI work offline: it uses only the history and remote-tracking refs already in the checkout, and falls back to the latest approved build when they aren't enough.

### 6. Screenshot Naming

PNG files are named by their relative path from the screenshots directory. The `.png` extension is stripped, and directories are joined with " - " (space, hyphen, space):

| File path              | Screen name            |
| ---------------------- | ---------------------- |
| `login.png`            | `login`                |
| `checkout/step-1.png`  | `checkout - step-1`    |
| `admin/users/list.png` | `admin - users - list` |

Screens are identified by name, so renaming or moving a file starts a new screen with no baseline.

### 7. Build Outcomes

| Exit code | Build status       | Meaning                                      |
| --------- | ------------------ | -------------------------------------------- |
| `0`       | `no changes`       | All screenshots match approved baselines     |
| `0`       | `changes approved` | Changes were previously approved             |
| `1`       | `needs review`     | New changes require human approval in the UI |

When a build needs review, the CLI output includes a direct link to the build in PixelCI. After reviewing and approving the changes in the web UI, PixelCI automatically restarts the failed CI job via the GitLab API and redirects you to the pipeline page.

### 8. Running the CLI Outside GitLab

You can run the CLI manually with Docker, providing the required environment variables yourself. A job token (as below) works only while the server has job-token auth enabled (`GITLAB_JOB_TOKEN_AUTH_ENABLED`, the default); otherwise pass a GitLab ID token as `PIXELCI_ID_TOKEN` instead. It must be unexpired and minted for the job's project, with the server's `PUBLIC_URL` as audience.

```bash
docker run --rm \
  -v $(pwd)/screenshots:/screenshots \
  -e PIXELCI_API_URL=https://pixelci.example.com \
  -e PIXELCI_APP_ID=your-app-id \
  -e CI_PROJECT_URL=https://gitlab.example.com/group/project \
  -e CI_JOB_TOKEN=your-job-token \
  ghcr.io/zyno-io/pixelci/cli:latest \
  /screenshots
```
