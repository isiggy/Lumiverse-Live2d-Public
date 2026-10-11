/**
 * The Live2D stage: owns the PIXI application, the loaded model, interaction
 * (drag, hit areas, cursor following), the talking mouth animation, and
 * expression/motion playback. Ports the behavior of the SillyTavern Live2d
 * extension's live2d.js onto a Lumiverse overlay or embedded container.
 */

import type { ModelAssets, ModelBundle } from './assets';
import { ensureLive2DRuntime } from './runtime';
import { squareThumbnail, THUMBNAIL_RENDER_PIXELS } from './thumbnail';
import {
  type ClickAnimation,
  type Live2DSettings,
  type ModelRecord,
  type ModelSettings,
  ID_PARAM_DEFAULT,
  ID_PARAM_PATCH,
  PARAM_MOUTH_OPEN_Y_DEFAULT,
  PARAM_MOUTH_OPEN_Y_PATCH,
} from '../shared/settings';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** pixi-live2d-display's MotionPriority.IDLE: any other motion interrupts one playing at this priority. */
const MOTION_PRIORITY_IDLE = 1;
/** Motion group the looping default motion is copied into, then used as the model's idle group. */
const DEFAULT_LOOP_GROUP = '__live2d_avatars_default__';
/** How long another expression stays before the looping default expression comes back, unless a motion is still playing. */
const EXPRESSION_HOLD_MS = 5000;
/** How long a model has been on stage before its first thumbnail is taken (its textures and idle pose have settled). */
const THUMBNAIL_DELAY_MS = 1500;

/** Host UI under the pointer that must keep its clicks even where the model is drawn. */
const INTERACTIVE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="slider"]',
].join(',');

export interface ModelDescription {
  expressions: Array<{ name: string; file: string }>;
  /** motion group -> per-motion file names */
  motions: Record<string, string[]>;
  hitAreas: string[];
  parameterIds: string[];
  /** The model's canvas size in model units, known once it has been instantiated. */
  size?: { width: number; height: number };
}

export interface StageDeps {
  getSettings(): Live2DSettings;
  getModelRecord(modelId: string): ModelRecord | undefined;
  /**
   * Returns (creating if needed) the per-character per-model settings object.
   * `preset` is a sillytavern_settings.json payload bundled with the model,
   * applied only when the user has no stored settings for this pair yet.
   */
  getModelSettings(
    characterId: string,
    modelId: string,
    description: ModelDescription | null,
    preset?: unknown,
  ): ModelSettings;
  saveSettingsDebounced(): void;
  assets: ModelAssets;
  /** Send a hit-area interaction message into the chat. */
  sendInteraction(message: string): void;
  /** Store a model's library thumbnail (an image data URL). */
  saveThumbnail(modelId: string, dataUrl: string): void;
  log(message: string): void;
}

interface LoadedEntry {
  characterId: string;
  modelId: string;
  model: any;
  objectUrls: string[];
  lastMotion: string | null;
  talking: boolean;
  abortTalk: boolean;
  frames: any[];
  /** Erases everything drawn outside the model's canvas; null when clipping is off. */
  clip: any | null;
  /** Last expression played ('none' before any) and when. */
  expression: string;
  expressionAt: number;
  /** The model's own idle motion group, restored when the default stops looping. */
  idleGroup: string | undefined;
  /** Motion currently installed as the idle loop, or null when the model's own idle motions play. */
  loopingMotion: string | null;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Case-insensitive key lookup used because some models mix `Name`/`name` keys. */
function loose(entry: Record<string, unknown>, key: string): string | undefined {
  const found = Object.keys(entry).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : String(entry[found]);
}

/**
 * Remove file references that are null or empty (e.g. `"Pose": null`, common in
 * models extracted from games). pixi-live2d-display would otherwise try to
 * resolve them as paths and throw.
 */
function dropEmptyFileReferences(json: any, cubism: 2 | 4): void {
  const refs = cubism === 4 ? json?.FileReferences : json;
  if (!refs || typeof refs !== 'object') return;
  for (const [key, value] of Object.entries(refs)) {
    if (value === null || value === '') delete refs[key];
  }
}

function modelSize(model: any): { width: number; height: number } {
  return {
    width: model.internalModel?.width || 1,
    height: model.internalModel?.height || model.height || 1,
  };
}

export function describeFromBundle(bundleJson: any, cubism: 2 | 4): Omit<ModelDescription, 'parameterIds'> {
  const expressions: Array<{ name: string; file: string }> = [];
  const motions: Record<string, string[]> = {};
  const hitAreas: string[] = [];

  if (cubism === 4) {
    const refs = bundleJson?.FileReferences ?? {};
    for (const entry of refs.Expressions ?? []) {
      expressions.push({ name: String(entry.Name ?? entry.File ?? ''), file: String(entry.File ?? '') });
    }
    for (const [group, defs] of Object.entries<any>(refs.Motions ?? {})) {
      motions[group] = (defs as any[]).map((def) => String(def.File ?? ''));
    }
    for (const area of bundleJson?.HitAreas ?? []) {
      const name = area?.Name ?? area?.Id;
      if (name) hitAreas.push(String(name));
    }
  } else {
    for (const entry of bundleJson?.expressions ?? []) {
      expressions.push({
        name: loose(entry, 'name') ?? loose(entry, 'file') ?? '',
        file: loose(entry, 'file') ?? '',
      });
    }
    for (const [group, defs] of Object.entries<any>(bundleJson?.motions ?? {})) {
      motions[group] = (defs as any[]).map((def) => loose(def, 'file') ?? '');
    }
    for (const area of bundleJson?.hit_areas ?? []) {
      const name = loose(area, 'name');
      if (name) hitAreas.push(name);
    }
  }
  return { expressions, motions, hitAreas };
}

export class Stage {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private app: any = null;
  private loaded: LoadedEntry | null = null;
  private chatId: string | null = null;
  private characterId: string | null = null;
  private loadToken = 0;
  private ticker: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private starterTimer: number | null = null;
  private thumbnailTimer: number | null = null;
  private previousInteraction = { characterId: '', message: '' };
  private descriptionCache = new Map<string, ModelDescription>();
  private drag: { entry: LoadedEntry; pointerId: number; offsetX: number; offsetY: number; moved: boolean } | null =
    null;
  private suppressClick = false;
  private hoverFrame: number | null = null;
  private hovering = false;

  // The canvas never takes pointer events, so it can't block the chat UI drawn
  // under it. Model interaction is detected at the document level instead.
  private listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> = [
    [document, 'pointerdown', (event) => this.onPointerDown(event as PointerEvent), { capture: true }],
    [document, 'pointermove', (event) => this.onPointerMove(event as PointerEvent), { capture: true }],
    [document, 'pointerup', (event) => this.onPointerUp(event as PointerEvent), { capture: true }],
    [document, 'pointercancel', () => this.endDrag(), { capture: true }],
    [document, 'click', (event) => this.onClickCapture(event as MouseEvent), { capture: true }],
    [document, 'touchstart', (event) => this.drag && event.preventDefault(), { capture: true, passive: false }],
    [document, 'touchmove', (event) => this.drag && event.preventDefault(), { capture: true, passive: false }],
  ];

  constructor(private deps: StageDeps) {
    for (const [target, type, listener, options] of this.listeners) target.addEventListener(type, listener, options);
  }

  destroy(): void {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    if (this.hoverFrame !== null) window.cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.setHovering(false);
    this.teardownApp();
    if (this.ticker !== null) window.clearInterval(this.ticker);
    if (this.starterTimer !== null) window.clearTimeout(this.starterTimer);
    this.ticker = null;
  }

  /** Attach the stage to a host element (overlay mount root or embedded panel). */
  setHost(host: HTMLElement | null): void {
    if (this.host === host) return;
    this.teardownApp();
    this.host = host;
    void this.reload();
  }

  setChatContext(chatId: string | null, characterId: string | null): void {
    const changed = chatId !== this.chatId || characterId !== this.characterId;
    this.chatId = chatId;
    this.characterId = characterId;
    if (changed) void this.reload();
  }

  getChatContext(): { chatId: string | null; characterId: string | null } {
    return { chatId: this.chatId, characterId: this.characterId };
  }

  currentModel(): { characterId: string; modelId: string } | null {
    return this.loaded ? { characterId: this.loaded.characterId, modelId: this.loaded.modelId } : null;
  }

  /** Rebuild the whole stage from current settings + chat context. */
  async reload(): Promise<void> {
    this.teardownApp(); // bumps loadToken, cancelling any in-flight load
    const token = ++this.loadToken;

    const settings = this.deps.getSettings();
    if (!settings.global.enabled || !this.host || !this.characterId) return;
    const modelId = settings.characterModelMapping[this.characterId];
    if (!modelId) return;
    const record = this.deps.getModelRecord(modelId);
    if (!record) return;

    let PIXI: any;
    let bundle: ModelBundle;
    try {
      [PIXI, bundle] = await Promise.all([ensureLive2DRuntime(), this.deps.assets.load(record)]);
    } catch (error) {
      this.deps.log(`Failed to prepare model: ${String(error)}`);
      return;
    }
    if (token !== this.loadToken || !this.host) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'live2d-avatars-canvas';
    this.host.appendChild(canvas);
    this.canvas = canvas;
    const hostRect = this.host.getBoundingClientRect();
    if (hostRect.width === 0 || hostRect.height === 0) {
      this.deps.log(`Stage host has no size yet (${hostRect.width}x${hostRect.height}); waiting for it to be shown.`);
    }

    this.app = new PIXI.Application({
      resolution: 2 * (window.devicePixelRatio || 1),
      view: canvas,
      autoStart: true,
      resizeTo: this.host,
      backgroundAlpha: 0,
    });
    // PIXI's resizeTo only reacts to window resizes; the host can also change
    // size on its own (a drawer tab opening, a panel resizing).
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.app) return;
      this.app.resize();
      this.applyLayout();
    });
    this.resizeObserver.observe(this.host);

    try {
      await this.loadModel(PIXI, record, bundle, token);
    } catch (error) {
      this.deps.log(`Failed to load model "${record.name}": ${String(error)}`);
      this.teardownApp();
      return;
    }

    if (this.ticker === null) {
      this.ticker = window.setInterval(() => this.tick(), 100);
    }
  }

  private async loadModel(PIXI: any, record: ModelRecord, bundle: ModelBundle, token: number): Promise<void> {
    const characterId = this.characterId!;
    const settingsText = await bundle.files.get(bundle.settingsFile)?.text();
    if (!settingsText) throw new Error(`Settings file missing from bundle: ${bundle.settingsFile}`);
    const json = JSON.parse(settingsText);

    const partialDescription = describeFromBundle(json, bundle.cubism);
    const baseDescription: ModelDescription = { ...partialDescription, parameterIds: [] };

    // Seed per-model user settings, honoring a bundled sillytavern_settings.json preset.
    const modelSettings = this.deps.getModelSettings(characterId, record.id, baseDescription, bundle.presetSettings);

    const { model, objectUrls } = await this.instantiate(PIXI, bundle, json, modelSettings.eye);
    if (token !== this.loadToken || !this.app) {
      model.destroy(true, true, true);
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      return;
    }

    const parameterIds: string[] = model.internalModel.coreModel?._model?.parameters?.ids ?? [];
    const description: ModelDescription = {
      ...partialDescription,
      parameterIds: [...parameterIds].sort(),
      size: modelSize(model),
    };
    this.descriptionCache.set(`${record.id}@${record.version}`, description);
    this.autoDetectParameters(modelSettings, description.parameterIds);

    const entry: LoadedEntry = {
      characterId,
      modelId: record.id,
      model,
      objectUrls,
      lastMotion: null,
      talking: false,
      abortTalk: false,
      frames: [],
      clip: null,
      expression: 'none',
      expressionAt: 0,
      idleGroup: model.internalModel.motionManager?.groups?.idle,
      loopingMotion: null,
    };
    this.loaded = entry;

    this.app.stage.addChild(model);
    this.applyCursorParams(entry, modelSettings);
    this.applyLayout(entry, modelSettings);
    if (this.deps.getSettings().global.showFrames) this.showFrames(entry, true);

    // Starter animation
    const starter = modelSettings.animation_starter;
    if (starter.expression !== 'none' || starter.motion !== 'none') {
      this.starterTimer = window.setTimeout(() => {
        if (this.loaded !== entry) return;
        if (starter.expression !== 'none') void this.playExpression(starter.expression);
        if (starter.motion !== 'none') void this.playMotion(starter.motion);
      }, Math.max(0, starter.delay));
    }

    // A model's first appearance gives the library its thumbnail.
    if (!record.thumbnail) {
      this.thumbnailTimer = window.setTimeout(() => {
        this.thumbnailTimer = null;
        if (this.loaded !== entry || this.deps.getModelRecord(record.id)?.thumbnail) return;
        const dataUrl = this.captureThumbnail();
        if (dataUrl) this.deps.saveThumbnail(record.id, dataUrl);
      }, THUMBNAIL_DELAY_MS);
    }
  }

  /**
   * A square picture of the model on stage, upright and centered, as an image
   * data URL; null when no model is shown. The model is drawn once more into
   * the canvas's corner, copied, and put back, all before the browser shows
   * the canvas again, so nothing flickers.
   */
  captureThumbnail(): string | null {
    const entry = this.loaded;
    const app = this.app;
    if (!entry || !app) return null;
    const view: HTMLCanvasElement = app.view;
    const pixels = Math.min(THUMBNAIL_RENDER_PIXELS, view.width, view.height);
    if (pixels < 32) return null;
    const box = pixels / app.renderer.resolution; // in stage units
    const model = entry.model;
    const { width: w, height: h } = modelSize(model);
    const saved = { x: model.x, y: model.y, rotation: model.rotation, scale: model.scale.x };
    let dataUrl: string | null = null;
    try {
      model.anchor.set(0.5, 0.5);
      model.rotation = 0;
      model.scale.set((box * 0.96) / Math.max(w, h));
      model.x = box / 2;
      model.y = box / 2;
      const frames = entry.frames.map((frame) => [frame, frame.visible] as const);
      for (const [frame] of frames) frame.visible = false;
      app.renderer.render(app.stage);
      for (const [frame, visible] of frames) frame.visible = visible;
      dataUrl = squareThumbnail(view, pixels);
    } catch (error) {
      this.deps.log(`Thumbnail failed: ${String(error)}`);
      return null;
    } finally {
      model.rotation = saved.rotation;
      model.scale.set(saved.scale);
      model.x = saved.x;
      model.y = saved.y;
      app.renderer.render(app.stage);
    }
    return dataUrl;
  }

  private async instantiate(
    PIXI: any,
    bundle: ModelBundle,
    json: any,
    eyeOffset: number,
  ): Promise<{ model: any; objectUrls: string[] }> {
    const baseDir = dirname(bundle.settingsFile);
    const objectUrls: string[] = [];
    const urlByPath = new Map<string, string>();
    const lowerCaseIndex = new Map<string, string>();
    for (const path of bundle.files.keys()) lowerCaseIndex.set(path.toLowerCase(), path);

    const urlFor = (file: string): string => {
      const resolved = normalizePath(baseDir ? `${baseDir}/${file}` : file);
      const actual = bundle.files.has(resolved) ? resolved : lowerCaseIndex.get(resolved.toLowerCase());
      if (!actual) return file; // let the loader fail with a meaningful path
      let url = urlByPath.get(actual);
      if (!url) {
        url = URL.createObjectURL(bundle.files.get(actual)!);
        urlByPath.set(actual, url);
        objectUrls.push(url);
      }
      return url;
    };

    dropEmptyFileReferences(json, bundle.cubism);
    json.url = `live2d://${bundle.modelId}/${bundle.settingsFile}`;
    const SettingsClass = bundle.cubism === 4 ? PIXI.live2d.Cubism4ModelSettings : PIXI.live2d.Cubism2ModelSettings;
    const settings = new SettingsClass(json);
    settings.replaceFiles((file: string) => urlFor(file));
    // File names are already absolute blob: URLs; the library's url.resolve
    // helper mangles them (blob:http// …), so resolution must be a no-op.
    settings.resolveURL = (file: string) => file;

    let model: any;
    try {
      model = await PIXI.live2d.Live2DModel.from(settings, { autoInteract: false }, eyeOffset || 45);
    } catch (error) {
      // Some models reject the patched eye-offset path; retry with defaults.
      model = await PIXI.live2d.Live2DModel.from(settings, { autoInteract: false });
    }
    return { model, objectUrls };
  }

  /** First-load detection of mouth + cursor parameters, mirroring the ST extension. */
  private autoDetectParameters(modelSettings: ModelSettings, parameterIds: string[]): void {
    let changed = false;
    if (modelSettings.param_mouth_open_y_id === 'none') {
      for (const candidate of [PARAM_MOUTH_OPEN_Y_DEFAULT, ...PARAM_MOUTH_OPEN_Y_PATCH]) {
        if (parameterIds.includes(candidate)) {
          modelSettings.param_mouth_open_y_id = candidate;
          changed = true;
          break;
        }
      }
    }
    for (const [param, fallbacks] of Object.entries(ID_PARAM_PATCH)) {
      if (modelSettings.cursor_param[param] !== 'none') continue;
      for (const candidate of [ID_PARAM_DEFAULT[param]!, ...fallbacks]) {
        if (parameterIds.includes(candidate)) {
          modelSettings.cursor_param[param] = candidate;
          changed = true;
          break;
        }
      }
    }
    if (changed) this.deps.saveSettingsDebounced();
  }

  getDescription(): ModelDescription | null {
    if (!this.loaded) return null;
    const record = this.deps.getModelRecord(this.loaded.modelId);
    if (!record) return null;
    return this.descriptionCache.get(`${record.id}@${record.version}`) ?? null;
  }

  /** Load a model off-stage just to read its metadata, then free it. */
  async describeModel(record: ModelRecord): Promise<ModelDescription> {
    const cached = this.descriptionCache.get(`${record.id}@${record.version}`);
    if (cached) return cached;
    const [PIXI, bundle] = await Promise.all([ensureLive2DRuntime(), this.deps.assets.load(record)]);
    const settingsText = await bundle.files.get(bundle.settingsFile)?.text();
    if (!settingsText) throw new Error(`Settings file missing from bundle: ${bundle.settingsFile}`);
    const json = JSON.parse(settingsText);
    const partial = describeFromBundle(json, bundle.cubism);

    // Reuse the live instance when it's the same model — no need to load twice.
    if (this.loaded?.modelId === record.id) {
      const parameterIds: string[] = this.loaded.model.internalModel.coreModel?._model?.parameters?.ids ?? [];
      const description = { ...partial, parameterIds: [...parameterIds].sort(), size: modelSize(this.loaded.model) };
      this.descriptionCache.set(`${record.id}@${record.version}`, description);
      return description;
    }

    const { model, objectUrls } = await this.instantiate(PIXI, bundle, json, 45);
    const parameterIds: string[] = model.internalModel.coreModel?._model?.parameters?.ids ?? [];
    const size = modelSize(model);
    model.destroy(true, true, true);
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    const description: ModelDescription = { ...partial, parameterIds: [...parameterIds].sort(), size };
    this.descriptionCache.set(`${record.id}@${record.version}`, description);
    return description;
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  private hostSize(): { width: number; height: number } {
    const rect = this.host?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }

  /**
   * The `scale` setting at which the model's whole canvas, rotated by
   * `rotation` degrees, just fits the stage. Null while the stage is hidden.
   */
  fitScale(description: ModelDescription, rotation: number): number | null {
    const { width, height } = this.hostSize();
    if (width === 0 || height === 0 || !description.size) return null;
    const { width: w, height: h } = description.size;
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    // Pixels per model unit that fit the rotated bounding box in both directions.
    const pixelsPerUnit = Math.min(width / (w * cos + h * sin), height / (w * sin + h * cos));
    // applyLayout's scale 1 maps the model's height to the stage height.
    return pixelsPerUnit / (height / h);
  }

  applyLayout(entry: LoadedEntry | null = this.loaded, modelSettings?: ModelSettings): void {
    if (!entry) return;
    const settings =
      modelSettings ?? this.deps.getModelSettings(entry.characterId, entry.modelId, this.getDescription());
    const { width, height } = this.hostSize();
    // Hidden host (e.g. closed drawer tab): lay out once the resize observer reports a size.
    if (width === 0 || height === 0) return;
    const internalHeight = entry.model.internalModel?.height || entry.model.height || 1;
    entry.model.scale.set((height / internalHeight) * settings.scale);
    // Position and rotate around the model's center. At 0° this matches the
    // old top-left placement, so stored x/y offsets keep their meaning.
    entry.model.anchor.set(0.5, 0.5);
    entry.model.rotation = ((settings.rotation || 0) * Math.PI) / 180;
    entry.model.x = width / 2 + ((width / 2) * settings.x) / 100;
    entry.model.y = height / 2 + ((height / 2) * settings.y) / 100;
    this.applyClip(entry, settings.clip_to_canvas);
  }

  /**
   * Full-scene models often carry backdrop art far bigger than their canvas,
   * which the Cubism editor crops away but a plain render shows, so zooming out
   * leaves an opaque frame around the model. The Cubism renderer turns off
   * scissor and stencil tests, so PIXI masks can't clip it; instead a child
   * drawn after the model erases the stage's pixels everywhere outside the
   * canvas rectangle, in the model's own (rotated, scaled) coordinates.
   */
  private applyClip(entry: LoadedEntry, clip: boolean): void {
    const PIXI = window.PIXI;
    if (!clip || !PIXI) {
      if (entry.clip) {
        entry.model.removeChild(entry.clip);
        entry.clip.destroy();
        entry.clip = null;
      }
      return;
    }
    if (entry.clip) return;
    const { width: w, height: h } = modelSize(entry.model);
    const far = 100 * Math.max(w, h);
    const eraser = new PIXI.Graphics();
    eraser.blendMode = PIXI.BLEND_MODES.ERASE;
    eraser.beginFill(0xffffff, 1);
    eraser.drawRect(-far, -far, w + 2 * far, far); // above
    eraser.drawRect(-far, h, w + 2 * far, far); // below
    eraser.drawRect(-far, 0, far, h); // left
    eraser.drawRect(w, 0, far, h); // right
    eraser.endFill();
    // Children render after the model itself; keep it under any debug frames.
    entry.model.addChildAt(eraser, 0);
    entry.clip = eraser;
  }

  applyCursorParams(entry: LoadedEntry | null = this.loaded, modelSettings?: ModelSettings): void {
    if (!entry?.model?.internalModel) return;
    const settings =
      modelSettings ?? this.deps.getModelSettings(entry.characterId, entry.modelId, this.getDescription());
    for (const [param, value] of Object.entries(settings.cursor_param)) {
      if (value !== 'none') {
        try {
          entry.model.internalModel[param] = value;
        } catch {
          /* model without that parameter */
        }
      }
    }
    if (settings.eye !== undefined) entry.model.eye_offset = settings.eye;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  /**
   * Whether a pointer event at this position belongs to the model: the model's
   * canvas must be the topmost layer there (no drawer or modal above it), the
   * element underneath must not be a control (input, button, link…), and the
   * point must fall on one of the model's visible drawn parts.
   */
  private isModelInteraction(event: PointerEvent): boolean {
    const entry = this.loaded;
    const canvas = this.canvas;
    if (!entry || !canvas) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return false;

    const previous = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'auto';
    const topmost = document.elementFromPoint(event.clientX, event.clientY);
    canvas.style.pointerEvents = previous;
    if (topmost !== canvas) return false;

    return this.isOverModel(entry, this.toStagePoint(event));
  }

  private isOverModel(entry: LoadedEntry, point: { x: number; y: number }): boolean {
    const PIXI = window.PIXI;
    const internal = entry.model?.internalModel;
    if (!PIXI || !internal) return false;
    try {
      if (entry.clip) {
        // Parts outside the canvas aren't drawn, so they can't be grabbed either.
        const onStage = entry.model.toLocal(new PIXI.Point(point.x, point.y));
        const { width, height } = modelSize(entry.model);
        if (onStage.x < 0 || onStage.y < 0 || onStage.x > width || onStage.y > height) return false;
      }
      const local = entry.model.toModelPosition(new PIXI.Point(point.x, point.y));
      const core = internal.coreModel;
      const hasOpacity = typeof core?.getDrawableOpacity === 'function';
      const bounds = { x: 0, y: 0, width: 0, height: 0 };
      const count: number = internal.getDrawableIDs().length;
      for (let index = 0; index < count; index++) {
        if (hasOpacity && core.getDrawableOpacity(index) < 0.05) continue;
        internal.getDrawableBounds(index, bounds);
        if (
          local.x >= bounds.x &&
          local.x <= bounds.x + bounds.width &&
          local.y >= bounds.y &&
          local.y <= bounds.y + bounds.height
        ) {
          return true;
        }
      }
    } catch {
      /* model destroyed or mid-reload */
    }
    return false;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.isModelInteraction(event)) return;
    const entry = this.loaded!;
    event.preventDefault();
    event.stopPropagation();
    const point = this.toStagePoint(event);
    this.drag = {
      entry,
      pointerId: event.pointerId,
      offsetX: point.x - entry.model.x,
      offsetY: point.y - entry.model.y,
      moved: false,
    };
    this.suppressClick = true;
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.dragTo(drag, event);
      return;
    }
    if (!this.loaded) return;
    if (this.deps.getSettings().global.followCursor) {
      const rect = this.canvas?.getBoundingClientRect();
      if (rect) {
        try {
          this.loaded.model.focus(event.clientX - rect.left, event.clientY - rect.top);
        } catch {
          /* model without focus controller */
        }
      }
    }
    if (event.pointerType === 'mouse' && this.hoverFrame === null) {
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        this.setHovering(this.isModelInteraction(event));
      });
    }
  }

  private dragTo(drag: NonNullable<Stage['drag']>, event: PointerEvent): void {
    const { entry } = drag;
    const point = this.toStagePoint(event);
    const newX = point.x - drag.offsetX;
    const newY = point.y - drag.offsetY;
    if (!drag.moved && Math.abs(newX - entry.model.x) < 3 && Math.abs(newY - entry.model.y) < 3) return;
    drag.moved = true;
    entry.model.x = newX;
    entry.model.y = newY;
    // Persist as percent offsets from center (model.x/y is the center: anchor 0.5)
    const { width, height } = this.hostSize();
    const settings = this.deps.getModelSettings(entry.characterId, entry.modelId, this.getDescription());
    settings.x = Math.round((entry.model.x - width / 2) / (width / 2 / 100));
    settings.y = Math.round((entry.model.y - height / 2) / (height / 2 / 100));
    this.deps.saveSettingsDebounced();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
    if (!drag.moved && this.loaded === drag.entry) void this.onModelClick(drag.entry, event);
  }

  private endDrag(): void {
    this.drag = null;
    // The browser dispatches `click` right after `pointerup`; if the pointer was
    // released over a different element no click comes, so stop suppressing.
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }

  private onClickCapture(event: MouseEvent): void {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  private setHovering(hovering: boolean): void {
    if (hovering === this.hovering) return;
    this.hovering = hovering;
    document.documentElement.classList.toggle('live2d-avatars-hover', hovering);
  }

  private toStagePoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  private async onModelClick(entry: LoadedEntry, event: PointerEvent): Promise<void> {
    const point = this.toStagePoint(event);
    let hits: string[] = [];
    try {
      hits = (await entry.model.hitTest(point.x, point.y)) ?? [];
    } catch {
      hits = [];
    }
    const settings = this.deps.getModelSettings(entry.characterId, entry.modelId, this.getDescription());
    const modelHitAreas = entry.model.internalModel?.hitAreas ?? {};

    // Pick the mapped hit area with the highest priority (lowest index), as ST does.
    let selected: ClickAnimation | null = null;
    let selectedPriority = Number.POSITIVE_INFINITY;
    for (const area of Object.keys(modelHitAreas)) {
      if (!hits.includes(area)) continue;
      const mapping = settings.hit_areas[area];
      if (!mapping) continue;
      if (mapping.expression === 'none' && mapping.motion === 'none' && mapping.message === '') continue;
      const priority = Number(modelHitAreas[area]?.index ?? 0);
      if (priority < selectedPriority) {
        selected = mapping;
        selectedPriority = priority;
      }
    }
    const mapping = selected ?? settings.animation_click;

    if (mapping.message && mapping.message !== '') {
      if (
        this.previousInteraction.characterId === entry.characterId &&
        this.previousInteraction.message === mapping.message
      ) {
        this.deps.log('Same as last interaction, message not sent again.');
      } else {
        this.previousInteraction = { characterId: entry.characterId, message: mapping.message };
        this.deps.sendInteraction(mapping.message);
      }
    }

    if (mapping.expression !== 'none') await this.playExpression(mapping.expression);
    if (mapping.motion !== 'none') await this.playMotion(mapping.motion);
  }

  private tick(): void {
    const entry = this.loaded;
    if (!entry) return;
    const globals = this.deps.getSettings().global;
    if (globals.force_loop && entry.lastMotion) {
      try {
        if (!entry.model.internalModel.motionManager.playing) {
          void this.playMotion(entry.lastMotion);
        }
      } catch {
        /* mid-reload */
      }
    }
    try {
      this.loopDefault(entry);
    } catch {
      /* mid-reload */
    }
  }

  /**
   * Keeps the default animation playing when "Loop the default animation" is on.
   * The default motion becomes the model's idle motion, which pixi-live2d-display
   * restarts whenever nothing else plays and which any other motion interrupts.
   * The default expression comes back once other animations are done with it.
   */
  private loopDefault(entry: LoadedEntry): void {
    const manager = entry.model.internalModel?.motionManager;
    if (!manager) return;
    const mapping = this.deps.getSettings().characterModelsSettings[entry.characterId]?.[entry.modelId]?.animation_default;
    const loop = mapping?.loop === true;

    const motion = loop && mapping.motion !== 'none' ? mapping.motion : null;
    if (motion !== entry.loopingMotion) {
      if (motion) {
        const [group = motion, id] = motion.split('_id=');
        const definitions: any[] = manager.definitions?.[group] ?? [];
        manager.definitions[DEFAULT_LOOP_GROUP] =
          id === undefined || id === 'random' ? definitions : definitions.slice(Number(id), Number(id) + 1);
        manager.motionGroups[DEFAULT_LOOP_GROUP] = [];
        manager.groups.idle = DEFAULT_LOOP_GROUP;
      } else {
        manager.groups.idle = entry.idleGroup;
      }
      entry.loopingMotion = motion;
      // Swap out an idle motion that's already playing; leave any other motion to finish.
      if (manager.state.currentPriority <= MOTION_PRIORITY_IDLE) manager.stopAllMotions();
    }

    if (!loop || mapping.expression === 'none' || entry.expression === mapping.expression) return;
    const state = manager.state;
    if (Math.max(state.currentPriority, state.reservePriority) > MOTION_PRIORITY_IDLE) return;
    if (performance.now() - entry.expressionAt < EXPRESSION_HOLD_MS) return;
    void this.playExpression(mapping.expression);
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  async playExpression(expression: string): Promise<void> {
    if (!this.loaded || expression === 'none') return;
    const entry = this.loaded;
    try {
      await entry.model.expression(expression);
      entry.expression = expression;
      entry.expressionAt = performance.now();
    } catch (error) {
      this.deps.log(`Expression "${expression}" failed: ${String(error)}`);
    }
  }

  async playMotion(motion: string, force = false): Promise<void> {
    if (!this.loaded || motion === 'none') return;
    if (force || this.deps.getSettings().global.force_animation) {
      await this.reload();
      if (!this.loaded) return;
    }
    const entry = this.loaded;
    const split = motion.split('_id=');
    const group = split[0] ?? motion;
    const id = split[1];
    try {
      if (id === undefined || id === 'random') await entry.model.motion(group);
      else await entry.model.motion(group, Number(id));
      entry.lastMotion = motion;
    } catch (error) {
      this.deps.log(`Motion "${motion}" failed: ${String(error)}`);
    }
  }

  /** Message-length-driven mouth animation, same shape as the ST extension. */
  async playTalk(textLength: number): Promise<void> {
    const entry = this.loaded;
    if (!entry || textLength <= 0) return;
    const settings = this.deps.getModelSettings(entry.characterId, entry.modelId, this.getDescription());
    const paramId = settings.param_mouth_open_y_id;
    if (paramId === 'none') return;
    const core = entry.model.internalModel?.coreModel;
    if (typeof core?.addParameterValueById !== 'function') return;

    if (entry.talking) {
      entry.abortTalk = true;
      while (entry.talking && this.loaded === entry) await delay(50);
      entry.abortTalk = false;
    }
    if (this.loaded !== entry) return;

    entry.talking = true;
    const start = Date.now();
    const duration = textLength * settings.mouth_time_per_character;
    try {
      while (Date.now() - start < duration) {
        if (entry.abortTalk || this.loaded !== entry) break;
        const coreModel = entry.model?.internalModel?.coreModel;
        if (!coreModel) break;
        coreModel.addParameterValueById(paramId, Math.sin(Date.now() - start));
        await delay(100 / Math.max(0.1, settings.mouth_open_speed));
      }
      entry.model?.internalModel?.coreModel?.addParameterValueById(paramId, -100);
    } catch {
      /* model destroyed while talking */
    } finally {
      entry.talking = false;
    }
  }

  setParameter(parameterId: string, value: number): void {
    try {
      this.loaded?.model.internalModel.coreModel.setParameterValueById(parameterId, value);
    } catch (error) {
      this.deps.log(`Set parameter failed: ${String(error)}`);
    }
  }

  resetParameters(): void {
    const core = this.loaded?.model?.internalModel?.coreModel;
    const defaults = core?._model?.parameters?.defaultValues;
    if (!core || !defaults) return;
    defaults.forEach((value: number, index: number) => {
      try {
        core.setParameterValueByIndex(index, value);
      } catch {
        /* out-of-range */
      }
    });
  }

  setShowFrames(show: boolean): void {
    if (this.loaded) this.showFrames(this.loaded, show);
  }

  private showFrames(entry: LoadedEntry, show: boolean): void {
    const PIXI = window.PIXI;
    for (const frame of entry.frames) {
      try {
        entry.model.removeChild(frame);
        frame.destroy();
      } catch {
        /* already gone */
      }
    }
    entry.frames = [];
    if (!show || !PIXI) return;
    try {
      const foreground = PIXI.Sprite.from(PIXI.Texture.WHITE);
      foreground.width = entry.model.internalModel.width;
      foreground.height = entry.model.internalModel.height;
      foreground.alpha = 0.2;
      const hitFrames = new PIXI.live2d.HitAreaFrames();
      entry.model.addChild(foreground);
      entry.model.addChild(hitFrames);
      entry.frames = [foreground, hitFrames];
    } catch (error) {
      this.deps.log(`Show frames failed: ${String(error)}`);
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  private teardownApp(): void {
    this.loadToken++;
    this.drag = null;
    this.setHovering(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.starterTimer !== null) {
      window.clearTimeout(this.starterTimer);
      this.starterTimer = null;
    }
    if (this.thumbnailTimer !== null) {
      window.clearTimeout(this.thumbnailTimer);
      this.thumbnailTimer = null;
    }
    if (this.loaded) {
      this.loaded.abortTalk = true;
      try {
        this.loaded.model.destroy(true, true, true);
      } catch {
        /* already destroyed */
      }
      this.loaded.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      this.loaded = null;
    }
    if (this.app) {
      try {
        this.app.destroy();
      } catch {
        /* already destroyed */
      }
      this.app = null;
    }
    this.canvas?.remove();
    this.canvas = null;
  }
}
