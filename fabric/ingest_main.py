"""
Fabric side of the FabricSimCity capacity metrics ingest.

Runs the DAX from `fabric/dax-queries.generated.json` against the Capacity Metrics semantic model
and writes the rows into the Rayfin app's SQL database, where the deployed app reads them back.

Everything the app needs to interpret those rows already exists in TypeScript, so this file does no
interpretation: it stores rows exactly as the model returned them. See `src/collect/ingestedDax.ts`.
"""

from __future__ import annotations

import datetime as _dt
import json
import struct
import uuid
from pathlib import Path

# In the notebook these come from the logic cell above, which has already run; outside it they come
# from the file that cell is generated from. Written this way so both the notebook and the tests
# execute exactly the same code.
if "bind_dax_parameters" not in globals():  # pragma: no cover - notebook path
    from simcity_ingest import (  # noqa: F401
        IngestError,
        bind_dax_parameters,
        capacity_ids,
        encode_row,
        normalize_row,
        pick_generation,
        probe_rows_for_generation,
        probe_tables,
        row_timestamp,
    )

# Must equal DAX_MANIFEST_VERSION in `src/collect/daxManifest.ts`. Pinned by `ingestNotebook.test.ts`.
DAX_MANIFEST_VERSION = 3

# PARAMETERS -------------------------------------------------------------------------------------
# Tag this cell "Parameters" in the Fabric notebook so a schedule or pipeline can override them.

# The Capacity Metrics semantic model. Find both ids in the Fabric portal URL when the model is
# open: /groups/<METRICS_WORKSPACE_ID>/datasets/<METRICS_DATASET_ID>. The metrics app installs into
# its own workspace, so this is not the workspace your app is deployed to.
METRICS_DATASET_ID = ""
METRICS_WORKSPACE_ID = ""

# The Rayfin app's SQL database. Copy from the SQL Database child item of your Fabric data app:
# Settings -> Connection strings. SQL_SERVER is the host only, with no `tcp:` prefix or port.
SQL_SERVER = ""
SQL_DATABASE = ""

# Written to every row. Must match what the app passes as its tenant, which is
# VITE_FABRIC_TENANT_ID, falling back to VITE_FABRIC_WORKSPACE_ID.
TENANT_ID = ""

# How much history to pull. Must match VITE_FABRIC_INGEST_WINDOW_DAYS in the app, which is what it
# declares as the source's retention. `ingestNotebook.test.ts` pins the two together.
INGEST_WINDOW_DAYS = 3

# How often this notebook is scheduled. Must match VITE_FABRIC_INGEST_INTERVAL_MINUTES, which the
# app adds to the model's own lag to report how stale the city may be.
INGEST_INTERVAL_MINUTES = 60

# Completed runs to keep. Older ones and their rows are deleted at the end of a successful run, so
# the table does not grow without bound. Keeping more than one means a run that fails midway leaves
# the previous city intact rather than emptying it.
KEEP_RUNS = 3

# Rows per INSERT batch.
BATCH_SIZE = 500
# ------------------------------------------------------------------------------------------------

SQL_RESOURCE = "https://database.windows.net/"
SQL_COPT_SS_ACCESS_TOKEN = 1256


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _iso(value: _dt.datetime) -> str:
    return value.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def connect_sql():
    """Open a token-authenticated connection to the Rayfin database.

    `notebookutils.credentials.getToken` has no documented audience key for SQL, but it accepts a
    resource URI, which is the pattern every Fabric-to-SQL sample uses. The token is passed through
    the ODBC connection attribute rather than the connection string because there is no
    connection-string form for a bearer token.
    """
    import pyodbc  # noqa: PLC0415 - notebook-only dependency
    from notebookutils import credentials  # noqa: PLC0415 - Fabric runtime only

    token = credentials.getToken(SQL_RESOURCE)
    encoded = b"".join(bytes([b]) + b"\x00" for b in token.encode("utf-8"))
    token_struct = struct.pack("=i", len(encoded)) + encoded

    driver = _newest_odbc_driver(pyodbc)
    connection_string = (
        f"Driver={{{driver}}};"
        f"Server={SQL_SERVER};"
        f"Database={SQL_DATABASE};"
        "Encrypt=yes;TrustServerCertificate=no;"
    )
    return pyodbc.connect(
        connection_string,
        attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_struct},
        autocommit=False,
    )


def _newest_odbc_driver(pyodbc) -> str:
    """Pick the newest installed msodbcsql.

    Pinning "ODBC Driver 18 for SQL Server" is the usual advice, but the Fabric runtime image is
    not something this repo controls, and a hard-coded name fails with a driver-not-found error
    that reads like a network problem.
    """
    drivers = [name for name in pyodbc.drivers() if "ODBC Driver" in name and "SQL Server" in name]
    if not drivers:
        raise RuntimeError(
            f"No msodbcsql driver is installed. pyodbc reports: {pyodbc.drivers()}"
        )
    return sorted(drivers)[-1]


def resolve_table(cursor, entity_name: str, required_columns: list[str]) -> str:
    """Find the table Rayfin generated for an entity, and check it has the columns expected.

    Rayfin pluralizes these entity names. Keep singular tables compatible, but never choose the
    first match when multiple schemas or naming generations coexist.
    """
    names = {
        "IngestRun": ("IngestRun", "IngestRuns"),
        "IngestRow": ("IngestRow", "IngestRows"),
    }.get(entity_name, (entity_name,))
    placeholders = ", ".join("LOWER(?)" for _ in names)
    cursor.execute(
        f"""
        SELECT TABLE_SCHEMA, TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND LOWER(TABLE_NAME) IN ({placeholders})
        """,
        *names,
    )
    matches = cursor.fetchall()
    if not matches:
        cursor.execute(
            "SELECT TABLE_SCHEMA + '.' + TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
        )
        found = ", ".join(row[0] for row in cursor.fetchall()) or "no tables at all"
        raise RuntimeError(
            f"No table for entity {entity_name}. Run `npx rayfin up` to apply the schema. "
            f"The database currently has: {found}."
        )

    if len(matches) != 1:
        found = ", ".join(f"{schema}.{table}" for schema, table in matches)
        raise RuntimeError(
            f"Multiple tables match entity {entity_name}: {found}. "
            "Resolve the ambiguity before ingesting; no table was selected."
        )
    schema_name, table_name = matches[0]
    qualified = ".".join("[" + name.replace("]", "]]") + "]" for name in (schema_name, table_name))

    cursor.execute(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        schema_name,
        table_name,
    )
    present = {row[0].lower() for row in cursor.fetchall()}
    missing = [column for column in required_columns if column.lower() not in present]
    if missing:
        raise RuntimeError(
            f"{qualified} is missing {', '.join(missing)}. It was probably created by an older "
            "schema; run `npx rayfin up` to bring it up to date."
        )
    return qualified


def evaluate_dax(query: str):
    """Run one DAX query against the metrics model and return plain dict rows."""
    import sempy.fabric as fabric  # noqa: PLC0415 - Fabric runtime only

    frame = fabric.evaluate_dax(
        dataset=METRICS_DATASET_ID,
        dax_string=query,
        workspace=METRICS_WORKSPACE_ID or None,
    )
    return frame.to_dict(orient="records")


def check_parameters() -> None:
    missing = [
        name
        for name, value in (
            ("METRICS_DATASET_ID", METRICS_DATASET_ID),
            ("SQL_SERVER", SQL_SERVER),
            ("SQL_DATABASE", SQL_DATABASE),
            ("TENANT_ID", TENANT_ID),
        )
        if not value
    ]
    if missing:
        raise IngestError(f"Set these parameters before running: {', '.join(missing)}.")


def run_ingest(manifest: dict) -> str:
    """Ingest one snapshot and return the run id.

    The run row is written first as `Running` and flipped to `Complete` only once every row is in,
    because the app reads the newest `Complete` run and nothing else. A crash halfway therefore
    leaves a partial run that no reader will ever look at, and the previous city stays up.
    """
    check_parameters()
    if manifest.get("version") != DAX_MANIFEST_VERSION:
        raise IngestError(
            f"dax-queries.generated.json is version {manifest.get('version')}, but this notebook "
            f"expects {DAX_MANIFEST_VERSION}. Re-export both from the same commit."
        )

    started = _now()
    window_end = started
    window_start = window_end - _dt.timedelta(days=INGEST_WINDOW_DAYS)
    run_id = str(uuid.uuid4())

    print(f"Probing the semantic model ({METRICS_DATASET_ID}) ...")
    probe = evaluate_dax(manifest["generations"][0]["queries"]["schemaProbe"])
    try:
        generation = pick_generation(manifest, probe)
    except IngestError as error:
        # Export names only, not raw probe fields or telemetry, and still stop before any SQL write.
        tables = probe_tables(probe)
        report = {table: sorted(columns) for table, columns in sorted(tables.items())}
        report_path = Path("builtin/capacity-metrics-schema.json")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        raise IngestError(
            f"{error} Full table/column schema saved to {report_path}. "
            "Download capacity-metrics-schema.json from notebook Resources > Built-in "
            "to update the adapter; do not rename model tables or skip the schema check."
        ) from error
    print(f"Matched schema generation {generation['name']}.")

    queries = generation["queries"]
    window = {"Start": _iso(window_start), "End": _iso(window_end)}

    inventory_query = queries.get("capacityInventory", queries["capacitySummary"])
    inventory_rows = evaluate_dax(bind_dax_parameters(inventory_query, window))
    ids = capacity_ids(inventory_rows, generation["capacityIdColumn"])
    if not ids:
        # A run with no capacities would be marked Complete and render as an empty atlas, which is
        # indistinguishable from a tenant that genuinely has none. Far more likely is that the
        # notebook identity cannot see the metrics model, so say so instead of publishing nothing.
        raise IngestError(
            f"The capacity inventory returned {len(inventory_rows)} row(s) but no capacity ids in "
            f"column '{generation['capacityIdColumn']}'. Check that this notebook's identity can "
            "read the Capacity Metrics semantic model."
        )
    print(f"{len(inventory_rows)} inventory rows covering {len(ids)} capacities.")
    summary_rows = [] if "capacityInventory" in queries else inventory_rows
    contexts = {}
    if "capacityInventory" in queries:
        for raw in inventory_rows:
            row = normalize_row(raw)
            capacity_id = row.get(generation["capacityIdColumn"])
            region = row.get("Region")
            if not isinstance(capacity_id, str) or not capacity_id or not isinstance(region, str) or not region:
                raise IngestError("Capacity inventory must include a capacity id and its routing Region.")
            if capacity_id in contexts and contexts[capacity_id] != region:
                raise IngestError(f"Capacity {capacity_id} has ambiguous routing regions.")
            contexts[capacity_id] = region

    pending: list[tuple] = []

    def stage(query_name: str, capacity_id: str, rows) -> None:
        for index, row in enumerate(rows):
            stamp = row_timestamp(row, generation["timestampColumn"]) if query_name == "timepoints" else None
            pending.append(
                (
                    str(uuid.uuid4()),
                    run_id,
                    TENANT_ID,
                    query_name,
                    capacity_id,
                    index,
                    stamp,
                    encode_row(row, query_name, index),
                )
            )

    stage("schemaProbe", "", probe_rows_for_generation(probe, generation))

    for capacity_id in ids:
        scoped = {"CapacityId": capacity_id, **window}
        if "capacityInventory" in queries:
            scoped["RegionName"] = contexts[capacity_id]
            rows = evaluate_dax(bind_dax_parameters(queries["capacitySummary"], scoped))
            if len(rows) != 1 or normalize_row(rows[0]).get(generation["capacityIdColumn"]) != capacity_id:
                raise IngestError(f"Capacity summary did not return exactly capacity {capacity_id}.")
            summary_rows.extend(rows)
            print(f"  {capacity_id} capacitySummary: {len(rows)} row ({scoped['RegionName']})")
        for query_name in ("cityItems", "operationFamilies", "timepoints"):
            if query_name in generation.get("unavailableQueries", []):
                print(f"  {capacity_id} {query_name}: unavailable in this schema; no samples inferred")
                continue
            rows = evaluate_dax(bind_dax_parameters(queries[query_name], scoped))
            stage(query_name, capacity_id, rows)
            print(f"  {capacity_id} {query_name}: {len(rows)} rows")

    stage("capacitySummary", "", summary_rows)
    connection = connect_sql()
    run_table = None
    try:
        cursor = connection.cursor()
        run_table = resolve_table(
            cursor,
            "IngestRun",
            [
                "id",
                "tenantId",
                "datasetId",
                "schemaGeneration",
                "status",
                "startedAt",
                "completedAt",
                "windowStart",
                "windowEnd",
                "rowCount",
                "failureMessage",
            ],
        )
        row_table = resolve_table(
            cursor,
            "IngestRow",
            ["id", "runId", "tenantId", "queryName", "capacityId", "rowIndex", "rowTimestamp", "rowJson"],
        )

        cursor.execute(
            f"INSERT INTO {run_table} "
            "([id], [tenantId], [datasetId], [schemaGeneration], [status], [startedAt], [windowStart], "
            "[windowEnd], [rowCount]) VALUES (?, ?, ?, ?, 'Running', ?, ?, ?, 0)",
            run_id,
            TENANT_ID,
            METRICS_DATASET_ID,
            generation["name"],
            started,
            window_start,
            window_end,
        )
        connection.commit()

        cursor.fast_executemany = True
        insert = (
            f"INSERT INTO {row_table} "
            "([id], [runId], [tenantId], [queryName], [capacityId], [rowIndex], [rowTimestamp], [rowJson]) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        for start in range(0, len(pending), BATCH_SIZE):
            cursor.executemany(insert, pending[start : start + BATCH_SIZE])
            connection.commit()

        cursor.execute(
            f"UPDATE {run_table} SET [status] = 'Complete', [completedAt] = ?, [rowCount] = ? WHERE [id] = ?",
            _now(),
            len(pending),
            run_id,
        )
        connection.commit()
        print(f"Run {run_id} complete: {len(pending)} rows.")

        prune_old_runs(cursor, connection, run_table, row_table)
    except Exception as error:
        if run_table is not None:
            _mark_failed(connection, run_table, run_id, error)
        raise
    finally:
        connection.close()

    return run_id


def _mark_failed(connection, run_table: str, run_id: str, error: Exception) -> None:
    """Record why a run stopped, so the app can say so instead of only showing stale data."""
    try:
        cursor = connection.cursor()
        cursor.execute(
            f"UPDATE {run_table} SET [status] = 'Failed', [completedAt] = ?, [failureMessage] = ? WHERE [id] = ?",
            _now(),
            str(error)[:1024],
            run_id,
        )
        connection.commit()
    except Exception as secondary:  # pragma: no cover - best effort only
        print(f"Could not record the failure: {secondary}")


def prune_old_runs(cursor, connection, run_table: str, row_table: str) -> None:
    """Delete all but the newest KEEP_RUNS completed runs, rows first."""
    cursor.execute(
        f"SELECT [id] FROM {run_table} WHERE [tenantId] = ? AND [datasetId] = ? "
        "ORDER BY [startedAt] DESC OFFSET ? ROWS",
        TENANT_ID,
        METRICS_DATASET_ID,
        KEEP_RUNS,
    )
    stale = [row[0] for row in cursor.fetchall()]
    for run_id in stale:
        cursor.execute(f"DELETE FROM {row_table} WHERE [runId] = ?", run_id)
        cursor.execute(f"DELETE FROM {run_table} WHERE [id] = ?", run_id)
        connection.commit()
    if stale:
        print(f"Pruned {len(stale)} older run(s).")
