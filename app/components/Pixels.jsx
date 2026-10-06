// Pixel Pride brand primitives: the three-pixel logo mark, a decorative pixel
// mosaic, and a 20-square "pixel meter" used for usage / progress displays.

export function BrandMark() {
  return (
    <span className="pp-mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

// Fixed pattern so server and client render identically (no hydration drift).
const MOSAIC = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1];

export function Mosaic({ cells = 24 }) {
  return (
    <span className="pp-mosaic" aria-hidden="true">
      {MOSAIC.slice(0, cells).map((on, i) => (
        <i key={i} style={on ? undefined : { visibility: "hidden" }} />
      ))}
    </span>
  );
}

export function PixelMeter({ pct = 0, light = false, label }) {
  const on = Math.round(Math.min(100, Math.max(0, pct)) / 5);
  const cls = `pp-meter${light ? " pp-meter--light" : ""}${pct >= 100 ? " is-full" : ""}`;
  return (
    <div className={cls} role="img" aria-label={label || `${Math.round(pct)}%`}>
      {Array.from({ length: 20 }, (_, i) => (
        <i key={i} className={i < on ? "is-on" : undefined} />
      ))}
    </div>
  );
}
