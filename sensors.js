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

// Marks a label for the translation template (make pot); the renderer translates it when it shows it.
const N_ = text => text;

// A rate needs two readings, and the next tick can be a minute away.
const SECOND_READING_SECONDS = 1;

// The kernel gives temperatures and voltages in thousandths, and a power limit in millionths.
const FILE_VALUE = {
    'temp': number => number / 1000, 'in': number => number / 1000, 'fan': number => number,
    'watt-limit': number => number / 1000000, 'percent': number => number * 0.01, 'memory': number => number
};
// Not voltage: an average over a battery, the system and a USB supply means nothing.
const AGGREGATED = {temperature: 'temp', fan: 'fan'};
const AGGREGATES = {
    'total-power-rate': SensorMath.sum,
    average: SensorMath.average,
    // Infinite without sensors, which makes the aggregate unavailable.
    minimum: sensors => Math.min(...sensors.map(sensor => sensor.value)),
    maximum: sensors => Math.max(...sensors.map(sensor => sensor.value))
};

const LOW_IS_BAD = {lowIsBad: true};

// A source's definition. `id` is the file's path, or a name for a source _registerSystemSources reads; without `id`,
// discovery makes one source per storage location or battery. Without `parse`, the file is one number.
const MEMORY = {
    id: '/proc/meminfo', parse: SensorMath.parseMemory, category: 'memory',
    sensors: {
        'physical': {label: N_('Physical'), format: 'memory', value: s => s.value.MemTotal},
        'available': {label: N_('Available'), format: 'memory', ...LOW_IS_BAD, value: s => s.value.MemAvailable},
        'cached': {label: N_('Cached'), format: 'memory', value: s => s.value.Cached},
        'free': {label: N_('Free'), format: 'memory', ...LOW_IS_BAD, value: s => s.value.MemFree},
        'swap-total': {label: N_('Swap Total'), format: 'memory', value: s => s.value.SwapTotal},
        'swap-free': {label: N_('Swap Free'), format: 'memory', ...LOW_IS_BAD, value: s => s.value.SwapFree},
        'allocated': {label: N_('Allocated'), format: 'memory', value: s => s.value.MemTotal - s.value.MemAvailable},
        'usage': {label: N_('Usage'), format: 'percent', value: s => (s.value.MemTotal - s.value.MemAvailable) / s.value.MemTotal},
        'swap-used': {label: N_('Swap Used'), format: 'memory', value: s => s.value.SwapTotal - s.value.SwapFree},
        'swap-usage': {label: N_('Swap Usage'), format: 'percent', value: s =>
            s.value.SwapTotal ? (s.value.SwapTotal - s.value.SwapFree) / s.value.SwapTotal : 0}
    }
};

// Discovery adds a sensor per core.
const CPU_STAT = {
    id: '/proc/stat', parse: SensorMath.parseCpuStat, category: 'processor',
    sensors: {'usage': {label: N_('Usage'), format: 'percent', value: s => SensorMath.cpuUsage(s, 'cpu')}}
};

// Read from one file per core, or from /proc/cpuinfo where it lists the frequencies (_discoverSystem).
const CPU_FREQUENCIES = {
    id: 'cpu-frequencies', category: 'processor',
    // In hertz, from /proc/cpuinfo's text or the per-core files' list.
    frequencies: s => Array.isArray(s.value) ? s.value :
        s.value.split('\n').filter(line => line.split(':')[0].trim() == 'cpu MHz')
            .map(line => Number(line.slice(line.indexOf(':') + 1)) * 1000000),
    sensors: {
        'frequency': {label: N_('Frequency'), format: 'hertz', icon: 'vitals-cpu-frequency-symbolic', value: s => {
            let frequencies = CPU_FREQUENCIES.frequencies(s);
            return frequencies.reduce((sum, frequency) => sum + frequency, 0) / frequencies.length;
        }},
        'min-frequency': {label: N_('Min frequency'), format: 'hertz', icon: 'vitals-cpu-frequency-symbolic',
            value: s => Math.min(...CPU_FREQUENCIES.frequencies(s))},
        'max-frequency': {label: N_('Max frequency'), format: 'hertz', icon: 'vitals-cpu-frequency-symbolic',
            value: s => Math.max(...CPU_FREQUENCIES.frequencies(s))}
    }
};

const UPTIME = {
    id: '/proc/uptime', parse: text => SensorMath.splitFields(text).map(Number), category: 'system',
    sensors: {
        // The time since boot minus one core's share of the idle time of all cores.
        'process-time': {category: 'processor', label: N_('Process Time'), format: 'uptime',
            value: (s, sensor, sensors) => s.value[0] - s.value[1] / sensors._cores().length},
        'uptime': {label: N_('Uptime'), format: 'uptime', value: s => s.value[0]}
    }
};

const LOADAVG = {
    id: '/proc/loadavg', parse: SensorMath.splitFields, category: 'system',
    sensors: {
        'load-1m': {label: N_('Load 1m'), format: 'load', value: s => Number(s.value[0])},
        'load-5m': {label: N_('Load 5m'), format: 'load', value: s => Number(s.value[1])},
        'load-15m': {label: N_('Load 15m'), format: 'load', value: s => Number(s.value[2])},
        // The fourth field is runnable/all threads, as "2/1234".
        'threads-active': {label: N_('Threads Active'), format: 'string', value: s => Number(s.value[3].split('/')[0])},
        'threads-total': {label: N_('Threads Total'), format: 'string', value: s => Number(s.value[3].split('/')[1])}
    }
};

// parseInt takes the first of the file's three numbers, the allocated file handles.
const OPEN_FILES = {
    id: '/proc/sys/fs/file-nr', parse: text => Number.parseInt(text), category: 'system',
    sensors: {'open-files': {label: N_('Open Files'), format: 'string', value: s => s.value}}
};

const POWERCAP = {
    id: '/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw', category: 'processor',
    sensors: {'powercap': {label: N_('Powercap'), format: 'watt-limit', icon: 'vitals-cpu-power-symbolic', value: s => FILE_VALUE['watt-limit'](s.value)}}
};

// 1 while a ThinkPad senses that it lies on a lap.
const LAP_MODE = {
    id: '/sys/devices/platform/thinkpad_acpi/dytc_lapmode', category: 'system',
    sensors: {'lap-mode': {label: N_('Lap mode'), format: 'string', value: (s, sensor, sensors) => sensors._gettext(s.value == 1 ? 'on' : 'off')}}
};

// No source: discovery writes their values once, with `include-static-info` on.
const STATIC_INFO = {
    category: 'processor',
    sensors: {
        'vendor': {label: N_('Vendor'), format: 'string'},
        'bogomips': {label: N_('Bogomips'), format: 'string'},
        'sockets': {label: N_('Sockets'), format: 'string'},
        'cache': {label: N_('Cache'), format: 'memory'},
        'kernel': {category: 'system', label: N_('Kernel'), format: 'string'}
    }
};

// The renderer orders the network rows by these sections.
const NETWORK_SECTION = {machineSpeed: 1, hardwareInterfaces: 2, volume: 3, other: 4, virtualInterfaces: 5};
const DIRECTION_ICONS = {rx: 'vitals-network-download-symbolic', tx: 'vitals-network-upload-symbolic'};
// By DEVTYPE; any other hardware interface is "Ethernet". "WiFi" is spelled as in the WIFI labels.
const HARDWARE_INTERFACE_KINDS = {wlan: N_('WiFi'), wwan: N_('Mobile')};

// Over the hardware interfaces only: what a virtual interface carries also passes a hardware one, and would count twice.
const NETWORK = {
    id: '/proc/net/dev', category: 'network', sensors: {},
    speed(s, sensors, directions) {
        let hardwareInterfaces = [...sensors._hardwareInterfaces()];
        let speeds = directions.flatMap(direction => hardwareInterfaces.map(name =>
            SensorMath.counterRate(s, value => value.interfaces.get(name)?.[direction])));
        if (speeds.includes(undefined)) return undefined;
        if (speeds.includes(SensorMath.PENDING)) return SensorMath.PENDING;
        return speeds.reduce((total, speed) => total + speed, 0);
    }
};
for (let [direction, speedLabel, bootLabel, sessionLabel] of [
    ['rx', N_('Download speed'), N_('Downloaded since boot'), N_('Downloaded this session')],
    ['tx', N_('Upload speed'), N_('Uploaded since boot'), N_('Uploaded this session')]]) {
    let icon = DIRECTION_ICONS[direction];
    Object.assign(NETWORK.sensors, {
        ['device-' + direction]: {label: speedLabel, format: 'speed', direction, icon, section: NETWORK_SECTION.machineSpeed,
            value: (s, sensor, sensors) => NETWORK.speed(s, sensors, [direction])},
        // An interface that was just unplugged can be missing from a reading.
        ['boot-' + direction]: {label: bootLabel, format: 'storage', direction, icon, section: NETWORK_SECTION.volume,
            value: (s, sensor, sensors) => [...sensors._hardwareInterfaces()].reduce((bytes, name) =>
                bytes + (s.value.interfaces.get(name)?.[direction] ?? 0), 0)},
        ['session-' + direction]: {label: sessionLabel, format: 'storage', direction, icon, section: NETWORK_SECTION.volume,
            value: s => s.value.session[direction]}
    });
}
NETWORK.sensors['combined'] = {label: N_('Total speed'), format: 'speed', section: NETWORK_SECTION.machineSpeed,
    value: (s, sensor, sensors) => NETWORK.speed(s, sensors, ['rx', 'tx'])};

// The values of the last interface the file lists.
const WIFI = {
    id: '/proc/net/wireless', category: 'network',
    // Two heading lines come first. /proc/net/wireless gives the link quality on a scale from 0 to 70.
    parse(text) {
        let lines = text.split('\n').slice(2).filter(line => line.trim());
        if (!lines.length) return {};
        let fields = SensorMath.splitFields(lines[lines.length - 1]);
        return {quality: Number(fields[2]) / 70, signal: Number(fields[3])};
    },
    icon(s) {
        let strength = s.value.quality * 100;
        let step = strength < 20 ? 'none' : strength < 40 ? 'weak' : strength < 50 ? 'ok' : strength < 80 ? 'good' : 'excellent';
        return 'vitals-wifi-signal-' + step + '-symbolic';
    },
    // Recorded on every machine; without WiFi they are unavailable.
    sensors: {
        'wifi-link-quality': {label: N_('WiFi Link Quality'), format: 'percent', section: NETWORK_SECTION.hardwareInterfaces, ...LOW_IS_BAD,
            value: s => s.value.quality},
        'wifi-signal-level': {label: N_('WiFi Signal Level'), format: 'string', section: NETWORK_SECTION.hardwareInterfaces,
            value: s => s.value.signal}
    }
};

const PUBLIC_IP = {
    id: 'public-ip', category: 'network',
    // Asked in order until one answers within `timeoutSeconds`.
    services: [
        ['https://1.1.1.1/cdn-cgi/trace', text => ({ip: text.match(/^ip=(.*)$/m)[1], country: text.match(/^loc=(.*)$/m)[1]})],
        ['https://get.geojs.io/v1/ip/country.json', text => JSON.parse(text)],
        ['https://api.country.is/', text => JSON.parse(text)]
    ],
    timeoutSeconds: 3,
    // Without a country, or one without an icon, the category's icon.
    icon: s => s.value.country ? 'vitals-country-' + s.value.country.toLowerCase() + '-symbolic' : undefined,
    sensors: {'public-ip': {label: N_('Public IP'), format: 'string', section: NETWORK_SECTION.other, value: s => s.value.ip}}
};

const MOUNTS = '/proc/self/mountinfo';

// One source per storage location (_storageLocationSource).
const STORAGE_SPACE = {
    sensors: {
        'total': {label: N_('Total'), format: 'storage', value: s => s.value.total},
        'used': {label: N_('Used'), format: 'storage', value: s => s.value.used},
        // With the space kept for root, as Free %; GIO's `free` leaves it out.
        'free': {label: N_('Free'), format: 'storage', ...LOW_IS_BAD, value: s => s.value.total - s.value.used},
        'reserved': {label: N_('Reserved'), format: 'storage', value: s => s.value.total - s.value.used - s.value.free},
        'used-percent': {label: N_('Used %'), format: 'percent', value: s => s.value.used / s.value.total},
        'free-percent': {label: N_('Free %'), format: 'percent', ...LOW_IS_BAD, value: s => (s.value.total - s.value.used) / s.value.total}
    }
};

const DISKSTATS = {
    id: '/proc/diskstats',
    // By major:minor, as the mount table names a device. Sectors are 512 bytes, whatever the device's.
    parse: text => new Map(text.split('\n').map(line => {
        let fields = SensorMath.splitFields(line);
        return [fields[0] + ':' + fields[1], {read: Number(fields[5]) * 512, write: Number(fields[9]) * 512}];
    })),
    sensors: {
        'read-total': {label: N_('Read total'), format: 'storage', icon: 'vitals-storage-read-symbolic',
            value: (s, sensor) => s.value.get(sensor.device)?.read},
        'read-rate': {label: N_('Read rate'), format: 'storage-rate', icon: 'vitals-storage-read-symbolic',
            value: (s, sensor) => SensorMath.counterRate(s, disks => disks.get(sensor.device)?.read)},
        'write-total': {label: N_('Write total'), format: 'storage', icon: 'vitals-storage-write-symbolic',
            value: (s, sensor) => s.value.get(sensor.device)?.write},
        'write-rate': {label: N_('Write rate'), format: 'storage-rate', icon: 'vitals-storage-write-symbolic',
            value: (s, sensor) => SensorMath.counterRate(s, disks => disks.get(sensor.device)?.write)}
    }
};

// The cache of ZFS.
const ARC = {
    id: '/proc/spl/kstat/zfs/arcstats', category: 'storage',
    // Lines are name, type, value; the heading lines become entries no sensor uses.
    parse: text => Object.fromEntries(text.split('\n').map(line => {
        let fields = SensorMath.splitFields(line);
        return [fields[0], Number(fields[2])];
    })),
    sensors: {
        'arc-target': {label: N_('ARC Target'), format: 'storage', value: s => s.value.c},
        'arc-maximum': {label: N_('ARC Maximum'), format: 'storage', value: s => s.value.c_max},
        'arc-current': {label: N_('ARC Current'), format: 'storage', value: s => s.value.size}
    }
};

// One source per battery's uevent file (_discoverBattery).
const BATTERY = {
    parse: SensorMath.parseBattery,
    // parseBattery's fields, and the sensor each one becomes.
    fieldKeys: {
        state: 'state', cycles: 'cycles', voltage: 'voltage', level: 'level', percentage: 'percentage', power: 'power-rate',
        full: 'energy-full', design: 'energy-design', now: 'energy-now'
    },
    sensors: {
        'state': {label: N_('State'), format: 'string', value: s => s.value.state},
        'cycles': {label: N_('Cycles'), format: 'string', value: s => s.value.cycles},
        'voltage': {label: N_('Voltage'), format: 'in', value: s => s.value.voltage},
        'level': {label: N_('Level'), format: 'string', value: s => s.value.level},
        'percentage': {label: N_('Percentage'), format: 'percent', ...LOW_IS_BAD, value: s => s.value.percentage},
        'power-rate': {label: N_('Power Rate'), format: 'watt', value: s => s.value.power},
        'energy-full': {label: N_('Energy (full)'), format: 'watt-hour', value: s => s.value.full},
        'energy-design': {label: N_('Energy (design)'), format: 'watt-hour', value: s => s.value.design},
        'energy-now': {label: N_('Energy (now)'), format: 'watt-hour', ...LOW_IS_BAD, value: s => s.value.now},
        'capacity': {label: N_('Capacity'), format: 'percent', ...LOW_IS_BAD, value: s => s.value.full / s.value.design},
        'time-left': {label: N_('Time left'), format: 'runtime', ...LOW_IS_BAD, value: (s, sensor, sensors) => sensors._batteryTimeLeft(s, sensor.file)}
    }
};

// Read through nvidia-smi (_configureNvidia).
const NVIDIA = {
    id: 'nvidia',
    // nvidia-smi gives percentages up to 100, memory in MiB and frequencies in MHz.
    scale: {'percent': 0.01, 'temp': 1, 'memory': 1048576, 'hertz': 1000000, 'watt-gpu': 1},
    // Two fields give a share of the first in the second, or a link speed as generation x width.
    value(reading, sensor) {
        let gpu = reading.value.gpus.get(sensor.nvidia);
        let [first, second] = sensor.field.split(',').map(field => Number(gpu?.[field]));
        if (sensor.format == 'pcie')
            return Number.isFinite(first) && Number.isFinite(second) ? first + 'x' + second : undefined;
        return second === undefined ? first * NVIDIA.scale[sensor.format] : first / second;
    }
};

// The frames the Shell draws per second (_startFrames).
const FRAMES = {
    id: 'frames', category: 'gpu',
    sensors: {'refresh-rate': {label: N_('Screen Redraws'), format: 'hertz', value: s => SensorMath.counterRate(s, frames => frames)}}
};

// Seconds that only move forward, for the time between two readings.
function clock() {
    return GLib.get_monotonic_time() / 1000000;
}

// Seconds of calendar time, for the timestamps that are saved with the catalog.
function now() {
    return GLib.get_real_time() / 1000000;
}

// Only for a stream without a pending read: GIO refuses to close one with a pending read.
function closeNvidiaStream(stream) {
    stream.close_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        try { stream.close_finish(result); }
        catch (error) { console.error(NVIDIA.id, error); }
    });
}

// The collector: it finds the sensors, reads the shown ones and writes the catalog (docs/catalog-design.md).
export class Sensors {
    constructor(settings, gettext) {
        // By id: a file's path, a storage location's mount point, or a name.
        this.sources = new Map();
        // The sources that are read, each with its sensors as [category name, sensor] (see _updateActiveSources).
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
        // The running nvidia-smi process, its output and its latest complete reading (see _configureNvidia).
        this._nvidia = null;
        this._frameSignal = 0;
        // The frames painted while FRAMES is read. Never reset, since counterRate takes a smaller count for a restart.
        this._frames = 0;
        // Per battery file, its charging state and its last time-left values in that state (see _batteryTimeLeft).
        this._batteryTimes = new Map();
        // The read of the mount table under way, which every storage location's read waits for.
        this._mountTableRead = null;
        this._registerSystemSources();
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
            catalog[name] = {...category, enabled: catalogSettings[name].enabled, runtime: {}, sensors,
                categoryPin: sensors.find(sensor => sensor.key == categoryPin)};
        }
        // A remembered width is only used with steady widths.
        let rememberWidths = this._settings.get_boolean('fixed-widths') && this._settings.get_boolean('remember-widths');
        catalog.panel = {sensors: saved.panel.sensors.map(({category, key, visible, reservedWidth}) => {
            let sensors = catalog[category].sensors;
            let sensor = sensors.find(candidate => candidate.key == key);
            // A pinned sensor no run has found yet, such as a default pin, keeps its place; discovery fills it in by key.
            if (!sensor) {
                sensor = {key, category, status: 'pending', runtime: {}};
                sensors.push(sensor);
            }
            return {sensor, visible, reservedWidth: rememberWidths ? reservedWidth : undefined, runtime: {}};
        })};
        return catalog;
    }

    save() {
        let catalog = {};
        // Objects are left out: `runtime`, and `categoryPin` and `sensors`, which are written below.
        let plain = record => Object.fromEntries(Object.entries(record).filter(([, fieldValue]) => typeof fieldValue != 'object'));
        // `enabled` is saved in the catalog settings, by the preferences window. A sensor's `category` is the list
        // it is saved in.
        for (let [name, category] of this.categories())
            catalog[name] = {...plain(category), enabled: undefined, categoryPin: category.categoryPin?.key,
                sensors: category.sensors.map(sensor => ({...plain(sensor), category: undefined}))};
        // A panel sensor's reference to its sensor is saved as that sensor's category and key.
        catalog.panel = {sensors: this.catalog.panel.sensors.map(({sensor, visible, reservedWidth}) =>
            ({category: sensor.category, key: sensor.key, visible, reservedWidth}))};
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
        return Object.entries(this.catalog).filter(([name]) => name != 'panel');
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

    addSource(id, definition) {
        this.sources.set(id, {id, interval: 0, ...definition, pendingRead: null});
        return this.sources.get(id);
    }

    // A file becomes a source the first time discovery finds a sensor in it.
    _source(id, parse = Number) {
        return this.sources.get(id) ?? this.addSource(id, {read: async cancellation => parse(await this._read(id, cancellation))});
    }

    reading(id) {
        return this.sources.get(id)?.reading;
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

    _aggregatedSensors(category) {
        return category.sensors.filter(sensor => sensorPresent(category, sensor) && !sensor.aggregate && !sensor.hidden);
    }

    _hardwareInterfaces() {
        let network = this.catalog.network;
        return new Set(network.sensors.filter(sensor => sensor.hardware && sensorPresent(network, sensor))
            .map(sensor => sensor.interface));
    }

    // As /proc/stat names them: "cpu0", "cpu1".
    _cores() {
        let processor = this.catalog.processor;
        return processor.sensors.filter(sensor => sensorPresent(processor, sensor) && sensor.core && sensor.core != 'cpu')
            .map(sensor => sensor.core);
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
                    activeSources.get(id).push([name, sensor]);
                }
            }
        }

        for (let id of this.activeSources.keys()) {
            if (!activeSources.has(id))
                this._stopReading(id);
        }
        for (let [id, fed] of activeSources) {
            let source = this.sources.get(id);
            if (!this.activeSources.has(id)) {
                // A recent reading with a `previous` is kept for the next tick; any other is read again at once, since
                // the second reading a rate waits for was called off when the source stopped.
                let reading = source.reading;
                let fresh = reading?.status == 'ready' && reading.previous && clock() - reading.time < this._settings.get_int('update-time');
                if (reading && !fresh && !this._withinInterval(id))
                    source.reading = {...reading, status: 'pending'};
                if (source.start) source.start();
            }
            if (source.configure)
                source.configure(fed.map(([, sensor]) => sensor));
        }
        this.activeSources = activeSources;
        this.aggregatedCategories = aggregatedCategories;
    }

    // A pending reading never is, so that it is read again.
    _withinInterval(id) {
        let source = this.sources.get(id);
        let sample = source.reading;
        let interval = typeof source.interval == 'function' ? source.interval() : source.interval;
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
        if (source.stop) source.stop();
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
                if (source.pendingRead == pendingRead) return source.read(pendingRead.cancellation);
            }).then(value => {
                // A cancelled read is discarded.
                if (source.pendingRead != pendingRead || this.destroyed) return;
                let time = source.readingTime ? source.readingTime(value) : clock();
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
                let updated = this._updateSensors(id);
                this.onValuesChanged(new Set(updated));
                let withoutValue = updated.some(sensor => sensor.status == 'pending');
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
            let categoryReads = [...this.activeSources].filter(([, fed]) => fed.some(([categoryName]) => categoryName == name))
                .map(([id]) => this.sources.get(id).pendingRead?.promise).filter(Boolean);
            if (!categoryReads.length) continue;
            this.aggregateReads.set(name, categoryReads);
            summaries.push(Promise.all(categoryReads).then(() => {
                // A later call that started newer reads computes them instead.
                if (this.aggregateReads.get(name) != categoryReads || this.destroyed || this._discovery || !this.aggregatedCategories.has(name)) return;
                this.onValuesChanged(new Set(this._updateAggregates(name)));
            }));
        }
        await Promise.all([...reads, ...summaries]);
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

    _updateSensors(id) {
        let reading = this.sources.get(id).reading;
        return this.activeSources.get(id).map(([, sensor]) => {
            if (reading?.status == 'ready') {
                this._assign(sensor, sensor.runtime.value(reading, sensor, this));
                if (sensor.runtime.icon)
                    sensor.icon = sensor.runtime.icon(reading);
            } else
                this._assign(sensor, reading?.status == 'unavailable' ? undefined : SensorMath.PENDING);
            return sensor;
        });
    }

    _updateAggregates(name) {
        let category = this.catalog[name];
        // The batteries' total is over their power rates. One unavailable sensor does not make the aggregates unavailable.
        let readable = this._aggregatedSensors(category).filter(sensor =>
            sensor.status != 'unavailable' && (name != 'battery' || sensor.field == 'power-rate'));
        let pending = readable.some(sensor => sensor.status == 'pending');
        let aggregates = category.sensors.filter(sensor => sensor.aggregate && sensorPresent(category, sensor));
        for (let sensor of aggregates)
            this._assign(sensor, pending ? SensorMath.PENDING : AGGREGATES[sensor.key](readable));
        return aggregates;
    }

    // From the readings there are, without reading. A source whose read is under way is left to that read.
    _updateActiveSensors() {
        let updated = new Set();
        for (let id of this.activeSources.keys()) {
            if (this.sources.get(id).pendingRead) continue;
            for (let sensor of this._updateSensors(id))
                updated.add(sensor);
        }
        for (let name of this.aggregatedCategories) {
            for (let sensor of this._updateAggregates(name))
                updated.add(sensor);
        }
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

    // Averaged over the last 10 readings in the current charging state.
    _batteryTimeLeft(sample, batteryFile) {
        let value = SensorMath.batteryTime(sample.value);
        if (typeof value != 'number') return value;
        if (this._batteryTimes.get(batteryFile)?.state != sample.value.state)
            this._batteryTimes.set(batteryFile, {state: sample.value.state, times: []});
        let times = this._batteryTimes.get(batteryFile).times;
        // _updateActiveSensors computes the value again from the same reading, which counts once.
        if (!times.length || times[times.length - 1].time != sample.time) {
            times.push({value, time: sample.time});
            if (times.length > 10) times.shift();
        }
        return SensorMath.average(times);
    }

    // One read serves every storage location of a tick. Not cancellable, since it is shared.
    _mountTable() {
        this._mountTableRead ??= this._read(MOUNTS, null).then(SensorMath.parseMountTable)
            .finally(() => { this._mountTableRead = null; });
        return this._mountTableRead;
    }

    // The space is queried per location, so each location is a source of its own.
    _storageLocationSource(sensor) {
        let location = sensor.location;
        let query = null;
        let mounted = true;
        return {
            // A network location not mounted is looked for at every tick: that only reads the mount table.
            interval: () => sensor.network && mounted ? this._settings.get_int('storage-network-interval') * 60 : 0,
            read: async () => {
                // Querying a path where nothing is mounted would mount an automounted location again, or give the space
                // of the disk under the empty directory.
                mounted = (await this._mountTable()).has(location);
                if (!mounted)
                    throw new Error('Nothing is mounted at ' + location);
                // A query on a network location whose server is gone can block for minutes and cannot be cancelled, so a
                // read waits for the one under way.
                query ??= new Promise((resolve, reject) => {
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
                }).finally(() => { query = null; });
                return query;
            }
        };
    }

    // The sources that need code of their own to be read. Discovery registers the others.
    _registerSystemSources() {
        this.addSource(NETWORK.id, {read: async cancellation => {
            let interfaces = SensorMath.parseNetwork(await this._read(NETWORK.id, cancellation));
            // A counter lower than before started again from zero, as when its interface was created again.
            let last = this.reading(NETWORK.id)?.value;
            let session = last ? {...last.session} : {rx: 0, tx: 0};
            let hardwareInterfaces = this._hardwareInterfaces();
            for (let [name, counters] of interfaces) {
                let previous = last?.interfaces.get(name);
                if (hardwareInterfaces.has(name) && previous) {
                    for (let direction of ['rx', 'tx'])
                        session[direction] += counters[direction] >= previous[direction]
                            ? counters[direction] - previous[direction] : counters[direction];
                }
            }
            let network = this.catalog.network;
            let knownInterfaces = new Set(network.sensors.filter(sensor => sensor.interface && sensorPresent(network, sensor))
                .map(sensor => sensor.interface));
            // An interface that appeared or disappeared is taken into the catalog at once, not at the next discovery.
            if (!this._discovery && (interfaces.size != knownInterfaces.size ||
                [...interfaces.keys()].some(name => !knownInterfaces.has(name))))
                await this._rediscoverNetwork(interfaces);
            return {interfaces, session};
        }});
        // The files give kHz.
        this.addSource(CPU_FREQUENCIES.id, {read: cancellation => Promise.all(this._cores().map(async core =>
            Number(await this._read('/sys/devices/system/cpu/' + core + '/cpufreq/scaling_cur_freq', cancellation)) * 1000))});
        this.addSource(PUBLIC_IP.id, {
            // After a failure, the next tick tries again.
            interval: () => this.reading(PUBLIC_IP.id)?.status == 'ready' ? this._settings.get_int('network-public-ip-interval') * 60 : 0,
            read: async () => {
                for (let [url, parse] of PUBLIC_IP.services) {
                    let cancellable = new Gio.Cancellable();
                    let timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PUBLIC_IP.timeoutSeconds * 1000, () => {
                        timeout = 0;
                        cancellable.cancel();
                        return GLib.SOURCE_REMOVE;
                    });
                    try {
                        return parse(await this._read(url, cancellable));
                    } catch (error) {
                        // The next service is asked.
                        console.debug(url, error);
                    } finally {
                        if (timeout) GLib.Source.remove(timeout);
                    }
                }
                throw new Error('No public IP service answered');
            }
        });
        this.addSource(FRAMES.id, {
            start: () => this._startFrames(),
            stop: () => this._stopFrames(),
            read: async () => this._frames
        });
        this.addSource(NVIDIA.id, {
            configure: sensors => this._configureNvidia(sensors),
            stop: () => this._stopNvidia(),
            read: () => this._readNvidia(),
            // As old as nvidia-smi's lines, which can be older than the read that takes them.
            readingTime: sample => sample.time
        });
    }

    // Always later than the last run, even when two runs start in the same second or the clock was set back.
    _startRun() {
        this._lastRun = Math.max(Math.floor(now()), this._lastRun + 1);
        return this._lastRun;
    }

    // Two devices can have the same key, such as two NVMe drives; each takes one sensor, in the order they are found.
    _unmatched(run, categoryName, key) {
        return this.catalog[categoryName].sensors.find(sensor => sensor.key == key && sensor.discovered != run);
    }

    // A sensor the run found: the known one with its key, or a new one at the end of the category.
    _found(run, categoryName, fields, source, value, icon) {
        let sensor = this._unmatched(run, categoryName, fields.key);
        if (!sensor) {
            sensor = {status: 'pending', runtime: {}};
            this.catalog[categoryName].sensors.push(sensor);
        }
        Object.assign(sensor.runtime, {source, value, icon});
        return Object.assign(sensor, fields, {category: categoryName, discovered: run});
    }

    _foundSource(run, definition, fields = {}) {
        let source = this._source(definition.id, definition.parse);
        for (let [key, {category = definition.category, value, ...sensorFields}] of Object.entries(definition.sensors)) {
            this._found(run, category, {key, file: definition.id.startsWith('/') ? definition.id : undefined, ...sensorFields, ...fields},
                source, value, definition.icon);
        }
    }

    _foundConstant(run, key, value) {
        let {category = STATIC_INFO.category, ...fields} = STATIC_INFO.sensors[key];
        this._found(run, category, {key, ...fields, value, status: 'ready', updated: now()});
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
            'include-static-info', 'include-static-gpu-info', 'include-public-ip',
            'storage-locations', 'storage-monitor-volumes', 'hide-zeros'
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
        let present = category.sensors.filter(sensor => sensorPresent(category, sensor));
        let withKey = key => present.find(sensor => sensor.key == key);
        let chosen = present.find(sensor => sensor.pinnedToCategory);
        if (chosen) return chosen;
        switch (categoryName) {
            case 'temperature':
            case 'fan':
                // Without an average, the category has fewer than two sensors.
                return withKey('average') ?? this._aggregatedSensors(category)[0];
            case 'voltage':
                // A battery's first, a USB supply's last (`priority`, from _discoverHwmon).
                return this._aggregatedSensors(category).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))[0];
            case 'battery':
                // Without a total, a battery's power rate; a mouse's battery has none, only a percentage.
                return withKey('total-power-rate') ?? present.find(sensor => sensor.field == 'power-rate') ??
                    present.find(sensor => sensor.field == 'percentage');
            case 'storage':
                // The first location sorts first, which is "/" while "/" is monitored.
                return present.find(sensor => sensor.field == 'free' && sensor.section == 1);
            case 'gpu':
                return present.find(sensor => sensor.field == 'utilization.gpu') ??
                    present.find(sensor => sensor.file?.endsWith('/gpu_busy_percent')) ?? withKey('refresh-rate');
            default:
                return withKey({memory: 'usage', processor: 'usage', system: 'load-1m', network: 'device-rx'}[categoryName]);
        }
    }

    async _discoverSystem(run) {
        this._foundSource(run, MEMORY);

        let cores = CPU_STAT.parse(await this._read(CPU_STAT.id, this._discoveryCancellation));
        // `cpu` is the whole processor.
        for (let core of cores.keys()) {
            if (core == 'cpu')
                this._foundSource(run, CPU_STAT, {core});
            else
                this._found(run, 'processor', {key: core, format: 'percent', core, file: CPU_STAT.id,
                    label: this._gettext('Core %d').replace('%d', core.slice(3))}, this._source(CPU_STAT.id, CPU_STAT.parse),
                    reading => SensorMath.cpuUsage(reading, core));
        }
        let cpuInfo = await this._read('/proc/cpuinfo', this._discoveryCancellation);
        // Where /proc/cpuinfo lists the frequencies, it is their source, kept as text.
        this._foundSource(run, /^cpu MHz\s*:/m.test(cpuInfo) ? {...CPU_FREQUENCIES, id: '/proc/cpuinfo', parse: text => text} : CPU_FREQUENCIES);
        for (let definition of [LOADAVG, OPEN_FILES, UPTIME])
            this._foundSource(run, definition);
        for (let definition of [POWERCAP, LAP_MODE]) {
            if (await this._optionalRead(definition.id) !== null)
                this._foundSource(run, definition);
        }

        if (this._settings.get_boolean('include-static-info')) {
            // From the first processor's entry.
            let field = name => cpuInfo.match(new RegExp('^' + name + '\\s*:\\s*(.+)$', 'm'))?.[1];
            // Every processor names its package in `physical id`.
            let sockets = new Set([...cpuInfo.matchAll(/^physical id\s*:\s*(\d+)/gm)].map(match => match[1]));
            this._foundConstant(run, 'vendor', field('vendor_id'));
            this._foundConstant(run, 'bogomips', field('bogomips'));
            this._foundConstant(run, 'sockets', sockets.size);
            // In KB.
            this._foundConstant(run, 'cache', Number.parseFloat(field('cache size')) * 1024);
            // "Linux version <release> ...".
            let kernel = (await this._read('/proc/version', this._discoveryCancellation)).split(' ')[2];
            this._foundConstant(run, 'kernel', kernel);
        }
    }

    // With `hide-zeros` on, a temperature is recorded only once discovery reads something other than zero for it. A
    // present sensor keeps its first reading of the session, so it stays when it reads zero later.
    async _foundWithHideZeros(run, categoryName, fields, source, value, readInitialTemperature) {
        let initialTemperature;
        if (fields.format == 'temp' && this._settings.get_boolean('hide-zeros')) {
            let known = this._unmatched(run, categoryName, fields.key);
            if (known && sensorPresent(this.catalog[categoryName], known))
                initialTemperature = known.runtime.initialTemperature;
            if (initialTemperature === undefined)
                initialTemperature = await readInitialTemperature();
            if (!Number.isFinite(initialTemperature) || initialTemperature === 0) return false;
        }
        this._found(run, categoryName, fields, source, value).runtime.initialTemperature = initialTemperature;
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
                let categoryName = {temp: 'temperature', in: 'voltage', fan: 'fan'}[match[1]];
                let input = match[1] + match[2];
                let rawLabel = await this._optionalRead(devicePath + '/' + input + '_label');
                if (rawLabel === null)
                    rawLabel = driveModel || labelPrefix + ' ' + input;
                else if (labelPrefix != rawLabel)
                    rawLabel = labelPrefix + ' ' + rawLabel;
                // For labels that only name the device and the input, or the CPU package.
                let names = {
                    'acpitz temp1': N_('ACPI Thermal Zone'), 'pch_cannonlake temp1': N_('Platform Controller Hub'),
                    'iwlwifi_1 temp1': N_('Wireless Adapter'), 'Package id 0': N_('Processor 0'), 'Package id 1': N_('Processor 1')
                };
                // Not keyed by the hwmon directory, whose number can change at the next boot.
                await this._foundWithHideZeros(run, categoryName, {
                    key: deviceName + '/' + input, label: (names[rawLabel] || rawLabel).replace('Package id', 'CPU'),
                    format: match[1], file: devicePath + '/' + file, priority: categoryName == 'voltage' ? priority : undefined
                }, this._source(devicePath + '/' + file), reading => FILE_VALUE[match[1]](reading.value), readFile(devicePath + '/' + file));
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
            await this._foundWithHideZeros(run, 'temperature', {key: 'thermal/' + zoneType, label: zoneType, format: 'temp', file},
                this._source(file), reading => FILE_VALUE.temp(reading.value), readFile(file));
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
                this._found(run, 'network', {key: 'lo/tx', label: N_('Transferred'), format: 'storage', file: NETWORK.id, interface: name,
                    hardware, section, heading}, this._source(NETWORK.id), reading => reading.value.interfaces.get(name)?.tx);
                continue;
            }
            for (let [direction, label] of [['rx', N_('Download speed')], ['tx', N_('Upload speed')]])
                this._found(run, 'network', {key: name + '/' + direction, label, format: 'speed', file: NETWORK.id, interface: name, direction,
                    icon: DIRECTION_ICONS[direction], hardware, section, heading},
                    this._source(NETWORK.id), reading => SensorMath.counterRate(reading, value => value.interfaces.get(name)?.[direction]));
        }
        this._foundSource(run, NETWORK);
        // Under the WiFi interface: the last one, as WIFI.parse takes the last line.
        this._foundSource(run, WIFI, {heading: wifiHeading});
        if (this._settings.get_boolean('include-public-ip'))
            this._foundSource(run, PUBLIC_IP);
    }

    // A hardware interface has a `device` entry; a bridge, a container's or a VPN's interface and the loopback have none.
    async _findHardwareInterfaces(interfaces) {
        let hardwareInterfaces = new Map();
        for (let name of interfaces.keys()) {
            if (await this._optionalRead('/sys/class/net/' + name + '/device/uevent') === null) continue;
            let description = await this._read('/sys/class/net/' + name + '/uevent', this._discoveryCancellation);
            let deviceType = description.split('\n').find(line => line.startsWith('DEVTYPE='))?.slice('DEVTYPE='.length);
            hardwareInterfaces.set(name, HARDWARE_INTERFACE_KINDS[deviceType] ?? N_('Ethernet'));
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
            for (let definition of network ? [STORAGE_SPACE] : [STORAGE_SPACE, DISKSTATS]) {
                for (let [field, {value, ...fields}] of Object.entries(definition.sensors)) {
                    let sensor = this._found(run, 'storage', {key: location + '/' + field, ...fields, field, location, network,
                        file: definition.id, device: mounts.get(location).device, section: index + 1, heading: location},
                        definition.id && this._source(definition.id, definition.parse), value);
                    // A space sensor shares its location's source.
                    sensor.runtime.source ??= this.sources.get(location) ?? this.addSource(location, this._storageLocationSource(sensor));
                }
            }
        }
        if (await this._optionalRead(ARC.id) !== null)
            this._foundSource(run, ARC, {section: monitoredLocations.length + 1, heading: N_('ZFS cache')});
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
                let {value, ...fields} = BATTERY.sensors[field];
                this._found(run, 'battery', {key: name + '/' + field, ...fields, field, file, heading}, this._source(file, BATTERY.parse), value);
            }
        }
        if (machineBatteries > 1) {
            this._found(run, 'battery', {key: 'total-power-rate', label: N_('Total power rate'), format: 'watt',
                aggregate: true, section: 1});
        }
    }

    _discoverAggregates(run) {
        for (let [categoryName, format] of Object.entries(AGGREGATED)) {
            if (this._aggregatedSensors(this.catalog[categoryName]).length < 2) continue;
            // Section 1 puts them below the sensors, which have none.
            for (let [key, label] of [['average', N_('Average')], ['minimum', N_('Minimum')], ['maximum', N_('Maximum')]])
                this._found(run, categoryName, {key, label, format, aggregate: true, section: 1});
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
            [N_('Temperature Limit'), 'temperature.gpu.tlimit', 'temp'],
            [N_('Power Limit'), 'power.limit', 'watt-gpu'], [N_('Addressing Mode'), 'addressing_mode', 'string'],
            [N_('Driver Version'), 'driver_version', 'string'], [N_('vBIOS Version'), 'vbios_version', 'string'],
            [N_('Serial Number'), 'serial', 'string'], [N_('Domain Number'), 'pci.domain', 'string'],
            [N_('Bus Number'), 'pci.bus', 'string'], [N_('Device Number'), 'pci.device', 'string'],
            [N_('Device ID'), 'pci.device_id', 'string'], [N_('Sub Device ID'), 'pci.sub_device_id', 'string']
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
                this._found(run, 'gpu', {key: cardName + '/name', label: N_('Vendor'), format: 'string', heading: heading(),
                    value: cardName, status: 'ready', updated: now()});
                for (let [label, field, format] of nvidiaStaticFields) {
                    if (part(field) == 'N/A' || part(field) == '[N/A]') continue;
                    this._found(run, 'gpu', {key: cardName + '/' + field, label, format, heading: heading(),
                        value: format == 'string' ? part(field) : Number(part(field)), status: 'ready', updated: now()});
                }
                let generation = part('pcie.link.gen.max');
                let width = part('pcie.link.width.max');
                if (Number.isFinite(Number(generation)) && Number.isFinite(Number(width)))
                    this._found(run, 'gpu', {key: cardName + '/pcie.link.max', label: N_('Maximum Link Speed'), format: 'pcie',
                        heading: heading(), value: generation + 'x' + width, status: 'ready', updated: now()});
            }
            let hasTemperature = false;
            for (let [label, field, format] of [
                [N_('Fan'), 'fan.speed', 'percent'], [N_('Temperature'), 'temperature.gpu', 'temp'],
                [N_('Memory Temperature'), 'temperature.memory', 'temp'],
                [N_('Memory Total'), 'memory.total', 'memory'], [N_('Memory Used'), 'memory.used', 'memory'],
                [N_('Memory Reserved'), 'memory.reserved', 'memory'], [N_('Memory Free'), 'memory.free', 'memory'],
                [N_('Memory Utilization'), 'utilization.memory', 'percent'], [N_('Utilization'), 'utilization.gpu', 'percent'],
                [N_('Encoder Utilization'), 'utilization.encoder', 'percent'],
                [N_('Decoder Utilization'), 'utilization.decoder', 'percent'],
                [N_('Frequency'), 'clocks.gr', 'hertz'], [N_('Memory Frequency'), 'clocks.mem', 'hertz'],
                [N_('Encoder/Decoder Frequency'), 'clocks.video', 'hertz'],
                [N_('Power'), 'power.draw.instant', 'watt-gpu'], [N_('Average Power'), 'power.draw.average', 'watt-gpu']
            ]) {
                let found = await this._foundWithHideZeros(run, 'gpu', {key: cardName + '/' + field, label, format, heading: heading(),
                    nvidia: uuid, field, ...(field == 'memory.free' && LOW_IS_BAD)}, this._source(NVIDIA.id), NVIDIA.value,
                    () => Number(part(field)));
                if (field == 'temperature.gpu')
                    hasTemperature = found;
            }
            this._found(run, 'gpu', {key: cardName + '/memory-usage', label: N_('Memory Usage'), format: 'percent', heading: heading(),
                nvidia: uuid, field: 'memory.used,memory.total'}, this._source(NVIDIA.id), NVIDIA.value);
            this._found(run, 'gpu', {key: cardName + '/link-speed', label: N_('Link Speed'), format: 'pcie', heading: heading(),
                nvidia: uuid, field: 'pcie.link.gen.gpucurrent,pcie.link.width.current'}, this._source(NVIDIA.id), NVIDIA.value);
            // Also among the temperatures, where it counts in their average.
            if (hasTemperature)
                this._found(run, 'temperature', {key: cardName + '/temperature.gpu', format: 'temp', nvidia: uuid,
                    label: nvidiaCards.length > 1 ? heading() : N_('GPU'), field: 'temperature.gpu'}, this._source(NVIDIA.id), NVIDIA.value);
        }

        for (let {devicePath, vendor, files} of otherCards) {
            cardNumber++;
            if (staticInfo) {
                let vendors = {'0x1002': 'AMD', '0x10de': 'NVIDIA', '0x13b5': 'ARM',
                    '0x5143': 'Qualcomm', '0x8086': 'Intel', '0x1234': 'QEMU'};
                this._found(run, 'gpu', {key: vendor + '/vendor', label: N_('Vendor'), format: 'string', heading: heading(),
                    value: vendors[vendor] || vendor, status: 'ready', updated: now()});
            }
            for (let [label, file, format] of [
                [N_('Usage'), 'gpu_busy_percent', 'percent'],
                [N_('Memory Used'), 'mem_info_vram_used', 'memory'],
                [N_('Memory Total'), 'mem_info_vram_total', 'memory']
            ]) {
                if (files.includes(file))
                    this._found(run, 'gpu', {key: vendor + '/' + file, label, format, heading: heading(), file: devicePath + file},
                        this._source(devicePath + file), reading => FILE_VALUE[format](reading.value));
            }
        }
        this._foundSource(run, FRAMES);
    }

    // A running process that asks for the same fields, cards and interval keeps running.
    _configureNvidia(activeSensors) {
        let requested = activeSensors.filter(sensor => sensor.nvidia);
        // `uuid` first: it tells which card a line is for.
        let fields = ['uuid', ...[...new Set(requested.flatMap(sensor => sensor.field.split(',')))].sort()];
        let uuids = [...new Set(requested.map(sensor => sensor.nvidia))].sort();
        let interval = this._settings.get_int('update-time');
        let signature = [fields.join(','), uuids.join(','), interval].join(';');
        if (this._nvidia && this._nvidia.signature == signature && !this._nvidia.error) return;
        this._stopReading(NVIDIA.id);
        // The last process's reading can lack the new fields.
        let source = this.sources.get(NVIDIA.id);
        if (source.reading)
            source.reading = {...source.reading, status: 'pending'};
        let process;
        try {
            process = Gio.Subprocess.new([
                'nvidia-smi', '--query-gpu=' + fields.join(','), '--id=' + uuids.join(','),
                '--format=csv,noheader,nounits', '-l', String(interval)
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (error) {
            this._nvidia = {error};
            return;
        }
        let state = {
            process, signature, fields, uuids, cancellation: new Gio.Cancellable(),
            stream: new Gio.DataInputStream({base_stream: process.get_stdout_pipe()}),
            rows: new Map(), latest: null, waiter: null, error: null
        };
        this._nvidia = state;
        let read = () => state.stream.read_line_async(GLib.PRIORITY_DEFAULT, state.cancellation, (stream, result) => {
            // The process was stopped while this line was read.
            if (this._nvidia != state) {
                closeNvidiaStream(stream);
                return;
            }
            try {
                let [line] = stream.read_line_finish_utf8(result);
                if (line === null) throw new Error('nvidia-smi stopped producing readings');
                let parts = line.split(',').map(part => part.trim());
                if (parts.length != fields.length) throw new Error('Incomplete nvidia-smi reading: ' + line);
                state.rows.set(parts[0], Object.fromEntries(fields.map((field, index) => [field, parts[index]])));
                // One line per card makes a reading.
                if (state.rows.size == uuids.length) {
                    let sample = {gpus: state.rows, time: clock()};
                    state.rows = new Map();
                    if (state.waiter) {
                        state.waiter.resolve(sample);
                        state.waiter = null;
                    } else {
                        state.latest = sample;
                    }
                }
                read();
            } catch (error) {
                state.error = error;
                if (state.waiter) {
                    state.waiter.reject(error);
                    state.waiter = null;
                }
            }
        });
        read();
    }

    // The latest reading, or the next one when none has come since the last read.
    _readNvidia() {
        let state = this._nvidia;
        if (state.error) return Promise.reject(state.error);
        if (state.latest) {
            let sample = state.latest;
            state.latest = null;
            return Promise.resolve(sample);
        }
        return new Promise((resolve, reject) => { state.waiter = {resolve, reject}; });
    }

    _stopNvidia() {
        let state = this._nvidia;
        if (!state) return;
        this._nvidia = null;
        // A process that could not be started.
        if (!state.process) return;
        state.cancellation.cancel();
        state.process.force_exit();
        if (state.waiter) state.waiter.reject(new Error('GPU collection stopped'));
        // A read under way closes the stream itself; after an error, none is.
        if (state.error)
            closeNvidiaStream(state.stream);
    }

    // Shows a window that redraws all the time without visibly changing. With several monitors, a frame counts once per
    // monitor.
    _startFrames() {
        this._frameSignal = global.stage.connect('after-paint', () => this._frames++);
    }

    _stopFrames() {
        if (this._frameSignal) {
            global.stage.disconnect(this._frameSignal);
            this._frameSignal = 0;
        }
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
