// Returned by a computation that has no value yet, such as a rate after its first counter reading.
export const PENDING = Symbol('pending');

export function splitFields(text) {
    let fields = [];
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
        if (index == text.length || text[index] <= ' ') {
            if (start < index) fields.push(text.slice(start, index));
            start = index + 1;
        }
    }
    return fields;
}

export function parseNetwork(contents) {
    let interfaces = new Map();
    for (let line of contents.trim().split('\n').slice(2)) {
        let colon = line.lastIndexOf(':');
        let name = line.slice(0, colon).trim();
        let fields = splitFields(line.slice(colon + 1)).map(Number);
        if (colon < 0 || fields.length < 16 || fields.some(value => !Number.isFinite(value)))
            throw new Error('Invalid /proc/net/dev row: ' + line);
        interfaces.set(name, {rx: fields[0], tx: fields[8]});
    }
    return interfaces;
}

export function parseCpuStat(contents) {
    let cores = new Map();
    for (let line of contents.split('\n')) {
        if (!line.startsWith('cpu')) continue;
        let [name, ...fields] = splitFields(line);
        if (name != 'cpu' && !Number.isInteger(Number(name.slice(3)))) continue;
        let ticks = fields.slice(0, 8).map(Number);
        let total = ticks.reduce((sum, value) => sum + value, 0);
        cores.set(name, {total, idle: ticks[3] + ticks[4]});
    }
    return cores;
}

export function cpuUsage(sample, core) {
    let current = sample.value.get(core);
    let previous = sample.previous?.value.get(core);
    if (!current) return undefined;
    if (!previous || current.total < previous.total || current.idle < previous.idle)
        return PENDING;
    let total = current.total - previous.total;
    return total > 0 ? (total - (current.idle - previous.idle)) / total : 0;
}

export function counterRate(sample, getCounter) {
    let current = getCounter(sample.value);
    if (current === undefined) return undefined;
    if (!sample.previous) return PENDING;
    let previous = getCounter(sample.previous.value);
    let elapsed = sample.time - sample.previous.time;
    if (previous === undefined || current < previous || elapsed <= 0)
        return PENDING;
    return (current - previous) / elapsed;
}

export function parseMemory(contents) {
    return Object.fromEntries(contents.trim().split('\n').map(line => {
        let colon = line.indexOf(':');
        return [line.slice(0, colon), Number.parseInt(line.slice(colon + 1)) * 1024];
    }));
}

export function parseBattery(contents) {
    let fields = Object.fromEntries(contents.trim().split('\n').map(line => {
        let equal = line.indexOf('=');
        return [line.slice(0, equal).replace('POWER_SUPPLY_', ''), line.slice(equal + 1)];
    }));
    let voltage = Number(fields.VOLTAGE_NOW) / 1000000;
    let designVoltage = Number(fields.VOLTAGE_MIN_DESIGN) / 1000000;
    let power = fields.POWER_NOW === undefined
        ? voltage * Number(fields.CURRENT_NOW) / 1000000
        : Number(fields.POWER_NOW) / 1000000;
    let energy = (energyKey, chargeKey) => fields[energyKey] === undefined
        ? Number(fields[chargeKey]) * designVoltage / 1000000
        : Number(fields[energyKey]) / 1000000;
    return {
        state: fields.STATUS,
        cycles: fields.CYCLE_COUNT === undefined ? undefined : Number(fields.CYCLE_COUNT),
        voltage,
        level: fields.CAPACITY_LEVEL,
        percentage: Number(fields.CAPACITY) / 100,
        power: fields.STATUS == 'Discharging' ? -power : power,
        full: energy('ENERGY_FULL', 'CHARGE_FULL'),
        design: energy('ENERGY_FULL_DESIGN', 'CHARGE_FULL_DESIGN'),
        now: energy('ENERGY_NOW', 'CHARGE_NOW')
    };
}

export function batteryTime(battery) {
    if (battery.state != 'Charging' && battery.state != 'Discharging')
        return battery.state;
    if (!Number.isFinite(battery.power) || battery.power == 0)
        return undefined;
    let remaining = battery.state == 'Charging' ? battery.full - battery.now : battery.now;
    return remaining / Math.abs(battery.power) * 3600;
}

export function sum(samples) {
    return samples.reduce((total, sample) => total + sample.value, 0);
}

export function average(samples) {
    return samples.length ? sum(samples) / samples.length : undefined;
}
