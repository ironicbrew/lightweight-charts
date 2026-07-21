import { useEffect, useRef, useState } from 'react';
import {
	CandlestickSeries,
	createChart,
	LineSeries,
	type CandlestickData,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	type Time,
} from 'lightweight-charts';
import { TrendLineDrawingTool, type LineKind } from './plugins/trend-line-tool';
import { DrawingToolbar } from './DrawingToolbar';

type SeriesKind = 'Line' | 'Candlestick';

interface Bar {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
}

// Canonical OHLC dataset. Line view is derived from it (value = close), so
// both series types and the live feed share a single source of truth.
function makeSeedBars(): Bar[] {
	const bars: Bar[] = [];
	let prev = 100;
	for (let i = 0; i < 50; i++) {
		const open = prev;
		const close = open + Math.sin(i / 4) * 4 + 0.4; // gentle deterministic drift
		const high = Math.max(open, close) + Math.abs(Math.sin(i)) * 2;
		const low = Math.min(open, close) - Math.abs(Math.cos(i)) * 2;
		bars.push({ time: 1704067200 + i * 86400, open, high, low, close });
		prev = close;
	}
	return bars;
}

function toLine(bar: Bar): LineData<Time> {
	return { time: bar.time as Time, value: bar.close };
}
function toCandle(bar: Bar): CandlestickData<Time> {
	return {
		time: bar.time as Time,
		open: bar.open,
		high: bar.high,
		low: bar.low,
		close: bar.close,
	};
}

// Generate the next live bar from the previous one.
function nextBar(last: Bar): Bar {
	const open = last.close;
	const close = open + (Math.random() - 0.5) * 8;
	const high = Math.max(open, close) + Math.random() * 3;
	const low = Math.min(open, close) - Math.random() * 3;
	return { time: last.time + 86400, open, high, low, close };
}

export function Chart() {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<IChartApi | null>(null);
	const toolRef = useRef<TrendLineDrawingTool | null>(null);
	const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Candlestick'> | null>(null);
	// Canonical bars persist across type toggles so live appends aren't lost.
	const barsRef = useRef<Bar[]>(makeSeedBars());

	const [activeKind, setActiveKind] = useState<LineKind | null>(null);
	const [live, setLive] = useState(false);
	const [seriesType, setSeriesType] = useState<SeriesKind>('Line');

	// Build the chart + series + drawing tool. Rebuilds when the series type
	// changes (swapping the series requires a fresh series object and tool).
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

		const bars = barsRef.current;
		let series: ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>;
		if (seriesType === 'Candlestick') {
			const s = chart.addSeries(CandlestickSeries, {
				upColor: '#26a69a',
				downColor: '#ef5350',
				borderVisible: false,
				wickUpColor: '#26a69a',
				wickDownColor: '#ef5350',
			});
			s.setData(bars.map(toCandle));
			series = s;
		} else {
			const s = chart.addSeries(LineSeries, { color: '#2962FF', lineWidth: 2 });
			s.setData(bars.map(toLine));
			series = s;
		}
		seriesRef.current = series;
		chart.timeScale().fitContent();

		const tool = new TrendLineDrawingTool(chart, series);
		tool.onStateChange((_drawing, kind) => setActiveKind(kind));
		toolRef.current = tool;

		return () => {
			tool.remove();
			chart.remove();
			chartRef.current = null;
			seriesRef.current = null;
			toolRef.current = null;
		};
	}, [seriesType]);

	// Live feed: append a bar every second. Depends on seriesType so the update
	// payload matches the current series' shape.
	useEffect(() => {
		if (!live) return;
		const id = setInterval(() => {
			const series = seriesRef.current;
			if (!series) return;
			const bars = barsRef.current;
			const bar = nextBar(bars[bars.length - 1]);
			bars.push(bar);
			if (seriesType === 'Candlestick') {
				(series as ISeriesApi<'Candlestick'>).update(toCandle(bar));
			} else {
				(series as ISeriesApi<'Line'>).update(toLine(bar));
			}
		}, 1000);
		return () => clearInterval(id);
	}, [live, seriesType]);

	return (
		<div style={{ display: 'flex', width: '100%', height: '100%' }}>
			<DrawingToolbar
				activeKind={activeKind}
				onToggle={(kind) => toolRef.current?.toggle(kind)}
				live={live}
				onToggleLive={() => setLive(v => !v)}
				candles={seriesType === 'Candlestick'}
				onToggleCandles={() => setSeriesType(t => (t === 'Line' ? 'Candlestick' : 'Line'))}
			/>
			<div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
				<div ref={containerRef} style={{ width: '100%', height: '100%' }} />
			</div>
		</div>
	);
}
