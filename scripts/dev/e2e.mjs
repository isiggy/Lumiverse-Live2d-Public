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
//   lumiverse.sh e2e --group      # a four-member group chat instead: every member's model is drawn
//                                 # in its own column, a drag moves only one model, and removing a
//                                 # member re-lays the stage out. With --spine-model, every other
//                                 # member gets a Spine model (Spine Avatars must be deployed too)
//                                 # and both extensions share the columns and the stacking order
//                                 # (Send to front / Send to back, which model gets the pointer)
//   lumiverse.sh e2e --group --stack --spine-model …  # only the stacking checks of a mixed group
//   lumiverse.sh e2e --hit-areas  # then draw a hit area on the model's face in Model settings, and
//                                 # check taps on it play its motion (upright, rotated, after a reload)
//                                 # while taps elsewhere fall back to On click
//   lumiverse.sh e2e --hit-areas --background  # then also, with the model as the chat background:
//                                 # taps through the empty chat reach the model, while a drag, a long
//                                 # press, a message and the input don't; and an emotion set to a tap
//                                 # plays that tap's motion
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
const group = process.argv.includes('--group');
const stackOnly = process.argv.includes('--stack');
const testHitAreas = process.argv.includes('--hit-areas');
const testBackground = process.argv.includes('--background');
// How long a model may take to appear: big models under swiftshader can take many minutes.
const LOAD_TIMEOUT = Number(process.env.LUMI_LOAD_TIMEOUT_MS) || 180000;
const lines = (value) => (value || '').split('\n').filter(Boolean);
const MODEL_ZIPS = lines(process.env.LUMI_MODEL_ZIPS || process.env.LUMI_MODEL_ZIP);
const SPINE_ZIPS = lines(process.env.LUMI_SPINE_ZIPS);
const GROUP_CHAT_ID = process.env.LUMI_GROUP_CHAT_ID;
const GROUP_MEMBERS = lines(process.env.LUMI_GROUP_MEMBERS);
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
  if (msg.text().includes('[live2d]') || msg.text().includes('[spine]')) problems.push(`extension: ${msg.text()}`);
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

// ── Group chats ─────────────────────────────────────────────────────────────

const modelName = (zip) => path.basename(zip).replace(/\.zip$/i, '');

/** One of the avatar extensions' settings tabs, by the prefix of its class names. */
const EXTENSIONS = {
  live2d: { tab: 'Live2D', prefix: 'l2d', canvas: '.live2d-avatars-canvas' },
  spine: { tab: 'Spine', prefix: 'spn', canvas: '.spine-avatars-canvas' },
};

async function openTab(ext) {
  await page.evaluate((label) => {
    const node = [...document.querySelectorAll('span,button,div')].find(
      (candidate) => candidate.textContent === label && candidate.children.length === 0,
    );
    (node?.closest('button') ?? node)?.click();
  }, ext.tab);
  await page.waitForFunction((root) => document.querySelector(root)?.getBoundingClientRect().width > 0, `.${ext.prefix}-root`, {
    timeout: 30000,
  });
}

/** An option's label: its first line that isn't a one-letter initial. */
function optionLabel(text) {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 1) ?? '';
}

function pickersOf(ext) {
  return page.locator(
    `.${ext.prefix}-section:has(> .${ext.prefix}-section-title:text-is("Character model")) .${ext.prefix}-picker`,
  );
}

/** Choose the option whose label is one of `labels`, searching first when the dropdown has a search field. */
async function pickOption(picker, labels, searchLabel) {
  await picker.locator('button').first().click();
  await page.waitForSelector('[role="listbox"]');
  const search = page.locator(`input[aria-label="${searchLabel}"]`);
  if (await search.isVisible().catch(() => false)) await search.fill(labels[0]);
  const options = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).map(optionLabel);
  const index = options.findIndex((option) => labels.includes(option));
  if (index === -1) {
    await page.keyboard.press('Escape');
    throw new Error(`${labels[0]} missing from the dropdown (${options.join(', ')})`);
  }
  await page.locator('[role="listbox"] [role="option"]').nth(index).click();
  await page.waitForTimeout(400);
}

async function characterName(characterId) {
  return page.evaluate(
    (id) => fetch(`/api/v1/characters/${id}`).then((response) => response.json()).then((c) => c.name),
    characterId,
  );
}

async function selectCharacterIn(ext, characterId) {
  const name = await characterName(characterId);
  const labels = [name, `${name} (in this chat)`];
  const picker = pickersOf(ext).nth(0);
  if (!labels.includes(optionLabel(await picker.innerText()))) await pickOption(picker, labels, 'Search characters…');
  return optionLabel(await pickersOf(ext).nth(0).innerText());
}

/** Bind `name` (or no model, for null) to the selected character. */
async function bindIn(ext, name) {
  const picker = pickersOf(ext).nth(1);
  const label = name ?? 'No model';
  if (optionLabel(await picker.innerText()) !== label) await pickOption(picker, [label], 'Search models…');
}

async function importInto(ext, zip) {
  const name = modelName(zip);
  const inLibrary = ({ prefix, name }) =>
    [...document.querySelectorAll(`.${prefix}-model-name, .${prefix}-tile-name`)].some((node) => node.textContent === name);
  if (await page.evaluate(inLibrary, { prefix: ext.prefix, name })) return;
  console.log(`Importing ${name} into ${ext.tab}…`);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.click(`.${ext.prefix}-root button:has-text("Import model")`),
  ]);
  await chooser.setFiles(zip);
  await page.waitForFunction(inLibrary, { prefix: ext.prefix, name }, { timeout: 300000 });
}

async function clickIn(ext, text) {
  // Model settings show once the model's files are downloaded, which takes a while for big models.
  await page.waitForSelector(`.${ext.prefix}-root button:text-is("${text}")`, { timeout: 600000 });
  await page.click(`.${ext.prefix}-root button:text-is("${text}")`);
  await page.waitForTimeout(400);
}

/** Per column of an extension's canvases (Live2D has one per model): the share of pixels drawn and the drawn box. */
async function columnInfo(ext, columns) {
  return page.evaluate(
    ({ selector, columns }) =>
      new Promise((resolve) => {
        const canvases = [...document.querySelectorAll(selector)];
        if (canvases.length === 0) return resolve(null);
        const rect = canvases[0].getBoundingClientRect();
        const scale = 0.25;
        const probe = document.createElement('canvas');
        probe.width = Math.max(1, Math.round(rect.width * scale));
        probe.height = Math.max(1, Math.round(rect.height * scale));
        const context = probe.getContext('2d', { willReadFrequently: true });
        requestAnimationFrame(() => {
          for (const canvas of canvases) context.drawImage(canvas, 0, 0, probe.width, probe.height);
          const data = context.getImageData(0, 0, probe.width, probe.height).data;
          const columnWidth = probe.width / columns;
          const result = [];
          for (let column = 0; column < columns; column++) {
            const x0 = Math.round(column * columnWidth);
            const x1 = Math.round((column + 1) * columnWidth);
            let drawn = 0;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let y = 0; y < probe.height; y++) {
              for (let x = x0; x < x1; x++) {
                if (data[(y * probe.width + x) * 4 + 3] > 16) {
                  drawn++;
                  minX = Math.min(minX, x);
                  maxX = Math.max(maxX, x);
                  minY = Math.min(minY, y);
                  maxY = Math.max(maxY, y);
                }
              }
            }
            result.push({
              drawn: +(drawn / ((x1 - x0) * probe.height)).toFixed(3),
              box: drawn
                ? {
                    x: Math.round(minX / scale),
                    y: Math.round(minY / scale),
                    width: Math.round((maxX - minX + 1) / scale),
                    height: Math.round((maxY - minY + 1) / scale),
                  }
                : null,
            });
          }
          resolve({ width: Math.round(rect.width), columns: result });
        });
      }),
    { selector: ext.canvas, columns },
  );
}

const center = (box) => (box ? box.x + box.width / 2 : NaN);

/** Wait until every member's model is drawn somewhere in its column (big models take a while to arrive). */
async function waitForModels(owners) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const used = [...new Set(owners)];
    const infos = Object.fromEntries(
      await Promise.all(used.map(async (key) => [key, await columnInfo(EXTENSIONS[key], owners.length)])),
    );
    if (owners.every((owner, index) => (infos[owner]?.columns[index]?.drawn ?? 0) > 0.01)) return;
    await page.waitForTimeout(3000);
  }
  console.log('Some models still missing after 10 minutes');
}

/**
 * Check that each member's model is drawn in its own column on the canvas of
 * the extension it belongs to, and nothing of it spills into the others' columns.
 */
async function checkColumns(owners, what) {
  const count = owners.length;
  const used = [...new Set(owners)];
  const infos = Object.fromEntries(await Promise.all(used.map(async (key) => [key, await columnInfo(EXTENSIONS[key], count)])));
  for (const key of used) {
    console.log(`${EXTENSIONS[key].tab} canvas columns (${what}): ${JSON.stringify(infos[key]?.columns.map((c) => c.drawn))}`);
  }
  owners.forEach((owner, index) => {
    const info = infos[owner];
    const column = info?.columns[index];
    const width = info ? info.width / count : 0;
    const x = center(column?.box);
    check(
      column && column.drawn > 0.01 && x > index * width && x < (index + 1) * width,
      `${what}: member ${index + 1}'s ${EXTENSIONS[owner].tab} model is drawn in column ${index + 1} of ${count} ` +
        `(${((column?.drawn ?? 0) * 100).toFixed(1)}% drawn, center x ${Math.round(x)})`,
    );
    for (const other of used) {
      if (other === owner) continue;
      const stray = infos[other]?.columns[index]?.drawn ?? 0;
      check(stray < 0.005, `${what}: the ${EXTENSIONS[other].tab} canvas leaves column ${index + 1} empty (${(stray * 100).toFixed(1)}%)`);
    }
  });
  return infos;
}

/**
 * The avatar canvases in DOM order (later ones draw on top) with the extension
 * that draws each, which shared layer it's in, and per column the share of its
 * pixels drawn. With `alpha`, also each canvas's alpha at a quarter scale.
 */
async function canvasStack(columns, alpha = false) {
  return page.evaluate(
    ({ columns, alpha }) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const canvases = [...document.querySelectorAll('[data-lumiverse-avatar]')];
          const scale = 0.25;
          resolve(
            canvases.map((canvas) => {
              const rect = canvas.getBoundingClientRect();
              const probe = document.createElement('canvas');
              probe.width = Math.max(1, Math.round(rect.width * scale));
              probe.height = Math.max(1, Math.round(rect.height * scale));
              const context = probe.getContext('2d', { willReadFrequently: true });
              context.drawImage(canvas, 0, 0, probe.width, probe.height);
              const data = context.getImageData(0, 0, probe.width, probe.height).data;
              const columnWidth = probe.width / columns;
              const drawn = [];
              for (let column = 0; column < columns; column++) {
                const x0 = Math.round(column * columnWidth);
                const x1 = Math.round((column + 1) * columnWidth);
                let count = 0;
                for (let y = 0; y < probe.height; y++) {
                  for (let x = x0; x < x1; x++) if (data[(y * probe.width + x) * 4 + 3] > 16) count++;
                }
                drawn.push(+(count / ((x1 - x0) * probe.height)).toFixed(3));
              }
              const mask = alpha ? [...Array(probe.width * probe.height).keys()].map((i) => data[i * 4 + 3] > 16) : null;
              return {
                owner: canvas.getAttribute('data-lumiverse-avatar'),
                layer: canvas.parentElement?.getAttribute('data-lumiverse-avatar-layer') ?? null,
                drawn,
                mask,
                width: probe.width,
                height: probe.height,
                left: rect.left,
                top: rect.top,
              };
            }),
          );
        });
      }),
    { columns, alpha },
  );
}

/** Which extension shows the grab cursor with the pointer at (x, y): the one whose model it would grab. */
async function grabbedAt(x, y) {
  await page.mouse.move(x - 5, y);
  await page.mouse.move(x, y, { steps: 2 });
  await page.waitForTimeout(400);
  return page.evaluate(() =>
    ['live2d', 'spine'].filter((name) => document.documentElement.classList.contains(`${name}-avatars-hover`)),
  );
}

/**
 * Stacking in a mixed group (members take Live2D and Spine models in turn):
 * every canvas in the one shared layer, Send to front / Send to back reorder
 * the canvases across both extensions and decide which model gets the pointer
 * where two overlap, the Spine canvas splits when a Live2D model sits between
 * two Spine models, and the order survives a reload.
 */
async function checkStacking(members, owners) {
  const live2d = EXTENSIONS.live2d;
  const spine = EXTENSIONS.spine;
  const count = members.length;
  const describe = (stack) => stack.map((canvas) => `${canvas.owner === 'live2d_avatars' ? 'L' : 'S'}[${canvas.drawn.map((d) => (d > 0.01 ? 1 : 0)).join('')}]`).join(' ');
  // The canvas drawing member `index`'s model: the one of its extension with pixels in its column.
  const canvasOf = (stack, index) =>
    stack.findIndex(
      (canvas) => canvas.owner === `${owners[index]}_avatars` && canvas.drawn[index] > 0.01,
    );

  const initial = await canvasStack(count);
  check(
    initial.length > 0 && initial.every((canvas) => canvas.layer === 'front'),
    `every avatar canvas is in the shared front layer (${initial.map((canvas) => canvas.layer).join(', ')})`,
  );

  // Drag member 2's Spine model half a column left, over member 1's Live2D model.
  const spineIndex = owners.indexOf('spine');
  const live2dIndex = owners.indexOf('live2d');
  const width = 1440 / count;
  const info = await columnInfo(spine, count);
  const box = info.columns[spineIndex].box;
  const grabX = center(box);
  const grabY = box.y + box.height * 0.5;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(grabX - (width * 0.6 * step) / 10, grabY);
  await page.mouse.up();
  await page.waitForTimeout(800);

  // A point where both models are drawn.
  const masks = await canvasStack(count, true);
  const live2dCanvas = masks[canvasOf(masks, live2dIndex)];
  const spineCanvas = masks.find((canvas) => canvas.owner === 'spine_avatars' && canvas.drawn[live2dIndex] > 0.001);
  let point = null;
  if (live2dCanvas && spineCanvas) {
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    const both = [];
    for (let y = 0; y < live2dCanvas.height; y++) {
      for (let x = 0; x < live2dCanvas.width; x++) {
        const i = y * live2dCanvas.width + x;
        if (live2dCanvas.mask[i] && spineCanvas.mask[i]) {
          both.push([x, y]);
          sumX += x;
          sumY += y;
          n++;
        }
      }
    }
    if (n > 0) {
      // The overlapping pixel nearest the overlap's middle, in CSS pixels.
      const [x, y] = both.reduce((best, p) =>
        Math.hypot(p[0] - sumX / n, p[1] - sumY / n) < Math.hypot(best[0] - sumX / n, best[1] - sumY / n) ? p : best,
      );
      point = { x: x / 0.25 + 2, y: y / 0.25 + 2, pixels: n };
    }
  }
  check(point !== null, `member ${spineIndex + 1}'s Spine model overlaps member ${live2dIndex + 1}'s Live2D model after a drag (${point?.pixels ?? 0} px at quarter scale)`);
  await page.screenshot({ path: `${OUT}/stack-overlap.png` });
  if (!point) return;

  const restack = async (ext, index, label) => {
    await openTab(ext);
    await selectCharacterIn(ext, members[index]);
    await clickIn(ext, label);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
  };

  // Live2D member to the front: its canvas goes last and it gets the pointer.
  await restack(live2d, live2dIndex, 'Send to front');
  let stack = await canvasStack(count);
  console.log(`stack after Live2D member ${live2dIndex + 1} to front: ${describe(stack)}`);
  check(canvasOf(stack, live2dIndex) === stack.length - 1, `Send to front puts member ${live2dIndex + 1}'s Live2D canvas on top`);
  let grabbed = await grabbedAt(point.x, point.y);
  check(grabbed.join() === 'live2d', `where they overlap, the pointer goes to the Live2D model in front (${grabbed.join() || 'none'})`);
  await page.screenshot({ path: `${OUT}/stack-live2d-front.png` });

  // Spine member to the front: back to Spine on top.
  await restack(spine, spineIndex, 'Send to front');
  stack = await canvasStack(count);
  console.log(`stack after Spine member ${spineIndex + 1} to front: ${describe(stack)}`);
  check(stack[stack.length - 1].owner === 'spine_avatars' && stack[stack.length - 1].drawn[spineIndex] > 0.001, `Send to front puts member ${spineIndex + 1}'s Spine model on top`);
  grabbed = await grabbedAt(point.x, point.y);
  check(grabbed.join() === 'spine', `where they overlap, the pointer goes to the Spine model in front (${grabbed.join() || 'none'})`);
  await page.screenshot({ path: `${OUT}/stack-spine-front.png` });

  // Another Spine member to the back: a Live2D model now sits between the two
  // Spine models, so the Spine extension draws them on two canvases.
  const lastSpine = owners.lastIndexOf('spine');
  if (lastSpine !== spineIndex) {
    await restack(spine, lastSpine, 'Send to back');
    stack = await canvasStack(count);
    console.log(`stack after Spine member ${lastSpine + 1} to back: ${describe(stack)}`);
    const spineCanvases = stack.filter((canvas) => canvas.owner === 'spine_avatars');
    check(
      spineCanvases.length === 2 && stack[0].owner === 'spine_avatars' && stack[0].drawn[lastSpine] > 0.01 && stack[0].drawn[spineIndex] < 0.001,
      `Send to back puts member ${lastSpine + 1}'s Spine model on its own canvas at the bottom (${describe(stack)})`,
    );
    check(
      stack[stack.length - 1].owner === 'spine_avatars' && stack[stack.length - 1].drawn[lastSpine] < 0.001,
      `member ${spineIndex + 1}'s Spine model stays on top, without member ${lastSpine + 1}'s`,
    );
    await page.screenshot({ path: `${OUT}/stack-spine-split.png` });
  }

  // The order is saved: after a reload the canvases come back the same way.
  const saved = describe(stack);
  await page.reload();
  await page.waitForTimeout(3000);
  await waitForModels(owners);
  await page.waitForTimeout(3000);
  stack = await canvasStack(count);
  check(describe(stack) === saved, `the stacking order survives a reload (${describe(stack)})`);
  grabbed = await grabbedAt(point.x, point.y);
  check(grabbed.join() === 'spine', `after the reload the pointer still goes to the Spine model in front (${grabbed.join() || 'none'})`);
  await page.screenshot({ path: `${OUT}/stack-after-reload.png` });

  // Put the dragged model back.
  await openTab(spine);
  await selectCharacterIn(spine, members[spineIndex]);
  await clickIn(spine, 'Fit to canvas');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}

async function runGroup() {
  console.log('── Group chat ──');
  const members = GROUP_MEMBERS;
  if (members.length < 2 || !GROUP_CHAT_ID) throw new Error('No group chat members; run lumiverse.sh seed-group');
  const groupChat = `${BASE}/chat/${GROUP_CHAT_ID}`;
  const live2d = EXTENSIONS.live2d;
  const spine = EXTENSIONS.spine;
  const mixed = SPINE_ZIPS.length > 0;
  // Members take Live2D models in turn; with Spine models, every other member takes a Spine one.
  const owners = members.map((_, index) => (mixed && index % 2 === 1 ? 'spine' : 'live2d'));
  const models = owners.map((owner, index) => {
    const zips = owner === 'spine' ? SPINE_ZIPS : MODEL_ZIPS;
    const turn = mixed ? Math.floor(index / 2) : index;
    return zips[turn % zips.length];
  });

  await page.goto(groupChat);
  await page.waitForTimeout(5000);
  await openTab(live2d);
  for (const zip of MODEL_ZIPS) await importInto(live2d, zip);
  if (mixed) {
    await openTab(spine);
    for (const zip of SPINE_ZIPS) await importInto(spine, zip);
  }

  // Each member gets a model in its extension and none in the other, then is fitted to its column.
  for (const [index, characterId] of members.entries()) {
    const owner = EXTENSIONS[owners[index]];
    if (mixed) {
      const other = owner === live2d ? spine : live2d;
      await openTab(other);
      await selectCharacterIn(other, characterId);
      await bindIn(other, null);
    }
    await openTab(owner);
    const label = await selectCharacterIn(owner, characterId);
    await bindIn(owner, modelName(models[index]));
    console.log(`bound ${owner.tab} model ${modelName(models[index])} to ${label}`);
  }
  if (mixed) await openTab(live2d);
  const labels = await page
    .locator('.l2d-section:has(> .l2d-section-title:text-is("Character model")) .l2d-picker')
    .nth(0)
    .locator('button')
    .first()
    .click()
    .then(() => page.locator('[role="listbox"] [role="option"]').allInnerTexts())
    .then((texts) => texts.map(optionLabel));
  await page.keyboard.press('Escape');
  check(
    labels.slice(0, members.length).every((label) => label.endsWith('(in this chat)')),
    `group members listed first in the Live2D character picker: ${labels.slice(0, members.length).join(', ')}`,
  );

  // Reload so the stage is built from scratch, then fit every model to its column.
  await page.goto(groupChat);
  await page.waitForTimeout(3000);
  await waitForModels(owners);
  for (const [index, characterId] of members.entries()) {
    const owner = EXTENSIONS[owners[index]];
    await openTab(owner);
    await selectCharacterIn(owner, characterId);
    await clickIn(owner, 'Fit to canvas');
  }
  // Close the drawer so the whole stage shows.
  await page.keyboard.press('Escape');
  await page.goto(groupChat);
  await page.waitForTimeout(3000);
  await waitForModels(owners);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/group-chat.png` });
  const before = await checkColumns(owners, 'group chat');
  if (mixed) await checkStacking(members, owners);
  if (stackOnly) return;

  // A tap on a member's model goes to that model's canvas only.
  const tappedCanvases = [];
  for (const [index, owner] of owners.entries()) {
    const box = before[owner]?.columns[index]?.box;
    if (owner !== 'live2d' || !box) continue;
    const counts = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.live2d-avatars-canvas')].map((canvas) => Number(canvas.dataset.live2dTaps ?? 0)),
      );
    const was = await counts();
    await page.mouse.click(center(box), box.y + box.height * 0.4);
    await page.waitForTimeout(300);
    const now = await counts();
    const tapped = now.flatMap((count, canvas) => (count > (was[canvas] ?? 0) ? [canvas] : []));
    check(
      tapped.length === 1 && !tappedCanvases.includes(tapped[0]),
      `a tap on member ${index + 1}'s model reaches its canvas only (canvases tapped: ${JSON.stringify(tapped)})`,
    );
    tappedCanvases.push(...tapped);
  }

  // Dragging the first member's model moves only it.
  const first = before.live2d.columns[0].box;
  const second = before[owners[1]].columns[1].box;
  if (!first || !second) {
    console.log('Skipping the remaining checks: member 1 or 2 has no model on screen to drag.');
    return;
  }
  const grabX = center(first);
  const grabY = first.y + first.height * 0.4;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 20, grabY, { steps: 5 });
  await page.mouse.move(grabX + 40, grabY + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterLive2D = await columnInfo(live2d, members.length);
  const afterSecond = await columnInfo(EXTENSIONS[owners[1]], members.length);
  const shift = center(afterLive2D.columns[0].box) - center(first);
  const otherShift = Math.abs(center(afterSecond.columns[1].box) - center(second));
  check(
    Math.abs(shift - 40) < 15 && otherShift < 15,
    `a drag moves member 1's model about 40px (${Math.round(shift)}px) and leaves member 2's (${Math.round(otherShift)}px)`,
  );
  await page.screenshot({ path: `${OUT}/group-dragged.png` });
  await openTab(live2d);
  await selectCharacterIn(live2d, members[0]);
  const draggedX = await sliderValue('X offset (%)');
  const columnWidth = afterLive2D.width / members.length;
  // The model follows the pointer exactly (40px from x = 0 after Fit); its drawn box can move less.
  const expectedX = (40 / (columnWidth / 2)) * 100;
  check(
    Math.abs(draggedX - expectedX) < 3,
    `member 1's X offset is relative to its column: ${draggedX}% (expected about ${expectedX.toFixed(1)}%)`,
  );
  await clickIn(live2d, 'Fit to canvas');
  await page.keyboard.press('Escape');

  // Removing a member re-lays out the stage without a reload, in both extensions.
  const removedIndex = 1;
  const removed = members[removedIndex];
  const removeStatus = await page.evaluate(
    async ({ chatId, characterId }) =>
      (await fetch(`/api/v1/chats/${chatId}/members/${characterId}`, { method: 'DELETE' })).status,
    { chatId: GROUP_CHAT_ID, characterId: removed },
  );
  check(removeStatus < 300, `removed member ${removedIndex + 1} (HTTP ${removeStatus})`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/group-member-removed.png` });
  await checkColumns(owners.filter((_, index) => index !== removedIndex), 'after removing a member');

  // Put the member back for the next run (it rejoins at the end).
  await page.evaluate(
    async ({ chatId, characterId }) =>
      fetch(`/api/v1/chats/${chatId}/members/${characterId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_greeting: true }),
      }),
    { chatId: GROUP_CHAT_ID, characterId: removed },
  );
  await page.waitForTimeout(5000);
  const rejoined = [...owners.filter((_, index) => index !== removedIndex), owners[removedIndex]];
  await page.screenshot({ path: `${OUT}/group-member-added.png` });
  await checkColumns(rejoined, 'after adding the member back');
  // Restore the original member order for the next run.
  await page.evaluate(
    async ({ chatId, members }) => {
      const chat = await fetch(`/api/v1/chats/${chatId}`).then((response) => response.json());
      await fetch(`/api/v1/chats/${chatId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...chat.metadata, character_ids: members }),
      });
    },
    { chatId: GROUP_CHAT_ID, members },
  );

  if (mixed) {
    // With Spine turned off, its members' columns go away and the Live2D models share the stage.
    await openTab(spine);
    await page.locator('.spn-root label:has-text("Enabled") input[type="checkbox"]').first().uncheck();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/group-spine-off.png` });
    await checkColumns(owners.filter((owner) => owner === 'live2d'), 'with Spine turned off');
    await openTab(spine);
    await page.locator('.spn-root label:has-text("Enabled") input[type="checkbox"]').first().check();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(5000);
    await checkColumns(owners, 'with Spine back on');
  }
}

/** The Hit areas section of Model settings, opened. */
async function openHitAreas() {
  await openLive2DTab();
  const hitAreas = page.locator('details.l2d-hit-areas');
  await hitAreas.waitFor({ timeout: 60000 });
  await hitAreas.evaluate((node) => (node.open = true));
  return hitAreas;
}

/** Tap (press and release) at a viewport point; returns what the model's canvas says the tap hit, or null for no tap. */
async function tapAt(x, y, screenshot) {
  const taps = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.live2d-avatars-canvas');
      return { count: Number(canvas?.dataset.live2dTaps ?? 0), area: canvas?.dataset.live2dTap ?? null };
    });
  const before = await taps();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  // While hit areas are shown, the tapped one is highlighted for a moment.
  if (screenshot) await page.waitForTimeout(80).then(() => page.screenshot({ path: screenshot }));
  else await page.waitForTimeout(300);
  const after = await taps();
  return after.count > before.count ? after.area : null;
}

/** Whether a Live2D canvas has a drawn (non-transparent) pixel at this viewport point. */
function drawnAt(x, y) {
  return page.evaluate(
    ({ x, y }) =>
      new Promise((resolve) => {
        const probe = document.createElement('canvas');
        probe.width = 1;
        probe.height = 1;
        const context = probe.getContext('2d', { willReadFrequently: true });
        requestAnimationFrame(() => {
          for (const canvas of document.querySelectorAll('.live2d-avatars-canvas')) {
            const rect = canvas.getBoundingClientRect();
            const sx = ((x - rect.left) / rect.width) * canvas.width;
            const sy = ((y - rect.top) / rect.height) * canvas.height;
            context.drawImage(canvas, sx, sy, 1, 1, 0, 0, 1, 1);
          }
          resolve(context.getImageData(0, 0, 1, 1).data[3] > 16);
        });
      }),
    { x, y },
  );
}

async function reopenChat() {
  await page.goto(CHAT);
  await page.waitForSelector('.live2d-avatars-canvas', { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(5000);
}

/** Where the model's canvas center is on screen (the model's center at X/Y offset 0, solo chat). */
async function stageCenter() {
  return page.evaluate(() => {
    const rect = document.querySelector('.live2d-avatars-canvas').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function hitAreaTest(freshBinding) {
  console.log('Hit areas:');
  await setBackgroundMode(false); // left on by an earlier --background run that failed
  let section = await openHitAreas();
  const text = await section.innerText();
  // The model file's areas are the rows before "Drawn on the model" that have no name field.
  const fileAreas = await section
    .locator('.l2d-row:has(> span.l2d-emotion)')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('span.l2d-emotion').textContent));
  if (fileAreas.length === 0) {
    check(text.includes('defines no hit areas'), 'a model without hit areas says so and offers drawing them');
  } else {
    console.log(`Hit areas from the model: ${fileAreas.join(', ')}`);
    // Give every file area a motion, so a tap on the model's body lands on one.
    for (const area of fileAreas) {
      const motion = section.locator(`.l2d-row:has(> span.l2d-emotion:text-is("${area}")) select`).nth(1);
      if ((await motion.inputValue()) === 'none') {
        await motion.selectOption({ index: 1 });
        console.log(`  ${area}: set to ${await motion.inputValue()}`);
      } else {
        console.log(`  ${area}: ${await motion.inputValue()} (already set)`);
      }
    }
  }
  if (freshBinding && fileAreas.length === 0) {
    // haru_ja has a "Tap" motion group: a new binding plays it on click.
    const onClick = await page.evaluate(() => {
      const title = [...document.querySelectorAll('.l2d-anim-title')].find((node) => node.textContent === 'On click');
      return title?.parentElement?.querySelectorAll('select')[1]?.value ?? null;
    });
    check(onClick === 'Tap_id=random', `a new binding's On click uses the model's tap motion (${onClick})`);
  }
  const center = await stageCenter();
  // A small box on the face (for the test models, upright at scale 1), smaller than any head area
  // the model file has, so a tap in it hits this one.
  const head = { x1: center.x - 40, y1: center.y - 310, x2: center.x + 40, y2: center.y - 230 };
  const headCenter = { x: center.x, y: (head.y1 + head.y2) / 2 };

  // Start without drawn areas (left from an earlier run).
  while ((await section.locator('button[aria-label^="Delete "]').count()) > 0) {
    await section.locator('button[aria-label^="Delete "]').first().click();
    await page.waitForTimeout(300);
    section = await openHitAreas();
  }
  await section.locator('input[placeholder="New area, e.g. Head"]').fill('Face');
  await section.locator('button:text-is("Add area")').click();
  check((await section.innerText()).includes('Drag on the model to draw “Face”'), 'Add area asks to drag on the model');
  await page.screenshot({ path: `${OUT}/hit-1-drawing.png` });
  await page.mouse.move(head.x1, head.y1);
  await page.mouse.down();
  await page.mouse.move((head.x1 + head.x2) / 2, (head.y1 + head.y2) / 2, { steps: 5 });
  await page.mouse.move(head.x2, head.y2, { steps: 5 });
  await page.screenshot({ path: `${OUT}/hit-2-dragging.png` });
  await page.mouse.up();
  await page.waitForTimeout(500);
  section = await openHitAreas();
  const nameInputs = await section.locator('input.l2d-area-name:not([placeholder])').evaluateAll((nodes) => nodes.map((node) => node.value));
  check(nameInputs.includes('Face'), `the drawn area is listed (${JSON.stringify(nameInputs)})`);
  check(
    await section.locator('label:has-text("Show hit areas on the model") input').isChecked(),
    'drawing an area turns on Show hit areas',
  );
  // Give it a motion: the last one in the list, unlike On click's.
  const headMotion = section.locator('.l2d-row:has(input.l2d-area-name)').first().locator('select').nth(1);
  const motionCount = await headMotion.locator('option').count();
  await headMotion.selectOption({ index: motionCount - 1 });
  const chosenMotion = await headMotion.inputValue();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/hit-3-area-in-settings.png` });

  // Reopen the chat to close the drawer, so the whole stage shows.
  await reopenChat();
  check(
    (await tapAt(headCenter.x, headCenter.y, `${OUT}/hit-4-tap-head.png`)) === 'Face',
    'a tap on the face hits the drawn area',
  );
  const bodyTap = await tapAt(center.x, center.y + 50, fileAreas.length ? `${OUT}/hit-4b-tap-body.png` : undefined);
  if (fileAreas.length === 0) check(bodyTap === '', 'a tap on the body plays On click');
  else check(fileAreas.includes(bodyTap), `a tap on the body hits one of the model file's areas (${bodyTap})`);
  const beside = { x: center.x - 500, y: center.y };
  if (await drawnAt(beside.x, beside.y)) {
    // A full-scene model (baifeng_3) draws its backdrop over the whole stage.
    console.log('skip a tap beside the model: the model draws there too');
  } else {
    check((await tapAt(beside.x, beside.y)) === null, 'a tap beside the model is not a tap on it');
  }

  // Rotated 90° counterclockwise about the model's center, the head is to the left of it.
  await openLive2DTab();
  await setSlider('Rotation (°)', -90);
  await page.waitForTimeout(1000);
  await reopenChat();
  const turned = { x: center.x - (center.y - headCenter.y), y: center.y };
  check(
    (await tapAt(turned.x, turned.y, `${OUT}/hit-5-rotated.png`)) === 'Face',
    'rotated -90°, a tap where the head went hits the area',
  );
  check((await tapAt(headCenter.x, headCenter.y)) !== 'Face', 'rotated -90°, the old head position is not the area');
  await openLive2DTab();
  await setSlider('Rotation (°)', 0);
  await page.waitForTimeout(1000);

  // Saved: still there after a reload.
  await reopenChat();
  check((await tapAt(headCenter.x, headCenter.y)) === 'Face', 'after a reload the area is still there');
  section = await openHitAreas();
  const motion = await section.locator('.l2d-row:has(input.l2d-area-name)').first().locator('select').nth(1).inputValue();
  check(motion === chosenMotion, `after a reload the area keeps its motion (${motion})`);
  await page.keyboard.press('Escape');
  return { headCenter, center, chosenMotion };
}

async function setBackgroundMode(on) {
  await openLive2DTab();
  const box = page.locator('label:has-text("Show model as chat background") input');
  if ((await box.isChecked()) !== on) await box.click();
  await page.waitForTimeout(1000);
}

/** Press, wait, move and release at a viewport point; returns whether the model counted a tap. */
async function pressAt(x, y, { holdMs = 0, moveBy = 0 } = {}) {
  const count = () => page.evaluate(() => Number(document.querySelector('.live2d-avatars-canvas')?.dataset.live2dTaps ?? 0));
  const before = await count();
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (holdMs) await page.waitForTimeout(holdMs);
  if (moveBy) await page.mouse.move(x + moveBy, y + moveBy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  return (await count()) > before;
}

/**
 * With the model as the chat background, the chat is above it: taps must go
 * through where the chat draws nothing, and only there, without taking the
 * chat's presses (scrolling, selecting, its buttons and input).
 */
async function backgroundTapTest({ headCenter, center, chosenMotion }) {
  console.log('Taps through the chat (background mode):');
  await setBackgroundMode(true);
  await reopenChat();
  check(
    await page.evaluate(() => !!document.querySelector('[data-lumiverse-avatar-layer="background"] .live2d-avatars-canvas')),
    'the model is drawn as the chat background',
  );
  const chatAbove = (point) =>
    page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-lumiverse-surface="chat-body"]'), point);
  check(await chatAbove(headCenter), 'the chat is on top of the model’s face');
  // Large models (baifeng_3) can still be setting up after the canvas appears.
  await page
    .waitForFunction(
      ({ x, y }) => {
        const canvas = document.querySelector('.live2d-avatars-canvas');
        return !!canvas && !!window.__lumiverseAvatarColumns?.hitTests?.live2d_avatars?.(canvas, x, y);
      },
      headCenter,
      { timeout: 60000 },
    )
    .catch(() => console.log('the model never answered a hit test at the face'));
  check(
    (await tapAt(headCenter.x, headCenter.y, `${OUT}/bg-1-tap-face-through-chat.png`)) === 'Face',
    'a tap on the face through the empty chat hits the drawn area',
  );
  check((await tapAt(center.x, center.y + 50)) !== null, 'a tap on the body through the chat reaches the model');
  check(!(await pressAt(headCenter.x, headCenter.y, { moveBy: 30 })), 'a drag through the chat is not a tap');
  check(!(await pressAt(headCenter.x, headCenter.y, { holdMs: 800 })), 'a long press through the chat is not a tap');
  const beside = { x: center.x - 500, y: center.y };
  if (!(await drawnAt(beside.x, beside.y))) {
    check((await tapAt(beside.x, beside.y)) === null, 'a tap through the chat beside the model is not a tap on it');
  }

  // A message over the model keeps the tap.
  const onMessage = await page.evaluate(() => {
    const canvas = document.querySelector('.live2d-avatars-canvas').getBoundingClientRect();
    for (const card of document.querySelectorAll('[data-component="MinimalMessage"], [data-component="BubbleMessage"]')) {
      const rect = card.getBoundingClientRect();
      const x = Math.max(rect.left, canvas.left) + 40;
      const y = (Math.max(rect.top, canvas.top) + Math.min(rect.bottom, canvas.bottom)) / 2;
      if (x < Math.min(rect.right, canvas.right) && y > rect.top && y < rect.bottom) return { x, y };
    }
    return null;
  });
  if (onMessage) {
    const message = { x: Math.max(onMessage.x, center.x - 60), y: onMessage.y };
    check((await tapAt(message.x, message.y)) === null, 'a tap on a message over the model stays the message’s');
  } else {
    console.log('skip a tap on a message: no message over the model');
  }

  // The input bar keeps its clicks.
  const input = page.locator('[data-component="InputArea"] textarea').first();
  const inputBox = await input.boundingBox();
  if (inputBox) {
    const tapped = await pressAt(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
    const focused = await input.evaluate((node) => document.activeElement === node);
    check(!tapped && focused, 'a click on the message input focuses it and is no tap');
  }

  // An emotion set to a tap plays that tap's motion (▶ in Emotion mappings).
  await openLive2DTab();
  const emotions = page.locator('.l2d-section:has(> .l2d-section-title:text-is("Emotion mappings"))');
  await emotions.evaluate((node) => (node.open = true));
  const joy = emotions.locator('.l2d-row:has(> span.l2d-emotion:text-is("joy"))');
  const joyMotion = joy.locator('select').nth(1);
  const tapOptions = await joyMotion.locator('optgroup[label^="Taps"] option').evaluateAll((nodes) =>
    nodes.map((node) => node.value),
  );
  check(tapOptions.includes('tap:Face'), `Emotion mappings offer the model’s taps (${tapOptions.join(', ')})`);
  await joyMotion.selectOption('tap:Face');
  await page.waitForTimeout(800);
  await joy.locator('button:text-is("▶")').click();
  await page.waitForTimeout(3000);
  const played = await page.evaluate(() => document.querySelector('.live2d-avatars-canvas')?.dataset.live2dMotion ?? null);
  check(played === chosenMotion, `an emotion set to “Tap Face” plays Face’s motion (${played})`);
  await page.screenshot({ path: `${OUT}/bg-2-emotion-tap.png` });
  await joyMotion.selectOption('none');
  await page.waitForTimeout(800);
  await setBackgroundMode(false);
}

try {
  await page.goto(BASE);
  await page.fill('input[type="text"]', process.env.LUMI_USER);
  await page.fill('input[type="password"]', process.env.LUMI_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  if (group) {
    await runGroup();
    console.log(`Screenshots: ${OUT}`);
    for (const problem of problems) console.log(problem);
    console.log(process.exitCode ? 'FAIL: some group chat checks failed' : 'OK: group chat checks passed');
    process.exit();
  }

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
    .waitForSelector('.live2d-avatars-canvas', { timeout: LOAD_TIMEOUT })
    .then(() => true, () => false);
  if (appeared) console.log(`Model loaded ${((Date.now() - loadStart) / 1000).toFixed(1)}s after opening the chat`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/chat.png` });

  const stage = await page.evaluate(() => {
    const canvas = document.querySelector('.live2d-avatars-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      overlay: !!canvas.closest('[data-lumiverse-avatar-layer]'),
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
  if (testHitAreas && stage) {
    const areas = await hitAreaTest(binding.startsWith('bound'));
    if (testBackground) await backgroundTapTest(areas);
  }
} finally {
  await browser.close();
}
