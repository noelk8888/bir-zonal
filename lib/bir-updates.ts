import { env } from "cloudflare:workers";

import type { CompactZonalRecord } from "./bir-workbook";

export type UpdateManifestEntry = {
  sha256: string;
  downloadUrl: string;
  rdoName: string;
  rdoNumber: string;
  revenueRegion: string;
  regionCode: string;
  recordsKey: string | null;
  cities: string[];
  recordCount: number;
  removed: boolean;
  updatedAt: string;
};

export type UpdateManifest = {
  version: 1;
  updatedAt: string | null;
  lastCheckedAt: string | null;
  rdos: Record<string, UpdateManifestEntry>;
};

type R2ObjectBody = {
  text(): Promise<string>;
};

type UpdatesBucket = {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

const MANIFEST_KEY = "updates/manifest.json";

export function getUpdatesBucket() {
  const bucket = (env as unknown as { FILES?: UpdatesBucket }).FILES;
  if (!bucket) {
    throw new Error("The BIR update store is unavailable.");
  }
  return bucket;
}

export async function readUpdateManifest(bucket = getUpdatesBucket()): Promise<UpdateManifest> {
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) return { version: 1, updatedAt: null, lastCheckedAt: null, rdos: {} };
  const parsed = JSON.parse(await object.text()) as Partial<UpdateManifest>;
  if (parsed.version !== 1 || !parsed.rdos) throw new Error("The BIR update manifest is invalid.");
  return { version: 1, updatedAt: parsed.updatedAt ?? null, lastCheckedAt: parsed.lastCheckedAt ?? null, rdos: parsed.rdos };
}

export async function writeUpdateManifest(manifest: UpdateManifest, bucket = getUpdatesBucket()) {
  manifest.updatedAt = new Date().toISOString();
  await bucket.put(MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function recordCompletedUpdateCheck(bucket = getUpdatesBucket()) {
  const manifest = await readUpdateManifest(bucket);
  manifest.lastCheckedAt = new Date().toISOString();
  await writeUpdateManifest(manifest, bucket);
  return manifest.lastCheckedAt;
}

export function recordsKeyForRdo(rdoKey: string) {
  return `updates/rdos/${rdoKey}.json`;
}

export async function writeRdoRecords(key: string, records: CompactZonalRecord[], bucket = getUpdatesBucket()) {
  await bucket.put(key, JSON.stringify(records), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function readRdoRecords(key: string, bucket = getUpdatesBucket()) {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Updated BIR data is missing: ${key}`);
  return JSON.parse(await object.text()) as CompactZonalRecord[];
}

export async function deleteRdoRecords(key: string | null, bucket = getUpdatesBucket()) {
  if (key) await bucket.delete(key);
}
