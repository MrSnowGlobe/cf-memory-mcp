// Cloudflare bindings
export interface Bindings {
  DB: D1Database;
  VEC_MESSAGES: VectorizeIndex;
  VEC_ENTITIES: VectorizeIndex;
  VEC_PREFERENCES: VectorizeIndex;
  VEC_FACTS: VectorizeIndex;
  VEC_TRACES: VectorizeIndex;
  CACHE: KVNamespace;
  AI: Ai;
  AUTH_TOKEN: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
}

export type Variables = {
  projectId: string;
  userId: string;
};

// Hono app type — used for all route definitions
export type AppType = { Bindings: Bindings; Variables: Variables };

// D1 Row types (one per table)
export interface ProjectRow {
  id: string;
  display_name: string | null;
  created_at: string;
  metadata: string; // JSON string
}

export interface UserRow {
  id: string;
  display_name: string | null;
  created_at: string;
  metadata: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  metadata: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: string;
  created_at: string;
  sequence_num: number;
  vector_id: string | null;
}

export interface EntityRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  entity_type: 'PERSON' | 'OBJECT' | 'LOCATION' | 'EVENT' | 'ORGANIZATION' | 'CUSTOM';
  subtype: string | null;
  description: string | null;
  promoted_from: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  vector_id: string | null;
}

export interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  metadata: string;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  project_id: string;
  user_id: string;
  category: string;
  preference: string;
  context: string | null;
  confidence: number;
  promoted_from: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  vector_id: string | null;
}

export interface FactRow {
  id: string;
  project_id: string;
  user_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_until: string | null;
  confidence: number;
  source: string | null;
  promoted_from: string | null;
  metadata: string;
  created_at: string;
  vector_id: string | null;
}

export interface TraceRow {
  id: string;
  project_id: string;
  user_id: string;
  session_id: string | null;
  task: string;
  outcome: string | null;
  success: number | null; // 0 or 1 in D1/SQLite
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by_message_id: string | null;
  metadata: string;
  vector_id: string | null;
}

export interface StepRow {
  id: string;
  trace_id: string;
  step_number: number;
  thought: string | null;
  action: string | null;
  observation: string | null;
  created_at: string;
}

export interface ToolCallRow {
  id: string;
  step_id: string;
  tool_name: string;
  arguments: string;
  result: string | null;
  status: 'success' | 'failure' | 'timeout';
  duration_ms: number | null;
  message_id: string | null;
  created_at: string;
}

export interface ToolStatRow {
  tool_name: string;
  project_id: string;
  user_id: string;
  total_calls: number;
  success_count: number;
  failure_count: number;
  total_duration_ms: number;
  last_used_at: string | null;
}

export interface PromotionLogRow {
  id: string;
  source_project_id: string;
  source_user_id: string;
  target_type: 'entity' | 'preference' | 'fact';
  source_record_id: string;
  global_record_id: string;
  reason: string | null;
  promoted_at: string;
}

// Search result type used across all memory modules
export interface SearchResult {
  id: string;
  score: number;
  metadata?: Record<string, string>;
  scopeLevel?: number; // 0=project+user, 1=user, 2=project, 3=global
}

// Pagination options
export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

// Context builder input
export interface ContextInput {
  query: string;
  session_id?: string;
  include?: ('short_term' | 'long_term' | 'procedural')[];
  limits?: {
    messages?: number;
    entities?: number;
    preferences?: number;
    facts?: number;
    traces?: number;
  };
}
