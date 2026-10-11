// Checks the whole recording path on a harmless action: the real pointer moves to Models, clicks,
// then to Workflow, while screencapture records the window. Writes public/captures/pointer-test.*.
import { launchApp } from "./app.mjs";
import { startShot } from "./recorder.mjs";

const { app, page } = await launchApp({ profile: "pointer-test", theme: "light", fontScale: 115 });
try {
  const shot = await startShot({ app, page, shotId: "pointer-test" });
  await shot.park(0.55, 0.45);
  await shot.click(page.getByRole("button", { name: "Models", exact: true }).first(), "open Models");
  await shot.pause(1500);
  await shot.click(page.getByRole("button", { name: "Workflow", exact: true }).first(), "open Workflow");
  await shot.pause(1500);
  console.log(JSON.stringify(await shot.stop()));
} finally {
  await app.close();
}
