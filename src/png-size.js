const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LONG_EDGE = 2576;

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a valid PNG file (bad signature or too short to hold an IHDR chunk)');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function assertImageSize({ width, height }) {
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_LONG_EDGE) {
    throw new Error(
      `Image long edge ${longEdge}px exceeds ${MAX_LONG_EDGE}px — the vision API would silently ` +
      'resize it and desync the model\'s returned coordinates from the real image. Downscale first.'
    );
  }
}

module.exports = { readPngSize, assertImageSize, MAX_LONG_EDGE };
