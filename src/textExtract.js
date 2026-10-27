import { api } from './api.js';
import { loadPdfjs } from './thumbnails.js';

// Reads the words inside documents in the browser so the library search can find them.
const LIMIT = 60_000;
const MAX_PAGES = 60;
const OFFICE = /officedocument|ms-powerpoint|msword|ms-excel|opendocument/;
const OFFICE_EXT = /\.(docx|pptx|xlsx|odt|odp|ods)$/i;

async function fromPdf(blob) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const parts = [];
    let length = 0;
    for (let number = 1; number <= Math.min(doc.numPages, MAX_PAGES) && length < LIMIT; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => `${item.str}${item.hasEOL ? '\n' : ''}`).join(' ');
      parts.push(text);
      length += text.length;
    }
    return parts.join('\n');
  } finally {
    task.destroy?.();
  }
}

async function fromOffice(blob) {
  const { unzipSync } = await import('fflate');
  const wanted = name => name === 'word/document.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(name)
    || name === 'xl/sharedStrings.xml' || name === 'content.xml';
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: file => wanted(file.name) });
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map(name => {
    const xml = new TextDecoder().decode(files[name]);
    // Paragraph ends become line breaks; every other tag is dropped.
    return xml.replace(/<\/(w:p|a:p|text:p|si)>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }).join('\n');
}

/** Returns the text of a document (capped), '' when it has none, or null when the format is not readable. */
export async function extractText(file) {
  const mime = file.type || '';
  const name = file.name || '';
  if (file.size > 80 * 1024 * 1024) return null;
  try {
    let text;
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) text = await fromPdf(file);
    else if (OFFICE.test(mime) || OFFICE_EXT.test(name)) text = await fromOffice(file);
    else if (mime.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) text = await file.slice(0, LIMIT * 2).text();
    else return null;
    return text.replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, LIMIT);
  } catch (error) {
    console.warn('Text could not be read from', name, error);
    return null;
  }
}

/** Saves document text for search. Empty text is saved too, so scanned documents are not read again. */
export async function saveText(id, file) {
  const text = await extractText(file);
  if (text == null) return false;
  await api(`/content/${encodeURIComponent(id)}/text`, { method: 'PUT', body: { text } });
  return true;
}

const EDGE = 2 * 1024 * 1024;
/** Identifies a file by its size and a hash of its first and last 2 MB, without reading huge files whole. */
export async function fingerprint(file) {
  if (!crypto?.subtle || !file.size) return null;
  try {
    const head = await file.slice(0, EDGE).arrayBuffer();
    const tail = file.size > EDGE ? await file.slice(Math.max(EDGE, file.size - EDGE)).arrayBuffer() : new ArrayBuffer(0);
    const joined = new Uint8Array(head.byteLength + tail.byteLength);
    joined.set(new Uint8Array(head), 0);
    joined.set(new Uint8Array(tail), head.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
    return `${file.size}:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}
