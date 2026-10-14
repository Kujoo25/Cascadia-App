// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * System elements: the logical architecture of a design (systems-engineering
 * Phase 5). An element is a versioned, ECO-controlled item; the architecture
 * is two edge types on it:
 *
 * - `DECOMPOSES` (element → child element) is the tree. It is deliberately
 *   not the BOM — one tree serving two masters was rejected in the proposal
 *   — and `ItemRelationshipService` refuses an edge that would close a loop.
 * - `REALIZED_BY` (element → Part/Software) is the hop from the logical
 *   element to the item that implements it, and the hop the requirements
 *   matrix follows after an allocation to the element.
 *
 * Both are edges between version rows, so they ride a checkout onto the
 * branch's working copy and the release rebuilds them on the released row,
 * like every other outgoing edge. The architecture read here resolves them
 * at a version context by the rules the requirements matrix applies — the
 * same helpers, so the two surfaces never disagree about which row answers
 * for an item at a tag.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { itemRelationships, items, systemElements } from '../db/schema/items'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  ALLOCATED_TO_RELATIONSHIP,
  DECOMPOSES_RELATIONSHIP,
  REALIZED_BY_RELATIONSHIP,
} from '../items/traceability-relationships'
import { DesignService } from './DesignService'
import { resolveLinkEndIds, resolveLinkEnds } from './link-ends'
import { suspectFields } from './RequirementService'
import {
  RequirementsMatrixService,
  describeContext,
} from './RequirementsMatrixService'
import type { LinkWriteOptions } from './link-ends'
import type { SuspectLinkFields } from './RequirementService'
import type { VersionContext } from './VersionResolver'
import type { SuspectState } from '../items/trace-affirmation'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import type {
  ArchitectureLink,
  ArchitectureNode,
  ArchitectureTotals,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'

// Wire types live in commons so the web can name them; re-exported so server
// callers keep importing them from here.
export type {
  ArchitectureLink,
  ArchitectureNode,
  ArchitectureTotals,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'

type ItemRow = typeof items.$inferSelect
type EdgeRow = typeof itemRelationships.$inferSelect

/** A child or parent element, as the element's own tree reads list it. */
export interface RelatedElement {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  elementKind: string | null
  relationshipId: string
}

/** An item linked to an element by a suspectable edge. */
export interface ElementLinkedItem extends SuspectLinkFields {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  relationshipId: string
}

const ITEM_SUMMARY = {
  id: items.id,
  masterId: items.masterId,
  itemNumber: items.itemNumber,
  name: items.name,
  itemType: items.itemType,
  revision: items.revision,
  state: items.state,
}

function byItemNumber<T extends { itemNumber: string }>(a: T, b: T): number {
  return a.itemNumber.localeCompare(b.itemNumber)
}

export class SystemElementService {
  // ---- The element's own reads ------------------------------------------

  private static async requireElement(
    elementId: string,
    operation: string,
  ): Promise<PersistedItem> {
    const element = await ItemService.findById(elementId)
    if (!element || element.itemType !== 'SystemElement') {
      throw new NotFoundError('SystemElement', elementId, { operation })
    }
    return element
  }

  private static async elementSummaries(
    rows: Array<EdgeRow>,
    end: 'sourceId' | 'targetId',
  ): Promise<Array<RelatedElement>> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row[end])
    const summaries = await db
      .select({ ...ITEM_SUMMARY, elementKind: systemElements.elementKind })
      .from(items)
      .leftJoin(systemElements, eq(systemElements.itemId, items.id))
      .where(and(inArray(items.id, ids), notDeleted()))
    return summaries
      .map((row) => {
        const edge = rows.find((candidate) => candidate[end] === row.id)
        return {
          id: row.id,
          masterId: row.masterId,
          itemNumber: row.itemNumber,
          name: row.name,
          revision: row.revision,
          state: row.state,
          elementKind: row.elementKind,
          relationshipId: edge!.id,
        }
      })
      .sort(byItemNumber)
  }

  /** The elements this element decomposes into (outgoing `DECOMPOSES`). */
  static async getChildren(elementId: string): Promise<Array<RelatedElement>> {
    const edges =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [elementId],
          DECOMPOSES_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.elementSummaries(edges, 'targetId')
  }

  /**
   * The element this one sits under (incoming `DECOMPOSES`), or null for a
   * root. An element placed under two parents answers with the first by
   * item number, as the design's tree does.
   */
  static async getParent(elementId: string): Promise<RelatedElement | null> {
    const edges =
      (
        await ItemRelationshipService.findIncomingLinks(
          [elementId],
          DECOMPOSES_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    const parents = await this.elementSummaries(edges, 'sourceId')
    return parents[0] ?? null
  }

  /**
   * Place `childIds` under `parentId`. Both ends must be system elements of
   * one design; an edge that would close a loop is refused by the
   * relationship service, which is what `POST /items/:id/relationships`
   * and the AI tools go through as well.
   */
  static async addChildren(
    parentId: string,
    childIds: Array<string>,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const parent = await this.requireElement(parentId, 'addChildren')
    for (const childId of childIds) {
      const child = await this.requireElement(childId, 'addChildren')
      if (child.designId !== parent.designId) {
        throw new ValidationError(
          `${child.itemNumber} is not in the same design as ${parent.itemNumber}; the architecture tree does not cross designs`,
          [{ field: 'itemIds', message: 'Child element is in another design' }],
        )
      }
      await this.link(parent, child, DECOMPOSES_RELATIONSHIP, userId, options)
    }
  }

  static async removeChild(
    parentId: string,
    childId: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    await this.unlink(
      parentId,
      childId,
      DECOMPOSES_RELATIONSHIP,
      userId,
      options,
    )
  }

  /** The items that realize this element (outgoing `REALIZED_BY`). */
  static async getRealizedBy(
    elementId: string,
  ): Promise<Array<ElementLinkedItem>> {
    const edges =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [elementId],
          REALIZED_BY_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.linkedItems(edges, 'targetId')
  }

  /**
   * Record that `itemIds` realize the element. The catalog fixes the item
   * types a realization may name (parts and software).
   */
  static async realize(
    elementId: string,
    itemIds: Array<string>,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const element = await this.requireElement(elementId, 'realize')
    for (const itemId of itemIds) {
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId, { operation: 'realize' })
      }
      await this.link(element, item, REALIZED_BY_RELATIONSHIP, userId, options)
    }
  }

  static async unrealize(
    elementId: string,
    itemId: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    await this.unlink(
      elementId,
      itemId,
      REALIZED_BY_RELATIONSHIP,
      userId,
      options,
    )
  }

  /**
   * The requirements allocated to this element (incoming `ALLOCATED_TO`),
   * inherited from the rows it succeeded the way every incoming trace read
   * is.
   */
  static async getAllocatedRequirements(
    elementId: string,
  ): Promise<Array<ElementLinkedItem>> {
    const edges =
      (
        await ItemRelationshipService.findIncomingLinks(
          [elementId],
          ALLOCATED_TO_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.linkedItems(edges, 'sourceId')
  }

  private static async linkedItems(
    edges: Array<EdgeRow>,
    end: 'sourceId' | 'targetId',
  ): Promise<Array<ElementLinkedItem>> {
    if (edges.length === 0) return []
    const rows = await db
      .select(ITEM_SUMMARY)
      .from(items)
      .where(
        and(
          inArray(
            items.id,
            edges.map((edge) => edge[end]),
          ),
          notDeleted(),
        ),
      )
    const states = await ItemRelationshipService.suspectStatesFor(
      edges.map((edge) => edge.id),
    )
    return rows
      .map((row) => {
        const edge = edges.find((candidate) => candidate[end] === row.id)!
        return {
          id: row.id,
          itemNumber: row.itemNumber,
          name: row.name,
          itemType: row.itemType,
          revision: row.revision,
          state: row.state,
          relationshipId: edge.id,
          ...suspectFields(states, edge.id),
        }
      })
      .sort(byItemNumber)
  }

  private static async link(
    source: PersistedItem,
    target: PersistedItem,
    relationshipType: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const ends = await resolveLinkEnds(source, target, options?.branchId)
    const existing = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.source.id),
          eq(itemRelationships.targetId, ends.target.id),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)
    if (existing.length > 0) return
    await ItemService.addRelationship(
      ends.source.id,
      ends.target.id,
      relationshipType,
      userId,
    )
  }

  private static async unlink(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const ends = await resolveLinkEndIds(sourceId, targetId, options?.branchId)
    const [relationship] = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)
    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  // ---- The design's architecture at a context ---------------------------

  /**
   * The architecture of one design at `context`: the `DECOMPOSES` forest of
   * its system elements, each with the items that realize it and the
   * requirements allocated to it.
   *
   * Resolution is the requirements matrix's: an element's row at the context
   * answers for the allocations made against the rows it succeeded, a
   * realization or a child is followed to the target's row at the context,
   * and a suspect state is judged there — live at a head, against the rows
   * the snapshot holds at a tag or commit. An element placed under two
   * parents appears under the first by item number; a loop that reached the
   * store despite the write guard is broken at the edge that closes it, so
   * the answer is always a forest.
   */
  static async forDesign(
    designId: string,
    context: VersionContext,
  ): Promise<DesignArchitecture> {
    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'designArchitecture',
      })
    }
    const base = {
      designId,
      designCode: design.code,
      designName: design.name,
      context: describeContext(context),
    }

    const atContext = await RequirementsMatrixService.rowsAtContext(
      designId,
      context,
    )
    const elementRows = [...atContext.values()]
      .filter((row) => row.itemType === 'SystemElement')
      .sort(byItemNumber)
    if (elementRows.length === 0) {
      return { ...base, roots: [], totals: emptyTotals() }
    }
    const elementIds = elementRows.map((row) => row.id)
    const extensionByItem = new Map(
      (
        await db
          .select()
          .from(systemElements)
          .where(inArray(systemElements.itemId, elementIds))
      ).map((row) => [row.itemId, row]),
    )

    // The element's own edges, and the allocations made against it or the
    // rows it succeeded. Working copies never lend theirs.
    const outgoing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, elementIds),
          inArray(itemRelationships.relationshipType, [
            DECOMPOSES_RELATIONSHIP,
            REALIZED_BY_RELATIONSHIP,
          ]),
        ),
      )
    const ancestorToOwner =
      await RequirementsMatrixService.predecessorsOf(elementRows)
    const incoming = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, [...ancestorToOwner.keys()]),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )

    const namedIds = [
      ...new Set([
        ...outgoing.map((edge) => edge.targetId),
        ...incoming.map((edge) => edge.sourceId),
      ]),
    ]
    const namedRows =
      namedIds.length > 0
        ? await db.select().from(items).where(inArray(items.id, namedIds))
        : []
    const namedById = new Map(namedRows.map((row) => [row.id, row]))
    const resolvedByMaster =
      await RequirementsMatrixService.resolveCounterparts(
        designId,
        atContext,
        namedRows,
      )

    // A child or a realization is followed to the target's row at the
    // context; an allocation counts only when its source row IS the
    // requirement's row there.
    const keptOutgoing = outgoing.filter((edge) => {
      const named = namedById.get(edge.targetId)
      return (
        named !== undefined && Boolean(resolvedByMaster.get(named.masterId))
      )
    })
    const keptIncoming = incoming.filter((edge) => {
      const named = namedById.get(edge.sourceId)
      const resolved = named ? resolvedByMaster.get(named.masterId) : undefined
      return (
        resolved !== undefined &&
        resolved !== null &&
        resolved.id === edge.sourceId
      )
    })

    const rowById = new Map<string, ItemRow>()
    for (const row of elementRows) rowById.set(row.id, row)
    for (const row of resolvedByMaster.values()) {
      if (row) rowById.set(row.id, row)
    }
    const suspectStates = await RequirementsMatrixService.suspectStates(
      context,
      keptIncoming,
      keptOutgoing,
      ancestorToOwner,
      namedById,
      resolvedByMaster,
      rowById,
    )

    const toLink = (
      edge: EdgeRow,
      row: ItemRow,
      state: SuspectState | undefined,
    ): ArchitectureLink => ({
      relationshipId: edge.id,
      itemId: row.id,
      masterId: row.masterId,
      itemNumber: row.itemNumber,
      name: row.name,
      itemType: row.itemType,
      revision: row.revision,
      state: row.state,
      suspect: state?.suspect ?? false,
      suspectReasons: state?.reasons ?? [],
    })

    const nodeById = new Map<string, ArchitectureNode>()
    for (const row of elementRows) {
      const extension = extensionByItem.get(row.id)
      nodeById.set(row.id, {
        itemId: row.id,
        masterId: row.masterId,
        itemNumber: row.itemNumber,
        name: row.name,
        revision: row.revision,
        state: row.state,
        elementKind: extension?.elementKind ?? null,
        description: extension?.description ?? null,
        realizedBy: [],
        allocatedRequirements: [],
        children: [],
      })
    }

    // Edges in item-number order of their source, then target, so "first
    // parent wins" and the dedup below are deterministic.
    const orderedOutgoing = [...keptOutgoing].sort((a, b) => {
      const bySource = byItemNumber(
        rowById.get(a.sourceId)!,
        rowById.get(b.sourceId)!,
      )
      if (bySource !== 0) return bySource
      const targetA = resolvedByMaster.get(namedById.get(a.targetId)!.masterId)!
      const targetB = resolvedByMaster.get(namedById.get(b.targetId)!.masterId)!
      return byItemNumber(targetA, targetB)
    })
    const parentOf = new Map<string, string>()
    const seen = new Set<string>()
    for (const edge of orderedOutgoing) {
      const node = nodeById.get(edge.sourceId)
      if (!node) continue
      const target = resolvedByMaster.get(
        namedById.get(edge.targetId)!.masterId,
      )!
      const key = `${edge.relationshipType}:${edge.sourceId}:${target.masterId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (edge.relationshipType === DECOMPOSES_RELATIONSHIP) {
        const child = nodeById.get(target.id)
        if (!child || child === node || parentOf.has(child.itemId)) continue
        parentOf.set(child.itemId, node.itemId)
        child.relationshipId = edge.id
        node.children.push(child)
      } else {
        node.realizedBy.push(toLink(edge, target, suspectStates.get(edge.id)))
      }
    }
    for (const edge of keptIncoming) {
      const owner = ancestorToOwner.get(edge.targetId)
      const node = owner ? nodeById.get(owner) : undefined
      const source = namedById.get(edge.sourceId)
      if (!node || !source) continue
      const key = `allocated:${node.itemId}:${source.masterId}`
      if (seen.has(key)) continue
      seen.add(key)
      node.allocatedRequirements.push(
        toLink(edge, source, suspectStates.get(edge.id)),
      )
    }

    // Roots are the unparented elements. A loop has no root, so whatever is
    // not reachable from one is promoted and the edge closing the loop is
    // dropped on the way down.
    const roots = [...nodeById.values()].filter(
      (node) => !parentOf.has(node.itemId),
    )
    const reached = new Set<string>()
    const prune = (node: ArchitectureNode, stack: Set<string>) => {
      reached.add(node.itemId)
      stack.add(node.itemId)
      node.children = node.children.filter((child) => !stack.has(child.itemId))
      for (const child of node.children) {
        if (!reached.has(child.itemId)) prune(child, stack)
      }
      stack.delete(node.itemId)
    }
    for (const root of roots) prune(root, new Set())
    for (const node of nodeById.values()) {
      if (!reached.has(node.itemId)) {
        roots.push(node)
        prune(node, new Set())
      }
    }
    roots.sort(byItemNumber)

    return { ...base, roots, totals: totalsOf([...nodeById.values()]) }
  }
}

function emptyTotals(): ArchitectureTotals {
  return { elements: 0, realized: 0, allocated: 0, suspect: 0 }
}

function totalsOf(nodes: Array<ArchitectureNode>): ArchitectureTotals {
  const totals = emptyTotals()
  totals.elements = nodes.length
  for (const node of nodes) {
    if (node.realizedBy.length > 0) totals.realized += 1
    if (node.allocatedRequirements.length > 0) totals.allocated += 1
    totals.suspect += [
      ...node.realizedBy,
      ...node.allocatedRequirements,
    ].filter((link) => link.suspect).length
  }
  return totals
}
