# Changelog

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
