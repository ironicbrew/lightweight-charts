import {
	LineSeries,
	LineStyle,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	type Time,
} from 'lightweight-charts';

const RSI_PERIOD = 14;
const RSI_COLOR = '#f48fb1';

// Compute full RSI series using Wilder's smoothed average method.
function computeRSI(bars: { time: number; close: number }[], period: number): LineData<Time>[] {
	if (bars.length < period + 1) return [];
	const result: LineData<Time>[] = [];

	let avgGain = 0;
	let avgLoss = 0;

	for (let i = 1; i <= period; i++) {
		const delta = bars[i].close - bars[i - 1].close;
		if (delta > 0) avgGain += delta;
		else avgLoss -= delta;
	}
	avgGain /= period;
	avgLoss /= period;

	for (let i = period; i < bars.length; i++) {
		if (i > period) {
			const delta = bars[i].close - bars[i - 1].close;
			const gain = delta > 0 ? delta : 0;
			const loss = delta < 0 ? -delta : 0;
			avgGain = (avgGain * (period - 1) + gain) / period;
			avgLoss = (avgLoss * (period - 1) + loss) / period;
		}
		const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
		const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
		result.push({ time: bars[i].time as Time, value: rsi });
	}

	return result;
}

export class RsiTool {
	private _series: ISeriesApi<'Line'> | null = null;
	private _paneIndex: number | null = null;

	constructor(private _chart: IChartApi) {}

	get isEnabled(): boolean {
		return this._series !== null;
	}

	// Add the RSI pane and series. Returns true.
	enable(bars: { time: number; close: number }[]): boolean {
		if (this._series) return true;

		this._chart.addPane();
		const panes = this._chart.panes();
		this._paneIndex = panes.length - 1;

		this._series = this._chart.addSeries(LineSeries, {
			color: RSI_COLOR,
			lineWidth: 1,
			title: `RSI(${RSI_PERIOD})`,
			priceLineVisible: false,
			lastValueVisible: true,
			autoscaleInfoProvider: () => ({
				priceRange: { minValue: 0, maxValue: 100 },
				margins: { above: 0.1, below: 0.1 },
			}),
		}, this._paneIndex);

		this._series.createPriceLine({ price: 70, color: 'rgba(244,143,177,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
		this._series.createPriceLine({ price: 30, color: 'rgba(244,143,177,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });

		// Size the RSI pane smaller than the main pane.
		const paneList = this._chart.panes();
		paneList[0].setStretchFactor(3);
		paneList[this._paneIndex].setStretchFactor(1);

		this._series.setData(computeRSI(bars, RSI_PERIOD));
		return true;
	}

	// Remove the RSI series + pane. Returns false.
	disable(): boolean {
		if (!this._series) return false;
		this._chart.removeSeries(this._series);
		this._series = null;
		this._paneIndex = null;
		// Reset pane stretch on the main pane back to default.
		this._chart.panes()[0]?.setStretchFactor(1);
		return false;
	}

	toggle(bars: { time: number; close: number }[]): boolean {
		return this._series ? this.disable() : this.enable(bars);
	}

	// Efficient append: only recompute the tail of the RSI.
	appendBar(bars: { time: number; close: number }[]): void {
		if (!this._series || bars.length < RSI_PERIOD + 1) return;
		// Recompute from (bars.length - period - 1) to pick up the new bar.
		const slice = bars.slice(-(RSI_PERIOD + 2));
		const tail = computeRSI(slice.map((b, i) => ({ time: bars[bars.length - slice.length + i].time, close: b.close })), RSI_PERIOD);
		if (tail.length > 0) {
			this._series.update(tail[tail.length - 1]);
		}
	}

	remove(): void {
		if (this._series) {
			this._chart.removeSeries(this._series);
			this._series = null;
			this._paneIndex = null;
		}
	}
}
