// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The requirements traceability matrix (RTM): every requirement of a design
 * with what it is allocated to, what satisfies it and what verifies it, read
 * at a version context — main as it stands, a branch, a tag or a commit.
 *
 * A trace claim is an edge between two version rows, and a revision moves
 * only the referring item's own side of it (`items/version-lineage.ts`). So
 * at a context the matrix resolves both ends of every candidate claim to the
 * rows that answer for them *there*:
 *
 * - a requirement's row at the context inherits the incoming claims made
 *   against the rows it succeeded, never against a later revision or another
 *   branch's working copy;
 * - a claim counts only when its source row IS the source's row at the
 *   context — the row that revised a part carries its own copy of every claim
 *   it still makes, so a claim the old row left behind is not followed, and a
 *   working copy's claim is seen on its branch and nowhere else;
 * - an allocation (the requirement's own outgoing edge) names a version row,
 *   and that reference is followed to the target's row at the context.
 *
 * Suspicion follows the same rule. At main or a branch a claim is judged as
 * the live readers judge it (`ItemRelationshipService.suspectStatesFor`), so
 * the matrix and the requirement page never disagree. At a tag or a commit a
 * claim is judged against the rows the snapshot holds: it is suspect when its
 * affirmation names a row the snapshot's row superseded — the claim predates
 * this revision and nobody has looked at it since — and not when it names
 * that row or a later one, since an affirmation made after the baseline does
 * not make the baseline suspect in hindsight. An edge records only its latest
 * affirmation, so this is as much as a snapshot can know.
 *
 * "Verified" is the one rule every coverage read applies
 * (`services/verification-rollup.ts`): the derived status says Passed or a
 * waiver is recorded, and no verifying claim is suspect. The three gaps are
 * independent flags here, not the first-that-applies chain `getCoverage`
 * reports, because the tab filters by each.
 */

import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import {
  branchItems,
  branches,
  itemRelationships,
  items,
  requirements,
  testCases,
} from '../db/schema'
import { NotFoundError } from '../errors'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { affirmationOf, isSuspectable } from '../items/trace-affirmation'
import {
  ALLOCATED_TO_RELATIONSHIP,
  REALIZED_BY_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from '../items/traceability-relationships'
import { DesignService } from './DesignService'
import { RevisionService } from './RevisionService'
import { VersionResolver } from './VersionResolver'
import { isVerifiedStatus } from './verification-rollup'
import type { VersionContext } from './VersionResolver'
import type { SuspectState } from '../items/trace-affirmation'
import type {
  RequirementsMatrix,
  RequirementsRollup,
  RequirementsRollupDesign,
  RequirementsRollupGap,
  RtmContext,
  RtmGapType,
  RtmLink,
  RtmRow,
  RtmTotals,
  RtmVerifyingTest,
} from '@cascadia/commons/services/types/requirements-matrix'

// Wire types live in commons so the web can name them; re-exported so server
// callers keep importing them from here.
export type {
  RequirementsMatrix,
  RequirementsRollup,
  RequirementsRollupDesign,
  RequirementsRollupGap,
  RtmContext,
  RtmGapType,
  RtmLink,
  RtmRow,
  RtmTotals,
  RtmVerifyingTest,
} from '@cascadia/commons/services/types/requirements-matrix'

type ItemRow = typeof items.$inferSelect
type EdgeRow = typeof itemRelationships.$inferSelect

const PRIORITY_ORDER = ['MustHave', 'ShouldHave', 'CouldHave', 'WontHave']

/** How many open gaps a program rollup lists; the total is reported beside. */
const ROLLUP_GAP_CAP = 200

function emptyTotals(): RtmTotals {
  return {
    total: 0,
    allocated: 0,
    satisfied: 0,
    verified: 0,
    suspect: 0,
    gaps: { not_allocated: 0, not_satisfied: 0, not_verified: 0 },
  }
}

export function describeContext(context: VersionContext): RtmContext {
  switch (context.type) {
    case 'branch':
      return { type: 'branch', id: context.branchId }
    case 'tag':
      return { type: 'tag', id: context.tagId }
    case 'commit':
      return { type: 'commit', id: context.commitId }
    default:
      return { type: 'released', id: null }
  }
}

/** A snapshot has no "current" row to judge a claim against; a head does. */
function isSnapshot(context: VersionContext): boolean {
  return context.type === 'tag' || context.type === 'commit'
}

export class RequirementsMatrixService {
  /**
   * The matrix of one design at `context`. Rows are the requirements that
   * exist there, in item-number order.
   */
  static async forDesign(
    designId: string,
    context: VersionContext,
  ): Promise<RequirementsMatrix> {
    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'requirementsMatrix',
      })
    }

    const atContext = await this.rowsAtContext(designId, context)
    const requirementRows = [...atContext.values()]
      .filter((row) => row.itemType === 'Requirement')
      .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

    const base = {
      designId,
      designCode: design.code,
      designName: design.name,
      context: describeContext(context),
    }
    if (requirementRows.length === 0) {
      return { ...base, rows: [], totals: emptyTotals() }
    }

    const requirementIds = requirementRows.map((row) => row.id)
    const extensionRows = await db
      .select()
      .from(requirements)
      .where(inArray(requirements.itemId, requirementIds))
    const extensionByItem = new Map(
      extensionRows.map((row) => [row.itemId, row]),
    )

    // The incoming claims each row answers for: its own, and those made
    // against the rows it succeeded. Working copies never lend theirs.
    const ancestorToOwner = await this.predecessorsOf(requirementRows)
    const incoming = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, [...ancestorToOwner.keys()]),
          inArray(itemRelationships.relationshipType, [
            SATISFIES_RELATIONSHIP,
            VERIFIED_BY_RELATIONSHIP,
          ]),
        ),
      )
    const outgoing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, requirementIds),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )

    // The rows the edges name, and the row each one's master resolves to at
    // the context.
    const namedIds = [
      ...new Set([
        ...incoming.map((edge) => edge.sourceId),
        ...outgoing.map((edge) => edge.targetId),
      ]),
    ]
    const namedRows =
      namedIds.length > 0
        ? await db.select().from(items).where(inArray(items.id, namedIds))
        : []
    const namedById = new Map(namedRows.map((row) => [row.id, row]))
    const resolvedByMaster = await this.resolveCounterparts(
      designId,
      atContext,
      namedRows,
    )

    // Keep a claim whose source is the source's row at the context, and an
    // allocation whose target resolves there at all.
    const keptIncoming = incoming.filter((edge) => {
      const named = namedById.get(edge.sourceId)
      const resolved = named ? resolvedByMaster.get(named.masterId) : undefined
      return (
        resolved !== undefined &&
        resolved !== null &&
        resolved.id === edge.sourceId
      )
    })
    const keptOutgoing = outgoing.filter((edge) => {
      const named = namedById.get(edge.targetId)
      return (
        named !== undefined && Boolean(resolvedByMaster.get(named.masterId))
      )
    })

    // The second hop of an allocation to a system element: the items that
    // realize the element at the context, judged the way the allocation is.
    const allocatedElements = new Map<string, ItemRow>()
    for (const edge of keptOutgoing) {
      const named = namedById.get(edge.targetId)
      const target = named ? resolvedByMaster.get(named.masterId) : undefined
      if (target && target.itemType === 'SystemElement') {
        allocatedElements.set(target.id, target)
      }
    }
    const realizedByElement = await this.realizationsOf(
      designId,
      context,
      atContext,
      [...allocatedElements.values()],
    )

    const rowById = new Map<string, ItemRow>()
    for (const row of requirementRows) rowById.set(row.id, row)
    for (const row of resolvedByMaster.values()) {
      if (row) rowById.set(row.id, row)
    }
    const suspectStates = await this.suspectStates(
      context,
      keptIncoming,
      keptOutgoing,
      ancestorToOwner,
      namedById,
      resolvedByMaster,
      rowById,
    )

    const verifyingIds = [
      ...new Set(
        keptIncoming
          .filter((edge) => edge.relationshipType === VERIFIED_BY_RELATIONSHIP)
          .map((edge) => edge.sourceId),
      ),
    ]
    const testRows =
      verifyingIds.length > 0
        ? await db
            .select({
              itemId: testCases.itemId,
              executionStatus: testCases.executionStatus,
              lastExecutedAt: testCases.lastExecutedAt,
            })
            .from(testCases)
            .where(inArray(testCases.itemId, verifyingIds))
        : []
    const testByItem = new Map(testRows.map((row) => [row.itemId, row]))

    const toLink = (
      edge: EdgeRow,
      row: ItemRow,
      state: SuspectState | undefined,
    ): RtmLink => ({
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

    const incomingByOwner = new Map<string, Array<EdgeRow>>()
    for (const edge of keptIncoming) {
      const owner = ancestorToOwner.get(edge.targetId)
      if (!owner) continue
      const list = incomingByOwner.get(owner) ?? []
      list.push(edge)
      incomingByOwner.set(owner, list)
    }
    const outgoingBySource = new Map<string, Array<EdgeRow>>()
    for (const edge of keptOutgoing) {
      const list = outgoingBySource.get(edge.sourceId) ?? []
      list.push(edge)
      outgoingBySource.set(edge.sourceId, list)
    }

    const rows: Array<RtmRow> = []
    for (const row of requirementRows) {
      const extension = extensionByItem.get(row.id)
      const satisfiedBy: Array<RtmLink> = []
      const verifiedBy: Array<RtmVerifyingTest> = []
      const seenMasters = new Set<string>()
      for (const edge of incomingByOwner.get(row.id) ?? []) {
        const source = namedById.get(edge.sourceId)
        if (!source) continue
        // One line per counterpart: two rows of one master naming this
        // requirement were resolved to the same row above.
        const key = `${edge.relationshipType}:${source.masterId}`
        if (seenMasters.has(key)) continue
        seenMasters.add(key)
        const link = toLink(edge, source, suspectStates.get(edge.id))
        if (edge.relationshipType === VERIFIED_BY_RELATIONSHIP) {
          const test = testByItem.get(source.id)
          verifiedBy.push({
            ...link,
            executionStatus: test?.executionStatus ?? null,
            lastExecutedAt: test?.lastExecutedAt?.toISOString() ?? null,
          })
        } else {
          satisfiedBy.push(link)
        }
      }
      const allocatedTo: Array<RtmLink> = []
      for (const edge of outgoingBySource.get(row.id) ?? []) {
        const named = namedById.get(edge.targetId)
        const target = named ? resolvedByMaster.get(named.masterId) : undefined
        if (!target) continue
        const key = `allocated:${target.masterId}`
        if (seenMasters.has(key)) continue
        seenMasters.add(key)
        const link = toLink(edge, target, suspectStates.get(edge.id))
        if (target.itemType === 'SystemElement') {
          link.realizedBy = realizedByElement.get(target.id) ?? []
        }
        allocatedTo.push(link)
      }

      const verified =
        isVerifiedStatus(extension?.verificationStatus ?? null) &&
        !verifiedBy.some((link) => link.suspect)
      const gaps: Array<RtmGapType> = []
      if (allocatedTo.length === 0) gaps.push('not_allocated')
      if (satisfiedBy.length === 0) gaps.push('not_satisfied')
      if (!verified) gaps.push('not_verified')
      const suspectCount = [
        ...allocatedTo,
        ...satisfiedBy,
        ...verifiedBy,
      ].filter((link) => link.suspect).length

      rows.push({
        requirement: {
          id: row.id,
          masterId: row.masterId,
          itemNumber: row.itemNumber,
          name: row.name,
          revision: row.revision,
          state: row.state,
          priority: extension?.priority ?? null,
          requirementType: extension?.type ?? null,
          verificationMethod: extension?.verificationMethod ?? null,
          verificationStatus: extension?.verificationStatus ?? null,
        },
        allocatedTo,
        satisfiedBy,
        verifiedBy,
        verified,
        suspectCount,
        gaps,
      })
    }

    return { ...base, rows, totals: this.totalsOf(rows) }
  }

  /**
   * Every design of a program at its released view, one line each, with the
   * open gaps across the program — the most important first.
   */
  static async forProgram(programId: string): Promise<RequirementsRollup> {
    const programDesigns = await DesignService.listByProgram(programId)
    const designs: Array<RequirementsRollupDesign> = []
    const openGaps: Array<RequirementsRollupGap> = []
    const totals = emptyTotals()

    for (const design of programDesigns) {
      // A family groups variants; its members' matrices are their own.
      if (design.designType === 'Family') continue
      const matrix = await this.forDesign(design.id, {
        type: 'released',
        designId: design.id,
      })
      designs.push({
        designId: design.id,
        designCode: design.code,
        designName: design.name,
        designType: design.designType,
        ...matrix.totals,
      })
      this.addTotals(totals, matrix.totals)
      for (const row of matrix.rows) {
        for (const gapType of row.gaps) {
          openGaps.push({
            designId: design.id,
            designCode: design.code,
            requirementId: row.requirement.id,
            itemNumber: row.requirement.itemNumber,
            name: row.requirement.name,
            priority: row.requirement.priority,
            gapType,
          })
        }
      }
    }

    designs.sort((a, b) => a.designCode.localeCompare(b.designCode))
    openGaps.sort((a, b) => {
      const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
      if (byPriority !== 0) return byPriority
      const byDesign = a.designCode.localeCompare(b.designCode)
      if (byDesign !== 0) return byDesign
      return a.itemNumber.localeCompare(b.itemNumber)
    })

    return {
      programId,
      designs,
      totals,
      openGaps: openGaps.slice(0, ROLLUP_GAP_CAP),
      openGapsTotal: openGaps.length,
    }
  }

  // ---- The rows at a context ------------------------------------------
  //
  // The four resolvers below are shared with `SystemElementService`, which
  // reads the architecture at a context by the same rules — one definition
  // of which row answers for an item at a tag, so the two never disagree.

  /**
   * The design's items at `context`, keyed by master. Main as it stands is
   * read the way every live coverage read does — the current rows, which a
   * branch's working copy never is — so a requirement drafted on main before
   * the first release counts here as it counts there; a branch, a tag or a
   * commit resolves through `VersionResolver`.
   *
   * A row *created* on a live branch is current too, and is nobody's until
   * the merge: it is left out, by the branch rows that hold it as their own
   * content. The merge archives the branch and releases a fresh row, so a
   * merged item is never caught by this.
   */
  static async rowsAtContext(
    designId: string,
    context: VersionContext,
  ): Promise<Map<string, ItemRow>> {
    if (context.type === 'released') {
      const branchOnly = await db
        .select({ itemId: branchItems.currentItemId })
        .from(branchItems)
        .innerJoin(branches, eq(branches.id, branchItems.branchId))
        .where(
          and(
            eq(branches.designId, designId),
            ne(branches.branchType, 'main'),
            eq(branches.isArchived, false),
            isNotNull(branchItems.changeType),
            isNotNull(branchItems.currentItemId),
          ),
        )
      const hidden = new Set(branchOnly.map((row) => row.itemId))
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.designId, designId),
            eq(items.isCurrent, true),
            notDeleted(),
          ),
        )
      return new Map(
        rows
          .filter((row) => !hidden.has(row.id))
          .map((row) => [row.masterId, row]),
      )
    }
    const { items: rows } = await VersionResolver.getItemsAtContext(
      designId,
      context,
    )
    return new Map(
      rows.filter((row) => !row.isDeleted).map((row) => [row.masterId, row]),
    )
  }

  /**
   * For each requirement row, the rows of its master whose incoming claims
   * it answers for: itself and every released row before it. A later
   * revision's claims are not its business, and a working copy never lends
   * what was claimed against it to anything — that is the branch isolation
   * guarantee, and it is why the live readers never inherit from one either.
   */
  static async predecessorsOf(
    rows: Array<ItemRow>,
  ): Promise<Map<string, string>> {
    const byMaster = new Map(rows.map((row) => [row.masterId, row]))
    const ancestorToOwner = new Map<string, string>()
    for (const row of rows) ancestorToOwner.set(row.id, row.id)

    const lineage = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        revision: items.revision,
        createdAt: items.createdAt,
      })
      .from(items)
      .where(and(inArray(items.masterId, [...byMaster.keys()]), notDeleted()))
    for (const ancestor of lineage) {
      const owner = byMaster.get(ancestor.masterId)
      if (!owner || ancestor.id === owner.id) continue
      if (RevisionService.isWorkingRevision(ancestor.revision)) continue
      if (revisionOrder(ancestor, owner) < 0) {
        ancestorToOwner.set(ancestor.id, owner.id)
      }
    }
    return ancestorToOwner
  }

  /**
   * The row each named master resolves to at the context: for this design's
   * items the row the context holds, for an item of another design — a
   * library part a requirement is allocated to — the row that is current
   * now, since another design's history is not this context's.
   */
  static async resolveCounterparts(
    designId: string,
    atContext: Map<string, ItemRow>,
    namedRows: Array<ItemRow>,
  ): Promise<Map<string, ItemRow | null>> {
    const resolved = new Map<string, ItemRow | null>()
    const foreignMasters = new Set<string>()
    for (const row of namedRows) {
      if (row.designId === designId) {
        resolved.set(row.masterId, atContext.get(row.masterId) ?? null)
      } else {
        foreignMasters.add(row.masterId)
      }
    }
    if (foreignMasters.size > 0) {
      const current = await db
        .select()
        .from(items)
        .where(
          and(
            inArray(items.masterId, [...foreignMasters]),
            eq(items.isCurrent, true),
            notDeleted(),
          ),
        )
      for (const master of foreignMasters) resolved.set(master, null)
      for (const row of current) resolved.set(row.masterId, row)
    }
    return resolved
  }

  /**
   * For each system element row, the items that realize it at the context —
   * its `REALIZED_BY` edges, followed to the target's row there and judged
   * like any outgoing claim. The matrix attaches these to an allocation whose
   * target is an element, so a row reads requirement → element → part.
   */
  private static async realizationsOf(
    designId: string,
    context: VersionContext,
    atContext: Map<string, ItemRow>,
    elementRows: Array<ItemRow>,
  ): Promise<Map<string, Array<RtmLink>>> {
    const realized = new Map<string, Array<RtmLink>>()
    if (elementRows.length === 0) return realized
    const edges = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(
            itemRelationships.sourceId,
            elementRows.map((row) => row.id),
          ),
          eq(itemRelationships.relationshipType, REALIZED_BY_RELATIONSHIP),
        ),
      )
    if (edges.length === 0) return realized
    const namedRows = await db
      .select()
      .from(items)
      .where(
        inArray(items.id, [...new Set(edges.map((edge) => edge.targetId))]),
      )
    const namedById = new Map(namedRows.map((row) => [row.id, row]))
    const resolvedByMaster = await this.resolveCounterparts(
      designId,
      atContext,
      namedRows,
    )
    const kept = edges.filter((edge) => {
      const named = namedById.get(edge.targetId)
      return (
        named !== undefined && Boolean(resolvedByMaster.get(named.masterId))
      )
    })
    const rowById = new Map<string, ItemRow>()
    for (const row of elementRows) rowById.set(row.id, row)
    for (const row of resolvedByMaster.values()) {
      if (row) rowById.set(row.id, row)
    }
    const states = await this.suspectStates(
      context,
      [],
      kept,
      new Map(),
      namedById,
      resolvedByMaster,
      rowById,
    )
    const seen = new Set<string>()
    for (const edge of kept) {
      const named = namedById.get(edge.targetId)
      const target = named ? resolvedByMaster.get(named.masterId) : undefined
      if (!target) continue
      const key = `${edge.sourceId}:${target.masterId}`
      if (seen.has(key)) continue
      seen.add(key)
      const links = realized.get(edge.sourceId) ?? []
      links.push(rtmLinkOf(edge, target, states.get(edge.id)))
      realized.set(edge.sourceId, links)
    }
    return realized
  }

  /**
   * The suspect state of each kept edge. At a head it is what the live
   * readers say. At a snapshot a claim is judged against the row the
   * snapshot holds: suspect when its affirmation names a row that row
   * superseded, not when it names that row or a later one (see the header).
   */
  static async suspectStates(
    context: VersionContext,
    keptIncoming: Array<EdgeRow>,
    keptOutgoing: Array<EdgeRow>,
    ancestorToOwner: Map<string, string>,
    namedById: Map<string, ItemRow>,
    resolvedByMaster: Map<string, ItemRow | null>,
    rowById: Map<string, ItemRow>,
  ): Promise<Map<string, SuspectState>> {
    if (!isSnapshot(context)) {
      return ItemRelationshipService.suspectStatesFor(
        [...keptIncoming, ...keptOutgoing].map((edge) => edge.id),
      )
    }
    const judged: Array<{ edge: EdgeRow; targetAtSnapshot: ItemRow }> = []
    for (const edge of keptIncoming) {
      const owner = ancestorToOwner.get(edge.targetId)
      const row = owner ? rowById.get(owner) : undefined
      if (row) judged.push({ edge, targetAtSnapshot: row })
    }
    for (const edge of keptOutgoing) {
      const named = namedById.get(edge.targetId)
      const target = named ? resolvedByMaster.get(named.masterId) : undefined
      if (target) judged.push({ edge, targetAtSnapshot: target })
    }
    const later = await this.laterRowsOf(
      judged.map(({ targetAtSnapshot }) => targetAtSnapshot),
    )
    const states = new Map<string, SuspectState>()
    for (const { edge, targetAtSnapshot } of judged) {
      states.set(
        edge.id,
        snapshotSuspectState(
          edge,
          targetAtSnapshot.id,
          later.get(targetAtSnapshot.id) ?? new Set(),
        ),
      )
    }
    return states
  }

  /**
   * For each row, the released rows of its master minted after it — the
   * revisions a snapshot holding the row does not yet know about.
   */
  private static async laterRowsOf(
    rows: Array<ItemRow>,
  ): Promise<Map<string, Set<string>>> {
    const later = new Map<string, Set<string>>()
    const byId = new Map(rows.map((row) => [row.id, row]))
    if (byId.size === 0) return later
    const lineage = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        revision: items.revision,
        createdAt: items.createdAt,
      })
      .from(items)
      .where(
        inArray(items.masterId, [
          ...new Set([...byId.values()].map((row) => row.masterId)),
        ]),
      )
    for (const row of byId.values()) {
      const successors = new Set<string>()
      for (const candidate of lineage) {
        if (candidate.masterId !== row.masterId || candidate.id === row.id) {
          continue
        }
        if (RevisionService.isWorkingRevision(candidate.revision)) continue
        if (revisionOrder(candidate, row) > 0) successors.add(candidate.id)
      }
      later.set(row.id, successors)
    }
    return later
  }

  // ---- Totals ----------------------------------------------------------

  private static totalsOf(rows: Array<RtmRow>): RtmTotals {
    const totals = emptyTotals()
    totals.total = rows.length
    for (const row of rows) {
      if (row.allocatedTo.length > 0) totals.allocated += 1
      if (row.satisfiedBy.length > 0) totals.satisfied += 1
      if (row.verified) totals.verified += 1
      if (row.suspectCount > 0) totals.suspect += 1
      for (const gap of row.gaps) totals.gaps[gap] += 1
    }
    return totals
  }

  private static addTotals(into: RtmTotals, from: RtmTotals): void {
    into.total += from.total
    into.allocated += from.allocated
    into.satisfied += from.satisfied
    into.verified += from.verified
    into.suspect += from.suspect
    into.gaps.not_allocated += from.gaps.not_allocated
    into.gaps.not_satisfied += from.gaps.not_satisfied
    into.gaps.not_verified += from.gaps.not_verified
  }
}

/** One end of a claim, resolved to `row` at the context, with its suspect state. */
function rtmLinkOf(
  edge: EdgeRow,
  row: ItemRow,
  state: SuspectState | undefined,
): RtmLink {
  return {
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
  }
}

/**
 * `suspectStateOf` for a snapshot: the target is the row the snapshot holds,
 * and an affirmation against that row or any later revision of it stands.
 */
function snapshotSuspectState(
  edge: EdgeRow,
  targetAtSnapshot: string,
  laterRows: ReadonlySet<string>,
): SuspectState {
  const affirmation = affirmationOf(edge.metadata)
  if (!isSuspectable(edge.relationshipType)) {
    return { suspect: false, reasons: [], affirmation }
  }
  const affirmed = affirmation ?? {
    sourceId: edge.sourceId,
    targetId: edge.targetId,
  }
  const reasons: SuspectState['reasons'] = []
  if (affirmed.sourceId !== edge.sourceId) reasons.push('source_revised')
  if (
    affirmed.targetId !== targetAtSnapshot &&
    !laterRows.has(affirmed.targetId)
  ) {
    reasons.push('target_revised')
  }
  return { suspect: reasons.length > 0, reasons, affirmation }
}

/**
 * Which of two released rows of one master came first. Minted in separate
 * transactions, as releases are, `createdAt` decides; rows minted in one
 * transaction share it (`now()` is the transaction's), so the revision itself
 * breaks the tie — a letter scheme by position, a numeric or prefixed scheme
 * by its number.
 */
function revisionOrder(
  a: { revision: string; createdAt: Date },
  b: { revision: string; createdAt: Date },
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime()
  if (byTime !== 0) return byTime
  return revisionOrdinal(a.revision) - revisionOrdinal(b.revision)
}

function revisionOrdinal(revision: string): number {
  if (/^[A-Za-z]+$/.test(revision)) {
    let ordinal = 0
    for (const letter of revision.toUpperCase()) {
      ordinal = ordinal * 26 + (letter.charCodeAt(0) - 64)
    }
    return ordinal
  }
  const digits = /\d+/.exec(revision)
  return digits ? Number.parseInt(digits[0], 10) : 0
}

function priorityRank(priority: string | null): number {
  const index = priority ? PRIORITY_ORDER.indexOf(priority) : -1
  return index === -1 ? PRIORITY_ORDER.length : index
}
