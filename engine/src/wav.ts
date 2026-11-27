/**
 * Just enough WAV handling to join the phone's recorded speech into one
 * file: reads 16-bit PCM (any rate, mono or stereo), converts to one common
 * format, adds pauses and writes a single WAV. No extra libraries.
 */
export interface Pcm {
  sampleRate: number;
  /** Mono 16-bit samples. */
  samples: Int16Array;
}

export function readWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV recording.");
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const idStr = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    // Some engines write a placeholder size for streamed data: take the rest of the file.
    if (idStr === "data" && (size === 0 || size === 0xffffffff || start + size > buf.length)) size = buf.length - start;
    if (idStr === "fmt ") fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    else if (idStr === "data") {
      data = buf.subarray(start, start + size);
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("The recording is incomplete.");
  if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error("The voice engine recorded in an unsupported format.");
  if (fmt.bits !== 16 && fmt.bits !== 8) throw new Error(`The voice engine recorded ${fmt.bits}-bit audio, which isn't supported.`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      sum += bytes === 2 ? data.readInt16LE(o) : (data[o] - 128) << 8;
    }
    out[i] = Math.round(sum / fmt.channels);
  }
  return { sampleRate: fmt.rate, samples: out };
}

/** Changes the sample rate (simple linear interpolation; fine for speech). */
export function resample(p: Pcm, rate: number): Pcm {
  if (p.sampleRate === rate || !p.samples.length) return { sampleRate: rate, samples: p.samples };
  const ratio = p.sampleRate / rate;
  const n = Math.floor(p.samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, p.samples.length - 1);
    out[i] = Math.round(p.samples[a] + (p.samples[b] - p.samples[a]) * (x - a));
  }
  return { sampleRate: rate, samples: out };
}

export const seconds = (p: Pcm) => p.samples.length / p.sampleRate;

/** Joins pieces (converted to the first piece's rate) with a pause between them. */
export function join(parts: Pcm[], pauseSec = 0.35): Pcm {
  if (!parts.length) return { sampleRate: 24000, samples: new Int16Array(0) };
  const rate = parts[0].sampleRate;
  const same = parts.map((p) => resample(p, rate));
  const gap = Math.round(pauseSec * rate);
  const total = same.reduce((n, p) => n + p.samples.length, 0) + gap * Math.max(0, same.length - 1);
  const out = new Int16Array(total);
  let o = 0;
  same.forEach((p, i) => {
    out.set(p.samples, o);
    o += p.samples.length + (i < same.length - 1 ? gap : 0);
  });
  return { sampleRate: rate, samples: out };
}

export function writeWav(p: Pcm): Buffer {
  const data = Buffer.from(p.samples.buffer, p.samples.byteOffset, p.samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(p.sampleRate, 24);
  h.writeUInt32LE(p.sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * A soft breath ("breath" = short in-breath, "sigh" = longer out-breath):
 * band-limited noise with a breath-shaped envelope, quiet (about -22 dBFS).
 * Sounds far more natural than a voice engine reading the word.
 */
export function breath(kind: "breath" | "sigh", rate = 24000, seed = 7): Pcm {
  const sec = kind === "sigh" ? 0.75 : 0.38;
  const n = Math.round(sec * rate);
  const out = new Int16Array(n);
  let x = seed >>> 0;
  let lp = 0;
  let lp2 = 0;
  const a = Math.exp((-2 * Math.PI * (kind === "sigh" ? 1800 : 2600)) / rate); // low-pass
  const b = Math.exp((-2 * Math.PI * 250) / rate); // high-pass corner
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const white = x / 2147483648 - 1;
    lp = a * lp + (1 - a) * white;
    lp2 = b * lp2 + (1 - b) * lp;
    const band = lp - lp2;
    const t = i / n;
    // In-breath swells then stops; a sigh rises fast and fades slowly.
    const env = kind === "sigh" ? Math.min(1, t / 0.12) * Math.pow(1 - t, 1.6) : Math.sin(Math.PI * Math.min(1, t * 1.1)) ** 1.5;
    out[i] = Math.round(Math.max(-1, Math.min(1, band * 9 * env)) * 2600);
  }
  return { sampleRate: rate, samples: out };
}
