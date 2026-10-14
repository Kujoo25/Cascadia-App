// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Wire types for the requirements traceability matrix (RTM) and the
 * program-level requirements rollup — what `RequirementsMatrixService`
 * computes and the design's Requirements tab and the program page render.
 * Declared apart from the service so the web package can name them; the
 * service re-exports them.
 */

import type { SuspectReason } from '../../items/suspect-reason'

/** The context a matrix was read at. `id` is null for the released view. */
export interface RtmContext {
  type: 'released' | 'branch' | 'tag' | 'commit'
  id: string | null
}

/** The three gaps a requirement can have, independently of each other. */
export type RtmGapType = 'not_allocated' | 'not_satisfied' | 'not_verified'

/** One end of a trace claim, resolved to its row at the matrix's context. */
export interface RtmLink {
  relationshipId: string
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  suspect: boolean
  suspectReasons: Array<SuspectReason>
  /**
   * The second hop of an allocation to a system element: the items that
   * realize the element (`REALIZED_BY`), resolved at the same context. Only
   * on `allocatedTo` links whose target is a `SystemElement`.
   */
  realizedBy?: Array<RtmLink>
}

/** A verifying test case, with the latest result recorded on its row. */
export interface RtmVerifyingTest extends RtmLink {
  executionStatus: string | null
  /** ISO timestamp of the latest run, or null when never run. */
  lastExecutedAt: string | null
}

export interface RtmRequirement {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  priority: string | null
  requirementType: string | null
  verificationMethod: string | null
  /** The derived status as stored on this row (`Waived` when waived). */
  verificationStatus: string | null
}

export interface RtmRow {
  requirement: RtmRequirement
  allocatedTo: Array<RtmLink>
  satisfiedBy: Array<RtmLink>
  verifiedBy: Array<RtmVerifyingTest>
  /**
   * The one rule every coverage read applies: the derived status says
   * Passed or a waiver is recorded, and no verifying claim is suspect.
   */
  verified: boolean
  /** Trace claims on this row that are suspect at the context. */
  suspectCount: number
  gaps: Array<RtmGapType>
}

export interface RtmTotals {
  total: number
  allocated: number
  satisfied: number
  verified: number
  /** Requirements with at least one suspect claim. */
  suspect: number
  gaps: Record<RtmGapType, number>
}

export interface RequirementsMatrix {
  designId: string
  designCode: string
  designName: string
  context: RtmContext
  rows: Array<RtmRow>
  totals: RtmTotals
}

export interface RequirementsRollupDesign extends RtmTotals {
  designId: string
  designCode: string
  designName: string
  designType: string
}

export interface RequirementsRollupGap {
  designId: string
  designCode: string
  requirementId: string
  itemNumber: string
  name: string | null
  priority: string | null
  gapType: RtmGapType
}

/** Every design of a program at its released view, one line each. */
export interface RequirementsRollup {
  programId: string
  designs: Array<RequirementsRollupDesign>
  totals: RtmTotals
  /** The open gaps across the program, most important first. */
  openGaps: Array<RequirementsRollupGap>
  /** How many open gaps there are in all, when `openGaps` is capped. */
  openGapsTotal: number
}
