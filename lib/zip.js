'use strict';

// Pure Node.js PKZIP (.zip) builder using Store (method 0) + UTF-8 flag (0x0800).
// Works out-of-the-box for JPEG/PNG photos without any native dependencies.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

function sanitizeZipEntryName(rawName, usedNames) {
  const cleaned = String(rawName || 'photo.jpg')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim() || 'photo.jpg';
  const dotIdx = cleaned.lastIndexOf('.');
  const base = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '';

  let candidate = cleaned;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Builds a standard .zip Buffer from an array of { name, buffer, date? }.
 * @param {Array<{name: string, buffer: Buffer, date?: Date}>} entries
 * @returns {Buffer}
 */
function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  const usedNames = new Set();
  let offset = 0;

  for (const entry of entries) {
    const dataBuf = Buffer.isBuffer(entry.buffer)
      ? entry.buffer
      : Buffer.from(entry.buffer || '');
    const safeName = sanitizeZipEntryName(entry.name, usedNames);
    const nameBuf = Buffer.from(safeName, 'utf8');
    const crc = crc32(dataBuf);
    const { dosTime, dosDate } = toDosDateTime(entry.date || new Date());
    const flags = 0x0800; // UTF-8 filename bit

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature PK\x03\x04
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6);      // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(0, 8);          // compression method: 0 (Store)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);              // extra field length

    localParts.push(localHeader, nameBuf, dataBuf);

    // Central directory file header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature PK\x01\x02
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(0, 10);         // method: Store
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra length
    centralHeader.writeUInt16LE(0, 32);         // comment length
    centralHeader.writeUInt16LE(0, 34);         // disk number start
    centralHeader.writeUInt16LE(0, 36);         // internal file attributes
    centralHeader.writeUInt32LE(0, 38);         // external file attributes
    centralHeader.writeUInt32LE(offset, 42);    // relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature PK\x05\x06
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);         // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

module.exports = {
  createZipBuffer,
  crc32
};
