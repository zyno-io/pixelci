# GitHub parity plan: GitHub App login, per-job re-run, platform-typed config

**Design.** Keep the `IVcsServiceImpl` provider model. All GitLab-specific behaviour moves out of the controllers and into the providers: project-moved recovery, URL parsing, commit URLs and PAT user lookup.

- **Config input.** Type it as a union keyed on `platform` at the body root. A union on the `config` field alone does not work in this framework (§3).
- **Re-run.** Re-run one job: `POST /actions/jobs/{check_run_id}/rerun`. Fall back to `rerun-failed-jobs` at the run level. `builds.ciJobId` becomes `"${run_id}:${check_run_id}"`. Failures come back to the UI as `vcsError`.
- **Commit subject/author.** Fetched with a cached installation token. For PRs, use the second parent of the merge commit, not `pulls/{N}`.
- **Token refresh.** One shared helper for both providers that coalesces concurrent refreshes per user. GitHub refresh tokens are single-use.

**Order:** WP-A1 (API contracts and security fixes) → then WP-A2 (GitHub provider) and WP-U (UI) in parallel. WP-M (MCP) and WP-D (docs) can run any time. WP-V (checks against real GitHub) runs last.

**Coordinator findings folded in:** `check_run_id` drives the job id format. The BIGINT migration is required; tests use repo id 3000000001 to prove it. `docker://` steps work, which closes design-doc open question 6. The PR claim shapes match slice 1.

---

## 0. Problems found that the design doc missed (ranked)

1. **Critical. Unauthenticated secret leak. FIXED on HEAD** (commit cherry-picked from `fix/providers-secret-leak`: `getProviders` maps to `{id,name}`; build responses strip `ciTokenHash`; regression test in `onboarding.test.ts`). **WP-A1 only needs to add `platform` to that mapping.** Background, for the record:
    - `Session.controller.ts:48-51` `getProviders()` returned whole `VcsIntegrationEntity` rows, `config` included.
    - The framework sends responses through plain `JSON.stringify` with no field filtering (`node_modules/@zyno-io/ts-server-foundation/dist/src/http/router.js:476-494`).
    - It leaked the GitLab `clientSecret`. With GitHub it would have leaked the App `privateKey`, which lets anyone mint installation tokens with Actions write on every installed repo.
2. **A `config` union strips GitHub fields.** Input values go through ts-reflection's `$`, which tries union members in declared order, drops undeclared keys, and takes the first member that validates (`node_modules/@zyno-io/ts-reflection/dist/index.js`, union branch of `$`). A GitHub Enterprise config has `url`, `clientId` and `clientSecret`, so it matches `IGitLabConfig` first and loses `oidcAudience`, `appId` and `privateKey`. Saving to the DB is safe: JSON columns are stored and read raw (`database/values.js:34-58`, `database/entity.js:101-113`).
3. **Re-run is disabled whenever `CI` is set.** `Builds.controller.ts:239-241` short-circuits on `process.env.CI`. CI runners always set it, so no re-run test can reach a provider. Remove it.
4. **Cross-provider token leak.** `searchProjects`, `getProjectByPath` and `rerunCiJob` (`Vcs.service.ts:82-96`, `Apps.controller.ts:127-145`, `Builds.controller.ts:247`) never check `user.vcsId === vcsId`. A GitLab-logged-in admin would send their GitLab token to GitHub. With `ENFORCE_VCS_PROJECT_ACCESS=false`, the same happens on approve.
5. **Token refresh.**
    - `VcsGitLab.service.ts:230` has the expiry check backwards. `expiresAt > Date.now() - 60_000` refreshes only after the token has been expired for 60s.
    - Nothing coalesces concurrent refreshes. `AppsController.index` runs `filterAccessible`, which uses `Promise.all`, so N apps start N refreshes at once.
    - GitHub refresh tokens are single-use: N−1 of those calls fail, and those apps are cached as "no access" for 60s.
6. **Dedupe keeps the old `ciJobId`** (`Builds.controller.ts:129-138`). After a manual re-run on GitHub, approval would target a job from an older attempt.
7. **Public repos are visible to any logged-in user.** The design doc says `GET /repositories/{id}` returns 404 unless the App is installed. A user token can read public repos without an install, so any logged-in GitHub user can see apps bound to public repos. That matches GitLab's handling of public projects; document it.
8. **Open login on github.com.** Anyone on github.com can log in. With `ENFORCE_VCS_PROJECT_ACCESS=false`, that means public read access. Recommend gating login on the user having at least one installation (§2), plus a docs warning.
9. **`test:all` (`packages/api/package.json:16`) skips three integration suites:** `test:int:auth`, `test:int:onboarding` and `test:int:ext` never run in CI.
10. **`packages/api/openapi.yaml` is stale** from slice 1 (`IGitHubConfig` has no `oidcAudience`). CI's `test:ui:types` regenerates the client from this checked-in file.
11. **Login page edge cases.** The GitHub "authorize during install" callback carries no `state`, and `login.vue:56` does `JSON.parse(atob(undefined))`. A `?error=` return makes `login.vue:78-84` redirect straight back to GitHub.
12. **Admin `show` returns secrets** (`VcsIntegrations.controller.ts:49-60`). With GitHub that includes `privateKey`.

---

## 1. Gap list

| Area                     | file:line                                                                                                                                                                                                                                                                                     | GitLab-specific today                                                                           | GitHub change                                                                      | WP                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| Providers endpoint       | `Session.controller.ts:13,48-51`                                                                                                                                                                                                                                                              | returns full entity; no `platform`                                                              | explicit `{id,name,platform}`                                                      | A1                       |
| Session identity         | `Session.controller.ts:11,39-46`                                                                                                                                                                                                                                                              | no `vcsId`                                                                                      | add `vcsId` (UI picks the integration the admin can search)                        | A1                       |
| Onboarding input         | `Session.controller.ts:29-33,73`                                                                                                                                                                                                                                                              | `config: IGitLabConfig` + slice-1 gate                                                          | `IVcsIntegrationCreateInput` union                                                 | A1                       |
| Admin create/update/show | `VcsIntegrations.controller.ts:10-32,49-60,63-99`                                                                                                                                                                                                                                             | GitLab-typed input, whole-config replace, gate, secrets in `show`                               | unions, merge on update, redacted `show`                                           | A1                       |
| Config type              | `VcsIntegration.entity.ts:10-19`                                                                                                                                                                                                                                                              | no `appId`/`privateKey`                                                                         | add both (optional in storage, required on create)                                 | A1                       |
| Provider interface       | `Vcs.service.ts:35-45,82-104,121-130`                                                                                                                                                                                                                                                         | `rerunCiJob(): string`; `getProjectPath` exists only for controller recovery; no provider guard | §3                                                                                 | A1                       |
| Re-run and moved project | `Builds.controller.ts:4,23-25,239-265`                                                                                                                                                                                                                                                        | axios 405 handling in controller; `CI` short-circuit                                            | provider returns result; `vcsError`                                                | A1                       |
| Dedupe                   | `Builds.controller.ts:129-138`                                                                                                                                                                                                                                                                | ciJobId not refreshed                                                                           | set `ciJobId` when status is `needs review`                                        | A1                       |
| Commit link base         | `Apps.controller.ts:60-66`                                                                                                                                                                                                                                                                    | hardcoded `https://github.com` (Enterprise broken)                                              | `provider.getCommitUrlBase`                                                        | A1                       |
| Project URL parsing      | `Apps.controller.ts:133-145`                                                                                                                                                                                                                                                                  | `/-/` stripping; `new URL` throws a 500                                                         | `provider.parseProjectUrl` + 400                                                   | A1                       |
| App create               | `Apps.controller.ts:71-98`                                                                                                                                                                                                                                                                    | `vcsId`/`vcsProjectId` not checked                                                              | 400 if integration unknown; GitHub requires a positive safe-integer `vcsProjectId` | A1                       |
| PAT auth                 | `AuthMiddleware.accessory.ts:84-144` (`:101,:107,:116-131`)                                                                                                                                                                                                                                   | GitLab only; PRIVATE-TOKEN on `/api/v4/user`                                                    | per-provider `getTokenUser`; pick platform from token prefix                       | A1 (GitLab), A2 (GitHub) |
| Token refresh            | `VcsGitLab.service.ts:229-270`                                                                                                                                                                                                                                                                | backwards window; no coalescing                                                                 | shared `VcsSessionRefresh`                                                         | A1                       |
| CI auth                  | `VcsGitHub.service.ts:105-112`                                                                                                                                                                                                                                                                | `jobId=run_id`; subject `''`                                                                    | `run_id:check_run_id`; commit metadata                                             | A2                       |
| GitHub provider          | `VcsGitHub.service.ts:119-149`                                                                                                                                                                                                                                                                | stubs                                                                                           | full implementation (§2)                                                           | A2                       |
| Repo id column           | migration `20260215_000004_add_vcs_project_id.ts`                                                                                                                                                                                                                                             | `INT NULL`                                                                                      | `BIGINT NULL` (only column holding it, see note below)                             | A1                       |
| Comments                 | `AppAccess.service.ts:10-21`, `ExternalRead.controller.ts:43-48`                                                                                                                                                                                                                              | "GitLab"                                                                                        | provider-neutral wording                                                           | A1                       |
| OpenAPI spec             | `packages/api/openapi.yaml`                                                                                                                                                                                                                                                                   | stale                                                                                           | regenerate                                                                         | A1                       |
| Onboarding UI            | `onboarding.vue:12,16-19,22-25,36-42,60-90`                                                                                                                                                                                                                                                   | GitLab-only form and copy                                                                       | platform select + GitHub fields                                                    | U                        |
| Admin integrations UI    | `admin/vcs-integrations.vue:39-65,93-99,115-139,157-178`                                                                                                                                                                                                                                      | GitLab-only; edits round-trip secrets                                                           | same, plus blank secret = keep                                                     | U                        |
| App create UI            | `apps.vue:40,73,157,214-226,299-301`                                                                                                                                                                                                                                                          | `.gitlab-ci.yml` labels and snippet; GitLab placeholder; swallows search errors                 | GitHub workflow snippet and labels; show errors                                    | U                        |
| Login UI                 | `login.vue:8,54-58,78-84`                                                                                                                                                                                                                                                                     | no platform icon; requires `state`; loops on `?error`                                           | icons; no-state fallback; show error                                               | U                        |
| Approve UI               | `screens.vue:475-491`                                                                                                                                                                                                                                                                         | generic failure alert                                                                           | show `vcsError`                                                                    | U                        |
| MCP                      | `mcp/src/index.ts:7,17-18,36-37`                                                                                                                                                                                                                                                              | `PIXELCI_GITLAB_TOKEN`                                                                          | `PIXELCI_VCS_TOKEN` (aliases `PIXELCI_GITHUB_TOKEN`, `PIXELCI_GITLAB_TOKEN`)       | M                        |
| Docs                     | `docs/.vitepress/config.mts:20`; `docs/index.md:6`; `README.md:3,16,31-46,63`; `getting-started.md:50-64`; `usage.md:7,14,74`; `deployment.md:183`; `llm-access.md:9,11,31,41,57,66`; `packages/mcp/README.md:7-9,26,48`; `CHANGELOG.md`; `CLAUDE.md:129,136,151`; `design/github-actions.md` | GitLab-only                                                                                     | new `docs/github-setup.md` + updates                                               | D                        |
| Test wiring              | `api/package.json:16`; `tests/integration/github-oidc.test.ts:75-86,153`; `tests/integration/index.ts:16,40-77`                                                                                                                                                                               | suites not wired; ciJobId expectation; no GitLab retry mock                                     | §5                                                                                 | A1/A2                    |

**No change needed:**

- CLI: `ci.ts` and `ci-github.ts` are complete.
- `ProcessBuild.job.ts`.
- Helm chart: config lives in the DB.
- `seed-e2e.mjs:80-83`.
- e2e `error-handling.spec.ts:19-20`: its regex already matches `/login/oauth/authorize`.

**BIGINT note.** `apps.vcsProjectId` is the only column that stores the repo id.

- TS `number` is safe up to 2^53.
- mysql2 returns BIGINT as a number; the framework's pool sets only `decimalNumbers` (`drivers/mysql.js:15-19`), and `coerceColumnValue` converts numeric strings.
- OpenAPI emits `type: number` with no int32 format (`openapi.yaml:929-932,966-967`).
- `users.vcsUserId` and `builds.ciJobId` are already varchar.

---

## 2. GitHub API calls

**Common to all calls**

- Bases: `web = (url ?? 'https://github.com')` with trailing `/` removed. `api = web === 'https://github.com' ? 'https://api.github.com' : \`${web}/api/v3\``.
- Headers on every API call: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: PixelCI`, `Authorization: Bearer <token>`.
- Timeout 10s per call; the whole CI commit-metadata path gets 5s.
- On 403/429 with `x-ratelimit-remaining: 0`, report "GitHub API rate limit exceeded".

| Method                                           | Call(s)                                                                                                                                                                                                                                                                                                                                                                                                 | Token                            | Fields used                                                                                                                   | Error mapping                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getProviderLoginUrl`                            | `{web}/login/oauth/authorize?` with URLSearchParams `client_id, redirect_uri, state` (no scope)                                                                                                                                                                                                                                                                                                         | –                                | –                                                                                                                             | –                                                                                                                                                                                                                     |
| `exchangeProviderCode`                           | `POST {web}/login/oauth/access_token`, form body `client_id, client_secret, code, redirect_uri`, `Accept: application/json`; then `GET {api}/user`                                                                                                                                                                                                                                                      | client creds, then user          | `access_token`, `expires_in?`, `refresh_token?`; `id`, `login`, `name`                                                        | **Errors arrive as HTTP 200 with `{error, error_description}`** → 400 with `error_description`. Non-2xx → 400. No `expires_in` → `expiresAt = Number.MAX_SAFE_INTEGER`, `refreshToken=''`. Name is `name \|\| login`. |
| login gate (recommended)                         | `GET {api}/user/installations?per_page=1`                                                                                                                                                                                                                                                                                                                                                               | user                             | `total_count`                                                                                                                 | 0 → 403 "No access to any installation of this GitHub App"                                                                                                                                                            |
| `renewToken` (via helper)                        | `POST {web}/login/oauth/access_token` with `grant_type=refresh_token, refresh_token, client_id, client_secret`                                                                                                                                                                                                                                                                                          | –                                | as above                                                                                                                      | `bad_refresh_token`: re-read the user from DB; if the refresh token changed and the session is fresh, adopt it; else throw (callers fail closed)                                                                      |
| `searchProjects`                                 | `GET {api}/user/installations?per_page=100&page=n`, then per installation `GET {api}/user/installations/{id}/repositories?per_page=100&page=n`                                                                                                                                                                                                                                                          | user                             | `installations[].id`; `total_count`; `repositories[].{id, name, full_name, html_url, description, default_branch, pushed_at}` | 401 → 400 "GitHub session expired"; other → 400 with GitHub `message`                                                                                                                                                 |
| `getProjectByPath`                               | `GET {api}/repos/{o}/{r}`, then `GET {api}/repos/{full_name}/installation`                                                                                                                                                                                                                                                                                                                              | user, then App JWT               | repo fields; installation `id`                                                                                                | 403/404 → 404 "not found or no access". Not installed → 400 "PixelCI GitHub App is not installed on {repo}". Skip the install check if `appId`/`privateKey` are absent.                                               |
| `userCanAccessProject` / `tokenCanAccessProject` | `GET {api}/repositories/{id}` (`/repos/{path}` if the identifier isn't numeric)                                                                                                                                                                                                                                                                                                                         | user / PAT                       | status only                                                                                                                   | 200 → true; anything else → false (warn on 5xx or network error)                                                                                                                                                      |
| `getTokenUser`                                   | `GET {api}/user`                                                                                                                                                                                                                                                                                                                                                                                        | PAT                              | `id`                                                                                                                          | 401/403 → null (installation tokens `ghs_` land here)                                                                                                                                                                 |
| `rerunCiJob`                                     | `GET {api}/repositories/{vcsProjectId}`, then `POST {api}/repos/{full_name}/actions/jobs/{job}/rerun` (201, empty body), fallback `POST …/actions/runs/{run}/rerun-failed-jobs` (201)                                                                                                                                                                                                                   | user                             | `full_name`, `permissions.push`                                                                                               | See the list below.                                                                                                                                                                                                   |
| `validateCiToken` (commit metadata)              | `GET {api}/repos/{repository}/installation` → `POST {api}/app/installations/{id}/access_tokens` with `{repository_ids:[repoId], permissions:{contents:'read'}}` → `GET {api}/repos/{repository}/commits/{sha}`. For `pull_request`: take `parents[1].sha` and `GET …/commits/{it}`. If `parents.length<2` or the merge commit returns 404: `GET …/pulls/{N}` (N from `refs/pull/N/merge`) → `head.sha`. | App JWT, then installation token | `id`; `token`, `expires_at`; `commit.message` (first line, ≤255), `commit.author.name`, `parents[].sha`                       | Any failure → warn, `commitSubject=''`, `commitAuthor=actor`                                                                                                                                                          |
| `parseProjectUrl`                                | pure                                                                                                                                                                                                                                                                                                                                                                                                    | –                                | host must equal `web`'s host; first two path segments, `.git` removed                                                         | null → 400                                                                                                                                                                                                            |
| `getCommitUrlBase`                               | pure                                                                                                                                                                                                                                                                                                                                                                                                    | –                                | `${web}/${path}/commit`                                                                                                       | –                                                                                                                                                                                                                     |

**Re-run error mapping**

- No `vcsProjectId`, or `ciJobId` doesn't match `^(\d+)(?::(\d+))?$` → `{ok:false, error:'No CI run recorded for this build'}`.
- Refresh failure or 401 → session-expired message plus the run URL.
- `/repositories/{id}` returns 404 → "Repository not accessible (App uninstalled or access lost)".
- `permissions.push === false` → a "needs write access" error before calling re-run.
- Job-level 4xx other than 401 → try `rerun-failed-jobs` once.
- Final failure → `GitHub refused to re-run the job (HTTP {s}): {message}. Re-run it from GitHub: {web}/{full_name}/actions/runs/{run}`. GitHub's own message is passed through verbatim, which covers the 30-day limit, "Resource not accessible by integration", a run still in progress, and missing write access.
- Success → `{ok:true, url: run URL}`.
- If `full_name !== projectPath` → set `movedProjectPath`. `VcsService` saves it even when the re-run fails.
- With no `check_run_id` (slice-1 builds, older GitHub Enterprise) → `rerun-failed-jobs` only.

**App JWT**

- Payload `{iat: now-60, exp: now+540, iss: appId}`, RS256.
- Key: `crypto.createPrivateKey(pem)`. GitHub issues PKCS#1 keys (`BEGIN RSA PRIVATE KEY`) and jose's `importPKCS8` rejects those. Pass the `KeyObject` to `SignJWT.sign`.
- Cache, at module level:
    - installation id per `(api, repoId)`;
    - installation token per `(api, appId, repoId)` until `expires_at` minus 5 minutes.
- On 401, drop the cached token and retry once.

**Repo search: use installations, not `/user/repos`.**

- `/user/installations/{id}/repositories` is documented as "repos the user has explicit permission to (owner, collaborator, org membership) within that installation". That is exactly the set where re-run and commit metadata will work, and close to the access check.
- `/user/repos` with a GitHub App user token has unclear install filtering and no server-side search.
- `/search/repositories` has a 30 requests/min secondary limit, ignores installs, and returns every public repo.
- **Pagination limits:**
    - `per_page` is at most 100 on both endpoints; use `page=n` until `ceil(total_count/100)`.
    - Cap at 1 page of installations and 10 pages (1000 repos) per installation.
    - Filter by case-insensitive substring on `full_name`, sort by `pushed_at` descending, return the first 20.
    - Cache the merged list per `(userId, vcsId)` for 60s, because the UI searches on every keystroke after a 300ms debounce.
    - Repos beyond the cap can still be added by pasting the URL.

---

## 3. Interface changes

```ts
// services/Vcs.service.ts
export type IVcsRerunResult = { ok: true; url: string; movedProjectPath?: string } | { ok: false; error: string; movedProjectPath?: string };
export interface IVcsTokenUser {
    id: string;
}

export interface IVcsServiceImpl {
    validateCiToken(ciToken: string): Promise<ICiJobData>;
    getProviderLoginUrl(redirectUri: string, state?: string): Promise<string>;
    exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse>;
    rerunCiJob(user: UserEntity, app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>, ciJobId: string): Promise<IVcsRerunResult>;
    searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]>;
    getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject>;
    parseProjectUrl(url: URL): string | null;
    getCommitUrlBase(projectPath: string): string;
    userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean>;
    tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean>;
    getTokenUser(token: string): Promise<IVcsTokenUser | null>;
} // removed: getProjectPath (becomes private in GitLab)
```

**`VcsService` public surface**

- `rerunCiJob(user, app: AppEntity, ciJobId)`: rejects when `user.vcsId !== app.vcsId`, catches throws into `{ok:false}`, saves `movedProjectPath`.
- `resolveProjectUrl(user, vcsId, url: string)`: bad URL or `null` → 400, then `getProjectByPath`.
- `getCommitUrlBase(integration, path)`.
- `getTokenUser(integration, token)`.
- `searchProjects` and `getProjectByPath` assert `user.vcsId === vcsId` (400). `userCanAccessProject` returns false on mismatch.

**DTOs.** Export every member under its own name; exported aliases become OpenAPI component names.

```ts
// entities/VcsIntegration.entity.ts
interface IGitHubConfig {
    url?: string;
    clientId: string;
    clientSecret: string;
    appId?: string;
    privateKey?: string;
    oidcAudience: string;
    oidcIssuer?: string;
}

// controllers/VcsIntegrations.controller.ts
export interface IGitHubConfigInput {
    url?: string;
    clientId: string;
    clientSecret: string;
    appId: string;
    privateKey: string;
    oidcAudience: string;
    oidcIssuer?: string;
}
export interface IGitLabIntegrationInput {
    name: string;
    platform: 'gitlab';
    config: IGitLabConfig;
}
export interface IGitHubIntegrationInput {
    name: string;
    platform: 'github';
    config: IGitHubConfigInput;
}
export type IVcsIntegrationCreateInput = IGitLabIntegrationInput | IGitHubIntegrationInput; // admin create + onboarding
export interface IGitLabIntegrationUpdateInput {
    name?: string;
    platform?: 'gitlab';
    config?: { url?: string; clientId?: string; clientSecret?: string };
}
export interface IGitHubIntegrationUpdateInput {
    name?: string;
    platform: 'github';
    config?: Partial<IGitHubConfigInput>;
}
export type IVcsIntegrationUpdateInput = IGitHubIntegrationUpdateInput | IGitLabIntegrationUpdateInput;
export interface IGitLabIntegrationDetail {
    id: string;
    name: string;
    platform: 'gitlab';
    config: { url: string; clientId: string };
}
export interface IGitHubIntegrationDetail {
    id: string;
    name: string;
    platform: 'github';
    config: { url?: string; clientId: string; appId?: string; oidcAudience: string; hasPrivateKey: boolean };
}
export type IVcsIntegrationDetailResponse = IGitLabIntegrationDetail | IGitHubIntegrationDetail;
// Session: ISessionProvider { id; name; platform }, ISessionResponse += vcsId
// Builds:  IBuildApprovalResponse { vcsUrl: string | false; vcsError?: string }
```

**How validation behaves (from reading the code; not run yet)**

- The union member is chosen by `$`, which deserializes against each member and takes the first that validates. The required `platform` literal makes the choice deterministic regardless of member order.
    - A body without `platform` falls to the GitLab update branch, which keeps existing GitLab clients working.
    - The server then rejects a `config` whose platform differs from the stored one (400). Name-only updates are allowed.
- The router's `normalizeHttpValue` uses the first object member's shape (`router.js:993-1004`), but it spreads the value, so it does not drop keys.
- `assertHttpValueMatchesType` accepts the value if any member matches (`router.js:1069-1079`).

**Merge rules on update**

- An absent key keeps the stored value.
- An empty `clientSecret` or `privateKey` keeps the stored value.
- An empty GitHub `url` deletes it.
- Then normalize: trim; strip trailing `/` from `url` and `oidcAudience`; drop `url` if it equals `https://github.com`.
- Then validate: `appId` must match `^\d+$`; `privateKey` must load in `crypto.createPrivateKey`; `url` must be http(s); GitHub `appId` and `privateKey` are required on create.
- Put this in a pure `services/VcsConfig.ts` (`normalizeCreateConfig`, `mergeConfigUpdate`, `redactConfig`) so it can be unit-tested.

**What the generated client sees**

- `oneOf` with a `discriminator: platform` for the create input and the detail response. The framework adds a discriminator only when every member has a required, non-overlapping string literal (`docs/content/openapi.md:106`).
- A plain `oneOf` for the update input.
- The current generated client already renders `oneOf` as TS unions (`types.gen.ts:154-159`), so the UI narrows on `platform`.
- `vcsError?: string` is optional.
- **UI typecheck breaks as soon as WP-A1's `openapi.yaml` lands.** Push A1 and U together, or accept a red `test:ui:types` until U merges.

---

## 4. Work packages

### WP-A1: API contracts, security and cross-cutting fixes (first; no dependencies)

Files and changes:

1. `src/controllers/Session.controller.ts`
    - `getProviders` returns an explicit `{id,name,platform}` per row.
    - `getIdentity` adds `vcsId`.
    - Onboarding takes `HttpBody<IVcsIntegrationCreateInput>` and uses `normalizeCreateConfig`.
    - Remove the `assertPlatformConfigurable` import.
2. `src/controllers/VcsIntegrations.controller.ts`: the §3 types; remove the gate (`:24-32`); `create` uses normalize; `update` uses merge plus the platform check; `show` uses redact.
3. `src/services/VcsConfig.ts` (new, pure).
4. `src/entities/VcsIntegration.entity.ts`: add `appId?` and `privateKey?`.
5. `src/services/Vcs.service.ts`: §3 interface and `VcsService` surface; cast config by platform in `createProvider`.
6. `src/services/VcsSessionRefresh.ts` (new): `ensureFreshVcsSession(user, refreshFn, isInvalidGrant)`.
    - Skip if `expiresAt - 5min > now`.
    - Coalesce through a module-level `Map<userId, Promise<IUserVcsSession>>`.
    - Inside the coalesced call:
        - re-read the user; if another process already refreshed, return that session;
        - otherwise call `refreshFn` and save with `UserEntity.query().filter({id}).patchMany({vcsSession})`;
        - on an invalid-grant error, re-read and adopt the stored session if its refresh token changed.
    - Assign the result to the caller's `user` object.
7. `src/services/VcsGitLab.service.ts`
    - `rerunCiJob` returns a result and handles the 405 → `getProjectPath` → retry recovery internally (logic moved from `Builds.controller.ts:243-260`).
    - `getProjectPath` becomes private.
    - `parseProjectUrl` takes the `Apps.controller.ts:136-140` logic.
    - `getCommitUrlBase` returns `${url}/${p}/-/commit`.
    - `getTokenUser` takes the `AuthMiddleware.accessory.ts:116-131` logic.
    - `renewToken` uses the shared helper, which also fixes `:230`.
8. `src/services/VcsGitHub.service.ts`: only adapt the stubs to the new signatures (`rerunCiJob` returns `{ok:false}`, `getTokenUser` returns null, `parseProjectUrl` returns null, `getCommitUrlBase` uses `web`).
9. `src/controllers/Builds.controller.ts`
    - Approve calls `vcsSvc.rerunCiJob(user, app, build.ciJobId)` and maps the result to `{vcsUrl, vcsError?}`.
    - Delete `:239-241` and the axios import.
    - In dedupe (`:129-138`), set `existingBuild.ciJobId = ciJobId` when status is `needs review`.
10. `src/controllers/Apps.controller.ts`: `show` uses `vcsService.getCommitUrlBase`; `create` validates as in §1; `resolve` uses `vcsService.resolveProjectUrl`.
11. `src/accessories/AuthMiddleware.accessory.ts`
    - Add exported `inferTokenPlatform(t)`: `/^(gh[pousr]_|github_pat_)/` → `github`, else `gitlab`.
    - Pick the integration: the header id (any platform), else the single integration of the inferred platform, else 401. GitLab-only setups keep working with no header.
    - Call `vcsService.getTokenUser`.
    - Inject `VcsService` into `VcsTokenAuthMiddleware`.
12. `src/migrations/20261107_000000_vcs_project_id_bigint.ts`: `ALTER TABLE apps MODIFY COLUMN vcsProjectId BIGINT NULL;` (same `db.rawExecute` pattern as `20260215_000004`).
13. Wording only: `AppAccess.service.ts:10-21`, `ExternalRead.controller.ts:43-48`.
14. Tests:
    - `tests/integration/index.ts`: add a mock `POST /api/v4/projects/:p/jobs/:id/retry` returning `{id, pipeline:{id:7}}`, and assert `vcsUrl` ends with `/int-test/-/pipelines/7`.
    - `onboarding.test.ts`: `show` has no `clientSecret`; GitLab PUT without `platform` still returns 200; GitHub create/show/merge; wrong-platform PUT → 400; invalid `privateKey` → 400; onboarding with GitHub on a fresh DB.
    - `ext-read.test.ts`: add a GitHub integration row. A GitLab PAT with no header still resolves. A `ghp_` token is never sent to the GitLab mock (assert the request log).
    - `tests/services/VcsConfig.spec.ts` (new): merge, redact, normalize, `inferTokenPlatform`.
15. Regenerate `packages/api/openapi.yaml` by booting the API, or by hand-editing per the memory note.

Validation:

```bash
cd packages/api && npx tsc --noEmit -p tsconfig.json && yarn build && yarn test
yarn test:int && yarn test:int:auth && yarn test:int:onboarding && yarn test:int:ext && yarn test:int:github
ENFORCE_VCS_PROJECT_ACCESS=false yarn dev   # services up per local-stack-boot memory; writes openapi.yaml
git diff openapi.yaml   # expect discriminator: platform on IVcsIntegrationCreateInput / IVcsIntegrationDetailResponse
```

### WP-A2: GitHub provider (after A1)

1. `src/services/github/GitHubHttp.ts` (new): `githubUrls(config)`, an axios factory (headers, timeout), and `describeGitHubError(err)` returning `{status, message}` (rate-limit aware).
2. `src/services/github/GitHubAppAuth.ts` (new): `signAppJwt(config)`, `getInstallationToken(config, repository, repoId)`, `appJwtGet(path)`, and the caches.
3. `src/services/VcsGitHub.service.ts`: implement §2.
    - `validateCiToken` sets `jobId = /^\d+$/.test(check_run_id) ? \`${run_id}:${check_run_id}\` : run_id`.
    - Normalize `oidcAudience` with trailing slashes removed before `jwtVerify`.
    - Fetch commit metadata only when `appId && privateKey`.
    - Pull branch derivation, `parseCiJobId` and subject extraction out as pure exported functions.
4. Tests:
    - `tests/integration/github-api.test.ts` (new, §5).
    - `tests/integration/github-oidc.test.ts`: add `check_run_id: '128602857139'` to the default claims (`:75-86`); expect `ciJobId === '987654:128602857139'` (`:153`); add a case without `check_run_id` that expects just the `run_id`.
    - `tests/services/VcsGitHub.service.spec.ts` (new).
5. `packages/api/package.json` (A2 owns this file):
    - add `"test:int:github-api": "APP_ENV=development ttsx tests/integration/github-api.test.ts"`;
    - set `test:all` to `yarn build && yarn test && yarn test:int && yarn test:int:auth && yarn test:int:onboarding && yarn test:int:ext && yarn test:int:github && yarn test:int:github-api`.

Validation: the A1 commands plus `yarn test:int:github-api` and `yarn test:all`. No OpenAPI change is expected; confirm `git diff openapi.yaml` is empty after a dev boot.

### WP-U: UI (after A1; parallel with A2)

1. `src/shared/components/vcs-integration-fields.vue` (new).
    - Props: `platform`, `isEdit`, `hasPrivateKey`; `v-model` holds the config.
    - GitLab fields: URL, Client ID, Client Secret, and an "OAuth Redirect URI" box.
    - GitHub fields:
        - GitHub Enterprise URL (optional; placeholder says leave blank for github.com), App ID, Client ID, Client Secret.
        - Private key (textarea; in edit mode, blank keeps the stored key, and the field shows a "key configured" hint).
        - OIDC audience, prefilled with `window.location.origin`, hint "must equal PIXELCI_API_URL in workflows".
        - A "Callback URL" box showing `${origin}/login`.
        - A permissions hint and a link to `docs.pixelci.dev/github-setup`.
2. `src/screens/onboarding.vue` and `src/screens/admin/vcs-integrations.vue`.
    - Platform `<select>` with GitLab and GitHub; name placeholder matches the platform.
    - Build the body for the chosen `platform`. PUT always sends `platform`; secrets are sent as `''` when blank.
    - Edit narrows on `detail.platform`.
3. `src/screens/apps.vue`.
    - Platform comes from `vcsIntegrations.find(v => v.id === vcsId)?.platform`.
    - Default `createForm.vcsId` to `store.sessionUser.vcsId`.
    - Placeholder: "Search by name or paste a GitHub/GitLab URL…".
    - Show API errors inline instead of swallowing them at `:299-301`.
    - Label `.github/workflows/pixelci.yml`.
    - The GitHub snippet uses `PIXELCI_API_URL` = the integration's `oidcAudience`, fetched with `getVcsIntegrationsShow` (admin-only screen).
    ```yaml
    on: push
    permissions: { contents: read, id-token: write }
    jobs:
        visual-regression:
            runs-on: ubuntu-latest
            steps:
                - uses: actions/checkout@v4
                # ...generate screenshots...
                - uses: docker://ghcr.io/zyno-io/pixelci/cli:latest
                  env: { PIXELCI_API_URL: <aud>, PIXELCI_APP_ID: <id>, PIXELCI_IMAGES_PATH: ./path/to/screenshots }
    ```
4. `src/screens/login.vue`.
    - Icon `fa-brands fa-github` / `fa-gitlab` by `provider.platform`.
    - A `code` without `state` with a single provider → use that provider; otherwise show "Please sign in again".
    - `?error=` → show `error_description` and do not auto-redirect.
5. `src/screens/screens.vue:487-491`: the alert includes `vcsError` when present.
6. `tests/e2e/github-ui.spec.ts` (new): `page.route` mocks only, no DB writes and no screenshots (see §5).

Validation:

```bash
cd packages/ui && npx generate-openapi-client && npx vue-tsc --noEmit -p tsconfig.vitest.json --composite false --ignoreDeprecations 6.0 && yarn build-only
cd ../.. && yarn test:e2e
```

### WP-M: MCP (any time)

- `packages/mcp/src/index.ts:7`: `TOKEN = PIXELCI_VCS_TOKEN ?? PIXELCI_GITHUB_TOKEN ?? PIXELCI_GITLAB_TOKEN`.
- Update the error text at `:17-18` and the comment at `:36-37`.
- Validate with `yarn workspace @zyno-io/pixelci-mcp build`.

### WP-D: Docs (any time; final pass after A2 and U)

- **`docs/github-setup.md`** (new):
    - **GitHub App setup:**
        - Callback URL `https://<pixelci>/login`, entered exactly. Expiring user tokens on.
        - Leave "Request user authorization during installation" and Device Flow unchecked; turn webhooks off.
        - Permissions: Metadata R, Contents R, Actions RW, Pull requests R (optional fallback only).
        - Generate a private key; note the App ID and Client ID; create a client secret; install on the repos.
    - **PixelCI side:**
        - Create the integration; the OIDC audience must equal `PIXELCI_API_URL`.
        - First login becomes admin; the App must be installed first if the login gate ships.
        - Access semantics: public repos are readable by any logged-in user; `ENFORCE_VCS_PROJECT_ACCESS=false` on github.com means public read.
        - Add App: search lists repos where the App is installed and you have access; pasting a URL also works.
    - **Workflows:**
        - Workflow snippet with `id-token: write`; recommend one trigger (`push`), not both `push` and `pull_request`.
        - Supported events: push, pull_request, workflow_dispatch, schedule. Rejected: pull_request_target, workflow_run, issue_comment, merge_group. Tag pushes become a branch named after the tag. Fork PRs are unsupported.
        - Exit codes, the `::error` annotation and the step summary.
    - **Approve and re-run:**
        - Re-run uses the approver's token and needs write access.
        - Runs older than 30 days, and runs still in progress, must be re-run manually.
        - The re-run dedupes to the approved build and passes.
    - **GitHub Enterprise:** `url` setting, `/api/v3`, `/_services/token`, `check_run_id` may be absent (run-level re-run instead).
    - **Other:** the CLI can't run outside Actions (OIDC); troubleshooting for 401 (audience, binding, event).
- Sidebar entry in `config.mts:20`; tagline at `docs/index.md:6`.
- `README.md`: `:3`, `:16`, add a "GitHub Actions Integration" section after `:46`, tick `:63`.
- `getting-started.md:50-64`, `usage.md:7,14,74`, `deployment.md:183` (provider-neutral; outbound HTTPS to GitHub; open-login warning).
- `llm-access.md` and `packages/mcp/README.md`: fine-grained PAT (selected repos; Metadata read is automatic), `PIXELCI_VCS_TOKEN`.
- `CHANGELOG.md`: next `## vX.Y.Z` section.
- `CLAUDE.md:129,136,151`.
- `design/github-actions.md`: status; per-job re-run; parents[1]; public-repo correction; providers leak.
- Validate with `yarn docs:build`.

### WP-V: Real-GitHub verification (after A2 and U are deployed)

Run the checklist in §6 against `zynoconsulting/pixelci-actions-test`. Adjust the error copy and docs from what you observe.

**Overlap check:** A1 and A2 overlap only on `VcsGitHub.service.ts`, and that is sequential (A1 changes stub signatures, A2 rewrites the file). A2, U, M and D touch disjoint file sets.

---

## 5. Test plan

**`github-api.test.ts`**

- Single mock HTTP server with an integration `url` of `http://127.0.0.1:PORT`. That makes it an Enterprise-style setup: API at `/api/v3`, issuer at `/_services/token`, which also exercises issuer derivation.
- Separate `databasePrefix` (e.g. `pixelci_ghapi`; not a prefix of another suite's).
- Leave access enforcement on.
- `REPO_ID = 3000000001` (above INT max) to prove the BIGINT migration.
- Every API route asserts the `Accept` and `X-GitHub-Api-Version` headers and logs the request.

Mock routes:

- `/_services/token/.well-known/jwks`.
- `POST /login/oauth/access_token`:
    - code `good` → tokens; code `bad` → HTTP 200 with `{error:'bad_verification_code'}`;
    - refresh: rotates the refresh token, counts calls, adds a 100ms delay;
    - reuse of an old refresh token → `bad_refresh_token`;
    - a hook that writes a fresh session to the DB and then returns `bad_refresh_token` (tests the adopt path).
- `GET /api/v3/user`: user token or `ghp_valid` → `{id:4242, login:'octo', name:null}`; else 401.
- `/user/installations` (2 installations) and `/user/installations/:id/repositories` (101 repos, so 2 pages).
- `/repositories/:id`: accessible ids → 200; one moved id → `full_name:'acme/renamed'`; others → 404.
- `/repos/:o/:r` and `/repos/:o/:r/installation`: verifies the App JWT with the public key and `iss=APP_ID`, and checks `exp-iat ≤ 600`; returns 404 for a not-installed repo.
- `POST /app/installations/77/access_tokens` (counted).
- `/repos/:o/:r/commits/:sha`: a push sha; a merge sha with `parents:[base, head]`; a head sha; `fail` → 500.
- `POST …/actions/jobs/:job/rerun` (201 / 403) and `POST …/actions/runs/:run/rerun-failed-jobs` (201 / 403 with a "month ago" message).
- The private key is generated with `crypto.generateKeyPairSync('rsa', {privateKeyEncoding:{type:'pkcs1', format:'pem'}})` to match GitHub's key format.

Cases:

1. `/api/session/providers` items have exactly the keys `{id, name, platform}` (regression test for the leak).
2. Login URL shape and encoding. Login with a good code → JWT, user `vcsUserId='4242'`, `name='octo'`, first user is admin. Bad code → 400. Login gate: zero installations → 403.
3. Refresh: session expired and 3 GitHub apps → `GET /api/apps` triggers **exactly 1** refresh and lists all 3; the new tokens are saved. Adopt-path hook → still 200.
4. Access: index filters out the 404 app; `show` on it → 403.
5. Search: filtered, mapped to `IVcsProject`, sorted by `pushed_at`, at most 20, both pages fetched. An admin logged in via another integration → 400, and the mock receives no request.
6. Resolve: `.../acme/app/pull/3` → `acme/app`. Not installed → 400. Host mismatch → 400. Malformed URL → 400.
7. App create: GitHub without `vcsProjectId` → 400. `REPO_ID` round-trips exactly.
8. CI create:
    - push → subject is the first line of the message, author from the commit, `ciJobId='run:check'`;
    - a second create reuses the installation token (`access_tokens` count is 1);
    - pull_request → subject of the head commit (parents[1]);
    - commit fetch returns 500 → still 200, subject `''`, author is `actor`;
    - config without `appId` → no installation calls.
9. Approve (build created through OIDC, status set to `needs review` directly):
    - job re-run 201 → `vcsUrl = {url}/acme/app/actions/runs/{run}`;
    - job 403 then run-level 201 → URL;
    - both 403 → `{vcsUrl:false, vcsError}` containing GitHub's message, and the build is still `changes approved`;
    - moved repo → `apps.projectPath` updated in the DB;
    - `ciJobId` with run only → `rerun-failed-jobs` is called.
    - Dedupe: a new `check_run_id` with the same sha while `needs review` → `ciJobId` updated.
10. PAT: `ghp_valid` with no header, GitLab and GitHub integrations both present → resolves the GitHub one; `/api/ext/apps` filters by `/repositories`. `ghp_unknown` → 401.

**Unit specs** (run by `yarn test`, which picks up `*.spec.js`):

- A2's `VcsGitHub.service.spec.ts`: `parseCiJobId`, `githubUrls` (github.com vs Enterprise, trailing `/`), `parseProjectUrl`, branch derivation, subject truncation.
- A1's `VcsConfig.spec.ts`.

**CI wiring:** `test:all` (WP-A2 item 5). Both `.gitlab-ci.yml` and `.github/workflows/ci.yml` already run `yarn test:api`, so no YAML change is needed. Neither suite has a GitLab or GitHub dependency beyond the local mocks.

**e2e (`github-ui.spec.ts`)**

- Pre-authenticate with the existing JWT and mock everything with `page.route`. This respects the shared-seed gotcha: no DB writes and no `--reset-reviews` dependency.
- (a) Admin → Add Integration → GitHub: the GitHub fields show, the audience is prefilled with the origin, the callback URL text is present; submit captures a body with `platform:'github'` and every config key.
- (b) Apps → Add App with a mocked integrations list `[gitlab, github]`, mocked search, create and integration show: the snippet contains `docker://ghcr.io/zyno-io/pixelci/cli:latest`, `id-token: write`, the mocked audience, and the `.github/workflows/` label.
- (c) Login with mocked providers `[gitlab, github]` → two buttons with icons.
- No `takeScreenshot` calls, so the VRT screen set doesn't change. No seed change: a seeded GitHub app would alter the "App List" screenshot and the `.app.first()` ordering.

---

## 6. Risks and unknowns to verify on real GitHub (ranked)

1. **Re-run while the workflow run is still in progress** (other jobs running). GitHub likely rejects it. Approval can't be retried because the build is already `changes approved`, so the user must re-run manually. Capture the status and message; the docs and `vcsError` carry the run URL. A "Re-run CI" button for approved builds could come later.
2. **Refresh-token reuse.** Does reusing a refresh token revoke the newly issued tokens (token-family revocation)? Test with two refreshes of the same token. The coalescing helper only covers one process; the DB adopt-path covers replicas.
3. **Per-job re-run on an older attempt** (after a manual re-run), and which status codes come back (403 vs 422). Mitigated by the dedupe `ciJobId` update and the run-level fallback.
4. **Union-root `HttpBody` and discriminator generation** in ts-server-foundation. Confirmed by reading the code, not by running it. A1's tests and the `openapi.yaml` diff will prove it. Fallback: `config: Record<string, unknown>` plus manual per-platform validation (loses typed config in the UI client).
5. **`GET /repositories/{id}` is undocumented.** Also check what it returns for public and private repos without an install, with a user token and with a fine-grained PAT.
6. **Merge commit lookup.** Is the `refs/pull/N/merge` commit retrievable via `/commits/{sha}`, and is `parents[1]` the PR head?
7. **Search completeness** (the "explicit permission" wording) for org members who only have base permissions; the 1000-repo cap.
8. **SAML SSO and IP allow-list orgs.** User-token calls can return 403, so access checks fail closed and users see no apps. Document the SSO authorization step.
9. **GitHub Enterprise:** whether the `check_run_id` claim exists, support for `X-GitHub-Api-Version: 2022-11-28`, the `/_services/token` issuer, and callback URL matching.
10. **OAuth behaviours:** errors returned with HTTP 200 (handled); exact `redirect_uri` matching; install-time authorization without `state` (handled in UI and docs); Apps with non-expiring tokens (handled).
11. **Open login on github.com** combined with enforcement off. The installation gate and a docs warning cover it.
12. **ARM runners:** the CLI image is single-arch (`exec format error` on ARM). Also confirm `ghcr.io/zyno-io/pixelci/cli:latest` is published and public; `scripts/release.sh` doesn't publish to GHCR.
13. **The three newly wired suites** (`auth`, `onboarding`, `ext`) may already be failing; WP-A1 runs them first.

**Key paths**

- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/services/Vcs.service.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/services/VcsGitHub.service.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/services/VcsGitLab.service.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/controllers/{Session,VcsIntegrations,Builds,Apps}.controller.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/accessories/AuthMiddleware.accessory.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/src/entities/VcsIntegration.entity.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/api/tests/integration/`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/ui/src/screens/{onboarding,apps,login,screens}.vue`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/ui/src/screens/admin/vcs-integrations.vue`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/packages/mcp/src/index.ts`
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/node_modules/@zyno-io/ts-reflection/dist/index.js` (`$`)
- `/Users/sean/Work/Signal24/OSS/pixelci-gha/node_modules/@zyno-io/ts-server-foundation/dist/src/http/router.js:476-494,845-1080`
