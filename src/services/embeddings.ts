import { EMBEDDING } from '../config';

function truncateForEmbedding(text: string): string {
  return text.length > EMBEDDING.maxChars ? text.slice(0, EMBEDDING.maxChars) : text;
}

export async function getEmbedding(text: string, ai: Ai): Promise<number[]> {
  const result = await ai.run(EMBEDDING.model, { text: [truncateForEmbedding(text)] });
  if ('data' in result && result.data) {
    const first = result.data[0];
    if (!first) {
      throw new Error('Embedding returned empty data array');
    }
    return first;
  }
  throw new Error('Unexpected embedding response format');
}

export async function getEmbeddings(texts: string[], ai: Ai): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING.batchSize) {
    const batch = texts.slice(i, i + EMBEDDING.batchSize).map(truncateForEmbedding);
    const result = await ai.run(EMBEDDING.model, { text: batch });
    if ('data' in result && result.data) {
      results.push(...result.data);
    } else {
      throw new Error('Unexpected embedding response format');
    }
  }
  return results;
}

export function entityEmbeddingText(name: string, description: string | null): string {
  return description ? `${name}. ${description}` : name;
}

export function preferenceEmbeddingText(
  category: string,
  preference: string,
  context: string | null
): string {
  return context ? `${category}: ${preference} (${context})` : `${category}: ${preference}`;
}

export function factEmbeddingText(subject: string, predicate: string, object: string): string {
  return `${subject} ${predicate} ${object}`;
}
