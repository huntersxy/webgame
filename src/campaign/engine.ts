/* ────────────────────────────────────────────────────────────
 *  campaign/engine.ts — Gomoku campaign: style-based AI opponents
 * ──────────────────────────────────────────────────────────── */

import type { GomokuBoard, GomokuPlayer } from '../types';
import { BOARD_SIZE, WIN_LENGTH, DIRS, checkWin, windowScore, inBounds } from '../gomoku/rules';
import { Zobrist } from '../core/zobrist';
import { TranspositionTable } from '../core/transposition';
import { nowMs } from '../core/time';

export interface CampaignLevel {
  id: number;
  name: string;
  emoji: string;
  style: string;
  depth: number;
  width: number;
  title: string;
  color: string;
  desc: string;
  tags: string[];
  locked?: boolean;
}

export const LEVELS: CampaignLevel[] = [
  { id: 0, name: '严防死守', emoji: '🏰', style: 'fortress', depth: 4, width: 14,
    title: '堡垒拦截者', color: '#5aa9ff',
    desc: '它从不主动进攻，只筑墙。你的每一步进攻都会被提前算死——先破防，再取胜。',
    tags: ['玩家威胁重罚', '只认杀棋', '深度4', '纯防守'] },
  { id: 1, name: '？？？', emoji: '🔒', style: '', depth: 4, width: 14, title: '', color: '', desc: '', tags: [], locked: true },
  { id: 2, name: '？？？', emoji: '🔒', style: '', depth: 4, width: 14, title: '', color: '', desc: '', tags: [], locked: true },
  { id: 3, name: '？？？', emoji: '🔒', style: '', depth: 4, width: 14, title: '', color: '', desc: '', tags: [], locked: true },
  { id: 4, name: '？？？', emoji: '🔒', style: '', depth: 4, width: 14, title: '', color: '', desc: '', tags: [], locked: true },
];

const STORE_KEY = 'zq_campaign';

export function loadProgress(): number {
  try { return Math.max(0, Math.min(LEVELS.length - 1, +(localStorage.getItem(STORE_KEY) ?? '0') || 0)); }
  catch { return 0; }
}

export function saveProgress(n: number): void {
  try { localStorage.setItem(STORE_KEY, String(n)); } catch { /* noop */ }
}

export function firstPlayable(): number {
  const p = loadProgress();
  if (!LEVELS[p] || LEVELS[p].locked) {
    for (let i = 0; i < LEVELS.length; i++) { if (!LEVELS[i].locked) return i; }
  }
  return p;
}

/** Fortress evaluation: penalize player threats heavily, only reward own 4+ */
function fortressEval(board: GomokuBoard): number {
  const me: GomokuPlayer = 2; // AI = White
  let s = 0;

  const evalWindow = (vals: number[]): void => {
    let meN = 0, opN = 0;
    for (const v of vals) { if (v === me) meN++; else if (v !== 0) opN++; }
    if (meN > 0 && opN > 0) return;
    if (meN > 0) {
      if (meN === 5) s += 1_000_000;
      else if (meN === 4) s += 160_000;
      // Don't reward own 3 or below — pure defense
    } else if (opN > 0) {
      if (opN === 5) s -= 1_000_000;
      else if (opN === 4) s -= 260_000;
      else if (opN === 3) s -= (WIN_LENGTH - opN) === 2 ? 90_000 : 32_000;
      else if (opN === 2) s -= (WIN_LENGTH - opN) === 3 ? 5_000 : 900;
      else s -= 50;
    }
  };

  // Horizontal
  for (let y = 0; y < BOARD_SIZE; y++)
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++)
      evalWindow([board[y][x], board[y][x+1], board[y][x+2], board[y][x+3], board[y][x+4]]);
  // Vertical
  for (let x = 0; x < BOARD_SIZE; x++)
    for (let y = 0; y <= BOARD_SIZE - WIN_LENGTH; y++)
      evalWindow([board[y][x], board[y+1][x], board[y+2][x], board[y+3][x], board[y+4][x]]);
  // Diagonal ↘
  for (let y = 0; y <= BOARD_SIZE - WIN_LENGTH; y++)
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++)
      evalWindow([board[y][x], board[y+1][x+1], board[y+2][x+2], board[y+3][x+3], board[y+4][x+4]]);
  // Diagonal ↗
  for (let y = WIN_LENGTH - 1; y < BOARD_SIZE; y++)
    for (let x = 0; x <= BOARD_SIZE - WIN_LENGTH; x++)
      evalWindow([board[y][x], board[y-1][x+1], board[y-2][x+2], board[y-3][x+3], board[y-4][x+4]]);

  return s;
}

// Zobrist + TT for campaign search
const zobrist = new Zobrist(BOARD_SIZE, BOARD_SIZE, 2, 0x9e3779b9);
const tt = new TranspositionTable<{ x: number; y: number }>(60_000);
let campaignNodes = 0;

function boardHash(board: GomokuBoard): number {
  let h = 0;
  for (let y = 0; y < BOARD_SIZE; y++)
    for (let x = 0; x < BOARD_SIZE; x++) {
      const v = board[y][x];
      if (v) h ^= zobrist.key(x, y, v - 1);
    }
  return h >>> 0;
}

function campaignCandidates(board: GomokuBoard, range: number, limit: number, forColor: GomokuPlayer) {
  const has = board.some(r => r.some(v => v !== 0));
  if (!has) return [{ x: 7, y: 7, s: 0 }];

  const set = new Set<number>();
  for (let y = 0; y < BOARD_SIZE; y++)
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x]) continue;
      let near = false;
      for (let dy = -range; dy <= range && !near; dy++)
        for (let dx = -range; dx <= range && !near; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inBounds(nx, ny) && board[ny][nx]) near = true;
        }
      if (near) set.add(y * BOARD_SIZE + x);
    }

  const arr: { x: number; y: number; s: number }[] = [];
  for (const k of set) {
    const x = k % BOARD_SIZE, y = (k / BOARD_SIZE) | 0;
    let sc = 0;
    for (const [dx, dy] of DIRS) {
      for (let o = -4; o <= 0; o++) {
        let meN = 0, opN = 0, ok = true;
        for (let kk = 0; kk < WIN_LENGTH; kk++) {
          const nx = x + dx * (o + kk), ny = y + dy * (o + kk);
          if (!inBounds(nx, ny)) { ok = false; break; }
          if (nx === x && ny === y) continue;
          const v = board[ny][nx];
          if (v === forColor) meN++; else if (v !== 0) opN++;
        }
        if (!ok || (meN > 0 && opN > 0)) continue;
        if (meN) sc += windowScore(meN, WIN_LENGTH - meN - opN) * 1.1;
        else if (opN) sc += windowScore(opN, WIN_LENGTH - meN - opN) * 1.2;
      }
    }
    arr.push({ x, y, s: sc });
  }
  arr.sort((a, b) => b.s - a.s);
  return arr.slice(0, limit);
}

function minimax(board: GomokuBoard, depth: number, alpha: number, beta: number, aiTurn: boolean, hash: number, width: number): number {
  campaignNodes++;
  const key = (hash ^ (aiTurn ? 1 : 0)) >>> 0;
  const ttScore = tt.probe(key, depth, alpha, beta);
  if (ttScore !== null) return ttScore;
  const tte = tt.get(key);

  if (depth === 0) return fortressEval(board);

  const me: GomokuPlayer = aiTurn ? 2 : 1;
  let moves = campaignCandidates(board, 2, width, me);
  if (moves.length === 0) return fortressEval(board);

  if (tte?.move) {
    const i = moves.findIndex(m => m.x === tte.move!.x && m.y === tte.move!.y);
    if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
  }

  let best = aiTurn ? -Infinity : Infinity;
  let bestMove: { x: number; y: number } | null = null;

  if (aiTurn) {
    for (const m of moves) {
      board[m.y][m.x] = 2;
      const v = minimax(board, depth - 1, alpha, beta, false, hash ^ zobrist.key(m.x, m.y, 1), width);
      board[m.y][m.x] = 0;
      if (v > best) { best = v; bestMove = m; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
  } else {
    for (const m of moves) {
      board[m.y][m.x] = 1;
      const v = minimax(board, depth - 1, alpha, beta, true, hash ^ zobrist.key(m.x, m.y, 0), width);
      board[m.y][m.x] = 0;
      if (v < best) { best = v; bestMove = m; }
      if (v < beta) beta = v;
      if (alpha >= beta) break;
    }
  }

  tt.store(key, depth, best, aiTurn ? alpha : alpha, beta, bestMove);
  return best;
}

export interface CampaignSearchResult {
  move: { x: number; y: number } | null;
  nodes: number;
  ms: number;
  depth: number;
  eval: number;
  instant: boolean;
  scores: Array<{ x: number; y: number; v: number }>;
}

export function campaignSearch(board: GomokuBoard, level: CampaignLevel): CampaignSearchResult {
  campaignNodes = 0;
  tt.clear();
  const t0 = nowMs();

  // Immediate win/block
  const cands = campaignCandidates(board, 1, 20, 2);
  for (const m of cands) { board[m.y][m.x] = 2; const w = checkWin(board, m.x, m.y); board[m.y][m.x] = 0; if (w) return { move: m, nodes: 0, ms: 0, depth: level.depth, eval: 9999999, instant: true, scores: [] }; }
  for (const m of cands) { board[m.y][m.x] = 1; const w = checkWin(board, m.x, m.y); board[m.y][m.x] = 0; if (w) return { move: m, nodes: 0, ms: 0, depth: level.depth, eval: 9999999, instant: true, scores: [] }; }

  const hash = boardHash(board);
  const moves = campaignCandidates(board, 2, level.width, 2);
  let best = moves[0], bestV = -Infinity;
  const scored: Array<{ x: number; y: number; v: number }> = [];

  for (const m of moves) {
    board[m.y][m.x] = 2;
    let v: number;
    if (checkWin(board, m.x, m.y)) v = 10_000_000;
    else v = minimax(board, level.depth - 1, -Infinity, Infinity, false, hash ^ zobrist.key(m.x, m.y, 1), level.width);
    board[m.y][m.x] = 0;
    scored.push({ ...m, v });
    if (v > bestV) { bestV = v; best = m; }
  }

  const t1 = nowMs();
  return { move: best, nodes: campaignNodes, ms: Math.round(t1 - t0), depth: level.depth, eval: Math.round(bestV), instant: false, scores: scored.slice(0, 5) };
}
