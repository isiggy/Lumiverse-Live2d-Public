# Lumiverse Live2D extension

A Spindle extension for Lumiverse that shows Live2D models as character avatars (a port of SillyTavern's Extension-Live2d). See README.md for features.

## Layout

- `spindle.json`: extension manifest.
- `src/backend.ts`: runs in a Lumiverse-managed Bun process. Settings and model storage, ZIP import, streaming model files to the browser, LLM emotion classification.
- `src/frontend.ts`: browser entry. Wires the stage, settings tab and backend messages together.
- `src/frontend/stage.ts`: PIXI + pixi-live2d-display rendering and model interaction. `ui.ts` is the settings tab, `assets.ts` the model file cache, `runtime.ts` loads the vendored libraries, `tus.ts` the upload client.
- `src/shared/`: the settings schema and the frontend/backend message types.
- `vendor/`: Live2D and PIXI runtime builds, embedded into `dist/frontend.js` at build time.
- `dist/` is committed, because Lumiverse installs straight from the repo. Rebuild before committing source changes.

## Build

`node_modules` doesn't survive between cloud sessions, so run `bun install` first.

```bash
bun install && bun run typecheck && bun run build
```

## Testing in a real Lumiverse instance

Use `scripts/dev/lumiverse.sh`; don't set Lumiverse up by hand. In a Claude Code session, put its work directory in the session scratchpad:

```bash
export LUMI_WORK=<scratchpad>/lumi
scripts/dev/lumiverse.sh setup    # ~20s: Bun 1.4, clone Lumiverse, install deps
scripts/dev/lumiverse.sh start    # background server on http://127.0.0.1:7860 (owner / live2dtest123)
scripts/dev/lumiverse.sh deploy   # build this repo, install or update the extension, grant permissions, enable
scripts/dev/lumiverse.sh e2e      # headless: create a Haru chat, import and bind the Haru model, check it renders
```

`e2e` prints `OK: avatar overlay is on screen` and writes screenshots to `$LUMI_WORK/shots/`. After changing code, run `deploy` then `e2e` again.

- `e2e --model path/to/model.zip` tests a specific model instead of Haru. The extension names an imported model after its zip file, so `e2e` finds it by that name and imports it only if it isn't in the library yet.
- `e2e --slow` sends the browser's traffic through a 3 MB/s proxy (`scripts/dev/throttle-proxy.mjs`), like a remote user. Use it for anything that touches model downloads: over loopback the browser keeps up with any amount of data, so transfer bugs don't show.

Other commands: `stop`, `restart`, `status`, `logs [n]`, `seed` (character and chat only), `models` (Haru and Shizuku test ZIPs in `$LUMI_WORK/models/`). `export` the variable rather than prefixing one command, since every command reads it.

### Pitfalls the script handles (don't rediscover them)

- **Old Bun.** The preinstalled Bun is 1.3.x and Lumiverse refuses to start below 1.4. `bun.sh` is blocked by the network proxy, so the script downloads Bun from GitHub releases.
- **Extension backend crashes with `TypeError: Unable to deserialize data`.** Lumiverse runs extension backends with `bun` from PATH (the old one), and the IPC handshake between Bun versions fails. The script sets `LUMIVERSE_BUN_METHOD=direct` and `LUMIVERSE_BUN_PATH` so they use the same Bun as the server.
- **`EAFNOSUPPORT` on listen.** Lumiverse binds `::` and the container has no IPv6. The script patches `src/main.ts` to bind `0.0.0.0`.
- **Server exits asking for the setup wizard.** It needs `OWNER_PASSWORD` (and `OWNER_USERNAME`) on first boot to create the owner account.
- **No web app build needed.** Lumiverse commits a prebuilt `frontend/dist`; the server just needs `FRONTEND_DIR` pointing at it.
- **Stopping the server.** Use `lumiverse.sh stop`, which kills the saved PID. `pkill -f "src/index.ts"` also matches the Bash tool's own shell command and kills it (exit code 144).
- **REST quirks.** Log in with `POST /api/auth/sign-in/username` and keep the cookie. `GET /api/v1/spindle/` with a trailing slash returns the web app's HTML. Without the slash it returns `{ extensions: [...] }`.
- **Locally installed extensions** go in `$DATA_DIR/extensions/<identifier>/repo/` and are registered with `POST /api/v1/spindle/import-local`. They install operator-scoped.

### Browser testing notes

- Playwright uses the preinstalled Chromium at `/opt/pw-browsers/chromium`. Pass `--enable-unsafe-swiftshader` or WebGL (and the model) won't render.
- The Live2D drawer tab can be scrolled out of the sidebar, so click it from the DOM (see `scripts/dev/e2e.mjs`).
- A test harness that fakes the host `ctx` is not enough: the first-version bug (zero-height overlay) only showed up in the real app. Check with `e2e`.

## Sending data to the browser

`spindle.sendToFrontend` messages reach the browser through Bun's WebSocket pub/sub, which **silently drops** messages once about 16 MB is queued for a connection. A large model pushed in one burst lost chunks and hung at "Loading model details…" until it timed out. That's why the browser pulls model files a few 1 MB chunks at a time (`src/frontend/assets.ts`, `get_model_manifest` / `get_model_chunk` in `src/backend.ts`) and re-requests chunks that don't arrive. Keep anything large on that pattern rather than pushing it.

## Reference

docs.lumiverse.chat is blocked by the network proxy. The same docs are in the Lumiverse repo under `developer-docs/docs/`, at `$LUMI_WORK/Lumiverse` after `setup`. Host internals worth knowing:

- `frontend/src/components/spindle/SpindleAppMount.tsx`: an `app-overlay` mount is a zero-height `position: relative` element at the end of the app root. That's why the stage host uses `position: fixed`.
- `src/spindle/runtime-transport.ts`: how extension backends are spawned.
- `src/routes/spindle.routes.ts`: extension install, enable and permission endpoints.
- Messages: Lumiverse documents a `CHARACTER_MESSAGE_RENDERED` event but never emits it. A reply's message is created once it has finished streaming (`MESSAGE_SENT`) and a regenerated reply arrives as `MESSAGE_SWIPED` with `action: 'added'`. In a group chat the message's `extra.character_id` names the member who wrote it (`extra.greeting_character_id` for greetings).
