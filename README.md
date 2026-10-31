# Vitals

Vitals is a GNOME Shell extension for displaying your computer's temperature, voltage, fan speed, memory usage, processor load, system resources, network speed and storage stats in your GNOME Shell's top menu bar. This is a one stop shop to monitor all of your vital sensors. Vitals uses asynchronous polling to provide a smooth user experience.

## This fork

This fork substantially reworks [Vitals](https://github.com/corecoding/Vitals), extending its features and rewriting much of the underlying code. Sensor polling follows what the top bar and menu need to display, reducing unnecessary background work.

You can drag pinned sensors into the order you want in the top bar. You can also reorder menu categories, rename or hide sensors, and monitor several disks and network shares together.

The menu keeps related sensors together in sections. Threshold colors can apply to one sensor or a group, such as all temperatures in a category. The [full comparison](docs/changes-against-upstream.md) covers the differences from upstream and the fork's limitations.

### Important notes

The preferences sidebar and cropped top-bar icons use newer GNOME APIs, so this fork requires GNOME Shell 50 or 51.

Sensors are now identified independently of their displayed names, keeping pins and color settings attached when labels change. Existing sensor settings use the old identifiers, so you'll need to set up your pinned sensors again and review your preferences when switching.

<img src="docs/screenshots/menu.png" alt="Vitals pinned sensors in the top bar and categories in the menu" width="360">

[Install](#installation) · [Use Vitals](#using-vitals) · [Screenshots](docs/screenshots/README.md) · [Report a problem](#reporting-problems) · [Development](#development) · [Credits and licenses](#credits-and-licenses)

## Installation

### Build and install this fork

You need Git, Make, `glib-compile-schemas` (GLib), `msgfmt` (gettext), `zip` and GNOME Shell's `gnome-extensions` command.

These steps install the fork in place of upstream Vitals.

```sh
git clone --branch catalog-rewrite https://github.com/ronny-rentner/Vitals.git
cd Vitals
make zip
gnome-extensions install --force vitals.zip
```

Log out and back in, then enable the extension:

```sh
gnome-extensions enable Vitals@CoreCoding.com
```

The Vitals listing on [GNOME Extensions](https://extensions.gnome.org/extension/1460/vitals/) distributes upstream. To install the fork described here, use the commands above. For packaging details, see [builds and releases](docs/development.md#builds-and-releases).

### Update an installed copy

From your existing checkout of `catalog-rewrite`:

```sh
git pull --ff-only
make zip
gnome-extensions install --force vitals.zip
```

Log out and back in to load the updated code.

## Using Vitals

Click a pinned sensor in the top bar, or the Vitals icon if none are shown, to open the menu. Then open a category to see its sensors. Click a sensor row to open its actions:

| Action | Result |
|---|---|
| Pin to top bar | Show the sensor's value in the top bar; select again to unpin. |
| Pin to category | Show the sensor's value in its category header; select again to restore the default. |
| Rename | Give the sensor your own label; clear it to restore its original label. |
| Hide | Remove the sensor from the menu and its category's aggregates. A pinned sensor stays in the top bar. |

Drag pinned sensors in the top bar to reorder them. Repinning a sensor adds it at the end. Use **Show hidden sensors** at the bottom of the menu to reveal hidden rows and undo **Hide**. **Refresh** looks for sensors again and updates the visible readings.

Open **Preferences** from the bottom of the menu. On the General page, you can change the update interval and icon style. The Top Bar and Menu pages control how those parts look. Each category page has a switch at the top to turn monitoring on or off, followed by its units, collection options and threshold colors.

To rearrange categories, open the Menu page, set **Order** to **Manual** and enable **Reorder by drag and drop**. You can then drag category headers to their new positions in the menu. The preferences pages follow the same order. Choose **Alphabetical** to sort by the translated category names instead.

To set threshold colors, open a category page, choose a sensor or group under **Add color scale**, and click **Add**. Set a threshold and its color, then use **Add breakpoint** for each additional level. A **From** breakpoint applies at and above its threshold; an **Up to** breakpoint applies at and below it. Each color continues until the next breakpoint. If a sensor has its own color scale, that scale overrides the group's.

To monitor another disk or share, open Storage › **Storage Locations**, click **+**, and select a mounted location. Enable **Monitor drives mounted by GNOME** to include those drives automatically. Vitals keeps your configured locations when you disconnect them and resumes readings when something is mounted at the same path.

The [screenshot gallery](docs/screenshots/README.md) shows top-bar options and menus in light and dark styles, plus the preferences window.

### Understanding the readings

An ellipsis ("…") means Vitals is still collecting a value. Rates need two readings. If there are no recent samples, Vitals schedules another reading one second after the first. Sensors that cannot be read disappear until readings resume.

Memory's main section adds up: **Free + Reclaimable = Available**, and **Used + Available = Total**. Memory › **Show details** adds cache and buffer counters in a separate section; swap has its own section.

Temperature › **Skip sensors that read zero** leaves out sensors that report zero during discovery. Vitals tries them again on rediscovery. A sensor that was accepted earlier stays available if it later reads zero. Turn the option off to include readable zero temperatures during discovery too.

Vitals collects readings for pinned sensors, category headers in the open menu and rows in expanded categories. When you close the menu, only pinned sensors need updates. If you pin an aggregate, Vitals also collects the readings used to calculate it. The [design decisions](docs/design.md) explain how each category behaves and why.

## Reporting problems

Report problems with this fork in its [GitHub issues](https://github.com/ronny-rentner/Vitals/issues). Include your distribution, GNOME Shell version, steps to reproduce and relevant Shell logs. The [development guide](docs/development.md#running-it) explains how to read the logs and run an isolated preview.

## Development

Start with the [development guide](docs/development.md) for setup, preview, tests, translations and releases.

| Document | Purpose |
|---|---|
| [Design decisions](docs/design.md) | Behavior, layout and icon rules. |
| [Sensor catalog](docs/catalog-design.md) | Collector, renderer, saved state and discovery. |
| [Sensor keys](docs/sensor-key-format.md) | Key formats and device identity limits. |
| [Glossary](docs/glossary.md) | Shared terminology. |
| [Writing tests](docs/writing-tests.md) | Requirements and boundaries for tests. |
| [Comparison with upstream](docs/changes-against-upstream.md) | User-visible and implementation differences; historical measurements. |
| [Agent instructions](AGENTS.md) | Entry point for coding agents. |

Common commands, run from the checkout:

| Task | Command |
|---|---|
| Run unit tests | `make test` |
| Run Shell integration tests in English | `LC_ALL=C make test-shell` |
| Open an interactive preview | `make preview` |
| Compile translations | `make translations` |
| Refresh the English screenshots | `LC_ALL=C make screenshots` |
| Package the extension | `make zip` |

The [preview and test instructions](docs/development.md#running-it) explain dependencies, UI scale, resolution and isolated settings.

### Historical plans

[Icons by name](docs/plans/icons-by-name.md) records an earlier implementation plan. Current icon rules are in [Design decisions](docs/design.md#icons).

## Credits and licenses

This fork builds on [Vitals by Core Coding and contributors](https://github.com/corecoding/Vitals), which originated from [Freon](https://github.com/UshakovVasilii/gnome-shell-extension-freon).

See the project's [LICENSE](LICENSE) and the bundled font's [DejaVu license](icons/countries/DejaVu-LICENSE). Country-code icons use DejaVu Sans Mono Bold. Icon names below omit the `vitals-` prefix and `-symbolic.svg` suffix.

### Classic icons

* `voltage` and `fan` - inherited from Freon.
* `system` and `storage` - from the Pop! OS theme.
* `temperature` - [iconnice studio](https://www.iconfinder.com/iconnice).
* `cpu` and `memory` - [DinosoftLabs](https://www.iconfinder.com/dinosoftlabs).
* `network*` - [Yannick Lung](https://www.iconfinder.com/yanlu).
* Historical Health icon - [Dod Cosmin](https://www.iconfinder.com/icons/458267/cross_doctor_drug_health_healthcare_hospital_icon).
* `wifi-signal-*` - from [Adwaita Icon Theme](https://gitlab.gnome.org/GNOME/adwaita-icon-theme).
* `power` - drawn for Vitals.

### Adwaita icons

* `battery`, `storage` and `wifi-signal-*` - from [Adwaita Icon Theme](https://gitlab.gnome.org/GNOME/adwaita-icon-theme).
* `memory`, `network*`, `swap`, `system` and `voltage` - from [Icon Development Kit](https://gitlab.gnome.org/Teams/Design/icon-development-kit).
* `power` - drawn for Vitals.
* `fan` - inherited from [Freon](https://github.com/UshakovVasilii/gnome-shell-extension-freon), with mild modifications.
* `temperature` and `cpu` - designed by [daudix](https://github.com/daudix).

### Disclaimer

Sensor data is obtained from sysfs, procfs, Gio filesystem queries and supported GPU tools. Core Coding and the Vitals authors are not responsible for improperly represented data. No warranty expressed or implied.

### Support upstream

[Donate to Core Coding](https://corecoding.com/donate.php) to support upstream Vitals.
