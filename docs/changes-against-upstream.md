# How this fork differs from upstream Vitals

[Documentation index](README.md)

## For users

1. **The pinned sensors in the top bar can be reordered by drag and drop.** Can be turned on/off in preferences. Addresses [#93](https://github.com/corecoding/Vitals/issues/93) "Reorder indicators".
2. **Values can be emphasized in the top bar to make them easier to read at a glance.** Can be turned on/off in preferences.
3. **The menu's categories can be reordered by drag and drop.** Can be turned on/off in preferences. Addresses [#451](https://github.com/corecoding/Vitals/issues/451) "Order Menu Components".
4. **Give sensors names you recognize and hide the ones you don't need.** You can also choose which sensor appears in each category header. Addresses [#83](https://github.com/corecoding/Vitals/issues/83) "Customize labels" and [#222](https://github.com/corecoding/Vitals/issues/222) "Hide unwanted sensors".
5. **Use threshold colours to spot readings that need attention.** Rules can cover a single sensor or a group, such as all temperatures in a category.
6. **Monitor several disks and network shares together.** Automatic monitoring of drives mounted by GNOME can be turned on/off in preferences. Addresses [#143](https://github.com/corecoding/Vitals/issues/143) "Multiple Storage Locations", [#455](https://github.com/corecoding/Vitals/issues/455) and [#503](https://github.com/corecoding/Vitals/issues/503).
7. **See your total network traffic without counting it again as it passes through a VPN or container.** Download and upload speeds can also be shown together. Addresses [#377](https://github.com/corecoding/Vitals/issues/377), [#319](https://github.com/corecoding/Vitals/issues/319) and [#198](https://github.com/corecoding/Vitals/issues/198).
8. **The memory breakdown shows what is used, what is free and what can be reclaimed.** These amounts add up to total memory, including after rounding. Extra details can be turned on/off in preferences.
9. **Monitor the batteries in your computer and accessories, along with UPS devices.** Each device is detected automatically and has its own readings. Related requests: [#263](https://github.com/corecoding/Vitals/issues/263) and [#540](https://github.com/corecoding/Vitals/issues/540).
10. **Translations are available in 22 languages.** The new WiFi rating labels are currently in English.

### What is lost or worse

- **You'll need GNOME Shell 50 or 51.** The preferences sidebar and cropped icons use newer GNOME APIs.
- **Existing sensor settings don't carry over.** We identify sensors independently of their labels, so pins need to be set up again. See [Installation](../README.md#installation).
- **Identically named devices can get each other's settings if their discovery order changes.**
- **Newly shown rates can briefly display "…" while waiting for a second reading.**

## Development

- **We rewrote the collector, renderer and preferences.** Formatting and icon cropping have separate modules.
- **The catalog keeps sensors and user settings together.** Source state stays separate. See [catalog design](catalog-design.md).
- **Preferences use libadwaita and read the saved catalog.**
- **Polling follows the top bar and menu.** Only sources needed for shown sensors and aggregates are polled; discovery makes additional reads. This also stops `nvidia-smi` when it isn't needed. Related requests: [#275](https://github.com/corecoding/Vitals/issues/275) and [#442](https://github.com/corecoding/Vitals/issues/442).
- **Storage queries run asynchronously through GLib, without libgtop.** Related issue: [#421](https://github.com/corecoding/Vitals/issues/421).
- **Battery power rates use charging status to determine the sign.**
- **Thermal zones already covered by hwmon are excluded.**
- **Failed reads mark sensors unavailable.** Only the first failure in a sequence is logged, at debug level.
- **Shell shutdown saves settings and stops monitoring.** Pending read results are discarded.
- **GNOME's JavaScript linting rules.** See the [ESLint configuration](../tools/eslint.config.mjs).
- **Unit tests cover calculations; GNOME Shell tests cover the interface.**
