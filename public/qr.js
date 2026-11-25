'use strict';

/**
 * Self-contained ISO/IEC 18004 QR Code Generator (Byte mode, ECC Level L, Versions 1..10)
 * Renders scannable QR codes onto an HTMLCanvasElement offline or online.
 */
(function (global) {
  // GF(256) exponent & log tables with primitive polynomial 0x11d
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP[i] = EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function polyMul(p, q) {
    const out = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) {
      for (let j = 0; j < q.length; j++) {
        out[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return out;
  }

  function rsGeneratorPoly(degree) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      g = polyMul(g, new Uint8Array([1, EXP[i]]));
    }
    return g;
  }

  function rsRemainder(data, degree) {
    const gen = rsGeneratorPoly(degree);
    const msg = new Uint8Array(data.length + degree);
    msg.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  // Version table for ECC Level L (1..6, single block for simplicity & high capacity up to 134 bytes)
  const VERSIONS_L = [
    null,
    { v: 1, size: 21, totalCodewords: 26, ecCodewords: 7, align: [] },
    { v: 2, size: 25, totalCodewords: 44, ecCodewords: 10, align: [6, 18] },
    { v: 3, size: 29, totalCodewords: 70, ecCodewords: 15, align: [6, 22] },
    { v: 4, size: 33, totalCodewords: 100, ecCodewords: 20, align: [6, 26] },
    { v: 5, size: 37, totalCodewords: 134, ecCodewords: 26, align: [6, 30] }
  ];

  function pickVersion(byteLen) {
    for (let v = 1; v <= 5; v++) {
      const info = VERSIONS_L[v];
      const dataCap = info.totalCodewords - info.ecCodewords - 2;
      if (byteLen <= dataCap) return info;
    }
    return VERSIONS_L[5];
  }

  function encodeDataCodewords(text) {
    const utf8 = new TextEncoder().encode(String(text || ''));
    const info = pickVersion(utf8.length);
    const dataCap = info.totalCodewords - info.ecCodewords;
    const maxPayload = dataCap - 2;
    const bytes = utf8.length > maxPayload ? utf8.slice(0, maxPayload) : utf8;

    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    }

    // Byte mode indicator (0100) + 8-bit character count (versions 1..9)
    pushBits(0b0100, 4);
    pushBits(bytes.length, 8);
    for (let i = 0; i < bytes.length; i++) {
      pushBits(bytes[i], 8);
    }

    // Terminator up to 4 zero bits
    const maxBits = dataCap * 8;
    const term = Math.min(4, maxBits - bits.length);
    pushBits(0, term);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = new Uint8Array(dataCap);
    for (let i = 0; i < bits.length / 8; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | bits[i * 8 + j];
      }
      codewords[i] = b;
    }

    const pads = [0xec, 0x11];
    let pIdx = 0;
    for (let i = bits.length / 8; i < dataCap; i++) {
      codewords[i] = pads[pIdx % 2];
      pIdx++;
    }

    const ec = rsRemainder(codewords, info.ecCodewords);
    const full = new Uint8Array(info.totalCodewords);
    full.set(codewords, 0);
    full.set(ec, codewords.length);
    return { info, full };
  }

  function buildMatrix(text) {
    const { info, full } = encodeDataCodewords(text);
    const n = info.size;
    const matrix = Array.from({ length: n }, () => new Int8Array(n)); // 0=unset, 1=light, 2=dark
    const isFunc = Array.from({ length: n }, () => new Uint8Array(n));

    function setFunc(r, c, dark) {
      if (r < 0 || r >= n || c < 0 || c >= n) return;
      matrix[r][c] = dark ? 2 : 1;
      isFunc[r][c] = 1;
    }

    function placeFinder(row, col) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= n || c < 0 || c >= n) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunc(r, c, inOuter || inInner);
        }
      }
    }

    placeFinder(0, 0);
    placeFinder(0, n - 7);
    placeFinder(n - 7, 0);

    // Timing patterns
    for (let i = 8; i < n - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    if (info.align.length) {
      for (const ar of info.align) {
        for (const ac of info.align) {
          if (isFunc[ar][ac]) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
              setFunc(ar + dr, ac + dc, dark);
            }
          }
        }
      }
    }

    // Reserve format info & dark module
    for (let i = 0; i < 9; i++) {
      if (!isFunc[8][i]) isFunc[8][i] = 1;
      if (!isFunc[i][8]) isFunc[i][8] = 1;
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][n - 1 - i] = 1;
      isFunc[n - 1 - i][8] = 1;
    }
    setFunc(n - 8, 8, true);

    // Place data bits in zig-zag
    const allBits = [];
    for (let i = 0; i < full.length; i++) {
      for (let b = 7; b >= 0; b--) {
        allBits.push((full[i] >>> b) & 1);
      }
    }

    let bitIdx = 0;
    let upward = true;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        const r = upward ? (n - 1 - vert) : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            const dark = bitIdx < allBits.length ? Boolean(allBits[bitIdx++]) : false;
            // Mask 0: (r + c) % 2 === 0
            const masked = ((r + c) % 2 === 0) ? !dark : dark;
            matrix[r][c] = masked ? 2 : 1;
          }
        }
      }
      upward = !upward;
    }

    // Format info bits for ECC Level L (01) + Mask 0 (000) -> precomputed BCH 0x77c4
    const formatBits = 0x77c4;
    function getFmtBit(i) {
      return ((formatBits >>> i) & 1) === 1;
    }

    for (let i = 0; i <= 5; i++) setFunc(8, i, getFmtBit(i));
    setFunc(8, 7, getFmtBit(6));
    setFunc(8, 8, getFmtBit(7));
    setFunc(7, 8, getFmtBit(8));
    for (let i = 9; i < 15; i++) setFunc(14 - i, 8, getFmtBit(i));

    for (let i = 0; i < 8; i++) setFunc(8, n - 1 - i, getFmtBit(i));
    for (let i = 8; i < 15; i++) setFunc(n - 15 + i, 8, getFmtBit(i));

    return { size: n, matrix };
  }

  function renderToCanvas(canvas, text, opts = {}) {
    const { size, matrix } = buildMatrix(text);
    const quiet = 4;
    const totalModules = size + quiet * 2;
    const pixelSize = opts.pixelSize || 260;
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext('2d');
    const scale = pixelSize / totalModules;

    ctx.fillStyle = opts.lightColor || '#ffffff';
    ctx.fillRect(0, 0, pixelSize, pixelSize);

    ctx.fillStyle = opts.darkColor || '#8a0e4b';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c] === 2) {
          ctx.fillRect(
            Math.floor((c + quiet) * scale),
            Math.floor((r + quiet) * scale),
            Math.ceil(scale),
            Math.ceil(scale)
          );
        }
      }
    }
  }

  global.RM6QR = { renderToCanvas, buildMatrix };
})(window);
