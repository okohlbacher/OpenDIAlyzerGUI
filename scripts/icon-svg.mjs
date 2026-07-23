/**
 * Emits the OpenDIAlyzer icon artwork on stdout.
 *
 * Not the OpenMS logo cropped. That mark is roughly 4:1 because its peaks are
 * woven through a wordmark, so on a square plate it reads as a thin band and
 * disappears at 16 px — and lifting it wholesale would claim to *be* OpenMS
 * rather than to belong to it.
 *
 * So: a spectrum drawn in the OpenMS idiom. Peak sticks under the logo's own
 * gradient, with the stick heights of a real fragment spectrum — one dominant
 * ion, a few strong, a tail of small ones — proportioned for a square. Same
 * visual language, its own mark.
 */

/** The OpenMS logo gradient, left to right. */
const STOPS = [
  [0.0, "#ffb401"], [0.05, "#ff9701"], [0.11, "#ff8401"], [0.16, "#ff7901"],
  [0.22, "#ff7501"], [0.54, "#ff03cb"], [0.77, "#b503ff"], [0.91, "#3157e9"],
];

// A regular sawtooth reads as a bar chart; this reads as a spectrum.
const HEIGHTS = [0.30, 0.52, 0.22, 0.71, 0.34, 1.0, 0.44, 0.83, 0.26, 0.58, 0.19, 0.38];

const W = 1000;
const BASE = 820;   // baseline
const TOP = 200;    // ceiling for a full-height peak
const STICK = 46;
const GAP = 34;

const span = HEIGHTS.length * STICK + (HEIGHTS.length - 1) * GAP;
const x0 = (W - span) / 2;

const sticks = HEIGHTS.map((h, i) => {
  const x = x0 + i * (STICK + GAP);
  const top = BASE - h * (BASE - TOP);
  return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${STICK}" ` +
    `height="${(BASE - top).toFixed(1)}" rx="${STICK / 2}"/>`;
}).join("\n    ");

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BASE - TOP + 40}" viewBox="0 ${TOP - 20} ${W} ${BASE - TOP + 40}">
  <defs>
    <linearGradient id="g" x1="${x0}" y1="0" x2="${x0 + span}" y2="0" gradientUnits="userSpaceOnUse">
      ${STOPS.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("\n      ")}
    </linearGradient>
  </defs>
  <g fill="url(#g)">
    ${sticks}
  </g>
</svg>
`);
