"use client";

import { FormEvent, useEffect, useState } from "react";

type AppIndex = {
  datasetCapturedAt: string;
  sourcePage: string;
  records: number;
  regionCodes: string[];
  regionFeeds: Record<string, string[]>;
  regions: Record<string, string>;
  cities: Record<string, { name: string; shard: string }>;
};

type ZonalValue = { cl: string; zv: number; row: number };
type ZonalRecord = {
  c: string;
  b: string;
  s: string;
  v: string;
  vals: ZonalValue[];
  rr: string;
  rno: string;
  rdo: string;
  p: string;
  do: string;
  ed: string;
  url: string;
  wb: string;
  sheet: string;
};

type CheckChange = { rdo: string; reason: string; downloadUrl?: string; records?: number };
type LiveEntry = { revenueRegion: string; rdoName: string; province: string; details: string; downloadUrl: string };

const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;
const BIR_PAGE = "https://www.bir.gov.ph/zonal-values";

function key(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function barangayKey(value: string) {
  return key(value).replace(/^(barangay|brgy|bgy|zone)\s*(no\s*)?/, "").trim();
}

function streetKey(value: string) {
  return key(value)
    .replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr)\b$/i, "")
    .trim();
}

type SearchInput =
  | { mode: "address"; street: string; barangay: string; city: string }
  | { mode: "name"; name: string; city: string };

function parseSearchInput(value: string): SearchInput | null {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const barangayIndex = parts.findIndex((part) => /\b(barangay|brgy\.?|bgy\.?|zone)\b/i.test(part));
  if (barangayIndex >= 1 && barangayIndex < parts.length - 1) {
    return {
      mode: "address",
      street: parts.slice(0, barangayIndex).join(", "),
      barangay: parts[barangayIndex],
      city: parts.slice(barangayIndex + 1).join(", "),
    };
  }
  if (parts.length === 2) return { mode: "name", name: parts[0], city: parts[1] };
  return null;
}

function resolveCity(input: string, cities: AppIndex["cities"]) {
  const exact = key(input);
  if (cities[exact]) return exact;
  const withoutCity = exact.replace(/\s+city$/, "");
  const candidates = Object.keys(cities).filter((candidate) => candidate.replace(/\s+city$/, "") === withoutCity);
  return candidates.length === 1 ? candidates[0] : null;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "Never checked";
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

function formatEffectivityDate(value: string) {
  if (!value) return "Not stated";
  const normalized = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const parsed = normalized ? new Date(`${normalized}T00:00:00`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "long" }).format(parsed);
}

function workbookLabel(record: ZonalRecord) {
  const office = record.rdo.replace(/^RDO\s+No\.\s*/i, "").replace(/^(\d+[A-Z]?)-/, "$1 - ");
  return `RDO No. ${office}`;
}

function rdoKey(value: string) {
  return value.match(/RDO\s*(?:No\.?\s*)?([0-9]+[A-Za-z]?)/i)?.[1]?.toUpperCase() ?? value.replace(/\W+/g, "").toLowerCase();
}

function decodeHtml(value: string) {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function collectStrings(value: unknown, field = "", output: Array<[string, string]> = []) {
  if (typeof value === "string") output.push([field, value]);
  else if (Array.isArray(value)) value.forEach((child) => collectStrings(child, field, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childField, child]) => collectStrings(child, childField, output));
  return output;
}

function candidateDownload(content: Record<string, unknown>) {
  const candidates: Array<{ priority: number; url: string }> = [];
  const seen = new Set<string>();
  for (const [field, value] of collectStrings(content)) {
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
      if (field.toLowerCase() === "files collection") priority += 10;
      if (field.toLowerCase() === "file") priority += 4;
      if (label.toLowerCase().includes("excel")) priority += 3;
      if (`${field} ${label}`.toLowerCase().includes("annex")) priority -= 5;
      candidates.push({ priority, url: normalizedUrl });
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))[0]?.url;
}

function encodeCatalog(entries: LiveEntry[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function liveEntriesForRegion(revenueRegion: string, datasetIds: string[]) {
  if (!datasetIds.length) throw new Error(`${revenueRegion} has no registered official BIR feed.`);
  const byRdo = new Map<string, LiveEntry>();
  for (const id of datasetIds) {
    const response = await fetch(`https://bir-cms-ws.bir.gov.ph/api/pub/templates/${encodeURIComponent(id)}/datasets?per_page=3000`, {
      credentials: "omit",
      headers: { "client-website-id": "2" },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Official BIR feed ${id} returned ${response.status}.`);
    let payload: { data?: Array<Record<string, unknown>> };
    try { payload = JSON.parse(body) as typeof payload; }
    catch { throw new Error(`Official BIR feed ${id} returned invalid data.`); }
    for (const row of payload.data ?? []) {
      if (Number(row.is_active ?? 1) !== 1) continue;
      const content = (row.content ?? {}) as Record<string, unknown>;
      const rdoName = decodeHtml(String(content.RDO ?? row.keyword_field_1 ?? ""));
      const province = decodeHtml(String(content.Province ?? row.keyword_field_2 ?? "")).replace(/^Province:\s*/i, "");
      const fullDetails = decodeHtml(String(content.Municipalities ?? content.Municities ?? content.Municipality ?? ""));
      const details = fullDetails.match(/Department\s+Order(?:\s+No\.?)?\s*[0-9]{1,3}\s*[-–]\s*[0-9]{2,4}/i)?.[0] ?? "";
      const downloadUrl = candidateDownload(content);
      if (!rdoName || !downloadUrl) continue;
      const entry = { revenueRegion, rdoName, province, details, downloadUrl };
      const office = rdoKey(rdoName);
      const prior = byRdo.get(office);
      if (prior && prior.downloadUrl !== downloadUrl) throw new Error(`The official BIR feed returned two different current files for ${rdoName}.`);
      byRdo.set(office, entry);
    }
  }
  if (!byRdo.size) throw new Error(`${revenueRegion} returned no active official workbooks.`);
  return [...byRdo.values()];
}

export default function Home() {
  const [address, setAddress] = useState("");
  const [index, setIndex] = useState<AppIndex | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchInput["mode"] | null>(null);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<ZonalRecord[]>([]);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState("");
  const [checkMessage, setCheckMessage] = useState("");

  useEffect(() => {
    fetch("/data/index.json")
      .then((response) => {
        if (!response.ok) throw new Error("The BIR search index could not be loaded.");
        return response.json();
      })
      .then((payload: AppIndex) => setIndex(payload))
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setLoadingData(false));
    const refreshClock = async () => {
      const deviceTime = window.localStorage.getItem("bir-zonal-last-checked");
      try {
        const response = await fetch("/api/bir/status");
        const payload = await response.json() as { lastCheckedAt?: string | null };
        setLastChecked(payload.lastCheckedAt ?? deviceTime);
      } catch {
        setLastChecked(deviceTime);
      }
      setClock(Date.now());
    };
    const initial = window.setTimeout(refreshClock, 0);
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  const updateIsDue = !lastChecked || clock === null || clock - new Date(lastChecked).getTime() >= FIFTEEN_DAYS;

  async function search(event: FormEvent) {
    event.preventDefault();
    setSearched(true);
    setResults([]);
    setMessage("");
    if (!index) {
      setMessage("The BIR search index is still loading. Please try again in a moment.");
      return;
    }
    const parsed = parseSearchInput(address);
    if (!parsed) {
      setMessage("Enter either: Street, Barangay, City — or Condominium name, City.");
      return;
    }
    setSearchMode(parsed.mode);
    const city = resolveCity(parsed.city, index.cities);
    if (!city) {
      setMessage("Can not be found. Try to search manually.");
      return;
    }
    setSearching(true);
    try {
      const shard = index.cities[city].shard;
      const response = await fetch(`/data/shard-${shard}.json`);
      if (!response.ok) throw new Error("The matching BIR data file could not be loaded.");
      const baselineRecords = await response.json() as ZonalRecord[];
      const updateResponse = await fetch(`/api/bir/overrides?city=${encodeURIComponent(city)}`);
      const updatePayload = await updateResponse.json() as { updatedRdos?: string[]; records?: ZonalRecord[]; error?: string };
      if (!updateResponse.ok) throw new Error(updatePayload.error || "The updated BIR data could not be loaded.");
      const overridden = new Set(updatePayload.updatedRdos ?? []);
      const records = [
        ...baselineRecords.filter((record) => !overridden.has(rdoKey(record.rdo))),
        ...(updatePayload.records ?? []),
      ];
      const matches = parsed.mode === "address"
        ? records.filter((record) =>
          key(record.c) === city &&
          barangayKey(record.b) === barangayKey(parsed.barangay) &&
          streetKey(record.s) === streetKey(parsed.street)
        )
        : records.filter((record) => key(record.c) === city && streetKey(record.s) === streetKey(parsed.name));
      if (!matches.length) setMessage("Can not be found. Try to search manually.");
      else setResults(matches);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The search could not be completed.");
    } finally {
      setSearching(false);
    }
  }

  async function checkForUpdates() {
    if (!index || checking) return;
    setChecking(true);
    setCheckMessage("");
    const found: CheckChange[] = [];
    try {
      for (let position = 0; position < index.regionCodes.length; position += 1) {
        const region = index.regionCodes[position];
        setCheckProgress(`Checking Revenue Region ${region} · ${position + 1} of ${index.regionCodes.length}`);
        const entries = await liveEntriesForRegion(index.regions[region] ?? `Revenue Region ${region}`, index.regionFeeds[region] ?? []);
        const catalog = encodeCatalog(entries);
        const response = await fetch(`/api/bir/check?region=${encodeURIComponent(region)}&catalog=${encodeURIComponent(catalog)}`);
        const payload = await response.json() as { changed?: CheckChange[]; error?: string };
        if (!response.ok) throw new Error(payload.error || `Revenue Region ${region} could not be checked.`);
        found.push(...(payload.changed ?? []));
      }
      let checkedAt = new Date().toISOString();
      try {
        const statusResponse = await fetch("/api/bir/status", { method: "POST" });
        const status = await statusResponse.json() as { lastCheckedAt?: string | null };
        if (statusResponse.ok && status.lastCheckedAt) checkedAt = status.lastCheckedAt;
      } catch {
        // Keep a device-local timestamp only if the shared store is unavailable.
      }
      window.localStorage.setItem("bir-zonal-last-checked", checkedAt);
      setLastChecked(checkedAt);
      setClock(new Date(checkedAt).getTime());
      if (found.length) {
        setResults([]);
        setSearched(false);
      }
    } catch (error) {
      setCheckMessage(error instanceof Error ? error.message : "The BIR update check failed.");
    } finally {
      setCheckProgress("");
      setChecking(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-label="BIR Zonal Values"><strong>BIR</strong><span>ZONAL</span></div>
        <div className="brand-copy"><p>Official property valuation reference</p><h1>BIR Zonal Values</h1></div>
        <div className="status-pill"><span /> {loadingData ? "Loading current reference" : `${index?.records.toLocaleString() ?? 0} exact street records`}</div>
      </header>

      <section className="workspace">
        <div className="search-panel">
          <p className="eyebrow">Exact address lookup</p>
          <h2>Find the official zonal value.</h2>
          <p className="lede">For streets, matching is always City → Barangay → Street. For a condominium, enter its official name and city; the app resolves its official barangay.</p>
          <form className="search-form" onSubmit={search}>
            <label htmlFor="address">Complete address</label>
            <div className="search-row">
              <input id="address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="e.g. Shang Salcedo Place, Makati City" autoComplete="street-address" />
              <button type="submit" disabled={searching || loadingData}>{searching ? "Searching…" : "Search zonal value"}</button>
            </div>
            <p className="input-help">Street: Street + Barangay + City. Condominium: official condominium name + City. Vicinity is never used as a match.</p>
          </form>
        </div>

        <aside className={`update-card ${updateIsDue ? "is-due" : ""}`}>
          <div className="update-icon" aria-hidden="true">↻</div>
          <p className="eyebrow">{updateIsDue ? "Update check due" : "Source health"}</p>
          <h3>Check BIR updates</h3>
          <p>{updateIsDue ? "It has been 15 days or more since the last successful check." : "Verify every Revenue Region against the official BIR files."}</p>
          <button className="update-button" type="button" onClick={checkForUpdates} disabled={checking || !index}>{checking ? "Checking official files…" : "Check for BIR updates"}</button>
          <small>Last checked: {formatDate(lastChecked)}</small>
          {checkProgress && <div className="check-progress">{checkProgress}</div>}
          {checkMessage && <div className="check-message warning">{checkMessage}</div>}
        </aside>
      </section>

      {searched && (
        <section className="results-section" aria-live="polite">
          {message && <div className="not-found"><strong>{message}</strong>{message.startsWith("Can not") && <a href={BIR_PAGE} target="_blank" rel="noreferrer">Search the official BIR page</a>}</div>}
          {results.length > 0 && <>
            <div className="results-heading"><p className="eyebrow">Exact BIR match</p><h2>{results[0].s}</h2><p>{results[0].b} · {results[0].c}</p></div>
            <div className="result-list">
              {results.map((record, recordIndex) => (
                <article className="result-card" key={`${record.rno}-${record.sheet}-${record.v}-${recordIndex}`}>
                  <div className="result-card-head"><div><span className="match-badge">{searchMode === "name" ? "Exact condominium/name match" : "Exact street match"}</span><h3>{record.s}</h3><p>Vicinity: {record.v || "Not stated"}</p></div><div className="classification-grid">{record.vals.map((value) => <div key={`${value.cl}-${value.row}`}><span>{value.cl}</span><strong>{formatMoney(value.zv)}</strong><small>per square meter</small></div>)}</div></div>
                  <dl className="details-grid">
                    <div><dt>City/Municipality</dt><dd>{record.c}</dd></div>
                    <div><dt>Barangay</dt><dd>{record.b}</dd></div>
                    <div><dt>Revenue Region</dt><dd>{record.rr}</dd></div>
                    <div><dt>Revenue District Office</dt><dd>{record.rdo}</dd></div>
                    <div><dt>Department Order</dt><dd>No. {record.do || "Not stated"}</dd></div>
                    <div><dt>Effectivity Date</dt><dd>{formatEffectivityDate(record.ed)}</dd></div>
                    <div><dt>Source Sheet</dt><dd>{record.sheet}</dd></div>
                    <div><dt>Source Row</dt><dd>{record.vals.map((value) => value.row).join(", ")}</dd></div>
                    <div><dt>Source Workbook</dt><dd>{workbookLabel(record)}</dd></div>
                    <div><dt>BIR page fallback</dt><dd><a href={BIR_PAGE} target="_blank" rel="noreferrer">Open official BIR zonal-values page</a></dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </>}
        </section>
      )}

      {!searched && (
        <section className="result-preview" aria-label="Example result format">
          <div><p className="eyebrow">What you will receive</p><h2>Every valid classification, in one answer.</h2></div>
          <div className="rule-list"><p><strong>1</strong> Match City/Municipality</p><p><strong>2</strong> Street: match Barangay/Zone</p><p><strong>3</strong> Street or condominium name: exact official field</p></div>
          <p className="evidence-note">Generic entries such as “All Other Streets” are excluded. Every result keeps its RDO, order, effectivity, sheet, and source-row evidence.</p>
        </section>
      )}

      <footer><span>Dataset captured: {index?.datasetCapturedAt ? formatDate(index.datasetCapturedAt) : "Loading…"}</span><a href={BIR_PAGE} target="_blank" rel="noreferrer">Bureau of Internal Revenue zonal values</a></footer>
    </main>
  );
}
