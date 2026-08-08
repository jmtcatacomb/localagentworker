#!/usr/bin/env python3
"""Superadmin-only Agentworks HTTP capability exposed as a stdio MCP server."""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


CAPABILITY_FILE = os.path.expanduser("~/.agentworks/admin-capability.json")
try:
    with open(CAPABILITY_FILE, encoding="utf-8") as handle:
        CAPABILITY = json.load(handle)
except (OSError, json.JSONDecodeError):
    CAPABILITY = {}
BASE = os.environ.get("AGENTWORKS_MASTER_URL", CAPABILITY.get("url", "http://127.0.0.1:18080")).rstrip("/")
TOKEN = os.environ.get("AGENTWORKS_MASTER_TOKEN", CAPABILITY.get("token", ""))


def request(method, route, body=None):
    if not TOKEN:
        raise ValueError("AGENTWORKS_MASTER_TOKEN is not configured")
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(
        BASE + route,
        data=payload,
        method=method,
        headers={"X-Agentworks-Master-Token": TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            data = response.read()
            return json.loads(data) if data else {"ok": True}
    except urllib.error.HTTPError as error:
        data = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(data).get("error", data)
        except json.JSONDecodeError:
            message = data
        raise ValueError(f"Agentworks HTTP {error.code}: {message}") from error


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


TOOLS = [
    {"name": "sessions_list_known", "description": "List every session visible to the Master Agent, including canonical addresses and UUIDs.", "inputSchema": obj({})},
    {"name": "sessions_send", "description": "Durably send one inter-session message as the Master Agent. The target is auto-woken when possible.", "inputSchema": obj({"source": {"type": "string"}, "target": {"type": "string"}, "content": {"type": "string", "minLength": 1, "maxLength": 100000}, "idempotency_key": {"type": "string"}, "expect_reply": {"type": "boolean", "default": True}}, ("source", "target", "content"))},
    {"name": "sessions_fanout_send", "description": "Durably send the same message to up to 100 sessions.", "inputSchema": obj({"source": {"type": "string"}, "targets": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 100}, "content": {"type": "string", "minLength": 1, "maxLength": 100000}, "idempotency_key": {"type": "string"}, "expect_reply": {"type": "boolean", "default": False}}, ("source", "targets", "content"))},
    {"name": "sessions_status", "description": "Read recent durable inter-session queue state.", "inputSchema": obj({})},
    {"name": "admin_list_tenants", "description": "List tenant owners, cells, assigned Worker and provisioning state. Master/system is excluded.", "inputSchema": obj({})},
    {"name": "admin_create_tenant", "description": "Create an isolated tenant owner and cell. The Worker provisions the cell when online. Initial password is returned only to this caller; do not publish it to chats or logs.", "inputSchema": obj({"slug": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,47}$"}, "display_name": {"type": "string", "minLength": 1, "maxLength": 120}, "email": {"type": "string", "format": "email"}, "password": {"type": "string", "minLength": 12, "maxLength": 256}, "desired_vcpus": {"type": "integer", "minimum": 1, "default": 2}, "max_vcpus": {"type": "integer", "minimum": 1, "default": 4}, "desired_memory_mib": {"type": "integer", "minimum": 512, "default": 4096}, "max_memory_mib": {"type": "integer", "minimum": 512, "default": 16384}}, ("slug", "display_name", "email", "password"))},
    {"name": "admin_list_cells", "description": "List Master and tenant cells, VM state, configured resource limits, and Worker state.", "inputSchema": obj({})},
    {"name": "admin_cell_action", "description": "Start, stop, ensure, or install agent CLIs in one tenant VM.", "inputSchema": obj({"cell_id": {"type": "string"}, "action": {"type": "string", "enum": ["ensure", "start", "stop", "install_agents"]}}, ("cell_id", "action"))},
    {"name": "admin_set_cell_resources", "description": "Set VM vCPU and RAM within its configured max. A running VM is restarted to apply the change.", "inputSchema": obj({"cell_id": {"type": "string"}, "desired_vcpus": {"type": "integer", "minimum": 1}, "desired_memory_mib": {"type": "integer", "minimum": 512}}, ("cell_id", "desired_vcpus", "desired_memory_mib"))},
    {"name": "admin_list_ports", "description": "List requested, active, revoked, and failed host-to-VM TCP routes.", "inputSchema": obj({})},
    {"name": "admin_open_port", "description": "Open an audited host TCP port to a tenant VM port. Defaults to loopback; 0.0.0.0 is externally reachable.", "inputSchema": obj({"cell_id": {"type": "string"}, "guest_port": {"type": "integer", "minimum": 1, "maximum": 65535}, "host_port": {"type": "integer", "minimum": 1, "maximum": 65535}, "bind_address": {"type": "string", "enum": ["127.0.0.1", "0.0.0.0"], "default": "127.0.0.1"}}, ("cell_id", "guest_port"))},
    {"name": "admin_revoke_port", "description": "Immediately close and revoke one host-to-VM TCP route.", "inputSchema": obj({"route_id": {"type": "string"}}, ("route_id",))},
    {"name": "admin_vm_exec", "description": "Execute an audited non-interactive shell command inside one tenant VM through the trusted host Worker. The VM is started automatically. Avoid embedding credentials in commands. Output is capped and commands time out after at most 600 seconds.", "inputSchema": obj({"cell_id": {"type": "string"}, "command": {"type": "string", "minLength": 1, "maxLength": 20000}, "cwd": {"type": "string", "description": "Optional absolute path inside the VM."}, "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600, "default": 120}, "as_root": {"type": "boolean", "default": False}}, ("cell_id", "command"))},
    {"name": "admin_vm_diagnostics", "description": "Start a tenant VM if necessary and collect identity, kernel, uptime, CPU, memory, disk, Docker, and Agentworks bridge diagnostics without changing tenant data.", "inputSchema": obj({"cell_id": {"type": "string"}}, ("cell_id",))},
    {"name": "admin_vm_repair_bridge", "description": "Start a tenant VM and deterministically reinstall/re-register its credentialless Agentworks bridge for Codex and Claude.", "inputSchema": obj({"cell_id": {"type": "string"}}, ("cell_id",))},
    {"name": "admin_update_session", "description": "Change a session alias/model/reasoning setting for its next turn.", "inputSchema": obj({"session_uuid": {"type": "string"}, "alias": {"type": "string"}, "model": {"type": "string"}, "effort": {"type": "string"}}, ("session_uuid", "alias", "model"))},
]


def call(name, args):
    if name == "sessions_list_known":
        return request("GET", "/api/inter-session/directory")
    if name == "sessions_status":
        return request("GET", "/api/inter-session/messages")
    if name == "sessions_send":
        return request("POST", "/api/inter-session/messages", {"source": args["source"], "target": args["target"], "content": args["content"], "idempotencyKey": args.get("idempotency_key") or str(uuid.uuid4()), "expectReply": args.get("expect_reply", True)})
    if name == "sessions_fanout_send":
        key = args.get("idempotency_key") or str(uuid.uuid4())
        return {"deliveries": [request("POST", "/api/inter-session/messages", {"source": args["source"], "target": target, "content": args["content"], "idempotencyKey": f"{key}:{index}", "expectReply": args.get("expect_reply", False)}) for index, target in enumerate(dict.fromkeys(args["targets"]))]}
    if name == "admin_list_tenants":
        return request("GET", "/api/admin/tenants")
    if name == "admin_create_tenant":
        return request("POST", "/api/admin/tenants", {"slug": args["slug"], "displayName": args["display_name"], "email": args["email"], "password": args["password"], "desiredVcpus": args.get("desired_vcpus", 2), "maxVcpus": args.get("max_vcpus", 4), "desiredMemoryMib": args.get("desired_memory_mib", 4096), "maxMemoryMib": args.get("max_memory_mib", 16384)})
    if name == "admin_list_cells":
        return request("GET", "/api/admin/cells")
    if name == "admin_cell_action":
        return request("POST", f"/api/cells/{urllib.parse.quote(args['cell_id'])}/actions", {"action": args["action"]})
    if name == "admin_set_cell_resources":
        return request("PATCH", f"/api/admin/cells/{urllib.parse.quote(args['cell_id'])}/resources", {"desiredVcpus": args["desired_vcpus"], "desiredMemoryMib": args["desired_memory_mib"]})
    if name == "admin_list_ports":
        return request("GET", "/api/admin/ports")
    if name == "admin_open_port":
        body = {"cellId": args["cell_id"], "guestPort": args["guest_port"], "bindAddress": args.get("bind_address", "127.0.0.1")}
        if args.get("host_port"):
            body["hostPort"] = args["host_port"]
        return request("POST", "/api/admin/ports", body)
    if name == "admin_revoke_port":
        return request("DELETE", f"/api/admin/ports/{urllib.parse.quote(args['route_id'])}")
    if name == "admin_vm_exec":
        return request("POST", f"/api/admin/cells/{urllib.parse.quote(args['cell_id'])}/exec", {"command": args["command"], "cwd": args.get("cwd"), "timeoutSeconds": args.get("timeout_seconds", 120), "asRoot": args.get("as_root", False)})
    if name == "admin_vm_diagnostics":
        return request("POST", f"/api/admin/cells/{urllib.parse.quote(args['cell_id'])}/diagnostics", {})
    if name == "admin_vm_repair_bridge":
        return request("POST", f"/api/admin/cells/{urllib.parse.quote(args['cell_id'])}/repair-bridge", {})
    if name == "admin_update_session":
        return request("PATCH", f"/api/sessions/{urllib.parse.quote(args['session_uuid'])}", {"alias": args["alias"], "model": args["model"], "effort": args.get("effort")})
    raise ValueError(f"unknown tool: {name}")


def mcp():
    for raw in sys.stdin:
        request_value = None
        try:
            request_value = json.loads(raw)
            request_id = request_value.get("id")
            if request_id is None:
                continue
            method = request_value.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "agentworks-admin", "version": "0.1.0"}}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                params = request_value.get("params") or {}
                value = call(params.get("name"), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}
            elif method == "ping":
                result = {}
            else:
                raise ValueError(f"unsupported method: {method}")
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as error:
            response = {"jsonrpc": "2.0", "id": request_value.get("id") if isinstance(request_value, dict) else None, "error": {"code": -32000, "message": str(error)}}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] != "mcp":
        raise SystemExit("usage: agentworks-admin mcp")
    mcp()
