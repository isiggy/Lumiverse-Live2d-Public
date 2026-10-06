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
      await injectScript(displaySrc, 'pixi-live2d-display');
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
