import { GomokuEngine, xOf, yOf } from '../src/gomoku/engine';
const eng = new GomokuEngine() as any;
const N=15;
const board = Array.from({length:N},()=>new Array(N).fill(0));
for (const [x,y,c] of [[7,7,1],[7,8,1],[7,9,1],[2,2,2],[2,3,2]] as const) board[y][x]=c;
eng.load2D(board);
// scan the candidate stack for duplicates
const seen = new Set<number>(); const dups: number[] = [];
for (let i=0;i<eng.cCount;i++){ const p=eng.cStack[i]; if (seen.has(p)) dups.push(p); seen.add(p); }
console.log('cCount', eng.cCount, 'dups', dups.map(p=>[xOf(p),yOf(p)]));
console.log('empty cStack slots occupied?', dups.length);
// also check win-cell stacks
for (const ci of [0,1]) {
  const s=new Set(); const d2:number[]=[];
  for (let i=0;i<eng.wCount[ci];i++){ const p=eng.wStack[ci][i]; if (s.has(p)) d2.push(p); s.add(p); }
  console.log('win dup color', ci, d2);
}
