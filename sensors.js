/*
  Copyright (c) 2018, Chris Monahan <chris@corecoding.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the GNOME nor the names of its contributors may be
      used to endorse or promote products derived from this software without
      specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
  ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as SensorMath from './helpers/sensorMath.js';
import {sensorCategories} from './helpers/categories.js';
import {readCatalog, readCatalogSettings, writeCatalog, sensorPresent} from './helpers/storedCatalog.js';

// A rate needs two readings, and the next tick can be a minute away.
const SECOND_READING_SECONDS = 1;

// Not voltage: an average over a battery, the system and a USB supply means nothing.
const AGGREGATED = {temperature: 'temp', fan: 'fan'};
const AGGREGATES = {
    'total-power-rate': SensorMath.sum,
    average: SensorMath.average,
    // Infinite without sensors, which makes the aggregate unavailable.
    minimum(sensors) {
        let minimum = Infinity;
        for (let sensor of sensors)
            minimum = Math.min(minimum, sensor.value);
        return minimum;
    },
    maximum(sensors) {
        let maximum = -Infinity;
        for (let sensor of sensors)
            maximum = Math.max(maximum, sensor.value);
        return maximum;
    }
};

const LOW_IS_BAD = {lowIsBad: true};

// A source's definition: its `id`, which is the path of the file it reads or a name, and its sensors, each with its
// catalog fields and `compute`, which computes its value from a reading. Every function of a definition gets one
// context object: the `collector`, the `source`, which holds the source's reading and the state the functions keep,
// and, for a sensor's `compute` and the definition's `icon`, the `sensor` and the `reading`. A source that reads one file takes it apart with `parse`, which gets the `text`;
// without `parse`, the file is one number. Any other source has `read`.
const MEMORY = {
    id: '/proc/meminfo',
    category: 'memory',
    parse: ({text}) => SensorMath.parseMemory(text),
    sensors: {
        'physical': {label: 'Physical', format: 'memory', compute: ({reading}) => reading.value.MemTotal},
        'available': {label: 'Available', format: 'memory', ...LOW_IS_BAD, compute: ({reading}) => reading.value.MemAvailable},
        'cached': {label: 'Cached', format: 'memory', compute: ({reading}) => reading.value.Cached},
        'free': {label: 'Free', format: 'memory', ...LOW_IS_BAD, compute: ({reading}) => reading.value.MemFree},
        'swap-total': {label: 'Swap Total', format: 'memory', compute: ({reading}) => reading.value.SwapTotal},
        'swap-free': {label: 'Swap Free', format: 'memory', ...LOW_IS_BAD, compute: ({reading}) => reading.value.SwapFree},
        'allocated': {
            label: 'Allocated',
            format: 'memory',
            compute: ({reading}) => reading.value.MemTotal - reading.value.MemAvailable
        },
        'usage': {
            label: 'Usage',
            format: 'percent',
            compute: ({reading}) => (reading.value.MemTotal - reading.value.MemAvailable) / reading.value.MemTotal
        },
        'swap-used': {
            label: 'Swap Used',
            format: 'memory',
            compute: ({reading}) => reading.value.SwapTotal - reading.value.SwapFree
        },
        'swap-usage': {
            label: 'Swap Usage',
            format: 'percent',
            compute: ({reading}) => reading.value.SwapTotal ? (reading.value.SwapTotal - reading.value.SwapFree) / reading.value.SwapTotal : 0
        }
    }
};

// Discovery adds a sensor per core, with the same `compute`.
const CPU_STAT = {
    id: '/proc/stat',
    category: 'processor',
    parse: ({text}) => SensorMath.parseCpuStat(text),
    sensors: {
        // `core` is "cpu" for the whole processor, as /proc/stat names it.
        'usage': {
            label: 'Usage',
            format: 'percent',
            core: 'cpu',
            compute: ({reading, sensor}) => SensorMath.cpuUsage(reading, sensor.core)
        }
    }
};

// What the processor says about itself, with `include-static-info` on. The fields are those of the first processor's
// entry, except the frequencies of all cores in hertz and the sockets, which every processor names in `physical id`.
const CPU_INFO = {
    id: '/proc/cpuinfo',
    category: 'processor',
    parse({text}) {
        let cpuInfo = {frequencies: [], sockets: new Set()};
        for (let line of text.split('\n')) {
            let colon = line.indexOf(':');
            if (colon < 0) continue;
            let name = line.slice(0, colon).trim();
            let fieldValue = line.slice(colon + 1).trim();
            if (name == 'cpu MHz')
                cpuInfo.frequencies.push(Number(fieldValue) * 1000000);
            else if (name == 'physical id')
                cpuInfo.sockets.add(fieldValue);
            else
                cpuInfo[name] ??= fieldValue;
        }
        return cpuInfo;
    },
    sensors: {
        'vendor': {label: 'Vendor', format: 'string', compute: ({reading}) => reading.value.vendor_id},
        'bogomips': {label: 'Bogomips', format: 'string', compute: ({reading}) => reading.value.bogomips},
        'sockets': {label: 'Sockets', format: 'string', compute: ({reading}) => reading.value.sockets.size},
        // In KB.
        'cache': {label: 'Cache', format: 'memory', compute: ({reading}) => Number.parseFloat(reading.value['cache size']) * 1024}
    }
};

// The frequencies of the cores in hertz, from /proc/cpuinfo where it lists them (_discoverSystem). The same source as
// CPU_INFO.
const CPU_FREQUENCIES = {
    id: CPU_INFO.id,
    category: 'processor',
    parse: context => CPU_INFO.parse(context),
    sensors: {
        'frequency': {
            label: 'Frequency',
            format: 'hertz',
            icon: 'vitals-cpu-frequency-symbolic',
            compute: ({reading}) => reading.value.frequencies.reduce((sum, frequency) => sum + frequency, 0) / reading.value.frequencies.length
        },
        'min-frequency': {
            label: 'Min frequency',
            format: 'hertz',
            icon: 'vitals-cpu-frequency-symbolic',
            compute: ({reading}) => Math.min(...reading.value.frequencies)
        },
        'max-frequency': {
            label: 'Max frequency',
            format: 'hertz',
            icon: 'vitals-cpu-frequency-symbolic',
            compute: ({reading}) => Math.max(...reading.value.frequencies)
        }
    }
};

// "Linux version <release> ...", with `include-static-info` on.
const KERNEL = {
    id: '/proc/version',
    category: 'system',
    parse: ({text}) => text.split(' ')[2],
    sensors: {
        'kernel': {label: 'Kernel', format: 'string', compute: ({reading}) => reading.value}
    }
};

// The same sensors where /proc/cpuinfo lists no frequencies: read from one file per core, which gives kHz.
const CPU_CORE_FREQUENCIES = {
    id: 'cpu-frequencies',
    category: 'processor',
    read: async ({cancellation, collector}) => ({
        frequencies: await Promise.all(collector._cores().map(async core =>
            Number(await collector._read('/sys/devices/system/cpu/' + core + '/cpufreq/scaling_cur_freq', cancellation)) * 1000))
    }),
    sensors: CPU_FREQUENCIES.sensors
};

const UPTIME = {
    id: '/proc/uptime',
    category: 'system',
    parse: ({text}) => SensorMath.splitFields(text).map(Number),
    sensors: {
        // The time since boot minus one core's share of the idle time of all cores.
        'process-time': {
            category: 'processor',
            label: 'Process Time',
            format: 'uptime',
            compute: ({reading, collector}) => reading.value[0] - reading.value[1] / collector._cores().length
        },
        'uptime': {label: 'Uptime', format: 'uptime', compute: ({reading}) => reading.value[0]}
    }
};

const LOADAVG = {
    id: '/proc/loadavg',
    category: 'system',
    parse: ({text}) => SensorMath.splitFields(text),
    sensors: {
        'load-1m': {label: 'Load 1m', format: 'load', compute: ({reading}) => Number(reading.value[0])},
        'load-5m': {label: 'Load 5m', format: 'load', compute: ({reading}) => Number(reading.value[1])},
        'load-15m': {label: 'Load 15m', format: 'load', compute: ({reading}) => Number(reading.value[2])},
        // The fourth field is runnable/all threads, as "2/1234".
        'threads-active': {
            label: 'Threads Active',
            format: 'string',
            compute: ({reading}) => Number(reading.value[3].split('/')[0])
        },
        'threads-total': {
            label: 'Threads Total',
            format: 'string',
            compute: ({reading}) => Number(reading.value[3].split('/')[1])
        }
    }
};

const OPEN_FILES = {
    id: '/proc/sys/fs/file-nr',
    category: 'system',
    // parseInt takes the first of the file's three numbers, the allocated file handles.
    parse: ({text}) => Number.parseInt(text),
    sensors: {
        'open-files': {label: 'Open Files', format: 'string', compute: ({reading}) => reading.value}
    }
};

const POWERCAP = {
    id: '/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw',
    category: 'processor',
    sensors: {
        'powercap': {
            label: 'Powercap',
            format: 'watt-limit',
            icon: 'vitals-cpu-power-symbolic',
            // The file gives microwatts.
            compute: ({reading}) => reading.value / 1000000
        }
    }
};

// 1 while a ThinkPad senses that it lies on a lap.
const LAP_MODE = {
    id: '/sys/devices/platform/thinkpad_acpi/dytc_lapmode',
    category: 'system',
    sensors: {
        'lap-mode': {
            label: 'Lap mode',
            format: 'string',
            compute: ({reading, collector}) => collector._gettext(reading.value == 1 ? 'on' : 'off')
        }
    }
};

// The renderer orders the network rows by these sections.
const NETWORK_SECTION = {machineSpeed: 1, hardwareInterfaces: 2, volume: 3, other: 4, virtualInterfaces: 5};
const DIRECTION_ICONS = {rx: 'vitals-network-download-symbolic', tx: 'vitals-network-upload-symbolic'};
// By DEVTYPE; any other hardware interface is "Ethernet". "WiFi" is spelled as in the WIFI labels.
const HARDWARE_INTERFACE_KINDS = {wlan: 'WiFi', wwan: 'Mobile'};

// Over the hardware interfaces only: what a virtual interface carries also passes a hardware one, and would count twice.
// Discovery adds the sensors of each interface, with `interfaceRate` and `interfaceTransferred` as their `compute`.
const NETWORK = {
    id: '/proc/net/dev',
    category: 'network',
    async parse({text, source, collector}) {
        let interfaces = SensorMath.parseNetwork(text);
        // A counter lower than before started again from zero, as when its interface was created again.
        let last = source.reading?.value;
        let session = last ? {...last.session} : {rx: 0, tx: 0};
        let hardwareInterfaces = collector._hardwareInterfaces();
        for (let [name, counters] of interfaces) {
            let previous = last?.interfaces.get(name);
            if (hardwareInterfaces.has(name) && previous) {
                for (let direction of ['rx', 'tx']) {
                    session[direction] += counters[direction] >= previous[direction]
                        ? counters[direction] - previous[direction] : counters[direction];
                }
            }
        }
        let network = collector.catalog.network;
        let knownInterfaces = new Set();
        for (let sensor of network.sensors) {
            if (sensor.interface && sensorPresent(network, sensor))
                knownInterfaces.add(sensor.interface);
        }
        let interfacesChanged = interfaces.size != knownInterfaces.size;
        for (let name of interfaces.keys()) {
            if (!knownInterfaces.has(name))
                interfacesChanged = true;
        }
        // An interface that appeared or disappeared is taken into the catalog at once, not at the next discovery.
        if (interfacesChanged && !collector._discovery)
            await collector._rediscoverNetwork(interfaces);
        return {interfaces, session};
    },
    // The sum of the rates over the hardware interfaces in the sensor's direction, or in both for the total speed.
    speed({reading, sensor, collector}) {
        if (!reading.previous) return SensorMath.PENDING;
        let total = 0;
        for (let name of collector._hardwareInterfaces()) {
            for (let direction of sensor.direction ? [sensor.direction] : ['rx', 'tx']) {
                let speed = SensorMath.counterRate(reading, value => value.interfaces.get(name)?.[direction]);
                // An interface that came or went between the two readings, or whose counter restarted, has no rate and adds nothing.
                if (speed !== undefined && speed !== SensorMath.PENDING)
                    total += speed;
            }
        }
        return total;
    },
    // What the hardware interfaces transferred in the sensor's direction since boot.
    sinceBoot({reading, sensor, collector}) {
        let hardwareInterfaces = collector._hardwareInterfaces();
        let total = 0;
        for (let [name, counters] of reading.value.interfaces) {
            if (hardwareInterfaces.has(name))
                total += counters[sensor.direction];
        }
        return total;
    },
    // The rate of the sensor's interface in the sensor's direction.
    interfaceRate({reading, sensor}) {
        return SensorMath.counterRate(reading, value => value.interfaces.get(sensor.interface)?.[sensor.direction]);
    },
    // What the sensor's interface transferred in the sensor's direction since it came up.
    interfaceTransferred({reading, sensor}) {
        return reading.value.interfaces.get(sensor.interface)?.[sensor.direction];
    },
    sensors: {
        'device-rx': {
            label: 'Download speed',
            format: 'speed',
            direction: 'rx',
            icon: DIRECTION_ICONS.rx,
            section: NETWORK_SECTION.machineSpeed,
            compute: context => NETWORK.speed(context)
        },
        'boot-rx': {
            label: 'Downloaded since boot',
            format: 'storage',
            direction: 'rx',
            icon: DIRECTION_ICONS.rx,
            section: NETWORK_SECTION.volume,
            compute: context => NETWORK.sinceBoot(context)
        },
        'session-rx': {
            label: 'Downloaded this session',
            format: 'storage',
            direction: 'rx',
            icon: DIRECTION_ICONS.rx,
            section: NETWORK_SECTION.volume,
            compute: ({reading}) => reading.value.session.rx
        },
        'device-tx': {
            label: 'Upload speed',
            format: 'speed',
            direction: 'tx',
            icon: DIRECTION_ICONS.tx,
            section: NETWORK_SECTION.machineSpeed,
            compute: context => NETWORK.speed(context)
        },
        'boot-tx': {
            label: 'Uploaded since boot',
            format: 'storage',
            direction: 'tx',
            icon: DIRECTION_ICONS.tx,
            section: NETWORK_SECTION.volume,
            compute: context => NETWORK.sinceBoot(context)
        },
        'session-tx': {
            label: 'Uploaded this session',
            format: 'storage',
            direction: 'tx',
            icon: DIRECTION_ICONS.tx,
            section: NETWORK_SECTION.volume,
            compute: ({reading}) => reading.value.session.tx
        },
        'combined': {
            label: 'Total speed',
            format: 'speed',
            section: NETWORK_SECTION.machineSpeed,
            compute: context => NETWORK.speed(context)
        }
    }
};

// The values of the last interface the file lists.
const WIFI = {
    id: '/proc/net/wireless',
    category: 'network',
    // Two heading lines come first. /proc/net/wireless gives the link quality on a scale from 0 to 70.
    parse({text}) {
        let lines = text.split('\n');
        let lastLine = null;
        for (let index = 2; index < lines.length; index++) {
            if (lines[index].trim())
                lastLine = lines[index];
        }
        if (lastLine === null) return {};
        let fields = SensorMath.splitFields(lastLine);
        return {quality: Number(fields[2]) / 70, signal: Number(fields[3])};
    },
    // The icon of both sensors, by the link quality.
    icon({reading}) {
        let strength = reading.value.quality * 100;
        let step = strength < 20 ? 'none' : strength < 40 ? 'weak' : strength < 50 ? 'ok' : strength < 80 ? 'good' : 'excellent';
        return 'vitals-wifi-signal-' + step + '-symbolic';
    },
    // Recorded on every machine; without WiFi they are unavailable.
    sensors: {
        'wifi-link-quality': {
            label: 'WiFi Link Quality',
            format: 'percent',
            section: NETWORK_SECTION.hardwareInterfaces,
            ...LOW_IS_BAD,
            compute: ({reading}) => reading.value.quality
        },
        'wifi-signal-level': {
            label: 'WiFi Signal Level',
            format: 'string',
            section: NETWORK_SECTION.hardwareInterfaces,
            compute: ({reading}) => reading.value.signal
        }
    }
};

const PUBLIC_IP = {
    id: 'public-ip',
    category: 'network',
    // Asked in order until one answers within `timeoutSeconds`.
    services: [
        ['https://1.1.1.1/cdn-cgi/trace', text => ({ip: text.match(/^ip=(.*)$/m)[1], country: text.match(/^loc=(.*)$/m)[1]})],
        ['https://get.geojs.io/v1/ip/country.json', text => JSON.parse(text)],
        ['https://api.country.is/', text => JSON.parse(text)]
    ],
    timeoutSeconds: 3,
    async read({collector}) {
        for (let [url, parse] of PUBLIC_IP.services) {
            let cancellable = new Gio.Cancellable();
            let timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PUBLIC_IP.timeoutSeconds * 1000, () => {
                timeout = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            try {
                return parse(await collector._read(url, cancellable));
            } catch (error) {
                // The next service is asked.
                console.debug(url, error);
            } finally {
                if (timeout) GLib.Source.remove(timeout);
            }
        }
        throw new Error('No public IP service answered');
    },
    // After a failure, the next tick tries again.
    interval: ({source, collector}) => source.reading?.status == 'ready'
        ? collector._settings.get_int('network-public-ip-interval') * 60 : 0,
    // Without a country, or one without an icon, the category's icon.
    icon: ({reading}) => reading.value.country ? 'vitals-country-' + reading.value.country.toLowerCase() + '-symbolic' : undefined,
    sensors: {
        'public-ip': {label: 'Public IP', format: 'string', section: NETWORK_SECTION.other, compute: ({reading}) => reading.value.ip}
    }
};

const MOUNTS = '/proc/self/mountinfo';

// One source per storage location: discovery gives each its location as `id` and `network` for a network location.
const STORAGE_SPACE = {
    // A network location not mounted is looked for at every tick: that only reads the mount table.
    interval: ({source, collector}) => source.definition.network && source.mounted
        ? collector._settings.get_int('storage-network-interval') * 60 : 0,
    async read({source, collector}) {
        let location = source.id;
        // Querying a path where nothing is mounted would mount an automounted location again, or give the space of
        // the disk under the empty directory.
        source.mounted = (await STORAGE_SPACE.mountTable({collector})).has(location);
        if (!source.mounted)
            throw new Error('Nothing is mounted at ' + location);
        // A query on a network location whose server is gone can block for minutes and cannot be cancelled, so a read
        // waits for the one under way.
        source.query ??= new Promise((resolve, reject) => {
            Gio.File.new_for_path(location).query_filesystem_info_async(
                'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_DEFAULT, null,
                (file, result) => {
                    try {
                        let info = file.query_filesystem_info_finish(result);
                        resolve({
                            total: info.get_attribute_uint64('filesystem::size'),
                            free: info.get_attribute_uint64('filesystem::free'),
                            used: info.get_attribute_uint64('filesystem::used')
                        });
                    } catch (error) { reject(error); }
                });
        }).finally(() => { source.query = null; });
        return source.query;
    },
    // One read serves every storage location of a tick. Not cancellable, since it is shared.
    mountTable({collector}) {
        collector._mountTableRead ??= collector._read(MOUNTS, null).then(SensorMath.parseMountTable)
            .finally(() => { collector._mountTableRead = null; });
        return collector._mountTableRead;
    },
    sensors: {
        'total': {label: 'Total', format: 'storage', compute: ({reading}) => reading.value.total},
        'used': {label: 'Used', format: 'storage', compute: ({reading}) => reading.value.used},
        // With the space kept for root, as Free %; GIO's `free` leaves it out.
        'free': {label: 'Free', format: 'storage', ...LOW_IS_BAD, compute: ({reading}) => reading.value.total - reading.value.used},
        'reserved': {
            label: 'Reserved',
            format: 'storage',
            compute: ({reading}) => reading.value.total - reading.value.used - reading.value.free
        },
        'used-percent': {label: 'Used %', format: 'percent', compute: ({reading}) => reading.value.used / reading.value.total},
        'free-percent': {
            label: 'Free %',
            format: 'percent',
            ...LOW_IS_BAD,
            compute: ({reading}) => (reading.value.total - reading.value.used) / reading.value.total
        }
    }
};

const DISKSTATS = {
    id: '/proc/diskstats',
    // By major:minor, as the mount table names a device. Sectors are 512 bytes, whatever the device's.
    parse({text}) {
        let disks = new Map();
        for (let line of text.split('\n')) {
            let fields = SensorMath.splitFields(line);
            disks.set(fields[0] + ':' + fields[1], {read: Number(fields[5]) * 512, write: Number(fields[9]) * 512});
        }
        return disks;
    },
    sensors: {
        'read-total': {
            label: 'Read total',
            format: 'storage',
            icon: 'vitals-storage-read-symbolic',
            compute: ({reading, sensor}) => reading.value.get(sensor.device)?.read
        },
        'read-rate': {
            label: 'Read rate',
            format: 'storage-rate',
            icon: 'vitals-storage-read-symbolic',
            compute: ({reading, sensor}) => SensorMath.counterRate(reading, disks => disks.get(sensor.device)?.read)
        },
        'write-total': {
            label: 'Write total',
            format: 'storage',
            icon: 'vitals-storage-write-symbolic',
            compute: ({reading, sensor}) => reading.value.get(sensor.device)?.write
        },
        'write-rate': {
            label: 'Write rate',
            format: 'storage-rate',
            icon: 'vitals-storage-write-symbolic',
            compute: ({reading, sensor}) => SensorMath.counterRate(reading, disks => disks.get(sensor.device)?.write)
        }
    }
};

// The cache of ZFS.
const ARC = {
    id: '/proc/spl/kstat/zfs/arcstats',
    category: 'storage',
    // Lines are name, type, value; the heading lines become entries no sensor uses.
    parse({text}) {
        let statistics = {};
        for (let line of text.split('\n')) {
            let fields = SensorMath.splitFields(line);
            statistics[fields[0]] = Number(fields[2]);
        }
        return statistics;
    },
    sensors: {
        'arc-target': {label: 'ARC Target', format: 'storage', compute: ({reading}) => reading.value.c},
        'arc-maximum': {label: 'ARC Maximum', format: 'storage', compute: ({reading}) => reading.value.c_max},
        'arc-current': {label: 'ARC Current', format: 'storage', compute: ({reading}) => reading.value.size}
    }
};

// One source per battery: discovery gives each its uevent file as `id`.
const BATTERY = {
    parse: ({text}) => SensorMath.parseBattery(text),
    // parseBattery's fields, and the sensor each one becomes.
    fieldKeys: {
        state: 'state',
        cycles: 'cycles',
        voltage: 'voltage',
        level: 'level',
        percentage: 'percentage',
        power: 'power-rate',
        full: 'energy-full',
        design: 'energy-design',
        now: 'energy-now'
    },
    // Averaged over the last 10 readings in the current charging state, which the source keeps.
    timeLeft({reading, source}) {
        let value = SensorMath.batteryTime(reading.value);
        if (typeof value != 'number') return value;
        if (source.timesLeft?.state != reading.value.state)
            source.timesLeft = {state: reading.value.state, times: []};
        let times = source.timesLeft.times;
        // Every update of the sensors computes the value again from the same reading, which counts once.
        if (!times.length || times[times.length - 1].time != reading.time) {
            times.push({value, time: reading.time});
            if (times.length > 10) times.shift();
        }
        return SensorMath.average(times);
    },
    sensors: {
        'state': {label: 'State', format: 'string', compute: ({reading}) => reading.value.state},
        'cycles': {label: 'Cycles', format: 'string', compute: ({reading}) => reading.value.cycles},
        'voltage': {label: 'Voltage', format: 'in', compute: ({reading}) => reading.value.voltage},
        'level': {label: 'Level', format: 'string', compute: ({reading}) => reading.value.level},
        'percentage': {label: 'Percentage', format: 'percent', ...LOW_IS_BAD, compute: ({reading}) => reading.value.percentage},
        'power-rate': {label: 'Power Rate', format: 'watt', compute: ({reading}) => reading.value.power},
        'energy-full': {label: 'Energy (full)', format: 'watt-hour', compute: ({reading}) => reading.value.full},
        'energy-design': {label: 'Energy (design)', format: 'watt-hour', compute: ({reading}) => reading.value.design},
        'energy-now': {label: 'Energy (now)', format: 'watt-hour', ...LOW_IS_BAD, compute: ({reading}) => reading.value.now},
        'capacity': {
            label: 'Capacity',
            format: 'percent',
            ...LOW_IS_BAD,
            compute: ({reading}) => reading.value.full / reading.value.design
        },
        'time-left': {
            label: 'Time left',
            format: 'runtime',
            ...LOW_IS_BAD,
            compute: context => BATTERY.timeLeft(context)
        }
    }
};

// Read through one nvidia-smi process, which writes a line per card at every update interval. Discovery adds the
// sensors, with this definition's `compute` as theirs.
const NVIDIA = {
    id: 'nvidia',
    // Starts the process for the sensors that are read. A running process that asks for the same fields, cards and
    // interval keeps running.
    configure({sensors, source, collector}) {
        let requestedFields = new Set();
        let requestedUuids = new Set();
        for (let sensor of sensors) {
            if (!sensor.nvidia) continue;
            for (let field of sensor.field.split(','))
                requestedFields.add(field);
            requestedUuids.add(sensor.nvidia);
        }
        // `uuid` first: it tells which card a line is for.
        let fields = ['uuid', ...[...requestedFields].sort()];
        let uuids = [...requestedUuids].sort();
        let interval = collector._settings.get_int('update-time');
        let signature = [fields.join(','), uuids.join(','), interval].join(';');
        if (source.process && source.process.signature == signature && !source.process.error) return;
        collector._stopReading(NVIDIA.id);
        // The last process's reading can lack the new fields.
        if (source.reading)
            source.reading = {...source.reading, status: 'pending'};
        let process;
        try {
            process = Gio.Subprocess.new([
                'nvidia-smi',
                '--query-gpu=' + fields.join(','),
                '--id=' + uuids.join(','),
                '--format=csv,noheader,nounits',
                '-l', String(interval)
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (error) {
            source.process = {error};
            return;
        }
        let state = {
            process,
            signature,
            fields,
            uuids,
            cancellation: new Gio.Cancellable(),
            stream: new Gio.DataInputStream({base_stream: process.get_stdout_pipe()}),
            rows: new Map(),
            latest: null,
            waiter: null,
            error: null
        };
        source.process = state;
        let readLine = () => state.stream.read_line_async(GLib.PRIORITY_DEFAULT, state.cancellation, (stream, result) => {
            // The process was stopped while this line was read.
            if (source.process != state) {
                NVIDIA.closeStream({stream});
                return;
            }
            try {
                let [line] = stream.read_line_finish_utf8(result);
                if (line === null) throw new Error('nvidia-smi stopped producing readings');
                let parts = line.split(',');
                if (parts.length != fields.length) throw new Error('Incomplete nvidia-smi reading: ' + line);
                let row = {};
                for (let index = 0; index < fields.length; index++)
                    row[fields[index]] = parts[index].trim();
                state.rows.set(row.uuid, row);
                // One line per card makes a reading.
                if (state.rows.size == uuids.length) {
                    let value = {gpus: state.rows, time: clock()};
                    state.rows = new Map();
                    if (state.waiter) {
                        state.waiter.resolve(value);
                        state.waiter = null;
                    } else {
                        state.latest = value;
                    }
                }
                readLine();
            } catch (error) {
                state.error = error;
                if (state.waiter) {
                    state.waiter.reject(error);
                    state.waiter = null;
                }
            }
        });
        readLine();
    },
    // The latest reading, or the next one when none has come since the last read.
    read({source}) {
        let state = source.process;
        if (state.error) return Promise.reject(state.error);
        if (state.latest) {
            let value = state.latest;
            state.latest = null;
            return Promise.resolve(value);
        }
        return new Promise((resolve, reject) => { state.waiter = {resolve, reject}; });
    },
    stop({source}) {
        let state = source.process;
        if (!state) return;
        source.process = null;
        // A process that could not be started.
        if (!state.process) return;
        state.cancellation.cancel();
        state.process.force_exit();
        if (state.waiter) state.waiter.reject(new Error('GPU collection stopped'));
        // A read under way closes the stream itself; after an error, none is.
        if (state.error)
            NVIDIA.closeStream({stream: state.stream});
    },
    // Only for a stream without a pending read: GIO refuses to close one with a pending read.
    closeStream({stream}) {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            try { stream.close_finish(result); }
            catch (error) { console.error(NVIDIA.id, error); }
        });
    },
    // As old as nvidia-smi's lines, which can be older than the read that takes them.
    readingTime: ({value}) => value.time,
    // nvidia-smi gives percentages up to 100, memory in MiB and frequencies in MHz.
    scale: {'percent': 0.01, 'temp': 1, 'memory': 1048576, 'hertz': 1000000, 'watt-gpu': 1},
    // Two fields give a share of the first in the second, or a link speed as generation x width.
    compute({reading, sensor}) {
        let gpu = reading.value.gpus.get(sensor.nvidia);
        let [first, second] = sensor.field.split(',').map(field => Number(gpu?.[field]));
        if (sensor.format == 'pcie')
            return Number.isFinite(first) && Number.isFinite(second) ? first + 'x' + second : undefined;
        return second === undefined ? first * NVIDIA.scale[sensor.format] : first / second;
    }
};

// The frames the Shell draws per second. Shows a window that redraws all the time without visibly changing.
const FRAMES = {
    id: 'frames',
    category: 'gpu',
    // With several monitors, a frame counts once per monitor. The count is never reset, since counterRate takes a
    // smaller count for a restart.
    start({source}) {
        source.frames ??= 0;
        source.paintSignal = global.stage.connect('after-paint', () => source.frames++);
    },
    stop({source}) {
        global.stage.disconnect(source.paintSignal);
        source.paintSignal = 0;
    },
    read: ({source}) => source.frames,
    sensors: {
        'refresh-rate': {
            label: 'Screen Redraws',
            format: 'hertz',
            compute: ({reading}) => SensorMath.counterRate(reading, frames => frames)
        }
    }
};

// Seconds that only move forward, for the time between two readings.
function clock() {
    return GLib.get_monotonic_time() / 1000000;
}

// Seconds of calendar time, for the timestamps that are saved with the catalog.
function now() {
    return GLib.get_real_time() / 1000000;
}

// The collector: it finds the sensors, reads the shown ones and writes the catalog (docs/catalog-design.md).
export class Sensors {
    constructor(settings, gettext) {
        // By id: a file's path, a storage location's mount point, or a name.
        this.sources = new Map();
        // The sources that are read, each with the sensors it is read for (see _updateActiveSources).
        this.activeSources = new Map();
        // The categories with an aggregate on screen.
        this.aggregatedCategories = new Set();
        // Per category, the reads its aggregates wait for in the latest _readSources call; an older call leaves them to it.
        this.aggregateReads = new Map();
        this.destroyed = false;
        this.onCatalogChanged = () => {};
        this.onValuesChanged = () => {};
        this._settings = settings;
        this._gettext = gettext;
        // The promise of the discovery under way.
        this._discovery = null;
        // Cancelled only by destroy().
        this._discoveryCancellation = new Gio.Cancellable();
        // The programs discovery runs, which destroy() stops.
        this._commands = new Set();
        // The read of the mount table under way, which every storage location's read waits for (STORAGE_SPACE).
        this._mountTableRead = null;
        this.catalog = this._load();
        // The timestamp of the latest run; _startRun gives every run a later one.
        this._lastRun = Math.max(0, ...this.categories().map(([, category]) => category.discovered ?? 0));
    }

    // Reads the saved catalog. Category pins and the panel sensors' references are saved as keys and become the
    // sensors here.
    // Whether a category is switched on comes from the catalog settings.
    _load() {
        let saved = readCatalog(this._settings);
        let catalogSettings = readCatalogSettings(this._settings);
        let catalog = {};
        for (let name of Object.keys(sensorCategories)) {
            let {categoryPin, sensors = [], ...category} = saved[name];
            // A saved value is from an earlier session. `runtime` only means something while the extension runs.
            for (let sensor of sensors)
                Object.assign(sensor, {category: name, status: 'pending', runtime: {}});
            catalog[name] = {
                ...category,
                enabled: catalogSettings[name].enabled,
                runtime: {},
                sensors,
                categoryPin: sensors.find(sensor => sensor.key == categoryPin)
            };
        }
        // A remembered width is only used with steady widths.
        let rememberWidths = this._settings.get_boolean('fixed-widths') && this._settings.get_boolean('remember-widths');
        catalog.panel = {
            sensors: saved.panel.sensors.map(({category, key, visible, reservedWidth}) => {
                let sensors = catalog[category].sensors;
                let sensor = sensors.find(candidate => candidate.key == key);
                // A pinned sensor no run has found yet, such as a default pin, keeps its place; discovery fills it in by key.
                if (!sensor) {
                    sensor = {key, category, status: 'pending', runtime: {}};
                    sensors.push(sensor);
                }
                return {sensor, visible, reservedWidth: rememberWidths ? reservedWidth : undefined, runtime: {}};
            })
        };
        return catalog;
    }

    save() {
        let catalog = {};
        // Objects are left out: `runtime`, and `categoryPin` and `sensors`, which are written below.
        let plain = record => Object.fromEntries(Object.entries(record).filter(([, fieldValue]) => typeof fieldValue != 'object'));
        // `enabled` is saved in the catalog settings, by the preferences window. A sensor's `category` is the list
        // it is saved in.
        for (let [name, category] of this.categories())
            catalog[name] = {
                ...plain(category),
                enabled: undefined,
                categoryPin: category.categoryPin?.key,
                sensors: category.sensors.map(sensor => ({...plain(sensor), category: undefined}))
            };
        // A panel sensor's reference to its sensor is saved as that sensor's category and key.
        catalog.panel = {
            sensors: this.catalog.panel.sensors.map(({sensor, visible, reservedWidth}) =>
                ({category: sensor.category, key: sensor.key, visible, reservedWidth}))
        };
        writeCatalog(this._settings, catalog);
    }

    // Returns whether any switch changed.
    reloadEnabled() {
        let catalogSettings = readCatalogSettings(this._settings);
        let changed = false;
        for (let [name, category] of this.categories()) {
            if (category.enabled != catalogSettings[name].enabled) {
                category.enabled = catalogSettings[name].enabled;
                changed = true;
            }
        }
        return changed;
    }

    // Without the panel, whose panel sensors refer to the sensors of the other categories.
    categories() {
        let categories = [];
        for (let name of Object.keys(sensorCategories))
            categories.push([name, this.catalog[name]]);
        return categories;
    }

    hasPanelItem(panelSensor) {
        let category = this.catalog[panelSensor.sensor.category];
        return panelSensor.visible && category.enabled && sensorPresent(category, panelSensor.sensor);
    }

    // A first pin goes to the end; an unpinned sensor keeps its panel sensor, and with it its place.
    setPanelSensorVisible(sensor, visible) {
        let panelSensor = this.catalog.panel.sensors.find(candidate => candidate.sensor == sensor);
        if (panelSensor)
            panelSensor.visible = visible;
        else
            this.catalog.panel.sensors.push({sensor, visible, runtime: {}});
        this.save();
    }

    // An empty label gives the sensor its own label back.
    renameSensor(sensor, customLabel) {
        sensor.customLabel = customLabel || undefined;
        this.save();
        this.catalogChanged();
    }

    // A hidden sensor does not count in its category's aggregates either.
    setSensorHidden(sensor, hidden) {
        sensor.hidden = hidden || undefined;
        this.save();
        this.catalogChanged();
    }

    // Pin to category; without a sensor, the default pin applies again.
    pinToCategory(categoryName, sensor = null) {
        let category = this.catalog[categoryName];
        for (let candidate of category.sensors)
            candidate.pinnedToCategory = candidate == sensor || undefined;
        category.categoryPin = this._chooseCategoryPin(categoryName);
        this.save();
        this.catalogChanged();
    }

    setCategoryOrder(categoryNames) {
        for (let [position, name] of categoryNames.entries())
            this.catalog[name].position = position;
        this.save();
    }

    // Without `beforePanelSensor`, to the end.
    movePanelSensor(panelSensor, beforePanelSensor = null) {
        let panelSensors = this.catalog.panel.sensors;
        panelSensors.splice(panelSensors.indexOf(panelSensor), 1);
        panelSensors.splice(beforePanelSensor === null ? panelSensors.length : panelSensors.indexOf(beforePanelSensor), 0, panelSensor);
        this.save();
    }

    // Registers a definition's source the first time discovery registers one of its sensors, and returns it. A source
    // holds its definition, its reading and the state its definition's functions keep in it.
    _registerSource(definition) {
        if (!this.sources.has(definition.id))
            this.sources.set(definition.id, {id: definition.id, definition, pendingRead: null});
        return this.sources.get(definition.id);
    }

    // The source's own read, or its file, taken apart by its `parse`; without `parse`, the file is one number.
    async _readSource(source, cancellation) {
        let {definition} = source;
        if (definition.read)
            return definition.read({cancellation, source, collector: this});
        let text = await this._read(source.id, cancellation);
        return definition.parse ? definition.parse({text, source, collector: this}) : Number(text);
    }

    catalogChanged() {
        if (this.destroyed) return;
        this.onCatalogChanged();
        this._updateActiveSources();
        this.onValuesChanged(this._updateActiveSensors());
        this._readNewlyShown();
    }

    // The renderer calls this after it changed `runtime.shown`. What came on screen is read at once, and what left it
    // stops at once: the next tick can be a whole update interval away.
    shownChanged() {
        this._updateActiveSources();
        this._updateActiveSensors();
        this._readNewlyShown();
    }

    // Whether the sensor counts in its category's average, minimum and maximum.
    _countsInAggregates(category, sensor) {
        return sensorPresent(category, sensor) && !sensor.aggregate && !sensor.hidden;
    }

    _hardwareInterfaces() {
        let network = this.catalog.network;
        let hardwareInterfaces = new Set();
        for (let sensor of network.sensors) {
            if (sensor.hardware && sensorPresent(network, sensor))
                hardwareInterfaces.add(sensor.interface);
        }
        return hardwareInterfaces;
    }

    // As /proc/stat names them: "cpu0", "cpu1".
    _cores() {
        let processor = this.catalog.processor;
        let cores = [];
        for (let sensor of processor.sensors) {
            if (sensor.core && sensor.core != 'cpu' && sensorPresent(processor, sensor))
                cores.push(sensor.core);
        }
        return cores;
    }

    // Works out which sources are read: those of what is on screen, and of all sensors an aggregate on screen is
    // computed over.
    _updateActiveSources() {
        let activeSources = new Map();
        let aggregatedCategories = new Set();
        if (!this.destroyed) {
            for (let [name, category] of this.categories()) {
                let onScreen = sensor => (sensor.runtime.shown || (category.runtime.shown && sensor == category.categoryPin)) &&
                    sensorPresent(category, sensor);
                if (category.sensors.some(sensor => sensor.aggregate && onScreen(sensor)))
                    aggregatedCategories.add(name);
                for (let sensor of category.sensors) {
                    let aggregatedCategoriesSensor = aggregatedCategories.has(name) && sensorPresent(category, sensor) && !sensor.hidden;
                    if (!onScreen(sensor) && !aggregatedCategoriesSensor) continue;
                    // Aggregates, values discovery wrote and sensors no run of this session found have no source.
                    let id = sensor.runtime.source?.id;
                    if (id === undefined) continue;
                    if (!activeSources.has(id))
                        activeSources.set(id, []);
                    activeSources.get(id).push(sensor);
                }
            }
        }

        for (let id of this.activeSources.keys()) {
            if (!activeSources.has(id))
                this._stopReading(id);
        }
        for (let [id, sensors] of activeSources) {
            let source = this.sources.get(id);
            if (!this.activeSources.has(id)) {
                // A recent reading with a `previous` is kept for the next tick; any other is read again at once, since
                // the second reading a rate waits for was called off when the source stopped.
                let reading = source.reading;
                let fresh = reading?.status == 'ready' && reading.previous && clock() - reading.time < this._settings.get_int('update-time');
                if (reading && !fresh && !this._withinInterval(id))
                    source.reading = {...reading, status: 'pending'};
                source.definition.start?.({source, collector: this});
            }
            source.definition.configure?.({sensors, source, collector: this});
        }
        this.activeSources = activeSources;
        this.aggregatedCategories = aggregatedCategories;
    }

    // A pending reading never is, so that it is read again.
    _withinInterval(id) {
        let source = this.sources.get(id);
        let sample = source.reading;
        let interval = source.definition.interval?.({source, collector: this}) ?? 0;
        return sample !== undefined && sample.status != 'pending' && clock() - sample.time < interval;
    }

    _cancelRead(source) {
        if (source.pendingRead) {
            source.pendingRead.cancellation.cancel();
            source.pendingRead = null;
        }
    }

    _stopReading(id) {
        let source = this.sources.get(id);
        this._cancelRead(source);
        this._callOffSecondReading(source);
        source.definition.stop?.({source, collector: this});
    }

    // For the sensors a first reading left pending, such as rates.
    _scheduleSecondReading(id, source) {
        source.secondReading = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SECOND_READING_SECONDS * 1000, () => {
            source.secondReading = null;
            // Nothing is read during discovery, so the read waits for it to end, failed or not.
            let read = () => this._readSources(candidate => candidate == id);
            Promise.resolve(this._discovery).then(read, read);
            return GLib.SOURCE_REMOVE;
        });
    }

    _callOffSecondReading(source) {
        if (source.secondReading) {
            GLib.Source.remove(source.secondReading);
            source.secondReading = null;
        }
    }

    // A tick. `force`, for Refresh, reads every active source.
    async poll(force = false) {
        // A tick during discovery is skipped, not made up for later.
        if (this.destroyed || this._discovery) return;
        this._updateActiveSources();
        // A source waiting for its second reading is left to it, so that its rate spans that second.
        await this._readSources(id => force || (!this.sources.get(id).secondReading && !this._withinInterval(id)));
    }

    // Reads what came on screen without waiting for a tick: the sources without a reading or with a pending one.
    _readNewlyShown() {
        // discover() calls this when it ends.
        if (this._discovery) return;
        this._readSources(id => {
            let reading = this.sources.get(id).reading;
            return !reading || reading.status == 'pending';
        });
    }

    // Resolves when the reads, also those already under way, and the aggregates computed from them are done.
    async _readSources(due) {
        let reads = [];
        for (let id of this.activeSources.keys()) {
            let source = this.sources.get(id);
            if (source.pendingRead) {
                reads.push(source.pendingRead.promise);
                continue;
            }
            if (!due(id))
                continue;

            let pendingRead = {cancellation: new Gio.Cancellable()};
            source.pendingRead = pendingRead;
            // Started a microtask later, so that an exception read() throws at once becomes a failed read.
            pendingRead.promise = Promise.resolve().then(() => {
                if (source.pendingRead == pendingRead) return this._readSource(source, pendingRead.cancellation);
            }).then(value => {
                // A cancelled read is discarded.
                if (source.pendingRead != pendingRead || this.destroyed) return;
                let time = source.definition.readingTime?.({value, source, collector: this}) ?? clock();
                let last = source.reading;
                // A rate is never computed across a failure. Against a reading younger than half the update interval, as
                // when Refresh follows a tick, it would span a moment, so the reading before that one is taken.
                let tooYoung = last && time - last.time < this._settings.get_int('update-time') / 2;
                let previous = last?.status != 'ready' ? null
                    : tooYoung && last.previous ? last.previous : {value: last.value, time: last.time};
                source.reading = {value, time, status: 'ready', previous};
            }, error => {
                if (source.pendingRead != pendingRead || this.destroyed) return;
                let previous = source.reading;
                // A failed read is expected, not a fault, so only the first in a row is logged. The value stays: the
                // network's session totals continue from it.
                if (!previous || previous.status != 'unavailable')
                    console.debug(id, error);
                source.reading = {...previous, time: clock(), status: 'unavailable'};
            }).finally(() => {
                if (source.pendingRead != pendingRead || this.destroyed) return;
                source.pendingRead = null;
                let updated = new Set();
                this._updateSensors(id, updated);
                this.onValuesChanged(updated);
                let withoutValue = this.activeSources.get(id).some(sensor => sensor.status == 'pending');
                if (withoutValue && !source.reading.previous && !source.secondReading)
                    this._scheduleSecondReading(id, source);
            }).catch(error => {
                // A fault in handling the reading, not a failed read.
                console.error(id, error);
            });
            reads.push(pendingRead.promise);
        }
        // A category's aggregates are computed once, after all its reads.
        let summaries = [];
        for (let name of this.aggregatedCategories) {
            let categoryReads = [];
            for (let [id, sensors] of this.activeSources) {
                let promise = this.sources.get(id).pendingRead?.promise;
                if (promise && sensors.some(sensor => sensor.category == name))
                    categoryReads.push(promise);
            }
            if (!categoryReads.length) continue;
            this.aggregateReads.set(name, categoryReads);
            summaries.push(Promise.all(categoryReads).then(() => {
                // A later call that started newer reads computes them instead.
                if (this.aggregateReads.get(name) != categoryReads || this.destroyed || this._discovery ||
                    !this.aggregatedCategories.has(name))
                    return;
                let updated = new Set();
                this._updateAggregates(name, updated);
                this.onValuesChanged(updated);
            }));
        }
        await Promise.all(reads);
        await Promise.all(summaries);
    }

    // SensorMath.PENDING means no value yet, such as a rate after one reading; no number, as from a missing field, makes
    // the sensor unavailable.
    _assign(sensor, value) {
        if (value === SensorMath.PENDING) {
            sensor.status = 'pending';
        } else if (value === undefined || value === null || (typeof value == 'number' && !Number.isFinite(value))) {
            sensor.status = 'unavailable';
        } else {
            sensor.status = 'ready';
            sensor.value = value;
            sensor.updated = now();
        }
    }

    // Adds the sensors it updated to `updated`.
    _updateSensors(id, updated) {
        let source = this.sources.get(id);
        let reading = source.reading;
        for (let sensor of this.activeSources.get(id)) {
            if (reading?.status == 'ready') {
                let context = {reading, sensor, source, collector: this};
                this._assign(sensor, sensor.runtime.compute(context));
                if (sensor.runtime.icon)
                    sensor.icon = sensor.runtime.icon(context);
            } else {
                this._assign(sensor, reading?.status == 'unavailable' ? undefined : SensorMath.PENDING);
            }
            updated.add(sensor);
        }
    }

    // Adds the aggregates it updated to `updated`.
    _updateAggregates(name, updated) {
        let category = this.catalog[name];
        let readable = [];
        let aggregates = [];
        let pending = false;
        // The batteries' total is over their power rates. One unavailable sensor does not make the aggregates unavailable.
        for (let sensor of category.sensors) {
            if (sensor.aggregate && sensorPresent(category, sensor)) {
                aggregates.push(sensor);
            } else if (this._countsInAggregates(category, sensor) && sensor.status != 'unavailable' &&
                (name != 'battery' || sensor.field == 'power-rate')) {
                readable.push(sensor);
                if (sensor.status == 'pending')
                    pending = true;
            }
        }
        for (let sensor of aggregates) {
            this._assign(sensor, pending ? SensorMath.PENDING : AGGREGATES[sensor.key](readable));
            updated.add(sensor);
        }
    }

    // From the readings there are, without reading. A source whose read is under way is left to that read.
    _updateActiveSensors() {
        let updated = new Set();
        for (let id of this.activeSources.keys()) {
            if (!this.sources.get(id).pendingRead)
                this._updateSensors(id, updated);
        }
        for (let name of this.aggregatedCategories)
            this._updateAggregates(name, updated);
        return updated;
    }

    // A file, or the answer of an https address.
    async _read(fileLocation, cancellation) {
        let file = fileLocation.startsWith('https://') ? Gio.File.new_for_uri(fileLocation) : Gio.File.new_for_path(fileLocation);
        return new Promise((resolve, reject) => {
            file.load_contents_async(cancellation, (file, result) => {
                try {
                    resolve(new TextDecoder().decode(file.load_contents_finish(result)[1]).trim());
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    // Sorted, so that discovery finds devices in the same order every time.
    async _list(directoryPath, cancellation) {
        let file = Gio.File.new_for_path(directoryPath);
        let enumerator = await new Promise((resolve, reject) => {
            file.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellation, (file, result) => {
                    try { resolve(file.enumerate_children_finish(result)); }
                    catch (error) { reject(error); }
                });
        });
        let names = [];
        try {
            while (true) {
                let files = await new Promise((resolve, reject) => {
                    enumerator.next_files_async(128, GLib.PRIORITY_DEFAULT, cancellation, (enumerator, result) => {
                        try { resolve(enumerator.next_files_finish(result)); }
                        catch (error) { reject(error); }
                    });
                });
                if (!files.length) return names.sort();
                names.push(...files.map(file => file.get_name()));
            }
        } finally {
            // Not cancellable, so that it is closed also after destroy().
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (enumerator, result) => {
                try { enumerator.close_finish(result); }
                catch (error) { console.error(directoryPath, error); }
            });
        }
    }

    // null for a file that does not exist; any other error is thrown.
    async _optionalRead(filePath) {
        try {
            return await this._read(filePath, this._discoveryCancellation);
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
                error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY))
                return null;
            throw error;
        }
    }

    // Always later than the last run, even when two runs start in the same second or the clock was set back.
    _startRun() {
        this._lastRun = Math.max(Math.floor(now()), this._lastRun + 1);
        return this._lastRun;
    }

    // The catalog's sensor with this key that `run` has not registered yet: two devices can have the same key, such as
    // two NVMe drives, and each takes one sensor, in the order they are found.
    _unmatched(run, categoryName, key) {
        return this.catalog[categoryName].sensors.find(sensor => sensor.key == key && sensor.discovered != run);
    }

    // Registers a sensor for the run: the catalog's one with its key, or a new one at the end of the category. `fields`
    // are its catalog fields and its `compute`, as in a definition's `sensors`. A sensor of a `definition` is read from
    // the definition's source; one without, such as an aggregate, has no source.
    _registerSensor(run, categoryName, fields, definition) {
        let {compute, ...catalogFields} = fields;
        let sensor = this._unmatched(run, categoryName, catalogFields.key);
        if (!sensor) {
            sensor = {status: 'pending', runtime: {}};
            this.catalog[categoryName].sensors.push(sensor);
        }
        let source = definition && this._registerSource(definition);
        Object.assign(sensor.runtime, {source, compute, icon: definition?.icon});
        return Object.assign(sensor, catalogFields, {category: categoryName, discovered: run});
    }

    // Registers a sensor whose value discovery read once, such as a graphics card's driver version. It has no source.
    _registerConstant(run, categoryName, fields, value) {
        Object.assign(this._registerSensor(run, categoryName, fields), {value, status: 'ready', updated: now()});
    }

    // Registers every sensor of a definition, with `fields` added.
    _registerSensors(run, definition, fields = {}) {
        for (let [key, {category = definition.category, ...sensorFields}] of Object.entries(definition.sensors)) {
            this._registerSensor(run, category, {
                key,
                file: definition.id.startsWith('/') ? definition.id : undefined,
                ...sensorFields,
                ...fields
            }, definition);
        }
    }


    _sensorCount() {
        return this.categories().reduce((count, [, category]) => count + category.sensors.length, 0);
    }

    // Looks for the sensors on the machine and matches them with the catalog.
    async discover() {
        if (this._discovery) return this._discovery;
        // Nothing is read during a run: a sensor could still hold a path the kernel has given to another device. The
        // readings stay, and the next rate is computed against them.
        for (let id of this.activeSources.keys())
            this._cancelRead(this.sources.get(id));
        // What changes what discovery finds; a run during which it changed is repeated.
        let configuration = () => JSON.stringify([this.catalog.gpu.enabled, ...[
            'include-static-info',
            'include-static-gpu-info',
            'include-public-ip',
            'storage-locations',
            'storage-monitor-volumes',
            'hide-zeros'
        ].map(key => this._settings.get_value(key).deep_unpack())]);
        // A category is complete when every step that feeds it succeeded.
        let steps = [
            ['system', ['memory', 'processor', 'system'], run => this._discoverSystem(run)],
            ['hwmon', ['temperature', 'voltage', 'fan'], run => this._discoverHwmon(run)],
            ['network', ['network'], async run => {
                let interfaces = SensorMath.parseNetwork(await this._read(NETWORK.id, this._discoveryCancellation));
                this._discoverNetwork(run, interfaces, await this._findHardwareInterfaces(interfaces));
            }],
            ['storage', ['storage'], run => this._discoverStorage(run)],
            ['battery', ['battery'], run => this._discoverBattery(run)],
            ['gpu', ['gpu', 'temperature'], run => this._discoverGpu(run)]
        ];
        let sensorCountBefore = this._sensorCount();
        this._discovery = (async () => {
            let discoveredConfiguration;
            do {
                discoveredConfiguration = configuration();
                let run = this._startRun();
                let incomplete = new Set();
                await Promise.all(steps.map(async ([stepName, fedCategories, discover]) => {
                    try { await discover(run); }
                    catch (error) {
                        for (let name of fedCategories)
                            incomplete.add(name);
                        if (!this.destroyed) console.error('discover:' + stepName, error);
                    }
                }));
                if (this.destroyed) return;
                // From here on, a sensor of a complete category that the run did not find is no longer present.
                for (let [name, category] of this.categories()) {
                    if (!incomplete.has(name))
                        category.discovered = run;
                }
                this._discoverAggregates(run);
            } while (discoveredConfiguration != configuration());
            this._forget();
            for (let [name, category] of this.categories())
                category.categoryPin = this._chooseCategoryPin(name);
            if (this._sensorCount() != sensorCountBefore)
                this.save();
            this.catalogChanged();
        })().finally(() => {
            this._discovery = null;
            // What came on screen during discovery is read now.
            this._readNewlyShown();
        });
        return this._discovery;
    }

    // Drops the sensors no run has found for a year, except pinned ones, such as the interface of a past container.
    _forget() {
        let oldest = now() - 365 * 86400;
        let inPanel = new Set(this.catalog.panel.sensors.map(panelSensor => panelSensor.sensor));
        for (let [, category] of this.categories())
            category.sensors = category.sensors.filter(sensor => inPanel.has(sensor) || sensor.discovered >= oldest);
    }

    _chooseCategoryPin(categoryName) {
        let category = this.catalog[categoryName];
        let find = test => category.sensors.find(sensor => sensorPresent(category, sensor) && test(sensor));
        let withKey = key => find(sensor => sensor.key == key);
        let chosen = find(sensor => sensor.pinnedToCategory);
        if (chosen) return chosen;
        switch (categoryName) {
            case 'temperature':
            case 'fan':
                // Without an average, the category has fewer than two sensors.
                return withKey('average') ?? find(sensor => this._countsInAggregates(category, sensor));
            case 'voltage':
                // A battery's first, a USB supply's last (`priority`, from _discoverHwmon).
                return category.sensors.filter(sensor => this._countsInAggregates(category, sensor))
                    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))[0];
            case 'battery':
                // Without a total, a battery's power rate; a mouse's battery has none, only a percentage.
                return withKey('total-power-rate') ?? find(sensor => sensor.field == 'power-rate') ??
                    find(sensor => sensor.field == 'percentage');
            case 'storage':
                // The first location sorts first, which is "/" while "/" is monitored.
                return find(sensor => sensor.field == 'free' && sensor.section == 1);
            case 'gpu':
                return find(sensor => sensor.field == 'utilization.gpu') ??
                    find(sensor => sensor.file?.endsWith('/gpu_busy_percent')) ?? withKey('refresh-rate');
            default:
                return withKey({memory: 'usage', processor: 'usage', system: 'load-1m', network: 'device-rx'}[categoryName]);
        }
    }

    async _discoverSystem(run) {
        this._registerSensors(run, MEMORY);
        this._registerSensors(run, CPU_STAT);
        let cores = SensorMath.parseCpuStat(await this._read(CPU_STAT.id, this._discoveryCancellation));
        // `cpu` is the whole processor, CPU_STAT's own sensor.
        for (let core of cores.keys()) {
            if (core == 'cpu') continue;
            this._registerSensor(run, 'processor', {
                key: core,
                label: this._gettext('Core %d').replace('%d', core.slice(3)),
                format: 'percent',
                core,
                file: CPU_STAT.id,
                compute: CPU_STAT.sensors.usage.compute
            }, CPU_STAT);
        }
        let cpuInfo = await this._read(CPU_FREQUENCIES.id, this._discoveryCancellation);
        this._registerSensors(run, /^cpu MHz\s*:/m.test(cpuInfo) ? CPU_FREQUENCIES : CPU_CORE_FREQUENCIES);
        this._registerSensors(run, LOADAVG);
        this._registerSensors(run, OPEN_FILES);
        this._registerSensors(run, UPTIME);
        if (await this._optionalRead(POWERCAP.id) !== null)
            this._registerSensors(run, POWERCAP);
        if (await this._optionalRead(LAP_MODE.id) !== null)
            this._registerSensors(run, LAP_MODE);

        if (this._settings.get_boolean('include-static-info')) {
            this._registerSensors(run, CPU_INFO);
            this._registerSensors(run, KERNEL);
        }
    }

    // With `hide-zeros` on, a temperature is registered only once discovery reads something other than zero for it. A
    // present sensor keeps its first reading of the session, so it stays when it reads zero later.
    async _registerSensorWithHideZeros(run, categoryName, fields, definition, readInitialTemperature) {
        let initialTemperature;
        if (fields.format == 'temp' && this._settings.get_boolean('hide-zeros')) {
            let known = this._unmatched(run, categoryName, fields.key);
            if (known && sensorPresent(this.catalog[categoryName], known))
                initialTemperature = known.runtime.initialTemperature;
            if (initialTemperature === undefined)
                initialTemperature = await readInitialTemperature();
            if (!Number.isFinite(initialTemperature) || initialTemperature === 0) return false;
        }
        this._registerSensor(run, categoryName, fields, definition).runtime.initialTemperature = initialTemperature;
        return true;
    }

    // Temperatures, voltages and fans from /sys/class/hwmon, and the temperatures of the thermal zones hwmon lacks.
    async _discoverHwmon(run) {
        let readFile = sensorFile => async () => {
            try {
                return Number(await this._optionalRead(sensorFile));
            } catch (error) {
                // An unreadable temperature is left out like one that reads zero, instead of failing the step.
                if (!this.destroyed) console.debug(sensorFile, error);
                return NaN;
            }
        };
        let hwmonDeviceNames = new Set();
        let root = '/sys/class/hwmon/';
        for (let directory of await this._list(root, this._discoveryCancellation)) {
            let devicePath = root + directory;
            let deviceName = await this._optionalRead(devicePath + '/name');
            // Some drivers keep `name` and the inputs in `device`.
            if (deviceName === null) {
                devicePath += '/device';
                deviceName = await this._optionalRead(devicePath + '/name');
            }
            if (deviceName === null) continue;
            hwmonDeviceNames.add(deviceName);
            // coretemp's temp1 names the CPU package, such as "Package id 0".
            let labelPrefix = deviceName;
            if (deviceName == 'coretemp')
                labelPrefix = await this._optionalRead(devicePath + '/temp1_label') || deviceName;
            // drivetemp's only temperature belongs to a drive, which its model names apart from other drives.
            let driveModel = deviceName == 'drivetemp' ? await this._optionalRead(devicePath + '/device/model') : null;
            let files = await this._list(devicePath, this._discoveryCancellation);
            // For the voltage's default pin (_chooseCategoryPin): 0 for a battery's, 2 for a USB supply's.
            let priority = 1;
            if (files.some(file => /^in\d+_input$/.test(file))) {
                let powerSupplyType = await this._optionalRead(root + directory + '/device/type');
                if (powerSupplyType == 'Battery')
                    priority = 0;
                else if (powerSupplyType !== null && powerSupplyType.startsWith('USB'))
                    priority = 2;
            }
            for (let file of files) {
                let match = file.match(/^(temp|in|fan)(\d+)_input$/);
                if (!match) continue;
                // hwmon gives temperatures in millidegrees and voltages in millivolts.
                let [categoryName, divisor] = {temp: ['temperature', 1000], in: ['voltage', 1000], fan: ['fan', 1]}[match[1]];
                let input = match[1] + match[2];
                let rawLabel = await this._optionalRead(devicePath + '/' + input + '_label');
                if (rawLabel === null)
                    rawLabel = driveModel || labelPrefix + ' ' + input;
                else if (labelPrefix != rawLabel)
                    rawLabel = labelPrefix + ' ' + rawLabel;
                // For labels that only name the device and the input, or the CPU package.
                let names = {
                    'acpitz temp1': 'ACPI Thermal Zone',
                    'pch_cannonlake temp1': 'Platform Controller Hub',
                    'iwlwifi_1 temp1': 'Wireless Adapter',
                    'Package id 0': 'Processor 0',
                    'Package id 1': 'Processor 1'
                };
                let inputFile = devicePath + '/' + file;
                await this._registerSensorWithHideZeros(run, categoryName, {
                    // Not keyed by the hwmon directory, whose number can change at the next boot.
                    key: deviceName + '/' + input,
                    label: (names[rawLabel] || rawLabel).replace('Package id', 'CPU'),
                    format: match[1],
                    file: inputFile,
                    priority: categoryName == 'voltage' ? priority : undefined,
                    compute: ({reading}) => reading.value / divisor
                }, {id: inputFile}, readFile(inputFile));
            }
        }
        root = '/sys/class/thermal/';
        let zones = [];
        // Zones of one type share one hwmon device, whose directory is inside the first of them only
        // (drivers/thermal/thermal_hwmon.c); the loop above has recorded it.
        let zoneTypesInHwmon = new Set();
        for (let directory of await this._list(root, this._discoveryCancellation)) {
            if (!directory.startsWith('thermal_zone')) continue;
            let zoneType = await this._read(root + directory + '/type', this._discoveryCancellation);
            zones.push({directory, zoneType});
            let zoneEntries = await this._list(root + directory, this._discoveryCancellation);
            if (zoneEntries.some(entry => entry.startsWith('hwmon')))
                zoneTypesInHwmon.add(zoneType);
        }
        for (let {directory, zoneType} of zones) {
            // Intel's thermal framework device; its zone always reports 20 °C.
            if (zoneType == 'INT3400 Thermal') continue;
            // coretemp reports the same package temperature.
            if (zoneType == 'x86_pkg_temp' && hwmonDeviceNames.has('coretemp')) continue;
            if (zoneTypesInHwmon.has(zoneType)) continue;
            let file = root + directory + '/temp';
            await this._registerSensorWithHideZeros(run, 'temperature', {
                key: 'thermal/' + zoneType,
                label: zoneType,
                format: 'temp',
                file,
                // The zone gives millidegrees.
                compute: ({reading}) => reading.value / 1000
            }, {id: file}, readFile(file));
        }
    }

    _discoverNetwork(run, interfaces, hardwareInterfaces) {
        let wifiHeading;
        for (let name of interfaces.keys()) {
            let hardware = hardwareInterfaces.has(name);
            // As "WiFi (wlp0s20f3)".
            let heading = hardware ? this._gettext(hardwareInterfaces.get(name)) + ' (' + name + ')' : name;
            if (hardwareInterfaces.get(name) == HARDWARE_INTERFACE_KINDS.wlan)
                wifiHeading = heading;
            let section = hardware ? NETWORK_SECTION.hardwareInterfaces : NETWORK_SECTION.virtualInterfaces;
            // What the loopback interface receives is what it sends.
            if (name == 'lo') {
                this._registerSensor(run, 'network', {
                    key: 'lo/tx',
                    label: 'Transferred',
                    format: 'storage',
                    file: NETWORK.id,
                    interface: name,
                    direction: 'tx',
                    hardware,
                    section,
                    heading,
                    compute: NETWORK.interfaceTransferred
                }, NETWORK);
                continue;
            }
            for (let [direction, label] of [['rx', 'Download speed'], ['tx', 'Upload speed']]) {
                this._registerSensor(run, 'network', {
                    key: name + '/' + direction,
                    label,
                    format: 'speed',
                    file: NETWORK.id,
                    interface: name,
                    direction,
                    icon: DIRECTION_ICONS[direction],
                    hardware,
                    section,
                    heading,
                    compute: NETWORK.interfaceRate
                }, NETWORK);
            }
        }
        this._registerSensors(run, NETWORK);
        // Under the WiFi interface: the last one, as WIFI.parse takes the last line.
        this._registerSensors(run, WIFI, {heading: wifiHeading});
        if (this._settings.get_boolean('include-public-ip'))
            this._registerSensors(run, PUBLIC_IP);
    }

    // A hardware interface has a `device` entry; a bridge, a container's or a VPN's interface and the loopback have none.
    async _findHardwareInterfaces(interfaces) {
        let hardwareInterfaces = new Map();
        for (let name of interfaces.keys()) {
            if (await this._optionalRead('/sys/class/net/' + name + '/device/uevent') === null) continue;
            let description = await this._read('/sys/class/net/' + name + '/uevent', this._discoveryCancellation);
            let deviceType = description.split('\n').find(line => line.startsWith('DEVTYPE='))?.slice('DEVTYPE='.length);
            hardwareInterfaces.set(name, HARDWARE_INTERFACE_KINDS[deviceType] ?? 'Ethernet');
        }
        return hardwareInterfaces;
    }

    // A run for the network category alone, when /proc/net/dev lists other interfaces than the catalog.
    async _rediscoverNetwork(interfaces) {
        let hardwareInterfaces = await this._findHardwareInterfaces(interfaces);
        // A discovery that started meanwhile finds them itself.
        if (this._discovery || this.destroyed) return;
        let network = this.catalog.network;
        let sensorCountBefore = network.sensors.length;
        let run = this._startRun();
        this._discoverNetwork(run, interfaces, hardwareInterfaces);
        network.discovered = run;
        network.categoryPin = this._chooseCategoryPin('network');
        if (network.sensors.length != sensorCountBefore)
            this.save();
        this.catalogChanged();
    }

    // The monitored locations that are mounted. A network location has no disk counters.
    async _discoverStorage(run) {
        let mounts = SensorMath.parseMountTable(await this._read(MOUNTS, this._discoveryCancellation));
        let monitored = new Set(this._settings.get_strv('storage-locations'));
        if (this._settings.get_boolean('storage-monitor-volumes')) {
            // A mount without a path, such as a phone's, is in no mount table and is dropped below.
            for (let mount of Gio.VolumeMonitor.get().get_mounts())
                monitored.add(mount.get_root().get_path());
        }
        // gvfs's FUSE directory only holds the shares gvfs mounts, and has no space of its own.
        let monitoredLocations = [...monitored].filter(location => mounts.get(location) && mounts.get(location).type != 'fuse.gvfsd-fuse').sort();
        for (let [index, location] of monitoredLocations.entries()) {
            let network = SensorMath.isRemoteMount(mounts.get(location));
            // `file` is the file the sensors are read from, if they are read from one.
            let registerLocationSensors = (definition, file) => {
                for (let [field, sensorFields] of Object.entries(definition.sensors)) {
                    this._registerSensor(run, 'storage', {
                        key: location + '/' + field,
                        ...sensorFields,
                        field,
                        location,
                        network,
                        file,
                        device: mounts.get(location).device,
                        section: index + 1,
                        heading: location
                    }, definition);
                }
            };
            // The space is queried per location, so each location is a source of its own.
            registerLocationSensors({...STORAGE_SPACE, id: location, network});
            if (!network)
                registerLocationSensors(DISKSTATS, DISKSTATS.id);
        }
        if (await this._optionalRead(ARC.id) !== null)
            this._registerSensors(run, ARC, {section: monitoredLocations.length + 1, heading: 'ZFS cache'});
    }

    // Also the batteries of devices such as a mouse. A key is the battery's name and the field.
    async _discoverBattery(run) {
        let root = '/sys/class/power_supply/';
        let supplies;
        try {
            supplies = await this._list(root, this._discoveryCancellation);
        } catch (error) {
            // Without the directory, the machine has no batteries.
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
            throw error;
        }
        let batteries = [];
        for (let name of supplies) {
            if (await this._optionalRead(root + name + '/type') == 'Battery')
                batteries.push(name);
        }
        let machineBatteries = 0;
        for (let name of batteries) {
            let file = root + name + '/uevent';
            let description = await this._read(file, this._discoveryCancellation);
            // A device's battery, such as a mouse's, does not count toward the total power rate.
            let peripheral = await this._optionalRead(root + name + '/scope') == 'Device';
            if (!peripheral) machineBatteries++;
            let batteryFields = SensorMath.parseBattery(description);
            // A field the file lacks gets no sensor; capacity and time left are computed, so every battery has them.
            let found = Object.entries(BATTERY.fieldKeys).filter(([batteryField]) => batteryFields[batteryField] !== undefined &&
                !(typeof batteryFields[batteryField] == 'number' && !Number.isFinite(batteryFields[batteryField])))
                .map(([, field]) => field);
            // A device's battery is headed by its model.
            let heading = peripheral && description.match(/^POWER_SUPPLY_MODEL_NAME=(.+)$/m)?.[1] || name;
            for (let field of [...found, 'capacity', 'time-left']) {
                this._registerSensor(run, 'battery', {
                    key: name + '/' + field,
                    ...BATTERY.sensors[field],
                    field,
                    file,
                    heading
                }, {...BATTERY, id: file});
            }
        }
        if (machineBatteries > 1) {
            this._registerSensor(run, 'battery', {
                key: 'total-power-rate',
                label: 'Total power rate',
                format: 'watt',
                aggregate: true,
                section: 1
            });
        }
    }

    _discoverAggregates(run) {
        for (let [categoryName, format] of Object.entries(AGGREGATED)) {
            let category = this.catalog[categoryName];
            let count = 0;
            for (let sensor of category.sensors) {
                if (this._countsInAggregates(category, sensor))
                    count++;
            }
            if (count < 2) continue;
            // Section 1 puts them below the sensors, which have none.
            for (let [key, label] of [['average', 'Average'], ['minimum', 'Minimum'], ['maximum', 'Maximum']])
                this._registerSensor(run, categoryName, {key, label, format, aggregate: true, section: 1});
        }
    }

    // destroy() stops the program.
    async _runProgram(args) {
        this._discoveryCancellation.set_error_if_cancelled();
        let process = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._commands.add(process);
        try {
            return await new Promise((resolve, reject) => {
                process.communicate_utf8_async(null, this._discoveryCancellation, (process, result) => {
                    try {
                        let [, output, error] = process.communicate_utf8_finish(result);
                        if (!process.get_successful()) throw new Error(error.trim() || args[0] + ' failed');
                        resolve(output.trim());
                    } catch (error) { reject(error); }
                });
            });
        } finally {
            this._commands.delete(process);
        }
    }

    // NVIDIA cards through nvidia-smi, the others through /sys/class/drm. A key is the card's name and the field.
    async _discoverGpu(run) {
        // A switched-off category starts no nvidia-smi.
        if (!this.catalog.gpu.enabled) return;
        let staticInfo = this._settings.get_boolean('include-static-gpu-info');
        let nvidiaCards = [];
        let nvidiaFields = ['uuid', 'name'];
        let nvidiaStaticFields = [
            ['Temperature Limit', 'temperature.gpu.tlimit', 'temp'],
            ['Power Limit', 'power.limit', 'watt-gpu'],
            ['Addressing Mode', 'addressing_mode', 'string'],
            ['Driver Version', 'driver_version', 'string'],
            ['vBIOS Version', 'vbios_version', 'string'],
            ['Serial Number', 'serial', 'string'],
            ['Domain Number', 'pci.domain', 'string'],
            ['Bus Number', 'pci.bus', 'string'],
            ['Device Number', 'pci.device', 'string'],
            ['Device ID', 'pci.device_id', 'string'],
            ['Sub Device ID', 'pci.sub_device_id', 'string']
        ];
        if (GLib.find_program_in_path('nvidia-smi')) {
            // For the hide-zeros check below.
            if (this._settings.get_boolean('hide-zeros'))
                nvidiaFields.push('temperature.gpu', 'temperature.memory');
            if (staticInfo)
                nvidiaFields.push(...nvidiaStaticFields.map(([, field]) => field), 'pcie.link.gen.max', 'pcie.link.width.max');
            try {
                let output = await this._runProgram(['nvidia-smi', '--query-gpu=' + nvidiaFields.join(','), '--format=csv,noheader,nounits']);
                nvidiaCards = output.split('\n').filter(line => line.trim()).map(line => line.split(',').map(part => part.trim()));
            } catch (error) {
                // Without a working card, as when it is switched off, the query fails every run: no fault.
                if (!this.destroyed) console.debug('nvidia discovery', error);
            }
        }
        let otherCards = [];
        for (let card of await this._list('/sys/class/drm', this._discoveryCancellation)) {
            if (!/^card\d+$/.test(card)) continue;
            let devicePath = '/sys/class/drm/' + card + '/device/';
            let vendor = await this._optionalRead(devicePath + 'vendor');
            // 0x10de is NVIDIA: when nvidia-smi reports cards, they are not read through /sys as well.
            if (vendor === null || (vendor == '0x10de' && nvidiaCards.length)) continue;
            otherCards.push({devicePath, vendor, files: await this._list(devicePath, this._discoveryCancellation)});
        }
        let cardNumber = 0;
        let heading = () => this._gettext('GPU %d').replace('%d', cardNumber);

        for (let parts of nvidiaCards) {
            cardNumber++;
            let uuid = parts[0];
            let cardName = parts[1];
            let part = field => parts[nvidiaFields.indexOf(field)];
            if (staticInfo) {
                this._registerConstant(run, 'gpu', {
                    key: cardName + '/name',
                    label: 'Vendor',
                    format: 'string',
                    heading: heading()
                }, cardName);
                for (let [label, field, format] of nvidiaStaticFields) {
                    if (part(field) == 'N/A' || part(field) == '[N/A]') continue;
                    this._registerConstant(run, 'gpu', {
                        key: cardName + '/' + field,
                        label,
                        format,
                        heading: heading()
                    }, format == 'string' ? part(field) : Number(part(field)));
                }
                let generation = part('pcie.link.gen.max');
                let width = part('pcie.link.width.max');
                if (Number.isFinite(Number(generation)) && Number.isFinite(Number(width))) {
                    this._registerConstant(run, 'gpu', {
                        key: cardName + '/pcie.link.max',
                        label: 'Maximum Link Speed',
                        format: 'pcie',
                        heading: heading()
                    }, generation + 'x' + width);
                }
            }
            let hasTemperature = false;
            for (let [label, field, format] of [
                ['Fan', 'fan.speed', 'percent'],
                ['Temperature', 'temperature.gpu', 'temp'],
                ['Memory Temperature', 'temperature.memory', 'temp'],
                ['Memory Total', 'memory.total', 'memory'],
                ['Memory Used', 'memory.used', 'memory'],
                ['Memory Reserved', 'memory.reserved', 'memory'],
                ['Memory Free', 'memory.free', 'memory'],
                ['Memory Utilization', 'utilization.memory', 'percent'],
                ['Utilization', 'utilization.gpu', 'percent'],
                ['Encoder Utilization', 'utilization.encoder', 'percent'],
                ['Decoder Utilization', 'utilization.decoder', 'percent'],
                ['Frequency', 'clocks.gr', 'hertz'],
                ['Memory Frequency', 'clocks.mem', 'hertz'],
                ['Encoder/Decoder Frequency', 'clocks.video', 'hertz'],
                ['Power', 'power.draw.instant', 'watt-gpu'],
                ['Average Power', 'power.draw.average', 'watt-gpu']
            ]) {
                let registered = await this._registerSensorWithHideZeros(run, 'gpu', {
                    key: cardName + '/' + field,
                    label,
                    format,
                    heading: heading(),
                    nvidia: uuid,
                    field,
                    ...(field == 'memory.free' && LOW_IS_BAD),
                    compute: NVIDIA.compute
                }, NVIDIA, () => Number(part(field)));
                if (field == 'temperature.gpu')
                    hasTemperature = registered;
            }
            this._registerSensor(run, 'gpu', {
                key: cardName + '/memory-usage',
                label: 'Memory Usage',
                format: 'percent',
                heading: heading(),
                nvidia: uuid,
                field: 'memory.used,memory.total',
                compute: NVIDIA.compute
            }, NVIDIA);
            this._registerSensor(run, 'gpu', {
                key: cardName + '/link-speed',
                label: 'Link Speed',
                format: 'pcie',
                heading: heading(),
                nvidia: uuid,
                field: 'pcie.link.gen.gpucurrent,pcie.link.width.current',
                compute: NVIDIA.compute
            }, NVIDIA);
            // Also among the temperatures, where it counts in their average.
            if (hasTemperature) {
                this._registerSensor(run, 'temperature', {
                    key: cardName + '/temperature.gpu',
                    label: nvidiaCards.length > 1 ? heading() : 'GPU',
                    format: 'temp',
                    nvidia: uuid,
                    field: 'temperature.gpu',
                    compute: NVIDIA.compute
                }, NVIDIA);
            }
        }

        for (let {devicePath, vendor, files} of otherCards) {
            cardNumber++;
            if (staticInfo) {
                let vendors = {
                    '0x1002': 'AMD',
                    '0x10de': 'NVIDIA',
                    '0x13b5': 'ARM',
                    '0x5143': 'Qualcomm',
                    '0x8086': 'Intel',
                    '0x1234': 'QEMU'
                };
                this._registerConstant(run, 'gpu', {
                    key: vendor + '/vendor',
                    label: 'Vendor',
                    format: 'string',
                    heading: heading()
                }, vendors[vendor] || vendor);
            }
            // The busy percentage goes up to 100; memory is in bytes.
            for (let [label, file, format, scale] of [
                ['Usage', 'gpu_busy_percent', 'percent', 0.01],
                ['Memory Used', 'mem_info_vram_used', 'memory', 1],
                ['Memory Total', 'mem_info_vram_total', 'memory', 1]
            ]) {
                if (!files.includes(file)) continue;
                this._registerSensor(run, 'gpu', {
                    key: vendor + '/' + file,
                    label,
                    format,
                    heading: heading(),
                    file: devicePath + file,
                    compute: ({reading}) => reading.value * scale
                }, {id: devicePath + file});
            }
        }
        this._registerSensors(run, FRAMES);
    }

    destroy() {
        this.destroyed = true;
        // Destroyed, nothing is active, so every source stops.
        this._updateActiveSources();
        this._discoveryCancellation.cancel();
        for (let process of this._commands)
            process.force_exit();
    }
}
