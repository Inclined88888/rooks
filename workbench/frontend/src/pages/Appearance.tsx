import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULTS, FONTS, SIZES, useAppearance } from "../appearance";
import { ThemeGrid } from "../ThemePicker";
import { Badge, Button, Page, Presence, Section } from "../ui";
import { usePresence } from "../shell/presence";

/** One panel, five choices, all live. Nothing here needs explaining twice. */
export default function Appearance() {
  const [a, set] = useAppearance();
  const presence = usePresence();
  const [osReduced, setOsReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setOsReduced(mq.matches);
    const on = () => setOsReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const isDefault = JSON.stringify(a) === JSON.stringify(DEFAULTS);

  return (
    <Page title="Appearance" description="Changes apply straight away and are saved on this device." wide
      actions={<Button variant="ghost" size="sm" icon={<RotateCcw size={13} />} disabled={isDefault} onClick={() => set(DEFAULTS)}>Reset</Button>}>
      <div className="ap-grid">
        <div>
          <Section title="Theme">
            <ThemeGrid />
          </Section>

          <Section title="Typeface">
            <Seg label="Typeface" value={a.font} onChange={(v) => set({ font: v })} options={FONTS.map((f) => [f.id, f.label])} />
          </Section>

          <Section title="Text size" actions={<span className="mono">{a.size}px</span>}>
            <div className="row" style={{ gap: 12 }}>
              <span className="small muted" aria-hidden="true">A</span>
              <input className="ap-range" type="range" min={SIZES.min} max={SIZES.max} step={1} value={a.size} aria-label="Text size"
                onChange={(e) => set({ size: Number(e.target.value) })} />
              <span className="muted" style={{ fontSize: 20 }} aria-hidden="true">A</span>
            </div>
          </Section>

          <Section title="Spacing">
            <Seg label="Spacing" value={a.density} onChange={(v) => set({ density: v })}
              options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} />
          </Section>

          <Section title="Motion">
            <Seg label="Motion" value={a.motion} onChange={(v) => set({ motion: v })} options={[["full", "On"], ["off", "Off"]]} />
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              {osReduced ? "Your computer asks for reduced motion, so nothing fades whatever you pick here."
                : a.motion === "full" ? "Menus, sheets and new rows fade in quickly. Nothing slides, bounces or glows."
                : "Nothing moves. Things appear and disappear at once."}
            </p>
          </Section>
        </div>

        <aside className="ap-preview" aria-label="Preview">
          <p className="label">Preview</p>
          <div className="frame">
            {/* the shell's own parts, so what you pick is what you get: the presence line, a heading, the buttons, the composer */}
            <Presence className="ap-presence" name={presence.name} mood="working" doing="Reading 3 emails" needsYou={2} onNeedsYou={() => undefined} />
            <h2>Good morning.</h2>
            <p className="muted" style={{ margin: 0 }}>Three tasks are due and the Smith St quote is waiting for your OK. Want a plan for today?</p>
            <div className="row">
              <Button size="sm" variant="primary">Plan my day</Button>
              <Button size="sm" variant="secondary">Later</Button>
              <Badge tone="live">Live</Badge>
            </div>
            <div className="composer">
              <div className="fake-input">Ask anything…</div>
            </div>
          </div>
        </aside>
      </div>
    </Page>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}
