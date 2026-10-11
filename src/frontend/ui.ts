/**
 * Settings UI rendered into the extension's drawer tab. Mirrors the
 * SillyTavern Live2d extension's window.html controls: global toggles, model
 * library management, character↔model binding, model layout, mouth/cursor
 * parameters, animation mappings, emotion (classify) mappings, and hit areas.
 */

import type { ModelDescription, Stage } from './stage';
import {
  CLASSIFY_EXPRESSIONS,
  CURSOR_PARAM_IDS,
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
}

const REQUIRED_PERMS: Array<{ id: string; why: string }> = [
  { id: 'app_manipulation', why: 'show the avatar over the app (otherwise it renders inside this tab)' },
  { id: 'generation', why: 'classify message emotions with the LLM' },
  { id: 'chat_mutation', why: 'read messages for emotion/talking and send hit-area interaction messages' },
  { id: 'chats', why: 'know which character the active chat belongs to' },
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

function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLLabelElement {
  const wrap = el('label', 'l2d-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el('span', undefined, label));
  return wrap;
}

function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el('select', 'l2d-select');
  for (const option of options) {
    const opt = el('option', undefined, option.label);
    opt.value = option.value;
    node.appendChild(opt);
  }
  node.value = value;
  if (node.value !== value) node.selectedIndex = 0;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (value: number) => void,
): HTMLDivElement & { setValue(value: number): void } {
  const wrap = Object.assign(el('div', 'l2d-slider'), {
    /** Show a value set from code, without calling onInput. */
    setValue(next: number) {
      input.value = String(next);
      valueSpan.textContent = input.value;
    },
  });
  const head = el('div', 'l2d-slider-head');
  head.appendChild(el('span', undefined, label));
  const valueSpan = el('span', 'l2d-slider-value', String(value));
  head.appendChild(valueSpan);
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    valueSpan.textContent = input.value;
    onInput(Number(input.value));
  });
  wrap.appendChild(head);
  wrap.appendChild(input);
  return wrap;
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const wrap = el('details', 'l2d-section') as unknown as HTMLDetailsElement;
  wrap.open = true;
  const summary = el('summary', 'l2d-section-title', title);
  wrap.appendChild(summary);
  for (const child of children) if (child) wrap.appendChild(child);
  return wrap;
}

function row(...children: (HTMLElement | string)[]): HTMLDivElement {
  const wrap = el('div', 'l2d-row');
  for (const child of children) {
    wrap.appendChild(typeof child === 'string' ? el('span', 'l2d-label', child) : child);
  }
  return wrap;
}

function note(text: string): HTMLParagraphElement {
  return el('p', 'l2d-note', text);
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
  private selectedModelId: string | null = null;

  constructor(private controller: UIController) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  /** Re-render from current state (cheap enough for a settings panel). */
  render(): void {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    root.classList.add('l2d-root');

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
      section(
        'Global',
        checkbox('Enabled', globals.enabled, (value) => {
          globals.enabled = value;
          controller.saveNow();
          controller.reloadStage();
        }),
        checkbox('Follow cursor', globals.followCursor, (value) => {
          globals.followCursor = value;
          controller.saveDebounced();
        }),
        checkbox('Show model as chat background', globals.backgroundMode, (value) => {
          globals.backgroundMode = value;
          controller.saveNow();
          controller.applyBackgroundMode();
        }),
        checkbox('Auto-send interaction', globals.autoSendInteraction, (value) => {
          globals.autoSendInteraction = value;
          controller.saveDebounced();
        }),
        row(
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
        controller.usingOverlay()
          ? null
          : note('Overlay permission not granted — the avatar renders in the preview box below.'),
      ),
    );

    // ── Debug ──
    root.appendChild(
      section(
        'Debug',
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
        row(
          button('Reload Live2D', () => controller.reloadStage()),
        ),
      ),
    );

    // ── Embedded preview host ──
    if (!controller.usingOverlay()) {
      const preview = section('Stage preview');
      controller.embeddedHost.classList.add('l2d-embedded-host');
      preview.appendChild(controller.embeddedHost);
      root.appendChild(preview);
    }

    // ── Model library ──
    const library = el('div');
    const models = controller.getModels();
    if (models.length === 0) {
      library.appendChild(note('No models imported yet. Import a Live2D model folder as a .zip archive.'));
    }
    for (const model of models) {
      const megabytes = (model.sizeBytes / (1024 * 1024)).toFixed(1);
      const line = row(
        el('span', 'l2d-model-name', `${model.name}`),
        el('span', 'l2d-dim', `Cubism ${model.cubism} · ${model.fileCount} files · ${megabytes} MB`),
        button('Delete', () => {
          void controller.deleteModel(model.id);
        }),
      );
      library.appendChild(line);
    }
    const importStatus = el('span', 'l2d-dim', '');
    library.appendChild(
      row(
        button('Import model (.zip)', () => {
          void this.controller.importZip((text) => {
            importStatus.textContent = text;
          });
        }),
        importStatus,
      ),
    );
    library.appendChild(
      note(
        'Zip the model folder (the *.model3.json or *.model.json file plus textures, motions and expressions). ' +
          'A sillytavern_settings.json preset in the folder is applied automatically.',
      ),
    );
    root.appendChild(section('Model library', library));

    // ── Character binding ──
    const characters = [...controller.getCharacters()];
    const activeCharacterId = controller.getActiveCharacterId();
    if (activeCharacterId && !characters.some((character) => character.id === activeCharacterId)) {
      characters.unshift({ id: activeCharacterId, name: 'Current chat character' });
    }
    if (!this.selectedCharacterId && activeCharacterId) this.selectedCharacterId = activeCharacterId;
    if (!this.selectedCharacterId && characters.length > 0) this.selectedCharacterId = characters[0]!.id;

    const bindingSection = el('div');
    if (characters.length === 0) {
      bindingSection.appendChild(
        note('Open a chat (or grant the "characters" permission) to assign a model to a character.'),
      );
    } else {
      const characterSelect = select(
        characters.map((character) => ({ value: character.id, label: character.name })),
        this.selectedCharacterId ?? characters[0]!.id,
        (value) => {
          this.selectedCharacterId = value;
          this.render();
        },
      );
      const boundModelId = this.selectedCharacterId
        ? settings.characterModelMapping[this.selectedCharacterId] ?? 'none'
        : 'none';
      this.selectedModelId = boundModelId === 'none' ? null : boundModelId;
      const modelSelect = select(
        [
          { value: 'none', label: 'No model' },
          ...models.map((model) => ({ value: model.id, label: model.name })),
        ],
        boundModelId,
        (value) => {
          const characterId = this.selectedCharacterId;
          if (!characterId) return;
          if (value === 'none') delete settings.characterModelMapping[characterId];
          else settings.characterModelMapping[characterId] = value;
          controller.saveNow();
          controller.reloadStage();
          this.render();
        },
      );
      bindingSection.appendChild(row('Character', characterSelect));
      bindingSection.appendChild(row('Model', modelSelect));
      bindingSection.appendChild(
        row(
          button('Clear model settings for this character', () => {
            const characterId = this.selectedCharacterId;
            if (!characterId) return;
            delete settings.characterModelsSettings[characterId];
            controller.saveNow();
            controller.reloadStage();
            this.render();
          }),
        ),
      );
    }
    root.appendChild(section('Character model', bindingSection));

    // ── Per-model settings (async: needs the model description) ──
    if (this.selectedCharacterId && this.selectedModelId) {
      const host = el('div');
      const status = note('Loading model details…');
      host.appendChild(status);
      root.appendChild(section('Model settings', host));
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

    // ── Classification test ──
    const testInput = el('input', 'l2d-input') as HTMLInputElement;
    testInput.type = 'text';
    testInput.placeholder = 'Type a message to classify…';
    const testResult = el('span', 'l2d-dim', '');
    root.appendChild(
      section(
        'Test emotion classification',
        row(
          testInput,
          button('Classify', () => {
            testResult.textContent = '…';
            void controller
              .classifyTest(testInput.value)
              .then((label) => {
                testResult.textContent = `→ ${label}`;
              })
              .catch((error) => {
                testResult.textContent = String(error);
              });
          }),
          testResult,
        ),
      ),
    );
  }

  private renderModelSettings(
    host: HTMLElement,
    characterId: string,
    modelId: string,
    description: ModelDescription,
  ): void {
    const controller = this.controller;
    const modelSettings = controller.getOrCreateModelSettings(characterId, modelId, description);

    const applyLive = () => {
      const current = controller.stage.currentModel();
      if (current && current.characterId === characterId && current.modelId === modelId) {
        controller.stage.applyLayout();
        controller.stage.applyCursorParams();
      }
    };

    // Layout sliders
    const scaleSlider = slider('Scale', 0.05, 3, 0.01, modelSettings.scale, (value) => {
      modelSettings.scale = value;
      controller.saveDebounced();
      applyLive();
    });
    const xSlider = slider('X offset (%)', -100, 100, 1, modelSettings.x, (value) => {
      modelSettings.x = value;
      controller.saveDebounced();
      applyLive();
    });
    const ySlider = slider('Y offset (%)', -100, 100, 1, modelSettings.y, (value) => {
      modelSettings.y = value;
      controller.saveDebounced();
      applyLive();
    });
    const center = () => {
      modelSettings.x = 0;
      modelSettings.y = 0;
      xSlider.setValue(0);
      ySlider.setValue(0);
    };
    const fitHint = el('span', 'l2d-dim', '');
    host.appendChild(
      row(
        button('Fit to canvas', () => {
          const fit = controller.stage.fitScale(description, modelSettings.rotation || 0);
          if (fit === null) {
            fitHint.textContent = 'Show the model first, then try again.';
            return;
          }
          fitHint.textContent = '';
          // Round down so the rounded scale still fits.
          modelSettings.scale = Math.min(3, Math.max(0.05, Math.floor(fit * 100) / 100));
          scaleSlider.setValue(modelSettings.scale);
          center();
          controller.saveDebounced();
          applyLive();
        }),
        button('Center model', () => {
          center();
          controller.saveDebounced();
          applyLive();
        }),
        fitHint,
      ),
    );
    host.appendChild(scaleSlider);
    host.appendChild(xSlider);
    host.appendChild(ySlider);
    host.appendChild(
      slider('Rotation (°)', -180, 180, 1, modelSettings.rotation, (value) => {
        modelSettings.rotation = value;
        controller.saveDebounced();
        applyLive();
      }),
    );
    host.appendChild(
      checkbox('Hide anything outside the model canvas', modelSettings.clip_to_canvas, (value) => {
        modelSettings.clip_to_canvas = value;
        controller.saveDebounced();
        applyLive();
      }),
    );
    host.appendChild(
      slider('Eye follow offset', -100, 100, 1, modelSettings.eye, (value) => {
        modelSettings.eye = value;
        controller.saveDebounced();
        applyLive();
      }),
    );

    // Mouth animation
    const mouth = el('div');
    mouth.appendChild(
      row(
        'Mouth open parameter',
        select(parameterOptions(description), modelSettings.param_mouth_open_y_id, (value) => {
          modelSettings.param_mouth_open_y_id = value;
          controller.saveDebounced();
        }),
      ),
    );
    mouth.appendChild(
      slider('Mouth open speed', 0.1, 3, 0.1, modelSettings.mouth_open_speed, (value) => {
        modelSettings.mouth_open_speed = value;
        controller.saveDebounced();
      }),
    );
    mouth.appendChild(
      slider('Talk time per character (ms)', 0, 100, 1, modelSettings.mouth_time_per_character, (value) => {
        modelSettings.mouth_time_per_character = value;
        controller.saveDebounced();
      }),
    );
    host.appendChild(section('Talking mouth animation', mouth));

    // Cursor tracking parameters
    const cursor = el('div');
    for (const paramId of CURSOR_PARAM_IDS) {
      cursor.appendChild(
        row(
          paramId.replace(/^idParam/, ''),
          select(parameterOptions(description), modelSettings.cursor_param[paramId] ?? 'none', (value) => {
            modelSettings.cursor_param[paramId] = value;
            controller.saveDebounced();
            applyLive();
          }),
        ),
      );
    }
    cursor.appendChild(note('Auto-detected on first load when the model uses standard parameter names.'));
    host.appendChild(section('Cursor tracking parameters', cursor));

    // Animations: starter / default / click
    const animations = el('div');
    animations.appendChild(this.animationRow('Starter', description, modelSettings.animation_starter, true));
    animations.appendChild(this.animationRow('Default', description, modelSettings.animation_default, false));

    const clickRow = this.animationRow('On click', description, modelSettings.animation_click, false);
    const clickMessage = el('input', 'l2d-input') as HTMLInputElement;
    clickMessage.type = 'text';
    clickMessage.placeholder = 'Message sent when clicked (optional)';
    clickMessage.value = modelSettings.animation_click.message;
    clickMessage.addEventListener('change', () => {
      modelSettings.animation_click.message = clickMessage.value;
      controller.saveDebounced();
    });
    clickRow.appendChild(row('Click message', clickMessage));
    animations.appendChild(clickRow);
    host.appendChild(section('Animations', animations));

    // Emotion (classify) mappings
    const classify = el('div');
    for (const label of CLASSIFY_EXPRESSIONS) {
      const mapping = modelSettings.classify_mapping[label]!;
      classify.appendChild(
        row(
          el('span', 'l2d-emotion', label),
          select(expressionOptions(description), mapping.expression, (value) => {
            mapping.expression = value;
            controller.saveDebounced();
          }),
          select(motionOptions(description), mapping.motion, (value) => {
            mapping.motion = value;
            controller.saveDebounced();
          }),
          button('▶', () => {
            void controller.stage.playExpression(mapping.expression);
            void controller.stage.playMotion(mapping.motion, true);
          }),
        ),
      );
    }
    const classifySection = section('Emotion mappings', classify);
    (classifySection as HTMLDetailsElement).open = false;
    host.appendChild(classifySection);

    // Hit areas
    const hitAreaNames = new Set([...description.hitAreas, ...Object.keys(modelSettings.hit_areas)]);
    if (hitAreaNames.size > 0) {
      const hitAreas = el('div');
      for (const area of hitAreaNames) {
        if (!modelSettings.hit_areas[area]) {
          modelSettings.hit_areas[area] = { expression: 'none', motion: 'none', message: '' };
        }
        const mapping = modelSettings.hit_areas[area]!;
        const message = el('input', 'l2d-input') as HTMLInputElement;
        message.type = 'text';
        message.placeholder = 'Message';
        message.value = mapping.message;
        message.addEventListener('change', () => {
          mapping.message = message.value;
          controller.saveDebounced();
        });
        hitAreas.appendChild(
          row(
            el('span', 'l2d-emotion', area),
            select(expressionOptions(description), mapping.expression, (value) => {
              mapping.expression = value;
              controller.saveDebounced();
            }),
            select(motionOptions(description), mapping.motion, (value) => {
              mapping.motion = value;
              controller.saveDebounced();
            }),
            message,
            button('▶', () => {
              void controller.stage.playExpression(mapping.expression);
              void controller.stage.playMotion(mapping.motion, true);
            }),
          ),
        );
      }
      const hitSection = section('Hit areas', hitAreas);
      (hitSection as HTMLDetailsElement).open = false;
      host.appendChild(hitSection);
    }
  }

  private animationRow(
    label: string,
    description: ModelDescription,
    mapping: { expression: string; motion: string; delay?: number },
    withDelay: boolean,
  ): HTMLDivElement {
    const controller = this.controller;
    const wrap = el('div', 'l2d-anim');
    wrap.appendChild(el('div', 'l2d-anim-title', label));
    wrap.appendChild(
      row(
        'Expression',
        select(expressionOptions(description), mapping.expression, (value) => {
          mapping.expression = value;
          controller.saveDebounced();
        }),
        'Motion',
        select(motionOptions(description), mapping.motion, (value) => {
          mapping.motion = value;
          controller.saveDebounced();
        }),
        button('▶', () => {
          void controller.stage.playExpression(mapping.expression);
          void controller.stage.playMotion(mapping.motion, true);
        }),
      ),
    );
    if (withDelay) {
      wrap.appendChild(
        slider('Delay before starter (ms)', 0, 10000, 100, mapping.delay ?? 0, (value) => {
          mapping.delay = value;
          controller.saveDebounced();
        }),
      );
    }
    return wrap;
  }
}

export const UI_CSS = `
.l2d-root { padding: 10px 12px; color: var(--lumiverse-text); font-size: 13px; }
.l2d-section { margin-bottom: 10px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 8px 10px; background: var(--lumiverse-fill-subtle); }
.l2d-section-title { cursor: pointer; font-weight: 600; margin: 0 0 4px; color: var(--lumiverse-text); }
.l2d-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
.l2d-label { color: var(--lumiverse-text-muted); min-width: 90px; }
.l2d-note { color: var(--lumiverse-text-dim); font-size: 12px; margin: 6px 0; }
.l2d-dim { color: var(--lumiverse-text-dim); font-size: 12px; }
.l2d-btn { padding: 4px 10px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; }
.l2d-btn:hover { border-color: var(--lumiverse-border-hover); }
.l2d-check { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
.l2d-select { max-width: 100%; min-width: 140px; padding: 3px 6px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); }
.l2d-input { flex: 1; min-width: 120px; padding: 4px 8px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); }
.l2d-slider { margin: 8px 0; }
.l2d-slider input[type=range] { width: 100%; }
.l2d-slider-head { display: flex; justify-content: space-between; color: var(--lumiverse-text-muted); }
.l2d-slider-value { color: var(--lumiverse-text); }
.l2d-emotion { min-width: 110px; color: var(--lumiverse-text-muted); }
.l2d-model-name { font-weight: 600; }
.l2d-anim { border-top: 1px solid var(--lumiverse-border); padding-top: 6px; margin-top: 6px; }
.l2d-anim-title { font-weight: 600; color: var(--lumiverse-text-muted); }
.l2d-banner { border: 1px solid var(--lumiverse-accent); border-radius: var(--lumiverse-radius); padding: 8px 10px; margin-bottom: 10px; }
.l2d-banner-title { font-weight: 600; margin-bottom: 4px; }
.l2d-banner-line { color: var(--lumiverse-text-muted); font-size: 12px; margin: 2px 0 6px; }
.l2d-embedded-host { position: relative; width: 100%; height: 420px; overflow: hidden; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); }
`;
