import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi } from 'lightweight-charts';
import { SpreadTool, type SpreadBar } from './plugins/spread-tool';

// ── Deterministic LCG (seed=42) ───────────────────────────────────────────────
// Produces floats in [0, 1). Used instead of Math.random() for stable hot-reload.
function makeLCG(seed: number): () => number {
	let s = seed;
	return () => {
		// Parameters from Numerical Recipes
		s = (Math.imul(1664525, s) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function randn(rand: () => number): number {
	// Box-Muller transform
	const u1 = rand();
	const u2 = rand();
	return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
}

// Generate 2 years of daily data with an OU-style spread component.
function makeSeedBars(): SpreadBar[] {
	const rand = makeLCG(42);
	const bars: SpreadBar[] = [];

	const startTime = 1704067200; // 2024-01-01 00:00:00 UTC
	const days = 365 * 2;

	let front = 100;
	let spreadOU = 0; // mean-reverts to 0

	for (let i = 0; i < days; i++) {
		// Front month: random walk with slight positive drift
		const frontReturn = 0.003 + 0.012 * randn(rand);
		front = front * (1 + frontReturn);

		// Spread component: Ornstein-Uhlenbeck
		// spread_t = spread_{t-1} * 0.98 + 0.2 * randn
		spreadOU = spreadOU * 0.98 + 0.2 * randn(rand);

		const back = front + spreadOU;

		bars.push({
			time: startTime + i * 86400,
			front: Math.max(front, 1),
			back: Math.max(back, 1),
		});
	}

	return bars;
}

// Generate the next bar from the last one using the same OU model.
// We use a simple per-call rand so each live tick is different.
let _liveRandState = 99991;
function nextBar(last: SpreadBar): SpreadBar {
	// Mini LCG for live ticks
	const r = () => {
		_liveRandState = (Math.imul(1664525, _liveRandState) + 1013904223) >>> 0;
		return _liveRandState / 0x100000000;
	};

	const spreadPrev = last.front - last.back;
	const frontReturn = 0.003 + 0.012 * randn(r);
	const front = last.front * (1 + frontReturn);
	const spreadNext = spreadPrev * 0.98 + 0.2 * randn(r);
	const back = front + spreadNext;

	return {
		time: last.time + 86400,
		front: Math.max(front, 1),
		back: Math.max(back, 1),
	};
}

export function SpreadChart() {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<IChartApi | null>(null);
	const toolRef = useRef<SpreadTool | null>(null);
	const barsRef = useRef<SpreadBar[]>(makeSeedBars());

	const [live, setLive] = useState(false);
	const [lookback, setLookback] = useState(20);

	// Build chart + SpreadTool
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const chart = createChart(container, {
			autoSize: true,
			layout: {
				background: { color: '#111317' },
				textColor: '#d1d4dc',
			},
			grid: {
				vertLines: { color: '#1f2329' },
				horzLines: { color: '#1f2329' },
			},
			rightPriceScale: { borderColor: '#2a2e39' },
			timeScale: { borderColor: '#2a2e39' },
			crosshair: {
				vertLine: { color: '#4a5160', labelBackgroundColor: '#2962FF' },
				horzLine: { color: '#4a5160', labelBackgroundColor: '#2962FF' },
			},
		});
		chartRef.current = chart;

		const tool = new SpreadTool(chart);
		tool.setData(barsRef.current);
		toolRef.current = tool;

		chart.timeScale().fitContent();

		return () => {
			tool.remove();
			chart.remove();
			chartRef.current = null;
			toolRef.current = null;
		};
	}, []);

	// Live feed
	useEffect(() => {
		if (!live) return;
		const id = setInterval(() => {
			const tool = toolRef.current;
			if (!tool) return;
			const bars = barsRef.current;
			const bar = nextBar(bars[bars.length - 1]);
			bars.push(bar);
			tool.appendBar(bar);
		}, 1000);
		return () => clearInterval(id);
	}, [live]);

	// Lookback changes
	const handleLookbackChange = (value: number) => {
		setLookback(value);
		toolRef.current?.setLookback(value);
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#111317' }}>
			<style>{SPREAD_CSS}</style>
			{/* Controls bar */}
			<div className="spread-controls">
				<label className="spread-label">
					Lookback
					<span className="spread-value">{lookback}</span>
				</label>
				<input
					className="spread-slider"
					type="range"
					min={5}
					max={100}
					value={lookback}
					onChange={e => handleLookbackChange(Number(e.target.value))}
				/>
				<button
					className={`spread-btn${live ? ' spread-btn-active' : ''}`}
					type="button"
					onClick={() => setLive(v => !v)}
				>
					{live ? 'Live' : 'Live'}
					<span className={`spread-dot${live ? ' spread-dot-on' : ''}`} />
				</button>
			</div>
			{/* Chart container */}
			<div style={{ flex: 1, minHeight: 0 }}>
				<div ref={containerRef} style={{ width: '100%', height: '100%' }} />
			</div>
		</div>
	);
}

const SPREAD_CSS = `
.spread-controls {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 6px 14px;
	background: #131722;
	border-bottom: 1px solid #2a2e39;
	flex-shrink: 0;
}
.spread-label {
	display: flex;
	align-items: center;
	gap: 6px;
	color: #b2b5be;
	font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
	white-space: nowrap;
	user-select: none;
}
.spread-value {
	color: #d1d4dc;
	font-weight: 600;
	min-width: 28px;
	text-align: right;
}
.spread-slider {
	-webkit-appearance: none;
	appearance: none;
	width: 160px;
	height: 4px;
	border-radius: 2px;
	background: #2a2e39;
	outline: none;
	cursor: pointer;
}
.spread-slider::-webkit-slider-thumb {
	-webkit-appearance: none;
	appearance: none;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: #2962FF;
	cursor: pointer;
}
.spread-slider::-moz-range-thumb {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: #2962FF;
	cursor: pointer;
	border: none;
}
.spread-btn {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	background: #1e222d;
	border: 1px solid #2a2e39;
	border-radius: 4px;
	color: #b2b5be;
	font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
	cursor: pointer;
	transition: background-color 0.15s, color 0.15s;
}
.spread-btn:hover { background: #2a2e39; color: #d1d4dc; }
.spread-btn-active { border-color: #2962FF; color: #2962FF; }
.spread-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #4a5160;
	flex-shrink: 0;
	transition: background-color 0.2s;
}
.spread-dot-on {
	background: #26a69a;
	box-shadow: 0 0 4px rgba(38, 166, 154, 0.8);
	animation: spread-pulse 1.4s ease-in-out infinite;
}
@keyframes spread-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.5; }
}
`;
