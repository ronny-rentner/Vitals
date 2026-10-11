import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Sensors} from '../sensors.js';
import {readCatalog, writeCatalog, writeCategoryEnabled, sensorPresent} from '../helpers/storedCatalog.js';
import {test, equal, mean, settings, runTests} from './harness.js';
import {Machine} from './machine.js';
import {machine as machineFixture, filesystems, mappedRootMounts, usbDriveMounts, shareMounts} from './fixtures/machine.js';

const CORETEMP = '/sys/class/hwmon/hwmon3/';
const BATTERY = '/sys/class/hwmon/hwmon4/';
const THINKPAD = '/sys/class/hwmon/hwmon5/';
const USB = '/sys/class/hwmon/hwmon8/';
const USB_NAME = machineFixture[USB + 'name'].trim();
const ZONES = '/sys/class/thermal/';
const NETWORK = '/proc/net/dev';
const DISKS = '/proc/diskstats';
const MOUNTS = '/proc/self/mountinfo';
const USB_DRIVE = '/media/USB drive';
const SHARE = '/media/share';
// The temperature files Vitals reports. Not among them: thermal_zone1 (the policy zone),
// thermal_zone8 (the package temperature coretemp reports) and thermal_zone9 (published through hwmon7).
const TEMPERATURES = [
    CORETEMP + 'temp1_input', THINKPAD + 'temp1_input', THINKPAD + 'temp2_input', '/sys/class/hwmon/hwmon7/temp1_input',
    ZONES + 'thermal_zone2/temp', ZONES + 'thermal_zone6/temp'
];
const SECTOR_BYTES = 512;
const YEAR_SECONDS = 365 * 86400;

// Builds what one test works on: a machine, a Sensors instance that reads it, and the two clocks the test advances.
// A test that starts from a saved catalog, or launches a second time, passes its own settings. `locations` are the
// storage locations the user added, when they are not the default.
function setup({files = machineFixture, configuration = settings(), locations} = {}) {
    let machine = new Machine(files, filesystems);
    // Every file Sensors opens comes from this test's machine. This process only runs tests, so it is never restored.
    Gio.File.new_for_path = path => machine.file(path);
    Gio.VolumeMonitor.get = () => machine.volumeMonitor();
    if (locations)
        configuration.set_strv('storage-locations', locations);
    let sensors = new Sensors(configuration, text => text);
    let time = 1;
    let date = Math.floor(GLib.get_real_time() / 1000000);
    let errors = [];
    sensors.clock = () => time;
    sensors.now = () => date;
    // Here only ticks read. The second reading that follows a rate's first one is in the collection tests.
    sensors.schedule = () => null;
    sensors.onError = (id, error) => errors.push([id, error]);
    return {
        sensors, configuration, machine, errors,
        // sysfs stores temperatures and voltages in thousandths of °C and V.
        fileValue: path => Number(machine.content(path)) / 1000,
        // The sensor with this key that is on the machine, if there is one.
        find(categoryName, key) {
            let category = sensors.catalog[categoryName];
            return category.sensors.find(sensor => sensor.key == key && sensorPresent(category, sensor));
        },
        // Marks what is on screen, as the renderer does: the given sensors, and the header of each named category.
        show(...shown) {
            for (let [name, category] of sensors.categories()) {
                category.shown = shown.includes(name);
                for (let sensor of category.sensors)
                    sensor.shown = shown.includes(sensor);
            }
            sensors.shownChanged();
        },
        advance(seconds) { time += seconds; },
        advanceDate(seconds) { date += seconds; }
    };
}

// /proc/net/dev as the kernel writes it, for the given byte counters.
function networkDevices(counters) {
    return 'Inter-| Receive | Transmit\n' +
        ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n' +
        Object.entries(counters).map(([name, {rx, tx}]) =>
            name + ': ' + rx + ' 0 0 0 0 0 0 0 ' + tx + ' 0 0 0 0 0 0 0\n').join('');
}

// /proc/diskstats as the kernel writes it, for the given sector counters.
function diskStatistics(disks) {
    return disks.map(disk => disk.device.replace(':', ' ') + ' ' + disk.name + ' 1 0 ' + disk.readSectors + ' 0 1 0 ' +
        disk.writtenSectors + ' 0 0 0 0\n').join('');
}

// Bytes per second over every interface except loopback that both snapshots contain.
function combinedRate(before, after, seconds) {
    let bytes = 0;
    for (let [name, counters] of Object.entries(after)) {
        if (name == 'lo' || !(name in before)) continue;
        bytes += counters.rx - before[name].rx + counters.tx - before[name].tx;
    }
    return bytes / seconds;
}

// Puts the stand-in nvidia-smi of tests/fixtures/programs in front of the real one for this process, with a card
// list and a start log of this test's own. Sensors finds and runs it like the real program.
function installNvidiaSmi() {
    let directory = GLib.dir_make_tmp('vitals-nvidia-XXXXXX');
    let cardsFile = directory + '/cards', logFile = directory + '/log';
    GLib.file_set_contents(logFile, '');
    GLib.setenv('NVIDIA_SMI_CARDS', cardsFile, true);
    GLib.setenv('NVIDIA_SMI_LOG', logFile, true);
    let programs = GLib.get_current_dir() + '/tests/fixtures/programs';
    if (!GLib.getenv('PATH').startsWith(programs + ':'))
        GLib.setenv('PATH', programs + ':' + GLib.getenv('PATH'), true);
    // The processes started with -l, which keep reporting until they are stopped.
    let streams = () => new TextDecoder().decode(GLib.file_get_contents(logFile)[1]).split('\n')
        .filter(start => start.includes(' -l ')).map(start => {
            let [pid, ...startArguments] = start.split(' ');
            return {
                pid, interval: Number(startArguments[startArguments.indexOf('-l') + 1]),
                queriedFields: startArguments.find(argument => argument.startsWith('--query-gpu=')).slice('--query-gpu='.length)
            };
        });
    return {
        setCards(cards) {
            GLib.file_set_contents(cardsFile, cards.map(card =>
                Object.entries(card).map(([field, fieldValue]) => field + '=' + fieldValue).join(';') + '\n').join(''));
        },
        streams,
        // Resolves when every started stream process has exited; the test fails if one is still running after a second.
        async allStopped() {
            for (let attempt = 0; streams().some(({pid}) => GLib.file_test('/proc/' + pid, GLib.FileTest.EXISTS)); attempt++) {
                if (attempt == 20) throw new Error('an nvidia-smi stream is still running');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    };
}

// Adds a battery as the kernel shows it. `status` is "Charging", "Discharging" or "Not charging"; `scope` is
// "Device" for the battery of a mouse or keyboard, and a battery of the machine has none.
function plugInBattery(machine, name, {status, powerWatts, percent, scope}) {
    machine.write('/sys/class/power_supply/' + name + '/type', 'Battery\n');
    if (scope)
        machine.write('/sys/class/power_supply/' + name + '/scope', scope + '\n');
    machine.write('/sys/class/power_supply/' + name + '/uevent', 'POWER_SUPPLY_NAME=' + name + '\nPOWER_SUPPLY_STATUS=' + status +
        '\nPOWER_SUPPLY_POWER_NOW=' + powerWatts * 1000000 + '\nPOWER_SUPPLY_CAPACITY=' + percent +
        '\nPOWER_SUPPLY_ENERGY_FULL_DESIGN=50000000\nPOWER_SUPPLY_ENERGY_FULL=40000000\nPOWER_SUPPLY_ENERGY_NOW=20000000\n');
}

// Adds what the kernel shows for a hardware network interface: its own description and its device.
// `deviceType` is the DEVTYPE the kernel reports, such as "wlan"; a network card has none.
function plugInInterface(machine, name, deviceType) {
    machine.write('/sys/class/net/' + name + '/uevent',
        (deviceType ? 'DEVTYPE=' + deviceType + '\n' : '') + 'INTERFACE=' + name + '\n');
    machine.write('/sys/class/net/' + name + '/device/uevent', 'DRIVER=test\n');
}

function keys(category) {
    return category.sensors.map(sensor => sensor.key).join(', ');
}

test('discovery describes sensors without starting collection', async () => {
    let {sensors, machine, errors, find} = setup();
    machine.write(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    equal(errors.length, 0, 'discovery errors');
    equal(find('temperature', 'thermal/SEN1') !== undefined, true, 'SEN1');
    equal(find('temperature', 'thermal/TCPU') !== undefined, true, 'a thermal zone no rule leaves out');
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'zero sensor');
    equal(find('processor', 'powercap') !== undefined, true, 'Processor Powercap');
    equal(find('system', 'lap-mode') !== undefined, true, 'lap mode');
    for (let key of ['average', 'minimum', 'maximum']) {
        equal(find('voltage', key), undefined, 'voltage has no ' + key);
        equal(find('fan', key), undefined, 'one fan has no ' + key);
        equal(find('temperature', key) !== undefined, true, 'temperature ' + key);
    }
    equal(sensors.catalog.voltage.header, find('voltage', 'BAT0/in0'), 'voltage header');
    equal(sensors.activeSources.size, 0, 'active sources');
    equal(machine.reads.includes(THINKPAD + 'temp1_input'), false, 'thermal discovery read');
    equal(machine.reads.includes('/proc/meminfo'), false, 'memory discovery read');
    equal(machine.reads.filter(readPath => readPath == THINKPAD + 'device/type').length, 1,
        'one supply type read for multiple voltage sensors');
    sensors.destroy();
});

test('a sensor says where it is read from and how it is shown, and its key leaves the kernel number out', async () => {
    let {sensors, find} = setup();
    await sensors.discover();
    let temperature = find('temperature', 'thinkpad/temp1');
    equal(temperature.file, THINKPAD + 'temp1_input', 'the file as it is now');
    equal(temperature.label, 'thinkpad CPU', 'the label the kernel gives the input');
    equal(temperature.format, 'temp');
    equal(find('temperature', 'coretemp/temp1').label, 'Processor 0', 'a renamed label does not change the key');
    equal(find('memory', 'usage').file, '/proc/meminfo', 'a sensor that shares its file with others names it too');
    equal(find('network', 'eth0/rx').file, NETWORK);
    equal(find('network', 'eth0/rx').interface, 'eth0');
    equal(find('network', 'eth0/rx').hardware, true, 'a network card is hardware');
    equal(find('network', 'lo/tx').hardware, false, 'the loopback is not');
    equal(find('processor', 'cpu0').core, 'cpu0');
    for (let [name, category] of sensors.categories()) {
        for (let sensor of category.sensors)
            equal(Object.values(sensor).some(field => typeof field == 'function' || typeof field == 'object'), false,
                name + '/' + sensor.key + ' is plain data');
    }
    sensors.destroy();
});

test('thermal zones that are not sensors are excluded', async () => {
    let {sensors, find} = setup();
    await sensors.discover();
    equal(find('temperature', 'thermal/INT3400 Thermal'), undefined, 'thermal policy zone excluded');
    equal(find('temperature', 'thermal/SEN1') !== undefined, true, 'other thermal zones still discovered');
    sensors.destroy();
});

test('a thermal zone that the kernel also publishes through hwmon is listed once', async () => {
    let {sensors, find} = setup();
    await sensors.discover();
    equal(find('temperature', 'iwlwifi_1/temp1') !== undefined, true, 'hwmon view listed');
    equal(find('temperature', 'thermal/iwlwifi_1'), undefined, 'thermal zone view left out');
    sensors.destroy();
});

test('zones of one type share an hwmon device, and all of them are listed through it only', async () => {
    let {sensors, machine, find} = setup();
    // A second ACPI zone: the kernel adds it to the hwmon device of the first as temp2 and gives it no directory of its own.
    machine.write('/sys/class/hwmon/hwmon0/name', 'acpitz\n');
    machine.write('/sys/class/hwmon/hwmon0/temp1_input', '45000\n');
    machine.write('/sys/class/hwmon/hwmon0/temp2_input', '48000\n');
    machine.write(ZONES + 'thermal_zone0/type', 'acpitz\n');
    machine.write(ZONES + 'thermal_zone0/temp', '45000\n');
    machine.write(ZONES + 'thermal_zone0/hwmon0/name', 'acpitz\n');
    machine.write(ZONES + 'thermal_zone3/type', 'acpitz\n');
    machine.write(ZONES + 'thermal_zone3/temp', '48000\n');
    await sensors.discover();
    equal(find('temperature', 'acpitz/temp1') !== undefined, true, 'first zone through hwmon');
    equal(find('temperature', 'acpitz/temp2') !== undefined, true, 'second zone through hwmon');
    equal(find('temperature', 'thermal/acpitz'), undefined, 'neither zone is listed a second time');
    sensors.destroy();
});

test('the CPU package zone is listed only when coretemp does not report the package temperature', async () => {
    let withCoretemp = setup();
    await withCoretemp.sensors.discover();
    equal(withCoretemp.find('temperature', 'coretemp/temp1') !== undefined, true, 'coretemp package temperature listed');
    equal(withCoretemp.find('temperature', 'thermal/x86_pkg_temp'), undefined, 'zone left out next to coretemp');
    withCoretemp.sensors.destroy();

    let withoutCoretemp = setup();
    for (let file of ['name', 'temp1_label', 'temp1_input'])
        withoutCoretemp.machine.remove(CORETEMP + file);
    await withoutCoretemp.sensors.discover();
    equal(withoutCoretemp.find('temperature', 'thermal/x86_pkg_temp') !== undefined, true, 'zone listed without coretemp');
    withoutCoretemp.sensors.destroy();
});

test('two devices with the same name each get a sensor with the same key, read from its own file', async () => {
    let {sensors, machine, fileValue, show} = setup();
    // Every NVMe drive registers its hwmon device under the name "nvme".
    let drives = ['/sys/class/hwmon/hwmon1/', '/sys/class/hwmon/hwmon2/'];
    machine.write(drives[0] + 'name', 'nvme\n');
    machine.write(drives[0] + 'temp1_input', '45000\n');
    machine.write(drives[1] + 'name', 'nvme\n');
    machine.write(drives[1] + 'temp1_input', '52000\n');
    await sensors.discover();
    let twins = () => sensors.catalog.temperature.sensors.filter(sensor => sensor.key == 'nvme/temp1');
    equal(twins().map(sensor => sensor.file).join(', '), drives.map(drive => drive + 'temp1_input').join(', '),
        'one sensor per drive, in directory order');
    await sensors.discover();
    equal(twins().length, drives.length, 'a later run matches both again and adds none');
    show(...twins());
    await sensors.poll();
    for (let [index, sensor] of twins().entries())
        equal(sensor.value, fileValue(drives[index] + 'temp1_input'), 'drive ' + index);
    sensors.destroy();
});

test('discovery uses settings changed while its reads are pending', async () => {
    let {sensors, configuration, machine, find} = setup({files: {...machineFixture, ...usbDriveMounts}});
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

test('every discovery run has a later timestamp, and a present sensor carries that of its category', async () => {
    let {sensors, find} = setup();
    await sensors.discover();
    let firstRun = sensors.catalog.memory.discovered;
    equal(find('memory', 'usage').discovered, firstRun);
    // The second run starts in the same second.
    await sensors.discover();
    equal(sensors.catalog.memory.discovered > firstRun, true, 'later than the run before');
    equal(find('memory', 'usage').discovered, sensors.catalog.memory.discovered);
    sensors.destroy();
});

test('an unplugged device stays in the catalog and is not read; when it returns it is the same sensor in the same place', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let usbVoltage = find('voltage', USB_NAME + '/in0');
    let order = keys(sensors.catalog.voltage);
    show(usbVoltage);
    for (let file of ['name', 'in0_input', 'device/type'])
        machine.remove(USB + file);
    await sensors.discover();
    equal(find('voltage', USB_NAME + '/in0'), undefined, 'not present');
    equal(sensors.catalog.voltage.sensors.includes(usbVoltage), true, 'still in the catalog');
    equal(sensors.activeSources.has(usbVoltage.file), false, 'not read, although it is marked as shown');
    for (let file of ['name', 'in0_input', 'device/type'])
        machine.write(USB + file, machineFixture[USB + file]);
    await sensors.discover();
    equal(find('voltage', USB_NAME + '/in0'), usbVoltage, 'the same sensor is present again');
    equal(keys(sensors.catalog.voltage), order, 'in the same place');
    sensors.destroy();
});

test('a kernel number that passes to another device does not make the old sensor read the new device', async () => {
    let {sensors, machine, fileValue, find, show, advance} = setup();
    await sensors.discover();
    let usbVoltage = find('voltage', USB_NAME + '/in0');
    show(usbVoltage);
    await sensors.poll();
    let lastUsbReading = usbVoltage.value;
    // The USB supply is unplugged and another device gets hwmon8.
    machine.write(USB + 'name', 'other_supply\n');
    machine.write(USB + 'in0_input', '9000\n');
    await sensors.discover();
    let otherVoltage = find('voltage', 'other_supply/in0');
    show(usbVoltage, otherVoltage);
    advance(1);
    await sensors.poll();
    equal(otherVoltage.value, fileValue(USB + 'in0_input'), 'the new device is read');
    equal(usbVoltage.file, otherVoltage.file, 'the old sensor still names the same file');
    equal(usbVoltage.value, lastUsbReading, 'and is not read through it');
    sensors.destroy();
});

test('a discovery step that fails leaves its categories as they were', async () => {
    let {sensors, machine, errors, find} = setup();
    await sensors.discover();
    let discoveredBefore = sensors.catalog.temperature.discovered;
    machine.failLists('/sys/class/hwmon/', new Gio.IOErrorEnum({code: Gio.IOErrorEnum.FAILED, message: 'Input/output error'}));
    await sensors.discover();
    equal(errors.length, 1, 'the failure is reported');
    equal(sensors.catalog.temperature.discovered, discoveredBefore, 'the category is not completed');
    equal(find('temperature', 'thinkpad/temp1') !== undefined, true, 'its sensors are still present');
    equal(sensors.catalog.memory.discovered > discoveredBefore, true, 'other categories are completed');
    sensors.destroy();
});

test('no sensor is read during a discovery run, and a rate afterwards spans the run', async () => {
    let {sensors, machine, find, show, advance} = setup();
    let initial = {lo: {rx: 10, tx: 10}, eth0: {rx: 100, tx: 50}};
    let later = {lo: {rx: 10, tx: 10}, eth0: {rx: 700, tx: 350}};
    machine.write(NETWORK, networkDevices(initial));
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    show(download);
    await sensors.poll();
    let secondsBeforeRun = 2, secondsAfterRun = 1;
    advance(secondsBeforeRun);

    let mountsRead = machine.holdNextRead('/proc/self/mountinfo');
    let run = sensors.discover();
    // Let the run get as far as the read it is held at.
    await new Promise(resolve => setTimeout(resolve, 0));
    let readsBeforeTick = machine.reads.filter(readPath => readPath == NETWORK).length;
    await sensors.poll();
    equal(machine.reads.filter(readPath => readPath == NETWORK).length, readsBeforeTick, 'a tick that falls into a run reads nothing');
    mountsRead.finish();
    await run;

    advance(secondsAfterRun);
    machine.write(NETWORK, networkDevices(later));
    await sensors.poll();
    equal(download.status, 'ready', 'the rate does not start over after the run');
    equal(download.value, (later.eth0.rx - initial.eth0.rx) / (secondsBeforeRun + secondsAfterRun),
        'computed against the last reading before the run');
    sensors.destroy();
});

test('a discovery run cancels a read that is under way, and its late result is dropped', async () => {
    let {sensors, machine, find, show} = setup();
    await sensors.discover();
    let uptime = find('system', 'uptime');
    machine.write('/proc/uptime', '100.00 50.00\n');
    let uptimeRead = machine.holdNextRead('/proc/uptime');
    show(uptime);
    let poll = sensors.poll();
    await Promise.resolve();
    let readAfterRun = machine.holdNextRead('/proc/uptime');
    await sensors.discover();
    equal(uptimeRead.cancellable.is_cancelled(), true, 'the read is cancelled when the run starts');
    uptimeRead.finish();
    await poll;
    equal(uptime.value, undefined, 'the late result is not taken');
    equal(typeof readAfterRun.finish, 'function', 'the sensor is read again when the run ends, without a tick');
    readAfterRun.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(uptime.value, 100, 'and has its value');
    sensors.destroy();
});

test('a sensor that no run has found for a year is forgotten, unless it is in the panel', async () => {
    let {sensors, machine, find, advanceDate} = setup();
    machine.write(NETWORK, networkDevices({lo: {rx: 0, tx: 0}, eth0: {rx: 0, tx: 0}, veth1a2b3c: {rx: 0, tx: 0}}));
    await sensors.discover();
    let containerDownload = find('network', 'veth1a2b3c/rx');
    let containerUpload = find('network', 'veth1a2b3c/tx');
    sensors.setPanelSensorVisible('network', containerUpload, true);
    machine.write(NETWORK, networkDevices({lo: {rx: 0, tx: 0}, eth0: {rx: 0, tx: 0}}));
    advanceDate(YEAR_SECONDS - 60);
    await sensors.discover();
    equal(sensors.catalog.network.sensors.includes(containerDownload), true, 'kept within the year');
    advanceDate(120);
    await sensors.discover();
    equal(sensors.catalog.network.sensors.includes(containerDownload), false, 'forgotten after a year');
    equal(sensors.catalog.network.sensors.includes(containerUpload), true, 'a sensor in the panel is never forgotten');
    equal(find('network', 'eth0/rx') !== undefined, true, 'sensors that are still found stay');
    sensors.destroy();
});

test('a second launch finds the saved sensors again, in their order, with their last readings', async () => {
    let first = setup();
    await first.sensors.discover();
    let usage = first.find('memory', 'usage');
    first.show(usage);
    await first.sensors.poll();
    let order = keys(first.sensors.catalog.temperature);
    first.sensors.destroy();

    let second = setup({configuration: first.configuration});
    let restored = second.find('memory', 'usage');
    equal(restored.value, usage.value, 'the last reading is there before anything is read');
    equal(restored.status, 'saved');
    second.show(restored);
    equal(restored.status, 'saved', 'and stays on screen while this launch has no reading of its own');
    equal(sensorPresent(second.sensors.catalog.memory, restored), true, 'the saved sensor counts as present until discovery ran');
    await second.sensors.discover();
    equal(keys(second.sensors.catalog.temperature), order, 'discovery matches every saved sensor and adds none');
    equal(second.find('memory', 'usage'), restored, 'the saved sensor is the one discovery found');
    second.sensors.destroy();
});

test('a saved reading that is older than a minute is not shown at the next launch', async () => {
    let first = setup();
    await first.sensors.discover();
    let usage = first.find('memory', 'usage');
    first.show(usage);
    await first.sensors.poll();
    first.sensors.destroy();
    // The machine was off for two minutes.
    let saved = readCatalog(first.configuration);
    let savedUsage = saved.memory.sensors.find(sensor => sensor.key == 'usage');
    savedUsage.updated -= 120;
    writeCatalog(first.configuration, saved);

    let second = setup({configuration: first.configuration});
    equal(second.find('memory', 'usage').status, 'pending', 'an old reading says nothing about now');
    second.sensors.destroy();
});

test('a category is switched on and off in the saved catalog, and saving keeps what the preferences wrote', async () => {
    let {sensors, configuration, find} = setup();
    await sensors.discover();
    equal(sensors.catalog.battery.enabled, false, 'the schema default');
    writeCategoryEnabled(configuration, 'battery', true);
    // The collector saves before it has taken the switch over.
    sensors.setPanelSensorVisible('memory', find('memory', 'usage'), true);
    equal(readCatalog(configuration).battery.enabled, true, 'saving does not undo the switch');
    equal(sensors.reloadEnabled(), true, 'a changed switch is reported');
    equal(sensors.catalog.battery.enabled, true);
    equal(sensors.reloadEnabled(), false, 'nothing changed since');
    sensors.destroy();
});

test('shown sensors select only the sources they need', async () => {
    let {sensors, machine, find, show} = setup();
    let totalKilobytes = 1000, availableKilobytes = 400;
    machine.write('/proc/meminfo',
        'MemTotal: ' + totalKilobytes + ' kB\nMemAvailable: ' + availableKilobytes + ' kB\nMemFree: 300 kB\n');
    await sensors.discover();
    machine.reads.length = 0;
    show(find('memory', 'usage'), find('memory', 'free'));
    await sensors.poll();
    equal(machine.reads.join(','), '/proc/meminfo', 'shared memory read');
    equal(find('memory', 'usage').value, (totalKilobytes - availableKilobytes) / totalKilobytes, 'memory usage');
    machine.reads.length = 0;
    show();
    await sensors.poll();
    equal(machine.reads.length, 0, 'closed menu without pins');
    sensors.destroy();
});

test('a storage location has its space, and the header shows the free space of the first one', async () => {
    let {sensors, errors, find, show} = setup();
    let {'filesystem::size': size, 'filesystem::free': free, 'filesystem::used': used} = filesystems['/'];
    let value = field => find('storage', '//' + field).value;
    await sensors.discover();
    show(...['total', 'used', 'free', 'reserved', 'used-percent', 'free-percent'].map(field => find('storage', '//' + field)), 'storage');
    await sensors.poll();
    equal(errors.length, 0, 'collection errors');
    equal(value('total'), size, 'total');
    equal(value('used'), used, 'used');
    equal(value('free'), free, 'free is what users may still write');
    equal(value('reserved'), size - used - free, 'reserved is the unused space users may not write');
    equal(value('used-percent'), used / size, 'used share');
    equal(value('free-percent'), (size - used) / size, 'free share includes reserved space');
    equal(sensors.catalog.storage.header, find('storage', '//free'), 'group header shows free space');
    equal(find('storage', '//free').label, 'Free', 'with one location, a label does not name it');
    sensors.destroy();
});

test('every storage location has its own values, in a section of its own', async () => {
    let {sensors, machine, find, show} = setup({files: {...machineFixture, ...usbDriveMounts}, locations: [USB_DRIVE, '/']});
    // The order of the locations does not follow the order of the table.
    machine.write(MOUNTS, usbDriveMounts[MOUNTS].trim().split('\n').reverse().join('\n') + '\n');
    await sensors.discover();
    let rootFree = find('storage', '//free'), usbFree = find('storage', USB_DRIVE + '/free');
    equal(rootFree.lowIsBad, true, 'free space is watched for low values');
    equal(rootFree.label, 'Free (/)', 'with several locations, a label names its own');
    equal(usbFree.label, 'Free (' + USB_DRIVE + ')');
    equal(rootFree.section != usbFree.section, true, 'each location is a section');
    equal(find('storage', USB_DRIVE + '/read-rate').section, usbFree.section, 'with all its values');
    equal(sensors.catalog.storage.header, rootFree, 'the header shows the first location');
    show(usbFree);
    await sensors.poll();
    equal(usbFree.value, filesystems[USB_DRIVE]['filesystem::free']);
    equal(machine.asked.join(','), USB_DRIVE, 'only the location on screen is asked');
    sensors.destroy();
});

test('a storage location is monitored when the user added it and something is mounted there', async () => {
    let {sensors, configuration, find} = setup({files: {...machineFixture, ...shareMounts}});
    let locations = () => [...new Set(sensors.catalog.storage.sensors.filter(sensor => sensorPresent(sensors.catalog.storage, sensor))
        .map(sensor => sensor.location))].sort().join(',');
    await sensors.discover();
    equal(locations(), '/', 'at the start, the root alone');
    configuration.set_strv('storage-locations', ['/', SHARE, '/media/idle', '/mnt/backup']);
    await sensors.discover();
    equal(locations(), '/,' + SHARE, 'not the automount that is not connected, nor a path where nothing is mounted');
    equal(find('storage', SHARE + '/free').network, true, 'a share is a network storage location');
    equal(find('storage', SHARE + '/read-rate'), undefined, 'which has no disk whose reads are counted');
    equal(find('storage', '//free').network, false);
    configuration.set_strv('storage-locations', [SHARE]);
    await sensors.discover();
    equal(sensors.catalog.storage.header, find('storage', SHARE + '/free'), 'the header shows the first monitored one');
    equal(sensors.catalog.storage.header.label, 'Free');
    configuration.set_strv('storage-locations', [SHARE, '/']);
    await sensors.discover();
    equal(sensors.catalog.storage.header, find('storage', '//free'), 'also when the first one was added later');
    sensors.destroy();
});

test('what GNOME reports as mounted is monitored while the user wants that', async () => {
    let {sensors, configuration, machine, find} = setup({files: {...machineFixture, ...usbDriveMounts}});
    // A phone is a mount without a path.
    machine.volumes = [USB_DRIVE, null];
    await sensors.discover();
    equal(find('storage', USB_DRIVE + '/free'), undefined, 'not from the start');
    configuration.set_boolean('storage-monitor-volumes', true);
    await sensors.discover();
    equal(find('storage', USB_DRIVE + '/free').status, 'pending', 'the drive, which the user did not add');
    equal(find('storage', '//free').label, 'Free (/)', 'beside the root');
    machine.volumes = [];
    await sensors.discover();
    equal(find('storage', USB_DRIVE + '/free'), undefined, 'gone with its mount');
    sensors.destroy();
});

test('a network storage location is asked once per interval, a disk at every tick', async () => {
    let {sensors, configuration, machine, find, show, advance} = setup({files: {...machineFixture, ...shareMounts}, locations: ['/', SHARE]});
    let minutes = 2;
    configuration.set_int('storage-network-interval', minutes);
    await sensors.discover();
    let shareFree = find('storage', SHARE + '/free'), rootFree = find('storage', '//free');
    show(shareFree, rootFree);
    await sensors.poll();
    equal(shareFree.value, filesystems[SHARE]['filesystem::free']);
    let asked = location => machine.asked.filter(askedLocation => askedLocation == location).length;
    let shareAsked = asked(SHARE), rootAsked = asked('/');
    advance(minutes * 60 - 1);
    await sensors.poll();
    equal(asked(SHARE), shareAsked, 'the share is not asked inside its interval');
    equal(asked('/'), rootAsked + 1, 'the disk is');
    show(rootFree);
    show(shareFree, rootFree);
    await sensors.poll();
    equal(asked(SHARE), shareAsked, 'nor when it comes on screen again inside it');
    equal(shareFree.status, 'ready', 'it shows the answer it has');
    await sensors.poll(true);
    equal(asked(SHARE), shareAsked + 1, 'a forced reading asks it at once');
    advance(minutes * 60);
    await sensors.poll();
    equal(asked(SHARE), shareAsked + 2, 'and so does a tick after the interval');
    sensors.destroy();
});

test('a storage location where nothing is mounted any more is not asked', async () => {
    let {sensors, machine, find, show, advance} = setup({files: {...machineFixture, ...shareMounts}, locations: ['/', SHARE]});
    await sensors.discover();
    let shareFree = find('storage', SHARE + '/free');
    show(shareFree);
    await sensors.poll();
    let askedWhileConnected = machine.asked.length;
    // The share disconnects: its automount stays in the table.
    machine.write(MOUNTS, shareMounts[MOUNTS].split('\n').filter(line => !line.includes(' cifs ')).join('\n'));
    await sensors.poll(true);
    equal(machine.asked.length, askedWhileConnected, 'asking would connect it again');
    equal(shareFree.status, 'unavailable');
    machine.write(MOUNTS, shareMounts[MOUNTS]);
    advance(1);
    await sensors.poll();
    equal(shareFree.status, 'ready', 'connected again, it is asked at the next tick and does not wait for its interval');
    sensors.destroy();
});

test('a storage location that does not answer is not asked a second time', async () => {
    let {sensors, machine, find, show, advance} = setup({files: {...machineFixture, ...shareMounts}, locations: ['/', SHARE]});
    await sensors.discover();
    let shareFree = find('storage', SHARE + '/free');
    let question = machine.holdNextRead(SHARE);
    let secondQuestion;
    show(shareFree);
    // Let the read get as far as the question it is held at.
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(typeof question.finish, 'function', 'the question is out');
    secondQuestion = machine.holdNextRead(SHARE);
    // Each run cancels the read under way, and the reading that follows the run reads again.
    await sensors.discover();
    let reading = sensors.poll(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(secondQuestion.finish, null, 'no second question while the first is out');
    equal(machine.asked.filter(location => location == SHARE).length, 1, 'through the run and the readings after it');
    question.finish();
    await reading;
    equal(shareFree.value, filesystems[SHARE]['filesystem::free'], 'the answer serves the reading that waited');
    advance(1);
    reading = sensors.poll(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(typeof secondQuestion.finish, 'function', 'the location is asked again once it has answered');
    secondQuestion.finish();
    await reading;
    sensors.destroy();
});

test('storage rates identify mapped devices and keep idle readings available', async () => {
    let {sensors, machine, find, show, advance} = setup({files: {...machineFixture, ...mappedRootMounts}});
    let disk = {device: '254:1', name: 'dm-1', readSectors: 100, writtenSectors: 50};
    machine.write(DISKS, diskStatistics([disk]));
    await sensors.discover();
    let readRate = find('storage', '//read-rate'), writeRate = find('storage', '//write-rate');
    show(readRate, writeRate);
    await sensors.poll();
    equal(readRate.status, 'pending', 'first reading establishes baseline');
    let seconds = 2, readSectors = 4, writtenSectors = 2;
    advance(seconds);
    machine.write(DISKS, diskStatistics([
        {...disk, readSectors: disk.readSectors + readSectors, writtenSectors: disk.writtenSectors + writtenSectors}
    ]));
    machine.reads.length = 0;
    await sensors.poll();
    equal(machine.reads.join(','), DISKS, 'read and write share one disk snapshot');
    equal(readRate.value, readSectors * SECTOR_BYTES / seconds, 'read bytes per second');
    equal(writeRate.value, writtenSectors * SECTOR_BYTES / seconds, 'write bytes per second');
    advance(1);
    await sensors.poll();
    equal(readRate.status, 'ready', 'idle read rate remains available');
    equal(readRate.value, 0, 'idle read rate is zero');
    machine.write(DISKS, diskStatistics([{device: '8:0', name: 'sda', readSectors: 10, writtenSectors: 10}]));
    advance(1);
    await sensors.poll();
    equal(readRate.status, 'unavailable', 'removed disk unavailable');
    machine.write(DISKS, diskStatistics([disk]));
    advance(1);
    await sensors.poll();
    equal(readRate.status, 'pending', 'return establishes new baseline');
    advance(1);
    await sensors.poll();
    equal(readRate.status, 'ready', 'returned idle disk available');
    sensors.destroy();
});

test('storage rates are those of the location\'s own disk, also at a path with an escaped space', async () => {
    let {sensors, machine, find, show, advance} = setup({files: {...machineFixture, ...usbDriveMounts}, locations: ['/', USB_DRIVE]});
    let rootDisk = {device: '254:1', name: 'dm-1', readSectors: 100, writtenSectors: 50};
    let usbDisk = {device: '8:1', name: 'sda1', readSectors: 10, writtenSectors: 10};
    machine.write(DISKS, diskStatistics([rootDisk, usbDisk]));
    await sensors.discover();
    let readRate = find('storage', USB_DRIVE + '/read-rate');
    show(readRate);
    await sensors.poll();
    let seconds = 1, readSectors = 2;
    advance(seconds);
    machine.write(DISKS, diskStatistics([rootDisk, {...usbDisk, readSectors: usbDisk.readSectors + readSectors}]));
    await sensors.poll();
    equal(readRate.value, readSectors * SECTOR_BYTES / seconds, 'the USB drive, not the root disk');
    equal(readRate.format, 'storage-rate', 'rate format');
    sensors.destroy();
});

test('hide-zeros excludes a temperature that reads zero at discovery', async () => {
    let {sensors, configuration, machine, fileValue, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.write(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp2'), undefined, 'zero temperature excluded');
    show(find('temperature', 'average'));
    machine.reads.length = 0;
    await sensors.poll();
    equal(machine.reads.includes(THINKPAD + 'temp2_input'), false, 'excluded temperature not polled');
    equal(find('temperature', 'average').value,
        mean(TEMPERATURES.filter(path => path != THINKPAD + 'temp2_input').map(fileValue)), 'excluded temperature not averaged');
    sensors.destroy();
});

test('hide-zeros admits an excluded temperature when a rediscovery reads a value', async () => {
    let {sensors, configuration, machine, fileValue, find, show, advance} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.write(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    show(find('temperature', 'average'));
    machine.write(THINKPAD + 'temp2_input', '10000\n');
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp2'), undefined, 'polling does not admit the temperature');
    await sensors.discover();
    advance(1);
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'rediscovery admits the temperature');
    equal(find('temperature', 'average').value, mean(TEMPERATURES.map(fileValue)), 'admitted temperature averaged');
    sensors.destroy();
});

test('hide-zeros keeps an admitted temperature that later reads zero', async () => {
    let {sensors, configuration, machine, fileValue, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    await sensors.discover();
    show(find('temperature', 'average'));
    machine.write(THINKPAD + 'temp1_input', '0\n');
    await sensors.discover();
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp1') !== undefined, true, 'admitted temperature survives a later zero');
    equal(find('temperature', 'average').value, mean(TEMPERATURES.map(fileValue)), 'later zero averaged');
    sensors.destroy();
});

test('turning hide-zeros off admits a temperature that reads zero', async () => {
    let {sensors, configuration, machine, fileValue, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.write(THINKPAD + 'temp2_input', '0\n');
    await sensors.discover();
    equal(find('temperature', 'thinkpad/temp2'), undefined, 'zero temperature excluded while the option is on');
    configuration.set_boolean('hide-zeros', false);
    await sensors.discover();
    show(find('temperature', 'average'));
    await sensors.poll();
    equal(find('temperature', 'thinkpad/temp2') !== undefined, true, 'zero temperature admitted');
    equal(find('temperature', 'average').value, mean(TEMPERATURES.map(fileValue)), 'zero temperature averaged');
    sensors.destroy();
});

test('hide-zeros keeps zero fan and voltage readings', async () => {
    let {sensors, configuration, machine, find, show} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.write(THINKPAD + 'fan1_input', '0\n');
    machine.write(THINKPAD + 'in1_input', '0\n');
    await sensors.discover();
    let zeroReadings = [find('fan', 'thinkpad/fan1'), find('voltage', 'thinkpad/in1')];
    show(...zeroReadings);
    await sensors.poll();
    for (let sensor of zeroReadings) {
        equal(sensor.status, 'ready', sensor.key + ' valid');
        equal(sensor.value, 0, sensor.key + ' zero');
    }
    sensors.destroy();
});

test('an unreadable initial temperature does not abort discovery', async () => {
    let {sensors, configuration, machine, errors, find} = setup();
    configuration.set_boolean('hide-zeros', true);
    machine.failReads(THINKPAD + 'temp1_input',
        new Gio.IOErrorEnum({code: Gio.IOErrorEnum.FAILED, message: 'No such device or address'}));
    await sensors.discover();
    equal(errors.length, 0, 'an unreadable sensor is not reported as an error');
    equal(find('temperature', 'thinkpad/temp1'), undefined, 'failed sensor excluded');
    equal(find('temperature', 'thermal/SEN1') !== undefined, true, 'other sensors still discovered');
    equal(find('voltage', 'thinkpad/in1') !== undefined, true, 'voltage still discovered');
    sensors.destroy();
});

test('rediscovery keeps readings and a format setting causes no reads', async () => {
    let {sensors, configuration, machine, fileValue, find, show} = setup();
    await sensors.discover();
    let temperature = find('temperature', 'thinkpad/temp1');
    show(temperature);
    await sensors.poll();
    await sensors.discover();
    equal(temperature.value, fileValue(THINKPAD + 'temp1_input'), 'retained reading');
    equal(temperature.status, 'ready');
    machine.reads.length = 0;
    configuration.set_int('unit', 1);
    equal(machine.reads.length, 0, 'format setting does not read');
    sensors.destroy();
});

test('the voltage header shows the battery, then the system, then a USB supply, as discovery finds them', async () => {
    let {sensors, machine, fileValue, show, advance} = setup();
    let header = () => sensors.catalog.voltage.header;
    await sensors.discover();
    show('voltage');
    machine.reads.length = 0;
    await sensors.poll();
    equal(header().value, fileValue(BATTERY + 'in0_input'), 'battery preferred regardless of name or magnitude');
    equal(machine.reads.join(','), BATTERY + 'in0_input', 'only the header\'s voltage is read for it');
    machine.remove(BATTERY + 'in0_input');
    advance(1);
    await sensors.poll();
    equal(header().status, 'unavailable', 'a header whose voltage cannot be read keeps its sensor until the next discovery');
    await sensors.discover();
    advance(1);
    await sensors.poll();
    equal(header().value, fileValue(THINKPAD + 'in1_input'), 'system voltage preferred over USB');
    machine.remove(THINKPAD + 'in1_input');
    machine.remove(THINKPAD + 'in2_input');
    await sensors.discover();
    advance(1);
    await sensors.poll();
    equal(header().value, fileValue(USB + 'in0_input'), 'USB used when it is the only voltage');
    machine.remove(USB + 'in0_input');
    await sensors.discover();
    equal(header(), undefined, 'no voltage, no header');
    sensors.destroy();
});

test('temperature aggregates ignore an unreadable input and include it again when it recovers', async () => {
    let {sensors, machine, fileValue, find, show, advance} = setup();
    await sensors.discover();
    let average = find('temperature', 'average');
    equal(sensors.catalog.temperature.header, average, 'the header shows the average');
    equal(average.aggregate, true, 'the average is marked as computed over the sensors');
    equal(find('temperature', 'thinkpad/temp1').aggregate, undefined, 'a sensor of the machine is not');
    equal(average.section > (find('temperature', 'thinkpad/temp1').section ?? 0), true, 'and it is in a section after the sensors');
    show('temperature', average, find('temperature', 'minimum'), find('temperature', 'maximum'));
    machine.remove(THINKPAD + 'temp1_input');
    await sensors.poll();
    let readable = TEMPERATURES.filter(path => path != THINKPAD + 'temp1_input').map(fileValue);
    equal(average.status, 'ready', 'average with failed input');
    equal(average.value, mean(readable), 'average of the readable temperatures');
    equal(find('temperature', 'minimum').value, Math.min(...readable), 'minimum ignores failed input');
    equal(find('temperature', 'maximum').value, Math.max(...readable), 'maximum ignores failed input');
    machine.write(THINKPAD + 'temp1_input', machineFixture[THINKPAD + 'temp1_input']);
    advance(1);
    await sensors.poll();
    equal(average.value, mean(TEMPERATURES.map(fileValue)), 'recovered temperature included');
    for (let path of TEMPERATURES)
        machine.remove(path);
    advance(1);
    await sensors.poll();
    equal(average.status, 'unavailable', 'no readings is not zero');
    sensors.destroy();
});

test('with one temperature there is no average row and the header shows that temperature', async () => {
    let {sensors, machine, find} = setup();
    for (let path of Object.keys(machineFixture)) {
        if ((path.startsWith('/sys/class/hwmon/') || path.startsWith(ZONES)) && !path.startsWith(THINKPAD))
            machine.remove(path);
    }
    machine.remove(THINKPAD + 'temp2_input');
    machine.remove(THINKPAD + 'temp2_label');
    await sensors.discover();
    equal(find('temperature', 'average'), undefined, 'no average of one');
    equal(sensors.catalog.temperature.header, find('temperature', 'thinkpad/temp1'));
    sensors.destroy();
});

test('network inventory changes update rates and sums; an interface leaves and returns like any sensor', async () => {
    let {sensors, machine, errors, find, show, advance} = setup();
    let initial = {lo: {rx: 10, tx: 10}, eth0: {rx: 100, tx: 50}};
    machine.write(NETWORK, networkDevices(initial));
    // The interfaces that come and go in this test are hardware, like eth0.
    plugInInterface(machine, 'wlan0', 'wlan');
    plugInInterface(machine, 'eth1');
    await sensors.discover();
    let combined = find('network', 'combined');
    let eth0Download = find('network', 'eth0/rx');
    show(combined, eth0Download);
    machine.reads.length = 0;
    await sensors.poll();
    equal(machine.reads.length, 1, 'one shared network read');
    equal(combined.status, 'pending', 'initial baseline');

    let busy = {lo: {rx: 9000, tx: 9000}, eth0: {rx: 300, tx: 150}};
    advance(2);
    machine.write(NETWORK, networkDevices(busy));
    await sensors.poll();
    equal(combined.value, combinedRate(initial, busy, 2), 'combined excludes loopback');

    let joined = {eth0: {rx: 400, tx: 200}, wlan0: {rx: 0, tx: 0}, eth1: {rx: 0, tx: 0}};
    advance(1);
    machine.write(NETWORK, networkDevices(joined));
    await sensors.poll();
    equal(find('network', 'wlan0/rx') !== undefined, true, 'Wi-Fi adapter appeared');
    equal(find('network', 'eth1/tx') !== undefined, true, 'second network card appeared');

    let allBusy = {eth0: {rx: 500, tx: 250}, wlan0: {rx: 100, tx: 50}, eth1: {rx: 100, tx: 50}};
    advance(1);
    machine.write(NETWORK, networkDevices(allBusy));
    await sensors.poll();
    equal(combined.value, combinedRate(joined, allBusy, 1), 'all current interfaces contribute');

    let withoutEth0 = {wlan0: {rx: 200, tx: 100}, eth1: {rx: 200, tx: 100}};
    advance(1);
    machine.write(NETWORK, networkDevices(withoutEth0));
    await sensors.poll();
    equal(find('network', 'eth0/rx'), undefined, 'an interface that disappeared is no longer present');
    equal(combined.value, combinedRate(allBusy, withoutEth0, 1), 'missing interface excluded');

    machine.remove(NETWORK);
    advance(1);
    await sensors.poll();
    equal(errors.length, 0, 'a failed read is not reported as an error');
    equal(find('network', 'wlan0/rx') !== undefined, true, 'failed read preserves inventory');

    let returned = {eth0: {rx: 5000, tx: 2500}};
    advance(1);
    machine.write(NETWORK, networkDevices(returned));
    await sensors.poll();
    equal(find('network', 'eth0/rx'), eth0Download, 'the returned interface is the same sensor again');
    equal(find('network', 'wlan0/rx'), undefined, 'the interfaces that disappeared are no longer present');
    equal(eth0Download.status, 'pending', 'return establishes baseline');

    let returnedBusy = {eth0: {rx: 5100, tx: 2550}};
    advance(1);
    machine.write(NETWORK, networkDevices(returnedBusy));
    await sensors.poll();
    equal(combined.value, combinedRate(returned, returnedBusy, 1), 'normal rate after return');
    sensors.destroy();
});

test('network totals are over the hardware interfaces, so what a VPN carries is not counted a second time', async () => {
    let {sensors, configuration, machine, find, show, advance} = setup();
    configuration.set_boolean('include-public-ip', true);
    // tun0 is a VPN: no hardware, and its traffic passes eth0 as well.
    let initial = {lo: {rx: 10, tx: 10}, eth0: {rx: 100, tx: 50}, wlan0: {rx: 1000, tx: 500}, tun0: {rx: 70, tx: 30}};
    let later = {lo: {rx: 90, tx: 90}, eth0: {rx: 300, tx: 150}, wlan0: {rx: 1600, tx: 800}, tun0: {rx: 200, tx: 90}};
    let hardware = ['eth0', 'wlan0'];
    plugInInterface(machine, 'wlan0', 'wlan');
    let seconds = 2;
    let value = key => find('network', key).value;
    let total = (counters, direction) => hardware.reduce((bytes, name) => bytes + counters[name][direction], 0);
    machine.write(NETWORK, networkDevices(initial));
    await sensors.discover();
    equal(find('network', 'tun0/rx').hardware, false, 'the VPN interface is known, and known not to be hardware');
    let sections = ['device-rx', 'wlan0/rx', 'boot-rx', 'public-ip', 'tun0/rx', 'lo/tx']
        .map(key => find('network', key).section);
    equal(sections.join(','), [...sections].sort().join(','),
        'sections: the machine, hardware interfaces, volume, other, virtual interfaces');
    equal(new Set(sections).size, 5, 'five different sections');
    equal(find('network', 'wifi-link-quality').section, find('network', 'wlan0/rx').section,
        'the WiFi values are in the section of the hardware interfaces');
    equal(find('network', 'wlan0/rx').label, 'WiFi (wlan0) download speed', 'a hardware interface is called by its kind');
    equal(find('network', 'eth0/tx').label, 'Ethernet (eth0) upload speed');
    equal(find('network', 'tun0/rx').label, 'tun0 download speed', 'a virtual one by its name');
    equal(find('network', 'lo/tx').label, 'lo transferred');
    equal(find('network', 'device-rx').label, 'Download speed');
    equal(find('network', 'session-tx').label, 'Uploaded this session');
    show(...['boot-rx', 'boot-tx', 'session-rx', 'session-tx', 'device-rx', 'device-tx', 'combined', 'tun0/rx']
        .map(key => find('network', key)));
    await sensors.poll();
    equal(value('boot-rx'), total(initial, 'rx'), 'boot total is the sum of the hardware counters');
    equal(value('session-rx'), 0, 'session total starts at the first reading');
    advance(seconds);
    machine.write(NETWORK, networkDevices(later));
    await sensors.poll();
    for (let direction of ['rx', 'tx']) {
        equal(value('boot-' + direction), total(later, direction), 'boot ' + direction);
        equal(value('session-' + direction), total(later, direction) - total(initial, direction), 'session ' + direction);
        equal(value('device-' + direction), (total(later, direction) - total(initial, direction)) / seconds, 'device ' + direction);
    }
    equal(value('combined'), value('device-rx') + value('device-tx'), 'combined is download plus upload');
    equal(value('tun0/rx'), (later.tun0.rx - initial.tun0.rx) / seconds, 'the VPN interface still has its own rate');
    sensors.destroy();
});

test('network polling leaves the other categories alone and does not collect voltage', async () => {
    let {sensors, machine, find, show, advance} = setup();
    await sensors.discover();
    let voltageHeader = sensors.catalog.voltage.header;
    let temperatureHeader = sensors.catalog.temperature.header;
    show(find('network', 'combined'));
    machine.reads.length = 0;
    let polls = 3;
    for (let poll = 0; poll < polls; poll++) {
        advance(1);
        machine.write(NETWORK, networkDevices({lo: {rx: 10, tx: 10}, eth0: {rx: 100 + poll * 100, tx: 50 + poll * 50}}));
        await sensors.poll();
        equal(sensors.catalog.voltage.header, voltageHeader, 'voltage header retained');
        equal(sensors.catalog.temperature.header, temperatureHeader, 'temperature header retained');
    }
    equal(machine.reads.join(','), Array(polls).fill(NETWORK).join(','), 'only the shown network source is read');
    sensors.destroy();
});

test('menu demand changes preserve network readings between shared ticks', async () => {
    let {sensors, configuration, machine, find, show, advance} = setup();
    let updateSeconds = 5;
    let initial = {lo: {rx: 10, tx: 10}, eth0: {rx: 100, tx: 50}};
    let busy = {lo: {rx: 10, tx: 10}, eth0: {rx: 600, tx: 300}};
    configuration.set_int('update-time', updateSeconds);
    machine.write(NETWORK, networkDevices(initial));
    await sensors.discover();
    let download = find('network', 'eth0/rx');
    show(download);
    await sensors.poll();
    advance(updateSeconds);
    machine.write(NETWORK, networkDevices(busy));
    await sensors.poll();
    let sample = sensors.reading(NETWORK);
    machine.reads.length = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
        advance(0.1);
        show(download, find('network', 'combined'), 'memory');
        show(download);
        equal(download.value, (busy.eth0.rx - initial.eth0.rx) / updateSeconds, 'rate retained after menu close');
        equal(sensors.reading(NETWORK), sample, 'counter and timestamp retained');
    }
    // A read that the last change of what is on screen caused would have started by now.
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(machine.reads.includes(NETWORK), false, 'no premature network read');
    advance(updateSeconds);
    await sensors.poll();
    equal(download.value, 0, 'no traffic reads as zero after a full interval');
    sensors.destroy();
});

test('steady collection uses no regular expressions', async () => {
    let {sensors, errors, find, show, advance} = setup();
    await sensors.discover();
    let shown = [find('processor', 'usage'), find('processor', 'frequency'), find('memory', 'usage'), find('network', 'combined')];
    show(...shown, 'temperature', 'voltage');
    await sensors.poll();
    let exec = RegExp.prototype.exec;
    RegExp.prototype.exec = function () { throw new Error('Regex executed during collection: ' + this); };
    try {
        advance(1);
        await sensors.poll();
    } finally {
        RegExp.prototype.exec = exec;
    }
    equal(errors.length, 0, 'collection errors');
    for (let sensor of [...shown, sensors.catalog.temperature.header, sensors.catalog.voltage.header])
        equal(sensor.status, 'ready', sensor.key + ' collected');
    sensors.destroy();
});

test('NVIDIA initially zero temperatures are excluded and retried on discovery', async () => {
    let {sensors, configuration, find} = setup();
    let nvidiaSmi = installNvidiaSmi();
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    configuration.set_boolean('hide-zeros', true);
    let admittedTemperature = 45;
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': 0}]);
    await sensors.discover();
    equal(find('gpu', 'Test GPU/temperature.gpu'), undefined, 'zero GPU temperature excluded');
    equal(find('gpu', 'Test GPU/temperature.memory'), undefined, 'unavailable GPU memory temperature excluded');
    equal(find('temperature', 'Test GPU/temperature.gpu'), undefined, 'excluded GPU not among the temperatures');
    equal(nvidiaSmi.streams().length, 0, 'discovery does not start streaming');
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': admittedTemperature}]);
    await sensors.discover();
    equal(find('temperature', 'Test GPU/temperature.gpu') !== undefined, true, 'nonzero GPU temperature admitted');
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'temperature.gpu': 0}]);
    await sensors.discover();
    equal(find('temperature', 'Test GPU/temperature.gpu') !== undefined, true, 'accepted GPU survives later zero');
    equal(find('gpu', 'Test GPU/temperature.gpu').initialTemperature, admittedTemperature, 'initial reading retained');
    configuration.set_boolean('hide-zeros', false);
    await sensors.discover();
    equal(find('gpu', 'Test GPU/temperature.memory') !== undefined, true, 'option off leaves availability to collection');
    sensors.destroy();
});

test('the NVIDIA stream asks for the fields of the shown sensors only and stops when none is shown', async () => {
    let {sensors, configuration, find, show} = setup();
    let nvidiaSmi = installNvidiaSmi();
    let card = {uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192, 'temperature.gpu': 45};
    nvidiaSmi.setCards([card]);
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    configuration.set_boolean('include-static-gpu-info', false);
    await sensors.discover();
    equal(nvidiaSmi.streams().length, 0, 'discovery leaves streaming stopped');
    equal(sensors.catalog.gpu.header, find('gpu', 'Test GPU/utilization.gpu'), 'the header shows the utilization');
    let memoryUsage = find('gpu', 'Test GPU/memory-usage');
    show(memoryUsage);
    await sensors.poll();
    equal(memoryUsage.value, card['memory.used'] / card['memory.total'], 'NVIDIA memory usage');
    equal(nvidiaSmi.streams()[0].queriedFields, 'uuid,memory.total,memory.used', 'only required fields queried');
    let amongTemperatures = find('temperature', 'Test GPU/temperature.gpu');
    let cardTemperature = find('gpu', 'Test GPU/temperature.gpu');
    let linkSpeed = find('gpu', 'Test GPU/link-speed');
    show(amongTemperatures, cardTemperature, linkSpeed);
    await sensors.poll();
    equal(amongTemperatures.value, card['temperature.gpu'], 'temperature among the temperatures');
    equal(amongTemperatures.label, 'GPU');
    equal(cardTemperature.value, card['temperature.gpu'], 'temperature row');
    equal(linkSpeed.status, 'unavailable', 'unsupported PCIe value');
    show();
    await nvidiaSmi.allStopped();
    sensors.destroy();
});

test('a tick starts the NVIDIA stream again when the update interval changed and when the process ended', async () => {
    let {sensors, configuration, find, show, advance} = setup();
    let nvidiaSmi = installNvidiaSmi();
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192}]);
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    await sensors.discover();
    let memoryUsed = find('gpu', 'Test GPU/memory.used');
    show(memoryUsed);
    await sensors.poll();
    equal(nvidiaSmi.streams().length, 1);

    let updateSeconds = configuration.get_int('update-time') + 2;
    configuration.set_int('update-time', updateSeconds);
    advance(updateSeconds);
    await sensors.poll();
    equal(nvidiaSmi.streams().length, 2, 'the tick after a changed update interval starts a new process');
    equal(nvidiaSmi.streams()[1].interval, updateSeconds, 'which reports at that interval');

    GLib.spawn_command_line_sync('kill ' + nvidiaSmi.streams()[1].pid);
    // The first tick finds the process gone, the second has the reading of the new one.
    for (let tick = 0; tick < 2; tick++) {
        await new Promise(resolve => setTimeout(resolve, 300));
        advance(updateSeconds);
        await sensors.poll();
    }
    equal(nvidiaSmi.streams().length, 3, 'a tick starts the process again after it ended');
    equal(memoryUsed.status, 'ready');
    show();
    await nvidiaSmi.allStopped();
    sensors.destroy();
});

test('an NVIDIA sensor that comes on screen next to a shown one of its card is read at once', async () => {
    let {sensors, configuration, find, show} = setup();
    let nvidiaSmi = installNvidiaSmi();
    let card = {uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192, 'utilization.gpu': 30};
    nvidiaSmi.setCards([card]);
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    await sensors.discover();
    let memoryUsed = find('gpu', 'Test GPU/memory.used');
    let utilization = find('gpu', 'Test GPU/utilization.gpu');
    show(memoryUsed);
    await sensors.poll();
    show(memoryUsed, utilization);
    // No tick follows. The process that reports the utilization as well has to start and print its first line.
    for (let waited = 0; utilization.status != 'ready' && waited < 3000; waited += 50)
        await new Promise(resolve => setTimeout(resolve, 50));
    equal(utilization.status, 'ready', 'without a tick');
    equal(utilization.value, card['utilization.gpu'] / 100);
    show();
    await nvidiaSmi.allStopped();
    sensors.destroy();
});

test('the refresh rate shows that its value is on its way until two frames were counted', async () => {
    let {sensors, configuration, find, show} = setup();
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    await sensors.discover();
    let refreshRate = find('gpu', 'refresh-rate');
    show(refreshRate);
    await sensors.poll();
    equal(refreshRate.status, 'pending', 'no frame is counted outside the Shell');
    sensors.destroy();
});

test('showing the same NVIDIA sensors in another order keeps the running process', async () => {
    let {sensors, configuration, find, show} = setup();
    let nvidiaSmi = installNvidiaSmi();
    nvidiaSmi.setCards([{uuid: 'GPU-test', name: 'Test GPU', 'memory.used': 2048, 'memory.total': 8192}]);
    writeCategoryEnabled(configuration, 'gpu', true);
    sensors.reloadEnabled();
    await sensors.discover();
    let used = find('gpu', 'Test GPU/memory.used'), total = find('gpu', 'Test GPU/memory.total');
    show(used, total);
    await sensors.poll();
    show(total, used);
    equal(nvidiaSmi.streams().length, 1, 'process retained');
    sensors.destroy();
    await nvidiaSmi.allStopped();
});

test('the machine\'s battery is found by its type, whatever its name; a mouse\'s battery is not', async () => {
    let {sensors, machine, find, show} = setup();
    let percent = 80;
    machine.remove('/sys/class/power_supply/BAT0/type');
    machine.remove('/sys/class/power_supply/BAT0/uevent');
    plugInBattery(machine, 'main-battery', {status: 'Not charging', powerWatts: 0, percent});
    plugInBattery(machine, 'hidpp_battery_0', {status: 'Discharging', powerWatts: 0, percent: 50, scope: 'Device'});
    await sensors.discover();
    let percentage = find('battery', 'main-battery/percentage');
    equal(percentage.label, 'Percentage', 'with one battery the labels do not name it');
    equal(find('battery', 'hidpp_battery_0/percentage'), undefined, 'the battery of a device is left out');
    equal(find('battery', 'total-power-rate'), undefined, 'one battery has no total');
    equal(sensors.catalog.battery.header, find('battery', 'main-battery/power-rate'), 'the header shows its power rate');
    show(percentage);
    await sensors.poll();
    equal(percentage.value, percent / 100);
    sensors.destroy();
});

test('two batteries each have their own sensors, and the header shows their power rates together', async () => {
    let {sensors, machine, find, show} = setup();
    let dischargingWatts = 12, chargingWatts = 5;
    plugInBattery(machine, 'BAT0', {status: 'Discharging', powerWatts: dischargingWatts, percent: 40});
    plugInBattery(machine, 'BAT1', {status: 'Charging', powerWatts: chargingWatts, percent: 90});
    await sensors.discover();
    equal(find('battery', 'BAT0/percentage').label, 'BAT0 Percentage', 'the labels say which battery');
    equal(find('battery', 'BAT1/percentage').label, 'BAT1 Percentage');
    let total = find('battery', 'total-power-rate');
    equal(sensors.catalog.battery.header, total, 'the header shows the total');
    show('battery', find('battery', 'BAT0/time-left'), find('battery', 'BAT1/time-left'));
    await sensors.poll();
    equal(find('battery', 'BAT0/power-rate').value, -dischargingWatts, 'a battery that is discharging has a negative rate');
    equal(total.value, chargingWatts - dischargingWatts, 'the total is the sum of both');
    equal(find('battery', 'BAT0/time-left').value !== find('battery', 'BAT1/time-left').value, true, 'each battery has its own time left');
    sensors.destroy();
});

test('a name the user gives a sensor is kept across discovery and a restart, next to the sensor\'s own label', async () => {
    let first = setup();
    await first.sensors.discover();
    let temperature = first.find('temperature', 'thinkpad/temp1');
    let ownLabel = temperature.label;
    first.sensors.renameSensor(temperature, 'Processor');
    await first.sensors.discover();
    equal(temperature.customLabel, 'Processor', 'discovery does not take the name away');
    equal(temperature.label, ownLabel, 'and still writes the sensor\'s own label');
    first.sensors.destroy();

    let second = setup({configuration: first.configuration});
    equal(second.find('temperature', 'thinkpad/temp1').customLabel, 'Processor', 'saved with the catalog');
    second.sensors.renameSensor(second.find('temperature', 'thinkpad/temp1'), '');
    equal(second.find('temperature', 'thinkpad/temp1').customLabel, undefined, 'an empty name gives the own label back');
    second.sensors.destroy();
});

test('a hidden sensor does not count in the average, minimum and maximum, and is not read for them', async () => {
    let {sensors, machine, fileValue, find, show} = setup();
    await sensors.discover();
    let hidden = find('temperature', 'thinkpad/temp2');
    sensors.setSensorHidden(hidden, true);
    show(find('temperature', 'average'));
    machine.reads.length = 0;
    await sensors.poll();
    let counted = TEMPERATURES.filter(path => path != THINKPAD + 'temp2_input');
    equal(machine.reads.includes(THINKPAD + 'temp2_input'), false, 'not read');
    equal(find('temperature', 'average').value, mean(counted.map(fileValue)), 'average over the others');
    sensors.setSensorHidden(hidden, false);
    equal(hidden.hidden, undefined, 'shown again');
    await sensors.poll();
    equal(find('temperature', 'average').value, mean(TEMPERATURES.map(fileValue)), 'and counted again');
    sensors.destroy();
});

test('the sensor the user makes the category default is what the header shows, also after discovery', async () => {
    let {sensors, find} = setup();
    await sensors.discover();
    let automatic = sensors.catalog.temperature.header;
    let chosen = find('temperature', 'thinkpad/temp1');
    sensors.setCategoryDefault('temperature', chosen);
    equal(sensors.catalog.temperature.header, chosen);
    await sensors.discover();
    equal(sensors.catalog.temperature.header, chosen, 'discovery keeps the choice');
    sensors.setCategoryDefault('temperature', find('temperature', 'thinkpad/temp2'));
    equal(chosen.categoryDefault, undefined, 'a category has one default');
    sensors.setCategoryDefault('temperature');
    equal(sensors.catalog.temperature.header, automatic, 'without a choice the header is the collector\'s again');
    sensors.destroy();
});

test('the order the user gives the categories is saved with the catalog', async () => {
    let first = setup();
    await first.sensors.discover();
    let order = ['voltage', ...first.sensors.categories().map(([name]) => name).filter(name => name != 'voltage')];
    first.sensors.setCategoryOrder(order);
    await first.sensors.discover();
    first.sensors.destroy();

    let second = setup({configuration: first.configuration});
    equal(second.sensors.categories().sort(([, a], [, b]) => a.position - b.position).map(([name]) => name).join(', '),
        order.join(', '), 'kept across discovery and a restart');
    second.sensors.destroy();
});

test('panel links are shown, hidden and moved through Sensors, which saves them', async () => {
    let configuration = settings();
    let saved = readCatalog(configuration);
    // A device that is not plugged in is in the panel from an earlier session.
    saved.panel.sensors = [{category: 'voltage', key: 'unplugged/in0', visible: true}];
    writeCatalog(configuration, saved);
    let {sensors, find} = setup({configuration});
    let links = sensors.catalog.panel.sensors;
    let shown = () => links.filter(link => sensors.linkShown(link)).map(link => link.category + ' ' + link.sensor.key).join(', ');
    let link = (categoryName, key) => links.find(candidate => candidate.sensor == find(categoryName, key));
    await sensors.discover();
    equal(shown(), '', 'a link whose sensor is not on the machine is not shown');
    equal(links.length, 1, 'and keeps its place in the panel');
    for (let [categoryName, key] of [['memory', 'usage'], ['system', 'load-1m'], ['processor', 'usage']])
        sensors.setPanelSensorVisible(categoryName, find(categoryName, key), true);
    sensors.setPanelSensorVisible('system', find('system', 'load-1m'), false);
    equal(shown(), 'memory usage, processor usage', 'a hidden link is not shown; the same key in two categories is two sensors');
    sensors.setPanelSensorVisible('system', find('system', 'load-1m'), true);
    equal(shown(), 'memory usage, system load-1m, processor usage', 'a hidden link kept its place');
    sensors.movePanelLink(link('processor', 'usage'), link('memory', 'usage'));
    equal(shown(), 'processor usage, memory usage, system load-1m', 'moved in front of another link');
    sensors.movePanelLink(link('processor', 'usage'));
    equal(shown(), 'memory usage, system load-1m, processor usage', 'moved to the end');
    writeCategoryEnabled(configuration, 'memory', false);
    sensors.reloadEnabled();
    equal(shown(), 'system load-1m, processor usage', 'a sensor of a category that is switched off is not shown');
    equal(JSON.stringify(readCatalog(configuration).panel.sensors), JSON.stringify(
        links.map(({category, sensor, visible}) => ({category, key: sensor.key, visible}))), 'saved as category and key');
    sensors.destroy();
});

await runTests();
