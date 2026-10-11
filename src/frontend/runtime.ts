/**
 * Loads the Live2D rendering runtimes into the page exactly once.
 *
 * The vendor scripts (Cubism 2 core, Cubism 4 core, PIXI 6, pixi-live2d-display
 * and its HitAreaFrames extra) are classic scripts that install globals, so they
 * are embedded in this bundle as text and executed via blob-URL script tags.
 * These are the same builds the SillyTavern Live2d extension ships.
 */

import cubismCoreSrc from '../../vendor/live2dcubismcore.min.js' with { type: 'text' };
import cubism2Src from '../../vendor/live2d.min.js' with { type: 'text' };
import pixiSrc from '../../vendor/pixi.min.js' with { type: 'text' };
import displaySrc from '../../vendor/index.min.js' with { type: 'text' };
import extraSrc from '../../vendor/extra.min.js' with { type: 'text' };

declare global {
  interface Window {
    PIXI?: any;
    Live2DCubismCore?: any;
  }
}

let runtimePromise: Promise<any> | null = null;

/**
 * pixi-live2d-display's Cubism 4 renderer keeps its shader programs in one
 * global (the framework's CubismShader_WebGL singleton, `pe` in this build),
 * compiled for the WebGL context the latest model was set up in. The stage
 * gives each model its own PIXI application and so its own context, and with
 * the stock code only the last model set up draws. These edits keep the
 * programs per context and switch the singleton to the drawing renderer's
 * context before each model draws.
 */
const DISPLAY_PATCHES: Array<[find: string, replace: string]> = [
  // One set of programs per WebGL context, picked by setGl.
  [
    'setGl(t){this.gl=t}',
    'setGl(t){this.gl=t;const s=this._setsByGl||(this._setsByGl=new WeakMap);s.has(t)||s.set(t,[]);this._shaderSets=s.get(t)}',
  ],
  // A model set up in a context recompiles that context's programs, not everyone's.
  [
    'pe.getInstance()._shaderSets=[]',
    'pe.getInstance()._setsByGl.set(t,pe.getInstance()._shaderSets=[])',
  ],
  // Draw (and draw masks) with the programs of the renderer's own context.
  ['doDrawModel(){this.preDraw(),', 'doDrawModel(){pe.getInstance().setGl(this.gl),this.preDraw(),'],
];

function patchDisplay(source: string): string {
  for (const [find, replace] of DISPLAY_PATCHES) {
    const at = source.indexOf(find);
    if (at === -1 || source.indexOf(find, at + 1) !== -1) {
      throw new Error(`pixi-live2d-display patch doesn't fit this build: ${find}`);
    }
    source = source.slice(0, at) + replace + source.slice(at + find.length);
  }
  return source;
}

function injectScript(source: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const script = document.createElement('script');
    script.dataset.live2dAvatars = label;
    script.src = url;
    script.onload = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    script.onerror = () => {
      URL.revokeObjectURL(url);
      script.remove();
      reject(new Error(`Failed to load Live2D runtime script: ${label}`));
    };
    document.head.appendChild(script);
  });
}

/** Resolves to the `PIXI` global with `PIXI.live2d` attached. */
export function ensureLive2DRuntime(): Promise<any> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (window.PIXI?.live2d?.Live2DModel) return window.PIXI;
      await injectScript(cubismCoreSrc, 'cubism4-core');
      await injectScript(cubism2Src, 'cubism2-core');
      if (!window.PIXI) await injectScript(pixiSrc, 'pixi');
      await injectScript(patchDisplay(displaySrc), 'pixi-live2d-display');
      await injectScript(extraSrc, 'pixi-live2d-display-extra');
      if (!window.PIXI?.live2d?.Live2DModel) {
        throw new Error('Live2D runtime did not initialize (PIXI.live2d missing).');
      }
      return window.PIXI;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}
