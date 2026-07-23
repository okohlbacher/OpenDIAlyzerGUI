/**
 * Emits the OpenDIAlyzer icon artwork on stdout.
 *
 * Not the OpenMS logo cropped. That mark is roughly 4:1 because its peaks are
 * woven through a wordmark, so on a square plate it reads as a thin band — and
 * lifting it wholesale would claim to *be* OpenMS rather than to belong to it.
 *
 * So: a spectrum drawn in the OpenMS idiom — peak sticks under the logo's own
 * gradient, with the stick heights of a real fragment spectrum — over the
 * product wordmark. `DIA` is picked out in the gradient because it is the
 * meaningful middle of the name, and it echoes how the OpenMS mark colours its
 * peaks against a dark wordmark.
 *
 * The wordmark is legible from about 128 px up, which covers Finder, the About
 * panel and a large dock. Below that the spectrum carries the identity on its
 * own — which is why the sticks stay chunky rather than fine.
 */

/** The OpenMS logo gradient, left to right. */
const STOPS = [
  [0.0, "#ffb401"], [0.05, "#ff9701"], [0.11, "#ff8401"], [0.16, "#ff7901"],
  [0.22, "#ff7501"], [0.54, "#ff03cb"], [0.77, "#b503ff"], [0.91, "#3157e9"],
];

// A regular sawtooth reads as a bar chart; this reads as a spectrum.
const HEIGHTS = [0.30, 0.52, 0.22, 0.71, 0.34, 1.0, 0.44, 0.83, 0.26, 0.58, 0.19, 0.38];

const W = 1000;
const TOP = 120;        // ceiling for a full-height peak
const BASE = 640;       // spectrum baseline
const STICK = 46;
const GAP = 34;
const TEXT_Y = 810;     // wordmark baseline
const FONT = 138;

const span = HEIGHTS.length * STICK + (HEIGHTS.length - 1) * GAP;
const x0 = (W - span) / 2;

const sticks = HEIGHTS.map((h, i) => {
  const x = x0 + i * (STICK + GAP);
  const top = BASE - h * (BASE - TOP);
  return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${STICK}" ` +
    `height="${(BASE - top).toFixed(1)}" rx="${STICK / 2}"/>`;
}).join("\n    ");

const FAMILY = "Helvetica Neue, Helvetica, Arial, sans-serif";

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="900" viewBox="0 60 ${W} 840">
  <defs>
    <linearGradient id="g" x1="${x0}" y1="0" x2="${x0 + span}" y2="0" gradientUnits="userSpaceOnUse">
      ${STOPS.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("\n      ")}
    </linearGradient>
    <linearGradient id="gt" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff03cb"/>
      <stop offset="1" stop-color="#b503ff"/>
    </linearGradient>
  </defs>
  <g fill="url(#g)">
    ${sticks}
  </g>
  <text x="${W / 2}" y="${TEXT_Y}" text-anchor="middle"
        font-family="${FAMILY}" font-size="${FONT}" font-weight="600"
        letter-spacing="-4" fill="#f2efec">Open<tspan fill="url(#gt)">DIA</tspan>lyzer</text>
</svg>
`);
