// One screenshot of a screen of the app, for style frames and posters.
//   node scripts/capture/still.mjs --profile style --theme light --font-scale 115 --route "#/chat" --out public/stills/x.png
import path from "node:path";
import { parseArgs } from "node:util";
import { launchApp, project } from "./app.mjs";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "style" },
    theme: { type: "string", default: "dark" },
    "font-scale": { type: "string", default: "100" },
    route: { type: "string", default: "#/chat" },
    out: { type: "string" },
  },
});
const { app, page } = await launchApp({ profile: values.profile, theme: values.theme, fontScale: Number(values["font-scale"]) });
try {
  await page.evaluate(route => { location.hash = route; }, values.route);
  await page.waitForTimeout(1500);
  const out = path.resolve(project, values.out ?? `out/stills/${values.theme}.png`);
  await page.screenshot({ path: out });
  console.log(path.relative(project, out));
} finally {
  await app.close();
}
