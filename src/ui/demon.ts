/* ────────────────────────────────────────────────────────────
 *  ui/demon.ts — Demon AI profile (褚赢) + BGM management
 *  Shared by both Gomoku and Xiangqi panels.
 * ──────────────────────────────────────────────────────────── */

import demonAvatarUrl from '../assets/demon-avatar.png';
import type { AudioEngine } from './audio';

export const DEMON_NAME = '褚赢';

/**
 * Populate any demon avatars with the project image.
 * Safe to call multiple times; only sets src when element exists.
 */
export function setupDemonAssets(): void {
  for (const id of ['g-demon-avatar', 'x-demon-avatar']) {
    const img = document.getElementById(id) as HTMLImageElement | null;
    if (img) img.src = demonAvatarUrl;
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
  document.getElementById(`${panelId}-demon-profile`)?.classList.toggle('hidden', !demon);
  document.getElementById(`${panelId}-demon-warn`)?.classList.toggle('hidden', !demon);
  if (demon) {
    audio.startBGM();
  } else {
    audio.stopBGM();
  }
}