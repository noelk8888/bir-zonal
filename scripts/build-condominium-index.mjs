import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDirectory = path.resolve("public/data");
const shardFiles = (await readdir(dataDirectory))
  .filter((name) => /^shard-[a-f0-9]{2}\.json$/.test(name))
  .sort();

const records = [];
for (const shardFile of shardFiles) {
  const shard = JSON.parse(await readFile(path.join(dataDirectory, shardFile), "utf8"));
  records.push(...shard.filter((record) => record.vals?.some(({ cl }) => ["RC", "CC", "PS"].includes(cl))));
}

await writeFile(
  path.join(dataDirectory, "condominium-index-20260821.json"),
  JSON.stringify(records),
);

console.log(`Wrote ${records.length} condominium records.`);
