#!/usr/bin/env python3
"""Agentworks VM-local durable outbox and stdio MCP bridge.

The bridge intentionally has no Master credential and performs no network access.
The trusted host Worker drains its files over the existing authenticated Worker link.
"""

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile
import uuid


ROOT = pathlib.Path(os.environ.get("AGENTWORKS_BRIDGE_HOME", "~/.agentworks/bridge")).expanduser()
OUTBOX = ROOT / "outbox"
RECEIPTS = ROOT / "receipts"
DELIVERIES = ROOT / "deliveries"
DIRECTORY = ROOT / "directory.json"


def ensure_state():
    for path in (ROOT, OUTBOX, RECEIPTS, DELIVERIES):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)


def atomic_json(path, payload):
    ensure_state()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def enqueue(arguments):
    source = str(
        arguments.get("source")
        or os.environ.get("AGENTWORKS_SESSION_UUID")
        or os.environ.get("AGENTWORKS_SESSION_ADDRESS")
        or ""
    ).strip()
    target = str(arguments.get("target") or "").strip()
    content = str(arguments.get("content") or "").strip()
    if not source:
        raise ValueError("source session is required outside an Agentworks-managed CLI turn")
    if not target or not content:
        raise ValueError("target and content are required")
    if len(content) > 100_000:
        raise ValueError("content exceeds 100000 characters")
    outbox_id = str(uuid.uuid4())
    payload = {
        "outboxId": outbox_id,
        "source": source,
        "target": target,
        "content": content,
        "idempotencyKey": str(arguments.get("idempotency_key") or outbox_id),
        "expectReply": bool(arguments.get("expect_reply", True)),
        "replyTo": arguments.get("reply_to"),
        "createdAt": now(),
    }
    atomic_json(OUTBOX / f"{outbox_id}.json", payload)
    return {"queued": True, "outboxId": outbox_id, "idempotencyKey": payload["idempotencyKey"]}


def enqueue_fanout(arguments):
    raw_targets = arguments.get("targets") or []
    targets = list(dict.fromkeys(str(value).strip() for value in raw_targets if str(value).strip()))
    if not targets:
        raise ValueError("at least one target is required")
    if len(targets) > 100:
        raise ValueError("fanout supports at most 100 unique targets")
    content = str(arguments.get("content") or "").strip()
    if not content:
        raise ValueError("content is required")
    fanout_id = str(uuid.uuid4())
    base_key = str(arguments.get("idempotency_key") or fanout_id)
    deliveries = []
    for index, target in enumerate(targets):
        deliveries.append(enqueue({
            **arguments,
            "target": target,
            "idempotency_key": f"{base_key}:{index}",
            "expect_reply": bool(arguments.get("expect_reply", False)),
        }))
    return {"queued": True, "fanoutId": fanout_id, "count": len(deliveries), "deliveries": deliveries}


def known_sessions(arguments=None):
    value = load_json(DIRECTORY, {"sessions": [], "capturedAt": None})
    if not isinstance(value, dict):
        value = {"sessions": [], "capturedAt": None}
    arguments = arguments or {}
    explicit_source = str(arguments.get("source") or "").strip()
    source_uuid = str(os.environ.get("AGENTWORKS_SESSION_UUID") or "").strip()
    source_address = str(os.environ.get("AGENTWORKS_SESSION_ADDRESS") or explicit_source or "").strip()
    current = next((item for item in value.get("sessions", []) if
                    item.get("sessionUuid") in (source_uuid, explicit_source) or item.get("address") == source_address), None)
    return {
        **value,
        "self": current or ({"sessionUuid": source_uuid, "address": source_address} if source_uuid or source_address else None),
        "capabilities": ["list", "send", "reply", "fanout_send", "durable_status"],
    }


def message_status(arguments):
    message_id = str(arguments.get("message_id") or "").strip()
    receipts = []
    for path in sorted(RECEIPTS.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        value = load_json(path, None)
        if value and (not message_id or value.get("messageId") == message_id or value.get("outboxId") == message_id):
            receipts.append(value)
            if message_id or len(receipts) >= 20:
                break
    pending = []
    for path in sorted(OUTBOX.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        value = load_json(path, None)
        if value and (not message_id or value.get("outboxId") == message_id or value.get("idempotencyKey") == message_id):
            pending.append({**value, "state": "local_outbox"})
    return {"receipts": receipts, "pending": pending}


TOOLS = [
    {
        "name": "sessions_list_known",
        "description": "List sessions visible to this tenant bridge, with canonical namespaced addresses.",
        "inputSchema": {
            "type": "object",
            "properties": {"source": {"type": "string", "description": "Your canonical address from the Agentworks runtime instruction."}},
            "required": ["source"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sessions_send",
        "description": "Durably enqueue an inter-session message. Delivery survives VM, Worker, or Master downtime.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "description": "Your required canonical address from the Agentworks runtime instruction."},
                "target": {"type": "string", "description": "Stable UUID or canonical address from sessions_list_known."},
                "content": {"type": "string", "minLength": 1, "maxLength": 100000},
                "idempotency_key": {"type": "string"},
                "expect_reply": {"type": "boolean", "default": True},
            },
            "required": ["source", "target", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sessions_reply",
        "description": "Reply to a known inter-session message without creating a reply loop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "target": {"type": "string"},
                "content": {"type": "string", "minLength": 1, "maxLength": 100000},
                "reply_to": {"type": "string"},
                "idempotency_key": {"type": "string"},
            },
            "required": ["source", "target", "content", "reply_to"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sessions_fanout_send",
        "description": "Durably enqueue the same message to multiple known sessions. Each target is delivered and acknowledged independently.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "description": "Your required canonical address from the Agentworks runtime instruction."},
                "targets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 100,
                    "description": "Stable UUIDs or canonical addresses from sessions_list_known.",
                },
                "content": {"type": "string", "minLength": 1, "maxLength": 100000},
                "idempotency_key": {"type": "string"},
                "expect_reply": {"type": "boolean", "default": False},
            },
            "required": ["source", "targets", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sessions_status",
        "description": "Read durable local receipts and pending outbox state for a message.",
        "inputSchema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "additionalProperties": False,
        },
    },
]


def tool_call(name, arguments):
    if name == "sessions_list_known":
        return known_sessions(arguments)
    if name == "sessions_send":
        return enqueue(arguments)
    if name == "sessions_reply":
        return enqueue({**arguments, "expect_reply": False})
    if name == "sessions_fanout_send":
        return enqueue_fanout(arguments)
    if name == "sessions_status":
        return message_status(arguments)
    raise ValueError(f"unknown tool: {name}")


def mcp():
    ensure_state()
    for raw in sys.stdin:
        request = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            method = request.get("method")
            if request_id is None:
                continue
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "agentworks-bridge", "version": "0.1.0"},
                }
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                params = request.get("params") or {}
                value = tool_call(params.get("name"), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}
            elif method == "ping":
                result = {}
            else:
                raise ValueError(f"unsupported method: {method}")
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as error:
            response = {
                "jsonrpc": "2.0",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": {"code": -32000, "message": str(error)},
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(prog="agentworks-bridge")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("mcp")
    send = sub.add_parser("send")
    send.add_argument("--source")
    send.add_argument("--target", required=True)
    send.add_argument("--content", required=True)
    send.add_argument("--idempotency-key")
    send.add_argument("--no-reply", action="store_true")
    fanout = sub.add_parser("fanout-send")
    fanout.add_argument("--source")
    fanout.add_argument("--target", action="append", required=True, dest="targets")
    fanout.add_argument("--content", required=True)
    fanout.add_argument("--idempotency-key")
    fanout.add_argument("--expect-reply", action="store_true")
    sub.add_parser("list-known")
    sub.add_parser("outbox-list")
    ack = sub.add_parser("outbox-ack")
    ack.add_argument("outbox_id")
    sub.add_parser("sync-directory")
    receipt = sub.add_parser("receipt")
    receipt.add_argument("message_id")
    delivery_get = sub.add_parser("delivery-get")
    delivery_get.add_argument("message_id")
    delivery_record = sub.add_parser("delivery-record")
    delivery_record.add_argument("message_id")
    args = parser.parse_args()
    ensure_state()
    if args.command == "mcp":
        return mcp()
    if args.command == "send":
        print(json.dumps(enqueue({
            "source": args.source,
            "target": args.target,
            "content": args.content,
            "idempotency_key": args.idempotency_key,
            "expect_reply": not args.no_reply,
        }), ensure_ascii=False))
    elif args.command == "fanout-send":
        print(json.dumps(enqueue_fanout({
            "source": args.source,
            "targets": args.targets,
            "content": args.content,
            "idempotency_key": args.idempotency_key,
            "expect_reply": args.expect_reply,
        }), ensure_ascii=False))
    elif args.command == "list-known":
        print(json.dumps(known_sessions(), ensure_ascii=False))
    elif args.command == "outbox-list":
        values = [load_json(path, None) for path in sorted(OUTBOX.glob("*.json"))]
        print(json.dumps([value for value in values if value], ensure_ascii=False))
    elif args.command == "outbox-ack":
        path = OUTBOX / f"{uuid.UUID(args.outbox_id)}.json"
        if path.exists():
            path.unlink()
        print(json.dumps({"acknowledged": True, "outboxId": args.outbox_id}))
    elif args.command == "sync-directory":
        atomic_json(DIRECTORY, json.load(sys.stdin))
        print(json.dumps({"synced": True}))
    elif args.command == "receipt":
        value = json.load(sys.stdin)
        atomic_json(RECEIPTS / f"{uuid.UUID(args.message_id)}.json", value)
        print(json.dumps({"stored": True, "messageId": args.message_id}))
    elif args.command == "delivery-get":
        value = load_json(DELIVERIES / f"{uuid.UUID(args.message_id)}.json", None)
        print(json.dumps({"found": value is not None, "result": value}, ensure_ascii=False))
    elif args.command == "delivery-record":
        value = json.load(sys.stdin)
        atomic_json(DELIVERIES / f"{uuid.UUID(args.message_id)}.json", value)
        print(json.dumps({"stored": True, "messageId": args.message_id}))


if __name__ == "__main__":
    main()
