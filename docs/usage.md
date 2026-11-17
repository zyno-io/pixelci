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

Click a build to view its screenshots. **Screens** in the header opens the app's [screen gallery](#screen-gallery).

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

## Sharded Suites

If your screenshots come from a test suite split across several CI jobs (parallel jobs, a matrix), tell PixelCI which slice each job uploads with `PIXELCI_SHARD=<index>/<total>` (1-based, for example `2/4`). `total` can be at most 64; `1/1` means unsharded.

- Each job uploads only its own screenshots. Screen names must be unique across shards (a duplicate is rejected with a 409).
- PixelCI starts comparing once **every** shard has uploaded. Until then the build reports `processing`.
- Every job waits for, and exits with, the same single build result. Approving the build re-runs every shard's CI job (on GitHub, the workflow run).
- Every shard must use the same total, and all shards must start within the CLI timeout of each other, or the early ones give up waiting. The build stays open while any shard job is polling, so a slow shard can join as long as the earlier shards are still waiting.
- A job that has no screenshots for its slice may upload none; at least one shard must upload something.
- Without `PIXELCI_SHARD`, two jobs for the same commit that upload different screenshots are rejected with a 409 rather than silently comparing the wrong set.

Requires `@zyno-io/pixelci-cli` 2.x and a server that supports shards.

GitLab (`parallel:`):

```yaml
visual-test:
    parallel: 4
    variables:
        PIXELCI_SHARD: $CI_NODE_INDEX/$CI_NODE_TOTAL
```

GitHub Actions (matrix):

```yaml
jobs:
    visual-test:
        strategy:
            matrix:
                shard: [1, 2, 3, 4]
        steps:
            - run: npx @zyno-io/pixelci-cli ./screenshots
              env:
                  PIXELCI_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}
```

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

## Screen Gallery

The gallery shows screens as thumbnails, without the side-by-side review layout. There are two of them:

- **An app's screens.** Open it with **Screens** on the build list. It shows each screen as new builds will be compared against it: the image from the latest approved build on the default branch. A screen that has been uploaded since but isn't part of that baseline yet is tagged **Not in baseline** and shows its latest upload.
- **A build's screens.** Open it with the grid button in the header of the screen comparison view. It shows every screen in that build with its status.

Type in **Find a screen** to filter by name, use the buttons beside it to show only changed, unchanged or custom screens (those with their own [tolerances](#tolerances) or [masks](#masks)), and pick a thumbnail size. Thumbnails take the shape of your screenshots; a screenshot much taller than its thumbnail shows its top.

Click a thumbnail to open the screen at full size. There, the **left and right arrow keys** step through the screens, **Fit**, **100%** and **200%** set the zoom, and in a build's gallery you can switch between the new build, the reference and the diff (or hold **D** for the diff). The panel beside the image shows the screen's details, its [tolerances](#tolerances) and its [masks](#masks).

## Tolerances

Three values decide when a screen counts as changed:

| Value                      | What it does                                                                                                                                                           | Default |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Color tolerance**        | How far a pixel's color may drift before it counts as changed, from 0 (exact match) to 1                                                                               | `0.2`   |
| **Shift tolerance**        | Content that only moved by up to this many pixels is not counted (0 to 5; 0 turns it off). This is what stops text that renders a pixel to the side from being flagged | `1` px  |
| **Changed pixels allowed** | The percentage of the screenshot that may still differ before the screen is flagged                                                                                    | `0.01`% |

Each value can be set at three levels, and the most specific one that is set wins:

1. **Instance** — the defaults above, which an operator can change with [environment variables](/deployment#tuning).
2. **App** — click **Tolerances** in the app's screen gallery. Administrators can change these; everyone else can read them.
3. **Screen** — open the screen from a gallery, or click **Tolerance** on its card in the screen comparison view. Anyone who can review the app can change these.

Leave a field empty to follow the level above; the field shows the value it would use. The reset button beside a field returns it to following.

When you open a screen from a build, the tolerance panel runs the comparison again with the values in the fields and tells you whether the screen **would pass** or **would be flagged**, how many pixels differ, and how many were ignored as shifted. Choose **Diff** above the image to see the diff those values produce. Nothing is saved until you click **Save for this screen**.

Saved tolerances apply from the next build. A build that has already been processed keeps its result, so a screen you are reviewing still needs its Approve or Reject.

## Masks

A mask is a rectangle on a screen whose pixels never affect the result. Use one for content that changes on every run: a clock, an ad slot, a rotating avatar, a live chart. Nothing under a mask can make a screen differ, and masked pixels are left out of the percentage too: **Changed pixels allowed** is a share of the pixels that are compared, not of the whole screenshot. A screen that is entirely masked has nothing to flag.

Masks can be set at two levels, and both apply:

1. **App** — in the lightbox of any screen, click **Edit app masks**. Administrators can change these; everyone else sees them drawn dashed. They apply to every screen in the app, so keep them to things that really are on every screen, such as a header clock.
2. **Screen** — open the screen from a gallery, or click **Tolerance** on its card in the screen comparison view, and use the **Masks** section. Anyone who can review the app can change these.

A screen is compared with its own masks plus the app's. Untick **Use app masks** to leave the app's out for that screen.

### Drawing and editing

In the **Masks** section:

- Click **Draw mask**, then drag on the screenshot. **Add mask** (or **N**) puts a mask in view that you then move and resize.
- Drag a mask to move it and drag its handles to resize it, or type its **X**, **Y**, **W** and **H** in the list. Add a label if you want a reminder of what it covers (up to 80 characters).
- **Hide masks** (or **M**) hides the outlines while you look at the screenshot.
- Each screen can have 50 masks, and the app another 50.

Masks are fully usable from the keyboard. Tab to a mask; the **arrow keys** move it by 1 pixel (hold **Shift** for 10), **Alt** with the arrows resizes it, **Delete** removes it, and **Escape** returns to the screenshot. **Escape** also cancels a draw in progress.

When you open a screen from a build, the preview on the lightbox panel runs the comparison again with your masks and tells you whether the screen **would pass** or **would be flagged**, and how many pixels are masked. Nothing is saved until you click **Save masks** (or **Save app masks**). If someone else saved masks for the same screen or app first, PixelCI reloads what they saved and discards your unsaved edits, so you never overwrite them unseen.

### Where masks sit

- **Pixels, from the top-left.** A mask is a rectangle in whole pixels measured from the top-left corner of the screenshot, so it keeps the same position in every build.
- **Masks never scale.** If a screenshot changes size (a full-page capture that gets longer, or a different device pixel ratio), the mask stays at the same pixel position. Anything past the edge of the compared area is ignored, and PixelCI tells you when a mask is partly or wholly outside the screenshot you are looking at.
- **Pad for anti-aliasing.** A changed pixel right next to a mask is always counted, even if it would otherwise pass as anti-aliasing, so leave a pixel or two of padding around masks.
- **Pad for shift tolerance.** Content that moves across a mask's edge can still show up as a thin sliver of difference, up to the [shift tolerance](#tolerances) wide, just outside it. Make masks at least that much larger than the content they hide.
- **Layout that moves needs a different tool.** A fixed rectangle can't follow content that reflows. If it does, mask it where you take the screenshot instead: Playwright's `page.screenshot({ mask: [page.locator('.clock')] })` paints over the elements wherever they are, and PixelCI then sees identical pixels there.

### Reviewing masked screens

Masks apply from the next build. A build that has already been processed keeps its result, so a screen you are reviewing still needs its Approve or Reject, and a build that needs review stays that way; the preview will say it would pass, and approving re-runs your CI as usual.

Because masks can hide a real regression, each screen in a build records the masks it was compared with. On the review screen they're drawn as dashed outlines over both screenshots and the diff, and the screen carries a **Masked** tag. The diff image shows masked pixels in a grey hatch, so red and yellow keep their meaning. The lightbox warns when masks cover more than half of a screenshot. [LLM access](/llm-access) reports the same masks as `appliedMasks`.

A screen that comes out unchanged is shown using the earlier approved image rather than its own upload, so what you see can differ from what was uploaded inside a mask.

## How Comparisons Work

When a build is processed, PixelCI runs a multi-stage comparison:

1. **Previous build on same branch** — checks if changes match a previously approved build on this branch
2. **Default branch baseline** — compares against the latest approved build on the default branch
3. **Cross-branch matching** — looks for identical approved changes on other branches since the baseline
4. **New screen detection** — screens not present in the baseline are flagged as new

Every one of these comparisons ignores the screen's [masks](#masks): the pixels under them are treated as identical, and they are left out of the percentage.

Changes are flagged only when the share of differing pixels exceeds the screen's [tolerance](#tolerances) (by default, 0.01% of the compared pixels). This approach minimizes false positives — once a change is approved anywhere, it's recognized across all branches.
