/* ────────────────────────────────────────────────────────────
 *  core/transposition.ts — Depth-aware transposition table
 *  Fixed-capacity array-backed probing table (no full clear on
 *  eviction), giving consistent high hit rates during search.
 * ──────────────────────────────────────────────────────────── */

export type TTFlag = 0 | 1 | 2; // EXACT | LOWER_BOUND | UPPER_BOUND

export interface TTEntry<M> {
  depth: number;
  score: number;
  flag: TTFlag;
  move: M | null;
}

/**
 * Fixed-capacity transposition table backed by a plain array with
 * per-slot replacement (age-agnostic, "replace always" policy).
 * Unlike a Map that clears itself wholesale when full, this keeps
 * older entries around and only overwrites individual slots, which
 * dramatically improves hit rates during a deep search.
 */
export class TranspositionTable<M> {
  private readonly keys: Uint32Array;
  private readonly depth: Int32Array;
  private readonly score: Int32Array;
  private readonly flag: Uint8Array;
  private readonly move: (M | null)[];
  private readonly cap: number;
  private readonly mask: number;

  constructor(maxEntries = 300_000) {
    // Round capacity up to a power of two so we can use masking.
    let cap = 1;
    while (cap < maxEntries) cap <<= 1;
    this.cap = cap;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap);
    this.depth = new Int32Array(cap);
    this.score = new Int32Array(cap);
    this.flag = new Uint8Array(cap);
    this.move = new Array<M | null>(cap).fill(null);
  }

  private index(hash: number): number {
    // Avalanche the hash to reduce collisions at low-order bits.
    let h = hash >>> 0;
    h ^= h >>> 16; h = (h * 0x45d9f3b) >>> 0; h ^= h >>> 16;
    return h & this.mask;
  }

  get(hash: number): TTEntry<M> | undefined {
    const i = this.index(hash);
    if (this.keys[i] === (hash >>> 0)) {
      return { depth: this.depth[i], score: this.score[i], flag: this.flag[i] as TTFlag, move: this.move[i] };
    }
    return undefined;
  }

  probe(hash: number, depth: number, alpha: number, beta: number): number | null {
    const i = this.index(hash);
    if (this.keys[i] !== (hash >>> 0)) return null;
    const eDepth = this.depth[i];
    if (eDepth < depth) return null;
    const eFlag = this.flag[i] as TTFlag;
    const eScore = this.score[i];
    if (eFlag === 0) return eScore;
    if (eFlag === 1 && eScore >= beta) return eScore;
    if (eFlag === 2 && eScore <= alpha) return eScore;
    return null;
  }

  store(hash: number, depth: number, score: number, alpha: number, beta: number, move: M | null): void {
    const i = this.index(hash);
    // Always-replace policy; clamp extremes so they don't dominate.
    let flag: TTFlag = 0;
    if (score <= alpha) flag = 2;
    else if (score >= beta) flag = 1;
    this.keys[i] = hash >>> 0;
    const bounded = Math.max(-3000000, Math.min(3000000, score));
    this.depth[i] = depth;
    this.score[i] = bounded;
    this.flag[i] = flag;
    this.move[i] = move;
  }

  clear(): void {
    this.keys.fill(0);
    this.depth.fill(0);
    this.score.fill(0);
    this.flag.fill(0);
    this.move.fill(null);
  }

  get size(): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.keys[i] !== 0) n++;
    return n;
  }
}