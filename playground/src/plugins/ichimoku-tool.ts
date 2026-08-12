import type {
	BitmapCoordinatesRenderingScope,
	CanvasRenderingTarget2D,
} from 'fancy-canvas';
import {
	LineSeries,
	type IChartApi,
	type ISeriesApi,
	type IPrimitivePaneRenderer,
	type IPrimitivePaneView,
	type ISeriesPrimitive,
	type LineData,
	type SeriesAttachedParameter,
	type SeriesType,
	type Time,
} from 'lightweight-charts';

const TENKAN_P   = 9;
const KIJUN_P    = 26;
const SENKOU_B_P = 52;
const DISP       = 26;

const COLOR_TENKAN = '#e91e63';
const COLOR_KIJUN  = '#1e88e5';
const COLOR_SPAN_A = 'rgba(38,166,154,0.8)';
const COLOR_SPAN_B = 'rgba(239,83,80,0.8)';
const COLOR_CHIKOU = '#ab47bc';

// Semi-transparent fills for the cloud interior.
const FILL_BULL = 'rgba(38,166,154,0.15)';
const FILL_BEAR = 'rgba(239,83,80,0.15)';

type OHLCBar = { time: number; high: number; low: number; close: number };

function periodMid(bars: OHLCBar[], i: number, period: number): number | null {
	if (i < period - 1) return null;
	let hi = -Infinity, lo = Infinity;
	for (let j = i - period + 1; j <= i; j++) {
		if (bars[j].high > hi) hi = bars[j].high;
		if (bars[j].low  < lo) lo = bars[j].low;
	}
	return (hi + lo) / 2;
}

interface IchimokuData {
	tenkan: LineData<Time>[];
	kijun:  LineData<Time>[];
	spanA:  LineData<Time>[];
	spanB:  LineData<Time>[];
	chikou: LineData<Time>[];
}

function computeIchimoku(bars: OHLCBar[]): IchimokuData {
	const barInterval = bars.length >= 2
		? bars[bars.length - 1].time - bars[bars.length - 2].time
		: 86400;

	const futureTime = (i: number): Time => {
		const j = i + DISP;
		if (j < bars.length) return bars[j].time as Time;
		return (bars[bars.length - 1].time + (j - (bars.length - 1)) * barInterval) as Time;
	};

	const tenkan: LineData<Time>[] = [];
	const kijun:  LineData<Time>[] = [];
	const spanA:  LineData<Time>[] = [];
	const spanB:  LineData<Time>[] = [];
	const chikou: LineData<Time>[] = [];

	for (let i = 0; i < bars.length; i++) {
		const t = bars[i].time as Time;

		const tk = periodMid(bars, i, TENKAN_P);
		if (tk !== null) tenkan.push({ time: t, value: tk });

		const kj = periodMid(bars, i, KIJUN_P);
		if (kj !== null) kijun.push({ time: t, value: kj });

		if (tk !== null && kj !== null) {
			spanA.push({ time: futureTime(i), value: (tk + kj) / 2 });
		}

		const sb = periodMid(bars, i, SENKOU_B_P);
		if (sb !== null) {
			spanB.push({ time: futureTime(i), value: sb });
		}

		if (i >= DISP) {
			chikou.push({ time: bars[i - DISP].time as Time, value: bars[i].close });
		}
	}

	return { tenkan, kijun, spanA, spanB, chikou };
}

// ── Cloud fill primitive ───────────────────────────────────────────────────────
// Renders the filled region between Span A and Span B.  Attaches to the Span A
// series so it inherits the correct price scale and pane.

class CloudRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _spanA: LineData<Time>[],
		private _spanB: LineData<Time>[],
		private _chart: IChartApi,
		private _series: ISeriesApi<SeriesType>,
	) {}

	draw(target: CanvasRenderingTarget2D): void {
		target.useBitmapCoordinateSpace((scope: BitmapCoordinatesRenderingScope) => {
			this._drawCloud(scope);
		});
	}

	private _px(v: number): number {
		return Math.round(v);
	}

	private _drawCloud({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapCoordinatesRenderingScope): void {
		const ts = this._chart.timeScale();

		// Build merged time index from SpanA × SpanB (they share timestamps).
		const aMap = new Map<number, number>();
		for (const p of this._spanA) aMap.set(p.time as number, p.value);
		const bMap = new Map<number, number>();
		for (const p of this._spanB) bMap.set(p.time as number, p.value);

		// Only draw where both spans have a value.
		const times: number[] = [];
		for (const t of aMap.keys()) {
			if (bMap.has(t)) times.push(t);
		}
		times.sort((a, b) => a - b);
		if (times.length < 2) return;

		// Convert to pixel coordinates.
		interface Pt { x: number; yA: number; yB: number }
		const pts: Pt[] = [];
		for (const t of times) {
			const xRaw = ts.timeToCoordinate(t as Time);
			const yARaw = this._series.priceToCoordinate(aMap.get(t)!);
			const yBRaw = this._series.priceToCoordinate(bMap.get(t)!);
			if (xRaw === null || yARaw === null || yBRaw === null) continue;
			pts.push({
				x:  this._px(xRaw  * hpr),
				yA: this._px(yARaw * vpr),
				yB: this._px(yBRaw * vpr),
			});
		}
		if (pts.length < 2) return;

		// Walk through segments, breaking at each A/B crossover to swap fill colour.
		let i = 0;
		while (i < pts.length - 1) {
			// Find the next crossover or end of data.
			let j = i + 1;
			const startBull = pts[i].yA <= pts[i].yB; // yA <= yB means A >= B in price (screen is inverted)
			while (j < pts.length - 1) {
				const bull = pts[j].yA <= pts[j].yB;
				if (bull !== startBull) break;
				j++;
			}

			// If j reached an actual crossover, interpolate the intersection.
			let extraPt: Pt | null = null;
			if (j < pts.length) {
				const p0 = pts[j - 1], p1 = pts[j];
				const dA = p1.yA - p0.yA, dB = p1.yB - p0.yB;
				const denom = dB - dA;
				if (Math.abs(denom) > 0.01) {
					const t2 = (p0.yA - p0.yB) / denom;
					const xi = p0.x + t2 * (p1.x - p0.x);
					const yI = p0.yA + t2 * dA;
					extraPt = { x: this._px(xi), yA: this._px(yI), yB: this._px(yI) };
				}
			}

			const seg = pts.slice(i, j + 1);
			if (extraPt) seg[seg.length - 1] = extraPt;

			ctx.beginPath();
			// Top edge: Span A forward
			ctx.moveTo(seg[0].x, seg[0].yA);
			for (let k = 1; k < seg.length; k++) ctx.lineTo(seg[k].x, seg[k].yA);
			// Bottom edge: Span B backward
			for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(seg[k].x, seg[k].yB);
			ctx.closePath();
			ctx.fillStyle = startBull ? FILL_BULL : FILL_BEAR;
			ctx.fill();

			i = j;
			if (extraPt) {
				// Restart from the crossover point.
				pts[i] = extraPt;
			}
		}
	}
}

class CloudPaneView implements IPrimitivePaneView {
	private _renderer: CloudRenderer;

	constructor(
		spanA: LineData<Time>[],
		spanB: LineData<Time>[],
		private _chart: IChartApi,
		private _series: ISeriesApi<SeriesType>,
	) {
		this._renderer = new CloudRenderer(spanA, spanB, _chart, _series);
	}

	update(spanA: LineData<Time>[], spanB: LineData<Time>[]): void {
		this._renderer = new CloudRenderer(spanA, spanB, this._chart, this._series);
	}

	renderer(): IPrimitivePaneRenderer {
		return this._renderer;
	}
}

class CloudPrimitive implements ISeriesPrimitive<Time> {
	private _view: CloudPaneView | null = null;
	private _chart: IChartApi | null = null;
	private _series: ISeriesApi<SeriesType> | null = null;
	private _spanA: LineData<Time>[] = [];
	private _spanB: LineData<Time>[] = [];
	private _requestUpdate?: () => void;

	attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
		this._chart  = param.chart;
		this._series = param.series;
		this._requestUpdate = param.requestUpdate;
		this._view = new CloudPaneView(this._spanA, this._spanB, this._chart, this._series);
	}

	detached(): void {
		this._view  = null;
		this._chart = null;
		this._series = null;
	}

	updateData(spanA: LineData<Time>[], spanB: LineData<Time>[]): void {
		this._spanA = spanA;
		this._spanB = spanB;
		this._view?.update(spanA, spanB);
		this._requestUpdate?.();
	}

	paneViews(): IPrimitivePaneView[] {
		return this._view ? [this._view] : [];
	}
}

// ── IchimokuTool ──────────────────────────────────────────────────────────────

export class IchimokuTool {
	private _tenkanSeries:  ISeriesApi<'Line'> | null = null;
	private _kijunSeries:   ISeriesApi<'Line'> | null = null;
	private _spanASeries:   ISeriesApi<'Line'> | null = null;
	private _spanBSeries:   ISeriesApi<'Line'> | null = null;
	private _chikouSeries:  ISeriesApi<'Line'> | null = null;
	private _cloudPrimitive: CloudPrimitive | null = null;

	constructor(private _chart: IChartApi) {}

	get isEnabled(): boolean {
		return this._tenkanSeries !== null;
	}

	enable(bars: OHLCBar[]): boolean {
		if (this._tenkanSeries) return true;

		this._tenkanSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_TENKAN, lineWidth: 1, title: 'Tenkan',
			priceLineVisible: false, lastValueVisible: false,
		}, 0);

		this._kijunSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_KIJUN, lineWidth: 1, title: 'Kijun',
			priceLineVisible: false, lastValueVisible: false,
		}, 0);

		this._spanASeries = this._chart.addSeries(LineSeries, {
			color: COLOR_SPAN_A, lineWidth: 1, title: 'Span A',
			priceLineVisible: false, lastValueVisible: false,
		}, 0);

		this._spanBSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_SPAN_B, lineWidth: 1, title: 'Span B',
			priceLineVisible: false, lastValueVisible: false,
		}, 0);

		this._chikouSeries = this._chart.addSeries(LineSeries, {
			color: COLOR_CHIKOU, lineWidth: 1, title: 'Chikou',
			priceLineVisible: false, lastValueVisible: false,
		}, 0);

		// Attach the cloud fill to Span A's series.
		this._cloudPrimitive = new CloudPrimitive();
		this._spanASeries.attachPrimitive(this._cloudPrimitive);

		this._setData(computeIchimoku(bars));
		return true;
	}

	disable(): boolean {
		if (!this._tenkanSeries) return false;
		if (this._cloudPrimitive) {
			this._spanASeries!.detachPrimitive(this._cloudPrimitive);
			this._cloudPrimitive = null;
		}
		this._chart.removeSeries(this._tenkanSeries);
		this._chart.removeSeries(this._kijunSeries!);
		this._chart.removeSeries(this._spanASeries!);
		this._chart.removeSeries(this._spanBSeries!);
		this._chart.removeSeries(this._chikouSeries!);
		this._tenkanSeries = null;
		this._kijunSeries  = null;
		this._spanASeries  = null;
		this._spanBSeries  = null;
		this._chikouSeries = null;
		return false;
	}

	toggle(bars: OHLCBar[]): boolean {
		return this._tenkanSeries ? this.disable() : this.enable(bars);
	}

	appendBar(bars: OHLCBar[]): void {
		if (!this._tenkanSeries) return;
		this._setData(computeIchimoku(bars));
	}

	remove(): void {
		if (this._tenkanSeries) this.disable();
	}

	private _setData(d: IchimokuData): void {
		this._tenkanSeries!.setData(d.tenkan);
		this._kijunSeries!.setData(d.kijun);
		this._spanASeries!.setData(d.spanA);
		this._spanBSeries!.setData(d.spanB);
		this._chikouSeries!.setData(d.chikou);
		this._cloudPrimitive?.updateData(d.spanA, d.spanB);
	}
}
