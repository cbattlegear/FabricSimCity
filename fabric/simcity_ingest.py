"""
Pure logic for the FabricSimCity capacity metrics ingest.

Kept free of every Fabric import so it can be executed and tested on an ordinary machine — see
`src/collect/ingestNotebook.test.ts`, which runs this file under Python and checks the two
substitution traps below. The notebook cell that does I/O imports from here rather than restating
any of it.

Two things in here fail as wrong numbers rather than as an error, which is why they are tested:

* `bind_dax_parameters` matches whole identifiers. A plain string replace of `@Start` would also
  rewrite the front of `@StartOfDay`, and what it leaves behind is still valid DAX.
* `dax_literal` doubles quotes in strings, which is DAX's own escape, so a capacity id cannot end
  the literal and carry on as expression text.

Both mirror `src/collect/semanticModelDaxClient.ts`. Change one, change the other.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any, Iterable, Mapping, Sequence

# Matches `@Name` as a whole identifier. See the module docstring for why this is not a plain
# replace of each parameter name in turn.
_PARAMETER_REFERENCE = re.compile(r"@([A-Za-z_][A-Za-z0-9_]*)")

# Accepts the ISO-8601 shapes the app emits. Anything else is treated as an ordinary string, so a
# capacity name that merely looks date-ish is still quoted rather than turned into arithmetic.
_ISO_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)

# `executeQueries` and `sempy` both return bracketed column names: `[CapacityId]` for a
# SELECTCOLUMNS alias, `Table[Column]` for a bare column reference.
_BRACKETED_KEY = re.compile(r"\[([^\[\]]+)\]$")


class IngestError(RuntimeError):
    """Raised for a condition the operator has to fix, rather than one to retry."""


def parse_iso(value: str) -> _dt.datetime | None:
    """Parse an ISO timestamp to an aware UTC datetime, or return None if it is not one."""
    if not isinstance(value, str) or not _ISO_TIMESTAMP.match(value):
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def dax_literal(value: Any) -> str:
    """Render a Python value as a DAX literal.

    Timestamps become `DATE(...) + TIME(...)` rather than a quoted string because DAX comparison
    against text is a type error in some models and silently coerces in others; built
    arithmetically it is unambiguous in both.
    """
    if value is None:
        return "BLANK()"
    if isinstance(value, bool):
        return "TRUE()" if value else "FALSE()"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise IngestError(f"Cannot bind non-finite number {value!r} into DAX.")
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, _dt.datetime):
        return _timestamp_literal(value)

    text = str(value)
    timestamp = parse_iso(text)
    if timestamp is not None:
        return _timestamp_literal(timestamp)
    escaped = text.replace('"', '""')
    return f'"{escaped}"'


def _timestamp_literal(value: _dt.datetime) -> str:
    utc = value.astimezone(_dt.timezone.utc) if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    return (
        f"(DATE({utc.year},{utc.month},{utc.day})"
        f" + TIME({utc.hour},{utc.minute},{utc.second}))"
    )


def bind_dax_parameters(query: str, parameters: Mapping[str, Any]) -> str:
    """Substitute `@Name` placeholders with DAX literals.

    An unbound placeholder is a bug in the generated query, so it raises rather than being left in
    the text for the model to reject with a less specific message.
    """

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in parameters:
            raise IngestError(
                f"DAX query references {match.group(0)} but no such parameter was supplied."
            )
        return dax_literal(parameters[name])

    return _PARAMETER_REFERENCE.sub(replace, query)


def normalize_row_key(key: str) -> str:
    """Strip the brackets DAX transports wrap column names in."""
    match = _BRACKETED_KEY.search(key)
    return match.group(1) if match else key


def normalize_row(row: Mapping[str, Any]) -> dict[str, Any]:
    return {normalize_row_key(str(key)): value for key, value in row.items()}


def probe_tables(rows: Iterable[Mapping[str, Any]]) -> dict[str, set[str]]:
    """Turn schema-probe rows into a table name -> column names map.

    Mirrors `schemaTables` in `semanticModelSource.ts`, including its fallback from the
    `TableName`/`ColumnName` aliases to the bare `Table`/`Name` columns of `INFO.VIEW.COLUMNS()`.
    """
    tables: dict[str, set[str]] = {}
    for raw in rows:
        row = normalize_row(raw)
        table = row.get("TableName", row.get("Table"))
        column = row.get("ColumnName", row.get("Name"))
        if not isinstance(table, str) or not isinstance(column, str):
            continue
        tables.setdefault(table, set()).add(column)
    return tables


def pick_generation(
    manifest: Mapping[str, Any],
    probe_rows: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    """Choose the manifest entry matching the model, by the same rule the app applies.

    Selecting differently to `createSemanticModelSource` would be the worst kind of mismatch: the
    notebook would ingest one generation's rows and the app would parse them as the other's, which
    reads as a model with every value missing rather than as an error.
    """
    tables = probe_tables(probe_rows)
    mismatches: list[str] = []
    for generation in manifest["generations"]:
        required_tables = generation.get(
            "requiredTables", {generation["table"]: generation["requiredColumns"]}
        )
        missing_tables: list[str] = []
        for table, required in required_tables.items():
            columns = tables.get(table)
            if columns is None:
                missing_tables.append(f"{table}: table absent")
            else:
                missing = sorted(set(required) - columns)
                if missing:
                    missing_tables.append(f"{table}: missing columns {', '.join(missing)}")
        if not missing_tables:
            return generation
        mismatches.append(f"{generation['name']} ({'; '.join(missing_tables)})")

    seen = ", ".join(sorted(tables)[:10]) or "no tables at all"
    preview = " (first 10)" if len(tables) > 10 else ""
    raise IngestError(
        "Capacity Metrics semantic model matched no known schema generation. "
        f"Expected schemas: {'; '.join(mismatches)}. "
        f"The probe returned {len(tables)} tables{preview}: {seen}."
    )


def probe_rows_for_table(rows: Iterable[Mapping[str, Any]], table: str) -> list[dict[str, Any]]:
    """Keep only the probe rows describing the table the app will look up.

    `INFO.VIEW.COLUMNS()` describes the entire model. The generation helper calls this for each
    required fact or dimension table so unrelated tables do not multiply the size of every ingest.
    """
    kept: list[dict[str, Any]] = []
    for raw in rows:
        row = normalize_row(raw)
        name = row.get("TableName", row.get("Table"))
        if name == table:
            kept.append(row)
    return kept


def probe_rows_for_generation(
    rows: Sequence[Mapping[str, Any]], generation: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Keep dimensions as well as the fact table so the reader can detect the same schema."""
    tables = generation.get("requiredTables", {generation["table"]: generation["requiredColumns"]})
    return [row for table in tables for row in probe_rows_for_table(rows, table)]


def capacity_ids(rows: Iterable[Mapping[str, Any]], capacity_id_column: str) -> list[str]:
    """Distinct capacity ids from the summary rows, in first-seen order."""
    seen: list[str] = []
    known: set[str] = set()
    for raw in rows:
        row = normalize_row(raw)
        value = row.get(capacity_id_column)
        if isinstance(value, str) and value and value not in known:
            known.add(value)
            seen.append(value)
    return seen


def _utc_datetime(value: _dt.datetime) -> _dt.datetime | None:
    # pandas.NaT is a datetime subclass that compares unequal to itself, not a usable timestamp.
    if value != value:
        return None
    aware = value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    return aware.astimezone(_dt.timezone.utc)


def row_timestamp(row: Mapping[str, Any], timestamp_column: str) -> _dt.datetime | None:
    """Lift a row's own timepoint out, so the reader can window it in SQL."""
    value = normalize_row(row).get(timestamp_column)
    if isinstance(value, _dt.datetime):
        return _utc_datetime(value)
    if isinstance(value, str):
        return parse_iso(value)
    return None


def json_safe(value: Any) -> Any:
    """Coerce a DAX cell into something `json.dumps` accepts and the TypeScript parser reads back.

    Timestamps are rendered as ISO strings because that is what the app's contracts carry, and what
    `semanticModelSource` parses with `Date.parse`.
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return None if value != value else value
    if isinstance(value, _dt.datetime):
        timestamp = _utc_datetime(value)
        return timestamp.isoformat().replace("+00:00", "Z") if timestamp is not None else None
    if isinstance(value, _dt.date):
        return value.isoformat()
    return str(value)


# The `rowJson` column is NVARCHAR(3500). A row wider than that is a schema change worth failing
# on rather than truncating, because a truncated row is unparseable JSON that would surface much
# later as a corrupt-row error with no hint of where it came from.
ROW_JSON_LIMIT = 3500


def encode_row(row: Mapping[str, Any], query_name: str, row_index: int) -> str:
    payload = json.dumps({str(k): json_safe(v) for k, v in row.items()}, separators=(",", ":"))
    if len(payload) > ROW_JSON_LIMIT:
        raise IngestError(
            f"{query_name} row {row_index} serializes to {len(payload)} characters, over the "
            f"{ROW_JSON_LIMIT} the rowJson column holds."
        )
    return payload
