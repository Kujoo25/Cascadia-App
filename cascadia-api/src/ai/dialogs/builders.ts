// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Dialog payload builders for the read tools.
 *
 * Each read tool already has the rows it fetched; these turn them into the
 * grid or graph a dialog stores, and own the two thresholds that decide
 * whether a result is worth a dialog at all. Pure functions — the tool
 * handlers decide *when*, these decide *what*.
 */

import { ITEM_TYPE_DEFINITIONS } from '@cascadia/commons/items/item-type-definitions'
import type {
  DataGridDialogPayload,
  DialogGraphEdge,
  DialogGraphNode,
  DialogGridRow,
  GraphDialogPayload,
} from '@cascadia/commons/ai/dialogs'

/** Rows a data-grid dialog holds at most. */
export const DIALOG_ROW_CAP = 500

/** Nodes a graph dialog holds at most; past this the browser layout crawls. */
export const GRAPH_NODE_CAP = 300

/**
 * A grid earns its sort-and-filter chrome from this many rows. Below it the
 * model lists everything in the message and a button would only add noise.
 */
export const GRID_MIN_ROWS = 6

/** A graph earns its space once there is structure to see: nodes beyond the root. */
export const GRAPH_MIN_NODES = 2

// ─── grids ──────────────────────────────────────────────────────────────────

export interface ItemRow {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
}

function itemHref(itemType: string, id: string): string | undefined {
  const base = ITEM_TYPE_DEFINITIONS[itemType]?.detailPath
  return base ? `${base}/${id}` : undefined
}

/** Plural display label for an item type, or "Items" across types. */
export function itemTypeLabel(itemType: string | undefined): string {
  return itemType
    ? (ITEM_TYPE_DEFINITIONS[itemType]?.pluralLabel ?? `${itemType}s`)
    : 'Items'
}

/** The full result set of `search_items`. */
export function itemGrid(
  rows: Array<ItemRow>,
  total: number,
): DataGridDialogPayload {
  const kept = rows.slice(0, DIALOG_ROW_CAP)
  return {
    columns: [
      { id: 'itemNumber', header: 'Number', type: 'link' },
      { id: 'name', header: 'Name' },
      { id: 'itemType', header: 'Type' },
      { id: 'revision', header: 'Rev' },
      { id: 'state', header: 'State', type: 'state' },
    ],
    rows: kept.map((row) => ({
      itemNumber: row.itemNumber,
      name: row.name,
      itemType: row.itemType,
      revision: row.revision,
      state: row.state,
      href: itemHref(row.itemType, row.id),
    })),
    total,
    truncated: kept.length < total,
  }
}

export interface ProgramRow {
  id: string
  code: string
  name: string
  status: string
  customer: string | null
  description: string | null
}

/** The full result set of `search_programs`. */
export function programGrid(
  rows: Array<ProgramRow>,
  total: number,
): DataGridDialogPayload {
  const kept = rows.slice(0, DIALOG_ROW_CAP)
  return {
    columns: [
      { id: 'code', header: 'Code', type: 'link' },
      { id: 'name', header: 'Name' },
      { id: 'status', header: 'Status' },
      { id: 'customer', header: 'Customer' },
      { id: 'description', header: 'Description' },
    ],
    rows: kept.map((row) => ({
      code: row.code,
      name: row.name,
      status: row.status,
      customer: row.customer,
      description: row.description,
      href: `/programs/${row.id}`,
    })),
    total,
    truncated: kept.length < total,
  }
}

export interface DesignRow {
  id: string
  code: string
  name: string
  designType: string
  programName: string | null
  description: string | null
}

/** The full result set of `search_designs`. */
export function designGrid(
  rows: Array<DesignRow>,
  total: number,
): DataGridDialogPayload {
  const kept = rows.slice(0, DIALOG_ROW_CAP)
  return {
    columns: [
      { id: 'code', header: 'Code', type: 'link' },
      { id: 'name', header: 'Name' },
      { id: 'designType', header: 'Type' },
      { id: 'programName', header: 'Program' },
      { id: 'description', header: 'Description' },
    ],
    rows: kept.map((row) => ({
      code: row.code,
      name: row.name,
      designType: row.designType,
      programName: row.programName,
      description: row.description,
      href: `/designs/${row.id}`,
    })),
    total,
    truncated: kept.length < total,
  }
}

// ─── graphs ─────────────────────────────────────────────────────────────────

/** The item a graph is about. */
export interface GraphRootItem {
  id: string
  itemNumber: string
  name: string | null
  state: string
  itemType: string
}

/** One level of the tree `get_bom` assembles. */
export interface BomTreeNode {
  itemId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  quantity?: number
  findNumber?: number
  referenceDesignator?: string
  depth: number
  children?: Array<BomTreeNode>
}

/**
 * A single node per item, however many parents use it: the first parent to
 * reach a node places it, later ones only add an edge. Keeps a diamond in a
 * BOM (two sub-assemblies sharing a part) drawn as a diamond.
 */
class GraphAccumulator {
  readonly nodes = new Map<string, DialogGraphNode>()
  readonly edges: Array<DialogGraphEdge> = []
  private readonly seenEdges = new Set<string>()

  add(node: DialogGraphNode): boolean {
    if (this.nodes.has(node.id)) return false
    if (this.nodes.size >= GRAPH_NODE_CAP) return false
    this.nodes.set(node.id, node)
    return true
  }

  connect(source: string, target: string, label?: string): void {
    if (!this.nodes.has(source) || !this.nodes.has(target)) return
    const key = `${source}→${target}`
    if (this.seenEdges.has(key)) return
    this.seenEdges.add(key)
    this.edges.push(label ? { source, target, label } : { source, target })
  }
}

function rootNode(item: GraphRootItem): DialogGraphNode {
  return {
    id: item.id,
    label: item.itemNumber,
    sublabel: item.name ?? undefined,
    state: item.state,
    itemType: item.itemType,
    href: itemHref(item.itemType, item.id),
    depth: 0,
  }
}

function quantityLabel(
  quantity: number | string | undefined,
): string | undefined {
  if (quantity === undefined || quantity === '') return undefined
  return `×${quantity}`
}

/** A part's BOM as assembly → component edges, plus the tree as a table. */
export function bomGraph(
  parent: GraphRootItem,
  children: Array<BomTreeNode>,
  totalComponents: number,
): GraphDialogPayload {
  const graph = new GraphAccumulator()
  graph.add(rootNode(parent))

  const walk = (parentId: string, nodes: Array<BomTreeNode>) => {
    for (const child of nodes) {
      graph.add({
        id: child.itemId,
        label: child.itemNumber,
        sublabel: child.name ?? undefined,
        state: child.state,
        itemType: child.itemType,
        href: itemHref(child.itemType, child.itemId),
        depth: child.depth,
      })
      graph.connect(parentId, child.itemId, quantityLabel(child.quantity))
      if (child.children) walk(child.itemId, child.children)
    }
  }
  walk(parent.id, children)

  const toRow = (node: BomTreeNode): DialogGridRow => ({
    itemNumber: node.itemNumber,
    name: node.name,
    revision: node.revision,
    state: node.state,
    quantity: node.quantity ?? null,
    findNumber: node.findNumber ?? null,
    referenceDesignator: node.referenceDesignator ?? null,
    itemType: node.itemType,
    href: itemHref(node.itemType, node.itemId),
    children: node.children?.map(toRow),
  })

  const truncated = graph.nodes.size - 1 < totalComponents
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    direction: 'TB',
    legend: 'An arrow points from an assembly to a component it uses.',
    total: totalComponents,
    truncated,
    table: {
      columns: [
        { id: 'itemNumber', header: 'Number', type: 'link' },
        { id: 'name', header: 'Name' },
        { id: 'revision', header: 'Rev' },
        { id: 'state', header: 'State', type: 'state' },
        { id: 'quantity', header: 'Qty', type: 'number' },
        { id: 'findNumber', header: 'Find #', type: 'number' },
        { id: 'referenceDesignator', header: 'Ref Des' },
      ],
      rows: children.map(toRow),
      total: totalComponents,
      truncated: false,
      hierarchical: true,
    },
  }
}

/**
 * What `ImpactAssessmentService.findWhereUsed` returns, as far as a graph
 * needs it. `path` is the chain of master ids from the target up to this
 * node, so the entry before the last is the node this one is a parent of.
 */
export interface WhereUsedGraphNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  depth: number
  path: Array<string>
  quantity?: string
  findNumber?: number
  designCode?: string | null
}

/** Where-used edges (assembly → the item it uses) into an accumulator. */
function addWhereUsed(
  graph: GraphAccumulator,
  target: GraphRootItem & { masterId: string },
  whereUsed: Array<WhereUsedGraphNode>,
): void {
  // Master id → the node id drawn for it. The target is drawn by item id.
  const drawnByMaster = new Map<string, string>([[target.masterId, target.id]])
  for (const usage of whereUsed) {
    if (!drawnByMaster.has(usage.masterId)) {
      drawnByMaster.set(usage.masterId, usage.itemId)
    }
  }

  // Closest parents first, so a node is placed before anything hangs off it.
  const ordered = [...whereUsed].sort((a, b) => a.depth - b.depth)
  for (const usage of ordered) {
    const nodeId = drawnByMaster.get(usage.masterId) ?? usage.itemId
    graph.add({
      id: nodeId,
      label: usage.itemNumber,
      sublabel: usage.name ?? undefined,
      state: usage.state,
      itemType: usage.itemType,
      href: itemHref(usage.itemType, usage.itemId),
      depth: usage.depth,
    })
    const childMaster = usage.path.at(-2)
    const childId = childMaster ? drawnByMaster.get(childMaster) : undefined
    graph.connect(nodeId, childId ?? target.id, quantityLabel(usage.quantity))
  }
}

function whereUsedRows(
  whereUsed: Array<WhereUsedGraphNode>,
): Array<DialogGridRow> {
  return whereUsed.map((usage) => ({
    itemNumber: usage.itemNumber,
    name: usage.name,
    revision: usage.revision,
    state: usage.state,
    depth: usage.depth,
    quantity: usage.quantity ?? null,
    designCode: usage.designCode ?? null,
    itemType: usage.itemType,
    href: itemHref(usage.itemType, usage.itemId),
  }))
}

const WHERE_USED_COLUMNS = [
  { id: 'itemNumber', header: 'Number', type: 'link' as const },
  { id: 'name', header: 'Name' },
  { id: 'revision', header: 'Rev' },
  { id: 'state', header: 'State', type: 'state' as const },
  { id: 'depth', header: 'Levels up', type: 'number' as const },
  { id: 'quantity', header: 'Qty', type: 'number' as const },
  { id: 'designCode', header: 'Design' },
]

/** Every assembly that uses an item, closest parents nearest the item. */
export function whereUsedGraph(
  target: GraphRootItem & { masterId: string },
  whereUsed: Array<WhereUsedGraphNode>,
): GraphDialogPayload {
  const graph = new GraphAccumulator()
  graph.add(rootNode(target))
  addWhereUsed(graph, target, whereUsed)

  const kept = whereUsed.slice(0, DIALOG_ROW_CAP)
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    direction: 'TB',
    legend: 'An arrow points from an assembly to the item it uses.',
    total: whereUsed.length,
    truncated: graph.nodes.size - 1 < whereUsed.length,
    table: {
      columns: WHERE_USED_COLUMNS,
      rows: whereUsedRows(kept),
      total: whereUsed.length,
      truncated: kept.length < whereUsed.length,
    },
  }
}

export interface ImpactRelated {
  documents: Array<{ id: string; itemNumber: string; name: string | null }>
  changeOrders: Array<{ id: string; itemNumber: string; state: string }>
}

/**
 * The blast radius of a change: the where-used tree above the item, the
 * documents attached to it, and the open change orders already touching it.
 */
export function impactGraph(
  item: GraphRootItem & { masterId: string },
  whereUsed: Array<WhereUsedGraphNode>,
  related: ImpactRelated,
): GraphDialogPayload {
  const graph = new GraphAccumulator()
  graph.add(rootNode(item))
  addWhereUsed(graph, item, whereUsed)

  for (const doc of related.documents) {
    graph.add({
      id: doc.id,
      label: doc.itemNumber,
      sublabel: doc.name ?? undefined,
      itemType: 'Document',
      href: itemHref('Document', doc.id),
      depth: 1,
    })
    graph.connect(item.id, doc.id, 'documented by')
  }
  for (const eco of related.changeOrders) {
    graph.add({
      id: eco.id,
      label: eco.itemNumber,
      state: eco.state,
      itemType: 'ChangeOrder',
      href: itemHref('ChangeOrder', eco.id),
      depth: 1,
    })
    graph.connect(eco.id, item.id, 'affects')
  }

  const rows: Array<DialogGridRow> = [
    ...whereUsedRows(whereUsed.slice(0, DIALOG_ROW_CAP)).map((row) => ({
      ...row,
      relation: 'Uses this item',
    })),
    ...related.documents.map((doc) => ({
      itemNumber: doc.itemNumber,
      name: doc.name,
      relation: 'Document',
      itemType: 'Document',
      href: itemHref('Document', doc.id),
    })),
    ...related.changeOrders.map((eco) => ({
      itemNumber: eco.itemNumber,
      state: eco.state,
      relation: 'Change order',
      itemType: 'ChangeOrder',
      href: itemHref('ChangeOrder', eco.id),
    })),
  ]
  const total =
    whereUsed.length + related.documents.length + related.changeOrders.length

  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    direction: 'TB',
    legend:
      'Assemblies point at what they use; change orders point at what they affect.',
    total,
    truncated: graph.nodes.size - 1 < total,
    table: {
      columns: [
        { id: 'itemNumber', header: 'Number', type: 'link' },
        { id: 'name', header: 'Name' },
        { id: 'relation', header: 'Relation' },
        { id: 'state', header: 'State', type: 'state' },
        { id: 'depth', header: 'Levels up', type: 'number' },
        { id: 'designCode', header: 'Design' },
      ],
      rows,
      total,
      truncated: rows.length < total,
    },
  }
}
