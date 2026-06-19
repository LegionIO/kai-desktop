#!/usr/bin/env python3
"""AT-SPI helper for Kai on Linux.

Speaks the same NDJSON protocol as the other platform helpers
(see electron/platform/helper-process.ts). Provides text-field
introspection and a shallow UI-tree dump for the focused application
via the AT-SPI2 accessibility bus.
"""

import json
import sys
import traceback

try:
    import gi  # type: ignore

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # type: ignore

    ATSPI_AVAILABLE = True
    ATSPI_ERROR = None
except Exception as exc:  # pragma: no cover - import guard
    ATSPI_AVAILABLE = False
    ATSPI_ERROR = str(exc)


def respond(req_id: int, ok: bool, data=None, error: str | None = None) -> None:
    payload: dict = {"id": req_id, "ok": ok}
    if ok and data is not None:
        payload["data"] = data
    if not ok:
        payload["error"] = error or "unknown error"
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def focused_accessible():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            state = app.get_state_set()
        except Exception:
            continue
        if state and state.contains(Atspi.StateType.ACTIVE):
            return find_focused(app)
    return None


def find_focused(node, depth: int = 0):
    if node is None or depth > 64:
        return None
    try:
        st = node.get_state_set()
    except Exception:
        return None
    if st and st.contains(Atspi.StateType.FOCUSED):
        return node
    for i in range(node.get_child_count()):
        found = find_focused(node.get_child_at_index(i), depth + 1)
        if found is not None:
            return found
    return None


def element_signature(node) -> str:
    parts: list[str] = []
    try:
        app = node.get_application()
        parts.append(str(app.get_process_id()) if app else "0")
    except Exception:
        parts.append("0")
    cur = node
    hops = 0
    while cur is not None and hops < 32:
        try:
            parts.append(str(cur.get_index_in_parent()))
            cur = cur.get_parent()
        except Exception:
            break
        hops += 1
    return ":".join(parts)


def read_text_field():
    node = focused_accessible()
    if node is None:
        return None
    try:
        text = node.get_text_iface()
    except Exception:
        text = None
    if text is None:
        return None
    try:
        value = text.get_text(0, text.get_character_count())
    except Exception:
        value = ""
    sel_start = sel_end = text.get_caret_offset()
    try:
        if text.get_n_selections() > 0:
            sel_start, sel_end = text.get_selection(0)
    except Exception:
        pass
    role = None
    try:
        role = node.get_role_name()
    except Exception:
        pass
    return {
        "value": value,
        "selectionStart": int(sel_start),
        "selectionEnd": int(sel_end),
        "elementSignature": element_signature(node),
        "role": role,
    }


def write_text_field(value: str, sel_start, sel_end):
    node = focused_accessible()
    if node is None:
        return False
    try:
        editable = node.get_editable_text_iface()
    except Exception:
        editable = None
    if editable is None:
        return False
    try:
        editable.set_text_contents(value)
    except Exception:
        return False
    try:
        text = node.get_text_iface()
        if text is not None:
            caret = sel_start if isinstance(sel_start, int) else len(value)
            text.set_caret_offset(caret)
            if isinstance(sel_start, int) and isinstance(sel_end, int) and sel_end > sel_start:
                text.set_selection(0, sel_start, sel_end)
    except Exception:
        pass
    return True


def selected_text():
    node = focused_accessible()
    if node is None:
        return None
    try:
        text = node.get_text_iface()
    except Exception:
        return None
    if text is None:
        return None
    try:
        if text.get_n_selections() > 0:
            s, e = text.get_selection(0)
            return text.get_text(s, e)
    except Exception:
        pass
    return None


def active_application():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            if app.get_state_set().contains(Atspi.StateType.ACTIVE):
                return app
        except Exception:
            continue
    return None


def walk(node, depth: int, max_depth: int):
    out: dict = {}
    try:
        out["role"] = node.get_role_name()
    except Exception:
        out["role"] = "unknown"
    try:
        name = node.get_name()
        if name:
            out["name"] = name
    except Exception:
        pass
    try:
        ext = node.get_extents(Atspi.CoordType.SCREEN)
        if ext and ext.width > 0:
            out["bounds"] = {"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height}
    except Exception:
        pass
    if depth < max_depth:
        children = []
        try:
            count = min(node.get_child_count(), 64)
            for i in range(count):
                child = node.get_child_at_index(i)
                if child is not None:
                    children.append(walk(child, depth + 1, max_depth))
        except Exception:
            pass
        if children:
            out["children"] = children
    return out


def ui_tree(max_depth: int):
    app = active_application()
    if app is None:
        return None
    return walk(app, 0, max(1, max_depth))


HANDLERS = {
    "ping": lambda _a: {"pong": True, "atspi": ATSPI_AVAILABLE},
    "readTextField": lambda _a: read_text_field(),
    "writeTextField": lambda a: {"ok": write_text_field(a.get("value", ""), a.get("selectionStart"), a.get("selectionEnd"))},
    "selectedText": lambda _a: {"text": selected_text()},
    "uiTree": lambda a: {"root": ui_tree(int(a.get("maxDepth", 4)))},
}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        req_id = int(req.get("id", 0))
        cmd = str(req.get("cmd", ""))
        args = req.get("args") or {}

        if not ATSPI_AVAILABLE:
            respond(req_id, False, error=f"AT-SPI unavailable: {ATSPI_ERROR}")
            continue

        handler = HANDLERS.get(cmd)
        if handler is None:
            respond(req_id, False, error=f"unknown command '{cmd}'")
            continue
        try:
            result = handler(args)
            if result is None and cmd in ("readTextField",):
                respond(req_id, False, error="no focused text element")
            else:
                respond(req_id, True, data=result)
        except Exception:
            respond(req_id, False, error=traceback.format_exc(limit=2))


if __name__ == "__main__":
    main()
