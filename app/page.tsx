"use client";

import { FormEvent, useEffect, useState } from "react";

type AppIndex = {
  datasetCapturedAt: string;
  sourcePage: string;
  records: number;
  regionCodes: string[];
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

function parseAddress(value: string) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const barangayIndex = parts.findIndex((part) => /\b(barangay|brgy\.?|bgy\.?|zone)\b/i.test(part));
  if (parts.length < 3 || barangayIndex < 1 || barangayIndex >= parts.length - 1) return null;
  return {
    street: parts.slice(0, barangayIndex).join(", "),
    barangay: parts[barangayIndex],
    city: parts.slice(barangayIndex + 1).join(", "),
  };
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

export default function Home() {
  const [address, setAddress] = useState("");
  const [index, setIndex] = useState<AppIndex | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<ZonalRecord[]>([]);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState("");
  const [checkMessage, setCheckMessage] = useState("");
  const [changes, setChanges] = useState<CheckChange[]>([]);

  useEffect(() => {
    fetch("/data/index.json")
      .then((response) => {
        if (!response.ok) throw new Error("The BIR search index could not be loaded.");
        return response.json();
      })
      .then((payload: AppIndex) => setIndex(payload))
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setLoadingData(false));
    const refreshClock = () => {
      setLastChecked(window.localStorage.getItem("bir-zonal-last-checked"));
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
    const parsed = parseAddress(address);
    if (!parsed) {
      setMessage("Enter the address as: Street, Barangay, City.");
      return;
    }
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
      const requestedBarangay = barangayKey(parsed.barangay);
      const requestedStreet = streetKey(parsed.street);
      const matches = records.filter((record) =>
        key(record.c) === city &&
        barangayKey(record.b) === requestedBarangay &&
        streetKey(record.s) === requestedStreet
      );
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
    setChanges([]);
    setCheckMessage("");
    const found: CheckChange[] = [];
    try {
      for (let position = 0; position < index.regionCodes.length; position += 1) {
        const region = index.regionCodes[position];
        setCheckProgress(`Checking Revenue Region ${region} · ${position + 1} of ${index.regionCodes.length}`);
        const response = await fetch(`/api/bir/check?region=${encodeURIComponent(region)}`);
        const payload = await response.json() as { changed?: CheckChange[]; error?: string };
        if (!response.ok) throw new Error(payload.error || `Revenue Region ${region} could not be checked.`);
        found.push(...(payload.changed ?? []));
      }
      const checkedAt = new Date().toISOString();
      window.localStorage.setItem("bir-zonal-last-checked", checkedAt);
      setLastChecked(checkedAt);
      setClock(new Date(checkedAt).getTime());
      setChanges(found);
      if (found.length) {
        setResults([]);
        setSearched(false);
      }
      setCheckMessage(found.length
        ? `${found.length} official BIR file change${found.length === 1 ? "" : "s"} installed. Search results now use the updated files.`
        : "No BIR changes found. Your reference is current.");
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
          <p className="lede">Enter the street, barangay, and city. Matching is always City → Barangay → Street.</p>
          <form className="search-form" onSubmit={search}>
            <label htmlFor="address">Complete address</label>
            <div className="search-row">
              <input id="address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="e.g. A. Del Mundo St., Brgy. 48, Caloocan City" autoComplete="street-address" />
              <button type="submit" disabled={searching || loadingData}>{searching ? "Searching…" : "Search zonal value"}</button>
            </div>
            <p className="input-help">Street + Barangay + City are required. Vicinity is never used as the street match.</p>
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
          {checkMessage && <div className={`check-message ${changes.length ? "warning" : "success"}`}>{checkMessage}</div>}
          {changes.length > 0 && <ul className="change-list">{changes.map((change) => <li key={`${change.rdo}-${change.reason}`}><strong>{change.rdo}</strong><span>{change.reason}{change.records ? ` · ${change.records.toLocaleString()} records` : ""}</span></li>)}</ul>}
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
                  <div className="result-card-head"><div><span className="match-badge">Exact street match</span><h3>{record.s}</h3><p>Vicinity: {record.v || "Not stated"}</p></div><div className="classification-grid">{record.vals.map((value) => <div key={`${value.cl}-${value.row}`}><span>{value.cl}</span><strong>{formatMoney(value.zv)}</strong><small>per square meter</small></div>)}</div></div>
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
          <div className="rule-list"><p><strong>1</strong> Match City/Municipality</p><p><strong>2</strong> Match Barangay/Zone</p><p><strong>3</strong> Match the Street field exactly</p></div>
          <p className="evidence-note">Generic entries such as “All Other Streets” are excluded. Every result keeps its RDO, order, effectivity, sheet, and source-row evidence.</p>
        </section>
      )}

      {changes.length > 0 && <section className="change-panel"><h2>Official changes detected</h2><p>The affected RDO files are listed below. Their official download links are preserved for verification.</p><ul>{changes.map((change) => <li key={`${change.rdo}-${change.reason}`}><strong>{change.rdo}</strong> — {change.reason}{change.downloadUrl && <> · <a href={change.downloadUrl} target="_blank" rel="noreferrer">official file</a></>}</li>)}</ul></section>}

      <footer><span>Dataset captured: {index?.datasetCapturedAt ? formatDate(index.datasetCapturedAt) : "Loading…"}</span><a href={BIR_PAGE} target="_blank" rel="noreferrer">Bureau of Internal Revenue zonal values</a></footer>
    </main>
  );
}
