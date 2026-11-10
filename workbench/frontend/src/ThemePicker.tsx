import { Check } from "lucide-react";
import { FONTS, THEMES, type ThemeInfo, pickTheme, useAppearance } from "./appearance";

type Swatch = ThemeInfo["swatch"];

/** The Workroom in miniature (rail, presence line, a few lines of text), painted with one theme's own colours. */
function Shell({ p }: { p: Swatch }) {
  return (
    <span className="mini-shell" style={{ background: p.paper, color: p.text }}>
      <span className="mini-rail" style={{ background: p.panel, borderRight: `1px solid ${p.border}` }}>
        <i style={{ background: p.text }} />
        <i style={{ background: p.muted }} />
        <i style={{ background: p.muted }} />
      </span>
      <span className="mini-main">
        <span className="mini-presence" style={{ borderBottom: `1px solid ${p.border}` }}>
          <b style={{ background: p.live }} />
          <span className="l" style={{ background: p.muted, width: "44%" }} />
        </span>
        <span className="mini-thread">
          <span className="l" style={{ background: p.text, width: "56%" }} />
          <span className="l" style={{ background: p.muted, width: "84%" }} />
          <span className="l" style={{ background: p.muted, width: "62%" }} />
          <span className="b" style={{ background: p.text }} />
        </span>
      </span>
    </span>
  );
}

/** A tiny drawing of the app in a theme's own colours, so every card previews itself whatever theme is on now. */
function Mini({ t }: { t: ThemeInfo }) {
  if (t.mode === "auto") {
    const light = THEMES.find((x) => x.id === "light")!.swatch;
    const dark = THEMES.find((x) => x.id === "dark")!.swatch;
    return <span className="look-mini split" aria-hidden="true"><Shell p={light} /><Shell p={dark} /></span>;
  }
  return <span className="look-mini" aria-hidden="true"><Shell p={t.swatch} /></span>;
}

/** Theme cards: picking one restyles the whole app at once (that is the live preview). */
export function ThemeGrid() {
  const [a] = useAppearance();
  return (
    <div className="look-grid" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={a.theme === t.id} className="look-card" data-theme-option={t.id}
          onClick={() => pickTheme(t.id)}>
          <Mini t={t} />
          <span className="name">{t.label}{a.theme === t.id && <Check size={14} aria-label="chosen" />}</span>
          <span className="note">{t.note}</span>
        </button>
      ))}
    </div>
  );
}

const SETUP_SIZES: [number, string][] = [[13, "Smaller"], [14, "Standard"], [16, "Larger"]];

/** Typeface and text size, the two other things people want to set before they start. */
export function TypeChoices() {
  const [a, set] = useAppearance();
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="look-row">
        <span className="small muted look-row-label">Typeface</span>
        <div className="ap-seg" role="radiogroup" aria-label="Typeface">
          {FONTS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={a.font === f.id} style={{ fontFamily: f.body }} onClick={() => set({ font: f.id })}>{f.label}</button>
          ))}
        </div>
      </div>
      <div className="look-row">
        <span className="small muted look-row-label">Text size</span>
        <div className="ap-seg" role="radiogroup" aria-label="Text size">
          {SETUP_SIZES.map(([px, label]) => (
            <button key={px} type="button" role="radio" aria-checked={a.size === px} onClick={() => set({ size: px })}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
