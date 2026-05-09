import type { Context } from 'hono';
import type { AppType } from '../types';
import { ShortTermMemory } from '../memory/short-term';
import { LongTermMemory } from '../memory/long-term';
import { ProceduralMemory } from '../memory/procedural';

export type Ctx = Context<AppType>;

// Hono throws if executionCtx isn't available (e.g. some test environments).
// Wrap access so factories degrade to inline-await semantics gracefully.
export function tryWaitUntil(c: Ctx): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}

export const stm = (c: Ctx): ShortTermMemory =>
  new ShortTermMemory(c.env, c.get('projectId'), c.get('userId'), tryWaitUntil(c));

export const ltm = (c: Ctx): LongTermMemory =>
  new LongTermMemory(c.env, c.get('projectId'), c.get('userId'));

export const pm = (c: Ctx): ProceduralMemory =>
  new ProceduralMemory(c.env, c.get('projectId'), c.get('userId'));
