// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Power, Trash2 } from 'lucide-react'
import type {
  ConfigurePartVariantInput,
  CreateExecutionBomLineInput,
  CreateVariantExecutionInput,
} from '@/lib/product-variants/types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  itemTextSearchQuery,
  partVariantConfigurationQuery,
  resolvedVariantBomQuery,
  useResourceMutation,
} from '@/lib/query'

interface PartSuggestion {
  id: string
  masterId: string
  itemNumber: string
  name: string
  revision: string
}

interface PartVariantPanelProps {
  partId: string
  designId?: string | null
  readOnly: boolean
}

const emptyConfiguration: ConfigurePartVariantInput = {
  familyCode: '',
  familyName: '',
  familyDescription: '',
  variantCode: '',
}

const emptyExecution: CreateVariantExecutionInput = {
  code: '',
  name: '',
  sku: '',
  isActive: true,
  attributes: {},
}

export function PartVariantPanel({
  partId,
  designId,
  readOnly,
}: PartVariantPanelProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [configurationForm, setConfigurationForm] =
    useState<ConfigurePartVariantInput>(emptyConfiguration)
  const [executionForm, setExecutionForm] =
    useState<CreateVariantExecutionInput>(emptyExecution)
  const [editingBomFor, setEditingBomFor] = useState<string | null>(null)
  const [resolvedFor, setResolvedFor] = useState<string | null>(null)
  const [partSearch, setPartSearch] = useState('')
  const [selectedTarget, setSelectedTarget] = useState<PartSuggestion | null>(
    null,
  )
  const [quantity, setQuantity] = useState('1')

  const configurationQuery = useQuery(partVariantConfigurationQuery(partId))
  const resolvedBomQuery = useQuery(
    resolvedVariantBomQuery(partId, resolvedFor),
  )
  const debouncedSearch = useDebouncedValue(partSearch.trim(), 250)
  const canSearch = Boolean(editingBomFor && debouncedSearch.length >= 2)
  const currentDesignSearch = useQuery(
    itemTextSearchQuery<PartSuggestion>(
      {
        q: debouncedSearch,
        types: ['Part'],
        limit: 10,
        designScope: 'current',
        contextDesignId: designId ?? undefined,
      },
      canSearch && Boolean(designId) && !selectedTarget,
    ),
  )
  const librarySearch = useQuery(
    itemTextSearchQuery<PartSuggestion>(
      {
        q: debouncedSearch,
        types: ['Part'],
        limit: 10,
        designScope: 'library',
        contextDesignId: designId ?? undefined,
      },
      canSearch && !selectedTarget,
    ),
  )
  const suggestions = [
    ...(currentDesignSearch.data ?? []),
    ...(librarySearch.data ?? []),
  ].filter(
    (candidate, index, rows) =>
      candidate.id !== partId &&
      candidate.masterId !== configurationQuery.data?.variant.partMasterId &&
      rows.findIndex((row) => row.id === candidate.id) === index,
  )

  const configure = useResourceMutation({
    invalidates: ['parts'],
    mutationFn: (body: ConfigurePartVariantInput) =>
      apiFetch(`/api/v1/parts/${partId}/variant-configuration`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => showSuccess('Product Variant configured'),
    onError: (error) => handleError(error),
  })

  const addExecution = useResourceMutation({
    invalidates: ['parts'],
    mutationFn: (body: CreateVariantExecutionInput) =>
      apiFetch(`/api/v1/parts/${partId}/variant-executions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setExecutionForm(emptyExecution)
      showSuccess('Execution added')
    },
    onError: (error) => handleError(error),
  })

  const setExecutionActive = useResourceMutation({
    invalidates: ['parts', 'relationships'],
    mutationFn: ({
      executionId,
      isActive,
    }: {
      executionId: string
      isActive: boolean
    }) =>
      apiFetch(`/api/v1/parts/${partId}/variant-executions/${executionId}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: (_data, variables) =>
      showSuccess(
        variables.isActive ? 'Execution reactivated' : 'Execution deactivated',
      ),
    onError: (error) => handleError(error),
  })

  const addBomLine = useResourceMutation({
    invalidates: ['parts', 'relationships'],
    mutationFn: ({
      executionId,
      body,
    }: {
      executionId: string
      body: CreateExecutionBomLineInput
    }) =>
      apiFetch(
        `/api/v1/parts/${partId}/variant-executions/${executionId}/bom`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      setPartSearch('')
      setSelectedTarget(null)
      setQuantity('1')
      setEditingBomFor(null)
      showSuccess('MK BOM item added')
    },
    onError: (error) => handleError(error),
  })

  const removeBomLine = useResourceMutation({
    invalidates: ['parts', 'relationships'],
    mutationFn: ({
      executionId,
      lineId,
    }: {
      executionId: string
      lineId: string
    }) =>
      apiFetch(
        `/api/v1/parts/${partId}/variant-executions/${executionId}/bom/${lineId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => showSuccess('MK BOM item removed'),
    onError: (error) => handleError(error),
  })

  if (configurationQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin" />
        </CardContent>
      </Card>
    )
  }

  if (configurationQuery.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Could not load product Variant</CardTitle>
          <CardDescription>{configurationQuery.error.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => configurationQuery.refetch()}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  const configuration = configurationQuery.data
  if (!configuration) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configure product Variant</CardTitle>
          <CardDescription>
            Connect this revisioned Part to a stable product Family and Variant
            code. This identity cannot be changed later.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <VariantInput
            label="Family code"
            value={configurationForm.familyCode}
            placeholder="P3001"
            disabled={readOnly}
            onChange={(familyCode) =>
              setConfigurationForm((value) => ({ ...value, familyCode }))
            }
          />
          <VariantInput
            label="Family name"
            value={configurationForm.familyName}
            placeholder="Hotel room controller"
            disabled={readOnly}
            onChange={(familyName) =>
              setConfigurationForm((value) => ({ ...value, familyName }))
            }
          />
          <VariantInput
            label="Variant code"
            value={configurationForm.variantCode}
            placeholder="V1"
            disabled={readOnly}
            onChange={(variantCode) =>
              setConfigurationForm((value) => ({ ...value, variantCode }))
            }
          />
          <VariantInput
            label="Family description"
            value={configurationForm.familyDescription ?? ''}
            disabled={readOnly}
            onChange={(familyDescription) =>
              setConfigurationForm((value) => ({
                ...value,
                familyDescription,
              }))
            }
          />
          <div className="md:col-span-2">
            <Button
              disabled={
                readOnly ||
                configure.isPending ||
                !configurationForm.familyCode ||
                !configurationForm.familyName ||
                !configurationForm.variantCode
              }
              onClick={() => configure.mutate(configurationForm)}
            >
              {configure.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Configure Variant
            </Button>
            {readOnly && (
              <p className="mt-2 text-sm text-muted-foreground">
                Enter Edit mode to configure product variants.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{configuration.family.name}</CardTitle>
              <CardDescription>
                {configuration.family.code} · Variant{' '}
                {configuration.variant.code}
              </CardDescription>
            </div>
            <Badge variant="outline" className="font-mono text-base">
              {configuration.variant.baseDesignation}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add execution</CardTitle>
            <CardDescription>
              MK has no independent revision; it always inherits the Variant
              Part revision shown above.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-4">
            <VariantInput
              label="MK code"
              value={executionForm.code}
              placeholder="MK1"
              onChange={(code) =>
                setExecutionForm((value) => ({ ...value, code }))
              }
            />
            <VariantInput
              label="Name"
              value={executionForm.name ?? ''}
              placeholder="White, 8 buttons"
              onChange={(name) =>
                setExecutionForm((value) => ({ ...value, name }))
              }
            />
            <VariantInput
              label="SKU (optional)"
              value={executionForm.sku ?? ''}
              onChange={(sku) =>
                setExecutionForm((value) => ({ ...value, sku }))
              }
            />
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!executionForm.code || addExecution.isPending}
                onClick={() => addExecution.mutate(executionForm)}
              >
                <Plus className="mr-2 h-4 w-4" /> Add MK
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {configuration.executions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No executions configured yet.
          </CardContent>
        </Card>
      ) : (
        configuration.executions.map((execution) => (
          <Card key={execution.id}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="font-mono">{execution.designation}</span>
                    <Badge
                      variant={execution.isActive ? 'default' : 'secondary'}
                    >
                      {execution.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {[execution.name, execution.sku]
                      .filter(Boolean)
                      .join(' · ') || execution.code}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {execution.isActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setResolvedFor((value) =>
                          value === execution.id ? null : execution.id,
                        )
                      }
                    >
                      Resolved BOM
                    </Button>
                  )}
                  {!readOnly && execution.isActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingBomFor(execution.id)}
                    >
                      <Plus className="mr-2 h-4 w-4" /> MK BOM item
                    </Button>
                  )}
                  {!readOnly && execution.isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={setExecutionActive.isPending}
                      onClick={() =>
                        setExecutionActive.mutate({
                          executionId: execution.id,
                          isActive: false,
                        })
                      }
                    >
                      <Power className="mr-2 h-4 w-4" /> Deactivate
                    </Button>
                  )}
                  {!readOnly && !execution.isActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={setExecutionActive.isPending}
                      onClick={() =>
                        setExecutionActive.mutate({
                          executionId: execution.id,
                          isActive: true,
                        })
                      }
                    >
                      <Power className="mr-2 h-4 w-4" /> Reactivate
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {execution.bomLines.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium">
                    MK-specific additions
                  </p>
                  <div className="divide-y rounded-md border">
                    {execution.bomLines.map((line) => (
                      <div
                        key={line.id}
                        className="flex items-center justify-between gap-3 p-3 text-sm"
                      >
                        <span>
                          <span className="font-mono">
                            {line.targetItem.itemNumber}
                          </span>{' '}
                          {line.targetItem.name} · Qty {line.quantity}
                        </span>
                        {!readOnly && execution.isActive && (
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={removeBomLine.isPending}
                            aria-label="Remove MK BOM item"
                            onClick={() =>
                              removeBomLine.mutate({
                                executionId: execution.id,
                                lineId: line.id,
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editingBomFor === execution.id && (
                <div className="space-y-3 rounded-md border p-4">
                  <VariantInput
                    label="Find a Part in this Design or the Library"
                    value={
                      selectedTarget
                        ? `${selectedTarget.itemNumber} — ${selectedTarget.name}`
                        : partSearch
                    }
                    placeholder="Type at least 2 characters"
                    disabled={Boolean(selectedTarget)}
                    onChange={setPartSearch}
                  />
                  {!selectedTarget && suggestions.length > 0 && (
                    <div className="max-h-48 divide-y overflow-y-auto rounded-md border">
                      {suggestions.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          className="block w-full p-2 text-left text-sm hover:bg-muted"
                          onClick={() => setSelectedTarget(candidate)}
                        >
                          <span className="font-mono">
                            {candidate.itemNumber}
                          </span>{' '}
                          — {candidate.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="w-32">
                      <VariantInput
                        label="Quantity"
                        value={quantity}
                        type="number"
                        min="0.001"
                        step="0.001"
                        onChange={setQuantity}
                      />
                    </div>
                    <Button
                      disabled={
                        !selectedTarget ||
                        addBomLine.isPending ||
                        !Number.isFinite(Number(quantity)) ||
                        Number(quantity) <= 0
                      }
                      onClick={() => {
                        if (!selectedTarget) return
                        addBomLine.mutate({
                          executionId: execution.id,
                          body: {
                            targetItemId: selectedTarget.id,
                            quantity,
                          },
                        })
                      }}
                    >
                      Add item
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditingBomFor(null)
                        setSelectedTarget(null)
                        setPartSearch('')
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {resolvedFor === execution.id && (
                <div className="rounded-md border p-4">
                  <p className="mb-2 text-sm font-medium">
                    Resolved BOM (common Variant BOM + {execution.code})
                  </p>
                  {resolvedBomQuery.isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : resolvedBomQuery.isError ? (
                    <div className="space-y-2 text-sm text-destructive">
                      <p>{resolvedBomQuery.error.message}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resolvedBomQuery.refetch()}
                      >
                        Try again
                      </Button>
                    </div>
                  ) : resolvedBomQuery.data?.length ? (
                    <div className="divide-y">
                      {resolvedBomQuery.data.map((line) => (
                        <div
                          key={`${line.scope}-${line.id}`}
                          className="flex justify-between gap-3 py-2 text-sm"
                        >
                          <span>
                            <span className="font-mono">
                              {line.targetItem.itemNumber}
                            </span>{' '}
                            — {line.targetItem.name}
                          </span>
                          <span className="text-muted-foreground">
                            Qty {line.quantity} ·{' '}
                            {line.scope === 'variant'
                              ? 'Common'
                              : execution.code}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      The resolved BOM is empty.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function VariantInput({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  type = 'text',
  min,
  step,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'number'
  min?: string
  step?: string
}) {
  const inputId = useId()
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        type={type}
        min={min}
        step={step}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
