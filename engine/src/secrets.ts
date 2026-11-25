import { bridge, bridgeAvailable } from "./bridge.ts";
import { collection } from "./store.ts";

/**
 * Secrets (API keys, passwords, tokens). On the phone each value is
 * encrypted by the Android Keystore through the native bridge, so the file
 * on disk is useless without this device. Values are never sent to the UI;
 * the UI only learns whether a secret is set.
 */
const file = collection<Record<string, string>>("secrets", {});
const cache = new Map<string, string>();
let loaded = false;

async function load() {
  if (loaded) return;
  for (const [name, stored] of Object.entries(file.get())) {
    try {
      if (stored.startsWith("ks:")) {
        const { plain } = await bridge<{ plain: string }>("/secret/decrypt", { cipher: stored.slice(3) });
        cache.set(name, plain);
      } else if (stored.startsWith("dev:")) {
        cache.set(name, Buffer.from(stored.slice(4), "base64").toString("utf8"));
      }
    } catch {
      /* unreadable on this device (e.g. restored from elsewhere): treat as unset */
    }
  }
  loaded = true;
}

export async function initSecrets() {
  await load();
}

export function getSecret(name: string): string | undefined {
  return cache.get(name);
}

export function hasSecret(name: string): boolean {
  return Boolean(cache.get(name));
}

export async function setSecret(name: string, value: string | null): Promise<void> {
  await load();
  if (!value) {
    cache.delete(name);
    file.update((f) => {
      delete f[name];
    });
    return;
  }
  let stored: string;
  if (bridgeAvailable()) {
    const { cipher } = await bridge<{ cipher: string }>("/secret/encrypt", { plain: value });
    stored = `ks:${cipher}`;
  } else {
    stored = `dev:${Buffer.from(value, "utf8").toString("base64")}`;
  }
  cache.set(name, value);
  file.update((f) => {
    f[name] = stored;
  });
}
