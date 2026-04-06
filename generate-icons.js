// Generate PWA icons as SVG-based PNGs
// Run once: node generate-icons.js

const fs = require("fs");

// Create SVG icon
function createIconSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="#0f0f11"/>
  <text x="${size/2}" y="${size * 0.65}" font-size="${size * 0.5}" text-anchor="middle" fill="#c9a84c">⚓</text>
</svg>`;
}

// For now, just create placeholder files that the server can serve
// The actual icons will be SVGs served as-is
fs.writeFileSync("icon-192.svg", createIconSVG(192));
fs.writeFileSync("icon-512.svg", createIconSVG(512));
console.log("Icons generated (SVG). Convert to PNG for full PWA support.");
