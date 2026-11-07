import zlib from 'node:zlib';

// 의존성 없이 더미 상품 이미지(PNG)를 만든다: 색 배경 + "DUMMY" + 번호.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5x7 비트맵 글꼴 (필요한 글자만)
const FONT = {
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function drawText(rgb, width, text, cx, cy, scale, color) {
  const charW = 6 * scale; // 5px + 1px 간격
  const startX = Math.round(cx - (text.length * charW - scale) / 2);
  const startY = Math.round(cy - (7 * scale) / 2);
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch] || FONT[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = startX + i * charW + gx * scale + dx;
            const y = startY + gy * scale + dy;
            const p = (y * width + x) * 3;
            rgb[p] = color[0];
            rgb[p + 1] = color[1];
            rgb[p + 2] = color[2];
          }
        }
      }
    }
  });
}

/** 번호별로 색이 다른 정사각형 더미 이미지를 PNG Buffer로 만든다. */
export function makeDummyImage(index, size = 600) {
  const hue = (index * 47) % 360;
  const bg = hslToRgb(hue, 0.55, 0.62);
  const panel = hslToRgb(hue, 0.6, 0.9);
  const ink = hslToRgb(hue, 0.5, 0.25);
  const rgb = Buffer.alloc(size * size * 3);
  const margin = Math.round(size * 0.12);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inPanel = x >= margin && x < size - margin && y >= margin && y < size - margin;
      const c = inPanel ? panel : bg;
      const p = (y * size + x) * 3;
      rgb[p] = c[0];
      rgb[p + 1] = c[1];
      rgb[p + 2] = c[2];
    }
  }
  const scale = Math.max(2, Math.floor(size / 60));
  drawText(rgb, size, 'DUMMY', size / 2, size * 0.4, scale, ink);
  drawText(rgb, size, `#${String(index).padStart(3, '0')}`, size / 2, size * 0.6, scale, ink);
  return encodePng(size, size, rgb);
}

export function toDataUri(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}
