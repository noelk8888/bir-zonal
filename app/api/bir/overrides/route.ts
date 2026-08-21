import { readRdoRecords, readUpdateManifest } from "@/lib/bir-updates";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

function key(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const city = key(new URL(request.url).searchParams.get("city") ?? "");
    if (!city) return Response.json({ error: "A city is required." }, { status: 400, headers: noStoreHeaders });
    let manifest;
    try { manifest = await readUpdateManifest(); }
    catch (error) {
      if (error instanceof Error && error.message === "The BIR update store is unavailable.") {
        return Response.json({ updatedRdos: [], records: [], updatedAt: null, storageMode: "baseline" }, { headers: noStoreHeaders });
      }
      throw error;
    }
    const entries = Object.entries(manifest.rdos);
    const relevant = entries.filter(([, entry]) => !entry.removed && entry.recordsKey && entry.cities.some((candidate) => key(candidate) === city));
    const loaded = await Promise.all(relevant.map(async ([rdo, entry]) => ({
      rdo,
      records: await readRdoRecords(entry.recordsKey!),
    })));
    // An update may cover several cities. Only replace a bundled RDO when the
    // refreshed records actually include the city being searched. This keeps a
    // partial refresh from hiding an otherwise valid current bundled record.
    const applicable = loaded.filter(({ records }) => records.some((record) => key(record.c) === city));
    return Response.json({
      updatedRdos: applicable.map(({ rdo }) => rdo),
      records: applicable.flatMap(({ records }) => records),
      updatedAt: manifest.updatedAt,
    }, { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Updated BIR data could not be loaded." }, { status: 500, headers: noStoreHeaders });
  }
}
