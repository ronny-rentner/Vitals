# Design decisions

[Documentation index](README.md) · [Development](development.md)

## Where values come from

- Read procfs and sysfs asynchronously. Use GLib's `query_filesystem_info_async` for storage space. NVIDIA monitoring uses `nvidia-smi`.
- For hardware and filesystem classification, reuse established rules from tools such as `df` or libgtop and cite the source in the code. Observations on one machine do not justify a general rule. Where the user can decide instead, let the user decide.

## Memory

The first section shows used, reclaimable, free, available and total memory. Used is `MemTotal - MemAvailable`; reclaimable is `MemAvailable - MemFree`. That gives free + reclaimable = available, and used + available = total. To keep the displayed numbers consistent, the formatter uses the total's unit and rounds the operands before subtracting them. The raw readings are unchanged.

The memory page's "Show details" switch (`memory-show-details`, off by default) adds a section after a divider: file cache (`Cached - Shmem`), shared memory and tmpfs (`Shmem`), kernel reclaimable cache (`SReclaimable`), buffers and usage percentage. Switching it off leaves pinned sensors from that section in the top bar. Swap follows in its own section with used, free, total and usage regardless of that switch. These counters follow the [kernel's definitions](https://docs.kernel.org/filesystems/proc.html).

## Temperatures

Temperatures come from `/sys/class/hwmon` and `/sys/class/thermal`. Vitals excludes a thermal zone if it is not a sensor, if the kernel also exposes it through hwmon, or if an hwmon driver reports the same value. The exclusion lists are in `sensors.js`.

Individual core temperatures are off by default. Enable **Temperature** › **Show individual cores** to include them. Package temperatures remain available. CPU numbers appear in temperature labels on systems with multiple CPU packages.

## Icons

- **One category base per style.** Adjust the category's existing artwork to distinguish readings, keeping the base recognisable. Examples include the CPU with a waveform for frequency or a lightning bolt for power, and the drive with arrows for reads and writes. Temperature variants retain the thermometer as their main symbol.
- **Consistency within each set.** Classic and Adwaita have distinct artwork. Reuse each set's own shapes, including the same thermometer throughout that set.
- **Readability at the rendered size.** Both the base and its distinguishing detail must be recognisable in the actual panel. If both cannot remain legible, simplify the artwork.
- **Preserve proportions and GNOME rendering.** Cropping removes transparent borders while retaining the artwork's scale and aspect ratio. Do not stretch or pad a rectangular icon back into a square when using cropped top-bar icons. Preserve GNOME's symbolic recolouring, theme overrides, shadows and stock layout except for the intended size change. Keep cropping in `croppedIcon.js`. Menu icons must use stock `St.Icon`. Use shared stylesheet rules for spacing, without adjustments for individual icons.
- **Verify the result the user sees.** Inspect both styles in the running Shell at actual panel size. Confirm the active settings, including "Emphasize values". Check font and display scaling, and light and dark appearance, when the change affects them.

The Classic CPU base has two broad contacts on each side and a centered core. Its frequency and power icons keep the same outline and contacts. The Classic memory base is a horizontal module with three equally spaced bars. Draw outlines as filled paths with cutouts so their interiors stay transparent under symbolic recoloring.

Memory and WiFi bars light at the midpoints of the 0 to 33%, 33 to 67% and 67 to 100% bands: 16.5%, 50% and 83.5%. Each memory row represents its own share of total RAM; swap rows use total swap. Both Classic and Adwaita use this rule. The outline stays fixed and unlit bars remain visible.

## Storage

- The storage category shows the locations the user chose. Each location must be a mount point. If Vitals monitored an arbitrary folder after its disk was unplugged, it would show the containing disk's numbers under the missing disk's name. Only `/` is monitored initially.
- The `storage-locations` setting keeps the selected mount points, including those with nothing currently mounted. With `storage-monitor-volumes` enabled (off by default), Vitals also monitors mounts reported by `Gio.VolumeMonitor`. GIO gets these from gvfs volume monitor services; `gvfs-udisks2-volume-monitor` reports disks. Preferences calls these "drives mounted by GNOME".
- Users add a location by choosing from the current mounts rather than typing a path. Locations classified as disks by libgtop or as remote by `df` appear first.
- `parseMountTable` reads `/proc/self/mountinfo` to determine what is mounted where. It treats an idle automount as unmounted because querying it would trigger a connection.
- Vitals queries filesystem space once per location. It checks the mount table first to avoid reconnecting an automounted share after it has been unmounted. Only one filesystem query per location may be pending; an unreachable server can take minutes to answer.
- A network location is one that `df` classifies as remote (`isRemoteMount`, using gnulib's `ME_REMOTE` rule). Vitals queries its space only while it is mounted, using the separate `storage-network-interval` in minutes.

## Network

- Network sensors come from `/proc/net/dev`. If a reading contains a different set of interfaces from the catalog, Vitals immediately runs discovery for the network category. Missing interfaces have no placeholder rows.
- Network totals count hardware interfaces only, avoiding duplicate counts across hardware and the virtual interfaces carrying the same traffic. An interface is hardware when the kernel gives it a `device` entry under `/sys/class/net/<name>/`.
- The network menu is divided into sections. The `network-hardware-only` display setting is on by default and hides rows for interfaces that are not hardware.

## Batteries

Vitals discovers power supplies with `type` equal to `Battery`, including mouse and keyboard batteries, and UPS devices reported by UPower. Readings are grouped under their battery's name; a peripheral's model is used when available.

The kernel identifies peripheral batteries with `scope` set to `Device`. They may report power consumption, but Vitals excludes it from the computer's battery power total. Vitals adds that total when it finds more than one machine battery. UPS readings stay separate. The default category pin is the total if present, then the first power-rate sensor, then a percentage sensor. The user can choose a different category pin.

## Categories

- Define each category's display name once, as `name` in `sensorCategories` (`helpers/categories.js`). The menu and preferences translate that name rather than deriving it from the key.
- In each of the temperature and fan categories, the average, minimum and maximum share a separate section. The `include-aggregates` setting controls only whether those aggregates have menu rows.

## Colour scales

Each category has its own colour scales, applied by `colorStyle` in `helpers/colors.js`. A scale targets one sensor or all sensors in that category with the same kind of value. The sensor's `lowIsBad` field determines whether thresholds apply towards lower or higher values; the user does not choose that direction.

## The menu

- **Use sections inside categories.** Use dividers and headings instead of nested sensor submenus. A sensor's row menu is a separate interaction for its actions.
- By default, clicking Vitals opens the menu centered under the pointer. With "Open centered under the sensors", it opens under the center of Vitals' combined top-bar items. Its position stays fixed while it is open.
- The menu has a fixed width. If a row does not fit, its label is shortened; its value stays complete.
- Only one category can be open at a time, and it remains expanded when the menu closes.
- Each level of the menu starts under the name of the level above it.
- Clicking a row only opens the row menu beneath it, with "Pin to top bar", "Pin to category", "Rename" and "Hide". The marks on the row indicate state; they do not perform actions.
- The row menu follows GNOME Shell's second-level quick-settings menus (`QuickToggleMenu`), including their animation duration.
- A click anywhere else closes the row menu and does nothing else. Escape closes the whole menu.

## The top bar

- Set spacing between top-bar items, and between an icon and its value, through the containing box's `spacing` in `stylesheet.css`.
- Use actor layout for icon and text alignment. Measure text widths only for "Steady widths".
- Top-bar icons have transparent borders removed while preserving their scale and aspect ratio. Menu icons keep GNOME's default sizing.
- Hiding icons leaves the spacing between top-bar items unchanged. There are no per-icon margins.
- Values and units share the same text baseline.

"Emphasize values" (`emphasize-values`, on by default) makes icons and units lighter and smaller than the numbers.

With "Steady widths", each top-bar value reserves enough space for its text and expands immediately if the text grows wider. If the text leaves some of that space unused for a minute, the next update shrinks it to the current text width. Turning the option off clears the reserved widths.

"Remember widths" restores each value's saved width after a restart. The same expansion and expiry rules apply. The minute is counted from startup, then from the last time the text filled its reserved width. Turning the option off prevents saved widths from being restored at the next start; current widths still follow "Steady widths".
