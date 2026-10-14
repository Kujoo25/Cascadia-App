// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted, notWorkingRevision } from '../db/filters'
import { itemRelationships, items } from '../db/schema'
import { ValidationError } from '../errors'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  SUSPECTABLE_RELATIONSHIP_TYPES,
  affirmationOf,
  isSuspectable,
} from '../items/trace-affirmation'
import { followSupersededRows } from '../items/version-lineage'
import type { SuspectReason } from '../items/trace-affirmation'

/** One end of a listed trace claim. */
export interface TraceLinkEnd {
  itemId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
}

/** A trace claim as the listing reports it, with its suspect state. */
export interface TraceLinkListing {
  relationshipId: string
  relationshipType: string
  source: TraceLinkEnd
  /** Resolved to the row that currently answers for the pinned target. */
  target: TraceLinkEnd
  suspect: boolean
  suspectReasons: Array<SuspectReason>
  affirmedBy: string | null
  affirmedAt: string | null
}

export type TraceLinkScope = { designId: string } | { itemId: string }

export interface TraceLinkListOptions {
  /** One of the suspectable types; every one of them when omitted. */
  relationshipType?: string
  /** Only the claims that are suspect today. */
  suspectOnly?: boolean
  limit: number
}

const SUSPECTABLE_TYPES = [...SUSPECTABLE_RELATIONSHIP_TYPES]

/**
 * The trace claims touching a design's released items, or one item, read
 * from main the way every trace panel reads them: each item's own outgoing
 * claims, plus the claims pointing at it resolved through its lineage, with
 * left-behind and foreign working-copy sources dropped
 * (`ItemRelationshipService.findIncomingLinks`). The one listing the AI and
 * MCP tools use to answer "what is suspect here", so it agrees with the
 * panels to the row.
 */
export class TraceLinkService {
  static async list(
    scope: TraceLinkScope,
    options: TraceLinkListOptions,
  ): Promise<{ links: Array<TraceLinkListing>; total: number }> {
    const relationshipTypes = this.relationshipTypesFor(options)
    const ownerIds = await this.ownersOf(scope)
    if (ownerIds.length === 0) return { links: [], total: 0 }

    const edges = new Map<string, typeof itemRelationships.$inferSelect>()
    for (const rel of await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, ownerIds),
          inArray(itemRelationships.relationshipType, relationshipTypes),
        ),
      )) {
      edges.set(rel.id, rel)
    }
    for (const relationshipType of relationshipTypes) {
      const incoming = await ItemRelationshipService.findIncomingLinks(
        ownerIds,
        relationshipType,
      )
      for (const rels of incoming.values()) {
        for (const rel of rels) edges.set(rel.id, rel)
      }
    }
    if (edges.size === 0) return { links: [], total: 0 }

    const states = await ItemRelationshipService.suspectStatesFor([
      ...edges.keys(),
    ])
    const listed = [...edges.values()].filter(
      (rel) => !options.suspectOnly || states.get(rel.id)?.suspect,
    )
    if (listed.length === 0) return { links: [], total: 0 }

    const redirects = await followSupersededRows(
      listed.map((rel) => rel.targetId),
    )
    const endIds = new Set<string>()
    for (const rel of listed) {
      endIds.add(rel.sourceId)
      endIds.add(redirects.get(rel.targetId) ?? rel.targetId)
    }
    const rows = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        itemType: items.itemType,
        revision: items.revision,
        state: items.state,
      })
      .from(items)
      .where(inArray(items.id, [...endIds]))
    const endById = new Map(rows.map((row) => [row.id, row]))

    const links = listed.flatMap((rel): Array<TraceLinkListing> => {
      const source = endById.get(rel.sourceId)
      const target = endById.get(redirects.get(rel.targetId) ?? rel.targetId)
      if (!source || !target) return []
      const state = states.get(rel.id)
      const affirmation = affirmationOf(rel.metadata)
      return [
        {
          relationshipId: rel.id,
          relationshipType: rel.relationshipType,
          source: { ...source, itemId: source.id },
          target: { ...target, itemId: target.id },
          suspect: state?.suspect ?? false,
          suspectReasons: state?.reasons ?? [],
          affirmedBy: affirmation?.affirmedBy ?? null,
          affirmedAt: affirmation?.affirmedAt ?? null,
        },
      ]
    })
    links.sort(
      (a, b) =>
        a.source.itemNumber.localeCompare(b.source.itemNumber) ||
        a.target.itemNumber.localeCompare(b.target.itemNumber) ||
        a.relationshipType.localeCompare(b.relationshipType),
    )

    return { links: links.slice(0, options.limit), total: links.length }
  }

  private static relationshipTypesFor(
    options: TraceLinkListOptions,
  ): Array<string> {
    if (options.relationshipType === undefined) return SUSPECTABLE_TYPES
    if (!isSuspectable(options.relationshipType)) {
      throw new ValidationError(
        `${options.relationshipType} is not a trace claim`,
        [
          {
            field: 'relationshipType',
            message: `One of ${SUSPECTABLE_TYPES.join(', ')}`,
          },
        ],
      )
    }
    return [options.relationshipType]
  }

  /**
   * The rows whose claims the listing is about: a design's current released
   * rows, or the one item named. Working revisions are a branch's own and
   * stay out of main's view.
   */
  private static async ownersOf(scope: TraceLinkScope): Promise<Array<string>> {
    if ('itemId' in scope) return [scope.itemId]
    const rows = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.designId, scope.designId),
          eq(items.isCurrent, true),
          notWorkingRevision(),
          notDeleted(),
        ),
      )
    return rows.map((row) => row.id)
  }
}
