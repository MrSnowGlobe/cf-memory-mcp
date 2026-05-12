import { z } from 'zod';

// ============================================================
// Shared constraints
// ============================================================

const MAX_STRING = 50_000;
const MAX_SHORT_STRING = 500;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_BYTES = 16_384;
const MAX_BATCH_SIZE = 100;

/**
 * Walk a JSON-shaped value and return its maximum nesting depth. Bails out
 * as soon as `max` is exceeded so a pathological input doesn't burn CPU
 * before the refinement rejects it.
 */
function jsonDepth(value: unknown, max: number, current = 0): number {
  if (current > max) return current;
  if (value === null || typeof value !== 'object') return current;
  let deepest = current;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const d = jsonDepth(v, max, current + 1);
    if (d > deepest) deepest = d;
    if (deepest > max) return deepest;
  }
  return deepest;
}

/**
 * Metadata object with bounded keys, depth, and serialised size. Each
 * constraint catches a different DoS shape: too-many-keys (CPU on iteration),
 * too-deep (JSON.stringify recursion), too-large (D1 row bloat + log spam).
 */
const metadataSchema = z
  .record(z.unknown())
  .refine((obj) => Object.keys(obj).length <= MAX_METADATA_KEYS, {
    message: `Metadata must have at most ${MAX_METADATA_KEYS} keys`,
  })
  .refine((obj) => jsonDepth(obj, MAX_METADATA_DEPTH) <= MAX_METADATA_DEPTH, {
    message: `Metadata must nest at most ${MAX_METADATA_DEPTH} levels deep`,
  })
  .refine(
    (obj) => {
      try {
        return JSON.stringify(obj).length <= MAX_METADATA_BYTES;
      } catch {
        return false;
      }
    },
    { message: `Metadata must serialise to at most ${MAX_METADATA_BYTES} chars` }
  )
  .optional();

// ============================================================
// Shared query-string schemas
// ============================================================

/**
 * Standard pagination params for list endpoints. Backed by z.coerce so
 * "12" parses as 12 but "Infinity" / "NaN" / "-1" / "abc" are rejected by
 * `.int()` / `.min()` rather than slipping through as Number() coercions
 * to downstream clamp helpers.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** Snapshot endpoint accepts six independent caps. */
export const SnapshotQuerySchema = z.object({
  entity_limit: z.coerce.number().int().min(1).max(5000).optional(),
  relation_limit: z.coerce.number().int().min(1).max(5000).optional(),
  message_limit: z.coerce.number().int().min(1).max(5000).optional(),
  trace_limit: z.coerce.number().int().min(1).max(5000).optional(),
  preference_limit: z.coerce.number().int().min(1).max(5000).optional(),
  fact_limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export type SnapshotQuery = z.infer<typeof SnapshotQuerySchema>;

/** Trace list endpoint accepts pagination + filters. */
export const TraceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  session_id: z.string().min(1).max(MAX_SHORT_STRING).optional(),
  success: z.enum(['true', 'false']).optional(),
});
export type TraceListQuery = z.infer<typeof TraceListQuerySchema>;

// ============================================================
// Short-Term Memory
// ============================================================

export const CreateSessionSchema = z.object({
  id: z.string().min(1).max(MAX_SHORT_STRING),
  metadata: metadataSchema,
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const AddMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(MAX_STRING),
  metadata: metadataSchema,
});
export type AddMessageInput = z.infer<typeof AddMessageSchema>;

export const BatchMessagesSchema = z.object({
  messages: z.array(AddMessageSchema).min(1).max(MAX_BATCH_SIZE),
});
export type BatchMessagesInput = z.infer<typeof BatchMessagesSchema>;

export const SearchQuerySchema = z.object({
  query: z.string().min(1).max(MAX_STRING),
  limit: z.number().int().min(1).max(100).optional(),
  session_id: z.string().max(MAX_SHORT_STRING).optional(),
});
export type SearchQueryInput = z.infer<typeof SearchQuerySchema>;

// ============================================================
// Long-Term Memory — Entities
// ============================================================

export const AddEntitySchema = z.object({
  name: z.string().min(1).max(MAX_SHORT_STRING),
  entity_type: z.enum([
    'PERSON',
    'OBJECT',
    'LOCATION',
    'EVENT',
    'ORGANIZATION',
    'CUSTOM',
  ]),
  subtype: z.string().max(MAX_SHORT_STRING).optional(),
  description: z.string().max(MAX_STRING).optional(),
  metadata: metadataSchema,
});
export type AddEntityInput = z.infer<typeof AddEntitySchema>;

export const UpdateEntitySchema = z.object({
  name: z.string().min(1).max(MAX_SHORT_STRING).optional(),
  entity_type: z
    .enum([
      'PERSON',
      'OBJECT',
      'LOCATION',
      'EVENT',
      'ORGANIZATION',
      'CUSTOM',
    ])
    .optional(),
  subtype: z.string().max(MAX_SHORT_STRING).nullable().optional(),
  description: z.string().max(MAX_STRING).nullable().optional(),
  metadata: metadataSchema,
});
export type UpdateEntityInput = z.infer<typeof UpdateEntitySchema>;

export const AddRelationSchema = z.object({
  target_entity_id: z.string().min(1).max(MAX_SHORT_STRING),
  relation_type: z.string().min(1).max(MAX_SHORT_STRING),
  relation_strength: z.number().min(0).max(1).optional(),
  metadata: metadataSchema,
});
export type AddRelationInput = z.infer<typeof AddRelationSchema>;

export const TraverseRelationsSchema = z.object({
  max_depth: z.number().int().min(1).max(4).optional(),
  relation_types: z.array(z.string().min(1).max(MAX_SHORT_STRING)).max(20).optional(),
  direction: z.enum(['out', 'in', 'both']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type TraverseRelationsInput = z.infer<typeof TraverseRelationsSchema>;

// ============================================================
// Long-Term Memory — Preferences
// ============================================================

export const AddPreferenceSchema = z.object({
  category: z.string().min(1).max(MAX_SHORT_STRING),
  preference: z.string().min(1).max(MAX_STRING),
  context: z.string().max(MAX_STRING).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: metadataSchema,
});
export type AddPreferenceInput = z.infer<typeof AddPreferenceSchema>;

// ============================================================
// Long-Term Memory — Facts
// ============================================================

export const AddFactSchema = z.object({
  subject: z.string().min(1).max(MAX_SHORT_STRING),
  predicate: z.string().min(1).max(MAX_SHORT_STRING),
  object: z.string().min(1).max(MAX_STRING),
  valid_from: z.string().max(MAX_SHORT_STRING).optional(),
  valid_until: z.string().max(MAX_SHORT_STRING).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().max(MAX_SHORT_STRING).optional(),
  metadata: metadataSchema,
});
export type AddFactInput = z.infer<typeof AddFactSchema>;

export const InvalidateFactSchema = z.object({
  valid_until: z.string().max(MAX_SHORT_STRING).optional(),
});
export type InvalidateFactInput = z.infer<typeof InvalidateFactSchema>;

export const UpdatePreferenceSchema = z.object({
  category: z.string().min(1).max(MAX_SHORT_STRING).optional(),
  preference: z.string().min(1).max(MAX_STRING).optional(),
  context: z.string().max(MAX_STRING).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: metadataSchema,
});
export type UpdatePreferenceInput = z.infer<typeof UpdatePreferenceSchema>;

export const UpdateFactSchema = z.object({
  subject: z.string().min(1).max(MAX_SHORT_STRING).optional(),
  predicate: z.string().min(1).max(MAX_SHORT_STRING).optional(),
  object: z.string().min(1).max(MAX_STRING).optional(),
  valid_from: z.string().max(MAX_SHORT_STRING).nullable().optional(),
  valid_until: z.string().max(MAX_SHORT_STRING).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().max(MAX_SHORT_STRING).nullable().optional(),
  metadata: metadataSchema,
});
export type UpdateFactInput = z.infer<typeof UpdateFactSchema>;

// ============================================================
// Procedural Memory
// ============================================================

export const StartTraceSchema = z.object({
  task: z.string().min(1).max(MAX_STRING),
  session_id: z.string().max(MAX_SHORT_STRING).optional(),
  triggered_by_message_id: z.string().max(MAX_SHORT_STRING).optional(),
  metadata: metadataSchema,
});
export type StartTraceInput = z.infer<typeof StartTraceSchema>;

export const CompleteTraceSchema = z.object({
  outcome: z.string().min(1).max(MAX_STRING),
  success: z.boolean(),
});
export type CompleteTraceInput = z.infer<typeof CompleteTraceSchema>;

export const AddStepSchema = z.object({
  thought: z.string().max(MAX_STRING).optional(),
  action: z.string().max(MAX_STRING).optional(),
  observation: z.string().max(MAX_STRING).optional(),
});
export type AddStepInput = z.infer<typeof AddStepSchema>;

export const RecordToolCallSchema = z.object({
  tool_name: z.string().min(1).max(MAX_SHORT_STRING),
  arguments: metadataSchema,
  result: z.unknown().optional(),
  status: z.enum(['success', 'failure', 'timeout']),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
  message_id: z.string().max(MAX_SHORT_STRING).optional(),
});
export type RecordToolCallInput = z.infer<typeof RecordToolCallSchema>;

// ============================================================
// Promotion & Context
// ============================================================

export const PromoteRequestSchema = z.object({
  type: z.enum(['entity', 'preference', 'fact']),
  id: z.string().min(1).max(MAX_SHORT_STRING),
  reason: z.string().min(1).max(MAX_STRING),
  target: z.enum(['user', 'global']).optional(),
});
export type PromoteRequestInput = z.infer<typeof PromoteRequestSchema>;

export const ContextRequestSchema = z.object({
  query: z.string().min(1).max(MAX_STRING),
  session_id: z.string().max(MAX_SHORT_STRING).optional(),
  include: z
    .array(z.enum(['short_term', 'long_term', 'procedural']))
    .optional(),
  limits: z
    .object({
      messages: z.number().int().min(1).max(100).optional(),
      entities: z.number().int().min(1).max(100).optional(),
      preferences: z.number().int().min(1).max(100).optional(),
      facts: z.number().int().min(1).max(100).optional(),
      traces: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
});
export type ContextRequestInput = z.infer<typeof ContextRequestSchema>;

// ============================================================
// Users
// ============================================================

export const CreateUserSchema = z.object({
  id: z.string().min(1).max(MAX_SHORT_STRING),
  display_name: z.string().max(MAX_SHORT_STRING).optional(),
  metadata: metadataSchema,
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

// ============================================================
// Projects
// ============================================================

export const CreateProjectSchema = z.object({
  id: z.string().min(1).max(MAX_SHORT_STRING).regex(/^[a-zA-Z0-9_-]+$/, 'Project ID must be alphanumeric with hyphens/underscores only'),
  display_name: z.string().max(MAX_SHORT_STRING).optional(),
  metadata: metadataSchema,
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z
  .object({
    display_name: z.string().max(MAX_SHORT_STRING).optional(),
    archived: z.boolean().optional(),
    metadata: metadataSchema,
  })
  .refine(
    (v) =>
      v.display_name !== undefined ||
      v.archived !== undefined ||
      v.metadata !== undefined,
    { message: 'Provide at least one field to update' }
  );
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

// ============================================================
// Pagination & Filters
// ============================================================

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
export type PaginationInput = z.infer<typeof PaginationSchema>;

export const TraceFilterSchema = PaginationSchema.extend({
  session_id: z.string().max(MAX_SHORT_STRING).optional(),
  success: z.boolean().optional(),
});
export type TraceFilterInput = z.infer<typeof TraceFilterSchema>;
