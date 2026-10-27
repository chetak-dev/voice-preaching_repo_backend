import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export const LANGUAGES = ['English', 'Hindi', 'Odia', 'Bengali', 'Sanskrit', 'Telugu', 'Other'];
export const EMPTY_TAGS = { language: '', speaker: '', verses: '', topics: '' };

/** "2.13,3.19,3.20,3.21,4" → "2.13, 3.19–21, Ch 4" */
export function formatVerses(value) {
  if (!value) return '';
  const groups = [];
  for (const ref of value.split(',')) {
    const [chapter, verse] = ref.split('.').map(Number);
    const last = groups[groups.length - 1];
    if (verse && last && last.chapter === chapter && last.to === verse - 1) last.to = verse;
    else groups.push({ chapter, from: verse, to: verse });
  }
  return groups.map(g => (!g.from ? `Ch ${g.chapter}` : g.from === g.to ? `${g.chapter}.${g.from}` : `${g.chapter}.${g.from}–${g.to}`)).join(', ');
}

// Picks up references such as "BG 2.13", "Gita 3:19-21" or "2.47" from a title.
const GITA_VERSES = [47, 72, 43, 42, 29, 47, 30, 28, 34, 42, 55, 20, 35, 27, 20, 24, 28, 78];
export function detectVerses(title) {
  const found = [];
  const pattern = /(?:^|[^\d.])(1[0-8]|[1-9])[.:](\d{1,2})(?:\s*-\s*(\d{1,2}))?(?![\d.])/g;
  let match;
  while ((match = pattern.exec(title || ''))) {
    const [, chapter, from, to] = match.map(Number);
    const last = to || from;
    if (from < 1 || last < from || last > GITA_VERSES[chapter - 1] || last - from > 20) continue;
    found.push(to ? `${chapter}.${from}-${to}` : `${chapter}.${from}`);
  }
  return [...new Set(found)].join(', ');
}

export const tagsOf = item => ({
  language: item?.language || '', speaker: item?.speaker || '',
  verses: item?.verses ? formatVerses(item.verses).replace(/–/g, '-').replace(/Ch /g, '') : '',
  topics: item?.topics ? item.topics.split(',').join(', ') : '',
});

let facetsPromise;
export function useFacets() {
  const [facets, setFacets] = useState(null);
  useEffect(() => {
    let live = true;
    facetsPromise ||= api('/content/facets').catch(error => { facetsPromise = null; throw error; });
    facetsPromise.then(data => live && setFacets(data)).catch(() => {});
    return () => { live = false; };
  }, []);
  return facets;
}
export const refreshFacets = () => { facetsPromise = null; };

export function TagFields({ value, onChange, idPrefix = 'tags' }) {
  const facets = useFacets();
  const set = key => event => onChange({ ...value, [key]: event.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="label">Language</span>
        <select className="input" value={value.language} onChange={set('language')}>
          <option value="">Not set</option>
          {LANGUAGES.map(language => <option key={language}>{language}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="label">Speaker</span>
        <input className="input" value={value.speaker} onChange={set('speaker')} maxLength={80} placeholder="e.g. HG Prabhu" list={`${idPrefix}-speakers`} />
        <datalist id={`${idPrefix}-speakers`}>{facets?.speakers.map(entry => <option key={entry.name} value={entry.name} />)}</datalist>
      </label>
      <label className="block">
        <span className="label">Gita verses</span>
        <input className="input" value={value.verses} onChange={set('verses')} maxLength={300} placeholder="e.g. 2.13, 3.19-21 or 4" />
      </label>
      <label className="block">
        <span className="label">Topics</span>
        <input className="input" value={value.topics} onChange={set('topics')} maxLength={300} placeholder="Comma separated, e.g. karma, soul" list={`${idPrefix}-topics`} />
        <datalist id={`${idPrefix}-topics`}>{facets?.topics.map(entry => <option key={entry.name} value={entry.name} />)}</datalist>
      </label>
    </div>
  );
}

export function TagChips({ item, onPick, className = '' }) {
  const chips = [
    item.language && { key: 'language', label: item.language, value: item.language },
    item.speaker && { key: 'speaker', label: item.speaker, value: item.speaker },
    item.verses && { key: 'verses', label: `BG ${formatVerses(item.verses)}`, value: item.verses.split(',')[0].split('.')[0], filter: 'chapter' },
    ...(item.topics ? item.topics.split(',').map(topic => ({ key: `t:${topic}`, label: `#${topic}`, value: topic, filter: 'topic' })) : []),
  ].filter(Boolean);
  if (!chips.length) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {chips.map(chip => {
        const Tag = onPick ? 'button' : 'span';
        return (
          <Tag key={chip.key} type={onPick ? 'button' : undefined} onClick={onPick ? () => onPick(chip.filter || chip.key, chip.value) : undefined}
            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">
            {chip.label}
          </Tag>
        );
      })}
    </div>
  );
}
