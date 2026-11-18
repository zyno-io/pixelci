# Changelog

## Unreleased

- **GitLab ID tokens for CI auth.** Declare `id_tokens: PIXELCI_ID_TOKEN` (with the server's `PUBLIC_URL` as `aud`) in a
  GitLab job and the CLI authenticates with it instead of `CI_JOB_TOKEN`. The server verifies the token's signature,
  issuer, audience, expiry and project against your GitLab instance's public keys, with no call to GitLab. `CI_JOB_TOKEN`
  still works. New server variables: `GITLAB_ID_TOKEN_AUDIENCES` (extra accepted audiences) and
  `GITLAB_JOB_TOKEN_AUTH_ENABLED` (set `false` to accept only ID tokens). Needs GitLab 15.7 or later
- **The web UI session is now an `HttpOnly` cookie** instead of a token in `localStorage`, so a script injected into the
  page can no longer steal it. State-changing browser requests are refused unless they come from PixelCI's own origin
  (`Origin` / `Sec-Fetch-Site`), the cookie is renewed while in use (`AUTH_JWT_EXPIRATION_MINS`, default 60, is the idle
  timeout) up to an absolute limit (new `SESSION_MAX_AGE_HOURS`, default 168), and `POST /api/session/logout` ends it.
  Logging out signs that user out of all of their sessions, on every browser and device, and a copied cookie stops
  working. (New `users.sessionsValidAfter` column; the migration is additive.)
  `POST /api/session/login` no longer returns the token. Bearer session tokens, CI tokens, MCP and `/api/ext` work as
  before. Everyone signs in once more after upgrading. `PUBLIC_URL` must be the `https` origin users visit, and a
  reverse proxy must pass `Origin` and `Sec-Fetch-*` through. Local development now proxies the whole API through the
  Vite dev server (see DEVELOPMENT.md)
- **Storage cleanup.** Screenshots, diffs and thumbnails that nothing needs any more are now removed from S3: uploads of
  unchanged screens once no later build, baseline or approval decision points at them, leftovers from re-runs, takeovers and
  failed uploads, and the data of apps deleted more than `APP_PURGE_AFTER_DAYS` (30) days ago. It starts in **dry-run**
  (logs what it would delete); set `STORAGE_GC_MODE=delete` to enable it. Never share a bucket between deployments with delete
  mode on. Run one pass by hand with `node . storage:gc [dry-run|delete] [appId]`. See "Storage cleanup" in the deployment guide
- Deleting an app now stops its CI uploads at once, and a screen whose own upload was cleaned up shows the image it matched
- **Upgrade notes:** the migration adds a `storage_sweeps` table and four indexes (on `builds_screens` and `screen_decisions`);
  large tables take a moment to index. Workers now also consume a `storage` queue

## v0.8.0

- **Approvals are remembered as changes: the screen's image before and after.** A build is approved automatically only
  when it makes a change that was already approved, from the same starting image, on any branch or after the merge. This
  fixes a branch's approved change being asked again on the default branch after another merge landed first, and an older
  approval letting a different change through (an approval older than the baseline, a rebase that dropped a newer
  default-branch change, or a removed screen re-added with its old image)
- **Branches are compared with the default branch where they forked**, not with its latest approved build, so changes made
  on the default branch since you branched no longer appear in your review. The CLI finds the merge base with git and uses
  the merge-request or pull-request base commit when there is one. Without git history it falls back to the latest
  approved build and the review page says so. Set `GIT_DEPTH: 0` (GitLab) or `fetch-depth: 0` (GitHub Actions). The CLI
  image now includes git. New variables: `PIXELCI_BASE_COMMIT` and `PIXELCI_GIT_FETCH`
- **Rejections stick.** A rejected change arrives pre-marked as rejected on every branch that makes it, showing who
  rejected it and where, until someone approves it
- **Revoke an approval** from the build it was made in. Future builds that make the same change ask again; builds already
  approved stay approved
- Clearer audit trail: automatically approved screens show the review they came from, and review marks carried from the
  branch's previous build say so. Review marks now carry over only within a branch; decisions travel between branches as
  approvals and rejections. In MCP and `/api/ext`, `reviewedByName` is null for screens nobody reviewed in that build, and
  a new `decision` field is added
- When matching earlier approvals, PixelCI uses each screen's current tolerances and masks. Screens byte-identical to
  their baseline skip the pixel comparison
- Fixed: the diff for an automatically approved screen could be against an older baseline than the image beside it. The
  review screen, the gallery and the external API now show the two images processing compared and the diff between them
- Fixed: processing and the tolerance preview compared against the reference build's own upload instead of the image it was
  matched to
- Fixed: comparing two screenshots of different shapes could allocate a canvas far above `SCREEN_MAX_PIXELS` and exhaust
  memory; a pair whose padded canvas exceeds the cap now counts as fully changed without a pixel comparison, and the
  compare preview says so
- Fixed: checking other branches' approved changes could overwrite a screen's stored diff
- **Upgrade notes:** approvals made before this release are not reused, so in-flight branches may ask once more. Approved
  builds remain baselines
- **Breaking (API):** `process` accepts `base`; the create response adds `defaultBranch`; build and screen responses add
  reference and decision fields; new `POST /api/apps/:appId/decisions/:id/revoke`

## v0.7.0

- Masks: draw rectangles over the parts of a screen that change on every run (a clock, an ad, a live chart) and PixelCI
  ignores them. The pixels under a mask never make a screen differ, and they are left out of the percentage, so **Changed
  pixels allowed** is now a share of the pixels that are compared. Masks can be set per screen by anyone who can review
  the app, and per app by administrators; a screen uses the app's masks plus its own, and can opt out of the app's. They
  apply from the next build, like tolerances
- Draw, move and resize masks in the screen lightbox, or type their position in pixels. Every mask can be moved, resized
  and deleted from the keyboard. The lightbox previews proposed masks against the build you are looking at ("would pass",
  and how many pixels are masked) before you save
- Each build records the masks every screen was compared with. The review screen draws them over both screenshots as a translucent grey fill with thin diagonal lines and tags
  the screen **Masked**, the diff shows masked pixels under the same grey tint and lines, and the gallery tags masked screens
  and counts them under **Custom**. `appliedMasks` is available to the MCP server and the `/api/ext` build detail
- **Breaking:** the `POST /api/apps/:appId/builds/:buildId/screens/:screenId/compare` endpoint now requires a `masks` array
  in its body (send `[]` for none) and returns `maskedPixels`

## v0.6.1

- Re-release of v0.6.0, whose tag build failed before publishing the server and CLI images. No changes to PixelCI itself

## v0.6.0

- **Breaking:** `DEFAULT_PIXEL_DIFF_PCT_THRESHOLD` is now a true percentage of pixels. It used to be divided by 100 a second
  time, so the old default of `1` really flagged screens above 0.01%. The default is now `0.01` and behaves the same as
  before. If you set this variable yourself, divide your value by 100 to keep your current behaviour
- Shift tolerance: content that only moved by a pixel or two (text that renders slightly to the side) is no longer counted
  as changed. On by default at 1px (`DEFAULT_PIXEL_SHIFT_TOLERANCE`, `0` turns it off), so some screens that were flagged
  before will now pass. An edge that grows or shrinks by no more than the radius is forgiven too
- Comparison tolerances (color tolerance, shift tolerance, changed pixels allowed) can be set per app by administrators and
  per screen by anyone who can review the app, each falling back to the level above. The tolerance panel previews proposed
  values against the build you are looking at before you save
- Screen gallery: browse an app's baseline screens, or one build's screens, as thumbnails and open any of them at full size.
  Thumbnails are scaled-down copies made when a build is processed (or the first time a screen is shown, for
  builds processed before this) and kept in storage beside the screenshot (`<screen>.<upload>.thumb.png`)
- License updated to the PixelCI Source Available License, Version 1.2
    - Material you post in an issue or discussion and mark “Not a Contribution” (for example, code from your own app
      pasted into a bug report) is excluded from the contribution terms. The marking does not apply to pull requests,
      merge requests or patches, which are covered by the CLA
- **Breaking:** the MCP server is now served by the API at `/api/mcp` over Streamable HTTP, and the stdio `@zyno-io/pixelci-mcp` package is removed
    - Reconfigure MCP clients to use the HTTP endpoint, e.g. `claude mcp add --transport http pixelci https://pixelci.example.com/api/mcp --header "Authorization: Bearer <token>"`. See the LLM Access guide
    - Personal access tokens keep working
- MCP connectors can sign in with OAuth (claude.ai, Claude Desktop, Claude Code), no personal access token needed. PixelCI acts as the authorization server (PKCE, dynamic client registration). Manage access under Connected apps
    - Requires `PUBLIC_URL` to be an `https` address. Set `MCP_OAUTH_ENABLED=false` to turn it off. Registration is rate limited (Redis-backed), see the deployment guide
- OAuth clients can identify themselves with a metadata URL (Client ID Metadata Documents); the approval screen shows the publishing domain. Set `OAUTH_CIMD_ENABLED=false` to turn it off; it needs outbound HTTPS from the API, see the deployment guide
- Request logs and traces now redact query-string values such as OAuth `code` and `state`

## v0.5.0

- **Breaking:** PixelCI now requires PostgreSQL 15+ (PostgreSQL 18 recommended); MySQL is no longer supported
    - Replace the `MYSQL_*` environment variables with `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD_SECRET` and `PG_DATABASE`
    - The database schema is now created by a single base migration. Existing MySQL data is not migrated automatically
- GitHub Actions integration: GitHub App login, OIDC-authenticated CLI (no secrets), and per-job re-run after approval
  (push, pull_request, workflow_dispatch and schedule events; GitHub Enterprise Server support is untested). See the GitHub Setup guide
- GitHub: if the workflow run is still in progress when a build is approved, PixelCI now re-runs the job automatically once the run
  finishes (checked every minute, up to 6 hours) instead of asking for a manual re-run
- MCP/`/api/ext` read access now accepts GitHub personal access tokens; token env var is `PIXELCI_VCS_TOKEN`
  (`PIXELCI_GITLAB_TOKEN` and `PIXELCI_GITHUB_TOKEN` remain as aliases)
- License updated to the PixelCI Source Available License, Version 1.1. Self-hosting for internal use remains free
    - Adds contribution terms (inbound license to the Licensor) and permits forking to prepare a contribution
    - You own the copyright in your own modifications, which remain subject to the License
    - Contractors no longer need confidentiality obligations; they must be bound to use your copies and deployments only on
      your behalf. Your affiliates may use PixelCI under your license
    - A contractor or service provider may operate your instance, but not one that offers PixelCI hosting or management
      as a service to others; that requires a commercial license
    - Termination: 30-day cure period for breaches other than hosting, embedding, distribution, white-labelling,
      circumvention, or willful breach. Licensor notices must be retained on copies
    - Examples replaced with PixelCI-specific ones. Agencies may test the sites they build for clients; offering visual
      regression testing as a service to others requires a commercial license
    - Sister companies related only through a common financial investor are not affiliates
- The CLI (`packages/cli`, the `pixelci/cli` image) and the MCP server (`packages/mcp`) are now licensed under the MIT
  License, including earlier releases
- Contributions now require signing the Contributor License Agreement (`CLA.md`), checked by a CLA bot on GitHub pull
  requests. See `CONTRIBUTING.md`

## v0.4.0

- Apply the CI Dashboard design system across the UI, including accessible menus,
  light/dark/system themes, semantic status colors, and responsive review controls.
- Update dependencies across all workspaces to the latest releases.
- Fix build-navigation checks to select the branch name independently of commit links.
- Support Helm `envValueFrom` configuration.
- Mirror release history without force-pushing.
- Run TSF compiler setup during API installation, aligning the API and CLI with
  TSF's supported compiler versions and native package settings.
- Prepare the compiler during container builds, including TSF's Node 24 patch,
  and keep compiler tooling out of the CLI runtime image.
- Preserve the release version in container metadata when no build version override is supplied.

## v0.3.0

- Per-screen build review, with bulk approve and explicit build rejection
- Read access for LLMs/MCP via GitLab PAT, gated on project access
- Zoom for screens, including the diff overlay, with centring fixes
- Apps list search and screen review UX improvements
- **Fixed screen names being truncated on upload.** The CLI derived a name by trimming
  `sourcePath.length` off the front of each path, but `fs.glob` returns a _normalized_ path
  — so invoking with `./screenshots` silently ate the first two characters of every screen
  name, and a trailing slash ate one. Names are the screen identity (`{ appId, name }`), so
  this attached review history to the wrong record. Now derived with `path.relative`.
- Fixed new-build images being sized inconsistently with the reference build, and
  overscaled images

## v0.2.0

- Light/dark mode toggle

## v0.1.0

- Initial release
