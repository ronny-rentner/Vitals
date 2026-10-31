# Sensor catalog

[Documentation index](../README.md#development) · [Development](development.md) · [Glossary](glossary.md)

The collector and renderer share sensor state through the catalog. [Design decisions](design.md) covers category behavior and UI choices; [Sensor keys](sensor-key-format.md) explains the key formats.

## Two parts with separate jobs

- The collector (`sensors.js`) keeps track of every sensor, reads its value and stores the catalog on disk.
- The renderer (`extension.js`) displays the catalog using the user's display settings, such as the temperature unit and icon style. It needs no other information about the sensors.

The collector saves the catalog to settings. The preferences window writes the catalog settings, which control whether each category is enabled. The renderer marks which sensors and category headers need readings (`runtime.shown`, `shownChanged`), and the collector uses those marks to decide what to read. The renderer also records each pinned sensor's reserved value width (`reservedWidth`) and changes panel membership and order through `pinToPanel` and `movePanelSensor`.

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
- `runtime.enabled`: whether the category is switched on. It comes from `catalog-settings` and is not saved in the catalog. See [On disk](#on-disk).
- `discovered`: the timestamp of the last discovery run that completed this category. See [Discovery](#discovery).
- `runtime.shown`: whether the menu is open and the category enabled. Its category pin then needs readings; see [What is collected](#what-is-collected).
- `sensors`: its sensors, in discovery order. Menu ordering is derived separately; see [The renderer](#the-renderer).

`categoryPin(categoryName)` chooses the present sensor marked `pinnedToCategory`, or the category's default if none is marked and present. For voltage, the default prefers the battery, then the system, then a USB supply.

### A sensor

- `key`: identifies the sensor within its category. See [Keys](#keys).
- `category`: the name of the category it belongs to, such as `temperature`. Loading sets it from the containing category; discovery also writes it.
- `label`: the text shown in the menu, such as "ACPI Thermal Zone" or "Usage".
- `format`: how its value is formatted.
- `discovered`: the timestamp of the discovery run that last found it. See [Discovery](#discovery).
- `section`: the part of the category's menu that contains this sensor. Rows in a section stay together regardless of their labels. Network sensors specify a section, as do the average, minimum and maximum. Those computed sensors also have an `aggregate` field.
- `order`: an explicit row order within a section and heading, before sorting by label. Memory uses it to keep the breakdown in its arithmetic order.
- `heading`: the sensor's row-group name. It can identify a battery ("BAT0"), graphics card ("GPU 2"), network interface ("WiFi (wlp0s20f3)") or storage location ("/home"), or name a group such as "Memory details", "Swap" or "ZFS cache". The menu displays headings when a category has several groups; rows without a heading count as a separate group. Row labels can then stay plain ("Percentage") and be translated directly.
- `icon`: the sensor's icon name when it differs from its category's, such as `vitals-storage-read-symbolic`. Discovery sets it. Some sensors update it with each reading: WiFi sensors use signal bars, and the public IP uses its country code (`vitals-country-de-symbolic`). If no theme provides the named icon, the renderer uses the category's icon.
- `runtime.shown`: whether the sensor needs readings for a top-bar item or a row in an expanded category. The renderer sets this; see [What is collected](#what-is-collected).
- `value` and `updated`: its reading and when it was taken. A few readings are text, such as a battery's state.
- `status`: `ready` when `value` is current, `pending` while there is none yet (shown as "…"), and `unavailable` when it cannot be read (the row is not displayed).
- `file`: the file used to read the sensor, such as its temperature input file or `/proc/meminfo` for memory sensors. Sensors without a file include NVIDIA readings (`nvidia`), filesystem space (`location`), the public IP, screen redraws and, on some machines, CPU frequencies. Values supplied by discovery, such as a graphics card's driver version, and computed averages, minima and maxima also have no file.
- Other fields identify the sensor's part of a shared file: the interface name for a network rate or the core for a CPU reading. Network sensors also have `hardware`, which says whether the interface is a hardware device.
- `lowIsBad`: set by discovery when low values are a concern, as with free memory, battery charge or WiFi link quality (`LOW_IS_BAD` in `sensors.js`). The sensor's colour scale applies downwards from its breakpoints; other sensors' scales apply upwards.
- `customLabel`, `hidden` and `pinnedToCategory`: the user's label, hiding choice and category pin. Discovery preserves them. A hidden sensor is excluded from aggregates and normally has no menu row; "Show hidden sensors" reveals it. Hiding leaves its top-bar pin intact.

Each source definition in `sensors.js` groups its file, parsing logic and sensor definitions. Each sensor has a label, format and `compute` function that derives its value from a reading. During discovery, the collector assigns the source and `compute` function to each registered sensor's `runtime` fields. Reads use those assignments. Computation functions are not saved.

## Keys

A key identifies a sensor within its category. Discovery matches by key on every run, updating the existing sensor's fields while retaining its user choices. The renderer holds sensor objects directly.

See [Sensor keys](sensor-key-format.md) for formats, examples, color-setting targets and the limits of identifying same-name devices.

## The panel

Panel membership is stored on the sensors themselves:

- `panelPosition`: a sensor's position in the top bar. An absent field means it is not pinned. `panelSensors()` gathers and sorts the pinned sensors.
- `reservedWidth`: the space reserved for a value when "Steady widths" is enabled. `-1` uses the text's natural width. The [top-bar design](design.md#the-top-bar) describes when widths are retained or reset.
- `runtime.reservedWidthLastFilled`: when the value last needed its full reserved width. This is not saved.

Pinning adds a sensor at the end of the top bar and resets its reserved width. Unpinning removes its position, so repinning puts it at the end again. Dragging changes the order through `movePanelSensor`.

An absent device keeps its pin but has no visible top-bar item until it returns. A sensor in a disabled category also keeps its pin but is not displayed.

## On disk

The catalog is saved in one setting, excluding every `runtime` field. It records sensors, their readings and user choices. Category on/off switches and display options are separate settings; the renderer combines them with the catalog to determine what is visible.

- The setting is called `catalog`. Its schema default contains entries for the three initial top-bar pins. Discovery fills in the rest of the catalog.
- The separate `catalog-settings` setting stores category switches in the same nested form as the catalog: `{temperature: {enabled: true}, …}`. It replaced the ten `show-*` settings and contains only categories whose switches the user has changed. Other categories use the `enabled` defaults in `sensorCategories`. Each of the two settings has one writer.
- User changes to pins, labels, hiding and ordering save the catalog, as does panel destruction. Discovery saves when the sensor count changes.
- There are no migrations. Settings saved by earlier versions are not converted.
- The preferences window runs in a separate process. Its category switches write `catalog-settings` (`_categoryPage` in `prefs.js`), and its colour pages read sensor labels from the saved catalog. The extension applies switch changes when it receives a `catalog-settings` change notification.
- Session-only fields live in `runtime`: collection marks, source references, computation functions and `initialTemperature` (the reading remembered by the hide-zeros option). These fields are not saved. The last reading (`value`, `updated`, `status`) is saved, but loading sets every sensor to `pending`, so every value starts as "…".

The setting stores the catalog as nested records and lists, using GNOME's `a{sv}` settings type. `helpers/storedCatalog.js` converts the catalog's plain data into that structure rather than serializing it as text. GNOME provides the code to read the structure back.

Display settings and category options, such as hide-zeros, storage locations and public IP options, remain separate.

**Known bug:** discovery checks only the sensor count when deciding whether to save. It misses changed fields and runs that add and remove equal numbers of sensors. As a result, the preferences' colour pages can show stale catalog data until another save. The persistence logic needs fixing; this behavior is unintended.

## The renderer

- It draws categories as menu sections and pinned sensors as top-bar items.
- Updates affect only the changed sensors. A sensor appearing or disappearing adds or removes its row. Pinning, unpinning or moving a sensor changes that one top-bar item. A new reading updates that sensor's text.
- Changing a display setting may redraw everything. This happens rarely; avoiding a full redraw is worthwhile only if it keeps the code simple.
- The `_rows` and `_panelItems` maps use sensor objects directly rather than looking them up by key.
- Dragging a sensor in the top bar concerns only the renderer; the collector keeps reading.
- Rows sort by `section`, then `heading`, then explicit `order`, then their displayed labels. Missing section and order fields count as zero. Labels and headings use natural sorting, so "Core 2" comes before "Core 10". The menu does not use the catalog's discovery order.

## What is collected

The renderer sets `runtime.shown` for present pinned sensors in enabled categories. While the menu is open, it also marks enabled category headers and rows in expanded categories. These marks include rows outside the scroll viewport and unavailable sensors awaiting recovery. They describe which readings the UI needs, not whether an actor is currently visible. The collector derives `activeSources` from those marks, category pins and aggregate inputs. With the menu closed, collection is driven by the pinned sensors.

On each tick, the collector refreshes the active-source map and reads each due source once. Sensors sharing a source share its reading. As each read finishes, it updates the active sensors that depend on it and notifies the renderer. A slow source therefore does not delay the others. Source state and the active-source map persist between ticks.

Read costs vary by source and hardware. The [historical measurements](changes-against-upstream.md#historical-speed-and-memory-measurements) include per-source costs from one ThinkPad.

Failed reads are expected during monitoring. The collector marks their sensors `unavailable`, the renderer hides their rows, and the failure is logged with `console.debug` rather than as an error.

An aggregate is computed from other sensors. Showing one activates the sources of present, non-hidden sensors in its category, including inputs not on screen. Aggregates are calculated after the category's reads finish. Unavailable inputs are excluded; pending inputs keep the aggregate pending. Battery power totals exclude peripheral batteries.

After changing these marks, the renderer calls `shownChanged`. The collector reads newly needed sources immediately through `_readNewlyShown`, except when it can reuse a reading. A ready reading with a previous sample is reused if it is younger than the update interval. A source still within its own interval also keeps its reading. Catalog changes, including a different category pin, update collection too. Sensors sharing an already active source use its existing samples.

A rate needs two readings. If the first leaves a sensor pending, the collector schedules a second read one second later (`SECOND_READING_SECONDS`). Regular ticks wait for that read. Removing the source from the active-source map cancels the second read; discovery delays it until the run ends. If an inactive source's samples are stale when it is needed again, the collector starts a new pair. It does not calculate a rate across the time the source was inactive.

When the last successful reading is younger than half the update interval, the collector uses that reading's previous sample as the rate's starting point, if one exists. Otherwise it uses the last reading itself. This avoids very short intervals after Refresh while allowing the first pair of samples to produce a rate. Rates are never computed across a failed read.

A reading from `nvidia-smi` holds only the requested fields. When newly shown sensors require additional fields, the process restarts with those fields. Its previous reading is marked pending because it may lack those fields, and the collector requests a new reading immediately.

## Device identity

Where discovery supports several devices with the same name, it numbers them. This distinguishes devices within a run, but a name can refer to a different physical device after a restart. See [device identity limits](sensor-key-format.md#device-identity-limits).

## Discovery

Discovery runs at launch, when the menu opens, on Refresh, and when a setting affecting discovery changes. Checking when the menu opens brings newly connected devices into the menu. Devices can be connected or removed at any time, so later runs add and retire sensors while preserving those still present. Only one discovery run can be active at a time.

At launch, the collector starts reading as soon as the first discovery run finishes. Until then, every value is "…". Refresh runs discovery, then immediately reads every shown value, ignoring source intervals such as the public IP's.

### The `discovered` field

`discovered` records the start time of the last run that found the sensor. Every sensor found in that run gets the same timestamp. It uses wall-clock time because the timestamp is saved on disk and compared after restarts.

- A sensor that has never been found has no timestamp.
- During discovery, a sensor with the current run's timestamp has already been matched.
- After discovery, an older timestamp means the run did not find that sensor. It also records when the sensor was last seen.

### Whether a sensor is present

A sensor is present when it was found in the last run that completed its category:

```js
sensor.discovered !== undefined && sensor.discovered >= (category.discovered ?? 0)
```

Presence is derived by `sensorPresent` in `helpers/storedCatalog.js`, not stored separately. A sensor without a discovery timestamp is not present.

- Only present sensors in enabled categories can appear. Top-bar items also require a `panelPosition`; menu rows follow hiding and availability rules.
- The collector reads only sensors that are present.

Presence is checked against the last run that completed the category. During a new run, sensors already found have a newer timestamp; sensors not yet reached still have the old one. Both count as present because the category's timestamp advances only when discovery completes that category.

A sensor the user hid (`hidden`) is still present. It keeps its top-bar pin, and "Show hidden sensors" can reveal its menu row.

### A run

1. The run takes the current wall-clock time in seconds as its timestamp.
2. Discovery looks up each sensor by key within its category. If found, it updates that sensor's discovery fields and runtime source; otherwise it adds a sensor. User choices remain on the existing sensor.
3. When all discovery steps feeding a category succeed, its `discovered` timestamp advances to the run's timestamp. Sensors not found in that run then cease to be present.
4. If a discovery-related setting changed during the run, discovery repeats before completing.

The [key-format reference](sensor-key-format.md#device-identity-limits) explains how discovery order affects identically named devices.

### Sensors a run did not find

A sensor missing from a discovery run still has its `file` field. The path contains a device number that the kernel can later reuse for another device. Continuing to read that path could show the new device's value under the old sensor's label.

Completing discovery for the category makes its timestamp newer than the missing sensor's. The sensor then counts as absent and is no longer read. During discovery, an old and a new sensor can briefly point at the same file. Completing the category resolves that without modifying the missing sensors.

A category can receive sensors from several discovery steps. Temperatures, for example, come from hwmon, thermal zones and graphics cards. Discovery completes the category only when all those steps succeed. If a step fails, the affected categories keep their previous timestamps, so previously present sensors remain present.

The collector compares the interfaces in each `/proc/net/dev` reading with those in the catalog. If they differ, it immediately runs discovery for the network category alone. That run timestamps the interfaces it finds and sensors shared across interfaces, such as the totals, then completes the category.

An absent sensor stays in the catalog with its label, category and top-bar position. If a later run finds it, discovery updates its timestamp and `file`, making it present again.

### Forgetting

Sensors that have not been found for a year are removed unless pinned to the top bar. This prevents temporary names, such as the `veth…` interfaces created when containers start, from remaining in the saved catalog forever.

A pinned sensor is never dropped, however long its device has been away.

### Reading during a run

Regular collection pauses during discovery. Discovery itself reads files and devices to identify sensors and their supported fields.

- When a run starts, reads that are under way are cancelled.
- Ticks during discovery are skipped, not queued. Regular collection resumes on the next tick after discovery finishes.
- Sensors newly needed during discovery, for example when the menu opens, are read when the run ends.

This prevents regular collection from using a sensor path while discovery is reassigning it.

The collector keeps readings taken before discovery. Rates such as network speed use the difference between the last reading before the run and the first one after it, divided by the actual elapsed time. They therefore do not restart with "…" after every discovery run.

## Saved pins

Top-bar pins are saved as `panelPosition` on each sensor; a category pin is saved as `pinnedToCategory` on that sensor. Discovery matches the saved sensor by key, so both choices follow the same [device identity limits](sensor-key-format.md#device-identity-limits).
