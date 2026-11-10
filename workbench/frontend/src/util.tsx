import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { MouseEvent, useEffect, useRef, useState } from "react";
import { api, Model } from "./api";
import { MERMAID_RE, renderMarkdownHtml, unesc } from "./markdown";

// In non-browser contexts (tests) dompurify's default export is a factory whose product needs a real
// DOM window; without one it stays a bare function with no sanitize/addHook. Treat that as "no purifier".
const _dp: unknown = DOMPurify;
const _made = typeof _dp === "function" ? (_dp as (w?: unknown) => Partial<typeof DOMPurify>)() : _dp;
const purify: typeof DOMPurify | null = typeof (_made as Partial<typeof DOMPurify>)?.sanitize === "function" ? (_made as typeof DOMPurify) : null;

// highlight.js CSS classes are token classes, not raw styles — keep them through sanitization.
purify?.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class" && data.attrValue.includes("hljs")) data.forceKeepAttr = true;
});

// Mermaid is ~500 kB min: load it only when a mermaid block actually appears, and only once.
type MermaidApi = typeof import("mermaid")["default"];
let mermaidP: Promise<MermaidApi> | null = null;
const loadMermaid = () => (mermaidP ??= import("mermaid").then((m) => m.default));

/** The diagram in the app's language (the industrial redesign): white boxes with an ink edge, ink words and lines,
 *  grey for what is secondary, the one orange for notes and highlights; square, thin lines. Mermaid works its other
 *  colours out from these with colour maths, so it gets the theme's real colours (read from the tokens when a diagram
 *  is drawn, so a diagram drawn after a theme change follows it), never var() strings it cannot parse. */
function mermaidTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const ink = v("--color-ink", "#111111");
  const surface = v("--color-surface", "#FFFFFF");
  const muted = v("--color-surface-muted", "#EDEDEA");
  const line = v("--color-border", "#D8D8D5");
  const grey = v("--color-ink-muted", "#5A5A57");
  const accent = v("--color-accent", "#FF4D00");
  // pies: the share is written on each slice in one colour, so the slices are light (the orange, greys, white), each
  // outlined in ink, with ink words: AA on every slice in every theme (tokens.css --color-pie-*)
  const pieInk = v("--color-pie-ink", "#111111");
  const pie = [1, 2, 3, 4, 5].map((i) => v(`--color-pie-${i}`, ["#FF4D00", "#A6A6A2", "#C1C1BD", "#DEDEDA", "#FFFFFF"][i - 1]));
  // mermaid takes twelve slice colours; after five they repeat
  const pies = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`pie${i + 1}`, pie[i % pie.length]]));
  const variables = {
    fontFamily: v("--font-sans", "sans-serif"),
    background: surface,
    primaryColor: surface, primaryBorderColor: ink, primaryTextColor: ink,
    secondaryColor: muted, secondaryBorderColor: grey, secondaryTextColor: ink,
    tertiaryColor: surface, tertiaryBorderColor: line, tertiaryTextColor: ink,
    lineColor: ink, textColor: ink, titleColor: ink,
    mainBkg: surface, nodeBorder: ink, clusterBkg: muted, clusterBorder: line,
    edgeLabelBackground: surface, noteBkgColor: surface, noteBorderColor: accent, noteTextColor: ink,
    actorBkg: surface, actorBorder: ink, actorTextColor: ink, signalColor: ink, signalTextColor: ink,
    // solid slices: mermaid's default 0.7 opacity would blend each fill with the page and drop its words under AA
    ...pies, pieOpacity: "1", pieStrokeColor: pieInk, pieStrokeWidth: "1px", pieOuterStrokeColor: ink, pieOuterStrokeWidth: "1px",
    pieSectionTextColor: pieInk, pieTitleTextColor: ink, pieLegendTextColor: ink,
  };
  // thin lines, square boxes
  const themeCSS = "rect, polygon, path.basic, .node rect, .cluster rect { stroke-width: 1px; } .node rect, .cluster rect { rx: 0; ry: 0; } .flowchart-link, .edgePath .path { stroke-width: 1px; }"
    // the legend's swatches outlined, so the white one shows on a white card (mermaid writes the swatch's stroke inline)
    + ` .legend rect { stroke: ${ink} !important; stroke-width: 1px; }`;
  return { variables, themeCSS };
}

// Mermaid keeps one configuration: it is set once, and again only when the theme's colours have changed since (a
// diagram drawn after a switch to dark follows it).
let mermaidReady: Promise<MermaidApi> | null = null;
let mermaidKey = "";
function initMermaid(): Promise<MermaidApi> {
  return (mermaidReady ??= loadMermaid()).then((m) => {
    const theme = mermaidTheme();
    const key = JSON.stringify(theme);
    if (key !== mermaidKey) {
      mermaidKey = key;
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: theme.variables,
        themeCSS: theme.themeCSS,
      });
    }
    return m;
  });
}

/** A ```mermaid fence rendered as an SVG diagram. Falls back to the escaped source when the source is
 *  incomplete (still streaming) or invalid. SVG is sanitized before insertion (mermaid emits raw markup). */
export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const el = ref.current;
    if (!el) return;
    setFailed(false);
    initMermaid()
      .then((m) => m.parse(code, { suppressErrors: true }).then((ok) => {
        if (ok === false) throw new Error("invalid mermaid source");
        return m.render(`mmd-${Math.random().toString(36).slice(2)}`, code);
      }))
      .then(({ svg }) => {
        if (live && ref.current) ref.current.innerHTML = purify ? purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) : svg;
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [code]);
  if (failed) return <div className="mermaid-fallback"><pre>{code}</pre></div>;
  return <div className="mermaid-diagram" ref={ref} aria-label="Diagram" />;
}

// Maths support ($$...$$ and $...$ via KaTeX) is registered in ./markdown alongside the code renderer.

function onCopyClick(e: MouseEvent<HTMLDivElement>) {
  const btn = (e.target as HTMLElement).closest(".code-copy");
  if (!btn) return;
  const code = btn.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
  navigator.clipboard?.writeText(code).then(() => {
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1600);
  }).catch(() => undefined);
}

// Splits sanitized HTML on the mermaid placeholders so those blocks become live <MermaidBlock/> components.
// Marked keeps the raw text of an unclosed trailing fence out of the output until the fence closes, so a
// half-typed ```mermaid block mid-stream renders nothing until it is complete — then the diagram appears.
// (MERMAID_RE and unesc come from ./markdown.)

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const raw = renderMarkdownHtml(text);
  const html = purify ? purify.sanitize(raw) : raw; // purify is only null in DOM-less tests
  const parts = html.split(MERMAID_RE);
  if (parts.length === 1) return <div className={`prose ${className}`} onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className={`prose ${className}`} onClick={onCopyClick}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <MermaidBlock key={i} code={unesc(part)} />
          : <div key={i} dangerouslySetInnerHTML={{ __html: part }} />)}
    </div>
  );
}

export function Skeleton({ w = "100%", h = 12, style }: { w?: number | string; h?: number; style?: React.CSSProperties }) {
  return <span className="skeleton" aria-hidden="true" style={{ width: w, height: h, ...style }} />;
}

/** Placeholder rows while a list loads. */
export function SkeletonList({ rows = 4, avatar = false }: { rows?: number; avatar?: boolean }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          {avatar && <Skeleton w={18} h={18} style={{ flex: "none" }} />}
          <div className="grow col" style={{ gap: 7 }}>
            <Skeleton w={`${62 - ((i * 13) % 30)}%`} h={11} />
            <Skeleton w={`${34 - ((i * 7) % 14)}%`} h={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  const [defaultRef, setDefaultRef] = useState("");
  const [loading, setLoading] = useState(true);
  const load = (fresh = false) => {
    setLoading(true);
    api<{ models: Model[]; default: string }>(`/models${fresh ? "?fresh=true" : ""}`)
      .then((r) => {
        setModels(r.models);
        setDefaultRef(r.default);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);
  return { models, defaultRef, loading, reload: load };
}

export function ModelSelect({
  value,
  onChange,
  models,
  allowDefault = true,
  emptyLabel = "Default model",
}: {
  value: string;
  onChange: (v: string) => void;
  models: Model[];
  allowDefault?: boolean;
  emptyLabel?: string;
}) {
  const groups = new Map<string, Model[]>();
  models.forEach((m) => groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]));
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Model">
      {allowDefault && <option value="">{emptyLabel}</option>}
      {[...groups.entries()].map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.label || (m.model === "default" ? "Recommended (the plan's default)" : m.model)}{m.free ? "  (free)" : ""}{reliabilityLabel(m)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** How hard a plan's model thinks (Claude, ChatGPT and Copilot plans). The same four levels as the rooks terminal's
 *  /effort, remembered on this device. Shown only when the chosen model is a plan. */
export const EFFORT_LEVELS: [string, string][] = [["", "Thinking: auto"], ["low", "Thinking: low (quick)"], ["medium", "Thinking: medium"], ["high", "Thinking: high (hard problems)"]];

export function useEffort(): [string, (v: string) => void] {
  const [effort, setEffort] = useState(() => localStorage.getItem("aiw.effort") || "");
  return [effort, (v: string) => { localStorage.setItem("aiw.effort", v); setEffort(v); }];
}

export function EffortSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="input effort-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="How hard the plan's model thinks" title="How hard the plan's model thinks">
      {EFFORT_LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

// Measured on this workspace (receipts.py): share of tool calls that worked and passed their check
export function reliabilityLabel(m: Model): string {
  const r = m.reliability;
  if (!r || !r.calls || r.success_rate === null) return "";
  return `  · ${Math.round(r.success_rate * 100)}% of ${r.calls} tool calls ok`;
}

export function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function localDateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** One toast stack for the app (ui/toast.ts): pages call useToast() and the stack mounted once in the shell shows it;
 *  only the ask bar, which has no shell, renders toast.node itself. */
export { useToast } from "./ui";

export function Empty({ icon, title, hint, hero = false, children }: { icon?: React.ReactNode; title: string; hint?: string; hero?: boolean; children?: React.ReactNode }) {
  return (
    <div className={`empty ${hero ? "hero" : ""}`}>
      {icon && <div className="empty-icon" aria-hidden="true">{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="muted">{hint}</div>}
      {children}
    </div>
  );
}

/** What the smart router reports with each answer (router.py). */
export type RouterQuota = {
  used_today: number; free: boolean; resets_at: string; note?: string; limit?: number; remaining?: number | null;
  window?: "day" | "minute"; estimated?: boolean; cooling_until?: string; cooling_reason?: string;
};
export type RouterInfo = {
  provider: string; label?: string; model: string; tier: "fast" | "strong"; subscription?: boolean;
  fallbacks: { provider: string; model: string; reason: string }[]; quota?: RouterQuota;
  resting?: { provider: string; reason: string; until: string }[];
};

const n = (x: number) => x.toLocaleString();

export function resetTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "812 of 1,000 free requests left today", or the honest fallback when the provider doesn't say. */
export function quotaText(q?: RouterQuota, subscription?: boolean): string {
  if (!q) return "";
  if (subscription) return "on your plan";
  if (q.limit != null && q.remaining != null && q.window === "day")
    return `${q.estimated ? "about " : ""}${n(q.remaining)} of ${n(q.limit)}${q.free ? " free" : ""} requests left today`;
  if (q.limit != null && q.remaining != null) return `${n(q.used_today)} used today · ${n(q.remaining)} of ${n(q.limit)} left this minute`;
  return `${n(q.used_today)} used today${q.free ? " · free tier" : ""}`;
}

/** The "via" line under an answer: who answered, how much free quota is left, and what was skipped. */
export function RouterVia({ r }: { r: RouterInfo }) {
  const short = r.model.split("/").pop();
  return (
    <div className="via" title={r.quota?.note || undefined}>
      <span className="via-who">via <b>{r.provider}</b> · {short}</span>
      <span className="via-tier">{r.tier}</span>
      {r.quota && <span className="via-quota">{quotaText(r.quota, r.subscription)}</span>}
      {r.fallbacks.map((f, i) => (
        <span key={i} className="via-skip">{f.provider} {f.reason}{f.reason === "daily limit reached" ? ", switched" : ", skipped"}</span>
      ))}
      {(r.resting || []).map((x, i) => (
        <span key={`r${i}`} className="via-skip">{x.provider} resting until {resetTime(x.until)} ({x.reason})</span>
      ))}
    </div>
  );
}
