# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(DanDroid's interface is a web app running inside its own Android app. It has its own visual style rather than Material Design, while respecting Android basics: the system Back gesture, 48dp touch targets, safe areas and the keyboard, dark mode, and the phone's text-size setting.)

## Users

One person: Dan, a teacher, using DanDroid as his own personal assistant across school days and home life. It's mostly used on his Android phone (a POCO F8 Pro), sometimes from a computer through DanDroid's website link. He uses it in short bursts between other things (classroom, corridors, the car, evenings), often one-handed or hands-free, and he's not a developer.

## Product Purpose

DanDroid keeps Dan on top of things so nothing slips, lets him talk to it hands-free, and keeps what he's saved findable later. Success is Dan acting on what matters without hunting for it, and being interrupted only when something actually needs him.

## Positioning

A private assistant that runs on Dan's own phone, made of a small team of bots that share his context. It reads what's arriving (email, messaging apps, school updates), brings forward only what needs him, drafts replies and summaries in his style, and talks with him in natural voice. It never sends, deletes or acts on his behalf without his explicit OK.

## Operating Context

- **What needs him:** Reply Desk (messages that may need a reply, from email and messaging apps), approval and question cards from bots, missed calls, and the Notifications screen ("Needs you" first; updates and background records kept quietly).
- **Hands-free:** voice calls with any bot (interruptible, on-device listening, hold and resume), the assistant pop-up from the phone's assistant gesture, and read-aloud replies.
- **Saved things:** Resources (links and documents, grouped by keyword, archived but searchable), the Morning Brief, weekly audio overviews of the school's Staff Update (with source PDFs), and Downloads.
- **Bots:** Maus (the main assistant), plus Researcher, Inbox, Improver (nightly self-improvement suggestions he approves) and any he creates. Each bot has its own chat, routines and alerts.
- **Rhythm:** a weekday Morning Brief, weekly audio overviews, routines on schedules or triggers, quiet hours.

## Capabilities and Constraints

- Every significant external action goes through an approval: sending email, payments, posting, deleting. Messaging apps get drafts and handoffs, never automatic sending. Meta accounts are draft-only.
- Messaging apps are read through their notifications only, so those show previews.
- Updates arrive over the air; a new Android app is installed only when Dan says "Release".
- The source repository is public: no secrets, personal data or private details in the code, docs or design files.
- Text size is user-adjustable (all sizing scales with it); light and dark themes follow the phone's setting.
- Terminology in use: Reply Desk, Needs you / Updates / Background, Resources, Morning Brief, audio overview, routines, approvals ("needs your OK").

## Brand Commitments

- Name: **DanDroid** (renamed from MausDroid). The main bot keeps its name, **Maus**.
- A friendly, personal character. Dan has asked for **hand-drawn, drawn-feeling elements** in the icons and design, and for the app to look clearly different from the previous version. The exact drawn style is still to be chosen.
- Voice: plain, warm, Australian-friendly English; no slang greetings ("G'day" was removed at his request); short sentences; controls name their action.

## Evidence on Hand

- The real app: all screens and features in `ui/src`, the engine in `engine/src`, the Android app in `android/`.
- No testimonials, users beyond Dan, metrics or press. None should be invented.

## Product Principles

1. **Only what needs Dan interrupts Dan.** Everything else is kept, quietly, and stays findable.
2. **He stays in control.** Bots draft and prepare; Dan approves and sends.
3. **Glanceable in seconds, usable one-handed or by voice.**
4. **Personal, not corporate.** It should feel like his own assistant, with character.
5. **Nothing gets lost.** Saved things, past messages and decisions can always be found again.

## Accessibility & Inclusion

Adjustable text size must keep working; readable contrast in bright classrooms and at night; large touch targets for quick one-handed use; respect reduced-motion settings; everything usable by voice where voice exists.
