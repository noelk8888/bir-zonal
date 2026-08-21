import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function barangay(value) {
  return normalize(value).replace(/^(barangay|brgy|bgy|zone)\s*(no\s*)?/, "").trim();
}

function street(value) {
  return normalize(value).replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr)\b$/, "").trim();
}

function cityGroup(city, cities) {
  const cityBase = (value) => normalize(value)
    .replace(/^(city|municipality)\s+of\s+/, "")
    .replace(/\s+(city|municipality)$/, "")
    .trim();
  const requested = cityBase(city);
  const keys = Object.keys(cities);
  const exact = keys.find((candidate) => cityBase(candidate) === requested);
  return exact && requested
    ? keys.filter((candidate) => cityBase(candidate) === requested || cityBase(candidate).endsWith(` ${requested}`))
    : [];
}

function nameVariants(value) {
  return [...new Set([normalize(value), normalize(value.replace(/\([^)]*\)/g, " "))])].filter(Boolean);
}

function propertyNameMatches(officialName, requestedName) {
  const requestedVariants = new Set(nameVariants(requestedName));
  return nameVariants(officialName).some((official) => requestedVariants.has(official));
}

async function search(city, brgy, streetName) {
  const dataRoot = new URL("../public/data/", import.meta.url);
  const index = JSON.parse(await readFile(new URL("index.json", dataRoot), "utf8"));
  const cityKey = normalize(city);
  const shard = index.cities[cityKey].shard;
  const records = JSON.parse(await readFile(new URL(`shard-${shard}.json`, dataRoot), "utf8"));
  return records.filter((record) =>
    normalize(record.c) === cityKey &&
    barangay(record.b) === barangay(brgy) &&
    street(record.s) === street(streetName)
  );
}

test("server-renders the BIR lookup interface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>BIR Zonal Values<\/title>/i);
  assert.match(html, /Find the official zonal value/i);
  assert.match(html, /Check for BIR updates/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("strict Caloocan lookup returns the verified current rows", async () => {
  const matches = await search("Caloocan City", "Brgy. 48", "A. Del Mundo St.");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].v, "3RD AVE - 4TH AVE");
  assert.deepEqual(matches[0].vals, [
    { cl: "CR", zv: 44100, row: 2468 },
    { cl: "I", zv: 39700, row: 2469 },
  ]);
  assert.equal(matches[0].sheet, "Sheet 8 (DO 046-2023)");
});

test("strict Quezon City lookup uses the street field and current sheet", async () => {
  const matches = await search("Quezon City", "Brgy. Sangandaan", "Premium St.");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].s, "PREMIUM");
  assert.deepEqual(matches[0].vals, [{ cl: "RR", zv: 44000, row: 1945 }]);
  assert.equal(matches[0].sheet, "Sheet 8 (DO 033-2024)");
});

test("general city searches cover BIR city divisions and condominium-name aliases", async () => {
  const dataRoot = new URL("../public/data/", import.meta.url);
  const index = JSON.parse(await readFile(new URL("index.json", dataRoot), "utf8"));
  const cities = cityGroup("Quezon City", index.cities);
  assert.ok(cities.includes("south quezon city"));
  assert.deepEqual(cityGroup("San Juan City", index.cities), ["san juan"]);
  const records = JSON.parse(await readFile(new URL(`shard-${index.cities["south quezon city"].shard}.json`, dataRoot), "utf8"));
  const match = records.find((record) =>
    normalize(record.c) === "south quezon city" && propertyNameMatches(record.s, "Blue Residences")
  );
  assert.equal(match?.s, "BLUE RESIDENCES (SMDC)");
  assert.equal(match?.b, "LOYOLA HEIGHTS");
  assert.equal(propertyNameMatches("BLUE RESIDENCES (SMDC)", "Blue Residence"), false);
});

test("generic street fallbacks are absent from app search data", async () => {
  const dataRoot = new URL("../public/data/", import.meta.url);
  const index = JSON.parse(await readFile(new URL("index.json", dataRoot), "utf8"));
  assert.ok(index.genericRowsExcluded > 90000);
  const sampleShard = JSON.parse(await readFile(new URL("shard-d5.json", dataRoot), "utf8"));
  assert.equal(sampleShard.some((record) => /all other|remaining street|remaining lot/i.test(`${record.s} ${record.v}`)), false);
});
