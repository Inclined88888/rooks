import { Check } from "lucide-react";
import { FONTS, THEMES, type ThemeInfo, pickTheme, useAppearance } from "./appearance";

type Swatch = ThemeInfo["swatch"];

/** The Workroom shell in miniature (rail, presence strip, thread, Stage), painted with one theme's own colours. */
function Shell({ p, narrow = false }: { p: Swatch; narrow?: boolean }) {
  return (
    <span className="mini-shell" style={{ background: p.paper, color: p.text }}>
      <span className="mini-rail" style={{ borderRight: `1px solid ${p.border}` }}>
        <i style={{ background: p.accent }} />
        <i style={{ background: p.text }} />
        <i style={{ background: p.text }} />
        <i style={{ background: p.text }} />
      </span>
      <span className="mini-main">
        <span className="mini-presence" style={{ borderBottom: `1px solid ${p.border}` }}>
          <b style={{ background: p.accent }} />
          <span className="l" style={{ background: p.muted, width: "48%" }} />
          <em style={{ background: p.accent }} />
        </span>
        <span className="mini-thread">
          <span className="h">Good morning</span>
          <span className="l" style={{ background: p.muted, width: "85%" }} />
          <span className="l" style={{ background: p.muted, width: "60%" }} />
          <span className="b" style={{ background: p.accent, color: p.onAccent }}>Plan my day</span>
        </span>
      </span>
      {!narrow && <span className="mini-stage" style={{ background: p.panel, borderColor: p.accent }} />}
    </span>
  );
}

/** A tiny drawing of the app in a theme's own colours, so every card previews itself whatever theme is on now. */
function Mini({ t }: { t: ThemeInfo }) {
  if (t.mode === "auto") {
    const light = THEMES.find((x) => x.id === "gallery")!.swatch;
    const dark = THEMES.find((x) => x.id === "night")!.swatch;
    return (
      <span className="look-mini split" aria-hidden="true" style={{ borderColor: light.border }}>
        <Shell p={light} narrow /><Shell p={dark} narrow />
      </span>
    );
  }
  return (
    <span className="look-mini" aria-hidden="true" style={{ borderColor: t.swatch.border }}>
      <Shell p={t.swatch} />
    </span>
  );
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
          <span className="name">{t.label}{a.theme === t.id && <Check size={13} aria-label="chosen" />}</span>
          <span className="note">{t.note}</span>
        </button>
      ))}
    </div>
  );
}

const SETUP_FONTS = ["modern", "editorial", "classic"] as const;
const SETUP_SIZES: [number, string][] = [[13, "Smaller"], [14, "Standard"], [16, "Larger"]];

/** Typeface and text size, the two other things people want to set before they start. */
export function TypeChoices() {
  const [a, set] = useAppearance();
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="look-row">
        <span className="small muted" style={{ minWidth: 70 }}>Typeface</span>
        <div className="ap-seg" role="radiogroup" aria-label="Typeface">
          {SETUP_FONTS.map((id) => {
            const f = FONTS.find((x) => x.id === id)!;
            return <button key={id} type="button" role="radio" aria-checked={a.font === id} style={{ fontFamily: f.display }} onClick={() => set({ font: id })}>{f.label}</button>;
          })}
        </div>
      </div>
      <div className="look-row">
        <span className="small muted" style={{ minWidth: 70 }}>Text size</span>
        <div className="ap-seg" role="radiogroup" aria-label="Text size">
          {SETUP_SIZES.map(([px, label]) => (
            <button key={px} type="button" role="radio" aria-checked={a.size === px} style={{ fontSize: px }} onClick={() => set({ size: px })}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
