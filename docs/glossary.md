# Glossary

[Documentation index](../README.md#development) · [Development](development.md)

The terms used in the code and the documentation of Vitals, each with one meaning.

## The two parts

- **Collector**: `Sensors` in `sensors.js`. It discovers sensors, reads the inputs needed by shown values and aggregates, and saves the catalog.
- **Renderer**: `extension.js`. It displays the catalog in the top bar and the menu, and marks which sensors and category headers need readings.

## The catalog

- **Catalog**: every known sensor by category, including its reading and user choices. Saved in the setting `catalog`, omitting session-only `runtime` fields. See [catalog-design.md](catalog-design.md).
- **Catalog settings**: the user's settings for the catalog, by category, in the setting `catalog-settings`: whether each category is switched on (`enabled`). The preferences window writes them.
- **Category**: a group of sensors of one kind, such as Temperature or Memory, with a page in the preferences and a part in the menu. Its name is `name` in `sensorCategories` (`helpers/categories.js`).
- **Sensor**: one value Vitals can show, such as a temperature input or the memory usage, with its label, format and reading.
- **Key**: what tells a sensor apart from the other sensors of its category. See [sensor-key-format.md](sensor-key-format.md).
- **Label**: the text that names a sensor in the menu. The user can replace it (`customLabel`).
- **Format**: how a sensor's value is written, such as `temp` or `percent`. A colour scale for all sensors of one format calls it a kind (`kind:temp`).
- **Section**: a part of a category's menu whose rows stay together, such as the network interfaces or the average, minimum and maximum.
- **Heading**: the name of a group of sensor rows within a category, such as a battery's name, "Memory details" or "Swap". The menu shows it above its rows when a category's rows fall into several groups.
- **Category pin**: the sensor whose value the category header shows, derived by `categoryPin(categoryName)`: the present sensor the user marked `pinnedToCategory`, otherwise the default chosen by the collector's rules.
- **Aggregate**: a value computed from other sensors, such as an average, minimum, maximum or battery power total.
- **Panel sensor**: a sensor pinned to the top bar, with a `panelPosition` and a `reservedWidth` for its displayed value.
- **Pinned sensors**: sensors with a `panelPosition`, sorted by that position. An absent sensor or a disabled category keeps its pins but shows no top-bar items.

## On screen

- **Top bar**: GNOME Shell's bar at the top of the screen. GNOME's code calls it the panel (`Main.panel`).
- **Top-bar item**: what Vitals shows in the top bar for one pinned sensor: an icon and a value.
- **Menu**: what opens from Vitals' top-bar items, with one part per category.
- **Category header**: a category's title row in the menu, with the category's name and the value of its category pin.
- **Row**: one sensor in the menu.
- **Row menu**: what opens under a row when it is clicked, with the sensor's actions.
- **Action**: an entry of a row menu: Pin to top bar, Pin to category, Rename, Hide.
- **Shown**: marked by the renderer with `runtime.shown` because the top bar or open menu needs its reading. This includes rows outside the scroll viewport and unavailable sensors awaiting recovery. See [What is collected](catalog-design.md#what-is-collected).
- **Hidden**: the user's choice to exclude a sensor from the normal menu and aggregates (`hidden`). "Show hidden sensors" reveals its row; its top-bar pin stays. Not the same as unavailable.

## Reading

- **Source**: what one read gets values from: a file such as `/proc/meminfo`, the `nvidia-smi` process, a storage location, the public IP services. Several sensors can come from one source.
- **Read**: one request to a source.
- **Reading**: what a read of a source returned, with its time and status.
- **Status**: `ready` when a sensor's value is current, `pending` while there is none yet (shown as "…"), `unavailable` when a read fails or yields no usable value. Unavailable sensors are not displayed.
- **Tick**: one collection pass at the update interval. It refreshes the active-source map and reads each due source needed by shown sensors or aggregates once.
- **Update interval**: the time between two ticks, the setting `update-time`.
- **Interval** (of a source): a time of its own between two reads of a source, longer than the update interval, such as the public IP's or that of a network storage location.
- **Rate**: a value computed from two readings, such as a download speed.
- **Second reading**: the read one second after a first reading, so that a rate that came on screen has a value.

## Discovery

- **Discovery**: looking for the sensors on the machine and matching them with the catalog.
- **Run**: one pass of discovery. Its timestamp is written into the sensors it finds (`discovered`).
- **Present**: a sensor is present when the last run that completed its category found it. Only present sensors are shown and read.
- **Refresh**: the button in the menu. It runs discovery, then reads every shown value at once, ignoring the intervals of the sources.

## Storage and network

- **Storage location**: a mount point the Storage category shows.
- **Network location**: a storage location that `df` counts as remote.
- **Hardware interface**: a network interface that the kernel gives a `device` entry under `/sys/class/net/<name>/`.

## Tests

- **Machine**: the test double for the system the collector monitors (`tests/machine.js`).
- **Fixture**: a frozen constant in `tests/fixtures/`, such as the files of the ThinkPad that the machine presents.
- **Device group**: the files of one device in a fixture, which a test plugs in or out together.
