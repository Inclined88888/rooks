import { ArrowLeft, ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, EmptyState, ErrorState, List, Loading, Page, Row, Select, Stat, Tabs } from "../ui";
import { errorText } from "../ui/toast";
import { relTime } from "../util";
import { ButtonLink, Notice } from "./settings/index";

// One row of the run log (backend actions.py). Text fields are already redacted on the server.
type Action = {
  id: number; ts: string; kind: "turn" | "model_call" | "tool_call" | "decision"; channel: string; conversation_id: number | null;
  provider: string; model: string; auth_kind: string; protocol: string; tool: string; effect: string; args: string;
  latency_ms: number; tokens_in: number; tokens_out: number; usd_cost: number | null; outcome: string; failure_reason: string;
  verified: number | null; evidence: string; detail: string; from_text: number; request_id: string; parent_action_id: number | null;
};
type Totals = { steps: number; model_calls: number; tool_calls: number; total_tokens_in: number; total_tokens_out: number; total_usd: number | null; unpriced: number; failures: number };
type Run = Action & Totals & { conversation_title: string | null };
type Node = Action & { children: Node[] };

const GOOD = new Set(["ok", "verified", "backed", "fixed", "no_claim", "approved"]);
const PENDING = new Set(["running", "held", "duplicate"]);
const tone = (o: string): "ok" | "warn" | "danger" => (GOOD.has(o) ? "ok" : PENDING.has(o) ? "warn" : o === "budget_paused" ? "warn" : "danger");
const usd = (v: number | null, unpriced = 0) => (v === null ? (unpriced ? "price unknown" : "$0") : `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}${unpriced ? " + unpriced" : ""}`);
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const KIND = { turn: "Turn", model_call: "Model call", tool_call: "Tool call", decision: "Your decision" };

function title(r: Run) {
  if (r.kind === "turn") return r.conversation_title || (r.channel?.startsWith("cli:") && r.args) || `Turn #${r.id}`;
  return `${KIND[r.kind]} · ${r.channel || "unknown"}`;
}

const WORD: Record<string, string> = {
  ok: "Done", verified: "Verified", backed: "Backed up", fixed: "Fixed", no_claim: "Done", approved: "Approved", running: "Running", held: "Waiting for you",
  duplicate: "Duplicate", budget_paused: "Paused for budget", failed: "Failed", error: "Failed", denied: "Denied", contradicted: "Contradicted",
};
const word = (o: string) => WORD[o] ?? o.replace(/_/g, " ");

export default function Runs() {
  const { id } = useParams();
  return id ? <Trace id={Number(id)} /> : <RunList />;
}

function RunList() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [channel, setChannel] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const load = (before?: number) => {
    setLoading(true);
    const q = new URLSearchParams({ limit: "50", ...(channel && { channel }), ...(failed && { failed: "true" }), ...(before && { before: String(before) }) });
    api<{ runs: Run[]; channels: string[] }>(`/runs?${q}`)
      .then((r) => {
        setRuns((prev) => (before ? [...prev, ...r.runs] : r.runs));
        setChannels(r.channels);
        setMore(r.runs.length === 50);
        setError("");
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), [channel, failed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page title="Run log" wide className="st-page"
      description="Every turn and model call, with the tool calls and approvals under it. Secrets are removed before anything is stored."
      actions={
        <div className="st-filters">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Where it ran">
            <option value="">Everywhere</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Tabs label="Show" size="sm" items={[{ id: "all", label: "All" }, { id: "failed", label: "With failures" }]} value={failed ? "failed" : "all"} onChange={(id) => setFailed(id === "failed")} />
        </div>
      }>
      {error && !runs.length && <ErrorState title="The run log did not load" line={error} onRetry={() => load()} />}
      {error && runs.length > 0 && <Notice tone="danger">{error}</Notice>}
      {!loading && !runs.length && !error && <EmptyState icon={<ListTree size={22} />} title="No runs yet" line={failed ? "Nothing failed." : "Chat with the assistant and its runs appear here."} />}
      {loading && !runs.length && <Loading rows={5} label="Loading the run log" />}
      {runs.length > 0 && (
        <List label="Runs">
          {runs.map((r) => (
            <Row key={r.id} onClick={() => navigate(`/runs/${r.id}`)}
              leading={<Badge tone={tone(r.outcome)}>{word(r.outcome)}</Badge>}
              title={<>{title(r)}<span className="sr-only">, {word(r.outcome)}</span></>}
              meta={`${r.channel || "no channel"} · ${r.model || "no model"} · ${r.model_calls} model / ${r.tool_calls} tool calls${r.failures ? ` · ${r.failures} failed` : ""} · ${usd(r.total_usd, r.unpriced)} · ${relTime(r.ts)}${r.latency_ms ? ` · ${secs(r.latency_ms)}` : ""}`} />
          ))}
        </List>
      )}
      <div className="st-more">
        {loading && runs.length > 0 && <span className="st-small" role="status">Loading older runs…</span>}
        {more && !loading && <Button onClick={() => load(runs[runs.length - 1].id)}>Load older runs</Button>}
      </div>
    </Page>
  );
}

function Trace({ id }: { id: number }) {
  const [run, setRun] = useState<(Node & Totals & { conversation_title: string | null }) | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setRun(null);
    setError("");
    api<Node & Totals & { conversation_title: string | null }>(`/runs/${id}`).then(setRun).catch((e) => setError(errorText(e)));
  }, [id, tick]);

  const back = <ButtonLink variant="ghost" size="sm" to="/runs" icon={<ArrowLeft size={14} />}>Run log</ButtonLink>;
  if (!run) {
    return (
      <Page title="Run" kicker="Run log" className="st-page" actions={back}>
        {error ? <ErrorState title="This run did not load" line={error} onRetry={() => setTick((n) => n + 1)} /> : <Loading rows={4} label="Loading the run" />}
      </Page>
    );
  }
  return (
    <Page title={run.kind === "turn" ? title(run) : `${KIND[run.kind]} #${run.id}`} kicker="Run log" wide className="st-page" actions={back}
      description={<>{new Date(run.ts).toLocaleString()} · {run.channel || "no channel"}{run.conversation_id && <> · <Link className="st-link" to={`/assistant/${run.conversation_id}`}>open conversation</Link></>}</>}>
      <div className="st-stack st-gap-lg">
        <div className="st-stats is-three">
          <Stat label="Outcome" value={word(run.outcome)} tone={tone(run.outcome) === "ok" ? "neutral" : tone(run.outcome)} hint={run.failures ? `${run.failures} failed ${run.failures === 1 ? "step" : "steps"}` : undefined} />
          <Stat label="Cost" value={usd(run.total_usd, run.unpriced)} hint={`${run.total_tokens_in.toLocaleString()} in · ${run.total_tokens_out.toLocaleString()} out`} />
          <Stat label="Steps" value={`${run.model_calls + run.tool_calls}`} hint={`${run.model_calls} model · ${run.tool_calls} tool${run.latency_ms ? ` · ${secs(run.latency_ms)} total` : ""}`} />
        </div>
        <div className="st-trace">
          <TraceNode node={run} depth={0} />
        </div>
      </div>
    </Page>
  );
}

function TraceNode({ node, depth }: { node: Node; depth: number }) {
  const [open, setOpen] = useState(node.outcome !== "ok" && node.outcome !== "verified" && depth > 0);
  const label = node.kind === "tool_call" ? node.tool : node.kind === "model_call" ? node.model : node.kind === "decision" ? `${node.outcome} ${node.tool}` : node.model || "no model";
  const facts: [string, string][] = [
    ["Provider", node.provider && `${node.provider} (${node.auth_kind}, ${node.protocol})`],
    ["Effect", node.effect],
    ["Arguments", node.args],
    ["Failure", node.failure_reason],
    ["Receipt", node.evidence + (node.verified === 0 ? " (contradicted)" : node.verified === 1 ? " (confirmed)" : "")],
    ["Detail", node.detail],
    ["Recovered from text", node.from_text ? "yes: the model wrote this call as text, not as a tool call" : ""],
    ["Request id", node.request_id],
  ].filter(([, v]) => v && v.trim()) as [string, string][];
  const indent = depth ? ` st-depth-${Math.min(depth, 4)}` : "";
  return (
    <>
      <button type="button" className={`st-trace-row${indent}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Badge>{KIND[node.kind]}</Badge>
        <span className="st-trace-label">{label}</span>
        <Badge tone={tone(node.outcome)}>{word(node.outcome)}</Badge>
        <span className="st-trace-meta">
          {node.latency_ms ? secs(node.latency_ms) : ""}
          {node.kind === "model_call" ? ` · ${node.tokens_in}/${node.tokens_out} tokens · ${usd(node.usd_cost, node.usd_cost === null ? 1 : 0)}` : ""}
        </span>
      </button>
      {open && (
        <dl className={`st-trace-facts${indent}`}>
          {facts.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd className={k === "Arguments" || k === "Request id" ? "is-mono" : ""}>{v}</dd></div>
          ))}
          {!facts.length && <p className="st-small">Nothing else recorded.</p>}
        </dl>
      )}
      {node.children.map((c) => <TraceNode key={c.id} node={c} depth={depth + 1} />)}
    </>
  );
}
