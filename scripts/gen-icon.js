'use strict';
// Regenerates the app icons by rasterizing the anchor mark to PNGs at the sizes iOS/Android/browsers
// actually use. Run: node scripts/gen-icon.js  (needs the dev dep @resvg/resvg-js)
//
// Why PNGs and not just the SVG: iOS Safari IGNORES SVG favicons and manifest icons — the home-screen
// tile and the Safari tab need real PNGs, and the apple-touch-icon must be FULL-BLEED (iOS rounds the
// corners itself; transparent corners render badly). So this icon has a solid teal square background.

const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'server', 'public');

// Full-bleed anchor (no rounded corners — iOS masks them). White anchor on harbor teal.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0e8f8f"/>
  <g fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="15" r="4"/>
    <line x1="32" y1="19" x2="32" y2="50"/>
    <line x1="23" y1="27" x2="41" y2="27"/>
    <path d="M16 34c0 10 7 16 16 16s16-6 16-16"/>
    <line x1="16" y1="34" x2="12" y2="38"/>
    <line x1="16" y1="34" x2="20" y2="38"/>
    <line x1="48" y1="34" x2="44" y2="38"/>
    <line x1="48" y1="34" x2="52" y2="38"/>
  </g>
</svg>`;

const SIZES = {
  'apple-touch-icon.png': 180, // iOS home screen
  'favicon-32.png': 32, // browser tab (incl. iOS Safari, which ignores the SVG)
  'icon-192.png': 192, // web manifest (Android / PWA)
  'icon-512.png': 512, // web manifest / splash
};

for (const [name, size] of Object.entries(SIZES)) {
  const png = new Resvg(ICON_SVG, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote ${name} (${size}px, ${png.length} bytes)`);
}
