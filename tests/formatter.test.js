import {Formatter} from '../formatter.js';
import {test, equal, runTests} from './harness.js';

test('formatting changes have no measurement state or I/O', () => {
    const options = {
        'unit': 0, 'memory-measurement': 0, 'storage-measurement': 0,
        'network-speed-format': 0, 'network-speed-unit': 0,
    };
    const settings = {
        get_boolean: key => Boolean(options[key]),
        get_int: key => options[key] || 0,
        get_strv: () => [],
    };
    const formatter = new Formatter(settings);
    equal(formatter.format(45.1, 'temp', 'temperature', 't').text, '45 °C');
    equal(formatter.format(45.9, 'temp', 'temperature', 't').text, '45 °C');
    options.unit = 1;
    equal(formatter.format(45, 'temp', 'temperature', 't').text, '113 °F');
    equal(formatter.format(1048576, 'memory', 'memory', 'm').text, '1.0 MiB');
    equal(formatter.format(45, 'watt-limit', 'processor', 'p').text, '45 W');
    equal(formatter.format(-1.2, 'in', 'voltage', 'v').text, '-1.2 V');
    equal(formatter.format('3x16', 'pcie', 'gpu', 'g').text, 'PCIe 3 x16');
    equal(formatter.format('Full', 'runtime', 'battery', 'b').text, 'Full');
    equal('resetHistory' in formatter, false);
});

test('WiFi signal levels keep their sign and dBm unit at either precision', () => {
    for (const precise of [false, true]) {
        const formatter = new Formatter({get_boolean: () => precise, get_int: () => 0, get_strv: () => []});
        for (const value of [-110, -90, -70, -50, 0]) {
            const formatted = formatter.format(value, 'dbm', 'network', 'wifi-signal-level', true);
            equal(formatted.text, `${value} dBm`);
            equal(formatted.unit, ' dBm');
        }
    }
});

test('storage rates use storage units and a per-second suffix', () => {
    let measurement = 0;
    const formatter = new Formatter({
        get_boolean: () => false,
        get_int: key => key === 'storage-measurement' ? measurement : 1,
        get_strv: () => [],
    });
    equal(formatter.format(1024, 'storage-rate', 'storage', 'read').text, '1.0 KiB/s');
    equal(formatter.format(0, 'storage-rate', 'storage', 'read').text, '0.0 B/s');
    measurement = 1;
    equal(formatter.format(1000, 'storage-rate', 'storage', 'read').text, '1.0 kB/s');
});

test('network speeds are written per second with a slash, from kB/s or kbit/s on, with a decimal below 10', () => {
    const options = {'network-speed-format': 0, 'network-speed-unit': 0};
    const formatter = new Formatter({
        get_boolean: () => false,
        get_int: key => options[key],
        get_strv: () => [],
    });
    equal(formatter.format(500, 'speed', 'network', 'rx').text, '0.5 kB/s');
    equal(formatter.format(2000, 'speed', 'network', 'rx').text, '2.0 kB/s');
    equal(formatter.format(12000, 'speed', 'network', 'rx').text, '12 kB/s');
    equal(formatter.format(3000000, 'speed', 'network', 'rx').text, '3.0 MB/s');
    options['network-speed-format'] = 1;
    equal(formatter.format(50, 'speed', 'network', 'rx').text, '0.4 kbit/s');
    equal(formatter.format(250, 'speed', 'network', 'rx').text, '2.0 kbit/s');
    equal(formatter.format(375000, 'speed', 'network', 'rx').text, '3.0 Mbit/s');
});

test('displayed memory totals add up at either precision and in decimal or binary units', () => {
    for (const measurement of [0, 1]) {
        for (const precise of [false, true]) {
            const formatter = new Formatter({get_boolean: () => precise, get_int: () => measurement, get_strv: () => []});
            const base = measurement ? 1000 : 1024;
            // Each independently rounded difference would disagree with at least one displayed total.
            const total = 33.349 * base ** 3, available = 10.851 * base ** 3, free = 7.024 * base ** 3;
            const display = (...operands) => formatter.format(operands.reduce((left, right) => left - right),
                'memory', 'memory', 'm', false, {total, operands});
            const parts = [[total], [available], [free], [total, available], [available, free]].map(operands => display(...operands));
            const [whole, usable, unused, used, reclaimed] = parts.map(part => Math.round(Number.parseFloat(part.text) * (precise ? 100 : 10)));
            equal(used + usable, whole);
            equal(unused + reclaimed, usable);
            equal(new Set(parts.map(part => part.unit)).size, 1, 'all parts use the total\'s unit');
            equal(display(0).unit, parts[0].unit, 'zero keeps that unit too');
        }
    }
});

await runTests();
