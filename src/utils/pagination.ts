export type PaginationCursor = string;

export interface PaginatedRequest {
  cursor?: PaginationCursor;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: PaginationCursor;
}

export function createCursor(offset: number): PaginationCursor {
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

export function parseCursor(cursor?: PaginationCursor): number {
  if (!cursor) return 0;

  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return typeof parsed.offset === 'number' ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export function paginateArray<T>(
  items: T[],
  cursor?: PaginationCursor,
  limit: number = 50,
): PaginatedResponse<T> {
  const offset = parseCursor(cursor);
  const startIndex = Math.max(0, offset);
  const endIndex = startIndex + limit;

  const data = items.slice(startIndex, endIndex);
  const nextCursor = endIndex < items.length ? createCursor(endIndex) : undefined;

  return { data, nextCursor };
}
