import { ArrowDown, ArrowUp, BadgeCheck, Cloud, Cpu, KeyRound, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Page, Section, Select } from "../ui";
import { errorText } from "../ui/toast";
import { quotaText, resetTime, RouterQuota, useToast } from "../util";
import { Providers } from "./Settings";
import { Advanced, Notice, SettingRow, SettingsGroup, Switch } from "./settings/index";

/** The smart router, laid out: who answers first, which model each provider uses for quick and for hard jobs,
 * and how much free quota is left. */

type Row = {
  id: number; name: string; label: string; auth_kind: string; free: boolean; in_router: boolean; disabled: boolean; local: boolean;
  fast: string | null; strong: string | null; models: string[]; quota: RouterQuota; state: string;
};
type Status = { providers: Row[]; settings: { order: number[]; disabled: number[]; models: Record<string, { fast?: string; strong?: string }>; local_fallback: boolean };
  tiers: { fast: string | null; strong: string | null } };

function kindLabel(r: Row) {
  if (r.auth_kind === "oauth_subscription") return "Your plan";
  if (r.auth_kind === "cli_subscription") return "Your plan (CLI)";
  if (r.local) return "On this computer";
  if (r.free) return "Free tier";
  return r.auth_kind === "openai_compatible" ? "Server" : "API key";
}

function Meter({ q }: { q: RouterQuota }) {
  if (q.limit == null || q.remaining == null || q.window !== "day") return null;
  const pct = Math.max(0, Math.min(100, (q.remaining / q.limit) * 100));
  return <div className="st-meter" role="img" aria-label={`${Math.round(pct)}% left`}><div style={{ width: `${pct}%` }} /></div>;
}

export default function Models() {
  const [s, setS] = useState<Status | null>(null);
  const [failed, setFailed] = useState("");
  const [def, setDef] = useState("");
  const toast = useToast();
  const load = () => api<Status>("/router").then((r) => { setS(r); setFailed(""); }).catch((e) => setFailed(errorText(e)));
  useEffect(() => {
    load();
    api<{ default: string }>("/models").then((m) => setDef(m.default)).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body: Partial<Status["settings"]>) => {
    try { setS(await api<Status>("/router", { method: "PUT", body })); } catch (e) { toast.err(e); }
  };
  const routed = s?.providers.filter((p) => !p.local || s.settings.local_fallback) ?? [];
  const move = (i: number, d: number) => {
    const ids = routed.map((p) => p.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    save({ order: ids });
  };
  const toggle = (r: Row) => save({ disabled: r.disabled ? s!.settings.disabled.filter((x) => x !== r.id) : [...s!.settings.disabled, r.id] });
  const pickModel = (r: Row, tier: "fast" | "strong", model: string) => {
    const m = { ...s!.settings.models, [String(r.id)]: { ...(s!.settings.models[String(r.id)] ?? {}), [tier]: model } };
    if (!model) delete m[String(r.id)][tier];
    save({ models: m });
  };
  const useAuto = async () => {
    try {
      await api("/settings", { method: "PUT", body: { default_model: "auto" } });
      setDef("auto");
      toast.ok("New chats use the smart router");
    } catch (e) { toast.err(e); }
  };
  const retryNow = async (r: Row) => {
    try { setS(await api<Status>(`/router/reset/${r.id}`, { method: "POST" })); } catch (e) { toast.err(e); }
  };

  return (
    <Page title="AI models" className="st-page"
      description="Connect the AI you want to use. With more than one, quick jobs go to a fast model, real work to a strong one, and when one runs out for the day the next picks up.">
      {def && !def.startsWith("auto") && (
        <div className="st-notice-gap">
          <Notice action={<Button size="sm" variant="primary" onClick={useAuto}>Use the smart router</Button>}>Chats use a fixed model right now.</Notice>
        </div>
      )}
      <Providers onChange={load} />
      <Section title="Which model does what" description="Auto handles this for you. Change the order or pin a model only if you want to.">
        {failed && !s ? <ErrorState title="The model list did not load" line={failed} onRetry={load} />
          : !s ? <Loading rows={3} label="Loading which model does what" />
          : routed.length === 0 ? <EmptyState title="Nothing connected yet" line="Sign in with a plan or paste a key above, and the models show up here." />
          : (
            <div className="st-stack">
              <div className="st-tiers">
                <div className="st-tier"><span className="st-tier-label">Quick jobs</span><span className="st-tier-model">{s.tiers.fast ?? "Nothing connected"}</span><span className="st-tier-line">Summaries, titles, memory</span></div>
                <div className="st-tier"><span className="st-tier-label">Real work</span><span className="st-tier-model">{s.tiers.strong ?? "Nothing connected"}</span><span className="st-tier-line">Chat with tools, research, browser, Rooks Code</span></div>
              </div>
              <Advanced label={`Change which model answers (${routed.length} connected)`}>
                <ol className="st-group st-routes" aria-label="Who answers first">
                  {routed.map((r, i) => (
                    <li key={r.id} className={`st-route${r.disabled ? " is-off" : ""}`}>
                      <span className="st-route-n">{i + 1}</span>
                      <div className="st-route-main">
                        <div className="st-route-head">
                          {r.auth_kind === "oauth_subscription" || r.auth_kind === "cli_subscription" ? <BadgeCheck size={15} /> : r.local ? <Cpu size={15} /> : r.free ? <Cloud size={15} /> : <KeyRound size={15} />}
                          <span className="st-plan-name">{r.name}</span>
                          <Badge tone={r.free ? "ok" : "neutral"}>{kindLabel(r)}</Badge>
                          {r.quota.cooling_until && <Badge tone="warn">Resting until {resetTime(r.quota.cooling_until)} · {r.quota.cooling_reason}</Badge>}
                          {r.state === "needs_auth" && <Badge tone="danger">Sign in again</Badge>}
                        </div>
                        <div className="st-route-models">
                          {(["fast", "strong"] as const).map((tier) => (
                            <Select key={tier} label={tier === "fast" ? "Fast" : "Strong"} value={s.settings.models[String(r.id)]?.[tier] ?? ""} onChange={(e) => pickModel(r, tier, e.target.value)} disabled={r.disabled}>
                              <option value="">{(r[tier] ?? "none").split("/").pop()} (auto)</option>
                              {r.models.map((m) => <option key={m} value={m}>{m}</option>)}
                            </Select>
                          ))}
                        </div>
                        <div className="st-route-quota">
                          <span>{quotaText(r.quota, r.auth_kind === "oauth_subscription")}</span>
                          <Meter q={r.quota} />
                          {r.free && <span>resets {resetTime(r.quota.resets_at)}</span>}
                          {r.quota.note && <span>{r.quota.note}</span>}
                        </div>
                      </div>
                      <div className="st-route-actions">
                        <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconButton>
                        <IconButton size="sm" label="Move down" disabled={i === routed.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconButton>
                        {r.quota.cooling_until && <IconButton size="sm" label="Try again now" onClick={() => retryNow(r)}><RotateCcw size={14} /></IconButton>}
                        <Switch checked={!r.disabled} onChange={() => toggle(r)} label={`Use ${r.name}`} />
                      </div>
                    </li>
                  ))}
                </ol>
                {s.providers.some((p) => p.local) && (
                  <SettingsGroup>
                    <SettingRow label="Fall back to this computer" help="Use local Ollama when every cloud provider is out.">
                      <Switch checked={s.settings.local_fallback} onChange={(on) => save({ local_fallback: on })} label="Fall back to local Ollama when every cloud provider is out" />
                    </SettingRow>
                  </SettingsGroup>
                )}
                <p className="st-small">The order is who answers first. The terminal (rooks) and the Browser agent use these same models.</p>
              </Advanced>
            </div>
          )}
      </Section>
    </Page>
  );
}
