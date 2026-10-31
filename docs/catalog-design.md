# Sensor catalog

[Documentation index](../README.md#development) · [Development](development.md) · [Glossary](glossary.md)

How the collector and renderer share sensor state. Category behavior and UI decisions are covered in [Design decisions](design.md); key formats are covered in [Sensor keys](sensor-key-format.md).

## Two parts with separate jobs

- **The collector** (`sensors.js`) knows every sensor, reads their values, and stores the catalog on disk.
- **The renderer** (`extension.js`) displays the catalog. Beyond the catalog it only knows the user's display settings, such as the temperature unit or the icon style.

The collector saves the catalog to settings. The preferences window writes the catalog settings, which say whether each category is switched on. The renderer marks which sensors and category headers need readings (`runtime.shown`, `shownChanged`), notes on each pinned sensor the width it keeps free for its top-bar value (`reservedWidth`), and changes panel membership and order through `pinToPanel` and `movePanelSensor`. The collector uses those marks to determine what to read.

## The catalog

The catalog groups sensors by category. Each sensor holds its reading, label and user choices, including its top-bar position. The saved data contains no functions. During a session, categories and sensors also have a `runtime` object, which is omitted when saving.

A shortened example of saved data:

```js
{
    memory: {
        discovered: 1759820000,
        sensors: [{
            key: 'usage',
            category: 'memory',
            label: 'Usage',
            format: 'percent',
            discovered: 1759820000,
            value: 0.63,
            updated: 1759823000,
            status: 'ready',
            panelPosition: 0,
            reservedWidth: -1
        }]
    }
}
```

The collector keeps source readings, pending reads and the active-source map separately. Sensors refer to their sources through `runtime.source`.

### A category

- `position`: the category's place in the menu and preferences sidebar when Menu › Order is Manual. Unplaced categories follow in alphabetical order. With Alphabetical selected, all categories sort by their translated names, ignoring saved positions.
- `runtime.enabled`: whether the category is switched on, taken from the setting `catalog-settings` and not saved in the catalog. See [On disk](#on-disk).
- `discovered`: the timestamp of the last discovery run that completed this category. See [Discovery](#discovery).
- `runtime.shown`: whether the menu is open and the category enabled. Its category pin then needs readings; see [What is collected](#what-is-collected).
- `sensors`: its sensors, in discovery order. Menu ordering is derived separately; see [The renderer](#the-renderer).

The category pin is derived by `categoryPin(categoryName)`: the present sensor marked `pinnedToCategory`, otherwise the category's default. For voltage, the default prefers the battery, then the system, then a USB supply.

### A sensor

- `key`: tells it apart from the other sensors in its category. See [Keys](#keys).
- `category`: the name of the category it belongs to, such as `temperature`. Loading sets it from the containing category; discovery also writes it.
- `label`: the text shown in the menu, such as "ACPI Thermal Zone" or "Usage".
- `format`: how its value is formatted.
- `discovered`: the timestamp of the discovery run that last found it. See [Discovery](#discovery).
- `section`: which part of its category's menu a sensor belongs to. The rows of a section stay together, whatever their labels are. The network sensors name one, and so do the average, minimum and maximum, which also carry `aggregate`.
- `order`: an explicit row order within a section and heading, before sorting by label. Memory uses it to keep the breakdown in its arithmetic order.
- `heading`: the name of the sensor's row group. It can name a battery, graphics card, network interface or storage location, such as "BAT0", "GPU 2", "WiFi (wlp0s20f3)" or "/home", or a group such as "Memory details", "Swap" or "ZFS cache". When a category's rows fall into more than one group by heading, rows without one being a group too, the menu shows each heading above its rows. So the labels stay plain ("Percentage") and are translated as they are.
- `icon`: the name of its icon in the icon theme, when it is not its category's, such as `vitals-storage-read-symbolic`. Discovery writes it, and a few sensors take it from each reading: the WiFi values the bars of their signal, the public IP its country (`vitals-country-de-symbolic`). The renderer shows the category's icon when no theme has an icon of that name.
- `runtime.shown`: whether the sensor needs readings for a top-bar item or a row in an expanded category. The renderer sets this; see [What is collected](#what-is-collected).
- `value` and `updated`: its reading and when it was taken. A few readings are text, such as a battery's state.
- `status`: `ready` when `value` is current, `pending` while there is none yet (shown as "…"), and `unavailable` when it cannot be read (the row is not displayed).
- `file`: the file the sensor is read from: its own for a temperature, `/proc/meminfo` for every memory sensor. A sensor read from something else has none: an NVIDIA card's values (`nvidia`), the space of a storage location (`location`), the public IP, the screen redraws and, on some machines, the CPU frequencies. Nor does a value discovery writes, such as a graphics card's driver version, or an average, minimum or maximum.
- Fields that say which part of the file is the sensor's: the interface name for a network rate (with `hardware`, whether that interface is a hardware device), the core for a CPU core.
- `lowIsBad`: set by discovery on a sensor whose low values are the ones to watch, such as free memory, a battery's charge or the WiFi link quality (`LOW_IS_BAD` in `sensors.js`). A colour scale on such a sensor colours downwards from its breakpoints; on every other sensor, upwards.
- `customLabel`, `hidden` and `pinnedToCategory`: the user's label, hiding choice and category pin. Discovery preserves them. A hidden sensor is excluded from aggregates and normally has no menu row; "Show hidden sensors" reveals it. Hiding leaves its top-bar pin intact.

The saved data contains no computation functions. Each source is one piece in `sensors.js`: its file, how the file is taken apart, and its sensors with their labels, formats and `compute`, which computes a sensor's value from a reading. Discovery gives every sensor it registers its source and its `compute` in `runtime`, and a read uses only those.

## Keys

A key identifies a sensor within its category. Discovery matches by key on every run, updating the existing sensor's fields while retaining its user choices. The renderer holds sensor objects directly.

See [Sensor keys](sensor-key-format.md) for formats, examples, color-setting targets and the limits of identifying same-name devices.

## The panel

Panel membership is stored on the sensors themselves:

- `panelPosition`: a sensor's position in the top bar. An absent field means it is not pinned. `panelSensors()` gathers and sorts the pinned sensors.
- `reservedWidth`: the width kept for the value with "Steady widths" enabled; `-1` lets the text choose its width. The [top-bar design](design.md#the-top-bar) describes when widths are retained or reset.
- `runtime.reservedWidthLastFilled`: when the value last needed its full reserved width. This is not saved.

Pinning appends the sensor and resets its reserved width. Unpinning removes its position; repinning appends it again. Dragging changes the order through `movePanelSensor`.

An absent device keeps its pin but has no visible top-bar item until it returns. A sensor in a disabled category also keeps its pin but is not displayed.

## On disk

The catalog is saved in one setting, excluding every `runtime` field. It records sensors, their readings and user choices. Category on/off switches and display options are separate settings; the renderer combines them with the catalog to determine what is visible.

- The setting is called `catalog`. Its schema default contains entries for the three initial top-bar pins. Discovery fills in the rest of the catalog.
- Whether each category is switched on is in a setting of its own, `catalog-settings`, laid out like the catalog: `{temperature: {enabled: true}, …}`. It replaced the ten `show-*` settings, and it holds only the categories the user switched. The others are as `enabled` in `sensorCategories` says. Each of the two settings has one writer.
- User changes to pins, labels, hiding and ordering save the catalog, as does panel destruction. Discovery saves when the sensor count changes.
- There are no migrations. Settings saved by earlier versions are not converted.
- The preferences window is a separate program. Its category switches write `catalog-settings` (`_categoryPage` in `prefs.js`), and it reads the sensors' labels from the saved catalog for the colour pages. The extension takes a changed switch over when `catalog-settings` changes.
- Session-only fields live in `runtime`: collection marks, source references, computation functions and `initialTemperature` (what the hide-zeros option remembers). They are omitted from saved data. The last reading (`value`, `updated`, `status`) is written; on load every sensor is `pending`, so every value starts as "…".

The setting holds the catalog as a structure, not as text. GNOME's settings format stores nested records and lists directly (type `a{sv}`). `helpers/storedCatalog.js` turns the catalog's plain data into that format; reading it back is built in.

Other settings stay as they are: the display settings, and the options that belong to one category, such as hide-zeros, the storage locations and the public-IP options.

**Known bug:** discovery's sensor-count check misses changed fields and a run that adds and forgets equal numbers of sensors. The preferences' colour pages can therefore show stale catalog data until another save. This needs a persistence fix; it is not an intended synchronization rule.

## The renderer

- It draws categories as menu sections and pinned sensors as top-bar items.
- It changes only what changed. A sensor that appears or disappears adds or removes its own row. Pinning, unpinning or moving a sensor adds, removes or moves that one top-bar item. A new reading updates that sensor's text.
- A change of a display setting may redraw everything. That is rare, and avoiding it is only worth doing where it comes out naturally.
- It holds its rows and items by the sensors they show (`_rows`, `_panelItems`), not in tables looked up by key.
- Dragging a sensor in the top bar concerns only the renderer; the collector keeps reading.
- Rows sort by `section`, then `heading`, then explicit `order`, then their displayed labels. Missing section and order fields count as zero. Labels and headings use natural sorting, so "Core 2" comes before "Core 10". The menu does not use the catalog's discovery order.

## What is collected

The renderer sets `runtime.shown` for present pinned sensors in enabled categories. While the menu is open, it also marks enabled category headers and rows in expanded categories. These marks include rows outside the scroll viewport and unavailable sensors awaiting recovery. They describe which readings the UI needs, not whether an actor is currently visible. The collector derives `activeSources` from those marks, category pins and aggregate inputs. With the menu closed, collection is driven by the pinned sensors.

A tick refreshes the active-source map and reads each source that is due once. Sensors sharing a source share its reading. Each completed read updates the active sensors that depend on it and notifies the renderer, so a slow source does not hold the others back. Source state and the active-source map persist between ticks.

Read costs vary by source and hardware. The [historical measurements](changes-against-upstream.md#historical-speed-and-memory-measurements) include per-source costs from one ThinkPad.

A read that fails is an expected state, not an error: its sensors become `unavailable`, their rows are not displayed, and it is logged with `console.debug`.

An aggregate is computed from other sensors. Showing one activates the sources of present, non-hidden sensors in its category, including inputs not on screen. The aggregates are computed after the category’s reads finish. Unavailable inputs are excluded; pending inputs keep the aggregate pending. Battery power totals exclude peripheral batteries.

After changing these marks, the renderer calls `shownChanged`. Newly needed sources are read immediately through `_readNewlyShown`, with two exceptions: a ready reading with a previous sample is reused while younger than the update interval, and a source still within its own interval keeps its reading. Catalog changes, including a different category pin, also update collection. Sensors sharing an already active source use its existing samples.

A rate needs two readings. If a first reading leaves a sensor pending, the collector schedules a second read one second later (`SECOND_READING_SECONDS`). Regular ticks wait for that read. Leaving the active-source map cancels it; discovery delays it until the run ends. A source reactivated after its samples have become stale starts a new pair, rather than calculating a rate across the time it was inactive.

When the last successful reading is younger than half the update interval, the collector uses that reading's previous sample as the rate's starting point, if one exists. Otherwise it uses the last reading itself. This avoids very short intervals after Refresh while allowing the first pair of samples to produce a rate. Rates are never computed across a failed read.

A reading from `nvidia-smi` holds only the requested fields. When newly shown sensors require additional fields, the process restarts with those fields. Its previous reading is marked pending because it may lack those fields, and the collector requests a new reading immediately.

## Device identity

Device names are numbered where discovery supports multiple same-name devices. This distinguishes them within a run but does not guarantee the same physical-device identity after a restart. See [device identity limits](sensor-key-format.md#device-identity-limits).

## Discovery

Discovery runs at launch and again while the extension runs: when the menu opens, so that a device plugged in since is there when the user looks, on Refresh, and when a setting that affects it changes. Devices can be plugged in and removed at any time, so a later run has to add and retire sensors without disturbing the ones that are still there. There is only one run at a time.

At launch the collector reads as soon as the first run ends; until then every value is "…". After the run of Refresh, every value on screen is read at once, ignoring intervals such as the public IP's.

### The `discovered` field

`discovered` holds a timestamp: the time at which the run that last found the sensor started. It is the same for every sensor found in one run. It is real time, since it is stored on disk and compared after a restart.

- A sensor that has never been found has no timestamp.
- During a run, a sensor whose timestamp is that of the run has already been matched in it.
- Afterwards, an older timestamp says the sensor was not found in the latest run, and how long ago it was last seen.

### Whether a sensor is present

A sensor is present when it was found in the last run that completed its category:

```js
sensor.discovered !== undefined && sensor.discovered >= (category.discovered ?? 0)
```

Presence is derived by `sensorPresent` in `helpers/storedCatalog.js`, not stored separately. A sensor without a discovery timestamp is not present.

- Only present sensors in enabled categories can appear. Top-bar items also require a `panelPosition`; menu rows follow hiding and availability rules.
- The collector reads only sensors that are present.

The comparison is with the last run that completed the category, not with a run that is still in progress. While a run is under way, a sensor it has already found carries a newer timestamp and a sensor it has not reached yet carries the old one; both are still present. The category's timestamp moves only when the category is complete.

A sensor the user hid (`hidden`) is still present. It keeps its top-bar pin, and "Show hidden sensors" can reveal its menu row.

### A run

1. The run takes the current wall-clock time in seconds as its timestamp.
2. Discovery looks up each sensor by key within its category. If found, it updates that sensor's discovery fields and runtime source; otherwise it adds a sensor. User choices remain on the existing sensor.
3. When all discovery steps feeding a category succeed, its `discovered` timestamp advances to the run's timestamp. Sensors not found in that run then cease to be present.
4. If a discovery-related setting changed during the run, discovery repeats before completing.

The [key-format reference](sensor-key-format.md#device-identity-limits) explains how discovery order affects identically named devices.

### Sensors a run did not find

A sensor that a run did not find still has its `file` field. That path contains the kernel's number for the device, and the kernel hands a number to another device once it is free. If the sensor were still read, it would show another device's value under its own label.

It is not read, because it is no longer present: when the run completes the category, the category's timestamp becomes newer than the sensor's. While the run is in progress, an old sensor and a new one may point at the same file for a moment; completing the category ends that. Nothing has to be written into the sensors that were not found.

A category can be fed from more than one place: temperatures come from hwmon, from the thermal zones and from graphics cards. It is complete when all of them are done. When a discovery step fails, the categories it feeds are not completed in that run, and their sensors stay as they were.

Every reading of `/proc/net/dev` is compared with the interfaces the catalog has. When they differ, a small run of its own for the network category follows at once: it gives its timestamp to the interfaces it sees and to the network sensors that do not belong to one interface, such as the totals, and then completes the category.

A sensor that is not present stays in the catalog with its label and its place, in its category and in the panel. When a later run finds it again, it gets that run's timestamp and its current `file`, and it is present again.

### Forgetting

A sensor is dropped from the catalog when it has not been found for a year and is not in the panel. This is for names that are used once and never again, such as the `veth…` interface that every container start creates. Without it they would stay in the stored catalog for good.

A pinned sensor is never dropped, however long its device has been away.

### Reading during a run

Regular collection pauses during discovery. Discovery itself reads files and devices to identify sensors and their supported fields.

- When a run starts, reads that are under way are cancelled.
- A tick that falls into a run does nothing. It is not held back and carried out later; the next regular tick after the run reads again.
- What came on screen during a run, as when the menu opens, is read when the run ends.

This prevents regular collection from using a sensor path while discovery is reassigning it.

The readings taken before the run are kept. A rate, such as network speed, is then computed between the last reading before the run and the first one after it, over the time that really passed, so it does not start over with "…" after each discovery.

## Saved pins

Top-bar pins are saved as `panelPosition` on each sensor; a category pin is saved as `pinnedToCategory` on that sensor. Discovery matches the saved sensor by key, so both choices follow the same [device identity limits](sensor-key-format.md#device-identity-limits).
