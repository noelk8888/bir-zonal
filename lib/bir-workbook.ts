import { unzipSync } from "fflate";
import * as XLSX from "xlsx";

export type LiveWorkbookEntry = {
  revenueRegion: string;
  rdoName: string;
  province: string;
  details: string;
  downloadUrl: string;
};

export type CompactZonalRecord = {
  c: string;
  b: string;
  s: string;
  v: string;
  vals: Array<{ cl: string; zv: number; row: number }>;
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

const GENERIC_PATTERNS = ["all other", "all others", "other street", "other lot", "remaining street", "remaining lot"];
const CLASSIFICATION = /^[A-Z]{1,4}\d{0,2}(?:\/[A-Z]{1,4}\d{0,2})*$/i;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function searchKey(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function labelKey(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z]+/g, "");
}

function isGeneric(value: string) {
  const normalized = searchKey(value);
  return GENERIC_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function nextValue(values: unknown[], start: number) {
  for (const value of values.slice(start + 1)) {
    const candidate = clean(value).replace(/^\s*[:=-]+\s*/, "");
    if (candidate) return candidate;
  }
  return "";
}

function metadataValue(values: unknown[], labels: string[], takeLast = false) {
  for (let index = 0; index < values.length; index += 1) {
    const normalized = labelKey(values[index]);
    if (!labels.some((label) => normalized.startsWith(label))) continue;
    const raw = clean(values[index]);
    if (raw.includes(":")) {
      const inline = clean(raw.split(":").slice(1).join(":"));
      if (inline) return inline;
    }
    if (takeLast) {
      const candidates = values.slice(index + 1).map((item) => clean(item).replace(/^\s*[:=-]+\s*/, "")).filter(Boolean);
      return candidates.at(-1) ?? "";
    }
    return nextValue(values, index);
  }
  return null;
}

function normalizeBarangay(value: string) {
  return clean(value)
    .replace(/\s*[-–—]+\s*(continued|continuation)\s*$/i, "")
    .replace(/\s+continued\s*$/i, "");
}

function normalizeEffectivityDate(value: string) {
  const candidate = clean(value);
  if (!/^\d+(?:\.\d+)?$/.test(candidate)) return candidate;
  const serial = Number(candidate);
  if (serial < 20_000 || serial > 100_000) return candidate;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function findHeader(values: unknown[]) {
  const compact = values.map((value) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, ""));
  const classification = compact.findIndex((value) => value.includes("CLASS"));
  const street = compact.findIndex((value) => ["STREET", "SUBDIVISION", "CONDOMINIUM", "TOWNHOUSE"].some((token) => value.includes(token)));
  const vicinity = compact.findIndex((value) => value.includes("VICINITY"));
  if (classification < 0 || street < 0) return null;
  const candidates = compact
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => index !== classification && ["ZV", "ZONALVALUE", "REVISION", "REV"].some((token) => value.includes(token)) && ["SQ", "VALUE", "ZV", "REV"].some((token) => value.includes(token)));
  const value = candidates.at(-1)?.index ?? (classification + 1 < values.length ? classification + 1 : -1);
  if (value < 0) return null;
  return { street, vicinity, classification, value };
}

function parseClassification(value: unknown) {
  const candidate = clean(value).toUpperCase().replace(/\s+/g, "").replace(/\*/g, "");
  return candidate && CLASSIFICATION.test(candidate) ? candidate : null;
}

function parseAmount(value: unknown) {
  const candidate = clean(value).replace(/PHP|PESO|₱/gi, "").replace(/[ ,]/g, "").replace(/\*$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(candidate)) return null;
  return Number(candidate);
}

function departmentOrderTokens(value: string) {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(?:department\s+order(?:\s+no\.?)?\s*)?([0-9]{1,3})\s*[-–]\s*([0-9]{2,4})/gi)) {
    tokens.add(`${Number(match[1])}-${match[2].slice(-2)}`);
    tokens.add(`${Number(match[1])}-${match[2]}`);
  }
  return tokens;
}

function hasTokenMatch(left: Set<string>, right: Set<string>) {
  return [...left].some((token) => right.has(token));
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string) {
  // Preserve raw numeric values. Some official BIR workbooks display an
  // explicit zero as a dash, but zero still belongs in the search result.
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: true });
}

function selectCurrentSheets(workbook: XLSX.WorkBook, details: string) {
  const pageTokens = departmentOrderTokens(details);
  const tokenMatches = workbook.SheetNames.filter((name) => hasTokenMatch(pageTokens, departmentOrderTokens(name)));
  if (tokenMatches.length) return tokenMatches;

  const lookup = new Map(workbook.SheetNames.map((name) => [searchKey(name), name]));
  const present: string[] = [];
  for (const notice of workbook.SheetNames.filter((name) => searchKey(name).includes("notice"))) {
    for (const row of sheetRows(workbook, notice)) {
      const values = row.map(clean);
      if (!values.some((value) => value.toLowerCase() === "present")) continue;
      for (const value of values) {
        const normalized = searchKey(value);
        if (lookup.has(normalized)) present.push(lookup.get(normalized)!);
        else for (const [sheetKey, sheetName] of lookup) if (sheetKey && normalized.includes(sheetKey) && sheetName !== notice) present.push(sheetName);
      }
    }
  }
  if (present.length) return [...new Set(present)];
  return [workbook.SheetNames.find((name) => !searchKey(name).includes("notice")) ?? workbook.SheetNames[0]];
}

function rdoNumber(name: string) {
  return name.match(/RDO\s+No\.\s*([0-9]{1,3}[A-Z]?)/i)?.[1]?.toUpperCase() ?? "";
}

function cityFromSingleCityRdo(name: string) {
  const area = name.includes("-") ? clean(name.split("-").slice(1).join("-")) : "";
  return /city/i.test(area) && !area.includes(",") && !area.includes("/") ? area : "";
}

function orderFromDetails(details: string) {
  return clean(details.match(/Department\s+Order(?:\s+No\.?)?\s*([0-9]{1,3}\s*[-–]\s*[0-9]{2,4})/i)?.[1] ?? "");
}

function extractWorkbook(payload: Uint8Array, url: string) {
  if (!/\.zip(?:$|\?)/i.test(url)) return payload;
  const files = unzipSync(payload);
  const workbooks = Object.entries(files).filter(([name]) => /\.(xls|xlsx)$/i.test(name) && !name.split("/").at(-1)?.startsWith("~$"));
  if (workbooks.length !== 1) throw new Error(`Expected one Excel workbook in the official archive, found ${workbooks.length}`);
  return workbooks[0][1];
}

export function normalizeOfficialWorkbook(payload: Uint8Array, entry: LiveWorkbookEntry): CompactZonalRecord[] {
  const workbookBytes = extractWorkbook(payload, entry.downloadUrl);
  const workbook = XLSX.read(workbookBytes, { type: "array", cellDates: false });
  const selectedSheets = selectCurrentSheets(workbook, entry.details);
  const parsed: Array<CompactZonalRecord & { value: { cl: string; zv: number; row: number } }> = [];

  for (const sheetName of selectedSheets) {
    const state = {
      province: entry.province,
      city: cityFromSingleCityRdo(entry.rdoName),
      barangay: "",
      order: orderFromDetails(entry.details),
      effectivity: "",
    };
    let header: ReturnType<typeof findHeader> = null;
    const recent: unknown[][] = [];
    let lastStreet = "";
    let lastVicinity = "";
    let verticalIndex: number | null = null;
    const rows = sheetRows(workbook, sheetName);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const values = rows[rowIndex].slice(0, 20);
      const first = labelKey(values[0]);
      if (first.startsWith("provincecitymunicipalitybarangay")) {
        verticalIndex = 0;
        header = null;
        recent.push(values);
        if (recent.length > 3) recent.shift();
        continue;
      }
      if (verticalIndex !== null) {
        const verticalValue = values.map((value) => clean(value).replace(/^\s*[:=-]+\s*/, "")).find(Boolean) ?? "";
        if (verticalValue) {
          if (verticalIndex === 0) state.province = verticalValue;
          if (verticalIndex === 1) state.city = verticalValue;
          if (verticalIndex === 2) state.barangay = normalizeBarangay(verticalValue);
          verticalIndex += 1;
          if (verticalIndex >= 3) verticalIndex = null;
        }
        recent.push(values);
        if (recent.length > 3) recent.shift();
        continue;
      }

      const province = metadataValue(values, ["province"]);
      if (province !== null) { state.province = province; header = null; }
      let city = metadataValue(values, ["citymunicipality", "municipalitycity", "municipality", "city"]);
      if (city && /^\d+\s*\/\s*\d+$/.test(city) && recent.length) {
        const prior = recent.at(-1)!.map(clean).filter(Boolean);
        if (prior.length === 1 && /[A-Za-z]/.test(prior[0])) {
          state.city = prior[0];
          state.barangay = normalizeBarangay(city);
          city = null;
        }
      }
      if (city) { state.city = city; state.barangay = ""; lastStreet = ""; lastVicinity = ""; header = null; }
      const brgy = metadataValue(values, ["zonebarangay", "zonebrgy", "barangayzone", "barangay", "baragay", "baranga", "brgyzone", "brgy"]);
      if (brgy) { state.barangay = normalizeBarangay(brgy); lastStreet = ""; lastVicinity = ""; header = null; }
      const order = metadataValue(values, ["dono", "departmentorderno", "departmentorder"], true);
      if (order) state.order = order;
      const effectivity = metadataValue(values, ["effectivitydate", "effectivedate"], true);
      if (effectivity) state.effectivity = normalizeEffectivityDate(effectivity);

      let detected = findHeader(values);
      if (!detected && recent.length) {
        for (let depth = 1; depth <= recent.length; depth += 1) {
          const parts = [...recent.slice(-depth), values];
          const width = Math.max(...parts.map((part) => part.length));
          const combined = Array.from({ length: width }, (_, index) => parts.map((part) => clean(part[index])).join(" "));
          detected = findHeader(combined);
          if (detected) break;
        }
      }
      if (detected) { header = detected; lastStreet = ""; lastVicinity = ""; recent.splice(0); continue; }
      if (!header) { recent.push(values); if (recent.length > 3) recent.shift(); continue; }
      if (Math.max(header.street, header.vicinity, header.classification, header.value) >= values.length) continue;

      let street = clean(values[header.street]);
      let vicinity = header.vicinity >= 0 ? clean(values[header.vicinity]) : "";
      if (street) lastStreet = street; else street = lastStreet;
      if (vicinity) lastVicinity = vicinity; else vicinity = lastVicinity;
      if (!street) continue;
      let classification: string | null = null;
      for (let index = header.classification; index <= Math.min(header.value, values.length - 1); index += 1) {
        classification = parseClassification(values[index]);
        if (classification) break;
      }
      const amount = parseAmount(values[header.value]);
      if (!classification || amount === null || isGeneric(street) || isGeneric(vicinity)) continue;
      const barangay = normalizeBarangay(state.barangay) || (searchKey(street) === "all barangays" ? "ALL BARANGAYS" : "NOT STATED IN BIR SHEET");
      parsed.push({
        c: clean(state.city), b: barangay, s: street, v: vicinity,
        vals: [], rr: entry.revenueRegion, rno: rdoNumber(entry.rdoName), rdo: entry.rdoName,
        p: clean(state.province), do: clean(state.order), ed: clean(state.effectivity), url: entry.downloadUrl,
        wb: entry.rdoName, sheet: sheetName,
        value: { cl: classification, zv: amount, row: rowIndex + 1 },
      });
      recent.push(values);
      if (recent.length > 3) recent.shift();
    }
  }

  const grouped = new Map<string, CompactZonalRecord>();
  for (const row of parsed) {
    const groupKey = JSON.stringify([row.rr, row.rno, row.rdo, row.p, row.c, row.b, row.s, row.v, row.do, row.ed, row.url, row.wb, row.sheet]);
    const current = grouped.get(groupKey) ?? {
      c: row.c, b: row.b, s: row.s, v: row.v, vals: [], rr: row.rr,
      rno: row.rno, rdo: row.rdo, p: row.p, do: row.do, ed: row.ed,
      url: row.url, wb: row.wb, sheet: row.sheet,
    };
    // Mirror the audited baseline normalizer: identical classification/value
    // duplicates keep the first source row as their evidence row.
    if (!current.vals.some((value) => value.cl === row.value.cl && value.zv === row.value.zv)) current.vals.push(row.value);
    grouped.set(groupKey, current);
  }
  return [...grouped.values()].map((record) => ({ ...record, vals: record.vals.sort((a, b) => a.cl.localeCompare(b.cl) || a.row - b.row) }));
}
