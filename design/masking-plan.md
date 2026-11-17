# Masking (ignore regions): plan

Status: proposed, 2026-11-16. Nothing is implemented yet. File:line references are to `origin/main` at the time of
writing.

**Goal:** masks are regions of a screen whose pixels never affect whether the screen changed. They work like the v0.6.0
tolerances: stored with the screen, an app-level set, editable by people who can review the app, and previewed against
the build you're looking at before saving.

**The one invariant:** counts and verdicts depend only on unmasked pixels. Nothing under a mask can change a result.

## Decisions to confirm

| #   | Question                                                                    | Recommendation                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Do app masks combine with screen masks, or does the screen replace the app? | Combine, with a per-screen "Use app masks" opt-out                                                                                                          |
| 2   | Who edits app masks?                                                        | Admins, as with app tolerances, because app masks blank every screen                                                                                        |
| 3   | Do masks follow layout reflow or device-pixel-ratio changes?                | No in v1. Show "partly outside this screenshot", document Playwright `mask`, add "scale masks" later                                                        |
| 4   | Reprocess existing builds, or add a "re-check" action, when masks change?   | No. Masks apply from the next build, the same rule as tolerances                                                                                            |
| 5   | What guards against masks hiding real regressions?                          | Store `appliedMasks` per build screen, record who and when, always draw outlines in review, cap at 50 masks, show the masked share, warn above 50% coverage |
| 6   | Should masked pixels be excluded from the percentage?                       | Yes: "changed pixels allowed" becomes a share of the compared pixels. Document it                                                                           |
| 7   | Should a stale save be rejected?                                            | Yes, 409 on a stale `baseVersion`. Apply the same check to tolerances later                                                                                 |
| 8   | Should the CLI accept masks in v1?                                          | No. Playwright's `screenshot({ mask })` masks at capture and follows reflow. A sidecar JSON later becomes `declaredMasks`, merged at processing time        |

## 1. Interpretation and scope

"Tracking with the screenshot and tolerances" means three things:

- **Owned by the screen slot.** Masks live on `ScreenEntity`, which is unique per app and name (Screen.entity.ts:5), so
  they persist across builds and branches.
- **Screenshot pixels from the top-left.** This matches how `normalizeToCanvas` anchors screenshots of different sizes
  (PixelMatch.service.ts:19-34).
- **When dimensions change, masks keep their pixel position and never scale.** They are clipped to the comparison
  canvas, and they can cover the magenta padding. Fractional coordinates were rejected: full-page heights change all the
  time, so every mask would drift.

Masks also follow the tolerances lifecycle: the same levels, the review role, live preview, and "applies from the next
build".

- **v1:** rectangles; screen and app levels; edited in the UI; read-only in `/api/ext` and MCP.
- **Later:** polygons, CLI-declared masks, a re-check action, DPR scaling.

## 2. Data model

`packages/api/src/services/Mask.ts`:

- `IMaskRect { id: uuid; x; y; width; height: int; label: string | null }`
- `validateMasks`:
    - up to 50 masks;
    - integer values;
    - x and y ≥ 0;
    - width and height ≥ 1;
    - x+width and y+height ≤ 100 000;
    - unique ids;
    - labels up to 80 characters.
- `resolveMasks`, `rasterizeMasks`.

Migration, created with `yarn migrate:create`. Use `json`, not `jsonb`, as `ciReadTokenHashes` does, to avoid schema
drift:

```sql
ALTER TABLE "apps"    ADD COLUMN "masks" json;  -- + masksVersion integer NOT NULL DEFAULT 0, masksUpdatedAt timestamp, masksUpdatedById uuid
ALTER TABLE "screens" ADD COLUMN "masks" json;  -- same three, + "inheritAppMasks" boolean NOT NULL DEFAULT TRUE
ALTER TABLE "builds_screens" ADD COLUMN "appliedMasks" json;
```

Entities: App.entity.ts:20, Screen.entity.ts:12, BuildScreen.entity.ts:22.

- **Masks in effect** = the app's masks (unless the screen opts out) plus the screen's own masks.
- **`appliedMasks`** is the audit record of what was ignored when a build was processed. The review screen draws it.

## 3. Comparison

`getDiff` (PixelMatch.service.ts:213) takes `masks`:

1. **Rasterise.** After normalising (:225-226), and only when masks exist, rasterise them into a `Uint8Array(w*h)`.
   Count `maskedPixels` once, even where masks overlap.
2. **Neutralise.** Paint one opaque `MASK_FILL` into both images under the mask. pixelmatch then sees no difference
   there, and its anti-aliasing checks next to mask edges see identical content.
3. **Shift tolerance.** Pass the mask into `applyShiftTolerance` and `hasNearbyMatch` (:85-138) and skip masked
   neighbours next to `if (j === i) continue` (:122). Masked content can't excuse an unmasked pixel.
    - Content that shifts across a mask edge can still flag a sliver up to the shift radius wide. The docs say to pad
      masks by the shift radius.
4. **Percentage.** Change :246 to `diffPct = diffPixels / (totalPixels − maskedPixels) × 100`. When everything is
   masked, the result is 0. Return `maskedPixels`.
5. **Diff image.** Paint masked pixels with a neutral grey hatch. Red, yellow and magenta keep their meanings, so the
   stored diff (and MCP `get_screen_image kind=diff`) explains itself.

ProcessBuild:

- Replace `tolerancesFor` (:106) with `comparisonFor(screenId) → ITolerances & { masks }`. Resolve it once from the rows
  loaded at :97 and :102, so a save during processing applies to all of the build or none of it.
- Thread it through `loadAndDiff` (:373-377). The calls at :164, :185, :230 and :290 keep their shape.
- Apply the same masks to the previous approved build, the reference, cross-branch approvals (:213-247) and carried
  reviews (:272-319). A change that differs only inside a mask then matches an approval made elsewhere and never blocks.
- No hash shortcut exists today. If one is added, unequal hashes must still go through the masked diff.
- Set `appliedMasks` before the screen loop, inside the existing transaction (:349-368), so lease retries rewrite it
  consistently.
- Fix the comment at :267-269, which says "exact pixel match".
- Matching screens mark their own upload `pendingDeletion` (:362-367). Under masks, the image shown afterwards can
  differ inside the masked area. Document this.

Existing builds are not reprocessed (docs/usage.md:195). A build that needs review stays that way. The preview says
"Would pass", and approving re-runs CI (Builds.controller.ts:643).

## 4. API, permissions, audit, OpenAPI

| Route                                                                             | Who                                  | Body                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `PUT /api/apps/:appId/screens/:screenId/masks` (Screens.controller.ts, near :140) | review role (`assertCanReviewAppId`) | `{ masks, inheritAppMasks, baseVersion }`                 |
| `PUT /api/apps/:id/masks` (Apps.controller.ts)                                    | `AdminAuthMiddleware` (as :124)      | `{ masks, baseVersion }`                                  |
| `POST …/screens/:screenId/compare` (BuildScreens.controller.ts:191)               | app access                           | Adds a required `masks`; the response adds `maskedPixels` |

- **Saving:** in a transaction, `forUpdate()` the row (as `reviewScreen` does at :396-420). Return 409 on a stale
  version. Bump the version, set `masksUpdatedAt` and `masksUpdatedById`, and log the before and after counts.
- **Reading:**
    - Add `masks: { masks, inheritAppMasks, version, updatedAt, updatedByName }` to `IBuildScreenResponse` (:47-83,
      select :175) and to `IAppGalleryScreen` (Screens.controller.ts:16-28).
    - Add `appliedMasks` to `pickBuildScreen` (:87).
    - App show (Apps.controller.ts:85) spreads the entity.
- **`/api/ext` and MCP:** add read-only `appliedMasks`, without ids, to `IExtBuildScreenResponse`
  (ExternalRead.service.ts:27-36, :99-108), and mention it in the `get_build` description (Mcp.controller.ts:43). There
  is no write access.
- **OpenAPI:** boot the API to regenerate `packages/api/openapi.yaml`. CI regenerates the UI client
  (.gitlab-ci.yml:123).

## 5. UI

New files: `ui/src/shared/masks.ts`, `shared/components/mask-layer.vue` (SVG overlay with an `editable` prop) and
`shared/components/mask-fields.vue`.

**Lightbox** (screen-lightbox.vue):

- **Canvas.** Wrap the stage `<img>` (:61) in `.lb-canvas`, which takes over the fit and zoom rules (:590-632).
  `mask-layer` is `<svg viewBox="0 0 naturalW naturalH">`, so it scales with Fit, 100% and 200%. Map pointer positions
  to image pixels with `getScreenCTM().inverse()`. Show the layer on all three views.
- **Masks section, after Tolerance (:92-164):**
    - "Draw mask" mode: drag to create, select to move, eight handles to resize.
    - A row per mask with X, Y, W and H fields, a label and Delete.
    - "Use app masks" checkbox. App masks are drawn dashed and read-only; admins get "Edit app masks".
    - A separate "Save masks" action. Drafts are kept per screen, like tolerance drafts (:340-348).
    - "Partly outside this screenshot" warning.
- **Preview.**
    - Send the masks in effect with compare (:423-427), and add them to the watch at :451.
    - While dragging, run the preview only on pointer up.
    - Add "N px masked" to the verdict.
- **Keyboard:**
    - Each mask is focusable and labelled ("Mask 2, x 40, y 12, 200 × 32 px").
    - Arrows move it 1 px (Shift: 10). Alt+arrows resize. Delete removes it. Escape cancels a draw.
    - Every one of these calls `preventDefault()`, which the lightbox's arrow stepping (:480) and the modal's Escape
      handling (a11y-modal.vue:55) respect.
    - **N** adds a mask in view; **M** hides or shows the layer. Add both to the key legend (:166-174).
    - The X/Y/W/H fields are the path for anyone not using a pointer. A polite live region announces changes.
- **Look.** Two-tone dashed outlines. Hatch colours are custom properties, redeclared for dark mode. No indigo except
  for focus and selection (DESIGN.md:439).

**Review screen** (screens.vue:214-233): a read-only `mask-layer`, drawn from `appliedMasks`, over both panes. It is
outline only, with `pointer-events: none` so Shift+click still toggles the diff. Add a neutral "Masked" tag.

**Gallery** (gallery.vue:140): a "Masked" tag next to "Custom". The Custom filter (:268-292) counts masked screens.

## 6. Tests

- **Unit.**
    - `tests/services/Mask.spec.ts`: validation, combining, opt-out, clipping, overlap counting.
    - `PixelMatch.service.spec.ts`:
        - a change inside a mask gives 0 changed pixels;
        - the percentage excludes masked pixels;
        - a screen that is entirely masked gives 0%;
        - **invariance**: random content under a mask leaves `diffPixels` and `diffPct` unchanged, across shift radii 1 to
          5 and next to shifted content;
        - masked neighbours never excuse a pixel;
        - a size change with a mask over the padding;
        - the hatch is drawn only on masked pixels.
- **Integration.** `tests/integration/masks.test.ts`, with a `test:int:masks` script in `test:all`.
    - **Errors:** 400 for invalid masks; 403 without the review role; app masks are admin-only; 409 on a stale version.
    - **Compare:** a mask flips `passes`, and `maskedPixels` is reported.
    - **Processing:**
        - a masked change gives "no changes";
        - a change only inside a mask matches a cross-branch approval;
        - carried reviews still work;
        - `appliedMasks` is written;
        - a build that needs review stays that way after a save.
    - Derive the changed region from `fixtures/finder-1-diff.png`.
- **Canary.** Cases for both PUT routes. Add `masks: []` to the compare body (response-canary.test.ts:347-356). Check
  the `appliedMasks` shape in ext-read.test.ts.
- **e2e.** `tests/e2e/masks.spec.ts` on the mocked API, extending `fixtures/design-system.ts` (:106-121).
    - Pointer: draw, see "Would pass", save, reload.
    - Keyboard: add, nudge, resize and delete.
    - Arrows and Escape don't leak to the lightbox.
    - A reader can't edit; app masks are admin-only; the editor works at phone width.
    - Run axe.
- **VRT.** Seed a mask and its `appliedMasks` in `seed-e2e.mjs`, and add a "Screen Lightbox - Masks" capture after
  basic.spec.ts:58. Expect the Screen List baselines to change because of the outlines.

## 7. Docs

- **docs/usage.md:**
    - A "Masks" section after Tolerances (:175-195) covering levels, combining, pixel coordinates, clipping, padding by
      the shift radius, Playwright `mask` as an alternative, and "applies from the next build".
    - Mention masks in "How Comparisons Work" (:197-206).
- **docs/llm-access.md:** document `appliedMasks`.
- **DESIGN.md:** update the Lightbox (:601-618) and Diff (:687) sections, and add a "Mask layer" component.
- **PRODUCT.md:51 and CHANGELOG.md:** describe the feature.
- **The sales site:** remove "Ignore regions are planned" from `src/data/compare.ts` (`px.ignore`).

## 8. Memory

The mask bitmap is at most 25 MB at `SCREEN_MAX_PIXELS` (config.ts:25), next to about 200 MB of decoded image data. It
is allocated only when masks exist.

## 9. Implementation order

Each chunk can be delegated separately.

1. `services/Mask.ts`, then `PixelMatch.service.ts` (`getDiff` and the shift pass), with unit tests.
2. Migration and entities, then ProcessBuild and `appliedMasks`. **Review this chunk**: it changes data and comparison
   results.
3. Routes: Screens, Apps and BuildScreens controllers; `ExternalRead.service.ts` and `Mcp.controller.ts`;
   `openapi.yaml`; canary cases; `masks.test.ts`.
4. UI: `shared/masks.ts`, `mask-layer.vue` and `mask-fields.vue`, then the lightbox editor and preview.
5. Read-only overlays and tags in `screens.vue` and `gallery.vue`.
6. e2e fixtures, `masks.spec.ts`, the accessibility pass, the seed, and the VRT capture.
7. Docs, DESIGN.md, PRODUCT.md and CHANGELOG.md.
