import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

// Renders each page in docs/diagrams/src/ to a PNG in docs/diagrams/, at twice its size, with the Chrome on this machine.
// The pages are served from the repository under a made-up origin, so they can load the site's fonts.
const root = join(import.meta.dirname, "..");
const origin = "http://diagrams.local";
const only = process.argv.slice(2);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await page.route(`${origin}/**`, (route) =>
    route.fulfill({ path: join(root, decodeURIComponent(new URL(route.request().url()).pathname)) }),
);
for (const file of readdirSync(join(root, "docs/diagrams/src"))) {
    const name = file.replace(/\.html$/, "");
    if (name === file || (only.length > 0 && !only.includes(name))) continue;
    await page.goto(`${origin}/docs/diagrams/src/${file}`);
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await page.locator("main").screenshot({ path: join(root, "docs/diagrams", `${name}.png`) });
    console.log(`docs/diagrams/${name}.png`);
}
await browser.close();
