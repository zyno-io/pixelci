# Changelog

## Unreleased

- GitHub Actions integration: GitHub App login, OIDC-authenticated CLI (no secrets), and per-job re-run after approval
  (push, pull_request, workflow_dispatch and schedule events; GitHub Enterprise Server supported). See the GitHub Setup guide
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
