// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { designs, itemRelationships, requirements } from '../db/schema'
import { NotFoundError } from '../errors'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { LifecycleService } from './LifecycleService'
import { EBOM_SOURCE_RELATIONSHIP } from './MbomService'
import { VersionResolver } from './VersionResolver'
import {
  ALLOCATED_TO_RELATIONSHIP,
  SATISFIES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
  idsWithLinks,
} from './RequirementService'
import { VALIDATES_RELATIONSHIP } from './VerificationService'
import { isVerifiedStatus } from './verification-rollup'
import type { ThreadDomain } from './ThreadService'

// ============================================================================
// Types
// ============================================================================
import type {
  Gap,
  GapAnalysisRequest,
  GapAnalysisResult,
  GapSeverity,
  GapType,
} from '@cascadia/commons/services/types/gap-analysis'
// Wire types live in commons so the web can name them; re-exported so
// server callers keep importing them from here.
export type {
  GapType,
  GapSeverity,
  Gap,
  GapAnalysisRequest,
  GapAnalysisResult,
} from '@cascadia/commons/services/types/gap-analysis'

// ============================================================================
// Zod Schema for API validation
// ============================================================================

export const gapAnalysisRequestSchema = z.object({
  includeTypes: z
    .array(
      z.enum([
        'unallocated_requirement',
        'unsatisfied_requirement',
        'unverified_requirement',
        'suspect_requirement',
        'untested_part',
        'unmapped_ebom_item',
        'orphan_mbom_item',
        'missing_documentation',
      ]),
    )
    .optional(),
  includeDomains: z
    .array(
      z.enum(['requirements', 'engineering', 'manufacturing', 'validation']),
    )
    .optional(),
  includeSeverities: z.array(z.enum(['critical', 'major', 'minor'])).optional(),
})

export type GapAnalysisRequestInput = z.input<typeof gapAnalysisRequestSchema>

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Service for analyzing traceability gaps across the digital thread.
 * Identifies missing links, unverified requirements, untested parts,
 * and EBOM→MBOM mapping gaps.
 */
export class GapAnalysisService {
  /**
   * Main entry point - orchestrates all gap detection for a design.
   */
  static async analyze(
    request: GapAnalysisRequest,
  ): Promise<GapAnalysisResult> {
    const { designId, includeTypes, includeDomains, includeSeverities } =
      request

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'gapAnalysis' })
    }

    // Collect all gaps
    const allGaps: Array<Gap> = []

    // Find requirement gaps
    const requirementGaps = await this.findRequirementGaps(designId)
    allGaps.push(...requirementGaps)

    // Find engineering gaps
    const engineeringGaps = await this.findEngineeringGaps(designId)
    allGaps.push(...engineeringGaps)

    // Find manufacturing gaps
    const manufacturingGaps = await this.findManufacturingGaps(designId)
    allGaps.push(...manufacturingGaps)

    // Apply filters
    let filteredGaps = allGaps

    if (includeTypes && includeTypes.length > 0) {
      filteredGaps = filteredGaps.filter((g) => includeTypes.includes(g.type))
    }

    if (includeDomains && includeDomains.length > 0) {
      filteredGaps = filteredGaps.filter((g) =>
        includeDomains.includes(g.domain),
      )
    }

    if (includeSeverities && includeSeverities.length > 0) {
      filteredGaps = filteredGaps.filter((g) =>
        includeSeverities.includes(g.severity),
      )
    }

    // Calculate coverage metrics
    const coverage = await this.calculateCoverageMetrics(designId)

    // Calculate summary
    const summary = this.calculateSummary(filteredGaps, coverage)

    return {
      designId,
      designName: design.name,
      analyzedAt: new Date(),
      gaps: filteredGaps,
      summary,
      coverage,
    }
  }

  /**
   * The design's items of one type, resolved the way the rest of the app
   * resolves them.
   *
   * `items.isCurrent` is not this question, and every read in this service
   * used to ask it. It is a flag on a row: a part *created* on an open
   * change-order branch carries it, so asking it directly counted unapproved
   * work as the design's — reporting gaps against items that are not in the
   * design yet, and inflating the denominator the completeness figure divides
   * by, which is read as a compliance number. A part *revised* on a branch
   * does not leak (its working copy is not current) and a design with merge
   * history resolves identically either way, which is what kept the
   * difference out of sight.
   *
   * `VersionResolver.getReleasedItems` is the answer the design page, the
   * items tab and the structure tab already give, and it excludes
   * soft-deleted rows on every one of its paths — so this is one resolution
   * rule rather than a second copy of the predicate that can drift from it.
   */
  private static async resolveDesignItems(designId: string, itemType: string) {
    const resolved = await VersionResolver.getReleasedItems(designId, {
      itemType,
    })
    return resolved.items
  }

  /**
   * The design's requirements, each with the fields that live on its
   * extension row.
   *
   * A Requirement item with no `requirements` row is left out, which is what
   * the inner join this replaced did. It is a data gap rather than an
   * untraced requirement, and reporting it as the latter would put a row in
   * the gap list that no amount of tracing can clear.
   */
  private static async resolveRequirements(designId: string) {
    const resolved = await this.resolveDesignItems(designId, 'Requirement')
    if (resolved.length === 0) return []

    const extensions = await db
      .select({
        itemId: requirements.itemId,
        priority: requirements.priority,
        verificationStatus: requirements.verificationStatus,
      })
      .from(requirements)
      .where(
        inArray(
          requirements.itemId,
          resolved.map((item) => item.id),
        ),
      )
    const byItemId = new Map(extensions.map((row) => [row.itemId, row]))

    return resolved.flatMap((item) => {
      const extension = byItemId.get(item.id)
      if (!extension) return []
      return [
        {
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          itemType: item.itemType,
          revision: item.revision,
          state: item.state,
          priority: extension.priority,
          verificationStatus: extension.verificationStatus,
        },
      ]
    })
  }

  /**
   * Find requirement-related gaps:
   * - unallocated_requirement: Not allocated to any design element
   * - unsatisfied_requirement: Not satisfied by any part/document
   * - unverified_requirement: Not linked to any test case
   * - suspect_requirement: A trace link's end revised since it was affirmed
   */
  static async findRequirementGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    const allRequirements = await this.resolveRequirements(designId)

    if (allRequirements.length === 0) {
      return gaps
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Read version-aware, or every revision reads back as a fresh gap:
    // SATISFIES and VERIFIED_BY point AT a requirement and belong to the item
    // at the other end, so a release leaves them naming the row it superseded.
    // Allocation is the requirement's own outgoing edge and rides the
    // revision. See ItemRelationshipService.find{Incoming,Outgoing}Links.
    const allocatedLinks = await ItemRelationshipService.findOutgoingLinks(
      requirementIds,
      ALLOCATED_TO_RELATIONSHIP,
    )
    const satisfiedLinks = await ItemRelationshipService.findIncomingLinks(
      requirementIds,
      SATISFIES_RELATIONSHIP,
    )
    const verifiedLinks = await ItemRelationshipService.findIncomingLinks(
      requirementIds,
      VERIFIED_BY_RELATIONSHIP,
    )
    const allocatedIds = idsWithLinks(allocatedLinks)
    const satisfiedIds = idsWithLinks(satisfiedLinks)
    const { counts: suspectCounts, suspectVerified } =
      await this.suspectLinkCounts({
        allocatedLinks,
        satisfiedLinks,
        verifiedLinks,
      })
    // Verified by the one rule every coverage read applies: the derived
    // status says Passed (or a waiver is recorded), and no verifying claim is
    // suspect. A linked test that has never run verifies nothing yet.
    const isVerified = (req: {
      id: string
      verificationStatus: string | null
    }) =>
      isVerifiedStatus(req.verificationStatus) && !suspectVerified.has(req.id)

    // Process each requirement
    for (const req of allRequirements) {
      // A stale claim is a gap of its own, whatever else the requirement is
      // missing: the link still counts it as covered, and that is exactly
      // what someone has to look at.
      const suspectLinks = suspectCounts.get(req.id) ?? 0
      if (suspectLinks > 0) {
        gaps.push({
          id: `gap-${req.id}-suspect`,
          type: 'suspect_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion:
            suspectLinks === 1
              ? 'One trace link is suspect: an end revised since it was affirmed. Affirm it, or fix what changed'
              : `${suspectLinks} trace links are suspect: an end revised since each was affirmed. Affirm them, or fix what changed`,
        })
      }

      // Check for unallocated
      if (!allocatedIds.has(req.id)) {
        gaps.push({
          id: `gap-${req.id}-unallocated`,
          type: 'unallocated_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion:
            'Allocate this requirement to a design element (part or assembly)',
        })
      }
      // Check for unsatisfied (only if allocated)
      else if (!satisfiedIds.has(req.id)) {
        gaps.push({
          id: `gap-${req.id}-unsatisfied`,
          type: 'unsatisfied_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion:
            'Link parts that implement this requirement via SATISFIES relationship',
        })
      }
      // Check for unverified (only if satisfied)
      else if (!isVerified(req)) {
        gaps.push({
          id: `gap-${req.id}-unverified`,
          type: 'unverified_requirement',
          itemId: req.id,
          itemNumber: req.itemNumber,
          itemName: req.name,
          itemType: req.itemType,
          revision: req.revision,
          state: req.state,
          domain: 'requirements',
          severity: this.calculateRequirementSeverity(req.priority),
          priority: req.priority,
          suggestion: 'Create test cases to verify this requirement',
        })
      }
    }

    return gaps
  }

  /**
   * Find engineering-related gaps:
   * - untested_part: Part/assembly without any VALIDATES test cases
   * - unmapped_ebom_item: EBOM item without EBOM_SOURCE relationship from MBOM
   * - missing_documentation: Part without attached documents
   */
  static async findEngineeringGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) return gaps

    // Only check engineering designs
    if (design.designType !== 'Engineering') {
      return gaps
    }

    const allParts = await this.resolveDesignItems(designId, 'Part')

    if (allParts.length === 0) {
      return gaps
    }

    const partIds = allParts.map((p) => p.id)

    // Find parts with VALIDATES test cases
    const testedParts = await db
      .select({ partId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, partIds),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )
    const testedPartIds = new Set(testedParts.map((p) => p.partId))

    // Find parts with EBOM_SOURCE (mapped to MBOM)
    const mappedParts = await db
      .select({ partId: itemRelationships.sourceId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, partIds),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
    const mappedPartIds = new Set(mappedParts.map((p) => p.partId))

    // Check if any MBOM exists for this design
    const derivedMboms = await db
      .select({ id: designs.id })
      .from(designs)
      .where(
        and(
          eq(designs.sourceDesignId, designId),
          eq(designs.designType, 'Manufacturing'),
          eq(designs.isArchived, false),
        ),
      )
      .limit(1)

    const hasMbom = derivedMboms.length > 0

    // Process each part
    for (const part of allParts) {
      // Check for untested parts
      if (!testedPartIds.has(part.id)) {
        gaps.push({
          id: `gap-${part.id}-untested`,
          type: 'untested_part',
          itemId: part.id,
          itemNumber: part.itemNumber,
          itemName: part.name,
          itemType: part.itemType,
          revision: part.revision,
          state: part.state,
          domain: 'engineering',
          severity: await this.calculatePartSeverity(part.itemType, part.state),
          suggestion: 'Create test cases to validate this part',
        })
      }

      // Check for unmapped EBOM items (only if MBOM exists)
      if (hasMbom && !mappedPartIds.has(part.id)) {
        gaps.push({
          id: `gap-${part.id}-unmapped`,
          type: 'unmapped_ebom_item',
          itemId: part.id,
          itemNumber: part.itemNumber,
          itemName: part.name,
          itemType: part.itemType,
          revision: part.revision,
          state: part.state,
          domain: 'engineering',
          severity: 'minor',
          suggestion: 'Map this EBOM item to corresponding MBOM item',
        })
      }
    }

    return gaps
  }

  /**
   * Find manufacturing-related gaps:
   * - orphan_mbom_item: MBOM item with broken/missing EBOM_SOURCE link
   */
  static async findManufacturingGaps(designId: string): Promise<Array<Gap>> {
    const gaps: Array<Gap> = []

    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) return gaps

    // Only check manufacturing designs
    if (design.designType !== 'Manufacturing') {
      return gaps
    }

    const allMbomItems = await this.resolveDesignItems(designId, 'Part')

    if (allMbomItems.length === 0) {
      return gaps
    }

    const mbomItemIds = allMbomItems.map((p) => p.id)

    // Find MBOM items with EBOM_SOURCE relationship (linked to EBOM)
    const linkedMbomItems = await db
      .select({ mbomId: itemRelationships.targetId })
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, mbomItemIds),
          eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
        ),
      )
    const linkedIds = new Set(linkedMbomItems.map((p) => p.mbomId))

    // Process each MBOM item
    for (const mbomItem of allMbomItems) {
      // Check for orphan MBOM items (no EBOM_SOURCE link)
      if (!linkedIds.has(mbomItem.id)) {
        gaps.push({
          id: `gap-${mbomItem.id}-orphan`,
          type: 'orphan_mbom_item',
          itemId: mbomItem.id,
          itemNumber: mbomItem.itemNumber,
          itemName: mbomItem.name,
          itemType: mbomItem.itemType,
          revision: mbomItem.revision,
          state: mbomItem.state,
          domain: 'manufacturing',
          severity: 'major',
          suggestion:
            'Link this MBOM item to its EBOM source or remove if not needed',
        })
      }
    }

    return gaps
  }

  /**
   * Calculate coverage metrics for a design.
   */
  private static async calculateCoverageMetrics(
    designId: string,
  ): Promise<GapAnalysisResult['coverage']> {
    // Get design info
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    // Requirements coverage. The same resolution the gap list uses, so the
    // summary and the gap list cannot disagree about the population either —
    // not only about what a revised requirement still covers.
    const allRequirements = await this.resolveRequirements(designId)

    const requirementIds = allRequirements.map((r) => r.id)
    let allocated = 0
    let satisfied = 0
    let verified = 0
    let suspect = 0

    if (requirementIds.length > 0) {
      // Same reads as findRequirementGaps, so the summary and the gap list
      // cannot disagree about what a revised requirement still covers.
      const allocatedLinks = await ItemRelationshipService.findOutgoingLinks(
        requirementIds,
        ALLOCATED_TO_RELATIONSHIP,
      )
      const satisfiedLinks = await ItemRelationshipService.findIncomingLinks(
        requirementIds,
        SATISFIES_RELATIONSHIP,
      )
      const verifiedLinks = await ItemRelationshipService.findIncomingLinks(
        requirementIds,
        VERIFIED_BY_RELATIONSHIP,
      )
      allocated = idsWithLinks(allocatedLinks).size
      satisfied = idsWithLinks(satisfiedLinks).size
      const { counts, suspectVerified } = await this.suspectLinkCounts({
        allocatedLinks,
        satisfiedLinks,
        verifiedLinks,
      })
      verified = allRequirements.filter(
        (r) =>
          isVerifiedStatus(r.verificationStatus) && !suspectVerified.has(r.id),
      ).length
      suspect = counts.size
    }

    // Engineering coverage
    const allParts = await this.resolveDesignItems(designId, 'Part')

    const partIds = allParts.map((p) => p.id)
    let tested = 0
    let mappedToMbom = 0

    if (partIds.length > 0) {
      const testedParts = await db
        .select({ partId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.targetId, partIds),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
      tested = new Set(testedParts.map((p) => p.partId)).size

      const mappedParts = await db
        .select({ partId: itemRelationships.sourceId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.sourceId, partIds),
            eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
          ),
        )
      mappedToMbom = new Set(mappedParts.map((p) => p.partId)).size
    }

    // Manufacturing coverage (for MBOM designs)
    let mbomTotal = 0
    let linkedToEbom = 0

    if (design?.designType === 'Manufacturing') {
      // An MBOM's items are the design's parts — the same resolution the
      // engineering block above already performed, reused rather than asked
      // again so the two counts cannot come back different.
      mbomTotal = allParts.length
      const mbomItemIds = partIds

      if (mbomItemIds.length > 0) {
        const linkedItems = await db
          .select({ mbomId: itemRelationships.targetId })
          .from(itemRelationships)
          .where(
            and(
              inArray(itemRelationships.targetId, mbomItemIds),
              eq(itemRelationships.relationshipType, EBOM_SOURCE_RELATIONSHIP),
            ),
          )
        linkedToEbom = new Set(linkedItems.map((p) => p.mbomId)).size
      }
    }

    return {
      requirements: {
        total: allRequirements.length,
        allocated,
        satisfied,
        verified,
        suspect,
      },
      engineering: {
        total: allParts.length,
        tested,
        mappedToMbom,
      },
      manufacturing: {
        total: mbomTotal,
        linkedToEbom,
      },
    }
  }

  /**
   * How many of each requirement's trace links are suspect, over the links
   * the coverage reads already fetched — the same edges the counters were
   * computed from, so a requirement counted as covered by a stale claim is
   * reported rather than silently counted clean. Requirements with none are
   * absent from the result.
   */
  private static async suspectLinkCounts(linkSets: {
    allocatedLinks: Map<string, Array<{ id: string }>>
    satisfiedLinks: Map<string, Array<{ id: string }>>
    verifiedLinks: Map<string, Array<{ id: string }>>
  }): Promise<{
    counts: Map<string, number>
    /** Requirements with a suspect verifying claim — not verified, whatever the status says. */
    suspectVerified: Set<string>
  }> {
    const ownerOfLink = new Map<string, string>()
    const verifying = new Set<string>()
    for (const [kind, links] of Object.entries(linkSets)) {
      for (const [requirementId, rels] of links) {
        for (const rel of rels) {
          ownerOfLink.set(rel.id, requirementId)
          if (kind === 'verifiedLinks') verifying.add(rel.id)
        }
      }
    }
    const counts = new Map<string, number>()
    const suspectVerified = new Set<string>()
    if (ownerOfLink.size === 0) return { counts, suspectVerified }

    const states = await ItemRelationshipService.suspectStatesFor([
      ...ownerOfLink.keys(),
    ])
    for (const [relationshipId, requirementId] of ownerOfLink) {
      if (!states.get(relationshipId)?.suspect) continue
      counts.set(requirementId, (counts.get(requirementId) ?? 0) + 1)
      if (verifying.has(relationshipId)) suspectVerified.add(requirementId)
    }
    return { counts, suspectVerified }
  }

  /**
   * Calculate severity for a requirement gap based on priority.
   */
  private static calculateRequirementSeverity(
    priority: string | null,
  ): GapSeverity {
    switch (priority) {
      case 'MustHave':
        return 'critical'
      case 'ShouldHave':
        return 'major'
      case 'CouldHave':
        return 'minor'
      case 'WontHave':
        return 'minor'
      default:
        return 'major'
    }
  }

  /**
   * Calculate severity for a part gap based on state: a gap on released
   * lineage or on an item already moving through its flow is major; one on
   * an item still in its initial state is minor.
   */
  private static async calculatePartSeverity(
    itemType: string,
    state: string,
  ): Promise<GapSeverity> {
    if (await LifecycleService.isInitialState(itemType, state)) {
      return 'minor'
    }
    return 'major'
  }

  /**
   * Calculate summary statistics from gaps.
   */
  private static calculateSummary(
    gaps: Array<Gap>,
    coverage: GapAnalysisResult['coverage'],
  ): GapAnalysisResult['summary'] {
    const byType: Record<GapType, number> = {
      unallocated_requirement: 0,
      unsatisfied_requirement: 0,
      unverified_requirement: 0,
      suspect_requirement: 0,
      untested_part: 0,
      unmapped_ebom_item: 0,
      orphan_mbom_item: 0,
      missing_documentation: 0,
    }

    const bySeverity: Record<GapSeverity, number> = {
      critical: 0,
      major: 0,
      minor: 0,
    }

    const byDomain: Record<ThreadDomain, number> = {
      requirements: 0,
      engineering: 0,
      manufacturing: 0,
      validation: 0,
      physical: 0,
    }

    for (const gap of gaps) {
      byType[gap.type]++
      bySeverity[gap.severity]++
      byDomain[gap.domain]++
    }

    // Calculate completeness (weighted average)
    const { requirements: req, engineering: eng } = coverage

    const allocatedPercent =
      req.total > 0 ? (req.allocated / req.total) * 100 : 100
    const satisfiedPercent =
      req.total > 0 ? (req.satisfied / req.total) * 100 : 100
    const verifiedPercent =
      req.total > 0 ? (req.verified / req.total) * 100 : 100
    const testedPercent = eng.total > 0 ? (eng.tested / eng.total) * 100 : 100

    const completeness = Math.round(
      allocatedPercent * 0.2 +
        satisfiedPercent * 0.3 +
        verifiedPercent * 0.3 +
        testedPercent * 0.2,
    )

    return {
      totalGaps: gaps.length,
      byType,
      bySeverity,
      byDomain,
      completeness,
    }
  }
}
