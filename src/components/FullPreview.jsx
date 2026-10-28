import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { fileUrl, thumbnailUrl } from '../api.js';
import { loadPdfjs } from '../thumbnails.js';
import { Button, TYPE_META, cx } from './ui.jsx';

const OFFICE = /officedocument\.(wordprocessingml|presentationml|spreadsheetml)/;
const OFFICE_EXT = /\.(docx|pptx|xlsx)$/i;
const TEXT_EXT = /\.(txt|md|csv|json|log)$/i;
const READ_LIMIT = 50 * 1024 * 1024;
const PAGE_BATCH = 10;

export const isPdf = item => item.mime === 'application/pdf' || /\.pdf$/i.test(item.original_name || '');
export const isOffice = item => OFFICE.test(item.mime || '') || OFFICE_EXT.test(item.original_name || '');
export const isText = item => (item.mime || '').startsWith('text/') || TEXT_EXT.test(item.original_name || '');

const frame = 'max-h-[65vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50';

function Loading({ label = 'Loading preview…' }) {
  return (
    <div className="flex h-48 items-center justify-center gap-2 rounded-lg bg-slate-50 text-sm text-slate-500" role="status">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

function Unavailable({ item, message }) {
  const meta = TYPE_META[item.type] || TYPE_META.doc;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-slate-50 p-6 text-center">
      {item.has_thumb
        ? <img src={thumbnailUrl(item.id)} alt="" className="max-h-[45vh] rounded-lg object-contain shadow ring-1 ring-slate-200" />
        : <meta.icon className="h-10 w-10 text-slate-400" strokeWidth={1.5} />}
      <p className="break-all text-sm font-medium text-slate-700">{item.original_name || item.title}</p>
      <p className="flex items-center gap-1.5 text-xs text-slate-500"><AlertCircle className="h-3.5 w-3.5" />{message}</p>
    </div>
  );
}

function useFile(item, enabled) {
  const [state, setState] = useState({ blob: null, error: '' });
  useEffect(() => {
    if (!enabled) return undefined;
    if (item.size > READ_LIMIT) { setState({ blob: null, error: 'This file is too large to preview. Download it to read it.' }); return undefined; }
    const controller = new AbortController();
    setState({ blob: null, error: '' });
    fetch(fileUrl(item.id, true), { credentials: 'same-origin', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.blob(); })
      .then(blob => setState({ blob, error: '' }))
      .catch(error => { if (error.name !== 'AbortError') setState({ blob: null, error: 'The preview could not be loaded.' }); });
    return () => controller.abort();
  }, [item.id, item.size, enabled]);
  return state;
}

function PdfPage({ doc, number, width }) {
  const ref = useRef(null);
  useEffect(() => {
    let task;
    let live = true;
    doc.getPage(number).then(page => {
      if (!live || !ref.current) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      const canvas = ref.current;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${base.width} / ${base.height}`;
      task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
      task.promise.catch(() => {});
    });
    return () => { live = false; task?.cancel?.(); };
  }, [doc, number, width]);
  return <canvas ref={ref} aria-label={`Page ${number}`} className="block w-full rounded bg-white shadow-sm ring-1 ring-slate-200" />;
}

function PdfViewer({ item }) {
  const box = useRef(null);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(PAGE_BATCH);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let task;
    let live = true;
    loadPdfjs().then(pdfjs => {
      if (!live) return;
      task = pdfjs.getDocument({ url: fileUrl(item.id, true), withCredentials: true, isEvalSupported: false });
      task.promise.then(result => live && setDoc(result), () => live && setError('The preview could not be loaded.'));
    }, () => live && setError('The preview could not be loaded.'));
    return () => { live = false; task?.destroy?.(); };
  }, [item.id]);
  useEffect(() => {
    if (!box.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [doc]);
  if (error) return <Unavailable item={item} message={error} />;
  if (!doc) return <Loading />;
  const pages = Math.min(shown, doc.numPages);
  return (
    <div className={cx(frame, 'p-2 sm:p-3')}>
      <div ref={box} className="mx-auto max-w-3xl space-y-3">
        {width > 0 && Array.from({ length: pages }, (_, i) => <PdfPage key={i} doc={doc} number={i + 1} width={width} />)}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-500">
        <span>{pages} of {doc.numPages} page{doc.numPages === 1 ? '' : 's'}</span>
        {pages < doc.numPages && <Button variant="secondary" size="sm" onClick={() => setShown(n => n + PAGE_BATCH)}>Show more pages</Button>}
      </div>
    </div>
  );
}

function TextViewer({ item }) {
  const { blob, error } = useFile(item, true);
  const [text, setText] = useState(null);
  useEffect(() => { setText(null); blob?.slice(0, 1_000_000).text().then(setText, () => setText('')); }, [blob]);
  if (error) return <Unavailable item={item} message={error} />;
  if (text === null) return <Loading />;
  return <pre className={cx(frame, 'whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-slate-800')}>{text || 'This file is empty.'}</pre>;
}

const isPptx = item => /presentationml\.presentation/.test(item.mime || '') || /\.pptx$/i.test(item.original_name || '');

// Draws the real slides (layout, pictures, shapes and colours) instead of only their text.
function SlideDeck({ blob, onFail }) {
  const box = useRef(null);
  const host = useRef(null);
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!box.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      // Re-render only on real size changes, not on every pixel of a resize.
      const next = Math.max(240, Math.min(960, Math.floor(entry.contentRect.width / 16) * 16));
      setWidth(current => (current === next ? current : next));
    });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!width || !host.current) return undefined;
    let live = true;
    let viewer;
    const el = host.current;
    el.innerHTML = '';
    setReady(false);
    Promise.all([import('pptx-preview'), blob.arrayBuffer(), import('../officePreview.js').then(m => m.deckLayout(blob)).catch(() => null)])
      .then(async ([{ init }, data, layout]) => {
        if (!live) return;
        viewer = init(el, { width, height: Math.round(width * 9 / 16), mode: 'list' });
        await viewer.preview(data);
        if (!live) return;
        const wrapper = el.querySelector('.pptx-preview-wrapper');
        const drawn = wrapper ? [...wrapper.children].filter(node => node.classList.contains('pptx-preview-slide-wrapper')) : [];
        if (!drawn.length) throw new Error('empty');
        // The renderer draws slides in file order and includes hidden ones; match what the presenter would show.
        if (layout?.show.length && drawn.length === layout.files.length) {
          drawn.forEach(node => node.remove());
          layout.show.forEach(name => wrapper.appendChild(drawn[layout.files.indexOf(name)]));
        }
        setCount(wrapper.children.length);
        setReady(true);
      })
      .catch(() => live && onFail());
    return () => { live = false; try { viewer?.destroy?.(); } catch { /* already gone */ } };
  }, [blob, width, onFail]);
  return (
    <div className={cx(frame, 'p-2 sm:p-3')}>
      <div ref={box} className="mx-auto max-w-[960px]">
        {!ready && <Loading label="Drawing slides…" />}
        <div ref={host} className={cx('kt-slides mx-auto', !ready && 'h-0 overflow-hidden')} style={{ width }} />
        {ready && <p className="mt-2 text-center text-xs text-slate-500">{count} slide{count === 1 ? '' : 's'}</p>}
      </div>
    </div>
  );
}

function OfficeViewer({ item }) {
  const { blob, error } = useFile(item, true);
  const [doc, setDoc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(isPptx(item));
  const fallBack = useCallback(() => setDrawn(false), []);
  useEffect(() => {
    if (!blob || drawn) return undefined;
    let live = true;
    setDoc(null);
    setFailed(false);
    import('../officePreview.js').then(m => m.readOffice(blob)).then(result => {
      if (!live) return;
      if (result) setDoc(result); else setFailed(true);
    }, () => live && setFailed(true));
    return () => { live = false; };
  }, [blob, drawn]);
  if (error) return <Unavailable item={item} message={error} />;
  if (drawn) return blob ? <SlideDeck blob={blob} onFail={fallBack} /> : <Loading />;
  if (failed) return <Unavailable item={item} message="This document can’t be shown here. Download it to open it." />;
  if (!doc) return <Loading />;
  if (doc.kind === 'doc') {
    return (
      <div className={cx(frame, 'p-2 sm:p-4')}>
        <article className="mx-auto max-w-3xl space-y-2 rounded bg-white px-5 py-6 text-sm leading-relaxed text-slate-800 shadow-sm ring-1 ring-slate-200 sm:px-10 sm:py-10">
          {doc.paragraphs.map((p, i) => (p.text.trim()
            ? <p key={i} className={p.heading ? 'pt-2 text-base font-semibold text-slate-900' : ''}>{p.text}</p>
            : <div key={i} className="h-2" />))}
        </article>
      </div>
    );
  }
  if (doc.kind === 'slides') {
    return (
      <ol className={cx(frame, 'space-y-3 p-2 sm:p-3')}>
        {doc.slides.map((slide, i) => (
          <li key={i} className="mx-auto flex aspect-video max-w-3xl flex-col overflow-hidden rounded bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6">
            <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Slide {i + 1}</p>
            <h4 className="mt-1 text-base font-semibold text-slate-900 sm:text-lg">{slide.title}</h4>
            <ul className="mt-2 space-y-1 overflow-hidden text-xs text-slate-700 sm:text-sm">
              {slide.lines.map((line, j) => <li key={j}>{line}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    );
  }
  return <SheetViewer sheets={doc.sheets} />;
}

function SheetViewer({ sheets }) {
  const [index, setIndex] = useState(0);
  const sheet = sheets[index];
  return (
    <div className="space-y-2">
      {sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto" role="tablist">
          {sheets.map((s, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === index} onClick={() => setIndex(i)}
              className={cx('shrink-0 rounded-md px-3 py-1 text-xs font-medium', i === index ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>{s.name}</button>
          ))}
        </div>
      )}
      <div className={cx(frame, 'bg-white')}>
        {sheet.rows.length ? (
          <table className="min-w-full border-collapse text-xs">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r} className={r === 0 ? 'bg-slate-50 font-semibold' : ''}>
                  {row.map((cell, c) => <td key={c} className="whitespace-nowrap border border-slate-200 px-2 py-1 text-slate-800">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="p-6 text-center text-sm text-slate-500">This sheet is empty.</p>}
      </div>
      {sheet.truncated && <p className="text-xs text-slate-500">Showing the first rows and columns. Download the file to see everything.</p>}
    </div>
  );
}

const youtubeEmbed = url => {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const id = host === 'youtu.be' ? u.pathname.slice(1) : host.endsWith('youtube.com') ? (u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1]) : null;
    return id && /^[\w-]{6,}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch { return null; }
};

/** Shows the full content of an item so it can be checked before downloading. */
export default function FullPreview({ item }) {
  const src = fileUrl(item.id, true);
  if (item.type === 'image') return <img src={src} alt={item.title} className="mx-auto max-h-[65vh] rounded-lg object-contain" />;
  if (item.type === 'video') {
    return <video key={item.id} src={src} controls playsInline preload="metadata" poster={item.has_thumb ? thumbnailUrl(item.id) : undefined} className="mx-auto max-h-[65vh] w-full rounded-lg bg-black" />;
  }
  if (item.type === 'audio') {
    return (
      <div className="space-y-4 rounded-lg bg-slate-50 p-4 text-center">
        {item.has_thumb && <img src={thumbnailUrl(item.id)} alt="" className="mx-auto max-h-56 rounded-lg object-contain" />}
        <audio key={item.id} src={src} controls preload="metadata" className="w-full" />
      </div>
    );
  }
  if (item.type === 'link') {
    const embed = youtubeEmbed(item.url);
    if (embed) {
      return <iframe title={item.title} src={embed} className="aspect-video w-full rounded-lg bg-black" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />;
    }
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">External link</p>
        <p className="mt-1 break-all text-sm text-slate-800">{item.url}</p>
      </div>
    );
  }
  if (isPdf(item)) return <PdfViewer item={item} />;
  if (isOffice(item)) return <OfficeViewer item={item} />;
  if (isText(item)) return <TextViewer item={item} />;
  return <Unavailable item={item} message="A preview isn’t available for this file type. Download it to open it." />;
}
