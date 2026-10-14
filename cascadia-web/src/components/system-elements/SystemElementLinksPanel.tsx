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

/** One end of an architecture link, as the element's own reads list it. */
interface LinkedItem {
  id: string
  itemNumber: string
  name: string | null
  /** Absent on the tree reads, whose ends are always system elements. */
  itemType?: string
  revision: string
  state: string
  relationshipId: string
  suspect?: boolean
  suspectReasons?: Array<SuspectReason>
}

/**
 * The three link panels of a system element page: the elements it decomposes
 * into (`DECOMPOSES`, outgoing — the tree), the items that realize it
 * (`REALIZED_BY`, outgoing), and the requirements allocated to it
 * (`ALLOCATED_TO`, incoming). The first two go through the element's own
 * link endpoints and read the catalog for which item types may be picked;
 * the third is read-only here, because an allocation is written from the
 * requirement's page.
 */
export type ElementLinkKind =
  'children' | 'realizedBy' | 'allocatedRequirements'

interface KindConfig {
  title: string
  description: string
  /** The candidate item types, read from the catalog; empty for a read-only panel. */
  candidateTypes: ReadonlyArray<string>
  subPath: 'children' | 'realized-by' | 'allocated-requirements'
  addLabel: string
  emptyText: string
  /** The reason labels, read from this element's side of the link; absent when the edge cannot go stale. */
  reasonLabels?: SuspectReasonLabels
  affirmTitle?: string
  affirmAllTitle?: string
}

const DECOMPOSES = catalogEntry('DECOMPOSES')
const REALIZED_BY = catalogEntry('REALIZED_BY')

const KINDS: Record<ElementLinkKind, KindConfig> = {
  children: {
    title: 'Decomposes into',
    description: 'The elements beneath this one in the architecture',
    candidateTypes: DECOMPOSES?.targetTypes ?? ['SystemElement'],
    subPath: 'children',
    addLabel: 'Add child',
    emptyText: 'This element has no children yet',
  },
  realizedBy: {
    title: 'Realized by',
    description: 'The parts and software that implement this element',
    candidateTypes: REALIZED_BY?.targetTypes ?? ['Part'],
    subPath: 'realized-by',
    addLabel: 'Realize',
    emptyText: 'Nothing realizes this element yet',
    reasonLabels: {
      source_revised: 'this element revised since this link was affirmed',
      target_revised: 'the item revised since this link was affirmed',
    },
    affirmTitle:
      'Record that this item still realizes the element as it now stands',
    affirmAllTitle:
      'Record that every suspect item still realizes the element as it now stands',
  },
  allocatedRequirements: {
    title: 'Allocated requirements',
    description:
      'Requirements allocated to this element — written from the requirement',
    candidateTypes: [],
    subPath: 'allocated-requirements',
    addLabel: '',
    emptyText: 'No requirement is allocated to this element yet',
    reasonLabels: {
      source_revised: 'the requirement revised since this link was affirmed',
      target_revised: 'this element revised since this link was affirmed',
    },
    affirmTitle:
      'Record that this allocation still holds for the element as it now stands',
    affirmAllTitle:
      'Record that every suspect allocation still holds for the element as it now stands',
  },
}

interface SystemElementLinksPanelProps {
  kind: ElementLinkKind
  elementId: string
  designId?: string
  isEditable?: boolean
}

export function SystemElementLinksPanel({
  kind,
  elementId,
  designId,
  isEditable = false,
}: SystemElementLinksPanelProps) {
  const config = KINDS[kind]
  const canLink = isEditable && config.candidateTypes.length > 0
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
    invalidates: ['system-elements'],
  })

  const { data: linked = [], isPending: loading } = useQuery(
    entitySubQuery<LinkedItem>(
      'system-elements',
      elementId,
      config.subPath,
      'items',
    ),
  )

  // Candidates in the same design, of the type picked, minus the ones
  // linked and the element itself.
  const debouncedSearch = useDebouncedValue(searchQuery)
  const { data: candidates = [], isFetching: searching } = useQuery({
    ...itemCollectionQuery<BaseItem>({
      itemType: candidateType,
      designId,
      search: debouncedSearch,
    }),
    enabled: canLink && Boolean(debouncedSearch.trim()) && Boolean(designId),
  })
  const linkedIds = new Set(linked.map((item) => item.id))
  const searchResults = debouncedSearch.trim()
    ? candidates.filter(
        (item) => item.id && item.id !== elementId && !linkedIds.has(item.id),
      )
    : []

  const run = async (
    key: string,
    request: () => Promise<unknown>,
    title: string,
  ) => {
    setBusy(key)
    try {
      await request()
      await invalidate('system-elements')
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
          `/api/v1/system-elements/${elementId}/${config.subPath}`,
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
        apiFetch(`/api/v1/system-elements/${elementId}/${config.subPath}`, {
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
            {config.affirmAllTitle && (
              <AffirmAllButton
                relationshipIds={suspectIdsOf(linked)}
                pendingIds={pendingIds}
                onAffirm={affirm}
                title={config.affirmAllTitle}
              />
            )}
            {canLink && !showSearch && (
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
        {showSearch && canLink && (
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
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {config.emptyText}
          </p>
        ) : (
          <ul className="divide-y">
            {linked.map((item) => {
              const itemType = item.itemType ?? 'SystemElement'
              return (
                <li
                  key={item.relationshipId}
                  className="flex items-center justify-between py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ItemLink
                      itemType={itemType}
                      itemId={item.id}
                      className="font-mono text-sm text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {item.itemNumber}
                    </ItemLink>
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {item.name}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {getItemTypeLabel(itemType)}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      Rev {item.revision}
                    </span>
                    <StateBadge itemType={itemType} state={item.state} />
                    {item.suspect && config.reasonLabels && (
                      <SuspectBadge
                        reasons={item.suspectReasons ?? []}
                        labels={config.reasonLabels}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {item.suspect && config.affirmTitle && (
                      <AffirmButton
                        relationshipId={item.relationshipId}
                        pendingIds={pendingIds}
                        onAffirm={affirm}
                        title={config.affirmTitle}
                      />
                    )}
                    {canLink && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleUnlink(item.id)}
                        disabled={busy === `unlink:${item.id}`}
                        title="Remove link"
                      >
                        {busy === `unlink:${item.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-red-500" />
                        )}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
