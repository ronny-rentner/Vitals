# Development

[Documentation index](../README.md#development)

Vitals is a GNOME Shell extension (`Vitals@CoreCoding.com`) that reads hardware sensors asynchronously and shows them in the top bar. It runs as GJS ES modules and supports GNOME Shell 50 and 51. GNOME's own guides: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

The terms used here are defined in [glossary.md](glossary.md). How the sensor catalog works is in [catalog-design.md](catalog-design.md), the other decisions about what Vitals does are in [design.md](design.md).

## Getting started

Use the [installation instructions](../README.md#installation) to clone this fork and build its package. Run development commands from that checkout.

- `make test` needs GJS and `glib-compile-schemas`.
- `make preview`, `make test-shell` and `make screenshots` also need GNOME Shell, `dbus-run-session`, PipeWire, WirePlumber and the GNOME settings tools. The interactive preview needs `mutter-devkit`.
- Packaging needs `msgfmt` and `zip` as well; see [builds and releases](#builds-and-releases).

Start with `make test`, then use the [preview](#running-it) for UI changes. Read [Writing tests](writing-tests.md) before adding or changing tests, and the [icon rules](design.md#icons) before changing artwork or sizing.

## Files

The install directory has the name of the `uuid` in `metadata.json`; a user install is in `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

GNOME Shell requires `metadata.json` and `extension.js`. Vitals also has `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, `helpers/` and `icons/`.

`metadata.json` declares the extension's identity, supported Shell versions, settings schema, translation domain and project links. Versioning is covered below.

| File | Process | Toolkit |
|---|---|---|
| `extension.js` and the modules it imports | `gnome-shell` | Clutter / St |
| `prefs.js` | a GTK program of its own | GTK 4 / Adwaita |

A helper imported by both may import neither `St`/`Clutter` nor `Gtk`/`Adw`/`Gdk`. `stylesheet.css` applies to the Shell only, not to the preferences. The schema id is in `metadata.json`, so both entry points call `this.getSettings()` without an argument.

## Metadata versioning

Verified against GNOME's documentation and website source on 2026-10-30:

- [`version`](https://gjs.guide/extensions/overview/anatomy.html#version) is an optional integer submission counter controlled by extensions.gnome.org. The documentation says: "This field SHOULD NOT be set by extension developers." The website overrides it; setting it can affect automatic upgrades or downgrades. This is a recommendation against setting it, not a claim that the field is invalid.
- The [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html#metadata-json-must-be-well-formed) mark `version` as deprecated and reserved for the website's internal use.
- The [website implementation](https://github.com/GNOME/extensions-web/blob/master/sweettooth/extensions/models.py) confirms this: `ExtensionVersion.save()` assigns the next submission number, `make_metadata_json()` overwrites `version`, and `_replace_metadata_json()` writes that metadata into the uploaded ZIP.
- [`version-name`](https://gjs.guide/extensions/overview/anatomy.html#version-name) is the optional developer-controlled string for the version shown to users.

Vitals omits `version` in source metadata to follow this guidance. GitHub releases take their names from pushed tags beginning with `v` followed by a digit, independently of the website's submission counter.

## Builds and releases

`make zip` compiles the settings schema and translations, then packages the extension as `vitals.zip`. It requires `glib-compile-schemas`, `msgfmt` and `zip`.

GitHub Actions runs `make test` on branch pushes, pull requests and release tags. Only a release-tag push builds the ZIP with `make zip`, checks it with `shexli`, then publishes a GitHub release with that ZIP. The release job requires the tests to pass. No ZIP is built or published for branch pushes or pull requests. The Shell UI tests remain a local check because they require GNOME Shell and real sensor hardware.

## Translations

`locale/vitals.pot` lists the messages, and each language has `locale/<language>/LC_MESSAGES/vitals.po` and its compiled `.mo` file. `make translations` rebuilds all compiled catalogs; `make zip` includes that step. Keep the compiled files with their catalog changes.

Category names, sensor labels and section headings are translated when displayed. Their plain string literals also need entries in the translation template and catalogs; extracting only literal `_()` calls does not include them. Validate changed catalogs with `msgfmt --check --statistics -o /dev/null <file.po>` and review fuzzy matches before accepting them.

## GNOME versions and size

Support targets current GNOME versions (decided on 2026-10-10). `metadata.json` lists GNOME 50 and 51; preferences use `Adw.ViewSwitcherSidebar`, available since libadwaita 1.9. The development rule is to use GNOME's APIs directly rather than maintain compatibility branches for older releases. Propose changes to the supported versions explicitly and update `metadata.json` and the installation docs together.

Of two ways that do the job, the one with less code is taken.

## Modules

- `extension.js` default-exports a subclass of `Extension` with `enable()` and `disable()`; `prefs.js` default-exports a subclass of `ExtensionPreferences`.
- Libraries are imported as `import St from 'gi://St'`; the preferences pin GTK 4 (`gi://Gtk?version=4.0`).
- Shell modules are imported from `resource:///org/gnome/shell/...` in the Shell, and from `resource:///org/gnome/Shell/Extensions/js/...` in the preferences.
- Files of Vitals are imported by relative path (`./sensors.js`). `imports.` is not used.

## Lifecycle

The exported `Extension` class has no custom constructor. Loading the module does not build the UI or start monitoring; `enable()` creates the panel button and collector.

- `enable()` builds the UI, connects signals, adds sources and calls `Main.panel.addToStatusArea(...)`.
- `disable()` destroys the panel button and clears the extension's reference to it. Destruction must disconnect signals, remove timers and cancel pending work, including timers that would later remove themselves.

The panel button's `destroy` signal saves the catalog first, then stops the refresh timer and destroys the collector. This also runs when Shell shutdown destroys the button without calling the extension's `disable()` method. The collector cancels pending reads and discards their completions, preventing updates to destroyed UI objects.

Keep `enable()` and `disable()` small, and make cleanup explicit wherever a signal, timer or asynchronous operation is added. Do not wrap `destroy()` or `GLib.Source.remove()` in try/catch to conceal lifecycle errors.

## Code conventions

- The Shell's main loop is never blocked: a crash or a stall in the Shell process takes the desktop with it. Files are read with `Gio.File.load_contents_async`, programs run through `Gio.Subprocess`.
- Translated texts use `_()` from the Extension or preferences import, domain `vitals`.
- GObject subclasses use `GObject.registerClass` with a unique `GTypeName`.
- Vitals ships its own sensor icons in `icons/`, with names that a user's icon theme can override.
- Before changing icon artwork or sizing, follow the [icon design and approval rules](design.md#icons), including verification at actual panel size.
- Icons are `St.Icon` and `Gtk.Image`, never emoji. An icon is looked up by name in the user's icon theme, so that a theme can replace it. Vitals' own icons are named `vitals-…-symbolic` and lie in the folder of each icon style, which is searched last. The country icons in `icons/countries/` are drawn by `make country-icons`.
- The `crop-icons` setting selects `CroppedIcon` or stock `St.Icon` through `PanelIconType` in `extension.js`. Cropping, its cache and lifecycle are confined to `croppedIcon.js`. Menu icons always use stock `St.Icon`.
- Lines stay under about 200 characters, which is what the review page of extensions.gnome.org shows.
- A new sensor goes into the definition of its source in `sensors.js`; a new source is a new definition there, with the discovery of its sensors.
- Logging: a read that fails is logged with `console.debug`; `console.warn` and `console.error` are for faults. The journal is shared by the whole system, so messages are few.

## Units

Units are written as the standards write them, SI and IEC 80000-13 for bits and bytes (decided on 2026-10-08): `kB` and `MB` for thousands, `KiB` and `MiB` for 1024s, `kHz`, and a rate as the unit with `/s`: `kB/s` for bytes and `kbit/s` for bits, never `Kbps`. The lists are at the top of `formatter.js`, and `tests/formatter.test.js` holds the spellings.

## The preferences

The preferences window is written in code, in `prefs.js`, without a UI file (decided on 2026-10-10). `fillPreferencesWindow` reads in the order of the window, and one call holds everything about a setting. There is no list of settings and no loop that makes rows from one.

The rows are libadwaita's own, with one exception: a number is a `Gtk.SpinButton` in an `Adw.ActionRow`, because an `Adw.SpinRow` does not look like something to type into. Use the widgets' default margins. Elements are called by the names GNOME gives them: toggle group, combo row.

A setting is on the page of what it changes: General, Top Bar, Menu, or a category's page. A setting has a name and a description, in `prefs.js` and again in the schema.

- On a page, a name does not repeat the page ("Hide icons"). The schema has no pages, so its names say the whole thing ("Hide icons in top bar").
- Page and group titles are capitalised like headings, names of settings and list entries like sentences.
- The name says what the setting does. The description says what the user cannot see from the name and needs in order to decide: what the setting affects, what it leaves alone, or what happens otherwise. It does not repeat the name in other words.
- A description is one sentence, two at most. A detail that does not change the user's decision is left out.
- When behaviour changes, the texts of the settings it touches change with it.

## Running it

GJS caches the modules it has loaded, so a change of code needs a new gnome-shell process; disabling and enabling the extension is not enough.

- `make preview` runs a Shell in a window, with the extension, and keeps its settings under `build/preview`.
- `SCALE` sets the UI scale and `TEXT_SCALE` the text scale. `RESOLUTION` sets the headless display's pixel dimensions independently: `make test-shell SCALE=2 RESOLUTION=2560x1440`. Tests default to `1280x720`; screenshots use `3840x2160` with UI scale 2. The interactive preview's resolution follows its devkit window size.
- The preview and Shell tests replace their staged extension with the checkout's files on every launch. They keep their settings and data under `build/<target>` in a separate D-Bus session; `shell-session.sh` handles the setup. The preview keeps its settings between launches, while Shell tests reset theirs.
- To update the desktop's installed copy, follow [Update an installed copy](../README.md#update-an-installed-copy), then log out and back in to load the new code.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. `SHELL_DEBUG=backtrace-warnings` adds JavaScript stacks. Looking Glass: Alt+F2, `lg`.
- After a change of the schema in a local clone: `glib-compile-schemas --strict schemas/`.
- An animation that jumps is found frame by frame in a Shell without a screen: an automation script, run as `make test-shell` runs `tests/shell.test.js`, clicks through the menu and prints, in a handler of `global.stage`'s `after-paint` signal, the position and allocated height of each actor that moves. A jump is a value that changes in one frame or snaps back at the end.

## Tests

The [test-writing rules](writing-tests.md) define which requirements tests protect and what they may depend on.

`make test` runs the unit tests in GJS. `make test-shell` runs `tests/shell.test.js` inside a gnome-shell without a screen, after resetting the settings under `build/test-shell`, so it starts from the schema defaults.

- The unit-test files listed in the Makefile each run in a separate GJS interpreter. `tests/shell.test.js` also imports the cropped-icon checks, which need Shell's St and Clutter libraries.
- Nothing in Vitals is replaced, made up or read from a private member. A test uses `Sensors` as the extension does, the callbacks the extension sets included, and changes only the machine and the settings.
- A test of `Sensors` drives it through a `Machine` (`tests/machine.js`), the test double for the system that `Sensors` monitors. It stands in for the files under `/sys` and `/proc`, the space of the mounted filesystems, the mounts of `Gio.VolumeMonitor`, the public IP services, the monotonic clock and the GLib timers. A test sets and removes files, plugs device groups in and out, fails and holds reads, and skips time instead of waiting out an interval; skipping fires the timers that fall due.
- Fixtures are frozen constants in `tests/fixtures/`. `machine.js` there is a ThinkPad in device groups, each file's content exactly as the kernel presents it. No test changes a fixture.
- Everything mutable is created inside the test and ends with it. A `setup()` helper may build it; it holds no data.
- In the GJS tests, a `console.error` or `console.warn` fails the test, unless the test expects it and takes it with `takeFaults`.
- The `nvidia-smi` fixture in `tests/fixtures/programs` runs as a subprocess. The test puts its directory first in `PATH`, so it exercises process handling without an NVIDIA card.
- Every expected value is computed from the machine's current contents or from named inputs in the same test. The formatted strings in `tests/formatter.test.js` are the specification and stay literal.
- `tests/shell.test.js` runs in the Shell's own interpreter, where whatever it replaced it would replace for the Shell too. So it replaces nothing, and Vitals reads the machine the test runs on. It acts as a user does, through a virtual pointer and keyboard and the settings, and checks only what is on screen. Each step puts back the settings and the arrangement it changed. It needs a machine with two temperatures or more, and English as the language.

## Screenshots

`make screenshots` refreshes the [screenshot gallery](screenshots/README.md) in a Shell without a screen, using readings from the machine it runs on. The script, `docs/screenshots/screenshots.js`, starts from schema defaults, enables Battery and GPU, pins additional readings and applies the options named in each gallery caption. It switches the public IP address off because the pictures are published. When an accepted display option changes the appearance, update its example and caption together.

Screenshots are captured at twice the display resolution. Embed them with an explicit width no greater than half their pixel width so they retain detail on high-density displays. The README's category overview is displayed at 360 pixels wide.
