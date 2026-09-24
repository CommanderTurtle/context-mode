"""Hermes Agent control plane for the canonical context-mode MCP server.

All callbacks are bounded and fail open. Session persistence/routing remains in
the existing JavaScript hooks and SessionDB; this module only translates the
public Hermes plugin lifecycle into that wire protocol.
"""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import os
import shutil
import subprocess
import threading
import uuid
from typing import Any


_TIMEOUT = 2.0
_INDEX_TIMEOUT = 8.0
_MAX_CAPTURE = 2 * 1024 * 1024
_INDEX_THRESHOLD = 16 * 1024
_CTX_PREFIX = "mcp__context_mode__ctx_"
_COMPRESSED_SUMMARY_KEY = "_compressed_summary"
_MAX_TRACKED_SESSIONS = 512
_ALIASES = {"terminal": "Bash", "delegate_task": "Agent", "search_files": "Grep"}
# Mutating/interactive results must remain verbatim. Context-mode's own tools
# are also exempt to prevent recursive indexing.
_RESULT_TOOLS = {"read_file", "search_files", "web_extract", "web_search", "browser_snapshot", "browser_console", "browser_extract"}
_state_lock = threading.RLock()
_index_lock = threading.Lock()
_session_summaries: OrderedDict[str, str | None] = OrderedDict()
_ctx: Any = None


def _sid(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "hermes")


def _project(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("project_dir") or kwargs.get("cwd") or os.getcwd())


def _compaction_fingerprint(history: Any) -> str | None:
    """Identify Hermes' rebuilt history without relying on an unshipped hook flag.

    Hermes invokes ``pre_llm_call`` after compaction and passes the rebuilt
    in-memory message list as ``conversation_history``. Its exact
    ``_compressed_summary`` metadata is still present there (wire sanitizers
    remove it only later). Hashing only those marked messages lets us detect a
    new compaction once while ignoring the same summary on following turns.
    """
    if not isinstance(history, list):
        return None
    summaries = [
        {
            "role": message.get("role"),
            "content": message.get("content"),
            "has_user_turn": message.get("_compressed_summary_has_user_turn"),
            "micro": message.get("_micro_compact_marker"),
        }
        for message in history
        if isinstance(message, dict) and message.get(_COMPRESSED_SUMMARY_KEY) is True
    ]
    if not summaries:
        return None
    try:
        encoded = json.dumps(
            summaries,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=lambda value: f"<{type(value).__module__}.{type(value).__qualname__}>",
        ).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded).hexdigest()


def _remember_session(sid: str, fingerprint: str | None) -> tuple[bool, str | None]:
    """Return prior state and retain a bounded per-process compaction edge."""
    known = sid in _session_summaries
    previous = _session_summaries.get(sid)
    if fingerprint is not None or not known:
        _session_summaries[sid] = fingerprint
    _session_summaries.move_to_end(sid)
    while len(_session_summaries) > _MAX_TRACKED_SESSIONS:
        _session_summaries.popitem(last=False)
    return known, previous


def _run_hook(event: str, payload: dict[str, Any], timeout: float = _TIMEOUT) -> dict[str, Any] | None:
    executable = os.environ.get("CONTEXT_MODE_EXECUTABLE") or shutil.which("context-mode")
    if not executable:
        return None
    env = os.environ.copy()
    env["CONTEXT_MODE_PLATFORM"] = "hermes"
    try:
        proc = subprocess.run(
            [executable, "hook", "hermes", event], input=json.dumps(payload), text=True,
            capture_output=True, timeout=timeout, env=env, check=False,
        )
        if proc.returncode != 0 or len(proc.stdout) > _MAX_CAPTURE:
            return None
        text = proc.stdout.strip()
        return json.loads(text) if text else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _pre_tool_call(tool_name: str, args: dict[str, Any], **kwargs: Any) -> dict[str, str] | None:
    payload = {"tool_name": _ALIASES.get(tool_name, tool_name), "tool_input": args,
               "session_id": _sid(kwargs), "cwd": _project(kwargs)}
    response = _run_hook("pretooluse", payload)
    # Hermes' public pre_tool_call API supports veto, not argument rewriting.
    if response and response.get("hookSpecificOutput", {}).get("permissionDecision") == "deny":
        return {"action": "block", "message": str(response["hookSpecificOutput"].get("permissionDecisionReason") or "Blocked by context-mode routing")}
    return None


def _post_tool_call(tool_name: str, args: dict[str, Any], result: Any, **kwargs: Any) -> None:
    _run_hook("posttooluse", {"tool_name": _ALIASES.get(tool_name, tool_name),
        "tool_input": args, "tool_response": result, "session_id": _sid(kwargs),
        "cwd": _project(kwargs)})


def _pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    sid = _sid(kwargs)
    prompt = ""
    if isinstance(kwargs.get("user_message"), str):
        prompt = kwargs["user_message"]
    if prompt:
        _run_hook("userpromptsubmit", {"prompt": prompt, "session_id": sid, "cwd": _project(kwargs)})
    fingerprint = _compaction_fingerprint(kwargs.get("conversation_history"))
    with _state_lock:
        known, previous = _remember_session(sid, fingerprint)
        first = not known or bool(kwargs.get("is_first_turn"))
    # ``compaction_applied`` is retained for forward compatibility. Current
    # Hermes does not send it, so the exact summary-metadata edge is the live
    # signal. Compact wins over ``is_first_turn`` because session rotation can
    # intentionally clear the flush baseline during the compaction turn.
    compact = bool(kwargs.get("compaction_applied")) or (
        fingerprint is not None and fingerprint != previous
    )
    source = "compact" if compact else ("startup" if first else None)
    if source:
        response = _run_hook("sessionstart", {"source": source, "session_id": sid, "cwd": _project(kwargs)})
        context = response.get("hookSpecificOutput", {}).get("additionalContext") if response else None
        if isinstance(context, str) and context:
            # Hermes deliberately injects plugin context into the current user
            # message; ``context`` is the only accepted result key.
            return {"context": context}
    return None


def _session_boundary(source: str, **kwargs: Any) -> None:
    sid = _sid(kwargs)
    if source in {"resume", "clear"}:
        _run_hook("sessionstart", {"source": source, "session_id": sid, "cwd": _project(kwargs)})
    else:
        _run_hook("stop", {"session_id": sid, "cwd": _project(kwargs)})
    if source in {"clear", "finalize"}:
        with _state_lock: _session_summaries.pop(sid, None)


def _dispatch_index(args: dict[str, Any]) -> Any:
    """Bound one MCP index dispatch without accumulating abandoned workers."""
    if _ctx is None or not _index_lock.acquire(blocking=False):
        return None
    done = threading.Event()
    outcome: dict[str, Any] = {}
    ctx = _ctx

    def run() -> None:
        try:
            outcome["value"] = ctx.dispatch_tool(_CTX_PREFIX + "index", args)
        except Exception as exc:
            outcome["error"] = exc
        finally:
            _index_lock.release()
            done.set()

    threading.Thread(target=run, name="context-mode-index", daemon=True).start()
    if not done.wait(_INDEX_TIMEOUT) or "error" in outcome:
        return None
    return outcome.get("value")


def _transform(tool_name: str, result: Any, **kwargs: Any) -> str | None:
    if _ctx is None or tool_name.startswith(_CTX_PREFIX) or tool_name not in _RESULT_TOOLS:
        return None
    text = result if isinstance(result, str) else json.dumps(result, default=str)
    if len(text.encode("utf-8")) < _INDEX_THRESHOLD:
        return None
    call_id = str(kwargs.get("tool_call_id") or uuid.uuid4().hex)
    source = f"hermes:{tool_name}:{_sid(kwargs)}:{call_id}"
    try:
        indexed = _dispatch_index({"content": text, "source": source})
        parsed = json.loads(indexed) if isinstance(indexed, str) else indexed
        if not isinstance(parsed, dict) or parsed.get("isError") or parsed.get("error") or parsed.get("success") is False:
            return None
        confirmed = parsed.get("success") is True
        if not confirmed and isinstance(parsed.get("content"), list):
            confirmed = any("Indexed " in str(item.get("text", "")) for item in parsed["content"] if isinstance(item, dict))
        if not confirmed:
            return None
    except Exception:
        return None
    return f'[context-mode: indexed {len(text.encode("utf-8"))} bytes from {tool_name} as source "{source}". Use mcp__context_mode__ctx_search to retrieve details.]'


def _command(tool: str, raw_args: str = "") -> str:
    args = {"queries": [raw_args]} if tool == "search" else {}
    return _ctx.dispatch_tool(_CTX_PREFIX + tool, args)


def register(ctx: Any) -> None:
    global _ctx
    _ctx = ctx
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    # on_session_end is the canonical once-per-run turn boundary, avoiding
    # duplicate Stop events from post_llm_call.
    ctx.register_hook("on_session_end", lambda **kw: _session_boundary("turn", **kw))
    ctx.register_hook("on_session_finalize", lambda **kw: _session_boundary("finalize", **kw))
    ctx.register_hook("on_session_reset", lambda **kw: _session_boundary("clear", **kw))
    ctx.register_hook("transform_tool_result", _transform)
    ctx.register_command("ctx-stats", lambda raw_args="": _command("stats", raw_args), "Show context-mode statistics")
    ctx.register_command("ctx-doctor", lambda raw_args="": _command("doctor", raw_args), "Run context-mode diagnostics")
    ctx.register_command("ctx-search", lambda raw_args="": _command("search", raw_args), "Search indexed context", "<query>")
