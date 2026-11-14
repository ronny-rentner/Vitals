# Development

[Documentation index](README.md)

Vitals is a GNOME Shell extension (`Vitals@CoreCoding.com`) that reads hardware sensors asynchronously and shows them in the top bar. It runs as GJS ES modules and supports GNOME Shell 50 and 51. GNOME's own guides: [Creating an extension](https://gjs.guide/extensions/development/creating.html), [Anatomy](https://gjs.guide/extensions/overview/anatomy.html), [Imports](https://gjs.guide/extensions/overview/imports-and-modules.html), [Debugging](https://gjs.guide/extensions/development/debugging.html), [Best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

The [glossary](glossary.md) defines the terms used here. [Sensor catalog](catalog-design.md) explains how the catalog works, and [Design decisions](design.md) covers the extension's behavior and layout.

## Getting started

Run development commands from the checkout.

```sh
npm --prefix tools install
make lint
make test
```

Use the [preview](#running-it) for UI changes. Read [Writing tests](writing-tests.md) before adding or changing tests, and the [icon rules](design.md#icons) before changing artwork or sizing.

## Files

The installation directory is named after the `uuid` in `metadata.json`. For a user install, it is `~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/`.

GNOME Shell requires `metadata.json` and `extension.js`. Vitals also has `prefs.js`, `stylesheet.css`, `schemas/`, `locale/`, `helpers/` and `icons/`.

| File | Process | Toolkit |
|---|---|---|
| `extension.js` and the modules it imports | `gnome-shell` | Clutter / St |
| `prefs.js` | Separate GTK process | GTK 4 / Adwaita |

Helpers shared by both entry points must not import `St`, `Clutter`, `Gtk`, `Adw` or `Gdk`. `stylesheet.css` applies only to the Shell.

## Metadata versioning

Leave [`version`](https://gjs.guide/extensions/overview/anatomy.html#version) unset; extensions.gnome.org assigns it. Use [`version-name`](https://gjs.guide/extensions/overview/anatomy.html#version-name) for the version displayed to users.

## Builds and releases

[Makefile](../Makefile) · [ESLint configuration](../tools/eslint.config.mjs) · [Tests workflow](../.github/workflows/tests.yml) · [Release workflow](../.github/workflows/release.yml)

## Translations

`locale/vitals.pot` lists the messages. Each language has a catalog at `locale/<language>/LC_MESSAGES/vitals.po` and a compiled `.mo` file alongside it. `make translations` rebuilds all compiled catalogs, and `make zip` includes that step. Commit the compiled files together with their catalog changes.

Category names, sensor labels and section headings are translated when displayed. They are stored as plain string literals, so extracting only literal `_()` calls misses them. Include them in the translation template and catalogs too. Validate changed catalogs with `msgfmt --check --statistics -o /dev/null <file.po>` and review fuzzy matches before accepting them.

## GNOME versions

Target current GNOME versions and use GNOME's APIs directly, without maintaining compatibility branches for older releases. We support GNOME 50 and 51, as declared in `metadata.json`. The preferences use `Adw.ViewSwitcherSidebar`, available since libadwaita 1.9. Propose changes to the supported versions explicitly and update `metadata.json` and the installation docs together.

## Modules

- `extension.js` default-exports a subclass of `Extension` with `enable()` and `disable()`; `prefs.js` default-exports a subclass of `ExtensionPreferences`.
- Libraries are imported as `import St from 'gi://St'` or `import Gtk from 'gi://Gtk'`.
- Shell modules are imported from `resource:///org/gnome/shell/...` in the Shell, and from `resource:///org/gnome/Shell/Extensions/js/...` in the preferences.
- Vitals imports its own modules by relative path (`./sensors.js`) and does not use `imports.`.

## Lifecycle

Create the UI and start monitoring in `enable()`. Cleanup belongs in the panel button's `destroy` handler so it also runs at Shell shutdown.

Save the catalog before stopping monitoring. Disconnect signals, remove timers and cancel pending reads. Discard completions from cancelled reads. Do not wrap `destroy()` or `GLib.Source.remove()` in try/catch to conceal lifecycle errors.

## Code conventions

- Never block the Shell's main loop: a crash or a stall in the Shell process takes the desktop with it. Read files with `Gio.File.load_contents_async` and run programs through `Gio.Subprocess`.
- Translated texts use `_()` from the Extension or preferences import, domain `vitals`.
- GObject subclasses use `GObject.registerClass` with a unique `GTypeName`.
- Before changing icon artwork or sizing, follow the [icon design rules](design.md#icons), including verification at actual panel size.
- Use `St.Icon` and `Gtk.Image` for icons, never emoji. Look them up by name so the user's icon theme can replace them. Vitals' bundled icons are named `vitals-…-symbolic`; each icon style has its own folder, searched last.
- Regenerate the country icons in `icons/countries/` with `make country-icons`. This optional command needs GJS with Cairo support, the GObject introspection libraries for GTK 4's Gsk, Pango, PangoCairo and librsvg, and the `iso-codes` data. It uses the bundled DejaVu Sans Mono Bold font. Ordinary builds use the existing SVG files.
- Cropping, its cache and lifecycle are confined to `croppedIcon.js`. Menu icons always use stock `St.Icon`.
- Keep lines under about 200 characters, the width shown on the extensions.gnome.org review page.
- Add a sensor to its source definition in `sensors.js`. For a new source, add a definition and the code to discover its sensors there.
- Log failed reads with `console.debug`. Reserve `console.warn` and `console.error` for faults. Keep messages sparse because the whole system shares the journal.

## Units

Use the standard SI spellings, and IEC 80000-13 for bits and bytes. Use `kB` and `MB` for powers of 1000, `KiB` and `MiB` for powers of 1024, and `kHz` for kilohertz. Write data-transfer rates with `/s`: `kB/s` for bytes and `kbit/s` for bits, never `Kbps`.

## The preferences

Define each setting in one call in `prefs.js`, in display order.

Use libadwaita's standard rows. For number inputs, use a `Gtk.SpinButton` inside an `Adw.ActionRow`. Keep the widgets' default margins and use GNOME's names for them, such as toggle group and combo row.

A setting belongs on the page for what it changes: "General", "Top Bar", "Menu" or a category page. Give it a name in both `prefs.js` and the schema.

- In preferences, leave the page name out of the setting's name: "Hide icons". In the schema, include it because there are no pages: "Hide icons in top bar".
- Capitalise page and group titles as headings, and setting names and list entries as sentences.
- The name should say what the setting does. Use the description for details that help the user decide, such as what it affects, what it leaves alone or what happens otherwise. Do not repeat the name in other words.
- Keep descriptions to one sentence, or two at most. Leave out details that do not affect the user's decision.
- When behavior changes, update the affected settings' names and descriptions too.

## Running it

GJS caches the modules it has loaded, so a change of code needs a new gnome-shell process; disabling and enabling the extension is not enough.

- `make preview` runs a Shell in a window, with the extension, and keeps its settings under `build/preview`.
- `SCALE` sets the UI scale and `TEXT_SCALE` the text scale. `RESOLUTION` sets the headless display's pixel dimensions: `make test-shell SCALE=2 RESOLUTION=2560x1440`. The interactive preview's resolution follows its devkit window size.
- The preview and Shell tests replace their staged extension with the checkout's files on every launch. They keep their settings and data under `build/<target>` in a separate D-Bus session; `shell-session.sh` handles the setup. The preview keeps its settings between launches, while Shell tests reset theirs.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. `SHELL_DEBUG=backtrace-warnings` adds JavaScript stacks. Looking Glass: Alt+F2, `lg`.
- After a change of the schema in a local clone: `glib-compile-schemas --strict schemas/`.
- To investigate an animation that jumps, use an automation script in the same headless Shell as `tests/shell.test.js`. Click through the menu and record each moving actor's position and allocated height on `global.stage`'s `after-paint` signal. Look for a sudden change between frames or a snap back at the end of the animation.

## Tests

The [test-writing rules](writing-tests.md) define which requirements tests protect and what they may depend on.

`make test` runs the unit tests in GJS. `make test-shell` runs `tests/shell.test.js` in English inside a headless GNOME Shell. It resets the settings under `build/test-shell` first, so each run starts from the schema defaults. The command's locale setting does not change the desktop's language.

- `Sensors` tests use a `Machine` (`tests/machine.js`) as a test double for the monitored system. It supplies the files under `/sys` and `/proc`, mounted filesystem space, `Gio.VolumeMonitor` mounts, public IP services, the monotonic clock and GLib timers. Tests can change files, connect or disconnect device groups, fail or hold reads, and advance time. Advancing time fires the timers that become due, so tests do not have to wait for real polling intervals.
- Fixtures are frozen constants in `tests/fixtures/`. The `machine.js` fixture describes a ThinkPad, grouped by device. Tests must not modify fixtures.
- In GJS tests, `console.error` and `console.warn` fail the test unless it expects the message and collects it with `takeFaults`.
- The `nvidia-smi` fixture in `tests/fixtures/programs` runs as a subprocess. The test puts its directory first in `PATH`, so it exercises process handling without an NVIDIA card.
- `tests/shell.test.js` runs inside GNOME Shell with real sensor hardware. It exercises the menu and top bar through a virtual pointer, keyboard and settings. The missing-icon check temporarily moves the isolated Shell's installed icon directory, then restores it. Each step restores the settings and layout it changed. These tests need at least two temperature sensors and an English-language session.

## Screenshots

Run `make screenshots` to refresh the [gallery](screenshots/README.md). The examples are defined in [screenshots.js](screenshots/screenshots.js).

Keep public IP addresses out of published images. Crop top-bar examples to the button and include the whole preferences window. Inspect the images at their displayed size after regenerating them.
