/* ────────────────────────────────────────────────────────────
 *  ui/stats.ts — Global game statistics (localStorage)
 * ──────────────────────────────────────────────────────────── */

import { mustEl } from './dom';

const KEY_GAMES = 'zq_games';
const KEY_WINS = 'zq_wins';

export const Stats = {
  get games(): number { return +(localStorage.getItem(KEY_GAMES) ?? '0') || 0; },
  get wins(): number { return +(localStorage.getItem(KEY_WINS) ?? '0') || 0; },

  add(win: boolean): void {
    localStorage.setItem(KEY_GAMES, String(this.games + 1));
    if (win) localStorage.setItem(KEY_WINS, String(this.wins + 1));
    this.refresh();
  },

  refresh(): void {
    mustEl('stat-games').textContent = String(this.games);
    mustEl('stat-wins').textContent = String(this.wins);
  },
};
