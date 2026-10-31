# Development

[Documentation index](../README.md#development)

Vitals is a GNOME Shell extension (`Vitals@CoreCoding.com`) that reads hardware sensors asynchronously and shows them in the top bar. It runs as GJS ES modules and supports GNOME Shell 50 and 51. GNOME's own guides: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

The [glossary](glossary.md) defines the terms used here. [Sensor catalog](catalog-design.md) explains how the catalog works, and [Design decisions](design.md) covers the extension's behavior and layout.

## Getting started

Use the [installation instructions](../README.md#installation) to clone this fork and build its package. Run development commands from that checkout.

- `make test` needs GJS and `glib-compile-schemas`.
- `make preview`, `make test-shell` and `make screenshots` also need GNOME Shell, `dbus-run-session`, PipeWire, WirePlumber and the GNOME settings tools. The interactive preview needs `mutter-devkit`. Run `LC_ALL=C make test-shell` for the tests' English labels.
- Packaging needs `msgfmt` and `zip` as well; see [builds and releases](#builds-and-releases).

Start with `make test`, then use the [preview](#running-it) for UI changes. Read [Writing tests](writing-tests.md) before adding or changing tests, and the [icon rules](design.md#icons) before changing artwork or sizing.

## Files

The installation directory is named after the `uuid` in `metadata.json`. For a user install, it is `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

GNOME Shell requires `metadata.json` and `extension.js`. Vitals also has `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, `helpers/` and `icons/`.

`metadata.json` declares the extension's identity, supported Shell versions, settings schema, translation domain and project links. Versioning is covered below.

| File | Process | Toolkit |
|---|---|---|
| `extension.js` and the modules it imports | `gnome-shell` | Clutter / St |
| `prefs.js` | Separate GTK process | GTK 4 / Adwaita |

Helpers shared by both entry points must not import `St`, `Clutter`, `Gtk`, `Adw` or `Gdk`. `stylesheet.css` applies only to the Shell. Both entry points call `this.getSettings()` without an argument because `metadata.json` supplies the schema ID.

## Metadata versioning

We checked GNOME's documentation and website source on 2026-10-30:

- [`version`](https://gjs.guide/extensions/overview/anatomy.html#version) is an optional integer submission counter controlled by extensions.gnome.org. The documentation says: "This field SHOULD NOT be set by extension developers." The website overrides it; setting it can affect automatic upgrades or downgrades. This is a recommendation against setting it, not a claim that the field is invalid.
- The [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html#metadata-json-must-be-well-formed) mark `version` as deprecated and reserved for the website's internal use.
- The [website implementation](https://github.com/GNOME/extensions-web/blob/master/sweettooth/extensions/models.py) confirms this: `ExtensionVersion.save()` assigns the next submission number, `make_metadata_json()` overwrites `version`, and `_replace_metadata_json()` writes that metadata into the uploaded ZIP.
- [`version-name`](https://gjs.guide/extensions/overview/anatomy.html#version-name) is the optional developer-controlled string for the version shown to users.

We omit `version` in source metadata to follow this guidance. GitHub releases take their names from pushed tags beginning with `v` followed by a digit, independently of the website's submission counter.

## Builds and releases

`make zip` compiles the settings schema and translations, then packages the extension as `vitals.zip`. It requires `glib-compile-schemas`, `msgfmt` and `zip`.

GitHub Actions runs `make test` on branch pushes, pull requests and release tags. A release-tag push also runs the release job after the tests pass: it builds the ZIP with `make zip`, checks it with `shexli` and publishes it in a GitHub release. Branch pushes and pull requests do not build or publish a ZIP. Run the Shell UI tests locally; they need GNOME Shell and real sensor hardware.

## Translations

`locale/vitals.pot` lists the messages. Each language has a catalog at `locale/<language>/LC_MESSAGES/vitals.po` and a compiled `.mo` file alongside it. `make translations` rebuilds all compiled catalogs, and `make zip` includes that step. Commit the compiled files together with their catalog changes.

Category names, sensor labels and section headings are translated when displayed. They are stored as plain string literals, so extracting only literal `_()` calls misses them. Include them in the translation template and catalogs too. Validate changed catalogs with `msgfmt --check --statistics -o /dev/null <file.po>` and review fuzzy matches before accepting them.

## GNOME versions and size

We decided on 2026-10-10 to target current GNOME versions and use GNOME's APIs directly, without maintaining compatibility branches for older releases. We support GNOME 50 and 51, as declared in `metadata.json`. The preferences use `Adw.ViewSwitcherSidebar`, available since libadwaita 1.9. Propose changes to the supported versions explicitly and update `metadata.json` and the installation docs together.

When two approaches do the same job, choose the one with less code.

## Modules

- `extension.js` default-exports a subclass of `Extension` with `enable()` and `disable()`; `prefs.js` default-exports a subclass of `ExtensionPreferences`.
- Libraries are imported as `import St from 'gi://St'` or `import Gtk from 'gi://Gtk'`.
- Shell modules are imported from `resource:///org/gnome/shell/...` in the Shell, and from `resource:///org/gnome/Shell/Extensions/js/...` in the preferences.
- Vitals imports its own modules by relative path (`./sensors.js`) and does not use `imports.`.

## Lifecycle

The exported `Extension` class has no custom constructor. Loading the module does not build the UI or start monitoring; `enable()` creates the panel button and collector.

- `enable()` builds the UI, connects signals, adds sources and calls `Main.panel.addToStatusArea(...)`.
- `disable()` destroys the panel button and clears the extension's reference to it. Destruction must disconnect signals, remove timers and cancel pending work, including timers that would later remove themselves.

The panel button's `destroy` signal saves the catalog first, then stops the refresh timer and destroys the collector. This also runs when Shell shutdown destroys the button without calling the extension's `disable()` method. The collector cancels pending reads and discards their completions, preventing updates to destroyed UI objects.

Keep `enable()` and `disable()` small, and make cleanup explicit wherever a signal, timer or asynchronous operation is added. Do not wrap `destroy()` or `GLib.Source.remove()` in try/catch to conceal lifecycle errors.

## Code conventions

- Never block the Shell's main loop: a crash or a stall in the Shell process takes the desktop with it. Read files with `Gio.File.load_contents_async` and run programs through `Gio.Subprocess`.
- Translated texts use `_()` from the Extension or preferences import, domain `vitals`.
- GObject subclasses use `GObject.registerClass` with a unique `GTypeName`.
- Vitals ships its own sensor icons in `icons/`, with names that a user's icon theme can override.
- Before changing icon artwork or sizing, follow the [icon design and approval rules](design.md#icons), including verification at actual panel size.
- Use `St.Icon` and `Gtk.Image` for icons, never emoji. Look them up by name so the user's icon theme can replace them. Vitals' bundled icons are named `vitals-…-symbolic`; each icon style has its own folder, searched last.
- Regenerate the country icons in `icons/countries/` with `make country-icons`. This optional command needs GJS with Cairo support, the GObject introspection libraries for GTK 4's Gsk, Pango, PangoCairo and librsvg, and the `iso-codes` data. It uses the bundled DejaVu Sans Mono Bold font. Ordinary builds use the existing SVG files.
- The `crop-icons` setting selects `CroppedIcon` or stock `St.Icon` through `PanelIconType` in `extension.js`. Cropping, its cache and lifecycle are confined to `croppedIcon.js`. Menu icons always use stock `St.Icon`.
- Keep lines under about 200 characters, the width shown on the extensions.gnome.org review page.
- Add a sensor to its source definition in `sensors.js`. For a new source, add a definition and the code to discover its sensors there.
- Log failed reads with `console.debug`. Reserve `console.warn` and `console.error` for faults. Keep messages sparse because the whole system shares the journal.

## Units

Use the standard SI spellings, and IEC 80000-13 for bits and bytes (decided on 2026-10-08). Use `kB` and `MB` for powers of 1000, `KiB` and `MiB` for powers of 1024, and `kHz` for kilohertz. Write data-transfer rates with `/s`: `kB/s` for bytes and `kbit/s` for bits, never `Kbps`. The unit lists are at the top of `formatter.js`; `tests/formatter.test.js` checks their spellings.

## The preferences

We build the preferences window in `prefs.js`, without a UI file (decided on 2026-10-10). Calls in `fillPreferencesWindow` follow the order of the controls in the window. Each call defines one setting completely, rather than generating rows in a loop from a separate settings list.

Use libadwaita's standard rows, with one exception: number inputs use a `Gtk.SpinButton` inside an `Adw.ActionRow`. The `Adw.SpinRow` design does not make it clear that users can type a number. Keep the widgets' default margins and use GNOME's names for them, such as toggle group and combo row.

A setting belongs on the page for what it changes: General, Top Bar, Menu or a category page. Give it a name and description in both `prefs.js` and the schema.

- In preferences, leave the page name out of the setting's name: "Hide icons". In the schema, include it because there are no pages: "Hide icons in top bar".
- Capitalise page and group titles as headings, and setting names and list entries as sentences.
- The name should say what the setting does. Use the description for details that help the user decide, such as what it affects, what it leaves alone or what happens otherwise. Do not repeat the name in other words.
- Keep descriptions to one sentence, or two at most. Leave out details that do not affect the user's decision.
- When behavior changes, update the affected settings' names and descriptions too.

## Running it

GJS caches the modules it has loaded, so a change of code needs a new gnome-shell process; disabling and enabling the extension is not enough.

- `make preview` runs a Shell in a window, with the extension, and keeps its settings under `build/preview`.
- `SCALE` sets the UI scale and `TEXT_SCALE` the text scale. `RESOLUTION` sets the headless display's pixel dimensions independently: `LC_ALL=C make test-shell SCALE=2 RESOLUTION=2560x1440`. Tests default to `1280x720`; screenshots use `3840x2160` with UI scale 2. The interactive preview's resolution follows its devkit window size.
- The preview and Shell tests replace their staged extension with the checkout's files on every launch. They keep their settings and data under `build/<target>` in a separate D-Bus session; `shell-session.sh` handles the setup. The preview keeps its settings between launches, while Shell tests reset theirs.
- To update the desktop's installed copy, follow [Update an installed copy](../README.md#update-an-installed-copy), then log out and back in to load the new code.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. `SHELL_DEBUG=backtrace-warnings` adds JavaScript stacks. Looking Glass: Alt+F2, `lg`.
- After a change of the schema in a local clone: `glib-compile-schemas --strict schemas/`.
- To investigate an animation that jumps, use an automation script in the same headless Shell as `tests/shell.test.js`. Click through the menu and record each moving actor's position and allocated height on `global.stage`'s `after-paint` signal. Look for a sudden change between frames or a snap back at the end of the animation.

## Tests

The [test-writing rules](writing-tests.md) define which requirements tests protect and what they may depend on.

`make test` runs the unit tests in GJS. `LC_ALL=C make test-shell` runs `tests/shell.test.js` in English inside a headless GNOME Shell. It resets the settings under `build/test-shell` first, so each run starts from the schema defaults. The command's locale setting does not change the desktop's language.

- The unit-test files listed in the Makefile each run in a separate GJS interpreter. `tests/shell.test.js` also imports the cropped-icon checks, which construct icons in the Shell and check their dimensions and rendered pixels using St and Clutter.
- Collector tests use `Sensors` as the extension does, including its callbacks. They change the machine and settings without replacing Vitals internals or reading private members.
- `Sensors` tests use a `Machine` (`tests/machine.js`) as a test double for the monitored system. It supplies the files under `/sys` and `/proc`, mounted filesystem space, `Gio.VolumeMonitor` mounts, public IP services, the monotonic clock and GLib timers. Tests can change files, connect or disconnect device groups, fail or hold reads, and advance time. Advancing time fires the timers that become due, so tests do not have to wait for real polling intervals.
- Fixtures are frozen constants in `tests/fixtures/`. The `machine.js` fixture describes a ThinkPad, grouped by device, with file contents exactly as the kernel provides them. Tests must not modify fixtures.
- Create all mutable state inside the test and discard it when the test ends. A `setup()` helper may construct that state but must not retain any data itself.
- In GJS tests, `console.error` and `console.warn` fail the test unless it expects the message and collects it with `takeFaults`.
- The `nvidia-smi` fixture in `tests/fixtures/programs` runs as a subprocess. The test puts its directory first in `PATH`, so it exercises process handling without an NVIDIA card.
- Every expected value is computed from the machine's current contents or from named inputs in the same test. The formatted strings in `tests/formatter.test.js` are the specification and stay literal.
- `tests/shell.test.js` runs inside GNOME Shell with real sensor hardware. It exercises the menu and top bar through a virtual pointer, keyboard and settings. The missing-icon check temporarily moves the isolated Shell's installed icon directory, then restores it. Each step restores the settings and layout it changed. These tests need at least two temperature sensors and an English-language session.

## Screenshots

`LC_ALL=C make screenshots` refreshes the English [screenshot gallery](screenshots/README.md) in a headless Shell, using readings from the machine running it. The script, `docs/screenshots/screenshots.js`, starts from schema defaults, enables Battery and GPU, pins additional sensors and applies the options named in each caption. It disables public IP lookup because the pictures are published. When an accepted display option changes the appearance, update its example and caption together.

Screenshots are captured at UI scale 2. Top-bar and menu examples share one capture width, set in `screenshots.js`; their heights follow the contents. The preferences screenshot includes its whole window. In the gallery, put captions above their images and use `width="50%"` to display them at half the available page width. Check the rendered gallery for readable labels, values and icons after changing captures or layout. The README's compact category overview uses a separate width of 360 pixels.
