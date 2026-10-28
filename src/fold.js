// Same rule as server/fold.js: matching ignores accents and case, so "yada" finds "yadā".
export const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Where `query` appears in `text` ignoring accents, as [start, end] in the original text, or null. */
export function findFolded(text, query) {
  const needle = fold(query);
  if (!needle) return null;
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
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length < map.length - 1 ? map[at + needle.length] : index;
  return [map[at], end];
}
