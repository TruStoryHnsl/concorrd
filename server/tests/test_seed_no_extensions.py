"""Regression tests for the P0-sprint Issue 4 "clean seed" invariant.

Locks in two properties that must NOT regress:

1. The bundled extensions catalog (``server/extensions.json``) ships
   EMPTY. Any future PR that bakes a hardcoded extension list back into
   the repo will fail this test before merge.

2. The ``_seed_default_server`` lobby creation function creates ONLY
   text + voice channels — no application/extension channels. Adding
   an "app" entry to its ``channel_defs`` list (or any non-text/voice
   ``channel_type``) trips the runtime assertion inside the function,
   but we exercise the same invariant here at test time so the failure
   surfaces in CI before any operator hits it.

Both checks are *fast* — they read source/JSON files and a small AST
slice. No DB, no Matrix, no network — they run inside the same pytest
unit-test suite as the rest of `server/tests/`.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

_SERVER_ROOT = Path(__file__).resolve().parent.parent


def test_bundled_extensions_catalog_is_empty() -> None:
    """`server/extensions.json` ships as a clean empty array.

    The static-catalog fallback for runtime extension installs reads
    from this file (see ``routers/extensions.py::_load_catalog``).
    Shipping the repo with a populated array means a fresh
    ``docker compose up -d`` would surface those extensions in the
    Extension Library without the operator ever installing them — the
    exact regression the P0-sprint Issue 4 cleanup forbids.
    """
    bundled = _SERVER_ROOT / "extensions.json"
    assert bundled.exists(), "server/extensions.json is missing"
    raw = bundled.read_text()
    parsed = json.loads(raw)
    assert parsed == [], (
        f"server/extensions.json must ship empty; found {len(parsed)} "
        f"entries: {[e.get('id') for e in parsed if isinstance(e, dict)]}"
    )


def test_seed_default_server_only_text_and_voice_channels() -> None:
    """Static check: the literal `channel_defs` list inside
    `_seed_default_server` contains only text and voice tuples.

    We pull the list out of the source AST rather than calling the
    function — the function takes a DB and Matrix bot session, which
    is way out of scope for a unit-test invariant. A future PR that
    adds an ``("orrdia-bridge", "app")`` entry will fail this test
    even before its DB-touching code runs.
    """
    src = (_SERVER_ROOT / "main.py").read_text()
    module = ast.parse(src)

    target_fn: ast.AsyncFunctionDef | None = None
    for node in ast.walk(module):
        if (
            isinstance(node, ast.AsyncFunctionDef)
            and node.name == "_seed_default_server"
        ):
            target_fn = node
            break
    assert target_fn is not None, "_seed_default_server not found in main.py"

    # Find the `channel_defs = [...]` assignment inside the function body.
    channel_defs_node: ast.List | None = None
    for stmt in ast.walk(target_fn):
        if (
            isinstance(stmt, (ast.Assign, ast.AnnAssign))
            and isinstance(getattr(stmt, "value", None), ast.List)
        ):
            # AnnAssign has .target singular; Assign has .targets plural.
            targets = (
                [stmt.target] if isinstance(stmt, ast.AnnAssign) else stmt.targets
            )
            for t in targets:
                if isinstance(t, ast.Name) and t.id == "channel_defs":
                    channel_defs_node = stmt.value  # type: ignore[assignment]
                    break
        if channel_defs_node is not None:
            break
    assert channel_defs_node is not None, (
        "Could not find a `channel_defs = [...]` literal inside "
        "_seed_default_server"
    )

    # Each element must be a 2-tuple literal whose second element is the
    # literal string "text" or "voice".
    bad: list[str] = []
    for elt in channel_defs_node.elts:
        assert isinstance(elt, ast.Tuple) and len(elt.elts) == 2, (
            "channel_defs entries must be 2-tuples"
        )
        name_node, type_node = elt.elts
        ch_type = (
            type_node.value if isinstance(type_node, ast.Constant) else None
        )
        ch_name = (
            name_node.value if isinstance(name_node, ast.Constant) else None
        )
        if ch_type not in ("text", "voice"):
            bad.append(f"{ch_name!r}={ch_type!r}")

    assert not bad, (
        "lobby seed must only create text + voice channels; found "
        f"non-text/voice entries: {bad}. Extensions install at runtime "
        "via the Extension Library, NOT via the seed function."
    )
