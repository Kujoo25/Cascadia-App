// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { SystemElement } from '@cascadia/commons/items/types/system-element'
import type { ItemFilters } from '@/query'
import { PageContainer } from '@/components/layout'
import { SystemElementTable } from '@/components/system-elements/SystemElementTable'
import { useVersionContext } from '@/hooks/useVersionContext'
import { useServerDataGrid } from '@/hooks/useServerDataGrid'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/hooks/useAlertDialog'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import {
  designListQuery,
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  lifecycleByItemTypeQuery,
  useInvalidateResources,
} from '@/query'
import { apiFetch } from '@/api/client'
import { LifecycleStateCards } from '@/components/items/LifecycleStateCards'

// Search schema for URL validation
const systemElementsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_elementKind: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type SystemElementsSearch = z.infer<typeof systemElementsSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function elementFilters(search: SystemElementsSearch): ItemFilters {
  return {
    itemType: 'SystemElement',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/system-elements/')({
  validateSearch: systemElementsSearchSchema,
  component: SystemElementsListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = elementFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<SystemElement>(filters, gridParamsFromSearch(deps)),
      ),
      (async () => {
        const lifecycle = await queryClient.ensureQueryData(
          lifecycleByItemTypeQuery('SystemElement'),
        )
        await queryClient.ensureQueryData(
          itemCountsQuery(
            filters,
            lifecycle.states.map((state) => state.id),
          ),
        )
      })(),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function SystemElementsListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()
  const filters = elementFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())
  const {
    items: elements,
    total,
    dataGridProps,
  } = useServerDataGrid<SystemElement>({
    query: itemGridQuery<SystemElement>(filters),
  })

  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  const handleEdit = (element: SystemElement) => {
    if (element.id) {
      navigate({ to: '/system-elements/$id', params: { id: element.id } })
    }
  }

  const handleDelete = (element: SystemElement) => {
    if (!element.id) return
    confirm({
      title: 'Delete System Element',
      description: `Are you sure you want to delete ${element.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/system-elements/${element.id}`, {
            method: 'DELETE',
          })
          showSuccess(
            'System element deleted',
            `${element.itemNumber} has been deleted`,
          )
          await invalidate('system-elements')
        } catch (error) {
          handleError(error, { title: 'Failed to delete system element' })
        }
      },
    })
  }

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'branch':
        return 'secondary'
      case 'tag':
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              System Elements
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            The logical architecture: what requirements are allocated to before
            any part exists
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <Link
          to="/system-elements/new"
          search={selectedDesignId ? { designId: selectedDesignId } : {}}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create System Element
          </Button>
        </Link>
      </div>

      {/* Stats — one card per lifecycle state, from configuration */}
      <LifecycleStateCards
        itemType="SystemElement"
        filters={filters}
        total={total}
        totalLabel="Total System Elements"
      />

      <Card>
        <CardHeader>
          <CardTitle>All System Elements</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'system element' : 'system elements'} in the
            system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SystemElementTable
            elements={elements}
            onEdit={handleEdit}
            onDelete={handleDelete}
            serverSidePagination={dataGridProps.serverSidePagination}
            totalRows={dataGridProps.totalRows}
            onPageChange={dataGridProps.onPageChange}
            isLoading={dataGridProps.isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
