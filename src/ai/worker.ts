/* ────────────────────────────────────────────────────────────
 *  ai/worker.ts — Web Worker: runs AI search off the main thread
 *  so the UI never freezes, even during demon-level deep searches.
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, GomokuBoard, XqBoard, GomokuPlayer, XqSide, JqBoard, JqSide, SearchResult, GomokuMove, XqMove, JqMove } from '../types';
import { findBestMove as gomokuSearch, findHintMove as gomokuHint } from '../gomoku/search';
import { findBestMove as xqSearch, findHintMove as xqHint } from '../xiangqi/search';
import { findBestMove as jqSearch, findHintMove as jqHint } from '../junqi/ai';
import { RapfiEngine } from '../gomoku/rapfi';
import { PikafishEngine } from '../xiangqi/pikafish';

/** Rapfi WASM 引擎（gomocup 级，五子棋）。wasm 加载失败时回退
 *  gomoku/search.ts 里的内置 JS 引擎。 */
const rapfi = new RapfiEngine();
rapfi.onLoadProgress = (loaded, total) => post({ type: 'load-progress', loaded, total });

/** Pikafish WASM 引擎（UCI，象棋）。命令走共享内存，见 xiangqi/pikafish.ts。
 *  不可用（无 COOP/COEP、wasm 失败）时回退 xiangqi/search.ts 的内置 JS 引擎。 */
const pikafish = new PikafishEngine();
pikafish.onLoadProgress = (loaded, total) => post({ type: 'load-progress', loaded, total });

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
      // 只加载、不搜索：进入对局页面即调用，把首次下载藏进玩家思考时间
      rapfi.warmUp().then(
        () => post({ type: 'warmup-done', ok: true, variant: rapfi.variant ?? undefined, game: 'gomoku' }),
        () => post({ type: 'warmup-done', ok: false, game: 'gomoku' }),
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
      const side = req.side as XqSide;
      const { difficulty, mode, historyLength, forceJs } = req;
      // 玩家在 UI 里选了「内置 JS 引擎」：直接走 JS，不进 Pikafish 的排队
      if (forceJs) {
        reply(req, { ...xqSearch(board, side, difficulty, mode, historyLength), engine: 'js' } as any);
        break;
      }
      pikafish
        .findMove(board, side, difficulty, mode, historyLength, () => ({
          ...xqSearch(board, side, difficulty, mode, historyLength),
          engine: 'js' as const,
        }))
        .then((result) => reply(req, result as any));
      break;
    }
    case 'xq-warmup': {
      pikafish.warmUp().then(
        () => post({ type: 'warmup-done', ok: true, game: 'xq' }),
        () => post({ type: 'warmup-done', ok: false, game: 'xq' }),
      );
      break;
    }
    case 'xq-hint': {
      const board = req.board as XqBoard;
      const side = req.side as XqSide;
      const { mode, historyLength, forceJs } = req;
      if (forceJs) {
        reply(req, { ...xqHint(board, side, mode, historyLength), engine: 'js' } as any);
        break;
      }
      // 提示走恶魔档配置：一次满配搜索给出最佳着法
      pikafish
        .findMove(board, side, 4, mode, historyLength, () => ({
          ...xqHint(board, side, mode, historyLength),
          engine: 'js' as const,
        }))
        .then((result) => reply(req, result as any));
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
