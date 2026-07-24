import { useEffect, useRef, useState } from 'react';

export type LineKind =
	| 'segment'
	| 'ray'
	| 'extended'
	| 'horizontal'
	| 'horizontal-ray'
	| 'vertical'
	| 'cross'
	| 'channel';

interface DrawingToolbarProps {
	activeKind: LineKind | null;
	onToggle: (kind: LineKind) => void;
	live: boolean;
	onToggleLive: () => void;
	candles: boolean;
	onToggleCandles: () => void;
}

// TradingView's trendline glyph (diagonal line + two ringed endpoints).
const TrendIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M7.354 21.354l14-14-.707-.707-14 14z" />
			<path d="M22.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM5.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Ray glyph: two ringed endpoints with the line continuing past the second,
// trailing off toward the corner — signalling extension to infinity.
const RayIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M8.354 20.354l5-5-.707-.707-5 5z" />
			<path d="M16.354 12.354l8-8-.707-.707-8 8z" />
			<path d="M14.5 15c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM6.5 23c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Extended-line glyph: two ringed endpoints with the line trailing off past
// BOTH of them toward opposite corners — signalling extension in both directions.
const ExtendedIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M4.354 25.354l5-5-.707-.707-5 5z" />
			<path d="M12.354 17.354l5-5-.707-.707-5 5z" />
			<path d="M20.354 9.354l5-5-.707-.707-5 5z" />
			<path d="M18.5 12c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM10.5 20c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Horizontal-line glyph: a flat line spanning the width with a single mid dot.
const HorizontalIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M2 14.5h9v-1H2zM17 14.5h9v-1h-9z" />
			<path d="M14 15.5c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Horizontal-ray glyph: a dot on the left with a flat line extending right.
const HorizontalRayIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M12 14.5h14v-1H12z" />
			<path d="M8 15.5c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Vertical-line glyph: a line spanning the height with a single mid dot.
const VerticalIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M14.5 2v9h-1V2zM14.5 17v9h-1v-9z" />
			<path d="M14 15.5c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Cross-line glyph: full-width and full-height lines crossing at a center dot.
const CrossIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M2 14.5h9v-1H2zM17 14.5h9v-1h-9zM14.5 2v9h-1V2zM14.5 17v9h-1v-9z" />
			<path d="M14 15.5c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Parallel-channel glyph: two parallel diagonal lines with anchor dots.
const ChannelIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
		<g fill="currentColor" fillRule="nonzero">
			<path d="M4.354 18.354l14-14-.707-.707-14 14z" />
			<path d="M9.354 23.354l14-14-.707-.707-14 14z" />
			<path d="M18.5 5c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM4.5 19c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM23.5 10c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z" />
		</g>
	</svg>
);

// Settings gear glyph.
const GearIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
		<path
			fill="currentColor"
			fillRule="evenodd"
			d="M10.5 2h3l.5 2.6a7.5 7.5 0 0 1 1.9 1.1l2.5-1 1.5 2.6-2 1.7a7.6 7.6 0 0 1 0 2.2l2 1.7-1.5 2.6-2.5-1a7.5 7.5 0 0 1-1.9 1.1L13.5 22h-3l-.5-2.6a7.5 7.5 0 0 1-1.9-1.1l-2.5 1L4.1 16.7l2-1.7a7.6 7.6 0 0 1 0-2.2l-2-1.7 1.5-2.6 2.5 1a7.5 7.5 0 0 1 1.9-1.1L10.5 2zm1.5 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
			clipRule="evenodd"
		/>
	</svg>
);

// The little dropdown-arrow glyph from the markup.
const ArrowIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 16" width="10" height="16">
		<path fill="currentColor" d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
	</svg>
);

const TOOLS: { kind: LineKind; label: string; Icon: () => JSX.Element }[] = [
	{ kind: 'segment', label: 'Trend Line', Icon: TrendIcon },
	{ kind: 'ray', label: 'Ray', Icon: RayIcon },
	{ kind: 'extended', label: 'Extended Line', Icon: ExtendedIcon },
	{ kind: 'horizontal', label: 'Horizontal Line', Icon: HorizontalIcon },
	{ kind: 'horizontal-ray', label: 'Horizontal Ray', Icon: HorizontalRayIcon },
	{ kind: 'vertical', label: 'Vertical Line', Icon: VerticalIcon },
	{ kind: 'cross', label: 'Cross Line', Icon: CrossIcon },
	{ kind: 'channel', label: 'Parallel Channel', Icon: ChannelIcon },
];

export function DrawingToolbar({
	activeKind,
	onToggle,
	live,
	onToggleLive,
	candles,
	onToggleCandles,
}: DrawingToolbarProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// The tool shown on the main button. Defaults to the trend line, then
	// tracks whatever was last picked from the flyout (TradingView behaviour).
	const [selectedKind, setSelectedKind] = useState<LineKind>('segment');
	const rootRef = useRef<HTMLDivElement>(null);

	const active = activeKind !== null;
	const selected = TOOLS.find(t => t.kind === selectedKind) ?? TOOLS[0];

	// Close any flyout on outside click, mirroring TV behaviour.
	useEffect(() => {
		if (!menuOpen && !settingsOpen) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
				setSettingsOpen(false);
			}
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [menuOpen, settingsOpen]);

	return (
		<div className="tv-rail" ref={rootRef}>
			<style>{TOOLBAR_CSS}</style>
			<div className={`tv-group${active ? ' tv-active' : ''}`}>
				<div className="tv-btn-wrap">
					<button
						className="tv-btn"
						type="button"
						aria-label={selected.label}
						aria-pressed={active}
						onClick={() => onToggle(selected.kind)}
					>
						<span className="tv-icon" role="img" aria-hidden="true">
							<selected.Icon />
						</span>
						<span className="tv-tooltip">{selected.label}</span>
					</button>
				</div>
				<button
					className="tv-arrow"
					type="button"
					aria-label="Line tools"
					aria-expanded={menuOpen}
					onClick={() => setMenuOpen(v => !v)}
				>
					<span className="tv-arrow-icon" role="img" aria-hidden="true">
						<ArrowIcon />
					</span>
				</button>

				{menuOpen && (
					<div className="tv-menu" role="menu">
						{TOOLS.map(({ kind, label, Icon }) => (
							<button
								key={kind}
								className={`tv-menu-item${activeKind === kind ? ' tv-menu-item-active' : ''}`}
								role="menuitem"
								onClick={() => {
									setSelectedKind(kind);
									if (activeKind !== kind) onToggle(kind);
									setMenuOpen(false);
								}}
							>
								<span className="tv-menu-icon">
									<Icon />
								</span>
								<span className="tv-menu-label">{label}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Push the settings gear to the bottom of the rail. */}
			<div className="tv-spacer" />

			<div className="tv-group">
				<div className="tv-btn-wrap">
					<button
						className="tv-btn"
						type="button"
						aria-label="Settings"
						aria-expanded={settingsOpen}
						onClick={() => setSettingsOpen(v => !v)}
					>
						<span className="tv-icon tv-icon-gear" role="img" aria-hidden="true">
							<GearIcon />
						</span>
						<span className="tv-tooltip">Settings</span>
					</button>
				</div>

				{settingsOpen && (
					<div className="tv-menu tv-menu-up" role="menu">
						<div className="tv-menu-title">Chart</div>
						<button
							className="tv-menu-item"
							role="menuitemcheckbox"
							aria-checked={candles}
							onClick={onToggleCandles}
						>
							<span className={`tv-check${candles ? ' tv-check-on' : ''}`} />
							<span className="tv-menu-label">
								{candles ? 'Candlestick' : 'Line'} series
							</span>
						</button>
						<button
							className="tv-menu-item"
							role="menuitemcheckbox"
							aria-checked={live}
							onClick={onToggleLive}
						>
							<span className={`tv-check${live ? ' tv-check-on' : ''}`} />
							<span className="tv-menu-label">Live data feed</span>
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

// Scoped stylesheet — reproduces TradingView's left-rail button states:
// muted icon → white on hover → accent blue when active, with a delayed
// right-side tooltip and a flyout menu.
const TOOLBAR_CSS = `
.tv-rail {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	height: 100%;
	box-sizing: border-box;
	padding: 6px 4px;
	background: #131722;
	border-right: 1px solid #2a2e39;
	font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
	z-index: 20;
}
.tv-spacer { flex: 1; }
.tv-icon-gear { transform: scale(0.8); }
.tv-group {
	position: relative;
	display: flex;
	align-items: center;
	background: #1e222d;
	border: 1px solid #2a2e39;
	border-radius: 6px;
	overflow: visible;
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
.tv-btn-wrap { position: relative; }
.tv-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 38px;
	height: 38px;
	padding: 0;
	border: none;
	background: transparent;
	color: #b2b5be;
	cursor: pointer;
	border-radius: 6px 0 0 6px;
	transition: background-color 0.15s ease, color 0.15s ease;
}
.tv-btn:hover { background: #2a2e39; color: #d1d4dc; }
.tv-group.tv-active .tv-btn { color: #2962ff; }
.tv-icon { display: flex; }
.tv-arrow {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 38px;
	padding: 0;
	border: none;
	border-left: 1px solid #2a2e39;
	background: transparent;
	color: #787b86;
	cursor: pointer;
	border-radius: 0 6px 6px 0;
	transition: background-color 0.15s ease, color 0.15s ease;
}
.tv-arrow:hover { background: #2a2e39; color: #d1d4dc; }
.tv-arrow-icon { display: flex; transform: scale(0.55); }

/* Delayed tooltip to the right of the button, TradingView style. */
.tv-tooltip {
	position: absolute;
	left: calc(100% + 10px);
	top: 50%;
	transform: translateY(-50%);
	white-space: nowrap;
	background: #2a2e39;
	color: #d1d4dc;
	padding: 5px 9px;
	border-radius: 4px;
	font-size: 12px;
	pointer-events: none;
	opacity: 0;
	visibility: hidden;
	transition: opacity 0.1s ease;
	transition-delay: 0s;
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
.tv-btn:hover .tv-tooltip {
	opacity: 1;
	visibility: visible;
	transition-delay: 0.6s;
}

/* Flyout menu opened by the arrow — anchored beside the button group. */
.tv-menu {
	position: absolute;
	top: -1px;
	left: calc(100% + 8px);
	min-width: 160px;
	z-index: 30;
	background: #1e222d;
	border: 1px solid #2a2e39;
	border-radius: 6px;
	padding: 4px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
.tv-menu-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 6px 8px;
	border: none;
	background: transparent;
	color: #d1d4dc;
	cursor: pointer;
	border-radius: 4px;
	text-align: left;
	font: inherit;
}
.tv-menu-item:hover { background: #2a2e39; }
.tv-menu-item-active { color: #2962ff; }
.tv-menu-icon { display: flex; transform: scale(0.7); }
.tv-menu-label { line-height: 1; }

/* Settings flyout anchored to the bottom (opens upward from the gear). */
.tv-menu-up { top: auto; bottom: -1px; }
.tv-menu-title {
	padding: 4px 8px 6px;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: #787b86;
}

/* Checkmark toggle used in the settings menu. */
.tv-check {
	width: 14px;
	height: 14px;
	flex: none;
	border: 1px solid #4a5160;
	border-radius: 3px;
	position: relative;
}
.tv-check-on { background: #2962ff; border-color: #2962ff; }
.tv-check-on::after {
	content: '';
	position: absolute;
	left: 4px;
	top: 1px;
	width: 3px;
	height: 7px;
	border: solid #fff;
	border-width: 0 2px 2px 0;
	transform: rotate(45deg);
}
`;
