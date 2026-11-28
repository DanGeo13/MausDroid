---
version: 1
slug: "ui-src-main-tsx"
primary_target: "ui/src/main.tsx"
related_targets: ["ui/public/app.css","ui/src/icons.tsx"]
---

# DanDroid app shell (all screens)

Scope: the whole app UI (ui/src, ui/public/app.css, icons, logo). Visitor mode: Operate. Build path: code-led.
Audience and job: Dan alone, glancing between lessons, in the car and in the evening; sees what needs him, acts, talks hands-free, finds saved things.
Constraints: PRODUCT.md (approvals for every external action, adjustable text size, light and dark, 48dp targets, Android Back). Brand commitment translated: "hand-drawn elements" become hand-drawn pictograms inside the world's black inset squares.

## Direction contract

THESIS: DanDroid is signposted like a good airport: one yellow band tells Dan the single next thing that needs him and how many follow. It refuses the category default of a chat-app list with a gradient brand and equal-weight rows.

OWN-WORLD: Signal yellow (#FFCC00) reserved for wayfinding only: the top band, "needs you" counts, the followed/selected item. Sign black for text, primary buttons, pictogram squares and frame rules; white and pale grey grounds; one humanist sans (Hind, self-hosted) in sentence case, bold for destinations. Hand-drawn white pictograms on black inset squares; arrows locked to the edge they point past; squared 6px panels, hairline rules, no gradients. Dark: black ground, the yellow band stays lit.

STORY: Dan opens the app and knows at once whether anything needs him, what it is, and where it is; he taps the band to act, or scans his bots, Reply Desk, saved things and notifications by their pictograms.

FIRST VIEWPORT: Home on a phone: a yellow top bar (logo, Reply Desk, Resources, Brief, Improver, Notifications, Settings, all 48dp) continuing into the yellow "next decision" band: the needs-you count set monumentally (about 4.5rem) with "need you", then a black inset panel naming the single next item (pictogram, who, what, action) with an edge arrow; collapses to one line "Nothing needs you" when clear. Below: bots as rows with black pictogram squares and edge chevrons. A "Your bots" heading carries the black New bot button at its right and stays pinned at the top of the list (contract change approved by Dan in the third review round). Below the list, the black sign bar: Home, Brief, Talk (hands-free call), Saved.

FORM: Challenger world "international airport sign system" (catalog), chosen by Dan over the assigned direction (assigned was position 5 of my grounded list, Fridge door). seed:992d7199c0f97702. Signature interaction: the band's count and next item update with a split-flap flip (instant under reduced motion), and every screen's header is a sign band with the destination named in black.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
