import { Type } from "@sinclair/typebox";
import { PageCursor, PageLimit } from "./schemas/common.js";

export const PageQuery = Type.Object(
  {
    limit: Type.Optional(PageLimit),
    cursor: Type.Optional(PageCursor),
  },
  { additionalProperties: false },
);

export type PageParams = { limit: number; cursor: string | null };

export type Page<T> = { items: T[]; nextCursor: string | null };

export function pageParams(query: { limit?: number; cursor?: string }): PageParams {
  return {
    limit: query.limit ?? 50,
    cursor: query.cursor && query.cursor.length > 0 ? query.cursor : null,
  };
}

export function pageResult<T>(rows: T[], limit: number, keyOf: (row: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: keyOf(items[items.length - 1]) };
}

export function encodeJobCursor(row: { created_at: string | Date; id: string }): string {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return `${created}|${row.id}`;
}

export function decodeJobCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  return { createdAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
}
