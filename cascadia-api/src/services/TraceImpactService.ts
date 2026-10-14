// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { notWorkingRevision } from '../db/filters'
import { branchItems, itemRelationships, items } from '../db/schema'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  SUSPECTABLE_RELATIONSHIP_TYPES,
  carryAffirmation,
  suspectStateOf,
} from '../items/trace-affirmation'
import { followSupersededRows } from '../items/version-lineage'
import type { SuspectReason } from '../items/trace-affirmation'

/**
 * One end of a trace claim, as the release preview names it.
 */
export interface TraceImpactEnd {
  itemId: string
  itemNumber: string
  name: string | null
  itemType: string
}

/**
 * A trace claim that will be suspect once the change order releases.
 */
export interface TraceImpactLink {
  /** The edge as it is stored today: the working copy's, or main's. */
  relationshipId: string
  relationshipType: string
  source: TraceImpactEnd
  target: TraceImpactEnd
  /** Why the claim will be suspect after the release. */
  reasons: Array<SuspectReason>
  /**
   * Main already reads the claim as suspect today: the release neither
   * causes nor clears it. False for a claim the release itself makes
   * suspect — the "N claims" a reviewer is being told about.
   */
  alreadySuspect: boolean
}

export interface TraceImpact {
  /** Trace claims that will be suspect once the release lands. */
  suspectAfterRelease: number
  /** Of those, the ones that are not suspect on main today. */
  newlySuspect: number
  links: Array<TraceImpactLink>
}

const SUSPECTABLE_TYPES = [...SUSPECTABLE_RELATIONSHIP_TYPES]

/**
 * What a release does to the trace graph, told before it happens.
 *
 * A release supersedes a row of every master it revises, and the suspect
 * rule (`items/trace-affirmation.ts`) is judged against the rows a claim was
 * affirmed on and against the rows that are current. So the release touches
 * trace claims from two sides:
 *
 * - **The outgoing claims of what it releases.** The merge re-homes each
 *   working copy's edges onto the released row with their metadata, and
 *   re-points an affirmation that names the working copy (step 5b of
 *   `ChangeOrderMergeService`). One affirmed on the branch is released
 *   affirmed; one copied at checkout and never looked at is released
 *   suspect, `source_revised`.
 * - **The incoming claims of what it supersedes.** Every claim affirmed
 *   against the row the release replaces — a test case verifying the
 *   requirement, a part satisfying it — reads `target_revised` the moment
 *   the new row is current, with no write anywhere.
 *
 * The preview is the live rule applied to the edges *as the merge will leave
 * them*: the same `suspectStateOf`, fed the same carried metadata the merge
 * writes, against a stand-in for the row the release will mint. It is not a
 * second rule, which is what lets the preview's count equal the count read
 * back after the merge — the invariant the suite pins. Users who find the
 * two disagree stop trusting both.
 */
export class TraceImpactService {
  static async forChangeOrder(changeOrderId: string): Promise<TraceImpact> {
    const ecoDesigns =
      await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
    const branchIds = ecoDesigns.flatMap((design) =>
      design.branchId && design.mergeStatus !== 'merged'
        ? [design.branchId]
        : [],
    )
    const changed =
      branchIds.length > 0
        ? await db
            .select()
            .from(branchItems)
            .where(
              and(
                inArray(branchItems.branchId, branchIds),
                isNotNull(branchItems.changeType),
              ),
            )
        : []

    // The masters whose current main row the release supersedes: every
    // master the branches release, and every affected item whose change
    // action revises it without branch content (`applyRemainingActions`
    // mints a new row for `revise`; the other actions write in place and
    // move no pin).
    const supersededMasters = new Set<string>()
    for (const bi of changed) {
      if (bi.changeType !== 'deleted') supersededMasters.add(bi.itemMasterId)
    }
    for (const affected of await ChangeOrderService.getAffectedItems(
      changeOrderId,
    )) {
      if (affected.changeAction !== 'revise') continue
      const masterId =
        affected.affectedItemMasterId ?? affected.affectedItemDetails?.masterId
      if (masterId) supersededMasters.add(masterId)
    }

    // Outgoing: the working copies' own trace edges, which the merge re-homes.
    const workingCopies = changed.filter(
      (bi): bi is typeof bi & { currentItemId: string } =>
        bi.changeType !== 'deleted' && bi.currentItemId !== null,
    )
    const outgoing =
      workingCopies.length > 0
        ? await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(
                  itemRelationships.sourceId,
                  workingCopies.map((bi) => bi.currentItemId),
                ),
                inArray(itemRelationships.relationshipType, SUSPECTABLE_TYPES),
              ),
            )
        : []

    // Incoming: the claims pointing at the rows the release supersedes, read
    // the way every trace listing reads them (inherited rows walked, left-
    // behind and foreign working-copy sources dropped). A source whose own
    // master is being released answers through its working copy above, and
    // its main row's edge is left behind by the release.
    const mainRows =
      supersededMasters.size > 0
        ? await db
            .select({ id: items.id, masterId: items.masterId })
            .from(items)
            .where(
              and(
                inArray(items.masterId, [...supersededMasters]),
                eq(items.isCurrent, true),
                notWorkingRevision(),
              ),
            )
        : []
    const incoming: Array<typeof itemRelationships.$inferSelect> = []
    if (mainRows.length > 0) {
      const outgoingIds = new Set(outgoing.map((rel) => rel.id))
      for (const relationshipType of SUSPECTABLE_TYPES) {
        const byOwner = await ItemRelationshipService.findIncomingLinks(
          mainRows.map((row) => row.id),
          relationshipType,
        )
        for (const rels of byOwner.values()) {
          for (const rel of rels) {
            if (!outgoingIds.has(rel.id)) incoming.push(rel)
          }
        }
      }
    }
    if (outgoing.length === 0 && incoming.length === 0) {
      return { suspectAfterRelease: 0, newlySuspect: 0, links: [] }
    }

    // Every row the rule or the listing names, in one read.
    const namedIds = new Set<string>()
    for (const rel of [...outgoing, ...incoming]) {
      namedIds.add(rel.sourceId)
      namedIds.add(rel.targetId)
      const affirmed = affirmedTargetOf(rel.metadata)
      if (affirmed) namedIds.add(affirmed)
    }
    const baseIds = workingCopies.flatMap((bi) =>
      bi.baseItemId ? [bi.baseItemId] : [],
    )
    const rows = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
      })
      .from(items)
      .where(inArray(items.id, [...namedIds]))
    const rowById = new Map(rows.map((row) => [row.id, row]))
    const redirects = await followSupersededRows([...namedIds])

    // A stand-in for the row the release will make current for a master it
    // supersedes. Its identity is all the rule compares, so the token stands
    // for the released row on both sides of the comparison — the edge's
    // re-pointed pin and the row readers will resolve the pin to.
    const released = (masterId: string) => `released:${masterId}`
    const afterRelease = (id: string): string => {
      const masterId = rowById.get(id)?.masterId
      return masterId && supersededMasters.has(masterId)
        ? released(masterId)
        : id
    }
    const currentAfterRelease = (id: string): string => {
      const masterId = rowById.get(id)?.masterId
      if (masterId && supersededMasters.has(masterId)) return released(masterId)
      return redirects.get(id) ?? id
    }
    const incomingSourceLeftBehind = (rel: { sourceId: string }) => {
      const masterId = rowById.get(rel.sourceId)?.masterId
      return masterId !== undefined && supersededMasters.has(masterId)
    }

    // What main reads today, for `alreadySuspect`: the incoming edges as they
    // are, and for a working copy's edge the base row's edge it was copied
    // from — matched by type and target master, since the copy's id is new.
    const baseEdges =
      baseIds.length > 0
        ? await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, baseIds),
                inArray(itemRelationships.relationshipType, SUSPECTABLE_TYPES),
              ),
            )
        : []
    const baseTargetRows =
      baseEdges.length > 0
        ? await db
            .select({ id: items.id, masterId: items.masterId })
            .from(items)
            .where(
              inArray(
                items.id,
                [...new Set(baseEdges.map((rel) => rel.targetId))].filter(
                  (id) => !rowById.has(id),
                ),
              ),
            )
        : []
    const masterOf = (id: string) =>
      rowById.get(id)?.masterId ??
      baseTargetRows.find((row) => row.id === id)?.masterId
    const liveStates = await ItemRelationshipService.suspectStatesFor([
      ...incoming.map((rel) => rel.id),
      ...baseEdges.map((rel) => rel.id),
    ])
    const baseEdgeKey = (
      sourceId: string,
      relationshipType: string,
      targetId: string,
    ) => `${sourceId}|${relationshipType}|${masterOf(targetId) ?? targetId}`
    const baseEdgeByKey = new Map(
      baseEdges.map((rel) => [
        baseEdgeKey(rel.sourceId, rel.relationshipType, rel.targetId),
        rel,
      ]),
    )
    const baseOf = new Map(
      workingCopies.flatMap((bi) =>
        bi.baseItemId ? [[bi.currentItemId, bi.baseItemId] as const] : [],
      ),
    )

    const end = (id: string): TraceImpactEnd => {
      const row = rowById.get(redirects.get(id) ?? id) ?? rowById.get(id)
      return row
        ? {
            itemId: row.id,
            itemNumber: row.itemNumber,
            name: row.name,
            itemType: row.itemType,
          }
        : { itemId: id, itemNumber: id, name: null, itemType: 'Item' }
    }

    const links: Array<TraceImpactLink> = []

    for (const rel of outgoing) {
      // The edge as step 5b will write it. The released row's identity is
      // not known yet, but the rule only asks whether the affirmation names
      // the row the edge hangs off — and after the carry that is true
      // exactly when it named the working copy.
      const predicted = {
        sourceId: rel.sourceId,
        targetId: afterRelease(rel.targetId),
        relationshipType: rel.relationshipType,
        metadata: carryAffirmation(rel.metadata, {
          fromSourceId: rel.sourceId,
          toSourceId: rel.sourceId,
          resolveTarget: afterRelease,
        }),
      }
      const state = suspectStateOf(predicted, currentAfterRelease(rel.targetId))
      if (!state.suspect) continue

      const baseId = baseOf.get(rel.sourceId)
      const baseEdge = baseId
        ? baseEdgeByKey.get(
            baseEdgeKey(baseId, rel.relationshipType, rel.targetId),
          )
        : undefined
      links.push({
        relationshipId: rel.id,
        relationshipType: rel.relationshipType,
        source: end(rel.sourceId),
        target: end(rel.targetId),
        reasons: state.reasons,
        alreadySuspect: baseEdge
          ? (liveStates.get(baseEdge.id)?.suspect ?? false)
          : false,
      })
    }

    for (const rel of incoming) {
      if (incomingSourceLeftBehind(rel)) continue
      // Untouched by the merge; only the row its pin resolves to changes.
      const state = suspectStateOf(rel, currentAfterRelease(rel.targetId))
      if (!state.suspect) continue
      links.push({
        relationshipId: rel.id,
        relationshipType: rel.relationshipType,
        source: end(rel.sourceId),
        target: end(rel.targetId),
        reasons: state.reasons,
        alreadySuspect: liveStates.get(rel.id)?.suspect ?? false,
      })
    }

    links.sort(
      (a, b) =>
        a.source.itemNumber.localeCompare(b.source.itemNumber) ||
        a.target.itemNumber.localeCompare(b.target.itemNumber) ||
        a.relationshipType.localeCompare(b.relationshipType),
    )

    return {
      suspectAfterRelease: links.length,
      newlySuspect: links.filter((link) => !link.alreadySuspect).length,
      links,
    }
  }
}

/** The target row an edge's affirmation names, when it carries one. */
function affirmedTargetOf(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null
  const affirmed = (metadata as { affirmed?: unknown }).affirmed
  if (affirmed === null || typeof affirmed !== 'object') return null
  const targetId = (affirmed as { targetId?: unknown }).targetId
  return typeof targetId === 'string' ? targetId : null
}
