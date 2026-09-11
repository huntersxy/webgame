/* ────────────────────────────────────────────────────────────
 *  engine-worker.js — classic（非 module）worker，托管 XQWLight 引擎
 *
 *  为什么是独立 worker 而不是直接用 src/xiangqi/search.ts：
 *  ① 许可隔离：public/xqwlight/ 下的 position.js / search.js / book.js 是
 *     上游（xqbase/xqwlight，GPL-2.0+）**原样**搬过来的独立程序，不被
 *     打进本项目的 bundle，避免 GPL 传染到 MIT 的主程序。
 *  ② 它是同步 JS：搜索时整条线程被占满，放在 AI Worker 里会顶住围棋/
 *     五子棋的搜索。
 *
 *  与象棋神经网络引擎的区别：这里**不需要**共享内存做阻塞式 stdin ——
 *  XQWLight 是纯函数式调用（fromFen → searchMain），一问一答即可，
 *  因此也完全不依赖 COOP/COEP。
 *
 *  协议
 *    入：{ type:'init' }                        → { type:'ready' }
 *        { type:'go', id, fen, millis, depth }  → { type:'bestmove', id, iccs, nodes, ms }
 *        { type:'quit' }
 *    出：{ type:'error', id?, data }
 *
 *  注意：每手都从 FEN 重建局面（本项目的唯一事实来源），所以引擎看不到
 *  整局历史 —— 它的重复局面/长将判定只在本手内部有效。
 * ──────────────────────────────────────────────────────────── */

/* global Position, Search, SRC, DST, FILE_X, RANK_Y, FILE_LEFT, RANK_TOP */
'use strict';

/** 置换表大小级别：2^16 项，与上游 board.js 的 setSearch(16) 一致 */
var HASH_LEVEL = 16;

var pos = null;
var search = null;

function post(msg) {
  self.postMessage(msg);
}

/** XQWLight 着法整数 → ICCS 记法（"H2-E2"，等价于上游 cchess.js 的 move2Iccs）。
 *  注意：**字母与档位都要过 String.fromCharCode** —— 少一层就是把数字直接拼成
 *  字符串（"B" + 50 = "B50"），着法会整体错位。 */
function move2Iccs(mv) {
  var sqSrc = SRC(mv);
  var sqDst = DST(mv);
  return String.fromCharCode(65 + FILE_X(sqSrc) - FILE_LEFT) +
    String.fromCharCode(57 - RANK_Y(sqSrc) + RANK_TOP) + '-' +
    String.fromCharCode(65 + FILE_X(sqDst) - FILE_LEFT) +
    String.fromCharCode(57 - RANK_Y(sqDst) + RANK_TOP);
}

function init() {
  if (pos) return;
  importScripts('position.js', 'search.js', 'book.js');
  if (typeof Position !== 'function' || typeof Search !== 'function') {
    post({ type: 'error', data: 'XQWLight 脚本未正确加载' });
    return;
  }
  pos = new Position();
  search = new Search(pos, HASH_LEVEL);
  post({ type: 'ready' });
}

function go(msg) {
  if (!pos || !search) {
    post({ type: 'error', id: msg.id, data: '引擎未初始化' });
    return;
  }
  var t0 = Date.now();
  try {
    pos.fromFen(String(msg.fen || ''));
    pos.distance = 0;
    var depth = Number(msg.depth) > 0 ? Number(msg.depth) : 64;
    var millis = Number(msg.millis) >= 0 ? Number(msg.millis) : 1000;
    var mv = search.searchMain(depth, millis);
    var ms = Date.now() - t0;
    if (!mv) {
      post({ type: 'bestmove', id: msg.id, iccs: null, nodes: Number(search.allNodes) || 0, ms: ms });
      return;
    }
    post({
      type: 'bestmove',
      id: msg.id,
      iccs: move2Iccs(mv),
      nodes: Number(search.allNodes) || 0,
      ms: ms,
      // 开局库命中时 searchMain 会直接返回，没有节点数
      book: !(Number(search.allNodes) > 0),
    });
  } catch (err) {
    post({ type: 'error', id: msg.id, data: String((err && err.message) || err) });
  }
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'init') init();
  else if (msg.type === 'go') go(msg);
  else if (msg.type === 'quit') self.close();
};
