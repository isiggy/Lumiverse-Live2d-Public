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
//                                 # and both extensions share the columns
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

  // Dragging the first member's model moves only it.
  const first = before.live2d.columns[0].box;
  const second = before[owners[1]].columns[1].box;
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
  const expectedX = (shift / (columnWidth / 2)) * 100;
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
