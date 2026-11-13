'use client';

/**
 * The one canvas of the workflow plugin: builder (editable) and run view
 * (read-only, with per-node status) share it — PRD §2.4 "one graph".
 *
 * Rule `react-flow-callbacks`: every handler is a stable `useCallback`,
 * every option object lives at module scope, and every state derived from the
 * canvas bails out on equality (`sameJson`) — an inline callback here re-renders
 * the flow on each frame and the page silently loops.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useColorScheme } from '@/components/theme-provider';
import { t } from '@/lib/i18n';
import { CATEGORY_TONE, nodeTypeLabel, presentationFor } from './node-catalog';
import { formatDuration, formatTokens, outPortsFor, placeUnpositioned, removeEdges, removeNodes, sameJson, type NodeType, type RunNode, type WorkflowDefinition, type WorkflowNode } from './types';

const MINIMAP_STYLE = { height: 90, width: 150 } as const;
const FIT_VIEW_OPTIONS = { padding: 0.25, duration: 300 } as const;
const DELETE_KEYS = ['Backspace', 'Delete'];
const SNAP_GRID: [number, number] = [12, 12];
const DEFAULT_EDGE_OPTIONS = { type: 'workflow' } as const;
const NODE_ORIGIN: [number, number] = [0, 0];

type CanvasData = { node: WorkflowNode; ports: string[]; run?: RunNode; readOnly: boolean; dim: boolean; /** What publish or run refused on this node, until the next edit. */ issue?: string };
type CanvasFlowNode = Node<CanvasData, 'workflow'>;
type EdgeData = { taken: boolean; dimmed: boolean; label: string | null; active: boolean };
type CanvasFlowEdge = Edge<EdgeData, 'workflow'>;

/* ── Status pill (run mode) ──────────────────────────────────────────────── */

export function runStatusTone(status: string | undefined): { label: string; className: string; dot: string } {
  switch (status) {
    case 'ok': return { label: t('workflows.status.ok'), className: 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]', dot: 'bg-[hsl(var(--success))]' };
    case 'running': return { label: t('workflows.status.running'), className: 'bg-primary/15 text-primary', dot: 'bg-primary animate-pulse' };
    case 'waiting': return { label: t('workflows.status.waiting'), className: 'bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning))]', dot: 'bg-[hsl(var(--warning))] animate-pulse' };
    case 'error': case 'timeout': return { label: t('workflows.status.error'), className: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' };
    case 'cancelled': return { label: t('workflows.status.cancelled'), className: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' };
    case 'skipped': return { label: t('workflows.status.skipped'), className: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' };
    default: return { label: t('workflows.status.idle'), className: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50' };
  }
}

function StatusPill({ status }: { status: string }) {
  const tone = runStatusTone(status);
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider', tone.className)}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {tone.label}
    </span>
  );
}

/* ── Node card ───────────────────────────────────────────────────────────── */

function CanvasNode({ data, selected }: NodeProps<CanvasFlowNode>) {
  const { node, ports, run, readOnly, dim, issue } = data;
  const pres = presentationFor(node.type);
  const Icon = pres.icon;
  const tone = CATEGORY_TONE[pres.category];
  const rows = pres.summary(node.config ?? {});
  const isTrigger = node.type.startsWith('trigger.');
  const duration = run?.started_at ? formatDuration((run.ended_at ?? Date.now()) - run.started_at) : null;
  const tokens = run ? (run.tokens_in ?? 0) + (run.tokens_out ?? 0) : 0;
  const failed = run?.status === 'error' || run?.status === 'timeout';
  const running = run?.status === 'running' || run?.status === 'waiting';

  return (
    <div
      className={cn(
        'w-[248px] rounded-xl border bg-card text-card-foreground shadow-[0_1px_2px_hsl(var(--surface-0)/0.35),0_6px_18px_-8px_hsl(var(--surface-0)/0.55)] transition-[box-shadow,border-color,opacity]',
        selected ? 'border-primary/70 ring-2 ring-primary/30' : 'border-border hover:border-foreground/25',
        (failed || issue) && 'border-destructive/60',
        running && !selected && 'border-primary/50',
        dim && 'opacity-45',
      )}
    >
      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          isConnectable={!readOnly}
          className="!left-[-5px] !top-[18px] !size-2.5 !rounded-full !border-2 !border-card !bg-muted-foreground"
        />
      )}
      <header className="flex items-center gap-2 rounded-t-xl bg-muted/40 px-3 py-1.5">
        <span className="flex size-5 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${tone} 18%, transparent)` }}>
          <Icon className="size-3" style={{ color: tone }} />
        </span>
        <span className="truncate text-[11px] font-medium text-muted-foreground">{nodeTypeLabel(node.type)}</span>
        {run && <span className="ml-auto shrink-0"><StatusPill status={run.status} /></span>}
      </header>
      <div className="px-3 pb-2 pt-2">
        <div className="truncate text-[13px] font-semibold leading-tight">{node.label || node.id}</div>
        {rows.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5 overflow-hidden rounded-md border border-border/60 bg-background/50 py-0.5">
            {rows.map((row, index) => (
              <div key={index} className="truncate px-2 py-1 text-[11px] leading-snug text-muted-foreground">{row}</div>
            ))}
          </div>
        )}
        {run && (duration || tokens > 0 || run.error) && (
          <div className="mt-2 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
            {duration && <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{duration}</span>}
            {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
            {run.attempt > 1 && <span>#{run.attempt}</span>}
          </div>
        )}
        {run?.error && <div className="mt-1.5 truncate text-[10.5px] text-destructive" title={run.error}>{run.error}</div>}
        {issue && <div className="mt-1.5 line-clamp-2 text-[10.5px] text-destructive" title={issue}>{issue}</div>}
      </div>
      {ports.length > 0 && (
        <div className="rounded-b-xl bg-muted/25 py-1">
          {ports.map((port) => {
            const taken = run?.taken_port === port;
            return (
              <div key={port} className="relative flex h-5 items-center justify-end pr-3">
                <span className={cn('text-[10px]', taken ? 'font-semibold text-primary' : 'text-muted-foreground/80')}>
                  {ports.length > 1 || port !== 'out' ? port : ''}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={port}
                  isConnectable={!readOnly}
                  className="!right-[-5px] !top-1/2 !size-2.5 !rounded-full !border-2 !border-card"
                  style={{ background: taken ? 'hsl(var(--primary))' : tone }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Edge ────────────────────────────────────────────────────────────────── */

function WorkflowFlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<CanvasFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const taken = data?.taken ?? false;
  const dimmed = data?.dimmed ?? false;
  const stroke = taken ? 'hsl(var(--primary))' : selected ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground) / 0.55)';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke, strokeWidth: taken || selected ? 2 : 1.5, strokeDasharray: taken ? undefined : '4 5', opacity: dimmed ? 0.35 : 1 }}
        interactionWidth={16}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={cn('pointer-events-none absolute rounded-md border px-1.5 py-px text-[9.5px]', taken ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground')}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { workflow: CanvasNode };
const EDGE_TYPES = { workflow: WorkflowFlowEdge };

function minimapColor(node: CanvasFlowNode): string {
  return CATEGORY_TONE[presentationFor(node.data.node.type).category];
}

/* ── Canvas ──────────────────────────────────────────────────────────────── */

export type CanvasSelection = { kind: 'node' | 'edge'; id: string } | null;

export type WorkflowCanvasProps = {
  definition: WorkflowDefinition;
  nodeTypes: NodeType[];
  runNodes?: RunNode[];
  /** Publish / run refusals by node id, drawn on the cards. */
  issues?: Record<string, string>;
  readOnly?: boolean;
  selection?: CanvasSelection;
  /** Bump to re-fit the viewport (after a tidy, on load). */
  fitKey?: number;
  onChange?: (definition: WorkflowDefinition) => void;
  onSelect?: (selection: CanvasSelection) => void;
  onAddNode?: (type: string, position: { x: number; y: number }) => void;
  children?: React.ReactNode;
};

const NO_RUN_NODES: RunNode[] = [];

function CanvasInner({ definition, nodeTypes, runNodes = NO_RUN_NODES, issues, readOnly = false, selection = null, fitKey = 0, onChange, onSelect, onAddNode, children }: WorkflowCanvasProps) {
  const { scheme } = useColorScheme();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [hover, setHover] = useState(false);
  const specs = useMemo(() => new Map(nodeTypes.map((item) => [item.type, item])), [nodeTypes]);
  const runByNode = useMemo(() => {
    const map = new Map<string, RunNode>();
    for (const row of runNodes) {
      const current = map.get(row.node_id);
      if (!current || current.attempt < row.attempt) map.set(row.node_id, row);
    }
    return map;
  }, [runNodes]);
  const runMode = runNodes.length > 0;

  const placed = useMemo(() => placeUnpositioned(definition), [definition]);
  const wanted = useMemo<CanvasFlowNode[]>(() => placed.nodes.map((item) => {
    const run = runByNode.get(item.id);
    return {
      id: item.id,
      type: 'workflow',
      position: item.position ?? { x: 0, y: 0 },
      selected: selection?.kind === 'node' && selection.id === item.id,
      draggable: !readOnly,
      data: { node: item, ports: outPortsFor(item, specs.get(item.type)), run, readOnly, dim: runMode && (!run || run.status === 'pending' || run.status === 'skipped'), issue: issues?.[item.id] },
    };
  }), [placed.nodes, issues, runByNode, runMode, readOnly, selection, specs]);

  /**
   * React Flow owns the nodes while the pointer is down.
   *
   * Rebuilding the array from `definition` on every drag frame handed React
   * Flow brand-new node objects, stripped of the internals it measures itself
   * (`measured`, `dragging`): the card was re-mounted ~60 times a second and
   * visibly flickered under the cursor. The canvas now applies the changes
   * locally and only publishes positions once the drag ends — the graph above
   * therefore changes once per move, not once per frame.
   */
  const [flowNodes, setFlowNodes] = useState<CanvasFlowNode[]>(wanted);
  const dragging = useRef(false);
  // Mirror of the state, kept in sync synchronously: a change batch must read
  // the array the previous batch produced, not the one React has repainted.
  const applied = useRef<CanvasFlowNode[]>(wanted);
  useEffect(() => {
    if (dragging.current) return;
    applied.current = wanted;
    setFlowNodes(wanted);
  }, [wanted]);


  const edges = useMemo<CanvasFlowEdge[]>(() => definition.edges.map((item) => {
    const source = runByNode.get(item.from);
    const taken = !!source && source.taken_port === item.fromPort && ['ok', 'running', 'waiting'].includes(runByNode.get(item.to)?.status ?? 'ok');
    const target = runByNode.get(item.to);
    const portLabel = item.fromPort !== 'out' && item.fromPort !== 'done' ? item.fromPort : null;
    const label = item.condition ? `${portLabel ? `${portLabel} · ` : ''}${item.condition}` : portLabel;
    return {
      id: item.id,
      type: 'workflow',
      source: item.from,
      sourceHandle: item.fromPort,
      target: item.to,
      targetHandle: item.toPort ?? 'in',
      selected: selection?.kind === 'edge' && selection.id === item.id,
      animated: taken && (target?.status === 'running' || target?.status === 'waiting'),
      data: { taken, dimmed: runMode && !taken, label, active: false },
    };
  }), [definition.edges, runByNode, runMode, selection]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const next = applyNodeChanges(changes, applied.current);
    applied.current = next;
    setFlowNodes(next);
    const settled = new Set<string>();
    const removed: string[] = [];
    for (const change of changes) {
      if (change.type === 'position' && !readOnly) {
        if (change.dragging) dragging.current = true;
        else { dragging.current = false; settled.add(change.id); }
      } else if (change.type === 'remove' && !readOnly) removed.push(change.id);
      else if (change.type === 'select') {
        if (change.selected) onSelect?.({ kind: 'node', id: change.id });
        else if (selection?.kind === 'node' && selection.id === change.id) onSelect?.(null);
      }
    }
    if (!onChange) return;
    let updated = definition;
    if (settled.size) {
      // The dropped position is the one React Flow just applied — reading it
      // back from the change would miss the snap to grid.
      const landed = new Map(next.filter((node) => settled.has(node.id)).map((node) => [node.id, node.position]));
      // The first move also saves where the laid-out nodes are drawn, so they
      // do not jump when the one being dragged stops being "unplaced".
      updated = { ...placed, nodes: placed.nodes.map((node) => (landed.has(node.id) ? { ...node, position: landed.get(node.id)! } : node)) };
    }
    if (removed.length) updated = removeNodes(updated, removed);
    if (!sameJson(updated, definition)) onChange(updated);
  }, [definition, onChange, onSelect, placed, readOnly, selection]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    const removed: string[] = [];
    for (const change of changes) {
      if (change.type === 'remove' && !readOnly) removed.push(change.id);
      else if (change.type === 'select') {
        if (change.selected) onSelect?.({ kind: 'edge', id: change.id });
        else if (selection?.kind === 'edge' && selection.id === change.id) onSelect?.(null);
      }
    }
    if (removed.length && onChange) onChange(removeEdges(definition, removed));
  }, [definition, onChange, onSelect, readOnly, selection]);

  const onConnect = useCallback((connection: Connection) => {
    if (readOnly || !onChange || !connection.source || !connection.target || connection.source === connection.target) return;
    const fromPort = connection.sourceHandle ?? 'out';
    if (definition.edges.some((edge) => edge.from === connection.source && edge.fromPort === fromPort && edge.to === connection.target)) return;
    onChange({ ...definition, edges: [...definition.edges, { id: `e-${crypto.randomUUID().slice(0, 8)}`, from: connection.source, fromPort, to: connection.target, toPort: connection.targetHandle ?? 'in' }] });
  }, [definition, onChange, readOnly]);

  const onPaneClick = useCallback(() => onSelect?.(null), [onSelect]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (readOnly || !onAddNode) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setHover(true);
  }, [onAddNode, readOnly]);
  const onDragLeave = useCallback(() => setHover(false), []);
  const onDrop = useCallback((event: React.DragEvent) => {
    setHover(false);
    if (readOnly || !onAddNode) return;
    const type = event.dataTransfer.getData('application/rooks-node');
    if (!type) return;
    event.preventDefault();
    onAddNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [onAddNode, readOnly, screenToFlowPosition]);

  useEffect(() => {
    if (!fitKey) return;
    const frame = requestAnimationFrame(() => { void fitView(FIT_VIEW_OPTIONS); });
    return () => cancelAnimationFrame(frame);
  }, [fitKey, fitView]);

  return (
    <div className={cn('wf-canvas relative h-full w-full', hover && 'wf-canvas-drop')} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <ReactFlow
        colorMode={scheme}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        nodeOrigin={NODE_ORIGIN}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="hsl(var(--muted-foreground) / 0.35)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap style={MINIMAP_STYLE} nodeColor={minimapColor} pannable zoomable position="bottom-right" />
        {children ? <Panel position="top-right">{children}</Panel> : null}
      </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
