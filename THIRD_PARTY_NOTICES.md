# Third-party components

This extension does not distribute Keil, STC-ISP or user firmware.

## stcgal (MIT)

The read-only backend includes unmodified `__init__.py`, `protocols.py`,
`options.py`, `models.py`, and `utils.py` from
https://github.com/grigorig/stcgal at commit
`fdf5fdd60515a260bb303dcf7b251c2b2671f91c` (1.10).
Original author copyright and full MIT notices remain in those source files.
The upstream CLI/frontend and programming commands are not exposed by this
extension. The adapter blocks programming/calibration/option-write operations.
Native `ReadOnlyProbe` code is maintained in `python/probe_core.py`.

## Bundled Python dependency wheels

- pyserial 3.5 — BSD-3-Clause, https://github.com/pyserial/pyserial
- tqdm 4.70.1 — MPL-2.0 / MIT portions; original notices in the wheel,
  https://github.com/tqdm/tqdm
- colorama 0.4.6 — BSD-3-Clause, https://github.com/tartley/colorama

Wheels retain original license metadata and are installed into the extension's
private virtual environment only on explicit setup. Python itself is not bundled.

## JavaScript runtime bundle

- fast-xml-parser 5.11.2 — MIT, https://github.com/NaturalIntelligence/fast-xml-parser
- iconv-lite 0.7.2 — MIT, https://github.com/ashtuchkin/iconv-lite
- Their transitive runtime dependencies: see the bundled third-party license file.

The @nodable/entities npm package omits its license file; its MIT notice is
preserved in licenses/nodable-entities-LICENSE, retrieved from the upstream
https://github.com/nodable/val-parsers/blob/main/LICENSE on 2026-10-17.

Development-only tools are recorded in package-lock.json and are not distributed
as node_modules in the VSIX. No GPL code from stc-newisp-cli is included.
