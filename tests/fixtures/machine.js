// Object.freeze is shallow: it locks only the object it is called on, and nested objects stay mutable.
// Every test in a file shares these fixtures, so they are frozen at every level.
function deepFreeze(fixture) {
    for (let part of Object.values(fixture)) {
        if (typeof part == 'object' && part !== null)
            deepFreeze(part);
    }
    return Object.freeze(fixture);
}

// The /sys and /proc of the machine every sensors test starts from: path to file content, as the kernel presents it.
// The devices, their names and their kernel numbers are those of a ThinkPad.
export const machine = deepFreeze({
    '/proc/stat': 'cpu 10 0 5 80 5 0 0 0\ncpu0 10 0 5 80 5 0 0 0\n',
    '/proc/cpuinfo': 'processor : 0\ncpu MHz : 2400\nvendor_id : TestVendor\ncache size : 1024 KB\n',
    '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 300 kB\nCached: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    '/proc/net/dev':
        'Inter-| Receive | Transmit\n' +
        ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n' +
        'lo: 10 0 0 0 0 0 0 0 10 0 0 0 0 0 0 0\n' +
        'eth0: 100 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n',
    '/proc/self/mountinfo': '20 1 8:1 / / rw - ext4 /dev/sda1 rw\n',
    '/proc/diskstats': '8 1 sda1 1 0 10 0 1 0 10 0 0 0 0\n',

    // A network card. The kernel gives an interface that is hardware a `device` entry; `lo` has none.
    // An interface's own uevent names its kind in DEVTYPE; a network card has no such line.
    '/sys/class/net/eth0/uevent': 'INTERFACE=eth0\nIFINDEX=2\n',
    '/sys/class/net/eth0/device/uevent': 'DRIVER=e1000e\n',

    '/sys/class/hwmon/hwmon3/name': 'coretemp\n',
    '/sys/class/hwmon/hwmon3/temp1_label': 'Package id 0\n',
    '/sys/class/hwmon/hwmon3/temp1_input': '70000\n',
    '/sys/class/hwmon/hwmon4/name': 'BAT0\n',
    '/sys/class/hwmon/hwmon4/in0_input': '7400\n',
    '/sys/class/hwmon/hwmon4/device/type': 'Battery\n',
    '/sys/class/power_supply/AC/type': 'Mains\n',
    '/sys/class/power_supply/BAT0/type': 'Battery\n',
    '/sys/class/power_supply/BAT0/uevent': 'DEVTYPE=power_supply\nPOWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\n' +
        'POWER_SUPPLY_STATUS=Not charging\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_TECHNOLOGY=Li-poly\n' +
        'POWER_SUPPLY_CYCLE_COUNT=767\nPOWER_SUPPLY_VOLTAGE_MIN_DESIGN=15440000\nPOWER_SUPPLY_VOLTAGE_NOW=17324000\n' +
        'POWER_SUPPLY_POWER_NOW=0\nPOWER_SUPPLY_ENERGY_FULL_DESIGN=57000000\nPOWER_SUPPLY_ENERGY_FULL=36420000\n' +
        'POWER_SUPPLY_ENERGY_NOW=35620000\nPOWER_SUPPLY_CAPACITY=98\nPOWER_SUPPLY_CAPACITY_LEVEL=Normal\n',
    '/sys/class/power_supply/ucsi-source-psy-USBC000:001/type': 'USB\n',
    '/sys/class/hwmon/hwmon5/name': 'thinkpad\n',
    '/sys/class/hwmon/hwmon5/temp1_label': 'CPU\n',
    '/sys/class/hwmon/hwmon5/temp1_input': '40000\n',
    '/sys/class/hwmon/hwmon5/temp2_label': 'GPU\n',
    '/sys/class/hwmon/hwmon5/temp2_input': '55000\n',
    '/sys/class/hwmon/hwmon5/in1_input': '1200\n',
    '/sys/class/hwmon/hwmon5/in2_input': '3300\n',
    '/sys/class/hwmon/hwmon5/fan1_input': '2400\n',
    // The kernel's hwmon view of thermal_zone9. In /sys/class/hwmon it is a link into the zone's directory.
    '/sys/class/hwmon/hwmon7/name': 'iwlwifi_1\n',
    '/sys/class/hwmon/hwmon7/temp1_input': '42000\n',
    '/sys/class/hwmon/hwmon8/name': 'ucsi_source_psy_USBC000:001\n',
    '/sys/class/hwmon/hwmon8/in0_input': '20000\n',
    '/sys/class/hwmon/hwmon8/device/type': 'USB\n',

    // Intel's thermal policy switch: a zone that is not a sensor and reports a dummy temperature.
    '/sys/class/thermal/thermal_zone1/type': 'INT3400 Thermal\n',
    '/sys/class/thermal/thermal_zone1/temp': '20000\n',
    '/sys/class/thermal/thermal_zone2/type': 'SEN1\n',
    '/sys/class/thermal/thermal_zone2/temp': '50000\n',
    '/sys/class/thermal/thermal_zone6/type': 'TCPU\n',
    '/sys/class/thermal/thermal_zone6/temp': '60000\n',
    // The CPU package temperature, which the coretemp hwmon device above reports as well.
    '/sys/class/thermal/thermal_zone8/type': 'x86_pkg_temp\n',
    '/sys/class/thermal/thermal_zone8/temp': '70000\n',
    // A zone the kernel also publishes through hwmon, as hwmon7 inside the zone.
    '/sys/class/thermal/thermal_zone9/type': 'iwlwifi_1\n',
    '/sys/class/thermal/thermal_zone9/temp': '42000\n',
    '/sys/class/thermal/thermal_zone9/hwmon7/name': 'iwlwifi_1\n',
    '/sys/class/thermal/thermal_zone9/hwmon7/temp1_input': '42000\n',

    '/sys/class/drm/version': 'drm 1.1.0 20060810\n',
    '/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw': '45000000\n',
    '/sys/devices/platform/thinkpad_acpi/dytc_lapmode': '1\n'
});

// The sizes in bytes that Gio reports for the filesystem mounted at each path. This is not a file in /sys or /proc:
// Gio gets it from the statfs system call. `free` is what users may still write; unused space beyond it is reserved.
export const filesystems = deepFreeze({
    '/': {'filesystem::size': 1000000, 'filesystem::free': 300000, 'filesystem::used': 600000}
});

// The root filesystem on a device-mapper volume.
export const mappedRootMounts = deepFreeze({
    '/proc/self/mountinfo': '20 1 254:1 / / rw - ext4 /dev/mapper/system-root rw\n'
});

// A mapped root plus a USB drive mounted at a path that contains a space, which mountinfo escapes as \040.
export const usbDriveMounts = deepFreeze({
    '/proc/self/mountinfo':
        '20 1 254:1 / / rw shared:1 - ext4 /dev/mapper/system-root rw\n' +
        '21 20 8:1 / /media/USB\\040drive rw shared:2 - ext4 /dev/sda1 rw\n'
});
