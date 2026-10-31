// Object.freeze is shallow: it locks only the object it is called on, and nested objects stay mutable.
// Every test in a file shares these fixtures, so they are frozen at every level.
function deepFreeze(fixture) {
    for (let part of Object.values(fixture)) {
        if (typeof part == 'object' && part !== null)
            deepFreeze(part);
    }
    return Object.freeze(fixture);
}

// How long the machine has been running when a test builds it.
const BOOTED_SECONDS = 5000;

// A line of /proc/stat for `cores` cores together: ticks of 1/100 s in user, nice, system, idle, iowait, irq,
// softirq, steal, guest and guest_nice. A core is busy 30 % of the time.
function cpuLine(name, cores, seconds) {
    let ticks = share => Math.round(share * 100 * cores * (BOOTED_SECONDS + seconds));
    return [name, ticks(0.25), 0, ticks(0.05), ticks(0.69), ticks(0.01), 0, 0, 0, 0, 0].join(' ') + '\n';
}

// A line of /proc/net/dev for an interface that receives and sends so many bytes per second.
function interfaceLine(name, received, sent, seconds) {
    let bytes = rate => Math.round(rate * (BOOTED_SECONDS + seconds));
    return name + ': ' + [bytes(received), 0, 0, 0, 0, 0, 0, 0, bytes(sent), 0, 0, 0, 0, 0, 0, 0].join(' ') + '\n';
}

// A line of /proc/diskstats for a block device that reads and writes so many bytes per second, in sectors of 512 bytes:
// its numbers, its name, and the 17 counters of reads, writes, the time spent, discards and flushes.
function diskLine(major, minor, name, read, written, seconds) {
    let sectors = rate => Math.round(rate * (BOOTED_SECONDS + seconds) / 512);
    return [major, minor, name, 1000, 0, sectors(read), 0, 1000, 0, sectors(written), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        .join(' ') + '\n';
}

// The machine every test starts from, in groups of files that come and go together: `system` is always there, the
// others are plugged in by a test. A file is its path, or the address of a public IP service, and its content as
// the kernel or the service presents it. A content that changes over time is a function of the seconds since the
// test built the machine. Where several plugged groups have the same file, such as /proc/net/dev, their contents
// follow each other in it. The devices, their names and their kernel numbers are those of a ThinkPad.
export const devices = deepFreeze({
    system: {
        '/proc/stat': seconds => cpuLine('cpu', 2, seconds) + cpuLine('cpu0', 1, seconds) + cpuLine('cpu1', 1, seconds) +
            'intr 0\nctxt 0\nbtime 1760000000\nprocesses 9000\nprocs_running 2\nprocs_blocked 0\n',
        '/proc/uptime': seconds => (BOOTED_SECONDS + seconds).toFixed(2) + ' ' +
            (2 * 0.69 * (BOOTED_SECONDS + seconds)).toFixed(2) + '\n',
        '/proc/loadavg': '0.52 0.61 0.70 2/1234 56789\n',
        '/proc/sys/fs/file-nr': '9152\t0\t9223372036854775807\n',
        '/proc/version': 'Linux version 6.17.0-1-amd64 (debian-kernel@lists.debian.org) #1 SMP PREEMPT_DYNAMIC\n',
        '/proc/cpuinfo':
            'processor\t: 0\nvendor_id\t: GenuineIntel\ncpu MHz\t\t: 2400.000\ncache size\t: 12288 KB\n' +
            'physical id\t: 0\nbogomips\t: 5990.40\n\n' +
            'processor\t: 1\nvendor_id\t: GenuineIntel\ncpu MHz\t\t: 1800.000\ncache size\t: 12288 KB\n' +
            'physical id\t: 0\nbogomips\t: 5990.40\n',
        '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq': '2400000\n',
        '/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq': '1800000\n',
        '/proc/meminfo': 'MemTotal:       16245000 kB\nMemFree:         2405000 kB\nMemAvailable:    9120000 kB\n' +
            'Cached:          6200000 kB\nShmem:           1200000 kB\nBuffers:          230000 kB\nSReclaimable:     614000 kB\n' +
            'SwapTotal:       8388604 kB\nSwapFree:        8100000 kB\n',

        '/proc/net/dev': seconds =>
            'Inter-|   Receive                                                |  Transmit\n' +
            ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
            interfaceLine('lo', 2000, 2000, seconds) + interfaceLine('eth0', 50000, 10000, seconds) +
            interfaceLine('wlan0', 200000, 20000, seconds),
        // The kernel gives an interface that is hardware a `device` entry; `lo` has none. An interface's own uevent
        // names its kind in DEVTYPE; a network card has no such line.
        '/sys/class/net/lo/uevent': 'INTERFACE=lo\nIFINDEX=1\n',
        '/sys/class/net/eth0/uevent': 'INTERFACE=eth0\nIFINDEX=2\n',
        '/sys/class/net/eth0/device/uevent': 'DRIVER=e1000e\n',
        '/sys/class/net/wlan0/uevent': 'DEVTYPE=wlan\nINTERFACE=wlan0\nIFINDEX=3\n',
        '/sys/class/net/wlan0/device/uevent': 'DRIVER=iwlwifi\n',
        '/proc/net/wireless':
            'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n' +
            ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n' +
            'wlan0: 0000   56.  -54.  -256        0      0      0      0     44        0\n',

        // The root filesystem on a device-mapper volume on the NVMe disk.
        '/proc/self/mountinfo':
            '22 1 254:1 / / rw,relatime shared:1 - ext4 /dev/mapper/system-root rw\n' +
            '23 22 0:22 / /proc rw,nosuid shared:13 - proc proc rw\n' +
            '90 22 7:3 / /snap/core/1 ro,nodev shared:40 - squashfs /dev/loop3 ro\n',
        '/proc/diskstats': seconds => diskLine(259, 0, 'nvme0n1', 400000, 300000, seconds) +
            diskLine(254, 1, 'dm-1', 400000, 300000, seconds),

        '/sys/class/hwmon/hwmon3/name': 'coretemp\n',
        '/sys/class/hwmon/hwmon3/temp1_label': 'Package id 0\n',
        '/sys/class/hwmon/hwmon3/temp1_input': '70000\n',
        '/sys/class/hwmon/hwmon4/name': 'BAT0\n',
        '/sys/class/hwmon/hwmon4/in0_input': '17324\n',
        '/sys/class/hwmon/hwmon4/device/type': 'Battery\n',
        '/sys/class/hwmon/hwmon5/name': 'thinkpad\n',
        '/sys/class/hwmon/hwmon5/temp1_label': 'CPU\n',
        '/sys/class/hwmon/hwmon5/temp1_input': '40000\n',
        '/sys/class/hwmon/hwmon5/temp2_label': 'GPU\n',
        '/sys/class/hwmon/hwmon5/temp2_input': '55000\n',
        '/sys/class/hwmon/hwmon5/in1_input': '1200\n',
        '/sys/class/hwmon/hwmon5/in2_input': '3300\n',
        '/sys/class/hwmon/hwmon5/fan1_input': '2400\n',
        '/sys/class/hwmon/hwmon6/name': 'nvme\n',
        '/sys/class/hwmon/hwmon6/temp1_label': 'Composite\n',
        '/sys/class/hwmon/hwmon6/temp1_input': '38850\n',
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

        '/sys/class/power_supply/AC/type': 'Mains\n',
        '/sys/class/power_supply/BAT0/type': 'Battery\n',
        '/sys/class/power_supply/BAT0/uevent': 'DEVTYPE=power_supply\nPOWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\n' +
            'POWER_SUPPLY_STATUS=Not charging\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_TECHNOLOGY=Li-poly\n' +
            'POWER_SUPPLY_CYCLE_COUNT=767\nPOWER_SUPPLY_VOLTAGE_MIN_DESIGN=15440000\nPOWER_SUPPLY_VOLTAGE_NOW=17324000\n' +
            'POWER_SUPPLY_POWER_NOW=0\nPOWER_SUPPLY_ENERGY_FULL_DESIGN=57000000\nPOWER_SUPPLY_ENERGY_FULL=36420000\n' +
            'POWER_SUPPLY_ENERGY_NOW=35620000\nPOWER_SUPPLY_CAPACITY=98\nPOWER_SUPPLY_CAPACITY_LEVEL=Normal\n',
        '/sys/class/power_supply/ucsi-source-psy-USBC000:001/type': 'USB\n',

        // The processor's graphics, and the connector of the built-in screen, which is no card.
        '/sys/class/drm/version': 'drm 1.1.0 20060810\n',
        '/sys/class/drm/card0/device/vendor': '0x8086\n',
        '/sys/class/drm/card0-eDP-1/status': 'connected\n',
        '/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw': '45000000\n',
        '/sys/devices/platform/thinkpad_acpi/dytc_lapmode': '1\n'
    },

    // The connection to the internet: the public IP services, which all answer the machine's address and country.
    internet: {
        'https://1.1.1.1/cdn-cgi/trace': 'fl=123f45\nh=1.1.1.1\nip=203.0.113.7\nts=1792229214.123\nvisit_scheme=https\n' +
            'uag=gvfs/1.58.0\ncolo=TXL\nsliver=none\nhttp=http/2\nloc=DE\ntls=TLSv1.3\nsni=off\nwarp=off\ngateway=off\n' +
            'rbi=off\nkex=X25519\n',
        'https://get.geojs.io/v1/ip/country.json': '{"country":"DE","country_3":"DEU","ip":"203.0.113.7","name":"Germany"}',
        'https://api.country.is/': '{"ip":"203.0.113.7","country":"DE"}'
    },

    // A second battery that powers the machine, discharging. Its driver gives it another name than BAT.
    secondBattery: {
        '/sys/class/power_supply/CMB1/type': 'Battery\n',
        '/sys/class/power_supply/CMB1/uevent': 'DEVTYPE=power_supply\nPOWER_SUPPLY_NAME=CMB1\nPOWER_SUPPLY_TYPE=Battery\n' +
            'POWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_TECHNOLOGY=Li-ion\n' +
            'POWER_SUPPLY_CYCLE_COUNT=120\nPOWER_SUPPLY_VOLTAGE_MIN_DESIGN=11400000\nPOWER_SUPPLY_VOLTAGE_NOW=12100000\n' +
            'POWER_SUPPLY_POWER_NOW=6500000\nPOWER_SUPPLY_ENERGY_FULL_DESIGN=24000000\nPOWER_SUPPLY_ENERGY_FULL=22000000\n' +
            'POWER_SUPPLY_ENERGY_NOW=11000000\nPOWER_SUPPLY_CAPACITY=50\nPOWER_SUPPLY_CAPACITY_LEVEL=Normal\n'
    },

    // A wireless mouse. Its battery powers the mouse, not the machine.
    mouse: {
        '/sys/class/power_supply/hidpp_battery_0/type': 'Battery\n',
        '/sys/class/power_supply/hidpp_battery_0/scope': 'Device\n',
        '/sys/class/power_supply/hidpp_battery_0/uevent': 'DEVTYPE=power_supply\nPOWER_SUPPLY_NAME=hidpp_battery_0\n' +
            'POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\nPOWER_SUPPLY_MODEL_NAME=MX Master 3\n' +
            'POWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_CAPACITY=60\n'
    },

    // A USB drive, mounted at a path with a space, which the mount table writes as \040.
    usbDrive: {
        '/proc/self/mountinfo': '61 22 8:1 / /media/USB\\040drive rw,nosuid shared:200 - ext4 /dev/sda1 rw\n',
        '/proc/diskstats': seconds => diskLine(8, 1, 'sda1', 30000, 10000, seconds)
    },

    // A share that is connected under its automount, and a second automount that waits to be used.
    share: {
        '/proc/self/mountinfo':
            '55 22 0:45 / /media/share rw shared:113 - autofs systemd-1 rw,fd=82,timeout=600\n' +
            '59 22 0:46 / /media/idle rw shared:117 - autofs systemd-1 rw,fd=84,timeout=600\n' +
            '431 55 0:104 / /media/share rw shared:631 - cifs //server/share rw,vers=3.1.1\n'
    },

    // A VPN connection: an interface that is not hardware.
    vpn: {
        '/proc/net/dev': seconds => interfaceLine('tun0', 10000, 5000, seconds),
        '/sys/class/net/tun0/uevent': 'DEVTYPE=tun\nINTERFACE=tun0\nIFINDEX=5\n'
    },

    // A second NVMe disk in an enclosure, with its temperature.
    secondNvme: {
        '/sys/class/hwmon/hwmon9/name': 'nvme\n',
        '/sys/class/hwmon/hwmon9/temp1_label': 'Composite\n',
        '/sys/class/hwmon/hwmon9/temp1_input': '35850\n'
    },

    // An AMD graphics card in an enclosure.
    amdGpu: {
        '/sys/class/drm/card1/device/vendor': '0x1002\n',
        '/sys/class/drm/card1/device/gpu_busy_percent': '12\n',
        '/sys/class/drm/card1/device/mem_info_vram_used': '536870912\n',
        '/sys/class/drm/card1/device/mem_info_vram_total': '8589934592\n'
    }
});

// The sizes in bytes that Gio reports for the filesystem mounted at each path. This is not a file in /sys or /proc:
// Gio gets it from the statfs system call. `free` is what users may still write; unused space beyond it is reserved.
export const filesystems = deepFreeze({
    '/': {'filesystem::size': 500000000000, 'filesystem::free': 150000000000, 'filesystem::used': 325000000000},
    '/media/USB drive': {'filesystem::size': 64000000000, 'filesystem::free': 60000000000, 'filesystem::used': 4000000000},
    '/media/share': {'filesystem::size': 8000000000000, 'filesystem::free': 5000000000000, 'filesystem::used': 3000000000000}
});
