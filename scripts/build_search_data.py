#!/usr/bin/env python3
"""Build compact, deterministic city-address shards for the BIR web app."""

from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
CRM_ROOT = APP_ROOT.parent
MASTER = CRM_ROOT / "bir-zonal-values" / "normalized" / "bir-zonal-values-current-master.csv"
OUTPUT = APP_ROOT / "public" / "data"
MANIFEST = CRM_ROOT / "bir-zonal-values" / "manifest" / "bir-rdo-current.json"
DOWNLOADS = CRM_ROOT / "bir-zonal-values" / "manifest" / "download-inventory.json"

GENERIC_PATTERNS = (
    "all other",
    "all others",
    "other street",
    "other lot",
    "remaining street",
    "remaining lot",
)

GROUP_FIELDS = (
    "revenue_region",
    "rdo_number",
    "rdo_name",
    "province",
    "city_municipality",
    "barangay",
    "street_subdivision_condominium",
    "vicinity",
    "department_order",
    "effectivity_date",
    "source_url",
    "source_workbook",
    "source_sheet",
)


def search_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).strip()


def is_generic(value: str) -> bool:
    key = search_key(value)
    return any(pattern in key for pattern in GENERIC_PATTERNS)


def shard_id(city_key: str) -> str:
    return hashlib.sha1(city_key.encode("utf-8")).hexdigest()[:2]


def number(value: str) -> int | float:
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def compact(group: dict) -> dict:
    rows = sorted(group["values"], key=lambda item: (item[0], item[2]))
    return {
        "c": group["city_municipality"],
        "b": group["barangay"],
        "s": group["street_subdivision_condominium"],
        "v": group["vicinity"],
        "vals": [{"cl": cl, "zv": value, "row": row} for cl, value, row in rows],
        "rr": group["revenue_region"],
        "rno": group["rdo_number"],
        "rdo": group["rdo_name"],
        "p": group["province"],
        "do": group["department_order"],
        "ed": group["effectivity_date"],
        "url": group["source_url"],
        "wb": Path(group["source_workbook"]).name,
        "sheet": group["source_sheet"],
    }


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob("shard-*.json"):
        stale.unlink()

    grouped: dict[tuple[str, ...], dict] = {}
    source_rows = 0
    skipped = 0
    with MASTER.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            source_rows += 1
            if is_generic(row["street_subdivision_condominium"]) or is_generic(row["vicinity"]):
                skipped += 1
                continue
            key = tuple(row[field] for field in GROUP_FIELDS)
            group = grouped.setdefault(key, {field: row[field] for field in GROUP_FIELDS})
            group.setdefault("values", [])
            item = (
                row["classification"],
                number(row["zonal_value_php_per_sqm"]),
                int(row["source_row"]),
            )
            if item not in group["values"]:
                group["values"].append(item)

    shards: dict[str, list[dict]] = defaultdict(list)
    cities: dict[str, dict[str, str]] = {}
    for group in grouped.values():
        city_key = search_key(group["city_municipality"])
        if not city_key:
            continue
        sid = shard_id(city_key)
        cities[city_key] = {"name": group["city_municipality"], "shard": sid}
        shards[sid].append(compact(group))

    shard_manifest = {}
    for sid, records in sorted(shards.items()):
        records.sort(key=lambda row: (search_key(row["c"]), search_key(row["b"]), search_key(row["s"]), search_key(row["v"])))
        path = OUTPUT / f"shard-{sid}.json"
        path.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        shard_manifest[sid] = {"file": path.name, "records": len(records)}

    source_manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    download_inventory = json.loads(DOWNLOADS.read_text(encoding="utf-8"))
    baseline_catalog = [
        {
            "revenue_region": item["revenue_region"],
            "rdo_name": item["rdo_name"],
            "province": item.get("province") or "",
            "details": item.get("details") or "",
            "download_url": item["download_url"],
            "sha256": item["sha256"],
        }
        for item in download_inventory
    ]
    region_codes = sorted(
        {
            match.group(1).upper()
            for item in baseline_catalog
            if (match := re.search(r"Revenue Region\s+([0-9]+[A-Z]?)", item["revenue_region"], re.I))
        },
        key=lambda value: (int(re.match(r"\d+", value).group()), value),
    )
    region_feeds: dict[str, set[str]] = defaultdict(set)
    region_names: dict[str, str] = {}
    for item in source_manifest.get("entries", []):
        match = re.search(r"Revenue Region\s+([0-9]+[A-Z]?)", item.get("revenue_region") or "", re.I)
        dataset_id = str(item.get("dataset_id") or "").strip()
        if match and dataset_id:
            code = match.group(1).upper()
            region_feeds[code].add(dataset_id)
            region_names[code] = item["revenue_region"]
    (OUTPUT / "catalog-baseline.json").write_text(
        json.dumps(baseline_catalog, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    index = {
        "datasetCapturedAt": source_manifest.get("captured_at"),
        "sourcePage": source_manifest.get("source_page"),
        "sourceRows": source_rows,
        "genericRowsExcluded": skipped,
        "records": sum(len(rows) for rows in shards.values()),
        "regionCodes": region_codes,
        "regionFeeds": {code: sorted(region_feeds.get(code, set()), key=int) for code in region_codes},
        "regions": {code: region_names.get(code, f"Revenue Region {code}") for code in region_codes},
        "cities": dict(sorted(cities.items())),
        "shards": shard_manifest,
    }
    (OUTPUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({key: index[key] for key in ("sourceRows", "genericRowsExcluded", "records")}, indent=2))
    print(f"cities={len(cities)} shards={len(shards)}")


if __name__ == "__main__":
    main()
