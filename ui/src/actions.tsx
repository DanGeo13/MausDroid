import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { BotPicto, IconBot, IconChat, IconCopy, IconGlobe, IconMail, IconMore, IconPlay, IconShare, IconStop } from "./icons.tsx";

/** Short message at the bottom of the screen. */
export const toast = (m: string) => {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = m;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
};

/** Puts text on the clipboard exactly as it is (line breaks and links kept). */
export async function copyText(text: string) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    /* the WebView may not allow it: the phone does it instead */
  }
  try {
    await api("share/copy", { body: { text } });
    ok = true;
  } catch {
    /* website on a computer: the browser copy above is all there is */
  }
  return ok;
}

let speakingId: string | null = null;
const listeners = new Set<() => void>();

/**
 * Copy, Play (Stop while playing) and Share beneath an assistant response.
 * Share: Another bot, Chrome, then messaging apps and email — prefilled where
 * the app supports it, otherwise copied with the app opened to paste. You
 * choose the recipient and press send yourself.
 */
export function ResponseActions({ id, text, title, openBot }: { id: string; text: string; title?: string; openBot?: (botId: string, text: string) => void }) {
  const [playing, setPlaying] = useState(false);
  const [menu, setMenu] = useState<"" | "share" | "bots">("");
  const [targets, setTargets] = useState<any | null>(null);
  const [bots, setBots] = useState<any[]>([]);
  useEffect(() => {
    const sync = () => setPlaying(speakingId === id);
    listeners.add(sync);
    return () => void listeners.delete(sync);
  }, [id]);
  const setSpeaking = (v: string | null) => {
    speakingId = v;
    listeners.forEach((f) => f());
  };
  const play = async () => {
    if (playing) {
      setSpeaking(null);
      await api("voice/stop", { body: {} }).catch(() => {});
      return;
    }
    setSpeaking(id);
    try {
      await api("voice/speak", { body: { text } });
      // Back to Play when it has finished (or was stopped elsewhere).
      for (let i = 0; i < 600 && speakingId === id; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const st = await api("voice/state").catch(() => ({ speaking: false }));
        if (!st.speaking && i > 1) break;
      }
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    if (speakingId === id) setSpeaking(null);
  };
  const openShare = async () => {
    setMenu(menu ? "" : "share");
    if (!targets) setTargets(await api("share/targets").catch(() => ({ chrome: false, apps: [{ id: "email", label: "Email", accent: "#EA4335", prefill: true }] })));
  };
  const toBot = async () => {
    setMenu("bots");
    setBots(((await api("state").catch(() => ({ bots: [] }))).bots ?? []).filter((b: any) => !b.hidden));
  };
  const app = async (a: any) => {
    setMenu("");
    try {
      const r = await api("share/app", { body: { app: a.id, pkg: a.pkg, prefill: a.prefill, text, subject: title } });
      if (r.done === "copied-and-opened") toast(`Copied — paste it in ${a.label} and send when you're ready.`);
    } catch (e) {
      if (await copyText(text)) toast(`Copied. ${(e as Error).message}`);
      else toast(`⚠️ ${(e as Error).message}`);
    }
  };
  return (
    <div class="resp-actions">
      <button class="icon-btn small" aria-label="Copy response" title="Copy" onClick={async () => toast((await copyText(text)) ? "Copied" : "Couldn't copy")}>
        <IconCopy />
      </button>
      <button class="icon-btn small" aria-label={playing ? "Stop reading aloud" : "Read aloud"} title={playing ? "Stop" : "Play"} onClick={play}>
        {playing ? <IconStop /> : <IconPlay />}
      </button>
      <button class="icon-btn small" aria-label="Share response" title="Share" aria-expanded={Boolean(menu)} onClick={openShare}>
        <IconShare />
      </button>
      {menu === "share" ? (
        <div class="share-menu" role="menu">
          <button role="menuitem" onClick={toBot}>
            <span class="icon-glyph"><IconBot /></span> Another bot
          </button>
          <button
            role="menuitem"
            onClick={async () => {
              setMenu("");
              const r = await api("share/view", { body: { text, title: title ?? "From DanDroid" } }).catch((e) => ({ error: (e as Error).message }));
              if (r.error) toast(`⚠️ ${r.error}`);
              else if (!targets?.chrome) window.open(r.url, "_blank");
            }}
          >
            <span class="icon-glyph"><IconGlobe /></span> Chrome
          </button>
          {(targets?.apps ?? []).map((a: any) => (
            <button role="menuitem" onClick={() => app(a)}>
              <span class="icon-glyph">{a.id === "email" ? <IconMail /> : a.id === "other" ? <IconMore /> : <IconChat />}</span> {a.label}
              {a.prefill ? "" : " (copy + open)"}
            </button>
          ))}
        </div>
      ) : null}
      {menu === "bots" ? (
        <div class="share-menu" role="menu" aria-label="Choose a bot">
          {bots.map((b) => (
            <button
              role="menuitem"
              onClick={() => {
                setMenu("");
                openBot?.(b.id, `Shared with you to review:\n\n${text}`);
              }}
            >
              <span class="avatar" style={{ width: "2rem", height: "2rem" }}><BotPicto name={b.name} /></span> {b.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
