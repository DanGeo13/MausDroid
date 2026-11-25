# MausDroid computer companion

Lets your phone's bots use **Claude Code** and **Codex** on your computer —
with your Claude Pro/Max or ChatGPT Plus/Pro subscription — while the phone
stays in charge (its approvals, browser and connected apps).

1. Install and sign in to the program(s) on your computer once:

   ```bash
   npm install -g @anthropic-ai/claude-code @openai/codex
   ```

   then run `claude` and `codex` once each to sign in.
2. Put the computer on your Tailscale network (install Tailscale there).
3. Start the companion (keep the window open, or add it to start-up):

   ```bash
   node companion.mjs
   ```

4. It prints a pairing token. On the phone: **Settings → AI → Claude Code** (or
   Codex) → *Run on: My computer* → address `http://<computer-name>:8790` →
   paste the token → **Save & turn on**.

The companion only answers requests carrying that token. Work happens in
`~/.mausdroid-companion/work` unless you set `MAUSDROID_WORKDIR`.
