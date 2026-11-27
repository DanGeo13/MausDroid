# Screen Helper (Chrome extension + Mac helper)

Press **⌘ ⇧ Y** in Chrome and a side panel opens. ChatGPT looks at the current tab and answers the
questions on it: multiple choice, short answers, and putting things in the right order. Ask
follow-ups underneath.

It uses your **ChatGPT subscription by sign-in — no API key**, the same way the MausDroid app does:
a small helper on your Mac runs **Codex**, OpenAI's official program, signed in with your ChatGPT
account. It only sees the visible part of the current Chrome tab.

## Set up (once)

1. Install Node.js from https://nodejs.org (the "LTS" version).
2. Open the Terminal app and install Codex:

   ```bash
   npm install -g @openai/codex
   ```

3. Sign in with your ChatGPT account (choose **Sign in with ChatGPT**; a browser page opens):

   ```bash
   codex login
   ```

4. Download this repository (on GitHub: **Code → Download ZIP**, `claude/busy-dirac-feib75`
   branch) and unzip it.
5. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and
   choose the `screen-helper/extension` folder. Pin it from the puzzle-piece menu.

## Every time you use it

1. In Terminal, start the helper and leave the window open:

   ```bash
   cd ~/Downloads/MausDroid-claude-busy-dirac-feib75/screen-helper
   ```

   ```bash
   node helper.mjs
   ```

2. The first time only: click the extension, click **Pair**, paste the **pairing code** the helper
   printed, and click **Save**.
3. Press **⌘ ⇧ Y** on the tab with your questions.

## Choosing a model

The panel has **Model** and **Effort** menus. The list comes from your own Codex, so it shows the
models your ChatGPT plan can use. **Effort** is how hard the model thinks: **Quick** is fastest,
higher levels are slower but more careful and use more of your plan's limits. Your choice is
remembered.

## Safety

- The helper only accepts connections from this Mac, and only with the pairing code.
- Codex runs read-only: it can't change files on your Mac.
- Screenshots are deleted after each answer.

## Change the instructions

Edit `extension/prompt.js`, then click the reload icon on Screen Helper in `chrome://extensions`.
