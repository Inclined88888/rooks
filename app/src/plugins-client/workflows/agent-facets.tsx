'use client';

/**
 * "Agent" display mode (PRD §5.3, §8.3 — capture 1): the selected agent node
 * in the middle, its facets around it. Same data as the graph, another layout:
 * facets are projections of the node and its neighbours, never nodes of the
 * definition.
 */
import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { AlertTriangle, BookOpen, Bot, CalendarClock, ChevronDown, GitFork, MessageSquare, Radio, Wand2, Wrench } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useColorScheme } from '@/components/theme-provider';
import { formatDuration, formatTokens, type RunNode, type TraceSpan, type WorkflowDefinition, type WorkflowNode } from './types';

type FacetRow = { text: string; sub?: string };
type FacetData = { title: string; icon: React.ComponentType<{ className?: string }>; rows: FacetRow[]; empty: string; warning?: string; side: 'left' | 'right' };
type CenterData = { name: string; summary: string; instructions: string; meta: string[]; run?: RunNode };
type FacetNode = Node<FacetData, 'facet'>;
type CenterNode = Node<CenterData, 'center'>;
type AnyNode = FacetNode | CenterNode;

const HIDDEN_HANDLE = '!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent';
const FIT = { padding: 0.15 } as const;

function FacetCard({ data }: NodeProps<FacetNode>) {
  const Icon = data.icon;
  return (
    <div className="w-[264px] rounded-xl border border-border bg-card shadow-sm">
      <Handle type="target" position={Position.Left} id="in" className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} id="out" className={HIDDEN_HANDLE} />
      <header className="flex items-center gap-2 rounded-t-xl bg-muted/40 px-3 py-1.5">
        <ChevronDown className="size-3 text-muted-foreground" />
        <span className="text-[12px] font-semibold">{data.title}</span>
        {data.warning && <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.12)] px-1.5 py-px text-[10px] text-[hsl(var(--warning))]"><AlertTriangle className="size-2.5" />{data.warning}</span>}
      </header>
      <div className="p-2">
        {data.rows.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] text-muted-foreground">{data.empty}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 overflow-hidden rounded-md border border-border/60 bg-background/50 py-0.5">
            {data.rows.map((row, index) => (
              <li key={index} className="flex items-center gap-2 px-2 py-1.5">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{row.text}</span>
                  {row.sub && <span className="block truncate text-[10px] text-muted-foreground">{row.sub}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CenterCard({ data }: NodeProps<CenterNode>) {
  const run = data.run;
  return (
    <div className="w-[300px] rounded-xl border border-primary/40 bg-card shadow-[0_8px_24px_-10px_hsl(var(--primary)/0.35)]">
      <Handle type="target" position={Position.Left} id="in" className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} id="out" className={HIDDEN_HANDLE} />
      <header className="flex items-center gap-2 rounded-t-xl bg-muted/40 px-3 py-1.5">
        <ChevronDown className="size-3 text-muted-foreground" />
        <span className="text-[12px] font-semibold">{t('workflows.facets.agent')}</span>
        {run && <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{run.started_at ? formatDuration((run.ended_at ?? Date.now()) - run.started_at) : ''}{run.tokens_in || run.tokens_out ? ` · ${formatTokens((run.tokens_in ?? 0) + (run.tokens_out ?? 0))} tok` : ''}</span>}
      </header>
      <div className="space-y-2 p-2">
        <div className="rounded-md border border-border/60 bg-background/50 px-2.5 py-2">
          <div className="flex items-center gap-2"><Bot className="size-3.5 text-primary" /><span className="truncate text-[12.5px] font-semibold">{data.name}</span></div>
          {data.summary && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{data.summary}</p>}
          {data.meta.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{data.meta.map((item) => <span key={item} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{item}</span>)}</div>}
        </div>
        <div className="rounded-md border border-border/60 bg-background/50 px-2.5 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold"><ChevronDown className="size-3 text-muted-foreground" />{t('workflows.facets.instructions')}</div>
          <p className="mt-1 line-clamp-5 whitespace-pre-line text-[11px] leading-snug text-muted-foreground">{data.instructions || t('workflows.facets.noInstructions')}</p>
        </div>
      </div>
    </div>
  );
}

const NODE_TYPES = { facet: FacetCard, center: CenterCard };

type AgentSummary = { name: string; backend?: string; model?: string | null; skills?: string[]; mcp_servers?: string[]; allowed_tools?: string[]; memory_scope?: string };
let agentsCache: AgentSummary[] | null = null;

function useAgents(): AgentSummary[] {
  const [agents, setAgents] = useState<AgentSummary[]>(agentsCache ?? []);
  useEffect(() => {
    if (agentsCache) return;
    let cancelled = false;
    void fetch('/api/ui/agents', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : { agents: [] })).then((value: { agents?: AgentSummary[] }) => {
      agentsCache = value.agents ?? [];
      if (!cancelled) setAgents(agentsCache);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return agents;
}

const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function estimateHeight(rows: number): number {
  return 44 + Math.max(1, rows) * 34 + 16;
}

export function buildFacets(definition: WorkflowDefinition, node: WorkflowNode, agents: AgentSummary[], runNodes: RunNode[], spans: TraceSpan[]) {
  const config = node.config;
  const identity = (config.identity && typeof config.identity === 'object' ? config.identity : {}) as Record<string, unknown>;
  const ref = str(config.ref);
  const agent = ref ? agents.find((item) => item.name === ref) : undefined;
  const byId = new Map(definition.nodes.map((item) => [item.id, item]));
  const incoming = definition.edges.filter((edge) => edge.to === node.id).map((edge) => byId.get(edge.from)).filter((item): item is WorkflowNode => !!item);
  const outgoing = definition.edges.filter((edge) => edge.from === node.id).map((edge) => ({ edge, target: byId.get(edge.to) })).filter((item): item is { edge: typeof item.edge; target: WorkflowNode } => !!item.target);
  const neighbours = [...incoming, ...outgoing.map((item) => item.target)];
  const run = runNodes.filter((row) => row.node_id === node.id).sort((a, b) => b.attempt - a.attempt)[0];
  const observedChildren = spans.filter((span) => span.kind === 'spawn' && span.workflow_node_id === node.id).map((span) => span.name);

  const schedule: FacetRow[] = incoming.filter((item) => item.type === 'trigger.schedule').map((item) => ({ text: item.label || item.id, sub: `cron ${str(item.config.cron)}${item.config.tz ? ` · ${str(item.config.tz)}` : ''}` }));
  const triggers: FacetRow[] = incoming.filter((item) => item.type.startsWith('trigger.') && item.type !== 'trigger.schedule').map((item) => ({ text: item.label || item.id, sub: item.type === 'trigger.event' ? `on ${str(item.config.kind)}${item.config.filter ? ` · ${str(item.config.filter)}` : ''}` : item.type }));
  const upstream: FacetRow[] = incoming.filter((item) => !item.type.startsWith('trigger.') && !item.type.startsWith('memory.')).map((item) => ({ text: item.label || item.id, sub: item.type }));
  const memory: FacetRow[] = neighbours.filter((item) => item.type.startsWith('memory.')).map((item) => ({ text: item.label || item.id, sub: `${item.type.slice('memory.'.length)} · ${str(item.config.scope) || 'global'}${item.config.query ? ` · ${str(item.config.query)}` : ''}` }));
  if (agent?.memory_scope && agent.memory_scope !== 'NONE') memory.push({ text: t('workflows.facets.memoryScope'), sub: agent.memory_scope });
  const tools: FacetRow[] = [
    ...[...new Set([...strList(config.allowedTools), ...strList(identity.allowedTools), ...(agent?.allowed_tools ?? [])])].map((tool) => ({ text: tool })),
    ...[...new Set([...strList(config.mcpServers), ...strList(identity.mcpServers), ...(agent?.mcp_servers ?? [])])].map((server) => ({ text: server, sub: 'mcp' })),
  ];
  const subAgents: FacetRow[] = [
    ...outgoing.filter((item) => item.target.type === 'agent' || item.target.type === 'skill').map((item) => ({ text: item.target.label || item.target.id, sub: `${item.edge.fromPort} → ${str(item.target.config.ref) || t('workflows.inline')}` })),
    ...observedChildren.map((name) => ({ text: name, sub: t('workflows.facets.observed') })),
  ];
  const skills: FacetRow[] = [...new Set([...(node.type === 'skill' ? [str(config.skillId)] : []), ...strList(config.skills), ...strList(identity.skills), ...(agent?.skills ?? [])])].filter(Boolean).map((skill) => ({ text: skill }));
  const backend = str(config.backend) || str(identity.backend) || agent?.backend || '';
  const model = str(config.model) || str(identity.model) || agent?.model || '';
  const meta = [backend, model, config.completion === 'explicit' ? 'explicit' : '', typeof config.timeoutMs === 'number' ? formatDuration(config.timeoutMs) : ''].filter(Boolean);
  const name = ref ? `@${ref}` : str(identity.name) || node.label || node.id;
  const missingIdentity = !ref && !str(identity.name);

  const left: Omit<FacetData, 'side'>[] = [
    { title: t('workflows.facets.schedule'), icon: CalendarClock, rows: schedule, empty: t('workflows.facets.noSchedule') },
    { title: t('workflows.facets.triggers'), icon: Radio, rows: [...triggers, ...upstream], empty: t('workflows.facets.noTriggers') },
    { title: t('workflows.facets.channels'), icon: MessageSquare, rows: [{ text: 'workflow', sub: t('workflows.facets.channelWorkflow') }, ...(ref ? [{ text: 'web', sub: t('workflows.facets.channelChat') }] : [])], empty: '', warning: missingIdentity ? t('workflows.facets.setIdentity') : undefined },
    { title: t('workflows.facets.memory'), icon: BookOpen, rows: memory, empty: t('workflows.facets.noMemory') },
  ];
  const right: Omit<FacetData, 'side'>[] = [
    { title: t('workflows.facets.tools'), icon: Wrench, rows: tools, empty: t('workflows.facets.inherited') },
    { title: t('workflows.facets.subagents'), icon: GitFork, rows: subAgents, empty: t('workflows.facets.noSubagents') },
    { title: t('workflows.facets.skills'), icon: Wand2, rows: skills, empty: t('workflows.facets.noSkills') },
  ];
  const center: CenterData = { name, summary: node.label && node.label !== name ? node.label : '', instructions: str(identity.instructions) || (ref ? t('workflows.facets.refInstructions', { agent: ref }) : ''), meta, run };
  return { left, right, center };
}

export function AgentFacets({ definition, nodeId, runNodes, spans }: { definition: WorkflowDefinition; nodeId: string; runNodes: RunNode[]; spans: TraceSpan[] }) {
  const { scheme } = useColorScheme();
  const agents = useAgents();
  const node = definition.nodes.find((item) => item.id === nodeId);
  const { nodes, edges } = useMemo(() => {
    if (!node) return { nodes: [] as AnyNode[], edges: [] as Edge[] };
    const facets = buildFacets(definition, node, agents, runNodes, spans);
    const nodes: AnyNode[] = [];
    const edges: Edge[] = [];
    const column = (items: Omit<FacetData, 'side'>[], side: 'left' | 'right', x: number) => {
      let y = 40;
      items.forEach((item, index) => {
        const id = `${side}-${index}`;
        nodes.push({ id, type: 'facet', position: { x, y }, draggable: false, selectable: false, data: { ...item, side } });
        edges.push(side === 'left'
          ? { id: `e-${id}`, source: id, sourceHandle: 'out', target: 'center', targetHandle: 'in', style: { stroke: 'hsl(var(--muted-foreground) / 0.5)', strokeDasharray: '3 5' } }
          : { id: `e-${id}`, source: 'center', sourceHandle: 'out', target: id, targetHandle: 'in', style: { stroke: 'hsl(var(--muted-foreground) / 0.5)', strokeDasharray: '3 5' } });
        y += estimateHeight(item.rows.length) + 24;
      });
      return y;
    };
    const leftHeight = column(facets.left, 'left', 40);
    const rightHeight = column(facets.right, 'right', 820);
    nodes.push({ id: 'center', type: 'center', position: { x: 400, y: Math.max(40, Math.max(leftHeight, rightHeight) / 2 - 160) }, draggable: false, selectable: false, data: facets.center });
    return { nodes, edges };
  }, [agents, definition, node, runNodes, spans]);

  if (!node) return <div className="p-6 text-sm text-muted-foreground">{t('workflows.noAgentNode')}</div>;
  return (
    <div className={cn('wf-canvas h-full w-full')}>
      <ReactFlow proOptions={{ hideAttribution: true }} colorMode={scheme} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView fitViewOptions={FIT} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false} minZoom={0.3} maxZoom={1.6}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="hsl(var(--muted-foreground) / 0.35)" />
      </ReactFlow>
    </div>
  );
}
