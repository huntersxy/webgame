/* ────────────────────────────────────────────────────────────
 *  core/zobrist.ts — Generic Zobrist hashing for board games
 * ──────────────────────────────────────────────────────────── */

/**
 * Zobrist hashing: precompute random keys for every (position, piece)
 * combination, then XOR them together to get a incremental board hash.
 * Used by transposition tables to avoid re-searching identical positions.
 */
export class Zobrist {
  private readonly table: Uint32Array;
  private readonly sideKey: number;
  private readonly width: number;
  private readonly pieceCount: number;

  /**
   * @param width   Board width (positions per row)
   * @param height  Board height (rows)
   * @param pieceCount  Number of distinct piece types
   * @param seed    PRNG seed for deterministic keys
   */
  constructor(width: number, height: number, pieceCount: number, seed = 0x9e3779b9) {
    this.width = width;
    this.pieceCount = pieceCount;
    const total = width * height * pieceCount;
    this.table = new Uint32Array(total);

    const rnd = this.makeRng(seed);
    for (let i = 0; i < total; i++) {
      this.table[i] = rnd();
    }
    this.sideKey = rnd();
  }

  /** XOR the side-to-move key (use when turn matters) */
  get side(): number {
    return this.sideKey;
  }

  /** Hash key for a single (x, y, pieceIndex) */
  key(x: number, y: number, pieceIndex: number): number {
    return this.table[(y * this.width + x) * this.pieceCount + pieceIndex];
  }

  private makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
  }
}
