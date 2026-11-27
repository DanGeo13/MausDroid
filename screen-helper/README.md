# Screen Helper (Chrome extension)

Press **⌘ ⇧ Y** in Chrome and a side panel opens. ChatGPT looks at the current tab and answers the
questions on it: multiple choice, short answers, and putting things in the right order. Ask
follow-ups underneath.

It uses your **ChatGPT subscription by sign-in, with no API key and nothing else to install**. You
sign in on OpenAI's own page, the same one Codex uses. It only sees the visible part of the current
Chrome tab.

> It borrows Codex's sign-in, which OpenAI doesn't officially offer to other apps. It may stop
> working if OpenAI changes it, and using it this way may go against OpenAI's terms.

## Install (once)

1. On GitHub, open the `claude/busy-dirac-feib75` branch, click **Code → Download ZIP**, and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `screen-helper/extension` folder.
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Screen Helper**.
5. Open the panel and click **Sign in with ChatGPT**. Sign in on the OpenAI page that opens; the tab
   closes by itself.

## Use it

- Press **⌘ ⇧ Y** (or click the toolbar icon). It reads the tab straight away.
- Moved to a new question? Click **Look at this tab**.
- **Model** and **Effort** menus: the list comes from your ChatGPT account. **Quick** is fastest;
  higher effort is slower but more careful and uses more of your plan's limits. Your choice is
  remembered.
- To change the shortcut, go to `chrome://extensions/shortcuts`.

Your sign-in is stored in Chrome's extension storage on this computer. **Sign out** removes it.

## Change the instructions

Edit `extension/prompt.js`, then click the reload icon on Screen Helper in `chrome://extensions`.
