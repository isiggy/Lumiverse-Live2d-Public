/**
 * Live2D Avatars — backend runtime.
 *
 * Owns persistent state (settings + imported model files), unpacks model ZIPs,
 * streams model files to the frontend, classifies message emotions with a
 * quiet LLM generation, and relays chat lifecycle context to the stage.
 */

declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

import { unzipSync } from 'fflate';
import type {
  BackendToFrontend,
  FrontendToBackend,
  GetModelChunkMsg,
  GetModelManifestMsg,
  ImportModelZipMsg,
  InteractionMsg,
  SaveSettingsMsg,
} from './shared/protocol';
import {
  CLASSIFY_EXPRESSIONS,
  FALLBACK_EXPRESSION,
  type Live2DSettings,
  type ModelRecord,
  normalizeSettings,
} from './shared/settings';

const SETTINGS_FILE = 'settings.json';
const REGISTRY_FILE = 'models.json';
const MODELS_DIR = 'models';

const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_FILE_COUNT = 3000;
/** Raw bytes per chunk; base64 expansion keeps this well under the 4 MB message cap. */
const CHUNK_BYTES = 1024 * 1024;

// ── Storage helpers ─────────────────────────────────────────────────────────

async function loadSettings(userId?: string): Promise<Live2DSettings> {
  const raw = await spindle.userStorage.getJson<unknown>(SETTINGS_FILE, {
    fallback: null,
    ...(userId ? { userId } : {}),
  });
  return normalizeSettings(raw);
}

async function saveSettings(settings: Live2DSettings, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(SETTINGS_FILE, settings, {
    indent: 2,
    ...(userId ? { userId } : {}),
  });
}

async function loadRegistry(userId?: string): Promise<ModelRecord[]> {
  const raw = await spindle.userStorage.getJson<ModelRecord[]>(REGISTRY_FILE, {
    fallback: [],
    ...(userId ? { userId } : {}),
  });
  return Array.isArray(raw) ? raw : [];
}

async function saveRegistry(models: ModelRecord[], userId?: string): Promise<void> {
  await spindle.userStorage.setJson(REGISTRY_FILE, models, {
    indent: 2,
    ...(userId ? { userId } : {}),
  });
}

function send(payload: BackendToFrontend, userId?: string): void {
  spindle.sendToFrontend(payload, userId);
}

// ── ZIP import ──────────────────────────────────────────────────────────────

function sanitizeZipPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) return null;
  if (parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'))) return null;
  return parts.join('/');
}

/** Strip a single shared top-level directory, if every file lives under one. */
function stripCommonRoot(paths: string[]): (path: string) => string {
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  const first = [...roots][0];
  if (roots.size === 1 && first !== undefined && paths.every((path) => path.includes('/'))) {
    const prefix = first + '/';
    return (path) => path.slice(prefix.length);
  }
  return (path) => path;
}

function findModelSettingsFile(paths: string[]): { path: string; cubism: 2 | 4 } | null {
  const model3 = paths
    .filter((path) => path.toLowerCase().endsWith('.model3.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (model3) return { path: model3, cubism: 4 };
  const model2 = paths
    .filter((path) => path.toLowerCase().endsWith('.model.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (model2) return { path: model2, cubism: 2 };
  return null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'model'
  );
}

async function handleImportZip(msg: ImportModelZipMsg, userId: string): Promise<void> {
  const upload = await spindle.uploads.get(msg.uploadId, userId);
  if (!upload) {
    send({ type: 'import_error', error: 'Upload not found or expired. Try again.' }, userId);
    return;
  }
  try {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(upload.data);
    } catch {
      send({ type: 'import_error', error: 'Could not read the ZIP archive.' }, userId);
      return;
    }

    const cleaned: Array<{ path: string; data: Uint8Array }> = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      const path = sanitizeZipPath(rawPath);
      if (!path || data.length === 0) continue;
      cleaned.push({ path, data });
    }
    if (cleaned.length === 0) {
      send({ type: 'import_error', error: 'The ZIP archive is empty.' }, userId);
      return;
    }
    if (cleaned.length > MAX_FILE_COUNT) {
      send({ type: 'import_error', error: `Too many files in archive (max ${MAX_FILE_COUNT}).` }, userId);
      return;
    }
    const totalBytes = cleaned.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > MAX_UNPACKED_BYTES) {
      send({ type: 'import_error', error: 'Unpacked model exceeds the 512 MB limit.' }, userId);
      return;
    }

    const strip = stripCommonRoot(cleaned.map((file) => file.path));
    const files = cleaned
      .map((file) => ({ path: strip(file.path), data: file.data }))
      .filter((file) => file.path.length > 0);

    const settingsFile = findModelSettingsFile(files.map((file) => file.path));
    if (!settingsFile) {
      send(
        {
          type: 'import_error',
          error: 'No Live2D settings file (*.model3.json or *.model.json) found in the archive.',
        },
        userId,
      );
      return;
    }

    const registry = await loadRegistry(userId);
    const baseName =
      msg.name?.trim() ||
      settingsFile.path.split('/').pop()!.replace(/\.model3?\.json$/i, '').replace(/\.model$/i, '') ||
      upload.fileName.replace(/\.zip$/i, '');
    let id = slugify(baseName);
    let suffix = 2;
    while (registry.some((model) => model.id === id)) {
      id = `${slugify(baseName)}_${suffix++}`;
    }

    for (const file of files) {
      await spindle.userStorage.writeBinary(`${MODELS_DIR}/${id}/${file.path}`, file.data, userId);
    }

    const record: ModelRecord = {
      id,
      name: baseName,
      settingsFile: settingsFile.path,
      cubism: settingsFile.cubism,
      sizeBytes: totalBytes,
      fileCount: files.length,
      importedAt: new Date().toISOString(),
      version: 1,
    };
    registry.push(record);
    await saveRegistry(registry, userId);

    spindle.log.info(`live2d: imported model "${record.name}" (${files.length} files, ${totalBytes} bytes)`);
    send({ type: 'model_imported', model: record }, userId);
    spindle.toast.success(`Live2D model "${record.name}" imported.`, userId ? { userId } : undefined);
  } finally {
    await spindle.uploads.delete(msg.uploadId, userId).catch(() => {});
  }
}

async function handleDeleteModel(modelId: string, userId: string): Promise<void> {
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === modelId);
  if (!record) return;

  const prefix = `${MODELS_DIR}/${modelId}/`;
  for (const key of [...fileCache.keys()]) {
    if (key.startsWith(`${userId}:${prefix}`)) fileCache.delete(key);
  }
  const files = await spindle.userStorage.list(prefix, userId);
  for (const file of files) {
    await spindle.userStorage.delete(file, userId).catch(() => {});
  }
  await saveRegistry(
    registry.filter((model) => model.id !== modelId),
    userId,
  );

  // Drop dangling character bindings
  const settings = await loadSettings(userId);
  let changed = false;
  for (const [characterId, boundModel] of Object.entries(settings.characterModelMapping)) {
    if (boundModel === modelId) {
      delete settings.characterModelMapping[characterId];
      changed = true;
    }
  }
  if (changed) await saveSettings(settings, userId);

  send({ type: 'model_deleted', modelId }, userId);
}

// ── Model file streaming ────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

interface TransferSession {
  prefix: string;
  files: Set<string>;
  lastUsed: number;
}

const TRANSFER_IDLE_MS = 10 * 60 * 1000;
const FILE_CACHE_IDLE_MS = 60 * 1000;
const FILE_CACHE_MAX_ENTRIES = 3;

/** Open transfers, keyed by user + browser-chosen request id. */
const transfers = new Map<string, TransferSession>();
/** Whole files kept briefly so consecutive chunk requests don't re-read them. */
const fileCache = new Map<string, { bytes: Promise<Uint8Array>; lastUsed: number }>();

function sweepTransferState(now: number): void {
  for (const [key, session] of transfers) {
    if (now - session.lastUsed > TRANSFER_IDLE_MS) transfers.delete(key);
  }
  for (const [key, entry] of fileCache) {
    if (now - entry.lastUsed > FILE_CACHE_IDLE_MS) fileCache.delete(key);
  }
}

function readCachedFile(userId: string, path: string): Promise<Uint8Array> {
  const key = `${userId}:${path}`;
  const now = Date.now();
  let entry = fileCache.get(key);
  if (!entry) {
    while (fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
      const oldest = [...fileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      fileCache.delete(oldest[0]);
    }
    const bytes = spindle.userStorage.readBinary(path, userId);
    bytes.catch(() => fileCache.delete(key));
    entry = { bytes, lastUsed: now };
    fileCache.set(key, entry);
  }
  entry.lastUsed = now;
  return entry.bytes;
}

async function handleGetModelManifest(msg: GetModelManifestMsg, userId: string): Promise<void> {
  sweepTransferState(Date.now());
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record) {
    send({ type: 'model_files_error', reqId: msg.reqId, error: `Unknown model: ${msg.modelId}` }, userId);
    return;
  }

  const prefix = `${MODELS_DIR}/${record.id}/`;
  const listed = await spindle.userStorage.list(prefix, userId);
  const relative = listed
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .filter((path) => path.length > 0);

  const files: Array<{ path: string; size: number }> = [];
  for (const path of relative) {
    const stat = await spindle.userStorage.stat(prefix + path, userId);
    if (stat.isFile) files.push({ path, size: stat.sizeBytes });
  }

  let presetSettings: unknown;
  const presetPath = relative.find((path) => path.toLowerCase().endsWith('sillytavern_settings.json'));
  if (presetPath) {
    try {
      presetSettings = JSON.parse(await spindle.userStorage.read(prefix + presetPath, userId));
    } catch {
      presetSettings = undefined;
    }
  }

  transfers.set(`${userId}:${msg.reqId}`, {
    prefix,
    files: new Set(files.map((file) => file.path)),
    lastUsed: Date.now(),
  });

  send(
    {
      type: 'model_manifest',
      reqId: msg.reqId,
      modelId: record.id,
      version: record.version,
      settingsFile: record.settingsFile,
      cubism: record.cubism,
      chunkBytes: CHUNK_BYTES,
      files,
      ...(presetSettings !== undefined ? { presetSettings } : {}),
    },
    userId,
  );
}

async function handleGetModelChunk(msg: GetModelChunkMsg, userId: string): Promise<void> {
  const session = transfers.get(`${userId}:${msg.reqId}`);
  if (!session || !session.files.has(msg.path)) {
    send({ type: 'model_files_error', reqId: msg.reqId, error: 'Transfer expired or unknown file; reload the model.' }, userId);
    return;
  }
  session.lastUsed = Date.now();
  const bytes = await readCachedFile(userId, session.prefix + msg.path);
  const seq = Math.max(0, Math.floor(msg.seq));
  const slice = bytes.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, bytes.length));
  send({ type: 'model_chunk', reqId: msg.reqId, path: msg.path, seq, dataB64: toBase64(slice) }, userId);
}

// ── Emotion classification ──────────────────────────────────────────────────

function trimToEndSentence(text: string): string {
  const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '\n']);
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i]!;
    if (punctuation.has(char)) {
      return text.substring(0, i + 1).trimEnd();
    }
  }
  return text.trimEnd();
}

function trimToStartSentence(text: string): string {
  const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '\n']);
  for (let i = 0; i < text.length; i++) {
    if (punctuation.has(text[i]!)) {
      return text.substring(i + 1).trimStart();
    }
  }
  return text;
}

/** Same sampling as the SillyTavern extension: strip markup, keep ends of long messages. */
function sampleClassifyText(text: string): string {
  let result = text.replace(/[\*\"]/g, '');
  const SAMPLE_THRESHOLD = 300;
  const HALF = SAMPLE_THRESHOLD / 2;
  if (text.length < SAMPLE_THRESHOLD) {
    result = trimToEndSentence(result);
  } else {
    result = trimToEndSentence(result.slice(0, HALF)) + ' ' + trimToStartSentence(result.slice(-HALF));
  }
  return result.trim();
}

async function classifyExpression(text: string): Promise<string> {
  if (!text || !spindle.permissions.has('generation')) return FALLBACK_EXPRESSION;
  const labels = CLASSIFY_EXPRESSIONS.join(', ');
  try {
    const result = (await spindle.generate.quiet({
      type: 'quiet',
      messages: [
        {
          role: 'system',
          content:
            'You classify the dominant emotion of a roleplay message. ' +
            `Respond with exactly one word from this list and nothing else: ${labels}.`,
        },
        { role: 'user', content: sampleClassifyText(text) },
      ],
      parameters: { max_tokens: 16, temperature: 0 },
    })) as { content?: string } | null;
    const response = (result?.content ?? '').toLowerCase();
    // Prefer an exact word match; fall back to the first label mentioned anywhere.
    const words = response.split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      if ((CLASSIFY_EXPRESSIONS as readonly string[]).includes(word)) return word;
    }
    for (const label of CLASSIFY_EXPRESSIONS) {
      if (response.includes(label)) return label;
    }
  } catch (error) {
    spindle.log.warn(`live2d: classification failed: ${String(error)}`);
  }
  return FALLBACK_EXPRESSION;
}

// ── Chat lifecycle ──────────────────────────────────────────────────────────

async function resolveChatCharacter(chatId: string, userId?: string): Promise<string | null> {
  if (!spindle.permissions.has('chats')) return null;
  try {
    const chat = await spindle.chats.get(chatId, userId);
    return chat?.character_id ?? null;
  } catch {
    return null;
  }
}

async function handleCharacterMessageRendered(
  payload: { chatId: string; messageId: string },
  userId?: string,
): Promise<void> {
  const settings = await loadSettings(userId);
  if (!settings.global.enabled) return;

  const characterId = await resolveChatCharacter(payload.chatId, userId);

  let text = '';
  if (spindle.permissions.has('chat_mutation')) {
    try {
      const messages = await spindle.chat.getMessages(payload.chatId);
      const message = messages.find((entry) => entry.id === payload.messageId);
      if (message && !message.is_user) text = message.content ?? '';
    } catch (error) {
      spindle.log.warn(`live2d: could not read message: ${String(error)}`);
    }
  }

  send(
    {
      type: 'character_message',
      chatId: payload.chatId,
      characterId,
      messageId: payload.messageId,
      textLength: text.length,
    },
    userId,
  );

  if (settings.global.expressionSource !== 'llm') return;
  if (!text) return;

  const label = await classifyExpression(text);
  send({ type: 'expression', chatId: payload.chatId, characterId, label, source: 'llm' }, userId);
}

async function handleInteraction(msg: InteractionMsg, userId?: string): Promise<void> {
  if (!spindle.permissions.has('chat_mutation')) {
    spindle.toast.warning(
      'Grant the "Chat mutation" permission to send Live2D interaction messages.',
      userId ? { userId } : undefined,
    );
    return;
  }
  try {
    await spindle.chat.appendMessage(
      msg.chatId,
      { role: 'user', content: msg.message },
      msg.generate ? { triggerGeneration: true } : undefined,
    );
  } catch (error) {
    spindle.log.warn(`live2d: interaction failed: ${String(error)}`);
    spindle.toast.error(`Live2D interaction failed: ${String(error)}`, userId ? { userId } : undefined);
  }
}

// ── State snapshot ──────────────────────────────────────────────────────────

async function sendState(userId: string): Promise<void> {
  const settings = await loadSettings(userId);
  const models = await loadRegistry(userId);

  let characters: Array<{ id: string; name: string }> = [];
  if (spindle.permissions.has('characters')) {
    try {
      const { data } = await spindle.characters.list({ limit: 200, userId });
      characters = data.map((character) => ({ id: character.id, name: character.name }));
    } catch {
      characters = [];
    }
  }

  const permissions = await spindle.permissions.getGranted();
  send({ type: 'state', settings, models, characters, permissions }, userId);
}

// ── Message router ──────────────────────────────────────────────────────────

spindle.onFrontendMessage(async (payload, userId) => {
  const msg = payload as FrontendToBackend;
  try {
    switch (msg.type) {
      case 'get_state':
        await sendState(userId);
        break;
      case 'save_settings':
        await saveSettings(normalizeSettings((msg as SaveSettingsMsg).settings), userId);
        send({ type: 'settings_saved' }, userId);
        break;
      case 'import_model_zip':
        await handleImportZip(msg, userId);
        break;
      case 'delete_model':
        await handleDeleteModel(msg.modelId, userId);
        break;
      case 'get_model_manifest':
        await handleGetModelManifest(msg, userId);
        break;
      case 'get_model_chunk':
        await handleGetModelChunk(msg, userId);
        break;
      case 'interaction':
        await handleInteraction(msg, userId);
        break;
      case 'classify_test': {
        const label = await classifyExpression(msg.text);
        send({ type: 'classify_test_result', label }, userId);
        break;
      }
    }
  } catch (error) {
    spindle.log.error(`live2d: error handling ${msg?.type ?? 'message'}: ${String(error)}`);
    if (msg?.type === 'import_model_zip') {
      send({ type: 'import_error', error: String(error) }, userId);
    } else if (msg?.type === 'get_model_manifest' || msg?.type === 'get_model_chunk') {
      send({ type: 'model_files_error', reqId: msg.reqId, error: String(error) }, userId);
    }
  }
});

// ── Event subscriptions ─────────────────────────────────────────────────────

spindle.on('CHARACTER_MESSAGE_RENDERED', (payload, userId) => {
  const event = payload as { chatId: string; messageId: string };
  if (!event?.chatId || !event?.messageId) return;
  void handleCharacterMessageRendered(event, userId);
});

// Reuse Lumiverse's native expression detection when the user prefers it.
spindle.on('EXPRESSION_CHANGED', (payload, userId) => {
  const event = payload as { chatId: string; characterId: string; label: string };
  if (!event?.chatId || !event?.label) return;
  void (async () => {
    const settings = await loadSettings(userId);
    if (!settings.global.enabled || settings.global.expressionSource !== 'native') return;
    send(
      {
        type: 'expression',
        chatId: event.chatId,
        characterId: event.characterId ?? null,
        label: event.label,
        source: 'native',
      },
      userId,
    );
  })();
});

spindle.on('CHAT_SWITCHED', (payload, userId) => {
  const event = payload as { chatId: string | null };
  void (async () => {
    const characterId = event?.chatId ? await resolveChatCharacter(event.chatId, userId) : null;
    send({ type: 'chat_context', chatId: event?.chatId ?? null, characterId }, userId);
  })();
});

spindle.permissions.onChanged(({ allGranted }) => {
  send({ type: 'permissions_changed', permissions: allGranted });
});

// ── Command palette ─────────────────────────────────────────────────────────

spindle.commands.register([
  {
    id: 'live2d-open-settings',
    label: 'Live2D: Open Settings',
    description: 'Open the Live2D Avatars settings tab',
    keywords: ['live2d', 'avatar', 'model', 'settings'],
  },
  {
    id: 'live2d-reload',
    label: 'Live2D: Reload Models',
    description: 'Reload all Live2D models on the stage',
    keywords: ['live2d', 'reload', 'reset'],
  },
  {
    id: 'live2d-toggle',
    label: 'Live2D: Toggle Enabled',
    description: 'Enable or disable the Live2D avatar stage',
    keywords: ['live2d', 'toggle', 'enable', 'disable'],
  },
]);

spindle.commands.onInvoked((commandId) => {
  void (async () => {
    switch (commandId) {
      case 'live2d-open-settings':
        send({ type: 'focus_tab' });
        break;
      case 'live2d-reload':
        send({ type: 'reload_models' });
        break;
      case 'live2d-toggle': {
        const settings = await loadSettings();
        settings.global.enabled = !settings.global.enabled;
        await saveSettings(settings);
        send({ type: 'toggle_enabled', enabled: settings.global.enabled });
        spindle.toast.info(`Live2D ${settings.global.enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
    }
  })();
});

spindle.log.info('live2d: backend ready');
