import { inflateSync } from 'node:zlib';

/**
 * Minimal PNG statistics, so a screenshot suite can assert something about the IMAGE.
 *
 * Fifty of the fifty-eight checks in the screenshot matrix asserted only `bytes.length > 1024`.
 * An all-black frame passes that. So does a magenta shader-failure frame, and so does the
 * loading card. The suite could not fail, which is why nobody noticed that eight of ten authored
 * stills had no midtone shelf at all — one of them put 89.2% of the frame below 0.18.
 *
 * No dependencies: zlib is built in, and the decoder below handles the only colour types
 * Playwright emits (8-bit RGB and RGBA, non-interlaced).
 */

export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('Not a PNG: bad signature.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}.`);
  if (colourType !== 2 && colourType !== 6) throw new Error(`Unsupported PNG colour type ${colourType}.`);
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported.');

  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);

  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[x] = (line[x] + pr) & 0xff;
      }
    }
    line.copy(pixels, y * stride);
    previous = line;
  }

  return { width, height, channels, pixels };
}

const REC709 = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * @param image decoded PNG
 * @param options.titleColumn fraction of the frame width reserved for a store-page title block;
 *   the subject bounding box is reported against the remainder so staging can be asserted.
 */
export function imageStats(image, options = {}) {
  const { width, height, channels, pixels } = image;
  const step = options.step ?? 2;
  const subjectThreshold = options.subjectThreshold ?? 0.30;

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let black = 0;
  let white = 0;
  let midtone = 0;
  let shadow = 0;
  const levels = new Set();
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let subjectPixels = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const o = (y * width + x) * channels;
      const l = REC709(pixels[o], pixels[o + 1], pixels[o + 2]);
      count += 1;
      sum += l;
      sumSq += l * l;
      if (l < 0.02) black += 1;
      if (l > 0.98) white += 1;
      if (l < 0.18) shadow += 1;
      // The midtone shelf: the band a store-page frame needs between its dark anchor and its
      // hot accent. An image with only the anchor and the accent reads as an unfinished render.
      if (l >= 0.18 && l <= 0.45) midtone += 1;
      levels.add(Math.round(l * 64));
      if (l >= subjectThreshold) {
        subjectPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const mean = sum / count;
  return {
    width,
    height,
    sampled: count,
    mean: round(mean),
    stdDev: round(Math.sqrt(Math.max(sumSq / count - mean * mean, 0))),
    blackFraction: round(black / count),
    whiteFraction: round(white / count),
    shadowFraction: round(shadow / count),
    midtoneFraction: round(midtone / count),
    distinctLevels: levels.size,
    subject: maxX < 0
      ? null
      : {
        pixels: subjectPixels,
        fraction: round(subjectPixels / count),
        minX,
        minY,
        maxX,
        maxY,
        touchesLeft: minX <= step,
        touchesRight: maxX >= width - 1 - step,
        touchesTop: minY <= step,
        touchesBottom: maxY >= height - 1 - step,
      },
  };
}

function round(v) {
  return Math.round(v * 10_000) / 10_000;
}
