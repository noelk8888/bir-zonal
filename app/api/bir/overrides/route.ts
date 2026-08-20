import { readRdoRecords, readUpdateManifest } from "@/lib/bir-updates";

function key(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const city = key(new URL(request.url).searchParams.get("city") ?? "");
    if (!city) return Response.json({ error: "A city is required." }, { status: 400 });
    const manifest = await readUpdateManifest();
    const entries = Object.entries(manifest.rdos);
    const updatedRdos = entries.map(([rdo]) => rdo);
    const relevant = entries.filter(([, entry]) => !entry.removed && entry.recordsKey && entry.cities.some((candidate) => key(candidate) === city));
    const records = (await Promise.all(relevant.map(([, entry]) => readRdoRecords(entry.recordsKey!)))).flat();
    return Response.json({ updatedRdos, records, updatedAt: manifest.updatedAt });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Updated BIR data could not be loaded." }, { status: 500 });
  }
}
