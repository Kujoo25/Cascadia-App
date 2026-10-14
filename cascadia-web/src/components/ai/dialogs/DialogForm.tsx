// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DialogForm — the form behind a `request_user_input` dialog.
 *
 * The assistant describes the fields; this renders them with the standard
 * form primitives, checks the required ones, and turns the answers into the
 * user's next chat message — one field per line, so the model reads them
 * back the way the tool description promised.
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type {
  DialogFormField,
  FormDialogPayload,
} from '@cascadia/commons/ai/dialogs'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { designListQuery, programListQuery } from '@/query'

interface DialogFormProps {
  title: string
  payload: FormDialogPayload
  /** Called with the message to send; the caller closes the dialog. */
  onSubmit: (message: string) => void
  onCancel: () => void
}

type FieldValue = string | boolean

interface Option {
  label: string
  value: string
}

function initialValues(
  fields: Array<DialogFormField>,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const field of fields) {
    if (field.type === 'checkbox') {
      values[field.name] = field.defaultValue === true
    } else if (field.defaultValue !== undefined) {
      values[field.name] = String(field.defaultValue)
    } else {
      values[field.name] = ''
    }
  }
  return values
}

/** The live pick-lists a select may draw from, loaded only when one asks. */
function useOptionSources(fields: Array<DialogFormField>) {
  const wantsDesigns = fields.some((f) => f.optionsFrom === 'designs')
  const wantsPrograms = fields.some((f) => f.optionsFrom === 'programs')

  const designs = useQuery({
    ...designListQuery<{ id: string; name: string; code: string }>(),
    enabled: wantsDesigns,
  })
  const programs = useQuery({
    ...programListQuery(),
    enabled: wantsPrograms,
  })

  return {
    designs: (designs.data ?? []).map((d) => ({
      value: d.id,
      label: `${d.name} (${d.code})`,
    })),
    programs: (programs.data ?? []).map((p) => ({
      value: p.id,
      label: `${p.name} (${p.code})`,
    })),
    loading: designs.isLoading || programs.isLoading,
  }
}

/** The answers as the chat message the assistant reads next. */
function formatSubmission(
  title: string,
  fields: Array<DialogFormField>,
  values: Record<string, FieldValue>,
  optionsOf: (field: DialogFormField) => Array<Option>,
): string {
  const lines: Array<string> = []
  const blank: Array<string> = []

  for (const field of fields) {
    const value = values[field.name]
    if (field.type === 'checkbox') {
      lines.push(`- ${field.label}: ${value === true ? 'Yes' : 'No'}`)
      continue
    }
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) {
      blank.push(field.label)
      continue
    }
    if (field.type === 'select') {
      const option = optionsOf(field).find((o) => o.value === text)
      // A live pick-list submits an id, which the model needs verbatim; a
      // fixed one submits the value the model chose, shown with its label.
      const shown =
        option && option.label !== text
          ? field.optionsFrom
            ? `${option.label} (id: ${text})`
            : `${option.label} (${text})`
          : text
      lines.push(`- ${field.label}: ${shown}`)
      continue
    }
    lines.push(`- ${field.label}: ${text}`)
  }

  const parts = [`Submitted form "${title}":`, ...lines]
  if (blank.length > 0) parts.push(`Left blank: ${blank.join(', ')}`)
  return parts.join('\n')
}

export function DialogForm({
  title,
  payload,
  onSubmit,
  onCancel,
}: DialogFormProps) {
  const [values, setValues] = useState(() => initialValues(payload.fields))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const sources = useOptionSources(payload.fields)

  const optionsOf = (field: DialogFormField): Array<Option> => {
    if (field.optionsFrom === 'designs') return sources.designs
    if (field.optionsFrom === 'programs') return sources.programs
    return (field.options ?? []).filter((o) => o.value !== '')
  }

  const setValue = (name: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const { [name]: _cleared, ...rest } = prev
      return rest
    })
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const missing: Record<string, string> = {}
    for (const field of payload.fields) {
      if (!field.required || field.type === 'checkbox') continue
      const value = values[field.name]
      if (typeof value !== 'string' || value.trim() === '') {
        missing[field.name] = `${field.label} is required`
      }
    }
    if (Object.keys(missing).length > 0) {
      setErrors(missing)
      return
    }
    onSubmit(formatSubmission(title, payload.fields, values, optionsOf))
  }

  const renderControl = (field: DialogFormField) => {
    const value = values[field.name]
    const text = typeof value === 'string' ? value : ''
    const inputId = `dialog-field-${field.name}`

    switch (field.type) {
      case 'textarea':
        return (
          <Textarea
            id={inputId}
            value={text}
            onChange={(e) => setValue(field.name, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
          />
        )
      case 'select': {
        const options = optionsOf(field)
        return (
          <Select
            value={text || undefined}
            onValueChange={(next) => setValue(field.name, next)}
          >
            <SelectTrigger id={inputId} error={Boolean(errors[field.name])}>
              <SelectValue
                placeholder={
                  sources.loading && field.optionsFrom
                    ? 'Loading…'
                    : (field.placeholder ?? 'Select…')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      case 'checkbox':
        return (
          <div className="flex items-center gap-2">
            <Checkbox
              id={inputId}
              checked={value === true}
              onCheckedChange={(checked) =>
                setValue(field.name, checked === true)
              }
            />
            {field.placeholder && (
              <span className="text-sm text-slate-600 dark:text-slate-400">
                {field.placeholder}
              </span>
            )}
          </div>
        )
      case 'number':
      case 'date':
        return (
          <Input
            id={inputId}
            type={field.type}
            value={text}
            onChange={(e) => setValue(field.name, e.target.value)}
            placeholder={field.placeholder}
          />
        )
      default:
        return (
          <Input
            id={inputId}
            value={text}
            onChange={(e) => setValue(field.name, e.target.value)}
            placeholder={field.placeholder}
          />
        )
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {payload.description && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {payload.description}
        </p>
      )}

      {payload.fields.map((field) => (
        <FormField
          key={field.name}
          label={field.label}
          required={field.required}
          helpText={field.helpText}
          error={errors[field.name]}
        >
          {renderControl(field)}
        </FormField>
      ))}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{payload.submitLabel ?? 'Submit'}</Button>
      </div>
    </form>
  )
}
