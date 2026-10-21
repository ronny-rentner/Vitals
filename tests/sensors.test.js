import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Sensors} from '../sensors.js';
import {toVariant, sensorPresent} from '../helpers/storedCatalog.js';
import {test, atEnd, equal, near, between, mean, settings, takeFaults, settle, wait, runTests} from './harness.js';
import {Machine} from './machine.js';
import {devices, filesystems} from './fixtures/machine.js';

const CORETEMP = '/sys/class/hwmon/hwmon3/';
const BATTERY = '/sys/class/hwmon/hwmon4/';
const THINKPAD = '/sys/class/hwmon/hwmon5/';
const NVME = '/sys/class/hwmon/hwmon6/';
const USB = '/sys/class/hwmon/hwmon8/';
const SECOND_NVME = '/sys/class/hwmon/hwmon9/';
const ZONES = '/sys/class/thermal/';
const NETWORK = '/proc/net/dev';
const DISKS = '/proc/diskstats';
const MOUNTS = '/proc/self/mountinfo';
const USB_DRIVE = '/media/USB drive';
const SHARE = '/media/share';
// The temperature files Vitals reports. Not among them: thermal_zone1 (the policy zone),
// thermal_zone8 (the package temperature coretemp reports) and thermal_zone9 (published through hwmon7).
const TEMPERATURES = [
    CORETEMP + 'temp1_input', THINKPAD + 'temp1_input', THINKPAD + 'temp2_input', NVME + 'temp1_input',
    '/sys/class/hwmon/hwmon7/temp1_input', ZONES + 'thermal_zone2/temp', ZONES + 'thermal_zone6/temp'
];
const SECTOR_BYTES = 512;
const YEAR_SECONDS = 365 * 86400;

// Lets the first reading of a rate finish, skips the second after which its second reading follows, and lets that
// finish too.
const secondReading = async machine => {
    await settle();
    machine.skip(1);
    await settle();
};
// Seconds of the machine's clock. The span of a rate after its second reading is at least a second, since the
// second reading never comes early, and at most the seconds the test measured around both readings.
const clock = () => GLib.get_monotonic_time() / 1000000;

// What one test works on: the machine, in place of the system, and a Sensors instance that reads it. A test that
// launches a second time passes the settings of the first.
function setup(configuration = settings()) {
    let machine = new Machine();
    machine.install();
    atEnd(() => machine.uninstall());
    let nvidiaSmi = installNvidiaSmi();
    let sensors = new Sensors(configuration, text => text);
    return {
        sensors, configuration, machine, nvidiaSmi,
        // sysfs stores temperatures and voltages in thousandths of °C and V.
        fileValue: path => Number(machine.content(path)) / 1000,
        // How often the file was read so far.
        reads: path => machine.reads.filter(read => read == path).length,
        // The sensor with this key that is on the machine, if there is one.
        find(categoryName, key) {
            let category = sensors.catalog[categoryName];
            return category.sensors.find(sensor => sensor.key == key && sensorPresent(category, sensor));
        },
        // Marks what is on screen, as the renderer does: the given sensors, and the category header of each named category.
        show(...shown) {
            for (let [name, category] of sensors.categories()) {
                category.runtime.shown = shown.includes(name);
                for (let sensor of category.sensors)
                    sensor.runtime.shown = shown.includes(sensor);
            }
            sensors.shownChanged();
        }
    };
}

function keys(category) {
    return category.sensors.map(sensor => sensor.key).join(', ');
}

// /proc/net/dev as the kernel writes it, for the given byte counters.
function networkDevices(counters) {
    return devices.system[NETWORK](0).split('\n').slice(0, 2).join('\n') + '\n' +
        Object.entries(counters).map(([name, {rx, tx}]) =>
            name + ': ' + rx + ' 0 0 0 0 0 0 0 ' + tx + ' 0 0 0 0 0 0 0\n').join('');
}

// The stand-in nvidia-smi of tests/fixtures/programs, first in PATH for the test, so that no test runs the real one.
// It reports the cards the test gives it, none at first, and logs every start.
function installNvidiaSmi() {
    let directory = GLib.dir_make_tmp('vitals-nvidia-XXXXXX');
    let cardsFile = directory + '/cards', logFile = directory + '/log';
    let environment = ['PATH', 'NVIDIA_SMI_CARDS', 'NVIDIA_SMI_LOG'].map(name => [name, GLib.getenv(name)]);
    GLib.setenv('NVIDIA_SMI_CARDS', cardsFile, true);
    GLib.setenv('NVIDIA_SMI_LOG', logFile, true);
    GLib.setenv('PATH', GLib.get_current_dir() + '/tests/fixtures/programs:' + GLib.getenv('PATH'), true);
    atEnd(() => {
        for (let [name, value] of environment) {
            if (value === null) GLib.unsetenv(name);
            else GLib.setenv(name, value, true);
        }
        for (let file of [cardsFile, logFile, directory])
            GLib.remove(file);
    });
    // The processes started with -l, which keep reporting until they are stopped.
    let streams = () => new TextDecoder().decode(GLib.file_get_contents(logFile)[1]).split('\n')
        .filter(start => start.includes(' -l ')).map(start => {
            let [pid, ...startArguments] = start.split(' ');
            return {
                pid, interval: Number(startArguments[startArguments.indexOf('-l') + 1]),
                queriedFields: startArguments.find(argument => argument.startsWith('--query-gpu=')).slice('--query-gpu='.length)
            };
        });
    let nvidiaSmi = {
        setCards(cards) {
            GLib.file_set_contents(cardsFile, cards.map(card =>
                Object.entries(card).map(([field, fieldValue]) => field + '=' + fieldValue).join(';') + '\n').join(''));
        },
        streams,
        // Resolves when every started stream process has exited; the test fails if one is still running after a second.
        async allStopped() {
            for (let attempt = 0; streams().some(({pid}) => GLib.file_test('/proc/' + pid, GLib.FileTest.EXISTS)); attempt++) {
                if (attempt == 20) throw new Error('an nvidia-smi stream is still running');
                await wait(0.05);
            }
        }
    };
    GLib.file_set_contents(logFile, '');
    nvidiaSmi.setCards([]);
    return nvidiaSmi;
}

// Discovery

test('every category has the default pin its rule names', async () => {
    let {sensors, configuration, machine, find} = setup();
    configuration.set_value('catalog-settings', toVariant({gpu: {enabled: true}}));
    sensors.reloadEnabled();
    machine.plug('amdGpu');
    await sensors.discover();
    for (let [categoryName, key] of [['temperature', 'average'], ['voltage', 'BAT0/in0'], ['fan', 'thinkpad/fan1'],
        ['memory', 'usage'], ['processor', 'usage'], ['system', 'load-1m'], ['network', 'device-rx'],
        ['storage', '//free'], ['battery', 'BAT0/power-rate'], ['gpu', '0x1002/gpu_busy_percent']])
        equal(sensors.categoryPin(categoryName), find(categoryName, key), categoryName);
    sensors.destroy();
});

test('a thermal zone is listed once, through hwmon where the kernel publishes it there, and CPU package zone only without coretemp', async () => {
    let {sensors, machine, find} = setup();
    // A second ACPI zone: the kernel adds it to the hwmon device of the first as temp2 and gives it no directory of its own.
    for (let [path, content] of [['/sys/class/hwmon/hwmon0/name', 'acpitz'], ['/sys/class/hwmon/hwmon0/temp1_input', '45000'],
        ['/sys/class/hwmon/hwmon0/temp2_input', '48000'], [ZONES + 'thermal_zone0/type', 'acpitz'],
        [ZONES + 'thermal_zone0/temp', '45000'], [ZONES + 'thermal_zone0/hwmon0/name', 'acpitz'],
        [ZONES + 'thermal_zone3/type', 'acpitz'], [ZONES + 'thermal_zone3/temp', '48000']])
        machine.setContent(path, content + '\n');
    for (let file of ['name', 'temp1_label', 'temp1_input'])
        machine.remove(CORETEMP + file);
    await sensors.discover();
    equal(find('temperature', 'acpitz/temp1') !== undefined && find('temperature', 'acpitz/temp2') !== undefined, true,
        'both zones through hwmon');
    equal(find('temperature', 'thermal/acpitz'), undefined, 'neither a second time');
    equal(find('temperature', 'thermal/x86_pkg_temp') !== undefined, true, 'the package zone without coretemp');
    sensors.destroy();
});

test('two devices with the same name each get a sensor with a key of its own, read from its own file', async () => {
    let {sensors, machine, fileValue, show} = setup();
    // Every NVMe drive registers its hwmon device under the name "nvme".
    machine.plug('secondNvme');
    await sensors.discover();
    let twins = () => sensors.catalog.temperature.sensors.filter(sensor => [NVME, SECOND_NVME].map(drive => drive + 'temp1_input').includes(sensor.file));
    equal(new Set(twins().map(sensor => sensor.key)).size, 2, 'two keys');
    equal(twins().map(sensor => sensor.file).join(', '), NVME + 'temp1_input, ' + SECOND_NVME + 'temp1_input');
    await sensors.discover();
    equal(twins().length, 2, 'a later run matches both again and adds none');
    show(...twins());
    await settle();
    equal(twins().map(sensor => sensor.value).join(', '), [NVME, SECOND_NVME].map(drive => fileValue(drive + 'temp1_input')).join(', '));
    sensors.destroy();
});

test('discovery uses settings changed while its reads are pending', async () => {
    let {sensors, configuration, machine, find} = setup();
    machine.plug('usbDrive');
    let mountsRead = machine.holdNextRead(MOUNTS);
    let firstDiscovery = sensors.discover();
    configuration.set_strv('storage-locations', [USB_DRIVE]);
    let secondDiscovery = sensors.discover();
    mountsRead.finish();
    await Promise.all([firstDiscovery, secondDiscovery]);
    equal(find('storage', '//free'), undefined, 'the location that was removed meanwhile');
    equal(find('storage', USB_DRIVE + '/free').status, 'pending', 'the one that was added');
    sensors.destroy();
});

test('an unplugged device stays in the catalog and is not read; when it returns it is the same sensor in the same place', async () => {
    let {sensors, machine, reads, show} = setup();
    machine.plug('secondNvme');
    await sensors.discover();
    let category = sensors.catalog.temperature;
    let secondDrive = category.sensors.find(sensor => sensor.file == SECOND_NVME + 'temp1_input');
    let order = keys(category);
    show(secondDrive);
    await settle();
    machine.unplug('secondNvme');
    await sensors.discover();
    equal(sensorPresent(category, secondDrive), false, 'not present');
    equal(category.sensors.includes(secondDrive), true, 'still in the catalog');
    let readsWhilePresent = reads(SECOND_NVME + 'temp1_input');
    await sensors.poll();
    equal(reads(SECOND_NVME + 'temp1_input'), readsWhilePresent, 'not read, although it is marked as shown');
    machine.plug('secondNvme');
    await sensors.discover();
    equal(sensorPresent(category, secondDrive), true, 'the same sensor is present again');
    equal(keys(category), order, 'in the same place');
    sensors.destroy();
});

test('a kernel number that passes to another device does not make the old sensor read the new device', async () => {
    let {sensors, machine, fileValue, find, show} = setup();
    await sensors.discover();
    let usbVoltage = find('voltage', 'ucsi_source_psy_USBC000:001/in0');
    show(usbVoltage);
    await settle();
    let lastUsbReading = usbVoltage.value;
    // The USB supply is unplugged and another device gets hwmon8.
    machine.setContent(USB + 'name', 'other_supply\n');
    machine.setContent(USB + 'in0_input', '9000\n');
    await sensors.discover();
    let otherVoltage = find('voltage', 'other_supply/in0');
    show(usbVoltage, otherVoltage);
    await sensors.poll();
    equal(otherVoltage.value, fileValue(USB + 'in0_input'), 'the new device is read');
    equal(usbVoltage.file, otherVoltage.file, 'the old sensor still names the same file');
    equal(usbVoltage.value, lastUsbReading, 'and is not read through it');
    sensors.destroy();
});

test('a discovery step that fails is reported and leaves its categories as they were', async () => {
    let {sensors, machine, find} = setup();
    await sensors.discover();
    let discoveredBefore = sensors.catalog.temperature.discovered;
    machine.failLists('/sys/class/hwmon/', new Gio.IOErrorEnum({code: Gio.IOErrorEnum.FAILED, message: 'Input/output error'}));
    // On the same stream as the error, so that it stands right before it.
    printerr('WARNING: the next error, discover:hwmon, is caused on purpose by this test and is expected:');
    await sensors.discover();
    equal(takeFaults().length, 1, 'the failure is reported');
    equal(sensors.catalog.temperature.discovered, discoveredBefore, 'the category is not completed');
    equal(find('temperature', 'thinkpad/temp1') !== undefined, true, 'its sensors are still present');
    equal(sensors.catalog.memory.discovered > discoveredBefore, true, 'other categories are completed');
    sensors.destroy();
});

test('no sensor is read during a discovery run, and a rate does not start over because of one', async () => {
    let {sensors, machine, reads, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    show(download);
    await secondReading(machine);
    let mountsRead = machine.holdNextRead(MOUNTS);
    let run = sensors.discover();
    // Let the run get as far as the read it is held at.
    await settle();
    let readsBeforeTick = reads(NETWORK);
    await sensors.poll();
    equal(reads(NETWORK), readsBeforeTick, 'a tick that falls into a run reads nothing');
    mountsRead.finish();
    await run;
    await sensors.poll();
    equal(download.status, 'ready', 'the rate is computed against the last reading before the run');
    sensors.destroy();
});

test('a discovery run cancels a read that is under way, and its late result is dropped', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let uptime = find('system', 'uptime');
    machine.setContent('/proc/uptime', '100.00 50.00\n');
    let uptimeRead = machine.holdNextRead('/proc/uptime');
    show(uptime);
    await settle();
    let readAfterRun = machine.holdNextRead('/proc/uptime');
    await sensors.discover();
    equal(uptimeRead.cancellable.is_cancelled(), true, 'the read is cancelled when the run starts');
    uptimeRead.finish();
    await settle();
    equal(uptime.value, undefined, 'the late result is not taken');
    equal(typeof readAfterRun.finish, 'function', 'the sensor is read again when the run ends, without a tick');
    readAfterRun.finish();
    await settle();
    equal(uptime.value, 100);
    sensors.destroy();
});

test('hide-zeros leaves out a temperature that reads zero at discovery, until a run reads a value; then it stays', async () => {
    let {sensors, configuration, machine, fileValue, reads, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.setContent(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp2'), undefined, 'left out');
    let average = find('temperature', 'average');
    show(average);
    await settle();
    equal(reads(THINKPAD + 'temp2_input'), 1, 'read once, by discovery');
    equal(average.value, mean(TEMPERATURES.filter(path => path != THINKPAD + 'temp2_input').map(fileValue)), 'not averaged');
    machine.setContent(THINKPAD + 'temp2_input', '10000\n');
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp2'), undefined, 'a reading does not take it in');
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'a run does');
    machine.setContent(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'a later zero does not take it out again');
    equal(average.value, mean(TEMPERATURES.map(fileValue)), 'and the zero is averaged');
    sensors.destroy();
});

test('hide-zeros leaves fans, voltages and unreadable temperatures alone, and switched off it takes zeros in', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    for (let file of ['fan1_input', 'in1_input', 'temp2_input'])
        machine.setContent(THINKPAD + file, '0\n');
    machine.failReads(THINKPAD + 'temp1_input',
        new Gio.IOErrorEnum({code: Gio.IOErrorEnum.FAILED, message: 'No such device or address'}));
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp1'), undefined, 'a temperature that cannot be read is left out');
    equal(find('temperature', 'thermal/SEN1') !== undefined, true, 'without stopping the run');
    let zeros = [find('fan', 'thinkpad/fan1'), find('voltage', 'thinkpad/in1')];
    show(...zeros);
    await settle();
    equal(zeros.map(sensor => sensor.value).join(','), '0,0');
    configuration.set_boolean('hide-zeros', false);
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'a zero temperature is taken in');
    sensors.destroy();
});

// Reading

test('only what is on screen is read, at once, and a file that several sensors on screen come from is read once', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    await sensors.discover();
    let kilobytes = name => Number(machine.content('/proc/meminfo').match(new RegExp(name + ':\\s*(\\d+)'))[1]);
    machine.reads.length = 0;
    show(find('memory', 'usage'), find('memory', 'free'), find('network', 'combined'));
    await settle();
    equal(machine.reads.sort().join(','), '/proc/meminfo,/proc/net/dev', 'when they come on screen, without a tick');
    equal(find('memory', 'usage').value, (kilobytes('MemTotal') - kilobytes('MemAvailable')) / kilobytes('MemTotal'));
    equal(find('memory', 'free').value, kilobytes('MemFree') * 1024);
    machine.reads.length = 0;
    show(find('memory', 'usage'), find('memory', 'free'), find('network', 'combined'), find('system', 'uptime'));
    await settle();
    equal(machine.reads.join(','), '/proc/uptime', 'what comes on screen next to them is read alone');
    machine.reads.length = 0;
    await sensors.poll();
    equal(machine.reads.sort().join(','), '/proc/meminfo,/proc/uptime', 'a tick reads them again; the network file waits for its second reading');
    await sensors.discover();
    equal(find('system', 'uptime').status, 'ready', 'discovery keeps the readings');
    machine.reads.length = 0;
    configuration.set_int('unit', 1);
    await settle();
    equal(machine.reads.length, 0, 'a setting of the display reads nothing');
    show();
    await sensors.poll();
    equal(machine.reads.length, 0, 'nothing on screen, nothing read');
    sensors.destroy();
});

test('a sensor that becomes the category pin of a category on screen is read at once', async () => {
    let {sensors, find, show} = setup();
    await sensors.discover();
    let systemVoltage = find('voltage', 'thinkpad/in1');
    show('voltage');
    await settle();
    equal(systemVoltage.status, 'pending', 'a sensor that is neither on screen nor a category pin is not read');
    sensors.pinToCategory('voltage', systemVoltage);
    await settle();
    equal(systemVoltage.status, 'ready');
    sensors.destroy();
});

test('ticks that overlap share the read that is under way, and nothing is read once Sensors is destroyed', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    show(find('memory', 'usage'));
    await settle();
    machine.reads.length = 0;
    let read = machine.holdNextRead('/proc/meminfo');
    let ticks = [sensors.poll(), sensors.poll()];
    await settle();
    read.finish();
    await Promise.all(ticks);
    equal(machine.reads.join(','), '/proc/meminfo');
    machine.reads.length = 0;
    show(find('memory', 'usage'), find('system', 'uptime'));
    sensors.destroy();
    await settle();
    equal(machine.reads.length, 0);
});

test('a read that fails keeps the last value, which is unavailable until a read succeeds again', async () => {
    let {sensors, machine, fileValue, find, show} = setup();
    await sensors.discover();
    let temperature = find('temperature', 'thinkpad/temp1');
    show(temperature);
    await settle();
    let lastValue = temperature.value;
    machine.remove(THINKPAD + 'temp1_input');
    await sensors.poll();
    equal(temperature.status, 'unavailable');
    equal(temperature.value, lastValue);
    machine.setContent(THINKPAD + 'temp1_input', '41000\n');
    await sensors.poll();
    equal(temperature.status, 'ready');
    equal(temperature.value, fileValue(THINKPAD + 'temp1_input'));
    sensors.destroy();
});

test('a rate that comes on screen has its value a second later, without a tick, and back on screen keeps a fresh reading', async () => {
    let {sensors, machine, configuration, reads, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx'), uptime = find('system', 'uptime');
    show(download, uptime);
    await settle();
    equal(download.status, 'pending', 'one reading gives no rate');
    await sensors.poll();
    equal(reads(NETWORK), 2, 'a tick leaves the file to the second reading');
    equal(download.status, 'pending', 'so the rate waits for it');
    await secondReading(machine);
    equal(download.status, 'ready', 'which gives the rate');
    equal(download.value > 0, true);
    equal(reads(NETWORK), 3);
    equal(reads('/proc/uptime'), 2, 'the other file is not read with it');
    show(uptime);
    show(download, uptime);
    await settle();
    equal(download.status + ' ' + reads(NETWORK), 'ready 3', 'back within the update interval, the rate keeps its value until the next tick');
    show(uptime);
    machine.skip(configuration.get_int('update-time'));
    show(download, uptime);
    await settle();
    equal(download.status + ' ' + reads(NETWORK), 'pending 4', 'back later, the file is read and the rate starts over');
    show(uptime);
    await secondReading(machine);
    equal(reads(NETWORK), 4, 'a second reading is called off when its file leaves the screen');
    show(download, uptime);
    await settle();
    equal(download.status + ' ' + reads(NETWORK), 'pending 5', 'a first reading alone is not kept, since its second reading was called off');
    sensors.destroy();
});

test('a tick right after the second reading computes the rate from the first reading, not over a moment', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    let received = rx => networkDevices({lo: {rx: 0, tx: 0}, eth0: {rx, tx: 0}, wlan0: {rx: 0, tx: 0}});
    machine.setContent(NETWORK, received(1000));
    let start = clock();
    show(download);
    await settle();
    machine.setContent(NETWORK, received(2000));
    await secondReading(machine);
    between(download.value, 1000 / (clock() - start), 1000, 'the second reading gives the bytes received per second');
    await sensors.poll();
    between(download.value, 1000 / (clock() - start), 1000, 'the counter stood since the second reading, but the rate spans from the first');
    machine.skip(1);
    await sensors.poll();
    equal(download.value, 0, 'the next tick computes against the tick before');
    sensors.destroy();
});

test('a rate is never computed across a counter that went back or a failed read', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    show(download);
    await secondReading(machine);
    equal(download.status, 'ready');
    machine.setContent(NETWORK, networkDevices({lo: {rx: 0, tx: 0}, eth0: {rx: 5, tx: 5}, wlan0: {rx: 5, tx: 5}}));
    await sensors.poll();
    equal(download.status, 'pending', 'a counter that went back');
    machine.remove(NETWORK);
    await sensors.poll();
    equal(download.status, 'unavailable', 'a failed read');
    machine.restore(NETWORK);
    await sensors.poll();
    equal(download.status, 'pending', 'the reading after it starts over');
    await secondReading(machine);
    equal(download.status, 'ready');
    sensors.destroy();
});

test('what comes on screen during a discovery run, and a second reading, wait for the end of the run', async () => {
    let {sensors, machine, reads, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    let mountsRead = machine.holdNextRead(MOUNTS);
    let run = sensors.discover();
    await settle();
    let readsInRun = reads(NETWORK);
    show(download);
    await settle();
    equal(reads(NETWORK), readsInRun, 'not read during the run');
    mountsRead.finish();
    await run;
    await settle();
    equal(reads(NETWORK), readsInRun + 1, 'read when it ends');

    mountsRead = machine.holdNextRead(MOUNTS);
    run = sensors.discover();
    await settle();
    readsInRun = reads(NETWORK);
    await secondReading(machine);
    equal(reads(NETWORK), readsInRun, 'the second reading is not taken during the run');
    mountsRead.finish();
    await run;
    await settle();
    equal(download.status, 'ready', 'it follows when the run has ended');
    sensors.destroy();
});

test('a finished file writes and publishes its own sensors, and the average follows once when the last is in', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    show(find('temperature', 'average'));
    await settle();
    let published = [];
    sensors.onValuesChanged = written => published.push([...written].map(sensor => sensor.key).join(','));
    let slowRead = machine.holdNextRead(THINKPAD + 'temp1_input');
    let tick = sensors.poll();
    await settle();
    equal(published.length, TEMPERATURES.length - 1, 'every other file published its sensor');
    equal(published.some(keys => keys.includes('thinkpad/temp1') || keys.includes('average')), false,
        'not the slow one, nor the average');
    slowRead.finish();
    await tick;
    equal(published.slice(-2).join(' | '), 'thinkpad/temp1 | average,minimum,maximum', 'then the slow one, then the average');
    sensors.destroy();
});

test('the average, minimum and maximum count every readable sensor of the category, zeros too, hidden ones not', async () => {
    let {sensors, machine, fileValue, reads, find, show} = setup();
    await sensors.discover();
    let [average, minimum, maximum] = ['average', 'minimum', 'maximum'].map(key => find('temperature', key));
    let hidden = find('temperature', 'thinkpad/temp2');
    sensors.setSensorHidden(hidden, true);
    machine.setContent(NVME + 'temp1_input', '0\n');
    machine.remove(THINKPAD + 'temp1_input');
    show(average, minimum, maximum);
    await settle();
    let counted = TEMPERATURES.filter(path => path != THINKPAD + 'temp2_input' && path != THINKPAD + 'temp1_input')
        .map(fileValue);
    equal(reads(THINKPAD + 'temp2_input'), 0, 'a hidden sensor is not read for them');
    equal(average.value, mean(counted));
    equal(minimum.value, 0, 'a zero is a reading');
    equal(maximum.value, Math.max(...counted));
    sensors.setSensorHidden(hidden, false);
    machine.restore(THINKPAD + 'temp1_input');
    await sensors.poll();
    equal(average.value, mean(TEMPERATURES.map(fileValue)), 'shown again and readable again, both count');
    for (let path of TEMPERATURES)
        machine.remove(path);
    await sensors.poll();
    equal(average.status, 'unavailable', 'no readings is not zero');
    sensors.destroy();
});

test('with one temperature there is no average and that temperature is the default pin', async () => {
    let {sensors, machine, find} = setup();
    // Left are the ThinkPad's first temperature and the thermal policy zone, which is no sensor.
    let kept = [THINKPAD + 'name', THINKPAD + 'temp1_input', ZONES + 'thermal_zone1/type', ZONES + 'thermal_zone1/temp'];
    for (let path of Object.keys(devices.system)) {
        if ((path.startsWith('/sys/class/hwmon/') || path.startsWith(ZONES)) && !kept.includes(path))
            machine.remove(path);
    }
    await sensors.discover();
    equal(find('temperature', 'average'), undefined);
    equal(sensors.categoryPin('temperature'), find('temperature', 'thinkpad/temp1'));
    sensors.destroy();
});

test('the voltage\'s default pin is the battery, then the system, then a USB supply, as discovery finds them', async () => {
    let {sensors, machine, fileValue, show} = setup();
    let categoryPin = () => sensors.categoryPin('voltage');
    await sensors.discover();
    machine.reads.length = 0;
    show('voltage');
    await settle();
    equal(categoryPin().value, fileValue(BATTERY + 'in0_input'), 'the battery, whatever its name or value');
    equal(machine.reads.join(','), BATTERY + 'in0_input', 'only the category pin\'s voltage is read for it');
    machine.remove(BATTERY + 'in0_input');
    await sensors.poll();
    equal(categoryPin().status, 'unavailable', 'a category pin that cannot be read keeps its sensor until the next discovery');
    await sensors.discover();
    await settle();
    equal(categoryPin().value, fileValue(THINKPAD + 'in1_input'), 'the system before a USB supply');
    machine.remove(THINKPAD + 'in1_input');
    machine.remove(THINKPAD + 'in2_input');
    await sensors.discover();
    await settle();
    equal(categoryPin().value, fileValue(USB + 'in0_input'), 'a USB supply when it is the only voltage');
    machine.remove(USB + 'in0_input');
    await sensors.discover();
    equal(categoryPin(), undefined, 'no voltage, no category pin');
    sensors.destroy();
});

// Graphics cards and headings

test('a graphics card in /sys/class/drm gives its usage and memory from its own files', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    let card = '/sys/class/drm/card1/device/';
    configuration.set_value('catalog-settings', toVariant({gpu: {enabled: true}}));
    sensors.reloadEnabled();
    machine.plug('amdGpu');
    await sensors.discover();
    let [usage, used, total] = ['gpu_busy_percent', 'mem_info_vram_used', 'mem_info_vram_total'].map(file => find('gpu', '0x1002/' + file));
    show(usage, used, total);
    await settle();
    near(usage.value, Number(machine.content(card + 'gpu_busy_percent')) / 100);
    equal(used.value, Number(machine.content(card + 'mem_info_vram_used')));
    equal(total.value, Number(machine.content(card + 'mem_info_vram_total')));
    sensors.destroy();
});

test('the sensors of each battery, interface and storage location share a heading of their own', async () => {
    let {sensors, configuration, machine} = setup();
    machine.plug('secondBattery');
    machine.plug('usbDrive');
    configuration.set_strv('storage-locations', ['/', USB_DRIVE]);
    await sensors.discover();
    // The headings of the present sensors of a category whose keys start so.
    let headings = (categoryName, keyStart) => {
        let category = sensors.catalog[categoryName];
        return [...new Set(category.sensors.filter(sensor => sensorPresent(category, sensor) && sensor.key.startsWith(keyStart))
            .map(sensor => sensor.heading))];
    };
    for (let [categoryName, first, second] of [['battery', 'BAT0/', 'CMB1/'], ['network', 'eth0/', 'wlan0/'], ['storage', '//', USB_DRIVE + '/']]) {
        let [firstHeadings, secondHeadings] = [headings(categoryName, first), headings(categoryName, second)];
        equal(firstHeadings.length + ',' + secondHeadings.length, '1,1', categoryName + ': one heading each');
        equal(firstHeadings[0] != secondHeadings[0] && Boolean(firstHeadings[0]), true, categoryName + ': each its own');
    }
    equal(headings('network', 'wifi-').join(), headings('network', 'wlan0/').join(), 'the WiFi values are under the WiFi interface');
    sensors.destroy();
});

// Intervals

test('the public IP is asked of the next service when one fails or does not answer within 3 seconds', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    let timeoutSeconds = 3;
    let [first, second] = Object.keys(devices.internet);
    configuration.set_boolean('include-public-ip', true);
    machine.plug('internet');
    await sensors.discover();
    let publicIp = find('network', 'public-ip');
    let webReads = () => machine.reads.splice(0).filter(read => read.startsWith('https://'));
    machine.remove(first);
    show(publicIp);
    await settle();
    equal(publicIp.status, 'ready');
    equal(webReads().join(' '), first + ' ' + second, 'the second service answers when the first fails');
    machine.restore(first);
    let silent = machine.holdNextRead(first);
    let reading = sensors.poll(true);
    await settle();
    machine.skip(timeoutSeconds - 0.1);
    equal(silent.cancellable.is_cancelled(), false, 'a service is waited for until its time is up');
    machine.skip(0.1);
    await reading;
    equal(publicIp.status, 'ready');
    equal(webReads().join(' '), first + ' ' + second, 'then the second service is asked');
    sensors.destroy();
});

// Storage

test('a storage location is monitored when the user added it, or GNOME mounted it, and something is mounted there', async () => {
    let {sensors, configuration, machine, find} = setup();
    machine.plug('share');
    machine.plug('usbDrive');
    let locations = () => [...new Set(sensors.catalog.storage.sensors.filter(sensor => sensorPresent(sensors.catalog.storage, sensor))
        .map(sensor => sensor.location))].sort().join(',');
    // A phone is a mount without a path.
    machine.volumes = [USB_DRIVE, null];
    await sensors.discover();
    equal(locations(), '/', 'at the start, the root alone');
    configuration.set_strv('storage-locations', ['/', SHARE, '/media/idle', '/mnt/backup']);
    await sensors.discover();
    equal(locations(), '/,' + SHARE, 'not the automount that is not connected, nor a path where nothing is mounted');
    equal(find('storage', SHARE + '/free').network, true, 'a share is a network storage location');
    equal(find('storage', SHARE + '/read-rate'), undefined, 'which has no disk whose reads are counted');
    configuration.set_strv('storage-locations', [SHARE]);
    await sensors.discover();
    equal(sensors.categoryPin('storage'), find('storage', SHARE + '/free'), 'the default pin is the first monitored one');
    configuration.set_strv('storage-locations', [SHARE, '/']);
    await sensors.discover();
    equal(sensors.categoryPin('storage'), find('storage', '//free'), 'also when the first one was added later');
    configuration.set_boolean('storage-monitor-volumes', true);
    await sensors.discover();
    equal(locations(), '/,' + USB_DRIVE + ',' + SHARE, 'the drive GNOME mounted, while the user wants that');
    machine.volumes = [];
    await sensors.discover();
    equal(locations(), '/,' + SHARE, 'gone with its mount');
    sensors.destroy();
});

test('a storage location\'s free space counts what is kept for root, as its free share does', async () => {
    let {sensors, find, show} = setup();
    await sensors.discover();
    let space = filesystems['/'];
    let [total, used, free, reserved, usedShare, freeShare] = ['total', 'used', 'free', 'reserved', 'used-percent', 'free-percent']
        .map(field => find('storage', '//' + field));
    show(total, used, free, reserved, usedShare, freeShare);
    await sensors.poll(true);
    equal(total.value, space['filesystem::size']);
    equal(used.value, space['filesystem::used']);
    equal(free.value, space['filesystem::size'] - space['filesystem::used'], 'what is not used');
    equal(reserved.value, space['filesystem::size'] - space['filesystem::used'] - space['filesystem::free'], 'the part of it only root may use');
    near(usedShare.value, used.value / total.value);
    near(freeShare.value, free.value / total.value, 'the free share matches the free space');
    sensors.destroy();
});

test('a network storage location is asked once per interval, and not while nothing is mounted there', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    machine.plug('share');
    configuration.set_strv('storage-locations', ['/', SHARE]);
    await sensors.discover();
    let shareFree = find('storage', SHARE + '/free'), rootFree = find('storage', '//free');
    show(shareFree, rootFree);
    await settle();
    let asked = location => machine.asked.filter(askedLocation => askedLocation == location).length;
    await sensors.poll();
    equal(asked(SHARE) + ',' + asked('/'), '1,2', 'the share not inside its interval, the disk at every tick');
    show(rootFree);
    show(shareFree, rootFree);
    await settle();
    equal(asked(SHARE), 1, 'nor when it comes on screen again inside it');
    await sensors.poll(true);
    equal(asked(SHARE), 2, 'Refresh asks it at once');
    machine.skip(configuration.get_int('storage-network-interval') * 60);
    await sensors.poll();
    equal(asked(SHARE), 3, 'and so does a tick after the interval');
    // The share disconnects: its automount stays in the table, and asking would connect it again.
    machine.setContent(MOUNTS, machine.content(MOUNTS).split('\n').filter(line => !line.includes(' cifs ')).join('\n'));
    await sensors.poll(true);
    equal(asked(SHARE), 3, 'not asked once nothing is mounted there');
    equal(shareFree.status, 'unavailable');
    machine.restore(MOUNTS);
    await sensors.poll();
    equal(shareFree.status, 'ready', 'connected again, it is asked at the next tick');
    sensors.destroy();
});

test('a storage location that does not answer is not asked a second time', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    machine.plug('share');
    configuration.set_strv('storage-locations', ['/', SHARE]);
    await sensors.discover();
    let shareFree = find('storage', SHARE + '/free');
    let question = machine.holdNextRead(SHARE);
    show(shareFree);
    await settle();
    let secondQuestion = machine.holdNextRead(SHARE);
    // Each run cancels the read under way, and the reading that follows the run reads again.
    await sensors.discover();
    let reading = sensors.poll(true);
    await settle();
    equal(secondQuestion.finish, null, 'no second question while the first is out');
    equal(machine.asked.filter(location => location == SHARE).length, 1, 'through the run and the readings after it');
    question.finish();
    await reading;
    equal(shareFree.value, filesystems[SHARE]['filesystem::free'], 'the answer serves the reading that waited');
    reading = sensors.poll(true);
    await settle();
    equal(typeof secondQuestion.finish, 'function', 'the location is asked again once it has answered');
    secondQuestion.finish();
    await reading;
    sensors.destroy();
});

test('what a storage location read and wrote is that of its own disk, also at a path with an escaped space', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    machine.plug('usbDrive');
    configuration.set_strv('storage-locations', ['/', USB_DRIVE]);
    // /proc/diskstats with the sectors read and written since boot by the root's volume and by the USB drive.
    let diskLine = (numbers, sectors) => numbers + ' 1 0 ' + sectors + ' 0 1 0 ' + sectors + ' 0 0 0 0 0 0 0 0 0 0\n';
    let diskStatistics = ({root, usb}) => diskLine('254 1 dm-1', root) + (usb === undefined ? '' : diskLine('8 1 sda1', usb));
    let sectors = {root: 1000, usb: 10};
    machine.setContent(DISKS, diskStatistics(sectors));
    await sensors.discover();
    let [rootRead, usbRead, usbWritten, usbReadRate] = [['/', 'read-total'], [USB_DRIVE, 'read-total'],
        [USB_DRIVE, 'write-total'], [USB_DRIVE, 'read-rate']].map(([location, field]) => find('storage', location + '/' + field));
    let start = clock();
    show(rootRead, usbRead, usbWritten, usbReadRate);
    await settle();
    equal([rootRead.value, usbRead.value, usbWritten.value].join(), [sectors.root, sectors.usb, sectors.usb].map(count => count * SECTOR_BYTES).join());
    let moreSectors = {...sectors, usb: sectors.usb + 20};
    machine.setContent(DISKS, diskStatistics(moreSectors));
    await secondReading(machine);
    let readBytes = 20 * SECTOR_BYTES;
    between(usbReadRate.value, readBytes / (clock() - start), readBytes, 'the bytes the USB drive read per second');
    machine.setContent(DISKS, diskStatistics({root: sectors.root}));
    await sensors.poll();
    equal(usbReadRate.status, 'unavailable', 'a disk that is gone has none');
    machine.setContent(DISKS, diskStatistics(moreSectors));
    // Ticks are an update interval apart.
    machine.skip(1);
    await sensors.poll();
    equal(usbReadRate.status, 'pending', 'back, it starts over');
    sensors.destroy();
});

// Network

test('the network totals are over the hardware interfaces, and a session total grows by what they transferred since', async () => {
    let {sensors, machine, find, show} = setup();
    machine.plug('vpn');
    let counters = {lo: {rx: 100, tx: 100}, eth0: {rx: 1000, tx: 300}, wlan0: {rx: 5000, tx: 700}, tun0: {rx: 9000, tx: 9000}};
    machine.setContent(NETWORK, networkDevices(counters));
    await sensors.discover();
    let [bootRx, bootTx, sessionRx, deviceRx] = ['boot-rx', 'boot-tx', 'session-rx', 'device-rx'].map(key => find('network', key));
    let start = clock();
    show(bootRx, bootTx, sessionRx, deviceRx);
    await settle();
    let hardware = direction => counters.eth0[direction] + counters.wlan0[direction];
    equal(bootRx.value, hardware('rx'), 'received since boot by the hardware interfaces, not the loopback or the VPN');
    equal(bootTx.value, hardware('tx'));
    let later = {...counters, eth0: {rx: 1400, tx: 300}, wlan0: {rx: 5600, tx: 700}, tun0: {rx: 99999, tx: 9000}};
    machine.setContent(NETWORK, networkDevices(later));
    await secondReading(machine);
    let received = later.eth0.rx + later.wlan0.rx - hardware('rx');
    equal(sessionRx.value, received, 'this session: what the hardware interfaces received since the first reading');
    between(deviceRx.value, received / (clock() - start), received, 'the speed of the hardware interfaces together');
    sensors.destroy();
});

test('the WiFi values are those of the interface /proc/net/wireless lists, and without one they are unavailable', async () => {
    let {sensors, machine, find, show} = setup();
    let wireless = '/proc/net/wireless';
    await sensors.discover();
    let quality = find('network', 'wifi-link-quality'), signal = find('network', 'wifi-signal-level');
    show(quality, signal);
    await settle();
    // The interface's line: its name, status, link quality out of 70, signal level and noise.
    let fields = machine.content(wireless).trim().split('\n').at(-1).trim().split(/\s+/);
    near(quality.value, Number(fields[2]) / 70);
    equal(signal.value, Number(fields[3]));
    machine.setContent(wireless, machine.content(wireless).split('\n').slice(0, 2).join('\n') + '\n');
    await sensors.poll(true);
    equal(quality.status + ',' + signal.status, 'unavailable,unavailable');
    sensors.destroy();
});

test('interfaces that come and go change the network sensors at the next reading, not only at discovery', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let combined = find('network', 'combined'), ethernetDownload = find('network', 'eth0/rx');
    show(combined, ethernetDownload);
    await secondReading(machine);
    machine.plug('vpn');
    await sensors.poll();
    equal(find('network', 'tun0/rx') !== undefined, true, 'an interface that appeared');
    let lastValue = ethernetDownload.value;
    machine.setContent(NETWORK, machine.content(NETWORK).split('\n').filter(line => !line.startsWith('eth0:')).join('\n'));
    await sensors.poll();
    equal(find('network', 'eth0/rx'), undefined, 'an interface that disappeared is no longer present');
    equal(ethernetDownload.value, lastValue, 'and its sensors are not written');
    equal(combined.status, 'ready', 'the total goes on without it');
    machine.remove(NETWORK);
    await sensors.poll();
    equal(find('network', 'tun0/rx') !== undefined, true, 'a failed read keeps the interfaces');
    machine.restore(NETWORK);
    machine.unplug('vpn');
    await sensors.poll();
    equal(find('network', 'eth0/rx'), ethernetDownload, 'a returned interface is the same sensor again');
    equal(find('network', 'tun0/rx'), undefined);
    await secondReading(machine);
    equal(ethernetDownload.status, 'ready');
    sensors.destroy();
});

test('a menu that opens and closes keeps the readings of the network between ticks', async () => {
    let {sensors, machine, reads, find, show} = setup();
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    show(download);
    await secondReading(machine);
    let value = download.value;
    let readsBefore = reads(NETWORK);
    for (let cycle = 0; cycle < 3; cycle++) {
        show(download, find('network', 'combined'), 'memory');
        show(download);
        equal(download.value, value, 'the rate stays');
    }
    await settle();
    equal(reads(NETWORK), readsBefore, 'and the file is not read before the next tick');
    sensors.destroy();
});

// Batteries

// Batteries

test('a battery\'s values come from its own uevent file, and the total power rate is over the machine\'s batteries', async () => {
    let {sensors, machine, find, show} = setup();
    machine.plug('secondBattery');
    machine.plug('mouse');
    await sensors.discover();
    // A line of the battery's uevent file, in the kernel's units: µV, µW, µWh and percent.
    let field = (name, key) =>
        Number(machine.content('/sys/class/power_supply/' + name + '/uevent').match(new RegExp('^POWER_SUPPLY_' + key + '=(.+)$', 'm'))[1]);
    let value = (name, key) => find('battery', name + '/' + key).value;
    let total = find('battery', 'total-power-rate');
    show(total, find('battery', 'hidpp_battery_0/percentage'),
        ...['BAT0', 'CMB1'].flatMap(name => ['percentage', 'voltage', 'power-rate', 'capacity'].map(key => find('battery', name + '/' + key))));
    await sensors.poll(true);
    for (let name of ['BAT0', 'CMB1']) {
        near(value(name, 'percentage'), field(name, 'CAPACITY') / 100, name);
        near(value(name, 'voltage'), field(name, 'VOLTAGE_NOW') / 1000000, name);
        near(value(name, 'capacity'), field(name, 'ENERGY_FULL') / field(name, 'ENERGY_FULL_DESIGN'), name);
    }
    near(value('CMB1', 'power-rate'), -field('CMB1', 'POWER_NOW') / 1000000, 'a discharging battery\'s power rate is negative');
    near(total.value, value('BAT0', 'power-rate') + value('CMB1', 'power-rate'), 'the total is over the machine\'s batteries');
    equal(find('battery', 'hidpp_battery_0/power-rate'), undefined, 'a mouse\'s battery has no power rate');
    near(value('hidpp_battery_0', 'percentage'), field('hidpp_battery_0', 'CAPACITY') / 100);
    sensors.destroy();
});

test('where a mouse has the only battery, its percentage is the default pin', async () => {
    let {sensors, machine, find} = setup();
    for (let file of ['type', 'uevent'])
        machine.remove('/sys/class/power_supply/BAT0/' + file);
    machine.plug('mouse');
    await sensors.discover();
    equal(sensors.categoryPin('battery'), find('battery', 'hidpp_battery_0/percentage'));
    sensors.destroy();
});

test('a UPS that UPower knows is a battery with its percentage and time left, and each UPS has keys of its own', async () => {
    let {sensors, machine, find, show} = setup();
    let ups = {Type: 3, Model: 'Back-UPS ES 700', Serial: '4B1234', State: 2, Percentage: 80, TimeToEmpty: 1500, TimeToFull: 0};
    machine.upower['/org/freedesktop/UPower/devices/ups_hiddev0'] = ups;
    // Two more of the same model that report no serial number, and the mains, which is no UPS.
    machine.upower['/org/freedesktop/UPower/devices/ups_hiddev1'] = {...ups, Serial: ''};
    machine.upower['/org/freedesktop/UPower/devices/ups_hiddev2'] = {...ups, Serial: ''};
    machine.upower['/org/freedesktop/UPower/devices/line_power_AC'] = {Type: 1, Model: '', Serial: ''};
    await sensors.discover();
    let upsPercentages = sensors.catalog.battery.sensors.filter(sensor => sensor.key.startsWith('ups/') && sensor.field == 'percentage');
    equal(new Set(upsPercentages.map(sensor => sensor.key)).size, 3, 'three UPSs, and no mains');
    let percentage = find('battery', 'ups/' + ups.Serial + '/percentage');
    let timeLeft = find('battery', 'ups/' + ups.Serial + '/time-left');
    show(percentage, timeLeft);
    await sensors.poll();
    near(percentage.value, ups.Percentage / 100);
    equal(timeLeft.value, ups.TimeToEmpty, 'while discharging, until empty');
    sensors.destroy();
});

// Processor, system information and power

test('the usage of each core is a sensor only with include-processor-cores', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    await sensors.discover();
    equal(find('processor', 'cpu0'), undefined, 'not by default');
    configuration.set_boolean('include-processor-cores', true);
    await sensors.discover();
    let usage = find('processor', 'usage');
    let cores = ['cpu0', 'cpu1'].map(core => find('processor', core));
    show(usage, ...cores);
    await secondReading(machine);
    // Every core of the machine is as busy as the whole processor, up to the rounding of its ticks.
    for (let core of cores)
        between(core.value, usage.value - 0.02, usage.value + 0.02, core.key);
    sensors.destroy();
});

test('the frequency is the mean of /proc/cpuinfo, and of the cores\' cpufreq files with use-processor-cpufreq or where /proc/cpuinfo lists none', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    let cpufreq = core => '/sys/devices/system/cpu/' + core + '/cpufreq/scaling_cur_freq';
    // The cores' files give other frequencies than /proc/cpuinfo, in kHz.
    machine.setContent(cpufreq('cpu0'), '3000000\n');
    machine.setContent(cpufreq('cpu1'), '1000000\n');
    let cpuinfoMean = mean([...machine.content('/proc/cpuinfo').matchAll(/^cpu MHz\s*:\s*(\S+)/gm)].map(match => Number(match[1]) * 1000000));
    let cpufreqMean = mean(['cpu0', 'cpu1'].map(core => Number(machine.content(cpufreq(core))) * 1000));
    let frequency = async () => {
        await sensors.discover();
        let sensor = find('processor', 'frequency');
        show(sensor);
        await sensors.poll();
        return sensor.value;
    };
    near(await frequency(), cpuinfoMean, 'from /proc/cpuinfo');
    configuration.set_boolean('use-processor-cpufreq', true);
    near(await frequency(), cpufreqMean, 'from cpufreq with the option');
    configuration.set_boolean('use-processor-cpufreq', false);
    machine.setContent('/proc/cpuinfo', machine.content('/proc/cpuinfo').replace(/^cpu MHz.*\n/gm, ''));
    near(await frequency(), cpufreqMean, 'from cpufreq where /proc/cpuinfo lists none');
    sensors.destroy();
});

test('with include-static-info, the processor and the kernel describe themselves', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    await sensors.discover();
    equal(find('system', 'kernel'), undefined, 'not by default');
    configuration.set_boolean('include-static-info', true);
    await sensors.discover();
    let [vendor, sockets, cache, kernel] = [['processor', 'vendor'], ['processor', 'sockets'], ['processor', 'cache'],
        ['system', 'kernel']].map(([categoryName, key]) => find(categoryName, key));
    show(vendor, sockets, cache, kernel);
    await sensors.poll();
    let cpuInfo = machine.content('/proc/cpuinfo');
    equal(vendor.value, cpuInfo.match(/^vendor_id\s*:\s*(\S+)/m)[1]);
    equal(sockets.value, new Set(cpuInfo.match(/^physical id.*$/gm)).size, 'the sockets the cores are in');
    equal(cache.value, Number.parseFloat(cpuInfo.match(/^cache size\s*:\s*(\S+)/m)[1]) * 1024, 'in bytes');
    equal(kernel.value, machine.content('/proc/version').split(' ')[2]);
    sensors.destroy();
});

test('a power input of hwmon is in watts', async () => {
    let {sensors, machine, find, show} = setup();
    machine.setContent(BATTERY + 'power1_input', '12500000\n');
    await sensors.discover();
    let power = find('power', 'BAT0/power1');
    show(power);
    await sensors.poll();
    near(power.value, Number(machine.content(BATTERY + 'power1_input')) / 1000000, 'from microwatts');
    sensors.destroy();
});

test('a readable powercap zone gives its power draw from its energy counter, once per zone name, and only with use-powercap', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    let powercap = '/sys/class/powercap/';
    machine.setContent(powercap + 'intel-rapl:0/name', 'package-0\n');
    machine.setContent(powercap + 'intel-rapl:0/energy_uj', '1000000\n');
    // The same zone through the processor's memory-mapped registers.
    machine.setContent(powercap + 'intel-rapl-mmio:0/name', 'package-0\n');
    machine.setContent(powercap + 'intel-rapl-mmio:0/energy_uj', '1000000\n');
    // A zone whose counter only root may read.
    machine.setContent(powercap + 'intel-rapl:0:0/name', 'core\n');
    machine.setContent(powercap + 'intel-rapl:0:0/energy_uj', '1000000\n');
    machine.failReads(powercap + 'intel-rapl:0:0/energy_uj',
        new Gio.IOErrorEnum({code: Gio.IOErrorEnum.PERMISSION_DENIED, message: 'energy_uj'}));
    await sensors.discover();
    equal(keys(sensors.catalog.power), 'powercap/package-0', 'the package once, and not the zone only root may read');
    let packagePower = find('power', 'powercap/package-0');
    let joules = 5;
    let start = clock();
    show(packagePower);
    await settle();
    machine.setContent(packagePower.file, (1000000 + joules * 1000000) + '\n');
    await secondReading(machine);
    between(packagePower.value, joules / (clock() - start), joules, 'the joules per second');
    configuration.set_boolean('use-powercap', false);
    await sensors.discover();
    equal(find('power', 'powercap/package-0'), undefined, 'without use-powercap');
    sensors.destroy();
});

// What is saved

test('a second launch has the saved sensors in their order, and no value until it reads them', async () => {
    let first = setup();
    await first.sensors.discover();
    first.show(first.find('memory', 'usage'));
    await settle();
    let order = keys(first.sensors.catalog.temperature);
    first.sensors.destroy();

    let {sensors, find} = setup(first.configuration);
    let restored = find('memory', 'usage');
    equal(restored.status, 'pending', 'a reading of the session before says nothing about now');
    await sensors.discover();
    equal(keys(sensors.catalog.temperature), order, 'discovery matches every saved sensor and adds none');
    equal(find('memory', 'usage'), restored, 'the saved sensor is the one discovery found');
    sensors.destroy();
});

test('a sensor that no run has found for a year is forgotten, unless it is in the panel', async () => {
    let first = setup();
    first.machine.plug('vpn');
    first.machine.plug('secondNvme');
    await first.sensors.discover();
    first.sensors.pinToPanel(first.find('network', 'tun0/tx'), true);
    first.sensors.destroy();
    // The VPN was last connected a year and a minute ago, the second drive a minute less than a year ago.
    let saved = first.configuration.get_value('catalog').recursiveUnpack();
    for (let sensor of saved.network.sensors.filter(sensor => sensor.interface == 'tun0'))
        sensor.discovered -= YEAR_SECONDS + 60;
    saved.temperature.sensors.find(sensor => sensor.file == SECOND_NVME + 'temp1_input').discovered -= YEAR_SECONDS - 60;
    first.configuration.set_value('catalog', toVariant(saved));

    let {sensors} = setup(first.configuration);
    await sensors.discover();
    let networkKeys = sensors.catalog.network.sensors.map(sensor => sensor.key);
    equal(networkKeys.includes('tun0/rx'), false, 'forgotten after a year');
    equal(networkKeys.includes('tun0/tx'), true, 'a sensor in the panel is never forgotten');
    equal(sensors.catalog.temperature.sensors.some(sensor => sensor.file == SECOND_NVME + 'temp1_input'), true,
        'kept within the year');
    sensors.destroy();
});

test('a name, a category pin and the order of the categories are kept across discovery and a restart', async () => {
    let first = setup();
    await first.sensors.discover();
    let temperature = first.find('temperature', 'thinkpad/temp1');
    let ownLabel = temperature.label;
    let defaultPin = first.sensors.categoryPin('temperature');
    let order = ['voltage', ...first.sensors.categories().map(([name]) => name).filter(name => name != 'voltage')];
    first.sensors.renameSensor(temperature, 'Processor');
    first.sensors.pinToCategory('temperature', temperature);
    first.sensors.setCategoryOrder(order);
    await first.sensors.discover();
    equal(temperature.customLabel + ' / ' + temperature.label, 'Processor / ' + ownLabel,
        'discovery keeps the name and still writes the sensor\'s own label');
    equal(first.sensors.categoryPin('temperature'), temperature, 'and keeps the category pin the user chose');
    first.sensors.destroy();

    let {sensors, find} = setup(first.configuration);
    let restored = find('temperature', 'thinkpad/temp1');
    equal(restored.customLabel, 'Processor');
    equal(sensors.categoryPin('temperature'), restored);
    equal(sensors.categories().sort(([, a], [, b]) => a.position - b.position).map(([name]) => name).join(', '), order.join(', '));
    sensors.pinToCategory('temperature', find('temperature', 'thinkpad/temp2'));
    equal(restored.pinnedToCategory, undefined, 'a category has one category pin');
    sensors.pinToCategory('temperature');
    equal(sensors.categoryPin('temperature').key, defaultPin.key, 'without a choice the default pin applies again');
    sensors.renameSensor(restored, '');
    equal(restored.customLabel, undefined, 'an empty name gives the own label back');
    sensors.destroy();
});

test('the panel\'s sensors and category switches are changed through Sensors, which saves them and keeps what the preferences wrote', async () => {
    let configuration = settings();
    // A device that is not plugged in is in the panel from an earlier session.
    configuration.set_value('catalog', toVariant({voltage: {sensors: [{key: 'unplugged/in0', panelPosition: 0}]}}));
    let {sensors, find} = setup(configuration);
    let names = panelSensors => panelSensors.map(sensor => sensor.category + ' ' + sensor.key).join(', ');
    let shown = () => names(sensors.panelSensors().filter(sensor => sensors.hasPanelItem(sensor)));
    await sensors.discover();
    equal(shown(), '', 'a sensor that is not on the machine is not shown');
    equal(sensors.panelSensors().length, 1, 'and stays in the panel');
    for (let [categoryName, key] of [['memory', 'usage'], ['system', 'load-1m'], ['processor', 'usage']])
        sensors.pinToPanel(find(categoryName, key), true);
    sensors.pinToPanel(find('system', 'load-1m'), false);
    equal(shown(), 'memory usage, processor usage', 'an unpinned sensor is not shown; the same key in two categories is two sensors');
    sensors.pinToPanel(find('system', 'load-1m'), true);
    equal(shown(), 'memory usage, processor usage, system load-1m', 'a pinned sensor goes to the end');
    sensors.movePanelSensor(find('system', 'load-1m'), find('processor', 'usage'));
    equal(shown(), 'memory usage, system load-1m, processor usage', 'moved in front of another sensor');
    sensors.movePanelSensor(find('memory', 'usage'));
    equal(shown(), 'system load-1m, processor usage, memory usage', 'moved to the end');
    // The preferences switch a category in the catalog settings.
    equal(sensors.catalog.battery.runtime.enabled, false, 'the default');
    configuration.set_value('catalog-settings', toVariant({battery: {enabled: true}, memory: {enabled: false}}));
    equal(sensors.reloadEnabled(), true, 'a changed switch is reported');
    equal(sensors.reloadEnabled(), false, 'once');
    equal(shown(), 'system load-1m, processor usage', 'a sensor of a category that is switched off is not shown');
    sensors.destroy();
    let restarted = setup(configuration).sensors;
    equal(names(restarted.panelSensors()), 'voltage unplugged/in0, system load-1m, processor usage, memory usage', 'saved');
    restarted.destroy();
});

// NVIDIA

// Sets up a machine with the GPU category on and the given NVIDIA cards.
async function setupNvidia(cards, adjust = () => {}) {
    let machineSetup = setup();
    machineSetup.nvidiaSmi.setCards(cards);
    machineSetup.configuration.set_value('catalog-settings', toVariant({gpu: {enabled: true}}));
    machineSetup.sensors.reloadEnabled();
    adjust(machineSetup.configuration);
    await machineSetup.sensors.discover();
    return machineSetup;
}

// Ends a test with NVIDIA cards: nothing on screen any more stops every stream.
async function endNvidia({sensors, nvidiaSmi, show}) {
    show();
    await nvidiaSmi.allStopped();
    sensors.destroy();
}

test('with hide-zeros, an NVIDIA temperature that reads zero is left out until a run reads a value', async () => {
    let nvidia = await setupNvidia([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': 0}],
        configuration => configuration.set_boolean('hide-zeros', true));
    let {sensors, configuration, nvidiaSmi, find} = nvidia;
    equal(find('gpu', 'Test GPU/temperature.gpu'), undefined, 'a zero temperature is left out');
    equal(find('gpu', 'Test GPU/temperature.memory'), undefined, 'and one the card does not have');
    equal(find('temperature', 'Test GPU/temperature.gpu'), undefined, 'also among the temperatures');
    equal(nvidiaSmi.streams().length, 0, 'discovery starts no stream');
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': 45}]);
    await sensors.discover();
    equal(find('temperature', 'Test GPU/temperature.gpu') !== undefined, true, 'a value takes it in');
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': 0}]);
    await sensors.discover();
    equal(find('temperature', 'Test GPU/temperature.gpu') !== undefined, true, 'a later zero does not take it out');
    configuration.set_boolean('hide-zeros', false);
    await sensors.discover();
    equal(find('gpu', 'Test GPU/temperature.memory') !== undefined, true, 'switched off, the card\'s fields are all in');
    await endNvidia(nvidia);
});

test('a tick starts the NVIDIA stream again when the update interval changed and when the process ended', async () => {
    let nvidia = await setupNvidia([{uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192}]);
    let {sensors, configuration, nvidiaSmi, find, show} = nvidia;
    let memoryUsed = find('gpu', 'Test GPU/memory.used');
    show(memoryUsed);
    await sensors.poll();
    equal(nvidiaSmi.streams().length, 1);
    let updateSeconds = configuration.get_int('update-time') + 2;
    configuration.set_int('update-time', updateSeconds);
    await sensors.poll();
    equal(nvidiaSmi.streams().length, 2, 'the tick after a changed update interval starts a new process');
    equal(nvidiaSmi.streams()[1].interval, updateSeconds, 'which reports at that interval');
    GLib.spawn_command_line_sync('kill ' + nvidiaSmi.streams()[1].pid);
    // The first tick finds the process gone, the second has the reading of the new one.
    for (let tick = 0; tick < 2; tick++) {
        await wait(0.3);
        await sensors.poll();
    }
    equal(nvidiaSmi.streams().length, 3, 'a tick starts the process again after it ended');
    equal(memoryUsed.status, 'ready');
    await endNvidia(nvidia);
});

test('an NVIDIA sensor that comes on screen next to one of its card is read at once, and the order keeps the process', async () => {
    let card = {uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192, 'utilization.gpu': 30};
    let nvidia = await setupNvidia([card]);
    let {sensors, nvidiaSmi, find, show} = nvidia;
    let memoryUsed = find('gpu', 'Test GPU/memory.used'), memoryTotal = find('gpu', 'Test GPU/memory.total');
    let utilization = find('gpu', 'Test GPU/utilization.gpu');
    show(memoryUsed, memoryTotal);
    await sensors.poll();
    show(memoryTotal, memoryUsed);
    equal(nvidiaSmi.streams().length, 1, 'the same sensors in another order keep the process');
    show(memoryUsed, memoryTotal, utilization);
    // No tick follows. The process that reports the utilization as well has to start and print its first line.
    for (let waited = 0; utilization.status != 'ready' && waited < 3; waited += 0.05)
        await wait(0.05);
    equal(utilization.status + ' ' + utilization.value, 'ready ' + card['utilization.gpu'] / 100, 'without a tick');
    await endNvidia(nvidia);
});

await runTests();
