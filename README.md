# Live2D Avatars for Lumiverse

A [Spindle](https://docs.lumiverse.chat/) extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that brings **Live2D animated models** to your chats as character avatars. It replicates the functionality of the [SillyTavern Live2d extension](https://github.com/SillyTavern/Extension-Live2d) on top of Lumiverse's extension APIs.

Supports **Cubism 2.1** (`*.model.json`) and **Cubism 3/4/5** (`*.model3.json`) models.

## Features

- **Model library** — import Live2D model folders as `.zip` archives straight from the browser. Files are stored in the extension's private storage and cached client-side (Cache Storage) for instant reloads.
- **Per-character bindings** — assign a model to each character; the avatar loads automatically when you open that character's chat.
- **Emotion-driven animation** — new character messages are classified into one of the classic 28 emotions (`joy`, `anger`, `surprise`, …) with a quiet LLM generation, and each emotion can be mapped to a model expression and/or motion. Alternatively reuse Lumiverse's own expression detection (`EXPRESSION_CHANGED`) or turn it off.
- **Talking mouth animation** — the mouth-open parameter is animated while the character "speaks", scaled by message length (configurable speed and per-character duration; parameter auto-detected with the same fallbacks as the ST extension).
- **Hit areas & interactions** — click the model to trigger mapped expressions/motions per hit area (priority-ordered like the ST extension), optionally sending a message into the chat and auto-triggering a reply ("Auto-send interaction").
- **Cursor following** — the model's head/eyes/body follow your cursor, with per-model parameter overrides (`ParamAngleX/Y/Z`, `ParamBodyAngleX`, `ParamBreath`, `ParamEyeBallX/Y`) and automatic detection of legacy parameter names.
- **Layout controls** — scale / X / Y / rotation sliders, plus drag-and-drop positioning (positions persist as percent offsets, same formula as the ST extension). Eye-follow offset slider included.
- **Background mode** — a global toggle that draws the model behind the chat instead of over it, so messages and the input bar sit on top of it like a wallpaper. Needs `app_manipulation`. While it's on, the chat takes the clicks, so drag and hit areas don't respond; a chat or character wallpaper or a scene background, if set, covers the model.
- **Starter / default / click animations** — play an animation when a chat opens (with delay), fall back to a default animation when an emotion has no mapping, and configure the default click behavior.
- **Debug tools** — show model frame & hit areas, force animation (reset model before each motion, for models without a stable idle state), force animation looping, and a reload button.
- **ST settings presets** — if a model folder ships a `sillytavern_settings.json`, it is applied automatically the first time the model is used.
- **Command palette** — `Live2D: Open Settings`, `Live2D: Reload Models`, `Live2D: Toggle Enabled` (Ctrl/Cmd+K).

## Installation

Install from the Lumiverse **Extensions** panel with this repository's GitHub URL, or via the REST API:

```
POST /api/v1/spindle/install  { "url": "https://github.com/isiggy/Lumiverse-Live2d-Public" }
```

The repository ships prebuilt bundles in `dist/`, so no build step is needed at install time.

## Permissions

The extension works with whatever you grant and degrades gracefully:

| Permission | Used for | Without it |
|---|---|---|
| `app_manipulation` | rendering the avatar as a full-app overlay | the avatar renders inside the Live2D drawer tab preview |
| `generation` | LLM emotion classification | no automatic emotion detection (native/off modes still work) |
| `chat_mutation` | reading messages (emotion + talking) and sending hit-area interaction messages | no talking animation, no interaction messages |
| `chats` | resolving which character the active chat belongs to | falls back to the frontend's active-chat context |
| `characters` | listing characters by name in the binding UI | bind models to the current chat's character only |

## Usage

1. Open the **Live2D** tab in the sidebar drawer (or press Ctrl/Cmd+K and search "Live2D").
2. Grant the requested permissions from the banner (or from the Extensions panel).
3. **Import a model**: zip a Live2D model folder — the `*.model3.json` / `*.model.json` file plus its textures, motions, expressions, physics — and use *Import model (.zip)*. Nested single-root zips are handled automatically.
4. **Bind it to a character** under *Character model*.
5. Open that character's chat — the avatar appears. Configure scale/position, mouth and cursor parameters, animations, emotion mappings, and hit areas under *Model settings*.

### Emotion mappings

Under *Emotion mappings*, pick an expression and/or motion for each of the 28 classify labels. When a mapping is `none`, the *Default* animation plays instead. Use the ▶ buttons to preview any mapping on the live model, and *Test emotion classification* to see what label a given text produces.

### Hit areas

Models that define hit areas get a row per area under *Hit areas*: expression, motion, and an optional message. Clicking the model picks the highest-priority mapped area under the cursor (or the *On click* defaults). If a message is set, it is sent as you; with *Auto-send interaction* enabled the character replies immediately.

## How it works

- **Backend** (`dist/backend.js`, Bun worker): stores settings + model files in extension user storage, unpacks ZIPs (via [fflate](https://github.com/101arrowz/fflate)), streams model files to the browser in chunked messages, classifies emotions with `spindle.generate.quiet`, and relays chat lifecycle events.
- **Frontend** (`dist/frontend.js`): injects the Live2D runtimes, renders the stage with PIXI + pixi-live2d-display into an app overlay (`ctx.ui.mountApp`) or the drawer tab, and drives all interaction. Model files are loaded from blob URLs via `ModelSettings.replaceFiles`, so nothing is ever served from disk paths.
- The overlay is a `position: fixed` full-viewport canvas with `pointer-events: none`, so it never blocks the app. Clicks and drags are picked up at the document level and go to the model only when they land on one of its visible parts, nothing (like a drawer or modal) is drawn above it there, and the element underneath isn't a control such as the message box, a button or a link.

## Development

```bash
bun install
bun run typecheck
bun run build     # writes dist/backend.js + dist/frontend.js
```

To try the extension in a real local Lumiverse instance (Linux), use `scripts/dev/lumiverse.sh`: `setup`, `start`, `deploy`, then `e2e` for a headless check that the avatar renders. `CLAUDE.md` explains each step and the environment workarounds.

## Bundled third-party runtimes (`vendor/`)

The `vendor/` directory contains the same runtime builds shipped by the SillyTavern Live2d extension, embedded into `dist/frontend.js` at build time:

- `pixi.min.js` — [PixiJS](https://pixijs.com/) v6.5.2, MIT License
- `index.min.js`, `extra.min.js` — [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) (patched build with eye-offset support), MIT License
- `live2dcubismcore.min.js` — Live2D Cubism Core for Web, © Live2D Inc., distributed under the [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
- `live2d.min.js` — Live2D Cubism 2.1 core library, © Live2D Inc.

Live2D and Cubism are trademarks of Live2D Inc. This project is not affiliated with Live2D Inc. If you distribute an application containing the Cubism Core, review Live2D's license terms.

## Known limitations

- One model on stage at a time (the active chat's character). Group-chat multi-model staging is not implemented yet.
- Motion sounds referenced by models play only if the browser allows autoplay.
- Very large models (hundreds of MB) transfer to the browser on first load; subsequent loads come from the local cache.

## License

MIT (see `LICENSE`). Bundled third-party runtimes keep their own licenses as listed above.
