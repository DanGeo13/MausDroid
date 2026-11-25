# MausDroid computer companion

A backup for when a subscription can't run on the phone itself: your
phone's bots use **Claude Code** (Claude) and **Codex** (ChatGPT) on your computer — signed in with your own accounts, no API
keys — while the phone stays in charge (approvals, browser, connected apps).

1. Install and sign in to the program(s) on your computer once:

   ```bash
   npm install -g @anthropic-ai/claude-code @openai/codex
   ```

   then run `claude` and `codex` once each and choose to sign in with your
   account.
2. Put the computer on your Tailscale network (install Tailscale there).
3. Start the companion (keep the window open, or add it to start-up):

   ```bash
   node companion.mjs
   ```

4. It prints a pairing token. On the phone: **Settings → AI → Claude**
   (or ChatGPT) → **Options** → companion address
   `http://<computer-name>:8790` → paste the token → **Save options**.

The companion only answers requests carrying that token. Work happens in
`~/.mausdroid-companion/work` unless you set `MAUSDROID_WORKDIR`.
