import { LineChart } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { EmptyState, ErrorState, Loading, Page, Section, Stat, Tabs } from "../ui";
import { errorText } from "../ui/toast";
import { SettingRow, SettingsGroup } from "./settings";

// Phase 3: trends from the run log (GET /api/usage/daily). Zero dependencies: bars are plain SVG.
type Day = { day: string; calls: number; failures: number; tokens_in: number; tokens_out: number; usd: number | null; unpriced: number; avg_ms: number; p95_ms: number };
type Provider = { provider: string; calls: number; failures: number; avg_ms: number | null };
type Daily = { days: Day[]; providers: Provider[]; channels: { channel: string; calls: number }[];
  totals: { calls: number; failures: number; tokens_in: number; tokens_out: number; unpriced: number; usd: number | null } };

const money = (v: number | null) => (v === null ? "unpriced" : v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");

function Bars({ days, value, fmt, danger, label }: { days: Day[]; value: (d: Day) => number; fmt: (n: number) => string; danger?: (d: Day) => number; label: string }) {
  const max = Math.max(1, ...days.map(value));
  const w = 100 / days.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="st-bars" role="img" aria-label={label}>
      {days.map((d, i) => {
        const h = (value(d) / max) * 38;
        const bad = danger ? Math.min(h, (danger(d) / max) * 38) : 0;
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${fmt(value(d))}${danger && danger(d) ? ` (${danger(d)} failed)` : ""}`}</title>
            <rect className="st-bar" x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={h} />
            {bad > 0 && <rect className="st-bar is-failed" x={i * w + w * 0.15} y={40 - bad} width={w * 0.7} height={bad} />}
          </g>
        );
      })}
    </svg>
  );
}

function Chart({ title, days, value, fmt, danger, note }: { title: string; days: Day[]; value: (d: Day) => number; fmt: (n: number) => string; danger?: (d: Day) => number; note?: string }) {
  const last = days[days.length - 1];
  return (
    <div className="st-chart">
      <div className="st-chart-head"><span className="st-chart-title">{title}</span><span className="st-small">today {fmt(value(last))}</span></div>
      <Bars days={days} value={value} fmt={fmt} danger={danger} label={`${title}, ${days.length} days`} />
      <div className="st-chart-axis"><span>{days[0].day}</span><span>{last.day}</span></div>
      {note && <p className="st-small">{note}</p>}
    </div>
  );
}

const RANGES = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }];

export default function Insights() {
  const [range, setRange] = useState(30);
  const [data, setData] = useState<Daily | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setError("");
    setData(null);
    api<Daily>(`/usage/daily?days=${range}`).then(setData).catch((e) => setError(errorText(e)));
  }, [range, tick]);
  const t = data?.totals;
  return (
    <Page title="Insights" wide className="st-page"
      description="How your models have been doing: calls, failures, speed and cost per day, from the run log."
      actions={<Tabs label="Range" size="sm" items={RANGES} value={String(range)} onChange={(id) => setRange(Number(id))} />}>
      {error && <ErrorState title="Insights did not load" line={error} onRetry={() => setTick((n) => n + 1)} />}
      {!data && !error && <Loading rows={4} label="Loading insights" />}
      {data && t && !t.calls && <EmptyState icon={<LineChart size={22} />} title="Nothing to chart yet" line="Chat with the assistant and its model calls show up here." />}
      {data && t && t.calls > 0 && (
        <div className="st-stack st-gap-lg">
          <div className="st-stats">
            <Stat label="Model calls" value={t.calls.toLocaleString()} />
            <Stat label="Failed" value={t.failures.toLocaleString()} hint={`${pct(t.failures, t.calls)} of calls`} />
            <Stat label="Tokens" value={(t.tokens_in + t.tokens_out).toLocaleString()} />
            <Stat label="Cost" value={money(t.usd)} hint={t.unpriced > 0 ? `+ ${t.unpriced} unpriced calls` : undefined} />
          </div>
          <div className="st-charts">
            <Chart title="Calls per day" days={data.days} value={(d) => d.calls} fmt={(n) => `${n} calls`} danger={(d) => d.failures} note="Red: calls that failed (the router may have answered from another provider)." />
            <Chart title="Tokens per day" days={data.days} value={(d) => d.tokens_in + d.tokens_out} fmt={(n) => n.toLocaleString()} />
            <Chart title="Cost per day" days={data.days} value={(d) => d.usd ?? 0} fmt={(n) => money(n)} note="Local and unknown-price models count as unpriced, not free." />
            <Chart title="Slowest typical answer" days={data.days} value={(d) => d.p95_ms} fmt={secs} note="95% of successful calls that day were faster than this." />
          </div>
          <div className="st-charts">
            <Section title="Providers">
              <SettingsGroup label="Providers">
                {data.providers.map((p) => (
                  <SettingRow key={p.provider || "?"} label={p.provider || "unknown"} help={`${p.calls} calls · ${pct(p.failures, p.calls)} failed${p.avg_ms ? ` · avg ${secs(p.avg_ms)}` : ""}`} />
                ))}
              </SettingsGroup>
            </Section>
            <Section title="Where calls come from">
              <SettingsGroup label="Where calls come from">
                {data.channels.map((c) => <SettingRow key={c.channel || "?"} label={c.channel || "other"} help={`${c.calls} calls`} />)}
              </SettingsGroup>
            </Section>
          </div>
        </div>
      )}
    </Page>
  );
}
