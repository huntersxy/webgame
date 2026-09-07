/* ────────────────────────────────────────────────────────────
 *  ui/stats.ts — Global game statistics (localStorage)
 * ──────────────────────────────────────────────────────────── */

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
    const g = document.getElementById('stat-games');
    const w = document.getElementById('stat-wins');
    if (g) g.textContent = String(this.games);
    if (w) w.textContent = String(this.wins);
  },
};
