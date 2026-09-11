/* ────────────────────────────────────────────────────────────
 *  ai/worker.ts — Web Worker: runs AI search off the main thread
 *  so the UI never freezes, even during demon-level deep searches.
 * ──────────────────────────────────────────────────────────── */

import type { WorkerRequest, WorkerResponse, GomokuBoard, XqBoard, GomokuPlayer, XqSide, JqBoard, JqSide, SearchResult, GomokuMove, XqMove, JqMove, GoMove, GoLevel } from '../types';
import { findBestMove as gomokuSearch, findHintMove as gomokuHint } from '../gomoku/search';
import { findBestMove as xqSearch, findHintMove as xqHint, HINT_BUDGET_MS } from '../xiangqi/search';
import { findBestMove as jqSearch, findHintMove as jqHint } from '../junqi/ai';
import { RapfiEngine } from '../gomoku/rapfi';
import { XqnnEngine } from '../xqnn/engine';
import { XqWLightEngine } from '../xiangqi/xqwlight';
import { GoEngine } from '../go/engine';
import { findBestMove as othSearch, findHintMove as othHint } from '../othello/search';
import { EgaroucidEngine } from '../othello/egaroucid';
import { EGAROUCID_HINT_LEVEL } from '../othello/egaroucid-assets';

/** Rapfi WASM 引擎（gomocup 级，五子棋）。wasm 加载失败时回退
 *  gomoku/search.ts 里的内置 JS 引擎。 */
const rapfi = new RapfiEngine();
rapfi.onLoadProgress = (loaded, total) => post({ type: 'load-progress', loaded, total });

/** 象棋神经网络引擎（TF.js 推理 + α-β 融合搜索，见 src/xqnn/）。
 *  未就绪/失败时回退 xiangqi/search.ts 的内置 JS 引擎。 */
const xqnn = new XqnnEngine();
/** 象棋神经网络搜索串行化：并发请求（AI 落子与「请神」）绝不交错 */
let xqnnChain: Promise<unknown> = Promise.resolve();

/** XQWLight（象棋小巫师）经典引擎：public/xqwlight/ 下的 GPL 代码由独立
 *  classic worker 加载，见 xiangqi/xqwlight.ts。不可用时回退内置 JS 引擎。 */
const xqwlight = new XqWLightEngine();

/** 黑白棋可选引擎：Egaroucid（GPL-3.0）跑在 public/egaroucid/engine-worker.js
 *  的独立 module worker 里，不会顶住本 worker 的其它搜索。 */
const egar = new EgaroucidEngine();

/** 围棋：KataGo 小网络的 TF.js 推理 + PUCT 搜索（见 src/go/）。
 *  权重没就绪时 engine 内部会自动落到常识棋兜底。 */
const go = new GoEngine();

/** 回带请求 id：主线程靠它把结果配回发起它的那次请求（见 ai-bridge.ts）。 */
function reply(req: WorkerRequest, result: SearchResult<GomokuMove | XqMove | JqMove | GoMove>): void {
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
      // dataBuffer：主线程已下完的权重；注入 getPreloadedPackage，避免二次下载
      rapfi.warmUp(req.dataBuffer).then(
        () => post({ type: 'warmup-done', ok: true, variant: rapfi.variant ?? undefined, game: 'gomoku' }),
        (err) => {
          const reason = String((err && (err as Error).message) || err);
          console.error('[rapfi] 预热失败：', err);
          post({ type: 'warmup-done', ok: false, game: 'gomoku', error: reason });
        },
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
      const { difficulty, mode, historyLength, engineKind } = req;
      const fallback = () => ({ ...xqSearch(board, side, difficulty, mode, historyLength), engine: 'js' as const });
      // 玩家选了「经典引擎」：走 XQWLight，失败时它自己回退
      if (engineKind === 'classic') {
        xqwlight.findMove(board, side, difficulty, mode, historyLength, fallback).then((result) => reply(req, result as any));
        break;
      }
      // 神经网络还没就绪：先让内置引擎立刻应手，网络在后台继续加载
      if (!xqnn.ready) {
        void xqnn.warmUp().catch(() => undefined);
        reply(req, fallback() as any);
        break;
      }
      const runXq = () => xqnn.findMove(board, side, difficulty, mode, historyLength);
      const task = xqnnChain.then(runXq, runXq);
      xqnnChain = task.catch(() => undefined);
      task.then(
        (result) => reply(req, result as any),
        (err) => {
          console.warn('[xqnn] 搜索失败，回退内置引擎：', err);
          reply(req, fallback() as any);
        },
      );
      break;
    }
    case 'xq-warmup': {
      xqnn.warmUp(req.dataBuffer).then(
        (r) =>
          post({
            type: 'warmup-done',
            ok: r.ok,
            game: 'xq',
            error: r.error,
            backend: r.backend,
            modelName: r.modelName,
          }),
        (err) => {
          // 预热失败的原因必须落到 console——否则静默回退，查无日志
          const reason = String((err && (err as Error).message) || err);
          console.error('[xqnn] 预热失败：', err);
          post({ type: 'warmup-done', ok: false, game: 'xq', error: reason });
        },
      );
      break;
    }
    case 'xq-hint': {
      const board = req.board as XqBoard;
      const side = req.side as XqSide;
      const { mode, historyLength, engineKind } = req;
      const fallback = () => ({ ...xqHint(board, side, mode, historyLength), engine: 'js' as const });
      if (engineKind === 'classic') {
        xqwlight.findMove(board, side, 4, mode, historyLength, fallback, HINT_BUDGET_MS).then((result) => reply(req, result as any));
        break;
      }
      if (!xqnn.ready) {
        void xqnn.warmUp().catch(() => undefined);
        reply(req, fallback() as any);
        break;
      }
      // 提示走恶魔档配置，但用短预算：请神要的是体验，不跟着恶魔一起等 10 秒
      const runHint = () => xqnn.findMove(board, side, 4, mode, historyLength, HINT_BUDGET_MS);
      const hintTask = xqnnChain.then(runHint, runHint);
      xqnnChain = hintTask.catch(() => undefined);
      hintTask.then(
        (result) => reply(req, result as any),
        (err) => {
          console.warn('[xqnn] 提示搜索失败，回退内置引擎：', err);
          reply(req, fallback() as any);
        },
      );
      break;
    }
    case 'oth-search': {
      const board = req.board;
      const side = req.side;
      const fallback = () => ({
        ...othSearch(board, side, req.difficulty, req.mode, req.historyLength),
        engine: 'js' as const,
      });
      if (req.engineKind === 'egar') {
        egar
          .findMove(board, side, req.difficulty, req.mode, fallback)
          .then((r) => reply(req, r as any));
        break;
      }
      reply(req, fallback() as any);
      break;
    }
    case 'oth-hint': {
      const board = req.board;
      const side = req.side;
      const fallback = () => ({
        ...othHint(board, side, req.mode, req.historyLength),
        engine: 'js' as const,
      });
      if (req.engineKind === 'egar') {
        // 提示走中上强度档位：满档 24 在单线程 wasm 里可能要十几秒
        egar
          .findMove(board, side, 3, req.mode, fallback, EGAROUCID_HINT_LEVEL)
          .then((r) => reply(req, r as any));
        break;
      }
      reply(req, fallback() as any);
      break;
    }
    case 'oth-warmup': {
      console.info(`[egaroucid] 预热开始（当前 ready=${egar.ready}）`);
      egar.warmUp().then(
        () => post({ type: 'warmup-done', ok: true, game: 'oth', modelName: `Egaroucid Web (wasm 内存 ${egar.memMB ?? '?'}MB)` }),
        (err) => {
          const reason = String((err && (err as Error).message) || err);
          console.error('[egaroucid] 预热失败：', err);
          post({ type: 'warmup-done', ok: false, game: 'oth', error: reason });
        },
      );
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
    case 'go-warmup': {
      go.warmUp(req.dataBuffer, (loaded, total) => post({ type: 'load-progress', loaded, total })).then(
        (r) =>
          post({
            type: 'warmup-done',
            ok: r.ok,
            game: 'go',
            error: r.error,
            backend: r.backend,
            modelName: r.modelName,
          }),
        (err) => {
          const reason = String((err && (err as Error).message) || err);
          console.error('[go] 预热失败：', err);
          post({ type: 'warmup-done', ok: false, game: 'go', error: reason });
        },
      );
      break;
    }
    case 'go-search': {
      const position = req.position;
      const area = position.size * position.size;
      go.findMove(
        {
          ...position,
          level: req.level as GoLevel,
          forceHeuristic: req.forceHeuristic,
          visitsOverride: req.visitsOverride,
          timeMsOverride: req.timeMsOverride,
        },
        {
          onProgress: (visits) => post({ type: 'search-progress', id: req.id, nodes: visits }),
        },
      )
        .then((r) => {
          reply(req, {
            move: { i: r.move },
            depth: 1,
            nodes: r.visits,
            ms: r.ms,
            eval: r.winProb,
            scores: r.candidates
              .slice(0, 12)
              .map((c) => ({ i: c.move >= area ? -1 : c.move, v: c.visits })),
            pv: r.pv.map((m) => ({ i: m })),
            visits: r.visits,
            winProb: r.winProb,
            scoreLead: r.scoreLead,
            goCandidates: r.candidates,
            ownership: r.ownership,
            engine: r.engine === 'nn' ? 'go-nn' : 'go-heuristic',
            backend: r.backend,
            modelName: r.modelName,
          });
        })
        .catch((err) => {
          console.error('[go] 搜索异常：', err);
          reply(req, { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] });
        });
      break;
    }
    case 'go-estimate': {
      go.estimate({ ...req.position, level: 2, moveHistory: req.position.moveHistory })
        .then((est) => {
          if (!est) {
            reply(req, { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] });
            return;
          }
          reply(req, {
            move: null,
            depth: 1,
            nodes: 0,
            ms: 0,
            eval: est.blackWinProb,
            scores: [],
            winProb: est.blackWinProb,
            scoreLead: est.blackScoreLead,
            ownership: est.ownership,
            engine: 'go-nn',
            backend: go.backend ?? undefined,
            modelName: go.modelName ?? undefined,
          });
        })
        .catch((err) => {
          console.error('[go] 形势判断失败：', err);
          reply(req, { move: null, depth: 0, nodes: 0, ms: 0, eval: 0, scores: [] });
        });
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
