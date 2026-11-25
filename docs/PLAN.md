# MausDroid plan (agreed scope)

Three phases, each tested on the Poco F8 before the next.

## Phase 1 — core (this release)
Bots & chats · AI: API keys, subscriptions (Claude Code/Codex), free and
local/custom models · Composio (all its services) + Google Drive · background
browser (screen-off capable) · GitHub skills marketplace · approvals in chat
and notifications · routines + basic smart alerts + quiet hours · built-in
Tailscale · always-on password-protected website with QR pairing ·
self-updating (signed OTA + rollback).

## Phase 2 — phone & communication
- Calls, SMS, contacts.
- **Meta, no/low-risk only** (never drives your Facebook/WhatsApp account):
  1. read notifications from Messenger, WhatsApp, Marketplace;
  2. approved quick replies from the notification (you tap to send);
  3. prefilled messages / Marketplace listings opened for you to send/post;
  4. Facebook alert emails via Gmail.
- Live voice calls: API (OpenAI/Gemini realtime), free voices, the phone's
  own speech, local/PC models.
- Smart alerts in the style of Meta Muse / Grok Bot: condition watchers,
  morning briefings, inbox/message nudges, proactive check-ins (with an
  off switch, not reading encrypted apps by default), digests.
- Rooms/channels with several bots.

## Phase 3 — school & payments
- **Compass (read-only):** Compass app notifications + your Compass
  calendar (iCal) feed. No logins or clicks inside Compass.
- **Intranet documents:** you give the current documents; each tagged
  weekly / monthly / term / semester / year. The app checks on that
  schedule, detects replacements and summarises changes. Quick links grouped
  by purpose so you or a bot can find a document fast. Uses your school
  Google account (Drive), falling back to the background browser if the
  school blocks outside apps.
- **Payment vault (n8n Nod style):** cards encrypted on the phone; the model
  never sees the number; every payment pauses for your approval where you
  enter the CVV; CVV/OTP typed in chat is intercepted; states
  pending/entering/submitted/uncertain/expired; usage log.

## Decisions
- Sideloaded APK targeting Android API 28 (needed to run Claude Code/Codex
  and Tailscale on the phone). Not for Google Play.
- Updates are fetched from the public `updates` branch of this repo and must
  be signed with the MausDroid update key.
