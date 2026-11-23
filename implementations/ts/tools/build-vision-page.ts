import { readFileSync, writeFileSync } from "node:fs";
import { renderVisionPage } from "../demo/site/vision-page.js";

const source = new URL("../../../VISION.md", import.meta.url);
const target = new URL("../../../docs/index.html", import.meta.url);
writeFileSync(target, renderVisionPage(readFileSync(source, "utf8")));
