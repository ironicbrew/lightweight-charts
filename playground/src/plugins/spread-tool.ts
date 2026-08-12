import {
	LineSeries,
	LineStyle,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	type Time,
} from 'lightweight-charts';

export interface SpreadBar {
	time: number;   // unix seconds
	front: number;  // front-month price
	back: number;   // back-month price
}

interface Derived {
	time: number;
	spread: number;
	sma: number | null;
	zscore: number | null;
}

// Compute spread, rolling SMA, and z-score from SpreadBar[].
// Returns a parallel array of Derived values.
function computeAll(bars: SpreadBar[], lookback: number): Derived[] {
	const n = bars.length;
	const result: Derived[] = new Array(n);

	// Running accumulators for mean and variance (Welford-style over lookback window).
	// We use a simple two-pass approach per window for clarity + correctness.
	const spreads: number[] = bars.map(b => b.front - b.back);

	for (let i = 0; i < n; i++) {
		const spread = spreads[i];
		let sma: number | null = null;
		let zscore: number | null = null;

		if (i >= lookback - 1) {
			// Window [i - lookback + 1 .. i]
			let sum = 0;
			for (let j = i - lookback + 1; j <= i; j++) sum += spreads[j];
			sma = sum / lookback;

			let varSum = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				const diff = spreads[j] - sma;
				varSum += diff * diff;
			}
			const std = Math.sqrt(varSum / lookback);
			zscore = std > 0 ? (spread - sma) / std : 0;
		}

		result[i] = { time: bars[i].time, spread, sma, zscore };
	}

	return result;
}

// Efficient tail recompute — only the last `lookback` entries change.
function recomputeTail(bars: SpreadBar[], derived: Derived[], lookback: number): void {
	const n = bars.length;
	const spreads = bars.map(b => b.front - b.back);

	// Only bars from index (n - lookback) onward need updating, but we at minimum
	// need to recompute from (n - lookback * 2) to handle newly valid windows.
	const start = Math.max(0, n - lookback * 2);
	for (let i = start; i < n; i++) {
		const spread = spreads[i];
		let sma: number | null = null;
		let zscore: number | null = null;

		if (i >= lookback - 1) {
			let sum = 0;
			for (let j = i - lookback + 1; j <= i; j++) sum += spreads[j];
			sma = sum / lookback;

			let varSum = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				const diff = spreads[j] - sma;
				varSum += diff * diff;
			}
			const std = Math.sqrt(varSum / lookback);
			zscore = std > 0 ? (spread - sma) / std : 0;
		}

		derived[i] = { time: bars[i].time, spread, sma, zscore };
	}
}

export class SpreadTool {
	private _bars: SpreadBar[] = [];
	private _derived: Derived[] = [];
	private _lookback: number = 20;

	// Pane 0 — front and back price lines
	private _frontSeries: ISeriesApi<'Line'>;
	private _backSeries: ISeriesApi<'Line'>;

	// Pane 1 — spread + its SMA
	private _spreadSeries: ISeriesApi<'Line'>;
	private _smaSeries: ISeriesApi<'Line'>;

	// Pane 2 — z-score
	private _zscoreSeries: ISeriesApi<'Line'>;

	constructor(private _chart: IChartApi) {
		// Pane 0: front + back month prices (existing pane, index 0)
		this._frontSeries = this._chart.addSeries(LineSeries, {
			color: '#2962FF',
			lineWidth: 2,
			title: 'Front',
			priceLineVisible: false,
			lastValueVisible: true,
		}, 0);

		this._backSeries = this._chart.addSeries(LineSeries, {
			color: '#FF6D00',
			lineWidth: 2,
			title: 'Back',
			priceLineVisible: false,
			lastValueVisible: true,
		}, 0);

		// Add pane 1 for the spread
		this._chart.addPane();
		this._spreadSeries = this._chart.addSeries(LineSeries, {
			color: '#26c6da',
			lineWidth: 2,
			title: 'Spread',
			priceLineVisible: false,
			lastValueVisible: true,
		}, 1);

		this._smaSeries = this._chart.addSeries(LineSeries, {
			color: 'rgba(150, 150, 150, 0.6)',
			lineWidth: 1,
			title: `SMA(${this._lookback})`,
			priceLineVisible: false,
			lastValueVisible: false,
			crosshairMarkerVisible: false,
		}, 1);

		// Add pane 2 for z-score
		this._chart.addPane();
		this._zscoreSeries = this._chart.addSeries(LineSeries, {
			color: '#2962FF',
			lineWidth: 2,
			title: 'Z-Score',
			priceLineVisible: false,
			lastValueVisible: true,
			autoscaleInfoProvider: (_original: () => import('lightweight-charts').AutoscaleInfo | null) => {
				if (this._derived.length === 0) return null;
				let minZ = -3;
				let maxZ = 3;
				for (const d of this._derived) {
					if (d.zscore !== null) {
						if (d.zscore < minZ) minZ = d.zscore;
						if (d.zscore > maxZ) maxZ = d.zscore;
					}
				}
				return {
					priceRange: {
						minValue: Math.min(-3, minZ),
						maxValue: Math.max(3, maxZ),
					},
				};
			},
		}, 2);

		// Add price lines for sigma levels on the z-score series
		this._zscoreSeries.createPriceLine({
			price: 2,
			color: '#ef5350',
			lineWidth: 1,
			lineStyle: LineStyle.Dashed,
			axisLabelVisible: true,
			title: '+2σ',
		});
		this._zscoreSeries.createPriceLine({
			price: -2,
			color: '#26a69a',
			lineWidth: 1,
			lineStyle: LineStyle.Dashed,
			axisLabelVisible: true,
			title: '-2σ',
		});
		this._zscoreSeries.createPriceLine({
			price: 1,
			color: 'rgba(239, 83, 80, 0.4)',
			lineWidth: 1,
			lineStyle: LineStyle.Dashed,
			axisLabelVisible: false,
			title: '+1σ',
		});
		this._zscoreSeries.createPriceLine({
			price: -1,
			color: 'rgba(38, 166, 154, 0.4)',
			lineWidth: 1,
			lineStyle: LineStyle.Dashed,
			axisLabelVisible: false,
			title: '-1σ',
		});

		// Size the panes: ~50% main, ~30% spread, ~20% z-score
		const panes = this._chart.panes();
		if (panes.length >= 3) {
			panes[0].setStretchFactor(5000);
			panes[1].setStretchFactor(3000);
			panes[2].setStretchFactor(2000);
		}
	}

	setData(bars: SpreadBar[]): void {
		this._bars = bars.slice();
		this._derived = computeAll(this._bars, this._lookback);
		this._pushAll();
	}

	appendBar(bar: SpreadBar): void {
		this._bars.push(bar);
		this._derived.push({ time: bar.time, spread: 0, sma: null, zscore: null });
		recomputeTail(this._bars, this._derived, this._lookback);

		// Update series with only the last value (efficient)
		const last = this._derived[this._derived.length - 1];
		const t = last.time as Time;

		this._frontSeries.update({ time: t, value: bar.front });
		this._backSeries.update({ time: t, value: bar.back });
		this._spreadSeries.update({ time: t, value: last.spread });
		if (last.sma !== null) {
			this._smaSeries.update({ time: t, value: last.sma });
		}
		if (last.zscore !== null) {
			this._zscoreSeries.update({ time: t, value: last.zscore });
		}
	}

	setLookback(period: number): void {
		this._lookback = period;
		this._smaSeries.applyOptions({ title: `SMA(${period})` });
		if (this._bars.length > 0) {
			this._derived = computeAll(this._bars, this._lookback);
			this._pushAll();
		}
	}

	remove(): void {
		this._chart.removeSeries(this._frontSeries);
		this._chart.removeSeries(this._backSeries);
		this._chart.removeSeries(this._spreadSeries);
		this._chart.removeSeries(this._smaSeries);
		this._chart.removeSeries(this._zscoreSeries);
	}

	private _pushAll(): void {
		const frontData: LineData<Time>[] = [];
		const backData: LineData<Time>[] = [];
		const spreadData: LineData<Time>[] = [];
		const smaData: LineData<Time>[] = [];
		const zscoreData: LineData<Time>[] = [];

		for (let i = 0; i < this._bars.length; i++) {
			const bar = this._bars[i];
			const d = this._derived[i];
			const t = bar.time as Time;

			frontData.push({ time: t, value: bar.front });
			backData.push({ time: t, value: bar.back });
			spreadData.push({ time: t, value: d.spread });
			if (d.sma !== null) {
				smaData.push({ time: t, value: d.sma });
			}
			if (d.zscore !== null) {
				zscoreData.push({ time: t, value: d.zscore });
			}
		}

		this._frontSeries.setData(frontData);
		this._backSeries.setData(backData);
		this._spreadSeries.setData(spreadData);
		this._smaSeries.setData(smaData);
		this._zscoreSeries.setData(zscoreData);
	}
}
