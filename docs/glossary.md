# Glossary

The terms used in the code and the documentation of Vitals, each with one meaning.

## The two parts

- **Collector**: `Sensors` in `sensors.js`. It knows every sensor, reads the ones that are shown, and writes the catalog.
- **Renderer**: `extension.js`. It displays the catalog in the top bar and the menu, and marks what is on screen.

## The catalog

- **Catalog**: every known sensor by category, plus the panel. Plain data, saved as a whole in the setting `catalog`. See [catalog-design.md](catalog-design.md).
- **Category**: a group of sensors of one kind, such as Temperature or Memory, with a page in the preferences and a part in the menu. Its name is `name` in `sensorCategories` (`helpers/categories.js`).
- **Sensor**: one value Vitals can show, such as a temperature input or the memory usage, with its label, format and reading.
- **Key**: what tells a sensor apart from the other sensors of its category. See [sensor-key-format.md](sensor-key-format.md).
- **Label**: the text that names a sensor in the menu. The user can replace it (`customLabel`).
- **Format**: how a sensor's value is written, such as `temp` or `percent`. A colour scale for all sensors of one format calls it a kind (`kind:temp`).
- **Section**: a part of a category's menu whose rows stay together, such as the network interfaces or the average, minimum and maximum.
- **Heading**: the battery, graphics card, network interface or storage location a sensor belongs to. The menu shows it above its rows when a category's rows fall into several groups.
- **Category pin**: the sensor whose value the category header shows (`categoryPin`): the one the user pinned to the category (`pinnedToCategory`), otherwise the default pin, which the collector chooses by its rules.
- **Aggregate**: the average, minimum or maximum of a category. It is computed from the category's other sensors, not read.
- **Pinned sensors**: the sensors the user pinned to the top bar, in the user's order. The catalog holds them as links in `panel.sensors`.
- **Link**: an entry of the pinned sensors, or a category pin: a pointer to a sensor, saved as the sensor's category and key. A link of the pinned sensors has its own `visible` flag; an unpinned sensor keeps its link with `visible` off, and with it its place.

## On screen

- **Top bar**: GNOME Shell's bar at the top of the screen. GNOME's code calls it the panel (`Main.panel`).
- **Top-bar item**: what Vitals shows in the top bar for one pinned sensor: an icon and a value.
- **Menu**: what opens from Vitals' top-bar items, with one part per category.
- **Category header**: a category's title row in the menu, with the category's name and the value of its category pin.
- **Row**: one sensor in the menu.
- **Row menu**: what opens under a row when it is clicked, with the sensor's actions.
- **Action**: an entry of a row menu: Pin to top bar, Pin to category, Rename, Hide.
- **Shown**: a sensor or category header is shown while it is on screen; the renderer sets `shown` in the catalog.
- **Hidden**: a sensor the user hid has no row (`hidden`). Not the same as unavailable.

## Reading

- **Source**: what one read gets values from: a file such as `/proc/meminfo`, the `nvidia-smi` process, a storage location, the public IP services. Several sensors can come from one source.
- **Read**: one request to a source.
- **Reading**: what a read of a source returned, with its time and status.
- **Status**: `ready` when a sensor's value is current, `pending` while there is none yet (shown as "…"), `unavailable` when its read failed (its row is hidden).
- **Tick**: one pass over the catalog at the update interval: every source of a shown sensor that is due is read once.
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
