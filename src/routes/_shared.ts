import type { Context } from 'hono';
import type { AppType } from '../types';
import { ShortTermMemory } from '../memory/short-term';
import { LongTermMemory } from '../memory/long-term';
import { ProceduralMemory } from '../memory/procedural';

export type Ctx = Context<AppType>;

export const stm = (c: Ctx): ShortTermMemory =>
  new ShortTermMemory(c.env, c.get('projectId'), c.get('userId'));

export const ltm = (c: Ctx): LongTermMemory =>
  new LongTermMemory(c.env, c.get('projectId'), c.get('userId'));

export const pm = (c: Ctx): ProceduralMemory =>
  new ProceduralMemory(c.env, c.get('projectId'), c.get('userId'));
