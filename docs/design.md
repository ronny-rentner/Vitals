# Design decisions

[Documentation index](../README.md#development) · [Development](development.md)

This document explains Vitals' behavior and design decisions. [Sensor catalog](catalog-design.md) covers the catalog, and the [glossary](glossary.md) defines the terms.

## Where values come from

- Read sensors through files and system APIs rather than launching programs (decided on 2026-10-10). NVIDIA monitoring is the exception: Vitals uses `nvidia-smi`.
- Vitals reads procfs and sysfs asynchronously instead of using `libgtop` (decided on 2026-10-08). This avoids an extra dependency and synchronous libgtop calls on the Shell's main thread. Storage space comes from GLib (`query_filesystem_info_async`).
- For hardware and filesystem classification, reuse established rules from tools such as `df` or libgtop and cite the source in the code (decided on 2026-10-11). Observations on one machine do not justify a general rule. Where the user can decide instead, let the user decide.

## Memory

The first section shows Used, Reclaimable, Free, Available and Total. Used is `MemTotal - MemAvailable`; Reclaimable is `MemAvailable - MemFree`. That gives Free + Reclaimable = Available, and Used + Available = Total. To keep the displayed numbers consistent, the formatter uses the total's unit and rounds the operands before subtracting them. The raw readings are unchanged.

The Memory page's "Show details" switch (`memory-show-details`, off by default) adds a section after a divider: file cache (`Cached - Shmem`), shared memory and tmpfs (`Shmem`), kernel reclaimable cache (`SReclaimable`), buffers and usage percentage. Switching it off leaves pinned sensors from that section in the top bar. Swap follows in its own section with Used, Free, Total and Usage regardless of that switch. Existing sensor keys retain their pins and settings. These counters follow the [kernel's definitions](https://docs.kernel.org/filesystems/proc.html).

## Temperatures

Temperatures come from `/sys/class/hwmon` and `/sys/class/thermal`. Vitals excludes a thermal zone if it is not a sensor, if the kernel also exposes it through hwmon, or if an hwmon driver reports the same value. The exclusion lists are in `sensors.js`.

[Understanding the readings](../README.md#understanding-the-readings) explains the "Skip sensors that read zero" option.

## Icons

- **Approval before adding variants.** Discuss proposed artwork with the user and obtain explicit approval before adding new variants to the extension. A request to investigate icons or improve readability does not authorise new variants. The CPU, GPU and drive temperature variants tried in October 2026 were rejected and reverted; do not restore them as accepted work.
- **One category base per style.** Adjust the category's existing artwork to distinguish readings, keeping the base recognisable. The established examples are the CPU with a waveform for frequency or a lightning bolt for power, and the drive with arrows for reads and writes. A Temperature variant must retain the thermometer as its main symbol; replacing it with a device icon and a thermometer badge breaks this rule.
- **Consistency within each set.** Classic and Adwaita have distinct artwork. Reuse each set's own shapes and visual language, including the same thermometer throughout that set. Do not invent a different thermometer for each variant or copy one set over the other.
- **Readability at the rendered size.** Both the base and its distinguishing detail must be recognisable in the actual panel. A 16×16 SVG canvas does not guarantee readability: the theme, font scaling and "Emphasize values" affect its displayed size. Enlarging the base while making the distinguishing mark smaller does not solve the problem. If both cannot remain legible, simplify the proposal or discuss sizing with the user before implementation.
- **Preserve proportions and GNOME rendering.** Cropping removes transparent borders while retaining the artwork's scale and aspect ratio. Do not stretch or pad a rectangular icon back into a square when using cropped top-bar icons. Preserve GNOME's symbolic recolouring, theme overrides, shadows and stock layout except for the intended size change. Keep cropping in `croppedIcon.js`, selected by the single `PanelIconType` switch. Menu icons must use stock `St.Icon`. Use shared stylesheet rules for spacing, without adjustments for individual icons.
- **Verify the result the user sees.** Inspect both styles in the running Shell at actual panel size. Confirm the active settings, including cropping and "Emphasize values". Check font and display scaling, and light and dark appearance, when the change affects them. Enlarged artwork previews and passing code tests do not prove that an icon is readable. Document accepted decisions; do not use documentation to legitimise a rejected implementation.

The icon-size slider was tried and removed at the user's request. Keep the existing size reduction under "Emphasize values".

## Storage

- The Storage category shows the locations the user chose (decided on 2026-10-11). Each location must be a mount point. If Vitals monitored an arbitrary folder after its disk was unplugged, it would show the containing disk's numbers under the missing disk's name. Only `/` is monitored initially.
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
- In each of the Temperature and Fan categories, the average, minimum and maximum share a separate section. The `include-aggregates` setting controls only whether those aggregates have menu rows.

## Colour scales

Each category has its own colour scales, applied by `colorStyle` in `helpers/colors.js` (decided on 2026-10-10). A scale targets one sensor or all sensors in that category with the same kind of value. The sensor's `lowIsBad` field determines whether thresholds apply towards lower or higher values; the user does not choose that direction.

## The menu

- **Use sections inside categories.** Nested sensor submenus were tried for CPU groups and Memory details and worked poorly. The Memory submenu closed its enclosing category and failed the scrolling check. Use the existing dividers and headings instead. This rule comes from those experiments. A sensor's row menu is a separate interaction for its actions.
- By default, clicking Vitals opens the menu centered under the pointer. With "Open centered under the sensors", it opens under the center of Vitals' combined top-bar items. Its position stays fixed while it is open.
- The menu has a fixed width. If a row does not fit, its label is shortened; its value stays complete.
- Vitals uses its own slide animation for categories because GNOME Shell only animates submenus that need no scrollbar. This keeps long and short categories consistent. Only one category can be open at a time, and it remains expanded when the menu closes.
- Each level of the menu starts under the name of the level above it.
- Clicking a row only opens the row menu beneath it, with Pin to top bar, Pin to category, Rename and Hide. The marks on the row indicate state; they do not perform actions.
- The row menu follows GNOME Shell's second-level quick-settings menus (`QuickToggleMenu`), including their animation duration. This was decided on 2026-10-09 after a custom design made it unclear which row the menu belonged to.
- A click anywhere else closes the row menu and does nothing else. Escape closes the whole menu, as in every menu of the Shell.

## The top bar

These appearance rules were decided on 2026-10-11. `stylesheet.css` contains the values.

- Spacing between top-bar items, and between an icon and its value, is set by the containing box's `spacing` in the stylesheet. The Shell theme's status-icon margin and padding are removed so they do not add to those gaps.
- Do not measure glyph bounds to position icons, values or units; earlier attempts gave uneven spacing. Measuring text width for "Steady widths" serves a different purpose: reserving room as readings change.
- `crop-icons` is on by default. It removes transparent borders from loaded top-bar icons while preserving their scale and aspect ratio. Each loaded image's crop is cached. GNOME handles loading, recolouring, shadows and layout, and menu icons keep GNOME's default sizing.
- Hiding icons leaves the spacing between top-bar items unchanged. There are no per-icon margins.
- Use Shell classes for their intended purpose. Applying the battery's `power-status` class to every sensor for its styling was a misuse.
- A top-bar value and its unit are separate labels, vertically centred by the Shell's box layout. The unit keeps the formatter's leading space, scaled with its font by the "emphasize values" option.
- The stylesheet does not set `tnum`: the Shell's theme sets it on the whole top bar.

"Emphasize values" (`emphasize-values`, on by default) makes icons and units lighter and smaller than the numbers. Users can switch it off to suit their preference.

With "Steady widths", each top-bar value reserves enough space for its text and expands immediately if the text grows wider. If the text leaves some of that space unused for a minute, the next update shrinks it to the current text width. Turning the option off clears the reserved widths.

"Remember widths" restores each value's saved width after a restart. The same expansion and expiry rules apply. The minute is counted from startup, then from the last time the text filled its reserved width. Turning the option off prevents saved widths from being restored at the next start; current widths still follow "Steady widths".
