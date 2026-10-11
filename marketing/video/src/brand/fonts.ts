// Geist and Geist Mono, the landing page's own variable font files (SIL OFL, public/fonts/OFL.txt).
// loadFont() holds rendering until each file is ready.
import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

loadFont({ family: "Geist", url: staticFile("fonts/Geist-Variable.woff2"), weight: "100 900" });
loadFont({ family: "Geist Mono", url: staticFile("fonts/GeistMono-Variable.woff2"), weight: "100 900" });
