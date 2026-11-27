# Screen Helper (Chrome extension)

Press **⌘ ⇧ Y** in Chrome and a side panel opens. Claude looks at the current tab and answers the
questions on it: multiple choice, short answers, and putting things in the right order. You can then
type follow-up questions about the same screenshot.

It only sees the visible part of the current Chrome tab, not other apps.

## Install (once)

1. Download this repository (on GitHub: **Code → Download ZIP**, using the
   `claude/busy-dirac-feib75` branch) and unzip it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `screen-helper/extension` folder.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Screen Helper**.
6. Get an API key from https://console.anthropic.com (Settings → API Keys). Each question costs a
   small amount.
7. Open the panel, click **API key**, paste it and click **Save**. The key is stored on this
   computer only, in Chrome's extension storage (not encrypted).

## Use it

- Press **⌘ ⇧ Y** (or click the toolbar icon). It reads the tab straight away.
- Moved to a new question? Click **Look at this tab**.
- To change the shortcut, go to `chrome://extensions/shortcuts`.

## Change how it answers

Edit `SYSTEM_PROMPT` in `src/panel.js`, then rebuild and click the reload icon on the extension in
`chrome://extensions`:

```bash
npm install
npm run build
```
