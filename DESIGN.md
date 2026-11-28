---
name: DanDroid
description: A personal assistant signposted like a good airport, where one yellow band names the next thing that needs you.
colors:
  signal-yellow: "#ffcc00"
  sign-black: "#0b0b0b"
  on-sign-muted: "#4a3d00"
  pictogram-white: "#ffffff"
  hall-grey: "#f1f1ee"
  panel-white: "#ffffff"
  panel-grey: "#e8e8e3"
  muted-ink: "#4d4d48"
  hairline: "#d4d4cd"
  danger-red: "#c4262e"
  ok-green: "#16794a"
  warn-amber: "#9a5a00"
  night-hall: "#0c0c0c"
  night-panel: "#151515"
  night-raised: "#1a1a19"
  night-bubble: "#1f1f1e"
  night-panel-grey: "#232321"
  night-ink: "#f3f3ef"
  night-muted: "#aaaaa2"
  night-hairline: "#2e2e2b"
  night-picto-black: "#000000"
  night-danger: "#ff6b6b"
  night-ok: "#4cd391"
  night-warn: "#f5b041"
typography:
  display:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "4.6rem"
    fontWeight: 700
    lineHeight: 0.82
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  headline-sign:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.1
  headline-call:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
  headline:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.1
  brand:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title-section:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 700
  title-row:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1.03rem"
    fontWeight: 400
    lineHeight: 1.45
  title-card:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
  body-call:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
  control:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.92rem"
    fontWeight: 600
  body-compact:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
  note:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 400
  body-small:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 600
  help:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.84rem"
    fontWeight: 400
  label-group:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 600
    letterSpacing: "0.07em"
  meta:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 500
  sub:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 500
  micro:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  caption:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 400
    fontFeature: "tnum"
  stamp:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 400
    fontFeature: "tnum"
  badge-mini:
    fontFamily: "Hind, Roboto, Noto Sans, sans-serif"
    fontSize: "0.65rem"
    fontWeight: 700
    fontFeature: "tnum"
rounded:
  cut: "0.15rem"
  tag: "0.25rem"
  badge: "0.3rem"
  inset: "0.35rem"
  tile: "0.4rem"
  sign: "0.45rem"
  nested: "0.5rem"
  bubble: "0.6rem"
  logo: "1.2rem"
  dot: "50%"
spacing:
  xs: "0.3rem"
  sm: "0.5rem"
  md: "0.8rem"
  lg: "1rem"
  xl: "1.2rem"
components:
  button-primary:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    typography: "{typography.label}"
    rounded: "{rounded.sign}"
    padding: "0.6rem 1.1rem"
    height: "2.9rem"
  button-primary-active:
    backgroundColor: "{colors.night-picto-black}"
  button-primary-dark:
    backgroundColor: "{colors.night-ink}"
    textColor: "{colors.sign-black}"
  button-small:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sign}"
    padding: "0.45rem 0.9rem"
    height: "2.5rem"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.sign}"
    padding: "0.6rem 1.1rem"
    height: "2.9rem"
  button-danger:
    backgroundColor: "{colors.danger-red}"
    textColor: "{colors.pictogram-white}"
    rounded: "{rounded.sign}"
    height: "2.9rem"
  button-danger-dark:
    backgroundColor: "{colors.night-danger}"
    textColor: "{colors.sign-black}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.sign}"
    size: "3rem"
  sign-band:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.title}"
    padding: "0.5rem"
    height: "3.8rem"
  next-band:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.display}"
    padding: "0.3rem 1rem 1rem"
  next-panel:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    typography: "{typography.title-row}"
    rounded: "{rounded.sign}"
    padding: "0.75rem"
    height: "3.5rem"
  next-panel-square:
    backgroundColor: "{colors.pictogram-white}"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.inset}"
    size: "2.9rem"
  pictogram-square:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    rounded: "{rounded.sign}"
    size: "3rem"
  list-heading:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sign-black}"
    typography: "{typography.title-row}"
    padding: "0.7rem 1rem 0.5rem 1.1rem"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.sign-black}"
    typography: "{typography.title-row}"
    padding: "0.65rem 0.9rem"
  sign-bar:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    typography: "{typography.label}"
    height: "3.4rem"
  sign-bar-active:
    textColor: "{colors.signal-yellow}"
  sign-pane:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.headline-sign}"
    rounded: "{rounded.sign}"
    padding: "1.1rem 1.4rem"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.sign-black}"
    typography: "{typography.label}"
    rounded: "{rounded.sign}"
    padding: "0.5rem 0.9rem"
    height: "2.6rem"
  tab-on:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.sign-black}"
  badge:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.signal-yellow}"
    typography: "{typography.caption}"
    rounded: "{rounded.badge}"
    padding: "0.05rem 0.45rem"
  pill:
    backgroundColor: "{colors.panel-grey}"
    textColor: "{colors.muted-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.45rem"
  card-header:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.title-card}"
    padding: "0.6rem 0.9rem"
  input:
    backgroundColor: "{colors.panel-grey}"
    textColor: "{colors.sign-black}"
    typography: "{typography.body}"
    rounded: "{rounded.sign}"
    padding: "0.7rem 0.85rem"
  bubble-mine:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    rounded: "{rounded.bubble}"
    padding: "0.6rem 0.85rem"
  bubble-theirs:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.bubble}"
    padding: "0.6rem 0.85rem"
  toast:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.sign}"
    padding: "0.75rem 1rem"
  location-banner:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.signal-yellow}"
    typography: "{typography.label-group}"
    rounded: "{rounded.sign}"
    padding: "0.45rem 0.9rem"
  location-banner-done:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.pictogram-white}"
---

# Design System: DanDroid

## Overview

**Creative North Star: "The Terminal Sign"**

DanDroid is signposted like a good international airport. The traveller never hunts: one signal-yellow band says how many things need him and names the single next one, with an arrow pointing the way. Everything else in the hall is calm sign black on white and pale grey, ruled with hairlines and heavy frame rules, carried by one humanist sans in sentence case. Yellow is not decoration; it means "this is where you are going" or "this needs you", and nothing else.

The system is a sign system first and an app second. Every screen opens on a yellow sign band naming its destination in bold black, closed off by a heavy black rule; the home screen closes at the foot with a black sign bar. Destinations are identified by marker-drawn pictograms set in black inset squares, the way a terminal marks gates, toilets and baggage. The drawn line is the personal part: strokes cross at the corners and overshoot their ends like a marker sketch, which keeps the rigour of wayfinding from turning corporate. Density is phone-first and glanceable, built for one-handed taps between lessons, in the car and on the couch.

Light mode is the daylit concourse (pale grey hall, white panels, black frames). Dark mode is the terminal at night: the hall goes black, frames turn near-white, and the yellow sign stays lit at full strength. It replaced the earlier teal and purple gradient look outright; no gradient, glow or brand tint survives in the system.

**Key Characteristics:**
- Signal yellow reserved for wayfinding: sign bands, needs-you counts, the selected or followed item, and outlines on black notices.
- Sign black carries text, primary actions, frames, rules, pictogram squares and the foot sign bar.
- One face, Hind, self-hosted; bold for destinations, sentence case throughout.
- Marker-sketch pictograms with crossing corners and overshoots, drawn large; arrows locked to the edge they point past.
- Squared panels (about 7px), hairline and heavy rules, no gradients, no drop shadows on panels.
- The next-decision band is the signature: a monumental count with a split-flap flip.

## Colors

A two-ink sign palette, yellow and black, on neutral grounds; status colours stay small and functional.

### Primary
- **Signal Yellow** (#ffcc00): the wayfinding ink. Fills every sign band, the next-decision band, the desktop empty-pane sign, the selected tab, segment and keyword chip, card headers on bot approval cards, and the active item in the black sign bar. On black it is the needs-you badge figure, the "who" line and arrow in the next panel, the location banner's text, and the 2px outline around the toast and location banner. In dark mode it is unchanged; the sign stays lit.
- **Sign Black** (#0b0b0b): the other ink. Body text, primary and small buttons (including New bot), pictogram squares, the 3px frame rule under every band and above the sign bar, the next panel, the sign bar, the toast and the location banner. Pressed primary deepens to pure black.

### Secondary
- **Sign Shadow Ink** (#4a3d00): muted text that sits on yellow only (subtitles under the screen name, the "Next: ..." line under the count, the small line on the empty-pane sign). Never used off the yellow.
- **Pictogram White** (#ffffff): pictogram strokes inside black squares, text on black panels and buttons, the inverse square inside the next panel, and the location banner's "done" text.

### Neutral
- **Daylight Hall** (#f1f1ee): the page ground in light mode.
- **Panel White** (#ffffff): lists, the sticky "Your bots" heading, sidebars, raised sections, cards and incoming chat bubbles.
- **Concourse Grey** (#e8e8e3): inputs, the search field, attach and mic buttons, tool rows, quiet pills.
- **Muted Ink** (#4d4d48): secondary text, previews, timestamps, group labels, row arrows.
- **Hairline** (#d4d4cd): 1px dividers between list rows and around incoming bubbles.
- **Night Hall** (#0c0c0c), **Night Panel** (#151515), **Night Raised** (#1a1a19), **Night Bubble** (#1f1f1e), **Night Concourse** (#232321): the dark grounds, panels, incoming bubbles and fields.
- **Night Ink** (#f3f3ef) and **Night Muted** (#aaaaa2): dark-mode text. Night Ink is also the dark primary-button fill and the dark strong-rule colour.
- **Night Hairline** (#2e2e2b): dark dividers. **Night Picto Black** (#000000): pictogram squares go true black so they still read against the night panel.

### Strong rule
The build carries one frame token for outlines and heavy rules on panels: sign black in light mode, night ink in dark mode. It draws card and Reply Desk outlines, settings section outlines, the share menu border, the selected tab edge, the rule under the "Your bots" heading and the ring around the logo on onboarding. The rules under the yellow bands stay sign black in both themes because they belong to the lit sign.

### Status
- **Danger Red** (#c4262e, night #ff6b6b): delete and decline buttons, error outlines, the live recording mic. In dark mode the danger button carries sign-black text on the light red.
- **Go Green** (#16794a, night #4cd391): "on" and connected pills, the live dot on a working bot, the listening ring on a call.
- **Caution Amber** (#9a5a00, night #f5b041): warning pills and the warning banner wash.

### Named Rules
**The Wayfinding-Only Rule.** Signal yellow appears only where it guides or alerts: a band naming where you are, a count of what needs you, the item you have selected, or the edge of a black notice. If a yellow element does not answer "where am I" or "what needs me", it is not yellow.

**The Two Inks Rule.** Actions and emphasis are black (near-white in dark mode), never a third accent colour. The accent tokens in the build alias to sign black on purpose.

**The Lit Sign Rule.** Dark mode inverts the hall, not the signs: bands, the next panel, the empty-pane sign, the sign bar, the toast and the location banner keep their light-mode yellow and black.

## Typography

**Display Font:** Hind (with Roboto, Noto Sans, sans-serif)
**Body Font:** Hind (same family)
**Label/Mono Font:** none distinct; code in chat uses the system monospace at 0.85em of its context.

**Character:** One humanist sans in four self-hosted weights (400, 500, 600, 700, latin and latin-ext). It reads like terminal signage: open, legible at speed, bold where it names a destination. All sizes are in rem and the root is 16px times the user's text-size setting, so the whole system scales with Settings, Appearance, Text size.

### Hierarchy
The ramp is dense at the small end because the app is information-heavy on a phone; every step below is in use.
- **Display** (700, 4.6rem, line-height 0.82, -0.03em, tabular figures): the needs-you count in the next-decision band. One per screen, home only.
- **Headlines** (700): the desktop empty-pane sign (2rem, 1.1), the bot's name on the call screen (1.6rem), the "things need you" label beside the count (1.35rem, 1.1).
- **Titles** (700): the brand name (1.3rem, -0.02em), the destination in every sign band (1.25rem, -0.01em), settings section headings, the "Nothing needs you" line and the call button (1.1rem), bot names, the next item and the "Your bots" heading (1.05rem, 1.25), card headers and sheet headings (1rem).
- **Body** (400, 1.03rem, 1.45; chat bubbles 1.5): messages, descriptions and running text. Bubbles cap at 42rem wide. Call transcript lines step to 0.95rem; toasts, share-menu items, suggestion text and the next panel's supporting line use 0.9rem; banners, slash-command items and inline notes 0.88rem; row previews and small buttons 0.86rem.
- **Controls and labels** (500 to 600): segments and the "Also N notifications" link (0.92rem), tabs, chips, sign bar captions and share-menu headings (0.85rem), help text (0.84rem, 400), list group labels "Pinned" and "Others" (0.82rem, 600, muted, 0.07em tracking, sentence case) and the location banner (0.82rem), field labels and tool rows (0.8rem), band subtitles and centred notes (0.78rem).
- **Captions** (tabular figures): service tags, URLs and code blocks (0.75rem), times, badges, pills and day dividers (0.72rem), message stamps (0.68rem), the tiny badge on a header icon (0.65rem, 700).

### Named Rules
**The Sentence Case Rule.** Every label, heading and button is in sentence case. No all-caps signage.

**The Bold Destination Rule.** Weight 700 marks a destination or a decision (screen names, bot names, the count, the next item, the "Your bots" heading). Running text stays 400; 500 and 600 are for supporting lines and controls.

## Layout

Phone first, and the shell fits the screen exactly (100dvh): each area scrolls inside, the page never does. On screens up to 800px the app is one column: the list view and the detail view swap, with Android Back returning to the list. From 801px a 24rem sidebar (sign band, next-decision band, search, bot list, sign bar) sits beside the main pane, divided by a hairline; with nothing open, the main pane centres a single yellow sign pointing at the list: "Choose a bot".

Home stacks in sign order: the yellow sign band (logo and name, then 48dp icon buttons for Reply Desk, Improver, Notifications and Settings), continuing straight into the yellow next-decision band, a heavy black rule, the search field, then the bot list. The list opens with a sticky "Your bots" heading on the panel ground, ruled off underneath in the strong-rule colour, carrying the black New bot button at its right; it stays pinned at the top while the rows scroll. Rows group under muted "Pinned" and "Others" labels. The black sign bar (Home, Brief, Talk, Saved) closes the column at the foot, ruled off above in black. Nothing floats over the list.

Content pages use a 1rem gutter and a 54rem maximum width. Lists are full-bleed rows divided by hairlines rather than separate cards. Spacing steps are 0.3, 0.5, 0.8, 1 and 1.2rem; most panels pad 0.9 to 1rem. Every touch target is at least 2.75rem and usually 3rem (48dp at default size); below 460px wide the header name gives way before any header button shrinks below 2.75rem. Safe-area insets pad the top band, the composer, the sign bar, the toast and the location banner.

## Elevation & Depth

Flat. Depth comes from ink and rules, not shadow: a heavy 3px black rule closes every yellow band and opens the sign bar; panels are outlined with inset 2px (approval cards, Reply Desk cards, the share menu, the sticky list heading's rule) or 1.5px (settings sections) strokes in the strong-rule colour; list rows are separated by 1px hairlines. Grounds step from hall to panel to concourse grey. The toast and location banner, the two things that genuinely sit above the page, are black slabs edged with a crisp 2px signal-yellow outline instead of a drop shadow.

### Shadow Vocabulary
- **Notice edge** (`box-shadow: 0 0 0 2px #ffcc00`): the toast and the location banner; an outline, not a lift.
- **Menu lift** (`box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 6px 14px -8px rgba(0,0,0,.25)`; dark `0 1px 0 rgba(0,0,0,.5)`): the open share menu only, together with its 2px strong-rule border.
- **Focus** (`box-shadow: 0 0 0 3px #ffcc00, 0 0 0 5px #0b0b0b`): the keyboard focus ring everywhere, a yellow ring framed in black like a sign edge.

### Named Rules
**The Ruled Not Raised Rule.** Separate things with a rule or an outline. A soft shadow is allowed only on an open menu; notices that sit above the page are edged in yellow, not lifted.

## Shapes

Squared sign panels: one radius (0.45rem, about 7px) for buttons, fields, cards, tabs, chips, pictogram squares, the next panel, the empty-pane sign, the toast and the location banner. The steps that sit around it are all in use: 0.4rem for small tiles inside a sign (the empty-pane square, app icons), 0.35rem for the white square inside the next panel, 0.3rem for badges and day dividers, 0.25rem for pills and service tags (pills are squared, not capsules). Chat bubbles and the panels nested in cards (quoted context, review blocks, code in cards, share-menu items) round a little more at 0.6rem, with 0.5rem for a block nested one level deeper; a bubble's corner nearest the speaker is cut to 0.15rem. Circles (50%) are for status dots only. No pill-shaped buttons. The logo is the one generous corner: a yellow tile (24 on a 108 grid; 1.2rem on the 5.5rem onboarding logo) holding a drawn black droid, ringed in 2px of the strong-rule colour; in the sign band it is clipped to the sign radius inside a 2px black ring.

## Components

### Pictograms and sign squares
The visual voice of the system. Pictograms are marker sketches on a 24 grid: strokes cross at corners and overshoot their ends, paths are deliberately uneven, one stroke weight (2.2; 2.3 inside squares), round caps and joins, inline SVG in the current text colour. They are drawn large enough that the hand shows: 1.6rem in header icon buttons, 1.75rem in the sign bar, 1.4rem under chat replies, 1.45rem in the send button, 64% of a sign square. Settings is a drawn sliders pictogram (three rules with knobs), not a gear. Bots get a portrait chosen by what they do (Maus a mouse; Inbox an envelope; Researcher a magnifier; Improver a wrench; brief bots a newspaper; anyone else a droid).
- **Sign square:** a 3rem black square at the sign radius holding a white pictogram at 64%. Used for bot portraits in lists and headers, and scaled up (7rem) on the call screen.
- **Inverse square:** inside the black next panel the square flips to white with a black pictogram.
- **Edge arrow:** the drawn arrow sits at the trailing edge of every row and of the next panel, pointing past it: muted in rows, yellow in the next panel.

**The Hand-Drawn Pictogram Rule.** Every icon in the product is a drawn pictogram from the house set, never an emoji, icon font or library glyph, and a destination's pictogram sits in a black sign square.

### Next-decision band (signature)
The home screen's yellow band, continuing directly from the sign band above it. Left: the needs-you count in Display weight; beside it "thing needs you" or "things need you" with a muted "Next: answer a bot / a message to reply to / your notifications" line. Below: the black next panel (inverse pictogram square, the item's text in white bold, who and where in yellow, yellow edge arrow) that opens the item in one tap. Priority: a bot's approval or question first, then a message to reply to, then notifications. An underlined "Also N notifications" link follows when both exist. When nothing needs Dan it collapses to a single line: bell pictogram and "Nothing needs you".
- **Motion:** when the count changes it flips like a split-flap board (0.38s, rotateX from -88deg through a 10deg overshoot, the house ease-out). Under reduced motion it changes instantly.

### Sign bands (headers)
Every screen header is a yellow band at least 3.8rem tall with a 3px black rule beneath: back arrow, optional bot square, destination name in bold black (subtitle in sign shadow ink), and 48dp black icon buttons. Header badges are black with yellow figures. A primary button in a band is black with white text; a secondary is outlined in black.

### "Your bots" heading
A sticky heading at the top of the bot list on the panel ground: "Your bots" in bold row-title type at the left, a small black New bot button (plus pictogram and label) at the right, ruled off beneath in 2px of the strong-rule colour. It stays visible while the list scrolls, so creating a bot is always one tap away without anything floating over the rows.

### Black sign bar
The home navigation at the foot: black, a 3px black rule above, white pictograms (1.75rem) over 0.85rem semibold captions, each item at least 3.4rem tall. The current destination turns signal yellow; a press washes 10% white. It stays black in both themes.

### Desktop empty pane
With no bot open on a wide screen, the main pane centres one yellow sign: a black pictogram square (3.6rem), "Choose a bot" in the 2rem sign headline and a smaller muted line, framed by an inset 3px black rule at the sign radius.

### Buttons
- **Shape:** squared sign corners (0.45rem), at least 2.9rem tall; small buttons 2.5rem with 0.86rem text.
- **Primary:** sign black with white semibold text (dark mode: night ink with black text), padded 0.6rem by 1.1rem.
- **Pressed:** scales to 0.97 over 0.12s; primary deepens to pure black.
- **Secondary:** transparent with a 2px inset outline in the text colour.
- **Danger:** danger red with white text, for delete and decline only; in dark mode the light red carries black text.
- **Icon buttons:** 3rem transparent squares holding a 1.6rem pictogram. Copy, play and share under replies are 2.75rem squares with 1.4rem pictograms in the text colour.

### Tabs, segments and chips
Outlined in 2px of the text colour, squared. The selected one fills signal yellow with black bold text: wayfinding marks where you are.

### Pills and badges
Pills are squared tags (0.25rem) in 0.72rem semibold: quiet on concourse grey, "on" and warning pills tinted with a 14% wash of their status colour. Badges are black with yellow tabular figures at 0.3rem.

### Cards and sections
- **Approval and question cards (in chat):** raised panel outlined 2px in the strong-rule colour, with a full-width yellow header strip ruled off in black; actions sit underneath.
- **Reply Desk cards:** panel bordered 2px in the strong-rule colour, a black service tag, the message, quoted context on concourse grey, the editable draft, and action buttons.
- **Settings sections:** raised panels outlined 1.5px, 1rem padding, bold 1.1rem heading, muted help text.

### Lists
Full-width rows on the panel ground: sign square, bold name, muted one-line preview, tabular time, a black-and-yellow count badge, and the edge arrow. Rows divide with hairlines; pressed or active rows take a 7% black wash. Group labels ("Pinned", "Others") are small muted semibold sentence case.

### Inputs / Fields
Concourse grey fill, no visible border at rest, squared corners, 0.7rem by 0.85rem padding. On focus the field turns panel white with a black border; keyboard focus adds the yellow-and-black focus ring. The caret is black.

### Chat
Dan's messages are solid black bubbles with white text (night ink with black text in dark mode); a bot's are white with a hairline outline (night bubble in dark mode). Copy, play and share sit under every reply as icon buttons in the text colour. The composer is a panel strip with grey attach and camera buttons, the grey field, and a black send button.

### Notices
- **Toast:** a black slab at the sign radius above the sign bar, white 0.9rem text, edged with a 2px signal-yellow outline.
- **Location banner:** a black slab pinned at the top, yellow 0.82rem text, the same yellow outline; it pulses while sharing and turns to white text on black when done.

## Do's and Don'ts

### Do:
- **Do** reserve signal yellow (#ffcc00) for sign bands, needs-you counts, the selected item and the edge of black notices.
- **Do** open every screen with a yellow sign band naming the destination in bold black, closed by a 3px black rule.
- **Do** mark destinations with a marker-drawn pictogram in a 3rem black sign square, and end tappable rows with the drawn edge arrow.
- **Do** keep the next-decision band to one count and one next item, collapsing to "Nothing needs you" when clear.
- **Do** keep bands, the next panel, the empty-pane sign, notices and the black sign bar lit at full strength in dark mode.
- **Do** put list actions in the list's own sticky heading as a black button, not in a floating button over the content.
- **Do** frame panels in the strong-rule colour (black by day, near-white by night).
- **Do** size everything in rem so the text-size setting scales the whole interface, and keep targets at 3rem (48dp).
- **Do** let every animation, including the split-flap count, collapse to instant under reduced motion.

### Don't:
- **Don't** use gradients, glows, tinted brand washes or the previous teal and purple palette.
- **Don't** introduce a third accent colour for actions; actions are black (near-white in dark mode).
- **Don't** use emoji, icon fonts or stock icon libraries in place of the drawn pictogram set.
- **Don't** use yellow as a decorative fill, a background for body content, or for anything that is not wayfinding.
- **Don't** set labels or headings in all caps; signage here is sentence case.
- **Don't** lift panels or notices with drop shadows; separate them with rules and outlines.
- **Don't** float buttons over the list or the page.
- **Don't** round panels, pills or buttons into capsules; outside chat bubbles and nested blocks (0.6rem) and the logo, corners stay at the sign radius or tighter.
