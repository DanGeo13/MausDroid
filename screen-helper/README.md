# Screen Helper (Chrome extension)

Press **⌘ ⇧ Y** in Chrome and a side panel opens. AI on **Groq** looks at the current tab and
answers the questions on it: multiple choice, short answers, and putting things in the right
order. Ask follow-ups underneath. It only sees the visible part of the current Chrome tab.

## Install (once)

1. On GitHub, open the `claude/busy-dirac-feib75` branch, click **Code → Download ZIP**, and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. If an older Screen Helper is there, click **Remove** on it.
4. Click **Load unpacked** and choose the `screen-helper/extension` folder.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Screen Helper**.
6. Get a Groq API key at https://console.groq.com/keys (it starts with `gsk_`).
7. Open the panel, click **API key**, paste it, and click **Save**. The key is stored on this
   computer only, in Chrome's extension storage.

## Use it

- Press **⌘ ⇧ Y** (or click the toolbar icon). It reads the tab straight away.
- Moved to a new question? Click **Look at this tab**.
- **Model** menu: the list comes from Groq. Models marked 👁 can read images; pick one of those.
  Your choice is remembered.
- To change the shortcut, go to `chrome://extensions/shortcuts`.

## Change the instructions

Edit `extension/prompt.js`, then click the reload icon on Screen Helper in `chrome://extensions`.
