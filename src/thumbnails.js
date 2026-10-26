import { fileUrl, saveThumbnail } from './api.js';

// Builds a small JPEG preview for any file in the browser: a frame for videos, the first page for PDFs,
// embedded cover art for audio, the stored or rendered first page for Office files, and the text for text files.
const WIDTH = 480;
const HEIGHT = 300;
const PAPER_HEIGHT = 620;

function canvas(width, height) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function toJpeg(source, { fit = 'cover', background = '#ffffff' } = {}) {
  const sw = source.width || source.videoWidth;
  const sh = source.height || source.videoHeight;
  if (!sw || !sh) throw new Error('Empty image');
  // Portrait sources such as pages keep their shape; landscape media is cropped to the card ratio.
  const portrait = sh > sw;
  const out = portrait ? canvas(WIDTH, Math.round(Math.min(sh / sw, 1.5) * WIDTH)) : canvas(WIDTH, HEIGHT);
  const ctx = out.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  const scale = (fit === 'cover' ? Math.max : Math.min)(out.width / sw, out.height / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (out.width - w) / 2, portrait ? 0 : (out.height - h) / 2, w, h);
  return new Promise((resolve, reject) => out.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), 'image/jpeg', 0.78));
}

async function fromImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try { return await toJpeg(bitmap); } finally { bitmap.close?.(); }
}

function fromVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    const done = (error, result) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => done(new Error('Video frame timed out')), 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      // Skip black intro frames, but stay inside short clips.
      video.currentTime = Math.min(Math.max(1, video.duration * 0.1), Math.max(0, video.duration - 0.1)) || 0;
    };
    video.onseeked = () => toJpeg(video, { background: '#0f172a' }).then(result => done(null, result), done);
    video.onerror = () => done(new Error('Video cannot be decoded'));
    video.src = url;
  });
}

let pdfjs;
async function fromPdf(blob) {
  if (!pdfjs) {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    pdfjs = lib;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (WIDTH * 1.5) / base.width });
    const target = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = target.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    await page.render({ canvas: target, canvasContext: context, viewport }).promise;
    return await toJpeg(target);
  } finally {
    task.destroy?.();
  }
}

// ID3v2 "APIC" frames hold album art in MP3 files.
async function fromAudio(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 3)) !== 'ID3') return null;
  const version = head[3];
  const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
  const tag = new Uint8Array(await blob.slice(10, 10 + size).arrayBuffer());
  let offset = 0;
  while (offset + 10 < tag.length) {
    const id = String.fromCharCode(...tag.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const raw = tag.subarray(offset + 4, offset + 8);
    const length = version === 4 ? (raw[0] << 21) | (raw[1] << 14) | (raw[2] << 7) | raw[3] : ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
    if (id === 'APIC') {
      const frame = tag.subarray(offset + 10, offset + 10 + length);
      const encoding = frame[0];
      let cursor = frame.indexOf(0, 1) + 1; // after MIME type
      cursor += 1; // picture type
      if (encoding === 1 || encoding === 2) {
        while (cursor + 1 < frame.length && (frame[cursor] || frame[cursor + 1])) cursor += 2;
        cursor += 2;
      } else {
        cursor = frame.indexOf(0, cursor) + 1;
      }
      return fromImage(new Blob([frame.subarray(cursor)]));
    }
    offset += 10 + length;
  }
  return null;
}

function paper(lines, { title, accent = '#6d28d9' } = {}) {
  const out = canvas(WIDTH, PAPER_HEIGHT);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, out.width, 8);
  let y = 48;
  const margin = 36;
  const wrap = (text, font, lineHeight, color, maxLines) => {
    ctx.font = font;
    ctx.fillStyle = color;
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    let line = '';
    let count = 0;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > out.width - margin * 2 && line) {
        ctx.fillText(line, margin, y);
        y += lineHeight;
        line = word;
        if (++count >= maxLines || y > out.height - 24) return;
      } else line = next;
    }
    if (line) { ctx.fillText(line, margin, y); y += lineHeight; }
  };
  if (title) { wrap(title, 'bold 26px system-ui, sans-serif', 32, '#0f172a', 3); y += 10; }
  for (const text of lines) {
    if (y > out.height - 24) break;
    if (text.trim()) wrap(text, '17px system-ui, sans-serif', 24, '#334155', 30);
    y += 8;
  }
  return toJpeg(out);
}

async function fromText(blob) {
  const text = await blob.slice(0, 4000).text();
  return paper(text.split(/\r?\n/).slice(0, 40), { accent: '#0ea5e9' });
}

const xmlText = (xml, tag) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagNameNS('*', tag)];
};

async function fromOffice(blob) {
  const { unzipSync } = await import('fflate');
  const wanted = name => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(name) || ['word/document.xml', 'ppt/slides/slide1.xml', 'xl/sharedStrings.xml'].includes(name);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: file => wanted(file.name) });
  const thumbName = Object.keys(files).find(name => name.startsWith('docProps/'));
  if (thumbName) {
    try { return await fromImage(new Blob([files[thumbName]])); } catch { /* fall through to rendering */ }
  }
  const decode = name => (files[name] ? new TextDecoder().decode(files[name]) : null);
  const word = decode('word/document.xml');
  if (word) {
    const paragraphs = xmlText(word, 'p').map(p => xmlText(new XMLSerializer().serializeToString(p), 't').map(t => t.textContent).join(''));
    return paper(paragraphs.slice(0, 40), { accent: '#2563eb' });
  }
  const slide = decode('ppt/slides/slide1.xml');
  if (slide) {
    const texts = xmlText(slide, 'p').map(p => xmlText(new XMLSerializer().serializeToString(p), 't').map(t => t.textContent).join('')).filter(Boolean);
    return paper(texts.slice(1, 20), { title: texts[0] || 'Presentation', accent: '#ea580c' });
  }
  const sheet = decode('xl/sharedStrings.xml');
  if (sheet) return paper([xmlText(sheet, 't').slice(0, 60).map(t => t.textContent).join(' Â· ')], { title: 'Spreadsheet', accent: '#16a34a' });
  return null;
}

const OFFICE = /officedocument|ms-powerpoint|msword|ms-excel|opendocument/;
const OFFICE_EXT = /\.(docx|pptx|xlsx|odt|odp|ods)$/i;

/** Returns a JPEG Blob preview for the file, or null when no preview can be made. Never throws. */
export async function makeThumbnail(file) {
  const mime = file.type || '';
  const name = file.name || '';
  const whole = file.size <= 200 * 1024 * 1024;
  try {
    if (mime.startsWith('image/')) return await fromImage(file);
    if (mime.startsWith('video/')) return await fromVideo(file);
    if (mime.startsWith('audio/')) return await fromAudio(file);
    if (!whole) return null;
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return await fromPdf(file);
    if (OFFICE.test(mime) || OFFICE_EXT.test(name)) return await fromOffice(file);
    if (mime.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(name)) return await fromText(file);
  } catch (error) {
    console.warn('Thumbnail could not be created for', name, error);
  }
  return null;
}

const BACKFILL_LIMIT = 50 * 1024 * 1024;
const tried = new Set();
const queue = new Map();
let backfilling = false;

async function drainQueue() {
  if (backfilling) return;
  backfilling = true;
  try {
    while (queue.size) {
      const [id, { item, onSaved }] = queue.entries().next().value;
      queue.delete(id);
      tried.add(id);
      try {
        const response = await fetch(fileUrl(id, true), { credentials: 'same-origin' });
        if (!response.ok) continue;
        const file = new File([await response.blob()], item.original_name || item.title, { type: item.mime || '' });
        const thumb = await makeThumbnail(file);
        if (thumb) { await saveThumbnail(id, thumb); onSaved?.(id); }
      } catch { /* try the next one */ }
    }
  } finally {
    backfilling = false;
  }
}

/**
 * Creates missing thumbnails for existing items, one at a time, while the list is open.
 * Only runs for items the server lets this user update. Returns a cancel function.
 */
export function backfillThumbnails(items, onSaved) {
  const added = [];
  for (const item of items) {
    if (item.has_thumb || item.type === 'link' || !item.size || item.size > BACKFILL_LIMIT) continue;
    if (tried.has(item.id) || queue.has(item.id)) continue;
    queue.set(item.id, { item, onSaved });
    added.push(item.id);
  }
  drainQueue();
  return () => {
    for (const id of added) {
      const entry = queue.get(id);
      if (entry && entry.onSaved === onSaved) queue.delete(id);
    }
  };
}
