// Reads the text content of Word, PowerPoint and Excel files (OOXML) so they can be read in the browser before download.
const MAX_ROWS = 300;
const MAX_COLS = 30;

const parse = xml => new DOMParser().parseFromString(xml, 'application/xml');
const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const textOf = node => byTag(node, 't').map(t => t.textContent).join('');
const numbered = (files, pattern) => Object.keys(files)
  .map(name => [name, Number(name.match(pattern)?.[1])])
  .filter(([, n]) => n)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name);

function word(xml) {
  const body = parse(xml);
  return byTag(body, 'p').map(p => {
    const style = byTag(p, 'pStyle')[0]?.getAttribute('w:val') || '';
    return { text: textOf(p), heading: /^(Heading|Title)/i.test(style) };
  });
}

function slides(files, decode) {
  return numbered(files, /^ppt\/slides\/slide(\d+)\.xml$/).map(name => {
    const lines = byTag(parse(decode(name)), 'p').map(textOf).filter(line => line.trim());
    return { title: lines[0] || '', lines: lines.slice(1) };
  });
}

const columnIndex = ref => [...(ref.match(/^[A-Z]+/)?.[0] || 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

function sheets(files, decode) {
  const shared = files['xl/sharedStrings.xml'] ? byTag(parse(decode('xl/sharedStrings.xml')), 'si').map(textOf) : [];
  const names = files['xl/workbook.xml'] ? byTag(parse(decode('xl/workbook.xml')), 'sheet').map(s => s.getAttribute('name')) : [];
  return numbered(files, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((name, index) => {
    const rows = [];
    let truncated = false;
    for (const row of byTag(parse(decode(name)), 'row')) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const cells = [];
      for (const cell of byTag(row, 'c')) {
        const col = columnIndex(cell.getAttribute('r') || '');
        if (col >= MAX_COLS) { truncated = true; continue; }
        const type = cell.getAttribute('t');
        const value = byTag(cell, 'v')[0]?.textContent ?? '';
        cells[col] = type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? textOf(cell) : value;
      }
      if (cells.some(value => value !== undefined && value !== '')) rows.push(Array.from(cells, value => value ?? ''));
    }
    return { name: names[index] || `Sheet ${index + 1}`, rows, truncated };
  });
}

/** Returns { kind: 'doc' | 'slides' | 'sheets', ... } or null when the file is not a readable Office document. */
export async function readOffice(blob) {
  const { unzipSync } = await import('fflate');
  const wanted = name => name === 'word/document.xml' || name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml'
    || /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: file => wanted(file.name) });
  const decoder = new TextDecoder();
  const decode = name => decoder.decode(files[name]);
  if (files['word/document.xml']) return { kind: 'doc', paragraphs: word(decode('word/document.xml')) };
  const deck = slides(files, decode);
  if (deck.length) return { kind: 'slides', slides: deck };
  const book = sheets(files, decode);
  if (book.length) return { kind: 'sheets', sheets: book };
  return null;
}
