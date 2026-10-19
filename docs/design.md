# Design decisions

What Vitals does and why, outside the sensor catalog, which [catalog-design.md](catalog-design.md) describes. The terms are defined in [glossary.md](glossary.md).

## Where values come from

- No program is started to read a sensor (decided on 2026-10-10). `nvidia-smi` is the one exception, since NVIDIA offers no other way.
- Vitals does not use `libgtop` (decided on 2026-10-08): it gives the same numbers from the same files as about 50 lines of our own parsing, and would add a package that is often not installed and calls that block the main thread. Storage space comes from GLib (`query_filesystem_info_async`).
- A rule that says what something on a machine is, such as which mounts are storage, is not made up for Vitals (decided on 2026-10-11): its code is only ever seen running on one machine. Such a rule is taken unchanged from a program that has proven it on many machines, such as `df` or libgtop, and the comment names the source. Where the user can decide instead, the user decides.

## Temperatures

Temperatures come from `/sys/class/hwmon` and `/sys/class/thermal`. A thermal zone is left out when it is not a sensor, when the kernel also publishes it through hwmon, or when an hwmon driver reports the same value; the lists are in `sensors.js`.

## Storage

- The Storage category shows the storage locations the user chose (decided on 2026-10-11). A storage location is a mount point, not any path: the folder of a disk that is not plugged in lies on another disk, whose numbers would be shown under its name. At the start `/` is the only one.
- Monitored are the mount points in the setting `storage-locations`; one stays in it while nothing is mounted there. With `storage-monitor-volumes` (off by default), the mounts of `Gio.VolumeMonitor` are monitored too: GIO collects them from the volume monitor services of gvfs, of which `gvfs-udisks2-volume-monitor` reports the disks. The preferences call them "drives mounted by GNOME".
- A location is added by picking it from what is mounted now, not by typing. Offered first are those that libgtop counts as a disk or `df` as remote.
- What is mounted where comes from `/proc/self/mountinfo` (`parseMountTable`). An automount that waits to be used counts as nothing mounted, since asking it would connect it.
- The space of a location is asked from the kernel, once per location. The mount table is read first, because asking a path where nothing is mounted any more would connect an automounted share again. A location is not asked again while a question is out: a share whose server is gone can take minutes to answer.
- A network location is one that `df` counts as remote (`isRemoteMount`, gnulib's `ME_REMOTE` as it is). It is asked at an interval of its own, `storage-network-interval`, which works like the public IP's interval in every part.

## Network

- The network sensors follow `/proc/net/dev`: when a reading shows other interfaces than the catalog has, discovery of the network category follows at once. There are no placeholder rows for missing interfaces.
- The network totals are over the hardware interfaces only: what a bridge, a container or a VPN carries passes a hardware interface as well and would count twice. An interface is hardware when the kernel gives it a `device` entry under `/sys/class/net/<name>/`.
- The network menu is in sections. `network-hardware-only` is a display setting, on by default: with it on, interfaces that are not hardware have no menu row.

## Batteries

Every battery is found by itself (`type` is `Battery`), also that of a mouse or a keyboard; there is no setting for which battery to show and no list of battery names. With several batteries a label names its battery, a device's battery (`scope` is `Device`) by the device's model. With several batteries that power the machine there is one more sensor, the total power rate, which is the default pin; otherwise the default pin is the power rate of the one battery, or the percentage of a device's battery, which has no power rate.

## Categories

- A category has one name, `name` in `sensorCategories` (`helpers/categories.js`), which the menu and the preferences show translated. It is typed nowhere else and not derived from the key.
- The average, minimum and maximum of the temperatures and of the fans are a section of their own; `include-aggregates` only decides whether they have menu rows.

## Colour scales

Colour scales follow one rule (decided on 2026-10-10), `colorStyle` in `helpers/colors.js`: a category's scales colour that category's sensors, a scale is for one sensor or for all sensors of the category with the same kind of value, and which end is the bad one is a fact about the sensor (`lowIsBad`), not the user's choice.

## The menu

- The menu opens with its middle under the pointer, or under the middle of the top-bar item when opened from the keyboard or with the "Open centered under the sensors" option, and stays at that place while it is open.
- The menu has a fixed width; in a row that is too narrow the label is shortened, never the value.
- A category slides open with a slide of our own, never GNOME Shell's: the Shell only slides a submenu that needs no scrollbar, so long and short categories would behave differently. One category is open at a time, and it stays open while the menu is closed.
- Each level of the menu starts under the name of the level above it.
- A click on a row opens its row menu under the row and does nothing else: Pin to top bar, Pin to category, Rename, Hide. A row's marks only show the state.
- The row menu follows the second-level menus of GNOME Shell's quick settings (`QuickToggleMenu`), decided on 2026-10-09 after a design of our own was not recognisable as belonging to its row. It slides as long as they do.
- A click anywhere else closes the row menu and does nothing else. Escape closes the whole menu, as in every menu of the Shell.

## The top bar

The rules for its look were decided on 2026-10-11. The values themselves are in `stylesheet.css`.

- A distance is a fixed value in the stylesheet, set in one place: the `spacing` of the box whose children it separates. A user who wants another distance overrides that one rule. Nothing else adds to a distance, so the margin and padding that the Shell's theme gives a status icon are taken off.
- Nothing about a text or an actor is measured to place it. Code that measured where the glyphs are drawn gave uneven distances three times.
- There is no special case: hidden icons get the same distances, and there is no margin per icon.
- A class of the Shell is not put on something for a side effect; the battery's class `power-status` on every sensor was such a case.
- A value is one label, with the unit marked inside its text for the "emphasize values" option. Only inside one text do two sizes stand on one line of writing: the Shell's boxes line their children up by edges and know no baseline.
- The stylesheet does not set `tnum`: the Shell's theme sets it on the whole top bar.

The `emphasize-values` option (on by default) is the part of the look that is a matter of taste: icons and units lighter and smaller than the numbers.

With the "fixed widths" option, a top-bar value keeps the room of its widest text of the last minute. While the option is off, no width is remembered.
