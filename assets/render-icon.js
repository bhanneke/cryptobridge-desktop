/* Renders assets/icon.svg to a 1024×1024 transparent PNG for `tauri icon`.
   Uses the system Chrome via playwright-core — no browser download. */
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svg = await readFile(join(here, 'icon.svg'), 'utf8');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: 1024, height: 1024 },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
);
await page.locator('svg').screenshot({
  path: join(here, 'app-icon.png'),
  omitBackground: true,
});
await browser.close();
console.log('wrote assets/app-icon.png');
