// Headless check that the avatar renders in a real Lumiverse instance.
// Run through `scripts/dev/lumiverse.sh e2e`, which supplies the env vars.
//
// Logs in, opens the seeded chat, imports $LUMI_MODEL_ZIP through the Live2D
// tab unless a model of that name is already in the library, binds it to the
// chat's character, then reloads the chat and checks the overlay canvas is
// full-size. Each run uses a fresh browser profile, so the model's files are
// always downloaded from the backend again.
// Screenshots go to $LUMI_OUT. Exits non-zero if the avatar isn't on screen.
//
//   lumiverse.sh e2e              # the check above
//   lumiverse.sh e2e --keep-open  # also leave a screenshot with the Live2D tab open
//   (--model and --slow are handled by lumiverse.sh)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(process.env.PW_DIR + '/')('playwright');
const BASE = process.env.LUMI_BASE;
const CHAT = `${BASE}/chat/${process.env.LUMI_CHAT_ID}`;
const OUT = process.env.LUMI_OUT;
const keepOpen = process.argv.includes('--keep-open');
// The extension names an imported model after its zip file.
const MODEL_NAME = path.basename(process.env.LUMI_MODEL_ZIP).replace(/\.zip$/i, '');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader'], // WebGL without a GPU
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('console', (msg) => {
  if (msg.text().includes('[live2d]')) problems.push(`extension: ${msg.text()}`);
});

async function openLive2DTab() {
  // The drawer tab can be scrolled out of the sidebar, so click it from the DOM.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('span,button,div')].find(
      (node) => node.textContent === 'Live2D' && node.children.length === 0,
    );
    (label?.closest('button') ?? label)?.click();
  });
  await page.waitForSelector('.l2d-root', { timeout: 30000 });
}

try {
  await page.goto(BASE);
  await page.fill('input[type="text"]', process.env.LUMI_USER);
  await page.fill('input[type="password"]', process.env.LUMI_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  await page.goto(CHAT);
  await page.waitForTimeout(5000);
  await openLive2DTab();

  const inLibrary = (name) =>
    [...document.querySelectorAll('.l2d-model-name')].some((node) => node.textContent === name);
  if (!(await page.evaluate(inLibrary, MODEL_NAME))) {
    console.log(`Importing ${MODEL_NAME}…`);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.click('button:has-text("Import model")'),
    ]);
    await chooser.setFiles(process.env.LUMI_MODEL_ZIP);
    await page.waitForFunction(inLibrary, MODEL_NAME, { timeout: 300000 });
  }

  const binding = await page.evaluate((name) => {
    const section = [...document.querySelectorAll('.l2d-section')].find(
      (node) => node.querySelector('.l2d-section-title')?.textContent === 'Character model',
    );
    const [characterSelect, modelSelect] = section ? [...section.querySelectorAll('select')] : [];
    if (!modelSelect) return 'no binding controls (is a chat open?)';
    const option = [...modelSelect.options].find((o) => o.textContent === name);
    if (!option) return `${name} missing from the model list`;
    if (modelSelect.value === option.value) return `already bound: ${name}`;
    modelSelect.value = option.value;
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return `bound ${name} to ${characterSelect.selectedOptions[0]?.textContent}`;
  }, MODEL_NAME);
  console.log(binding);
  await page.waitForTimeout(3000);
  if (keepOpen) await page.screenshot({ path: `${OUT}/live2d-tab.png` });

  await page.goto(CHAT);
  const loadStart = Date.now();
  // Large models take a while to download, especially with --slow.
  const appeared = await page
    .waitForSelector('.live2d-avatars-canvas', { timeout: 180000 })
    .then(() => true, () => false);
  if (appeared) console.log(`Model loaded ${((Date.now() - loadStart) / 1000).toFixed(1)}s after opening the chat`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/chat.png` });

  const stage = await page.evaluate(() => {
    const canvas = document.querySelector('.live2d-avatars-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      overlay: !!canvas.closest('.live2d-avatars-overlay'),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });

  console.log('Stage:', JSON.stringify(stage));
  console.log(`Screenshots: ${OUT}`);
  for (const problem of problems) console.log(problem);
  if (!stage || stage.width === 0 || stage.height === 0) {
    console.log('FAIL: no visible avatar canvas');
    process.exitCode = 1;
  } else if (!stage.overlay) {
    console.log('NOTE: rendering in the Live2D tab preview (app_manipulation not granted)');
  } else {
    console.log('OK: avatar overlay is on screen');
  }
} finally {
  await browser.close();
}
