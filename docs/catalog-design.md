# Design: the sensor catalog

This is the design we worked out in discussion on 2026-10-07, and how `sensors.js` and `extension.js` are built. Where the code differs from what was agreed in the discussion, the section "Where the code differs from the discussion" at the end says so.

## Two parts with separate jobs

- **The collector** (`sensors.js`) knows every sensor, reads their values, and stores the catalog on disk.
- **The renderer** (`extension.js`) displays the catalog. Beyond the catalog it only knows the user's display settings, such as the temperature unit or the icon style.

Neither does the other's job. The renderer never decides what exists or what is collected, and the collector never decides how something looks.

## The catalog

The catalog consists of categories, and each category has its sensors, in order. It is plain data: text, numbers and true/false. It contains no functions, and nothing is kept beside it.

```js
catalog = {
    temperature: {
        enabled: true,
        discovered: 1759820000,
        header: 'average',
        sensors: [
            {
                key: 'acpitz/temp1',
                label: 'ACPI Thermal Zone',
                format: 'temp',
                discovered: 1759820000,
                file: '/sys/class/hwmon/hwmon0/temp1_input',
                value: 63,
                updated: 1759823000
            },
            {key: 'thinkpad/temp1', label: 'thinkpad CPU', format: 'temp', file: '/sys/class/hwmon/hwmon5/temp1_input', …},
            {key: 'average', label: 'Average', format: 'temp', …}
        ]
    },
    memory: {enabled: true, header: 'usage', sensors: [{key: 'usage', label: 'Usage', format: 'percent', …}, …]},
    …
    panel: {
        sensors: [
            {category: 'memory', key: 'usage', visible: true},
            {category: 'temperature', key: 'thinkpad/temp1', visible: false}
        ]
    }
}
```

### A category

- `position`: the category's place in the menu, once the user has arranged the categories. Without it the categories are in the alphabetical order of their names.
- `enabled`: whether the category is switched on. This replaced the ten `show-*` settings.
- `discovered`: the timestamp of the last discovery run that completed this category. See "Discovery".
- `header`: a link to the sensor of this category whose value is shown in the category's menu header. It is a link of the same kind as the panel's; on disk it is that sensor's key. The collector chooses it after every discovery run. For voltage it is the battery's, then the system's, then a USB supply's. A sensor the user pinned to the category (`categoryDefault`) comes before any of these rules.
- `shown`: whether the header is on screen right now. The renderer sets this; see "What is collected".
- `sensors`: its sensors, in the order in which they were found. The menu shows them by section and label; see "The renderer".

### A sensor

- `key`: tells it apart from the other sensors in its category. See below.
- `label`: the text shown in the menu, such as "ACPI Thermal Zone" or "Usage".
- `format`: how its value is formatted.
- `discovered`: the timestamp of the discovery run that last found it. See "Discovery".
- `section`: which part of its category's menu a sensor belongs to. The rows of a section stay together, whatever their labels are. The network sensors name one, and so do the average, minimum and maximum, which also carry `aggregate`.
- `icon`: the name of its icon in the icon theme, when it is not its category's, such as `vitals-storage-read-symbolic`. Discovery writes it, and a few sensors take it from each reading: the WiFi values the bars of their signal, the public IP its country (`vitals-country-de-symbolic`). The renderer shows the category's icon when no theme has an icon of that name.
- `shown`: whether it is on screen right now. The renderer sets this; see "What is collected".
- `value` and `updated`: its reading and when it was taken. A few readings are text, such as a battery's state.
- `status`: `ready` when `value` is current, `pending` while there is none yet (shown as "…"), and `unavailable` when it cannot be read (the row is hidden).
- `file`: the file the sensor is read from. A temperature has a file of its own; the memory sensors all name `/proc/meminfo`. A few sensors are read from something that is not a file and have no `file`: a card read through `nvidia-smi` has `nvidia`, the space of a storage location has `location`, the place where it is mounted, and the public IP, the screen redraws and, on some machines, the CPU frequencies are known by their key. A sensor whose value discovery wrote, such as the kernel version, has none either, and neither has an average, minimum or maximum.
- Fields that say which part of the file is the sensor's: the interface name for a network rate (with `hardware`, whether that interface is a hardware device), the core for a CPU core.

- `lowIsBad`: set by discovery on a sensor whose low values are the ones to watch, such as free memory, a battery's charge or the WiFi link quality (`LOW_IS_BAD` in `sensors.js`). A colour scale on such a sensor colours downwards from its breakpoints; on every other sensor, upwards.
- `customLabel`, `hidden` and `categoryDefault`: what the user set for the sensor in the menu: another name, that it has no row, and that it is the sensor its category shows in its header. Discovery does not touch them.

Any further field can be added to a sensor later without changing the structure.

There is no field that says how to compute the value. The code knows from the sensor's category and fields which rule applies (`Sensors._value`): a temperature is its file's number divided by 1000, and "memory usage" is computed from two lines of `/proc/meminfo`. The sensors that are found by their key alone, such as memory usage, are listed with their label, format and computation in the `FIXED` table in `sensors.js`.

## Keys

A key only has to tell a sensor apart from the others in its own category. The same key may appear in many categories.

| Category | Sensor | Key | Read from, on this machine |
|---|---|---|---|
| temperature | ThinkPad temperature input 1 | `thinkpad/temp1` | `/sys/class/hwmon/hwmon5/temp1_input` |
| temperature | ACPI zone | `acpitz/temp1` | `/sys/class/hwmon/hwmon0/temp1_input` |
| temperature | thermal zone of type `SEN1` | `thermal/SEN1` | `/sys/class/thermal/thermal_zone2/temp` |
| temperature | average | `average` | computed |
| voltage | battery voltage | `BAT0/in0` | `/sys/class/hwmon/hwmon4/in0_input` |
| fan | ThinkPad fan | `thinkpad/fan1` | `/sys/class/hwmon/hwmon5/fan1_input` |
| fan | average | `average` | computed |
| network | download rate of `eth0` | `eth0/rx` | `/proc/net/dev`, the line for `eth0` |
| processor | usage of core 8 | `cpu8` | `/proc/stat`, the line for `cpu8` |
| processor | usage | `usage` | `/proc/stat` |
| memory | usage | `usage` | `/proc/meminfo` |

Rules:

- **No directory numbers.** The number in `hwmon5` or `thermal_zone2` is given by the kernel in the order it finds devices and can differ at the next boot. A key uses the device's name instead, which is the content of the directory's `name` file, or of the `type` file for a thermal zone.
- **Input numbers stay.** `temp1`, `in0` and `fan1` are fixed by the driver. They are also the only thing that tells unlabelled inputs apart, such as `temp3` to `temp7` of the ThinkPad.
- **The separator is `/`,** because it cannot occur in a device, zone or interface name.
- **A key is used exactly once: at launch.** The stored catalog is loaded, discovery finds the sensors on the machine, and inside each category it matches them to the stored ones by key. After that the code holds the sensors themselves and never looks anything up by key.

The `file` field holds the path as it is today. Discovery writes the current path into it at every launch, so a stored path is not trusted across a reboot.

Graphics cards get keys like every other device, from the device's name and the name of the value: `NVIDIA GeForce RTX 3080/utilization.gpu` for a card read through `nvidia-smi`, and `0x1002/gpu_busy_percent` for a card read from `/sys/class/drm`, whose name is its vendor id. All cards are in the one category `gpu`.

The colour settings name a sensor by its category and key, as `sensor:temperature/thinkpad/temp1`, and all sensors of a category with one kind of value by that kind, the sensors' `format`, as `kind:temp`. That text is only compared; no sensor is looked up with it.

## The panel

The panel is a category like the others. The difference is how sensors get into it: the user puts them there, and its order is the user's order.

- Its sensors are links to real sensors. A link names the category and the key of the sensor it points to, and holds its own `visible` flag. A hidden link keeps its place.
- A link is turned into a pointer to the real sensor in the launch step. From then on the panel shows that sensor's label, format and reading; it has no copies of them.
- A link whose sensor is not on the machine, such as an unplugged device, stays in the panel category and shows nothing. Its top-bar item is created when the sensor is found.
- Whether a linked sensor is shown also depends on its own category: a sensor of a category that is switched off is not shown in the panel either.

## On disk

The whole catalog is stored on disk as it is, in one setting. It is the single source for which sensors there are, how they are ordered, and what is switched on or visible.

- The setting is called `catalog`. It replaced the `panel-sensors` setting and the ten `show-*` settings. Its schema default switches the categories on or off for a new user and puts three sensors in the panel.
- It is written when its structure or state changes: discovery finds a new sensor or forgets one, or the user pins, moves or switches something.
- There are no migrations. Settings saved by earlier versions are not converted.
- The preferences window is a separate program. Its category switches write `enabled` in the saved catalog (`writeCategoryEnabled` in `helpers/storedCatalog.js`), and it reads the sensors' labels from there for the colour pages. The extension takes a changed switch over when the setting changes, and when it saves it keeps the `enabled` values that are on disk.
- The fields that only mean something while the extension runs are not written: `shown`, `status`, the reading (`value` and `updated`), and `initialTemperature` (what the hide-zeros option remembers). A reading from an earlier session says nothing about now, so every value starts as "…".

The setting holds the catalog as a structure, not as text. GNOME's settings format stores nested records and lists directly (type `a{sv}`). `helpers/storedCatalog.js` turns the catalog's plain data into that format; reading it back is built in.

Other settings stay as they are: the display settings, and the options that belong to one category, such as hide-zeros, the storage locations and the public-IP options.

## The renderer

- It draws every category the same way from the catalog: the sensor categories as menu sections, the panel as items in the top bar.
- It changes only what changed. A sensor that appears or disappears adds or removes its own row. Pinning, unpinning or moving a sensor adds, removes or moves that one top-bar item. A new reading updates that sensor's text.
- A change of a display setting may redraw everything. That is rare, and avoiding it is only worth doing where it comes out naturally.
- It holds its rows and items by the sensors and links they show (`_rows`, `_panelItems`), not in tables looked up by key.
- A row's place in its category follows from the sensor's `section` and, inside a section, from the alphabetical order of the labels. A sensor that returns gets its row back in the same place. The order of the sensors in the catalog is the order in which they were found; the menu does not show it.

## What is collected

The renderer sets in the catalog what it shows: it marks a sensor as `shown` when it puts it on screen and clears the mark when it takes it away, and it marks a category as `shown` while its header is on screen. The collector fills in the values of the sensors that are marked and of the headers of the categories that are marked, and reads only the files behind those. With the menu closed that is two or three files per tick.

A tick is one pass over the catalog. It collects the files of the marked sensors, and for each file the sensors that are written from it. Each file is then read once, its content is taken apart once, and that read writes all its sensors; the renderer is told about them at once, so a slow source does not hold the others back. Nothing is kept between ticks about which sensors are collected: the catalog and its marks say it.

An average, minimum or maximum is not read from anything. When one of them is marked, every sensor of its category is read, also those that are not on screen, and the three are computed together once, when the last of those reads is in.

After it changed the marks, the renderer tells the collector so (`shownChanged`); see the last section. What came on screen is then read at once and does not wait for the next tick, which can be a minute away (`_readNewlyShown`, decided on 2026-10-10). Only that is read: a source that is on screen and has no reading. A source whose reading is younger than the update interval keeps it and is read at the next tick, unless that reading is a first one alone, and one that is still inside its own interval, such as the public IP, keeps the reading it has. The same happens when the catalog changed, for instance when another sensor became a category's header.

A rate needs two readings, and all sensors of one file share them: with download speed in the top bar, `/proc/net/dev` always has two, and every network speed has its value the moment its row appears. A rate whose file was not on screen during the last update interval starts from nothing, and it is not computed across a longer time off screen. So a first reading that leaves a sensor without a value is followed by a second reading one second later (`SECOND_READING_SECONDS`), and the rate shows what happened in that second until the next tick. A tick before the second reading does not read the source, so the rate spans that second. A rate is not computed against a reading younger than half the update interval but against the one that reading was computed against: a tick right after the second reading spans from the first reading, and Refresh right after a tick from the tick before. Only the second reading is computed against the first, however young. The second reading is called off when the source leaves the screen before it, and when it falls into a discovery run it waits for the end of that run.

A reading from `nvidia-smi` holds only the fields that were asked for. When another sensor of a card comes on screen, the process is started again with more fields, and the reading it left counts as none, so the new sensor is read at once like any other.

## Sensors with the same key

Two sensors in one category may have the same key. Nothing is done to prevent it, and nothing needs to be, because the running code never finds a sensor by its key. From the outside the two are hard to tell apart; each still has its own `file`, so both are read correctly.

Where it happens, confirmed in the kernel source on 2026-10-07:

- **Two NVMe drives.** `drivers/nvme/host/hwmon.c` registers every drive's hwmon device under the fixed name `"nvme"`, so both give `nvme/temp1`.
- **Several CPU packages.** `drivers/hwmon/coretemp.c` creates one hwmon device per package, each under the fixed name `"coretemp"`.
- **Several ACPI thermal zones.** `drivers/acpi/thermal.c` registers every ACPI thermal zone with the fixed type `"acpitz"`.

None of these occurs on this machine.

## Discovery

Discovery runs at launch and again while the extension runs: when the menu opens, on Refresh, and when a setting that affects it changes. Devices can be plugged in and removed at any time, so a later run has to add and retire sensors without disturbing the ones that are still there. There is only one run at a time.

### The `discovered` field

`discovered` holds a timestamp: the time at which the run that last found the sensor started. It is the same for every sensor found in one run. It is real time, since it is stored on disk and compared after a restart.

- A sensor that has never been found has no timestamp.
- During a run, a sensor whose timestamp is that of the run has already been matched in it.
- Afterwards, an older timestamp says the sensor was not found in the latest run, and how long ago it was last seen.

### Whether a sensor is present

A sensor is present when it was found in the last run that completed its category:

```
present  =  sensor.discovered >= category.discovered
```

`present` is not stored. It follows from the two timestamps.

- A sensor is shown when it is present and its category is `enabled`. For a panel sensor, the link has to be `visible` as well.
- The collector reads only sensors that are present.

The comparison is with the last run that completed the category, not with a run that is still in progress. While a run is under way, a sensor it has already found carries a newer timestamp and a sensor it has not reached yet carries the old one; both are still present. The category's timestamp moves only when the category is complete.

A user cannot hide a single sensor in the menu today, so a sensor has no `visible` field of its own. If that is ever offered, the field is added then.

### A run

1. The run takes its timestamp: the current time in whole seconds, and always later than the run before, also when two runs start in the same second or the system clock was set back.
2. It goes through the machine. For each sensor it finds, it looks in that sensor's category for a stored sensor with the same key that does not yet carry this run's timestamp.
   - If there is one, that is this sensor: it gets the run's timestamp and its current `file`.
   - If there is none, either because the key is new or because every stored sensor with that key is already matched, a new sensor is added to the category, with the same key if need be.
3. When a category is complete, the run sets the category's `discovered` to its own timestamp. From that moment the sensors it did not find are no longer present. See below.

With two drives called `nvme`, the first one found takes the first stored `nvme/temp1` and the second takes the second. Which drive is found first follows the kernel's numbering, so if that order differs after a reboot, the two swap their stored state, such as their place in the panel. That is accepted.

It can be closed at any time without changing the structure: a sensor can carry one more field that identifies its device for good, such as a drive's serial number, and discovery would then match on that field as well as on the key.

### Sensors a run did not find

A sensor that a run did not find still has its `file` field. That path contains the kernel's number for the device, and the kernel hands a number to another device once it is free. If the sensor were still read, it would show another device's value under its own label.

It is not read, because it is no longer present: when the run completes the category, the category's timestamp becomes newer than the sensor's. While the run is in progress, an old sensor and a new one may point at the same file for a moment; completing the category ends that. Nothing has to be written into the sensors that were not found.

A category can be fed from more than one place: temperatures come from hwmon, from the thermal zones and from graphics cards. It is complete when all of them are done. When a discovery step fails, the categories it feeds are not completed in that run, and their sensors stay as they were.

Every reading of `/proc/net/dev` is compared with the interfaces the catalog has. When they differ, a small run of its own for the network category follows at once: it gives its timestamp to the interfaces it sees and to the network sensors that do not belong to one interface, such as the totals, and then completes the category.

A sensor that is not present stays in the catalog with its label, its place and its panel link. When a later run finds it again, it gets that run's timestamp and its current `file`, and it is present again.

### Forgetting

A sensor is dropped from the catalog when it has not been found for a year and is not in the panel. This is for names that are used once and never again, such as the `veth…` interface that every container start creates. Without it they would stay in the stored catalog for good.

A sensor that is in the panel is never dropped, however long its device has been away.

### Reading during a run

No sensor is read while a discovery run is in progress.

- When a run starts, reads that are under way are cancelled.
- A tick that falls into a run does nothing. It is not held back and carried out later; the next regular tick after the run reads again.
- What came on screen during a run, as when the menu opens, is read when the run ends.

That way no sensor is ever read through a path that the run is about to turn off.

The readings taken before the run are kept. A rate, such as network speed, is then computed between the last reading before the run and the first one after it, over the time that really passed, so it does not start over with "…" after each discovery.
## Links on disk

A link, in the panel or as a category's `header`, is a pointer to its sensor while the extension runs. On disk it is written as the category and the key of that sensor. At launch each link is turned back into a pointer, to the sensor with that key in that category.

When two sensors share a key, a link cannot say which of them it means, and it resolves to the first one. With two NVMe drives, a link to the second drive's temperature points at the first drive after a restart. That is accepted: it is a property of a machine whose devices cannot be told apart by name, and every program that reads those names has it. Like the swap described above, it can be closed later with one more identifying field.

## Where the code differs from the discussion

- **The renderer tells the collector that the marks changed.** The discussion had the collector pick up the `shown` marks by itself at the next tick. With that, a sensor that comes on screen would show the value from the last time it was read until the next tick, and a source nobody shows any more, such as the `nvidia-smi` process, would run on until then. So the renderer calls `shownChanged` after it changed the marks.
- **The network run happens when the list of interfaces changed,** not on every tick. The result is the same; the timestamps of the network sensors just do not move every few seconds.
- **All graphics cards are in one category and one menu section.** Before, every card had a section of its own ("Graphics 1", "Graphics 2"). With several cards, the labels now say which card a value belongs to ("GPU 2 Utilization"), and the header shows the utilization of the first card. With one card nothing changes.
- **The panel category has no `enabled` field.** Nothing would read it.
