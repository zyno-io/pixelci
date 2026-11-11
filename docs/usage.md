# Using PixelCI

A walkthrough of the PixelCI web UI for reviewing visual regression test results.

## Login

Visit your PixelCI instance and log in via your configured OAuth provider (GitLab or GitHub).

<img src="/images/login-light.png" alt="Login page" class="light-only">
<img src="/images/login-dark.png" alt="Login page" class="dark-only">

## Apps List

After logging in, you'll see your apps. PixelCI only shows apps whose VCS project your account can access — access mirrors what GitLab or GitHub grants you. (Operators can disable this filtering; see [`ENFORCE_VCS_PROJECT_ACCESS`](/deployment#access-control).)

<img src="/images/app-list-light.png" alt="App list" class="light-only">
<img src="/images/app-list-dark.png" alt="App list" class="dark-only">

Click an app to view its builds.

## Build List

The build list shows all builds for an app, grouped by branch. Each build displays its status:

- **Needs Review** — new visual changes detected that need approval
- **No Changes** — all screenshots match approved baselines
- **Changes Approved** — all changes in this build have been approved
- **Changes Rejected** — a reviewer rejected one or more screens

<img src="/images/build-list-light.png" alt="Build list" class="light-only">
<img src="/images/build-list-dark.png" alt="Build list" class="dark-only">

Click a build to view its screenshots.

## Screen Comparison

The screen comparison view shows screenshots from the new build alongside the reference build (the approved baseline on the default branch).

<img src="/images/screen-list-light.png" alt="Screen list" class="light-only">
<img src="/images/screen-list-dark.png" alt="Screen list" class="dark-only">

### Who can review

Anyone who can open a build can look at it. Reviewing screens and approving the build needs at least the role the app's admin chose under **Who Can Approve Builds** in the app settings: anyone who can view the app, write access (the default; Developer in GitLab, Write in GitHub), or maintainers only. PixelCI admins can always review. Without the role, the build opens read-only with a notice saying what access is needed.

### Needs review / All screens

Use the **Needs review** and **All screens** buttons at the top to choose what's listed. **Needs review** shows only screens with visual differences (including new screens, and screens removed from the build), so you can focus on what's changed. It's the default whenever anything needs review. **All screens** lists every screen in the build; unchanged screens appear as collapsed one-line rows, and the chevron reveals their screenshot.

<img src="/images/screen-all-light.png" alt="All screens" class="light-only">
<img src="/images/screen-all-dark.png" alt="All screens" class="dark-only">

### Diff

Enable **Diff** to highlight pixel differences between the reference and new screenshots. Changed pixels are overlaid on the new screenshot so you can see exactly what moved or changed. Besides the checkbox, you can **Shift+click** a screenshot to toggle the diff for every screen, or **hold D** to flash it while you look. New screens have no reference, so they have no diff.

<img src="/images/screen-diff-light.png" alt="Screen list with diff mode" class="light-only">
<img src="/images/screen-diff-dark.png" alt="Screen list with diff mode" class="dark-only">

### Zoom

Pick a zoom from the select in the header: **Fit width**, **Fit height**, **25%**, **50%**, **100%** or **200%**.

- **Fit width** scales each screenshot down to its column and never above its real size. This is the default.
- **Fit height** scales each screenshot so the whole of it fits the pane's height, never above its real size. A very long page becomes small.
- **25%** to **200%** are percentages of the screenshot's real size: 100% shows one image pixel per screen pixel, 25% a quarter of its width, 200% double.

When a screenshot is larger than its pane, the pane scrolls, and the reference and new panes pan together so the same region stays aligned. The choice is remembered per app.

### Keyboard Shortcuts

| Key           | Action                    |
| ------------- | ------------------------- |
| **J** / **K** | Next / previous screen    |
| **A**         | Approve the active screen |
| **R**         | Reject the active screen  |
| **D** (hold)  | Flash the diff            |

Shortcuts are paused while you type in a comment box or have a dialog open.

## Reviewing Changes

When a build is in **Needs Review**, every screen that needs review has its own controls beneath the comparison: a comment box and **Approve** / **Reject** buttons. Builds in any other status are read-only.

- **Approve** or **Reject** each screen to record your decision. Type an optional comment first; it's saved together with the decision.
- Once you act on a screen it **collapses** so you can focus on what you haven't seen yet. Click it to expand again and change your decision.
- Reviewed screens show an **Approved** or **Rejected** badge, and the comment appears in the collapsed summary.
- Screens removed from the build are listed with a **Removed** tag. They have nothing to review.

### Approving the Build

The bar at the bottom of the screen shows your progress (e.g. "2 of 5 reviewed") and the submit button. You don't have to review every screen first: **any screen you haven't reviewed is approved when you submit**, and the confirmation tells you how many. The button reads **Approve build**, or **Submit review** once you've rejected a screen.

If you've rejected any screen, submitting marks the build **Changes Rejected** and the CI check stays failed. Nothing is promoted to the baseline, and you're returned to the build list.

Otherwise the build is approved:

- The build status changes to **Changes Approved**
- The failed CI job is automatically re-run via the GitLab or GitHub API (approving re-runs the CI job), and you're redirected to the pipeline or workflow run page. (On GitHub, PixelCI re-runs the specific failed job using your token, so you need write access; see [GitHub Setup](/github-setup#_8-approve-and-re-run).)
- Screens removed from the build leave the baseline
- Future builds on the same branch will compare against this build
- Other branches that produce the same visual changes will be automatically approved (cross-branch approval matching)

### Carrying Reviews Forward

You don't have to re-approve the same screen on every build. When a new build is processed, any screen that was individually approved or rejected since this branch's last approval is **pre-marked with that same decision (and comment)** — as long as the screenshot still matches. Unchanged screens arrive already reviewed and collapsed, so you only review what's genuinely new.

## Build Status Flow

Every build moves through these statuses:

```
draft → processing → no changes
                   → needs review → changes approved (after approval)
                                  → changes rejected (a screen was rejected)
                   → changes approved (auto-approved)
```

| Status               | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| **draft**            | Build created, screenshots being uploaded                    |
| **processing**       | Comparing screenshots against baselines                      |
| **no changes**       | All screenshots match — nothing to review                    |
| **needs review**     | Visual differences found — human review required             |
| **changes approved** | All changes approved (manually or via cross-branch matching) |
| **changes rejected** | A reviewer rejected one or more screens when submitting      |

## How Comparisons Work

When a build is processed, PixelCI runs a multi-stage comparison:

1. **Previous build on same branch** — checks if changes match a previously approved build on this branch
2. **Default branch baseline** — compares against the latest approved build on the default branch
3. **Cross-branch matching** — looks for identical approved changes on other branches since the baseline
4. **New screen detection** — screens not present in the baseline are flagged as new

Changes are flagged only when pixel differences exceed the configured threshold (default 1%). This approach minimizes false positives — once a change is approved anywhere, it's recognized across all branches.
