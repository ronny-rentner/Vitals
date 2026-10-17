# Vitals — agent notes

GNOME Shell extension (`Vitals@CoreCoding.com`) that polls hardware sensors asynchronously and shows them in the top bar. Runtime is GJS ES modules (Shell 50 and later). Official getting-started and practices: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

## Layout

The install directory **must match** `metadata.json` `uuid`. User install: `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

Required: `metadata.json`, `extension.js`. This repo also uses `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, helpers, and icons.

Required metadata: `uuid`, `name`, `description`, `shell-version`, `url`. This project also sets `settings-schema`, `gettext-domain`, and `donations`. It sets no `version`: the EGO site owns submission versioning.

## Versions and size

Decided on 2026-10-10: only current GNOME versions are supported, and nothing is written for older ones. `metadata.json` lists GNOME 50 and 51: the sidebar of the preferences is `Adw.ViewSwitcherSidebar`, which libadwaita has since 1.9. When a newer GNOME feature does a job with less code, it is used and the minimum goes up. An older version keeps being supported only when that is easy and costs next to no code; when it costs more, it is dropped from `metadata.json`. No fallbacks, version checks or second code paths beyond that.

The fewer lines, the better: of two ways that do the job, the one with less code is taken, and a chance to remove lines is said out loud.

## ES modules

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

- One `tests/<module>.test.js` per module, all run in GJS, each in an interpreter of its own.
- Nothing in Vitals is replaced, made up or read from a private member. A test uses `Sensors` as the extension does, the callbacks the extension sets included, and changes only the machine and the settings.
- A test of `Sensors` drives it through a `Machine` (`tests/machine.js`), the test double for the system that `Sensors` monitors. It stands in for the files under `/sys` and `/proc`, the space of the mounted filesystems, the mounts of `Gio.VolumeMonitor`, the public IP services, the monotonic clock and the GLib timers. The test sets and removes files, plugs device groups in and out, fails and holds reads, and skips time instead of waiting out an interval; skipping fires the timers that fall due.
- Fixtures are frozen constants in `tests/fixtures/`; `machine.js` is a ThinkPad in device groups, each file's content exactly as the kernel presents it. No test changes a fixture.
- Everything mutable is created inside the test and ends with it. A `setup()` helper may build it; it holds no data.
- In the GJS tests, a `console.error` or `console.warn` fails the test, unless the test expects it and takes it with `takeFaults`.
- `nvidia-smi` is a real program in the tests, a stand-in that the test puts first in `PATH`.
- Compute every expected value from the machine's current contents or from named inputs in the same test. Formatted strings in `tests/formatter.test.js` are the specification and stay literal.
- `tests/shell.test.js` runs in the Shell's own interpreter, so whatever it replaced, it would replace for the Shell too: it replaces nothing, and Vitals reads the machine the test runs on. It acts as a user does, through a virtual pointer and keyboard and the settings, and checks only what is on screen. Each step puts back the settings and the arrangement it changed. It needs a machine with two temperatures or more, and English as the language.

### Screenshots

`make screenshots` takes the pictures in `docs/screenshots/` again, with the schema defaults and the values of the machine it runs on. The script switches the public IP address off, because the pictures are published. A new display option of the top bar gets a picture in the script and a place in `docs/screenshots/README.md`.

## Units

Units are written as the standards write them (SI, and IEC 80000-13 for bits and bytes), decided on 2026-10-08: `kB`, `MB` for thousands and `KiB`, `MiB` for 1024s, `kHz`, and a rate as the unit with `/s`: `kB/s` for bytes and `kbit/s` for bits, never `Kbps`. The lists are at the top of `formatter.js`, and `tests/formatter.test.js` holds the spellings.

## Texts of settings

A setting has a name and a description, in `prefs.js` and again in the schema.

The preferences window is written in code, in `prefs.js`, with no UI file (decided on 2026-10-10). `fillPreferencesWindow` reads in the order of the window, and a setting is one call that holds everything about it. No list of settings and no loop that produces rows from one.

The rows are libadwaita's own, with one exception: a number is a `Gtk.SpinButton` in an `Adw.ActionRow`, because an `Adw.SpinRow` is not seen as something to type into. Nothing sets margins. Elements are called by the names GNOME gives them: toggle group, combo row.

Colour scales follow one rule (decided on 2026-10-10), `colorStyle` in `helpers/colors.js`: a category's scales colour that category's sensors, a scale is for one sensor or for all sensors of the category with the same kind of value, and which end is the bad one is a fact about the sensor (`lowIsBad`), not the user's choice.

A setting is on the page of what it changes: General, Top Bar, Menu, or a category's page. On a page, a setting's name does not repeat the page ("Hide icons"); the schema has no pages, so its names say the whole thing ("Hide icons in top bar"). Page and group titles are capitalised like headings, names of settings and list entries like sentences.

- The name says what the setting does. The description says what the user cannot see from the name and needs in order to decide: what the setting affects, what it leaves alone, or what happens otherwise. It never repeats the name in other words.
- One sentence, two at most. A detail that does not change the user's decision is left out.
- When behaviour changes, the texts of the settings it touches are checked in the same change.

## Code in this repo

- Do not poll or format on the main thread; keep `Gio.File.load_contents_async` / subprocess patterns.
- No `libgtop` (decided on 2026-10-08): it gives the same numbers from the same files as about 50 lines of our own parsing, and would add a package that is often not installed and calls that block the main thread. Storage space comes from GLib (`query_filesystem_info_async`).
- Gettext: `_()` from the Extension/prefs import, domain `vitals`.
- GObject subclasses: `GObject.registerClass` + unique `GTypeName`.
- Icons: `St.Icon` / `Gtk.Image`, not emoji. An icon is found by its name in the user's icon theme, so that a theme can replace it; our own are named `vitals-…-symbolic` and are in the folder of each icon style, which is searched last. The country icons in `icons/countries/` are drawn by `make country-icons`.
- Line length: stay under ~200 characters (EGO review UI).
- Temperatures come from `/sys/class/hwmon` and `/sys/class/thermal`. A thermal zone is left out when it is not a sensor, when the kernel also publishes it through hwmon, or when an hwmon driver reports the same value; the lists are in `sensors.js`.
- The sensor catalog is described in `docs/catalog-design.md`; read it before changing `sensors.js` or `extension.js`. It is plain data without functions, saved as a whole in the `catalog` setting.
- `Sensors` (`sensors.js`) is the collector: it knows every sensor, reads the ones that are shown, and alone writes the catalog; the one exception is the preferences window, which writes a category's `enabled` switch. `extension.js` is the renderer: it displays the catalog, marks what is on screen (`shown`, `shownChanged`), and changes the panel only through `setPanelSensorVisible` and `movePanelLink`.
- A tick is one pass over the catalog: every source of a sensor on screen is read once, taken apart once, and writes all its sensors. A new kind of sensor is a new field and a new branch in `Sensors._value`, not a function in the catalog.
- An average, minimum or maximum has no source: when one is on screen, every sensor of its category is read and the three are computed together once.
- What a read costs is decided by the kernel (measured on 2026-10-08): a `/proc` file or a `coretemp` temperature about 0.05 ms of CPU, a ThinkPad temperature 0.3 ms, a thermal zone that asks the firmware 0.7 ms, a ThinkPad fan 1 ms.
- A key tells a sensor apart only inside its category and is used to find a sensor only at launch and in discovery's matching; everything else holds the sensor itself. It is built from what the kernel provides, never from a label (`docs/sensor-key-format.md`). There is no migration code, and none is to be added.
- Nothing is removed from the catalog when a device goes away: a sensor is present when the last discovery run of its category found it (`sensorPresent`), and only present sensors are shown and read. A sensor that is not in the panel is dropped after a year without being found.
- Discovery runs at start, when a setting that affects it changes, when the menu opens, so that a device plugged in since is there when the user looks, and on Refresh. No sensor is read during a run. Refresh then reads every shown value at once, ignoring intervals such as the public IP's.
- No program is started to read a sensor (decided on 2026-10-10). `nvidia-smi` is the one exception, since NVIDIA offers no other way.
- A rule that says what something on a machine is, such as which mounts are storage, is not made up here (decided on 2026-10-11): this code is only ever seen running on one machine. It is taken unchanged from a program that has proven it on many machines, such as `df` or libgtop, and the comment names the source. Where the user can decide instead, the user decides.
- The Storage category shows the storage locations the user chose (decided on 2026-10-11). A storage location is a mount point, not any path: the folder of a disk that is not plugged in lies on another disk, whose numbers would be shown under its name. At the start `/` is the only one.
- What is mounted where comes from `/proc/self/mountinfo` (`parseMountTable`). An automount that waits to be used counts as nothing mounted, since asking it would connect it.
- The space of a location is asked from the kernel, once per location. The mount table is read first, because asking a path where nothing is mounted any more would connect an automounted share again. A location is not asked again while a question is out: a share whose server is gone can take minutes to answer.
- A network location is one that `df` counts as remote (`isRemoteMount`, gnulib's `ME_REMOTE` as it is). It is asked at an interval of its own, `storage-network-interval`, which works like the public IP's interval in every part.
- Monitored are the mount points in the setting `storage-locations`; one stays in it while nothing is mounted there. With `storage-monitor-volumes` (off by default), the mounts of `Gio.VolumeMonitor` are monitored too: GIO collects them from the volume monitor services of gvfs, of which `gvfs-udisks2-volume-monitor` reports the disks. The preferences call them "drives mounted by GNOME". A location is added by picking it from what is mounted now, not by typing; offered first are those that libgtop counts as a disk or `df` as remote.
- Network sensors follow `/proc/net/dev`: when a reading shows other interfaces than the catalog has, discovery of the network category follows at once. There are no placeholder rows for missing interfaces.
- The network totals are over the hardware interfaces only: what a bridge, a container or a VPN carries passes a hardware interface as well and would count twice. An interface is hardware when the kernel gives it a `device` entry under `/sys/class/net/<name>/`.
- The network menu is in sections, which a sensor names in its `section` field. `network-hardware-only` is a display setting, on by default: with it on, interfaces that are not hardware have no menu row.
- A category has one name, `name` in `sensorCategories` (`helpers/categories.js`), which the menu and the preferences show translated. It is typed nowhere else and not derived from the key.
- Rows are in alphabetical order inside their section. Categories are in alphabetical order until the user drags them; the arrangement is saved in the catalog and holds for the menu and the sidebar of the preferences alike.
- The average, minimum and maximum of the temperatures and of the fans are a section of their own; `include-aggregates` only decides whether they have menu rows.
- The renderer changes only what changed: one row, one top-bar item. A row is relabelled or moved, not rebuilt. Only a change of a display setting may redraw everything.
- Dragging a sensor in the top bar concerns only the renderer; the collector keeps reading.
- The menu opens with its middle under the pointer, or under the middle of the item when opened from the keyboard or with the "Open centered under the sensors" option, and stays at that place while it is open.
- The `emphasize-values` option (on by default) is the part of the top bar's look that is a matter of taste: icons and units lighter and smaller than the numbers.
- The rules for the look of the top bar (decided on 2026-10-11). The values themselves are in `stylesheet.css` and are not repeated here.
  - A distance is a fixed value in the stylesheet, set in one place: the `spacing` of the box whose children it separates. A user who wants another distance overrides that one rule. Nothing else adds to a distance, so the margin and padding that the Shell's theme gives a status icon are taken off.
  - Nothing about a text or an actor is measured to place it. Code that measured where the glyphs are drawn gave uneven distances three times.
  - No special case without the user's explicit approval: hidden icons get the same distances, and there is no margin per icon.
  - A class of the Shell is not put on something for a side effect; the battery's class `power-status` on every sensor was such a case.
  - A value is one label, with the unit marked inside its text for the "emphasize values" option. Only inside one text do two sizes stand on one line of writing: the Shell's boxes line their children up by edges and know no baseline.
  - The stylesheet does not set `tnum`: the Shell's theme sets it on the whole top bar.
- With the "fixed widths" option, a top-bar value keeps the room of its widest text of the last minute. While the option is off, no width is remembered.
- The dropdown menu has a fixed width; in a row that is too narrow the label is shortened, never the value.
- A category slides with a slide of our own, never GNOME Shell's: the Shell only slides a submenu that needs no scrollbar, so long and short categories would behave differently. One category is open at a time, and it stays open while the menu is closed.
- Every battery is found by itself (`type` is `Battery`), also that of a mouse or a keyboard; there is no setting for which battery to show and no list of battery names. With several batteries a label names its battery, a device's battery (`scope` is `Device`) by the device's model. With several batteries that power the machine there is one more sensor, the total power rate, which the header shows; otherwise the header shows the power rate of the one battery, or the percentage of a device's battery, which has no power rate.
- A click on a row opens a panel with that sensor's actions under the row and does nothing else: Pin to top bar, Pin to category, Rename, Hide. A row's marks only show the state.
- The panel follows the second-level menus of GNOME Shell's quick settings (`QuickToggleMenu`), decided on 2026-10-09 after a design of our own was not recognisable as belonging to its row.
- A click anywhere else closes the panel and does nothing else. Escape closes the whole menu, as in every menu of the Shell.
- Each level of the menu starts under the name of the level above it.
- What the user sets on a sensor is saved in the catalog, in fields that discovery leaves alone (`customLabel`, `hidden`, `categoryDefault`). A hidden sensor does not count in its category's average, minimum and maximum, and keeps its top-bar item when pinned.
- A header's sensor is chosen when the hardware is looked for and when the user pins one, never between.
- A panel link whose device is not there keeps its place and has no top-bar item until the device is found.
- What comes on screen is read at once, not at the next tick (decided on 2026-10-10), unless it was read during the last update interval. A rate gets its second reading a second later.
- At start the collector reads as soon as discovery ends. Until then every value is "…": readings are not saved.
- The catalog is written when a sensor is added or forgotten and when the user changes the panel.
- A sensor read that fails is an expected state, not an error: the sensor becomes `unavailable`, its row is hidden, and it is logged with `console.debug`. `console.error` is for faults.
