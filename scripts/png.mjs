/* ────────────────────────────────────────────────────────────
 *  scripts/png.mjs — 极简 PNG 解码器（仅供冒烟脚本做像素判定）
 *
 *  headless 截图拿到的是 PNG 字节流，Node 没有内置解码器。这里只实现
 *  验证需要的那一小块：8 位、非隔行的灰度 / 真彩 / 索引 / 带 alpha 图，
 *  也就是浏览器截图会产出的那几种。不支持 16 位、隔行与 tRNS 之外的
 *  高级特性——遇到不支持的形态直接抛错，而不是悄悄给出错误像素。
 *
 *  为什么要解码而不是在页面里 drawImage 取像素：WebGL 画布默认没有
 *  preserveDrawingBuffer，绘制缓冲在合成后即失效，drawImage 读回来是全透明，
 *  拿它判定「画面非空白」会恒假。截图走的是合成结果，不受此限制。
 * ──────────────────────────────────────────────────────────── */

import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 每像素通道数 */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 PNG 为 { width, height, data }，data 为 RGBA 字节。
 * @param {Buffer} buf
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 数据');

  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + data + crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (depth !== 8) throw new Error(`只支持 8 位 PNG，收到 ${depth} 位`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`不支持的色彩类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 4);

  // 逐行反滤波。filter 类型见 PNG 规范 §9。
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(line, 0, rp, rp + stride);
    rp += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const x = line[i];
      if (filter === 1) line[i] = (x + a) & 0xff;
      else if (filter === 2) line[i] = (x + b) & 0xff;
      else if (filter === 3) line[i] = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[i] = (x + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`未知的行滤波类型 ${filter}`);
    }

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      if (colorType === 6) {
        out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = line[s + 3];
      } else if (colorType === 2) {
        out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = line[s + 1];
      } else if (colorType === 3) {
        const p = line[s] * 3;
        out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2];
        out[o + 3] = trns && line[s] < trns.length ? trns[line[s]] : 255;
      }
    }

    line.copy(prev);
  }

  return { width, height, data: out };
}

/** 画面统计：用于判断「有实际画面」而不是空白/纯色 */
export function imageStats(img) {
  const { data } = img;
  const seen = new Set();
  let sum = 0;
  let opaque = 0;
  const counts = new Map();
  const total = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] > 8) opaque++;
    sum += (r + g + b) / 3;
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let dominant = 0;
  for (const n of counts.values()) if (n > dominant) dominant = n;

  return {
    total,
    opaque,
    mean: sum / total,
    distinct: seen.size,
    /** 出现最多的颜色占比：纯色页会接近 1 */
    dominantRatio: dominant / total,
  };
}

/** 两张同尺寸图的差异比例（0~1），按通道差超过阈值的像素计 */
export function diffRatio(a, b, threshold = 12) {
  if (a.data.length !== b.data.length) return 1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > threshold) n++;
  }
  return n / (a.data.length / 4);
}
