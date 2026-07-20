import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// StrictMode double-invokes effects in dev on purpose — it's the best way to
// catch missing cleanup (the classic "two charts stacked in one div" bug).
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>
);
