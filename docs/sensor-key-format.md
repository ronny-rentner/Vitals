# The sensor key format

A key tells a sensor apart from the other sensors in its category. It is part of the sensor's entry in the catalog, which `docs/catalog-design.md` describes. This format was introduced on 2026-10-07 without a migration: panel sensors and per-sensor colours saved by earlier versions are not carried over.

## Where a key is used

- **At launch.** The saved catalog is loaded and discovery finds the sensors on the machine. Inside each category, a sensor that is found is matched to the saved sensor with the same key (`_unmatched` and `_found` in `sensors.js`). The saved links, in the panel and as a category's header, are turned into the sensors themselves (`_load`). After that the code holds the sensors and never looks one up by key.
- **In the colour settings.** A threshold colour for one sensor names it as `<category>/<key>`, for example `temperature/thinkpad/temp1`. That text is only compared with the sensor being drawn.

Because a key is saved, it has to come out the same on every start and in every language for the same sensor. So a key is built from what the kernel provides, never from the label shown in the menu.

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
| network | download and upload rate of an interface | `eth0/rx`, `eth0/tx` | `/proc/net/dev`, the line for `eth0` |
| network | loopback bytes | `lo/tx` | `/proc/net/dev`, the line for `lo` |
| network | totals | `device-rx`, `boot-rx`, `session-rx`, the same with `tx`, `combined` | `/proc/net/dev` |
| processor | usage of one core | `cpu8` | `/proc/stat`, the line for `cpu8` |
| processor | usage | `usage` | `/proc/stat` |
| memory | usage | `usage` | `/proc/meminfo` |
| gpu | a value of an NVIDIA card | `<card name>/<nvidia-smi field>` | `nvidia-smi` |
| gpu | a value of another card | `<vendor id>/<file name>` | `/sys/class/drm/card0/device/` |

Rules:

- **A device's sensor is `<device name>/<input>`.** The device name is the content of the hwmon directory's `name` file. A thermal zone is `thermal/<content of its type file>`.
- **No directory numbers.** The number in `hwmon5` or `thermal_zone2` is given by the kernel in the order it finds devices and can differ at the next boot.
- **Input numbers stay.** `temp1`, `in0` and `fan1` are fixed by the driver, and they are the only thing that tells unlabelled inputs apart.
- **The separator is `/`,** because it cannot occur in a device, zone or interface name. A sensor that is not part of a device has a key without one, so `average` can never be the key of a device's sensor.
- **A key is unique at most within its category.** `usage` is a sensor in `memory` and another one in `processor`.
- **Case is kept.** `thermal/SEN1` and an interface called `WAN` keep their spelling.

The keys of the sensors that are not devices are the keys of the `FIXED` table in `sensors.js`.

## Sensors with the same key

Two devices with the same name give two sensors with the same key in one category: two NVMe drives are both `nvme/temp1`. That is allowed. Each sensor has its own `file`, and discovery gives each device one saved sensor, in the order in which it finds them. What follows from it is described in `docs/catalog-design.md` under "Sensors with the same key" and "Links on disk".
