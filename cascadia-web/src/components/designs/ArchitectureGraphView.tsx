// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The design's architecture as a graph: the DECOMPOSES forest top-down, each
 * element's realizing items beneath it, and — on request — the requirements
 * allocated to it above. Built from the same answer the Architecture tab's
 * tree renders, so the two views never disagree; drawn with the item node
 * and the directed relationship edge every other graph in the app uses.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import type { Edge, Node } from '@xyflow/react'
import type {
  ArchitectureNode,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'
import { GraphItemNode } from '@/components/items/GraphItemNode'
import { RelationshipEdge } from '@/components/graph/RelationshipEdge'
import { EdgeDirectionLegend } from '@/components/graph/EdgeDirectionLegend'
import {
  graphEdgeKind,
  graphEdgeVisuals,
  parallelEdgeOffsets,
  withEdgeDirectionLabels,
} from '@/components/graph/edgeStyles'
import { FullscreenGraphWrapper } from '@/components/ui/FullscreenGraphWrapper'
import { useTheme } from '@/theme'

interface ArchitectureGraphViewProps {
  architecture: DesignArchitecture
}

const NODE_WIDTH = 280
const NODE_HEIGHT = 120

function layout(nodes: Array<Node>, edges: Array<Edge>): Array<Node> {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 60 })
  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return nodes.map((node) => {
    const positioned = graph.node(node.id)
    return {
      ...node,
      position: {
        x: positioned.x - NODE_WIDTH / 2,
        y: positioned.y - NODE_HEIGHT / 2,
      },
    }
  })
}

interface GraphParts {
  nodes: Array<Node>
  edges: Array<Edge>
}

/**
 * Every element, realizing item and (optionally) allocated requirement as a
 * node, once each — an item realizing two elements is one node with two
 * edges — and every link as a directed edge carrying its stored type, so the
 * edge styles classify it as the architecture family.
 */
function buildGraph(
  architecture: DesignArchitecture,
  showRequirements: boolean,
): GraphParts {
  const nodes = new Map<string, Node>()
  const edges: Array<Edge> = []

  const itemNode = (
    item: {
      itemId: string
      itemNumber: string
      revision: string
      itemType: string
      name: string | null
      state: string
    },
    level: number,
  ) => {
    if (nodes.has(item.itemId)) return
    nodes.set(item.itemId, {
      id: item.itemId,
      type: 'itemNode',
      position: { x: 0, y: 0 },
      data: {
        itemId: item.itemId,
        itemNumber: item.itemNumber,
        revision: item.revision,
        itemType: item.itemType,
        name: item.name ?? '',
        state: item.state,
        level,
        isDefinition: false,
        isUsage: false,
      },
    })
  }

  const edge = (
    id: string,
    source: string,
    target: string,
    relationshipType: string,
    label: string,
  ) => {
    const visuals = graphEdgeVisuals(graphEdgeKind({ relationshipType }))
    edges.push({
      id,
      source,
      target,
      label,
      type: 'relationship',
      markerEnd: visuals.markerEnd,
      style: visuals.style,
      data: { relationshipType },
    })
  }

  const visit = (node: ArchitectureNode, depth: number) => {
    itemNode({ ...node, itemType: 'SystemElement' }, depth)
    for (const child of node.children) {
      visit(child, depth + 1)
      edge(
        child.relationshipId ?? `${node.itemId}-${child.itemId}`,
        node.itemId,
        child.itemId,
        'DECOMPOSES',
        'Decomposes into',
      )
    }
    for (const link of node.realizedBy) {
      itemNode(link, depth + 1)
      edge(
        link.relationshipId,
        node.itemId,
        link.itemId,
        'REALIZED_BY',
        'Realized by',
      )
    }
    if (showRequirements) {
      for (const link of node.allocatedRequirements) {
        itemNode(link, Math.max(depth - 1, 0))
        edge(
          link.relationshipId,
          link.itemId,
          node.itemId,
          'ALLOCATED_TO',
          'Allocated to',
        )
      }
    }
  }
  for (const root of architecture.roots) visit(root, 0)

  const flowNodes = [...nodes.values()]
  const offsets = parallelEdgeOffsets(edges)
  const spread = edges.map((item) => {
    const offset = offsets.get(item.id)
    return offset === undefined
      ? item
      : { ...item, data: { ...item.data, parallelOffset: offset } }
  })
  return {
    nodes: layout(flowNodes, spread),
    edges: withEdgeDirectionLabels(flowNodes, spread),
  }
}

export function ArchitectureGraphView({
  architecture,
}: ArchitectureGraphViewProps) {
  const { theme } = useTheme()
  const [showRequirements, setShowRequirements] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const nodeTypes = useMemo(() => ({ itemNode: GraphItemNode }), [])
  const edgeTypes = useMemo(() => ({ relationship: RelationshipEdge }), [])

  const built = useMemo(
    () => buildGraph(architecture, showRequirements),
    [architecture, showRequirements],
  )
  useEffect(() => {
    setNodes(built.nodes)
    setEdges(built.edges)
  }, [built, setNodes, setEdges])

  if (nodes.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500 dark:text-slate-400">
        No system elements to draw at this context.
      </div>
    )
  }

  return (
    <FullscreenGraphWrapper
      title="Architecture Graph"
      subtitle={`${nodes.length} item${nodes.length !== 1 ? 's' : ''}, ${edges.length} link${edges.length !== 1 ? 's' : ''}`}
      inlineHeight="600px"
      headerControls={
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={showRequirements}
            onChange={(event) => setShowRequirements(event.target.checked)}
            className="h-4 w-4"
          />
          Show allocated requirements
        </label>
      }
      footer={
        <div className="text-sm text-slate-600 dark:text-slate-400">
          <EdgeDirectionLegend example="a System Element that Decomposes into a child points at the child, and one Realized by a Part points at the Part" />
          <p className="mt-1 text-xs">
            Use mouse wheel to zoom, drag to pan. Click item numbers to
            navigate.
          </p>
        </div>
      }
    >
      <div className="h-full border rounded-lg bg-slate-50 dark:bg-slate-950">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          fitView
          attributionPosition="bottom-right"
          minZoom={0.1}
          maxZoom={2}
        >
          <Background gap={16} />
          <Controls />
        </ReactFlow>
      </div>
    </FullscreenGraphWrapper>
  )
}
