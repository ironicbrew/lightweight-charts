import {
	LineSeries,
	type IChartApi,
	type ISeriesApi,
	type LineData,
	type Time,
} from "lightweight-charts";

export interface MAConfig {
	period: number;
	color: string;
	label: string;
}

export const MA_PRESETS: MAConfig[] = [
	{ period: 9,   color: "#26c6da", label: "MA 9" },
	{ period: 20,  color: "#ff9800", label: "MA 20" },
	{ period: 50,  color: "#ab47bc", label: "MA 50" },
	{ period: 200, color: "#ef5350", label: "MA 200" },
];

// Compute SMA from an array of closes. Returns an array of {time, value} aligned
// to the input bars — the first (period-1) bars have no value and are omitted.
function computeSMA(bars: { time: number; close: number }[], period: number): LineData<Time>[] {
	const result: LineData<Time>[] = [];
	let sum = 0;
	for (let i = 0; i < bars.length; i++) {
		sum += bars[i].close;
		if (i >= period) sum -= bars[i - period].close;
		if (i >= period - 1) {
			result.push({ time: bars[i].time as Time, value: sum / period });
		}
	}
	return result;
}

interface MAState {
	series: ISeriesApi<"Line">;
	config: MAConfig;
}

export class MovingAverageTool {
	private _active: Map<number, MAState> = new Map();

	constructor(private _chart: IChartApi) {}

	// (Re)compute all enabled MAs from a full bar array. Call after series type
	// toggle or initial mount.
	setData(bars: { time: number; close: number }[]) {
		for (const state of this._active.values()) {
			state.series.setData(computeSMA(bars, state.config.period));
		}
	}

	// Append one new bar. Efficient: only recalculates the tail for each period.
	appendBar(bars: { time: number; close: number }[]) {
		for (const state of this._active.values()) {
			const { period } = state.config;
			if (bars.length < period) continue;
			const slice = bars.slice(-period);
			const sum = slice.reduce((acc, b) => acc + b.close, 0);
			const last = bars[bars.length - 1];
			state.series.update({ time: last.time as Time, value: sum / period });
		}
	}

	// Toggle a period on or off. Returns the new enabled state.
	toggle(period: number, bars: { time: number; close: number }[]): boolean {
		if (this._active.has(period)) {
			const state = this._active.get(period)!;
			this._chart.removeSeries(state.series);
			this._active.delete(period);
			return false;
		}

		const config = MA_PRESETS.find(p => p.period === period);
		if (!config) return false;

		const series = this._chart.addSeries(LineSeries, {
			color: config.color,
			lineWidth: 1,
			priceLineVisible: false,
			lastValueVisible: false,
			crosshairMarkerVisible: false,
		});
		series.setData(computeSMA(bars, period));
		this._active.set(period, { series, config });
		return true;
	}

	isEnabled(period: number): boolean {
		return this._active.has(period);
	}

	// Remove all MA series (call on chart teardown).
	remove() {
		for (const state of this._active.values()) {
			this._chart.removeSeries(state.series);
		}
		this._active.clear();
	}
}
