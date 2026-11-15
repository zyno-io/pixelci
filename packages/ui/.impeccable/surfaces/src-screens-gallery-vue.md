---
version: 1
slug: 'src-screens-gallery-vue'
primary_target: 'src/screens/gallery.vue'
related_targets: ['src/shared/components/screen-lightbox.vue', 'src/shared/components/tolerance-fields.vue']
---

# Screen gallery and tolerances

Scope: `packages/ui/src/screens/gallery.vue` (routes `/apps/:id/screens`, `/apps/:id/builds/:buildId/screens`), `shared/components/screen-lightbox.vue`, `shared/components/tolerance-fields.vue`, `screens/app-tolerances.vue`. Mode: Operate. Extends the established "Review Desk" world; no new identity.

Audience and job: reviewers and developers who want to look through an app's or a build's screens without the side-by-side review layout, and tune how strictly a screen is compared. Decisions confirmed by the user: app gallery shows the current baseline; tolerances are instance, then app (admins), then screen (anyone who can review); saved values apply from the next build; the lightbox previews proposed values live against the build being viewed.

## Direction contract

THESIS: the gallery is a contact sheet. Thumbnails take the shape of the app's own screenshots and everything else recedes; it refuses the equal-card dashboard grid with icons and stats.

OWN-WORLD: Review Desk tokens only. White 12px tiles on the grey desk, each holding one screenshot on the Screenshot Mat with a 5px inner radius; status as tag triplets; one indigo button per surface (Save in the lightbox, Review build when the build needs review).

STORY: the visitor scans, finds a screen by name or status, opens it large, steps with the arrow keys, and, if the screen is noisy, changes its tolerance and sees whether it would pass before saving.

FIRST VIEWPORT: sticky two-row header (back, app name, baseline or build context, actions; then search, filter, count, thumbnail size) over a full-width auto-fill grid of thumbnails.

FORM: thumbnail grid plus a near-full-viewport lightbox with the image stage on the mat and a 360px details and tolerance panel. Signature interaction: the live tolerance preview (verdict, measured diff, pixels ignored as shifted, and the resulting diff on the stage). seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
