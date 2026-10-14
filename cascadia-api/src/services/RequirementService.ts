// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { designs } from '../db/schema/designs'
import { itemRelationships, items, requirements } from '../db/schema/items'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  ALLOCATED_TO_RELATIONSHIP,
  DERIVES_FROM_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
} from '../items/traceability-relationships'
import { resolveInheritedLineage } from '../items/version-lineage'
import { REQUIREMENT_VERIFICATION_CHANGED, publishDomainEvent } from '../events'
import { BranchService } from './BranchService'
import { resolveLinkEndIds, resolveLinkEnds } from './link-ends'
import { VersionResolver } from './VersionResolver'
import {
  isVerifiedStatus,
  rollupVerificationForMasters,
} from './verification-rollup'
import type { VersionContext } from './VersionResolver'
import type { SuspectReason, SuspectState } from '../items/trace-affirmation'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import type { RequirementSheetRow } from '@cascadia/commons/import/types/requirement'
import type {
  Requirement,
  VerificationWaiver,
} from '@cascadia/commons/items/types/requirement'

/**
 * The suspect flag a trace reader attaches to each link it lists — see
 * `items/trace-affirmation.ts`. A link whose state could not be computed
 * (the edge vanished between the two reads) is reported as not suspect.
 */
export interface SuspectLinkFields {
  suspect: boolean
  suspectReasons: Array<SuspectReason>
}

/**
 * The owners (keys of a `findIncomingLinks`/`findOutgoingLinks` read) with at
 * least one suspect link among those listed for them. The coverage reads
 * combine it with the derived status: a claim under review is not evidence.
 */
export async function requirementsWithSuspectLinks(
  links: Map<string, Array<{ id: string }>>,
): Promise<Set<string>> {
  const ownerOfLink = new Map<string, string>()
  for (const [ownerId, rels] of links) {
    for (const rel of rels) ownerOfLink.set(rel.id, ownerId)
  }
  const suspect = new Set<string>()
  if (ownerOfLink.size === 0) return suspect
  const states = await ItemRelationshipService.suspectStatesFor([
    ...ownerOfLink.keys(),
  ])
  for (const [relationshipId, ownerId] of ownerOfLink) {
    if (states.get(relationshipId)?.suspect) suspect.add(ownerId)
  }
  return suspect
}

/** The `SuspectLinkFields` for one listed link, from a `suspectStatesFor` read. */
export function suspectFields(
  states: Map<string, SuspectState>,
  relationshipId: string,
): SuspectLinkFields {
  const state = states.get(relationshipId)
  return {
    suspect: state?.suspect ?? false,
    suspectReasons: state?.reasons ?? [],
  }
}

/**
 * Relationship type constants for requirements domain.
 * Defined in `items/traceability-relationships` so the edit-lock policy
 * can name them without importing this service back; re-exported here because
 * this is where callers have always found them.
 */
export {
  ALLOCATED_TO_RELATIONSHIP,
  DERIVES_FROM_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
}

/**
 * Where a traceability link write lands.
 *
 * Every link here is a content edit of one of its two items, so it obeys the
 * same rule as any other structural edit: a branch row whose checkout the
 * caller holds, or main before anything in the design has released
 * (`ItemEditPolicy.requireContentEditable`). `branchId` is how a caller says
 * "inside this ECO": both ends resolve to the rows that branch is working
 * from, so the caller can keep naming items by the ids it already has —
 * usually main's — without knowing any working-copy id. Without it the link
 * is written against the rows named, which on a released design means main,
 * and is refused with the ECO hint.
 *
 * Deliberately **not** a checkout: naming a branch resolves rows, it does not
 * take locks or start revisions. Pulling an item into an ECO's scope is
 * `POST /change-orders/:id/checkout` and stays an explicit act — a link
 * endpoint that silently added items to the reviewed set would put content in
 * a release nobody asked for. Same stance as the ECO BOM editor, which
 * refuses a parent that is not already an affected item.
 */
export interface TraceabilityLinkOptions {
  branchId?: string
}

/**
 * The subset of the items asked about that had at least one link, for the
 * coverage counters that only care whether an item is covered at all.
 */
export function idsWithLinks(links: Map<string, Array<unknown>>): Set<string> {
  const covered = new Set<string>()
  for (const [id, found] of links) {
    if (found.length > 0) covered.add(id)
  }
  return covered
}

/**
 * Gap information for requirements coverage
 */
export interface RequirementGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  gapType: 'not_allocated' | 'not_satisfied' | 'not_verified'
}

/**
 * One suspect trace link in a design's coverage: the requirement it is
 * about, the other end, and why the claim is stale.
 */
export interface SuspectCoverageLink {
  requirementId: string
  requirementNumber: string
  requirementName: string | null
  priority: string | null
  relationshipId: string
  relationshipType: string
  /** The item at the other end of the link, resolved to its current row. */
  counterpartId: string
  counterpartNumber: string
  counterpartName: string | null
  counterpartType: string
  suspectReasons: Array<SuspectReason>
}

/**
 * Requirements coverage metrics for a design
 */
export interface RequirementsCoverage {
  totalRequirements: number
  allocated: number
  satisfied: number
  verified: number
  /**
   * Requirements with at least one suspect trace link — a satisfaction,
   * allocation or verification claim one of whose ends revised since it was
   * last affirmed. Counted beside the coverage figures rather than subtracted
   * from them: the link is still there, it just needs a look.
   */
  suspect: number
  allocatedPercent: number
  satisfiedPercent: number
  verifiedPercent: number
  suspectPercent: number
  gaps: Array<RequirementGap>
  suspectLinks: Array<SuspectCoverageLink>
}

/**
 * Item that satisfies a requirement
 */
export interface SatisfyingItem extends SuspectLinkFields {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  relationshipId: string
}

/**
 * Service for requirements traceability and satisfaction linking
 */
export class RequirementService {
  /**
   * Create SATISFIES relationships between items and a requirement.
   * Direction: Item (Part/Document) → Requirement (source → target)
   */
  static async linkSatisfaction(
    requirementId: string,
    itemIds: Array<string>,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'linkSatisfaction',
      })
    }

    // Create relationships for each item
    for (const itemId of itemIds) {
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId, {
          operation: 'linkSatisfaction',
        })
      }

      const ends = await resolveLinkEnds(item, requirement, options?.branchId)

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, ends.source.id),
            eq(itemRelationships.targetId, ends.target.id),
            eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          ends.source.id,
          ends.target.id,
          SATISFIES_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a SATISFIES relationship between an item and a requirement.
   */
  static async unlinkSatisfaction(
    requirementId: string,
    itemId: string,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await resolveLinkEndIds(
      itemId,
      requirementId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get items that satisfy a requirement.
   */
  static async getSatisfyingItems(
    requirementId: string,
  ): Promise<Array<SatisfyingItem>> {
    // Everything that satisfies this requirement now: links it inherited from
    // the revision it replaced, minus links a revision left behind.
    const relationships =
      (
        await ItemRelationshipService.findIncomingLinks(
          [requirementId],
          SATISFIES_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each satisfying item
    const sourceIds = relationships.map((r) => r.sourceId)
    const sourceItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, sourceIds), notDeleted()))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Map items to include relationship ID
    return sourceItems.map((item) => {
      const rel = relationships.find((r) => r.sourceId === item.id)
      return {
        ...item,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }

  /**
   * Get requirements that an item satisfies.
   */
  static async getRequirementsSatisfiedBy(itemId: string): Promise<
    Array<
      {
        id: string
        itemNumber: string
        name: string | null
        priority: string | null
        verificationStatus: string | null
        relationshipId: string
      } & SuspectLinkFields
    >
  > {
    // A requirement revised since this link was made is named by the row the
    // release superseded, so targets resolve forward.
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [itemId],
          SATISFIES_RELATIONSHIP,
        )
      ).get(itemId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each requirement
    const targetIds = relationships.map((r) => r.targetId)
    const requirementItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, targetIds),
          eq(items.itemType, 'Requirement'),
          notDeleted(),
        ),
      )

    // Get requirement-specific data
    const requirementData = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(requirements)
      .where(inArray(requirements.itemId, targetIds))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Combine data
    return requirementItems.map((req) => {
      const rel = relationships.find((r) => r.targetId === req.id)
      const reqData = requirementData.find((r) => r.itemId === req.id)
      return {
        id: req.id,
        itemNumber: req.itemNumber,
        name: req.name,
        priority: reqData?.priority ?? null,
        verificationStatus: reqData?.verificationStatus ?? null,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }

  /**
   * Allocate a requirement to a target item (Part or Document).
   * Creates an ALLOCATED_TO relationship.
   */
  static async allocateToDesign(
    requirementId: string,
    targetItemId: string,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'allocateToDesign',
      })
    }

    // Verify target item exists
    const targetItem = await ItemService.findById(targetItemId)
    if (!targetItem) {
      throw new NotFoundError('Item', targetItemId, {
        operation: 'allocateToDesign',
      })
    }

    const ends = await resolveLinkEnds(
      requirement,
      targetItem,
      options?.branchId,
    )

    // Check if relationship already exists
    const existing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.source.id),
          eq(itemRelationships.targetId, ends.target.id),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (existing.length === 0) {
      await ItemService.addRelationship(
        ends.source.id,
        ends.target.id,
        ALLOCATED_TO_RELATIONSHIP,
        userId,
      )
    }
  }

  /**
   * Remove allocation of a requirement to a target item.
   */
  static async removeAllocation(
    requirementId: string,
    targetItemId: string,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await resolveLinkEndIds(
      requirementId,
      targetItemId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get the items a requirement is allocated to (ALLOCATED_TO relationships).
   *
   * The mirror of `getSatisfyingItems`: allocation runs requirement → item,
   * so this reads the requirement's outgoing edges. Gap analysis reports
   * `unallocated_requirement` against exactly this set.
   */
  static async getAllocatedItems(
    requirementId: string,
  ): Promise<Array<SatisfyingItem>> {
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [requirementId],
          ALLOCATED_TO_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

    if (relationships.length === 0) {
      return []
    }

    const targetIds = relationships.map((r) => r.targetId)
    const targetItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, targetIds), notDeleted()))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    return targetItems.map((item) => {
      const rel = relationships.find((r) => r.targetId === item.id)
      return {
        ...item,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }

  /**
   * Create a derived requirement from a parent requirement.
   * Sets up the parentRequirementId field for the derived requirement.
   *
   * Where the child lands, in order:
   *
   * 1. `options.branchId`, when the caller names one.
   * 2. The parent's own branch, when the parent row is the working copy on an
   *    ECO or workspace branch — a refinement of a requirement being edited
   *    under a change order belongs in that change order.
   * 3. Main, which only succeeds while the design is pre-release.
   *
   * Requirements are ECO-driven, so once anything in the design has been
   * released main is protected and a branch is the only place a child can go.
   * That is exactly when requirements get decomposed, so a derive with no way
   * to name a branch was unusable for the whole post-release life of a design.
   */
  static async deriveRequirement(
    parentRequirementId: string,
    childData: Partial<Requirement>,
    userId: string,
    options?: { branchId?: string; commitMessage?: string },
  ): Promise<Requirement> {
    // Verify parent requirement exists
    const parentRequirement = await ItemService.findById(parentRequirementId)
    if (!parentRequirement || parentRequirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', parentRequirementId, {
        operation: 'deriveRequirement',
      })
    }

    // findById merges the type-specific row into the item, so the requirement
    // columns are there at runtime; `PersistedItem` types only the base ones,
    // and they come back nullable because that is what the columns are.
    const parentFields = parentRequirement as typeof parentRequirement & {
      verificationMethod?: Requirement['verificationMethod'] | null
      category?: string | null
      source?: string | null
    }

    // Generate itemNumber for derived requirement if not provided
    // Format: PARENT-D1, PARENT-D2, etc.
    let itemNumber = childData.itemNumber
    if (!itemNumber) {
      // The highest `-D<n>` already taken, not the number of children. The two
      // agree only while nothing has ever been renumbered, deleted, or named
      // by hand, and disagreeing means minting an item number that is already
      // in use — a unique-constraint failure at insert, or a second `-D1` in
      // the tree. Children come back one row each, so a revised parent counts
      // its two children as two.
      const existingChildren =
        await this.getChildRequirements(parentRequirementId)
      const prefix = `${parentRequirement.itemNumber}-D`
      const taken = existingChildren.map((child) =>
        child.itemNumber.startsWith(prefix)
          ? Number(
              /^\d+$/.exec(child.itemNumber.slice(prefix.length))?.[0] ?? 0,
            )
          : 0,
      )
      itemNumber = `${prefix}${Math.max(0, ...taken) + 1}`
    }

    // Ensure child has designId from parent if not specified. No revision:
    // requirements are ECO-driven, so the release that assigns one is what
    // names it — inventing 'A' here made the first release read it as a real
    // revision A and revise the child straight to B.
    //
    // A derived requirement refines its parent, so it also inherits the
    // parent's verification method and its classification/provenance unless
    // the caller overrides them. Without this the child came back with no
    // verification method at all and had to be PUT immediately afterwards.
    const derivedData: Partial<Requirement> = {
      ...childData,
      itemNumber,
      parentRequirementId,
      designId: childData.designId || parentRequirement.designId,
      verificationMethod:
        childData.verificationMethod ??
        parentFields.verificationMethod ??
        undefined,
      category: childData.category ?? parentFields.category ?? undefined,
      source: childData.source ?? parentFields.source ?? undefined,
    }

    // Defensive runtime check: callers may pass a wrongly-typed itemType via
    // `as Requirement` casts despite the static `'Requirement'` constraint.
    if (
      derivedData.itemType &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- caller may bypass static type via cast
      derivedData.itemType !== 'Requirement'
    ) {
      throw new ValidationError(
        'Derived item must be a Requirement',
        undefined,
        { operation: 'deriveRequirement' },
      )
    }

    const branchId =
      options?.branchId ??
      (await ItemService.getItemBranchInfo(parentRequirementId))?.branchId

    // No branch in play: create on main. ItemService.create is what rejects
    // this once the design has released something.
    if (!branchId) {
      const child = await ItemService.create<Requirement>(
        'Requirement',
        derivedData as Requirement,
        userId,
      )
      await this.recordDerivation(child, parentRequirement, undefined, userId)
      return child
    }

    const branch = await BranchService.getById(branchId)
    if (!branch) {
      throw new NotFoundError('Branch', branchId, {
        operation: 'deriveRequirement',
      })
    }
    // createOnBranch takes the item's design from the branch, so a branch in
    // some other design would silently file the child away from its parent.
    if (branch.designId !== derivedData.designId) {
      throw new ValidationError(
        'Target branch belongs to a different design than the parent requirement',
        undefined,
        { operation: 'deriveRequirement' },
      )
    }

    const { item } = await ItemService.createOnBranch(
      'Requirement',
      derivedData as Requirement,
      branchId,
      options?.commitMessage ??
        `Derived ${itemNumber} from ${parentRequirement.itemNumber}`,
      userId,
    )
    const child = item as Requirement
    await this.recordDerivation(child, parentRequirement, branchId, userId)

    return child
  }

  /**
   * The derive hierarchy as an edge, beside the column.
   *
   * `parentRequirementId` is what the hierarchy readers follow; the
   * `DERIVES_FROM` edge is what the relationship graph, the catalog's pickers
   * and the demo dataset agree on, and until 2026-10-09 only the dataset had
   * it. Written with the edit guard bypassed, in the same breath as the
   * child's creation: it is the child's own initial structure, the way a
   * materialization writes a new part's BOM lines, and on a branch the child
   * is not yet checked out to anyone.
   */
  private static async recordDerivation(
    child: Requirement,
    parent: PersistedItem,
    branchId: string | undefined,
    userId: string,
  ): Promise<void> {
    // A created requirement carries the base columns at runtime; `Requirement`
    // types them as optional because the same shape is used for input.
    const ends = await resolveLinkEnds(
      child as unknown as PersistedItem,
      parent,
      branchId,
    )
    await ItemService.addRelationship(
      ends.source.id,
      ends.target.id,
      DERIVES_FROM_RELATIONSHIP,
      userId,
      undefined,
      { bypassEditGuard: true },
    )
  }

  /**
   * The version context a row answers in: the ECO/workspace branch it is a
   * working copy on, or its design's released context.
   *
   * The same question `deriveRequirement` asks to decide where a new child
   * goes. A row names its own context, which is why neither hierarchy read
   * needs a branch parameter. A released row on main gets the released
   * context: `getItemBranchInfo` matches only unarchived eco/workspace
   * branches, and closing a change order archives its branch.
   */
  private static async contextOf(row: {
    id: string
    designId: string | null
  }): Promise<VersionContext | null> {
    const branchInfo = await ItemService.getItemBranchInfo(row.id)
    if (branchInfo) {
      return { type: 'branch', branchId: branchInfo.branchId }
    }
    return row.designId ? { type: 'released', designId: row.designId } : null
  }

  /**
   * Get child requirements that derive from a parent requirement.
   *
   * `requirements.parent_requirement_id` names one **version row** of the
   * parent — whichever was current when the child was derived — and nothing
   * ever re-points it: the requirement type handler copies it onto every later
   * revision of the child. Matching it against the id passed in therefore
   * answered with history rather than structure. Once the parent had been
   * revised through an ECO its current row reported no children at all, while
   * the row it superseded reported every historical row of every child, so
   * each child came back two or three times.
   *
   * The column is an incoming reference like any other, so it gets the same
   * treatment the relationship reads already had, in two steps:
   *
   * 1. `resolveInheritedLineage` says which parent rows this row answers for —
   *    a current row inherits the rows it superseded, a working copy inherits
   *    the released lineage it was cut from, and a superseded row names only
   *    itself, so an old revision still reports the children it had. Nothing
   *    inherits from a working revision, which is what keeps a child derived
   *    inside one ECO invisible to main and to every other branch.
   * 2. Each child **master** found that way resolves at this parent row's own
   *    context, so the answer is one row per child: the branch's working copy
   *    when read from inside the branch holding it, the current released row
   *    otherwise. That is also what collapses the historical rows — they are
   *    versions of one child, not children in their own right.
   */
  static async getChildRequirements(parentRequirementId: string): Promise<
    Array<{
      id: string
      itemNumber: string
      name: string | null
      state: string
      priority: string | null
    }>
  > {
    const [parentRow] = await db
      .select({ id: items.id, designId: items.designId })
      .from(items)
      .where(eq(items.id, parentRequirementId))
      .limit(1)

    if (!parentRow) {
      return []
    }

    // Every parent row this one answers for, and the child rows naming any of
    // them — several rows per child, spread across its revisions.
    const lineage = await resolveInheritedLineage([parentRequirementId])
    const childRows = await db
      .select({ itemId: requirements.itemId })
      .from(requirements)
      .where(inArray(requirements.parentRequirementId, [...lineage.keys()]))

    if (childRows.length === 0) {
      return []
    }

    const candidates = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        designId: items.designId,
      })
      .from(items)
      .where(
        and(
          inArray(
            items.id,
            childRows.map((row) => row.itemId),
          ),
          notDeleted(),
        ),
      )

    const firstRowByMaster = new Map<string, (typeof candidates)[number]>()
    for (const row of candidates) {
      if (!firstRowByMaster.has(row.masterId)) {
        firstRowByMaster.set(row.masterId, row)
      }
    }

    // One row per child master: the row that answers at the parent's context.
    // A master with no row there — never released, and created on some other
    // branch, or deleted on this one — drops out.
    const context = await this.contextOf(parentRow)
    const resolvedIds = [
      ...new Set(
        (
          await Promise.all(
            [...firstRowByMaster.values()].map(async (row) => {
              if (!context || !row.designId) return row.id
              const atContext = await VersionResolver.getItemAtContext(
                row.masterId,
                row.designId,
                context,
              )
              return atContext?.id ?? null
            }),
          )
        ).filter((id): id is string => id !== null),
      ),
    ]

    if (resolvedIds.length === 0) {
      return []
    }

    return db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
        priority: requirements.priority,
      })
      .from(items)
      .innerJoin(requirements, eq(requirements.itemId, items.id))
      .where(and(inArray(items.id, resolvedIds), notDeleted()))
      .orderBy(items.itemNumber)
  }

  /**
   * Get parent requirement if this is a derived requirement.
   *
   * The stored `parent_requirement_id` names the parent's version row at
   * derive time and is never re-pointed, so returning it verbatim answered a
   * current, Released child with the superseded Draft row an ECO had already
   * replaced — wrong in id, revision and state, and a UI following it
   * navigated to a row nobody should be working from.
   *
   * The child owns this pointer, so — unlike the children read — the statement
   * is not stale, only the id in it. The parent therefore resolves to the row
   * that answers at the child row's own context: read from a branch holding
   * the parent, the branch's working copy; read from main, the current
   * released row. A parent in some other design resolves at that design's
   * released context, the same rule `VersionResolver.resolveRelationshipTarget`
   * applies to a stored edge target reaching outside the caller's design.
   */
  static async getParentRequirement(requirementId: string): Promise<{
    id: string
    itemNumber: string
    name: string | null
    state: string
  } | null> {
    const [childRow] = await db
      .select({
        id: items.id,
        designId: items.designId,
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(items)
      .innerJoin(requirements, eq(requirements.itemId, items.id))
      .where(eq(items.id, requirementId))
      .limit(1)

    if (!childRow?.parentRequirementId) {
      return null
    }

    const [parentRow] = await db
      .select({ masterId: items.masterId, designId: items.designId })
      .from(items)
      .where(eq(items.id, childRow.parentRequirementId))
      .limit(1)

    // A design-less parent has no context to resolve at and stands as named.
    let parentId = childRow.parentRequirementId
    if (parentRow?.designId) {
      const context =
        parentRow.designId === childRow.designId
          ? await this.contextOf(childRow)
          : { type: 'released' as const, designId: parentRow.designId }
      const atContext = context
        ? await VersionResolver.getItemAtContext(
            parentRow.masterId,
            parentRow.designId,
            context,
          )
        : null
      parentId = atContext?.id ?? parentId
    }

    const [parent] = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
      })
      .from(items)
      .where(and(eq(items.id, parentId), notDeleted()))
      .limit(1)

    return parent ?? null
  }

  /**
   * Calculate requirements coverage for a design.
   * Returns allocation, satisfaction, and verification metrics.
   */
  static async getCoverage(designId: string): Promise<RequirementsCoverage> {
    // Verify design exists
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getCoverage',
      })
    }

    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
          notDeleted(),
        ),
      )

    const totalRequirements = allRequirements.length
    if (totalRequirements === 0) {
      return {
        totalRequirements: 0,
        allocated: 0,
        satisfied: 0,
        verified: 0,
        suspect: 0,
        allocatedPercent: 0,
        satisfiedPercent: 0,
        verifiedPercent: 0,
        suspectPercent: 0,
        gaps: [],
        suspectLinks: [],
      }
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Allocation runs requirement → item, so it rides the requirement's own
    // outgoing edges and a revision carries it. Satisfaction and verification
    // point the other way and need the version-aware read.
    const allocatedLinks = await ItemRelationshipService.findOutgoingLinks(
      requirementIds,
      ALLOCATED_TO_RELATIONSHIP,
    )
    const allocatedIds = idsWithLinks(allocatedLinks)

    const satisfiedLinks = await ItemRelationshipService.findIncomingLinks(
      requirementIds,
      SATISFIES_RELATIONSHIP,
    )
    const satisfiedIds = idsWithLinks(satisfiedLinks)

    const verifiedLinks = await ItemRelationshipService.findIncomingLinks(
      requirementIds,
      VERIFIED_BY_RELATIONSHIP,
    )

    const suspectLinks = await this.suspectCoverageLinks(
      allRequirements,
      allocatedLinks,
      satisfiedLinks,
      verifiedLinks,
    )
    const suspectRequirementIds = new Set(
      suspectLinks.map((link) => link.requirementId),
    )

    // Verified by the one rule every coverage read applies: the derived
    // status says Passed (or a waiver is recorded), and no verifying claim is
    // suspect — a claim under review is not evidence. A linked test that has
    // never run verifies nothing yet.
    const suspectVerifiedIds = new Set(
      suspectLinks
        .filter((link) => link.relationshipType === VERIFIED_BY_RELATIONSHIP)
        .map((link) => link.requirementId),
    )
    const isVerified = (r: { id: string; verificationStatus: string | null }) =>
      isVerifiedStatus(r.verificationStatus) && !suspectVerifiedIds.has(r.id)
    const verifiedCount = allRequirements.filter(isVerified).length

    // Calculate percentages
    const allocated = allocatedIds.size
    const satisfied = satisfiedIds.size
    const verified = verifiedCount
    const suspect = suspectRequirementIds.size

    // Identify gaps
    const gaps: Array<RequirementGap> = []
    for (const req of allRequirements) {
      if (!allocatedIds.has(req.id)) {
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_allocated',
        })
      } else if (!satisfiedIds.has(req.id)) {
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_satisfied',
        })
      } else if (!isVerified(req)) {
        gaps.push({
          id: req.id,
          itemNumber: req.itemNumber,
          name: req.name,
          priority: req.priority,
          gapType: 'not_verified',
        })
      }
    }

    // Sort gaps by priority (MustHave first)
    const priorityOrder = ['MustHave', 'ShouldHave', 'CouldHave', 'WontHave']
    gaps.sort((a, b) => {
      const aOrder = a.priority
        ? priorityOrder.indexOf(a.priority)
        : priorityOrder.length
      const bOrder = b.priority
        ? priorityOrder.indexOf(b.priority)
        : priorityOrder.length
      return aOrder - bOrder
    })

    return {
      totalRequirements,
      allocated,
      satisfied,
      verified,
      suspect,
      allocatedPercent: Math.round((allocated / totalRequirements) * 1000) / 10,
      satisfiedPercent: Math.round((satisfied / totalRequirements) * 1000) / 10,
      verifiedPercent: Math.round((verified / totalRequirements) * 1000) / 10,
      suspectPercent: Math.round((suspect / totalRequirements) * 1000) / 10,
      gaps,
      suspectLinks,
    }
  }

  /**
   * The suspect links among a coverage read's trace edges, each attributed to
   * the requirement it covers — the same edges the coverage counters were
   * computed from, so a requirement counted as satisfied by a suspect claim
   * is listed here rather than silently counted clean.
   */
  private static async suspectCoverageLinks(
    allRequirements: Array<{
      id: string
      itemNumber: string
      name: string | null
      priority: string | null
    }>,
    allocatedLinks: Map<string, Array<typeof itemRelationships.$inferSelect>>,
    satisfiedLinks: Map<string, Array<typeof itemRelationships.$inferSelect>>,
    verifiedLinks: Map<string, Array<typeof itemRelationships.$inferSelect>>,
  ): Promise<Array<SuspectCoverageLink>> {
    // Allocation is the requirement's outgoing edge, so the other end is its
    // (forward-resolved) target; satisfaction and verification point at the
    // requirement, so the other end is the source.
    const candidates: Array<{
      requirementId: string
      rel: typeof itemRelationships.$inferSelect
      counterpartId: string
    }> = []
    for (const [requirementId, rels] of allocatedLinks) {
      for (const rel of rels) {
        candidates.push({ requirementId, rel, counterpartId: rel.targetId })
      }
    }
    for (const links of [satisfiedLinks, verifiedLinks]) {
      for (const [requirementId, rels] of links) {
        for (const rel of rels) {
          candidates.push({ requirementId, rel, counterpartId: rel.sourceId })
        }
      }
    }
    if (candidates.length === 0) return []

    const states = await ItemRelationshipService.suspectStatesFor(
      candidates.map((c) => c.rel.id),
    )
    const suspect = candidates.filter((c) => states.get(c.rel.id)?.suspect)
    if (suspect.length === 0) return []

    const counterparts = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
      })
      .from(items)
      .where(
        inArray(items.id, [...new Set(suspect.map((c) => c.counterpartId))]),
      )
    const counterpartById = new Map(counterparts.map((row) => [row.id, row]))
    const requirementById = new Map(allRequirements.map((r) => [r.id, r]))

    return suspect.flatMap(({ requirementId, rel, counterpartId }) => {
      const requirement = requirementById.get(requirementId)
      const counterpart = counterpartById.get(counterpartId)
      if (!requirement || !counterpart) return []
      return [
        {
          requirementId,
          requirementNumber: requirement.itemNumber,
          requirementName: requirement.name,
          priority: requirement.priority,
          relationshipId: rel.id,
          relationshipType: rel.relationshipType,
          counterpartId: counterpart.id,
          counterpartNumber: counterpart.itemNumber,
          counterpartName: counterpart.name,
          counterpartType: counterpart.itemType,
          suspectReasons: states.get(rel.id)?.reasons ?? [],
        },
      ]
    })
  }

  /**
   * Waive a requirement's verification: the one manual exception to the
   * derived status. Needs a note, wins over the derivation until cleared,
   * and is a review record rather than a design edit — written without the
   * edit lock, so a released requirement can be waived with no change order,
   * charged `requirements:update` by its route.
   */
  /**
   * The design's current requirements as sheet rows, the way the requirements
   * export writes them: every import field but the revision, each a string,
   * the parent by item number so the hierarchy survives a round trip.
   */
  static async exportRows(
    designId: string,
  ): Promise<Array<RequirementSheetRow>> {
    const rows = await db
      .select({
        itemNumber: items.itemNumber,
        name: items.name,
        description: requirements.description,
        type: requirements.type,
        priority: requirements.priority,
        category: requirements.category,
        source: requirements.source,
        acceptanceCriteria: requirements.acceptanceCriteria,
        verificationMethod: requirements.verificationMethod,
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
          notDeleted(),
        ),
      )
      .orderBy(asc(items.itemNumber))

    const parentIds = [
      ...new Set(
        rows
          .map((row) => row.parentRequirementId)
          .filter((id): id is string => id !== null),
      ),
    ]
    const parents =
      parentIds.length > 0
        ? await db
            .select({ id: items.id, itemNumber: items.itemNumber })
            .from(items)
            .where(inArray(items.id, parentIds))
        : []
    const numberById = new Map(parents.map((p) => [p.id, p.itemNumber]))

    return rows.map((row) => ({
      itemNumber: row.itemNumber,
      name: row.name ?? '',
      description: row.description ?? '',
      type: row.type ?? '',
      priority: row.priority ?? '',
      category: row.category ?? '',
      source: row.source ?? '',
      acceptanceCriteria: row.acceptanceCriteria ?? '',
      verificationMethod: row.verificationMethod ?? '',
      parentItemNumber: row.parentRequirementId
        ? (numberById.get(row.parentRequirementId) ?? '')
        : '',
    }))
  }

  static async waiveVerification(
    requirementId: string,
    note: string,
    userId: string,
  ): Promise<{ status: 'Waived'; waiver: VerificationWaiver }> {
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'waiveVerification',
      })
    }
    const trimmed = note.trim()
    if (!trimmed) {
      throw new ValidationError('A waiver needs a note saying why', [
        { field: 'note', message: 'Required' },
      ])
    }
    const waiver: VerificationWaiver = {
      note: trimmed,
      waivedBy: userId,
      waivedAt: new Date().toISOString(),
    }

    await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ verificationStatus: requirements.verificationStatus })
        .from(requirements)
        .where(eq(requirements.itemId, requirementId))
        .limit(1)
      await tx
        .update(requirements)
        .set({ verificationStatus: 'Waived', verificationWaiver: waiver })
        .where(eq(requirements.itemId, requirementId))
      await tx
        .update(items)
        .set({ modifiedAt: new Date(), modifiedBy: userId })
        .where(eq(items.id, requirementId))
      if (before?.verificationStatus !== 'Waived') {
        await publishDomainEvent(tx, REQUIREMENT_VERIFICATION_CHANGED, {
          actorId: userId,
          subject: { id: requirement.id, masterId: requirement.masterId },
          context: { designId: requirement.designId ?? undefined },
          payload: {
            requirementId: requirement.id,
            masterId: requirement.masterId,
            itemNumber: requirement.itemNumber,
            designId: requirement.designId ?? null,
            previousStatus: before?.verificationStatus ?? null,
            status: 'Waived',
            cause: 'waiver',
            testCaseId: null,
          },
        })
      }
    })

    return { status: 'Waived', waiver }
  }

  /**
   * Clear a waiver: the derived status takes over again, recomputed from the
   * verifying tests' executions in the same transaction.
   */
  static async clearVerificationWaiver(
    requirementId: string,
    userId: string,
  ): Promise<{ status: string }> {
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'clearVerificationWaiver',
      })
    }

    return db.transaction(async (tx) => {
      await tx
        .update(requirements)
        .set({ verificationWaiver: null })
        .where(eq(requirements.itemId, requirementId))
      await tx
        .update(items)
        .set({ modifiedAt: new Date(), modifiedBy: userId })
        .where(eq(items.id, requirementId))
      const changes = await rollupVerificationForMasters(
        tx,
        [requirement.masterId],
        { actorId: userId, cause: 'waiver_cleared' },
      )
      const own = changes.find((c) => c.requirementId === requirementId)
      if (own) return { status: own.status }
      const [row] = await tx
        .select({ verificationStatus: requirements.verificationStatus })
        .from(requirements)
        .where(eq(requirements.itemId, requirementId))
        .limit(1)
      return { status: row?.verificationStatus ?? 'NotStarted' }
    })
  }

  /**
   * Update the verification method of a requirement.
   */
  static async updateVerificationMethod(
    requirementId: string,
    verificationMethod: string,
    userId: string,
  ): Promise<void> {
    await ItemService.update(
      requirementId,
      { verificationMethod } as Partial<Requirement>,
      userId,
    )
  }

  /**
   * Create VERIFIED_BY relationships between test cases and a requirement.
   * Direction: TestCase → Requirement (source → target)
   * A test case "verifies" a requirement.
   */
  static async linkVerification(
    requirementId: string,
    testCaseIds: Array<string>,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    // Verify requirement exists
    const requirement = await ItemService.findById(requirementId)
    if (!requirement || requirement.itemType !== 'Requirement') {
      throw new NotFoundError('Requirement', requirementId, {
        operation: 'linkVerification',
      })
    }

    // Create relationships for each test case
    for (const testCaseId of testCaseIds) {
      const testCase = await ItemService.findById(testCaseId)
      if (!testCase) {
        throw new NotFoundError('TestCase', testCaseId, {
          operation: 'linkVerification',
        })
      }

      if (testCase.itemType !== 'TestCase') {
        throw new ValidationError(
          `Item ${testCaseId} is not a TestCase`,
          undefined,
          { operation: 'linkVerification' },
        )
      }

      const ends = await resolveLinkEnds(
        testCase,
        requirement,
        options?.branchId,
      )

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, ends.source.id),
            eq(itemRelationships.targetId, ends.target.id),
            eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          ends.source.id,
          ends.target.id,
          VERIFIED_BY_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a VERIFIED_BY relationship between a test case and a requirement.
   */
  static async unlinkVerification(
    requirementId: string,
    testCaseId: string,
    userId: string,
    options?: TraceabilityLinkOptions,
  ): Promise<void> {
    const ends = await resolveLinkEndIds(
      testCaseId,
      requirementId,
      options?.branchId,
    )

    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get test cases that verify a requirement (VERIFIED_BY relationships).
   */
  static async getVerifyingTests(requirementId: string): Promise<
    Array<
      {
        id: string
        itemNumber: string
        name: string | null
        testType: string | null
        executionStatus: string | null
        lastExecutedAt: Date | null
        relationshipId: string
      } & SuspectLinkFields
    >
  > {
    // Inherited across revisions, and without the rows a revision left
    // behind — see ItemRelationshipService.findIncomingLinks.
    const relationships =
      (
        await ItemRelationshipService.findIncomingLinks(
          [requirementId],
          VERIFIED_BY_RELATIONSHIP,
        )
      ).get(requirementId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each test case
    const sourceIds = relationships.map((r) => r.sourceId)
    const testCaseItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, sourceIds),
          eq(items.itemType, 'TestCase'),
          notDeleted(),
        ),
      )

    // Import testCases table dynamically to avoid circular dependencies
    const { testCases } = await import('../db/schema/items')

    // Get test case specific data
    const testCaseData = await db
      .select({
        itemId: testCases.itemId,
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        lastExecutedAt: testCases.lastExecutedAt,
      })
      .from(testCases)
      .where(inArray(testCases.itemId, sourceIds))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Combine data
    return testCaseItems.map((tc) => {
      const rel = relationships.find((r) => r.sourceId === tc.id)
      const tcData = testCaseData.find((t) => t.itemId === tc.id)
      return {
        id: tc.id,
        itemNumber: tc.itemNumber,
        name: tc.name,
        testType: tcData?.testType ?? null,
        executionStatus: tcData?.executionStatus ?? null,
        lastExecutedAt: tcData?.lastExecutedAt ?? null,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }

  /**
   * Get requirements that a test case verifies (VERIFIED_BY relationships).
   */
  static async getRequirementsVerifiedBy(testCaseId: string): Promise<
    Array<
      {
        id: string
        itemNumber: string
        name: string | null
        priority: string | null
        verificationStatus: string | null
        relationshipId: string
      } & SuspectLinkFields
    >
  > {
    // Targets resolve forward: a requirement revised since the link was made
    // is named by the row the release superseded.
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [testCaseId],
          VERIFIED_BY_RELATIONSHIP,
        )
      ).get(testCaseId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each requirement
    const targetIds = relationships.map((r) => r.targetId)
    const requirementItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(
        and(
          inArray(items.id, targetIds),
          eq(items.itemType, 'Requirement'),
          notDeleted(),
        ),
      )

    // Get requirement-specific data
    const requirementData = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(requirements)
      .where(inArray(requirements.itemId, targetIds))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Combine data
    return requirementItems.map((req) => {
      const rel = relationships.find((r) => r.targetId === req.id)
      const reqData = requirementData.find((r) => r.itemId === req.id)
      return {
        id: req.id,
        itemNumber: req.itemNumber,
        name: req.name,
        priority: reqData?.priority ?? null,
        verificationStatus: reqData?.verificationStatus ?? null,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }
}
