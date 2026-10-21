import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { MediaPlayerProvider } from './components/MediaPlayer.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MediaPlayerProvider>
      <App />
    </MediaPlayerProvider>
  </React.StrictMode>
);
