import { getUpdatesBucket, readUpdateManifest, recordCompletedUpdateCheck } from "@/lib/bir-updates";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET() {
  try {
    const manifest = await readUpdateManifest();
    return Response.json({ lastCheckedAt: manifest.lastCheckedAt, storageMode: "shared" }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof Error && error.message === "The BIR update store is unavailable.") {
      return Response.json({ lastCheckedAt: null, storageMode: "device" }, { headers: noStoreHeaders });
    }
    return Response.json({ error: "The shared update status could not be loaded." }, { status: 500, headers: noStoreHeaders });
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json().catch(() => ({})) as { lastCheckedAt?: string };
    const lastCheckedAt = await recordCompletedUpdateCheck(getUpdatesBucket(), payload.lastCheckedAt ?? new Date().toISOString());
    return Response.json({ lastCheckedAt, storageMode: "shared" }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof Error && error.message === "The BIR update store is unavailable.") {
      return Response.json({ lastCheckedAt: null, storageMode: "device" }, { headers: noStoreHeaders });
    }
    return Response.json({ error: "The shared update status could not be saved." }, { status: 500, headers: noStoreHeaders });
  }
}
