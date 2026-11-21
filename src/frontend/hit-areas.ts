/**
 * Hit areas: the ones a model file defines (model3.json `HitAreas`, model.json
 * `hit_areas`), and guesses at which of a model's motions are meant for a tap.
 * The stage does the hit testing; see Stage.hitAreasAt.
 */

import type { ClickAnimation, ModelSettings } from '../shared/settings';

/** A hit area from the model file: its name in settings, and the drawable (art mesh) whose bounds it covers. */
export interface HitAreaDef {
  name: string;
  drawableId: string;
}

/**
 * The model file's hit areas. An area is named by its `Name`, or by its `Id`
 * when the name is empty, as it often is (Cubism Viewer leaves it blank).
 */
export function hitAreaDefsFromBundle(bundleJson: any, cubism: 2 | 4): HitAreaDef[] {
  const raw: unknown[] = cubism === 4 ? bundleJson?.HitAreas : bundleJson?.hit_areas;
  if (!Array.isArray(raw)) return [];
  const defs: HitAreaDef[] = [];
  for (const area of raw) {
    if (!area || typeof area !== 'object') continue;
    const value = area as Record<string, unknown>;
    const field = (key: string) => {
      const found = Object.keys(value).find((candidate) => candidate.toLowerCase() === key);
      const entry = found === undefined ? undefined : value[found];
      return typeof entry === 'string' ? entry.trim() : '';
    };
    const drawableId = field('id');
    const name = field('name') || drawableId;
    if (drawableId && name) defs.push({ name, drawableId });
  }
  return defs;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The motion value for a whole group ('<group>_id=random'), or 'none'. */
function groupMotion(motions: Record<string, string[]>, wanted: string[]): string {
  const groups = Object.keys(motions).filter((group) => (motions[group]?.length ?? 0) > 0);
  for (const name of wanted) {
    const group = groups.find((candidate) => squash(candidate) === name);
    if (group) return `${group}_id=random`;
  }
  return 'none';
}

/**
 * The motion group a model seems to have for tapping this area: "Tap@Head",
 * "TapHead", "tap_head", "touch_head", "Head_Tap"… for an area named "Head"
 * (or "HitAreaHead"). 'none' when there's no such group.
 */
export function suggestAreaMotion(area: string, motions: Record<string, string[]>): string {
  const name = squash(area).replace(/^hitarea/, '').replace(/hitarea$/, '');
  if (!name) return 'none';
  return groupMotion(motions, [`tap${name}`, `touch${name}`, `${name}tap`, `${name}touch`, `click${name}`]);
}

/** The motion group a model seems to have for a tap anywhere on it ("Tap", "tap", "touch", "TapBody"…). */
export function suggestClickMotion(motions: Record<string, string[]>): string {
  return groupMotion(motions, ['tap', 'touch', 'click', 'tapbody', 'touchbody']);
}

const unset = (mapping: ClickAnimation | undefined) =>
  !mapping || (mapping.motion === 'none' && mapping.expression === 'none' && mapping.message === '');

/**
 * Give the hit areas and the "On click" animation the model's own tap motions
 * where they have nothing set yet. Returns how many it set.
 */
export function applyTapMotions(
  settings: ModelSettings,
  areaNames: Iterable<string>,
  motions: Record<string, string[]>,
): number {
  let changed = 0;
  for (const area of areaNames) {
    const mapping = settings.hit_areas[area];
    if (!unset(mapping)) continue;
    const motion = suggestAreaMotion(area, motions);
    if (motion === 'none') continue;
    settings.hit_areas[area] = { expression: 'none', motion, message: mapping?.message ?? '' };
    changed++;
  }
  if (unset(settings.animation_click)) {
    const motion = suggestClickMotion(motions);
    if (motion !== 'none') {
      settings.animation_click.motion = motion;
      changed++;
    }
  }
  return changed;
}
