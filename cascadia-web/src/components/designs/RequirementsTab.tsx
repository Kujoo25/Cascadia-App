// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The design's Requirements tab: coverage at a glance, and the requirements
 * traceability matrix (RTM) as a grid — or its verification columns, the
 * VCRM — at whatever version context the page is viewing. Read through
 * `designRtmQuery`, so the figures here are the figures the program rollup
 * sums, and a write anywhere on the trace graph restages them.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Link2,
  ListChecks,
} from 'lucide-react'
import type {
  RequirementsMatrix,
  RtmGapType,
  RtmLink,
  RtmRow,
  RtmVerifyingTest,
} from '@cascadia/commons/services/types/requirements-matrix'
import type { DataGridColumn } from '@/components/ui'
import type { VersionContext } from '@/hooks/useVersionContext'
import type { SuspectReasonLabels } from '@/components/items/suspect-links'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataGrid,
} from '@/components/ui'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'
import {
  AffirmAllButton,
  SuspectBadge,
  useAffirmLinks,
} from '@/components/items/suspect-links'
import { designRtmQuery, useInvalidateResources } from '@/query'
import { ImportButton } from '@/components/import/ImportButton'
import { getVersionContextLabel } from '@/hooks/useVersionContext'
import { cn } from '@/utils'

interface RequirementsTabProps {
  designId: string
  designCode: string
  /** The design's program, so the import wizard opens on this design. */
  programId?: string | null
  versionContext: VersionContext
  isHistoricalView: boolean
}

type MatrixView = 'rtm' | 'vcrm'
type GapFilter = 'all' | 'any' | RtmGapType

const GAP_LABELS: Record<RtmGapType, string> = {
  not_allocated: 'Not allocated',
  not_satisfied: 'Not satisfied',
  not_verified: 'Not verified',
}

const PRIORITY_LABELS: Record<string, string> = {
  MustHave: 'Must Have',
  ShouldHave: 'Should Have',
  CouldHave: 'Could Have',
  WontHave: "Won't Have",
}

const PRIORITY_VARIANTS: Record<
  string,
  'default' | 'secondary' | 'warning' | 'destructive'
> = {
  MustHave: 'destructive',
  ShouldHave: 'warning',
  CouldHave: 'default',
  WontHave: 'secondary',
}

/** The claim's other end revised, or the requirement did. */
const INCOMING_SUSPECT_LABELS: SuspectReasonLabels = {
  source_revised: 'Linked item revised',
  target_revised: 'Requirement revised',
}
/** An allocation runs from the requirement, so the ends read the other way. */
const ALLOCATION_SUSPECT_LABELS: SuspectReasonLabels = {
  source_revised: 'Requirement revised',
  target_revised: 'Linked item revised',
}

/** The second hop runs from the element to the item that realizes it. */
const REALIZATION_SUSPECT_LABELS: SuspectReasonLabels = {
  source_revised: 'Element revised',
  target_revised: 'Realizing item revised',
}

const EXECUTION_VARIANTS: Record<
  string,
  'success' | 'destructive' | 'warning' | 'secondary'
> = {
  Passed: 'success',
  Failed: 'destructive',
  Blocked: 'warning',
}

const STATUS_VARIANTS: Record<
  string,
  'success' | 'destructive' | 'warning' | 'secondary' | 'default'
> = {
  Passed: 'success',
  Waived: 'success',
  Failed: 'destructive',
  InProgress: 'warning',
  NotStarted: 'secondary',
}

/** The numbers, with an allocation's second hop after an arrow. */
function joinNumbers(links: Array<RtmLink>): string {
  return links
    .map((link) =>
      link.realizedBy && link.realizedBy.length > 0
        ? `${link.itemNumber} → ${link.realizedBy.map((hop) => hop.itemNumber).join('/')}`
        : link.itemNumber,
    )
    .join('; ')
}

function LinkList({
  links,
  labels,
}: {
  links: Array<RtmLink>
  labels: SuspectReasonLabels
}) {
  if (links.length === 0) {
    return <span className="text-slate-400">—</span>
  }
  return (
    <ul className="space-y-1">
      {links.map((link) => (
        <li
          key={link.relationshipId}
          className="flex flex-wrap items-center gap-1.5"
        >
          <ItemLink
            itemType={link.itemType}
            itemId={link.itemId}
            className="font-mono text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            {link.itemNumber}
          </ItemLink>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {link.revision}
          </span>
          {link.suspect && (
            <SuspectBadge reasons={link.suspectReasons} labels={labels} />
          )}
          {/* An allocation to a system element shows its second hop: the
              items that realize the element at this context. */}
          {link.realizedBy && link.realizedBy.length > 0 && (
            <span className="flex flex-wrap items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              <ArrowRight className="h-3 w-3" aria-hidden />
              {link.realizedBy.map((hop) => (
                <span
                  key={hop.relationshipId}
                  className="inline-flex items-center gap-1"
                >
                  <ItemLink
                    itemType={hop.itemType}
                    itemId={hop.itemId}
                    className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {hop.itemNumber}
                  </ItemLink>
                  {hop.suspect && (
                    <SuspectBadge
                      reasons={hop.suspectReasons}
                      labels={REALIZATION_SUSPECT_LABELS}
                    />
                  )}
                </span>
              ))}
            </span>
          )}
          {link.realizedBy && link.realizedBy.length === 0 && (
            <span className="text-xs text-slate-400">not yet realized</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function TestList({ tests }: { tests: Array<RtmVerifyingTest> }) {
  if (tests.length === 0) {
    return <span className="text-slate-400">—</span>
  }
  return (
    <ul className="space-y-1">
      {tests.map((test) => (
        <li
          key={test.relationshipId}
          className="flex flex-wrap items-center gap-1.5"
        >
          <ItemLink
            itemType={test.itemType}
            itemId={test.itemId}
            className="font-mono text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            {test.itemNumber}
          </ItemLink>
          <Badge
            variant={
              test.executionStatus
                ? (EXECUTION_VARIANTS[test.executionStatus] ?? 'secondary')
                : 'secondary'
            }
          >
            {test.executionStatus ?? 'Not run'}
          </Badge>
          {test.suspect && (
            <SuspectBadge
              reasons={test.suspectReasons}
              labels={INCOMING_SUSPECT_LABELS}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function StatCard({
  label,
  value,
  of,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  of?: number
  icon: typeof ListChecks
  tone: string
}) {
  const percent =
    of !== undefined && of > 0 ? Math.round((value / of) * 100) : null
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn('rounded-lg p-2', tone)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 dark:text-white">
            {value}
            {percent !== null && (
              <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                {percent}%
              </span>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export function RequirementsTab({
  designId,
  designCode,
  programId,
  versionContext,
  isHistoricalView,
}: RequirementsTabProps) {
  const {
    data: matrix,
    isPending,
    isError,
  } = useQuery(
    designRtmQuery(designId, {
      branchId: versionContext.branchId,
      tagId: versionContext.tagId,
      commitId: versionContext.commitId,
    }),
  )
  const [view, setView] = useState<MatrixView>('rtm')
  const [gapFilter, setGapFilter] = useState<GapFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<string>('all')
  const [suspectOnly, setSuspectOnly] = useState(false)
  const { affirm, pendingIds } = useAffirmLinks({
    invalidates: ['relationships', 'requirements'],
  })
  const invalidate = useInvalidateResources()

  const rows = useMemo(() => {
    const all = matrix?.rows ?? []
    return all.filter((row) => {
      if (gapFilter === 'any' && row.gaps.length === 0) return false
      if (
        gapFilter !== 'all' &&
        gapFilter !== 'any' &&
        !row.gaps.includes(gapFilter)
      ) {
        return false
      }
      if (
        priorityFilter !== 'all' &&
        (row.requirement.priority ?? '') !== priorityFilter
      ) {
        return false
      }
      if (suspectOnly && row.suspectCount === 0) return false
      return true
    })
  }, [matrix, gapFilter, priorityFilter, suspectOnly])

  const suspectRelationshipIds = useMemo(
    () =>
      (matrix?.rows ?? []).flatMap((row) =>
        [...row.allocatedTo, ...row.satisfiedBy, ...row.verifiedBy]
          .filter((link) => link.suspect)
          .map((link) => link.relationshipId),
      ),
    [matrix],
  )

  const columns = useMemo<Array<DataGridColumn<RtmRow>>>(() => {
    const requirement: DataGridColumn<RtmRow> = {
      id: 'requirement',
      header: 'Requirement',
      accessorFn: (row) => row.requirement.itemNumber,
      enableSorting: true,
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Number…',
      cell: ({ row }) => (
        <div>
          <ItemLink
            itemType="Requirement"
            itemId={row.original.requirement.id}
            className="font-mono text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {row.original.requirement.itemNumber}
          </ItemLink>
          <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
            {row.original.requirement.revision}
          </span>
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {row.original.requirement.name}
          </p>
        </div>
      ),
    }
    const priority: DataGridColumn<RtmRow> = {
      id: 'priority',
      header: 'Priority',
      accessorFn: (row) => row.requirement.priority ?? '',
      enableSorting: true,
      cell: ({ row }) => {
        const value = row.original.requirement.priority
        return value ? (
          <Badge variant={PRIORITY_VARIANTS[value] ?? 'default'}>
            {PRIORITY_LABELS[value] ?? value}
          </Badge>
        ) : (
          <span className="text-slate-400">—</span>
        )
      },
    }
    const state: DataGridColumn<RtmRow> = {
      id: 'state',
      header: 'State',
      accessorFn: (row) => row.requirement.state,
      enableSorting: true,
      cell: ({ row }) => (
        <StateBadge
          itemType="Requirement"
          state={row.original.requirement.state}
        />
      ),
    }
    const verification: DataGridColumn<RtmRow> = {
      id: 'verificationStatus',
      header: 'Verification',
      accessorFn: (row) => row.requirement.verificationStatus ?? '',
      enableSorting: true,
      cell: ({ row }) => {
        const value = row.original.requirement.verificationStatus
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={
                value ? (STATUS_VARIANTS[value] ?? 'default') : 'secondary'
              }
            >
              {value ?? 'Not started'}
            </Badge>
            {row.original.verified ? (
              <CheckCircle2
                className="h-4 w-4 text-green-600"
                aria-label="Verified"
              />
            ) : null}
          </div>
        )
      },
    }
    const verifiedBy: DataGridColumn<RtmRow> = {
      id: 'verifiedBy',
      header: 'Verified by',
      accessorFn: (row) =>
        row.verifiedBy
          .map(
            (test) =>
              `${test.itemNumber} (${test.executionStatus ?? 'Not run'})`,
          )
          .join('; '),
      cell: ({ row }) => <TestList tests={row.original.verifiedBy} />,
    }
    const suspect: DataGridColumn<RtmRow> = {
      id: 'suspect',
      header: 'Suspect',
      accessorFn: (row) => row.suspectCount,
      enableSorting: true,
      meta: { align: 'center' },
      cell: ({ row }) =>
        row.original.suspectCount > 0 ? (
          <Badge variant="warning">
            <AlertTriangle className="mr-1 h-3 w-3" />
            {row.original.suspectCount}
          </Badge>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    }
    const gaps: DataGridColumn<RtmRow> = {
      id: 'gaps',
      header: 'Gaps',
      accessorFn: (row) => row.gaps.map((gap) => GAP_LABELS[gap]).join('; '),
      cell: ({ row }) =>
        row.original.gaps.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.original.gaps.map((gap) => (
              <Badge key={gap} variant="outline">
                {GAP_LABELS[gap]}
              </Badge>
            ))}
          </div>
        ) : (
          <CheckCircle2
            className="h-4 w-4 text-green-600"
            aria-label="No gaps"
          />
        ),
    }
    if (view === 'vcrm') {
      const method: DataGridColumn<RtmRow> = {
        id: 'verificationMethod',
        header: 'Method',
        accessorFn: (row) => row.requirement.verificationMethod ?? '',
        enableSorting: true,
        cell: ({ row }) =>
          row.original.requirement.verificationMethod ?? (
            <span className="text-slate-400">—</span>
          ),
      }
      const lastRun: DataGridColumn<RtmRow> = {
        id: 'lastRun',
        header: 'Last run',
        accessorFn: (row) =>
          row.verifiedBy
            .map((test) => test.lastExecutedAt)
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? '',
        enableSorting: true,
        cell: ({ getValue }) => {
          const value = getValue() as string
          return value ? (
            new Date(value).toLocaleDateString()
          ) : (
            <span className="text-slate-400">—</span>
          )
        },
      }
      return [
        requirement,
        priority,
        method,
        verifiedBy,
        lastRun,
        verification,
        suspect,
      ]
    }
    const allocatedTo: DataGridColumn<RtmRow> = {
      id: 'allocatedTo',
      header: 'Allocated to',
      accessorFn: (row) => joinNumbers(row.allocatedTo),
      cell: ({ row }) => (
        <LinkList
          links={row.original.allocatedTo}
          labels={ALLOCATION_SUSPECT_LABELS}
        />
      ),
    }
    const satisfiedBy: DataGridColumn<RtmRow> = {
      id: 'satisfiedBy',
      header: 'Satisfied by',
      accessorFn: (row) => joinNumbers(row.satisfiedBy),
      cell: ({ row }) => (
        <LinkList
          links={row.original.satisfiedBy}
          labels={INCOMING_SUSPECT_LABELS}
        />
      ),
    }
    return [
      requirement,
      priority,
      state,
      allocatedTo,
      satisfiedBy,
      verifiedBy,
      verification,
      suspect,
      gaps,
    ]
  }, [view])

  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-red-600">
          Failed to load the requirements matrix.
        </CardContent>
      </Card>
    )
  }

  const totals: RequirementsMatrix['totals'] | undefined = matrix?.totals
  const contextLabel =
    versionContext.type === 'main'
      ? 'main as it stands'
      : getVersionContextLabel(versionContext)

  return (
    <div className="space-y-6">
      {totals && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatCard
            label="Requirements"
            value={totals.total}
            icon={ListChecks}
            tone="bg-purple-50 text-purple-600 dark:bg-purple-950 dark:text-purple-400"
          />
          <StatCard
            label="Allocated"
            value={totals.allocated}
            of={totals.total}
            icon={Link2}
            tone="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
          />
          <StatCard
            label="Satisfied"
            value={totals.satisfied}
            of={totals.total}
            icon={Link2}
            tone="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
          />
          <StatCard
            label="Verified"
            value={totals.verified}
            of={totals.total}
            icon={CheckCircle2}
            tone="bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400"
          />
          <StatCard
            label="With suspect links"
            value={totals.suspect}
            of={totals.total}
            icon={AlertTriangle}
            tone="bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
          />
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>
              {view === 'rtm'
                ? 'Requirements traceability matrix'
                : 'Verification cross-reference matrix'}
            </CardTitle>
            <CardDescription>
              {view === 'rtm'
                ? 'Each requirement with what it is allocated to, what satisfies it and what verifies it'
                : 'Each requirement with its verification method, its tests and their latest results'}
              , at {contextLabel}.
              {isHistoricalView
                ? ' A tag or commit is a snapshot: claims are judged against the rows it holds.'
                : ' A suspect claim is one whose ends revised since it was affirmed; it is not counted as evidence.'}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-slate-300 dark:border-slate-700">
              <Button
                variant={view === 'rtm' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setView('rtm')}
              >
                RTM
              </Button>
              <Button
                variant={view === 'vcrm' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setView('vcrm')}
              >
                VCRM
              </Button>
            </div>
            {!isHistoricalView && suspectRelationshipIds.length > 0 && (
              <AffirmAllButton
                relationshipIds={suspectRelationshipIds}
                pendingIds={pendingIds}
                onAffirm={affirm}
                title="Affirm every suspect claim in this matrix"
              />
            )}
            {!isHistoricalView && (
              <ImportButton
                itemType="Requirement"
                programId={programId ?? undefined}
                designId={designId}
                branchId={versionContext.branchId}
                size="sm"
                onImportComplete={() => {
                  void invalidate('requirements')
                }}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              title="Download the requirements on main as a sheet the import reads back"
              onClick={() => {
                window.location.assign(
                  `/api/v1/designs/${designId}/requirements-export?format=csv`,
                )
              }}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Export sheet
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">Gaps:</span>
            {(
              [
                ['all', 'All'],
                ['any', 'Any gap'],
                ['not_allocated', GAP_LABELS.not_allocated],
                ['not_satisfied', GAP_LABELS.not_satisfied],
                ['not_verified', GAP_LABELS.not_verified],
              ] as Array<[GapFilter, string]>
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={gapFilter === value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setGapFilter(value)}
              >
                {label}
                {totals && value !== 'all' && value !== 'any'
                  ? ` (${totals.gaps[value]})`
                  : ''}
              </Button>
            ))}
            <span className="ml-2 text-slate-500 dark:text-slate-400">
              Priority:
            </span>
            {['all', 'MustHave', 'ShouldHave', 'CouldHave', 'WontHave'].map(
              (value) => (
                <Button
                  key={value}
                  variant={priorityFilter === value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPriorityFilter(value)}
                >
                  {value === 'all' ? 'All' : PRIORITY_LABELS[value]}
                </Button>
              ),
            )}
            <Button
              variant={suspectOnly ? 'default' : 'outline'}
              size="sm"
              className="ml-2"
              onClick={() => setSuspectOnly((on) => !on)}
            >
              <AlertTriangle className="mr-1 h-3.5 w-3.5" />
              Suspect only
            </Button>
          </div>
          <DataGrid
            data={rows}
            columns={columns}
            getRowId={(row) => row.requirement.id}
            isLoading={isPending}
            enablePagination
            enableSorting
            enableFiltering
            enableGlobalFilter
            exportFilename={`${designCode}-${view}`}
            emptyMessage="No requirements"
            emptyDescription={
              matrix && matrix.rows.length > 0
                ? 'No requirement matches the filters.'
                : 'This design has no requirements at this context.'
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
