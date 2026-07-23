// The OpenMS mark is one <symbol> the whole page reuses via <use>.
import { readFileSync, writeFileSync } from "node:fs";
const sym = readFileSync("app/logo.svg.html", "utf8").trim();
const p = "app/index.html";
let s = readFileSync(p, "utf8");
if (s.includes("<!--LOGO_SYMBOL-->")) {
  writeFileSync(p, s.replace("<!--LOGO_SYMBOL-->", sym));
  console.log("logo symbol injected");
} else if (!s.includes('id="oms-logo"')) {
  throw new Error("index.html has neither the placeholder nor the symbol");
}
