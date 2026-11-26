import { useEffect, useRef, useState } from "preact/hooks";
import { copyWithFeedback } from "./copy.ts";
import { IconCheck, IconCopy } from "./icons.tsx";

/** Always-visible Copy icon (44 px, well over 32 dp). Hidden when there is nothing to copy. */
export function CopyButton({ text, class: cls = "" }: { text: string; class?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<any>(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      class={`copy-btn ${done ? "done" : ""} ${cls}`}
      aria-label="Copy message"
      title="Copy"
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyWithFeedback(text)) {
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

/** Wraps a message: long-press (or right-click) opens a small menu with "Copy". */
export function CopyMenu({ text, children, class: cls = "", mine = false }: { text: string; children: any; class?: string; mine?: boolean }) {
  const [open, setOpen] = useState(false);
  const press = useRef<any>(0);
  const cancel = () => clearTimeout(press.current);
  return (
    <div
      class={`${cls} copy-host`}
      onTouchStart={() => {
        cancel();
        press.current = setTimeout(() => text.trim() && setOpen(true), 550);
      }}
      onTouchMove={cancel}
      onTouchEnd={cancel}
      onTouchCancel={cancel}
      onContextMenu={(e) => {
        if (!text.trim()) return;
        e.preventDefault();
        setOpen(true);
      }}
    >
      {children}
      {open ? (
        <>
          <div class="menu-backdrop" onClick={() => setOpen(false)} />
          <div class={`copy-menu ${mine ? "mine" : ""}`} role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                await copyWithFeedback(text);
              }}
            >
              <IconCopy /> Copy
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
