# Development

Vitals is a GNOME Shell extension (`Vitals@CoreCoding.com`) that reads hardware sensors asynchronously and shows them in the top bar. It runs as GJS ES modules in GNOME Shell 50 and later. GNOME's own guides: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

The terms used here are defined in [glossary.md](glossary.md). How the sensor catalog works is in [catalog-design.md](catalog-design.md), the other decisions about what Vitals does are in [design.md](design.md).

## Files

The install directory has the name of the `uuid` in `metadata.json`; a user install is in `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

GNOME Shell requires `metadata.json` and `extension.js`. Vitals also has `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, `helpers/` and `icons/`.

`metadata.json` has the required `uuid`, `name`, `description`, `shell-version` and `url`, and also `settings-schema`, `gettext-domain` and `donations`. It has no `version`: extensions.gnome.org numbers the uploads.

| File | Process | Toolkit |
|---|---|---|
| `extension.js` and the modules it imports | `gnome-shell` | Clutter / St |
| `prefs.js` | a GTK program of its own | GTK 4 / Adwaita |

A helper imported by both may import neither `St`/`Clutter` nor `Gtk`/`Adw`/`Gdk`. `stylesheet.css` applies to the Shell only, not to the preferences. The schema id is in `metadata.json`, so both entry points call `this.getSettings()` without an argument.

## GNOME versions and size

Only current GNOME versions are supported, and nothing is written for older ones (decided on 2026-10-10). `metadata.json` lists GNOME 50 and 51: the sidebar of the preferences is `Adw.ViewSwitcherSidebar`, which libadwaita has since 1.9. When a newer GNOME feature does a job with less code, it is used and the minimum goes up. An older version stays supported only while that costs next to no code; otherwise it is dropped from `metadata.json`. There are no fallbacks, version checks or second code paths.

Of two ways that do the job, the one with less code is taken.

## Modules

- `extension.js` default-exports a subclass of `Extension` with `enable()` and `disable()`; `prefs.js` default-exports a subclass of `ExtensionPreferences`.
- Libraries are imported as `import St from 'gi://St'`; the preferences pin GTK 4 (`gi://Gtk?version=4.0`).
- Shell modules are imported from `resource:///org/gnome/shell/...` in the Shell, and from `resource:///org/gnome/Shell/Extensions/js/...` in the preferences.
- Files of Vitals are imported by relative path (`./sensors.js`). `imports.` is not used.

## Lifecycle

The constructor runs once, when the extension is loaded. It creates no GObjects, connects no signals, adds no timeouts and changes nothing in the Shell.

- `enable()` builds the UI, connects signals, adds sources and calls `Main.panel.addToStatusArea(...)`.
- `disable()` undoes everything `enable()` did: it destroys widgets, disconnects signals, removes sources, also those that would return `SOURCE_REMOVE` later, and clears the references. The lock screen calls `disable()` as well. An extension that leaves something behind here is the most common reason for a rejection on extensions.gnome.org.

`enable()` and `disable()` are next to each other and small. A timeout is created and removed in adjacent code; `destroy()` and `GLib.Source.remove()` are not wrapped in try/catch.

## Code conventions

- The Shell's main loop is never blocked: a crash or a stall in the Shell process takes the desktop with it. Files are read with `Gio.File.load_contents_async`, programs run through `Gio.Subprocess`.
- Translated texts use `_()` from the Extension or preferences import, domain `vitals`.
- GObject subclasses use `GObject.registerClass` with a unique `GTypeName`.
- Every sensor icon comes from Vitals' own `icons/` folder, never from GNOME's icons.
- Icons are `St.Icon` and `Gtk.Image`, never emoji. An icon is looked up by name in the user's icon theme, so that a theme can replace it. Vitals' own icons are named `vitals-…-symbolic` and lie in the folder of each icon style, which is searched last. The country icons in `icons/countries/` are drawn by `make country-icons`.
- Lines stay under about 200 characters, which is what the review page of extensions.gnome.org shows.
- A new sensor goes into the definition of its source in `sensors.js`; a new source is a new definition there, with the discovery of its sensors.
- Logging: a read that fails is logged with `console.debug`; `console.warn` and `console.error` are for faults. The journal is shared by the whole system, so messages are few.

## Units

Units are written as the standards write them, SI and IEC 80000-13 for bits and bytes (decided on 2026-10-08): `kB` and `MB` for thousands, `KiB` and `MiB` for 1024s, `kHz`, and a rate as the unit with `/s`: `kB/s` for bytes and `kbit/s` for bits, never `Kbps`. The lists are at the top of `formatter.js`, and `tests/formatter.test.js` holds the spellings.

## The preferences

The preferences window is written in code, in `prefs.js`, without a UI file (decided on 2026-10-10). `fillPreferencesWindow` reads in the order of the window, and one call holds everything about a setting. There is no list of settings and no loop that makes rows from one.

The rows are libadwaita's own, with one exception: a number is a `Gtk.SpinButton` in an `Adw.ActionRow`, because an `Adw.SpinRow` does not look like something to type into. Nothing sets margins. Elements are called by the names GNOME gives them: toggle group, combo row.

A setting is on the page of what it changes: General, Top Bar, Menu, or a category's page. A setting has a name and a description, in `prefs.js` and again in the schema.

- On a page, a name does not repeat the page ("Hide icons"). The schema has no pages, so its names say the whole thing ("Hide icons in top bar").
- Page and group titles are capitalised like headings, names of settings and list entries like sentences.
- The name says what the setting does. The description says what the user cannot see from the name and needs in order to decide: what the setting affects, what it leaves alone, or what happens otherwise. It does not repeat the name in other words.
- A description is one sentence, two at most. A detail that does not change the user's decision is left out.
- When behaviour changes, the texts of the settings it touches change with it.

## Running it

GJS caches the modules it has loaded, so a change of code needs a new gnome-shell process; disabling and enabling the extension is not enough.

- `make preview` runs a Shell in a window, with the extension, and keeps its settings under `build/preview`.
- By hand on Wayland: `dbus-run-session gnome-shell --devkit --wayland` (GNOME 49 and later, needs `mutter-devkit`; GNOME 48 and earlier: `--nested --wayland`), then `gnome-extensions enable Vitals@CoreCoding.com` inside that session.
- On X11: Alt+F2, `restart`, then enable. A Wayland session cannot restart in place; log out.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. `SHELL_DEBUG=backtrace-warnings` adds JavaScript stacks. Looking Glass: Alt+F2, `lg`.
- After a change of the schema in a local clone: `glib-compile-schemas --strict schemas/`.

## Tests

`make test` runs the unit tests in GJS. `make test-shell` runs `tests/shell.test.js` inside a gnome-shell without a screen, after resetting the settings under `build/test-shell`, so it starts from the schema defaults.

- There is one `tests/<module>.test.js` per module, each run in an interpreter of its own.
- Nothing in Vitals is replaced, made up or read from a private member. A test uses `Sensors` as the extension does, the callbacks the extension sets included, and changes only the machine and the settings.
- A test of `Sensors` drives it through a `Machine` (`tests/machine.js`), the test double for the system that `Sensors` monitors. It stands in for the files under `/sys` and `/proc`, the space of the mounted filesystems, the mounts of `Gio.VolumeMonitor`, the public IP services, the monotonic clock and the GLib timers. A test sets and removes files, plugs device groups in and out, fails and holds reads, and skips time instead of waiting out an interval; skipping fires the timers that fall due.
- Fixtures are frozen constants in `tests/fixtures/`. `machine.js` there is a ThinkPad in device groups, each file's content exactly as the kernel presents it. No test changes a fixture.
- Everything mutable is created inside the test and ends with it. A `setup()` helper may build it; it holds no data.
- In the GJS tests, a `console.error` or `console.warn` fails the test, unless the test expects it and takes it with `takeFaults`.
- `nvidia-smi` is a real program in the tests: a stand-in in `tests/fixtures/programs`, which the test puts first in `PATH`.
- Every expected value is computed from the machine's current contents or from named inputs in the same test. The formatted strings in `tests/formatter.test.js` are the specification and stay literal.
- `tests/shell.test.js` runs in the Shell's own interpreter, where whatever it replaced it would replace for the Shell too. So it replaces nothing, and Vitals reads the machine the test runs on. It acts as a user does, through a virtual pointer and keyboard and the settings, and checks only what is on screen. Each step puts back the settings and the arrangement it changed. It needs a machine with two temperatures or more, and English as the language.

## Screenshots

`make screenshots` takes the pictures in `docs/screenshots/` again, in a Shell without a screen, with the schema defaults and the values of the machine it runs on. The script is `docs/screenshots/screenshots.js`; `docs/screenshots/README.md` says what each picture shows. The script switches the public IP address off, because the pictures are published. A new display option of the top bar gets a picture in the script and a place in `docs/screenshots/README.md`.
