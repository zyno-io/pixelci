# Changelog

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
