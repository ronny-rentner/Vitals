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
import {readCatalog, writeCatalog, sensorPresent} from './helpers/storedCatalog.js';

const MEMINFO = '/proc/meminfo';
const STAT = '/proc/stat';
const CPUINFO = '/proc/cpuinfo';
const UPTIME = '/proc/uptime';
const LOADAVG = '/proc/loadavg';
const OPEN_FILES = '/proc/sys/fs/file-nr';
const DISKSTATS = '/proc/diskstats';
const ARCSTATS = '/proc/spl/kstat/zfs/arcstats';
const WIRELESS = '/proc/net/wireless';
const NETWORK = '/proc/net/dev';
const MOUNTS = '/proc/self/mountinfo';
// The sources that are not one file whose content is read as it is.
const CPU_FREQUENCIES = 'cpu-frequencies';
const PUBLIC_IP = 'public-ip';
const FRAMES = 'frames';
const NVIDIA = 'nvidia';
// A reading taken when its sensor came on screen can be followed by a tick at once. A rate over less time than this
// says nothing.
const SHORTEST_RATE_SECONDS = 0.5;
// A rate has no value after the first reading of its source. The second reading follows this much later and does
// not wait for the next tick, which can be a minute away.
const SECOND_READING_SECONDS = 1;
// How the content of a file is taken apart, for the files that hold more than one number.
const PARSERS = {
    [MEMINFO]: SensorMath.parseMemory,
    [STAT]: SensorMath.parseCpuStat,
    [CPUINFO]: text => text,
    [UPTIME]: text => SensorMath.splitFields(text).map(Number),
    [LOADAVG]: SensorMath.splitFields,
    [OPEN_FILES]: text => Number.parseInt(text),
    [DISKSTATS]: text => new Map(text.split('\n').map(line => {
        let fields = SensorMath.splitFields(line);
        return [fields[0] + ':' + fields[1], {read: Number(fields[5]) * 512, write: Number(fields[9]) * 512}];
    })),
    [ARCSTATS]: text => Object.fromEntries(text.split('\n').map(line => {
        let fields = SensorMath.splitFields(line);
        return [fields[0], Number(fields[2])];
    })),
    [WIRELESS]: text => {
        let lines = text.split('\n').slice(2).filter(line => line.trim());
        if (!lines.length) return {};
        let fields = SensorMath.splitFields(lines[lines.length - 1]);
        return {quality: Number(fields[2]) / 70, signal: Number(fields[3])};
    }
};
const PUBLIC_IP_URLS = ['https://ipv4.corecoding.com', 'https://api.myip.com', 'https://api.ipify.org?format=json'];
// Thermal zone types that are control interfaces, not sensors.
// INT3400 is Intel's thermal policy switch; its zone reports a fixed dummy temperature.
const NON_SENSOR_THERMAL_ZONE_LABELS = ['INT3400 Thermal'];
// Thermal zones that report what an hwmon driver also reports: zone label to that driver's hwmon name.
// Such a zone is left out while the hwmon device exists. x86_pkg_temp and coretemp both report the CPU package temperature.
const THERMAL_ZONE_HWMON_EQUIVALENTS = {x86_pkg_temp: 'coretemp'};
// A saved reading is shown at start when it is at most this old, as after the screen was locked for a moment.
// An older one says nothing about now, and "…" is shown until the first reading.
const SAVED_READING_SECONDS = 60;
// A sensor that is not in the panel is dropped from the catalog when no discovery has found it for this long.
const FORGET_AFTER_SECONDS = 365 * 86400;

// The number in a sensor's file, converted to the unit of the sensor's format.
const FILE_VALUE = {
    'temp': number => number / 1000, 'in': number => number / 1000, 'fan': number => number,
    'watt-limit': number => number / 1000000, 'percent': number => number * 0.01, 'memory': number => number
};
// What one unit of an nvidia-smi field is, in the unit of the sensor's format.
const NVIDIA_SCALE = {'percent': 0.01, 'temp': 1, 'memory': 1048576, 'hertz': 1000000, 'watt-gpu': 1};
// The categories whose sensors are summarised, with the format of the summary. Voltage is not among them: an
// average, minimum or maximum over a battery, a system rail and a USB supply says nothing.
const AGGREGATED = {temperature: 'temp', fan: 'fan'};
const AGGREGATES = {
    // The power rate of all batteries together, on a machine that has more than one.
    'total-power-rate': SensorMath.sum,
    average: SensorMath.average,
    minimum: sensors => Math.min(...sensors.map(sensor => sensor.value)),
    maximum: sensors => Math.max(...sensors.map(sensor => sensor.value))
};
// The sections of the network menu, in the order they are shown. A network sensor names its section; the rows of
// one section stay together, whatever the labels are.
const NETWORK_SECTION = {machineSpeed: 1, hardwareInterfaces: 2, volume: 3, other: 4, virtualInterfaces: 5};
// What an interface that is hardware is called, by the DEVTYPE the kernel reports for it. A network card reports none.
// "WiFi" is spelled as in the two WiFi labels below, which 22 translations are filed under.
const HARDWARE_INTERFACE_KINDS = {wlan: 'WiFi', wwan: 'Mobile'};
// The sensor whose value a category shows in its menu header. Temperature, voltage, fan, storage, battery and gpu choose theirs in _chooseHeader.
const HEADER_KEYS = {
    memory: 'usage', processor: 'usage', system: 'load-1m', network: 'device-rx'
};

// A sensor that is found by its key alone: what the catalog says about it, and how its value follows from the
// reading of its source. `source` is the file the sensor is read from, which becomes its `file` field, or one of
// the sources that are not a file. An entry without a source gets its file, its storage location or its value from
// discovery. An entry without `value` follows the rule for its fields (see Sensors._value).
function fixed(label, format, source, value, fields = {}) {
    let catalogFields = {label, format, ...fields};
    if (source?.startsWith('/'))
        catalogFields.file = source;
    return {fields: catalogFields, source, value};
}

// A reading of the CPU frequencies is the text of /proc/cpuinfo, or the list that the frequency files gave.
function cpuFrequencies(sample) {
    return Array.isArray(sample.value) ? sample.value :
        sample.value.split('\n').filter(line => line.split(':')[0].trim() == 'cpu MHz')
            .map(line => Number(line.slice(line.indexOf(':') + 1)) * 1000000);
}

// The speed of the hardware interfaces together, in the given directions.
function hardwareSpeed(sample, sensors, directions) {
    let hardwareInterfaces = [...sensors._hardwareInterfaces()];
    let speeds = directions.flatMap(direction => hardwareInterfaces.map(name =>
        SensorMath.counterRate(sample, value => value.interfaces.get(name)?.[direction])));
    if (speeds.includes(undefined)) return undefined;
    if (speeds.includes(SensorMath.PENDING)) return SensorMath.PENDING;
    return speeds.reduce((total, speed) => total + speed, 0);
}

// The field of a sensor whose low values are the ones to watch, such as what is left of something. A colour scale
// on such a sensor colours downwards from its breakpoints; on every other sensor, upwards.
const LOW_IS_BAD = {lowIsBad: true};

const FIXED = {
    memory: {
        'physical': fixed('Physical', 'memory', MEMINFO, s => s.value.MemTotal),
        'available': fixed('Available', 'memory', MEMINFO, s => s.value.MemAvailable, LOW_IS_BAD),
        'cached': fixed('Cached', 'memory', MEMINFO, s => s.value.Cached),
        'free': fixed('Free', 'memory', MEMINFO, s => s.value.MemFree, LOW_IS_BAD),
        'swap-total': fixed('Swap Total', 'memory', MEMINFO, s => s.value.SwapTotal),
        'swap-free': fixed('Swap Free', 'memory', MEMINFO, s => s.value.SwapFree, LOW_IS_BAD),
        'allocated': fixed('Allocated', 'memory', MEMINFO, s => s.value.MemTotal - s.value.MemAvailable),
        'usage': fixed('Usage', 'percent', MEMINFO, s => (s.value.MemTotal - s.value.MemAvailable) / s.value.MemTotal),
        'swap-used': fixed('Swap Used', 'memory', MEMINFO, s => s.value.SwapTotal - s.value.SwapFree),
        'swap-usage': fixed('Swap Usage', 'percent', MEMINFO, s =>
            s.value.SwapTotal ? (s.value.SwapTotal - s.value.SwapFree) / s.value.SwapTotal : 0)
    },
    processor: {
        'usage': fixed('Usage', 'percent', STAT),
        'frequency': fixed('Frequency', 'hertz', CPU_FREQUENCIES, s => {
            let frequencies = cpuFrequencies(s);
            return frequencies.reduce((sum, frequency) => sum + frequency, 0) / frequencies.length;
        }, {icon: 'frequency'}),
        'min-frequency': fixed('Min frequency', 'hertz', CPU_FREQUENCIES, s => Math.min(...cpuFrequencies(s)), {icon: 'frequency'}),
        'max-frequency': fixed('Max frequency', 'hertz', CPU_FREQUENCIES, s => Math.max(...cpuFrequencies(s)), {icon: 'frequency'}),
        'process-time': fixed('Process Time', 'uptime', UPTIME, (s, sensor, sensors) =>
            s.value[0] - s.value[1] / sensors._cores().length),
        'powercap': fixed('Powercap', 'watt-limit', undefined, undefined, {icon: 'power'}),
        'vendor': fixed('Vendor', 'string'),
        'bogomips': fixed('Bogomips', 'string'),
        'sockets': fixed('Sockets', 'string'),
        'cache': fixed('Cache', 'memory')
    },
    system: {
        'load-1m': fixed('Load 1m', 'load', LOADAVG, s => Number(s.value[0])),
        'load-5m': fixed('Load 5m', 'load', LOADAVG, s => Number(s.value[1])),
        'load-15m': fixed('Load 15m', 'load', LOADAVG, s => Number(s.value[2])),
        'threads-active': fixed('Threads Active', 'string', LOADAVG, s => Number(s.value[3].split('/')[0])),
        'threads-total': fixed('Threads Total', 'string', LOADAVG, s => Number(s.value[3].split('/')[1])),
        'open-files': fixed('Open Files', 'string', OPEN_FILES, s => s.value),
        'uptime': fixed('Uptime', 'uptime', UPTIME, s => s.value[0]),
        'lap-mode': fixed('Lap mode', 'string', undefined,
            (s, sensor, sensors) => sensors._gettext(s.value == 1 ? 'on' : 'off')),
        'kernel': fixed('Kernel', 'string')
    },
    network: {
        'combined': fixed('Total speed', 'speed', NETWORK, (s, sensor, sensors) => hardwareSpeed(s, sensors, ['rx', 'tx']),
            {section: NETWORK_SECTION.machineSpeed}),
        // The two WiFi values are with the hardware interfaces, next to the WiFi interface's speeds.
        'wifi-link-quality': fixed('WiFi Link Quality', 'percent', WIRELESS, s => s.value.quality,
            {section: NETWORK_SECTION.hardwareInterfaces, ...LOW_IS_BAD}),
        'wifi-signal-level': fixed('WiFi Signal Level', 'string', WIRELESS, s => s.value.signal,
            {section: NETWORK_SECTION.hardwareInterfaces}),
        'public-ip': fixed('Public IP', 'string', PUBLIC_IP, (s, sensor) => {
            // The renderer shows this country's flag next to the address.
            sensor.country = s.value.country;
            return s.value.ip;
        }, {section: NETWORK_SECTION.other})
    },
    storage: {
        'total': fixed('Total', 'storage', undefined, s => s.value.total),
        'used': fixed('Used', 'storage', undefined, s => s.value.used),
        'free': fixed('Free', 'storage', undefined, s => s.value.free, LOW_IS_BAD),
        'reserved': fixed('Reserved', 'storage', undefined, s => s.value.total - s.value.used - s.value.free),
        'used-percent': fixed('Used %', 'percent', undefined, s => s.value.used / s.value.total),
        'free-percent': fixed('Free %', 'percent', undefined, s => (s.value.total - s.value.used) / s.value.total, LOW_IS_BAD),
        'read-total': fixed('Read total', 'storage', DISKSTATS, (s, sensor) => s.value.get(sensor.device)?.read,
            {icon: 'read'}),
        'read-rate': fixed('Read rate', 'storage-rate', DISKSTATS, (s, sensor) =>
            SensorMath.counterRate(s, disks => disks.get(sensor.device)?.read), {icon: 'read'}),
        'write-total': fixed('Write total', 'storage', DISKSTATS, (s, sensor) => s.value.get(sensor.device)?.write,
            {icon: 'write'}),
        'write-rate': fixed('Write rate', 'storage-rate', DISKSTATS, (s, sensor) =>
            SensorMath.counterRate(s, disks => disks.get(sensor.device)?.write), {icon: 'write'}),
        'arc-target': fixed('ARC Target', 'storage', ARCSTATS, s => s.value.c),
        'arc-maximum': fixed('ARC Maximum', 'storage', ARCSTATS, s => s.value.c_max),
        'arc-current': fixed('ARC Current', 'storage', ARCSTATS, s => s.value.size)
    },
    battery: {
        'state': fixed('State', 'string', undefined, s => s.value.state),
        'cycles': fixed('Cycles', 'string', undefined, s => s.value.cycles),
        'voltage': fixed('Voltage', 'in', undefined, s => s.value.voltage),
        'level': fixed('Level', 'string', undefined, s => s.value.level),
        'percentage': fixed('Percentage', 'percent', undefined, s => s.value.percentage, LOW_IS_BAD),
        'power-rate': fixed('Power Rate', 'watt', undefined, s => s.value.power),
        'energy-full': fixed('Energy (full)', 'watt-hour', undefined, s => s.value.full),
        'energy-design': fixed('Energy (design)', 'watt-hour', undefined, s => s.value.design),
        'energy-now': fixed('Energy (now)', 'watt-hour', undefined, s => s.value.now, LOW_IS_BAD),
        'capacity': fixed('Capacity', 'percent', undefined, s => s.value.full / s.value.design, LOW_IS_BAD),
        'time-left': fixed('Time left', 'runtime', undefined, (s, sensor, sensors) => sensors._batteryTimeLeft(s, sensor.file), LOW_IS_BAD)
    },
    gpu: {
        'refresh-rate': fixed('Refresh Rate', 'hertz', FRAMES, s => s.value)
    }
};
for (let [direction, moving, moved] of [['rx', 'Download', 'Downloaded'], ['tx', 'Upload', 'Uploaded']]) {
    // The network totals are over the hardware interfaces. What a virtual interface carries, such as a bridge, a
    // container's or a VPN's, passes a hardware interface as well when it leaves the machine, and would count twice.
    FIXED.network['device-' + direction] = fixed(moving + ' speed', 'speed', NETWORK,
        (s, sensor, sensors) => hardwareSpeed(s, sensors, [direction]), {direction, section: NETWORK_SECTION.machineSpeed});
    // An interface the catalog has can be missing from a reading for the moment in which it is unplugged.
    FIXED.network['boot-' + direction] = fixed(moved + ' since boot', 'storage', NETWORK,
        (s, sensor, sensors) => [...sensors._hardwareInterfaces()].reduce((bytes, name) =>
            bytes + (s.value.interfaces.get(name)?.[direction] ?? 0), 0),
        {direction, section: NETWORK_SECTION.volume});
    FIXED.network['session-' + direction] = fixed(moved + ' this session', 'storage', NETWORK,
        s => s.value.session[direction], {direction, section: NETWORK_SECTION.volume});
}
// The fields of a battery's uevent file, as SensorMath.parseBattery names them, and the sensor each one becomes.
const BATTERY_FIELD_KEYS = {
    state: 'state', cycles: 'cycles', voltage: 'voltage', level: 'level', percentage: 'percentage', power: 'power-rate',
    full: 'energy-full', design: 'energy-design', now: 'energy-now'
};

// The collector. It knows every sensor, reads the ones that are shown, and saves the catalog. The catalog is plain
// data, described in docs/catalog-design.md: categories with their sensors, and the panel as a category of links.
export class Sensors {
    constructor(settings, gettext) {
        // Seconds that only move forward, for the time between two readings.
        this.clock = () => GLib.get_monotonic_time() / 1000000;
        // Seconds of calendar time, for the timestamps that are saved with the catalog.
        this.now = () => GLib.get_real_time() / 1000000;
        this.createCancellation = () => new Gio.Cancellable();
        // Calls `callback` once after so many seconds. What it returns calls that off when given to `unschedule`.
        this.schedule = (seconds, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this.unschedule = scheduled => GLib.Source.remove(scheduled);
        // Everything that is read, by its id: a file's path, or the name of a source that is not a file. Each holds
        // how it is read, its last reading, the read that is under way, and a second reading that is scheduled.
        this.sources = new Map();
        // The sources that are read at the moment, each with the sensors that are written from its reading, as
        // pairs of category name and sensor.
        this.activeSources = new Map();
        // The names of the categories that show a value over all their sensors at the moment (see _select).
        this.summarised = new Set();
        // The reads that each of those categories waits for before it writes that value (see _readSources).
        this.summaryReads = new Map();
        this.destroyed = false;
        this.onCatalogChanged = () => {};
        this.onValuesChanged = () => {};
        this.onError = (id, error) => console.error(id, error);
        this._settings = settings;
        this._gettext = gettext;
        this._discovery = null;
        this._discoveryCancellation = new Gio.Cancellable();
        this._commands = new Set();
        this._nvidia = null;
        this._frameSignal = 0;
        this._frameTimes = [];
        // For each battery file, the charging state it is in and its last readings of the time left in that state.
        this._batteryTimes = new Map();
        // The read of the mount table that is under way, which every storage location of a tick waits for.
        this._mountTableRead = null;
        this._registerSystemSources();
        this.catalog = this._load();
        // The timestamp of the latest discovery run. Every run gets a later one.
        this._lastRun = Math.max(0, ...this.categories().map(([, category]) => category.discovered ?? 0));
    }

    // Reads the saved catalog. The header of a category and the links in the panel are saved as keys and become
    // the sensors themselves here.
    _load() {
        let saved = readCatalog(this._settings);
        let catalog = {};
        for (let name of Object.keys(sensorCategories)) {
            let {header, sensors = [], ...category} = saved[name];
            // 'saved' is a recent reading from the session before. It is shown like a 'ready' one until this session has its own.
            for (let sensor of sensors)
                sensor.status = this.now() - sensor.updated <= SAVED_READING_SECONDS ? 'saved' : 'pending';
            catalog[name] = {...category, sensors, header: sensors.find(sensor => sensor.key == header)};
        }
        catalog.panel = {sensors: saved.panel.sensors.map(({category, key, visible}) => {
            let sensors = catalog[category].sensors;
            let sensor = sensors.find(candidate => candidate.key == key);
            // A link to a sensor that was never found keeps its place. Discovery fills the sensor in when it finds it.
            if (!sensor) {
                sensor = {key, status: 'pending'};
                sensors.push(sensor);
            }
            return {category, sensor, visible};
        })};
        return catalog;
    }

    // Writes the catalog as it is, except for what only means something while the extension runs.
    _save() {
        // The preferences window switches categories on and off in the saved catalog. That part is its own, so
        // what it wrote is kept even when this.catalog has not taken it over yet (see reloadEnabled).
        let saved = readCatalog(this._settings);
        let catalog = {};
        for (let [name, category] of this.categories()) {
            catalog[name] = {
                ...category, enabled: saved[name].enabled, shown: undefined, header: category.header?.key,
                sensors: category.sensors.map(({shown, status, initialTemperature, ...sensor}) => sensor)
            };
        }
        catalog.panel = {sensors: this.catalog.panel.sensors.map(link =>
            ({category: link.category, key: link.sensor.key, visible: link.visible}))};
        writeCatalog(this._settings, catalog);
    }

    // Takes over which categories are switched on from the saved catalog. Returns whether any of them changed.
    reloadEnabled() {
        let saved = readCatalog(this._settings);
        let changed = false;
        for (let [name, category] of this.categories()) {
            if (category.enabled != saved[name].enabled) {
                category.enabled = saved[name].enabled;
                changed = true;
            }
        }
        return changed;
    }

    // The sensor categories with their names. The panel is not among them: it holds links, not sensors.
    categories() {
        return Object.entries(this.catalog).filter(([name]) => name != 'panel');
    }

    // Whether a panel link has a top-bar item: it is visible, its sensor is on the machine, and that sensor's
    // category is switched on.
    linkShown(link) {
        let category = this.catalog[link.category];
        return link.visible && category.enabled && sensorPresent(category, link.sensor);
    }

    // A sensor shown for the first time goes to the end of the panel; one that is hidden keeps its place.
    setPanelSensorVisible(categoryName, sensor, visible) {
        let links = this.catalog.panel.sensors;
        let link = links.find(candidate => candidate.sensor == sensor);
        if (link)
            link.visible = visible;
        else
            links.push({category: categoryName, sensor, visible});
        this._save();
    }

    // Gives a sensor the name the user typed for it, or its own label again when the name is empty.
    renameSensor(sensor, customLabel) {
        sensor.customLabel = customLabel || undefined;
        this._save();
        this.catalogChanged();
    }

    // Takes a sensor out of the menu, or puts it back. A hidden sensor also does not count in the average, minimum
    // and maximum of its category.
    setSensorHidden(sensor, hidden) {
        sensor.hidden = hidden || undefined;
        this._save();
        this.catalogChanged();
    }

    // Makes a sensor the one its category shows in its header. Without a sensor, the choice is the collector's again.
    setCategoryDefault(categoryName, sensor = null) {
        let category = this.catalog[categoryName];
        for (let candidate of category.sensors)
            candidate.categoryDefault = candidate == sensor || undefined;
        category.header = this._chooseHeader(categoryName);
        this._save();
        this.catalogChanged();
    }

    // Saves the order the user gave the categories in the menu.
    setCategoryOrder(categoryNames) {
        for (let [position, name] of categoryNames.entries())
            this.catalog[name].position = position;
        this._save();
    }

    // Moves a panel link in front of another one, or to the end when no other is given.
    movePanelLink(link, beforeLink = null) {
        let links = this.catalog.panel.sensors;
        links.splice(links.indexOf(link), 1);
        links.splice(beforeLink === null ? links.length : links.indexOf(beforeLink), 0, link);
        this._save();
    }

    addSource(id, definition) {
        if (this.sources.has(id)) {
            Object.assign(this.sources.get(id), definition);
        } else {
            this.sources.set(id, {interval: 0, ...definition, pending: null});
        }
    }

    // The current reading of a source: its value, its time and its status.
    reading(id) {
        return this.sources.get(id)?.reading;
    }

    catalogChanged() {
        if (this.destroyed) return;
        this.onCatalogChanged();
        this._select();
        this.onValuesChanged(this._writeActive());
        this._readNewlyShown();
    }

    // The renderer calls this after it changed which sensors and headers are marked `shown`.
    // What came on screen is read at once: the next tick can be a whole update interval away. A source nobody
    // shows any more, such as the nvidia-smi process, is stopped at once as well.
    shownChanged() {
        this._select();
        this._writeActive();
        this._readNewlyShown();
    }

    // The temperatures, voltages or fan speeds of a category that are read from the machine and that the user has
    // not hidden, without the average, minimum and maximum that temperatures and fans have over them.
    _measured(category) {
        return category.sensors.filter(sensor => sensorPresent(category, sensor) && !sensor.aggregate && !sensor.hidden);
    }

    // The names of the network interfaces that are hardware, such as a network card or a Wi-Fi adapter.
    _hardwareInterfaces() {
        let network = this.catalog.network;
        return new Set(network.sensors.filter(sensor => sensor.hardware && sensorPresent(network, sensor))
            .map(sensor => sensor.interface));
    }

    // The names of the processor's cores, as /proc/stat has them: "cpu0", "cpu1".
    _cores() {
        let processor = this.catalog.processor;
        return processor.sensors.filter(sensor => sensorPresent(processor, sensor) && sensor.core && sensor.core != 'cpu')
            .map(sensor => sensor.core);
    }

    // The id of the source a sensor is read from: its file, or a source that is not a file, which for the space of
    // a storage location is the location. A sensor whose value discovery wrote, such as the kernel version, has
    // none, and neither has an average, minimum or maximum.
    _sourceOf(categoryName, sensor) {
        return sensor.file ?? (sensor.nvidia ? NVIDIA : (sensor.location ?? this._fixed(categoryName, sensor)?.source));
    }

    // The sensor's entry in the FIXED table, if it has one. A machine can have several batteries and several
    // storage locations, so their sensors have the battery's name or the location in their key, and name their
    // entry in `field`.
    _fixed(categoryName, sensor) {
        return FIXED[categoryName]?.[sensor.field ?? sensor.key];
    }

    // A sensor's value, from the reading of its source. The catalog holds no functions; which rule applies
    // follows from the category and the sensor's fields alone.
    _value(categoryName, sensor, reading) {
        let known = this._fixed(categoryName, sensor);
        if (known?.value)
            return known.value(reading, sensor, this);
        if (sensor.interface) {
            // The loopback interface has one sensor without a direction, which shows the bytes it has transferred.
            return sensor.direction
                ? SensorMath.counterRate(reading, value => value.interfaces.get(sensor.interface)?.[sensor.direction])
                : reading.value.interfaces.get(sensor.interface)?.tx;
        }
        if (sensor.core)
            return SensorMath.cpuUsage(reading, sensor.core);
        if (sensor.nvidia) {
            let gpu = reading.value.gpus.get(sensor.nvidia);
            let [first, second] = sensor.field.split(',').map(field => Number(gpu?.[field]));
            if (sensor.format == 'pcie')
                return Number.isFinite(first) && Number.isFinite(second) ? first + 'x' + second : undefined;
            return second === undefined ? first * NVIDIA_SCALE[sensor.format] : first / second;
        }
        return FILE_VALUE[sensor.format](reading.value);
    }

    // Goes over the catalog once and works out what is read: the source of every sensor that is on screen, with
    // the sensors that are written from its reading. A category that shows a value over all its sensors, an
    // average, minimum or maximum, has all of them read.
    _select() {
        let activeSources = new Map();
        let summarised = new Set();
        if (!this.destroyed) {
            for (let [name, category] of this.categories()) {
                let onScreen = sensor => (sensor.shown || (category.shown && sensor == category.header)) &&
                    sensorPresent(category, sensor);
                if (category.sensors.some(sensor => sensor.aggregate && onScreen(sensor)))
                    summarised.add(name);
                for (let sensor of category.sensors) {
                    let summarisedSensor = summarised.has(name) && sensorPresent(category, sensor) && !sensor.hidden;
                    if (!onScreen(sensor) && !summarisedSensor) continue;
                    let id = this._sourceOf(name, sensor);
                    if (id === undefined) continue;
                    if (!this.sources.has(id) && id == sensor.location) {
                        this.addSource(id, this._storageLocationSource(sensor));
                    } else if (!this.sources.has(id)) {
                        // A battery's file is at another path on every machine, so it is known by its category.
                        let parse = PARSERS[id] ?? (name == 'battery' ? SensorMath.parseBattery : Number);
                        this.addSource(id, {read: async cancellation => parse(await this._read(id, cancellation))});
                    }
                    if (!activeSources.has(id))
                        activeSources.set(id, []);
                    activeSources.get(id).push([name, sensor]);
                }
            }
        }

        for (let id of this.activeSources.keys()) {
            if (!activeSources.has(id))
                this._stopSource(id);
        }
        for (let [id, written] of activeSources) {
            let source = this.sources.get(id);
            if (!this.activeSources.has(id)) {
                // A reading still inside its interval stays as it is; reading the source again is not due yet.
                if (source.reading && !this._withinInterval(id))
                    source.reading = {...source.reading, status: 'pending'};
                if (source.start) source.start();
            }
            if (source.configure)
                source.configure(written.map(([, sensor]) => sensor));
        }
        this.activeSources = activeSources;
        this.summarised = summarised;
    }

    // Whether the source's last read, successful or failed, is younger than its interval.
    _withinInterval(id) {
        let source = this.sources.get(id);
        let sample = source.reading;
        let interval = typeof source.interval == 'function' ? source.interval() : source.interval;
        return sample !== undefined && sample.status != 'pending' && this.clock() - sample.time < interval;
    }

    _cancelRead(source) {
        if (source.pending) {
            source.pending.cancellation.cancel();
            source.pending = null;
        }
    }

    _stopSource(id) {
        let source = this.sources.get(id);
        this._cancelRead(source);
        this._callOffSecondReading(source);
        if (source.stop) source.stop();
    }

    _callOffSecondReading(source) {
        if (source.secondReading) {
            this.unschedule(source.secondReading);
            source.secondReading = null;
        }
    }

    // A tick: reads the sources of what is on screen whose reading is older than their interval. `force` reads
    // all of them.
    async poll(force = false) {
        // No sensor is read while a discovery run is in progress. This tick is skipped, not made up for later.
        if (this.destroyed || this._discovery) return;
        this._select();
        await this._readSources(id => force || !this._withinInterval(id));
    }

    // Reads what just came on screen, without waiting for a tick: the sources on screen that have no reading.
    // One that was read before has none when _select found its reading older than its interval.
    _readNewlyShown() {
        // Nothing is read during a discovery run. The run calls this when it ends.
        if (this._discovery) return;
        this._readSources(id => {
            let reading = this.sources.get(id).reading;
            return !reading || reading.status == 'pending';
        });
    }

    // Starts a read of every source on screen that is due, and ends when those and the reads under way are in.
    async _readSources(due) {
        let reads = [];
        for (let id of this.activeSources.keys()) {
            let source = this.sources.get(id);
            if (source.pending) {
                reads.push(source.pending.promise);
                continue;
            }
            if (!due(id))
                continue;

            let ticket = {cancellation: this.createCancellation()};
            source.pending = ticket;
            ticket.promise = Promise.resolve().then(() => {
                if (source.pending == ticket) return source.read(ticket.cancellation);
            }).then(value => {
                if (source.pending != ticket || this.destroyed) return;
                let time = source.sampleTime ? source.sampleTime(value) : this.clock();
                let last = source.reading;
                // A rate is computed against the last reading that succeeded, never across a failure or a stop, and
                // against the one before it when the last one is only a moment old.
                let previous = last?.status != 'ready' ? null
                    : time - last.time < SHORTEST_RATE_SECONDS ? last.previous : {value: last.value, time: last.time};
                source.reading = {value, time, status: 'ready', previous};
            }).catch(error => {
                if (source.pending != ticket || this.destroyed) return;
                let previous = source.reading;
                // A failed read is an expected state, handled by marking the reading unavailable. It is not an error.
                if (!previous || previous.status != 'unavailable')
                    console.debug(id, error);
                source.reading = {...previous, time: this.clock(), status: 'unavailable'};
            }).finally(() => {
                if (source.pending != ticket || this.destroyed) return;
                source.pending = null;
                let written = this._write(id);
                this.onValuesChanged(new Set(written));
                // A first reading that leaves a sensor without a value, as it does a rate, is followed by a second.
                // When a tick was first to bring the value, that second reading is called off.
                let withoutValue = written.some(sensor => sensor.status == 'pending' || sensor.status == 'saved');
                if (!withoutValue) {
                    this._callOffSecondReading(source);
                } else if (!source.reading.previous && !source.secondReading) {
                    source.secondReading = this.schedule(SECOND_READING_SECONDS, () => {
                        source.secondReading = null;
                        // No sensor is read during a discovery run, so the reading waits for the end of one.
                        let read = () => this._readSources(candidate => candidate == id);
                        Promise.resolve(this._discovery).then(read, read);
                    });
                }
            });
            reads.push(ticket.promise);
        }
        // What a category shows over all its sensors is written once, when the reads of its sensors are in.
        let summaries = [];
        for (let name of this.summarised) {
            let categoryReads = [...this.activeSources].filter(([, written]) => written.some(([categoryName]) => categoryName == name))
                .map(([id]) => this.sources.get(id).pending?.promise).filter(Boolean);
            if (!categoryReads.length) continue;
            this.summaryReads.set(name, categoryReads);
            summaries.push(Promise.all(categoryReads).then(() => {
                // Reads started since then have the category wait anew, so it is written once. A discovery run or
                // another choice of what is shown has called these reads off.
                if (this.summaryReads.get(name) != categoryReads || this.destroyed || this._discovery || !this.summarised.has(name)) return;
                this.onValuesChanged(new Set(this._summarise(name)));
            }));
        }
        await Promise.all([...reads, ...summaries]);
    }

    // Gives a sensor its new value. SensorMath.PENDING stands for none yet, such as a rate after its first counter
    // reading; anything that is not a value makes the sensor unavailable.
    _assign(sensor, value) {
        if (value === SensorMath.PENDING) {
            // A reading from an earlier session stays on screen while this session's first one is on its way.
            if (sensor.status != 'saved')
                sensor.status = 'pending';
        } else if (value === undefined || value === null || (typeof value == 'number' && !Number.isFinite(value))) {
            sensor.status = 'unavailable';
        } else {
            sensor.status = 'ready';
            sensor.value = value;
            sensor.updated = this.now();
        }
    }

    // Writes the sensors of a source from the reading it has, and returns them.
    _write(id) {
        let reading = this.sources.get(id).reading;
        return this.activeSources.get(id).map(([categoryName, sensor]) => {
            if (reading?.status == 'ready')
                this._assign(sensor, this._value(categoryName, sensor, reading));
            else
                this._assign(sensor, reading?.status == 'unavailable' ? undefined : SensorMath.PENDING);
            return sensor;
        });
    }

    // Writes what a category shows over all its sensors, and returns the sensors it wrote.
    _summarise(name) {
        let category = this.catalog[name];
        // The batteries' total is over their power rates; an average, minimum or maximum is over every sensor.
        // A sensor that cannot be read is left out, so one of them does not take the summary away.
        let readable = this._measured(category).filter(sensor =>
            sensor.status != 'unavailable' && (name != 'battery' || sensor.field == 'power-rate'));
        let pending = readable.some(sensor => sensor.status == 'pending');
        let aggregates = category.sensors.filter(sensor => sensor.aggregate && sensorPresent(category, sensor));
        for (let sensor of aggregates)
            this._assign(sensor, pending ? SensorMath.PENDING : AGGREGATES[sensor.key](readable));
        return aggregates;
    }

    // Writes every sensor that is read at the moment from the reading its source has, without reading anything,
    // and returns those sensors. The sensors of a source whose read is under way are written when it is in.
    _writeActive() {
        let written = new Set();
        for (let id of this.activeSources.keys()) {
            if (this.sources.get(id).pending) continue;
            for (let sensor of this._write(id))
                written.add(sensor);
        }
        for (let name of this.summarised) {
            for (let sensor of this._summarise(name))
                written.add(sensor);
        }
        return written;
    }

    // Reads a file, or the answer of an https address.
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
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (enumerator, result) => {
                try { enumerator.close_finish(result); }
                catch (error) { this.onError(directoryPath, error); }
            });
        }
    }

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

    // The time until the battery is full or empty, averaged over the last readings in the same charging state.
    _batteryTimeLeft(sample, batteryFile) {
        let value = SensorMath.batteryTime(sample.value);
        if (typeof value != 'number') return value;
        if (this._batteryTimes.get(batteryFile)?.state != sample.value.state)
            this._batteryTimes.set(batteryFile, {state: sample.value.state, times: []});
        let times = this._batteryTimes.get(batteryFile).times;
        if (!times.length || times[times.length - 1].time != sample.time) {
            times.push({value, time: sample.time});
            if (times.length > 10) times.shift();
        }
        return SensorMath.average(times);
    }

    // What is mounted where, as it is now. One read of the mount table serves every location that is read in the
    // same tick.
    _mountTable() {
        this._mountTableRead ??= this._read(MOUNTS, null).then(SensorMath.parseMountTable)
            .finally(() => { this._mountTableRead = null; });
        return this._mountTableRead;
    }

    // The space of one storage location. The kernel is asked once per location, so each is a source of its own.
    _storageLocationSource(sensor) {
        let location = sensor.location;
        let question = null;
        let mounted = true;
        return {
            // A network storage location is asked at the interval the user set, as the public IP is. One that
            // was found not mounted is looked for at every tick: that costs no question, and it can be back any time.
            interval: () => sensor.network && mounted ? this._settings.get_int('storage-network-interval') * 60 : 0,
            read: async () => {
                // Asking a path where nothing is mounted any more would connect an automounted share again, or
                // give the space of the disk that holds the empty directory.
                mounted = (await this._mountTable()).has(location);
                if (!mounted)
                    throw new Error('Nothing is mounted at ' + location);
                // A share whose server is gone can take minutes to answer, and a question cannot be taken back
                // from the kernel. So a location is not asked again while a question is out: its answer serves
                // the read that follows.
                question ??= new Promise((resolve, reject) => {
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
                }).finally(() => { question = null; });
                return question;
            }
        };
    }

    // The sources that are not one file whose content is read as it is. A file gets its source when it is first read (see _select).
    _registerSystemSources() {
        this.addSource(NETWORK, {read: async cancellation => {
            let interfaces = SensorMath.parseNetwork(await this._read(NETWORK, cancellation));
            // The session totals grow by what each interface transferred since the last reading of this file.
            let last = this.reading(NETWORK)?.value;
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
            // A discovery that is running reads the list itself.
            if (!this._discovery && (interfaces.size != knownInterfaces.size ||
                [...interfaces.keys()].some(name => !knownInterfaces.has(name))))
                await this._rediscoverNetwork(interfaces);
            return {interfaces, session};
        }});
        // One file per core, for a machine whose /proc/cpuinfo does not list the frequencies.
        this.addSource(CPU_FREQUENCIES, {read: cancellation => Promise.all(this._cores().map(async core =>
            Number(await this._read('/sys/devices/system/cpu/' + core + '/cpufreq/scaling_cur_freq', cancellation)) * 1000))});
        // The public-IP service the user chose.
        this.addSource(PUBLIC_IP, {
            // An answer is kept for the interval the user set, unless it is from another service than the one chosen now.
            interval: () => this.reading(PUBLIC_IP)?.value?.provider == this._settings.get_int('network-public-ip-provider')
                ? this._settings.get_int('network-public-ip-interval') * 60 : 0,
            read: async cancellation => {
                let provider = this._settings.get_int('network-public-ip-provider');
                let answer = JSON.parse(await this._read(PUBLIC_IP_URLS[provider], cancellation));
                let country = provider == 0 ? answer.countryCode : provider == 1 ? answer.cc : '';
                return {provider, ip: provider == 0 ? answer.IPv4 : answer.ip, country: (country || '').toLowerCase()};
            }
        });
        this.addSource(FRAMES, {
            start: () => this._startFrames(),
            stop: () => this._stopFrames(),
            read: async () => {
                if (this._frameTimes.length < 2) return SensorMath.PENDING;
                return (this._frameTimes.length - 1) /
                    (this._frameTimes[this._frameTimes.length - 1] - this._frameTimes[0]);
            }
        });
        this.addSource(NVIDIA, {
            configure: sensors => this._configureNvidia(sensors),
            stop: () => this._stopNvidia(),
            read: () => this._readNvidia(),
            sampleTime: sample => sample.time
        });
    }

    // The timestamp of a new discovery run: the current time, and always later than the run before, so that
    // "found in this run" can be told from "found in the last one" even when two runs start in the same second
    // or the system clock was set back.
    _startRun() {
        this._lastRun = Math.max(Math.floor(this.now()), this._lastRun + 1);
        return this._lastRun;
    }

    // The saved sensor with this key that the run has not matched yet. Two devices can have the same key, such as
    // two NVMe drives; each then takes one saved sensor, in the order in which they are found.
    _unmatched(run, categoryName, key) {
        return this.catalog[categoryName].sensors.find(sensor => sensor.key == key && sensor.discovered != run);
    }

    // Records a sensor the run found on the machine: the saved sensor with its key gets the current fields, or a
    // new sensor is added to the end of the category.
    _found(run, categoryName, fields) {
        let sensor = this._unmatched(run, categoryName, fields.key);
        if (!sensor) {
            sensor = {status: 'pending'};
            this.catalog[categoryName].sensors.push(sensor);
        }
        Object.assign(sensor, fields, {discovered: run});
    }

    _foundFixed(run, categoryName, key, fields = {}) {
        this._found(run, categoryName, {key, ...FIXED[categoryName][key].fields, ...fields});
    }

    // A value that does not change while the extension runs. Discovery writes it; nothing reads it again.
    _foundConstant(run, categoryName, key, value) {
        this._foundFixed(run, categoryName, key, {value, status: 'ready', updated: this.now()});
    }

    _sensorCount() {
        return this.categories().reduce((count, [, category]) => count + category.sensors.length, 0);
    }

    async discover() {
        if (this._discovery) return this._discovery;
        // No sensor is read during a run, so that none is read through a path the run is about to retire.
        // The readings taken so far stay, and the next rate is computed against them.
        for (let id of this.activeSources.keys())
            this._cancelRead(this.sources.get(id));
        let configuration = () => JSON.stringify([this.catalog.gpu.enabled, ...[
            'include-static-info', 'include-static-gpu-info', 'include-public-ip',
            'network-public-ip-provider', 'storage-locations', 'storage-monitor-volumes', 'hide-zeros'
        ].map(key => this._settings.get_value(key).deep_unpack())]);
        // Each step with the categories it feeds. A category is complete when every step that feeds it succeeded.
        let steps = [
            ['system', ['memory', 'processor', 'system'], run => this._discoverSystem(run)],
            ['hwmon', ['temperature', 'voltage', 'fan'], run => this._discoverHwmon(run)],
            ['network', ['network'], async run => {
                let interfaces = SensorMath.parseNetwork(await this._read('/proc/net/dev', this._discoveryCancellation));
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
                        if (!this.destroyed) this.onError('discover:' + stepName, error);
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
                category.header = this._chooseHeader(name);
            if (this._sensorCount() != sensorCountBefore)
                this._save();
            this.catalogChanged();
        })().finally(() => {
            this._discovery = null;
            // Nothing was read during the run, so what came on screen meanwhile is read now.
            this._readNewlyShown();
        });
        return this._discovery;
    }

    // Drops the sensors that no run has found for a year, except those in the panel.
    _forget() {
        let oldest = this.now() - FORGET_AFTER_SECONDS;
        let linked = new Set(this.catalog.panel.sensors.map(link => link.sensor));
        for (let [, category] of this.categories())
            category.sensors = category.sensors.filter(sensor => linked.has(sensor) || sensor.discovered >= oldest);
    }

    // The sensor a category shows in its menu header, among those that are present.
    _chooseHeader(categoryName) {
        let category = this.catalog[categoryName];
        let present = category.sensors.filter(sensor => sensorPresent(category, sensor));
        let withKey = key => present.find(sensor => sensor.key == key);
        // The sensor the user chose in the menu comes first, while it is on the machine.
        let chosen = present.find(sensor => sensor.categoryDefault);
        if (chosen) return chosen;
        switch (categoryName) {
            case 'temperature':
            case 'fan':
                // With one sensor there is no average row; the header then shows that sensor.
                return withKey('average') ?? this._measured(category)[0];
            case 'voltage':
                // The battery's voltage before the system's, and a USB supply's only when there is nothing else.
                return this._measured(category).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))[0];
            case 'battery':
                // With one battery there is no total row; the header then shows that battery's power rate.
                return withKey('total-power-rate') ?? present.find(sensor => sensor.field == 'power-rate');
            case 'storage':
                // The free space of the first location, which is "/" while that one is monitored.
                return present.find(sensor => sensor.field == 'free' && sensor.section == 1);
            case 'gpu':
                return present.find(sensor => sensor.field == 'utilization.gpu') ??
                    present.find(sensor => sensor.file?.endsWith('/gpu_busy_percent')) ?? withKey('refresh-rate');
            default:
                return withKey(HEADER_KEYS[categoryName]);
        }
    }

    async _discoverSystem(run) {
        for (let key of ['physical', 'available', 'cached', 'free', 'swap-total', 'swap-free', 'allocated', 'usage',
            'swap-used', 'swap-usage'])
            this._foundFixed(run, 'memory', key);

        let cores = SensorMath.parseCpuStat(await this._read('/proc/stat', this._discoveryCancellation));
        for (let core of cores.keys()) {
            if (core == 'cpu')
                this._foundFixed(run, 'processor', 'usage', {core});
            else
                this._found(run, 'processor', {key: core, format: 'percent', core, file: STAT,
                    label: this._gettext('Core %d').replace('%d', core.slice(3))});
        }
        let cpuInfo = await this._read('/proc/cpuinfo', this._discoveryCancellation);
        // Where /proc/cpuinfo does not list the frequencies, they are read from one file per core instead.
        let frequenciesFile = /^cpu MHz\s*:/m.test(cpuInfo) ? CPUINFO : undefined;
        for (let key of ['frequency', 'min-frequency', 'max-frequency'])
            this._foundFixed(run, 'processor', key, {file: frequenciesFile});
        this._foundFixed(run, 'processor', 'process-time');
        for (let key of ['load-1m', 'load-5m', 'load-15m', 'threads-active', 'threads-total', 'open-files', 'uptime'])
            this._foundFixed(run, 'system', key);

        for (let [categoryName, key, file] of [
            ['processor', 'powercap', '/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw'],
            ['system', 'lap-mode', '/sys/devices/platform/thinkpad_acpi/dytc_lapmode']
        ]) {
            if (await this._optionalRead(file) !== null)
                this._foundFixed(run, categoryName, key, {file});
        }

        if (this._settings.get_boolean('include-static-info')) {
            let field = name => cpuInfo.match(new RegExp('^' + name + '\\s*:\\s*(.+)$', 'm'))?.[1];
            let sockets = new Set([...cpuInfo.matchAll(/^physical id\s*:\s*(\d+)/gm)].map(match => match[1]));
            this._foundConstant(run, 'processor', 'vendor', field('vendor_id'));
            this._foundConstant(run, 'processor', 'bogomips', field('bogomips'));
            this._foundConstant(run, 'processor', 'sockets', sockets.size);
            this._foundConstant(run, 'processor', 'cache', Number.parseFloat(field('cache size')) * 1024);
            let kernel = (await this._read('/proc/version', this._discoveryCancellation)).split(' ')[2];
            this._foundConstant(run, 'system', 'kernel', kernel);
        }
    }

    // Records a sensor unless the hide-zeros option leaves it out: with the option on, a temperature is not recorded
    // until a discovery reads something other than zero for it. From then on it stays, also when it reads zero later.
    // Returns whether the sensor was recorded.
    async _foundWithHideZeros(run, categoryName, fields, readInitialTemperature) {
        let initialTemperature;
        if (fields.format == 'temp' && this._settings.get_boolean('hide-zeros')) {
            let known = this._unmatched(run, categoryName, fields.key);
            if (known && sensorPresent(this.catalog[categoryName], known))
                initialTemperature = known.initialTemperature;
            if (initialTemperature === undefined)
                initialTemperature = await readInitialTemperature();
            if (!Number.isFinite(initialTemperature) || initialTemperature === 0) return false;
        }
        this._found(run, categoryName, {...fields, initialTemperature});
        return true;
    }

    // Temperatures, voltages and fans from /sys/class/hwmon, and the temperatures of the thermal zones.
    async _discoverHwmon(run) {
        let readFile = sensorFile => async () => {
            try {
                return Number(await this._optionalRead(sensorFile));
            } catch (error) {
                // An unreadable temperature is left out like one that reads zero. It is not an error.
                if (!this.destroyed) console.debug(sensorFile, error);
                return NaN;
            }
        };
        let hwmonDeviceNames = new Set();
        let root = '/sys/class/hwmon/';
        for (let directory of await this._list(root, this._discoveryCancellation)) {
            let devicePath = root + directory;
            let deviceName = await this._optionalRead(devicePath + '/name');
            if (deviceName === null) {
                devicePath += '/device';
                deviceName = await this._optionalRead(devicePath + '/name');
            }
            if (deviceName === null) continue;
            hwmonDeviceNames.add(deviceName);
            // coretemp sensors are labelled after their CPU package, which the first input names.
            let labelPrefix = deviceName;
            if (deviceName == 'coretemp')
                labelPrefix = await this._optionalRead(devicePath + '/temp1_label') || deviceName;
            let files = await this._list(devicePath, this._discoveryCancellation);
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
                    rawLabel = labelPrefix + ' ' + input;
                else if (labelPrefix != rawLabel)
                    rawLabel = labelPrefix + ' ' + rawLabel;
                let names = {
                    'acpitz temp1': 'ACPI Thermal Zone', 'pch_cannonlake temp1': 'Platform Controller Hub',
                    'iwlwifi_1 temp1': 'Wireless Adapter', 'Package id 0': 'Processor 0', 'Package id 1': 'Processor 1'
                };
                // The key is the device's name and the input, never the label, so renaming or translating a label keeps the key.
                await this._foundWithHideZeros(run, categoryName, {
                    key: deviceName + '/' + input, label: (names[rawLabel] || rawLabel).replace('Package id', 'CPU'),
                    format: match[1], file: devicePath + '/' + file, priority: categoryName == 'voltage' ? priority : undefined
                }, readFile(devicePath + '/' + file));
            }
        }
        root = '/sys/class/thermal/';
        let zones = [];
        // The kernel publishes some zones through hwmon as well. Zones of the same type share one hwmon device,
        // and its directory is inside the first of them only (drivers/thermal/thermal_hwmon.c), so every zone of
        // a type is left out when one zone of that type has an hwmon directory.
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
            if (NON_SENSOR_THERMAL_ZONE_LABELS.includes(zoneType)) continue;
            if (hwmonDeviceNames.has(THERMAL_ZONE_HWMON_EQUIVALENTS[zoneType])) continue;
            if (zoneTypesInHwmon.has(zoneType)) continue;
            let file = root + directory + '/temp';
            await this._foundWithHideZeros(run, 'temperature', {key: 'thermal/' + zoneType, label: zoneType, format: 'temp', file},
                readFile(file));
        }
    }

    // The network sensors for the interfaces in /proc/net/dev.
    _discoverNetwork(run, interfaces, hardwareInterfaces) {
        for (let name of interfaces.keys()) {
            let hardware = hardwareInterfaces.has(name);
            // A hardware interface is called by its kind, with the kernel's name after it: "WiFi (wlp0s20f3)".
            let shownName = hardware ? hardwareInterfaces.get(name) + ' (' + name + ')' : name;
            let section = hardware ? NETWORK_SECTION.hardwareInterfaces : NETWORK_SECTION.virtualInterfaces;
            if (name == 'lo') {
                this._found(run, 'network', {key: 'lo/tx', label: this._gettext('%s transferred').replace('%s', shownName),
                    format: 'storage', file: NETWORK, interface: name, hardware, section});
                continue;
            }
            for (let [direction, label] of [['rx', '%s download speed'], ['tx', '%s upload speed']])
                this._found(run, 'network', {key: name + '/' + direction, label: this._gettext(label).replace('%s', shownName),
                    format: 'speed', file: NETWORK, interface: name, direction, hardware, section});
        }
        for (let key of ['device-rx', 'boot-rx', 'session-rx', 'device-tx', 'boot-tx', 'session-tx', 'combined',
            'wifi-link-quality', 'wifi-signal-level'])
            this._foundFixed(run, 'network', key);
        if (this._settings.get_boolean('include-public-ip'))
            this._foundFixed(run, 'network', 'public-ip');
    }

    // The interfaces that are hardware, each with what kind it is: "WiFi", "Mobile" or "Ethernet". The kernel gives
    // a hardware interface a `device` entry; a bridge, a container's or a VPN's interface and the loopback have none.
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

    // A discovery run for the network category alone, when a reading of /proc/net/dev shows other interfaces
    // than the catalog has.
    async _rediscoverNetwork(interfaces) {
        let hardwareInterfaces = await this._findHardwareInterfaces(interfaces);
        // A full discovery that started meanwhile reads the interfaces itself.
        if (this._discovery || this.destroyed) return;
        let network = this.catalog.network;
        let sensorCountBefore = network.sensors.length;
        let run = this._startRun();
        this._discoverNetwork(run, interfaces, hardwareInterfaces);
        network.discovered = run;
        network.header = this._chooseHeader('network');
        if (network.sensors.length != sensorCountBefore)
            this._save();
        this.catalogChanged();
    }

    // The storage locations that are monitored and mounted, each with its space and, unless it is on another
    // machine, what was read and written. Monitored are the mount points the user added and, when the user wants
    // them, the mounts of `Gio.VolumeMonitor`: GIO collects them from the volume monitor services of gvfs, of which
    // `gvfs-udisks2-volume-monitor` reports the disks.
    async _discoverStorage(run) {
        let mounts = SensorMath.parseMountTable(await this._read(MOUNTS, this._discoveryCancellation));
        let monitored = new Set(this._settings.get_strv('storage-locations'));
        if (this._settings.get_boolean('storage-monitor-volumes')) {
            // A mount without a path, such as a phone, is in no mount table.
            for (let mount of Gio.VolumeMonitor.get().get_mounts())
                monitored.add(mount.get_root().get_path());
        }
        let monitoredLocations = [...monitored].filter(location => mounts.has(location)).sort();
        for (let [index, location] of monitoredLocations.entries()) {
            let network = SensorMath.isRemoteMount(mounts.get(location));
            for (let field of ['total', 'used', 'free', 'reserved', 'used-percent', 'free-percent',
                ...(network ? [] : ['read-total', 'read-rate', 'write-total', 'write-rate'])]) {
                let {label, ...fields} = FIXED.storage[field].fields;
                // Each location is a section of the menu. With several, the labels say which one a value belongs to.
                this._found(run, 'storage', {key: location + '/' + field, ...fields, field, location, network,
                    device: mounts.get(location).device, section: index + 1,
                    label: monitoredLocations.length > 1 ? this._gettext(label) + ' (' + location + ')' : label});
            }
        }
        if (await this._optionalRead('/proc/spl/kstat/zfs/arcstats') !== null) {
            for (let key of ['arc-target', 'arc-maximum', 'arc-current'])
                this._foundFixed(run, 'storage', key, {section: monitoredLocations.length + 1});
        }
    }

    // Every battery that powers the machine, whatever the kernel calls it. A sensor's key is the battery's name
    // and the name of the value.
    async _discoverBattery(run) {
        let root = '/sys/class/power_supply/';
        let supplies;
        try {
            supplies = await this._list(root, this._discoveryCancellation);
        } catch (error) {
            // A machine without power supplies of its own, such as a virtual machine, does not have the directory.
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
            throw error;
        }
        let batteries = [];
        for (let name of supplies) {
            if (await this._optionalRead(root + name + '/type') != 'Battery') continue;
            // The battery of a mouse or a keyboard is listed here too; the kernel marks it as a device's.
            if (await this._optionalRead(root + name + '/scope') == 'Device') continue;
            batteries.push(name);
        }
        for (let name of batteries) {
            let file = root + name + '/uevent';
            let batteryFields = SensorMath.parseBattery(await this._read(file, this._discoveryCancellation));
            let found = Object.entries(BATTERY_FIELD_KEYS).filter(([batteryField]) => batteryFields[batteryField] !== undefined &&
                !(typeof batteryFields[batteryField] == 'number' && !Number.isFinite(batteryFields[batteryField])))
                .map(([, field]) => field);
            for (let field of [...found, 'capacity', 'time-left']) {
                let {label, ...fields} = FIXED.battery[field].fields;
                // With several batteries, the labels say which one a value belongs to.
                this._found(run, 'battery', {key: name + '/' + field, ...fields, field, file,
                    label: batteries.length > 1 ? name + ' ' + label : label});
            }
        }
        if (batteries.length > 1) {
            this._found(run, 'battery', {key: 'total-power-rate', label: 'Total power rate', format: 'watt',
                aggregate: true, section: 1});
        }
    }

    // The average, minimum and maximum over the temperatures and over the fans the machine has.
    _discoverAggregates(run) {
        for (let [categoryName, format] of Object.entries(AGGREGATED)) {
            if (this._measured(this.catalog[categoryName]).length < 2) continue;
            // `aggregate` marks a value that is computed over the sensors and not read from the machine. In the
            // menu these are a section of their own, below the sensors.
            for (let [key, label] of [['average', 'Average'], ['minimum', 'Minimum'], ['maximum', 'Maximum']])
                this._found(run, categoryName, {key, label, format, aggregate: true, section: 1});
        }
    }

    async _command(args) {
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

    // The graphics cards: NVIDIA cards through nvidia-smi, every other card through /sys/class/drm.
    // A sensor's key is the card's name and the name of the value.
    async _discoverGpu(run) {
        if (!this.catalog.gpu.enabled) return;
        let staticInfo = this._settings.get_boolean('include-static-gpu-info');
        let nvidiaCards = [];
        let nvidiaFields = ['uuid', 'name'];
        let nvidiaStaticFields = [
            ['Temperature Limit', 'temperature.gpu.tlimit', 'temp'],
            ['Power Limit', 'power.limit', 'watt-gpu'], ['Addressing Mode', 'addressing_mode', 'string'],
            ['Driver Version', 'driver_version', 'string'], ['vBIOS Version', 'vbios_version', 'string'],
            ['Serial Number', 'serial', 'string'], ['Domain Number', 'pci.domain', 'string'],
            ['Bus Number', 'pci.bus', 'string'], ['Device Number', 'pci.device', 'string'],
            ['Device ID', 'pci.device_id', 'string'], ['Sub Device ID', 'pci.sub_device_id', 'string']
        ];
        if (GLib.find_program_in_path('nvidia-smi')) {
            if (this._settings.get_boolean('hide-zeros'))
                nvidiaFields.push('temperature.gpu', 'temperature.memory');
            if (staticInfo)
                nvidiaFields.push(...nvidiaStaticFields.map(([, field]) => field), 'pcie.link.gen.max', 'pcie.link.width.max');
            try {
                let output = await this._command(['nvidia-smi', '--query-gpu=' + nvidiaFields.join(','), '--format=csv,noheader,nounits']);
                nvidiaCards = output.split('\n').filter(line => line.trim()).map(line => line.split(',').map(part => part.trim()));
            } catch (error) {
                if (!this.destroyed) this.onError('nvidia discovery', error);
            }
        }
        let otherCards = [];
        for (let card of await this._list('/sys/class/drm', this._discoveryCancellation)) {
            if (!/^card\d+$/.test(card)) continue;
            let devicePath = '/sys/class/drm/' + card + '/device/';
            let vendor = await this._optionalRead(devicePath + 'vendor');
            if (vendor === null || (vendor == '0x10de' && nvidiaCards.length)) continue;
            otherCards.push({devicePath, vendor, files: await this._list(devicePath, this._discoveryCancellation)});
        }
        // With several cards in one category, the labels say which card a value belongs to.
        let cardCount = nvidiaCards.length + otherCards.length;
        let cardNumber = 0;
        let labelPrefix = () => cardCount > 1 ? 'GPU ' + cardNumber + ' ' : '';

        for (let parts of nvidiaCards) {
            cardNumber++;
            let uuid = parts[0];
            let cardName = parts[1];
            let part = field => parts[nvidiaFields.indexOf(field)];
            if (staticInfo) {
                this._found(run, 'gpu', {key: cardName + '/name', label: labelPrefix() + 'Vendor', format: 'string',
                    value: cardName, status: 'ready', updated: this.now()});
                for (let [label, field, format] of nvidiaStaticFields) {
                    if (part(field) == 'N/A' || part(field) == '[N/A]') continue;
                    this._found(run, 'gpu', {key: cardName + '/' + field, label: labelPrefix() + label, format,
                        value: format == 'string' ? part(field) : Number(part(field)), status: 'ready', updated: this.now()});
                }
                let generation = part('pcie.link.gen.max');
                let width = part('pcie.link.width.max');
                if (Number.isFinite(Number(generation)) && Number.isFinite(Number(width)))
                    this._found(run, 'gpu', {key: cardName + '/pcie.link.max', label: labelPrefix() + 'Maximum Link Speed',
                        format: 'pcie', value: generation + 'x' + width, status: 'ready', updated: this.now()});
            }
            let hasTemperature = false;
            for (let [label, field, format] of [
                ['Fan', 'fan.speed', 'percent'], ['Temperature', 'temperature.gpu', 'temp'],
                ['Memory Temperature', 'temperature.memory', 'temp'],
                ['Memory Total', 'memory.total', 'memory'], ['Memory Used', 'memory.used', 'memory'],
                ['Memory Reserved', 'memory.reserved', 'memory'], ['Memory Free', 'memory.free', 'memory'],
                ['Memory Utilization', 'utilization.memory', 'percent'], ['Utilization', 'utilization.gpu', 'percent'],
                ['Encoder Utilization', 'utilization.encoder', 'percent'],
                ['Decoder Utilization', 'utilization.decoder', 'percent'],
                ['Frequency', 'clocks.gr', 'hertz'], ['Memory Frequency', 'clocks.mem', 'hertz'],
                ['Encoder/Decoder Frequency', 'clocks.video', 'hertz'],
                ['Power', 'power.draw.instant', 'watt-gpu'], ['Average Power', 'power.draw.average', 'watt-gpu']
            ]) {
                let found = await this._foundWithHideZeros(run, 'gpu', {key: cardName + '/' + field, label: labelPrefix() + label, format,
                    nvidia: uuid, field, ...(field == 'memory.free' && LOW_IS_BAD)}, () => Number(part(field)));
                if (field == 'temperature.gpu')
                    hasTemperature = found;
            }
            this._found(run, 'gpu', {key: cardName + '/memory-usage', label: labelPrefix() + 'Memory Usage', format: 'percent',
                nvidia: uuid, field: 'memory.used,memory.total'});
            this._found(run, 'gpu', {key: cardName + '/link-speed', label: labelPrefix() + 'Link Speed', format: 'pcie',
                nvidia: uuid, field: 'pcie.link.gen.gpucurrent,pcie.link.width.current'});
            // The card's temperature is listed with the other temperatures too, and counts in their average.
            if (hasTemperature)
                this._found(run, 'temperature', {key: cardName + '/temperature.gpu', format: 'temp', nvidia: uuid,
                    label: 'GPU' + (nvidiaCards.length > 1 ? ' ' + cardNumber : ''), field: 'temperature.gpu'});
        }

        for (let {devicePath, vendor, files} of otherCards) {
            cardNumber++;
            if (staticInfo) {
                let vendors = {'0x1002': 'AMD', '0x10de': 'NVIDIA', '0x13b5': 'ARM',
                    '0x5143': 'Qualcomm', '0x8086': 'Intel', '0x1234': 'QEMU'};
                this._found(run, 'gpu', {key: vendor + '/vendor', label: labelPrefix() + 'Vendor', format: 'string',
                    value: vendors[vendor] || vendor, status: 'ready', updated: this.now()});
            }
            for (let [label, file, format] of [
                ['Usage', 'gpu_busy_percent', 'percent'],
                ['Memory Used', 'mem_info_vram_used', 'memory'],
                ['Memory Total', 'mem_info_vram_total', 'memory']
            ]) {
                if (files.includes(file))
                    this._found(run, 'gpu', {key: vendor + '/' + file, label: labelPrefix() + label, format, file: devicePath + file});
            }
        }
        this._foundFixed(run, 'gpu', 'refresh-rate');
    }

    _configureNvidia(activeSensors) {
        let requested = activeSensors.filter(sensor => sensor.nvidia);
        let fields = ['uuid', ...[...new Set(requested.flatMap(sensor => sensor.field.split(',')))].sort()];
        let uuids = [...new Set(requested.map(sensor => sensor.nvidia))].sort();
        let interval = this._settings.get_int('update-time');
        let signature = [fields.join(','), uuids.join(','), interval].join(';');
        if (this._nvidia && this._nvidia.signature == signature && !this._nvidia.error) return;
        this._stopSource(NVIDIA);
        // The reading of the process that ran so far lacks the fields that are asked for from now on.
        let source = this.sources.get(NVIDIA);
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
            if (this._nvidia != state) return;
            try {
                let [line] = stream.read_line_finish_utf8(result);
                if (line === null) throw new Error('nvidia-smi stopped producing readings');
                let parts = line.split(',').map(part => part.trim());
                if (parts.length != fields.length) throw new Error('Incomplete nvidia-smi reading: ' + line);
                state.rows.set(parts[0], Object.fromEntries(fields.map((field, index) => [field, parts[index]])));
                if (state.rows.size == uuids.length) {
                    let sample = {gpus: state.rows, time: this.clock()};
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
        if (!state.process) return;
        state.cancellation.cancel();
        state.process.force_exit();
        if (state.waiter) state.waiter.reject(new Error('GPU collection stopped'));
        state.stream.close_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            try { stream.close_finish(result); }
            catch (error) { this.onError(NVIDIA, error); }
        });
    }

    _startFrames() {
        this._frameTimes = [];
        if (typeof global == 'undefined' || !global.stage) return;
        this._frameSignal = global.stage.connect('after-paint', () => {
            let now = this.clock();
            this._frameTimes.push(now);
            while (this._frameTimes.length > 2 && this._frameTimes[0] < now - 0.5)
                this._frameTimes.shift();
        });
    }

    _stopFrames() {
        if (this._frameSignal) {
            global.stage.disconnect(this._frameSignal);
            this._frameSignal = 0;
        }
    }

    destroy() {
        this.destroyed = true;
        this._select();
        this._discoveryCancellation.cancel();
        for (let process of this._commands)
            process.force_exit();
        // The readings are saved when the extension stops, so the next launch can show them until it has its own.
        this._save();
    }
}
