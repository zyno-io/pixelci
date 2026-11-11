# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally:

- **Developers unblocking CI.** Their pipeline failed with "needs review". They arrive from a link in the CI job log, check the diffs, approve or fix, and return to the merge request. The visit is short and task-driven.
- **Dedicated reviewers.** QA, designers, and leads who review visual changes across many builds and apps as a recurring part of their work. Not necessarily engineers.

Secondary: **instance operators/admins** who deploy PixelCI, connect VCS integrations, and manage users.

Deployment audiences, also equal targets: teams running a **self-hosted** instance today, and customers of a **hosted SaaS** version that is planned but not yet shipped.

## Product Purpose

PixelCI is a visual regression testing platform. CI uploads screenshots from each build; PixelCI compares them against approved baselines and surfaces only the changes that need a human decision.

It exists so teams catch unintended visual changes before merge without drowning in false positives or re-approving the same change on every branch.

Success: a reviewer reaches a confident approve/reject decision quickly, and the pipeline moves on.

## Positioning

- **Cross-branch approval tracking.** A change approved on one branch is recognized on every other branch, so each change is reviewed once.
- **Branch-aware baselines.** Each build is compared against the right reference: the previous approved build on its branch, then the latest approved build on the default branch.
- **Self-hosted, source-available.** Screenshots and diffs stay on the team's own infrastructure.
- **Closes the CI loop.** Approving a build restarts the failed CI job and sends the reviewer to the pipeline.

## Operating Context

- Entry point is usually a direct link from a failed CI job to a specific build, not the app list.
- Review flow: apps → builds (grouped by branch) → screens for one build, compared side by side against the reference build.
- Review tools on the screens view: "Show Changes" filter (changed screens only) and "Show Diff" overlay (changed pixels highlighted).
- Decisions are per screen (approve/reject, with comments) and per build (approve).
- After approval the user leaves PixelCI for the VCS pipeline.
- Access mirrors the VCS: users see only apps whose project their account can access on GitLab or GitHub (operators can disable this).
- A CLI runs inside CI to upload screenshots and poll for a result; a read-only MCP server lets AI assistants read build status, decisions, and comments.

## Capabilities and Constraints

- **Workspaces:** `packages/ui` (Vue 3 review app), `packages/api` (backend and worker), `packages/cli` (CI uploader), `packages/mcp` (read-only MCP server), `docs/` (documentation site, docs.pixelci.dev).
- **UI routes:** login, apps, builds, screens, admin (users, VCS integrations), first-run onboarding.
- **Build statuses (fixed terminology):** `draft`, `processing`, `no changes`, `needs review`, `changes approved`.
- **Other fixed terms:** app, branch, build, screen, reference build, baseline, diff, threshold.
- **Comparison:** pixel-by-pixel, flagged only above a configurable threshold (default 1%). Screens absent from the baseline are marked new.
- **VCS/CI:** GitLab (OAuth login, GitLab CI) and GitHub (GitHub Actions). Setup guides: `docs/gitlab-setup.md`, `docs/github-setup.md`.
- **Themes:** the UI ships in light and dark.
- **Auth:** login is via the configured OAuth provider; there are no local passwords.
- **Generated code:** `packages/ui/src/openapi-client-generated/` is generated from the API and never hand-edited.
- **Screenshots are the content.** Image dimensions and counts vary per app and are outside PixelCI's control.
- **License:** PixelCI Source Available License v1.1 (`LICENSE.md` is authoritative): source-available, with hosting it as a service for third parties reserved to the licensor. The CLI and MCP server are MIT.

Undecided or unshipped (do not present as available): hosted SaaS, teams and multi-user permissions, baseline management UI, Slack/Discord notifications, comparison history and analytics. No pricing has been published.

## Brand Commitments

- Name: **PixelCI** (one word, capital P, capital CI).
- Maker: Zyno Consulting (Signal24 LLC dba Zyno Consulting).
- Mark: the favicon, a 2x2 pixel grid inside a CI cycle arrow (`packages/ui/public/favicon.svg`, `docs/public/favicon.svg`). In the UI the brand appears as a small grid glyph beside the text wordmark "PixelCI". There is no separate logo asset; `packages/ui/public/assets/logo.svg` is an unused Vue scaffold leftover.
- Public tagline in use: "Self-hosted visual regression testing for your GitLab CI/CD and GitHub Actions pipelines."

## Evidence on Hand

- Real product screenshots, light and dark, of login, app list, build list, screen list, diff mode, and all-screens view: `docs/public/images/`.
- Product documentation: `docs/` (getting started, deployment, GitLab setup, GitHub setup, usage, LLM access).
- PixelCI tests its own UI with PixelCI in CI.

Absent, never to be fabricated: customer names or logos, testimonials, usage numbers, benchmarks, competitor comparisons, pricing, SaaS availability dates.

## Product Principles

1. **Review each change once.** An approval made anywhere should never be asked for again.
2. **The screenshot is the subject.** The interface exists to make differences between two images obvious; it stays out of their way.
3. **Fast path for the developer, depth for the reviewer.** A CI-link visitor can decide in one screen; a recurring reviewer can work through volume without friction.
4. **The same product self-hosted and hosted.** Nothing in the experience assumes a single deployment model.
5. **Mirror the VCS, don't duplicate it.** Identity, access, and the pipeline belong to the VCS; PixelCI hands the user back to it.
