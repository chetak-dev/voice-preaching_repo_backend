// Search ignores accents and case, so "yada yada hi dharmasya" finds "yadā yadā hi dharmasya" (and the other way round).
export const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Folds `text` and remembers where each folded character came from, so matches can be mapped back to the original. */
export function foldWithMap(text) {
  let folded = '';
  const map = [];
  let index = 0;
  for (const char of String(text ?? '')) {
    const part = fold(char);
    folded += part;
    for (let i = 0; i < part.length; i++) map.push(index);
    index += char.length;
  }
  map.push(index);
  return { folded, map };
}
