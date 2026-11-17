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

The screen comparison view shows screenshots from the new build alongside the reference build: the approved baseline on the default branch **where this build's branch forked from it**. The header names it (`base main @ abc1234`) and links to that build. See [How the Baseline Is Chosen](#how-the-baseline-is-chosen).

If PixelCI couldn't work out where the branch forked, it compared against the latest approved default-branch build instead and a notice at the top of the page says so.

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
- A line under the screen's name says where its state came from: **Approved by** a reviewer, **Approved automatically** because the same change was already approved, a **Rejected** mark from an earlier build, or a mark **Carried over** from this branch's previous build. See [Approvals and rejections](#approvals-and-rejections).

### Approving the Build

The bar at the bottom of the screen shows your progress (e.g. "2 of 5 reviewed") and the submit button. You don't have to review every screen first: **any screen you haven't reviewed is approved when you submit**, and the confirmation tells you how many. The button reads **Approve build**, or **Submit review** once you've rejected a screen.

If you've rejected any screen, submitting marks the build **Changes Rejected** and the CI check stays failed. Nothing is promoted to the baseline, and you're returned to the build list.

Otherwise the build is approved:

- The build status changes to **Changes Approved**
- The failed CI job is automatically re-run via the GitLab or GitHub API (approving re-runs the CI job), and you're redirected to the pipeline or workflow run page. (On GitHub, PixelCI re-runs the specific failed job using your token, so you need write access; see [GitHub Setup](/github-setup#_9-approve-and-re-run).)
- Screens removed from the build leave the baseline
- Each approved change is remembered (see below), so any build that makes the same change, on any branch or after the merge, is approved automatically
- Builds on the default branch that are approved become baselines for the branches forked from them afterwards

### Approvals and Rejections

PixelCI remembers an approval as a **change**: the screen's image before, and the image after. A later build is approved automatically only when all of these hold:

- its baseline is the same image the approval started from;
- the approval is newer than that baseline image;
- its screenshot matches the approved result, using the screen's **current** [tolerances](#tolerances) and [masks](#masks).

So an approval can't let a different change through. If the default branch changed the same screen in the meantime, the starting image differs and PixelCI asks again. A screen that was removed and later re-added with its old image is asked again too. An approval made on one branch applies to others straight away, with no merge needed.

A screen approved this way shows **Approved automatically: the same change was approved on _branch_ in _abc1234_ by _name_**, so you can see which review it came from.

Rejections stick the same way. A rejected change arrives on every branch that makes it **pre-marked as rejected**, with who rejected it, where, and why. Approve it to override.

### Carrying Reviews Forward

Within a branch, you don't have to re-review a screen on every build. A mark you made on the **immediately preceding build of the same branch** (approved or rejected, with its comment) is carried to the new build, as long as the screen makes the same change. The screen says **Carried over from _abc1234_ (reviewed by _name_)**. A carried mark isn't attributed to you until the build is submitted. Marks don't carry across branches; approvals and rejections do, as described above.

### Revoking an Approval

Approved by mistake? Open the build the approval was made in and click **Revoke approval** beside the screen (reviewers only; screens removed from the build have it too). Future builds that make the same change ask again. Builds that were already approved stay approved. A revoked approval can't be restored; if the change comes back, approve it again. Screens that were approved automatically from a revoked approval say **(since revoked)**.

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

| Status               | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| **draft**            | Build created, screenshots being uploaded                                      |
| **processing**       | Comparing screenshots against baselines                                        |
| **no changes**       | All screenshots match — nothing to review                                      |
| **needs review**     | Visual differences found — human review required                               |
| **changes approved** | All changes approved (manually, or via an earlier approval of the same change) |
| **changes rejected** | A reviewer rejected one or more screens when submitting                        |

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

Tolerances also apply when PixelCI matches a build against earlier approvals, and it uses the values in force when the build is processed: changing a screen's tolerances applies to approvals made before the change as well.

## Masks

A mask is a rectangle on a screen whose pixels never affect the result. Use one for content that changes on every run: a clock, an ad slot, a rotating avatar, a live chart. Nothing under a mask can make a screen differ, and masked pixels are left out of the percentage too: **Changed pixels allowed** is a share of the pixels that are compared, not of the whole screenshot. A screen that is entirely masked has nothing to flag.

Masks can be set at two levels, and both apply:

1. **App** — in the lightbox of any screen, click **Edit app masks**. Administrators can change these; everyone else sees them read-only. They apply to every screen in the app, so keep them to things that really are on every screen, such as a header clock.
2. **Screen** — open the screen from a gallery, or click **Tolerance** on its card in the screen comparison view, and use the **Masks** section. Anyone who can review the app can change these.

A screen is compared with its own masks plus the app's. Untick **Use app masks** to leave the app's out for that screen.

### Drawing and editing

In the **Masks** section:

- Click **Draw mask**, then drag on the screenshot. **Add mask** (or **N**) puts a mask in view that you then move and resize.
- Drag a mask to move it and drag its handles to resize it, or type its **X**, **Y**, **W** and **H** in the list. Add a label if you want a reminder of what it covers (up to 80 characters).
- **Hide masks** (or **M**) hides the masks while you look at the screenshot.
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

Masks apply from the next build, and they also apply when matching earlier approvals, retroactively: an approval made before you added a mask still matches a build whose only difference is under it. A build that has already been processed keeps its result, so a screen you are reviewing still needs its Approve or Reject, and a build that needs review stays that way; the preview will say it would pass, and approving re-runs your CI as usual.

Because masks can hide a real regression, each screen in a build records the masks it was compared with. On the review screen they're drawn as a translucent grey fill with thin diagonal lines over both screenshots, and the screen carries a **Masked** tag. The diff image tints masked pixels with the same grey and draws the same thin diagonal lines, so red and yellow keep their meaning. The lightbox warns when masks cover more than half of a screenshot. [LLM access](/llm-access) reports the same masks as `appliedMasks`.

A screen that comes out unchanged is shown using the earlier approved image rather than its own upload, so what you see can differ from what was uploaded inside a mask.

## How Comparisons Work

When a build is processed, PixelCI works out each screen's outcome in this order:

1. **Reference build** — the approved default-branch build where this build's branch forked (see below).
2. **Baseline comparison** — each screenshot is compared with that build's image of the same screen. A screenshot byte-identical to its baseline skips the pixel comparison and is **unchanged**.
3. **Earlier approvals** — if it differs, PixelCI looks for an [approval of the same change](#approvals-and-rejections) (same starting image, matching result) from any branch. A match approves it automatically. A rejection of the same change pre-marks it as rejected instead.
4. **New screen detection** — screens not present in the baseline are flagged as new.

Every one of these comparisons ignores the screen's [masks](#masks): the pixels under them are treated as identical, and they are left out of the percentage.

Changes are flagged only when the share of differing pixels exceeds the screen's [tolerance](#tolerances) (by default, 0.01% of the compared pixels). This minimizes false positives, and once a change is approved anywhere, builds that make the same change are recognized on every branch.

### How the Baseline Is Chosen

A branch is compared with the default branch **at the point where it forked**, so changes made on the default branch since you branched don't show up in your review.

- The CLI finds the fork point with git (the merge base with the default branch) and sends PixelCI the nearest 50 commits leading up to it. PixelCI uses the first of those with an approved default-branch build (**changes approved** or **no changes**).
- In a GitLab merge request pipeline or a GitHub pull request, the CLI uses the request's own base commit.
- If the default branch's build for the fork point is still running or unapproved, the nearest approved ancestor is used, so a pending change on the default branch shows up in your review too.
- Without git history (a shallow clone it can't deepen, or no repository), the CLI warns and PixelCI compares against the **latest** approved default-branch build. The review page shows a notice when this happens.

Give the CLI the history it needs with `GIT_DEPTH: 0` on GitLab or `fetch-depth: 0` on GitHub Actions. See the [GitLab](/gitlab-setup#_5-git-history-and-the-baseline) and [GitHub](/github-setup#_5-git-history-and-the-baseline) guides.
