import {
	HistogramSeries,
	LineSeries,
	LineStyle,
	type IChartApi,
	type ISeriesApi,
	type HistogramData,
	type LineData,
	type Time,
} from 'lightweight-charts';

const FAST = 12;
const SLOW = 26;
const SIGNAL = 9;

const COLOR_MACD    = '#2962FF';
const COLOR_SIGNAL  = '#ff6d00';
const COLOR_POS     = 'rgba(38,166,154,0.6)';
const COLOR_NEG     = 'rgba(239,83,80,0.6)';

interface MACDPoint {
	time: number;
	macd: number;
	signal: number;
	hist: number;
}

// EMA seeded from the first value.
function computeEMA(values: number[], period: number): number[] {
	if (values.length === 0) return [];
	const k = 2 / (period + 1);
	const result: number[] = new Array(values.length);
	result[0] = values[0];
	for (let i = 1; i < values.length; i++) {
		result[i] = values[i] * k + result[i - 1] * (1 - k);
	}
	return result;
}

function computeMACD(bars: { time: number; close: number }[]): MACDPoint[] {
	if (bars.length < SLOW + SIGNAL) return [];

	const closes = bars.map(b => b.close);
	const fastEMA  = computeEMA(closes, FAST);
	const slowEMA  = computeEMA(closes, SLOW);

	// MACD line starts being meaningful once the slow EMA has warmed up.
	// We skip the first (SLOW - 1) bars so both EMAs have the same history depth.
	const macdLine: number[] = [];
	const macdTimes: number[] = [];
	for (let i = SLOW - 1; i < bars.length; i++) {
		macdLine.push(fastEMA[i] - slowEMA[i]);
		macdTimes.push(bars[i].time);
	}

	const signalLine = computeEMA(macdLine, SIGNAL);

	const result: MACDPoint[] = [];
	for (let i = SIGNAL - 1; i < macdLine.length; i++) {
		result.push({
			time: macdTimes[i],
			macd: macdLine[i],
			signal: signalLine[i],
			hist: macdLine[i] - signalLine[i],
		});
	}
	return result;
}

export class MacdTool {
	private _macdSeries:   ISeriesApi<'Line'>      | null = null;
	private _signalSeries: ISeriesApi<'Line'>      | null = null;
	private _histSeries:   ISeriesApi<'Histogram'> | null = null;
	private _paneIndex: number | null = null;

	constructor(private _chart: IChartApi) {}

	get isEnabled(): boolean {
		return this._macdSeries !== null;
	}

	enable(bars: { time: number; close: number }[]): boolean {
		if (this._macdSeries) return true;

		this._chart.addPane();
		const panes = this._chart.panes();
		this._paneIndex = panes.length - 1;
		const pi = this._paneIndex;

		this._histSeries = this._chart.addSeries(HistogramSeries, {
			color: COLOR_POS,
			priceLineVisible: false,
			lastValueVisible: false,
			title: '',
		}, pi);

		this._macdSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_MACD,
			lineWidth: 1,
			title: `MACD(${FAST},${SLOW},${SIGNAL})`,
			priceLineVisible: false,
			lastValueVisible: true,
		}, pi);

		this._signalSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_SIGNAL,
			lineWidth: 1,
			title: 'Signal',
			priceLineVisible: false,
			lastValueVisible: true,
		}, pi);

		// Zero line for reference.
		this._macdSeries.createPriceLine({
			price: 0,
			color: 'rgba(120,123,134,0.4)',
			lineWidth: 1,
			lineStyle: LineStyle.Solid,
			axisLabelVisible: false,
			title: '',
		});

		// Size the MACD pane smaller than the main pane.
		const paneList = this._chart.panes();
		paneList[0].setStretchFactor(3);
		paneList[pi].setStretchFactor(1);

		this._setData(computeMACD(bars));
		return true;
	}

	disable(): boolean {
		if (!this._macdSeries) return false;
		if (this._histSeries)   this._chart.removeSeries(this._histSeries);
		if (this._macdSeries)   this._chart.removeSeries(this._macdSeries);
		if (this._signalSeries) this._chart.removeSeries(this._signalSeries);
		this._histSeries   = null;
		this._macdSeries   = null;
		this._signalSeries = null;
		this._paneIndex    = null;
		this._chart.panes()[0]?.setStretchFactor(1);
		return false;
	}

	toggle(bars: { time: number; close: number }[]): boolean {
		return this._macdSeries ? this.disable() : this.enable(bars);
	}

	appendBar(bars: { time: number; close: number }[]): void {
		if (!this._macdSeries) return;
		const points = computeMACD(bars);
		if (points.length === 0) return;
		const last = points[points.length - 1];
		this._macdSeries.update({ time: last.time as Time, value: last.macd });
		this._signalSeries!.update({ time: last.time as Time, value: last.signal });
		this._histSeries!.update({
			time: last.time as Time,
			value: last.hist,
			color: last.hist >= 0 ? COLOR_POS : COLOR_NEG,
		});
	}

	remove(): void {
		if (this._macdSeries) this.disable();
	}

	private _setData(points: MACDPoint[]): void {
		const macdData:   LineData<Time>[]      = points.map(p => ({ time: p.time as Time, value: p.macd }));
		const signalData: LineData<Time>[]      = points.map(p => ({ time: p.time as Time, value: p.signal }));
		const histData:   HistogramData<Time>[] = points.map(p => ({
			time: p.time as Time,
			value: p.hist,
			color: p.hist >= 0 ? COLOR_POS : COLOR_NEG,
		}));
		this._macdSeries!.setData(macdData);
		this._signalSeries!.setData(signalData);
		this._histSeries!.setData(histData);
	}
}
