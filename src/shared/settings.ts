/**
 * Shared settings schema. Mirrors the SillyTavern Live2d extension's settings
 * layout (characterModelMapping / characterModelsSettings) so that behavior —
 * and even a model folder's `sillytavern_settings.json` presets — carry over.
 */

export const CLASSIFY_EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
  'neutral',
] as const;

export const FALLBACK_EXPRESSION = 'joy';

export const PARAM_MOUTH_OPEN_Y_DEFAULT = 'ParamMouthOpenY';
export const PARAM_MOUTH_OPEN_Y_PATCH = ['PARAM_MOUTH_OPEN_Y', 'PARAM_MOUTH_OPEN'];

export const ID_PARAM_DEFAULT: Record<string, string> = {
  idParamAngleX: 'ParamAngleX',
  idParamAngleY: 'ParamAngleY',
  idParamAngleZ: 'ParamAngleZ',
  idParamBodyAngleX: 'ParamBodyAngleX',
  idParamBreath: 'ParamBreath',
  idParamEyeBallX: 'ParamEyeBallX',
  idParamEyeBallY: 'ParamEyeBallY',
};

export const ID_PARAM_PATCH: Record<string, string[]> = {
  idParamAngleX: ['PARAM_ANGLE_X'],
  idParamAngleY: ['PARAM_ANGLE_Y'],
  idParamAngleZ: ['PARAM_ANGLE_Z'],
  idParamBodyAngleX: ['PARAM_BODY_ANGLE_X'],
  idParamBreath: ['PARAM_BREATH'],
  idParamEyeBallX: ['PARAM_EYE_BALL_X'],
  idParamEyeBallY: ['PARAM_EYE_BALL_Y'],
};

export const CURSOR_PARAM_IDS = Object.keys(ID_PARAM_DEFAULT);

export interface AnimationMapping {
  expression: string; // 'none' or an expression name
  motion: string; // 'none' or '<group>_id=<index|random>'
}

export interface DefaultAnimation extends AnimationMapping {
  /** Keep the default playing: its motion repeats and its expression comes back once other animations finish. */
  loop: boolean;
}

export interface StarterAnimation extends AnimationMapping {
  delay: number; // ms before playing on chat load
}

export interface ClickAnimation extends AnimationMapping {
  message: string; // user message to send on click ('' = none)
}

export interface ModelSettings {
  scale: number;
  x: number; // percent offset from center, -100..100
  y: number;
  rotation: number; // degrees clockwise, -180..180
  /** Hide whatever the model draws outside its own canvas (oversized backdrops in full-scene models). */
  clip_to_canvas: boolean;
  eye: number; // eye follow offset (patched pixi-live2d-display), default 45
  cursor_param: Record<string, string>; // idParam* -> model parameter id or 'none'
  param_mouth_open_y_id: string; // parameter id or 'none'
  mouth_open_speed: number;
  mouth_time_per_character: number;
  animation_starter: StarterAnimation;
  animation_default: DefaultAnimation;
  animation_click: ClickAnimation;
  hit_areas: Record<string, ClickAnimation>;
  classify_mapping: Record<string, AnimationMapping>;
}

export interface GlobalSettings {
  enabled: boolean;
  followCursor: boolean;
  autoSendInteraction: boolean;
  /** Draw the model behind the chat, with the chat's panels made see-through. */
  backgroundMode: boolean;
  // Debug options
  force_animation: boolean; // reload model before each animation
  force_loop: boolean; // loop the last motion when idle
  showFrames: boolean; // show model frame + hit areas
  /**
   * How emotions are detected on new character messages:
   * - 'llm'    — classify the message with a quiet LLM generation (needs `generation`)
   * - 'native' — reuse Lumiverse's own expression detection (EXPRESSION_CHANGED)
   * - 'off'    — no automatic expression/motion on messages
   */
  expressionSource: 'llm' | 'native' | 'off';
  /** Model library order and layout in the settings tab. */
  librarySort: LibrarySort;
  libraryView: LibraryView;
}

export type LibrarySort = 'name' | 'name_desc' | 'newest' | 'oldest' | 'largest' | 'smallest';
export type LibraryView = 'tiles' | 'list';

export interface Live2DSettings {
  global: GlobalSettings;
  /** characterId -> modelId */
  characterModelMapping: Record<string, string>;
  /** characterId -> modelId -> per-model settings */
  characterModelsSettings: Record<string, Record<string, ModelSettings>>;
}

export interface ModelRecord {
  id: string;
  name: string;
  /** Path of the model settings file (model3.json / model.json) inside the model folder */
  settingsFile: string;
  /** 2 = Cubism 2.1, 4 = Cubism 3/4/5 */
  cubism: 2 | 4;
  sizeBytes: number;
  fileCount: number;
  importedAt: string;
  /** bumped when files change; used for frontend cache invalidation */
  version: number;
  /** Small picture of the model for the library (an image data URL), taken the first time it's shown. */
  thumbnail?: string;
}

export function defaultGlobalSettings(): GlobalSettings {
  return {
    enabled: true,
    followCursor: false,
    autoSendInteraction: false,
    backgroundMode: false,
    force_animation: false,
    force_loop: false,
    showFrames: false,
    expressionSource: 'llm',
    librarySort: 'name',
    libraryView: 'tiles',
  };
}

export function defaultSettings(): Live2DSettings {
  return {
    global: defaultGlobalSettings(),
    characterModelMapping: {},
    characterModelsSettings: {},
  };
}

export function defaultModelSettings(hitAreaNames: string[] = []): ModelSettings {
  const settings: ModelSettings = {
    scale: 1.0,
    x: 0.0,
    y: 0.0,
    rotation: 0,
    clip_to_canvas: true,
    eye: 45,
    cursor_param: {
      idParamAngleX: 'none',
      idParamAngleY: 'none',
      idParamAngleZ: 'none',
      idParamBodyAngleX: 'none',
      idParamBreath: 'none',
      idParamEyeBallX: 'none',
      idParamEyeBallY: 'none',
    },
    param_mouth_open_y_id: 'none',
    mouth_open_speed: 1.0,
    mouth_time_per_character: 30,
    animation_starter: { expression: 'none', motion: 'none', delay: 0 },
    animation_default: { expression: 'none', motion: 'none', loop: false },
    animation_click: { expression: 'none', motion: 'none', message: '' },
    hit_areas: {},
    classify_mapping: {},
  };
  for (const label of CLASSIFY_EXPRESSIONS) {
    settings.classify_mapping[label] = { expression: 'none', motion: 'none' };
  }
  for (const area of hitAreaNames) {
    settings.hit_areas[area] = { expression: 'none', motion: 'none', message: '' };
  }
  return settings;
}

/** Deep-merge a possibly partial/stale stored settings object over defaults. */
export function normalizeSettings(raw: unknown): Live2DSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<Live2DSettings>;
  if (value.global && typeof value.global === 'object') {
    base.global = { ...base.global, ...value.global };
  }
  if (value.characterModelMapping && typeof value.characterModelMapping === 'object') {
    base.characterModelMapping = { ...value.characterModelMapping };
  }
  if (value.characterModelsSettings && typeof value.characterModelsSettings === 'object') {
    base.characterModelsSettings = { ...value.characterModelsSettings };
  }
  return base;
}

/**
 * Ensure a stored per-model settings object has every field, mutating it in
 * place so live references held by the UI and the stage stay valid.
 */
export function ensureModelSettingsShape(settings: ModelSettings, hitAreaNames: string[] = []): ModelSettings {
  const base = defaultModelSettings(hitAreaNames);
  const target = settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(base) as Array<[string, unknown]>) {
    if (target[key] === undefined) target[key] = value;
  }
  for (const nested of ['cursor_param', 'classify_mapping', 'hit_areas'] as const) {
    const baseNested = base[nested] as Record<string, unknown>;
    const targetNested = settings[nested] as Record<string, unknown>;
    for (const [key, value] of Object.entries(baseNested)) {
      if (targetNested[key] === undefined) targetNested[key] = value;
    }
  }
  for (const nested of ['animation_starter', 'animation_default', 'animation_click'] as const) {
    const baseNested = base[nested] as unknown as Record<string, unknown>;
    const targetNested = settings[nested] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(baseNested)) {
      if (targetNested[key] === undefined) targetNested[key] = value;
    }
  }
  return settings;
}

/** Merge a (possibly partial) per-model settings object over defaults. */
export function normalizeModelSettings(raw: unknown, hitAreaNames: string[] = []): ModelSettings {
  const base = defaultModelSettings(hitAreaNames);
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<ModelSettings> & Record<string, unknown>;
  const out: ModelSettings = {
    ...base,
    ...value,
    cursor_param: { ...base.cursor_param, ...(value.cursor_param ?? {}) },
    animation_starter: { ...base.animation_starter, ...(value.animation_starter ?? {}) },
    animation_default: { ...base.animation_default, ...(value.animation_default ?? {}) },
    animation_click: { ...base.animation_click, ...(value.animation_click ?? {}) },
    hit_areas: { ...base.hit_areas, ...(value.hit_areas ?? {}) },
    classify_mapping: { ...base.classify_mapping, ...(value.classify_mapping ?? {}) },
  };
  return out;
}

/**
 * Keep only the fields of an untrusted per-model settings object (an imported
 * file) whose types match the defaults, with numbers clamped to the sliders' ranges.
 */
export function sanitizeModelSettings(raw: unknown): Partial<ModelSettings> {
  if (!isPlainObject(raw)) return {};
  const base = defaultModelSettings() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const fallback = base[key];
    if (fallback === undefined || typeof value !== typeof fallback) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (isPlainObject(fallback) !== isPlainObject(value)) continue;
    out[key] = value;
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    if (typeof out[key] === 'number') out[key] = Math.min(max, Math.max(min, out[key] as number));
  }
  const strings = (value: unknown) =>
    Object.fromEntries(Object.entries(value as object).filter(([, entry]) => typeof entry === 'string'));
  const mappings = (value: unknown, extra: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value as object)
        .filter(([, entry]) => isPlainObject(entry))
        .map(([name, entry]) => [name, pickTyped(entry, { expression: 'none', motion: 'none', ...extra })]),
    );
  if (out.cursor_param) out.cursor_param = strings(out.cursor_param);
  if (out.classify_mapping) out.classify_mapping = mappings(out.classify_mapping, {});
  if (out.hit_areas) out.hit_areas = mappings(out.hit_areas, { message: '' });
  for (const key of ['animation_starter', 'animation_default', 'animation_click'] as const) {
    if (out[key]) out[key] = pickTyped(out[key], base[key] as Record<string, unknown>);
  }
  const starter = out.animation_starter as { delay?: number } | undefined;
  if (starter?.delay !== undefined) starter.delay = Math.min(60_000, Math.max(0, starter.delay));
  return out as Partial<ModelSettings>;
}

const NUMBER_LIMITS: Record<string, [number, number]> = {
  scale: [0.05, 3],
  x: [-100, 100],
  y: [-100, 100],
  rotation: [-180, 180],
  eye: [-100, 100],
  mouth_open_speed: [0.1, 3],
  mouth_time_per_character: [0, 1000],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields of `value` that `shape` has, with the same type. */
function pickTyped(value: unknown, shape: Record<string, unknown>): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(shape)) {
    const entry = source[key];
    if (typeof entry === typeof fallback && !(typeof entry === 'number' && !Number.isFinite(entry))) out[key] = entry;
  }
  return out;
}
