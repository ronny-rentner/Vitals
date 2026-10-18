# Rewrite the tests on Machine, without fakes

## Context
The collection tests and the Shell test make up sensors and sources, replace methods of `Sensors` and of the renderer, and read private members. The tests are to be deleted and rewritten so that `Sensors` and the extension run unchanged and read everything from `Machine`, the test double of the system. Shorter code that covers more. Decided: no test expects an exact rate; tests of pure functions stay, minus overlaps; the Shell test replaces nothing.

## Machine (`tests/machine.js`, `tests/fixtures/machine.js`)
- Stands behind `Gio.File.new_for_path`, `Gio.File.new_for_uri` (the three public IP providers answer JSON from the fixture) and `Gio.VolumeMonitor.get`. Only paths under `/sys` and `/proc`, the mount points whose space is asked, and the provider URLs; every other path goes to the original. GJS tests only, each in an interpreter of its own.
- Stands behind `GLib.get_monotonic_time`, which is the real time plus what `machine.skip(seconds)` skipped, as a suspend does. A test of an interval skips it instead of waiting. A saved reading older than a minute, or a sensor not found for a year, comes from a saved catalog with old timestamps.
- Counters grow with real time at rates the fixture gives: `/proc/net/dev`, `/proc/stat`, `/proc/diskstats`, `/proc/uptime`. A network and a storage rate are checked between bounds: the test sets the counter, and the time between the two readings is at least the second reading's delay and at most what the test measured.
- What a test does to the machine: set, remove and restore a file's content, plug and unplug a device (a group of files the fixture names: second battery, mouse, USB drive, share, VPN interface, second NVMe, AMD card), fail a read, hold a read open, skip time. `reads` and `asked` stay. A test's machine is uninstalled when the test ends.
- Fixture: one machine with every category, adding what is missing today: `/proc/loadavg`, `/proc/uptime`, `file-nr`, `/proc/net/wireless` with a WiFi interface, an AMD card under `/sys/class/drm`.
- `nvidia-smi` stays a real program first in `PATH`, installed for each test; `PATH` and its environment are restored when the test ends.

## GJS tests
- Delete `tests/sensors.collection.test.js`; rewrite `tests/sensors.test.js` as the one file for `Sensors`. A test builds `Machine`, settings and `Sensors`, and nothing else is replaced. Assertions on what is on screen use the catalog's sensors; on what is read, `machine.reads`.
- Keep every behaviour of the inventory once, with real sensors; merge the duplicates (shared source read once, no reads during discovery, intervals, failures, rate baselines, the five hide-zeros tests into two).
- Add what is untested: public IP (interval, provider change, the three answers), Refresh, the header of every category in one table-driven test, static processor and GPU info, a non-NVIDIA GPU, WiFi values.
- Dropped: the test that replaces `RegExp.prototype.exec`.
- `tests/sensorMath.test.js`: drop what the `Sensors` tests now cover (reading a valid `/proc/net/dev`, the kilobytes of `/proc/meminfo`); the rest stays, since no other test covers it. `formatter`, `colors`, `categories` stay.

## Shell test (`tests/shell.test.js`)
- The test runs inside the Shell's interpreter, so whatever it replaces, it replaces for the Shell too. It replaces nothing: Vitals reads the machine the test runs on, and Machine is only for the GJS tests.
- The test works from the outside, as a user does: clicks, keys, scrolling and the virtual pointer on the Shell's actors, and the preferences. It finds actors by their text and checks only what is on screen. No private members, no replaced methods. Values are the GJS tests' part.
- Cases from the old test: default panel, pin and unpin from a row's actions, a value instead of "…" once read, categories open, slide and one open at a time, long label (renamed through Rename), rename, hide, hidden sensors, pin to category, category drag and order setting, aggregates option, hardware-only option, panel drag, menu placement, emphasize values, preferences window, disable and enable with the saved reading. Each step puts back the settings and the arrangement it changed.
- Dropped, because they need a machine the test controls: exact values, rates after their second reading, an interface plugged in and out, the scrollbar of a category made long by many interfaces, fixed widths growing and keeping, the open menu staying in place when the item gets wider.

## Faults
`Sensors` has no members for tests to replace any more: `clock` and `now` are module functions, the rest are direct calls. A fault is a `console.error` or `console.warn`. In the GJS tests, `tests/harness.js` collects them from the log; a test that expects one takes it with `takeFaults`, and any other fails the test.

## Order
1. Machine and fixture → 2. `sensors.test.js` → `make test` → 3. Shell test → `make test-shell` → 4. AGENTS.md testing section, last.

## Size
Before: 3193 lines (sensors 1329, collection 530, shell 1001, sensorMath 87, machine 136, fixture 110). Target: about 1800. Result: 2172 (sensors 1188, shell 516, sensorMath 78, machine 185, fixture 205); fewer tests, but every check of the old ones kept.

## Verification
- `make test` and `make test-shell` pass, full output.
- `rg` over `tests/` finds no `\._\w+` on `Sensors` or the button, no `addSource`, and no assignment to a member of `Sensors` or the button but the callbacks the extension sets.
