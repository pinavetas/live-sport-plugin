'use strict';

/**
 * MadPlayProtobuf.js
 *
 * Lightweight, zero-dependency Protocol Buffers wire decoder.
 * Supports Varint (wire 0), 64-bit (wire 1), Length-delimited (wire 2),
 * and 32-bit (wire 5). Correctly handles nested messages vs UTF-8 strings.
 */

function readVarint(buffer, offset) {
  let res = 0n;
  let shift = 0n;
  while (offset < buffer.length) {
    const b = BigInt(buffer[offset++]);
    res |= (b & 0x7Fn) << shift;
    if ((b & 0x80n) === 0n) break;
    shift += 7n;
  }
  return { value: res, offset };
}

function decodeProtobuf(buffer, maxDepth = 10, depth = 0) {
  if (depth > maxDepth || !buffer || buffer.length === 0) return {};
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const result = {};
  let offset = 0;

  while (offset < buf.length) {
    let key;
    try {
      const tagResult = readVarint(buf, offset);
      key = Number(tagResult.value);
      offset = tagResult.offset;
    } catch (_) {
      break;
    }

    const wireType = key & 0x07;
    const fieldNumber = key >>> 3;
    if (fieldNumber === 0) break;

    let value;
    if (wireType === 0) { // Varint
      try {
        const valResult = readVarint(buf, offset);
        value = valResult.value;
        offset = valResult.offset;
      } catch (_) { break; }
    } else if (wireType === 1) { // 64-bit
      if (offset + 8 > buf.length) break;
      value = buf.readBigUInt64LE(offset).toString();
      offset += 8;
    } else if (wireType === 2) { // Length-delimited
      try {
        const lenResult = readVarint(buf, offset);
        const len = Number(lenResult.value);
        offset = lenResult.offset;
        if (offset + len > buf.length) break;
        const subBuf = buf.subarray(offset, offset + len);
        offset += len;

        // Try decoding as string
        const str = subBuf.toString('utf8');
        const isPrintable = /^[\x20-\x7E\s\u00A0-\uFFFF]*$/.test(str) && !/[\x00-\x1F]/.test(str);

        // Try decoding as sub-message
        let subMsg = null;
        if (len > 1 && !isPrintable) {
          try {
            subMsg = decodeProtobuf(subBuf, maxDepth, depth + 1);
            if (Object.keys(subMsg).length === 0) subMsg = null;
          } catch (_) {}
        }

        if (subMsg) {
          value = subMsg;
        } else if (isPrintable && str.length > 0) {
          value = str;
        } else {
          try {
            const fallbackSub = decodeProtobuf(subBuf, maxDepth, depth + 1);
            if (Object.keys(fallbackSub).length > 0) {
              value = fallbackSub;
            } else {
              value = subBuf.toString('hex');
            }
          } catch (_) {
            value = subBuf.toString('hex');
          }
        }
      } catch (_) { break; }
    } else if (wireType === 5) { // 32-bit
      if (offset + 4 > buf.length) break;
      value = buf.readUInt32LE(offset);
      offset += 4;
    } else {
      break; // unsupported wire type
    }

    if (!result[fieldNumber]) {
      result[fieldNumber] = value;
    } else if (Array.isArray(result[fieldNumber])) {
      result[fieldNumber].push(value);
    } else {
      result[fieldNumber] = [result[fieldNumber], value];
    }
  }

  return result;
}

module.exports = {
  readVarint,
  decodeProtobuf
};
