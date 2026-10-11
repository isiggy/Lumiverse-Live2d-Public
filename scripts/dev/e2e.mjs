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
//   lumiverse.sh e2e --library    # then test the model library (thumbnails, sorting, filter,
//                                 # tiles and list), dropdown search, and settings file export/import
//   (--model and --slow are handled by lumiverse.sh)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(process.env.PW_DIR + '/')('playwright');
const BASE = process.env.LUMI_BASE;
const CHAT = `${BASE}/chat/${process.env.LUMI_CHAT_ID}`;
const OUT = process.env.LUMI_OUT;
const keepOpen = process.argv.includes('--keep-open');
const testLibrary = process.argv.includes('--library');
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

/** The trigger buttons of the Character model section's dropdowns: [character, model]. */
function bindingPickers() {
  return page.locator('.l2d-section:has(> .l2d-section-title:text-is("Character model")) .l2d-picker');
}

/** Choose `label` in a host dropdown, typing it into the search field when there is one. */
async function pick(picker, label, searchLabel) {
  await picker.locator('button').first().click();
  const search = page.locator(`input[aria-label="${searchLabel}"]`);
  if (await search.isVisible().catch(() => false)) await search.fill(label);
  await page.locator('[role="listbox"] [role="option"]', { hasText: label }).first().click();
}

/** Bind the model to the chat's character in the Character model section. */
async function bindModel(name) {
  const pickers = bindingPickers();
  if ((await pickers.count()) < 2) return 'no binding controls (is a chat open?)';
  const current = (await pickers.nth(1).innerText()).trim();
  if (current.split('\n')[0] === name) return `already bound: ${name}`;
  await pick(pickers.nth(1), name, 'Search models…');
  await page.waitForTimeout(500);
  return `bound ${name} to ${(await bindingPickers().nth(0).innerText()).trim().split('\n')[0]}`;
}

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) process.exitCode = 1;
}

/** Names of the models in the library, in the order shown (tiles or list). */
function libraryNames() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.l2d-tile-name, .l2d-model-name')].map((node) => node.textContent),
  );
}

async function setLibrarySort(label) {
  await page
    .locator('.l2d-section:has(> .l2d-section-title:text-is("Model library")) select')
    .selectOption({ label });
}

/** The value of a slider in Model settings, by its label. */
function sliderValue(label) {
  return page.evaluate((label) => {
    const slider = [...document.querySelectorAll('.l2d-slider')].find(
      (node) => node.querySelector('.l2d-slider-head span')?.textContent === label,
    );
    return slider ? Number(slider.querySelector('input').value) : null;
  }, label);
}

function setSlider(label, value) {
  return page.evaluate(
    ([label, value]) => {
      const slider = [...document.querySelectorAll('.l2d-slider')].find(
        (node) => node.querySelector('.l2d-slider-head span')?.textContent === label,
      );
      const input = slider.querySelector('input');
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [label, value],
  );
}

/** Import a settings file through the Character model section; returns the confirm dialog's text, if one opened. */
async function importSettingsFile(filePath, accept = true) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.click('button:has-text("Import settings")'),
  ]);
  await chooser.setFiles(filePath);
  // Lumiverse's confirm modal: the title, then the message, then the buttons.
  const title = page.locator('h3:has-text("Import model settings")');
  const opened = await title.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (!opened) return null;
  const text = await title.locator('xpath=..').innerText();
  await page.locator(`button:text-is("${accept ? 'Import' : 'Cancel'}")`).click();
  await page.waitForTimeout(1500);
  return text;
}

async function fileStatus() {
  return page.evaluate(() => {
    const exportButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Export settings');
    return exportButton?.parentElement?.querySelector('.l2d-dim')?.textContent ?? '';
  });
}

async function libraryTest() {
  console.log('Library, dropdown search and settings files:');
  await openLive2DTab();
  // The model on stage gets its thumbnail shortly after it first appears.
  const thumbnail = await page
    .waitForFunction(
      (name) =>
        [...document.querySelectorAll('.l2d-tile')].some(
          (tile) =>
            tile.querySelector('.l2d-tile-name')?.textContent === name &&
            tile.querySelector('img')?.src.startsWith('data:image/'),
        ),
      MODEL_NAME,
      { timeout: 15000 },
    )
    .then(() => true, () => false);
  check(thumbnail, `${MODEL_NAME} has a thumbnail in the tile view`);

  // Enough models for the dropdown to offer a search field.
  const extra = ['Aurora', 'Beryl', 'Cobalt', 'Dahlia', 'Ember', 'Fern'];
  const copies = path.join(OUT, 'library-copies');
  fs.mkdirSync(copies, { recursive: true });
  for (const name of extra) {
    if ((await libraryNames()).includes(name)) continue;
    const zip = path.join(copies, `${name}.zip`);
    fs.copyFileSync(process.env.LUMI_MODEL_ZIP, zip);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.click('button:has-text("Import model")'),
    ]);
    await chooser.setFiles(zip);
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.l2d-tile-name, .l2d-model-name')].some((n) => n.textContent === name),
      name,
      { timeout: 120000 },
    );
  }
  const librarySection = page.locator('.l2d-section:has(> .l2d-section-title:text-is("Model library"))');
  await librarySection.screenshot({ path: `${OUT}/library-tiles.png` });

  await setLibrarySort('Name (Z–A)');
  let names = await libraryNames();
  check(names[0] === [...names].sort((a, b) => b.localeCompare(a))[0], `Name (Z–A) puts ${names[0]} first`);
  await setLibrarySort('Oldest first');
  const oldest = await libraryNames();
  await setLibrarySort('Newest first');
  names = await libraryNames();
  check(
    names.join() === [...oldest].reverse().join() && names.indexOf('Fern') < names.indexOf('Aurora'),
    `Newest first is Oldest first reversed, Fern before Aurora (${names.join(', ')})`,
  );
  await setLibrarySort('Largest first');
  await setLibrarySort('Name (A–Z)');
  names = await libraryNames();
  check(names[0] === 'Aurora', `Name (A–Z) puts ${names[0]} first`);

  await page.fill('.l2d-library-filter', 'er');
  names = await libraryNames();
  check(names.join() === 'Beryl,Ember,Fern', `filter "er" shows ${names.join(', ')}`);
  await librarySection.screenshot({ path: `${OUT}/library-filter.png` });
  await page.fill('.l2d-library-filter', '');

  const tileCount = await page.locator('.l2d-tile').count();
  await page.click('.l2d-segmented button:text-is("List")');
  const listRows = await page.locator('.l2d-list-thumb').count();
  check(
    listRows === tileCount && (await page.locator('.l2d-tile').count()) === 0,
    `list view shows ${listRows} rows for ${tileCount} tiles`,
  );
  await librarySection.screenshot({ path: `${OUT}/library-list.png` });
  await page.click('.l2d-segmented button:text-is("Tiles")');

  // Search in the model dropdown.
  const modelPicker = bindingPickers().nth(1);
  await modelPicker.scrollIntoViewIfNeeded();
  await modelPicker.locator('button').first().click();
  const search = page.locator('input[aria-label="Search models…"]');
  check(await search.isVisible().catch(() => false), 'model dropdown has a search field');
  await search.fill('cob');
  const options = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).filter(
    (option) => option.trim() !== 'No model',
  );
  check(options.length === 1 && options[0].includes('Cobalt'), `searching "cob" leaves ${options.map((o) => o.replace(/\s+/g, ' ').trim()).join(', ')}`);
  await page.screenshot({ path: `${OUT}/model-search.png` });
  await page.keyboard.press('Escape');

  // Export this character's settings, change them, and import the file back.
  await page.waitForSelector('.l2d-slider', { timeout: 60000 });
  await setSlider('Scale', 0.8);
  await setSlider('Rotation (°)', 15);
  await page.waitForTimeout(800);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('button:has-text("Export settings")'),
  ]);
  const exported = path.join(OUT, download.suggestedFilename());
  await download.saveAs(exported);
  const file = JSON.parse(fs.readFileSync(exported, 'utf8'));
  check(
    file.format === 'lumiverse-avatar-model-settings' &&
      file.extension === 'live2d' &&
      file.model.name === MODEL_NAME &&
      file.settings.scale === 0.8 &&
      file.settings.rotation === 15,
    `exported ${download.suggestedFilename()} (scale ${file.settings?.scale}, rotation ${file.settings?.rotation})`,
  );

  await setSlider('Scale', 1.3);
  await setSlider('Rotation (°)', 0);
  const dialog = await importSettingsFile(exported);
  check(dialog?.includes(MODEL_NAME), 'import asks before replacing the settings');
  check((await sliderValue('Scale')) === 0.8 && (await sliderValue('Rotation (°)')) === 15, 'import restored scale 0.8 and rotation 15');
  check((await fileStatus()).startsWith('Imported'), `status: ${await fileStatus()}`);

  // A file for a model that isn't in the library applies to the bound model after a warning.
  const missing = path.join(OUT, 'missing-model.live2d-settings.json');
  fs.writeFileSync(
    missing,
    JSON.stringify({ ...file, model: { id: 'not_here', name: 'Not Here' }, settings: { ...file.settings, scale: 0.5, eye: 'bad' } }),
  );
  const warning = await importSettingsFile(missing);
  check(warning?.includes("isn't in your library"), 'a file for a missing model warns before applying');
  await page.screenshot({ path: `${OUT}/import-applied.png` });
  check((await sliderValue('Scale')) === 0.5 && (await sliderValue('Eye follow offset')) === 45, 'it applied scale 0.5 and ignored the bad eye value');

  // A Spine settings file is refused with a message.
  const spine = path.join(OUT, 'spine.json');
  fs.writeFileSync(spine, JSON.stringify({ ...file, extension: 'spine' }));
  check((await importSettingsFile(spine)) === null, 'a Spine file opens no dialog');
  await page.waitForTimeout(500);
  check((await fileStatus()).includes('Spine Avatars extension'), `status: ${await fileStatus()}`);

  // Sort and view persist.
  await setLibrarySort('Largest first');
  await page.click('.l2d-segmented button:text-is("List")');
  await page.waitForTimeout(1000);
  await page.goto(CHAT);
  await page.waitForTimeout(5000);
  await openLive2DTab();
  const kept = await page.evaluate(() => ({
    sort: document.querySelector('.l2d-library-filter')?.parentElement?.querySelector('select')?.value,
    list: document.querySelectorAll('.l2d-list-thumb').length,
  }));
  check(kept.sort === 'largest' && kept.list > 0, `sort and view kept after a reload (${JSON.stringify(kept)})`);
  await page.click('.l2d-segmented button:text-is("Tiles")');
  await setLibrarySort('Name (A–Z)');
  await setSlider('Scale', 1);
  await setSlider('Rotation (°)', 0);
  await page.waitForTimeout(1000);
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
    [...document.querySelectorAll('.l2d-model-name, .l2d-tile-name')].some((node) => node.textContent === name);
  if (!(await page.evaluate(inLibrary, MODEL_NAME))) {
    console.log(`Importing ${MODEL_NAME}…`);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.click('button:has-text("Import model")'),
    ]);
    await chooser.setFiles(process.env.LUMI_MODEL_ZIP);
    await page.waitForFunction(inLibrary, MODEL_NAME, { timeout: 300000 });
  }

  const binding = await bindModel(MODEL_NAME);
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
  if (testLibrary && stage) await libraryTest();
} finally {
  await browser.close();
}
