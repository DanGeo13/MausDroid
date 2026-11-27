# Screen Helper (Chrome extension)

Uses your normal ChatGPT account. No API key needed.

1. Press **⌘ ⇧ Y** (or click the toolbar icon) on the tab with your questions.
2. The extension screenshots the tab, copies it, and opens ChatGPT in a new tab with the
   instructions already typed in.
3. Press **⌘V** to paste the screenshot, then **Enter**.

ChatGPT then answers multiple choice, short answer and ordering questions. Ask follow-ups in the
same ChatGPT chat. It only sees the visible part of the tab, so scroll first if needed.

## Install (once)

1. On GitHub, open the `claude/busy-dirac-feib75` branch, click **Code → Download ZIP**, and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `screen-helper/extension` folder.
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Screen Helper**.
5. Make sure you're signed in at https://chatgpt.com.

To change the shortcut, go to `chrome://extensions/shortcuts`.

## Change the instructions

Edit `extension/prompt.js`, then click the reload icon on Screen Helper in `chrome://extensions`.

If ChatGPT changes its page and the instructions stop appearing, the extension shows a reminder
instead: paste with ⌘V and type your question yourself.
