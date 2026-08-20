const SOURCE_PAGE = "https://www.bir.gov.ph/zonal-values";
const CMS_BASE = "https://bir-cms-ws.bir.gov.ph";

type BaselineEntry = {
  revenue_region: string;
  rdo_name: string;
  download_url: string;
  sha256: string;
};

type LiveEntry = {
  revenueRegion: string;
  rdoName: string;
  downloadUrl: string;
};

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
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, child]) => collectStrings(child, childKey, output));
  }
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
    const response = await fetch(`${CMS_BASE}/api/pub/templates/${id}/datasets?per_page=3000`, {
      headers: { "client-website-id": "2", Origin: "https://www.bir.gov.ph" },
    });
    if (!response.ok) throw new Error(`BIR dataset ${id} returned ${response.status}`);
    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    for (const row of payload.data ?? []) {
      if (Number(row.is_active ?? 1) !== 1) continue;
      const content = (row.content ?? {}) as Record<string, unknown>;
      const rdoName = decodeHtml(String(content.RDO ?? row.keyword_field_1 ?? ""));
      const downloadUrl = candidateDownload(content);
      if (rdoName && downloadUrl) entries.push({ revenueRegion: feed.name, rdoName, downloadUrl });
    }
  }
  return entries;
}

async function sha256(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "bir-cdn.bir.gov.ph") throw new Error("Refusing a non-BIR download URL");
  const response = await fetch(url, { headers: { "user-agent": "KiuRealty-BIR-ZonalValues-App/1.0" } });
  if (!response.ok) throw new Error(`Official BIR file returned ${response.status}`);
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("region")?.toUpperCase();
    if (!code || !/^[0-9]+[A-Z]?$/.test(code)) {
      return Response.json({ error: "A valid Revenue Region code is required" }, { status: 400 });
    }
    const baselineResponse = await fetch(new URL("/data/catalog-baseline.json", request.url));
    const baseline = await baselineResponse.json() as BaselineEntry[];
    const baselineRegion = baseline.filter((entry) => regionCode(entry.revenue_region) === code);
    const baselineByRdo = new Map(baselineRegion.map((entry) => [rdoKey(entry.rdo_name), entry]));
    const live = await liveEntriesForRegion(code);
    const liveByRdo = new Map(live.map((entry) => [rdoKey(entry.rdoName), entry]));
    const changed: Array<{ rdo: string; reason: string; downloadUrl?: string }> = [];

    for (let index = 0; index < live.length; index += 3) {
      const batch = live.slice(index, index + 3);
      const comparisons = await Promise.all(batch.map(async (entry) => {
        const previous = baselineByRdo.get(rdoKey(entry.rdoName));
        if (!previous) return { rdo: entry.rdoName, reason: "new", downloadUrl: entry.downloadUrl };
        const currentHash = await sha256(entry.downloadUrl);
        if (currentHash !== previous.sha256) return { rdo: entry.rdoName, reason: "file changed", downloadUrl: entry.downloadUrl };
        if (entry.downloadUrl !== previous.download_url) return { rdo: entry.rdoName, reason: "link changed", downloadUrl: entry.downloadUrl };
        return null;
      }));
      changed.push(...comparisons.filter((item): item is NonNullable<typeof item> => item !== null));
    }

    for (const [key, entry] of baselineByRdo) {
      if (!liveByRdo.has(key)) changed.push({ rdo: entry.rdo_name, reason: "removed from current BIR catalog" });
    }

    return Response.json({
      checkedAt: new Date().toISOString(),
      region: code,
      rdoCount: live.length,
      changed,
      updatesAvailable: changed.length > 0,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "BIR check failed" }, { status: 502 });
  }
}
