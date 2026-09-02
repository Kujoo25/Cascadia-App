// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { RevisionScheme } from '@/lib/types/lifecycle'
import { NO_REVISION_MARKER } from '@/lib/types/lifecycle'
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface RevisionSchemeSelectorProps {
  value?: RevisionScheme
  onChange: (scheme: RevisionScheme) => void
  label?: string
}

type SchemeType = 'alpha' | 'numeric' | 'prefixed-numeric' | 'none'

function getSchemeType(scheme?: RevisionScheme): SchemeType {
  if (!scheme) return 'alpha'
  return scheme.type
}

function getPrefix(scheme?: RevisionScheme): string {
  if (scheme?.type === 'prefixed-numeric') return scheme.prefix
  return 'X'
}

function getStartAt(scheme?: RevisionScheme): number {
  if (scheme?.type === 'numeric' || scheme?.type === 'prefixed-numeric') {
    return scheme.startAt ?? 1
  }
  return 1
}

/** Preview of example revision sequence (pure client-side, no server imports) */
function getPreview(type: SchemeType, prefix: string, startAt: number): string {
  switch (type) {
    case 'alpha':
      return 'A, B, C, D, ...'
    case 'numeric':
      return `${startAt}, ${startAt + 1}, ${startAt + 2}, ${startAt + 3}, ...`
    case 'prefixed-numeric':
      return `${prefix}${startAt}, ${prefix}${startAt + 1}, ${prefix}${startAt + 2}, ...`
    case 'none':
      // Not "(no revision)": a released item does carry a revision under this
      // scheme — the fixed marker — it just never advances.
      return `${NO_REVISION_MARKER} -> ${NO_REVISION_MARKER} (never advances)`
  }
}

export function RevisionSchemeSelector({
  value,
  onChange,
  label = 'Revision Scheme',
}: RevisionSchemeSelectorProps) {
  const schemeType = getSchemeType(value)
  const prefix = getPrefix(value)
  const startAt = getStartAt(value)

  const handleTypeChange = (type: SchemeType) => {
    switch (type) {
      case 'alpha':
        onChange({ type: 'alpha' })
        break
      case 'numeric':
        onChange({ type: 'numeric', startAt })
        break
      case 'prefixed-numeric':
        onChange({ type: 'prefixed-numeric', prefix, startAt })
        break
      case 'none':
        onChange({ type: 'none' })
        break
    }
  }

  const handlePrefixChange = (newPrefix: string) => {
    onChange({
      type: 'prefixed-numeric',
      prefix: newPrefix || 'X',
      startAt,
    })
  }

  const handleStartAtChange = (rawValue: string) => {
    if (!/^\d+$/.test(rawValue)) return
    const nextStartAt = Number(rawValue)
    if (!Number.isInteger(nextStartAt) || nextStartAt < 0) return

    if (schemeType === 'numeric') {
      onChange({ type: 'numeric', startAt: nextStartAt })
    } else if (schemeType === 'prefixed-numeric') {
      onChange({
        type: 'prefixed-numeric',
        prefix,
        startAt: nextStartAt,
      })
    }
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <Select
        value={schemeType}
        onValueChange={(v) => handleTypeChange(v as SchemeType)}
      >
        <SelectTrigger className="h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="alpha">Alpha (A, B, C)</SelectItem>
          <SelectItem value="numeric">Numeric (1, 2, 3)</SelectItem>
          <SelectItem value="prefixed-numeric">Prefixed-Numeric</SelectItem>
          <SelectItem value="none">None</SelectItem>
        </SelectContent>
      </Select>

      {schemeType === 'prefixed-numeric' && (
        <div className="space-y-1.5">
          <Label htmlFor="revPrefix" className="text-xs">
            Prefix
          </Label>
          <Input
            id="revPrefix"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            className="h-8 text-sm"
            placeholder="e.g., X, P, REV"
          />
        </div>
      )}

      {(schemeType === 'numeric' || schemeType === 'prefixed-numeric') && (
        <div className="space-y-1.5">
          <Label htmlFor="revStartAt" className="text-xs">
            Start at
          </Label>
          <Input
            id="revStartAt"
            type="number"
            min={0}
            step={1}
            value={startAt}
            onChange={(e) => handleStartAtChange(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      )}

      <div className="text-xs text-slate-500 dark:text-slate-400">
        Preview: {getPreview(schemeType, prefix, startAt)}
      </div>
    </div>
  )
}
