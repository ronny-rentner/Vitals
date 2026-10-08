# Vitals — agent notes

GNOME Shell extension (`Vitals@CoreCoding.com`) that polls hardware sensors asynchronously and shows them in the top bar. Runtime is GJS ES modules (Shell 45–50). Official getting-started and practices: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

## Layout

The install directory **must match** `metadata.json` `uuid`. User install: `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

Required: `metadata.json`, `extension.js`. This repo also uses `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, helpers, and icons.

Required metadata: `uuid`, `name`, `description`, `shell-version`, `url`. This project also sets `settings-schema`, `gettext-domain`, and `donations`. It sets no `version`: the EGO site owns submission versioning.

## ES modules (GNOME 45+)

- `extension.js` default-exports a subclass of `Extension` with `enable()` / `disable()`.
- `prefs.js` default-exports a subclass of `ExtensionPreferences`.
- Platform libs: `import St from 'gi://St'` (prefs: pin GTK 4, e.g. `gi://Gtk?version=4.0`).
- Shell modules: `resource:///org/gnome/shell/...` in the shell process; prefs use `resource:///org/gnome/Shell/Extensions/js/...`.
- Local files: relative paths (`./sensors.js`). No `imports.` / `this.imports`.

Shared helpers must not import `St`/`Clutter` **and** `Gtk`/`Adw`/`Gdk`. Shell and prefs are different processes.

## Lifecycle

Constructor runs once on load. Do not create GObjects, connect signals, add timeouts, or change the Shell there.

- `enable()`: build UI, connect, add sources, `Main.panel.addToStatusArea(...)`.
- `disable()`: undo **everything** from `enable()`. Destroy widgets, disconnect, remove sources even if they would later return `SOURCE_REMOVE`, then null references. Screen lock also calls `disable()`. This is the usual EGO rejection reason.

Keep `enable()` / `disable()` next to each other and small. Timeout create/remove stay adjacent; do not wrap `destroy()` / `GLib.Source.remove()` in try/catch.

## Process split

| File | Process | Toolkit |
|---|---|---|
| `extension.js` and shell modules | `gnome-shell` | Clutter / St |
| `prefs.js` | separate GTK app | GTK 4 / Adwaita |

A crash in the shell process can take down the desktop. Prefer async I/O (this project’s design). Do not block the main loop.

`stylesheet.css` applies only to Shell UI, not prefs.

Settings: schema id lives in metadata; entry points use `this.getSettings()` with no argument.

## Testing

GJS caches loaded modules. **Code changes require a new gnome-shell process**, not just disable/enable.

- Wayland: `dbus-run-session gnome-shell --devkit --wayland` (GNOME 49+; needs `mutter-devkit`). GNOME 48 and earlier: `--nested --wayland`. Then `gnome-extensions enable Vitals@CoreCoding.com` inside that session.
- X11: Alt+F2 → `restart`, then enable. Wayland sessions cannot restart in-place; log out.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. Use `console.debug` / `warn` / `error`; keep volume low (journal is system-wide). `SHELL_DEBUG=backtrace-warnings` adds JS stacks. Looking Glass: Alt+F2 → `lg`.

Local clone: compile schemas after schema edits (`glib-compile-schemas --strict schemas/`). See README for develop-branch install.

### Automated tests

`make test` runs the unit tests in GJS; `make test-shell` runs `tests/shell.test.js` inside a headless gnome-shell. `make test-shell` resets the extension's settings under `build/test-shell` first, so it starts from the schema defaults.

- One `tests/<module>.test.js` per module under test. All run in GJS, the runtime the extension ships in. `sensors.js` has two: `sensors.test.js` for what it reads from a machine, and `sensors.collection.test.js` for how it collects, with made-up sources. The collection tests and `tests/shell.test.js` add made-up sensors to the catalog, each with a made-up source as its `file`, and replace `Sensors._value` for them, since a made-up sensor has no rule of its own.
- `tests/harness.js` holds the shared `test`, `equal`, `mean`, `settings` and `runTests`.
- Fixtures are fixed data: frozen constants in `tests/fixtures/`. `tests/fixtures/machine.js` is the `/sys` and `/proc` of the test machine, a ThinkPad with its real device names, keyed by path, with each file's content exactly as the kernel presents it (trailing newline included). No test changes a fixture.
- Everything mutable is created inside the test and ends with it: the object under test, a `Machine` (`tests/machine.js`), the clocks, and settings in a private in-memory backend, which also hold the saved catalog. A `setup()` helper may build them; it holds no data.
- A `Machine` starts with a fixture's files, and the test drives it by writing and removing files. `setup()` puts it behind `Gio.File.new_for_path`, so `Sensors` runs unmodified, including its own file reading. The test process only runs tests, so the replacement is never restored. A test steers what `Sensors` meets through the machine as well: `failReads`, `failLists`, and `holdNextRead` to keep a read open. It does not replace methods of `Sensors` for that.
- `nvidia-smi` is a real program in the tests: `tests/fixtures/programs/nvidia-smi` is a stand-in that the test puts first in `PATH` and gives a card list, so `Sensors` starts, reads and stops it like the real one.
- Compute every expected value from the machine's current contents or from named inputs in the same test. Do not type in a number that was calculated by hand from values defined elsewhere. Formatted strings in `tests/formatter.test.js` are the specification and stay literal.

## Texts of settings

A setting has a name and a description, in `prefs.ui` and again in the schema.

- The name says what the setting does. The description says what the user cannot see from the name and needs in order to decide: what the setting affects, what it leaves alone, or what happens otherwise. It never repeats the name in other words.
- One sentence, two at most. A detail that does not change the user's decision is left out.
- When behaviour changes, the texts of the settings it touches are checked in the same change.

## Code in this repo

- Do not poll or format on the main thread; keep `Gio.File.load_contents_async` / subprocess patterns.
- No `libgtop` (GTop). Decided on 2026-10-08: it covers only memory, processor usage, load, uptime, network counters and storage space, which are about 50 lines of our own parsing of `/proc`; it reads the same files and gives the same numbers; and it would add a package that is often not installed, calls that block the main thread, and values the tests cannot feed. Storage space comes from GLib (`query_filesystem_info_async`), which returned the same bytes as GTop on five filesystems.
- Gettext: `_()` from the Extension/prefs import, domain `vitals`.
- GObject subclasses: `GObject.registerClass` + unique `GTypeName`.
- Icons: `St.Icon` / `Gtk.Image`, not emoji.
- Line length: stay under ~200 characters (EGO review UI).
- Temperatures come from `/sys/class/hwmon` and from `/sys/class/thermal`. A thermal zone is left out when it is not a sensor (`NON_SENSOR_THERMAL_ZONE_LABELS`), when the kernel also publishes it through hwmon, or when an hwmon driver reports the same value (`THERMAL_ZONE_HWMON_EQUIVALENTS`). All three are in `sensors.js`. "Published through hwmon" holds for every zone of a type when one zone of that type contains an `hwmon*` directory: zones of the same type share one hwmon device, and its directory is inside the first of them only.
- The sensor catalog is described in `docs/catalog-design.md`; read it before changing `sensors.js` or `extension.js`. In short: the catalog is plain data, categories that hold their sensors in order, plus the panel as a category of links. It contains no functions, and nothing about a sensor is kept beside it. It is saved as a whole in the `catalog` setting.
- `Sensors` (`sensors.js`) is the collector: it knows every sensor, reads the ones that are shown, and saves the catalog. `extension.js` is the renderer: it displays the catalog and reads the user's display settings. It marks what is on screen with `shown` on sensors and categories and then calls `shownChanged`; it changes the panel only through `setPanelSensorVisible` and `movePanelLink`. Only `Sensors` writes the catalog, with one exception: the preferences window writes the `enabled` switch of a category (`writeCategoryEnabled`).
- A sensor that is read says in its `file` field which file it comes from; `/proc/meminfo` for the memory sensors, its own file for a temperature. The few sources that are not a file are named in code: `nvidia-smi` for a sensor with an `nvidia` field, and the filesystem, the public-IP service, the frame counter and the per-core frequency files in the `FIXED` table.
- A tick is one pass over the catalog (`Sensors._select`): it collects the sources of the sensors that are on screen, each with the sensors that are written from it. Every source is read once, its content is taken apart once (`PARSERS`), and the read writes all its sensors (`_write`). How one sensor's value follows from the reading is `Sensors._value`: the `FIXED` table for the sensors found by their key, otherwise the sensor's fields `interface`, `core`, `nvidia`, or the plain number of its file. A new kind of sensor is a new field and a new branch there, not a function in the catalog.
- An average, minimum or maximum has no source. When one of them is on screen, every sensor of its category is read, and the three are computed together once, after the last of those reads (`_summarise`). The voltage header works the same way: all voltages are read and the header takes the best one.
- What a read costs is decided by the kernel, not by this code: a `/proc` file or a `coretemp` temperature about 0.05 ms of CPU, a ThinkPad temperature about 0.3 ms, a thermal zone that asks the firmware (`SEN1`, `TCPU`) about 0.7 ms, a ThinkPad fan about 1 ms. Measured on 2026-10-08 with `Gio.File.load_contents_async`.
- A key tells a sensor apart only inside its category, and two sensors may have the same key. A key is used to find a sensor only at launch and in discovery's matching (`_load`, `_unmatched`). Everything else holds the sensor itself. The format is in `docs/sensor-key-format.md`. A key is built from what the kernel provides, never from the label shown in the menu. There is no migration code, and none is to be added.
- Nothing is removed from the catalog when a device goes away. A discovery run gives its timestamp to every sensor it finds and then to every category it completed. A sensor is present when its `discovered` is not older than its category's (`sensorPresent` in `helpers/storedCatalog.js`); only present sensors are shown and read. A sensor that is not in the panel is dropped after a year without being found.
- Discovery runs when the extension starts, when a setting that affects it changes, when the menu opens, and on the Refresh button. Discovery on menu open is deliberate: a device plugged in since the last discovery is there when the user looks. No sensor is read while a run is in progress: reads under way are cancelled and a tick that falls into a run is skipped. Refresh rediscovers and then reads every shown value at once, ignoring source intervals such as the public-IP interval.
- Network sensors follow `/proc/net/dev`: when a reading shows other interfaces than the catalog has, a discovery run for the network category alone follows at once. An interface that disappears is not present any more, and one that returns is the same sensor again, like any other device. There are no placeholder rows for missing interfaces.
- The network totals ("Download speed", "Upload speed", "Total speed", and the volumes since boot and this session) are over the hardware interfaces only. An interface is hardware when the kernel gives it a `device` entry under `/sys/class/net/<name>/`; discovery records that in the sensor's `hardware` field. What a bridge, a container's or a VPN's interface carries passes a hardware interface as well and would otherwise count twice. Every interface keeps its own sensors. A hardware interface is labelled by its kind and its name, "WiFi (wlp0s20f3) download speed"; the kind comes from the `DEVTYPE` line of `/sys/class/net/<name>/uevent`, and an interface without one is "Ethernet". A virtual interface is labelled by its name alone.
- The network menu is in sections: the machine's speeds, the hardware interfaces with the two WiFi values, the volumes, other values, and the virtual interfaces. A network sensor names its section in its `section` field (`NETWORK_SECTION` in `sensors.js`). The renderer keeps the rows of a section together and sorts them alphabetically inside a section (`_sensorsInRowOrder`). It draws one line, above the virtual interfaces. The `network-hardware-only` option is a display setting: with it on, the renderer gives the interfaces that are not hardware no menu row.
- Rows are always in alphabetical order inside their section, and the categories are in the alphabetical order of their names in the menu. There is no option for it.
- The average, minimum and maximum over the temperatures and over the fans are marked `aggregate` in the catalog and are a section of their own, below the sensors and under a line. The `include-aggregates` option is a display setting: with it off, the renderer gives them no menu row. They are still computed where needed: the header of the temperature and fan categories shows the average either way.
- The renderer changes only what changed: a sensor that appears or disappears adds or removes its own menu row (`_syncCatalog`), and pinning, unpinning or a sensor returning adds or removes that one top-bar item (`_syncPanelItems`). Only a change of a display setting may redraw everything.
- Dragging a sensor in the top bar affects only the renderer: it holds the display still until the drop and then saves the new order. The collector is not paused or told about a drag; it keeps reading, so the values are current at the drop.
- A row belongs to its sensor for as long as the sensor is present. When discovery gives the sensor another label or section, `_syncCatalog` relabels or moves that row; it is not rebuilt.
- The menu opens with its middle under the pointer when the pointer is on the Vitals item, as after a click (`_alignMenu`). Opened from the keyboard, or with the "Menu centered under panel sensors" option, its middle is under the middle of the item. GNOME Shell moves it back in when it would leave the screen. While the menu is open it stays there: the Shell places a menu relative to its item, whose width changes with its values, so `_anchorMenu` re-attaches the menu to the same place on screen whenever the item's size or position changes.
- The `emphasize-values` option (on by default) is the part of the top bar's look that is a matter of taste: icons and units lighter and smaller than the numbers. With it off, icons have the Shell's size and full strength, and units look like their numbers. Everything else described in the next point holds either way.
- The look of a top-bar item. The icon files have different amounts of empty room beside their drawings (`iconInsets` in `helpers/categories.js`, checked against the files by `tests/categories.test.js`); `_createPanelItem` sets each icon's and item's margins from it, so every drawing is the same distance from the item before it and from its value. Icons are drawn lighter than the values. A value is a `PanelValue` (`panelValue.js`): the number and, in a label of its own that the stylesheet makes smaller and thinner, the unit; `Formatter.format` says which part of a text is the unit. The unit stands close to its number, without the space of the full text, and on the number's baseline: `PanelValue` moves it down by the difference of the two fonts' baselines, since a box only lines children up by their edges. Icons are a step smaller than the text is tall (`PANEL_ICON_EM`). Digits have one width (`tnum` in `stylesheet.css`). The unit is a second label and not markup inside one label, because the Shell's text styling replaces such markup when a label is restyled.
- With the "fixed widths" option, a top-bar value keeps the room of its widest text until the text has been shorter for one minute (`WIDTH_MEMORY_SECONDS`, `_reservedWidth` in `extension.js`). A value that keeps changing length does not push its neighbours around, and one that stays shorter gives the room back.
- The dropdown menu has a fixed width (`.vitals-menu` in `stylesheet.css`), so it does not change size with its values. In a row that is too narrow, the label is shortened with "…" and the value is shown in full (`menuItem.js`).
- A category opens and closes at once, without animation. GNOME Shell slides a submenu only when it needs no scrollbar, so long and short categories would behave differently; `_initializeMenuGroup` switches the slide off for all. One category is open at a time and a long one scrolls inside itself, as the Shell does it. The open category stays open while the menu is closed, so it is there when the menu opens again; the Shell would close it, and `_initializeMenuGroup` leaves out that one close. This is not saved: after a restart all categories are closed.
- A panel link is shown when it is marked visible, its sensor is present, and that sensor's category is switched on; a link whose device is not there keeps its place and has no top-bar item until the device is found.
- At start the extension looks for hardware and then reads once at once; it does not wait for the first tick. Until that reading arrives, a saved reading is shown if it is at most a minute old (`SAVED_READING_SECONDS`), as after a short screen lock; an older one is not, and "…" is shown.
- The catalog is written when a sensor is added or forgotten and when the user changes the panel. The readings are written when the extension stops, not on every tick; after the next launch they are shown with the status `saved` until the first reading replaces them.
- A sensor read that fails is an expected state, not an error: the sensor's status becomes `unavailable` and its row is hidden. It is written with `console.debug`, which the journal only shows when debug output is switched on (`G_MESSAGES_DEBUG=all`). `console.error` is for faults: a discovery step that throws, `nvidia-smi` failing, a stream that cannot be closed.
