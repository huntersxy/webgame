/* ────────────────────────────────────────────────────────────
 *  ai/ai-bridge.ts — Main-thread ↔ Worker bridge with promise API
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, Difficulty, GameMode, SearchResult, GomokuBoard, GomokuPlayer, XqBoard, XqSide, GomokuMove, XqMove, JqMove, JqBoard, JqSide } from '../types';

export class AIBridge {
  private worker: Worker | null = null;
  private pendingResolve: ((r: SearchResult<GomokuMove | XqMove | JqMove>) => void) | null = null;
  private currentSeq = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'search-result' && this.pendingResolve) {
          this.pendingResolve(msg.result);
          this.pendingResolve = null;
        }
      };
      this.worker.onerror = (e) => {
        console.error('AI Worker error:', e);
        if (this.pendingResolve) {
          // Fallback: return null move
          this.pendingResolve({ move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] });
          this.pendingResolve = null;
        }
      };
    } catch (err) {
      console.error('Failed to create AI worker:', err);
    }
  }

  private send(req: WorkerRequest): Promise<SearchResult<GomokuMove | XqMove | JqMove>> {
    return new Promise((resolve) => {
      this.currentSeq++;
      this.pendingResolve = resolve;
      if (this.worker) {
        this.worker.postMessage(req);
      } else {
        // No worker — resolve immediately with null
        resolve({ move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] });
      }
    });
  }

  searchGomoku(
    board: GomokuBoard,
    player: GomokuPlayer,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
  ): Promise<SearchResult<GomokuMove>> {
    return this.send({
      type: 'gomoku-search',
      board,
      player,
      difficulty,
      mode,
      historyLength,
    }) as Promise<SearchResult<GomokuMove>>;
  }

  hintGomoku(
    board: GomokuBoard,
    player: GomokuPlayer,
    mode: GameMode,
    historyLength: number,
  ): Promise<SearchResult<GomokuMove>> {
    return this.send({
      type: 'gomoku-hint',
      board,
      player,
      mode,
      historyLength,
    }) as Promise<SearchResult<GomokuMove>>;
  }

  searchXq(
    board: XqBoard,
    side: XqSide,
    difficulty: Difficulty,
    mode: GameMode,
    historyLength: number,
  ): Promise<SearchResult<XqMove>> {
    return this.send({
      type: 'xq-search',
      board,
      side,
      difficulty,
      mode,
      historyLength,
    }) as Promise<SearchResult<XqMove>>;
  }

  hintXq(
    board: XqBoard,
    side: XqSide,
    mode: GameMode,
    historyLength: number,
  ): Promise<SearchResult<XqMove>> {
    return this.send({
      type: 'xq-hint',
      board,
      side,
      mode,
      historyLength,
    }) as Promise<SearchResult<XqMove>>;
  }

  searchJq(
    board: JqBoard,
    side: JqSide,
    difficulty: Difficulty,
    mode: GameMode,
    flip: boolean,
    historyLength: number,
  ): Promise<SearchResult<JqMove>> {
    return this.send({
      type: 'junqi-search',
      board,
      side,
      difficulty,
      mode,
      flip,
      historyLength,
    }) as Promise<SearchResult<JqMove>>;
  }

  hintJq(
    board: JqBoard,
    side: JqSide,
    mode: GameMode,
    flip: boolean,
    historyLength: number,
  ): Promise<SearchResult<JqMove>> {
    return this.send({
      type: 'junqi-hint',
      board,
      side,
      mode,
      flip,
      historyLength,
    }) as Promise<SearchResult<JqMove>>;
  }

  cancel(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' } as WorkerRequest);
    }
    this.pendingResolve = null;
  }

  get isBusy(): boolean {
    return this.pendingResolve !== null;
  }
}
