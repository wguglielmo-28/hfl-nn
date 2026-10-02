// Minimal 16-bit PCM WAV encode/decode (mono; stereo input is mixed down).
'use strict';

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // PCM chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] || 0));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      const ch = fmt.channels;
      const end = Math.min(buf.length, body + size);
      if (fmt.format === 3 && fmt.bits === 32) {
        const frames = Math.floor((end - body) / (4 * ch));
        const out = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          let s = 0;
          for (let c = 0; c < ch; c++) s += buf.readFloatLE(body + (i * ch + c) * 4);
          out[i] = s / ch;
        }
        return { samples: out, sampleRate: fmt.sampleRate };
      }
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}`);
      const frames = Math.floor((end - body) / (2 * ch));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += buf.readInt16LE(body + (i * ch + c) * 2);
        out[i] = s / ch / 32768;
      }
      return { samples: out, sampleRate: fmt.sampleRate };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

// Linear resample — only used if a provider returns a different rate.
function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = (samples[i0] || 0) * (1 - f) + (samples[i0 + 1] || 0) * f;
  }
  return out;
}

module.exports = { encodeWav, decodeWav, resample };
