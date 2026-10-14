// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import type { Resource } from '@/query'
import type { SuspectReason } from '@cascadia/commons/items/suspect-reason'
import { apiFetch } from '@/api/client'
import { useResourceMutation } from '@/query'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { useToast } from '@/hooks/useToast'
import { Badge, Button } from '@/components/ui'

/**
 * Suspect trace links, as every trace panel shows them.
 *
 * A trace claim (`SATISFIES`, `ALLOCATED_TO`, `VERIFIED_BY`, `VALIDATES`)
 * reads as suspect once either of its ends revised since it was last
 * affirmed; the API attaches `suspect` and `suspectReasons` to every listing
 * of one. Affirming is a review record, not an edit of the link, so the
 * affordances here are offered whenever a link is suspect — read-only
 * panels included, no checkout, no version context. What differs per panel
 * is only the wording of the reasons, since "the source revised" reads
 * differently from a requirement's page and from a part's.
 */

export type { SuspectReason }

export interface SuspectLinkFields {
  relationshipId: string
  /** The claim is stale: one end revised since it was last affirmed. */
  suspect?: boolean
  suspectReasons?: Array<SuspectReason>
}

export type SuspectReasonLabels = Record<SuspectReason, string>

/** The ids of the suspect links among `links`. */
export function suspectIdsOf(
  links: ReadonlyArray<SuspectLinkFields>,
): Array<string> {
  return links.filter((link) => link.suspect).map((link) => link.relationshipId)
}

interface BulkAffirmResult {
  affirmed: number
  results: Array<{
    relationshipId: string
    outcome: 'affirmed' | 'not_found' | 'forbidden' | 'not_suspectable'
  }>
}

const OUTCOME_TEXT: Record<
  Exclude<BulkAffirmResult['results'][number]['outcome'], 'affirmed'>,
  string
> = {
  not_found: 'no longer exist',
  forbidden: 'are not yours to affirm',
  not_suspectable: 'carry no affirmation',
}

/**
 * Affirm one or more trace links and refresh what lists them.
 *
 * One request whatever the count (`POST /relationships/affirm`), answered
 * per row: a link the caller may not affirm is reported, not a reason to
 * refuse the rest. `pendingIds` holds the ids in flight so a panel can show
 * which rows are being affirmed.
 */
export function useAffirmLinks(options: {
  invalidates: ReadonlyArray<Resource>
  onAffirmed?: () => void
}) {
  const { handleError } = useErrorHandler()
  const { addToast } = useToast()
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const mutation = useResourceMutation<BulkAffirmResult, Error, Array<string>>({
    mutationFn: async (relationshipIds) => {
      const result = await apiFetch<{ data: BulkAffirmResult }>(
        '/api/v1/relationships/affirm',
        {
          method: 'POST',
          body: JSON.stringify({ relationshipIds }),
        },
      )
      return result.data
    },
    invalidates: options.invalidates,
    onSuccess: (result, relationshipIds) => {
      const byOutcome = new Map<keyof typeof OUTCOME_TEXT, number>()
      for (const row of result.results) {
        if (row.outcome === 'affirmed') continue
        byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1)
      }
      if (byOutcome.size > 0) {
        addToast({
          variant: 'warning',
          title:
            result.affirmed > 0
              ? `Affirmed ${result.affirmed} of ${relationshipIds.length} links`
              : 'No links were affirmed',
          description: [...byOutcome]
            .map(([outcome, count]) => `${count} ${OUTCOME_TEXT[outcome]}`)
            .join('; '),
        })
      }
      if (result.affirmed > 0) options.onAffirmed?.()
    },
  })

  // Stable, so a memoized column set that closes over it does not rebuild
  // on every render; `mutateAsync` is stable across renders.
  const { mutateAsync } = mutation
  const affirm = useCallback(
    async (relationshipIds: Array<string>) => {
      if (relationshipIds.length === 0) return
      setPendingIds(new Set(relationshipIds))
      try {
        await mutateAsync(relationshipIds)
      } catch (error) {
        handleError(error, { title: 'Could not affirm link' })
      } finally {
        setPendingIds(new Set())
      }
    },
    [mutateAsync, handleError],
  )

  return { affirm, pendingIds, isPending: mutation.isPending }
}

/** The suspect badge, with the reasons as its tooltip. */
export function SuspectBadge({
  reasons = [],
  labels,
  className,
}: {
  reasons?: Array<SuspectReason>
  labels: SuspectReasonLabels
  className?: string
}) {
  return (
    <Badge
      variant="warning"
      className={className}
      title={reasons.map((reason) => labels[reason]).join('; ')}
    >
      <AlertTriangle className="h-3 w-3 mr-1" />
      Suspect
    </Badge>
  )
}

/** Affirm one link. */
export function AffirmButton({
  relationshipId,
  pendingIds,
  onAffirm,
  title,
  variant = 'outline',
}: {
  relationshipId: string
  pendingIds: ReadonlySet<string>
  onAffirm: (relationshipIds: Array<string>) => void
  title: string
  variant?: 'outline' | 'ghost'
}) {
  const pending = pendingIds.has(relationshipId)
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={() => onAffirm([relationshipId])}
      disabled={pendingIds.size > 0}
      title={title}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin mr-1" />
      ) : (
        <ShieldCheck className="h-4 w-4 mr-1" />
      )}
      Affirm
    </Button>
  )
}

/**
 * Affirm every suspect link a panel lists. Shown only when there are two or
 * more — one link has its own button.
 */
export function AffirmAllButton({
  relationshipIds,
  pendingIds,
  onAffirm,
  title,
}: {
  relationshipIds: Array<string>
  pendingIds: ReadonlySet<string>
  onAffirm: (relationshipIds: Array<string>) => void
  title: string
}) {
  if (relationshipIds.length < 2) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onAffirm(relationshipIds)}
      disabled={pendingIds.size > 0}
      title={title}
    >
      {pendingIds.size > 1 ? (
        <Loader2 className="h-4 w-4 animate-spin mr-1" />
      ) : (
        <ShieldCheck className="h-4 w-4 mr-1" />
      )}
      Affirm all suspect ({relationshipIds.length})
    </Button>
  )
}
