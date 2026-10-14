// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DialogGraph — a dialog's nodes and edges as a React Flow graph.
 *
 * Laid out with dagre in the payload's direction, the item the graph is
 * about highlighted at depth 0. Clicking a node's number navigates to it.
 * When the payload also carries a table, the two are offered as tabs.
 */

import '@xyflow/react/dist/style.css'
import * as dagre from 'dagre'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { memo, useMemo } from 'react'
import { DialogDataGrid } from './DialogDataGrid'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import type {
  DialogGraphNode,
  GraphDialogPayload,
} from '@cascadia/commons/ai/dialogs'
import { useLifecycleState } from '@/components/items/StateBadge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { cn } from '@/utils'

const NODE_WIDTH = 220
const NODE_HEIGHT = 76

interface ChatNodeData extends DialogGraphNode {
  direction: 'TB' | 'LR'
  onOpen: (href: string) => void
  [key: string]: unknown
}

type ChatNode = Node<ChatNodeData, 'chatNode'>

const ChatNodeView = memo(({ data }: NodeProps<ChatNode>) => {
  const state = useLifecycleState(data.itemType, data.state)
  const vertical = data.direction === 'TB'
  const isRoot = data.depth === 0

  return (
    <div
      className={cn(
        'rounded-lg border-2 bg-white px-3 py-2 shadow-sm dark:bg-slate-900',
        isRoot
          ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-950'
          : 'border-slate-300 dark:border-slate-600',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={vertical ? Position.Top : Position.Left}
        className="!bg-slate-400"
      />
      <div className="flex items-center justify-between gap-2">
        {data.href ? (
          <button
            type="button"
            onClick={() => data.href && data.onOpen(data.href)}
            className="truncate font-mono text-sm font-semibold text-cyan-700 hover:underline dark:text-cyan-400"
          >
            {data.label}
          </button>
        ) : (
          <span className="truncate font-mono text-sm font-semibold">
            {data.label}
          </span>
        )}
        {data.state && (
          <span
            className={cn(
              'flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              state.className,
            )}
          >
            {state.label}
          </span>
        )}
      </div>
      {data.sublabel && (
        <div className="truncate text-xs text-slate-600 dark:text-slate-300">
          {data.sublabel}
        </div>
      )}
      {data.itemType && (
        <div className="text-[10px] uppercase tracking-wide text-slate-400">
          {data.itemType}
        </div>
      )}
      <Handle
        type="source"
        position={vertical ? Position.Bottom : Position.Right}
        className="!bg-slate-400"
      />
    </div>
  )
})
ChatNodeView.displayName = 'ChatNodeView'

// Stable across renders: React Flow re-registers node types on identity change.
const nodeTypes = { chatNode: ChatNodeView }

function layout(
  payload: GraphDialogPayload,
  onOpen: (href: string) => void,
): { nodes: Array<ChatNode>; edges: Array<Edge> } {
  const direction = payload.direction ?? 'TB'
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, ranksep: 70, nodesep: 40 })
  for (const node of payload.nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of payload.edges) {
    graph.setEdge(edge.source, edge.target)
  }
  dagre.layout(graph)

  const nodes = payload.nodes.map((node): ChatNode => {
    const placed = graph.node(node.id)
    return {
      id: node.id,
      type: 'chatNode',
      position: {
        x: placed.x - NODE_WIDTH / 2,
        y: placed.y - NODE_HEIGHT / 2,
      },
      data: { ...node, direction, onOpen },
    }
  })
  const edges = payload.edges.map((edge, index): Edge => ({
    id: `e${index}`,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: '#94a3b8' },
    labelStyle: { fill: '#475569', fontSize: 11 },
  }))
  return { nodes, edges }
}

interface DialogGraphProps {
  payload: GraphDialogPayload
  onNavigate: (url: string) => void
}

function GraphCanvas({ payload, onNavigate }: DialogGraphProps) {
  const { nodes, edges } = useMemo(
    () => layout(payload, onNavigate),
    [payload, onNavigate],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          {nodes.length > 30 && <MiniMap pannable zoomable />}
        </ReactFlow>
      </div>
      {payload.legend && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {payload.legend}
        </p>
      )}
    </div>
  )
}

export function DialogGraph({ payload, onNavigate }: DialogGraphProps) {
  if (!payload.table) {
    return <GraphCanvas payload={payload} onNavigate={onNavigate} />
  }

  return (
    <Tabs defaultValue="graph" className="flex h-full flex-col">
      <TabsList className="self-start">
        <TabsTrigger value="graph">Graph</TabsTrigger>
        <TabsTrigger value="table">Table</TabsTrigger>
      </TabsList>
      <TabsContent value="graph" className="min-h-0 flex-1">
        <GraphCanvas payload={payload} onNavigate={onNavigate} />
      </TabsContent>
      <TabsContent value="table" className="min-h-0 flex-1 overflow-hidden">
        <DialogDataGrid payload={payload.table} onNavigate={onNavigate} />
      </TabsContent>
    </Tabs>
  )
}
