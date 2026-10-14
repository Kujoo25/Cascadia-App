// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The suspect-link rules, in isolation. Which rows a claim was affirmed
 * against decides whether it is suspect; these pin that arithmetic, and what
 * a merge does to an affirmation as it re-homes the edge. The database-backed
 * half — carried copies on checkout, the merge itself — is in
 * `services/RequirementService.suspect.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  affirmationOf,
  carryAffirmation,
  stampInitialAffirmation,
  suspectStateOf,
  withAffirmation,
} from './trace-affirmation'

const A = 'a0000000-0000-4000-8000-000000000001' // released source row
const W = 'a0000000-0000-4000-8000-000000000002' // its working copy
const R = 'a0000000-0000-4000-8000-000000000003' // the row the release mints
const T1 = 'b0000000-0000-4000-8000-000000000001' // target, first revision
const T2 = 'b0000000-0000-4000-8000-000000000002' // target, next revision

const affirmedAt = {
  affirmedBy: 'user',
  affirmedAt: '2026-10-09T00:00:00.000Z',
}

describe('suspectStateOf', () => {
  it('a claim affirmed against the rows it names, both current, is not suspect', () => {
    const edge = {
      sourceId: A,
      targetId: T1,
      relationshipType: 'SATISFIES',
      metadata: withAffirmation(null, {
        sourceId: A,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(edge, T1)).toMatchObject({
      suspect: false,
      reasons: [],
    })
  })

  it('is suspect once the target it was affirmed against is superseded', () => {
    const edge = {
      sourceId: A,
      targetId: T1,
      relationshipType: 'SATISFIES',
      metadata: withAffirmation(null, {
        sourceId: A,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(edge, T2)).toMatchObject({
      suspect: true,
      reasons: ['target_revised'],
    })
  })

  it('a carried copy is suspect on the source side until affirmed on its own row', () => {
    // What copyRelationshipsToItem produces: the working copy's edge, with
    // the released row's affirmation still on it.
    const carried = {
      sourceId: W,
      targetId: T1,
      relationshipType: 'VERIFIED_BY',
      metadata: withAffirmation(null, {
        sourceId: A,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(carried, T1)).toMatchObject({
      suspect: true,
      reasons: ['source_revised'],
    })

    const affirmedHere = {
      ...carried,
      metadata: withAffirmation(carried.metadata, {
        sourceId: W,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(affirmedHere, T1).suspect).toBe(false)
  })

  it('reports both ends when both have moved on', () => {
    const edge = {
      sourceId: W,
      targetId: T1,
      relationshipType: 'ALLOCATED_TO',
      metadata: withAffirmation(null, {
        sourceId: A,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(edge, T2).reasons).toEqual([
      'source_revised',
      'target_revised',
    ])
  })

  it('reads an edge without an affirmation as affirmed against its own pin', () => {
    // Existing data predates affirmations: the stored source row IS the row
    // the claim hangs off, so only a superseded target can make it suspect.
    const legacy = {
      sourceId: A,
      targetId: T1,
      relationshipType: 'SATISFIES',
      metadata: null,
    }
    expect(suspectStateOf(legacy, T1).suspect).toBe(false)
    expect(suspectStateOf(legacy, T2)).toMatchObject({
      suspect: true,
      reasons: ['target_revised'],
    })
    expect(suspectStateOf(legacy, T2).affirmation).toBeNull()
  })

  it('never suspects an edge type that is not a trace claim', () => {
    const bom = {
      sourceId: W,
      targetId: T1,
      relationshipType: 'BOM',
      metadata: withAffirmation(null, {
        sourceId: A,
        targetId: T1,
        ...affirmedAt,
      }),
    }
    expect(suspectStateOf(bom, T2).suspect).toBe(false)
  })
})

describe('stampInitialAffirmation', () => {
  it('affirms a new trace claim against the rows it names, keeping other metadata', () => {
    const metadata = stampInitialAffirmation(
      { note: 'kept' },
      { sourceId: A, targetId: T1, relationshipType: 'SATISFIES' },
      'author',
      new Date('2026-10-09T12:00:00.000Z'),
    )
    expect(metadata).toMatchObject({ note: 'kept' })
    expect(affirmationOf(metadata)).toEqual({
      sourceId: A,
      targetId: T1,
      affirmedBy: 'author',
      affirmedAt: '2026-10-09T12:00:00.000Z',
    })
  })

  it('leaves a non-trace edge’s metadata exactly as supplied', () => {
    const supplied = { role: 'consumer' }
    expect(
      stampInitialAffirmation(
        supplied,
        { sourceId: A, targetId: T1, relationshipType: 'BOM' },
        'author',
      ),
    ).toBe(supplied)
    expect(
      stampInitialAffirmation(
        null,
        { sourceId: A, targetId: T1, relationshipType: 'Document' },
        'author',
      ),
    ).toBeNull()
  })
})

describe('affirmationOf', () => {
  it('ignores a malformed affirmation rather than trusting it', () => {
    expect(affirmationOf({ affirmed: { sourceId: A } })).toBeNull()
    expect(affirmationOf({ affirmed: 'yes' })).toBeNull()
    expect(affirmationOf([])).toBeNull()
    expect(affirmationOf(undefined)).toBeNull()
  })
})

describe('carryAffirmation', () => {
  const resolveTarget = (id: string) => (id === T1 ? T2 : id)

  it('follows an affirmation made on the working copy onto the released row', () => {
    const metadata = withAffirmation(null, {
      sourceId: W,
      targetId: T1,
      ...affirmedAt,
    })
    const carried = carryAffirmation(metadata, {
      fromSourceId: W,
      toSourceId: R,
      resolveTarget: (id) => id,
    })
    expect(affirmationOf(carried)).toMatchObject({ sourceId: R, targetId: T1 })
  })

  it('leaves an affirmation that never named the working copy stale', () => {
    // Carried from the released row at checkout and never re-affirmed on the
    // branch: the release must not launder it into an affirmation of R.
    const metadata = withAffirmation(null, {
      sourceId: A,
      targetId: T1,
      ...affirmedAt,
    })
    const carried = carryAffirmation(metadata, {
      fromSourceId: W,
      toSourceId: R,
      resolveTarget: (id) => id,
    })
    expect(carried).toBe(metadata)
    expect(affirmationOf(carried)).toMatchObject({ sourceId: A })
  })

  it('re-points the affirmed target by the same rule as the edge target', () => {
    const metadata = withAffirmation(null, {
      sourceId: W,
      targetId: T1,
      ...affirmedAt,
    })
    const carried = carryAffirmation(metadata, {
      fromSourceId: W,
      toSourceId: R,
      resolveTarget,
    })
    expect(affirmationOf(carried)).toMatchObject({ sourceId: R, targetId: T2 })
  })

  it('passes metadata without an affirmation through untouched', () => {
    const plain = { note: 'kept' }
    expect(
      carryAffirmation(plain, {
        fromSourceId: W,
        toSourceId: R,
        resolveTarget,
      }),
    ).toBe(plain)
    expect(
      carryAffirmation(null, { fromSourceId: W, toSourceId: R, resolveTarget }),
    ).toBeNull()
  })
})
