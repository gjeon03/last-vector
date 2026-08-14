"""
The three numbers the hostile art director said he would hold us to on a re-score:

  1. median frame luminance 22-35   (was 6-11)
  2. a measurable rim peak INSIDE the silhouette of a backlit rock   (was zero)
  3. a visible frame deformation between cruise and boost captures   (was none)

This measures 2 and 3 from PNGs, because the WebGL canvas has no preserveDrawingBuffer and a
2D readback returns zeros — screenshots are the only reliable colour evidence in this project.
"""

import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    pos, idat = 8, b''
    w = h = ct = 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, _bd, ct = struct.unpack('>IIBB', chunk[:10])
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    bpp = 4 if ct == 6 else 3
    stride = w * bpp
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _y in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line
    return w, h, bpp, bytes(out)


def lum_row(px, w, bpp, y):
    row = []
    for x in range(w):
        o = (y * w + x) * bpp
        row.append(0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2])
    return row


def rim_peaks(path, rows):
    """A backlit rock is a dark run bounded by bright sky. A rim exists if luminance rises to a
    local maximum INSIDE that dark run before falling to the silhouette's interior."""
    w, h, bpp, px = read_png(path)
    found = []
    for y in rows:
        row = lum_row(px, w, bpp, y)
        x = 1
        while x < w - 1:
            if row[x] < 30 and row[x - 1] >= 30:          # entering a silhouette
                start = x
                while x < w - 1 and row[x] < 90:
                    x += 1
                end = x
                if 24 <= end - start <= 900:               # a plausible rock, not the void
                    inner = row[start:end]
                    if len(inner) > 12:
                        edge = max(inner[:len(inner) // 3])
                        core = min(inner[len(inner) // 3:2 * len(inner) // 3])
                        if edge - core >= 6:
                            found.append((y, start, end, round(edge, 1), round(core, 1),
                                          round(edge - core, 1)))
            x += 1
    return found


def streak_length(path):
    """Mean horizontal run length of bright pixels — dust streaks elongate under boost."""
    w, h, bpp, px = read_png(path)
    runs = []
    for y in range(120, h - 120, 7):
        row = lum_row(px, w, bpp, y)
        run = 0
        for x in range(w):
            if row[x] > 96:
                run += 1
            else:
                if 2 <= run <= 260:
                    runs.append(run)
                run = 0
    runs.sort()
    if not runs:
        return 0.0, 0, 0.0
    return (sum(runs) / len(runs), len(runs), runs[int(len(runs) * 0.9)])


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'rim':
        for path in sys.argv[2:]:
            hits = rim_peaks(path, range(200, 900, 9))
            name = path.rsplit('/', 1)[-1]
            print(f'{name:<22} rim peaks found: {len(hits)}')
            for hit in hits[:5]:
                print(f'    y={hit[0]:<5} span {hit[1]}-{hit[2]}px  '
                      f'edge {hit[3]} vs core {hit[4]}  ->  +{hit[5]} lum inside the silhouette')
    elif mode == 'streak':
        for path in sys.argv[2:]:
            mean, n, p90 = streak_length(path)
            name = path.rsplit('/', 1)[-1]
            print(f'{name:<22} bright runs {n:<6} mean {mean:.1f}px  p90 {p90}px')


def radial_rg(path, bins=10):
    """Mean R-G by radius. The damage overlay has a distinctive smoothstep shape; a flat
    profile means the cast is coming from the scene, not from a full-screen additive."""
    w, h, bpp, px = read_png(path)
    cx, cy = w / 2, h / 2
    maxr = (cx ** 2 + cy ** 2) ** 0.5
    sums = [0.0] * bins
    counts = [0] * bins
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            o = (y * w + x) * bpp
            r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / maxr
            b = min(bins - 1, int(r * bins))
            sums[b] += px[o] - px[o + 1]
            counts[b] += 1
    return [round(sums[i] / max(counts[i], 1), 1) for i in range(bins)]
