// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Why a trace claim reads as suspect: the end that revised since the claim
 * was last affirmed. Declared here so the server's affirmation arithmetic,
 * the wire types and the web's badges name one type.
 */
export type SuspectReason = 'source_revised' | 'target_revised'
