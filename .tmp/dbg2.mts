import { findBestMove } from '../src/gomoku/search';
const N=15;
const empty = () => Array.from({length:N},()=>new Array(N).fill(0));
const b = empty();
for (const [x,y,c] of [[7,7,1],[7,8,1],[7,9,1],[2,2,2],[2,3,2]] as const) b[y][x]=c;
for (let i=0;i<3;i++){
  const r = findBestMove(b.map(r=>[...r]), 2, 2, 'ai', 5);
  const m = r.move!;
  console.log(i, JSON.stringify(r), 'occupied?', b[m.y][m.x] !== 0);
}
