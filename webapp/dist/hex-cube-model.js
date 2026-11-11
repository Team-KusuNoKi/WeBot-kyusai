export const HEX_CUBE_ID = 'hex-cube';
export const INITIAL_COLORS = [false, false, false, false, true, true];
export const SQUARES = [[0,5],[0,1],[1,2],[2,3],[3,4],[4,5]];
export const MAX_MOVES = 1024;
export const REQUIRED_MOVES = 2;
export function initialPuzzle() { return { colors: [...INITIAL_COLORS], mode: 2 }; }
export function squareFor(first, second) {
  if (first === second) return null;
  return SQUARES.find(pair => pair.includes(first) && pair.includes(second)) || null;
}
export function applyPuzzleMove(state, areas) {
  if (!Array.isArray(areas) || !areas.every(i => Number.isInteger(i) && i >= 0 && i < 6) || state.colors.every(Boolean)) throw new Error('不正な操作です。');
  const valid = state.mode === 2 ? areas.length === 1 : areas.length === 2 && squareFor(...areas);
  if (!valid) throw new Error('正方形の面になりません。');
  const changed = state.mode === 2 ? [(areas[0]+5)%6,(areas[0]+1)%6] : [0,1,2,3,4,5].filter(i => !areas.includes(i));
  return { colors: state.colors.map((color,i) => changed.includes(i) ? !color : color), mode: state.mode === 2 ? 3 : 2 };
}
export function verifyPuzzleSolution(moves) {
  if (!Array.isArray(moves) || moves.length !== REQUIRED_MOVES) return false;
  try {
    const state = moves.reduce((current, move) => applyPuzzleMove(current, move), initialPuzzle());
    return state.colors.every(Boolean);
  } catch { return false; }
}

export function readMinigameEntry(value) {
  if(typeof value!=='string'||!value)return null;
  try {
    const url=new URL(value),path=decodeURIComponent(url.pathname);
    return ['/11月の救祭/app/','/app/'].includes(path)&&url.searchParams.get('minigame')===HEX_CUBE_ID?HEX_CUBE_ID:null;
  } catch {return null;}
}
