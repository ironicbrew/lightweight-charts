import type {
	BitmapCoordinatesRenderingScope,
	CanvasRenderingTarget2D,
} from "fancy-canvas";
import {
	type Coordinate,
	type IChartApi,
	type ISeriesApi,
	type ISeriesPrimitive,
	type IPrimitivePaneRenderer,
	type IPrimitivePaneView,
	type ITimeScaleApi,
	type MouseEventParams,
	type SeriesAttachedParameter,
	type SeriesType,
	type Time,
	Logical,
} from "lightweight-charts";

interface Point {
	logical: number; // snapped whole-bar index; extrapolates past the data edge
	price: number;
}

interface ViewPoint {
	x: Coordinate | null;
	y: Coordinate | null;
}

// Pixel-space midpoint of two view points (null if either is off-scale).
function midpoint(a: ViewPoint, b: ViewPoint): ViewPoint {
	if (a.x === null || a.y === null || b.x === null || b.y === null) {
		return { x: null, y: null };
	}
	return {
		x: ((a.x + b.x) / 2) as Coordinate,
		y: ((a.y + b.y) / 2) as Coordinate,
	};
}

// Which endpoint: 0 = none, 1 = p1, 2 = p2.
type Endpoint = 0 | 1 | 2;

export type LineKind =
	| "segment"
	| "ray"
	| "extended"
	| "horizontal"
	| "horizontal-ray"
	| "vertical"
	| "cross"
	| "channel"
	| "pitchfork";

export interface TrendLineOptions {
	lineColor: string;
	previewColor: string;
	fillColor: string;
	width: number;
	handleRadius: number; // CSS px
	kind: LineKind;
}

const defaultOptions: TrendLineOptions = {
	lineColor: "#2962FF",
	previewColor: "rgba(41, 98, 255, 0.5)",
	fillColor: "rgba(41, 98, 255, 0.1)",
	width: 2,
	handleRadius: 5,
	kind: "segment",
};

// CSS px — how close the pointer must be to grab draggable element
const HIT_RADIUS = 9;
const BODY_HIT_RADIUS = 6;

// Given the ray p1→p2, return the point where it exits the [0,w]×[0,h] canvas
// rect (in the direction beyond p2). Used to draw a ray as if it reaches
// infinity. Returns p2 unchanged if p1 and p2 coincide.
function extendToEdge(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	w: number,
	h: number,
): [number, number] {
	const dx = x2 - x1;
	const dy = y2 - y1;
	if (dx === 0 && dy === 0) return [x2, y2];

	// Largest t >= 0 such that (x1 + t*dx, y1 + t*dy) stays within the rect.
	// t = 1 is exactly p2, so the clip edge is always at t >= 1.
	let t = Infinity;
	if (dx > 0) t = Math.min(t, (w - x1) / dx);
	else if (dx < 0) t = Math.min(t, (0 - x1) / dx);
	if (dy > 0) t = Math.min(t, (h - y1) / dy);
	else if (dy < 0) t = Math.min(t, (0 - y1) / dy);

	return [x1 + t * dx, y1 + t * dy];
}

// ── Interaction plumbing ──────────────────────────────────────────────────────
// A Dragger is created on pointerdown by a primitive's hitTest and is fed the
// pointer position on every pointermove. Each primitive owns its own draggers,
// so the controller stays generic (no per-kind branching).
interface Dragger {
	move(x: number, y: number): void;
}

// Tracks incremental whole-bar movement while preserving the sub-bar remainder,
// so horizontal dragging snaps to bars AND tracks the cursor 1:1.
class BarTracker {
	private _lastX: number;
	constructor(
		private _ts: ITimeScaleApi<Time>,
		startX: number,
	) {
		this._lastX = startX;
	}

	// Whole bars crossed since the last consumed step; advances the reference by
	// exactly those bars (keeping the fractional remainder for next time).
	step(x: number): number {
		const cur = this._ts.coordinateToLogical(x);
		const last = this._ts.coordinateToLogical(this._lastX);
		const bars = cur !== null && last !== null ? Math.round(cur - last) : 0;
		if (bars !== 0 && last !== null) {
			const adv = this._ts.logicalToCoordinate((last + bars) as Logical);
			if (adv !== null) this._lastX = adv;
		}
		return bars;
	}
}

// Dragger that sets a single anchor to the snapped cursor position.
function snapDragger(prim: DrawingPrimitive, apply: (p: Point) => void): Dragger {
	return {
		move: (x, y) => {
			const l = prim.chart.timeScale().coordinateToLogical(x);
			const price = prim.series.coordinateToPrice(y);
			if (l !== null && price !== null) apply({ logical: Math.round(l), price });
		},
	};
}

// Dragger that translates a single anchor: whole bars in x, continuous price in
// y. Used by the cross and horizontal-ray bodies.
function anchorTranslateDragger(
	prim: DrawingPrimitive,
	read: () => Point,
	write: (p: Point) => void,
	startX: number,
	startY: number,
): Dragger {
	const tracker = new BarTracker(prim.chart.timeScale(), startX);
	let lastY = startY;
	return {
		move: (x, y) => {
			const anchor = read();
			const c = prim.coordOf(anchor);
			if (c.x === null || c.y === null) return;
			const dyp = y - lastY;
			lastY = y;
			const bars = tracker.step(x);
			const next = { ...anchor };
			const np = prim.series.coordinateToPrice((c.y as number) + dyp);
			if (np !== null) next.price = np;
			if (bars !== 0) next.logical = anchor.logical + bars;
			write(next);
		},
	};
}

// Interface for pane views that recompute pixel geometry each frame.
interface UpdatablePaneView extends IPrimitivePaneView {
	update(): void;
}

// ── Base primitive: lifecycle + coordinate helpers shared by every drawing ────
abstract class DrawingPrimitive implements ISeriesPrimitive<Time> {
	public chart!: IChartApi;
	public series!: ISeriesApi<SeriesType>;
	public _options: TrendLineOptions;
	protected _views: UpdatablePaneView[] = [];
	private _requestUpdateFn?: () => void;

	constructor(options: Partial<TrendLineOptions> = {}) {
		this._options = { ...defaultOptions, ...options };
	}

	attached(param: SeriesAttachedParameter<Time, SeriesType>) {
		this.chart = param.chart;
		this.series = param.series;
		this._requestUpdateFn = param.requestUpdate;
		this._requestUpdateFn?.();
	}

	detached() {
		this._requestUpdateFn = undefined;
	}

	requestUpdate() {
		this._requestUpdateFn?.();
	}

	updateAllViews() {
		this._views.forEach((v) => v.update());
	}

	paneViews() {
		return this._views;
	}

	// Logical + price → pane-local pixels.
	coordOf(p: Point): ViewPoint {
		return {
			x: this.chart.timeScale().logicalToCoordinate(p.logical as Logical),
			y: this.series.priceToCoordinate(p.price),
		};
	}

	// Interaction contract implemented by each shape.
	abstract beginDrag(x: number, y: number): Dragger | null;
	abstract updateHover(x: number, y: number): boolean;
}

// ── Trend line (segment / ray / extended): two anchored endpoints ─────────────
class TrendLinePaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _p1: ViewPoint,
		private _p2: ViewPoint,
		private _color: string,
		private _width: number,
		private _handleRadius: number,
		private _hovered: Endpoint,
		private _showHandles: boolean,
		private _showEndHandle: boolean,
		private _kind: LineKind,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				if (
					this._p1.x === null ||
					this._p1.y === null ||
					this._p2.x === null ||
					this._p2.y === null
				) {
					return;
				}
				const ctx = scope.context;
				const hr = scope.horizontalPixelRatio;
				const vr = scope.verticalPixelRatio;

				const x1 = this._p1.x * hr;
				const y1 = this._p1.y * vr;
				const x2 = this._p2.x * hr;
				const y2 = this._p2.y * vr;

				const w = scope.bitmapSize.width;
				const h = scope.bitmapSize.height;

				// Compute the two drawn ends based on kind:
				//   segment  → p1 ........ p2   (stops at both)
				//   ray      → p1 ........ p2 →→ edge   (past p2 only)
				//   extended → edge ←← p1 .. p2 →→ edge (past both ends)
				let sx = x1;
				let sy = y1;
				let ex = x2;
				let ey = y2;

				if (this._kind === "ray" || this._kind === "extended") {
					[ex, ey] = extendToEdge(x1, y1, x2, y2, w, h);
				}
				if (this._kind === "extended") {
					[sx, sy] = extendToEdge(x2, y2, x1, y1, w, h);
				}

				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(sx, sy);
				ctx.lineTo(ex, ey);
				ctx.stroke();

				if (!this._showHandles) return;

				this._drawHandle(ctx, x1, y1, hr, this._hovered === 1);
				if (this._showEndHandle) {
					this._drawHandle(ctx, x2, y2, hr, this._hovered === 2);
				}
			},
		);
	}

	private _drawHandle(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		ratio: number,
		hovered: boolean,
	) {
		const r = (hovered ? this._handleRadius + 2 : this._handleRadius) * ratio;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, 2 * Math.PI);
		ctx.fillStyle = "#111317";
		ctx.fill();
		ctx.lineWidth = 2 * ratio;
		ctx.strokeStyle = this._color;
		ctx.stroke();
	}
}

class TrendLinePaneView implements UpdatablePaneView {
	private _p1: ViewPoint = { x: null, y: null };
	private _p2: ViewPoint = { x: null, y: null };

	constructor(private _source: TrendLine) {}

	update() {
		this._p1 = this._source.endpointCoord(1);
		this._p2 = this._source.endpointCoord(2);
	}

	renderer() {
		return new TrendLinePaneRenderer(
			this._p1,
			this._p2,
			this._source._options.lineColor,
			this._source._options.width,
			this._source._options.handleRadius,
			this._source.hoveredHandle,
			this._source.showHandles,
			this._source.showEndHandle,
			this._source._options.kind,
		);
	}
}

export class TrendLine extends DrawingPrimitive {
	public hoveredHandle: Endpoint = 0;
	public showHandles = true;
	public showEndHandle = true;

	constructor(
		public _p1: Point,
		public _p2: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new TrendLinePaneView(this)];
	}

	endpointCoord(which: 1 | 2): ViewPoint {
		return this.coordOf(which === 1 ? this._p1 : this._p2);
	}

	hitTestHandle(x: number, y: number): Endpoint {
		for (const which of [1, 2] as const) {
			const c = this.endpointCoord(which);
			if (c.x === null || c.y === null) continue;
			if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS) return which;
		}
		return 0;
	}

	hitTestBody(x: number, y: number): boolean {
		const a = this.endpointCoord(1);
		const b = this.endpointCoord(2);
		if (a.x === null || a.y === null || b.x === null || b.y === null) return false;

		const dx = b.x - a.x,
			dy = b.y - a.y;
		const lenSq = dx * dx + dy * dy;
		// Clamp t to the drawn range: segment [0,1], ray [0,∞), extended (-∞,∞).
		let t = lenSq === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
		if (this._options.kind !== "extended") t = Math.max(0, t);
		if (this._options.kind === "segment") t = Math.min(1, t);
		const cx = a.x + t * dx,
			cy = a.y + t * dy;
		return Math.hypot(x - cx, y - cy) <= BODY_HIT_RADIUS;
	}

	setEndpoint(which: Endpoint, p: Point) {
		if (which === 1) this._p1 = p;
		else if (which === 2) this._p2 = p;
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		const which = this.hitTestHandle(x, y);
		if (which !== 0) {
			return snapDragger(this, (p) => this.setEndpoint(which, p));
		}
		if (this.hitTestBody(x, y)) {
			// Translate both endpoints together: whole bars in x, continuous y.
			const tracker = new BarTracker(this.chart.timeScale(), x);
			let lastY = y;
			return {
				move: (mx, my) => {
					const dyp = my - lastY;
					lastY = my;
					const bars = tracker.step(mx);
					for (const w of [1, 2] as const) {
						const c = this.endpointCoord(w);
						if (c.x === null || c.y === null) continue;
						const cur = w === 1 ? this._p1 : this._p2;
						const next = { ...cur };
						const np = this.series.coordinateToPrice((c.y as number) + dyp);
						if (np !== null) next.price = np;
						if (bars !== 0) next.logical = cur.logical + bars;
						this.setEndpoint(w, next);
					}
				},
			};
		}
		return null;
	}

	updateHover(x: number, y: number): boolean {
		const which = this.hitTestHandle(x, y);
		if (which !== this.hoveredHandle) {
			this.hoveredHandle = which;
			this.requestUpdate();
		}
		return which !== 0 || this.hitTestBody(x, y);
	}
}

// Preview line whose second endpoint tracks the cursor while drawing.
class PreviewTrendLine extends TrendLine {
	constructor(p1: Point, p2: Point, options: Partial<TrendLineOptions> = {}) {
		super(p1, p2, options);
		this._options.lineColor = this._options.previewColor;
		// Show the anchored first dot, but not one chasing the cursor.
		this.showEndHandle = false;
	}

	updateEndPoint(p: Point) {
		this._p2 = p;
		this.updateAllViews();
		this.requestUpdate();
	}
}

// ── Horizontal line: single price anchor, infinite width, no endpoints ────────
class HorizontalLinePaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _y: Coordinate | null,
		private _color: string,
		private _width: number,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				if (this._y === null) return;
				const ctx = scope.context;
				const y = this._y * scope.verticalPixelRatio;
				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(scope.bitmapSize.width, y);
				ctx.stroke();
			},
		);
	}
}

class HorizontalLinePaneView implements UpdatablePaneView {
	private _y: Coordinate | null = null;

	constructor(private _source: HorizontalLine) {}

	update() {
		this._y = this._source.series.priceToCoordinate(this._source.price);
	}

	renderer() {
		return new HorizontalLinePaneRenderer(
			this._y,
			this._source._options.lineColor,
			this._source._options.width,
		);
	}
}

export class HorizontalLine extends DrawingPrimitive {
	constructor(
		public price: number,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new HorizontalLinePaneView(this)];
	}

	hitTestBody(_x: number, y: number): boolean {
		const cy = this.series.priceToCoordinate(this.price);
		if (cy === null) return false;
		return Math.abs(cy - y) <= BODY_HIT_RADIUS;
	}

	setPrice(price: number) {
		this.price = price;
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		if (!this.hitTestBody(x, y)) return null;
		// Flat line: only the price (y) changes.
		return {
			move: (_mx, my) => {
				const price = this.series.coordinateToPrice(my);
				if (price !== null) this.setPrice(price);
			},
		};
	}

	updateHover(x: number, y: number): boolean {
		return this.hitTestBody(x, y);
	}
}

// ── Vertical line: single logical anchor, infinite height, no endpoints ───────
class VerticalLinePaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _x: Coordinate | null,
		private _color: string,
		private _width: number,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				if (this._x === null) return;
				const ctx = scope.context;
				const x = this._x * scope.horizontalPixelRatio;
				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, scope.bitmapSize.height);
				ctx.stroke();
			},
		);
	}
}

class VerticalLinePaneView implements UpdatablePaneView {
	private _x: Coordinate | null = null;

	constructor(private _source: VerticalLine) {}

	update() {
		this._x = this._source.chart
			.timeScale()
			.logicalToCoordinate(this._source.logical as Logical);
	}

	renderer() {
		return new VerticalLinePaneRenderer(
			this._x,
			this._source._options.lineColor,
			this._source._options.width,
		);
	}
}

export class VerticalLine extends DrawingPrimitive {
	constructor(
		public logical: number,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new VerticalLinePaneView(this)];
	}

	hitTestBody(x: number, _y: number): boolean {
		const cx = this.chart.timeScale().logicalToCoordinate(this.logical as Logical);
		if (cx === null) return false;
		return Math.abs(cx - x) <= BODY_HIT_RADIUS;
	}

	setLogical(logical: number) {
		this.logical = logical;
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		if (!this.hitTestBody(x, y)) return null;
		// Only the logical (x) changes, snapped to bars.
		const tracker = new BarTracker(this.chart.timeScale(), x);
		return {
			move: (mx) => {
				const bars = tracker.step(mx);
				if (bars !== 0) this.setLogical(this.logical + bars);
			},
		};
	}

	updateHover(x: number, y: number): boolean {
		return this.hitTestBody(x, y);
	}
}

// ── Cross line: single anchor drawing both a horizontal and vertical line ─────
class CrossLinePaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _c: ViewPoint,
		private _color: string,
		private _width: number,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				if (this._c.x === null || this._c.y === null) return;
				const ctx = scope.context;
				const x = this._c.x * scope.horizontalPixelRatio;
				const y = this._c.y * scope.verticalPixelRatio;
				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(scope.bitmapSize.width, y);
				ctx.moveTo(x, 0);
				ctx.lineTo(x, scope.bitmapSize.height);
				ctx.stroke();
			},
		);
	}
}

class CrossLinePaneView implements UpdatablePaneView {
	private _c: ViewPoint = { x: null, y: null };

	constructor(private _source: CrossLine) {}

	update() {
		this._c = this._source.coordOf(this._source._anchor);
	}

	renderer() {
		return new CrossLinePaneRenderer(
			this._c,
			this._source._options.lineColor,
			this._source._options.width,
		);
	}
}

export class CrossLine extends DrawingPrimitive {
	constructor(
		public _anchor: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new CrossLinePaneView(this)];
	}

	// Over either arm: near the vertical line (x) OR the horizontal line (y).
	hitTestBody(x: number, y: number): boolean {
		const c = this.coordOf(this._anchor);
		if (c.x === null || c.y === null) return false;
		return Math.abs(c.x - x) <= BODY_HIT_RADIUS || Math.abs(c.y - y) <= BODY_HIT_RADIUS;
	}

	setAnchor(p: Point) {
		this._anchor = p;
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		if (!this.hitTestBody(x, y)) return null;
		return anchorTranslateDragger(
			this,
			() => this._anchor,
			(p) => this.setAnchor(p),
			x,
			y,
		);
	}

	updateHover(x: number, y: number): boolean {
		return this.hitTestBody(x, y);
	}
}

// ── Horizontal ray: one anchored endpoint (dot), flat line to the right ───────
class HorizontalRayPaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _anchor: ViewPoint,
		private _color: string,
		private _width: number,
		private _handleRadius: number,
		private _hovered: boolean,
		private _showHandle: boolean,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				if (this._anchor.x === null || this._anchor.y === null) return;
				const ctx = scope.context;
				const x = this._anchor.x * scope.horizontalPixelRatio;
				const y = this._anchor.y * scope.verticalPixelRatio;

				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(x, y);
				ctx.lineTo(scope.bitmapSize.width, y);
				ctx.stroke();

				if (!this._showHandle) return;
				const r =
					(this._hovered ? this._handleRadius + 2 : this._handleRadius) *
					scope.horizontalPixelRatio;
				ctx.beginPath();
				ctx.arc(x, y, r, 0, 2 * Math.PI);
				ctx.fillStyle = "#111317";
				ctx.fill();
				ctx.lineWidth = 2 * scope.horizontalPixelRatio;
				ctx.strokeStyle = this._color;
				ctx.stroke();
			},
		);
	}
}

class HorizontalRayPaneView implements UpdatablePaneView {
	private _anchor: ViewPoint = { x: null, y: null };

	constructor(private _source: HorizontalRay) {}

	update() {
		this._anchor = this._source.coordOf(this._source._anchor);
	}

	renderer() {
		return new HorizontalRayPaneRenderer(
			this._anchor,
			this._source._options.lineColor,
			this._source._options.width,
			this._source._options.handleRadius,
			this._source.hovered,
			this._source.showHandle,
		);
	}
}

export class HorizontalRay extends DrawingPrimitive {
	public hovered = false;
	public showHandle = true;

	constructor(
		public _anchor: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new HorizontalRayPaneView(this)];
	}

	hitTestHandle(x: number, y: number): boolean {
		const c = this.coordOf(this._anchor);
		if (c.x === null || c.y === null) return false;
		return Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS;
	}

	// The flat body: at the right height AND at or right of the anchor.
	hitTestBody(x: number, y: number): boolean {
		const c = this.coordOf(this._anchor);
		if (c.x === null || c.y === null) return false;
		return Math.abs(c.y - y) <= BODY_HIT_RADIUS && x >= c.x - BODY_HIT_RADIUS;
	}

	setAnchor(p: Point) {
		this._anchor = p;
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		if (this.hitTestHandle(x, y)) {
			// Drag the dot: snapped logical + price, line stays flat.
			return snapDragger(this, (p) => this.setAnchor(p));
		}
		if (this.hitTestBody(x, y)) {
			return anchorTranslateDragger(
				this,
				() => this._anchor,
				(p) => this.setAnchor(p),
				x,
				y,
			);
		}
		return null;
	}

	updateHover(x: number, y: number): boolean {
		const on = this.hitTestHandle(x, y);
		if (on !== this.hovered) {
			this.hovered = on;
			this.requestUpdate();
		}
		return on || this.hitTestBody(x, y);
	}
}

// ── Parallel channel: base line (p1→p2) + a constant price offset ─────────────
// Model: two base endpoints + a scalar `offset` (price gap). The parallel line
// is the base shifted by `offset`, so it's ALWAYS parallel and the gap is
// constant unless the offset itself is changed (by a square resize handle).
//
// Four endpoints:  1 = p1, 2 = p2 (base);  3 = p1+offset, 4 = p2+offset.
type ChannelHandle = 0 | 1 | 2 | 3 | 4;
type ChannelPart = "base" | "parallel" | "fill" | null;

class ParallelChannelPaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _a1: ViewPoint,
		private _a2: ViewPoint,
		private _b1: ViewPoint,
		private _b2: ViewPoint,
		private _m1: ViewPoint,
		private _m2: ViewPoint,
		private _baseMid: ViewPoint,
		private _parallelMid: ViewPoint,
		private _color: string,
		private _fillColor: string,
		private _width: number,
		private _handleRadius: number,
		private _hovered: ChannelHandle,
		private _hoveredMid: "base" | "parallel" | null,
		private _showHandles: boolean,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace(
			(scope: BitmapCoordinatesRenderingScope) => {
				const a1 = this._a1, a2 = this._a2, b1 = this._b1, b2 = this._b2;
				const m1 = this._m1, m2 = this._m2;
				if (
					a1.x === null || a1.y === null || a2.x === null || a2.y === null ||
					b1.x === null || b1.y === null || b2.x === null || b2.y === null
				) {
					return;
				}
				const ctx = scope.context;
				const hr = scope.horizontalPixelRatio;
				const vr = scope.verticalPixelRatio;
				const px = (p: ViewPoint) => (p.x as number) * hr;
				const py = (p: ViewPoint) => (p.y as number) * vr;

				// Filled band between the two parallel lines.
				ctx.fillStyle = this._fillColor;
				ctx.beginPath();
				ctx.moveTo(px(a1), py(a1));
				ctx.lineTo(px(a2), py(a2));
				ctx.lineTo(px(b2), py(b2));
				ctx.lineTo(px(b1), py(b1));
				ctx.closePath();
				ctx.fill();

				// The two solid parallel lines.
				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(px(a1), py(a1));
				ctx.lineTo(px(a2), py(a2));
				ctx.moveTo(px(b1), py(b1));
				ctx.lineTo(px(b2), py(b2));
				ctx.stroke();

				// Dotted midline (visual only, not interactive).
				if (m1.x !== null && m1.y !== null && m2.x !== null && m2.y !== null) {
					ctx.save();
					ctx.setLineDash([4 * hr, 4 * hr]);
					ctx.lineWidth = Math.max(1, this._width - 1);
					ctx.beginPath();
					ctx.moveTo(px(m1), py(m1));
					ctx.lineTo(px(m2), py(m2));
					ctx.stroke();
					ctx.restore();
				}

				if (!this._showHandles) return;
				// Round endpoint handles.
				this._handle(ctx, px(a1), py(a1), hr, this._hovered === 1);
				this._handle(ctx, px(a2), py(a2), hr, this._hovered === 2);
				this._handle(ctx, px(b1), py(b1), hr, this._hovered === 3);
				this._handle(ctx, px(b2), py(b2), hr, this._hovered === 4);

				// Square resize handles at each line's midpoint (vertical resize).
				const bm = this._baseMid, pm = this._parallelMid;
				if (bm.x !== null && bm.y !== null) {
					this._square(ctx, px(bm), py(bm), hr, this._hoveredMid === "base");
				}
				if (pm.x !== null && pm.y !== null) {
					this._square(ctx, px(pm), py(pm), hr, this._hoveredMid === "parallel");
				}
			},
		);
	}

	private _square(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		ratio: number,
		hovered: boolean,
	) {
		const s = (hovered ? this._handleRadius + 2 : this._handleRadius) * ratio;
		const r = 2 * ratio;
		ctx.beginPath();
		ctx.roundRect(x - s, y - s, s * 2, s * 2, r);
		ctx.fillStyle = "#111317";
		ctx.fill();
		ctx.lineWidth = 2 * ratio;
		ctx.strokeStyle = this._color;
		ctx.stroke();
	}

	private _handle(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		ratio: number,
		hovered: boolean,
	) {
		const r = (hovered ? this._handleRadius + 2 : this._handleRadius) * ratio;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, 2 * Math.PI);
		ctx.fillStyle = "#111317";
		ctx.fill();
		ctx.lineWidth = 2 * ratio;
		ctx.strokeStyle = this._color;
		ctx.stroke();
	}
}

class ParallelChannelPaneView implements UpdatablePaneView {
	private _a1: ViewPoint = { x: null, y: null };
	private _a2: ViewPoint = { x: null, y: null };
	private _b1: ViewPoint = { x: null, y: null };
	private _b2: ViewPoint = { x: null, y: null };
	private _m1: ViewPoint = { x: null, y: null };
	private _m2: ViewPoint = { x: null, y: null };
	private _baseMid: ViewPoint = { x: null, y: null };
	private _parallelMid: ViewPoint = { x: null, y: null };

	constructor(private _source: ParallelChannel) {}

	update() {
		const s = this._source;
		const [e1, e2, e3, e4] = s.endpoints();
		this._a1 = s.coordOf(e1);
		this._a2 = s.coordOf(e2);
		this._b1 = s.coordOf(e3);
		this._b2 = s.coordOf(e4);
		const half = s.offset / 2;
		this._m1 = s.coordOf({ logical: s._p1.logical, price: s._p1.price + half });
		this._m2 = s.coordOf({ logical: s._p2.logical, price: s._p2.price + half });
		// Midpoint handles are averaged in PIXEL space (see midpoint()) because a
		// fractional logical (odd-length line) has no coordinate.
		this._baseMid = midpoint(this._a1, this._a2);
		this._parallelMid = midpoint(this._b1, this._b2);
	}

	renderer() {
		return new ParallelChannelPaneRenderer(
			this._a1,
			this._a2,
			this._b1,
			this._b2,
			this._m1,
			this._m2,
			this._baseMid,
			this._parallelMid,
			this._source._options.lineColor,
			this._source._options.fillColor,
			this._source._options.width,
			this._source._options.handleRadius,
			this._source.hoveredHandle,
			this._source.hoveredMid,
			this._source.showHandles,
		);
	}
}

export class ParallelChannel extends DrawingPrimitive {
	public hoveredHandle: ChannelHandle = 0;
	public hoveredMid: "base" | "parallel" | null = null;
	public showHandles = true;

	constructor(
		public _p1: Point,
		public _p2: Point,
		public offset: number,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new ParallelChannelPaneView(this)];
	}

	// The four endpoints, in handle order (1,2 base; 3,4 parallel).
	endpoints(): [Point, Point, Point, Point] {
		return [
			this._p1,
			this._p2,
			{ logical: this._p1.logical, price: this._p1.price + this.offset },
			{ logical: this._p2.logical, price: this._p2.price + this.offset },
		];
	}

	hitTestHandle(x: number, y: number): ChannelHandle {
		const eps = this.endpoints();
		for (let i = 0; i < 4; i++) {
			const c = this.coordOf(eps[i]);
			if (c.x === null || c.y === null) continue;
			if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS) return (i + 1) as ChannelHandle;
		}
		return 0;
	}

	// Which square midpoint handle (if any). Pixel-space midpoints (see above).
	hitTestMid(x: number, y: number): "base" | "parallel" | null {
		const [e1, e2, e3, e4] = this.endpoints();
		const checks: ["base" | "parallel", ViewPoint][] = [
			["base", midpoint(this.coordOf(e1), this.coordOf(e2))],
			["parallel", midpoint(this.coordOf(e3), this.coordOf(e4))],
		];
		for (const [part, c] of checks) {
			if (c.x === null || c.y === null) continue;
			if (Math.abs(c.x - x) <= HIT_RADIUS && Math.abs(c.y - y) <= HIT_RADIUS) {
				return part;
			}
		}
		return null;
	}

	// Which part of the body the pointer is over: a stroke line, the fill, or none.
	hitPart(x: number, y: number): ChannelPart {
		const [e1, e2, e3, e4] = this.endpoints();
		const a1 = this.coordOf(e1), a2 = this.coordOf(e2);
		const b1 = this.coordOf(e3), b2 = this.coordOf(e4);
		if (this._nearSegment(x, y, a1, a2)) return "base";
		if (this._nearSegment(x, y, b1, b2)) return "parallel";
		if (this._inQuad(x, y, a1, a2, b2, b1)) return "fill";
		return null;
	}

	hitTestBody(x: number, y: number): boolean {
		return this.hitPart(x, y) !== null;
	}

	private _nearSegment(x: number, y: number, a: ViewPoint, b: ViewPoint): boolean {
		if (a.x === null || a.y === null || b.x === null || b.y === null) return false;
		const dx = b.x - a.x, dy = b.y - a.y;
		const lenSq = dx * dx + dy * dy;
		let t = lenSq === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
		t = Math.max(0, Math.min(1, t));
		const cx = a.x + t * dx, cy = a.y + t * dy;
		return Math.hypot(x - cx, y - cy) <= BODY_HIT_RADIUS;
	}

	// Even-odd point-in-polygon for the band quad (order: a1,a2,b2,b1).
	private _inQuad(x: number, y: number, ...quad: ViewPoint[]): boolean {
		if (quad.some((p) => p.x === null || p.y === null)) return false;
		let inside = false;
		for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
			const xi = quad[i].x as number, yi = quad[i].y as number;
			const xj = quad[j].x as number, yj = quad[j].y as number;
			const intersect =
				yi > y !== yj > y &&
				x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
			if (intersect) inside = !inside;
		}
		return inside;
	}

	// Drag an endpoint. 1/2 move the base end directly; 3/4 move the base end so
	// the PARALLEL endpoint lands at p (keeping the offset → constant gap).
	setHandle(which: ChannelHandle, p: Point) {
		if (which === 1) this._p1 = p;
		else if (which === 2) this._p2 = p;
		else if (which === 3) this._p1 = { logical: p.logical, price: p.price - this.offset };
		else if (which === 4) this._p2 = { logical: p.logical, price: p.price - this.offset };
		this.updateAllViews();
		this.requestUpdate();
	}

	// Resize the gap by a price delta (vertical-only, so no horizontal jump).
	resizeBy(part: "base" | "parallel", dPrice: number) {
		if (part === "parallel") {
			this.offset += dPrice;
		} else {
			this._p1 = { ...this._p1, price: this._p1.price + dPrice };
			this._p2 = { ...this._p2, price: this._p2.price + dPrice };
			this.offset -= dPrice;
		}
		this.updateAllViews();
		this.requestUpdate();
	}

	// Set the offset so the parallel line passes through `price` at `logical`.
	// Used only while drawing (the preview's parallel side tracks the cursor).
	setOffsetFromPoint(logical: number, price: number) {
		const dl = this._p2.logical - this._p1.logical;
		const baseAt =
			dl === 0
				? this._p1.price
				: this._p1.price +
				  ((logical - this._p1.logical) / dl) * (this._p2.price - this._p1.price);
		this.offset = price - baseAt;
		this.updateAllViews();
		this.requestUpdate();
	}

	// Move the whole channel (offset unchanged → gap unchanged).
	translate(bars: number, dPrice: number) {
		for (const p of [this._p1, this._p2]) {
			p.logical += bars;
			p.price += dPrice;
		}
		this.updateAllViews();
		this.requestUpdate();
	}

	beginDrag(x: number, y: number): Dragger | null {
		const which = this.hitTestHandle(x, y);
		if (which !== 0) {
			return snapDragger(this, (p) => this.setHandle(which, p));
		}
		const mid = this.hitTestMid(x, y);
		if (mid !== null) {
			// Square handle → vertical-only resize (pixel delta → price delta).
			let lastY = y;
			return {
				move: (_mx, my) => {
					const cLast = this.series.coordinateToPrice(lastY);
					const cNow = this.series.coordinateToPrice(my);
					if (cLast !== null && cNow !== null) {
						this.resizeBy(mid, cNow - cLast);
						lastY = my;
					}
				},
			};
		}
		if (this.hitTestBody(x, y)) {
			// Any line or the fill → move the whole channel.
			const tracker = new BarTracker(this.chart.timeScale(), x);
			let lastY = y;
			return {
				move: (mx, my) => {
					const c = this.coordOf(this._p1);
					if (c.x === null || c.y === null) return;
					const dyp = my - lastY;
					lastY = my;
					const bars = tracker.step(mx);
					const np = this.series.coordinateToPrice((c.y as number) + dyp);
					const dPrice = np !== null ? np - this._p1.price : 0;
					if (bars !== 0 || dPrice !== 0) this.translate(bars, dPrice);
				},
			};
		}
		return null;
	}

	updateHover(x: number, y: number): boolean {
		const which = this.hitTestHandle(x, y);
		const mid = this.hitTestMid(x, y);
		if (which !== this.hoveredHandle || mid !== this.hoveredMid) {
			this.hoveredHandle = which;
			this.hoveredMid = mid;
			this.requestUpdate();
		}
		return which !== 0 || mid !== null || this.hitTestBody(x, y);
	}
}

// Preview channel: while picking the offset, the parallel line tracks the cursor.
class PreviewParallelChannel extends ParallelChannel {
	constructor(p1: Point, p2: Point, offset: number, options: Partial<TrendLineOptions> = {}) {
		super(p1, p2, offset, options);
		this._options.lineColor = this._options.previewColor;
	}
}

// ── Pitchfork (Andrews' Pitchfork): pivot p1, tine anchors p2 & p3 ─────────────
// Median line: from p1 through midpoint(p2,p3), extending as a ray.
// Upper tine: through p2, parallel to the median, extending as a ray.
// Lower tine: through p3, parallel to the median, extending as a ray.
// Three endpoint handles (one per anchor) + body hit-test over any tine.
type PitchforkHandle = 0 | 1 | 2 | 3;

class PitchforkPaneRenderer implements IPrimitivePaneRenderer {
	constructor(
		private _p1: ViewPoint,
		private _p2: ViewPoint,
		private _p3: ViewPoint,
		private _mid: ViewPoint,
		private _color: string,
		private _width: number,
		private _handleRadius: number,
		private _hovered: PitchforkHandle,
		private _showHandles: boolean,
	) {}

	draw(target: CanvasRenderingTarget2D) {
		target.useBitmapCoordinateSpace((scope: BitmapCoordinatesRenderingScope) => {
			const { _p1: p1, _p2: p2, _p3: p3, _mid: mid } = this;
			if (
				p1.x === null || p1.y === null ||
				p2.x === null || p2.y === null ||
				p3.x === null || p3.y === null ||
				mid.x === null || mid.y === null
			) return;

			const ctx = scope.context;
			const hr = scope.horizontalPixelRatio;
			const vr = scope.verticalPixelRatio;
			const w = scope.bitmapSize.width;
			const h = scope.bitmapSize.height;

			const sx = (v: ViewPoint) => (v.x as number) * hr;
			const sy = (v: ViewPoint) => (v.y as number) * vr;

			// Direction vector of the median (p1 → midpoint(p2,p3))
			const dx = sx(mid) - sx(p1);
			const dy = sy(mid) - sy(p1);

			// Extend each tine from its anchor in the median direction to canvas edge.
			const [ex2, ey2] = extendToEdge(sx(p2), sy(p2), sx(p2) + dx, sy(p2) + dy, w, h);
			const [ex3, ey3] = extendToEdge(sx(p3), sy(p3), sx(p3) + dx, sy(p3) + dy, w, h);
			const [exm, eym] = extendToEdge(sx(p1), sy(p1), sx(mid), sy(mid), w, h);

			ctx.lineWidth = this._width;
			ctx.strokeStyle = this._color;

			// Handle shaft: p1 to midpoint(p2,p3).
			ctx.beginPath();
			ctx.moveTo(sx(p1), sy(p1));
			ctx.lineTo(sx(mid), sy(mid));
			ctx.stroke();

			// Median ray: from midpoint onward.
			ctx.setLineDash([]);
			ctx.beginPath();
			ctx.moveTo(sx(mid), sy(mid));
			ctx.lineTo(exm, eym);
			ctx.stroke();

			// Upper & lower tines from anchors outward.
			ctx.beginPath();
			ctx.moveTo(sx(p2), sy(p2));
			ctx.lineTo(ex2, ey2);
			ctx.moveTo(sx(p3), sy(p3));
			ctx.lineTo(ex3, ey3);
			ctx.stroke();

			// Cross-bar connecting p2 to p3.
			ctx.save();
			ctx.setLineDash([3 * hr, 3 * hr]);
			ctx.lineWidth = Math.max(1, this._width - 1);
			ctx.beginPath();
			ctx.moveTo(sx(p2), sy(p2));
			ctx.lineTo(sx(p3), sy(p3));
			ctx.stroke();
			ctx.restore();

			if (!this._showHandles) return;
			this._handle(ctx, sx(p1), sy(p1), hr, this._hovered === 1);
			this._handle(ctx, sx(p2), sy(p2), hr, this._hovered === 2);
			this._handle(ctx, sx(p3), sy(p3), hr, this._hovered === 3);
		});
	}

	private _handle(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		ratio: number,
		hovered: boolean,
	) {
		const r = (hovered ? this._handleRadius + 2 : this._handleRadius) * ratio;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, 2 * Math.PI);
		ctx.fillStyle = "#111317";
		ctx.fill();
		ctx.lineWidth = 2 * ratio;
		ctx.strokeStyle = this._color;
		ctx.stroke();
	}
}

class PitchforkPaneView implements UpdatablePaneView {
	private _p1: ViewPoint = { x: null, y: null };
	private _p2: ViewPoint = { x: null, y: null };
	private _p3: ViewPoint = { x: null, y: null };
	private _mid: ViewPoint = { x: null, y: null };

	constructor(private _source: Pitchfork) {}

	update() {
		const s = this._source;
		this._p1 = s.coordOf(s._p1);
		this._p2 = s.coordOf(s._p2);
		this._p3 = s.coordOf(s._p3);
		// Midpoint of p2/p3 computed in pixel space (fractional logical → no coord).
		this._mid = midpoint(this._p2, this._p3);
	}

	renderer() {
		return new PitchforkPaneRenderer(
			this._p1,
			this._p2,
			this._p3,
			this._mid,
			this._source._options.lineColor,
			this._source._options.width,
			this._source._options.handleRadius,
			this._source.hoveredHandle,
			this._source.showHandles,
		);
	}
}

export class Pitchfork extends DrawingPrimitive {
	public hoveredHandle: PitchforkHandle = 0;
	public showHandles = true;

	constructor(
		public _p1: Point,
		public _p2: Point,
		public _p3: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		super(options);
		this._views = [new PitchforkPaneView(this)];
	}

	setPoint(which: PitchforkHandle, p: Point) {
		if (which === 1) this._p1 = p;
		else if (which === 2) this._p2 = p;
		else if (which === 3) this._p3 = p;
		this.updateAllViews();
		this.requestUpdate();
	}

	hitTestHandle(x: number, y: number): PitchforkHandle {
		for (const [i, pt] of [[1, this._p1], [2, this._p2], [3, this._p3]] as [PitchforkHandle, Point][]) {
			const c = this.coordOf(pt);
			if (c.x === null || c.y === null) continue;
			if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS) return i;
		}
		return 0;
	}

	hitTestBody(x: number, y: number): boolean {
		const c1 = this.coordOf(this._p1);
		const c2 = this.coordOf(this._p2);
		const c3 = this.coordOf(this._p3);
		if (c1.x === null || c1.y === null || c2.x === null || c2.y === null || c3.x === null || c3.y === null) {
			return false;
		}

		// The median direction vector (toward midpoint of p2/p3).
		const mid = midpoint(c2, c3);
		if (mid.x === null || mid.y === null) return false;
		const dx = mid.x - c1.x;
		const dy = mid.y - c1.y;

		// Check each of the three ray segments: shaft, upper tine, lower tine.
		const nearRay = (ox: number, oy: number) => {
			const lenSq = dx * dx + dy * dy;
			if (lenSq === 0) return false;
			const t = Math.max(0, ((x - ox) * dx + (y - oy) * dy) / lenSq);
			return Math.hypot(x - (ox + t * dx), y - (oy + t * dy)) <= BODY_HIT_RADIUS;
		};

		// Shaft: p1 to mid (clamped segment, not a ray).
		const shaftLenSq = dx * dx + dy * dy;
		if (shaftLenSq > 0) {
			const t = Math.max(0, Math.min(1, ((x - c1.x) * dx + (y - c1.y) * dy) / shaftLenSq));
			if (Math.hypot(x - (c1.x + t * dx), y - (c1.y + t * dy)) <= BODY_HIT_RADIUS) return true;
		}

		return nearRay(c2.x, c2.y) || nearRay(c3.x, c3.y);
	}

	beginDrag(x: number, y: number): Dragger | null {
		const which = this.hitTestHandle(x, y);
		if (which !== 0) {
			return snapDragger(this, (p) => this.setPoint(which, p));
		}
		if (this.hitTestBody(x, y)) {
			const tracker = new BarTracker(this.chart.timeScale(), x);
			let lastY = y;
			return {
				move: (mx, my) => {
					const dyp = my - lastY;
					lastY = my;
					const bars = tracker.step(mx);
					for (const w of [1, 2, 3] as PitchforkHandle[]) {
						const cur = w === 1 ? this._p1 : w === 2 ? this._p2 : this._p3;
						const c = this.coordOf(cur);
						if (c.x === null || c.y === null) continue;
						const np = this.series.coordinateToPrice((c.y as number) + dyp);
						const next = { ...cur };
						if (np !== null) next.price = np;
						if (bars !== 0) next.logical = cur.logical + bars;
						this.setPoint(w, next);
					}
				},
			};
		}
		return null;
	}

	updateHover(x: number, y: number): boolean {
		const which = this.hitTestHandle(x, y);
		if (which !== this.hoveredHandle) {
			this.hoveredHandle = which;
			this.requestUpdate();
		}
		return which !== 0 || this.hitTestBody(x, y);
	}
}

// Preview pitchfork used during placement (click 1: shaft preview, click 2: full preview).
class PreviewPitchfork extends Pitchfork {
	constructor(p1: Point, p2: Point, p3: Point, options: Partial<TrendLineOptions> = {}) {
		super(p1, p2, p3, options);
		this._options.lineColor = this._options.previewColor;
		this.showHandles = false;
	}

	updatePoint(which: PitchforkHandle, p: Point) {
		this.setPoint(which, p);
	}
}

// ── Tool registry: per-kind placement (clicks + build + preview) ──────────────
interface ToolSpec {
	clicks: number;
	build(points: Point[], options: Partial<TrendLineOptions>): DrawingPrimitive;
	// Preview shown after each click while points.length < clicks (null = none).
	preview?(points: Point[], options: Partial<TrendLineOptions>): DrawingPrimitive | null;
	// Update the preview as the cursor moves between clicks.
	previewCursor?(preview: DrawingPrimitive, cursor: Point): void;
}

function twoPointLine(): ToolSpec {
	return {
		clicks: 2,
		build: (pts, o) => new TrendLine(pts[0], pts[1], o),
		preview: (pts, o) => new PreviewTrendLine(pts[0], pts[0], o),
		previewCursor: (prev, cur) => (prev as PreviewTrendLine).updateEndPoint(cur),
	};
}

const TOOLS: Record<LineKind, ToolSpec> = {
	segment: twoPointLine(),
	ray: twoPointLine(),
	extended: twoPointLine(),
	horizontal: { clicks: 1, build: (pts, o) => new HorizontalLine(pts[0].price, o) },
	vertical: { clicks: 1, build: (pts, o) => new VerticalLine(pts[0].logical, o) },
	cross: { clicks: 1, build: (pts, o) => new CrossLine(pts[0], o) },
	"horizontal-ray": { clicks: 1, build: (pts, o) => new HorizontalRay(pts[0], o) },
	channel: {
		clicks: 3,
		build: (pts, o) => {
			const [p1, p2, p3] = pts;
			const dl = p2.logical - p1.logical;
			const baseAtP3 =
				dl === 0
					? p1.price
					: p1.price + ((p3.logical - p1.logical) / dl) * (p2.price - p1.price);
			return new ParallelChannel(p1, p2, p3.price - baseAtP3, o);
		},
		// Stage 1 → base-line preview; stage 2 → channel preview at zero offset.
		preview: (pts, o) =>
			pts.length === 1
				? new PreviewTrendLine(pts[0], pts[0], o)
				: new PreviewParallelChannel(pts[0], pts[1], 0, o),
		previewCursor: (prev, cur) => {
			if (prev instanceof PreviewParallelChannel) {
				prev.setOffsetFromPoint(cur.logical, cur.price);
			} else {
				(prev as PreviewTrendLine).updateEndPoint(cur);
			}
		},
	},
	pitchfork: {
		clicks: 3,
		build: (pts, o) => new Pitchfork(pts[0], pts[1], pts[2], o),
		// Stage 1: shaft preview (p1 → cursor); stage 2: full pitchfork preview.
		preview: (pts, o) =>
			pts.length === 1
				? new PreviewTrendLine(pts[0], pts[0], o)
				: new PreviewPitchfork(pts[0], pts[1], pts[1], o),
		previewCursor: (prev, cur) => {
			if (prev instanceof PreviewPitchfork) {
				prev.updatePoint(3, cur);
			} else {
				(prev as PreviewTrendLine).updateEndPoint(cur);
			}
		},
	},
};

// ── Controller: generic over all drawing kinds ────────────────────────────────
export class TrendLineDrawingTool {
	private _drawings: DrawingPrimitive[] = [];
	private _preview: DrawingPrimitive | undefined;
	private _points: Point[] = [];
	private _drawing = false;
	private _activeKind: LineKind = "segment";
	private _onStateChange?: (drawing: boolean, kind: LineKind | null) => void;
	private _dragger: Dragger | null = null;
	private readonly _el: HTMLElement;

	constructor(
		private _chart: IChartApi,
		private _series: ISeriesApi<SeriesType>,
		private _options: Partial<TrendLineOptions> = {},
	) {
		this._chart.subscribeCrosshairMove(this._moveHandler);
		this._el = this._chart.chartElement();
		this._el.addEventListener("pointerdown", this._onPointerDown);
		this._el.addEventListener("pointermove", this._onPointerMove);
		this._el.addEventListener("pointerup", this._onPointerUp);
	}

	private _moveHandler = (param: MouseEventParams) => this._onDrawMove(param);

	onStateChange(cb: (drawing: boolean, kind: LineKind | null) => void) {
		this._onStateChange = cb;
	}

	isDrawing() {
		return this._drawing;
	}

	activeKind(): LineKind | null {
		return this._drawing ? this._activeKind : null;
	}

	// Toggle drawing. Re-clicking the active kind stops; a different kind switches.
	toggle(kind: LineKind = "segment") {
		if (this._drawing && this._activeKind === kind) {
			this.stopDrawing();
		} else {
			this.startDrawing(kind);
		}
	}

	startDrawing(kind: LineKind = "segment") {
		this._activeKind = kind;
		this._drawing = true;
		this._points = [];
		this._el.style.cursor = "crosshair";
		this._onStateChange?.(true, this._activeKind);
	}

	stopDrawing() {
		this._drawing = false;
		this._points = [];
		this._removePreview();
		this._el.style.cursor = "";
		this._onStateChange?.(false, null);
	}

	remove() {
		this.stopDrawing();
		this._chart.unsubscribeCrosshairMove(this._moveHandler);
		this._el.removeEventListener("pointerdown", this._onPointerDown);
		this._el.removeEventListener("pointermove", this._onPointerMove);
		this._el.removeEventListener("pointerup", this._onPointerUp);
		this._drawings.forEach((d) => this._series.detachPrimitive(d));
		this._drawings = [];
	}

	// Pane-local pixel coords (right price scale + bottom time scale → origin 0,0).
	private _paneCoords(e: PointerEvent): { x: number; y: number } {
		const rect = this._el.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private _onPointerDown = (e: PointerEvent) => {
		const { x, y } = this._paneCoords(e);

		if (this._drawing) {
			const l = this._chart.timeScale().coordinateToLogical(x);
			const price = this._series.coordinateToPrice(y);
			if (l !== null && price !== null) {
				this._place({ logical: Math.round(l), price });
			}
			return;
		}

		// Topmost drawing wins → hit-test from the end (latest is drawn on top).
		for (let i = this._drawings.length - 1; i >= 0; i--) {
			const dragger = this._drawings[i].beginDrag(x, y);
			if (dragger) {
				this._dragger = dragger;
				this._beginDrag(e);
				return;
			}
		}
	};

	private _beginDrag(e: PointerEvent) {
		this._el.setPointerCapture(e.pointerId);
		this._chart.applyOptions({ handleScroll: false, handleScale: false });
		this._el.style.cursor = "grabbing";
		e.preventDefault();
	}

	private _onPointerMove = (e: PointerEvent) => {
		const { x, y } = this._paneCoords(e);

		if (this._dragger) {
			this._dragger.move(x, y);
			e.preventDefault();
			return;
		}

		if (this._drawing) return;

		// Hover feedback: let each drawing update its own hover state.
		let hovering = false;
		for (const d of this._drawings) {
			if (d.updateHover(x, y)) hovering = true;
		}
		this._el.style.cursor = hovering ? "grab" : "";
	};

	private _onPointerUp = (e: PointerEvent) => {
		if (!this._dragger) return;
		this._dragger = null;
		this._el.releasePointerCapture(e.pointerId);
		this._chart.applyOptions({ handleScroll: true, handleScale: true });
		this._el.style.cursor = "grab";
	};

	// Preview tracking as the cursor moves between clicks.
	private _onDrawMove(param: MouseEventParams) {
		if (!this._drawing || !param.point || !this._preview) return;
		const l = this._chart.timeScale().coordinateToLogical(param.point.x);
		const price = this._series.coordinateToPrice(param.point.y);
		if (l === null || price === null) return;
		TOOLS[this._activeKind].previewCursor?.(this._preview, {
			logical: Math.round(l),
			price,
		});
	}

	// Add a click point; commit when the tool has enough, else advance the preview.
	private _place(p: Point) {
		const spec = TOOLS[this._activeKind];
		const options = { ...this._options, kind: this._activeKind };
		this._points.push(p);

		if (this._points.length >= spec.clicks) {
			this._removePreview();
			const drawing = spec.build(this._points, options);
			this._drawings.push(drawing);
			this._series.attachPrimitive(drawing);
			this.stopDrawing();
			return;
		}

		// Rebuild the preview for the new stage (handles the channel's stage swap).
		this._removePreview();
		const preview = spec.preview?.(this._points, options);
		if (preview) {
			this._preview = preview;
			this._series.attachPrimitive(preview);
		}
	}

	private _removePreview() {
		if (this._preview) {
			this._series.detachPrimitive(this._preview);
			this._preview = undefined;
		}
	}
}
