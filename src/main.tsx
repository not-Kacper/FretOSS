import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { applyTheme, loadSettings } from './storage/settings';
import './styles.css';

applyTheme(loadSettings().theme);

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root container is missing from index.html');
}

// main.py: `if __name__ == "__main__": main()` — one view, mounted once.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
