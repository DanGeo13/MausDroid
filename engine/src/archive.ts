import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

/** Downloads a URL to a file (streamed), reporting progress. Uses the engine's fetch. */
export async function download(url: string, file: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": "MausDroid" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(`${file}.part`);
  const reader = (res.body as any).getReader();
  let done = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      done += r.value.length;
      if (!out.write(Buffer.from(r.value))) await new Promise((ok) => out.once("drain", ok));
      onProgress?.(done, total);
    }
  } finally {
    await new Promise((ok) => out.end(ok));
  }
  fs.renameSync(`${file}.part`, file);
}

/**
 * Streams a .tar.gz (or Alpine .apk, which is several gzip parts joined)
 * and writes the entries for which `pick` returns a destination path.
 */
export async function extractTarGz(file: string, pick: (name: string) => string | null): Promise<string[]> {
  const written: string[] = [];
  let buf = Buffer.alloc(0);
  let current: { remaining: number; pad: number; out: number | null } | null = null;
  let longName: string | null = null;
  let collectingLongName: Buffer[] | null = null;

  const consume = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (true) {
      if (current) {
        if (current.remaining > 0) {
          if (!buf.length) return;
          const n = Math.min(current.remaining, buf.length);
          const part = buf.subarray(0, n);
          if (collectingLongName) collectingLongName.push(Buffer.from(part));
          else if (current.out !== null) fs.writeSync(current.out, part);
          buf = buf.subarray(n);
          current.remaining -= n;
          if (current.remaining > 0) return;
        }
        if (buf.length < current.pad) return;
        buf = buf.subarray(current.pad);
        if (current.out !== null) fs.closeSync(current.out);
        if (collectingLongName) {
          longName = Buffer.concat(collectingLongName).toString("utf8").replace(/\0.*$/s, "");
          collectingLongName = null;
        }
        current = null;
      }
      if (buf.length < 512) return;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) continue; // end blocks (also between joined archives)
      const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(str(124, 136).trim() || "0", 8) || 0;
      const type = String.fromCharCode(h[156] || 48);
      const prefix = str(345, 500);
      let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
      longName = null;
      const pad = (512 - (size % 512)) % 512;
      if (type === "L") {
        collectingLongName = [];
        current = { remaining: size, pad, out: null };
        continue;
      }
      name = name.replace(/^\.\//, "");
      let out: number | null = null;
      if (type === "0" || type === "\0" || type === "7") {
        const dest = pick(name);
        if (dest) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          out = fs.openSync(dest, "w", 0o755);
          written.push(dest);
        }
      } else if (type === "2") {
        // Symlink (e.g. libstdc++.so.6 -> libstdc++.so.6.0.33): copy target later.
        const dest = pick(name);
        if (dest) written.push(`${dest}\u0000${str(157, 257)}`);
      }
      current = { remaining: size, pad, out };
    }
  };

  await pipeline(
    fs.createReadStream(file),
    zlib.createGunzip(),
    new Writable({
      write(chunk, _enc, cb) {
        try {
          consume(chunk);
          cb();
        } catch (e) {
          cb(e as Error);
        }
      },
    }),
  );
  // Resolve symlinks inside the same folder by copying.
  const files = written.filter((w) => !w.includes("\u0000"));
  for (const link of written.filter((w) => w.includes("\u0000"))) {
    const [dest, target] = link.split("\u0000");
    const src = path.join(path.dirname(dest), path.basename(target));
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
      files.push(dest);
    }
  }
  return files;
}

/** Extracts chosen entries from a .zip file (stored or deflated). */
export function extractZip(file: string, pick: (name: string) => string | null): string[] {
  const zip = fs.readFileSync(file);
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    const dest = name.endsWith("/") ? null : pick(name);
    if (!dest) continue;
    const lnlen = zip.readUInt16LE(local + 26);
    const lelen = zip.readUInt16LE(local + 28);
    const data = zip.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, method === 8 ? zlib.inflateRawSync(data) : data, { mode: 0o755 });
    out.push(dest);
  }
  return out;
}
