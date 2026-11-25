# MausDroid 🐭

Your own team of AI bots, running on your Android phone. An Android
adaptation of [OpenMausBot](https://github.com/milind-soni/OpenMausBot):
every chat is a real agent with its own personality, brain (AI model),
tools and connected apps. They work in the background (also with the
screen off), and **ask before anything risky**.

## Install on your phone (Poco F8 / any Android 9+, 64-bit)

1. On the phone, download the latest APK:
   **https://raw.githubusercontent.com/DanGeo13/MausDroid/updates/MausDroid-0.1.0.apk**
2. Open it. Android asks to allow installing from your browser/files app → allow → **Install**.
3. Open **MausDroid** and follow the short tour.

After this you never need to download the APK again: MausDroid updates
itself in the background. Only rare core changes need a new APK, and then
you get a notification — tap it to install. Your bots, chats and settings stay.

## What's in Phase 1 (this version)

| | |
|---|---|
| Bots like contacts | Chat list, personalities, pin, per-bot AI model, approval level, skills |
| AI brains | Claude / OpenAI API keys · free: Gemini (AI Studio key), OpenRouter free models, Groq · local or custom endpoints (phone, PC, any device) · **Claude Code and Codex with your subscriptions** via the [computer companion](companion/README.md) (on-phone mode experimental) |
| Background browser | Runs inside the app's background service; you keep using the phone; works with the screen off. Sign in yourself once ("browser_ask_login"), bots reuse the login |
| Connected apps | Composio: Gmail, Google Drive, Calendar, Outlook, Slack, Notion and 500+ more, several accounts per app |
| Skills marketplace | Search GitHub for skills (SKILL.md) or install from any repo link |
| Approvals | Allow / Deny cards in chat and **in the notification** |
| Smart alerts (base) | Routines & watchers ("every weekday 7am brief me", "only alert me if…"), quiet hours, alert history |
| Built-in Tailscale | Joins your tailnet itself with an auth key — no Tailscale app needed |
| Always-on website | Password protected, devices added by QR code ([relay/README.md](relay/README.md)) |
| Self-updating | Signed over-the-air updates with automatic rollback |

Coming in Phases 2 and 3: see [docs/PLAN.md](docs/PLAN.md).

## How it's built

- `android/` — Kotlin shell: foreground service (`:engine` process) running
  the engine on embedded Node.js (nodejs-mobile), background browser,
  notifications, Android Keystore, built-in Tailscale, updater.
- `engine/` — the bots (TypeScript): agent loop, AI providers, tools,
  Composio, skills, routines, approvals, pairing. Updates over the air.
- `ui/` — the app screens (Preact), served by the engine to the app, over
  Tailscale and through the website.
- `tsbridge/` — built-in Tailscale (Go, tsnet).
- `relay/` — always-on website (Cloudflare Worker).
- `companion/` — runs Claude Code / Codex on your computer for the phone.

Developers: [docs/BUILD.md](docs/BUILD.md) · releasing: [docs/RELEASING.md](docs/RELEASING.md).

Licensed Apache-2.0. See [NOTICE](NOTICE).
