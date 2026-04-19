import { z } from 'zod';

// ============================================================
// Shared constraints
// ============================================================

const MAX_STRING = 50_000;
const MAX_SHORT_STRING = 500;
const MAX_METADATA_KEYS = 50;
const MAX_BATCH_SIZE = 100;

/** Metadata object with bounded size to prevent DoS via huge payloads. */
const metadataSchema = z.record(z.unknown()).refine(
  (obj) => Object.keys(obj).length <= MAX_METADATA_KEYS,
  { message: `Metadata must have at most ${MAX_METADATA_KEYS} keys` }
).optional();

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
