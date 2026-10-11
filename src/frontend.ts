/**
 * Live2D Avatars — frontend module.
 *
 * Wires the stage (overlay or in-tab preview), the settings drawer tab, the
 * backend message channel, and chat lifecycle events together.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { ModelAssets } from './frontend/assets';
import { Stage, type ModelDescription } from './frontend/stage';
import { SettingsUI, UI_CSS, type UIController } from './frontend/ui';
import { tusUpload } from './frontend/tus';
import type { BackendToFrontend, ExpressionMsg } from './shared/protocol';
import {
  defaultSettings,
  ensureModelSettingsShape,
  normalizeModelSettings,
  normalizeSettings,
  type Live2DSettings,
  type ModelRecord,
  type ModelSettings,
} from './shared/settings';

const EXTENSION_ID = 'live2d_avatars';

const STAGE_CSS = `
.live2d-avatars-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 4; }
.live2d-avatars-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; background: transparent; }
html.live2d-avatars-hover, html.live2d-avatars-hover * { cursor: grab !important; }
/* Background mode: the host mounts the overlay at z-index 9990 above the whole
   app. Drop it to 0 so it sits above the app's backdrop and global wallpaper
   but under <main> (z-index 1), which holds the chat. While a chat is open the
   overlay moves into the chat view instead (see placeOverlay). */
html.live2d-avatars-bg .live2d-avatars-mount { z-index: 0 !important; }
html.live2d-avatars-bg .live2d-avatars-overlay { z-index: 0; }
`;

const TAB_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4.2"/><path d="M9.5 7.5h.01M14.5 7.5h.01"/><path d="M10 10c.6.6 1.3.9 2 .9s1.4-.3 2-.9"/><path d="M4.5 21c.8-3.6 3.9-6 7.5-6s6.7 2.4 7.5 6"/></svg>';

export function setup(ctx: SpindleFrontendContext) {
  ctx.deferReady();

  // ── State store ───────────────────────────────────────────────────────────
  let settings: Live2DSettings = defaultSettings();
  let models: ModelRecord[] = [];
  let characters: Array<{ id: string; name: string }> = [];
  let permissions: string[] = [];
  let stateReceived = false;

  const cleanups: Array<() => void> = [];
  const removeStyle = ctx.dom.addStyle(STAGE_CSS + UI_CSS);
  cleanups.push(removeStyle);

  const assets = new ModelAssets((payload) => ctx.sendToBackend(payload));

  // ── Persistence ───────────────────────────────────────────────────────────
  let saveTimer: number | null = null;
  const saveNow = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    ctx.sendToBackend({ type: 'save_settings', settings });
  };
  const saveDebounced = () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 500);
  };

  const getOrCreateModelSettings = (
    characterId: string,
    modelId: string,
    description: ModelDescription | null,
    preset?: unknown,
  ): ModelSettings => {
    const byCharacter = (settings.characterModelsSettings[characterId] ??= {});
    let modelSettings = byCharacter[modelId];
    if (!modelSettings) {
      modelSettings =
        preset !== undefined && preset !== null
          ? normalizeModelSettings(preset, description?.hitAreas ?? [])
          : normalizeModelSettings(null, description?.hitAreas ?? []);
      byCharacter[modelId] = modelSettings;
      saveDebounced();
    } else {
      ensureModelSettingsShape(modelSettings, description?.hitAreas ?? []);
    }
    return modelSettings;
  };

  // ── Stage ─────────────────────────────────────────────────────────────────
  const stage = new Stage({
    getSettings: () => settings,
    getModelRecord: (modelId) => models.find((model) => model.id === modelId),
    getModelSettings: getOrCreateModelSettings,
    saveSettingsDebounced: saveDebounced,
    assets,
    sendInteraction: (message) => {
      const { chatId } = stage.getChatContext();
      if (!chatId) return;
      ctx.sendToBackend({
        type: 'interaction',
        chatId,
        message,
        generate: settings.global.autoSendInteraction,
      });
    },
    log: (message) => console.debug('[live2d]', message),
  });
  cleanups.push(() => stage.destroy());

  // ── Stage host: app overlay when permitted, tab preview otherwise ─────────
  const embeddedHost = document.createElement('div');
  let overlayMount: { root: HTMLElement; mountRoot: HTMLElement; destroy(): void } | null = null;
  let overlayActive = false;

  const ensureStageHost = () => {
    if (permissions.includes('app_manipulation')) {
      if (!overlayMount) {
        try {
          const mount = ctx.ui.mountApp({ className: 'live2d-avatars-mount', position: 'app-overlay' });
          const host = document.createElement('div');
          host.className = 'live2d-avatars-overlay';
          mount.root.appendChild(host);
          overlayMount = {
            root: host,
            mountRoot: mount.root,
            destroy: () => {
              host.remove();
              mount.destroy();
            },
          };
          cleanups.push(() => overlayMount?.destroy());
        } catch (error) {
          console.debug('[live2d] overlay mount unavailable:', error);
        }
      }
      if (overlayMount) {
        overlayActive = true;
        stage.setHost(overlayMount.root);
        applyBackgroundMode();
        return;
      }
    }
    overlayActive = false;
    stage.setHost(embeddedHost);
    applyBackgroundMode();
  };

  const applyBackgroundMode = () => {
    const on = settings.global.enabled && settings.global.backgroundMode && overlayActive;
    document.documentElement.classList.toggle('live2d-avatars-bg', on);
    setOverlayTracking(on);
    placeOverlay();
  };
  cleanups.push(() => document.documentElement.classList.remove('live2d-avatars-bg'));

  // In background mode the chat view draws its own wallpaper and scene image
  // inside <main>, faded by the user's wallpaper opacity. Under <main> the model
  // would show through that fade, so a fully opaque wallpaper hid it. Instead the
  // overlay goes inside the chat view, just before the chat body: positioned at
  // z-index 0 after the wallpaper and scene layers (also z-index 0), it paints
  // above them and below the text scrim (1) and the chat itself (3).
  const placeOverlay = () => {
    if (!overlayMount) return;
    const host = overlayMount.root;
    const bgOn = document.documentElement.classList.contains('live2d-avatars-bg');
    // Fast path for the observer, which fires on every chat update: still in place.
    const next = host.nextElementSibling;
    if (bgOn && host.isConnected && next?.getAttribute('data-lumiverse-surface') === 'chat-body') return;
    const chatBody = bgOn
      ? document.querySelector('[data-component="ChatView"] > [data-lumiverse-surface="chat-body"]')
      : null;
    const target = chatBody?.parentElement ?? overlayMount.mountRoot;
    if (host.parentElement === target && (!chatBody || host.nextElementSibling === chatBody)) return;
    target.insertBefore(host, chatBody ?? null);
  };

  // Opening another chat or page replaces the chat view, so follow it.
  let overlayObserver: MutationObserver | null = null;
  let placeFrame: number | null = null;
  const setOverlayTracking = (on: boolean) => {
    if (on && !overlayObserver) {
      overlayObserver = new MutationObserver(() => {
        if (placeFrame !== null) return;
        placeFrame = window.requestAnimationFrame(() => {
          placeFrame = null;
          placeOverlay();
        });
      });
      overlayObserver.observe(document.querySelector('[data-app-root]') ?? document.body, {
        childList: true,
        subtree: true,
      });
    } else if (!on && overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
      if (placeFrame !== null) window.cancelAnimationFrame(placeFrame);
      placeFrame = null;
    }
  };
  cleanups.push(() => setOverlayTracking(false));

  // ── Settings tab ──────────────────────────────────────────────────────────
  let classifyPending: { resolve: (label: string) => void; reject: (error: Error) => void } | null = null;

  const controller: UIController = {
    getSettings: () => settings,
    getModels: () => models,
    getCharacters: () => characters,
    getPermissions: () => permissions,
    getActiveCharacterId: () => ctx.getActiveChat().characterId,
    stage,
    saveDebounced,
    saveNow,
    reloadStage: () => {
      applyBackgroundMode();
      void stage.reload();
    },
    importZip: async (status) => {
      const files = await ctx.uploads.pickFile({
        accept: ['.zip', 'application/zip'],
        maxSizeBytes: 512 * 1024 * 1024,
      });
      const file = files[0];
      if (!file) return;
      status('Uploading…');
      try {
        const uploadId = await tusUpload(file.bytes, file.name, EXTENSION_ID, (sent, total) => {
          status(`Uploading… ${Math.round((sent / total) * 100)}%`);
        });
        status('Importing…');
        ctx.sendToBackend({ type: 'import_model_zip', uploadId, name: file.name.replace(/\.zip$/i, '') });
      } catch (error) {
        status(`Upload failed: ${String(error)}`);
      }
    },
    deleteModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Delete Live2D model',
        message: `Delete "${record?.name ?? modelId}" and its files? Character bindings to it are removed.`,
        variant: 'danger',
        confirmLabel: 'Delete',
      });
      if (confirmed) ctx.sendToBackend({ type: 'delete_model', modelId });
    },
    classifyTest: (text) =>
      new Promise<string>((resolve, reject) => {
        classifyPending = { resolve, reject };
        ctx.sendToBackend({ type: 'classify_test', text });
        setTimeout(() => {
          if (classifyPending) {
            classifyPending = null;
            reject(new Error('Timed out.'));
          }
        }, 60_000);
      }),
    describeModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      if (!record) throw new Error(`Unknown model: ${modelId}`);
      return stage.describeModel(record);
    },
    getDownloadProgress: (modelId) => assets.progress(modelId),
    getOrCreateModelSettings,
    requestPermissions: async (perms) => {
      try {
        permissions = await ctx.permissions.request(perms);
      } catch {
        /* user declined */
      }
      ensureStageHost();
      ui.render();
    },
    embeddedHost,
    usingOverlay: () => overlayActive,
    applyBackgroundMode,
  };

  const ui = new SettingsUI(controller);

  const tab = ctx.ui.registerDrawerTab({
    id: 'live2d',
    title: 'Live2D Avatars',
    shortName: 'Live2D',
    description: 'Animated Live2D character avatars',
    keywords: ['live2d', 'avatar', 'model', 'vtuber', 'cubism'],
    headerTitle: 'Live2D',
    iconSvg: TAB_ICON,
  });
  ui.mount(tab.root);
  cleanups.push(() => tab.destroy());

  const inputAction = ctx.ui.registerInputBarAction({
    id: 'live2d-settings',
    label: 'Live2D Settings',
    iconSvg: TAB_ICON,
  });
  const unsubAction = inputAction.onClick(() => tab.activate());
  cleanups.push(() => {
    unsubAction();
    inputAction.destroy();
  });

  // ── Backend message handling ──────────────────────────────────────────────
  const playMappedExpression = (msg: ExpressionMsg) => {
    const { chatId, characterId } = stage.getChatContext();
    if (!chatId || msg.chatId !== chatId) return;
    if (msg.characterId && characterId && msg.characterId !== characterId) return;
    const current = stage.currentModel();
    if (!current) return;
    const modelSettings = getOrCreateModelSettings(current.characterId, current.modelId, stage.getDescription());
    const mapping = modelSettings.classify_mapping[msg.label] ?? { expression: 'none', motion: 'none' };
    let expression = mapping.expression;
    let motion = mapping.motion;
    if (expression === 'none') expression = modelSettings.animation_default.expression;
    if (motion === 'none') motion = modelSettings.animation_default.motion;
    if (expression !== 'none') void stage.playExpression(expression);
    if (motion !== 'none') void stage.playMotion(motion);
  };

  const unsubBackend = ctx.onBackendMessage((payload) => {
    const msg = payload as BackendToFrontend;
    if (assets.handleMessage(msg)) return;
    switch (msg.type) {
      case 'state': {
        settings = normalizeSettings(msg.settings);
        models = msg.models;
        characters = msg.characters;
        permissions = msg.permissions;
        stateReceived = true;
        ensureStageHost();
        const active = ctx.getActiveChat();
        stage.setChatContext(active.chatId, active.characterId);
        ui.render();
        break;
      }
      case 'settings_saved':
        break;
      case 'model_imported':
        models = [...models.filter((model) => model.id !== msg.model.id), msg.model];
        ui.render();
        void stage.reload();
        break;
      case 'model_deleted':
        models = models.filter((model) => model.id !== msg.modelId);
        assets.invalidate(msg.modelId);
        for (const characterId of Object.keys(settings.characterModelMapping)) {
          if (settings.characterModelMapping[characterId] === msg.modelId) {
            delete settings.characterModelMapping[characterId];
          }
        }
        ui.render();
        void stage.reload();
        break;
      case 'import_error':
        ui.render();
        void ctx.ui.showConfirm({
          title: 'Live2D import failed',
          message: msg.error,
          variant: 'warning',
          confirmLabel: 'OK',
        });
        break;
      case 'expression':
        playMappedExpression(msg);
        break;
      case 'character_message': {
        // In a group chat only the character on stage talks.
        const { chatId, characterId } = stage.getChatContext();
        if (!chatId || msg.chatId !== chatId || msg.textLength === 0) break;
        if (msg.characterId && characterId && msg.characterId !== characterId) break;
        void stage.playTalk(msg.textLength);
        break;
      }
      case 'chat_context':
        stage.setChatContext(msg.chatId, msg.characterId ?? ctx.getActiveChat().characterId);
        break;
      case 'classify_test_result':
        if (classifyPending) {
          const pending = classifyPending;
          classifyPending = null;
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.label);
        }
        break;
      case 'permissions_changed':
        permissions = msg.permissions;
        ensureStageHost();
        ui.render();
        break;
      case 'focus_tab':
        tab.activate();
        break;
      case 'reload_models':
        void stage.reload();
        break;
      case 'toggle_enabled':
        settings.global.enabled = msg.enabled;
        applyBackgroundMode();
        ui.render();
        void stage.reload();
        break;
    }
  });
  cleanups.push(unsubBackend);

  // Chat switches reach us via the backend relay; this direct subscription is
  // the fallback when the backend lacks the `chats` permission.
  const unsubChat = ctx.events.on('CHAT_SWITCHED', () => {
    window.setTimeout(() => {
      const active = ctx.getActiveChat();
      stage.setChatContext(active.chatId, active.characterId);
    }, 50);
  });
  cleanups.push(unsubChat);

  // ── Boot ──────────────────────────────────────────────────────────────────
  ctx.sendToBackend({ type: 'get_state' });
  ctx.ready();

  // If the backend was still starting, retry the state request once.
  window.setTimeout(() => {
    if (!stateReceived) ctx.sendToBackend({ type: 'get_state' });
  }, 3000);

  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
    ctx.dom.cleanup();
  };
}
