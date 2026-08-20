import { getUpdatesBucket, readUpdateManifest, recordCompletedUpdateCheck } from "@/lib/bir-updates";

export async function GET() {
  try {
    const manifest = await readUpdateManifest();
    return Response.json({ lastCheckedAt: manifest.lastCheckedAt, storageMode: "shared" });
  } catch (error) {
    if (error instanceof Error && error.message === "The BIR update store is unavailable.") {
      return Response.json({ lastCheckedAt: null, storageMode: "device" });
    }
    return Response.json({ error: "The shared update status could not be loaded." }, { status: 500 });
  }
}

export async function POST() {
  try {
    const lastCheckedAt = await recordCompletedUpdateCheck(getUpdatesBucket());
    return Response.json({ lastCheckedAt, storageMode: "shared" });
  } catch (error) {
    if (error instanceof Error && error.message === "The BIR update store is unavailable.") {
      return Response.json({ lastCheckedAt: null, storageMode: "device" });
    }
    return Response.json({ error: "The shared update status could not be saved." }, { status: 500 });
  }
}
