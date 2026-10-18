import {PENDING, cpuUsage, parseCpuStat, parseNetwork, parseMountTable, isRemoteMount, parseTypesWithoutDevice, parseBattery, batteryTime} from '../helpers/sensorMath.js';
import {test, equal, runTests} from './harness.js';

test('a network snapshot with an incomplete row is rejected', () => {
    let header = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n';
    let rejected = false;
    try {
        parseNetwork(header + 'vpn0: 100 0');
    } catch (error) {
        // The throw is the expected outcome; the assertion below fails when it is missing.
        rejected = true;
    }
    equal(rejected, true);
});

test('CPU rates use counter deltas and a zero counter is a valid baseline', () => {
    let ticks = {user: 20, nice: 0, system: 10, idle: 60, iowait: 10};
    let total = Object.values(ticks).reduce((sum, count) => sum + count, 0);
    let previous = parseCpuStat('cpu 0 0 0 0 0 0 0 0 0 0');
    let value = parseCpuStat('cpu ' + Object.values(ticks).join(' ') + ' 0 0 0 0 0');
    equal(cpuUsage({value, previous: {value: previous}}, 'cpu'), (total - ticks.idle - ticks.iowait) / total);
    equal(cpuUsage({value}, 'cpu'), PENDING);
});

test('a battery that reports charge instead of energy has its values in watts and watt-hours', () => {
    // sysfs reports microvolts, microamperes and microampere-hours.
    let micro = 1000000;
    let volts = 12, amperes = 1, ampereHoursNow = 2, ampereHoursFull = 4;
    let battery = parseBattery(
        'POWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=' + volts * micro + '\n' +
        'POWER_SUPPLY_VOLTAGE_MIN_DESIGN=' + volts * micro + '\nPOWER_SUPPLY_CURRENT_NOW=' + amperes * micro + '\n' +
        'POWER_SUPPLY_CHARGE_NOW=' + ampereHoursNow * micro + '\nPOWER_SUPPLY_CHARGE_FULL=' + ampereHoursFull * micro + '\n');
    let watts = volts * amperes;
    let wattHoursNow = ampereHoursNow * volts;
    equal(battery.voltage, volts);
    equal(battery.power, -watts, 'discharging power is negative');
    equal(battery.now, wattHoursNow);
    equal(batteryTime(battery), wattHoursNow / watts * 3600);
});

test('a battery\'s power rate takes its sign from the status, whatever sign the driver gives', () => {
    let micro = 1000000;
    let watts = 5, volts = 12, amperes = 0.5;
    let power = (status, field, value) => parseBattery('POWER_SUPPLY_STATUS=' + status + '\nPOWER_SUPPLY_VOLTAGE_NOW=' +
        volts * micro + '\nPOWER_SUPPLY_' + field + '=' + value * micro + '\n').power;
    // The battery driver of Apple's machines (macsmc-battery) gives a negative number while discharging.
    equal(power('Discharging', 'POWER_NOW', -watts), -watts, 'negative power from the driver');
    equal(power('Discharging', 'CURRENT_NOW', -amperes), -volts * amperes, 'negative current from the driver');
    equal(power('Discharging', 'POWER_NOW', watts), -watts, 'positive power from the driver');
    equal(power('Charging', 'POWER_NOW', watts), watts);
    equal(power('Charging', 'POWER_NOW', -watts), watts);
});

test('the mount on top is what is mounted at a place', () => {
    let disk = '30 20 8:17 / /mnt rw - ext4 /dev/sdb1 rw\n';
    let memory = '31 30 0:50 / /mnt rw - tmpfs tmpfs rw\n';
    let automount = '55 20 0:45 / /mnt rw - autofs systemd-1 rw\n';
    equal(JSON.stringify(parseMountTable(disk).get('/mnt')), JSON.stringify({type: 'ext4', source: '/dev/sdb1', device: '8:17'}));
    equal(parseMountTable(disk + memory).get('/mnt').type, 'tmpfs', 'a disk hidden under another mount');
    equal(parseMountTable(memory + disk).get('/mnt').type, 'ext4', 'a disk mounted over another mount');
    equal(parseMountTable(automount).has('/mnt'), false, 'an automount that waits is no mount');
    equal(parseMountTable(disk + automount).has('/mnt'), false, 'nor is what it hides');
    equal(parseMountTable(automount + disk).get('/mnt').type, 'ext4', 'what it connected is');
});

test('a mount is on another machine by df\'s rule', () => {
    equal(isRemoteMount({type: 'cifs', source: '//server/share'}), true, 'by its type');
    equal(isRemoteMount({type: 'fuse.sshfs', source: 'user@host:/data'}), true, 'by the colon in its source');
    equal(isRemoteMount({type: 'ext4', source: '/dev/sdb1'}), false);
    equal(isRemoteMount({type: 'zfs', source: 'tank'}), false);
});

test('the kernel marks the filesystem types that need no block device', () => {
    let types = parseTypesWithoutDevice('nodev\tproc\n\text4\nnodev\tcifs\n');
    equal([...types].join(','), 'proc,cifs');
});

await runTests();
