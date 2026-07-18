"""One-off/dev-time build script: converts the real source files (master site
list xlsx, admin2 + catchment shapefiles) into the static data/ and geo/
files the frontend and serverless API read at runtime.

This is NOT part of the serverless API's request path — geopandas/openpyxl
are dev-time dependencies only (see requirements-dev.txt), keeping the actual
Vercel function lightweight (httpx only).

Usage: python build_data.py
"""

from __future__ import annotations

import csv
import json

import geopandas as gpd
import openpyxl
import pandas as pd
from shapely.geometry import Point

MASTER_LIST_PATH = "ML/UPDATED IDP Site Master List -2nd Quarter 2026 _FINAL_v6.xlsx"
ADMIN2_SHAPEFILE = "Somali Maps/somalia_admin2/Som_Admbnda_Adm2_UNDP.shp"
CATCHMENT_SHAPEFILE = "Somali Maps/catchments/2025_CA_Shapefiles_V01/2025_CA_Shapefiles_V01.shp"

SECTORS = (
    "CCCM", "General Protection", "Child Protection", "GBV", "HLP",
    "Food Security and Livelihoods", "Health", "Education", "Nutrition",
    "Shelter/NFI", "WASH",
)
PARTNER_TYPES = ("United Nations", "International NGO", "National NGO", "Government", "Local authority", "Other")


def load_master_sheet() -> pd.DataFrame:
    wb = openpyxl.load_workbook(MASTER_LIST_PATH, read_only=True, data_only=True)
    ws = wb["CCCM IDP Site List (Partners)"]
    rows = list(ws.iter_rows(min_row=3, values_only=True))
    columns = [
        "cccm_site_id", "region", "district", "site_name", "latitude", "longitude",
        "neighbourhood", "neighbourhood_type", "date_established", "households",
        "individuals", "population_source", "cccm_partner", "record_status",
    ]
    df = pd.DataFrame(rows, columns=columns)
    return df[df["cccm_site_id"].notna()].copy()


def _catchment_label(row) -> str | None:
    """District-qualified catchment label, e.g. "Kismaayo · CA04".

    Catchment codes repeat across districts (CA01 exists in Baidoa, Kismaayo
    AND Daynile) — a bare "CA01" key silently merges three different areas,
    so every catchment reference in the pipeline uses this qualified label.
    Built dynamically from the shapefile's own ADM2_Dis: new districts appear
    automatically when the cluster ships updated CA shapefiles.
    """
    catchment = row.get("Catchment")
    if catchment is None or (isinstance(catchment, float) and pd.isna(catchment)):
        return None
    district = row.get("ADM2_Dis") or ""
    # Keep district naming consistent with the master list (Baydhaba -> Baidoa etc.).
    district = MASTER_DISTRICT_ALIASES.get(district, district)
    return f"{district} · {catchment}" if district else str(catchment)


# Shapefile district spelling -> master-list spelling, derived at import time
# from the p-code normalization (see build_admin_pcodes_json); seeded with the
# one known divergence so catchment labels stay consistent even on a fresh run.
MASTER_DISTRICT_ALIASES = {"Baydhaba": "Baidoa"}


def spatial_join_catchment(df: pd.DataFrame, catchments: gpd.GeoDataFrame) -> pd.DataFrame:
    has_coords = df["latitude"].notna() & df["longitude"].notna()
    geometry = [Point(lon, lat) if has else None for lat, lon, has in zip(df["latitude"], df["longitude"], has_coords)]
    gdf = gpd.GeoDataFrame(df.copy(), geometry=geometry, crs=4326)
    joined = gpd.sjoin(gdf[has_coords], catchments[["Catchment", "ADM2_Dis", "geometry"]], how="left", predicate="within")
    joined = joined[~joined.index.duplicated(keep="first")]
    df.loc[has_coords, "catchment"] = joined.apply(_catchment_label, axis=1)
    return df


def build_master_sites_csv(df: pd.DataFrame) -> None:
    with open("data/master-sites.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "cccm_site_id", "site_name", "alternative_names", "region", "district", "catchment",
            "latitude", "longitude", "households", "individuals", "record_status",
        ])
        for _, row in df.iterrows():
            writer.writerow([
                row["cccm_site_id"], row["site_name"], "", row["region"], row["district"],
                row.get("catchment") or "",
                "" if pd.isna(row["latitude"]) else row["latitude"],
                "" if pd.isna(row["longitude"]) else row["longitude"],
                "" if pd.isna(row["households"]) else int(row["households"]),
                "" if pd.isna(row["individuals"]) else int(row["individuals"]),
                row.get("record_status") or "",
            ])
    print(f"Wrote data/master-sites.csv ({len(df)} sites)")


def build_agencies_csv(df: pd.DataFrame) -> None:
    agencies = sorted(set(df["cccm_partner"].dropna().astype(str).str.strip()) - {""})
    with open("data/agencies.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["agency_name", "partner_type"])
        for name in agencies:
            writer.writerow([name, ""])  # partner_type left for manual/admin curation
    print(f"Wrote data/agencies.csv ({len(agencies)} agencies observed in master list)")


def build_sectors_csv() -> None:
    with open("data/sectors.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["sector_name", "sort_order"])
        for i, name in enumerate(SECTORS):
            writer.writerow([name, i])
    print("Wrote data/sectors.csv")


def build_services_csv() -> None:
    # Placeholder — populate once the Kobo XLSForm's per-sector service list is confirmed (Phase 1 discovery).
    with open("data/services.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["sector_name", "service_name"])
    print("Wrote data/services.csv (empty placeholder — populate from confirmed XLSForm)")


def build_admin_pcodes_json(admin2: gpd.GeoDataFrame, master_df: pd.DataFrame) -> None:
    """Kobo submissions store region/district as p-codes (e.g. 'SO14',
    'SO2801'), not names — this lookup lets the API resolve them without
    needing geopandas at request time.

    Names are normalized to the CCCM master list's spelling wherever possible
    (the master list is this project's naming authority): master sites are
    spatially joined to the admin2 polygons, and each polygon takes the most
    common master-list region/district name of the sites inside it. This is
    what merges e.g. UNDP's "Baydhaba" with the master list's "Baidoa" into
    one filter entry, without hardcoding any district list. Polygons with no
    master sites keep their UNDP name.
    """
    has_coords = master_df["latitude"].notna() & master_df["longitude"].notna()
    site_points = gpd.GeoDataFrame(
        master_df[has_coords][["region", "district"]].copy(),
        geometry=[Point(lon, lat) for lat, lon in zip(master_df[has_coords]["latitude"], master_df[has_coords]["longitude"])],
        crs=4326,
    )
    admin2 = admin2.to_crs(4326).reset_index(drop=True)
    joined = gpd.sjoin(site_points, admin2[["admin2Pcod", "admin1Pcod", "geometry"]], how="inner", predicate="within")

    district_name_override = (
        joined.groupby("admin2Pcod")["district"].agg(lambda s: s.mode().iloc[0]).to_dict()
    )
    region_name_override = (
        joined.groupby("admin1Pcod")["region"].agg(lambda s: s.mode().iloc[0]).to_dict()
    )

    regions = {}
    districts = {}
    overridden = 0
    for _, row in admin2.iterrows():
        region_name = region_name_override.get(row["admin1Pcod"], row["admin1Name"])
        district_name = district_name_override.get(row["admin2Pcod"], row["admin2Name"])
        if district_name != row["admin2Name"]:
            overridden += 1
        regions.setdefault(row["admin1Pcod"], region_name)
        districts[row["admin2Pcod"]] = {"name": district_name, "region_code": row["admin1Pcod"]}
    with open("data/admin-pcodes.json", "w", encoding="utf-8") as f:
        json.dump({"regions": regions, "districts": districts}, f, indent=2, ensure_ascii=False)
    print(
        f"Wrote data/admin-pcodes.json ({len(regions)} regions, {len(districts)} districts, "
        f"{overridden} district names normalized to master-list spelling)"
    )


def build_geojson(admin2: gpd.GeoDataFrame, catchments: gpd.GeoDataFrame) -> None:
    admin2 = admin2.to_crs(4326)
    catchments = catchments.to_crs(4326)

    # Use the same master-list-normalized names as admin-pcodes.json so the
    # map's click-to-filter district names match the records' district names.
    with open("data/admin-pcodes.json", encoding="utf-8") as f:
        pcodes = json.load(f)
    admin2 = admin2.copy()
    admin2["admin2Name"] = admin2["admin2Pcod"].map(lambda c: pcodes["districts"].get(c, {}).get("name")).fillna(admin2["admin2Name"])
    admin2["admin1Name"] = admin2["admin1Pcod"].map(pcodes["regions"]).fillna(admin2["admin1Name"])

    districts = admin2[["admin2Name", "admin2Pcod", "admin1Name", "admin1Pcod", "geometry"]].rename(
        columns={"admin2Name": "name", "admin2Pcod": "code", "admin1Name": "region", "admin1Pcod": "region_code"}
    )
    districts.geometry = districts.simplify(0.005, preserve_topology=True)
    districts.to_file("geo/districts.geojson", driver="GeoJSON")

    regions = admin2.dissolve(by="admin1Pcod").reset_index()[["admin1Name", "admin1Pcod", "geometry"]].rename(
        columns={"admin1Name": "name", "admin1Pcod": "code"}
    )
    regions.geometry = regions.simplify(0.01, preserve_topology=True)
    regions.to_file("geo/regions.geojson", driver="GeoJSON")

    cat = catchments[["Catchment", "ADM2_Dis", "geometry"]].copy()
    cat["name"] = cat.apply(_catchment_label, axis=1)  # district-qualified, matches record labels
    cat = cat.rename(columns={"ADM2_Dis": "district"})[["name", "district", "geometry"]]
    cat.geometry = cat.simplify(0.002, preserve_topology=True)
    cat.to_file("geo/catchments.geojson", driver="GeoJSON")

    print("Wrote geo/districts.geojson, geo/regions.geojson, geo/catchments.geojson")


def main() -> None:
    df = load_master_sheet()
    admin2 = gpd.read_file(ADMIN2_SHAPEFILE)
    catchments = gpd.read_file(CATCHMENT_SHAPEFILE)
    df = spatial_join_catchment(df, catchments)

    build_master_sites_csv(df)
    build_agencies_csv(df)
    build_sectors_csv()
    build_services_csv()
    build_admin_pcodes_json(admin2, df)  # must run before build_geojson (it reads the pcode file)
    build_geojson(admin2, catchments)


if __name__ == "__main__":
    main()
