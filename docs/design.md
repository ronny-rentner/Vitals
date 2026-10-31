# Design decisions

[Documentation index](../README.md#development) · [Development](development.md)

What Vitals does and why, outside the sensor catalog, which [catalog-design.md](catalog-design.md) describes. The terms are defined in [glossary.md](glossary.md).

## Where values come from

- Read sensors through files and system APIs rather than launching programs (decided on 2026-10-10). Vitals uses `nvidia-smi` for NVIDIA monitoring as the exception.
- Vitals reads procfs and sysfs asynchronously instead of using `libgtop` (decided on 2026-10-08). This avoids an extra dependency and synchronous libgtop calls on the Shell's main thread. Storage space comes from GLib (`query_filesystem_info_async`).
- For hardware and filesystem classification, reuse established rules from tools such as `df` or libgtop and cite the source in the code (decided on 2026-10-11). Observations on one machine do not justify a general rule. Where the user can decide instead, let the user decide.

## Memory

The first section shows Used, Reclaimable, Free, Available and Total. Used is `MemTotal - MemAvailable`; Reclaimable is `MemAvailable - MemFree`. Thus Free + Reclaimable = Available, and Used + Available = Total. The formatter uses the total's unit and subtracts rounded operands so these relationships hold at the displayed precision, while raw readings stay intact.

The Memory page's "Show details" switch (`memory-show-details`, off by default) adds a section after a divider: file cache (`Cached - Shmem`), shared memory and tmpfs (`Shmem`), kernel reclaimable cache (`SReclaimable`), buffers and usage percentage. Switching it off leaves pinned detail readings in the top bar. Swap follows in its own section with Used, Free, Total and Usage regardless of that switch. Existing sensor keys retain their pins and settings. These counters follow the [kernel's definitions](https://docs.kernel.org/filesystems/proc.html).

## Temperatures

Temperatures come from `/sys/class/hwmon` and `/sys/class/thermal`. A thermal zone is left out when it is not a sensor, when the kernel also publishes it through hwmon, or when an hwmon driver reports the same value; the lists are in `sensors.js`.

The user-facing behavior of “Skip sensors that read zero” is described under [Understanding the readings](../README.md#understanding-the-readings).

## Icons

- **Approval before adding variants.** Discuss proposed artwork with the user and obtain explicit approval before adding new variants to the extension. A request to investigate icons or improve readability does not authorise new variants. The CPU, GPU and drive temperature variants tried in October 2026 were rejected and reverted; do not restore them as accepted work.
- **One category base per style.** Adjust the category's existing artwork to distinguish readings, keeping the base recognisable. The established examples are the CPU with a waveform for frequency or a lightning bolt for power, and the drive with arrows for reads and writes. A Temperature variant must retain the thermometer as its main symbol; replacing it with a device icon and a thermometer badge breaks this rule.
- **Consistency within each set.** Classic and Adwaita have distinct artwork. Reuse each set's own shapes and visual language, including the same thermometer throughout that set. Do not invent a different thermometer for each variant or copy one set over the other.
- **Readability at the rendered size.** Both the base and its distinguishing detail must be recognisable in the actual panel. A 16×16 SVG canvas does not guarantee readability: the theme, font scaling and "Emphasize values" affect its displayed size. Enlarging the base while making the distinguishing mark smaller does not solve the problem. If both cannot remain legible, simplify the proposal or discuss sizing with the user before implementation.
- **Preserve proportions and GNOME rendering.** Cropping removes transparent borders while retaining the artwork's scale and aspect ratio; a rectangular image must not be stretched or padded back into a square in the cropped top-bar path. Keep GNOME's symbolic recolouring, theme overrides, shadows and stock layout apart from the intended sizing change. Cropping stays in `croppedIcon.js`, selected by the single `PanelIconType` switch; menu icons retain stock `St.Icon`. Keep spacing in the shared stylesheet rules, without per-icon compensation.
- **Verify the result the user sees.** Inspect both styles in the running Shell at actual panel size, with the active settings verified, including cropping and "Emphasize values". Check font/display scaling and light/dark appearance when affected. Enlarged artwork previews and passing code tests alone do not establish visual readability. Update documentation to reflect accepted decisions, never to legitimise a rejected implementation.

The icon-size slider was tried and removed at the user's request. Keep the existing size reduction under "Emphasize values".

## Storage

- The Storage category shows the storage locations the user chose (decided on 2026-10-11). A storage location is a mount point, not any path: the folder of a disk that is not plugged in lies on another disk, whose numbers would be shown under its name. At the start `/` is the only one.
- Monitored are the mount points in the setting `storage-locations`; one stays in it while nothing is mounted there. With `storage-monitor-volumes` (off by default), the mounts of `Gio.VolumeMonitor` are monitored too: GIO collects them from the volume monitor services of gvfs, of which `gvfs-udisks2-volume-monitor` reports the disks. The preferences call them "drives mounted by GNOME".
- A location is added by picking it from what is mounted now, not by typing. Offered first are those that libgtop counts as a disk or `df` as remote.
- What is mounted where comes from `/proc/self/mountinfo` (`parseMountTable`). An automount that waits to be used counts as nothing mounted, since asking it would connect it.
- The space of a location is asked from the kernel, once per location. The mount table is read first, because asking a path where nothing is mounted any more would connect an automounted share again. A location is not asked again while a question is out: a share whose server is gone can take minutes to answer.
- A network location is one that `df` counts as remote (`isRemoteMount`, using gnulib's `ME_REMOTE` rule). Its space is queried only while mounted, at the separate `storage-network-interval` in minutes.

## Network

- The network sensors follow `/proc/net/dev`: when a reading shows other interfaces than the catalog has, discovery of the network category follows at once. There are no placeholder rows for missing interfaces.
- Network totals count hardware interfaces only, avoiding duplicate counts across hardware and the virtual interfaces carrying the same traffic. An interface is hardware when the kernel gives it a `device` entry under `/sys/class/net/<name>/`.
- The network menu is in sections. `network-hardware-only` is a display setting, on by default: with it on, interfaces that are not hardware have no menu row.

## Batteries

Vitals discovers power supplies with `type` equal to `Battery`, including mouse and keyboard batteries, and UPS devices reported by UPower. Readings are grouped under their battery's name; a peripheral's model is used when available.

The kernel's `scope` equal to `Device` identifies a peripheral battery. It can report power consumption, but its power rate is excluded from the machine-battery total. With more than one machine battery, Vitals adds that total. UPS readings remain separate. The default category pin is the total when present, otherwise the first power-rate reading, otherwise a percentage. The user can choose another category pin.

## Categories

- Define each category's display name once, as `name` in `sensorCategories` (`helpers/categories.js`). The menu and preferences translate that name rather than deriving it from the key.
- The average, minimum and maximum of the temperatures and of the fans are a section of their own; `include-aggregates` only decides whether they have menu rows.

## Colour scales

Colour scales follow one rule (decided on 2026-10-10), `colorStyle` in `helpers/colors.js`: a category's scales colour that category's sensors, a scale is for one sensor or for all sensors of the category with the same kind of value, and which end is the bad one is a fact about the sensor (`lowIsBad`), not the user's choice.

## The menu

- **Use sections inside categories.** Experiments with nested sensor submenus, including CPU groups and Memory details, produced poor interactions. The Memory attempt closed its enclosing category and then failed the scrolling check. This is a lesson from trying the interaction, not merely a preference: use the existing dividers and headings instead of repeating nested sensor submenus. The actions opened from a sensor row are a separate interaction.
- The menu opens with its middle under the pointer, or under the middle of the top-bar item when opened from the keyboard or with the "Open centered under the sensors" option, and stays at that place while it is open.
- The menu has a fixed width; in a row that is too narrow the label is shortened, never the value.
- A category slides open with a slide of our own, never GNOME Shell's: the Shell only slides a submenu that needs no scrollbar, so long and short categories would behave differently. One category is open at a time, and it stays open while the menu is closed.
- Each level of the menu starts under the name of the level above it.
- A click on a row opens its row menu under the row and does nothing else: Pin to top bar, Pin to category, Rename, Hide. A row's marks only show the state.
- The row menu follows the second-level menus of GNOME Shell's quick settings (`QuickToggleMenu`), decided on 2026-10-09 after a design of our own was not recognisable as belonging to its row. It slides as long as they do.
- A click anywhere else closes the row menu and does nothing else. Escape closes the whole menu, as in every menu of the Shell.

## The top bar

The rules for its look were decided on 2026-10-11. The values themselves are in `stylesheet.css`.

- Spacing between top-bar items, and between an icon and its value, is set by the containing box's `spacing` in the stylesheet. The Shell theme's status-icon margin and padding are removed so they do not add to those gaps.
- Do not measure glyph bounds to position icons, values or units; earlier attempts gave uneven spacing. Measuring text width for "Steady widths" serves a different purpose: reserving room as readings change.
- With `crop-icons` on (on by default), top-bar icons crop transparent borders from the loaded image, preserving its scale and aspect ratio. The crop is cached per loaded image; GNOME handles loading, recolouring, shadows and layout. Menu icons keep GNOME's default sizing.
- Hiding icons leaves the spacing between top-bar items unchanged. There are no per-icon margins.
- A class of the Shell is not put on something for a side effect; the battery's class `power-status` on every sensor was such a case.
- A top-bar value and its unit are separate labels, vertically centred by the Shell's box layout. The unit keeps the formatter's leading space, scaled with its font by the "emphasize values" option.
- The stylesheet does not set `tnum`: the Shell's theme sets it on the whole top bar.

The `emphasize-values` option (on by default) is the part of the look that is a matter of taste: icons and units lighter and smaller than the numbers.

With "Steady widths", a top-bar value reserves the width it needs and expands immediately for wider text. Once the text has not filled that room for a minute, the next update shrinks it to the current text. Turning the option off clears the reserved widths.

"Remember widths" restores each value's saved width after restart. The same expansion and expiry rules apply, with the minute counted from startup until the text fills the room again. Turning it off prevents saved widths from being restored at the next start; current widths still follow "Steady widths".
