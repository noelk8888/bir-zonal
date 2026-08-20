import { normalizeOfficialWorkbook, type LiveWorkbookEntry } from "@/lib/bir-workbook";
import {
  deleteRdoRecords,
  getUpdatesBucket,
  readUpdateManifest,
  recordsKeyForRdo,
  writeRdoRecords,
  writeUpdateManifest,
} from "@/lib/bir-updates";

const SOURCE_PAGE = "https://www.bir.gov.ph/zonal-values";
const CMS_BASE = "https://bir-cms-ws.bir.gov.ph";

type BaselineEntry = {
  revenue_region: string;
  rdo_name: string;
  download_url: string;
  sha256: string;
};

type LiveEntry = LiveWorkbookEntry;

function decodeHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function regionCode(value: string) {
  return value.match(/Revenue Region\s+([0-9]+[A-Z]?)/i)?.[1]?.toUpperCase() ?? "";
}

function rdoKey(value: string) {
  return value.match(/RDO\s*(?:No\.?\s*)?([0-9]+[A-Za-z]?)/i)?.[1]?.toUpperCase() ?? value.replace(/\W+/g, "").toLowerCase();
}

function collectStrings(value: unknown, key = "", output: Array<[string, string]> = []) {
  if (typeof value === "string") output.push([key, value]);
  else if (Array.isArray(value)) value.forEach((child) => collectStrings(child, key, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => collectStrings(child, childKey, output));
  return output;
}

function candidateDownload(content: Record<string, unknown>) {
  const candidates: Array<{ priority: number; url: string }> = [];
  const seen = new Set<string>();
  for (const [key, value] of collectStrings(content)) {
    for (const piece of value.split(/[\r\n]/)) {
      const [rawUrl, label = ""] = piece.split("|", 2);
      if (!rawUrl.trim().startsWith("https://")) continue;
      let url: URL;
      try { url = new URL(rawUrl.trim()); } catch { continue; }
      if (url.hostname !== "bir-cdn.bir.gov.ph" || !/\.(zip|xls|xlsx)$/i.test(decodeURIComponent(url.pathname))) continue;
      const normalizedUrl = url.toString();
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      let priority = 0;
      if (key.toLowerCase() === "files collection") priority += 10;
      if (key.toLowerCase() === "file") priority += 4;
      if (label.toLowerCase().includes("excel")) priority += 3;
      if (`${key} ${label}`.toLowerCase().includes("annex")) priority -= 5;
      candidates.push({ priority, url: normalizedUrl });
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))[0]?.url;
}

async function fetchJson(url: string, label: string, init?: RequestInit) {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const body = await response.text();
      if (!response.ok) throw new Error(`${label} returned ${response.status}`);
      try { return JSON.parse(body) as unknown; }
      catch { throw new Error(`${label} returned invalid data${body.trim() ? `: ${body.trim().slice(0, 80)}` : ""}`); }
    } catch (error) {
      lastError = error instanceof Error ? error.message : `${label} failed`;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw new Error(lastError);
}

async function liveEntriesForRegion(code: string): Promise<LiveEntry[]> {
  const pageResponse = await fetch(SOURCE_PAGE, { headers: { "user-agent": "KiuRealty-BIR-ZonalValues-App/1.0" } });
  if (!pageResponse.ok) throw new Error(`BIR page returned ${pageResponse.status}`);
  const pageHtml = await pageResponse.text();
  const feeds = new Map<string, { name: string; ids: string[] }>();
  const pattern = /\\"label\\":\\"(Revenue Region[^\\"]+)\\".*?\\"code\\":\\"([0-9]+)\\"/gs;
  for (const match of pageHtml.matchAll(pattern)) {
    const name = decodeHtml(match[1]);
    const matchCode = regionCode(name);
    const current = feeds.get(matchCode) ?? { name, ids: [] };
    if (!current.ids.includes(match[2])) current.ids.push(match[2]);
    feeds.set(matchCode, current);
  }
  const feed = feeds.get(code.toUpperCase());
  if (!feed) throw new Error(`Revenue Region ${code} was not found on the BIR page`);

  const entries: LiveEntry[] = [];
  for (const id of feed.ids) {
    const payload = await fetchJson(`${CMS_BASE}/api/pub/templates/${id}/datasets?per_page=3000`, `BIR dataset ${id}`, {
      headers: { "client-website-id": "2", Origin: "https://www.bir.gov.ph" },
    }) as { data?: Array<Record<string, unknown>> };
    for (const row of payload.data ?? []) {
      if (Number(row.is_active ?? 1) !== 1) continue;
      const content = (row.content ?? {}) as Record<string, unknown>;
      const rdoName = decodeHtml(String(content.RDO ?? row.keyword_field_1 ?? ""));
      const province = decodeHtml(String(content.Province ?? row.keyword_field_2 ?? "")).replace(/^Province:\s*/i, "");
      const details = decodeHtml(String(content.Municipalities ?? content.Municities ?? content.Municipality ?? ""));
      const downloadUrl = candidateDownload(content);
      if (rdoName && downloadUrl) entries.push({ revenueRegion: feed.name, rdoName, province, details, downloadUrl });
    }
  }
  return entries;
}

function validateLiveEntries(value: unknown, code: string): LiveEntry[] {
  if (!Array.isArray(value)) throw new Error("The browser did not provide a valid BIR catalog.");
  const entries: LiveEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const entry = {
      revenueRegion: String(candidate.revenueRegion ?? ""),
      rdoName: String(candidate.rdoName ?? ""),
      province: String(candidate.province ?? ""),
      details: String(candidate.details ?? ""),
      downloadUrl: String(candidate.downloadUrl ?? ""),
    };
    let url: URL;
    try { url = new URL(entry.downloadUrl); } catch { continue; }
    if (regionCode(entry.revenueRegion) !== code || !entry.rdoName || url.hostname !== "bir-cdn.bir.gov.ph" || !/\.(zip|xls|xlsx)$/i.test(decodeURIComponent(url.pathname))) continue;
    entries.push(entry);
  }
  if (!entries.length) throw new Error(`No active official RDO workbooks were supplied for Revenue Region ${code}.`);
  return entries;
}

async function downloadOfficialFile(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "bir-cdn.bir.gov.ph") throw new Error("Refusing a non-BIR download URL");
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "KiuRealty-BIR-ZonalValues-App/1.0" } });
      if (!response.ok) throw new Error(`Official BIR file returned ${response.status}`);
      const payload = new Uint8Array(await response.arrayBuffer());
      if (!payload.length) throw new Error("Official BIR file was empty");
      const digest = await crypto.subtle.digest("SHA-256", payload);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return { payload, sha256 };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Official BIR file download failed";
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw new Error(lastError);
}

async function checkRegion(request: Request, code: string, live: LiveEntry[]) {
  const baselineResponse = await fetch(new URL("/data/catalog-baseline.json", request.url));
  const baseline = await baselineResponse.json() as BaselineEntry[];
  const baselineRegion = baseline.filter((entry) => regionCode(entry.revenue_region) === code);
  const baselineByRdo = new Map(baselineRegion.map((entry) => [rdoKey(entry.rdo_name), entry]));
  const liveByRdo = new Map(live.map((entry) => [rdoKey(entry.rdoName), entry]));
  const bucket = getUpdatesBucket();
  const manifest = await readUpdateManifest(bucket);
  const changed: Array<{ rdo: string; reason: string; downloadUrl?: string; records?: number }> = [];

  for (const entry of liveByRdo.values()) {
    const key = rdoKey(entry.rdoName);
    const baselineEntry = baselineByRdo.get(key);
    const priorUpdate = manifest.rdos[key];
    const { payload, sha256 } = await downloadOfficialFile(entry.downloadUrl);
    const matchesBaseline = baselineEntry?.sha256 === sha256 && baselineEntry.download_url === entry.downloadUrl;
    const matchesUpdate = !priorUpdate?.removed && priorUpdate?.sha256 === sha256 && priorUpdate.downloadUrl === entry.downloadUrl;
    if (matchesUpdate || (matchesBaseline && !priorUpdate)) continue;

    if (matchesBaseline) {
      await deleteRdoRecords(priorUpdate?.recordsKey ?? null, bucket);
      delete manifest.rdos[key];
      changed.push({ rdo: entry.rdoName, reason: "returned to the published baseline", downloadUrl: entry.downloadUrl });
      continue;
    }

    const records = normalizeOfficialWorkbook(payload, entry);
    if (!records.length) throw new Error(`${entry.rdoName} changed, but no searchable current rows could be extracted.`);
    const recordsKey = recordsKeyForRdo(key);
    await writeRdoRecords(recordsKey, records, bucket);
    const now = new Date().toISOString();
    manifest.rdos[key] = {
      sha256,
      downloadUrl: entry.downloadUrl,
      rdoName: entry.rdoName,
      rdoNumber: records[0]?.rno ?? key,
      revenueRegion: entry.revenueRegion,
      regionCode: code,
      recordsKey,
      cities: [...new Set(records.map((record) => record.c).filter(Boolean))].sort(),
      recordCount: records.length,
      removed: false,
      updatedAt: now,
    };
    changed.push({ rdo: entry.rdoName, reason: baselineEntry ? "updated and installed" : "new and installed", downloadUrl: entry.downloadUrl, records: records.length });
  }

  for (const [key, entry] of baselineByRdo) {
    if (liveByRdo.has(key) || manifest.rdos[key]?.removed) continue;
    await deleteRdoRecords(manifest.rdos[key]?.recordsKey ?? null, bucket);
    manifest.rdos[key] = {
      sha256: "", downloadUrl: "", rdoName: entry.rdo_name, rdoNumber: key,
      revenueRegion: entry.revenue_region, regionCode: code, recordsKey: null,
      cities: [], recordCount: 0, removed: true, updatedAt: new Date().toISOString(),
    };
    changed.push({ rdo: entry.rdo_name, reason: "removed from the current BIR catalog" });
  }

  if (changed.length) await writeUpdateManifest(manifest, bucket);
  return Response.json({
    checkedAt: new Date().toISOString(), region: code, rdoCount: liveByRdo.size,
    changed, updatesAvailable: changed.length > 0,
    installed: changed.filter((entry) => entry.reason.includes("installed")).length,
  });
}

function requestRegion(request: Request) {
  const code = new URL(request.url).searchParams.get("region")?.toUpperCase();
  if (!code || !/^[0-9]+[A-Z]?$/.test(code)) return null;
  return code;
}

function decodeCatalog(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function GET(request: Request) {
  try {
    const code = requestRegion(request);
    if (!code) return Response.json({ error: "A valid Revenue Region code is required" }, { status: 400 });
    const catalog = new URL(request.url).searchParams.get("catalog");
    const live = catalog ? validateLiveEntries(decodeCatalog(catalog), code) : await liveEntriesForRegion(code);
    return await checkRegion(request, code, live);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "BIR check failed" }, { status: 502 });
  }
}
