/* ────────────────────────────────────────────────────────────
 *  ai/worker.ts — Web Worker: runs AI search off the main thread
 *  so the UI never freezes, even during demon-level deep searches.
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, GomokuBoard, XqBoard, GomokuPlayer, XqSide, JqBoard, JqSide, SearchResult, GomokuMove, XqMove, JqMove } from '../types';
import { findBestMove as gomokuSearch, findHintMove as gomokuHint } from '../gomoku/search';
import { findBestMove as xqSearch, findHintMove as xqHint } from '../xiangqi/search';
import { findBestMove as jqSearch, findHintMove as jqHint } from '../junqi/ai';
import { RapfiEngine } from '../gomoku/rapfi';

/** Rapfi WASM engine (gomocup-level). Falls back to the bundled JS
 *  engine in gomoku/search.ts whenever the wasm fails to load. */
const rapfi = new RapfiEngine();
// 引擎自己的下载进度（主线程预取命中缓存时一般不会触发）
rapfi.onLoadProgress = (loaded, total) => post({ type: 'load-progress', loaded, total });

/** 回带请求 id：主线程靠它把结果配回发起它的那次请求（见 ai-bridge.ts）。 */
function reply(req: WorkerRequest, result: SearchResult<GomokuMove | XqMove | JqMove>): void {
  post({ type: 'search-result', id: req.id, result });
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  switch (req.type) {
    case 'gomoku-search': {
      const board = req.board as GomokuBoard;
      const player = req.player as GomokuPlayer;
      const { difficulty, mode, historyLength, moves, forceJs } = req;
      // 玩家在 UI 里选了「内置 JS 引擎」：直接走 JS，连 Rapfi 的排队都不进
      if (forceJs) {
        reply(req, { ...gomokuSearch(board, player, difficulty, mode, historyLength), engine: 'js' } as any);
        break;
      }
      rapfi
        .findMove(board, player, difficulty, mode, historyLength, moves, () => ({
          ...gomokuSearch(board, player, difficulty, mode, historyLength),
          engine: 'js' as const,
        }))
        .then((result) => reply(req, result as any));
      break;
    }
    case 'gomoku-warmup': {
      // 只加载、不搜索：进入对局页面即调用，把 11MB 首次下载藏进玩家思考时间
      rapfi.warmUp().then(
        () => post({ type: 'warmup-done', ok: true, variant: rapfi.variant ?? undefined }),
        () => post({ type: 'warmup-done', ok: false }),
      );
      break;
    }
    case 'gomoku-hint': {
      const board = req.board as GomokuBoard;
      const player = req.player as GomokuPlayer;
      const { mode, historyLength, moves, forceJs } = req;
      if (forceJs) {
        reply(req, { ...gomokuHint(board, player, mode, historyLength), engine: 'js' } as any);
        break;
      }
      rapfi
        .findMove(board, player, 4, mode, historyLength, moves, () => ({
          ...gomokuHint(board, player, mode, historyLength),
          engine: 'js' as const,
        }))
        .then((result) => reply(req, result as any));
      break;
    }
    case 'xq-search': {
      const board = req.board as XqBoard;
      reply(req, xqSearch(board, req.side as XqSide, req.difficulty, req.mode, req.historyLength) as any);
      break;
    }
    case 'xq-hint': {
      const board = req.board as XqBoard;
      reply(req, xqHint(board, req.side as XqSide, req.mode, req.historyLength) as any);
      break;
    }
    case 'junqi-search': {
      const board = req.board as JqBoard;
      reply(req, jqSearch(board, req.side as JqSide, req.difficulty, req.mode, req.flip, req.historyLength) as any);
      break;
    }
    case 'junqi-hint': {
      const board = req.board as JqBoard;
      reply(req, jqHint(board, req.side as JqSide, req.mode, req.flip, req.historyLength) as any);
      break;
    }
    case 'cancel':
      // Workers can't truly interrupt synchronous JS, but we acknowledge.
      // The search will complete and the result will be ignored by the controller.
      break;
  }
};

function post(res: WorkerResponse): void {
  (self as unknown as Worker).postMessage(res);
}
