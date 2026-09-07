/* ────────────────────────────────────────────────────────────
 *  ai/worker.ts — Web Worker: runs AI search off the main thread
 *  so the UI never freezes, even during demon-level deep searches.
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, GomokuBoard, XqBoard, GomokuPlayer, XqSide } from '../types';
import { findBestMove as gomokuSearch, findHintMove as gomokuHint } from '../gomoku/search';
import { findBestMove as xqSearch, findHintMove as xqHint } from '../xiangqi/search';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  switch (req.type) {
    case 'gomoku-search': {
      const board = req.board as GomokuBoard;
      const result = gomokuSearch(board, req.player as GomokuPlayer, req.difficulty, req.mode, req.historyLength);
      const res: WorkerResponse = { type: 'search-result', result: result as any };
      (self as unknown as Worker).postMessage(res);
      break;
    }
    case 'gomoku-hint': {
      const board = req.board as GomokuBoard;
      const result = gomokuHint(board, req.player as GomokuPlayer, req.mode, req.historyLength);
      const res: WorkerResponse = { type: 'search-result', result: result as any };
      (self as unknown as Worker).postMessage(res);
      break;
    }
    case 'xq-search': {
      const board = req.board as XqBoard;
      const result = xqSearch(board, req.side as XqSide, req.difficulty, req.mode, req.historyLength);
      const res: WorkerResponse = { type: 'search-result', result: result as any };
      (self as unknown as Worker).postMessage(res);
      break;
    }
    case 'xq-hint': {
      const board = req.board as XqBoard;
      const result = xqHint(board, req.side as XqSide, req.mode, req.historyLength);
      const res: WorkerResponse = { type: 'search-result', result: result as any };
      (self as unknown as Worker).postMessage(res);
      break;
    }
    case 'cancel':
      // Workers can't truly interrupt synchronous JS, but we acknowledge.
      // The search will complete and the result will be ignored by the controller.
      break;
  }
};
