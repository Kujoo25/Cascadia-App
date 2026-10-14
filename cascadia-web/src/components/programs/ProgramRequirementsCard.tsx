// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The program page's requirements rollup: one line per design at main, the
 * totals of each design's traceability matrix, and the open gaps across the
 * program. Each line drills down to the design's Requirements tab.
 */

import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ListChecks } from 'lucide-react'
import type { RtmGapType } from '@cascadia/commons/services/types/requirements-matrix'
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { ItemLink } from '@/components/items/ItemLink'
import { programRequirementsRollupQuery } from '@/query'

const GAP_LABELS: Record<RtmGapType, string> = {
  not_allocated: 'Not allocated',
  not_satisfied: 'Not satisfied',
  not_verified: 'Not verified',
}

/** How many open gaps the card lists before pointing at the designs' tabs. */
const GAPS_SHOWN = 8

function ratio(value: number, of: number): string {
  if (of === 0) return '—'
  return `${value} (${Math.round((value / of) * 100)}%)`
}

export function ProgramRequirementsCard({ programId }: { programId: string }) {
  const { data: rollup, isPending } = useQuery(
    programRequirementsRollupQuery(programId),
  )

  if (isPending || !rollup) return null

  const designs = rollup.designs.filter((design) => design.total > 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          <CardTitle>Requirements</CardTitle>
        </div>
        <CardDescription>
          {rollup.totals.total === 0
            ? 'No requirements in this program yet.'
            : `${rollup.totals.total} requirements across ${designs.length} ${
                designs.length === 1 ? 'design' : 'designs'
              }: ${rollup.totals.verified} verified, ${rollup.openGapsTotal} open ${
                rollup.openGapsTotal === 1 ? 'gap' : 'gaps'
              }.`}
        </CardDescription>
      </CardHeader>
      {rollup.totals.total > 0 && (
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Design</TableHead>
                <TableHead className="text-right">Requirements</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Satisfied</TableHead>
                <TableHead className="text-right">Verified</TableHead>
                <TableHead className="text-right">Suspect</TableHead>
                <TableHead className="text-right">Gaps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {designs.map((design) => {
                const gaps =
                  design.gaps.not_allocated +
                  design.gaps.not_satisfied +
                  design.gaps.not_verified
                return (
                  <TableRow key={design.designId}>
                    <TableCell>
                      <Link
                        to="/designs/$id"
                        params={{ id: design.designId }}
                        search={{ tab: 'requirements' }}
                        className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {design.designCode}
                      </Link>
                      <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                        {design.designName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{design.total}</TableCell>
                    <TableCell className="text-right">
                      {ratio(design.allocated, design.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {ratio(design.satisfied, design.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {ratio(design.verified, design.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {design.suspect > 0 ? (
                        <Badge variant="warning">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {design.suspect}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right">{gaps}</TableCell>
                  </TableRow>
                )
              })}
              {designs.length > 1 && (
                <TableRow className="font-medium">
                  <TableCell>All designs</TableCell>
                  <TableCell className="text-right">
                    {rollup.totals.total}
                  </TableCell>
                  <TableCell className="text-right">
                    {ratio(rollup.totals.allocated, rollup.totals.total)}
                  </TableCell>
                  <TableCell className="text-right">
                    {ratio(rollup.totals.satisfied, rollup.totals.total)}
                  </TableCell>
                  <TableCell className="text-right">
                    {ratio(rollup.totals.verified, rollup.totals.total)}
                  </TableCell>
                  <TableCell className="text-right">
                    {rollup.totals.suspect || '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {rollup.openGapsTotal}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {rollup.openGaps.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                Open gaps, most important first
              </p>
              <ul className="space-y-1">
                {rollup.openGaps.slice(0, GAPS_SHOWN).map((gap) => (
                  <li
                    key={`${gap.requirementId}:${gap.gapType}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <ItemLink
                      itemType="Requirement"
                      itemId={gap.requirementId}
                      className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {gap.itemNumber}
                    </ItemLink>
                    <span className="text-slate-700 dark:text-slate-300">
                      {gap.name}
                    </span>
                    <Badge variant="outline">{GAP_LABELS[gap.gapType]}</Badge>
                    {gap.priority && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {gap.priority} · {gap.designCode}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {rollup.openGapsTotal > GAPS_SHOWN && (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {rollup.openGapsTotal - GAPS_SHOWN} more on the designs'
                  Requirements tabs.
                </p>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
