# Value Forge — 0.7.0

A Decky plugin for named groups of memory addresses in a single running game session.
Built on [Memory Deck](https://github.com/CameronRedmore/memory-deck) by
Camzie99 (Cameron Redmore) and contributors, using scanmem. Value Forge is an
independent fork, maintained by [timekillr](https://github.com/timekillr), and is
not the original Memory Deck or an official update from its author.

This 0.5.0 baseline contains the existing session plugin features under the new
Value Forge name. The internal package/folder ID stays `memory-deck-session`
for upgrade compatibility, so existing saved groups use the same settings.
After updating from Memory Deck Session, restart Decky Loader once (or reboot)
to clear the old display name and backend. No uninstall or settings reset is needed.

## Changes in 0.7.0

Search results now have **Quick edit** directly above **Save to group**. Enter a
value with the controller number pad and press **Apply quick edit**. To change
several results together, select their addresses and choose **Quick edit selected**.
This applies one value using each row's chosen concrete type, without creating a
saved address or group. Auto's **Result type** selector applies to editing and saving.

Both Decky and [Value Forge Companion 0.2.0](https://github.com/timekillr/value-forge-companion)
support the same workflow. Current search readings and matching saved addresses
refresh after an edit. If a saved address is already frozen, its target updates
to the read-back value. Failed affected addresses stop freezing. The report shows
successes and per-address failures. Range, overlap and writable-region checks
run before any batch write; writes are sequential while the game runs.

Quick edits keep the current search candidates and its last-search comparison
baseline. Refining, resetting or changing the game invalidates an open quick
editor, so a stale selection cannot write to a different search or session.
These temporary selections and reports are not stored as saved entries.

## Changes in 0.6.0

Value Forge Companion for Android can control this same session from your home
network while the Decky panel is closed. Searches, progress, groups, individual
and group writes, freezing, labels, moves, and removal use the same backend.

1. Update the plugin using https://is.gd/valueforge and restart Decky if needed.
2. In the plugin, enable **Phone companion**, then press **Pair a phone**.
3. Install **Value Forge Companion** from its GitHub release. Allow Android's
   local-network permission when requested.
4. Enter the address and six-digit code shown in Decky. Check that the phone's
   fingerprint matches the plugin, then confirm pairing.
5. Use the app. Pairing is remembered across plugin, machine, and app restarts.
   The phone shows connection status, last response time, and reconnects while
   open. A changed machine IP can be entered without discarding its pairing.

The plugin listens on HTTPS port 52881 only when the companion is enabled.
Pairing codes expire after five minutes, are single-use, and allow five incorrect
attempts. The phone pins the certificate and encrypts its token with Android
Keystore. Tokens are hashed in the plugin settings. Remove a phone in Decky to
revoke access. OpenSSL on the Steam Machine creates the local certificate.
The connection is for your home network; no router configuration is required.

Phone polling reads current values without repeatedly writing the settings file.
Open Decky panels also observe session changes made from the app. Neither app
reconnection nor pairing starts scans, changes a value, or enables freezing.
Do not delete the plugin's companion settings/certificate directory if you want
to preserve pairings. Back it up with your existing plugin settings.

See [companion protocol](COMPANION_PROTOCOL.md) for the API and lifecycle details.

## Changes in 0.5.0

- Right-stick scrolling is always active while the plugin is visible. The Controls
  toggle is removed. Visibility, dead-zone, and disconnect handling remain.
- On the first search, progress appears immediately above **Start search**. While
  narrowing, it appears between **Narrow results** and **Start a new search**.
- **Compare → Increased by X** and **Decreased by X** use a **Change amount**
  number pad. Enter a positive difference since the previous search, rather than
  the new total. For example, search for 100, gain 25 in-game, then narrow using
  **Increased by X**, amount 25. Another gain of 25 uses the same amount again.
  For an unknown total, begin with **Unknown initial value**, change the value
  in-game by a known amount, and then use the exact-change comparison.
- Invalid change amounts leave the previous search intact. Integer and floating
  searches are supported. After an unknown Auto snapshot, a whole-number delta
  keeps both families eligible. Decimal deltas select the float family. A search
  already narrowed to integers needs resetting before a fractional delta.
- The native scanner's exact-change float comparisons now reject unchanged
  values when a small delta rounds away, and exclude non-finite values. This
  prevents large unchanged floats from swamping an unknown-value search.

Searches compare the game's current memory with the last successful search;
opening or refreshing the panel does not advance that comparison point. Searches
only read memory. Applying values to saved addresses remains a separate action.
Saved groups remain compatible with 0.2.x–0.4.0. Install over the existing plugin.

## Changes in 0.4.0

### Change every value in a group

Every saved group has a **Change all values** button. Open it, enter a value on
the controller number pad, then press **Apply to entire group**. The plugin
writes that value to every address in the group using each address's saved type,
reads the current values back, and reports how many addresses were updated.
Existing individual edit/remove/freeze controls are still available.

The full group is checked before writing: the value must fit every saved type,
all addresses must be readable/writable in the same running process, and
overlapping addresses must agree on the bytes being written. A failed preflight
changes no addresses. If an OS write fails after preflight (for example, the game
unmaps an address), the result lists successes and failures. This is one user
action with fast sequential writes while the game runs, not an atomic transaction.
Frozen members receive the new freeze target after a successful write; a member
that fails during writing is unfrozen. Other groups are not changed.

### Real scan progress

The progress bar samples scanmem's public `sm_get_scan_progress()` value while a
search runs. Progress frames use a separate protocol descriptor so native stdout
capture cannot swallow them. The frontend polls the backend while the initiating
search request is still pending, and can reconnect to progress after reopening.
The percentage describes the native memory scan, not a simulated timer or an
ETA. Updates can arrive in steps; very fast scans may finish before the bar moves.

### Right-stick scrolling

In 0.4.0, **Controls → Right-stick scrolling** enabled or disabled scrolling.
Version 0.5.0 removes this toggle and always scrolls while the panel is visible.
The plugin observes Steam's exposed controller state (`sRightStickY`), with a
standard browser Gamepad API fallback. It only runs while the plugin is visible,
honors a dead zone, and releases its own subscriptions on close. It does not
change controller mappings or unregister other Steam/plugin listeners.

Steam's existing scrolling container is used when available; otherwise only the
plugin's content is bounded as a scrolling region. Moving the stick farther
increases scroll speed. Controller-list notifications stop scrolling on disconnect;
older clients without them use a stale-input timeout. If neither controller API
is exposed, D-pad navigation remains available. Physical controller behavior and
SteamOS/client-specific input availability still require on-device validation.

Saved settings use the same schema as 0.2.x/0.3.0. Install this ZIP over the existing
plugin without uninstalling it; saved groups and addresses remain compatible.

## Changes in 0.3.0

- **One scrolling process list:** every listed process is on the same page.
  There are no process-page buttons. The optional filter uses controller keys.
- **One-press connection:** press A on a process row to connect immediately.
  There is no selection/confirmation step. Existing groups open in Saved; a
  new session with no saved addresses opens directly in Search.
- **Memory Deck-style number pad:** Search value and New value use the
  7–8–9 / 4–5–6 / 1–2–3 / backspace–0–decimal button grid. Signed values,
  decimal values, clear, and backspace are supported without Steam's keyboard.
- **Controller entry everywhere:** labels, group names, the process filter,
  and manual hexadecimal addresses also use inline button pads. No field opens
  a system virtual keyboard or needs a physical keyboard/mouse.
- **Auto is restored as the default search type:** whole-number input searches
  integer widths; decimal input searches float32/float64, matching Memory Deck's
  category inference. The inferred category stays consistent while refining a
  search. Reset before changing from a whole-number search to fractional values.
  Unknown-initial Auto searches include all numeric types; the first explicit
  numeric value narrows the search to its whole-number or decimal family.
- Auto results show possible concrete types when a value is ambiguous. The
  displayed default type is a suggestion (int32 is preferred when possible).
  You can choose another detected type before saving. Every saved address has
  a concrete byte width, so editing it does not blindly overwrite a wider slot.
- Existing saved groups and settings remain compatible with 0.2.x.

## Controller controls

The right stick always scrolls the panel when the controller API is available. The D-pad moves focus.

Move between controls and pad keys with the D-pad (or left stick); press A to
activate. Native Decky dropdowns handle value types, comparisons, and group
selection with the gamepad. Press a field's value button to show/hide its pad.

Within a pad: **X** removes the last character, **Y** clears, and **B** closes the
pad without backing out of the plugin. **Done** also closes the pad. Number pads
have a **±** button; text pads have case toggles and **Space**. To replace a value,
clear it first and enter the new digits. Search's pad is open by default.

All controls use Decky's focusable buttons/toggles/dropdowns. Automated tests
exercise the controller actions using a simulated Decky interface; physical
D-pad focus movement, scrolling, and Steam's menus still require on-device QA.

## Fixes in 0.2.1

- The process selector now uses an inline, searchable, paginated list instead of
  Steam's popup dropdown. Choosing a row keeps the picker open; connecting
  requires a separate press of **Use this process**.
- Selection is preserved by full process identity across list refreshes, changed
  ordering, and panel remounts. A slow refresh cannot overwrite a newer choice.
  If the selected process exits, selection is cleared rather than silently
  switched to the first item.
- Plugin content stays mounted during Steam menu overlays. Background saved-value
  refreshes no longer disable the focused control or reset unsubmitted search
  fields. Reopening still refreshes all saved address values.
- The current tab and pending process selection survive panel remounts for the
  lifetime of the loaded plugin frontend.
- Saved groups use the same settings schema as 0.2.0. Install the updated ZIP
  over the existing plugin using Decky's install flow; no uninstall is needed.

## Install on your Steam Machine

For installation directly from Gaming Mode through a permanent GitHub release
URL, see [GitHub publishing and installation](GITHUB_RELEASES.md). The repository
and first release must be published before that URL can be used.

Requires SteamOS/Linux x86-64, Decky Loader with its current plugin API,
and system Python 3.9 or newer. The ZIP already contains the compiled frontend
and native scanner; you do not need Node, npm, GCC, or Docker to install it.

1. Download **ValueForge-0.6.0.zip** onto the Steam Machine. If you are
   reading this on your phone, transfer the ZIP to the machine's Downloads folder.
2. Open Decky in Gaming Mode and open its settings (gear icon).
3. Under **General**, enable **Developer Mode**.
4. Open **Developer** and use **Install Plugin from ZIP** (wording varies by
   Decky version). Select the ZIP directly; do not extract it first.
5. Open **Value Forge** in the Decky plugin list.

The root permission in the manifest is needed for reading and writing another
process's memory. No sudo commands or SteamOS system modifications are needed
beyond Decky's own installation and plugin installation flow.

## First session

1. Launch your game and wait until it is fully running.
2. In the plugin, open **Process**, reload the list if needed, optionally filter
   by game name/PID, and press A on the actual executable's row to connect.
   Scroll through the single list with the D-pad. Proton games work through
   their Linux process; a Windows executable may have a shortened process name.
3. Open **Search**. Leave **Value type** on **Auto**, select **Equals**, enter the
   current number using the on-screen number pad, and start the search. You can
   choose a specific type instead when you know it.
4. Return to the game, change the number, reopen the plugin, and narrow the
   search using the new number or a Changed/Increased/Decreased comparison.
5. Use **Save to group** beside a result, or select several results and choose
   **Save selected**. Pick **New group** and name it, such as Gold, Health, or
   Ammo, or choose an existing group. A group can hold multiple addresses.
6. In **Saved**, each group shows its addresses and their independent current
   values. **Edit address** opens that address's label, write, freeze, move, and
   remove controls. Writing an address changes only that selected address.
7. **Start a new search** clears search candidates only, keeping saved groups.

You can also use **Add address** inside a group to enter a hexadecimal address
manually, or **Add address manually** to choose a new/existing destination group.
Every address records its own type; a group may contain different types.

## Managing groups and addresses

- Select multiple search results, including results on different pages, and save
  them together to a new or existing group. Saving does not write game memory.
- **Rename / Delete group** changes the group name or removes the saved group.
- **Edit address → Save label** gives one address an optional descriptive label.
- **Edit address → Write value** writes only that address. **Change all values**
  on the group display applies one value to every member. Current member values
  are displayed independently.
- **Edit address → Move to group → Move address** reorganizes a saved address
  without changing its value. Its existing freeze setting stays with it.
- **Edit address → Remove address → Confirm remove** removes only that saved
  address, stops its freezing, and leaves the other group members intact.
- Removing a group's last address keeps an empty group that can be reused.
- Deleting an entire group requires a separate confirmation and stops freezing
  for its members. Removing a saved address/group does not undo earlier edits.
- Refreshing or reopening reads every member of every group; an unavailable
  member does not prevent other members from updating.

## Upgrade from 0.1.0

Install the new ZIP through the same Decky installation flow. It uses the same
plugin identity and settings path. Existing saved entries become groups, keeping
all addresses and IDs. Entries with matching names (ignoring case) are combined
into one group. The first settings migration preserves the original file as
`sessions.v1-backup.json` next to `sessions.json`. Migration does not reactivate
freezes or apply previous addresses to a new game process.

## Refresh and session behavior

- Every panel mount and every hidden-to-visible transition reads all saved
  addresses from the game's memory. Cached values are hidden while reading.
- Changed values are highlighted and show the previous successful reading.
- **Refresh values** performs the same read manually. There is no continuous
  value polling by default; the timestamp shows when each value was read.
- Closing Decky does not reset the scanner. Re-selecting the same running
  process also leaves its current search intact.
- Starting another search does not remove named entries. The backend owns the
  scan, and switching away from and back to the same running process restores
  its saved entry list (its old scan candidates need a new search).
- Entries are associated with boot ID, PID, and process start time. A reused PID
  cannot reactivate entries belonging to an exited game.
- An unreadable address remains listed as **Unavailable**. Exited sessions show
  **Game not running** and disable editing. No time-based entry expiry exists.
- Named entries are checkpointed to Decky's plugin settings directory. Reloading
  the plugin can restore them for the same still-running process. Native scan
  candidates survive closing the panel, but not reloading/restarting the plugin.
- Restarting the game creates a new session; old addresses are not applied to it.
  Old session lists are retained in the settings file, not automatically copied.
- A game can move data during a level load. Readability alone cannot prove that
  an address still represents the same variable. This build does not resolve
  pointers or relocate entries.

## Freeze controls

Freeze is an explicit opt-in per entry. It reads the current value, then
reapplies it every 0.5 seconds while the plugin backend is running, including
while the panel is closed. Writing a new value to a frozen entry updates its
freeze target. Freezing stops on a read/write failure, a process change/exit,
plugin unload, or plugin restart. Reopening the panel never enables freezing
or writes values by itself. Native searches do not block the freeze scheduler.

## Scope and limits

- Integer types: signed/unsigned 8-, 16-, 32-, and 64-bit; float32 and float64.
- Values and addresses cross the frontend/backend boundary as strings, so large
  integers do not lose precision in JavaScript. Memory uses little-endian order.
- The first 200 scan candidates are available, ten per page; keep narrowing to
  find later matches. All candidates remain in the native scanner for refinement.
- Up to 200 saved addresses and 200 groups per process session.
- Auto or explicit numeric searches; no strings, pointer scans, restart recovery, automatic
  game selection, full-screen workspace, import/export, or Cheat Engine tables.
- Unknown-initial-value searches can consume significant RAM on large games.
  Known-value searches are a better first choice when possible.
- Intended for offline/single-player games. Editing the wrong address can crash
  a game or damage a save. This build does not bypass anti-cheat or permissions.

## Validation for this build

The native library was built for Linux x86-64 and inspected: its newest required
glibc symbol is GLIBC_2.17. This is not a claim of on-device SteamOS validation.

Automated checks cover actual memory in an opt-in disposable Linux process:
refresh/change tracking, integer/float scans and refinement, search preservation,
address-based writes after search reset, unreadable addresses, large unsigned
integers, freeze controls, process identity checks, and corrupt-file protection.
Group tests additionally cover independent edits to linked addresses, batch
validation, adding/moving/removing members, empty groups, deleting groups with
frozen addresses, and migration from the original saved-entry format.
The production frontend bundle is tested with real React and simulated Decky UI
components/RPC, including reopening, multi-select, per-address controls, groups, controller pads,
one-press selection from an unpaginated process list, group-wide edits, live scan
progress, and right-stick scrolling with visibility/disconnect cleanup.

**Still needs testing on the Steam Machine:** Decky installation/loading,
SteamOS process permissions, game compatibility, TV layout, on-screen keyboard,
physical-controller focus/navigation/scrolling, and sleep/resume behavior. Treat this as a test
build and begin with an offline game and a disposable save.

## Build from included source

On Linux x86-64 with Python 3.9+, GCC, Node.js 20+, and npm:

```sh
npm ci --ignore-scripts
npm run build:native
npm run check
npm run package
```

The resulting archive is written to `artifacts/ValueForge-0.6.0.zip`.
The ZIP includes the complete plugin source, native source, tests, lockfile,
license notices, and compiled outputs. The native build script builds the
vendored scanmem sources without requiring autotools. Optional Docker build:

```sh
docker build -t memory-deck-session-builder backend
docker run --rm -v "$PWD:/project" memory-deck-session-builder
```

Runtime files: `main.py`, `session_core.py`, `scanner_worker.py`,
`dist/index.js`, `bin/libscanmem.so.1.0.0`, `plugin.json`, and `package.json`.
The optional companion HTTPS service is off until explicitly enabled. The isolated native worker uses a
private stdin/stdout protocol and exits with the backend.

## License and attribution

GPL-3.0; see LICENSE and THIRD_PARTY.md. Original Memory Deck reference files
are preserved under `reference/`. The bundled scanmem source is under
`backend/scanmem/` with its original copyright and license notices.
