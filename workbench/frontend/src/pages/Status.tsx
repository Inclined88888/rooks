import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, ErrorState, Loading, Page, Section } from "../ui";
import { errorText } from "../ui/toast";
import { relTime } from "../util";
import { Advanced, Notice, SettingRow, SettingsGroup } from "./settings";

// Health of every moving part (backend health.py). Checked only when this page asks: no background probes (R8).
type Check = { name: string; kind: string; status: "ok" | "degraded" | "down" | "off"; detail: string; latency_ms: number };
type Report = { status: "ok" | "degraded" | "down"; checked_at: string; checks: Check[] };
type Host = { host: string; effect: "local" | "external"; components: string; requests: number; failures: number; last: string };
type Egress = { hours: number; local_only: boolean; external_requests: number; hosts: Host[] };
type Doctor = { models_connected: number; browser_ready: boolean; computer_ready: boolean; mail_accounts: number; docker_required: boolean; notes: string[] };

const TONE = { ok: "ok", degraded: "warn", down: "danger", off: "neutral" } as const;
const LABEL = { ok: "Working", degraded: "Degraded", down: "Down", off: "Not set up" } as const;
const GROUPS: [string, string][] = [["core", "The app"], ["model connection", "Model connections"], ["add-on", "Add-ons"], ["integration", "Integrations"]];

export default function Status() {
  const [report, setReport] = useState<Report | null>(null);
  const [egress, setEgress] = useState<Egress | null>(null);
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = (fresh: boolean) => {
    setBusy(true);
    api<Report>(`/health${fresh ? "?fresh=true" : ""}`)
      .then((r) => { setReport(r); setError(""); })
      .catch((e) => setError(errorText(e)))
      .finally(() => {
        setBusy(false);
        api<Egress>("/egress?hours=24").then(setEgress).catch(() => setEgress(null)); // after the probes, so they are counted
        api<Doctor>("/connections/doctor").then(setDoctor).catch(() => setDoctor(null));
      });
  };
  useEffect(() => load(false), []);

  const external = egress?.hosts.filter((h) => h.effect === "external").length ?? 0;
  return (
    <Page title="System status" className="st-page"
      description="Each part is checked when you open this page or press Check again, never in the background. Paid search services are not checked."
      actions={<Button icon={<RefreshCw size={15} />} busy={busy} onClick={() => load(true)}>{busy ? "Checking…" : "Check again"}</Button>}>
      {error && !report && <ErrorState title="The check did not finish" line={error} onRetry={() => load(true)} />}
      {!report && !error && <Loading rows={4} label="Checking each part" />}
      {report && (
        <>
          <div className="st-stack">
            {error && <Notice tone="danger">{error}</Notice>}
            <Notice tone={report.status === "ok" ? "ok" : report.status === "down" ? "danger" : "neutral"}>
              {report.status === "ok" ? "Everything that is set up is working." : report.status === "down" ? "Something is down. Details below." : "Working, with problems. Details below."}
              {" "}<span className="st-muted">Checked {relTime(report.checked_at)}.</span>
            </Notice>
          </div>
          {GROUPS.map(([kind, title]) => {
            const rows = report.checks.filter((c) => c.kind === kind);
            if (!rows.length) return null;
            return (
              <Section key={kind} title={title}>
                <SettingsGroup label={title}>
                  {rows.map((c) => (
                    <div key={c.name} className="st-item">
                      <div className="st-item-text">
                        <span className="st-item-title">{c.name}</span>
                        {c.detail && <span className="st-item-meta">{c.detail}</span>}
                      </div>
                      <span className="st-item-actions">
                        {c.latency_ms > 0 && <span className="st-small">{c.latency_ms} ms</span>}
                        <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                      </span>
                    </div>
                  ))}
                </SettingsGroup>
              </Section>
            );
          })}
        </>
      )}
      {doctor && (
        <Section title="Connections">
          <SettingsGroup>
            <SettingRow label="Models" help={`${doctor.models_connected} connection${doctor.models_connected === 1 ? "" : "s"}`} />
            <SettingRow label="Browser" help={doctor.browser_ready ? "Ready" : "Off"} />
            <SettingRow label="Computer" help={doctor.computer_ready ? "Ready" : "Off"} />
            <SettingRow label="Mail" help={`${doctor.mail_accounts} account${doctor.mail_accounts === 1 ? "" : "s"}${doctor.docker_required ? "" : " · Docker is not required"}`} />
            {doctor.notes.map((n) => <div key={n} className="st-row"><p className="st-small">{n}</p></div>)}
          </SettingsGroup>
        </Section>
      )}
      {egress && (
        <Section title={`What left this computer, last ${egress.hours} hours`}
          description="From the log of every connection the app makes. Pages the browser add-on visits are listed in its own job steps, not here.">
          <div className="st-stack">
            <Notice tone={egress.local_only ? "ok" : "neutral"}>
              {egress.local_only
                ? "Local only: nothing was sent beyond this computer or your home network."
                : `${egress.external_requests} requests went to the internet, to ${external} place${external === 1 ? "" : "s"}.`}
            </Notice>
            {egress.hosts.length > 0 && (
              <Advanced label={`Advanced: the ${egress.hosts.length} address${egress.hosts.length === 1 ? "" : "es"}`}>
                <SettingsGroup label="Addresses">
                  {egress.hosts.map((h) => (
                    <div key={`${h.host}-${h.effect}`} className="st-item">
                      <div className="st-item-text">
                        <span className="st-item-title st-mono">{h.host}</span>
                        <span className="st-item-meta">from {h.components.split(",").join(", ")} · {h.requests} requests{h.failures ? `, ${h.failures} failed` : ""} · last {relTime(h.last)}</span>
                      </div>
                      <span className="st-item-actions"><Badge tone={h.effect === "external" ? "warn" : "neutral"}>{h.effect === "external" ? "Internet" : "Local"}</Badge></span>
                    </div>
                  ))}
                </SettingsGroup>
              </Advanced>
            )}
          </div>
        </Section>
      )}
    </Page>
  );
}
