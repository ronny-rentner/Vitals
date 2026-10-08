import {PENDING, cpuUsage, parseCpuStat, parseNetwork, parseMemory, parseBattery, batteryTime} from '../helpers/sensorMath.js';
import {test, equal, runTests} from './harness.js';

test('network snapshot parses every interface and rejects incomplete rows', () => {
    let header = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n';
    let row = (name, {rx, tx}) => name + ': ' + rx + ' 0 0 0 0 0 0 0 ' + tx + ' 0 0 0 0 0 0 0\n';
    let vpn = {rx: 100, tx: 50};
    let snapshot = parseNetwork(header + row('lo', {rx: 2, tx: 2}) + row('vpn0', vpn) + row('br0', {rx: 200, tx: 75}));
    equal(snapshot.get('vpn0').rx, vpn.rx);
    equal(snapshot.get('vpn0').tx, vpn.tx);
    equal(snapshot.has('br0'), true);
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

test('memory and battery inputs use canonical units', () => {
    let kilobytes = 1024;
    equal(parseMemory('MemTotal: ' + kilobytes + ' kB\n').MemTotal, kilobytes * 1024);

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

await runTests();
