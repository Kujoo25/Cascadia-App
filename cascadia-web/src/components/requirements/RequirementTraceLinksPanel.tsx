// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { catalogEntry } from '@cascadia/commons/items/relationships/catalog'
import type { BaseItem } from '@cascadia/commons/items/types/base'
import type {
  SuspectReason,
  SuspectReasonLabels,
} from '@/components/items/suspect-links'
import { apiFetch } from '@/api/client'
import {
  entitySubQuery,
  itemCollectionQuery,
  useInvalidateResources,
} from '@/query'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { getItemTypeLabel } from '@/items/item-type-ui'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'
import {
  AffirmAllButton,
  AffirmButton,
  SuspectBadge,
  suspectIdsOf,
  useAffirmLinks,
} from '@/components/items/suspect-links'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/** One end of a trace link, as the requirement's satisfy/allocate reads list it. */
interface TraceLinkedItem {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  relationshipId: string
  suspect?: boolean
  suspectReasons?: Array<SuspectReason>
}

/**
 * The two trace panels a requirement page lacked: the items that satisfy it
 * (incoming `SATISFIES`, which the generic relationships tab never lists
 * because it shows outgoing edges only) and the items it is allocated to
 * (outgoing `ALLOCATED_TO`, which had no UI anywhere). Both go through the
 * requirement's own link endpoints, so the edge lands in the right direction
 * whichever end the user starts from, and both read the catalog for which
 * item types may be picked.
 */
export type TraceLinkKind = 'satisfiedBy' | 'allocatedTo'

interface KindConfig {
  title: string
  description: string
  /** The catalog entry whose endpoint types bound the picker. */
  relationshipType: 'SATISFIES' | 'ALLOCATED_TO'
  /** The candidate item types, read from the catalog. */
  candidateTypes: ReadonlyArray<string>
  subPath: 'satisfy' | 'allocate'
  addLabel: string
  emptyText: string
  /** The reason labels, read from this requirement's side of the link. */
  reasonLabels: SuspectReasonLabels
  affirmTitle: string
  affirmAllTitle: string
}

const SATISFIES = catalogEntry('SATISFIES')
const ALLOCATED_TO = catalogEntry('ALLOCATED_TO')

const KINDS: Record<TraceLinkKind, KindConfig> = {
  satisfiedBy: {
    title: 'Satisfied by',
    description: 'Items that claim to satisfy this requirement',
    relationshipType: 'SATISFIES',
    candidateTypes: SATISFIES?.sourceTypes ?? ['Part'],
    subPath: 'satisfy',
    addLabel: 'Link item',
    emptyText: 'Nothing claims to satisfy this requirement yet',
    reasonLabels: {
      source_revised: 'the item revised since this link was affirmed',
      target_revised: 'this requirement revised since this link was affirmed',
    },
    affirmTitle:
      'Record that this item still satisfies the requirement as it now stands',
    affirmAllTitle:
      'Record that every suspect item still satisfies the requirement as it now stands',
  },
  allocatedTo: {
    title: 'Allocated to',
    description: 'Items this requirement is allocated to',
    relationshipType: 'ALLOCATED_TO',
    candidateTypes: ALLOCATED_TO?.targetTypes ?? ['Part'],
    subPath: 'allocate',
    addLabel: 'Allocate',
    emptyText: 'This requirement is not allocated to anything yet',
    reasonLabels: {
      source_revised: 'this requirement revised since this link was affirmed',
      target_revised: 'the item revised since this link was affirmed',
    },
    affirmTitle:
      'Record that this allocation still holds for the requirement as it now stands',
    affirmAllTitle:
      'Record that every suspect allocation still holds for the requirement as it now stands',
  },
}

interface RequirementTraceLinksPanelProps {
  kind: TraceLinkKind
  requirementId: string
  designId?: string
  isEditable?: boolean
}

export function RequirementTraceLinksPanel({
  kind,
  requirementId,
  designId,
  isEditable = false,
}: RequirementTraceLinksPanelProps) {
  const config = KINDS[kind]
  const { handleError } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [candidateType, setCandidateType] = useState<string>(
    config.candidateTypes[0] ?? 'Part',
  )
  const [busy, setBusy] = useState<string | null>(null)
  // Affirming is a review record, not an edit of the link, so it is offered
  // whenever the link is suspect — no checkout, no version context.
  const { affirm, pendingIds } = useAffirmLinks({
    invalidates: ['requirements'],
  })

  const { data: linked = [], isPending: loading } = useQuery(
    entitySubQuery<TraceLinkedItem>(
      'requirements',
      requirementId,
      config.subPath,
      'items',
    ),
  )

  // Candidates in the same design, of the type picked, minus the ones linked.
  const debouncedSearch = useDebouncedValue(searchQuery)
  const { data: candidates = [], isFetching: searching } = useQuery({
    ...itemCollectionQuery<BaseItem>({
      itemType: candidateType,
      designId,
      search: debouncedSearch,
    }),
    enabled: Boolean(debouncedSearch.trim()) && Boolean(designId),
  })
  const linkedIds = new Set(linked.map((item) => item.id))
  const searchResults = debouncedSearch.trim()
    ? candidates.filter((item) => item.id && !linkedIds.has(item.id))
    : []

  const run = async (
    key: string,
    request: () => Promise<unknown>,
    title: string,
  ) => {
    setBusy(key)
    try {
      await request()
      await invalidate('requirements')
    } catch (error) {
      handleError(error, { title })
    } finally {
      setBusy(null)
    }
  }

  const handleLink = (itemId: string) =>
    run(
      `link:${itemId}`,
      async () => {
        await apiFetch(
          `/api/v1/requirements/${requirementId}/${config.subPath}`,
          {
            method: 'POST',
            body: JSON.stringify({ itemIds: [itemId] }),
          },
        )
        setSearchQuery('')
      },
      `Could not ${config.addLabel.toLowerCase()}`,
    )

  const handleUnlink = (itemId: string) =>
    run(
      `unlink:${itemId}`,
      () =>
        apiFetch(`/api/v1/requirements/${requirementId}/${config.subPath}`, {
          method: 'DELETE',
          body: JSON.stringify({ itemId }),
        }),
      'Could not remove link',
    )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{config.title}</CardTitle>
            <CardDescription>{config.description}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <AffirmAllButton
              relationshipIds={suspectIdsOf(linked)}
              pendingIds={pendingIds}
              onAffirm={affirm}
              title={config.affirmAllTitle}
            />
            {isEditable && !showSearch && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSearch(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                {config.addLabel}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showSearch && isEditable && (
          <div className="space-y-2">
            <div className="flex gap-2">
              {config.candidateTypes.length > 1 && (
                <Select value={candidateType} onValueChange={setCandidateType}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.candidateTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {getItemTypeLabel(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="relative flex-grow">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${getItemTypeLabel(candidateType).toLowerCase()}s to link...`}
                  className="pl-10"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />
                )}
              </div>
            </div>
            {searchResults.length > 0 && (
              <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                {searchResults.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div>
                      <span className="font-mono text-sm">
                        {item.itemNumber}
                      </span>
                      <span className="ml-2 text-slate-600 dark:text-slate-400">
                        {item.name}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleLink(item.id!)}
                      disabled={busy === `link:${item.id}`}
                    >
                      {busy === `link:${item.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowSearch(false)
                  setSearchQuery('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : linked.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            {config.emptyText}
          </div>
        ) : (
          <div className="space-y-2">
            {linked.map((item) => (
              <div
                key={item.relationshipId}
                className="flex items-center justify-between gap-2 p-3 border rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <ItemLink
                  itemType={item.itemType}
                  itemId={item.id}
                  className="flex items-center gap-3 flex-grow min-w-0"
                >
                  <Badge variant="outline" className="text-xs">
                    {getItemTypeLabel(item.itemType)}
                  </Badge>
                  <span className="font-mono text-sm">{item.itemNumber}</span>
                  <span className="text-slate-600 dark:text-slate-400 truncate">
                    {item.name}
                  </span>
                  <StateBadge
                    itemType={item.itemType}
                    state={item.state}
                    className="text-xs"
                  />
                  {item.suspect && (
                    <SuspectBadge
                      reasons={item.suspectReasons}
                      labels={config.reasonLabels}
                    />
                  )}
                </ItemLink>
                {item.suspect && (
                  <AffirmButton
                    relationshipId={item.relationshipId}
                    pendingIds={pendingIds}
                    onAffirm={affirm}
                    title={config.affirmTitle}
                  />
                )}
                {isEditable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleUnlink(item.id)}
                    disabled={busy === `unlink:${item.id}`}
                    className="text-slate-400 hover:text-red-500"
                    title="Remove link"
                  >
                    {busy === `unlink:${item.id}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
