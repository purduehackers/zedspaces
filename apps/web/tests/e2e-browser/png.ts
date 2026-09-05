import zlib from "node:zlib";

/**
 * A minimal reader for the PNGs Playwright's screenshots are (8-bit, non-interlaced RGB or
 * RGBA), enough to sample the pixels of a canvas. The page's own canvas APIs cannot read a
 * WebGL/WebGPU canvas back once the frame was presented (no `preserveDrawingBuffer`), so a
 * "did it paint" check goes through the compositor's picture instead.
 */
export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  /** Unfiltered rows, `channels` bytes per pixel. */
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(png: Buffer): DecodedPng {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG image data");
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

export interface PixelSample {
  /** Distinct `r,g,b,a` values seen and how often. */
  colours: Map<string, number>;
  opaque: number;
  sampled: number;
}

/** Every `step`-th pixel of every `step`-th row (alpha is 255 for images without one). */
export function samplePixels(image: DecodedPng, step = 8): PixelSample {
  const colours = new Map<string, number>();
  let opaque = 0;
  let sampled = 0;
  const px = image.data;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * image.channels;
      let rgba: [number, number, number, number];
      switch (image.channels) {
        case 4:
          rgba = [px[i], px[i + 1], px[i + 2], px[i + 3]];
          break;
        case 3:
          rgba = [px[i], px[i + 1], px[i + 2], 255];
          break;
        case 2:
          rgba = [px[i], px[i], px[i], px[i + 1]];
          break;
        default:
          rgba = [px[i], px[i], px[i], 255];
      }
      const key = rgba.join(",");
      colours.set(key, (colours.get(key) ?? 0) + 1);
      if (rgba[3] === 255) opaque += 1;
      sampled += 1;
    }
  }
  return { colours, opaque, sampled };
}
