type PreparedManifest = {
  schemaVersion: 1;
  catalogVersion: string;
  files: { path: string; sha256: string; bytes: number }[];
};

export function validateManifest(value: unknown): asserts value is PreparedManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid asset manifest");
  const data = value as Partial<PreparedManifest>;
  if (
    data.schemaVersion !== 1 ||
    data.catalogVersion !== "phase7-v1" ||
    !Array.isArray(data.files) ||
    !data.files.length
  ) {
    throw new Error("Unsupported asset manifest");
  }
  const paths = new Set<string>();
  for (const file of data.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(file.path) ||
      file.path.startsWith("/") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0
    ) {
      throw new Error("Invalid asset manifest entry");
    }
    paths.add(file.path);
  }
}

// Gate 7A checks the prepared inventory. Gate 7B adds map/texture loading and hash checks.
export async function loadManifest(signal: AbortSignal): Promise<PreparedManifest> {
  const response = await fetch("/game-assets/runtime/asset-manifest.json", { signal });
  if (!response.ok) throw new Error("Asset manifest unavailable");
  const data: unknown = await response.json();
  validateManifest(data);
  return data;
}
