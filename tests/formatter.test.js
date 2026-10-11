import {Formatter} from '../formatter.js';
import {test, equal, runTests} from './harness.js';

test('formatting changes have no measurement state or I/O', () => {
    let options = {'unit': 0, 'memory-measurement': 0, 'storage-measurement': 0,
        'network-speed-format': 0, 'network-speed-unit': 0};
    let settings = {
        get_boolean: key => Boolean(options[key]),
        get_int: key => options[key] || 0,
        get_strv: () => []
    };
    let formatter = new Formatter(settings);
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

test('storage rates use storage units and a per-second suffix', () => {
    let measurement = 0;
    let formatter = new Formatter({
        get_boolean: () => false,
        get_int: key => key == 'storage-measurement' ? measurement : 1,
        get_strv: () => []
    });
    equal(formatter.format(1024, 'storage-rate', 'storage', 'read').text, '1.0 KiB/s');
    equal(formatter.format(0, 'storage-rate', 'storage', 'read').text, '0.0 B/s');
    measurement = 1;
    equal(formatter.format(1000, 'storage-rate', 'storage', 'read').text, '1.0 kB/s');
});

test('network speeds are written per second with a slash, in bytes and in bits', () => {
    let options = {'network-speed-format': 0, 'network-speed-unit': 0};
    let formatter = new Formatter({
        get_boolean: () => false,
        get_int: key => options[key],
        get_strv: () => []
    });
    equal(formatter.format(500, 'speed', 'network', 'rx').text, '500 B/s');
    equal(formatter.format(2000, 'speed', 'network', 'rx').text, '2 kB/s');
    equal(formatter.format(3000000, 'speed', 'network', 'rx').text, '3 MB/s');
    options['network-speed-format'] = 1;
    equal(formatter.format(50, 'speed', 'network', 'rx').text, '400 bit/s');
    equal(formatter.format(250, 'speed', 'network', 'rx').text, '2 kbit/s');
    equal(formatter.format(375000, 'speed', 'network', 'rx').text, '3 Mbit/s');
});

await runTests();
