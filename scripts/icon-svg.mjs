/**
 * Emits the OpenDIAlyzer icon artwork on stdout.
 *
 * Not the OpenMS logo cropped. That mark is roughly 4:1 because its peaks are
 * woven through a wordmark, so on a square plate it reads as a thin band — and
 * lifting it wholesale would claim to *be* OpenMS rather than to belong to it.
 *
 * Instead, overlapping ion traces use the OpenMS palette to connect the app's
 * chromatogram analysis with the project it belongs to. The two-line wordmark
 * keeps the product name readable without turning the icon into a wide strip.
 *
 * The wordmark is legible from about 128 px up, which covers Finder, the About
 * panel and a large dock. Below that the traces carry the identity on their
 * own, so their strokes stay substantial and their peaks remain distinct.
 */

const W = 1000;
const H = 1040;
const FONT = 190;
const OPEN_X = 90;
// Rendered 190 px glyph probes put p's centre at 186.5 and I's at 137.0.
// Final-plate rasterisation moved I's ink 7 px right, so compensate by 7.5
// source pixels after the probe-derived alignment.
const DIALYZER_X = OPEN_X + 186.5 - 137 - 7.5;
const OPEN_Y = 760;
// A 122 px baseline gap puts 50 px of the p descender inside I's 136 px cap.
const DIALYZER_Y = OPEN_Y + 122;
const FAMILY = "Helvetica Neue, Helvetica, Arial, sans-serif";

// Each cubic curve is a smooth ion trace with its own retention time and width.
// Separate OpenMS stop colours preserve the logo's warm-to-cool sweep.
const TRACES = [
  ["#ffb401", "M84 554 C205 554 222 530 270 349 C305 216 349 216 383 349 C430 530 453 554 916 554"],
  ["#ff7901", "M84 554 C235 554 272 520 326 273 C360 116 414 116 448 273 C500 517 548 554 916 554"],
  ["#ff03cb", "M84 554 C280 554 337 526 395 319 C435 174 491 174 530 319 C588 526 627 554 916 554"],
  ["#b503ff", "M84 554 C346 554 416 530 474 368 C516 250 573 250 616 368 C674 530 719 554 916 554"],
  ["#3157e9", "M84 554 C410 554 495 535 553 410 C596 316 655 316 697 410 C753 532 791 554 916 554"],
];

const traces = TRACES.map(([color, path]) =>
  `<path d="${path}" stroke="${color}"/>`
).join("\n    ");

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="gt" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff4bd8"/>
      <stop offset="1" stop-color="#c64dff"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
    ${traces}
  </g>
  <text x="${OPEN_X}" y="${OPEN_Y}"
        font-family="${FAMILY}" font-size="${FONT}" font-weight="600"
        letter-spacing="-5" fill="#fff">Open</text>
  <text x="${DIALYZER_X}" y="${DIALYZER_Y}"
        font-family="${FAMILY}" font-size="${FONT}" font-weight="600"
        letter-spacing="-5" fill="url(#gt)">DIAlyzer</text>
</svg>
`);
