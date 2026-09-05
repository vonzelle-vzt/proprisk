'use client';

import { useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { NetworkEdge, NetworkEdgeKind, NetworkNode, NetworkRiskLevel } from '@/lib/network/types';
import { cn } from '@/lib/utils/cn';

interface SimNode extends SimulationNodeDatum, NetworkNode {}

interface SimLink extends Omit<NetworkEdge, 'source' | 'target'> {
  source: string | SimNode;
  target: string | SimNode;
}

export const RISK_COLOR: Record<NetworkRiskLevel, string> = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#60a5fa',
  low: '#9ca3af',
};

export const EDGE_STYLE: Record<NetworkEdgeKind, { color: string; label: string; dashed: boolean }> = {
  copy_correlation: { color: '#c084fc', label: 'Copy correlation', dashed: false },
  shared_identity: { color: '#60a5fa', label: 'Shared identity', dashed: false },
  coordinated_payout: { color: '#facc15', label: 'Coordinated payout', dashed: false },
  shared_ip: { color: '#f87171', label: 'Shared IP', dashed: true },
  shared_device: { color: '#34d399', label: 'Shared device', dashed: true },
};

const WIDTH = 880;
const HEIGHT = 520;
const MAX_TICKS = 300;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

function nodeRadius(riskLevel: NetworkRiskLevel): number {
  switch (riskLevel) {
    case 'critical': return 13;
    case 'high': return 10;
    case 'medium': return 8;
    default: return 6;
  }
}

function endpointId(end: string | SimNode): string {
  return typeof end === 'string' ? end : end.id;
}

function endpointNode(end: string | SimNode, byId: Map<string, SimNode>): SimNode | undefined {
  return typeof end === 'string' ? byId.get(end) : end;
}

interface NetworkGraphCanvasProps {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  selectedClusterId: string | null;
  onSelectNode: (node: NetworkNode) => void;
}

export function NetworkGraphCanvas({ nodes, edges, selectedClusterId, onSelectNode }: NetworkGraphCanvasProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);

  // Run the force simulation synchronously to a settled layout — no ticking
  // in React state, so ~30 nodes render as a single static SVG paint.
  const { simNodes, simLinks } = useMemo(() => {
    const nodesCopy: SimNode[] = nodes.map((n, i) => ({
      ...n,
      x: WIDTH / 2 + Math.cos(i) * 120,
      y: HEIGHT / 2 + Math.sin(i) * 120,
    }));
    const byId = new Map(nodesCopy.map((n) => [n.id, n]));
    const linksCopy: SimLink[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e }));

    const simulation = forceSimulation(nodesCopy)
      .force(
        'link',
        forceLink<SimNode, SimLink>(linksCopy)
          .id((d) => d.id)
          .distance(75)
          .strength(0.25)
      )
      .force('charge', forceManyBody().strength(-170))
      .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
      // Gravity keeps unlinked context nodes from being repelled out of frame.
      .force('gravityX', forceX(WIDTH / 2).strength(0.06))
      .force('gravityY', forceY(HEIGHT / 2).strength(0.08))
      .force('collide', forceCollide<SimNode>().radius((d) => nodeRadius(d.riskLevel) + 16))
      .stop();

    for (let i = 0; i < MAX_TICKS; i++) simulation.tick();

    // Fit the settled layout to the viewBox so every node is on screen.
    const PAD = 40;
    const xs = nodesCopy.map((n) => n.x ?? 0);
    const ys = nodesCopy.map((n) => n.y ?? 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((WIDTH - PAD * 2) / spanX, (HEIGHT - PAD * 2) / spanY, 1.4);
    const offsetX = (WIDTH - spanX * scale) / 2 - minX * scale;
    const offsetY = (HEIGHT - spanY * scale) / 2 - minY * scale;
    for (const n of nodesCopy) {
      n.x = (n.x ?? 0) * scale + offsetX;
      n.y = (n.y ?? 0) * scale + offsetY;
    }

    return { simNodes: nodesCopy, simLinks: linksCopy };
  }, [nodes, edges]);

  const nodesById = useMemo(() => new Map(simNodes.map((n) => [n.id, n])), [simNodes]);

  const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    setView((prev) => ({ ...prev, k: clampZoom(prev.k - e.deltaY * 0.001) }));
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    dragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startX: view.x, startY: view.y };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const { startClientX, startClientY, startX, startY } = dragRef.current;
    const dx = e.clientX - startClientX;
    const dy = e.clientY - startClientY;
    // Drag threshold: don't pan (and re-render mid-click) on sub-3px jitter.
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    setView((prev) => ({ ...prev, x: startX + dx, y: startY + dy }));
  };

  const endDrag = () => { dragRef.current = null; };

  const resetView = () => setView({ x: 0, y: 0, k: 1 });

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-[520px] cursor-grab active:cursor-grabbing select-none rounded-xl bg-black/30"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {simLinks.map((link, i) => {
            const s = endpointNode(link.source, nodesById);
            const t = endpointNode(link.target, nodesById);
            if (!s || !t) return null;
            const style = EDGE_STYLE[link.kind];
            const dimmed = selectedClusterId != null && s.clusterId !== selectedClusterId && t.clusterId !== selectedClusterId;
            return (
              <line
                key={`${endpointId(link.source)}-${endpointId(link.target)}-${link.kind}-${i}`}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={style.color}
                strokeWidth={1 + link.weight * 2}
                strokeDasharray={style.dashed ? '4 3' : undefined}
                opacity={dimmed ? 0.08 : 0.55}
              />
            );
          })}

          {simNodes.map((node) => {
            const dimmed = selectedClusterId != null && node.clusterId !== selectedClusterId;
            const isHovered = hoveredId === node.id;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                onClick={() => onSelectNode(node)}
              >
                <circle
                  r={nodeRadius(node.riskLevel)}
                  fill={RISK_COLOR[node.riskLevel]}
                  opacity={dimmed ? 0.2 : 0.9}
                  stroke={node.clusterId && node.clusterId === selectedClusterId ? '#ffffff' : 'rgba(255,255,255,0.25)'}
                  strokeWidth={node.clusterId && node.clusterId === selectedClusterId ? 2 : 1}
                />
                {(isHovered || (selectedClusterId != null && node.clusterId === selectedClusterId)) && (
                  <text
                    y={-nodeRadius(node.riskLevel) - 6}
                    textAnchor="middle"
                    className={cn('text-[9px] fill-gray-200 pointer-events-none', dimmed && 'opacity-40')}
                  >
                    {node.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <button
        onClick={resetView}
        className="absolute top-2 right-2 rounded-lg border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-gray-300 hover:bg-white/10"
      >
        Reset view
      </button>

      <div className="absolute bottom-2 left-2 flex flex-wrap gap-2 rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5">
        {(Object.keys(EDGE_STYLE) as NetworkEdgeKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1 text-[9px] text-gray-400">
            <span
              className="inline-block h-0.5 w-3"
              style={{ backgroundColor: EDGE_STYLE[kind].color, opacity: EDGE_STYLE[kind].dashed ? 0.7 : 1 }}
            />
            {EDGE_STYLE[kind].label}
          </span>
        ))}
      </div>
    </div>
  );
}
