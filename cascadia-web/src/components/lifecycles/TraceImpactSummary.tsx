// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { AlertTriangle } from 'lucide-react'
import { catalogEntry } from '@cascadia/commons/items/relationships/catalog'
import type {
  ReleaseTraceImpact,
  ReleaseTraceImpactLink,
} from '@/query/options/change-orders'

/** How many of the affected claims the dialog lists before "and N more". */
const SHOWN = 8

/** "PN-001 revised" / "REQ-004 revised": the end that moved, by number. */
function reasonText(link: ReleaseTraceImpactLink): string {
  return link.reasons
    .map((reason) =>
      reason === 'source_revised'
        ? `${link.source.itemNumber} revised`
        : `${link.target.itemNumber} revised`,
    )
    .join(', ')
}

/**
 * The trace-impact section of the release preview: the claims this release
 * will leave suspect, so a reviewer approves knowing what will need a look.
 * Rendered only when there is something to say; it never blocks the release.
 */
export function TraceImpactSummary({ impact }: { impact: ReleaseTraceImpact }) {
  const links = impact.links ?? []
  const shown = links.slice(0, SHOWN)
  const more = impact.suspectAfterRelease - shown.length
  const count = impact.suspectAfterRelease
  const newly =
    impact.newlySuspect < count ? ` (${impact.newlySuspect} newly)` : ''

  return (
    <div className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-white/60 dark:bg-black/20 p-2 text-xs">
      <div className="flex items-center gap-1 font-medium text-amber-900 dark:text-amber-100">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          {count} trace {count === 1 ? 'link' : 'links'} will be suspect after
          this release{newly}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-amber-800 dark:text-amber-200">
          {shown.map((link) => (
            <li key={link.relationshipId}>
              <span className="font-mono">{link.source.itemNumber}</span>{' '}
              {catalogEntry(link.relationshipType)?.label.toLowerCase() ??
                link.relationshipType}{' '}
              <span className="font-mono">{link.target.itemNumber}</span>
              {' — '}
              {reasonText(link)}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <div className="mt-1 text-amber-700 dark:text-amber-300">
          and {more} more
        </div>
      )}
      <div className="mt-1 text-amber-700 dark:text-amber-300">
        Releasing does not wait on them. Affirm each from its item page once the
        release has landed, or revise what changed.
      </div>
    </div>
  )
}
