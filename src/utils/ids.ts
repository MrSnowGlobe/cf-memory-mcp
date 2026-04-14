export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
