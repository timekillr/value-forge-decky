# Value Forge: source provenance and notices

- **Memory Deck**, Camzie99 (Cameron Redmore), HeyItsWaters and contributors:
  https://github.com/CameronRedmore/memory-deck
  Source snapshot: `9b1dc88ffa43f71299227fac4e533a8fe5a8c1ad` (2024-04-19).
  Original project license: GPL-3.0. The project was forked from this snapshot.
  The UI and Decky backend are replaced by the session-oriented implementation;
  original reference files are preserved in `reference/`. The number-pad layout
  and digit/backspace behavior in `src/components/ControllerPad.tsx` are adapted
  from the original `NumpadInput.tsx`, with controlled state and additional
  controller shortcuts, text entry, and hexadecimal entry.
- **scanmem/libscanmem**, Tavis Ormandy, Eli Dupree, Wang Lu, Sebastian
  Parschauer, Andrea Stacchiotti, and other contributors named in the source:
  https://github.com/scanmem/scanmem
  The complete sources bundled by that Memory Deck snapshot are retained in
  `backend/scanmem/`. Individual files carry GPL-3.0-or-later or
  LGPL-3.0-or-later notices. License texts and AUTHORS are retained there.
  In 0.5.0, `scanroutines.c` is modified so exact-change float comparisons
  require a finite, changed value. This excludes unchanged large floats when
  adding a small delta rounds back to the old value, and excludes infinities.
  `scripts/build_native.py` supplies the Linux build configuration and compiles
  the bundled library sources, including this change.
- **GameConqueror scanmem wrapper**, Wang Lu (2010, 2011, 2013), Sebastian
  Parschauer (2018), Andrea Stacchiotti (2020): GPL-3.0-or-later.
  The command-output capture technique and match-format regex in
  `scanner_worker.py` are adapted from `backend/scanmem/gui/scanmem.py`.
- **@decky/api 1.1.3**, SteamDeckHomebrew Team: LGPL-2.1.
  https://github.com/SteamDeckHomebrew/loader-api
  The npm distribution, its JavaScript source/declarations, package metadata,
  and license are included in `THIRD_PARTY/decky-api-1.1.3/`. Its API adapter is
  bundled into `dist/index.js`; rebuild using package-lock.json and npm ci.
- **@decky/ui 4.15.1** and React are provided by Decky at runtime and are not
  bundled into the plugin. Development versions are pinned by package-lock.json.
- **@decky/rollup 1.0.2** is used as a development/build tool only.
  The plugin uses its current build format; its runtime source is not bundled.

Value Forge session-specific code is distributed under the root GPL-3.0 license.
All original notices in vendored and reference sources remain applicable.
