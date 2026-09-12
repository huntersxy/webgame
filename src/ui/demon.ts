/* ────────────────────────────────────────────────────────────
 *  ui/demon.ts — Demon AI profile (褚赢) + BGM management
 *  Shared by both Gomoku and Xiangqi panels.
 * ──────────────────────────────────────────────────────────── */

import demonAvatarUrl from '../assets/demon-avatar.png';
import type { AudioEngine } from './audio';
import { mustEl } from './dom';

export const DEMON_NAME = '褚赢';

/**
 * Populate any demon avatars with the project image.
 * Safe to call multiple times.
 */
export function setupDemonAssets(): void {
  for (const id of ['g-demon-avatar', 'x-demon-avatar', 'go-demon-avatar', 'o-demon-avatar']) {
    mustEl<HTMLImageElement>(id).src = demonAvatarUrl;
  }
}

/**
 * Refresh the demon profile panel + BGM for one game panel.
 * @param panelId  base id ('g' for gomoku, 'x' for xiangqi)
 * @param level    current difficulty (4 = demon)
 * @param audio    shared audio engine (drives BGM)
 */
export function applyDemonTheme(panelId: string, level: number, audio: AudioEngine): void {
  const demon = level === 4;
  mustEl(`${panelId}-demon-profile`).classList.toggle('hidden', !demon);
  mustEl(`${panelId}-demon-warn`).classList.toggle('hidden', !demon);
  if (demon) {
    audio.startBGM();
  } else {
    audio.stopBGM();
  }
}