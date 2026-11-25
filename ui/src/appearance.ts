// Per-device look: text size and theme. Saved on this device only, so your
// phone and PC can each have their own size.
export interface Appearance {
  scale: number;
  theme: "system" | "light" | "dark";
}
const KEY = "mausdroid.appearance";
const DEFAULT: Appearance = { scale: 1, theme: "system" };

export function loadAppearance(): Appearance {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT;
  }
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.style.setProperty("--scale", String(a.scale));
  if (a.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", a.theme);
}

export function saveAppearance(a: Appearance) {
  applyAppearance(a);
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode: still applies for this visit */
  }
}

export const TEXT_SIZES: { label: string; scale: number }[] = [
  { label: "Small", scale: 0.9 },
  { label: "Default", scale: 1 },
  { label: "Large", scale: 1.15 },
  { label: "Extra large", scale: 1.3 },
  { label: "Huge", scale: 1.5 },
];
