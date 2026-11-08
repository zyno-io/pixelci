# GitHub Actions integration — design & plan

Status: slice 1 implemented; remaining work (GitHub App login, per-job re-run, platform-typed config, docs, MCP) is specified in [`design/github-parity-plan.md`](./github-parity-plan.md), which supersedes this doc where they differ. Updated 2026-11-07. Branch `github-actions-integration`.

**Recommendation:** extend the existing `IVcsServiceImpl` provider model with a `VcsGitHubService`. Use a **GitHub App** for user login, repo access and re-runs. Use **Actions OIDC ID tokens** for CLI auth: no secrets in workflows, the closest match to GitLab's `CI_JOB_TOKEN`. Keep the GitLab model (fail the job, then re-run it after approval) for parity. Add a PixelCI-owned check run later as an option.

---

## 1. GitLab integration today (end-to-end)

| Concern                   | Where                                                      | How                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider config           | `entities/VcsIntegration.entity.ts`                        | `platform: 'gitlab' \| 'github'` (DB enum already includes `github`). `IGitLabConfig { url, clientId, clientSecret }`. `IGitHubConfig` exists as an unused placeholder.                                                                                                  |
| Provider dispatch         | `services/Vcs.service.ts`                                  | `IVcsServiceImpl` with `getProviderLoginUrl`, `exchangeProviderCode`, `rerunCiJob`, `getProjectPath`, `searchProjects`, `getProjectByPath`, `userCanAccessProject`, `tokenCanAccessProject`. `getProvider()` only knows gitlab.                                          |
| User login                | `controllers/Session.controller.ts` → `VcsGitLabService`   | OAuth code flow, scopes `openid api`. `id_token` gives the user id and name. Access and refresh tokens are stored in `users.vcsSession` and refreshed on demand (`renewToken`). The first user becomes admin. A user belongs to exactly one integration (`users.vcsId`). |
| App ↔ repo binding        | `controllers/Apps.controller.ts`                           | Admin searches or resolves a project with their own token. The app stores `vcsId`, `projectPath` and `vcsProjectId` (numeric).                                                                                                                                           |
| Read authz                | `services/AppAccess.service.ts`                            | Gated on "can this principal `GET /projects/:id`", cached 60s. A cross-provider principal is always denied. `ENFORCE_VCS_PROJECT_ACCESS` turns it off for e2e.                                                                                                           |
| CI auth (create build)    | `AuthMiddleware.validateCiToken` (GitLab-hardcoded)        | The CLI sends `CI_JOB_TOKEN` as a bearer token. The server calls `GET /api/v4/job` with `JOB-TOKEN`, which gives the job id, ref, sha, commit title/author and `pipeline.project_id`. The server checks project id == `app.vcsProjectId` (skipped when null).            |
| CI auth (rest of session) | `BuildCiTokenMiddleware`                                   | sha256(token) == `builds.ciTokenHash`. It is cleared once a final status is read. This is token-format agnostic.                                                                                                                                                         |
| Baselines                 | `jobs/ProcessBuild.job.ts`                                 | Branch name + commit sha + UUID7 ordering. **Provider-agnostic, no change needed.**                                                                                                                                                                                      |
| Dedupe / re-run pass      | `BuildsController.create`                                  | An existing build for the same branch + sha is returned as-is. A re-run after approval therefore sees `changes approved` and exits 0.                                                                                                                                    |
| Approve → re-run          | `BuildsController.approve` → `rerunCiJob`                  | Calls `POST /projects/:path/jobs/:id/retry` with the approver's OAuth token and returns the pipeline URL. The UI (`screens.vue`) redirects to it. A 405 triggers project-moved recovery. **This is GitLab-specific logic inside the controller.**                        |
| CLI                       | `packages/cli/src/{ci,ci-gitlab,api,index}.ts`             | Detects `CI_PROJECT_URL` + `CI_JOB_TOKEN`; `ci.ts` has `// todo: add GitHub`. Env: `PIXELCI_API_URL`, `PIXELCI_APP_ID`, `PIXELCI_IMAGES_PATH`. Exits 1 on needs-review/rejected and prints the build URL.                                                                |
| MCP / PAT reads           | `resolveUserFromVcsToken`, `VcsTokenAuthMiddleware`        | GitLab PAT via `PRIVATE-TOKEN` on `/api/v4/user`. GitLab-hardcoded.                                                                                                                                                                                                      |
| UI                        | `onboarding.vue`, `admin/vcs-integrations.vue`, `apps.vue` | GitLab-only forms and copy, plus a `.gitlab-ci.yml` snippet. `Apps.show` already builds GitHub commit URLs.                                                                                                                                                              |
| Docs                      | `docs/gitlab-setup.md` (docs.pixelci.dev/gitlab-setup)     | Covers OAuth app creation, the onboarding wizard, the CI snippet, env vars and outcomes.                                                                                                                                                                                 |

## 2. GitHub vs GitLab — the differences that matter

| Topic                  | GitLab                                                                | GitHub                                                                                                                                                                                                                                                  | Decision                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI identity            | `CI_JOB_TOKEN`, verifiable via `GET /api/v4/job`                      | No job-token introspection endpoint. `GITHUB_TOKEN` proves repo access but not branch or sha. **OIDC ID token** is a signed JWT with `repository_id`, `ref`, `head_ref`, `sha`, `run_id`, `run_attempt` and `actor`.                                    | **OIDC.** The workflow needs `permissions: id-token: write`. The audience is `PIXELCI_API_URL` and the server verifies `aud` against the integration config.                                                                                                                      |
| Unbound apps           | `vcsProjectId` null was tolerated (self-hosted GitLab = closed world) | Any public repo can mint OIDC tokens for any audience                                                                                                                                                                                                   | **GitHub apps must have `vcsProjectId`; fail closed.**                                                                                                                                                                                                                            |
| Branch for PRs         | `job.ref` is the branch                                               | `pull_request` events: `ref = refs/pull/N/merge`, and `sha` is the **merge** commit. The branch is in `head_ref`.                                                                                                                                       | branch = `head_ref` if set, else strip `refs/heads/` or `refs/tags/`. Keep the token `sha`, because the screenshots were rendered from that commit.                                                                                                                               |
| Fork PRs               | n/a                                                                   | No OIDC token for fork `pull_request` runs                                                                                                                                                                                                              | Unsupported in v1. Document it, and don't recommend `pull_request_target`.                                                                                                                                                                                                        |
| App type               | OAuth app, scope `api` (broad)                                        | **GitHub App:** fine-grained permissions, per-repo install, expiring user tokens with refresh (mirrors GitLab `renewToken`), can create check runs. OAuth App: needs classic `repo` scope (full write to every private repo), cannot create check runs. | **GitHub App.** Permissions: Metadata R, Contents R (commit info), Actions **RW** (re-run), Checks RW (slice 4 only). No webhooks needed for v1.                                                                                                                                  |
| Login                  | OIDC `id_token`                                                       | No id_token. `POST /login/oauth/access_token` (Accept JSON), then `GET /user` for `id`, `name ?? login`.                                                                                                                                                | Implement in `exchangeProviderCode`.                                                                                                                                                                                                                                              |
| Access check           | `GET /projects/:id`                                                   | `GET /repositories/:id` with the user-to-server token. It returns 404 unless the user can see the repo **and** the App is installed on it.                                                                                                              | Same `AppAccessService` path. Install scope becomes part of authz (good).                                                                                                                                                                                                         |
| Re-run                 | Retry one job; returns a new pipeline id                              | `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs` (or `/actions/jobs/{job_id}/rerun`). Needs Actions write, plus write access for the user. Only allowed for runs < 30 days old. Re-running a job also re-runs its dependents.              | `rerun-failed-jobs` on `run_id`. Its side effect: other failed jobs in the run re-run too, which is acceptable and often desired. Return `https://github.com/{repo}/actions/runs/{run_id}`. Handle 403 (too old or no permission) by returning `vcsUrl: false` with a UI message. |
| Moved repos            | 405 + path lookup, in the controller                                  | `repository_id` is stable. Look up `GET /repositories/:id` for the current `full_name`.                                                                                                                                                                 | Move "project moved" recovery **into the provider** (`rerunCiJob` handles it). The controller stops special-casing axios 405.                                                                                                                                                     |
| "Fail with review URL" | Job log line                                                          | The Actions job is itself a check run on the PR                                                                                                                                                                                                         | Exit 1, plus a `::error` annotation with the URL (shown on the PR checks list), plus a `$GITHUB_STEP_SUMMARY` section.                                                                                                                                                            |
| Commit subject/author  | From `/job`                                                           | Not in OIDC                                                                                                                                                                                                                                             | Slice 2: server fetches `GET /repos/{r}/commits/{sha}` with an **installation** token (the App's private key). Until then the subject is empty and the author is `actor`.                                                                                                         |
| Enterprise             | Self-managed GitLab URL                                               | GHES: web `https://HOST`, API `https://HOST/api/v3`, OIDC issuer `https://HOST/_services/token`                                                                                                                                                         | `IGitHubConfig.url?`, with the issuer and API URLs derived from it.                                                                                                                                                                                                               |

## 3. Target design

### Config

```ts
interface IGitHubConfig {
    url?: string; // default https://github.com (GHES: https://ghe.example.com)
    clientId: string; // GitHub App client id (user login)
    clientSecret: string;
    oidcAudience: string; // must equal PIXELCI_API_URL used by the CLI
    oidcIssuer?: string; // override (GHES/tests); default derived from url
    // slice 2:
    appId?: string; // for installation tokens (commit metadata, optional app-actor re-runs)
    privateKey?: string;
}
```

`oidcAudience` is explicit config. It is not derived from the `Host` header, which the caller controls; deriving it would let a token minted for another PixelCI instance be replayed here. The UI pre-fills it with `window.location.origin`.

### Provider interface changes

- `validateCiToken(token): ICiJobData` moves onto `IVcsServiceImpl`. `VcsService.validateCiToken(app, token)` enforces project binding centrally (**slice 1, done**).
- `rerunCiJob` owns provider-specific recovery (GitLab 405 move, GitHub id lookup) and returns `{ url } | { error }`, so the UI can tell the user _why_ no re-run happened (slice 2).
- `resolveUserFromVcsToken` gets per-provider `getTokenUser(token)`, so MCP works with GitHub PATs (slice 3).

### CI flow on GitHub

```yaml
permissions:
    id-token: write # required: PixelCI auth via Actions OIDC
    contents: read

jobs:
    visual-regression:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            # ... produce ./screenshots/**/*.png ...
            - uses: docker://ghcr.io/zyno-io/pixelci/cli:latest
              env:
                  PIXELCI_API_URL: https://pixelci.example.com
                  PIXELCI_APP_ID: <app-id>
                  PIXELCI_IMAGES_PATH: ./screenshots
```

1. The CLI detects `GITHUB_ACTIONS=true`, requests an OIDC token (`ACTIONS_ID_TOKEN_REQUEST_URL&audience=<PIXELCI_API_URL>`) and sends it as the bearer token.
2. The server verifies the signature against the issuer JWKS, plus `iss`, `aud` and `exp`. It checks `repository_id` == `app.vcsProjectId` and derives the branch from `head_ref`/`ref`. `ciJobId` = `run_id`.
3. Upload, process and poll are unchanged, using hash auth on the same token.
4. On needs review, the CLI exits 1 with a `::error` annotation and step-summary link.
5. Approve in the UI triggers `rerun-failed-jobs` with the approver's user token. The re-run mints a new OIDC token, and `create` dedupes to the approved build, so the job exits 0.

A `uses: docker://` step works without publishing a separate action. A thin `action.yml` (e.g. `uses: zyno-io/pixelci@v1` with `images-path`/`app-id` inputs) is optional sugar for later.

## 4. Slices

### Slice 1 — CI auth path + stub provider (this branch)

- `validateCiToken` moved behind `IVcsServiceImpl`. GitLab behavior is unchanged and its existing auth tests still pass.
- `VcsService.validateCiToken(app, token)`: central project binding. GitHub apps with null `vcsProjectId` are rejected.
- `VcsGitHubService`: OIDC verification via `jose`. Every other method is stubbed (access checks fail closed; the rest throw 400).
    - Fails closed when `oidcAudience` is missing, because jose silently skips the `aud` check when `audience` is undefined.
    - `exp` is required.
    - Accepted `event_name` values: `push`, `pull_request`, `workflow_dispatch`, `schedule`.
        - `pull_request_target`, `workflow_run` and `issue_comment` are rejected. They carry the base branch's ref and sha, which would mis-attribute builds and dedupe away real changes.
        - `head_ref` is honored only for `pull_request`.
        - `merge_group` can be added later, once we decide how to name the `gh-readonly-queue/...` branches.
- Admin, onboarding and integration-update APIs reject GitHub config until slice 2. The input type is `IGitLabConfig`, so it would strip `oidcAudience`.
- CLI: `ci-github.ts` handles the OIDC token fetch and GitHub result reporting (annotation + step summary). `getJobInfo` is now async.
- Tests: CLI unit specs, and a `github-oidc` API integration test against a local JWKS server.
- **Not yet usable end-to-end.** There's no UI or API to create a GitHub integration, no GitHub login (so no user can see GitHub apps when access enforcement is on), and approve doesn't re-run.

### Slice 2 — GitHub App login, app creation, re-run (makes it usable)

- `VcsIntegrationsController`/`SessionController` input accepts `IGitHubConfig` (validate config shape against `platform`). Regenerate the OpenAPI client.
- `exchangeProviderCode` (code → token → `/user`), `renewToken` with refresh tokens, `searchProjects` (`GET /user/installations` + `/user/installations/{id}/repositories`, or `GET /user/repos` filtered), `getProjectByPath`, and `userCanAccessProject` (`GET /repositories/:id`).
- `rerunCiJob` → `rerun-failed-jobs` + run URL. Move the project-moved logic into providers, and surface 403/too-old to the UI.
- Commit subject/author via an installation token (`appId` + `privateKey`). Sign the App JWT with `jose`.
- UI: GitHub option in onboarding/admin forms (no URL field for github.com; show redirect URI, oidcAudience), GitHub copy/snippet in `apps.vue`.
- Docs: `docs/github-setup.md` (App creation with exact permissions, install on repos, workflow snippet, fork-PR limitation, GHES notes), sidebar entry, README/index tagline + roadmap tick.
- Tests: mock GitHub API server in the integration suite (login, access, re-run). Add a GitHub row to the e2e seed if UI screens change.

### Slice 3 — parity polish

- MCP/PAT reads with GitHub fine-grained PATs (`getTokenUser` per provider).
- Optional `action.yml` wrapper. Make sure the CLI image is multi-arch for ARM runners.

### Slice 4 — optional GitHub-native check mode

- PixelCI creates a `PixelCI` check run (Checks RW; `details_url` = build page; `action_required` → `success` on approval) instead of relying on job re-run. This avoids the 30-day re-run limit and the dependent-job re-runs. It needs branch protection to require the `PixelCI` check, and the job could then exit 0. Per-app toggle. Webhooks are needed only if we want "re-run" buttons on the check (`check_run.requested_action`).

## 5. Open questions for Sean

1. **GitHub App only, or also support OAuth Apps?** Recommendation: App only. OAuth Apps need `repo` scope and can't do checks.
2. **PR sha:** keep the merge-commit `sha` (verified, matches what was rendered) or show the PR head sha? Head sha would need the event payload (unverified) or an API lookup. Recommendation: verified merge sha for identity; show the head sha in the UI later via API.
3. **`push` + `pull_request` both running PixelCI** on the same branch create two builds (different shas). Recommend one trigger in the docs, or dedupe later.
4. **Re-run actor:** approver's user token (parity, attribution, requires repo write) vs installation token (always works, attributed to the App). Recommendation: user token, falling back to the installation token on 403-no-permission.
5. **`apps.vcsProjectId` is a signed INT** (max about 2.1B). GitHub repo ids are around 1.1B and growing. Slice 2 should migrate it to BIGINT.
6. **Verify on a real runner** that `uses: docker://…` steps receive `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` and `GITHUB_STEP_SUMMARY`. The fallback is a `container:` job or `docker run -e …`.
7. Should `IGitHubConfig.oidcAudience` default to a server-level `PUBLIC_URL` env var, if we add one, instead of per-integration config?
