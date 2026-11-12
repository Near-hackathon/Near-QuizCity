export class PaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationError";
  }
}

export function isLegacyMethodError(error: unknown): boolean {
  const record = error as { message?: unknown; type?: unknown };
  const text = `${String(record?.message ?? error)} ${String(record?.type ?? "")}`;
  return /MethodNotFound|unknown method|method .*not found|does not accept arguments|invalid type: map|expected unit|failed to deserialize input/i.test(
    text,
  );
}

type CollectPagesOptions<T> = {
  total: number;
  pageSize: number;
  fetchPage: (fromIndex: number, limit: number) => Promise<T[]>;
  idOf: (item: T) => string | number;
  legacy?: () => Promise<unknown>;
  isLegacyUnsupported?: (error: unknown) => boolean;
};

export async function collectPages<T>({
  total,
  pageSize,
  fetchPage,
  idOf,
  legacy,
  isLegacyUnsupported = isLegacyMethodError,
}: CollectPagesOptions<T>): Promise<T[]> {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new PaginationError(`invalid pagination total: ${total}`);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new PaginationError(`invalid page size: ${pageSize}`);
  }
  if (total === 0) return [];

  const all: T[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (offset < total) {
    let page: T[];
    try {
      page = await fetchPage(offset, pageSize);
    } catch (error) {
      if (offset === 0 && legacy && isLegacyUnsupported(error)) {
        return collectLegacy(legacy, total, idOf);
      }
      throw error;
    }
    if (!Array.isArray(page)) {
      throw new PaginationError(`pagination page at offset ${offset} was not an array`);
    }
    if (page.length > pageSize) {
      throw new PaginationError(
        `pagination page at offset ${offset} returned ${page.length} items; limit is ${pageSize}`,
      );
    }
    if (page.length === 0) {
      throw new PaginationError(
        `pagination ended early at offset ${offset}: collected ${all.length} of ${total}`,
      );
    }
    for (const item of page) {
      const id = String(idOf(item));
      if (seen.has(id)) {
        throw new PaginationError(`duplicate entity id ${id} across pages`);
      }
      seen.add(id);
      all.push(item);
    }
    offset += page.length;
  }

  if (all.length !== total) {
    throw new PaginationError(`pagination collected ${all.length} items, expected ${total}`);
  }
  return all;
}

async function collectLegacy<T>(
  legacy: () => Promise<unknown>,
  total: number,
  idOf: (item: T) => string | number,
): Promise<T[]> {
  const value = await legacy();
  if (!Array.isArray(value)) {
    throw new PaginationError("legacy fallback did not return an array");
  }
  if (value.length !== total) {
    throw new PaginationError(`legacy fallback returned ${value.length} items, expected ${total}`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    const id = String(idOf(item as T));
    if (seen.has(id)) {
      throw new PaginationError(`duplicate entity id ${id} in legacy fallback`);
    }
    seen.add(id);
  }
  return value as T[];
}
