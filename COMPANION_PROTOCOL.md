# Value Forge Companion protocol 1

Value Forge 0.6.0 adds an optional native-client HTTPS listener on port 52881.
The default is disabled. Enabling it, issuing pairing codes, and revoking phones
are local Decky actions, not remotely callable operations.

## Pairing and identity

The plugin creates a private self-signed TLS certificate with the system OpenSSL
command. Its key, server identity, device-token hashes, and enabled setting live
in `settings/memory-deck-session/companion/`, outside the installed plugin files.
The files survive upgrades and reboots. Do not publish these settings.

The app probes `GET /v1/info` without sending credentials, computes SHA-256 of
the peer's DER certificate, and asks the user to compare the first 20 hex digits
with Decky. It only submits the pairing code after this comparison is confirmed,
using the full fingerprint as its TLS pin. It never sends tokens or pairing
codes through an unverified connection. Subsequent connections require the full
remembered fingerprint. There is no global trust-all TLS override.

`POST /v1/pair` accepts `{ "code": "123456", "device_name": "Android phone" }`.
Codes last five minutes, are single-use, and close after five wrong attempts.
The response contains a 256-bit random bearer token, device ID, server ID, API
protocol, and plugin version. At most eight phones can be paired. The server
stores only token SHA-256 hashes; the phone encrypts its credentials using an
Android Keystore AES-GCM key. Android backups are disabled for this app.

Revoking a phone in Decky invalidates its token. `POST /v1/unpair` revokes only
the calling phone. Forgetting a phone while offline removes its local secret;
its old server entry can also be removed in Decky. Ordinary reconnects never
write memory, resume freezing, or restart/replay a scan.

## HTTP API

Responses use `{ "ok": true, "data": ... }`, or
`{ "ok": false, "error": "message" }` with a non-200 HTTP status. Requests use
HTTP/1.1, a Content-Length, and JSON for POST bodies. Chunked request bodies and
duplicate headers are rejected. Header/body limits and timeouts are enforced.
Every response closes its connection and is marked `Cache-Control: no-store`.
Browser Origin requests are rejected; no permissive CORS headers are sent.

Only `/v1/info` and `/v1/pair` are unauthenticated. Other endpoints require
`Authorization: Bearer <token>`:

| Endpoint | Purpose |
| --- | --- |
| GET /v1/info | Protocol, server identity, plugin name/version |
| POST /v1/pair | Redeem a local, short-lived pairing code |
| GET /v1/ping | Authenticated liveness and server identity |
| GET /v1/state | Shared session, saved groups, results and live scan progress |
| GET /v1/state?refresh=1 | Also reread saved addresses, without a settings-file write |
| GET /v1/processes | Complete process list with PID/session identities |
| POST /v1/unpair | Revoke the calling phone |
| POST /v1/command | Execute one allowed session operation |

The app polls state at 1.2-second intervals, or 250 ms while scanning. This is
also its authenticated heartbeat. It shows the last successful response, marks
values stale when disconnected, disables writes, and backs off retries up to
eight seconds. Polling stops while the Activity is paused and resumes on return.
Only reads reconnect automatically; mutations are never automatically retried.

## Commands

The command envelope contains `method`, an `args` object, `request_id` (unique
per user action), and `expected_session_id` (the last observed process identity).
The backend checks this identity inside its session lock before any mutation,
rejecting commands based on a stale game session. Attach additionally checks
the selected process's full identity through `expected_id`.

| Method | Arguments |
| --- | --- |
| attach | pid, expected_id |
| scan | operator, value, kind |
| reset_scan | none |
| save_entries | name, addresses [{address, kind}], optional group_id |
| rename_group | group_id, name |
| remove_group | group_id |
| move_entry | entry_id, group_id |
| rename_entry | entry_id, name |
| remove_entry | entry_id |
| write_entry | entry_id, value |
| write_group | group_id, value |
| write_results (0.7.0+) | addresses [{address, kind}], value, session_id, scan_id |
| freeze_entry | entry_id, enabled |

All values and addresses are strings, including 64-bit integers. Existing type,
range, process-liveness, overlap and writable-address checks remain authoritative.
Auto searches and every comparison mode are unchanged from the Decky UI.

Version 0.7.0 adds `scan.id`, a fresh identity for every completed search and
reset. `write_results` requires the identity of the displayed scan and session,
accepts only addresses/types in its current first 200 results, and rejects writes
while scanning. The entire batch is preflighted before writing. It creates no
saved group/entry and never updates scanmem's comparison baseline. The state
includes an ephemeral `quick_write` report with `total`, `written` address IDs,
`failed` address/error objects, value, selected addresses, session/scan IDs and
timestamp. State refresh rereads concrete result values as well as saved values.
Existing overlapping freeze targets update from actual memory after success;
failed overlapping targets stop freezing. Protocol 1 remains compatible with
older apps; the new client requires plugin 0.7.0 for Quick edit.

Remote mutations are serialized. Scans run outside the session lock so state
and progress remain readable and explicit freeze targets continue updating.
An in-flight command continues if its HTTP connection drops. The server retains
up to 128 command tasks/results keyed by device and request ID; reusing an ID
with identical arguments returns the same result, while different arguments
are rejected. This is an in-memory retry window, not a durable transaction log.
The app does not retry mutations. Reconnect and inspect shared state if a
response was lost. Groups use the existing schema and remain on the machine.

Disabling the listener closes connections and pairing windows; already-started
commands can finish. Unloading the plugin cancels its command tasks before
closing the scanner, and stops explicit freeze writes as before.
