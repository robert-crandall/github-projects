import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { themes } from './themes/browser.ts';
import { AppearanceNotice } from './themes/Appearance.tsx';
import './theme.css';
import './styles.css';

void themes.load().then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><AppearanceNotice /><App /></StrictMode>);
});
