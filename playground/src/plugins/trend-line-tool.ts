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

// Which endpoint: 0 = none, 1 = p1, 2 = p2.
type Endpoint = 0 | 1 | 2;

// A "segment" stops at both endpoints; a "ray" continues past p2 to infinity;
// an "extended" line continues past BOTH endpoints to infinity.
// A "horizontal" line is a separate shape: a single price anchor, infinite
// width, no endpoints — placed with one click and dragged vertically.
export type LineKind =
	| "segment"
	| "ray"
	| "extended"
	| "horizontal"
	| "horizontal-ray"
	| "vertical";

export interface TrendLineOptions {
	lineColor: string;
	previewColor: string;
	width: number;
	handleRadius: number; // CSS px
	kind: LineKind;
}

const defaultOptions: TrendLineOptions = {
	lineColor: "#2962FF",
	previewColor: "rgba(41, 98, 255, 0.5)",
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

// ── Renderer: pure canvas, pixels only ───────────────────────────────────────
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
				let sx = x1; // start end
				let sy = y1;
				let ex = x2; // finish end
				let ey = y2;

				// Extend past p2 (direction p1→p2) for ray and extended.
				if (this._kind === "ray" || this._kind === "extended") {
					[ex, ey] = extendToEdge(x1, y1, x2, y2, w, h);
				}
				// Extend past p1 (direction p2→p1) for extended only.
				if (this._kind === "extended") {
					[sx, sy] = extendToEdge(x2, y2, x1, y1, w, h);
				}

				// The line
				ctx.lineWidth = this._width;
				ctx.strokeStyle = this._color;
				ctx.beginPath();
				ctx.moveTo(sx, sy);
				ctx.lineTo(ex, ey);
				ctx.stroke();

				if (!this._showHandles) return;

				// Endpoint handles (always at the real endpoints, not the extension).
				// The end handle (p2) can be suppressed independently — used while
				// drawing, when only the anchored first dot should show.
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

// ── PaneView: logical (price/time) → pixels, every frame ──────────────────────
class TrendLinePaneView implements IPrimitivePaneView {
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

// ── Primitive: state + lifecycle ──────────────────────────────────────────────
export class TrendLine implements ISeriesPrimitive<Time> {
	public chart!: IChartApi;
	public series!: ISeriesApi<SeriesType>;
	public _options: TrendLineOptions;
	public hoveredHandle: Endpoint = 0;
	public showHandles = true;
	public showEndHandle = true;
	private _paneViews: TrendLinePaneView[];
	private _requestUpdate?: () => void;

	constructor(
		public _p1: Point,
		public _p2: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		this._options = { ...defaultOptions, ...options };
		this._paneViews = [new TrendLinePaneView(this)];
	}

	attached(param: SeriesAttachedParameter<Time, SeriesType>) {
		this.chart = param.chart;
		this.series = param.series;
		this._requestUpdate = param.requestUpdate;
		this._requestUpdate?.();
	}

	detached() {
		this._requestUpdate = undefined;
	}

	requestUpdate() {
		this._requestUpdate?.();
	}

	updateAllViews() {
		this._paneViews.forEach((pw) => pw.update());
	}

	paneViews() {
		return this._paneViews;
	}

	// Current pixel position of an endpoint (pane-local coords).
	endpointCoord(which: 1 | 2): ViewPoint {
		const p = which === 1 ? this._p1 : this._p2;
		return {
			x: this.chart.timeScale().logicalToCoordinate(p.logical as Logical),
			y: this.series.priceToCoordinate(p.price),
		};
	}

	// Returns which endpoint (if any) is within HIT_RADIUS of a pane-local point.
	hitTestHandle(x: number, y: number): Endpoint {
		for (const which of [1, 2] as const) {
			const c = this.endpointCoord(which);
			if (c.x === null || c.y === null) continue;
			if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS) return which;
		}
		return 0;
	}

	// pane-local pixels in, distance on px out
	hitTestBody(x: number, y: number): boolean {
		const a = this.endpointCoord(1);
		const b = this.endpointCoord(2);

		if (a.x === null || a.y === null || b.x === null || b.y === null) {
			return false;
		}

		const dx = b.x - a.x,
			dy = b.y - a.y;
		const lenSq = dx * dx + dy * dy;
		// Project the point onto the line, then clamp t to the drawn range:
		//   segment  → [0, 1]        (between the endpoints)
		//   ray      → [0, ∞)        (extends past p2)
		//   extended → (-∞, ∞)       (extends past both ends)
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
}

// A preview line whose second endpoint tracks the cursor while drawing.
class PreviewTrendLine extends TrendLine {
	constructor(p1: Point, p2: Point, options: Partial<TrendLineOptions> = {}) {
		super(p1, p2, options);
		this._options.lineColor = this._options.previewColor;
		// Show the anchored first dot, but not one chasing the cursor (the
		// crosshair already marks that end).
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

class HorizontalLinePaneView implements IPrimitivePaneView {
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

export class HorizontalLine implements ISeriesPrimitive<Time> {
	public chart!: IChartApi;
	public series!: ISeriesApi<SeriesType>;
	public _options: TrendLineOptions;
	private _paneViews: HorizontalLinePaneView[];
	private _requestUpdate?: () => void;

	constructor(
		public price: number,
		options: Partial<TrendLineOptions> = {},
	) {
		this._options = { ...defaultOptions, ...options };
		this._paneViews = [new HorizontalLinePaneView(this)];
	}

	attached(param: SeriesAttachedParameter<Time, SeriesType>) {
		this.chart = param.chart;
		this.series = param.series;
		this._requestUpdate = param.requestUpdate;
		this._requestUpdate?.();
	}

	detached() {
		this._requestUpdate = undefined;
	}

	requestUpdate() {
		this._requestUpdate?.();
	}

	updateAllViews() {
		this._paneViews.forEach((pw) => pw.update());
	}

	paneViews() {
		return this._paneViews;
	}

	// Vertical distance only — the line spans the full width.
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

class VerticalLinePaneView implements IPrimitivePaneView {
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

export class VerticalLine implements ISeriesPrimitive<Time> {
	public chart!: IChartApi;
	public series!: ISeriesApi<SeriesType>;
	public _options: TrendLineOptions;
	private _paneViews: VerticalLinePaneView[];
	private _requestUpdate?: () => void;

	constructor(
		public logical: number,
		options: Partial<TrendLineOptions> = {},
	) {
		this._options = { ...defaultOptions, ...options };
		this._paneViews = [new VerticalLinePaneView(this)];
	}

	attached(param: SeriesAttachedParameter<Time, SeriesType>) {
		this.chart = param.chart;
		this.series = param.series;
		this._requestUpdate = param.requestUpdate;
		this._requestUpdate?.();
	}

	detached() {
		this._requestUpdate = undefined;
	}

	requestUpdate() {
		this._requestUpdate?.();
	}

	updateAllViews() {
		this._paneViews.forEach((pw) => pw.update());
	}

	paneViews() {
		return this._paneViews;
	}

	// Horizontal distance only — the line spans the full height.
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

				// Flat line from the anchor to the right edge.
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

class HorizontalRayPaneView implements IPrimitivePaneView {
	private _anchor: ViewPoint = { x: null, y: null };

	constructor(private _source: HorizontalRay) {}

	update() {
		this._anchor = this._source.anchorCoord();
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

export class HorizontalRay implements ISeriesPrimitive<Time> {
	public chart!: IChartApi;
	public series!: ISeriesApi<SeriesType>;
	public _options: TrendLineOptions;
	public hovered = false;
	public showHandle = true;
	private _paneViews: HorizontalRayPaneView[];
	private _requestUpdate?: () => void;

	constructor(
		public _anchor: Point,
		options: Partial<TrendLineOptions> = {},
	) {
		this._options = { ...defaultOptions, ...options };
		this._paneViews = [new HorizontalRayPaneView(this)];
	}

	attached(param: SeriesAttachedParameter<Time, SeriesType>) {
		this.chart = param.chart;
		this.series = param.series;
		this._requestUpdate = param.requestUpdate;
		this._requestUpdate?.();
	}

	detached() {
		this._requestUpdate = undefined;
	}

	requestUpdate() {
		this._requestUpdate?.();
	}

	updateAllViews() {
		this._paneViews.forEach((pw) => pw.update());
	}

	paneViews() {
		return this._paneViews;
	}

	anchorCoord(): ViewPoint {
		return {
			x: this.chart.timeScale().logicalToCoordinate(this._anchor.logical as Logical),
			y: this.series.priceToCoordinate(this._anchor.price),
		};
	}

	// Is the pointer over the anchor dot?
	hitTestHandle(x: number, y: number): boolean {
		const c = this.anchorCoord();
		if (c.x === null || c.y === null) return false;
		return Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS;
	}

	// Is the pointer over the flat body — at the right height AND at or right of
	// the anchor (the ray only extends rightward)?
	hitTestBody(x: number, y: number): boolean {
		const c = this.anchorCoord();
		if (c.x === null || c.y === null) return false;
		return Math.abs(c.y - y) <= BODY_HIT_RADIUS && x >= c.x - BODY_HIT_RADIUS;
	}

	setAnchor(p: Point) {
		this._anchor = p;
		this.updateAllViews();
		this.requestUpdate();
	}

	setPrice(price: number) {
		this._anchor = { ...this._anchor, price };
		this.updateAllViews();
		this.requestUpdate();
	}
}

// ── Controller: draw new lines AND drag existing endpoints ────────────────────
export class TrendLineDrawingTool {
	private _lines: TrendLine[] = [];
	private _preview: PreviewTrendLine | undefined;
	private _points: Point[] = [];
	private _drawing = false;
	private _activeKind: LineKind = "segment";
	private _onStateChange?: (drawing: boolean, kind: LineKind | null) => void;

	// Drag state
	private _hlines: HorizontalLine[] = [];
	private _vlines: VerticalLine[] = [];
	private _hrays: HorizontalRay[] = [];
	private _dragTarget:
		| { line: TrendLine; mode: "endpoint"; which: 1 | 2 }
		| { line: TrendLine; mode: "body"; last: { x: number; y: number } }
		| { hline: HorizontalLine; mode: "hline" }
		| { vline: VerticalLine; mode: "vline"; last: { x: number } }
		| { hray: HorizontalRay; mode: "hray-anchor" }
		| { hray: HorizontalRay; mode: "hray-body"; last: { x: number; y: number } }
		| null = null;
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

	// The kind currently being drawn, or null if not drawing.
	activeKind(): LineKind | null {
		return this._drawing ? this._activeKind : null;
	}

	// Toggle drawing. If already drawing a different kind, switch to the new
	// kind instead of stopping (matches how a toolbar re-click behaves).
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
		this._lines.forEach((line) => this._series.detachPrimitive(line));
		this._lines = [];
		this._hlines.forEach((line) => this._series.detachPrimitive(line));
		this._hlines = [];
		this._vlines.forEach((line) => this._series.detachPrimitive(line));
		this._vlines = [];
		this._hrays.forEach((ray) => this._series.detachPrimitive(ray));
		this._hrays = [];
	}

	// ── Native pointer handling: drag endpoints of finished lines ──────────────

	// Convert a pointer event to pane-local pixel coords.
	// Right-side price scale + bottom time scale means the pane's origin is the
	// top-left of the chart element, so a simple rect offset is correct here.
	private _paneCoords(e: PointerEvent): { x: number; y: number } {
		const rect = this._el.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private _onPointerDown = (e: PointerEvent) => {
		if (this._drawing) {
			const { x, y } = this._paneCoords(e);
			const price = this._series.coordinateToPrice(y);

			// Horizontal line: one click, price only. Placed and done.
			if (this._activeKind === "horizontal") {
				if (price !== null) this._addHorizontalLine(price);
				return;
			}

			// Vertical line: one click, snapped logical only.
			if (this._activeKind === "vertical") {
				const l = this._chart.timeScale().coordinateToLogical(x);
				if (l !== null) this._addVerticalLine(Math.round(l));
				return;
			}

			// Horizontal ray: one click, price + snapped logical anchor.
			if (this._activeKind === "horizontal-ray") {
				const l = this._chart.timeScale().coordinateToLogical(x);
				if (l !== null && price !== null) {
					this._addHorizontalRay({ logical: Math.round(l), price });
				}
				return;
			}

			// Two-point kinds: place the point where the press lands (snapped).
			const logical = this._chart.timeScale().coordinateToLogical(x);
			if (logical !== null && price !== null) {
				this._addPoint({ logical: Math.round(logical), price });
			}
			return;
		}
		const { x, y } = this._paneCoords(e);

		// Horizontal rays first (dot beats body).
		for (let i = this._hrays.length - 1; i >= 0; i--) {
			if (this._hrays[i].hitTestHandle(x, y)) {
				this._dragTarget = { hray: this._hrays[i], mode: "hray-anchor" };
				this._beginDrag(e);
				return;
			}
			if (this._hrays[i].hitTestBody(x, y)) {
				this._dragTarget = {
					hray: this._hrays[i],
					mode: "hray-body",
					last: { x, y },
				};
				this._beginDrag(e);
				return;
			}
		}

		// Horizontal lines next (topmost wins).
		for (let i = this._hlines.length - 1; i >= 0; i--) {
			if (this._hlines[i].hitTestBody(x, y)) {
				this._dragTarget = { hline: this._hlines[i], mode: "hline" };
				this._beginDrag(e);
				return;
			}
		}

		// Vertical lines next (topmost wins).
		for (let i = this._vlines.length - 1; i >= 0; i--) {
			if (this._vlines[i].hitTestBody(x, y)) {
				this._dragTarget = { vline: this._vlines[i], mode: "vline", last: { x } };
				this._beginDrag(e);
				return;
			}
		}

		// Topmost trend line wins → search from the end.
		for (let i = this._lines.length - 1; i >= 0; i--) {
			const which = this._lines[i].hitTestHandle(x, y);
			if (which !== 0) {
				this._dragTarget = { line: this._lines[i], which, mode: "endpoint" };
				this._beginDrag(e);
				e.preventDefault();
				return;
			}
			const body = this._lines[i].hitTestBody(x, y);
			if (body) {
				this._dragTarget = {
					line: this._lines[i],
					mode: "body",
					last: { x, y },
				};
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

		if (this._dragTarget) {
			if (this._dragTarget.mode === "hline") {
				// Flat line: only the price (y) changes.
				const price = this._series.coordinateToPrice(y);
				if (price !== null) this._dragTarget.hline.setPrice(price);
				e.preventDefault();
				return;
			} else if (this._dragTarget.mode === "vline") {
				// Vertical line: only the logical (x) changes, snapped to bars.
				const ts = this._chart.timeScale();
				const curLogical = ts.coordinateToLogical(x);
				const lastLogical = ts.coordinateToLogical(this._dragTarget.last.x);
				const barsMoved =
					curLogical !== null && lastLogical !== null
						? Math.round(curLogical - lastLogical)
						: 0;
				if (barsMoved !== 0) {
					const vline = this._dragTarget.vline;
					vline.setLogical(vline.logical + barsMoved);
					if (lastLogical !== null) {
						const advanced = ts.logicalToCoordinate(
							(lastLogical + barsMoved) as Logical,
						);
						if (advanced !== null) this._dragTarget.last.x = advanced;
					}
				}
				e.preventDefault();
				return;
			} else if (this._dragTarget.mode === "hray-anchor") {
				// Drag the dot: snapped logical + price, line stays flat.
				const logical = this._chart.timeScale().coordinateToLogical(x);
				const price = this._series.coordinateToPrice(y);
				if (logical !== null && price !== null) {
					this._dragTarget.hray.setAnchor({ logical: Math.round(logical), price });
				}
				e.preventDefault();
				return;
			} else if (this._dragTarget.mode === "hray-body") {
				// Translate the whole ray: bars in x, continuous price in y.
				const ray = this._dragTarget.hray;
				const ts = this._chart.timeScale();
				const c = ray.anchorCoord();
				if (c.x !== null && c.y !== null) {
					const dyp = y - this._dragTarget.last.y;
					const curLogical = ts.coordinateToLogical(x);
					const lastLogical = ts.coordinateToLogical(this._dragTarget.last.x);
					const barsMoved =
						curLogical !== null && lastLogical !== null
							? Math.round(curLogical - lastLogical)
							: 0;

					const next = { ...ray._anchor };
					const newPrice = this._series.coordinateToPrice(c.y + dyp);
					if (newPrice !== null) next.price = newPrice;
					if (barsMoved !== 0) next.logical = ray._anchor.logical + barsMoved;
					ray.setAnchor(next);

					this._dragTarget.last.y = y;
					if (barsMoved !== 0 && lastLogical !== null) {
						const advanced = ts.logicalToCoordinate(
							(lastLogical + barsMoved) as Logical,
						);
						if (advanced !== null) this._dragTarget.last.x = advanced;
					}
				}
				e.preventDefault();
				return;
			} else if (this._dragTarget.mode === "endpoint") {
				// Convert pixel → data (snapped) and move the grabbed endpoint.
				const logical = this._chart.timeScale().coordinateToLogical(x);
				const price = this._series.coordinateToPrice(y);
				if (logical !== null && price !== null) {
					this._dragTarget.line.setEndpoint(this._dragTarget.which, {
						logical: Math.round(logical),
						price,
					});
				}
				e.preventDefault();
				return;
			} else if (this._dragTarget.mode === "body") {
				const line = this._dragTarget.line;
				const ts = this._chart.timeScale();

				// Vertical stays continuous.
				const dyp = y - this._dragTarget.last.y;

				// Horizontal: cursor movement measured in bars, rounded to snap.
				const curLogical = ts.coordinateToLogical(x);
				const lastLogical = ts.coordinateToLogical(this._dragTarget.last.x);
				const barsMoved =
					curLogical !== null && lastLogical !== null
						? Math.round(curLogical - lastLogical)
						: 0;

				for (const which of [1, 2] as const) {
					const c = line.endpointCoord(which);
					if (c.x === null || c.y === null) continue;
					const cur = which === 1 ? line._p1 : line._p2;
					const next = { ...cur };

					const newPrice = this._series.coordinateToPrice(c.y + dyp);
					if (newPrice !== null) next.price = newPrice;

					// Logical is continuous & extrapolates past the data edge, so
					// adding an integer bar offset keeps the endpoint snapped AND
					// lets it move beyond the last bar without collapsing.
					if (barsMoved !== 0) {
						next.logical = cur.logical + barsMoved;
					}
					line.setEndpoint(which, next);
				}

				this._dragTarget.last.y = y; // y: advance every frame
				if (barsMoved !== 0 && lastLogical !== null) {
					// x: advance by ONLY the bars consumed, keeping the sub-bar remainder
					const advanced = ts.logicalToCoordinate(
						(lastLogical + barsMoved) as Logical,
					);
					if (advanced !== null) this._dragTarget.last.x = advanced;
				}
				e.preventDefault();
				return;
			}
		}

		if (this._drawing) return;

		// Not dragging: hover feedback + grab cursor over a handle or line body.
		let hovered = false;
		for (const line of this._lines) {
			const which = line.hitTestHandle(x, y);
			if (which !== line.hoveredHandle) {
				line.hoveredHandle = which;
				line.requestUpdate();
			}
			if (which !== 0) hovered = true;
		}
		// Hover feedback for horizontal rays (dot enlarges like trend handles).
		let overHray = false;
		for (const ray of this._hrays) {
			const on = ray.hitTestHandle(x, y);
			if (on !== ray.hovered) {
				ray.hovered = on;
				ray.requestUpdate();
			}
			if (on || ray.hitTestBody(x, y)) overHray = true;
		}
		const overHline = this._hlines.some((line) => line.hitTestBody(x, y));
		const overVline = this._vlines.some((line) => line.hitTestBody(x, y));
		this._el.style.cursor =
			hovered || overHline || overVline || overHray ? "grab" : "";
	};

	private _onPointerUp = (e: PointerEvent) => {
		if (!this._dragTarget) return;
		this._dragTarget = null;
		this._el.releasePointerCapture(e.pointerId);
		this._chart.applyOptions({ handleScroll: true, handleScale: true });
		this._el.style.cursor = "grab";
	};

	// ── Drawing new lines ──────────────────────────────────────────────────────

	private _onDrawMove(param: MouseEventParams) {
		if (!this._drawing || !param.point || !this._preview) return;
		const logical = this._chart.timeScale().coordinateToLogical(param.point.x);
		const price = this._series.coordinateToPrice(param.point.y);
		if (logical === null || price === null) return;
		this._preview.updateEndPoint({ logical: Math.round(logical), price });
	}

	private _addPoint(p: Point) {
		this._points.push(p);
		const options = { ...this._options, kind: this._activeKind };
		if (this._points.length === 1) {
			this._preview = new PreviewTrendLine(p, p, options);
			this._series.attachPrimitive(this._preview);
		} else if (this._points.length >= 2) {
			this._removePreview();
			const line = new TrendLine(this._points[0], this._points[1], options);
			this._lines.push(line);
			this._series.attachPrimitive(line);
			this.stopDrawing();
		}
	}

	private _addHorizontalLine(price: number) {
		const line = new HorizontalLine(price, { ...this._options });
		this._hlines.push(line);
		this._series.attachPrimitive(line);
		this.stopDrawing();
	}

	private _addVerticalLine(logical: number) {
		const line = new VerticalLine(logical, { ...this._options });
		this._vlines.push(line);
		this._series.attachPrimitive(line);
		this.stopDrawing();
	}

	private _addHorizontalRay(anchor: Point) {
		const ray = new HorizontalRay(anchor, { ...this._options });
		this._hrays.push(ray);
		this._series.attachPrimitive(ray);
		this.stopDrawing();
	}

	private _removePreview() {
		if (this._preview) {
			this._series.detachPrimitive(this._preview);
			this._preview = undefined;
		}
	}
}
