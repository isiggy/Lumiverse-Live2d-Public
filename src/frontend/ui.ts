/**
 * Settings UI rendered into the extension's drawer tab. Mirrors the
 * SillyTavern Live2d extension's window.html controls: global toggles, model
 * library management, character↔model binding, model layout, mouth/cursor
 * parameters, animation mappings, emotion (classify) mappings, and hit areas.
 */

import type { SpindleSelectHandle, SpindleSelectOptionLeading, SpindleSelectOptions } from 'lumiverse-spindle-types';
import { applyTapMotions, suggestAreaMotion, tapMotion } from './hit-areas';
import type { ModelDescription, Stage } from './stage';
import {
  CLASSIFY_EXPRESSIONS,
  CURSOR_PARAM_IDS,
  defaultModelSettings,
  type LibrarySort,
  type CustomHitArea,
  type LibraryView,
  type Live2DSettings,
  type ModelRecord,
  type ModelSettings,
} from '../shared/settings';

export interface UIController {
  getSettings(): Live2DSettings;
  getModels(): ModelRecord[];
  getCharacters(): Array<{ id: string; name: string }>;
  getPermissions(): string[];
  getActiveCharacterId(): string | null;
  stage: Stage;
  saveDebounced(): void;
  saveNow(): void;
  reloadStage(): void;
  /** Show or hide the reload button in the chat's menu bar to match the settings. */
  syncChatBarButton(): void;
  importZip(status: (text: string) => void): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  classifyTest(text: string): Promise<string>;
  describeModel(modelId: string): Promise<ModelDescription>;
  /** Bytes received so far while a model's files are being downloaded from the backend. */
  getDownloadProgress(modelId: string): { receivedBytes: number; totalBytes: number } | null;
  getOrCreateModelSettings(characterId: string, modelId: string, description: ModelDescription | null): ModelSettings;
  requestPermissions(perms: string[]): Promise<void>;
  /** Host element used when the stage runs embedded in the tab (no overlay permission). */
  embeddedHost: HTMLElement;
  usingOverlay(): boolean;
  /** Re-apply the chat-background stacking after the setting changes. */
  applyBackgroundMode(): void;
  /** Mount Lumiverse's own searchable dropdown; undefined when the host doesn't offer it. */
  mountSelect?(target: HTMLElement, options: SpindleSelectOptions): SpindleSelectHandle;
  /** Save a character's settings for its model to a file. */
  exportModelSettings(characterId: string, characterName: string): void;
  /** Load a settings file onto a character; resolves to a status line ('' when cancelled). */
  importModelSettings(characterId: string, characterName: string): Promise<string>;
  /** Retake the library thumbnail of a character's model on stage; false when it isn't shown. */
  updateThumbnail(characterId: string, modelId: string): boolean;
  /** Ask before something that can't be undone; resolves to whether the user agreed. */
  confirm(options: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
}

const REQUIRED_PERMS: Array<{ id: string; why: string }> = [
  { id: 'app_manipulation', why: 'show the avatar over the app (otherwise it renders inside this tab)' },
  { id: 'generation', why: 'classify message emotions with the LLM' },
  { id: 'chat_mutation', why: 'send hit-area interaction messages' },
  { id: 'chats', why: 'know which characters are in the active chat (needed for group chats)' },
  { id: 'characters', why: 'list your characters by name when assigning models' },
];

// ── tiny DOM helpers ────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'l2d-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** A small square button (▶, ✕, ↺) that names its action for screen readers and on hover. */
function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = button(icon, onClick);
  node.classList.add('l2d-icon-btn');
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

/** A checkbox, with an optional line under its label that says what it does. */
function checkbox(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLLabelElement {
  const wrap = el('label', 'l2d-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  const text = el('span', 'l2d-check-text');
  text.appendChild(el('span', undefined, label));
  if (hint) text.appendChild(el('span', 'l2d-hint', hint));
  wrap.appendChild(text);
  return wrap;
}

/** A dropdown; options with a `group` go under that heading, in the order the groups first appear. */
function select(
  options: Array<{ value: string; label: string; group?: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el('select', 'l2d-select');
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const option of options) {
    const opt = el('option', undefined, option.label);
    opt.value = option.value;
    let parent: HTMLElement = node;
    if (option.group) {
      let group = groups.get(option.group);
      if (!group) {
        group = el('optgroup');
        group.label = option.group;
        groups.set(option.group, group);
        node.appendChild(group);
      }
      parent = group;
    }
    parent.appendChild(opt);
  }
  node.value = value;
  if (node.value !== value) node.selectedIndex = 0;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

interface SliderOptions {
  min: number;
  max: number;
  step: number;
  /** Shown after the value: '%', '°', '×', 'ms'. */
  unit?: string;
  /** The default value; a reset button shows whenever the value differs from it. */
  reset?: number;
}

/**
 * A labelled slider whose value can also be typed in, with a reset button
 * once it's moved off its default. The range input carries the label as its
 * aria-label.
 */
function slider(
  label: string,
  options: SliderOptions,
  value: number,
  onInput: (value: number) => void,
): HTMLDivElement & { setValue(value: number): void } {
  const decimals = (String(options.step).split('.')[1] ?? '').length;
  const clamp = (next: number) =>
    Number(Math.min(options.max, Math.max(options.min, next)).toFixed(decimals));
  const range = el('input', 'l2d-range');
  range.type = 'range';
  range.min = String(options.min);
  range.max = String(options.max);
  range.step = String(options.step);
  range.setAttribute('aria-label', label);
  const number = el('input', 'l2d-number');
  number.type = 'number';
  number.min = String(options.min);
  number.max = String(options.max);
  number.step = String(options.step);
  number.setAttribute('aria-label', `${label} value`);
  const reset =
    options.reset === undefined
      ? null
      : iconButton('↺', `Reset to ${options.reset}${options.unit ?? ''}`, () => {
          show(options.reset!);
          onInput(options.reset!);
        });
  const show = (next: number) => {
    range.value = String(next);
    number.value = next.toFixed(decimals);
    const fill = ((next - options.min) / (options.max - options.min)) * 100;
    range.style.setProperty('--l2d-fill', `${Math.min(100, Math.max(0, fill))}%`);
    if (reset) reset.hidden = next === options.reset;
  };
  range.addEventListener('input', () => {
    const next = clamp(Number(range.value));
    show(next);
    onInput(next);
  });
  number.addEventListener('change', () => {
    const typed = Number(number.value);
    const next = number.value.trim() === '' || !Number.isFinite(typed) ? Number(range.value) : clamp(typed);
    show(next);
    onInput(next);
  });
  const head = el('div', 'l2d-slider-head');
  head.appendChild(el('span', 'l2d-slider-label', label));
  const valueBox = el('span', 'l2d-slider-value');
  valueBox.appendChild(number);
  if (options.unit) valueBox.appendChild(el('span', 'l2d-unit', options.unit));
  if (reset) valueBox.appendChild(reset);
  head.appendChild(valueBox);
  const wrap = Object.assign(el('div', 'l2d-slider'), {
    /** Show a value set from code, without calling onInput. */
    setValue(next: number) {
      show(next);
    },
  });
  wrap.append(head, range);
  show(value);
  return wrap;
}

// Which sections are open is remembered in this browser, by title, so a
// re-render (or a reload) doesn't open everything again.
const SECTION_STATE_KEY = 'live2d-avatars:open-sections';

function loadSectionState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SECTION_STATE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const sectionState = loadSectionState();

/** A collapsible section, open unless `open: false`; the user's choice is remembered. */
function section(
  title: string,
  children: (HTMLElement | null)[] = [],
  options: { open?: boolean; className?: string } = {},
): HTMLDetailsElement {
  const wrap = el('details', 'l2d-section');
  if (options.className) wrap.classList.add(options.className);
  const defaultOpen = options.open ?? true;
  wrap.open = sectionState[title] ?? defaultOpen;
  wrap.addEventListener('toggle', () => {
    if (wrap.open === (sectionState[title] ?? defaultOpen)) return;
    sectionState[title] = wrap.open;
    try {
      localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(sectionState));
    } catch {
      /* storage unavailable: it's only remembered until the tab reloads */
    }
  });
  wrap.appendChild(el('summary', 'l2d-section-title', title));
  for (const child of children) if (child) wrap.appendChild(child);
  return wrap;
}

/** A row of buttons and status text. */
function row(...children: (HTMLElement | string)[]): HTMLDivElement {
  const wrap = el('div', 'l2d-row');
  for (const child of children) {
    wrap.appendChild(typeof child === 'string' ? el('span', 'l2d-label', child) : child);
  }
  return wrap;
}

/** A label and its control(s), lined up with the other fields; selects and inputs fill the space. */
function field(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const wrap = el('div', 'l2d-field');
  wrap.appendChild(el('span', 'l2d-label', label));
  const box = el('div', 'l2d-field-control');
  for (const control of controls) {
    if ((control instanceof HTMLSelectElement || control instanceof HTMLInputElement) && !control.hasAttribute('aria-label')) {
      control.setAttribute('aria-label', label);
    }
    box.appendChild(control);
  }
  wrap.appendChild(box);
  return wrap;
}

function note(text: string): HTMLParagraphElement {
  return el('p', 'l2d-note', text);
}

/** An explanation that the Show help text setting hides. */
function help(text: string): HTMLParagraphElement {
  return el('p', 'l2d-note l2d-help', text);
}

/** A line that explains why a button didn't do anything; empty otherwise. */
function statusLine(): { root: HTMLSpanElement; say(text: string): void } {
  const root = el('span', 'l2d-dim', '');
  root.setAttribute('role', 'status');
  return {
    root,
    say(text: string) {
      root.textContent = text;
    },
  };
}

// ── model library helpers ───────────────────────────────────────────────────

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'name_desc', label: 'Name (Z–A)' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
];

/** Dropdowns show their search field once they have more options than this. */
const SEARCH_THRESHOLD = 6;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortModels(models: ModelRecord[], sort: LibrarySort): ModelRecord[] {
  const time = (model: ModelRecord) => Date.parse(model.importedAt) || 0;
  const compare: Record<LibrarySort, (a: ModelRecord, b: ModelRecord) => number> = {
    name: (a, b) => byName.compare(a.name, b.name),
    name_desc: (a, b) => byName.compare(b.name, a.name),
    newest: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    largest: (a, b) => b.sizeBytes - a.sizeBytes,
    smallest: (a, b) => a.sizeBytes - b.sizeBytes,
  };
  const order = compare[sort] ?? compare.name;
  return [...models].sort((a, b) => order(a, b) || byName.compare(a.name, b.name));
}

function libraryView(view: LibraryView | undefined): LibraryView {
  return view === 'list' ? 'list' : 'tiles';
}

function modelSummary(model: ModelRecord): string {
  return `Cubism ${model.cubism} · ${(model.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** The model's thumbnail, or its initial on a plain square until it has one. */
function thumbnail(model: ModelRecord, className: string): HTMLElement {
  if (model.thumbnail) {
    const image = el('img', className);
    image.src = model.thumbnail;
    image.alt = '';
    return image;
  }
  return el('div', `${className} l2d-thumb-empty`, initial(model.name));
}

function modelLeading(model: ModelRecord): SpindleSelectOptionLeading {
  return model.thumbnail
    ? { type: 'image', src: model.thumbnail, rounded: false, fallback: { text: initial(model.name) } }
    : { type: 'initial', text: initial(model.name) };
}

interface PickerOption {
  value: string;
  label: string;
  sublabel?: string;
  leading?: SpindleSelectOptionLeading;
}

// ── option builders (port of the ST extension's loadAnimationUi) ────────────

function expressionOptions(description: ModelDescription | null): Array<{ value: string; label: string }> {
  const options = [{ value: 'none', label: 'None' }];
  for (const expression of description?.expressions ?? []) {
    options.push({ value: expression.name, label: `${expression.name} (${expression.file})` });
  }
  return options;
}

function motionOptions(description: ModelDescription | null): Array<{ value: string; label: string }> {
  const options = [{ value: 'none', label: 'None' }];
  for (const [group, files] of Object.entries(description?.motions ?? {})) {
    if (files.length === 1) {
      options.push({ value: `${group}_id=random`, label: group });
    } else {
      options.push({ value: `${group}_id=random`, label: `${group} random` });
      files.forEach((file, index) => {
        options.push({ value: `${group}_id=${index}`, label: `${group} ${index} (${file})` });
      });
    }
  }
  return options;
}

/**
 * Motions for an emotion: the model's motions, then its taps (each hit area,
 * and "On click"), which play whatever the tap is set to in Hit areas.
 */
function emotionMotionOptions(
  description: ModelDescription | null,
  modelSettings: ModelSettings,
): Array<{ value: string; label: string; group?: string }> {
  const [none, ...motions] = motionOptions(description);
  const areas = [...(description?.hitAreas ?? []), ...modelSettings.custom_hit_areas.map((area) => area.name)];
  const taps = [...new Set(areas)]
    .filter(Boolean)
    .map((area) => ({ value: tapMotion(area), label: `Tap ${area}`, group: 'Taps (as set in Hit areas)' }));
  taps.push({ value: tapMotion(''), label: 'Tap the model (On click)', group: 'Taps (as set in Hit areas)' });
  return [none!, ...motions.map((option) => ({ ...option, group: 'Motions' })), ...taps];
}

function parameterOptions(description: ModelDescription | null): Array<{ value: string; label: string }> {
  return [
    { value: 'none', label: 'Select parameter id' },
    ...(description?.parameterIds ?? []).map((id) => ({ value: id, label: id })),
  ];
}

// ── main UI class ───────────────────────────────────────────────────────────

export class SettingsUI {
  private root: HTMLElement | null = null;
  private selectedCharacterId: string | null = null;
  /** The chat's character when the tab last rendered; the selection follows it across chat switches. */
  private lastActiveCharacterId: string | null = null;
  /** Refreshes the layout sliders from the stored settings (after a drag on the stage). */
  private syncLayout: (() => void) | null = null;
  private selectedModelId: string | null = null;
  /** Model library filter text (not saved). */
  private libraryFilter = '';
  private libraryList: HTMLElement | null = null;
  /** Result of the last settings file import, shown until another character is picked. */
  private fileStatusText = '';
  /** Host dropdowns mounted by the last render, destroyed on the next one. */
  private mounted: SpindleSelectHandle[] = [];
  /** Host dropdowns to mount once the render has put their placeholders in the tab. */
  private pendingMounts: Array<() => void> = [];

  constructor(private controller: UIController) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  /** The stage moved a model (drag); show the new position on the sliders. */
  layoutChanged(): void {
    this.syncLayout?.();
  }

  /** Re-render from current state (cheap enough for a settings panel). */
  render(): void {
    const root = this.root;
    if (!root) return;
    for (const handle of this.mounted.splice(0)) {
      try {
        handle.destroy();
      } catch {
        /* already gone */
      }
    }
    this.pendingMounts = [];
    root.replaceChildren();
    root.classList.add('l2d-root');
    root.classList.toggle('l2d-hide-help', !this.controller.getSettings().global.showHelp);
    this.controller.syncChatBarButton();
    this.syncLayout = null;

    const controller = this.controller;
    const settings = controller.getSettings();
    const globals = settings.global;

    // ── Permissions banner ──
    const granted = new Set(controller.getPermissions());
    const missing = REQUIRED_PERMS.filter((perm) => !granted.has(perm.id));
    if (missing.length > 0) {
      const banner = el('div', 'l2d-banner');
      banner.appendChild(el('div', 'l2d-banner-title', 'Some features need permissions'));
      for (const perm of missing) {
        banner.appendChild(el('div', 'l2d-banner-line', `• ${perm.id} — ${perm.why}`));
      }
      banner.appendChild(
        button('Grant permissions', () => {
          void controller.requestPermissions(missing.map((perm) => perm.id));
        }),
      );
      root.appendChild(banner);
    }

    // ── Global settings ──
    root.appendChild(
      section('Global', [
        checkbox('Enabled', globals.enabled, (value) => {
          globals.enabled = value;
          controller.saveNow();
          controller.reloadStage();
          controller.syncChatBarButton();
        }),
        checkbox(
          'Show model as chat background',
          globals.backgroundMode,
          (value) => {
            globals.backgroundMode = value;
            controller.saveNow();
            controller.applyBackgroundMode();
          },
          'Draw the model behind the chat messages instead of over them. Taps still reach it through the empty parts of the chat.',
        ),
        checkbox(
          'Follow cursor',
          globals.followCursor,
          (value) => {
            globals.followCursor = value;
            controller.saveDebounced();
          },
          'The model looks toward the mouse pointer.',
        ),
        checkbox(
          'Reply to click messages',
          globals.autoSendInteraction,
          (value) => {
            globals.autoSendInteraction = value;
            controller.saveDebounced();
          },
          'When a click or hit area posts its message, the character answers it right away.',
        ),
        field(
          'Emotion detection',
          select(
            [
              { value: 'llm', label: 'LLM classification' },
              { value: 'native', label: "Lumiverse's expression detection" },
              { value: 'off', label: 'Off' },
            ],
            globals.expressionSource,
            (value) => {
              globals.expressionSource = value as typeof globals.expressionSource;
              controller.saveNow();
            },
          ),
        ),
        help('Each new character message plays the animation mapped to its emotion (Model settings → Emotion mappings).'),
        controller.usingOverlay()
          ? null
          : note('Overlay permission not granted — the avatar renders in the preview box below.'),
        checkbox(
          'Show help text',
          globals.showHelp,
          (value) => {
            globals.showHelp = value;
            controller.saveDebounced();
            root.classList.toggle('l2d-hide-help', !value);
          },
          'The explanations under the settings, like this one.',
        ),
      ]),
    );

    // ── Debug ──
    root.appendChild(
      section('Debug', [
        checkbox('Reset model before animations (force animation)', globals.force_animation, (value) => {
          globals.force_animation = value;
          controller.saveDebounced();
        }),
        checkbox('Force animations to loop', globals.force_loop, (value) => {
          globals.force_loop = value;
          controller.saveDebounced();
        }),
        checkbox('Show model frames & hit areas', globals.showFrames, (value) => {
          globals.showFrames = value;
          controller.saveDebounced();
          controller.stage.setShowFrames(value);
        }),
        checkbox(
          'Reload button in the chat menu bar',
          globals.showReloadButton,
          (value) => {
            globals.showReloadButton = value;
            controller.saveDebounced();
            controller.syncChatBarButton();
          },
          'Adds a button that reloads the Live2D models next to the chat’s other icons, above the message input.',
        ),
        row(button('Reload Live2D', () => controller.reloadStage())),
      ]),
    );

    // ── Embedded preview host ──
    if (!controller.usingOverlay()) {
      controller.embeddedHost.classList.add('l2d-embedded-host');
      root.appendChild(section('Stage preview', [controller.embeddedHost]));
    }

    // ── Character binding ──
    const models = controller.getModels();
    const known = controller.getCharacters();
    const activeCharacterId = controller.getActiveCharacterId();
    // The chat's characters come first, marked, in member order.
    const inChat = controller.stage.getChatContext().characterIds;
    if (activeCharacterId && !inChat.includes(activeCharacterId)) inChat.unshift(activeCharacterId);
    const isGroup = inChat.length > 1;
    const characters = [
      ...inChat.map((id, index) => {
        const name = known.find((character) => character.id === id)?.name;
        const fallback = isGroup ? `Group member ${index + 1}` : 'Current chat character';
        return { id, name: `${name ?? fallback} (in this chat)` };
      }),
      ...known.filter((character) => !inChat.includes(character.id)),
    ];
    // Follow the chat: when it switches, move the selection along unless the
    // user had picked some other character.
    if (activeCharacterId !== this.lastActiveCharacterId) {
      if (activeCharacterId && (!this.selectedCharacterId || this.selectedCharacterId === this.lastActiveCharacterId)) {
        this.selectedCharacterId = activeCharacterId;
      }
      this.lastActiveCharacterId = activeCharacterId;
    }
    if (!characters.some((character) => character.id === this.selectedCharacterId)) {
      this.selectedCharacterId = activeCharacterId ?? characters[0]?.id ?? null;
    }

    const bindingSection = el('div');
    if (characters.length === 0) {
      this.selectedModelId = null;
      bindingSection.appendChild(
        note('Open a chat (or grant the "characters" permission) to assign a model to a character.'),
      );
    } else {
      const characterSelect = this.picker(
        characters.map((character) => ({
          value: character.id,
          label: character.name,
          leading: {
            type: 'image',
            src: `/api/v1/characters/${encodeURIComponent(character.id)}/avatar?size=sm`,
            fallback: { text: initial(character.name) },
          },
        })),
        this.selectedCharacterId ?? characters[0]!.id,
        (value) => {
          this.selectedCharacterId = value;
          this.fileStatusText = '';
          this.render();
        },
        { placeholder: 'Choose a character', searchPlaceholder: 'Search characters…' },
      );
      const boundModelId = this.selectedCharacterId
        ? settings.characterModelMapping[this.selectedCharacterId] ?? 'none'
        : 'none';
      this.selectedModelId = boundModelId === 'none' ? null : boundModelId;
      const modelSelect = this.picker(
        sortModels(models, globals.librarySort).map((model) => ({
          value: model.id,
          label: model.name,
          sublabel: modelSummary(model),
          leading: modelLeading(model),
        })),
        boundModelId,
        (value) => {
          const characterId = this.selectedCharacterId;
          if (!characterId) return;
          if (value === 'none') delete settings.characterModelMapping[characterId];
          else settings.characterModelMapping[characterId] = value;
          controller.saveNow();
          if (this.isOnStage(characterId)) controller.reloadStage();
          this.render();
        },
        { placeholder: 'No model', searchPlaceholder: 'Search models…', noneLabel: 'No model' },
      );
      bindingSection.appendChild(field('Character', characterSelect));
      bindingSection.appendChild(field('Model', modelSelect));
      if (models.length === 0) {
        bindingSection.appendChild(note('Your library is empty: import a model in Model library below first.'));
      }
      if (isGroup) {
        bindingSection.appendChild(
          help(
            'Group chat: every member with a model is shown, starting side by side in equal columns in member order ' +
              '(Live2D and, with the Spine Avatars extension, Spine models). Drag a model anywhere on the screen. ' +
              'Zoom 1 fits the model in its column and Fit to canvas puts it back there; X offset 0 is the middle of its ' +
              'column, -100 and 100 the left and right edges of the screen. Right-click a model (or touch and hold it) ' +
              'to send it to the front or back where models overlap.',
          ),
        );
      }
      const characterName = () =>
        characters.find((character) => character.id === this.selectedCharacterId)?.name.replace(/ \(in this chat\)$/, '') ??
        'Character';
      const fileStatus = el('span', 'l2d-dim', this.fileStatusText);
      fileStatus.setAttribute('role', 'status');
      const exportButton = button('Export settings', () => {
        if (this.selectedCharacterId) controller.exportModelSettings(this.selectedCharacterId, characterName());
      });
      exportButton.disabled = boundModelId === 'none';
      exportButton.title = 'Save this character’s model and animation settings to a file';
      const importButton = button('Import settings', () => {
        const characterId = this.selectedCharacterId;
        if (!characterId) return;
        fileStatus.textContent = '';
        void controller
          .importModelSettings(characterId, characterName())
          .catch((error) => `Import failed: ${String(error)}`)
          .then((status) => {
            if (this.selectedCharacterId !== characterId) return;
            this.fileStatusText = status;
            this.render();
          });
      });
      importButton.title = 'Load model and animation settings for this character from a file';
      const resetButton = button('Reset settings', () => {
        const characterId = this.selectedCharacterId;
        if (!characterId) return;
        void controller
          .confirm({
            title: 'Reset model settings',
            message:
              `Reset ${characterName()}’s settings for every model to the defaults? Position, zoom, ` +
              'animations, emotion mappings and hit areas are all cleared. The model stays assigned.',
            confirmLabel: 'Reset',
          })
          .then((confirmed) => {
            if (!confirmed) return;
            delete settings.characterModelsSettings[characterId];
            controller.saveNow();
            if (this.isOnStage(characterId)) controller.reloadStage();
            this.render();
          });
      });
      resetButton.classList.add('l2d-btn-danger');
      resetButton.title = 'Clear this character’s model settings back to the defaults';
      bindingSection.appendChild(row(exportButton, importButton, resetButton, fileStatus));
    }
    root.appendChild(section('Character model', [bindingSection]));

    // ── Per-model settings (async: needs the model description) ──
    if (this.selectedCharacterId && this.selectedModelId) {
      const host = el('div');
      const status = note('Loading model details…');
      host.appendChild(status);
      root.appendChild(section('Model settings', [host]));
      const characterId = this.selectedCharacterId;
      const modelId = this.selectedModelId;
      const showProgress = () => {
        const progress = controller.getDownloadProgress(modelId);
        if (!progress || progress.totalBytes === 0) return;
        const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
        const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
        status.textContent =
          `Downloading model files… ${percent}% ` +
          `(${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)} MB)`;
      };
      const progressTimer = window.setInterval(() => {
        if (!status.isConnected) window.clearInterval(progressTimer);
        else showProgress();
      }, 500);
      void controller
        .describeModel(modelId)
        .then((description) => {
          if (this.selectedCharacterId !== characterId || this.selectedModelId !== modelId) return;
          host.replaceChildren();
          this.renderModelSettings(host, characterId, modelId, description);
        })
        .catch((error) => {
          host.replaceChildren();
          host.appendChild(note(`Could not load model details: ${String(error)}`));
        })
        .finally(() => window.clearInterval(progressTimer));
    }

    // ── Model library ──
    const library = el('div');
    const libraryList = el('div');
    this.libraryList = libraryList;
    const importStatus = el('span', 'l2d-dim', '');
    importStatus.setAttribute('role', 'status');
    const importButton = button('Import model (.zip)', () => {
      void this.controller.importZip((text) => {
        importStatus.textContent = text;
      });
    });
    importButton.classList.add('l2d-btn-primary');
    importButton.title =
      'Zip the model folder: the *.model3.json or *.model.json file plus its textures, motions and expressions';
    library.appendChild(row(importButton, importStatus));
    if (models.length === 0) {
      library.appendChild(
        note(
          'No models yet. Zip a Live2D model folder (the *.model3.json or *.model.json file plus textures, ' +
            'motions and expressions) and import it.',
        ),
      );
    } else {
      const filter = el('input', 'l2d-input l2d-library-filter');
      filter.type = 'search';
      filter.placeholder = 'Filter models…';
      filter.setAttribute('aria-label', 'Filter models');
      filter.value = this.libraryFilter;
      filter.addEventListener('input', () => {
        this.libraryFilter = filter.value;
        this.renderLibraryList(libraryList);
      });
      const sort = select(SORT_OPTIONS, globals.librarySort, (value) => {
        globals.librarySort = value as LibrarySort;
        controller.saveDebounced();
        this.renderLibraryList(libraryList);
      });
      sort.title = 'Sort models';
      sort.setAttribute('aria-label', 'Sort models');
      const views = el('div', 'l2d-segmented');
      views.setAttribute('role', 'group');
      views.setAttribute('aria-label', 'Library view');
      const viewButtons = (['tiles', 'list'] as const).map((view) => {
        const viewButton = button(view === 'tiles' ? 'Tiles' : 'List', () => {
          globals.libraryView = view;
          controller.saveDebounced();
          for (const other of viewButtons) {
            other.classList.toggle('l2d-active', other === viewButton);
            other.setAttribute('aria-pressed', String(other === viewButton));
          }
          this.renderLibraryList(libraryList);
        });
        const active = libraryView(globals.libraryView) === view;
        viewButton.classList.toggle('l2d-active', active);
        viewButton.setAttribute('aria-pressed', String(active));
        views.appendChild(viewButton);
        return viewButton;
      });
      library.appendChild(row(filter, sort, views));
    }
    library.appendChild(libraryList);
    this.renderLibraryList(libraryList);
    if (models.length > 0) {
      library.appendChild(
        help(
          'A sillytavern_settings.json preset in a model’s folder is applied automatically. ' +
            'A model’s thumbnail is taken the first time it’s shown; the highlighted one is the selected character’s.',
        ),
      );
    }
    root.appendChild(section('Model library', [library]));

    // ── Classification test ──
    const testInput = el('input', 'l2d-input') as HTMLInputElement;
    testInput.type = 'text';
    testInput.placeholder = 'Type a message to classify…';
    testInput.setAttribute('aria-label', 'Message to classify');
    const testResult = el('span', 'l2d-dim', '');
    testResult.setAttribute('role', 'status');
    const classifyButton = button('Classify', () => {
      if (!testInput.value.trim()) {
        testResult.textContent = 'Type a message first.';
        return;
      }
      testResult.textContent = 'Classifying…';
      classifyButton.disabled = true;
      void controller
        .classifyTest(testInput.value)
        .then((label) => {
          testResult.textContent = `Emotion: ${label}`;
        })
        .catch((error) => {
          testResult.textContent = String(error);
        })
        .finally(() => {
          classifyButton.disabled = false;
        });
    });
    testInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') classifyButton.click();
    });
    root.appendChild(
      section(
        'Test emotion classification',
        [row(testInput, classifyButton), testResult],
        { open: false },
      ),
    );


    for (const mount of this.pendingMounts.splice(0)) mount();
  }

  /** Redraw the model library (after a thumbnail changes) without rebuilding the rest of the tab. */
  refreshLibrary(): void {
    if (this.libraryList) this.renderLibraryList(this.libraryList);
  }

  /** The library's models, filtered and sorted, as tiles or a list. */
  private renderLibraryList(host: HTMLElement): void {
    const controller = this.controller;
    const settings = controller.getSettings();
    const models = controller.getModels();
    host.replaceChildren();
    if (models.length === 0) return;
    const needle = this.libraryFilter.trim().toLowerCase();
    const shown = sortModels(
      needle ? models.filter((model) => model.name.toLowerCase().includes(needle)) : models,
      settings.global.librarySort,
    );
    if (shown.length === 0) {
      host.appendChild(note(`No models match “${this.libraryFilter.trim()}”.`));
      return;
    }
    const boundTo = (modelId: string) =>
      Object.values(settings.characterModelMapping).filter((bound) => bound === modelId).length;
    const usedBy = (count: number) => (count ? `used by ${count}` : 'unused');
    const current = this.selectedCharacterId ? settings.characterModelMapping[this.selectedCharacterId] : undefined;
    const remove = (model: ModelRecord, label: string) => {
      const removeButton = button(label, () => {
        void controller.deleteModel(model.id);
      });
      removeButton.classList.add('l2d-btn-danger');
      removeButton.title = `Delete ${model.name}`;
      removeButton.setAttribute('aria-label', `Delete ${model.name}`);
      return removeButton;
    };

    if (libraryView(settings.global.libraryView) === 'tiles') {
      const grid = el('div', 'l2d-tiles');
      for (const model of shown) {
        const tile = el('div', 'l2d-tile');
        tile.dataset.modelId = model.id;
        tile.classList.toggle('l2d-current', model.id === current);
        const used = boundTo(model.id);
        tile.title = `${model.name}\n${modelSummary(model)}${used ? `\nUsed by ${used} character${used === 1 ? '' : 's'}` : ''}`;
        tile.appendChild(thumbnail(model, 'l2d-tile-thumb'));
        tile.appendChild(el('div', 'l2d-tile-name', model.name));
        tile.appendChild(el('div', 'l2d-tile-meta', `${(model.sizeBytes / (1024 * 1024)).toFixed(1)} MB · ${usedBy(used)}`));
        const removeButton = remove(model, '✕');
        removeButton.classList.add('l2d-tile-delete');
        tile.appendChild(removeButton);
        grid.appendChild(tile);
      }
      host.appendChild(grid);
      return;
    }
    for (const model of shown) {
      const megabytes = (model.sizeBytes / (1024 * 1024)).toFixed(1);
      const line = el('div', 'l2d-list-row');
      line.dataset.modelId = model.id;
      line.classList.toggle('l2d-current', model.id === current);
      const text = el('div', 'l2d-list-text');
      text.appendChild(el('div', 'l2d-model-name', model.name));
      text.appendChild(
        el('div', 'l2d-dim', `Cubism ${model.cubism} · ${model.fileCount} files · ${megabytes} MB · ${usedBy(boundTo(model.id))}`),
      );
      line.append(thumbnail(model, 'l2d-list-thumb'), text, remove(model, 'Delete'));
      host.appendChild(line);
    }
  }

  /**
   * A dropdown with a search field. Uses Lumiverse's own dropdown, mounted once
   * the render has placed it in the tab, and a plain select where that's unavailable.
   * A `noneLabel` adds a first option whose value is 'none'.
   */
  private picker(
    options: PickerOption[],
    value: string,
    onChange: (value: string) => void,
    config: { placeholder: string; searchPlaceholder: string; noneLabel?: string },
  ): HTMLElement {
    const fallback = () =>
      select(
        [...(config.noneLabel ? [{ value: 'none', label: config.noneLabel }] : []), ...options],
        value,
        onChange,
      );
    const mount = this.controller.mountSelect;
    if (!mount) return fallback();
    const host = el('div', 'l2d-picker');
    this.pendingMounts.push(() => {
      try {
        this.mounted.push(
          mount(host, {
            options,
            value: value === 'none' ? '' : value,
            clearable: config.noneLabel !== undefined,
            clearLabel: config.noneLabel,
            placeholder: config.placeholder,
            searchPlaceholder: config.searchPlaceholder,
            noResultsMessage: 'No matches',
            searchThreshold: SEARCH_THRESHOLD,
            maxHeight: 360,
            onChange: (next) => onChange(next === '' ? 'none' : next),
          }),
        );
      } catch (error) {
        console.debug('[live2d] host dropdown unavailable:', error);
        host.replaceChildren(fallback());
      }
    });
    return host;
  }

  /** Whether this character is in the chat on stage (its binding changes show there). */
  private isOnStage(characterId: string): boolean {
    return this.controller.stage.getChatContext().characterIds.includes(characterId);
  }

  private renderModelSettings(
    host: HTMLElement,
    characterId: string,
    modelId: string,
    description: ModelDescription,
  ): void {
    const controller = this.controller;
    const stage = controller.stage;
    const modelSettings = controller.getOrCreateModelSettings(characterId, modelId, description);
    const defaults = defaultModelSettings();
    const changed = () => controller.saveDebounced();

    const applyLive = () => {
      if (stage.isOnStage(characterId, modelId)) stage.applyLayoutFor(characterId);
    };
    /** Why buttons that act on the stage can't, or null when the model is on stage. */
    const notLiveReason = (): string | null => {
      if (stage.isOnStage(characterId, modelId)) return null;
      if (!controller.getSettings().global.enabled) return 'Live2D is turned off (Global → Enabled).';
      if (!this.isOnStage(characterId)) return 'Open a chat with this character to see the model on stage.';
      return "The model isn't on stage yet. If it doesn't appear, use Debug → Reload Live2D.";
    };
    /** Run `action` on the live model, or explain on `status` why it can't. */
    const onStage = (status: { say(text: string): void }, action: () => void) => {
      const reason = notLiveReason();
      status.say(reason ?? '');
      if (!reason) action();
    };
    const play = (status: { say(text: string): void }, mapping: { expression: string; motion: string }) =>
      onStage(status, () => {
        void stage.playExpression(characterId, mapping.expression);
        void stage.playMotion(characterId, mapping.motion, true);
      });

    // ── View ──
    const scaleSlider = slider('Zoom', { min: 0.05, max: 3, step: 0.01, unit: '×', reset: defaults.scale }, modelSettings.scale, (value) => {
      modelSettings.scale = value;
      changed();
      applyLive();
    });
    const xSlider = slider('X offset', { min: -100, max: 100, step: 1, unit: '%', reset: 0 }, modelSettings.x, (value) => {
      modelSettings.x = value;
      changed();
      applyLive();
    });
    const ySlider = slider('Y offset', { min: -100, max: 100, step: 1, unit: '%', reset: 0 }, modelSettings.y, (value) => {
      modelSettings.y = value;
      changed();
      applyLive();
    });
    const rotationSlider = slider('Rotation', { min: -180, max: 180, step: 1, unit: '°', reset: 0 }, modelSettings.rotation, (value) => {
      modelSettings.rotation = value;
      changed();
      applyLive();
    });
    this.syncLayout = () => {
      scaleSlider.setValue(modelSettings.scale);
      xSlider.setValue(modelSettings.x);
      ySlider.setValue(modelSettings.y);
    };
    const center = () => {
      modelSettings.x = 0;
      modelSettings.y = 0;
      xSlider.setValue(0);
      ySlider.setValue(0);
    };
    const viewStatus = statusLine();
    const view = el('div');
    const fitButton = button('Fit to canvas', () =>
      onStage(viewStatus, () => {
        const fit = stage.fitScale(characterId, modelId, modelSettings.rotation || 0);
        if (fit === null) {
          viewStatus.say('The stage is hidden or has no size yet. Show it, then try again.');
          return;
        }
        // Round down so the rounded scale still fits.
        modelSettings.scale = Math.min(3, Math.max(0.05, Math.floor(fit * 100) / 100));
        scaleSlider.setValue(modelSettings.scale);
        center();
        changed();
        applyLive();
      }),
    );
    fitButton.title = 'Make the model as large as fits, at its current rotation, and center it';
    const centerButton = button('Center model', () => {
      center();
      viewStatus.say('');
      changed();
      applyLive();
    });
    centerButton.title = 'Set X and Y offset back to 0';
    const thumbButton = button('Update thumbnail', () =>
      onStage(viewStatus, () => {
        viewStatus.say(
          controller.updateThumbnail(characterId, modelId)
            ? 'Thumbnail updated.'
            : 'The stage is hidden or has no size yet. Show it, then try again.',
        );
      }),
    );
    thumbButton.title = 'Take the library thumbnail again from the model as it is now';
    view.appendChild(row(fitButton, centerButton, thumbButton));
    if (stage.getChatContext().characterIds.length > 1 && this.isOnStage(characterId)) {
      // Where models overlap in a group chat, Live2D or Spine.
      const restack = (toFront: boolean) =>
        onStage(viewStatus, () => {
          if (!stage.restack(characterId, toFront)) viewStatus.say(toFront ? 'Already in front.' : 'Already at the back.');
        });
      const front = button('Send to front', () => restack(true));
      front.title = 'Draw this model over the other models in the chat where they overlap';
      const back = button('Send to back', () => restack(false));
      back.title = 'Draw this model under the other models in the chat where they overlap';
      view.appendChild(row(front, back));
    }
    view.appendChild(viewStatus.root);
    view.append(scaleSlider, xSlider, ySlider, rotationSlider);
    view.appendChild(
      checkbox(
        'Hide anything outside the model canvas',
        modelSettings.clip_to_canvas,
        (value) => {
          modelSettings.clip_to_canvas = value;
          changed();
          applyLive();
        },
        'Cuts off backdrops and effects that full-scene models draw past their own edges.',
      ),
    );
    view.appendChild(help('Drag the model on the stage to move it.'));
    host.appendChild(section('View', [view]));

    // ── Animations: starter / default / click ──
    const animationStatus = statusLine();
    const animations = el('div');
    animations.appendChild(animationStatus.root);
    const starterRow = this.animationRow('On chat open', description, modelSettings.animation_starter, animationStatus, play);
    starterRow.appendChild(
      slider(
        'Delay before it plays',
        { min: 0, max: 10000, step: 100, unit: 'ms', reset: 0 },
        modelSettings.animation_starter.delay ?? 0,
        (value) => {
          modelSettings.animation_starter.delay = value;
          changed();
        },
      ),
    );
    animations.appendChild(starterRow);
    const defaultRow = this.animationRow('Default', description, modelSettings.animation_default, animationStatus, play);
    defaultRow.appendChild(
      checkbox(
        'Loop the default animation',
        modelSettings.animation_default.loop,
        (value) => {
          modelSettings.animation_default.loop = value;
          changed();
        },
        'The default motion replaces the model’s idle motion and the default expression stays on. ' +
          'Chat-open, click and emotion animations play once, then the default comes back.',
      ),
    );
    animations.appendChild(defaultRow);

    const clickRow = this.animationRow('On click', description, modelSettings.animation_click, animationStatus, play);
    const clickMessage = el('input', 'l2d-input') as HTMLInputElement;
    clickMessage.type = 'text';
    clickMessage.placeholder = 'Optional';
    clickMessage.value = modelSettings.animation_click.message;
    clickMessage.addEventListener('change', () => {
      modelSettings.animation_click.message = clickMessage.value;
      changed();
    });
    clickRow.appendChild(field('Message', clickMessage));
    clickRow.appendChild(help('Plays when you click the model outside its hit areas. The message, if any, is posted to the chat.'));
    animations.appendChild(clickRow);
    host.appendChild(section('Animations', [animations]));

    // ── Emotion (classify) mappings, built again when hit areas change (their taps are motion options) ──
    const emotionStatus = statusLine();
    const classify = el('div');
    const grid = el('div', 'l2d-mapping-grid');
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', 'Emotion mappings');
    const renderClassify = () => {
      grid.replaceChildren();
      const head = el('div', 'l2d-mapping-head');
      head.setAttribute('role', 'row');
      for (const title of ['Emotion', 'Expression', 'Motion', '']) {
        const cell = el('span', undefined, title);
        cell.setAttribute('role', 'columnheader');
        head.appendChild(cell);
      }
      grid.appendChild(head);
      for (const label of CLASSIFY_EXPRESSIONS) {
        const mapping = modelSettings.classify_mapping[label]!;
        const line = el('div', 'l2d-mapping-row');
        line.setAttribute('role', 'row');
        const mark = () => line.classList.toggle('l2d-unset', mapping.expression === 'none' && mapping.motion === 'none');
        const expression = select(expressionOptions(description), mapping.expression, (value) => {
          mapping.expression = value;
          changed();
          mark();
        });
        expression.setAttribute('aria-label', `Expression for ${label}`);
        const motion = select(emotionMotionOptions(description, modelSettings), mapping.motion, (value) => {
          mapping.motion = value;
          changed();
          mark();
        });
        motion.setAttribute('aria-label', `Motion for ${label}`);
        line.append(
          el('span', 'l2d-emotion', label),
          expression,
          motion,
          iconButton('▶', `Play ${label} animation`, () => play(emotionStatus, stage.expandTap(characterId, mapping))),
        );
        mark();
        grid.appendChild(line);
      }
    };
    renderClassify();
    classify.append(emotionStatus.root, grid);
    classify.appendChild(
      help(
        'A new character message plays the expression and motion mapped to its emotion. Dimmed rows play nothing. ' +
          'A motion can also be one of the model’s taps: it plays what that tap is set to in Hit areas ' +
          '(its motion, and its expression unless the emotion has one), without sending the tap’s message.',
      ),
    );
    host.appendChild(section('Emotion mappings', [classify], { open: false }));

    // ── Hit areas ──
    const hitBody = el('div');
    this.renderHitAreas(hitBody, characterId, modelId, description, modelSettings, renderClassify);
    host.appendChild(section('Hit areas', [hitBody], { open: false, className: 'l2d-hit-areas' }));

    // ── Talking mouth animation ──
    const mouth = el('div');
    mouth.appendChild(
      field(
        'Mouth open parameter',
        select(parameterOptions(description), modelSettings.param_mouth_open_y_id, (value) => {
          modelSettings.param_mouth_open_y_id = value;
          changed();
        }),
      ),
    );
    mouth.appendChild(
      slider('Mouth open speed', { min: 0.1, max: 3, step: 0.1, unit: '×', reset: defaults.mouth_open_speed }, modelSettings.mouth_open_speed, (value) => {
        modelSettings.mouth_open_speed = value;
        changed();
      }),
    );
    mouth.appendChild(
      slider(
        'Talk time per character',
        { min: 0, max: 100, step: 1, unit: 'ms', reset: defaults.mouth_time_per_character },
        modelSettings.mouth_time_per_character,
        (value) => {
          modelSettings.mouth_time_per_character = value;
          changed();
        },
      ),
    );
    host.appendChild(section('Talking mouth animation', [mouth], { open: false }));

    // ── Cursor tracking ──
    const cursor = el('div');
    cursor.appendChild(
      slider('Eye follow offset', { min: -100, max: 100, step: 1, reset: defaults.eye }, modelSettings.eye, (value) => {
        modelSettings.eye = value;
        changed();
        applyLive();
      }),
    );
    for (const paramId of CURSOR_PARAM_IDS) {
      cursor.appendChild(
        field(
          paramId.replace(/^idParam/, ''),
          select(parameterOptions(description), modelSettings.cursor_param[paramId] ?? 'none', (value) => {
            modelSettings.cursor_param[paramId] = value;
            changed();
            applyLive();
          }),
        ),
      );
    }
    cursor.appendChild(
      help('The parameters the model turns toward the cursor (Global → Follow cursor). Auto-detected on first load when the model uses standard names.'),
    );
    host.appendChild(section('Cursor tracking', [cursor], { open: false }));
  }

  /**
   * What a tap on each hit area plays: the model file's areas, and areas the
   * user draws on the model themselves (most models from games define none).
   */
  private renderHitAreas(
    host: HTMLElement,
    characterId: string,
    modelId: string,
    description: ModelDescription,
    modelSettings: ModelSettings,
    areasChanged: () => void,
  ): void {
    const controller = this.controller;
    const stage = controller.stage;
    const rerender = () => {
      host.replaceChildren();
      this.renderHitAreas(host, characterId, modelId, description, modelSettings, areasChanged);
      areasChanged();
    };
    const hint = el('span', 'l2d-dim', '');
    hint.setAttribute('role', 'status');
    const play = (mapping: { expression: string; motion: string }) => {
      if (!stage.isOnStage(characterId, modelId)) {
        hint.textContent = 'Show the model first, then try again.';
        return;
      }
      void stage.playExpression(characterId, mapping.expression);
      void stage.playMotion(characterId, mapping.motion, true);
    };
    const modelAreas = description.hitAreas;
    const custom = modelSettings.custom_hit_areas;
    const taken = (name: string) => modelAreas.includes(name) || custom.some((area) => area.name === name);

    host.appendChild(
      checkbox('Show hit areas on the model', modelSettings.show_hit_areas, (value) => {
        modelSettings.show_hit_areas = value;
        controller.saveDebounced();
      }),
    );
    host.appendChild(
      help(
        'Tap a hit area on the model to play what it’s set to. Where areas overlap, the smallest one wins; ' +
          'a tap anywhere else on the model plays the “On click” animation.',
      ),
    );

    /** One area: its name and buttons on top, then what it plays and the message it posts. */
    const card = (name: HTMLElement, area: string, actions: HTMLElement[]) => {
      const mapping = (modelSettings.hit_areas[area] ??= { expression: 'none', motion: 'none', message: '' });
      const message = el('input', 'l2d-input') as HTMLInputElement;
      message.type = 'text';
      message.placeholder = 'Message (optional)';
      message.title = 'Message posted to the chat when this area is tapped';
      message.setAttribute('aria-label', `Message for ${area}`);
      message.value = mapping.message;
      message.addEventListener('change', () => {
        mapping.message = message.value;
        controller.saveDebounced();
      });
      const expression = select(expressionOptions(description), mapping.expression, (value) => {
        mapping.expression = value;
        controller.saveDebounced();
      });
      expression.title = 'Expression';
      expression.setAttribute('aria-label', `Expression for ${area}`);
      const motion = select(motionOptions(description), mapping.motion, (value) => {
        mapping.motion = value;
        controller.saveDebounced();
      });
      motion.title = 'Motion';
      motion.setAttribute('aria-label', `Motion for ${area}`);
      const wrap = el('div', 'l2d-mapping');
      const top = el('div', 'l2d-mapping-top');
      top.append(name, iconButton('▶', `Play ${area}`, () => play(mapping)), ...actions);
      const choices = el('div', 'l2d-mapping-choices');
      choices.append(expression, motion);
      wrap.append(top, choices, message);
      return wrap;
    };

    /** Let the user drag out an area on the model; `done` gets the rectangle (fractions of the model canvas). */
    const draw = (name: string, done: (rect: CustomHitArea) => void) => {
      const drawingHint = `Drag on the model to draw “${name}”. Esc cancels.`;
      if (!stage.isOnStage(characterId, modelId)) {
        hint.textContent = 'Show the model first, then try again.';
        return;
      }
      let watch = 0;
      let cancel: HTMLButtonElement | null = null;
      const started = stage.startDrawing(characterId, (rect) => {
        window.clearInterval(watch);
        cancel?.remove();
        if (!rect) {
          if (hint.textContent === drawingHint) hint.textContent = 'Drawing cancelled.';
          return;
        }
        done(rect);
      });
      if (!started) {
        hint.textContent = 'Show the model first, then try again.';
        return;
      }
      hint.textContent = drawingHint;
      cancel = button('Cancel', () => stage.cancelDrawing());
      hint.after(cancel);
      // Stop drawing once this tab is closed, so a later tap on the model isn't taken for a drawing.
      watch = window.setInterval(() => {
        if (!hint.isConnected || hint.offsetParent === null) stage.cancelDrawing();
      }, 500);
    };

    if (modelAreas.length > 0) {
      host.appendChild(el('div', 'l2d-anim-title', description.hitAreasDetected ? 'Found in the model' : 'From the model file'));
      if (description.hitAreasDetected) {
        host.appendChild(
          help(
            'The model’s file lists no hit areas, but the model has art meshes named like them (Touch…, HitArea…), ' +
              'as models from games often do. These follow the model’s animation.',
          ),
        );
      }
      for (const area of modelAreas) {
        host.appendChild(card(el('span', 'l2d-mapping-name', area), area, []));
      }
    } else {
      host.appendChild(note('This model’s file defines no hit areas. Draw your own below.'));
    }

    if (custom.length > 0) host.appendChild(el('div', 'l2d-anim-title', 'Drawn on the model'));
    for (const area of custom) {
      const name = el('input', 'l2d-input l2d-area-name') as HTMLInputElement;
      name.type = 'text';
      name.value = area.name;
      name.title = 'Area name';
      name.setAttribute('aria-label', 'Area name');
      name.addEventListener('change', () => {
        const next = name.value.trim().slice(0, 64);
        if (next === area.name) return;
        if (!next || taken(next)) {
          hint.textContent = next ? `There’s already an area called “${next}”.` : 'An area needs a name.';
          name.value = area.name;
          return;
        }
        const mapping = modelSettings.hit_areas[area.name];
        if (!modelAreas.includes(area.name)) delete modelSettings.hit_areas[area.name];
        if (mapping) modelSettings.hit_areas[next] = mapping;
        // Emotions set to tap this area tap it under its new name.
        for (const emotion of Object.values(modelSettings.classify_mapping)) {
          if (emotion.motion === tapMotion(area.name)) emotion.motion = tapMotion(next);
        }
        area.name = next;
        controller.saveDebounced();
        rerender();
      });
      const redraw = button('Redraw', () =>
        draw(area.name, (rect) => {
          Object.assign(area, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          controller.saveDebounced();
          hint.textContent = `Redrew “${area.name}”.`;
        }),
      );
      redraw.title = 'Drag a new rectangle for this area on the model';
      const remove = iconButton('✕', `Delete ${area.name}`, () => {
        const index = custom.indexOf(area);
        if (index !== -1) custom.splice(index, 1);
        if (!modelAreas.includes(area.name)) delete modelSettings.hit_areas[area.name];
        controller.saveDebounced();
        rerender();
      });
      remove.classList.add('l2d-btn-danger');
      host.appendChild(card(name, area.name, [redraw, remove]));
    }

    const newName = el('input', 'l2d-input l2d-area-name') as HTMLInputElement;
    newName.type = 'text';
    newName.placeholder = 'New area, e.g. Head';
    newName.setAttribute('aria-label', 'New area name');
    const add = button('Add area', () => {
      const name = newName.value.trim().slice(0, 64);
      if (!name) {
        hint.textContent = 'Name the area first.';
        return;
      }
      if (taken(name)) {
        hint.textContent = `There’s already an area called “${name}”.`;
        return;
      }
      draw(name, (rect) => {
        if (taken(name)) return;
        custom.push({ ...rect, name });
        const mapping = modelSettings.hit_areas[name];
        if (!mapping || (mapping.expression === 'none' && mapping.motion === 'none' && !mapping.message)) {
          modelSettings.hit_areas[name] = {
            expression: 'none',
            motion: suggestAreaMotion(name, description.motions),
            message: mapping?.message ?? '',
          };
        }
        // Show what was drawn.
        modelSettings.show_hit_areas = true;
        controller.saveDebounced();
        rerender();
      });
    });
    add.title = 'Name the area, then drag a rectangle over that part of the model';
    newName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') add.click();
    });
    const suggest = button('Use the model’s tap motions', () => {
      const names = [...modelAreas, ...custom.map((area) => area.name)];
      const count = applyTapMotions(modelSettings, names, description.motions);
      if (count === 0) {
        hint.textContent = 'No tap motions to add: the model has none named for these areas, or they’re already set.';
        return;
      }
      controller.saveDebounced();
      rerender();
    });
    suggest.title = 'Set areas (and “On click”) that play nothing yet to the model’s motion groups named for tapping them, like “Tap”, “TapHead” or “touch_body”';
    host.appendChild(row(newName, add));
    host.appendChild(row(suggest));
    host.appendChild(row(hint));
  }

  /** An animation's title with a play button, then its expression and motion. */
  private animationRow(
    label: string,
    description: ModelDescription,
    mapping: { expression: string; motion: string },
    status: { say(text: string): void },
    play: (status: { say(text: string): void }, mapping: { expression: string; motion: string }) => void,
  ): HTMLDivElement {
    const controller = this.controller;
    const wrap = el('div', 'l2d-anim');
    const title = el('div', 'l2d-anim-head');
    title.append(el('span', 'l2d-anim-title', label), iconButton('▶', `Play ${label} animation`, () => play(status, mapping)));
    wrap.appendChild(title);
    wrap.appendChild(
      field(
        'Expression',
        select(expressionOptions(description), mapping.expression, (value) => {
          mapping.expression = value;
          controller.saveDebounced();
        }),
      ),
    );
    wrap.appendChild(
      field(
        'Motion',
        select(motionOptions(description), mapping.motion, (value) => {
          mapping.motion = value;
          controller.saveDebounced();
        }),
      ),
    );
    return wrap;
  }
}

export const UI_CSS = `
.l2d-root { padding: 10px 12px; color: var(--lumiverse-text); font-size: 13px; container-type: inline-size; }
.l2d-section { margin-bottom: 10px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 0 10px; background: var(--lumiverse-fill-subtle); }
.l2d-section[open] { padding-bottom: 8px; }
.l2d-section .l2d-section { margin: 8px 0 0; background: transparent; }
.l2d-section-title { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; padding: 8px 0; color: var(--lumiverse-text); list-style: none; user-select: none; }
.l2d-section-title::-webkit-details-marker { display: none; }
.l2d-section-title::before { content: ''; flex: none; width: 6px; height: 6px; margin: 0 3px 0 1px; border-right: 1.5px solid var(--lumiverse-text-dim); border-bottom: 1.5px solid var(--lumiverse-text-dim); transform: rotate(-45deg); transition: transform var(--lumiverse-transition-fast, 0.15s); }
.l2d-section[open] > .l2d-section-title::before { transform: rotate(45deg); }
.l2d-section-title:hover::before { border-color: var(--lumiverse-text); }
.l2d-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 6px 0; }
.l2d-field { display: grid; grid-template-columns: minmax(72px, 34%) minmax(0, 1fr); align-items: center; gap: 8px; margin: 6px 0; }
.l2d-field-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
.l2d-field-control > .l2d-select, .l2d-field-control > .l2d-input, .l2d-field-control > .l2d-picker { flex: 1; min-width: 0; max-width: none; width: 100%; }
.l2d-label { color: var(--lumiverse-text-muted); }
.l2d-note { color: var(--lumiverse-text-dim); font-size: 12px; line-height: 1.45; margin: 6px 0; }
.l2d-dim { color: var(--lumiverse-text-dim); font-size: 12px; }
.l2d-dim:empty { display: none; }
.l2d-btn { padding: 4px 10px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; font: inherit; line-height: 1.4; }
.l2d-btn:hover:not(:disabled) { border-color: var(--lumiverse-border-hover); background: var(--lumiverse-fill-hover, var(--lumiverse-fill)); }
.l2d-btn:focus-visible, .l2d-select:focus-visible, .l2d-input:focus-visible, .l2d-number:focus-visible, .l2d-section-title:focus-visible { outline: 2px solid var(--lumiverse-primary, var(--lumiverse-accent)); outline-offset: 1px; }
.l2d-btn-primary { border-color: var(--lumiverse-primary, var(--lumiverse-accent)); }
.l2d-btn-danger:hover:not(:disabled) { border-color: var(--lumiverse-danger, #e5484d); color: var(--lumiverse-danger, #e5484d); }
.l2d-icon-btn { flex: none; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.l2d-icon-btn[hidden] { display: none; }
.l2d-check { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0; cursor: pointer; }
.l2d-check input { margin: 2px 0 0; flex: none; accent-color: var(--lumiverse-primary, var(--lumiverse-accent)); }
.l2d-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.l2d-hint { color: var(--lumiverse-text-dim); font-size: 12px; line-height: 1.4; }
.l2d-hide-help .l2d-help, .l2d-hide-help .l2d-hint { display: none; }
.l2d-select { max-width: 100%; min-width: 0; padding: 4px 6px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; text-overflow: ellipsis; }
.l2d-input { flex: 1; min-width: 120px; padding: 4px 8px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
.l2d-slider { margin: 6px 0 2px; }
.l2d-slider-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--lumiverse-text-muted); min-height: 28px; }
.l2d-slider-value { display: inline-flex; align-items: center; gap: 4px; color: var(--lumiverse-text); }
.l2d-number { width: 64px; padding: 2px 6px; border-radius: var(--lumiverse-radius); border: 1px solid transparent; background: transparent; color: var(--lumiverse-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; -moz-appearance: textfield; }
.l2d-number::-webkit-inner-spin-button, .l2d-number::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.l2d-number:hover, .l2d-number:focus { border-color: var(--lumiverse-border); background: var(--lumiverse-fill); }
.l2d-unit { color: var(--lumiverse-text-dim); min-width: 1ch; }
.l2d-slider-value .l2d-icon-btn { width: 24px; height: 24px; font-size: 13px; }
.l2d-range { display: block; width: 100%; margin: 0; }
@media (pointer: fine) { .l2d-root input.l2d-range { min-height: 24px; } }
.l2d-root input.l2d-range::-webkit-slider-runnable-track { background: linear-gradient(to right, var(--lumiverse-primary, var(--lumiverse-accent)) var(--l2d-fill, 0%), var(--lumiverse-border) var(--l2d-fill, 0%)); }
.l2d-root input.l2d-range::-moz-range-track { background: var(--lumiverse-border); }
.l2d-root input.l2d-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--lumiverse-primary, var(--lumiverse-accent)); }
@media (pointer: fine) { .l2d-root input.l2d-range::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -6px; } .l2d-root input.l2d-range::-moz-range-thumb { width: 16px; height: 16px; } }
.l2d-emotion { color: var(--lumiverse-text-muted); }
.l2d-input.l2d-area-name { flex: 1 1 100px; min-width: 80px; }
.l2d-model-name { font-weight: 600; }
.l2d-anim { border-top: 1px solid var(--lumiverse-border); padding-top: 4px; margin-top: 8px; }
.l2d-anim:first-of-type { border-top: none; margin-top: 0; }
.l2d-anim-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.l2d-anim-title { font-weight: 600; color: var(--lumiverse-text-muted); margin-top: 6px; }
.l2d-anim-head .l2d-anim-title { margin: 0; }
.l2d-mapping-grid { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) auto; gap: 4px 6px; align-items: center; margin: 6px 0; }
.l2d-mapping-head, .l2d-mapping-row { display: contents; }
.l2d-mapping-head > span { color: var(--lumiverse-text-dim); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l2d-mapping-row > .l2d-select { width: 100%; font-size: 12px; }
.l2d-mapping-row.l2d-unset > .l2d-emotion, .l2d-mapping-row.l2d-unset > .l2d-select { opacity: 0.55; }
.l2d-mapping { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; margin: 6px 0; display: flex; flex-direction: column; gap: 6px; }
.l2d-mapping-top { display: flex; align-items: center; gap: 6px; }
.l2d-mapping-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l2d-mapping-choices { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
.l2d-mapping-choices > .l2d-select { width: 100%; }
.l2d-mapping > .l2d-input { min-width: 0; }
.l2d-banner { border: 1px solid var(--lumiverse-primary, var(--lumiverse-accent)); border-radius: var(--lumiverse-radius); padding: 8px 10px; margin-bottom: 10px; }
.l2d-banner-title { font-weight: 600; margin-bottom: 4px; }
.l2d-banner-line { color: var(--lumiverse-text-muted); font-size: 12px; margin: 2px 0 6px; }
.l2d-segmented { display: inline-flex; }
.l2d-segmented .l2d-btn { border-radius: 0; }
.l2d-segmented .l2d-btn:first-child { border-radius: var(--lumiverse-radius) 0 0 var(--lumiverse-radius); }
.l2d-segmented .l2d-btn:last-child { border-radius: 0 var(--lumiverse-radius) var(--lumiverse-radius) 0; margin-left: -1px; }
.l2d-btn.l2d-active { background: var(--lumiverse-fill-hover, var(--lumiverse-fill)); border-color: var(--lumiverse-primary, var(--lumiverse-accent)); position: relative; }
.l2d-btn:disabled { opacity: 0.5; cursor: default; }
.l2d-library-filter { min-width: 120px; }
.l2d-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; margin: 8px 0; }
.l2d-tile { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 4px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); }
.l2d-tile.l2d-current, .l2d-list-row.l2d-current { border-color: var(--lumiverse-primary, var(--lumiverse-accent)); box-shadow: 0 0 0 1px var(--lumiverse-primary, var(--lumiverse-accent)); }
.l2d-tile-delete { position: absolute; top: 6px; right: 6px; padding: 0 6px !important; font-size: 11px; line-height: 18px; opacity: 0.55; }
.l2d-tile:hover .l2d-tile-delete, .l2d-tile-delete:focus-visible { opacity: 1; }
.l2d-tile-meta { color: var(--lumiverse-text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l2d-tile-thumb { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); }
.l2d-tile-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l2d-list-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; padding: 4px; border: 1px solid transparent; border-radius: var(--lumiverse-radius); }
.l2d-list-text { flex: 1; min-width: 0; }
.l2d-list-text > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l2d-list-thumb { width: 32px; height: 32px; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); flex: none; }
.l2d-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--lumiverse-text-dim); font-weight: 600; font-size: 20px; }
.l2d-list-thumb.l2d-thumb-empty { font-size: 14px; }
.l2d-picker { flex: 1; min-width: 160px; max-width: 360px; }
.l2d-embedded-host { position: relative; width: 100%; height: 420px; overflow: hidden; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); }
@container (max-width: 300px) {
  .l2d-field { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .l2d-mapping-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
  .l2d-mapping-head > span:first-child { display: none; }
  .l2d-mapping-row > .l2d-emotion { grid-column: 1 / -1; margin-top: 4px; }
}
`;
