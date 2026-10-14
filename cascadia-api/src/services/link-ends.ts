// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * Where a link write lands when the caller names a branch.
 *
 * Callers name items by whatever id they hold — usually main's — so finding
 * the row a branch is working from is the link writer's job, not theirs.
 * Shared by the requirement links (satisfy, allocate, verify) and the
 * architecture links (decompose, realize), which resolve their ends the same
 * way. What the caller may then do with the resolved row is the edit-lock
 * policy's call, made where the edge is written.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { branchItems } from '../db/schema/versioning'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { BranchService } from './BranchService'
import type { PersistedItem } from '@cascadia/commons/items/types/base'

/** Options every branch-aware link write accepts. */
export interface LinkWriteOptions {
  /**
   * The branch the link lands on. Both ends resolve to the rows that branch
   * is working from, so a caller inside an ECO can keep naming items by the
   * ids it already has. Omitted, the write goes to the rows named — on a
   * design with released items that is main, and it is refused there.
   */
  branchId?: string
}

/**
 * Resolve one end of a link onto `branchId`: the row that branch is
 * currently working from for this item's master, or the item itself when the
 * branch does not track it (it inherits main's row).
 */
export async function resolveOnBranch(
  item: PersistedItem,
  branchId: string,
): Promise<PersistedItem> {
  const branch = await BranchService.getById(branchId)
  if (!branch) {
    throw new NotFoundError('Branch', branchId, {
      operation: 'resolveOnBranch',
    })
  }
  if (item.designId && item.designId !== branch.designId) {
    throw new ValidationError(
      `Item '${item.itemNumber}' is not in the design that branch '${branch.name}' belongs to`,
      undefined,
      { operation: 'resolveOnBranch', itemId: item.id },
    )
  }

  const [branchRow] = await db
    .select({ currentItemId: branchItems.currentItemId })
    .from(branchItems)
    .where(
      and(
        eq(branchItems.branchId, branchId),
        eq(branchItems.itemMasterId, item.masterId),
      ),
    )
    .limit(1)

  if (!branchRow?.currentItemId || branchRow.currentItemId === item.id) {
    return item
  }
  return (await ItemService.findById(branchRow.currentItemId)) ?? item
}

/**
 * Resolve both ends of a link for the branch the caller named. A no-op
 * without one — the link is then written exactly where the caller pointed.
 */
export async function resolveLinkEnds(
  source: PersistedItem,
  target: PersistedItem,
  branchId: string | undefined,
): Promise<{ source: PersistedItem; target: PersistedItem }> {
  if (!branchId) return { source, target }
  return {
    source: await resolveOnBranch(source, branchId),
    target: await resolveOnBranch(target, branchId),
  }
}

/**
 * `resolveLinkEnds` for the unlink paths, which work in ids and treat an
 * item that no longer exists as "no such link" rather than an error.
 */
export async function resolveLinkEndIds(
  sourceId: string,
  targetId: string,
  branchId: string | undefined,
): Promise<{ sourceId: string; targetId: string }> {
  if (!branchId) return { sourceId, targetId }

  const [source, target] = await Promise.all([
    ItemService.findById(sourceId),
    ItemService.findById(targetId),
  ])
  if (!source || !target) return { sourceId, targetId }

  const ends = await resolveLinkEnds(source, target, branchId)
  return { sourceId: ends.source.id, targetId: ends.target.id }
}
