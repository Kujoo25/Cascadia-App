// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { BRANCH_TYPES } from '@cascadia/commons/versioning/branch-types'
import { describe, expect, it } from 'vitest'
import { resolveItemBranchActions } from './itemBranchActions'
import type { BranchDetail } from '@/query/options/branches'

const ECO_BRANCH: BranchDetail = {
  id: 'branch-eco',
  name: 'ECO-0001',
  branchType: BRANCH_TYPES.changeOrder,
  designId: 'design-1',
  changeOrderItemId: 'change-order-1',
}

function actionsFor(existsOnMain: boolean) {
  return resolveItemBranchActions({
    itemLabel: 'Part',
    itemNumber: 'P1001',
    itemMasterId: 'master-1',
    isCreateMode: false,
    isReleasedFamily: false,
    isMainProtected: true,
    existsOnMain,
    context: { type: 'branch', branchId: ECO_BRANCH.id },
    branch: ECO_BRANCH,
  })
}

describe('resolveItemBranchActions', () => {
  it('preserves the main item wording for an ECO change based on main', () => {
    const actions = actionsFor(true)

    expect(actions.deleteDescription).toContain(
      'The Part on main will not be deleted.',
    )
    expect(actions.deleteDescription).not.toContain('exists only')
  })

  it('does not imply a main item exists for an item created on the ECO', () => {
    const actions = actionsFor(false)

    expect(actions.deleteDescription).toContain(
      'This part exists only on this ECO; there is no version on main to preserve.',
    )
    expect(actions.deleteDescription).not.toContain(
      'The Part on main will not be deleted.',
    )
  })
})
