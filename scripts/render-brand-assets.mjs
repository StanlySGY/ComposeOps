// One vector source for the app, browser tab and installed app icons.
// Run from the repository root; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is optional.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const svg = await readFile(new URL('../frontend/src/assets/brand-mark.svg', import.meta.url), 'utf8');
const publicDir = new URL('../frontend/public/', import.meta.url);
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
try {
  await writeFile(new URL('favicon.svg', publicDir), svg);
  for (const [filename, size, inset] of [['pwa-icon-192.png', 192, 0], ['pwa-icon-512.png', 512, 0], ['apple-touch-icon.png', 180, 0], ['pwa-icon-maskable-512.png', 512, 64]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#141c25}body{box-sizing:border-box;padding:${inset}px}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: new URL(filename, publicDir).pathname });
    await page.close();
  }
} finally { await browser.close(); }
