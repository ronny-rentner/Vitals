# The sensor key format

[Documentation index](../README.md#development) · [Sensor catalog](catalog-design.md) · [Glossary](glossary.md)

A key identifies a sensor within its category in the [sensor catalog](catalog-design.md). It is independent of the displayed label and its translation. Settings saved by earlier implementations are not migrated.

## Where a key is used

- **During discovery.** At launch and on rediscovery, `_registerSensor` matches the sensor with the same key in its category. Pins and custom labels belong to that sensor and survive the match. See [Saved pins](catalog-design.md#saved-pins).
- **In the colour settings.** A threshold colour for one sensor targets `sensor:<category>/<key>`, for example `sensor:temperature/thinkpad/temp1`. A scale for a category's value format targets `kind:<format>`, such as `kind:temp`.
- **For default category pins.** The collector uses keys such as `usage` and `average` to choose the category header's reading when the user has not selected one.

Keys are built from device names and source fields rather than translated labels. They do not always identify the same physical device when names repeat or a mount point is reused. See [Device identity limits](#device-identity-limits).

## The format

| Category | Sensor | Key | Read from, on a ThinkPad |
|---|---|---|---|
| temperature | hwmon temperature input | `thinkpad/temp1` | `/sys/class/hwmon/hwmon5/temp1_input` |
| temperature | ACPI zone, shown as "ACPI Thermal Zone" | `acpitz/temp1` | `/sys/class/hwmon/hwmon0/temp1_input` |
| temperature | CPU package, shown as "Processor 0" | `coretemp/temp1` | `/sys/class/hwmon/hwmon3/temp1_input` |
| temperature | thermal zone of type `SEN1` | `thermal/SEN1` | `/sys/class/thermal/thermal_zone2/temp` |
| temperature | an NVIDIA card's temperature | `<card name>/temperature.gpu` | `nvidia-smi` |
| temperature, fan | over all sensors of the category | `average`, `minimum`, `maximum` | computed |
| voltage | battery voltage | `BAT0/in0` | `/sys/class/hwmon/hwmon4/in0_input` |
| fan | fan | `thinkpad/fan1` | `/sys/class/hwmon/hwmon5/fan1_input` |
| power | hwmon power input | `BAT0/power1` | `/sys/class/hwmon/hwmon4/power1_input` |
| power | power draw of a powercap zone, with `use-powercap` | `powercap/package-0` | `/sys/class/powercap/intel-rapl:0/energy_uj`, where it can be read |
| network | download and upload rate of an interface | `eth0/rx`, `eth0/tx` | `/proc/net/dev`, the line for `eth0` |
| network | loopback bytes | `lo/tx` | `/proc/net/dev`, the line for `lo` |
| network | totals | `device-rx`, `boot-rx`, `session-rx`, the same with `tx`, `combined` | `/proc/net/dev` |
| processor | usage of one core, with `include-processor-cores` | `cpu8` | `/proc/stat`, the line for `cpu8` |
| processor | usage | `usage` | `/proc/stat` |
| memory | usage | `usage` | `/proc/meminfo` |
| storage | a value of a storage location | `//free`, `/boot/free`, `/media/share/read-rate` | the location, or `/proc/diskstats` |
| gpu | a value of an NVIDIA card | `<card name>/<nvidia-smi field>` | `nvidia-smi` |
| gpu | a value of another card | `<vendor id>/<file name>` | `/sys/class/drm/card0/device/` |
| battery | a value of a UPS that UPower knows | `ups/<serial number or model>/percentage` | UPower's device, over D-Bus |

Rules:

- **A device's sensor is `<device name>/<input>`.** The device name is the content of the hwmon directory's `name` file. Repeated names receive a numeric suffix starting with the second device: `nvme`, `nvme2`, `nvme3`. A thermal zone is `thermal/<content of its type file>`.
- **No directory numbers.** The kernel assigns numbers such as those in `hwmon5` or `thermal_zone2` in discovery order. They can change at the next boot.
- **Input numbers stay.** The driver fixes names such as `temp1`, `in0` and `fan1`. These numbers are the only way to distinguish unlabelled inputs.
- **The separator is `/`.** Discovery joins the device name and input with it. Category-wide keys such as `average` contain no separator.
- **A storage location's sensor is `<mount point>/<field>`.** The mount point is a path, so the key of `/` starts with two slashes. The field names the value in the `STORAGE_SPACE` or `DISKSTATS` definition.
- **Keys are unique within a category, not across categories.** Both `memory` and `processor` have a sensor keyed `usage`.
- **Case is kept.** `thermal/SEN1` and an interface called `WAN` keep their spelling.

Sensors that do not represent devices use the keys from their source definitions in `sensors.js`.

## Device identity limits

Discovery numbers repeated hwmon device names, NVIDIA model names, other GPU vendor IDs and UPS names from their second occurrence. Two NVMe drives therefore use `nvme/temp1` and `nvme2/temp1`. If discovery order changes, their keys can follow different physical devices, taking saved pins, labels and colors with them.

Storage keys follow the mount point. Replacing a drive mounted at the same path keeps the same sensor keys. There is no general persistent physical-device ID; the existing UPS keys use a serial number when UPower supplies one.
