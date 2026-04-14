const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5' as const;
const MAX_EMBEDDING_CHARS = 512;

/** Truncate text to a safe length for the embedding model. */
function truncateForEmbedding(text: string): string {
  return text.length > MAX_EMBEDDING_CHARS ? text.slice(0, MAX_EMBEDDING_CHARS) : text;
}

export async function getEmbedding(text: string, ai: Ai): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [truncateForEmbedding(text)] });
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
  // Batch in chunks of 100 (Workers AI limit)
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100).map(truncateForEmbedding);
    const result = await ai.run(EMBEDDING_MODEL, { text: batch });
    if ('data' in result && result.data) {
      results.push(...result.data);
    } else {
      throw new Error('Unexpected embedding response format');
    }
  }
  return results;
}
