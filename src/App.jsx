import React, { useState, useMemo } from 'react';
import {
  Search, Home, Users, UploadCloud, HardDrive, FileText,
  Image as ImageIcon, Video, Music, Link as LinkIcon,
  Eye, Download, ExternalLink, Share2, Plus, Trophy, Sparkles
} from 'lucide-react';
import initialData from './data/initialNodes.json';

export default function App() {
  const [items, setItems] = useState(initialData.items || []);
  const [driveNodes] = useState(initialData.driveNodes || []);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (selectedCategory !== 'all' && item.type !== selectedCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
      }
      return true;
    });
  }, [items, selectedCategory, searchQuery]);

  return (
    <div className="min-h-screen bg-[#FAF6F0] text-slate-800 p-6">
      <header className="max-w-7xl mx-auto flex items-center justify-between pb-6 border-b border-orange-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-orange-500 to-amber-400 text-white flex items-center justify-center font-bold">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-orange-600">Sarvajna Team Content Hub</h1>
            <p className="text-xs text-slate-500">{driveNodes.length} Google Drive Backends Connected</p>
          </div>
        </div>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search files across all Google Drives..."
          className="px-4 py-2 rounded-xl border border-orange-200 bg-white text-sm w-72"
        />
      </header>
      <main className="max-w-7xl mx-auto mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
        {filtered.map((item) => (
          <div key={item.id} className="bg-white rounded-3xl border border-orange-100 overflow-hidden shadow-sm">
            <img src={item.thumbnail} alt={item.title} className="h-44 w-full object-cover" />
            <div className="p-4">
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-orange-100 text-orange-700">{item.format}</span>
              <h3 className="font-bold text-sm mt-2 truncate">{item.title}</h3>
              <p className="text-xs text-slate-500 line-clamp-2 mt-1">{item.description}</p>
              <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-100 text-xs text-slate-400">
                <span>{item.size}</span>
                <span>By {item.uploader}</span>
              </div>
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
