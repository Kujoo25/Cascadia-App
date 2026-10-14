// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI Tool Handlers
 *
 * Server-side implementations for the AI tools.
 * Each handler uses existing services and is wrapped with permission checking.
 */

import {
  formatOptionText,
  formatPartDesignation,
} from '@cascadia/commons/types/variants'
import { withPermissionAndAudit } from './permission-wrapper'
import type { ToolContext } from './permission-wrapper'
import type { ItemNumberMatch } from '@/items/services/ItemService'
import { ImpactAssessmentService } from '@/items/services/ImpactAssessmentService'
import { ItemService } from '@/items/services/ItemService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { TraceLinkService } from '@/services/TraceLinkService'
import { AccessControlService } from '@/auth/AccessControlService'
import { requireDesignAccess, requireItemAccess } from '@/auth/access'
import { ValidationError } from '@/errors'
import {
  DIALOG_ROW_CAP,
  GRAPH_MIN_NODES,
  GRID_MIN_ROWS,
  bomGraph,
  designGrid,
  impactGraph,
  itemGrid,
  itemTypeLabel,
  programGrid,
  whereUsedGraph,
} from '@/ai/dialogs/builders'
import { chatPanelListening, presentDialog } from '@/ai/dialogs/DialogService'

/**
 * A canonical UUID, in either case. Shared by the id-or-code resolvers below
 * and by `offer_navigation`, which builds a URL out of the id it is handed.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Helper to resolve a design identifier to a UUID.
 * Accepts either a UUID or a design code (e.g., "PC-PROTO").
 */
async function resolveDesignId(
  designIdOrCode: string | undefined,
): Promise<string | undefined> {
  if (!designIdOrCode) return undefined

  // Check if it's already a UUID (basic pattern check)
  if (UUID_PATTERN.test(designIdOrCode)) {
    return designIdOrCode
  }

  // Otherwise, treat as design code and look it up
  const design = await DesignService.getByCode(designIdOrCode)
  if (!design) {
    throw new Error(`Design not found: "${designIdOrCode}"`)
  }
  return design.id
}

/**
 * Helper to resolve a program identifier to a UUID.
 * Accepts either a UUID or a program code (e.g., "WIDGET").
 */
async function resolveProgramId(
  programIdOrCode: string | undefined,
): Promise<string | undefined> {
  if (!programIdOrCode) return undefined

  // Check if it's already a UUID (basic pattern check)
  if (UUID_PATTERN.test(programIdOrCode)) {
    return programIdOrCode
  }

  // Otherwise, treat as program code and look it up via search
  const result = await ProgramService.search({
    columnFilters: { code: programIdOrCode },
    limit: 1,
  })
  const match = result.items[0]
  if (!match) {
    throw new Error(`Program not found: "${programIdOrCode}"`)
  }
  return match.id
}

// Input types for handlers - we manually apply defaults since TanStack AI
// doesn't apply Zod defaults when inferring types
interface SearchItemsInput {
  /** Any registered item type name (schema-validated against the registry). */
  itemType?: string
  query?: string
  state?: string
  designId?: string
  limit?: number
}

interface GetItemDetailsInput {
  id?: string
  itemNumber?: string
  revision?: string
  designId?: string
}

interface GetBomInput {
  itemId: string
  depth?: number
}

interface GetWhereUsedInput {
  itemId: string
  maxDepth?: number
}

interface AnalyzeChangeImpactInput {
  itemId: string
  includeDocuments?: boolean
  includeRelatedChanges?: boolean
}

interface GetSuspectLinksInput {
  designId?: string
  itemId?: string
  relationshipType?: string
  includeAffirmed?: boolean
  limit?: number
}

interface OfferNavigationInput {
  itemId: string
  itemNumber: string
  itemName?: string | null
  itemType:
    | 'Part'
    | 'Document'
    | 'ChangeOrder'
    | 'Requirement'
    | 'Task'
    | 'Design'
    | 'Program'
  tab?: 'details' | 'relationships' | 'history' | 'bom' | 'affected-items'
  label?: string
}

interface SearchProgramsInput {
  query?: string
  status?: 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
  limit?: number
}

interface SearchDesignsInput {
  query?: string
  programId?: string
  designType?: 'Engineering' | 'Manufacturing' | 'Library' | 'Family'
  limit?: number
}

// ============================================================================
// Dialogs
// ============================================================================

/**
 * How many rows to fetch for a search on this surface.
 *
 * With a chat panel listening, the full result set goes into a data-grid
 * dialog the panel opens on demand, so one query fetches up to the dialog
 * cap and the model is handed only the `limit` it asked for. Anywhere else
 * there is no dialog, and the fetch stays what was requested.
 */
function fetchLimitFor(context: ToolContext, limit: number): number {
  return chatPanelListening(context) ? Math.max(limit, DIALOG_ROW_CAP) : limit
}

/** "View all 42 results", or "View 500 of 1,204 results" past the cap. */
function resultsLabel(shown: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  return shown < total
    ? `View ${fmt(shown)} of ${fmt(total)} results`
    : `View all ${fmt(total)} results`
}

/** The model-facing note on a data-grid dialog. */
function gridSummary(total: number): string {
  return (
    `${total} matches in total. The chat panel shows a button that opens all of ` +
    'them in a sortable, filterable table, so summarise only the most relevant ' +
    'few here and tell the user the button has the rest.'
  )
}

/** The model-facing note on a graph dialog. */
function graphSummary(what: string): string {
  return (
    `The chat panel shows a button that opens ${what} as a graph and a table, ` +
    'so describe the structure here rather than listing every node.'
  )
}

/**
 * A search hit in the shape both the model result and the grid use. The
 * return type is spelled out rather than named because an interface has no
 * implicit index signature, and a consumer of this tool's result reads the
 * items as `Record<string, unknown>`.
 */
function toItemRow(item: {
  id?: string
  itemNumber?: string
  name?: string | null
  revision?: string
  state?: string
  itemType: string
  designId?: string | null
}): {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
} {
  return {
    id: item.id ?? '',
    itemNumber: item.itemNumber ?? '',
    name: item.name ?? null,
    revision: item.revision ?? '',
    state: item.state ?? '',
    itemType: item.itemType,
    designId: item.designId ?? null,
  }
}

/** "Parts matching \"bracket\" in state Released" — the dialog's title. */
function describeItemSearch(input: SearchItemsInput): string {
  const parts = [itemTypeLabel(input.itemType)]
  if (input.query) parts.push(`matching "${input.query}"`)
  if (input.state) parts.push(`in state ${input.state}`)
  if (input.designId) parts.push(`in design ${input.designId}`)
  return parts.join(' ')
}

/** The full `search_items` result set as a dialog, once it is worth one. */
async function presentItemGrid(
  context: ToolContext,
  input: SearchItemsInput,
  rows: Array<ReturnType<typeof toItemRow>>,
  total: number,
) {
  if (rows.length < GRID_MIN_ROWS) return undefined
  const payload = itemGrid(rows, total)
  return presentDialog(context, 'search_items', {
    kind: 'data-grid',
    title: describeItemSearch(input),
    payload,
    label: resultsLabel(payload.rows.length, total),
    summary: gridSummary(total),
  })
}

// ============================================================================
// search_items handler
// ============================================================================

export const searchItemsHandler = withPermissionAndAudit(
  'search_items',
  { resource: 'parts', action: 'read' },
  async (input: SearchItemsInput, context: ToolContext) => {
    // Apply defaults
    const limit = input.limit ?? 20
    const fetchLimit = fetchLimitFor(context, limit)

    // Resolve designId - accepts either UUID or design code (e.g., "PC-PROTO")
    const resolvedDesignId = await resolveDesignId(input.designId)

    // Access control: restrict to user's accessible designs
    const isAdmin = await AccessControlService.hasCrossProgramAccess(
      context.userId,
    )
    let accessibleDesignIds: Array<string> | undefined
    if (!isAdmin) {
      const accessibleDesigns = await AccessControlService.getAccessibleDesigns(
        context.userId,
      )
      accessibleDesignIds = accessibleDesigns.map((d) => d.id)
    }

    // Validate explicit designId against access control
    if (resolvedDesignId && !isAdmin) {
      const hasAccess = await AccessControlService.canAccessDesign(
        context.userId,
        resolvedDesignId,
      )
      if (!hasAccess) {
        return { items: [], total: 0 }
      }
    }

    // Stored item state is a state ID (WI-5.2). The model may name a state
    // by its display name ("Released") — when the item type is known,
    // resolve id-or-name to the ID so the filter matches stored rows.
    let stateFilter = input.state
    if (stateFilter && input.itemType) {
      const { ItemTypeRegistry } = await import('@/items/registry')
      const lifecycle = await ItemTypeRegistry.getLifecycleForType(
        input.itemType,
      )
      const match = lifecycle?.states.find(
        (s) => s.id === stateFilter || s.name === stateFilter,
      )
      if (match) stateFilter = match.id
    }

    // If a text query is provided, use searchByItemNumber which searches both
    // itemNumber and name fields. Then filter by itemType/state afterward.
    // (ItemService.search doesn't implement text search yet)
    if (input.query && input.query.length >= 2) {
      const items = await ItemService.searchByItemNumber(input.query, {
        // Over-fetch when a state filter will drop rows afterwards
        limit: stateFilter ? fetchLimit * 2 : fetchLimit,
        currentOnly: true,
        itemTypes: input.itemType ? [input.itemType] : undefined,
        designIds: resolvedDesignId ? [resolvedDesignId] : accessibleDesignIds,
      })

      // Filter by state if specified, then cap at what this surface fetches
      const rows = (
        stateFilter ? items.filter((item) => item.state === stateFilter) : items
      )
        .slice(0, fetchLimit)
        .map(toItemRow)

      return {
        items: rows.slice(0, limit),
        total: rows.length,
        dialog: await presentItemGrid(context, input, rows, rows.length),
      }
    }

    // No text query - use ItemService.search if itemType is specified
    if (input.itemType) {
      const result = await ItemService.search(input.itemType, {
        state: stateFilter,
        designId: resolvedDesignId,
        designIds: !resolvedDesignId ? accessibleDesignIds : undefined,
        limit: fetchLimit,
      })
      const rows = result.items.map(toItemRow)

      return {
        items: rows.slice(0, limit),
        total: result.total,
        dialog: await presentItemGrid(context, input, rows, result.total),
      }
    }

    // No query and no itemType - return empty (need at least one filter)
    return {
      items: [],
      total: 0,
    }
  },
)

// ============================================================================
// get_item_details handler
// ============================================================================

export const getItemDetailsHandler = withPermissionAndAudit(
  'get_item_details',
  { resource: 'parts', action: 'read' },
  async (input: GetItemDetailsInput, context: ToolContext) => {
    let item
    // Rows sharing the requested item number that this call did not return.
    // An MBOM copies its EBOM's item numbers verbatim, so a number-only
    // lookup is routinely ambiguous — and answering as though it were not is
    // how an agent ends up describing the manufacturing shadow of a part.
    let otherMatches: Array<ItemNumberMatch> = []

    if (input.id) {
      item = await ItemService.findById(input.id)
      // The by-number branch below has been design-scoped since it was
      // written; the by-id branch was not, so an id was enough to read any
      // program's item through the chatbot or MCP. The gate runs after the
      // read rather than replacing it: `findById` applies the not-deleted
      // filter and merges type-specific fields, neither of which
      // `requireItemAccess` does, and the not-found message below stays the
      // model-facing one it has always been.
      if (item) await requireItemAccess(context.userId, item.id)
    } else if (input.itemNumber) {
      const matches = await ItemService.findMatchesByNumber(
        input.itemNumber,
        input.revision,
        {
          // Accepts a UUID or a design code, like search_items.
          designId: await resolveDesignId(input.designId),
          // Scope the same way search_items does, so a number lookup cannot
          // reach — or disclose — anything outside the caller's programs.
          accessScope: await AccessControlService.getAccessScope(
            context.userId,
          ),
        },
      )
      const best = matches.at(0)
      if (best) {
        item = await ItemService.findById(best.id)
        otherMatches = matches.slice(1)
      }
    } else {
      throw new Error('Must provide either id or itemNumber')
    }

    if (!item) {
      throw new Error(
        input.id
          ? `Item with ID ${input.id} not found`
          : `Item ${input.itemNumber}${input.revision ? `-${input.revision}` : ''} not found`,
      )
    }

    // Separate base fields from type-specific fields
    const {
      id,
      masterId,
      itemNumber,
      name,
      revision,
      state,
      itemType,
      designId,
      createdAt,
      createdBy,
      modifiedAt,
      modifiedBy,
      ...typeSpecificData
    } = item

    // Name the design on every path, including lookup by id: which design a
    // row lives in is what tells the caller whether it has the engineering
    // item or a manufacturing copy of it.
    const design = designId ? await DesignService.getById(designId) : null

    return {
      id,
      masterId,
      itemNumber,
      name: name ?? null,
      revision,
      state,
      itemType,
      designId: designId ?? null,
      designCode: design?.code ?? null,
      designName: design?.name ?? null,
      designType: design?.designType ?? null,
      createdAt: createdAt.toISOString(),
      createdBy,
      modifiedAt: modifiedAt.toISOString(),
      modifiedBy,
      typeSpecificData:
        Object.keys(typeSpecificData).length > 0 ? typeSpecificData : undefined,
      otherMatches:
        otherMatches.length > 0
          ? otherMatches.map((match) => ({
              id: match.id,
              itemNumber: match.itemNumber,
              name: match.name,
              revision: match.revision,
              state: match.state,
              itemType: match.itemType,
              designId: match.designId,
              designCode: match.designCode,
              designName: match.designName,
              designType: match.designType,
            }))
          : undefined,
    }
  },
)

// ============================================================================
// get_bom handler
// ============================================================================

interface BomChild {
  itemId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  quantity?: number
  findNumber?: number
  referenceDesignator?: string
  option?: string
  targetMakeCode?: string
  designation: string
  depth: number
  children?: Array<BomChild>
}

export const getBomHandler = withPermissionAndAudit(
  'get_bom',
  { resource: 'parts', action: 'read' },
  async (input: GetBomInput, context: ToolContext) => {
    // Apply defaults
    const depth = input.depth ?? 1

    // Get the parent item first
    const parentItem = await ItemService.findById(input.itemId)
    if (!parentItem) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }
    // Gate the root. Traversal results below stay gated at the root only,
    // which is REST parity: the relationship-graph routes draw the boundary
    // the same way.
    await requireItemAccess(context.userId, parentItem.id)

    if (parentItem.itemType !== 'Part') {
      throw new Error(
        `BOM is only available for Parts. This item is a ${parentItem.itemType}.`,
      )
    }

    // Recursive function to build BOM tree
    const addChildren = async (
      parentId: string,
      currentDepth: number,
      visited: Set<string>,
    ): Promise<Array<BomChild>> => {
      if (currentDepth > depth || visited.has(parentId)) {
        return []
      }

      visited.add(parentId)

      const rels = await ItemService.getRelationshipsWithDetails(
        parentId,
        'BOM',
      )
      const result: Array<BomChild> = []

      for (const rel of rels) {
        if (!rel.targetItem) continue

        const childNode: BomChild = {
          itemId: rel.targetItem.id,
          itemNumber: rel.targetItem.itemNumber,
          name: rel.targetItem.name ?? null,
          revision: rel.targetItem.revision,
          state: rel.targetItem.state,
          itemType: rel.targetItem.itemType,
          quantity: rel.quantity ? Number(rel.quantity) : undefined,
          findNumber: rel.findNumber ?? undefined,
          referenceDesignator: rel.referenceDesignator ?? undefined,
          option: formatOptionText(rel.option) || undefined,
          targetMakeCode: rel.targetMakeCode ?? undefined,
          designation: formatPartDesignation({
            itemNumber: rel.targetItem.itemNumber,
            revision: rel.targetItem.revision,
            makeCode: rel.targetMakeCode,
          }),
          depth: currentDepth,
        }

        // Recursively get children if depth allows
        if (currentDepth < depth && rel.targetItem.itemType === 'Part') {
          const nestedChildren = await addChildren(
            rel.targetItem.id,
            currentDepth + 1,
            new Set(visited),
          )
          if (nestedChildren.length > 0) {
            childNode.children = nestedChildren
          }
        }

        result.push(childNode)
      }

      return result
    }

    // Build the tree starting from depth 1
    const bomTree = await addChildren(input.itemId, 1, new Set())

    // Count total components (flatten tree)
    const countComponents = (children: Array<BomChild>): number => {
      let count = children.length
      for (const child of children) {
        if (child.children) {
          count += countComponents(child.children)
        }
      }
      return count
    }

    const totalComponents = countComponents(bomTree)
    const dialog =
      totalComponents >= GRAPH_MIN_NODES
        ? await presentDialog(context, 'get_bom', {
            kind: 'graph',
            title: `BOM of ${parentItem.itemNumber}${
              parentItem.name ? ` — ${parentItem.name}` : ''
            }`,
            payload: bomGraph(
              {
                id: parentItem.id,
                itemNumber: parentItem.itemNumber,
                name: parentItem.name ?? null,
                state: parentItem.state,
                itemType: parentItem.itemType,
              },
              bomTree,
              totalComponents,
            ),
            label: 'View BOM graph',
            summary: graphSummary('this BOM'),
          })
        : undefined

    return {
      parentItemNumber: parentItem.itemNumber,
      parentName: parentItem.name ?? null,
      children: bomTree,
      totalComponents,
      dialog,
    }
  },
)

// ============================================================================
// get_where_used handler
// ============================================================================

export const getWhereUsedHandler = withPermissionAndAudit(
  'get_where_used',
  { resource: 'parts', action: 'read' },
  async (input: GetWhereUsedInput, context: ToolContext) => {
    // Apply defaults
    const maxDepth = input.maxDepth ?? 15

    // Get the target item first
    const targetItem = await ItemService.findById(input.itemId)
    if (!targetItem) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }
    // Root-gated, as in get_bom: the parents walked up to are not re-checked.
    await requireItemAccess(context.userId, targetItem.id)

    // Use existing ImpactAssessmentService.findWhereUsed()
    const whereUsed = await ImpactAssessmentService.findWhereUsed(
      input.itemId,
      {
        maxDepth,
      },
    )

    const dialog =
      whereUsed.length >= GRAPH_MIN_NODES
        ? await presentDialog(context, 'get_where_used', {
            kind: 'graph',
            title: `Where ${targetItem.itemNumber} is used`,
            payload: whereUsedGraph(
              {
                id: targetItem.id,
                masterId: targetItem.masterId,
                itemNumber: targetItem.itemNumber,
                name: targetItem.name ?? null,
                state: targetItem.state,
                itemType: targetItem.itemType,
              },
              whereUsed,
            ),
            label: 'View where-used graph',
            summary: graphSummary('the where-used tree'),
          })
        : undefined

    return {
      itemNumber: targetItem.itemNumber,
      itemName: targetItem.name ?? null,
      whereUsed: whereUsed.map((node) => ({
        itemId: node.itemId,
        itemNumber: node.itemNumber,
        name: node.name,
        revision: node.revision,
        state: node.state,
        itemType: node.itemType,
        depth: node.depth,
        quantity: node.quantity,
        findNumber: node.findNumber,
        designId: node.designId ?? null,
        designCode: node.designCode ?? null,
        designName: node.designName ?? null,
      })),
      totalUsages: whereUsed.length,
      dialog,
    }
  },
)

// ============================================================================
// analyze_change_impact handler
// ============================================================================

interface Risk {
  severity: 'low' | 'medium' | 'high' | 'critical'
  category: string
  description: string
}

export const analyzeChangeImpactHandler = withPermissionAndAudit(
  'analyze_change_impact',
  { resource: 'parts', action: 'read' },
  async (input: AnalyzeChangeImpactInput, context: ToolContext) => {
    // Apply defaults
    const includeDocuments = input.includeDocuments ?? true
    const includeRelatedChanges = input.includeRelatedChanges ?? true

    // Get the target item
    const item = await ItemService.findById(input.itemId)
    if (!item) {
      throw new Error(`Item with ID ${input.itemId} not found`)
    }
    // Root-gated, as in get_bom.
    await requireItemAccess(context.userId, item.id)

    // Get where-used data
    const whereUsed = await ImpactAssessmentService.findWhereUsed(
      input.itemId,
      {
        maxDepth: 15,
      },
    )

    // Calculate max depth
    const maxDepth = whereUsed.reduce(
      (max, node) => Math.max(max, node.depth),
      0,
    )

    // Get related documents if requested
    let relatedDocuments:
      Array<{ id: string; itemNumber: string; name: string | null }> | undefined
    if (includeDocuments) {
      const docs = await ItemService.getRelated(input.itemId, 'Document')
      relatedDocuments = docs.map((doc) => ({
        id: doc.id,
        itemNumber: doc.itemNumber,
        name: doc.name ?? null,
      }))
    }

    // Get related change orders if requested
    let relatedChangeOrders:
      Array<{ id: string; itemNumber: string; state: string }> | undefined
    if (includeRelatedChanges) {
      const impactedItemIds = whereUsed.map((node) => node.itemId)
      // No current ECO to exclude — the caller is asking about the item, not
      // from inside a change order, so every open ECO touching it is relevant.
      const relatedChanges = await ImpactAssessmentService.findRelatedChanges(
        undefined,
        [input.itemId, ...impactedItemIds],
      )
      relatedChangeOrders = relatedChanges.map((co) => ({
        id: co.changeOrderId,
        itemNumber: co.itemNumber,
        state: co.state,
      }))
    }

    // Calculate risks
    const risks: Array<Risk> = []

    // High fan-out risk
    if (whereUsed.length > 50) {
      risks.push({
        severity: 'high',
        category: 'production',
        description: `High impact: item is used in ${whereUsed.length} assemblies`,
      })
    } else if (whereUsed.length > 20) {
      risks.push({
        severity: 'medium',
        category: 'production',
        description: `Moderate impact: item is used in ${whereUsed.length} assemblies`,
      })
    }

    // Deep hierarchy risk
    if (maxDepth > 7) {
      risks.push({
        severity: 'medium',
        category: 'production',
        description: `Change affects ${maxDepth} levels of assemblies`,
      })
    }

    // Document update risk
    if (relatedDocuments && relatedDocuments.length > 10) {
      risks.push({
        severity: 'medium',
        category: 'compliance',
        description: `${relatedDocuments.length} documents may need updating`,
      })
    }

    // Concurrent change risk
    if (relatedChangeOrders && relatedChangeOrders.length > 0) {
      risks.push({
        severity: 'critical',
        category: 'schedule',
        description: `Conflicts with ${relatedChangeOrders.length} active change orders`,
      })
    }

    // Cross-design risk
    const externalDesigns = new Set(
      whereUsed.filter((n) => n.designCode).map((n) => n.designCode),
    )
    if (externalDesigns.size > 0) {
      risks.push({
        severity: externalDesigns.size > 3 ? 'high' : 'medium',
        category: 'cross-design',
        description: `Item is used in ${externalDesigns.size} other design(s)`,
      })
    }

    // Calculate overall risk level
    const riskLevel: 'low' | 'medium' | 'high' | 'critical' = risks.some(
      (r) => r.severity === 'critical',
    )
      ? 'critical'
      : risks.some((r) => r.severity === 'high')
        ? 'high'
        : risks.some((r) => r.severity === 'medium')
          ? 'medium'
          : 'low'

    const relatedCount =
      (relatedDocuments?.length ?? 0) + (relatedChangeOrders?.length ?? 0)
    const dialog =
      whereUsed.length + relatedCount >= GRAPH_MIN_NODES
        ? await presentDialog(context, 'analyze_change_impact', {
            kind: 'graph',
            title: `Impact of changing ${item.itemNumber}`,
            payload: impactGraph(
              {
                id: item.id,
                masterId: item.masterId,
                itemNumber: item.itemNumber,
                name: item.name ?? null,
                state: item.state,
                itemType: item.itemType,
              },
              whereUsed,
              {
                documents: relatedDocuments ?? [],
                changeOrders: relatedChangeOrders ?? [],
              },
            ),
            label: 'View impact graph',
            summary: graphSummary('the full impact'),
          })
        : undefined

    return {
      item: {
        itemNumber: item.itemNumber,
        name: item.name ?? null,
        revision: item.revision,
        state: item.state,
      },
      whereUsedCount: whereUsed.length,
      maxDepthAffected: maxDepth,
      affectedAssemblies: whereUsed.slice(0, 20).map((node) => ({
        itemId: node.itemId,
        itemNumber: node.itemNumber,
        name: node.name,
        depth: node.depth,
        state: node.state,
      })),
      relatedDocuments,
      relatedChangeOrders,
      risks,
      riskLevel,
      dialog,
    }
  },
)

// ============================================================================
// offer_navigation handler
// ============================================================================

/**
 * Route mapping for item types
 */
const ITEM_TYPE_ROUTES: Record<OfferNavigationInput['itemType'], string> = {
  Part: '/parts',
  Document: '/documents',
  ChangeOrder: '/change-orders',
  Requirement: '/requirements',
  Task: '/tasks',
  Design: '/designs',
  Program: '/programs',
}

/**
 * The tab segment this tool will append: a route slug and nothing else.
 * `?`, `#`, `/` and `:` are the characters that turn an appended tab into a
 * different destination rather than a tab on the same page.
 */
const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/

export const offerNavigationHandler = withPermissionAndAudit(
  'offer_navigation',
  { resource: 'parts', action: 'read' },
  async (input: OfferNavigationInput, _context: ToolContext) => {
    // Both halves of the URL below are model-chosen, and what the model saw
    // before choosing them was tool results — item names and descriptions any
    // user with write access can author. The chat panel turns the result into
    // a one-click button, so the shape is checked here rather than left to
    // whichever surface called: `itemId` reaches no service at all for
    // Program, Design and ChangeOrder, and its schema is a bare string.
    if (!UUID_PATTERN.test(input.itemId)) {
      throw new ValidationError(`Invalid item ID: "${input.itemId}"`)
    }
    if (input.tab !== undefined && !TAB_SLUG_PATTERN.test(input.tab)) {
      throw new ValidationError(`Invalid tab: "${input.tab}"`)
    }

    // Validate item exists for most item types
    // Note: Programs and Designs have separate services but we'll skip validation
    // since this is just offering navigation, not accessing data
    if (
      input.itemType !== 'Program' &&
      input.itemType !== 'Design' &&
      input.itemType !== 'ChangeOrder'
    ) {
      const item = await ItemService.findById(input.itemId)
      if (!item) {
        throw new Error(`Item with ID ${input.itemId} not found`)
      }
    }

    // Build the navigation URL
    const baseRoute = ITEM_TYPE_ROUTES[input.itemType]
    let navigationUrl = `${baseRoute}/${input.itemId}`

    // Append tab as query param if specified
    if (input.tab) {
      navigationUrl += `?tab=${input.tab}`
    }

    return {
      navigationUrl,
      displayed: true,
    }
  },
)

// ============================================================================
// search_programs handler
// ============================================================================

export const searchProgramsHandler = withPermissionAndAudit(
  'search_programs',
  { resource: 'programs', action: 'read' },
  async (input: SearchProgramsInput, context: ToolContext) => {
    const limit = input.limit ?? 20
    const fetchLimit = fetchLimitFor(context, limit)

    // Get accessible program IDs for the current user
    const programIds = await AccessControlService.getAccessibleProgramIds(
      context.userId,
    )

    // Build search criteria
    const result = await ProgramService.search({
      globalSearch: input.query,
      columnFilters: input.status ? { status: input.status } : undefined,
      programIds,
      limit: fetchLimit,
    })

    const rows = result.items.map((program) => ({
      id: program.id,
      name: program.name,
      code: program.code,
      status: program.status,
      customer: program.customer ?? null,
      description: program.description ?? null,
    }))

    const dialog =
      rows.length >= GRID_MIN_ROWS
        ? await presentDialog(context, 'search_programs', {
            kind: 'data-grid',
            title: input.query
              ? `Programs matching "${input.query}"`
              : 'Programs',
            payload: programGrid(rows, result.total),
            label: resultsLabel(
              Math.min(rows.length, DIALOG_ROW_CAP),
              result.total,
            ),
            summary: gridSummary(result.total),
          })
        : undefined

    return {
      programs: rows.slice(0, limit),
      total: result.total,
      dialog,
    }
  },
)

// ============================================================================
// search_designs handler
// ============================================================================

export const searchDesignsHandler = withPermissionAndAudit(
  'search_designs',
  { resource: 'designs', action: 'read' },
  async (input: SearchDesignsInput, context: ToolContext) => {
    const limit = input.limit ?? 20
    const fetchLimit = fetchLimitFor(context, limit)

    // Get accessible program IDs for the current user
    const programIds = await AccessControlService.getAccessibleProgramIds(
      context.userId,
    )

    // Resolve programId input (could be UUID or program code)
    const resolvedProgramId = await resolveProgramId(input.programId)

    // If a specific program was requested, scope to just that program
    // (but still respect access control - if user can't access it, search returns empty)
    const scopedProgramIds = resolvedProgramId
      ? [resolvedProgramId]
      : programIds

    // Build column filters for designType if specified
    const columnFilters: Record<string, string> = {}
    if (input.designType) {
      columnFilters.designType = input.designType
    }

    const result = await DesignService.search({
      globalSearch: input.query,
      columnFilters:
        Object.keys(columnFilters).length > 0 ? columnFilters : undefined,
      programIds: scopedProgramIds,
      includeArchived: false,
      limit: fetchLimit,
    })

    // Look up program names for the results
    const programNameCache = new Map<string, string>()
    for (const design of result.items) {
      if (design.programId && !programNameCache.has(design.programId)) {
        const program = await ProgramService.getById(design.programId)
        if (program) {
          programNameCache.set(design.programId, program.name)
        }
      }
    }

    const rows = result.items.map((design) => ({
      id: design.id,
      name: design.name,
      code: design.code,
      designType: design.designType,
      programId: design.programId ?? null,
      programName: design.programId
        ? (programNameCache.get(design.programId) ?? null)
        : null,
      description: design.description ?? null,
    }))

    const dialog =
      rows.length >= GRID_MIN_ROWS
        ? await presentDialog(context, 'search_designs', {
            kind: 'data-grid',
            title: input.query
              ? `Designs matching "${input.query}"`
              : 'Designs',
            payload: designGrid(rows, result.total),
            label: resultsLabel(
              Math.min(rows.length, DIALOG_ROW_CAP),
              result.total,
            ),
            summary: gridSummary(result.total),
          })
        : undefined

    return {
      designs: rows.slice(0, limit),
      total: result.total,
      dialog,
    }
  },
)

// ============================================================================
// get_suspect_links handler
// ============================================================================

export const getSuspectLinksHandler = withPermissionAndAudit(
  'get_suspect_links',
  { resource: 'parts', action: 'read' },
  async (input: GetSuspectLinksInput, context: ToolContext) => {
    const limit = input.limit ?? 50
    const options = {
      relationshipType: input.relationshipType,
      suspectOnly: !(input.includeAffirmed ?? false),
      limit,
    }

    // Instance-level gate, the one the wrapper's type-level check cannot
    // supply: the design, or the item, must be one the caller can reach —
    // the same rule as get_item_details and the trace panels' own routes.
    if (input.itemId) {
      const item = await ItemService.findById(input.itemId)
      if (!item) {
        throw new Error(`Item with ID ${input.itemId} not found`)
      }
      await requireItemAccess(context.userId, item.id)
      const result = await TraceLinkService.list({ itemId: item.id }, options)
      return {
        scope: { itemId: item.id, itemNumber: item.itemNumber },
        links: result.links,
        total: result.total,
        suspectTotal: result.links.filter((link) => link.suspect).length,
      }
    }

    const designId = await resolveDesignId(input.designId)
    if (!designId) {
      throw new ValidationError('One of designId or itemId is required')
    }
    await requireDesignAccess(context.userId, designId)
    const design = await DesignService.getById(designId)
    const result = await TraceLinkService.list({ designId }, options)
    return {
      scope: {
        designId,
        designCode: design?.code,
        designName: design?.name,
      },
      links: result.links,
      total: result.total,
      suspectTotal: options.suspectOnly
        ? result.total
        : result.links.filter((link) => link.suspect).length,
    }
  },
)
