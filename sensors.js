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

const MEMINFO = 'source:/proc/meminfo';
const STAT = 'source:/proc/stat';
const CPUINFO = 'source:/proc/cpuinfo';
const CPU_FREQUENCIES = 'source:cpu-frequencies';
const UPTIME = 'source:/proc/uptime';
const LOADAVG = 'source:/proc/loadavg';
const OPEN_FILES = 'source:/proc/sys/fs/file-nr';
const DISKSTATS = 'source:/proc/diskstats';
const ARCSTATS = 'source:/proc/spl/kstat/zfs/arcstats';
const WIRELESS = 'source:/proc/net/wireless';
const NETWORK = 'source:/proc/net/dev';
const FRAMES = 'source:frames';
const NVIDIA = 'source:nvidia';
const PUBLIC_IP_URLS = ['https://ipv4.corecoding.com', 'https://api.myip.com', 'https://api.ipify.org?format=json'];
const BATTERY_DEVICES = ['BAT0', 'BAT1', 'BAT2', 'BATT', 'CMB0', 'CMB1', 'CMB2', 'macsmc-battery'];
// Thermal zone types that are control interfaces, not sensors.
// INT3400 is Intel's thermal policy switch; its zone reports a fixed dummy temperature.
const NON_SENSOR_THERMAL_ZONE_LABELS = ['INT3400 Thermal'];
// Thermal zones that report what an hwmon driver also reports: zone label to that driver's hwmon name.
// Such a zone is left out while the hwmon device exists. x86_pkg_temp and coretemp both report the CPU package temperature.
const THERMAL_ZONE_HWMON_EQUIVALENTS = {x86_pkg_temp: 'coretemp'};
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
    average: SensorMath.average,
    minimum: samples => Math.min(...samples.map(sample => sample.value)),
    maximum: samples => Math.max(...samples.map(sample => sample.value))
};
// The sections of the network menu, in the order they are shown. A network sensor names its section; the rows of
// one section stay together, whatever the labels are.
const NETWORK_SECTION = {machineSpeed: 1, hardwareInterfaces: 2, volume: 3, other: 4, virtualInterfaces: 5};
// What an interface that is hardware is called, by the DEVTYPE the kernel reports for it. A network card reports none.
// "WiFi" is spelled as in the two WiFi labels below, which 22 translations are filed under.
const HARDWARE_INTERFACE_KINDS = {wlan: 'WiFi', wwan: 'Mobile'};
// The sensor whose value a category shows in its menu header. Temperature, voltage, fan and gpu choose theirs in _chooseHeader.
const HEADER_KEYS = {
    memory: 'usage', processor: 'usage', system: 'load-1m', storage: 'free', battery: 'power-rate', network: 'device-rx'
};

// A sensor that is found by its key alone: what the catalog says about it, the source it is read from, and how
// its value follows from that source's reading. `source` is an id or picks one for the sensor. An entry without a
// source only names the sensor; its value comes from the sensor's fields (see Sensors._definition).
function fixed(label, format, source, value, fields = {}) {
    return {fields: {label, format, ...fields}, source, value};
}

function cpuFrequencies(sample) {
    return Array.isArray(sample.value) ? sample.value :
        sample.value.split('\n').filter(line => line.split(':')[0].trim() == 'cpu MHz')
            .map(line => Number(line.slice(line.indexOf(':') + 1)) * 1000000);
}

const cpuFrequencySource = sensors => sensors.sources.has(CPU_FREQUENCIES) ? CPU_FREQUENCIES : CPUINFO;
const filesystem = sensors => sensors._filesystemSource();
const battery = (sensors, sensor) => sensors._fileSource(sensor.file, SensorMath.parseBattery);

const FIXED = {
    memory: {
        'physical': fixed('Physical', 'memory', MEMINFO, s => s.value.MemTotal),
        'available': fixed('Available', 'memory', MEMINFO, s => s.value.MemAvailable),
        'cached': fixed('Cached', 'memory', MEMINFO, s => s.value.Cached),
        'free': fixed('Free', 'memory', MEMINFO, s => s.value.MemFree),
        'swap-total': fixed('Swap Total', 'memory', MEMINFO, s => s.value.SwapTotal),
        'swap-free': fixed('Swap Free', 'memory', MEMINFO, s => s.value.SwapFree),
        'allocated': fixed('Allocated', 'memory', MEMINFO, s => s.value.MemTotal - s.value.MemAvailable),
        'usage': fixed('Usage', 'percent', MEMINFO, s => (s.value.MemTotal - s.value.MemAvailable) / s.value.MemTotal),
        'swap-used': fixed('Swap Used', 'memory', MEMINFO, s => s.value.SwapTotal - s.value.SwapFree),
        'swap-usage': fixed('Swap Usage', 'percent', MEMINFO, s =>
            s.value.SwapTotal ? (s.value.SwapTotal - s.value.SwapFree) / s.value.SwapTotal : 0)
    },
    processor: {
        'usage': fixed('Usage', 'percent'),
        'frequency': fixed('Frequency', 'hertz', cpuFrequencySource, s => {
            let frequencies = cpuFrequencies(s);
            return frequencies.reduce((sum, frequency) => sum + frequency, 0) / frequencies.length;
        }),
        'min-frequency': fixed('Min frequency', 'hertz', cpuFrequencySource, s => Math.min(...cpuFrequencies(s))),
        'max-frequency': fixed('Max frequency', 'hertz', cpuFrequencySource, s => Math.max(...cpuFrequencies(s))),
        'process-time': fixed('Process Time', 'uptime', UPTIME, (s, sensor, sensors) =>
            s.value[0] - s.value[1] / sensors._coreCount()),
        'powercap': fixed('Powercap', 'watt-limit'),
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
        'lap-mode': fixed('Lap mode', 'string', (sensors, sensor) => sensors._fileSource(sensor.file),
            (s, sensor, sensors) => sensors._gettext(s.value == 1 ? 'on' : 'off')),
        'kernel': fixed('Kernel', 'string')
    },
    network: {
        'combined': fixed('Total speed', 'speed', undefined, undefined, {section: NETWORK_SECTION.machineSpeed}),
        // The two WiFi values are with the hardware interfaces, next to the WiFi interface's speeds.
        'wifi-link-quality': fixed('WiFi Link Quality', 'percent', WIRELESS, s => s.value.quality,
            {section: NETWORK_SECTION.hardwareInterfaces}),
        'wifi-signal-level': fixed('WiFi Signal Level', 'string', WIRELESS, s => s.value.signal,
            {section: NETWORK_SECTION.hardwareInterfaces}),
        'public-ip': fixed('Public IP', 'string', sensors => sensors._publicIpSource(), (s, sensor) => {
            // The renderer shows this country's flag next to the address.
            sensor.country = s.value.country;
            return s.value.ip;
        }, {section: NETWORK_SECTION.other})
    },
    storage: {
        'total': fixed('Total', 'storage', filesystem, s => s.value.total),
        'used': fixed('Used', 'storage', filesystem, s => s.value.used),
        'free': fixed('Free', 'storage', filesystem, s => s.value.free),
        'reserved': fixed('Reserved', 'storage', filesystem, s => s.value.total - s.value.used - s.value.free),
        'used-percent': fixed('Used %', 'percent', filesystem, s => s.value.used / s.value.total),
        'free-percent': fixed('Free %', 'percent', filesystem, s => (s.value.total - s.value.used) / s.value.total),
        'read-total': fixed('Read total', 'storage', DISKSTATS, (s, sensor) => s.value.get(sensor.device)?.read),
        'read-rate': fixed('Read rate', 'storage-rate', DISKSTATS, (s, sensor) =>
            SensorMath.counterRate(s, disks => disks.get(sensor.device)?.read)),
        'write-total': fixed('Write total', 'storage', DISKSTATS, (s, sensor) => s.value.get(sensor.device)?.write),
        'write-rate': fixed('Write rate', 'storage-rate', DISKSTATS, (s, sensor) =>
            SensorMath.counterRate(s, disks => disks.get(sensor.device)?.write)),
        'arc-target': fixed('ARC Target', 'storage', ARCSTATS, s => s.value.c),
        'arc-maximum': fixed('ARC Maximum', 'storage', ARCSTATS, s => s.value.c_max),
        'arc-current': fixed('ARC Current', 'storage', ARCSTATS, s => s.value.size)
    },
    battery: {
        'state': fixed('State', 'string', battery, s => s.value.state),
        'cycles': fixed('Cycles', 'string', battery, s => s.value.cycles),
        'voltage': fixed('Voltage', 'in', battery, s => s.value.voltage),
        'level': fixed('Level', 'string', battery, s => s.value.level),
        'percentage': fixed('Percentage', 'percent', battery, s => s.value.percentage),
        'power-rate': fixed('Power Rate', 'watt', battery, s => s.value.power),
        'energy-full': fixed('Energy (full)', 'watt-hour', battery, s => s.value.full),
        'energy-design': fixed('Energy (design)', 'watt-hour', battery, s => s.value.design),
        'energy-now': fixed('Energy (now)', 'watt-hour', battery, s => s.value.now),
        'capacity': fixed('Capacity', 'percent', battery, s => s.value.full / s.value.design),
        'time-left': fixed('Time left', 'runtime', battery, (s, sensor, sensors) => sensors._batteryTimeLeft(s, sensor.file))
    },
    gpu: {
        'refresh-rate': fixed('Refresh Rate', 'hertz', FRAMES, s => s.value)
    }
};
for (let [direction, moving, moved] of [['rx', 'Download', 'Downloaded'], ['tx', 'Upload', 'Uploaded']]) {
    // The network totals are over the hardware interfaces. What a virtual interface carries, such as a bridge, a
    // container's or a VPN's, passes a hardware interface as well when it leaves the machine, and would count twice.
    // The sum of the interface rates has sensors as inputs, so it is put together in Sensors._definition.
    FIXED.network['device-' + direction] = fixed(moving + ' speed', 'speed', undefined, undefined,
        {direction, section: NETWORK_SECTION.machineSpeed});
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
        this.sources = new Map();
        this.activeSources = new Set();
        // The sensors that are computed right now, each with its inputs and its computation (see _definition).
        // A sensor comes after the sensors it is computed from.
        this.active = new Map();
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
        this._batteryTimes = [];
        this._batteryState = '';
        this._registerSystemSources();
        this.catalog = this._load();
        // The timestamp of the latest discovery run. Every run gets a later one.
        this._lastRun = Math.max(0, ...this.categories().map(([, category]) => category.discovered ?? 0));
    }

    // Reads the saved catalog. This is the one place where a sensor is found by its key: the header of a category
    // and the links in the panel are saved as keys and become the sensors themselves here.
    _load() {
        let saved = readCatalog(this._settings);
        let catalog = {};
        for (let name of Object.keys(sensorCategories)) {
            let {header, sensors = [], ...category} = saved[name];
            // 'saved' is a reading from an earlier session. It is shown like a 'ready' one until this session has its own.
            for (let sensor of sensors)
                sensor.status = sensor.value === undefined ? 'pending' : 'saved';
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
        this._evaluate();
    }

    // The renderer calls this after it changed which sensors and headers are marked `shown`.
    // The design has the collector pick the marks up by itself at the next tick. It is told at once instead, so
    // that a sensor that comes on screen shows "…" and not a value from the last time it was read, and so that a
    // source nobody shows any more, such as the nvidia-smi process, stops right away.
    shownChanged() {
        this._select();
        this._evaluate();
    }

    // The temperatures, voltages or fan speeds of a category that are read from the machine, without the
    // average, minimum and maximum that temperatures and fans have over them.
    _measured(category) {
        return category.sensors.filter(sensor => sensorPresent(category, sensor) && !(sensor.key in AGGREGATES));
    }

    // The names of the network interfaces that are hardware, such as a network card or a Wi-Fi adapter.
    _hardwareInterfaces() {
        let network = this.catalog.network;
        return new Set(network.sensors.filter(sensor => sensor.hardware && sensorPresent(network, sensor))
            .map(sensor => sensor.interface));
    }

    _coreCount() {
        let processor = this.catalog.processor;
        return processor.sensors.filter(sensor => sensorPresent(processor, sensor) && sensor.core && sensor.core != 'cpu').length;
    }

    // Where a sensor's value comes from: its inputs, which are source ids or sensors of the same category, and the
    // computation from their readings. The catalog holds no functions; this follows from the category and the
    // sensor's fields alone.
    _definition(categoryName, sensor) {
        let category = this.catalog[categoryName];
        if (categoryName in AGGREGATED && sensor.key in AGGREGATES)
            return {inputs: this._measured(category), availableInputsOnly: true, compute: AGGREGATES[sensor.key]};
        if (categoryName == 'network' && sensor.key == 'combined') {
            return {
                inputs: category.sensors.filter(input =>
                    sensorPresent(category, input) && (input.key == 'device-rx' || input.key == 'device-tx')),
                compute: SensorMath.sum
            };
        }
        if (categoryName == 'network' && sensor.key == 'device-' + sensor.direction) {
            return {
                inputs: [NETWORK, ...category.sensors.filter(input =>
                    sensorPresent(category, input) && input.hardware && input.direction == sensor.direction)],
                compute: samples => SensorMath.sum(samples.slice(1))
            };
        }
        let known = FIXED[categoryName]?.[sensor.key];
        if (known?.source) {
            let source = typeof known.source == 'function' ? known.source(this, sensor) : known.source;
            return {inputs: [source], compute: ([s]) => known.value(s, sensor, this)};
        }
        if (sensor.interface) {
            // The loopback interface has one sensor without a direction, which shows the bytes it has transferred.
            return {inputs: [NETWORK], compute: ([s]) => sensor.direction
                ? SensorMath.counterRate(s, value => value.interfaces.get(sensor.interface)?.[sensor.direction])
                : s.value.interfaces.get(sensor.interface)?.tx};
        }
        if (sensor.core)
            return {inputs: [STAT], compute: ([s]) => SensorMath.cpuUsage(s, sensor.core)};
        if (sensor.nvidia) {
            return {inputs: [NVIDIA], compute: ([s]) => {
                let gpu = s.value.gpus.get(sensor.nvidia);
                let [first, second] = sensor.field.split(',').map(field => Number(gpu?.[field]));
                if (sensor.format == 'pcie')
                    return Number.isFinite(first) && Number.isFinite(second) ? first + 'x' + second : undefined;
                return second === undefined ? first * NVIDIA_SCALE[sensor.format] : first / second;
            }};
        }
        if (sensor.file)
            return {inputs: [this._fileSource(sensor.file)], compute: ([s]) => FILE_VALUE[sensor.format](s.value)};
        // Discovery wrote the value itself, such as the kernel version.
        return {inputs: [], compute: () => sensor.value};
    }

    // Works out which sensors are computed and which sources are read for them: the sensors marked `shown`, the
    // header of every category marked `shown`, and everything those are computed from.
    _select() {
        let active = new Map();
        let sources = new Set();
        let visit = (categoryName, sensor) => {
            if (active.has(sensor) || !sensorPresent(this.catalog[categoryName], sensor)) return;
            let definition = this._definition(categoryName, sensor);
            for (let input of definition.inputs) {
                if (typeof input != 'string')
                    visit(categoryName, input);
                // A source that discovery registers is not there yet when a saved catalog is shown before the first discovery.
                else if (this.sources.has(input))
                    sources.add(input);
            }
            active.set(sensor, definition);
        };
        if (!this.destroyed) {
            for (let [name, category] of this.categories()) {
                if (category.shown) {
                    // The voltage header shows the best voltage that can be read, so all of them are read for it.
                    for (let sensor of name == 'voltage' ? this._measured(category) : [category.header])
                        if (sensor) visit(name, sensor);
                }
                for (let sensor of category.sensors)
                    if (sensor.shown) visit(name, sensor);
            }
        }

        for (let id of this.activeSources) {
            if (!sources.has(id))
                this._stopSource(id);
        }
        this.active = active;
        for (let id of sources) {
            let source = this.sources.get(id);
            if (!this.activeSources.has(id)) {
                // A reading still inside its interval stays as it is; reading the source again is not due yet.
                if (source.reading && !this._withinInterval(id))
                    source.reading = {...source.reading, status: 'pending'};
                if (source.start) source.start();
            }
            if (source.configure)
                source.configure([...active.keys()]);
        }
        this.activeSources = sources;
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
        if (source.stop) source.stop();
    }

    async poll(force = false) {
        // No sensor is read while a discovery run is in progress. This tick is skipped, not made up for later.
        if (this.destroyed || this._discovery) return;
        this._select();
        let reads = [];
        for (let id of this.activeSources) {
            let source = this.sources.get(id);
            if (source.pending) {
                reads.push(source.pending.promise);
                continue;
            }
            if (!force && this._withinInterval(id))
                continue;

            let ticket = {cancellation: this.createCancellation()};
            source.pending = ticket;
            ticket.promise = Promise.resolve().then(() => {
                if (source.pending == ticket) return source.read(ticket.cancellation);
            }).then(value => {
                if (source.pending != ticket || this.destroyed) return;
                let time = source.sampleTime ? source.sampleTime(value) : this.clock();
                let last = source.reading;
                // A rate is computed against the last reading that succeeded, never across a failure or a stop.
                let previous = last?.status == 'ready' ? {value: last.value, time: last.time} : null;
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
                this._evaluate(id);
            });
            reads.push(ticket.promise);
        }
        await Promise.all(reads);
    }

    // Recomputes the active sensors, writes value, status and time into them, and tells the renderer which ones.
    // Given the source that just finished, it recomputes only the sensors that depend on that source, so a tick
    // costs one pass in total, not one per source.
    _evaluate(finishedSource) {
        if (this.destroyed) return;
        let waiting = new Set();
        let recomputed = new Set();
        // this.active is in dependency order, so one walk carries a change from a sensor to those built on it.
        for (let [sensor, definition] of this.active) {
            if (definition.inputs.some(input => waiting.has(input) || this.sources.get(input)?.pending)) {
                waiting.add(sensor);
                continue;
            }
            if (finishedSource !== undefined &&
                !definition.inputs.some(input => input == finishedSource || recomputed.has(input)))
                continue;
            // A sensor that is an input carries its own value and status, like a source's reading does.
            let inputs = definition.inputs.map(input => typeof input == 'string' ? this.reading(input) : input);
            if (definition.availableInputsOnly)
                inputs = inputs.filter(input => input?.status != 'unavailable');

            let status = 'ready';
            let value;
            if (inputs.some(input => input && input.status == 'unavailable')) {
                status = 'unavailable';
            } else if (inputs.some(input => !input || input.status == 'pending')) {
                status = 'pending';
            } else {
                value = definition.compute(inputs);
                if (value === SensorMath.PENDING)
                    status = 'pending';
                else if (value === undefined || value === null ||
                    (typeof value == 'number' && !Number.isFinite(value)))
                    status = 'unavailable';
            }
            // A reading from an earlier session stays on screen while this session's first one is on its way.
            if (status == 'pending' && sensor.status == 'saved')
                continue;

            sensor.status = status;
            if (status == 'ready') {
                sensor.value = value;
                sensor.updated = this.now();
            }
            recomputed.add(sensor);
        }
        if (this.catalog.voltage.shown)
            this.catalog.voltage.header = this._chooseHeader('voltage');
        this.onValuesChanged(recomputed);
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

    _fileSource(filePath, parse = text => Number(text)) {
        let id = 'source:' + filePath;
        this.addSource(id, {read: async cancellation => parse(await this._read(filePath, cancellation))});
        return id;
    }

    // The filesystem that holds the storage path the user set.
    _filesystemSource() {
        let storagePath = this._settings.get_string('storage-path');
        let id = 'source:filesystem:' + storagePath;
        this.addSource(id, {read: cancellation => new Promise((resolve, reject) => {
            Gio.File.new_for_path(storagePath).query_filesystem_info_async(
                'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_DEFAULT, cancellation,
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
        })});
        return id;
    }

    // The public-IP service the user chose.
    _publicIpSource() {
        let provider = this._settings.get_int('network-public-ip-provider');
        let id = 'source:public-ip:' + provider;
        this.addSource(id, {
            interval: () => this._settings.get_int('network-public-ip-interval') * 60,
            read: async cancellation => {
                let answer = JSON.parse(await this._read(PUBLIC_IP_URLS[provider], cancellation));
                let country = provider == 0 ? answer.countryCode : provider == 1 ? answer.cc : '';
                return {ip: provider == 0 ? answer.IPv4 : answer.ip, country: (country || '').toLowerCase()};
            }
        });
        return id;
    }

    // The time until the battery is full or empty, averaged over the last readings in the same charging state.
    _batteryTimeLeft(sample, batteryFile) {
        let value = SensorMath.batteryTime(sample.value);
        if (typeof value != 'number') return value;
        if (this._batteryState != batteryFile + sample.value.state) {
            this._batteryState = batteryFile + sample.value.state;
            this._batteryTimes = [];
        }
        if (!this._batteryTimes.length || this._batteryTimes[this._batteryTimes.length - 1].time != sample.time) {
            this._batteryTimes.push({value, time: sample.time});
            if (this._batteryTimes.length > 10) this._batteryTimes.shift();
        }
        return SensorMath.average(this._batteryTimes);
    }

    _registerSystemSources() {
        this._fileSource('/proc/meminfo', SensorMath.parseMemory);
        this._fileSource('/proc/stat', SensorMath.parseCpuStat);
        this._fileSource('/proc/cpuinfo', text => text);
        this._fileSource('/proc/uptime', text => SensorMath.splitFields(text).map(Number));
        this._fileSource('/proc/loadavg', SensorMath.splitFields);
        this._fileSource('/proc/sys/fs/file-nr', text => Number.parseInt(text));
        this._fileSource('/proc/diskstats', text => new Map(text.split('\n').map(line => {
            let fields = SensorMath.splitFields(line);
            return [fields[0] + ':' + fields[1], {read: Number(fields[5]) * 512, write: Number(fields[9]) * 512}];
        })));
        this._fileSource('/proc/spl/kstat/zfs/arcstats', text =>
            Object.fromEntries(text.split('\n').map(line => {
                let fields = SensorMath.splitFields(line);
                return [fields[0], Number(fields[2])];
            })));
        this._fileSource('/proc/net/wireless', text => {
            let lines = text.split('\n').slice(2).filter(line => line.trim());
            if (!lines.length) return {};
            let fields = SensorMath.splitFields(lines[lines.length - 1]);
            return {quality: Number(fields[2]) / 70, signal: Number(fields[3])};
        });
        this.addSource(NETWORK, {read: async cancellation => {
            let interfaces = SensorMath.parseNetwork(await this._read('/proc/net/dev', cancellation));
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
        this.addSource(FRAMES, {
            start: () => this._startFrames(),
            stop: () => this._stopFrames(),
            read: async () => {
                if (this._frameTimes.length < 2) return undefined;
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
        for (let id of this.activeSources)
            this._cancelRead(this.sources.get(id));
        let configuration = () => JSON.stringify([this.catalog.gpu.enabled, ...[
            'include-static-info', 'include-static-gpu-info', 'include-public-ip',
            'network-public-ip-provider', 'battery-slot', 'storage-path', 'hide-zeros'
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
        })().finally(() => { this._discovery = null; });
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
        switch (categoryName) {
            case 'temperature':
            case 'fan':
                // With one sensor there is no average row; the header then shows that sensor.
                return withKey('average') ?? this._measured(category)[0];
            case 'voltage': {
                let ranked = this._measured(category).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
                return ranked.find(sensor => sensor.status != 'unavailable') ?? ranked[0];
            }
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
                this._found(run, 'processor', {key: core, format: 'percent', core,
                    label: this._gettext('Core %d').replace('%d', core.slice(3))});
        }
        let cpuInfo = await this._read('/proc/cpuinfo', this._discoveryCancellation);
        if (!/^cpu MHz\s*:/m.test(cpuInfo)) {
            let frequencyFiles = [...cores.keys()].filter(core => core != 'cpu')
                .map(core => '/sys/devices/system/cpu/' + core + '/cpufreq/scaling_cur_freq');
            this.addSource(CPU_FREQUENCIES, {read: cancellation => Promise.all(frequencyFiles.map(
                async frequencyFile => Number(await this._read(frequencyFile, cancellation)) * 1000))});
        }
        for (let key of ['frequency', 'min-frequency', 'max-frequency', 'process-time'])
            this._foundFixed(run, 'processor', key);
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

    // The network sensors for the interfaces in /proc/net/dev. An interface that is not in the list is not found,
    // like any device that was unplugged, and is found again when it returns.
    _discoverNetwork(run, interfaces, hardwareInterfaces) {
        for (let name of interfaces.keys()) {
            let hardware = hardwareInterfaces.has(name);
            // A hardware interface is called by its kind, with the kernel's name after it: "WiFi (wlp0s20f3)".
            let shownName = hardware ? hardwareInterfaces.get(name) + ' (' + name + ')' : name;
            let section = hardware ? NETWORK_SECTION.hardwareInterfaces : NETWORK_SECTION.virtualInterfaces;
            if (name == 'lo') {
                this._found(run, 'network', {key: 'lo/tx', label: this._gettext('%s transferred').replace('%s', shownName),
                    format: 'storage', interface: name, hardware, section});
                continue;
            }
            for (let [direction, label] of [['rx', '%s download speed'], ['tx', '%s upload speed']])
                this._found(run, 'network', {key: name + '/' + direction, label: this._gettext(label).replace('%s', shownName),
                    format: 'speed', interface: name, direction, hardware, section});
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

    async _discoverStorage(run) {
        for (let key of ['total', 'used', 'free', 'reserved', 'used-percent', 'free-percent'])
            this._foundFixed(run, 'storage', key);

        let storagePath = this._settings.get_string('storage-path');
        let mounts = (await this._read('/proc/self/mountinfo', this._discoveryCancellation)).split('\n').map(line =>
            line.split(' ').map(field => field.replace(/\\([0-7]{3})/g, (_, octal) =>
                String.fromCharCode(Number.parseInt(octal, 8)))));
        let mount = mounts.filter(fields => storagePath == fields[4] || storagePath.startsWith(fields[4].replace(/\/$/, '') + '/'))
            .sort((a, b) => b[4].length - a[4].length)[0];
        if (mount && mount[mount.indexOf('-') + 2].startsWith('/dev/')) {
            for (let key of ['read-total', 'read-rate', 'write-total', 'write-rate'])
                this._foundFixed(run, 'storage', key, {device: mount[2]});
        }
        if (await this._optionalRead('/proc/spl/kstat/zfs/arcstats') !== null) {
            for (let key of ['arc-target', 'arc-maximum', 'arc-current'])
                this._foundFixed(run, 'storage', key);
        }
    }

    async _discoverBattery(run) {
        let file = '/sys/class/power_supply/' + BATTERY_DEVICES[this._settings.get_int('battery-slot')] + '/uevent';
        let contents = await this._optionalRead(file);
        if (contents === null) return;
        let batteryFields = SensorMath.parseBattery(contents);
        for (let [field, key] of Object.entries(BATTERY_FIELD_KEYS)) {
            if (batteryFields[field] === undefined ||
                (typeof batteryFields[field] == 'number' && !Number.isFinite(batteryFields[field])))
                continue;
            this._foundFixed(run, 'battery', key, {file});
        }
        this._foundFixed(run, 'battery', 'capacity', {file});
        this._foundFixed(run, 'battery', 'time-left', {file});
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
    // A sensor's key is the card's name and the name of the value, as for every other device.
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
                    nvidia: uuid, field}, () => Number(part(field)));
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
