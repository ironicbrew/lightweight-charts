import { useState } from 'react';
import { Chart } from './Chart';
import { SpreadChart } from './SpreadChart';

type Tab = 'chart' | 'spread';

const TAB_CSS = `
.app-tabs {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 10px;
	background: #131722;
	border-bottom: 1px solid #2a2e39;
	flex-shrink: 0;
	height: 36px;
}
.app-tab {
	padding: 0 14px;
	height: 34px;
	border: none;
	background: transparent;
	color: #787b86;
	font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
	cursor: pointer;
	border-bottom: 2px solid transparent;
	transition: color 0.15s, border-color 0.15s;
	margin-bottom: -1px;
}
.app-tab:hover { color: #d1d4dc; }
.app-tab-active {
	color: #d1d4dc;
	border-bottom-color: #2962FF;
}
`;

export function App() {
	const [tab, setTab] = useState<Tab>('chart');

	return (
		<div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: '#111317' }}>
			<style>{TAB_CSS}</style>
			<div className="app-tabs">
				<button
					className={`app-tab${tab === 'chart' ? ' app-tab-active' : ''}`}
					type="button"
					onClick={() => setTab('chart')}
				>
					Chart
				</button>
				<button
					className={`app-tab${tab === 'spread' ? ' app-tab-active' : ''}`}
					type="button"
					onClick={() => setTab('spread')}
				>
					Spread
				</button>
			</div>
			<div style={{ flex: 1, minHeight: 0, display: tab === 'chart' ? 'flex' : 'none', flexDirection: 'column' }}>
				<Chart />
			</div>
			<div style={{ flex: 1, minHeight: 0, display: tab === 'spread' ? 'flex' : 'none', flexDirection: 'column' }}>
				<SpreadChart />
			</div>
		</div>
	);
}
