// Generate a minimal 180x180 PNG icon for iOS
// Uses raw PNG encoding (no dependencies)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function createPNG(size, bgR, bgG, bgB, fgR, fgG, fgB) {
  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - center;
      const dy = y - center;

      // Background (rounded corners handled by iOS)
      pixels[idx] = bgR;
      pixels[idx + 1] = bgG;
      pixels[idx + 2] = bgB;
      pixels[idx + 3] = 255;

      // Draw anchor shape
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Ring at top (circle)
      const ringCenterY = center - size * 0.22;
      const ringDist = Math.sqrt(dx * dx + (y - ringCenterY) * (y - ringCenterY));
      if (ringDist > size * 0.06 && ringDist < size * 0.10) {
        pixels[idx] = fgR; pixels[idx + 1] = fgG; pixels[idx + 2] = fgB;
      }

      // Vertical line (shaft)
      if (Math.abs(dx) < size * 0.025 && y > ringCenterY + size * 0.08 && y < center + size * 0.32) {
        pixels[idx] = fgR; pixels[idx + 1] = fgG; pixels[idx + 2] = fgB;
      }

      // Horizontal bar (crossbar)
      if (Math.abs(y - (center - size * 0.05)) < size * 0.025 && Math.abs(dx) < size * 0.12) {
        pixels[idx] = fgR; pixels[idx + 1] = fgG; pixels[idx + 2] = fgB;
      }

      // Curved bottom (flukes)
      const flukeY = center + size * 0.15;
      const flukeDx = Math.abs(dx);
      if (flukeDx > size * 0.05 && flukeDx < size * 0.22) {
        const curveTarget = flukeY + (1 - (flukeDx - size * 0.05) / (size * 0.17)) * size * 0.17;
        if (Math.abs(y - curveTarget) < size * 0.025) {
          pixels[idx] = fgR; pixels[idx + 1] = fgG; pixels[idx + 2] = fgB;
        }
      }
    }
  }

  // Encode as PNG
  // Add filter byte (0 = None) before each row
  const rawData = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rawData[y * (size * 4 + 1)] = 0; // filter: None
    pixels.copy(rawData, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  // Build PNG
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  chunks.push(createChunk("IHDR", ihdr));

  // IDAT
  chunks.push(createChunk("IDAT", compressed));

  // IEND
  chunks.push(createChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeBuffer, data, crc]);
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Anchor Tasks: dark bg (#0f0f11), gold anchor (#c9a84c)
const tasksPNG = createPNG(180, 15, 15, 17, 201, 168, 76);
fs.writeFileSync(path.join(__dirname, "icon-180.png"), tasksPNG);
console.log("Tasks icon: icon-180.png (" + tasksPNG.length + " bytes)");

// Also create for Anchor Command: darker bg (#050a12), gold (#c9a227)
const commandPNG = createPNG(180, 5, 10, 18, 201, 162, 39);
fs.writeFileSync(path.join(__dirname, "..", "anchor-mortgage-app", "icon-180.png"), commandPNG);
console.log("Command icon: icon-180.png (" + commandPNG.length + " bytes)");
