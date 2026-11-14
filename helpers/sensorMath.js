// Returned by a computation that has no value yet, such as a rate after its first counter reading.
export const PENDING = Symbol('pending');

export function splitFields(text) {
    const fields = [];
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
        if (index === text.length || text[index] <= ' ') {
            if (start < index)
                fields.push(text.slice(start, index));
            start = index + 1;
        }
    }
    return fields;
}

// Exclude autofs entries so querying filesystem space does not trigger idle automounts.
export function parseMountTable(mountTable) {
    const mounts = new Map();
    for (const line of mountTable.trim().split('\n')) {
        // A space in a path is written as \040.
        const fields = line.split(' ').map(field => field.replace(/\\([0-7]{3})/g, (_, octal) =>
            String.fromCharCode(Number.parseInt(octal, 8))));
        const [type, source] = fields.slice(fields.indexOf('-') + 1);
        if (type === 'autofs')
            mounts.delete(fields[4]);
        else
            mounts.set(fields[4], {type, source, device: fields[2]});
    }
    return mounts;
}

// The filesystem types that df counts as being on another machine (is_remote_fs_type_name in gnulib).
const REMOTE_TYPES = new Set(['acfs', 'afs', 'autofs', 'auristorfs', 'cachefs', 'ceph', 'cifs', 'coda', 'fhgfs', 'gfs',
    'gfs2', 'gpfs', 'ibrix', 'lustre', 'ncpfs', 'netfs', 'nfs', 'nfs3', 'nfs4', 'ocfs2', 'panfs', 'smb', 'smb2', 'smb3',
    'smbfs', 'snfs', 'stnfs', 'userlandfs', 'vxfs', 'websearchfs']);

// Whether a mount is on another machine. The rule is df's (ME_REMOTE in gnulib), taken as it is.
export function isRemoteMount({type, source}) {
    return source.includes(':') || source === '-hosts' || REMOTE_TYPES.has(type);
}

// The filesystem types that need no block device, from the text of /proc/filesystems.
export function parseTypesWithoutDevice(filesystems) {
    return new Set(filesystems.trim().split('\n').filter(line => line.startsWith('nodev')).map(line => line.slice(5).trim()));
}

export function parseNetwork(contents) {
    const interfaces = new Map();
    for (const line of contents.trim().split('\n').slice(2)) {
        const colon = line.lastIndexOf(':');
        const name = line.slice(0, colon).trim();
        const fields = splitFields(line.slice(colon + 1)).map(Number);
        if (colon < 0 || fields.length < 16 || fields.some(value => !Number.isFinite(value)))
            throw new Error(`Invalid /proc/net/dev row: ${line}`);
        interfaces.set(name, {rx: fields[0], tx: fields[8]});
    }
    return interfaces;
}

export function parseCpuStat(contents) {
    const cores = new Map();
    for (const line of contents.split('\n')) {
        if (!line.startsWith('cpu'))
            continue;
        const [name, ...fields] = splitFields(line);
        if (name !== 'cpu' && !Number.isInteger(Number(name.slice(3))))
            continue;
        const ticks = fields.slice(0, 8).map(Number);
        const total = ticks.reduce((accumulated, value) => accumulated + value, 0);
        cores.set(name, {total, idle: ticks[3] + ticks[4]});
    }
    return cores;
}

export function cpuUsage(sample, core) {
    const current = sample.value.get(core);
    const previous = sample.previous?.value.get(core);
    if (!current)
        return undefined;
    if (!previous || current.total < previous.total || current.idle < previous.idle)
        return PENDING;
    const total = current.total - previous.total;
    return total > 0 ? (total - (current.idle - previous.idle)) / total : 0;
}

export function counterRate(sample, getCounter) {
    const current = getCounter(sample.value);
    if (current === undefined)
        return undefined;
    if (!sample.previous)
        return PENDING;
    const previous = getCounter(sample.previous.value);
    const elapsed = sample.time - sample.previous.time;
    if (previous === undefined || current < previous || elapsed <= 0)
        return PENDING;
    return (current - previous) / elapsed;
}

export function parseMemory(contents) {
    return Object.fromEntries(contents.trim().split('\n').map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), Number.parseInt(line.slice(colon + 1)) * 1024];
    }));
}

export function parseBattery(contents) {
    const fields = Object.fromEntries(contents.trim().split('\n').map(line => {
        const equal = line.indexOf('=');
        return [line.slice(0, equal).replace('POWER_SUPPLY_', ''), line.slice(equal + 1)];
    }));
    const voltage = Number(fields.VOLTAGE_NOW) / 1000000;
    const designVoltage = Number(fields.VOLTAGE_MIN_DESIGN) / 1000000;
    // Some drivers give a discharging battery's power or current as a negative number, others as a positive one. As
    // UPower does, only the size is taken from them, and the sign comes from the status.
    const power = Math.abs(fields.POWER_NOW === undefined
        ? voltage * Number(fields.CURRENT_NOW) / 1000000
        : Number(fields.POWER_NOW) / 1000000);
    const energy = (energyKey, chargeKey) => fields[energyKey] === undefined
        ? Number(fields[chargeKey]) * designVoltage / 1000000
        : Number(fields[energyKey]) / 1000000;
    return {
        state: fields.STATUS,
        cycles: fields.CYCLE_COUNT === undefined ? undefined : Number(fields.CYCLE_COUNT),
        voltage,
        level: fields.CAPACITY_LEVEL,
        percentage: Number(fields.CAPACITY) / 100,
        power: fields.STATUS === 'Discharging' ? -power : power,
        full: energy('ENERGY_FULL', 'CHARGE_FULL'),
        design: energy('ENERGY_FULL_DESIGN', 'CHARGE_FULL_DESIGN'),
        now: energy('ENERGY_NOW', 'CHARGE_NOW'),
    };
}

export function batteryTime(battery) {
    if (battery.state !== 'Charging' && battery.state !== 'Discharging')
        return battery.state;
    if (!Number.isFinite(battery.power) || battery.power === 0)
        return undefined;
    const remaining = battery.state === 'Charging' ? battery.full - battery.now : battery.now;
    return remaining / Math.abs(battery.power) * 3600;
}

export function sum(samples) {
    return samples.reduce((total, sample) => total + sample.value, 0);
}

export function average(samples) {
    return samples.length ? sum(samples) / samples.length : undefined;
}
