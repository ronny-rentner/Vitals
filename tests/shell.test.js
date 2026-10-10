import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {readCatalog, writeCategoryEnabled, sensorPresent} from '../helpers/storedCatalog.js';
import {equal} from './harness.js';

const CATEGORIES = ['temperature', 'voltage', 'fan', 'memory', 'processor', 'system', 'network', 'storage', 'battery', 'gpu'];

// Made-up sensors for the renderer to show. How the value of each follows from its source's reading is made up
// as well, so for these sensors the collector's own rules are replaced.
class Fixtures {
    constructor(sensors) {
        this._sensors = sensors;
        this._values = new Map();
        let realValue = sensors._value.bind(sensors);
        sensors._value = (categoryName, sensor, reading) =>
            this._values.has(sensor) ? this._values.get(sensor)(reading) : realValue(categoryName, sensor, reading);
    }

    // Takes every sensor off the machine, as a discovery run that finds nothing does, and empties the panel.
    // Returns the run's timestamp; a sensor added with it is on the machine.
    retireAll() {
        this.run = this._sensors._startRun();
        for (let [, category] of this._sensors.categories()) {
            category.discovered = this.run;
            category.header = undefined;
        }
        this._sensors.catalog.panel.sensors.length = 0;
    }

    // Takes one made-up sensor off the machine again.
    retire(sensor) {
        sensor.discovered = this.run - 1;
    }

    // Adds a sensor that is on the machine. `file` in its fields names the made-up source it is read from, and
    // `value` is how its value follows from that source's reading. A sensor without both follows the collector's rules.
    add(categoryName, fields, value) {
        let sensor = {status: 'pending', discovered: this.run, ...fields};
        this._sensors.catalog[categoryName].sensors.push(sensor);
        if (value)
            this._values.set(sensor, value);
        return sensor;
    }
}

// Pins or unpins a sensor the way a user does: a click on its row opens the panel with its actions, and the first
// of them pins or unpins.
function togglePin(button, sensor) {
    let row = button._rows.get(sensor);
    if (button._rowActions.sensor != sensor)
        row.activate();
    button._rowActions.items[0].activate();
    // Without the slide a user's click would give: the checks go on at once.
    button._closeRowActions();
}

function panelLink(sensors, sensor) {
    return sensors.catalog.panel.sensors.find(link => link.sensor == sensor);
}

async function waitFor(predicate, message) {
    let deadline = GLib.get_monotonic_time() + 10000000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error('Timed out: ' + message);
        await Scripting.sleep(50);
    }
}

async function checkPanelVisibility(button, fixtures) {
    let {counterRate} = await import('file://' + button._extensionObject.path + '/helpers/sensorMath.js');
    let sensors = button._sensors;
    let settings = button._settings;
    let failures = [];
    let checks = 0;
    let check = (actual, expected, message) => {
        checks++;
        if (actual !== expected) {
            let failure = message + ': expected ' + expected + ', got ' + actual;
            failures.push(failure);
            print('FAIL ' + failure);
        }
    };
    let originalClock = sensors.clock;
    let time = 1;
    sensors.clock = () => time;
    button.menu.close();
    for (let categoryName of CATEGORIES)
        writeCategoryEnabled(settings, categoryName, true);
    await button._discoverSensors();
    let item = sensor => button._panelItems.get(panelLink(sensors, sensor))?.item;
    let label = sensor => button._panelItems.get(panelLink(sensors, sensor))?.value;

    try {
        for (let [categoryName, format, rate, aggregate] of [
            ['temperature', 'temp', false, false], ['voltage', 'in', false, false],
            ['fan', 'fan', false, false], ['memory', 'memory', false, false],
            ['processor', 'percent', true, false], ['system', 'load', false, false],
            ['network', 'speed', true, false], ['storage', 'storage-rate', true, false],
            ['battery', 'watt', false, false], ['gpu', 'percent', false, false],
            ['temperature', 'temp', false, true]
        ]) {
            let name = categoryName + (aggregate ? ' aggregate' : '');
            let source = 'test:visibility:' + name;
            let value = 10;
            let release;
            let waiting = new Promise(resolve => { release = resolve; });
            sensors.addSource(source, {read: async () => {
                await waiting;
                return value;
            }});
            fixtures.retireAll();
            let sourceValue = rate ? s => counterRate(s, value => value) : s => s.value;
            let fixture;
            if (aggregate) {
                for (let part of ['a', 'b'])
                    fixtures.add(categoryName, {key: 'visibility/' + part, label: 'Visibility part ' + part, format, file: source}, sourceValue);
                // The collector's own average over the two parts.
                fixture = fixtures.add(categoryName, {key: 'average', label: 'Visibility aggregate', format, aggregate: true, section: 1});
            } else {
                fixture = fixtures.add(categoryName, {key: 'visibility/fixture', label: 'Visibility fixture', format, file: source}, sourceValue);
            }
            let category = sensors.catalog[categoryName];
            category.header = fixture;
            sensors.catalogChanged();
            let timer = button._refreshTimeoutId;
            togglePin(button, fixture);
            await Scripting.sleep(10);
            check(sensors.sources.get(source).pending, null, name + ' pinning does not collect');
            check(button._refreshTimeoutId, timer, name + ' pinning preserves timer');
            let poll = button._querySensors();
            check(item(fixture).visible, true, name + ' initial panel item');
            check(label(fixture).text, '…', name + ' initial placeholder');
            release();
            await poll;
            if (rate) {
                check(item(fixture).visible, true, name + ' first counter stays visible');
                check(label(fixture).text, '…', name + ' first counter is not a rate');
                time += settings.get_int('update-time');
                value += 60;
                await button._querySensors();
            }
            check(fixture.status, 'ready', name + ' valid reading');
            check(item(fixture).visible, true, name + ' nonzero panel item');
            let text = label(fixture).text;
            let panelItem = item(fixture);
            let otherCategory = categoryName == 'gpu' ? 'voltage' : 'gpu';
            for (let toggle = 0; toggle < 4; toggle++) {
                time += 0.1;
                writeCategoryEnabled(settings, otherCategory, toggle % 2 != 0);
                await sensors.discover();
                await Scripting.sleep(10);
                check(item(fixture) === panelItem, true, name + ' unrelated toggle preserves actor');
                check(item(fixture).visible, true, name + ' settled toggle stays visible');
                check(label(fixture).text, text, name + ' settled toggle preserves reading');
            }
            {
                for (let hideZeros of [true, false]) {
                    settings.set_boolean('hide-zeros', hideZeros);
                    for (let pendingRead of [false, true]) {
                        let scenario = name + ' rapid menu, hide-zeros=' + hideZeros + ', pending=' + pendingRead;
                        let hidden = 0;
                        let watchedItem = item(fixture);
                        let signal = watchedItem.connect('notify::visible', () => {
                            if (!watchedItem.visible) hidden++;
                        });
                        let sampleTime = sensors.reading(source).time;
                        text = label(fixture).text;
                        try {
                            for (let cycle = 0; cycle < 3; cycle++) {
                                time += 0.1;
                                if (pendingRead)
                                    waiting = new Promise(resolve => { release = resolve; });
                                button.menu.open();
                                button._groups[categoryName].menu.open();
                                if (pendingRead) await Scripting.sleep(10);
                                button.menu.close();
                                check(item(fixture).visible, true, scenario + ' visible on close ' + cycle);
                                if (pendingRead) release();
                                await Scripting.sleep(20);
                                await waitFor(() => !sensors.sources.get(source).pending, scenario + ' read completed');
                                check(item(fixture) === watchedItem, true, scenario + ' actor retained ' + cycle);
                                check(watchedItem.visible, true, scenario + ' visible after close ' + cycle);
                                check(label(fixture).text, text, scenario + ' reading retained ' + cycle);
                                check(sensors.reading(source).time, sampleTime,
                                    scenario + ' measurement interval preserved ' + cycle);
                                check(button._refreshTimeoutId, timer, scenario + ' shared timer retained ' + cycle);
                            }
                            check(hidden, 0, scenario + ' no transient hiding');
                        } finally {
                            watchedItem.disconnect(signal);
                            if (pendingRead) release();
                            button.menu.close();
                        }
                        time += settings.get_int('update-time');
                        value += 60;
                        await button._querySensors();
                        check(item(fixture).visible, true, scenario + ' scheduled update visible');
                        check(fixture.status, 'ready', scenario + ' scheduled update ready');
                    }
                }
                settings.set_boolean('hide-zeros', true);
                text = label(fixture).text;
            }
            waiting = new Promise(resolve => { release = resolve; });
            time += settings.get_int('update-time');
            value += 60;
            poll = button._querySensors();
            button._render();
            check(item(fixture).visible, true, name + ' pending update stays visible');
            check(label(fixture).text, text, name + ' pending update retains current text');
            settings.set_boolean('fixed-widths', !settings.get_boolean('fixed-widths'));
            check(item(fixture).visible, true, name + ' appearance change stays visible');
            check(label(fixture).text, text, name + ' appearance change retains current text');
            writeCategoryEnabled(settings, otherCategory, false);
            writeCategoryEnabled(settings, otherCategory, true);
            check(item(fixture).visible, true, name + ' category toggle stays visible');
            check(label(fixture).text, text, name + ' category toggle retains current text');
            check(sensors.activeSources.has(source), true, name + ' category toggle preserves collection');
            release();
            await poll;
            await button._discoverSensors();

            if (categoryName == 'network') {
                settings.set_boolean('fixed-widths', true);
                await Scripting.sleep(50);
                let initialWidth = label(fixture).width;
                time += 60;
                // 444 MB/s, which is wider than the few B/s before and after it.
                value += 444000000 * 60;
                await button._querySensors();
                await Scripting.sleep(50);
                let width = label(fixture).width;
                check(width > initialWidth, true, name + ' fixed width grows for longer text');
                time += 60;
                value += 60;
                await button._querySensors();
                await Scripting.sleep(50);
                check(label(fixture).width, width, name + ' fixed width survives shorter text');
                // A value that stays shorter gives the room back after a minute.
                let rendererClock = button._clock;
                let shortSince = rendererClock();
                let secondsShort = 0;
                button._clock = () => shortSince + secondsShort;
                secondsShort = 59;
                await button._querySensors();
                await Scripting.sleep(50);
                check(label(fixture).width, width, name + ' fixed width is kept while the text has been shorter for under a minute');
                secondsShort = 61;
                await button._querySensors();
                await Scripting.sleep(50);
                check(label(fixture).width < width, true, name + ' fixed width shrinks after a minute of shorter text');
                check(label(fixture).width, label(fixture).textWidth,
                    name + ' to the width of the text');
                button._clock = rendererClock;
                width = label(fixture).width;
                writeCategoryEnabled(settings, 'gpu', false);
                await sensors.discover();
                await Scripting.sleep(50);
                check(label(fixture).width, width, name + ' fixed width survives GPU toggle');
                writeCategoryEnabled(settings, 'gpu', true);
                await sensors.discover();
            }

            for (let zero of [false, true]) {
                time += settings.get_int('update-time');
                value = zero ? (rate ? value : 0) : value + 60;
                await button._querySensors();
                check(item(fixture).visible, true, name + ' measured zero=' + zero);
                waiting = new Promise(resolve => { release = resolve; });
                time += settings.get_int('update-time');
                if (rate && !zero) value += 60;
                poll = button._querySensors();
                button._render();
                check(item(fixture).visible, true, name + ' pending zero=' + zero + ' keeps visibility');
                release();
                await poll;
                waiting = new Promise(resolve => { release = resolve; });
                togglePin(button, fixture);
                check(item(fixture), undefined, name + ' unpinned zero=' + zero + ' has no panel item');
                time += 3600;
                togglePin(button, fixture);
                poll = button._querySensors();
                check(item(fixture).visible, true, name + ' resumed zero=' + zero + ' placeholder visible');
                check(label(fixture).text, '…', name + ' resumed zero=' + zero + ' discards stale display');
                value = zero ? (rate ? value : 0) : value + 60;
                release();
                await poll;
                if (rate) {
                    check(label(fixture).text, '…', name + ' resumed first counter');
                    time += settings.get_int('update-time');
                    if (!zero) value += 60;
                    await button._querySensors();
                }
                check(item(fixture).visible, true, name + ' fresh resumed zero=' + zero);
            }
            button.menu.open();
            await button._discoverSensors();
            time += settings.get_int('update-time');
            await button._querySensors();
            check(button._groups[categoryName]._statusLabel.visible, true, name + ' zero group header visible');
            check(button._groups[categoryName]._statusLabel.text,
                button._formatter.format(0, format, categoryName, categoryName + '/' + fixture.key).text,
                name + ' zero group header value');
            button.menu.close();
            settings.set_boolean('hide-zeros', false);
            check(item(fixture).visible, true, name + ' valid zero visible with temperature filtering disabled');
            settings.set_boolean('hide-zeros', true);
            time += settings.get_int('update-time');
            value = NaN;
            await button._querySensors();
            check(item(fixture).visible, false, name + ' unavailable hidden');
        }
    } finally {
        sensors.clock = originalClock;
    }
    print('Panel visibility: ' + checks + ' checks, ' + failures.length + ' failures');
    if (failures.length)
        throw new Error('Panel visibility regressions: ' + failures.length + ' failed checks');
}

export async function run() {
    // The Shell's helper process for automation scripts leaves by itself after half a minute, which is before this
    // test is done. Without this, the Shell tries to stop it at the end and ends with a failure.
    await Scripting.disableHelperAutoExit();
    await waitFor(() => Main.extensionManager.lookup('Vitals@CoreCoding.com'), 'extension registered');
    Main.extensionManager.enableExtension('Vitals@CoreCoding.com');
    await waitFor(() => Main.panel.statusArea.vitalsMenu, 'extension enabled');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 'overview hidden');
    let button = Main.panel.statusArea.vitalsMenu;
    let sensors = button._sensors;
    let settings = button._settings;
    settings.set_int('update-time', 60);
    settings.set_boolean('include-public-ip', false);
    // The checks look at a category right after it opened. The slide has its own part below.
    settings.set_boolean('animate-categories', false);
    for (let categoryName of CATEGORIES)
        writeCategoryEnabled(settings, categoryName, !['battery', 'gpu', 'fan'].includes(categoryName));
    settings.set_boolean('hide-zeros', true);
    settings.set_boolean('allow-panel-dragging', true);
    await button._discoverSensors();
    let find = (categoryName, key) => sensors.catalog[categoryName].sensors.find(sensor =>
        sensor.key == key && sensorPresent(sensors.catalog[categoryName], sensor));
    let savedPanel = () => readCatalog(settings).panel.sensors.map(link => link.category + ' ' + link.key).join(', ');
    equal(savedPanel(), 'memory usage, system load-1m, network device-rx', 'the panel a new user starts with');
    equal(sensors.catalog.panel.sensors.every(link => button._panelItems.has(link)), true,
        'every default panel sensor was found and has a top-bar item');

    sensors.catalog.panel.sensors.length = 0;
    let liveSensors = [['memory', 'usage'], ['storage', 'free'], ['system', 'uptime'], ['processor', 'usage'],
        ['storage', 'read-rate'], ['storage', 'write-rate']].map(([categoryName, key]) => {
        sensors.setPanelSensorVisible(categoryName, find(categoryName, key), true);
        return find(categoryName, key);
    });
    button._syncCatalog();
    await button._querySensors();
    await Scripting.sleep(50);
    await button._querySensors();
    for (let sensor of liveSensors)
        equal(sensor.status, 'ready', 'live ' + sensor.key);
    print('PASS real memory, storage space, storage rates, uptime and CPU readings');
    print('Discovered thermal zones: ' + sensors.catalog.temperature.sensors
        .filter(sensor => sensor.file?.startsWith('/sys/class/thermal/')).map(sensor => sensor.label).join(', '));

    button.menu.close();
    let discoveries = 0;
    let realDiscover = sensors.discover;
    sensors.discover = async () => { discoveries++; };
    let fixtures = new Fixtures(sensors);
    fixtures.retireAll();
    let a = 40, b = 0, reads = 0;
    sensors.addSource('test:a', {read: async () => { reads++; return a; }});
    sensors.addSource('test:b', {read: async () => { reads++; return b; }});
    let first = fixtures.add('temperature', {key: 'fixture/a', label: 'Fixture A', format: 'temp', file: 'test:a'}, s => s.value);
    let second = fixtures.add('temperature', {key: 'fixture/b', label: 'Fixture B', format: 'temp', file: 'test:b'}, s => s.value);
    // The collector's own average, minimum and maximum over the two made-up temperatures.
    sensors._discoverAggregates(fixtures.run);
    let temperature = sensors.catalog.temperature;
    temperature.header = sensors._chooseHeader('temperature');
    let average = find('temperature', 'average');
    equal(temperature.header, average, 'the temperature header shows the average');
    sensors.catalogChanged();
    equal(sensors.activeSources.size, 0, 'closed menu without pins');
    let timer = button._refreshTimeoutId;
    equal(timer !== null, true, 'shared timer remains active without demand');
    await button._querySensors();
    equal(reads, 0, 'idle tick performs no reads');

    button.menu.open();
    equal(discoveries, 1, 'opening the menu rediscovers');
    await button._discoverSensors();
    equal(reads, 0, 'opening and rediscovering do not collect');
    equal(button._refreshTimeoutId, timer, 'opening preserves shared timer');
    equal(button._groups.temperature._statusLabel.text, '…', 'new demand waits for tick');
    let discoveriesBeforeRefresh = discoveries;
    await button._refresh();
    equal(discoveries, discoveriesBeforeRefresh + 1, 'Refresh rediscovers');
    equal(reads > 0, true, 'Refresh reads values at once');
    equal(average.status, 'ready', 'Refresh does not wait for the next tick');
    equal(button._refreshTimeoutId, timer, 'Refresh preserves shared timer');
    await button._querySensors();
    equal(temperature.shown, true, 'the header of an open menu is marked as shown');
    equal(first.shown, false, 'a row in a collapsed category is not');
    equal(button._groups.temperature._statusLabel.text, '20°C', 'summary includes zero');
    button._groups.temperature.menu.open();
    await button._querySensors();
    equal(first.shown, true, 'a row in an open category is marked as shown');
    equal(button._rows.get(second).visible, true, 'accepted zero row visible');
    let captures = reads;
    settings.set_boolean('hide-zeros', false);
    equal(reads, captures, 'temperature option performs no immediate collection');
    equal(button._rows.get(second).visible, true, 'accepted zero remains visible');
    settings.set_boolean('hide-zeros', true);
    b = 20;
    await button._querySensors();
    equal(button._rows.get(second).visible, true, 'nonzero row returns');
    equal(button._rows.get(average).value, '30°C', 'average updated');
    captures = reads;
    settings.set_int('unit', 1);
    equal(reads, captures, 'format change performs no reads');
    equal(button._rows.get(first).value, '104°F', 'retained value reformatted');
    settings.set_int('unit', 0);
    equal(button._groups.temperature._statusLabel.text, '30°C', 'summary restored');
    a = NaN;
    await button._querySensors();
    equal(button._rows.get(first).visible, false, 'unavailable row hidden');
    equal(button._rows.get(average).visible, true, 'average uses available readings');
    equal(button._groups.temperature._statusLabel.visible, true, 'temperature group header remains visible');
    equal(button._groups.temperature._statusLabel.text, '20°C', 'temperature group header uses available readings');
    b = 0;
    await button._querySensors();
    equal(button._groups.temperature._statusLabel.visible, true, 'zero group header remains visible');
    equal(button._groups.temperature._statusLabel.text, '0°C', 'zero group header value');
    equal(button._rows.get(second).visible, true, 'accepted zero row still visible');
    b = 20;
    a = 40;
    await button._querySensors();
    equal(button._rows.get(first).visible, true, 'available row returns');
    // Without the "animate categories" option, every category opens and closes at once, a short one and one that
    // is long enough to need a scrollbar.
    let systemGroup = button._groups.system;
    for (let index = 0; index < 60; index++)
        fixtures.add('system', {key: 'fixture/' + index, label: 'Fixture ' + index, format: 'string', value: index, status: 'ready'});
    sensors.catalogChanged();
    let click = group => group.activate(Clutter.get_current_event());
    for (let [group, needsScrollbar] of [[button._groups.temperature, false], [systemGroup, true]]) {
        let submenu = group.menu;
        if (submenu.isOpen)
            click(group);
        click(group);
        equal(submenu.isOpen, true, 'a click opens the category');
        equal(submenu._needsScrollbar(), needsScrollbar, 'scrollbar needed');
        equal(submenu.actor.get_transition('height'), null, 'opening is not animated, scrollbar=' + needsScrollbar);
        click(group);
        equal(submenu.isOpen, false, 'a click closes it');
        equal(submenu.actor.get_transition('height'), null, 'closing is not animated, scrollbar=' + needsScrollbar);
        equal(submenu.actor.visible, false, 'and it is hidden at once');
    }
    // With the option, both kinds slide, and end at the height they have without it.
    let heightsWhile = async (submenu, act) => {
        let heights = [];
        // The height the category has on screen, which is not what it asks for while it slides.
        let painted = global.stage.connect('after-paint', () =>
            heights.push(submenu.actor.visible ? submenu.actor.get_allocation_box().get_height() : 0));
        act();
        await Scripting.sleep(600);
        global.stage.disconnect(painted);
        return heights;
    };
    for (let group of [button._groups.temperature, systemGroup]) {
        let submenu = group.menu;
        click(group);
        await Scripting.sleep(100);
        let openHeight = submenu.actor.get_allocation_box().get_height();
        click(group);
        settings.set_boolean('animate-categories', true);
        let opening = await heightsWhile(submenu, () => click(group));
        equal(new Set(opening).size > 3, true, 'the category slides open: ' + opening.length + ' frames');
        equal(Math.max(...opening) < openHeight + 1, true, 'and never gets a pixel taller than it is when open: ' + Math.max(...opening) + ' of ' + openHeight);
        equal(submenu.actor.get_allocation_box().get_height(), openHeight, 'it ends at its open height');
        let closing = await heightsWhile(submenu, () => click(group));
        equal(new Set(closing).size > 3, true, 'it slides shut');
        equal(Math.max(...closing) < openHeight + 1, true, 'and never gets a pixel taller than it was when open: ' + Math.max(...closing) + ' of ' + openHeight);
        equal(submenu.actor.visible, false, 'and is hidden at the end');
        settings.set_boolean('animate-categories', false);
    }
    // When a category opens while another one is open, that one slides shut at the same time, as in a menu of
    // GNOME Shell, and the one that opens still ends at its own height.
    let temperatureGroup = button._groups.temperature;
    let heightWhenOpen = new Map();
    for (let group of [temperatureGroup, systemGroup]) {
        click(group);
        await Scripting.sleep(100);
        heightWhenOpen.set(group, group.menu.actor.get_allocation_box().get_height());
        click(group);
    }
    settings.set_boolean('animate-categories', true);
    for (let [opened, other] of [[systemGroup, temperatureGroup], [temperatureGroup, systemGroup]]) {
        if (!other.menu.isOpen) {
            click(other);
            await Scripting.sleep(400);
        }
        let closing = await heightsWhile(other.menu, () => click(opened));
        equal(new Set(closing).size > 3, true, 'the category that was open slides shut while another one opens');
        equal(other.menu.actor.visible, false, 'and is hidden at the end');
        equal(opened.menu.actor.get_allocation_box().get_height(), heightWhenOpen.get(opened), 'the one that opened has its own height');
    }
    await Scripting.sleep(400);
    settings.set_boolean('animate-categories', false);
    click(button._groups.temperature);
    click(systemGroup);
    click(button._groups.temperature);
    equal(systemGroup.menu.isOpen, false, 'opening a category closes the one that was open');
    equal(button._groups.temperature.menu.isOpen, true);
    // The category that is open is still open when the menu is opened again.
    button.menu.close();
    // The Shell closes the submenus once the menu has faded out.
    await Scripting.sleep(600);
    button.menu.open();
    equal(button._groups.temperature.menu.isOpen, true, 'the open category is remembered while the menu is closed');
    equal(button._groups.temperature.menu.actor.visible, true, 'and its rows are there');
    equal(first.shown, true, 'and are read again');
    click(systemGroup);
    equal(button._groups.temperature.menu.isOpen, false, 'opening another category still closes it');
    click(button._groups.temperature);
    // The menu has one width, whatever its rows hold. A label that does not fit is shortened; the value never is.
    let shortened = label => label.get_clutter_text().get_layout().is_ellipsized();
    let menuWidth = button.menu.box.width;
    let longLabel = fixtures.add('temperature',
        {key: 'fixture/long', label: 'A temperature sensor with a label that is far too long for any menu', format: 'temp',
            file: 'test:a'}, s => s.value);
    sensors.catalogChanged();
    a = 1e15;
    await button._querySensors();
    await Scripting.sleep(100);
    let longRow = button._rows.get(longLabel);
    equal(button.menu.box.width, menuWidth, 'a long label and a long value do not widen the menu');
    equal(shortened(longRow._labelActor), true, 'the long label is shortened');
    equal(shortened(longRow._valueLabel), false, 'its value is shown in full');
    equal(shortened(button._rows.get(first)._labelActor), false, 'a label that fits is not shortened');
    a = 40;
    await button._querySensors();
    await Scripting.sleep(100);
    equal(button.menu.box.width, menuWidth, 'and short values do not narrow it');
    fixtures.retire(longLabel);
    sensors.catalogChanged();
    button.menu.close();
    button.menu.open();
    button._groups.temperature.menu.open();
    await button._querySensors();
    print('PASS menu demand, zero visibility, aggregates and formatting without new reads');

    // Count the top-bar items that the renderer creates and removes.
    let created = [], removed = [];
    let createPanelItem = button._createPanelItem, removePanelItem = button._removePanelItem;
    button._createPanelItem = function (link, ...rest) {
        created.push(link.sensor.key);
        return createPanelItem.call(this, link, ...rest);
    };
    button._removePanelItem = function (link) {
        removed.push(link.sensor.key);
        return removePanelItem.call(this, link);
    };
    togglePin(button, first);
    togglePin(button, second);
    equal(created.join(','), first.key + ',' + second.key, 'each pin creates one panel item');
    equal(removed.length, 0, 'pinning a second sensor leaves the first item alone');
    await button._querySensors();
    togglePin(button, first);
    equal(removed.join(','), first.key, 'unpinning removes that one panel item');
    equal(created.length, 2, 'unpinning creates nothing');
    togglePin(button, first);
    equal(created.join(','), [first.key, second.key, first.key].join(','), 'pinning again creates that one item');
    equal(removed.length, 1, 'pinning again removes nothing');
    button._createPanelItem = createPanelItem;
    button._removePanelItem = removePanelItem;
    equal(savedPanel(), 'temperature ' + first.key + ', temperature ' + second.key, 'hidden pin remembers position');
    captures = reads;
    button.menu.close();
    await Scripting.sleep(50);
    equal(reads, captures, 'closing menu does not query');
    equal([...sensors.activeSources.values()].flat().map(([, sensor]) => sensor.key).join(','), first.key + ',' + second.key,
        'with the menu closed only the pinned sensors are read');

    // The made-up interfaces that follow are not hardware, and those have rows only with this option off.
    settings.set_boolean('network-hardware-only', false);
    // Rows are created and destroyed one by one: count them while interfaces come and go.
    let rowsCreated = [];
    let addRow = button._addRow;
    button._addRow = function (categoryName, category, sensor) {
        rowsCreated.push(sensor.key);
        return addRow.call(this, categoryName, category, sensor);
    };
    let idle = {rx: 0, tx: 0};
    await sensors._rediscoverNetwork(new Map([['fixture0', idle]]));
    let fixtureDownload = find('network', 'fixture0/rx');
    equal(button._rows.has(fixtureDownload), true, 'new network row');
    let temperatureRow = button._rows.get(first);
    rowsCreated.length = 0;
    await sensors._rediscoverNetwork(new Map([['fixture0', idle], ['fixture1', idle]]));
    equal(rowsCreated.join(','), 'fixture1/rx,fixture1/tx', 'a new interface adds its own two rows and no other');
    equal(button._rows.get(first), temperatureRow, 'rows of other categories are left alone');
    await sensors._rediscoverNetwork(new Map([['fixture1', idle]]));
    equal(button._rows.has(fixtureDownload), false, 'disappeared network row removed');
    button._addRow = addRow;
    // The network menu from top to bottom: the label of each row, and a dash for the line between rows.
    let networkRowLabels = () => button._groups.network.menu._getMenuItems()
        .map(item => item instanceof PopupMenu.PopupSeparatorMenuItem ? '—' : item.label).join(', ');
    await sensors._rediscoverNetwork(new Map([['fixture0', idle], ['fixture1', idle], ['fixture2', idle]]));
    let rowsBefore = networkRowLabels();
    await sensors._rediscoverNetwork(new Map([['fixture0', idle], ['fixture2', idle]]));
    await sensors._rediscoverNetwork(new Map([['fixture0', idle], ['fixture1', idle], ['fixture2', idle]]));
    equal(networkRowLabels(), rowsBefore, 'a returning interface gets its rows back in the same place');
    // The average, minimum and maximum are below the temperatures, under a line, and an option leaves them out.
    let menuLabels = menu => menu._getMenuItems()
        .map(item => item instanceof PopupMenu.PopupSeparatorMenuItem ? '—' : item.label).join(', ');
    equal(menuLabels(button._groups.temperature.menu), 'Fixture A, Fixture B, —, Average, Maximum, Minimum',
        'sensors in alphabetical order, then a line, then the values computed over them');
    settings.set_boolean('include-aggregates', false);
    equal(menuLabels(button._groups.temperature.menu), 'Fixture A, Fixture B', 'the option removes those rows and the line');
    equal(temperature.header, average, 'the header still shows the average');
    settings.set_boolean('include-aggregates', true);
    equal(menuLabels(button._groups.temperature.menu), 'Fixture A, Fixture B, —, Average, Maximum, Minimum', 'and brings them back');
    // The categories are in the alphabetical order of their names.
    let categoryNames = button.menu._getMenuItems().filter(item => item instanceof PopupMenu.PopupSubMenuMenuItem).map(item => item.label.text);
    equal(categoryNames.join(', '), [...categoryNames].sort((a, b) => a.localeCompare(b)).join(', '), 'categories in alphabetical order');
    equal(categoryNames.includes('GPU') && categoryNames.includes('Temperature'), true, 'under the names the menu shows: ' + categoryNames);
    // The menu's sections: the machine's speeds first, the virtual interfaces last, below a line.
    let networkItems = button._groups.network.menu._getMenuItems();
    let separatorIndex = networkItems.findIndex(item => item instanceof PopupMenu.PopupSeparatorMenuItem);
    equal(networkItems[0].label, 'Download speed', 'the machine\'s download speed is the first network row');
    equal(separatorIndex > 0, true, 'there is a line in the network menu');
    equal(networkItems.slice(separatorIndex + 1).map(item => item.label).join(', '),
        ['fixture0', 'fixture1', 'fixture2'].flatMap(name => [name + ' download speed', name + ' upload speed']).join(', '),
        'below it are the virtual interfaces and nothing else');
    // A sensor that has a row gets another label and section, as when a newer version finds a saved sensor again.
    let renamed = find('network', 'combined');
    let renamedRow = button._rows.get(renamed);
    let volumeSection = find('network', 'boot-rx').section;
    renamed.label = 'Renamed total';
    renamed.section = volumeSection;
    sensors.catalogChanged();
    equal(button._rows.get(renamed), renamedRow, 'the row is kept');
    equal(renamedRow.label, 'Renamed total', 'and shows the new label');
    equal(networkRowLabels().includes('Downloaded this session, Renamed total, Uploaded since boot'), true,
        'in its new section, at its alphabetical place: ' + networkRowLabels());
    // A click on a row opens a panel with the sensor's actions under it, built like the menus in GNOME Shell's quick
    // settings: the sensor's name as its head, the actions below, and the rest of the menu dimmed. The actions pin
    // the sensor to the top bar, rename it in the panel's head, hide it, and make it the sensor its category
    // shows in its header.
    let labelsWithPanel = menu => menu._getMenuItems().map(item => {
        if (item instanceof PopupMenu.PopupSeparatorMenuItem) return '—';
        if (item instanceof PopupMenu.PopupMenuSection) {
            // The panel's first row is its head, with the sensor's name; the others are the actions.
            let [head, ...actions] = item._getMenuItems();
            return '[' + head.label + ': ' + actions.map(action => action.label).join(', ') + ']';
        }
        return item.label;
    }).join(', ');
    let temperatureMenu = button._groups.temperature.menu;
    button.menu.open();
    temperatureMenu.open();
    await Scripting.sleep(100);
    // The actions of a sensor without the first, in its panel, which a click on its row opens: Pin to category,
    // Rename and Hide.
    let actionsOf = sensor => {
        if (button._rowActions.sensor != sensor)
            button._rows.get(sensor).activate();
        return button._rowActions.items.slice(1);
    };
    equal(button._rowActions.items.length, 0, 'no panel is open');
    button._rows.get(first).activate();
    equal(labelsWithPanel(temperatureMenu).startsWith('Fixture A, [Fixture A: Pin to top bar, Pin to category, Rename, Hide], Fixture B'), true,
        'the panel is under its row, with the sensor\'s name and its actions: ' + labelsWithPanel(temperatureMenu));
    equal(button._rowActions.panel.actor.has_style_class_name('quick-toggle-menu'), true, 'it has the look of a quick settings menu');
    await Scripting.sleep(300);
    equal(button._rows.get(second).opacity < 255 && button._groups.memory.actor.opacity < 255, true,
        'the other rows and the other categories are dimmed');
    equal(button._rowActions.panel.actor.opacity, 255, 'and the panel is not');
    equal(button._rowActions.items[0].checked, true, 'the first action has a check mark, since the sensor is pinned');
    equal(button._rows.get(first).pinned, true, 'the row of a pinned sensor shows a check mark in front of its icon');
    button._rowActions.items[0].activate();
    equal(button._panelItems.has(panelLink(sensors, first)), false, 'the first action unpins');
    equal(button._rows.get(first).pinned, false, 'and the row loses its check mark');
    equal(button._rowActions.items[0].checked, false, 'and then has no check mark, with the panel still open');
    button._rowActions.items[0].activate();
    equal(button._panelItems.has(panelLink(sensors, first)), true, 'and pins again');
    button._rows.get(first).activate();
    equal(button._rowActions.items.length, 0, 'a second click on the row closes the panel');
    await Scripting.sleep(300);
    equal(button._rows.get(second).opacity == 255 && button._groups.memory.actor.opacity == 255, true, 'and nothing is dimmed any more');
    equal(labelsWithPanel(temperatureMenu).startsWith('Fixture A, Fixture B'), true, 'and the panel is gone: ' + labelsWithPanel(temperatureMenu));
    // In a category that is longer than the screen, the panel of its last row is scrolled into view.
    systemGroup.menu.open();
    await Scripting.sleep(100);
    let lastSystemRow = systemGroup.menu._getMenuItems().at(-1);
    let systemScrolling = systemGroup.menu.actor.vadjustment;
    let panelOnScreen = () => {
        let {y1, y2} = button._rowActions.panel.actor.get_allocation_box();
        return y1 >= systemScrolling.value && y2 <= systemScrolling.value + systemScrolling.page_size;
    };
    equal(systemScrolling.upper > systemScrolling.page_size, true, 'the system category scrolls');
    systemScrolling.value = systemScrolling.upper - systemScrolling.page_size;
    lastSystemRow.activate();
    await Scripting.sleep(300);
    equal(panelOnScreen(), true, 'the panel of the last row is on screen');
    lastSystemRow.activate();
    await Scripting.sleep(300);
    // A row that its new name moves to the far end of the category takes its panel along, which is scrolled into view.
    systemScrolling.value = 0;
    let firstSystemSensor = [...button._rows].find(([, row]) => row == systemGroup.menu._getMenuItems()[0])[0];
    actionsOf(firstSystemSensor)[1].activate();
    button._rowActions.header._labelEntry.text = 'zzz, the last by name';
    button._rowActions.header._labelEntry.clutter_text.emit('activate');
    await Scripting.sleep(300);
    equal(button._rowActions.sensor, firstSystemSensor, 'the panel of a renamed sensor stays open');
    equal(systemGroup.menu._getMenuItems().at(-1), button._rowActions.panel, 'at the row\'s new place');
    equal(panelOnScreen(), true, 'and is on screen');
    sensors.renameSensor(firstSystemSensor, '');
    button._closeRowActions();
    temperatureMenu.open();
    await Scripting.sleep(100);
    actionsOf(first)[1].activate();
    let nameField = button._rowActions.header._labelEntry;
    equal(nameField.text, 'Fixture A', 'Rename puts the name into a text field in the panel\'s head');
    // A row takes the keyboard, as the row under the pointer does; the field takes it back.
    button._rows.get(second).grab_key_focus();
    equal(global.stage.key_focus, nameField.clutter_text, 'the text field keeps the keyboard');
    nameField.text = 'Zone';
    nameField.clutter_text.emit('activate');
    equal(first.customLabel, 'Zone', 'Enter renames the sensor');
    equal(labelsWithPanel(temperatureMenu).startsWith('Fixture B, Zone, [Zone: Pin to top bar, Pin to category, Rename, Hide]'), true,
        'the row shows the new name, is sorted by it, and its panel is still open under it: ' + labelsWithPanel(temperatureMenu));
    actionsOf(first)[1].activate();
    equal(button._rowActions.header._labelEntry.text, 'Zone', 'renaming again starts from the name the user gave');
    button._rowActions.header._renameRestore.emit('clicked', 0);
    equal(first.customLabel, undefined, 'the button next to the field gives the sensor its own name back');
    equal(button._rows.get(first).label, 'Fixture A', 'and the row shows it');
    equal(button._rowActions.header.editing, false, 'and the renaming is over');
    sensors.renameSensor(first, 'Zone');
    actionsOf(first)[1].activate();
    button._rowActions.header._labelEntry.text = '';
    button._rowActions.header._labelEntry.clutter_text.emit('activate');
    equal(first.customLabel, undefined, 'an emptied name does the same');
    actionsOf(second)[0].activate();
    equal(temperature.header, second, 'Pin to category makes it the header\'s sensor');
    equal(button._rows.get(second).categoryDefault, true, 'and its row shows a star after its name');
    equal(button._rowActions.sensor, second, 'the panel stays open');
    equal(actionsOf(second)[0].checked, true, 'and the action has a check mark, and undoes it');
    actionsOf(second)[0].activate();
    equal(actionsOf(second)[0].checked, false, 'after which the check mark is gone');
    equal(temperature.header, average, 'the header is the average again');
    equal(button._rows.get(second).categoryDefault, false, 'and its star is gone');
    equal(button._rows.get(average).categoryDefault, true, 'the star is on the average, which the extension chose for the header');
    actionsOf(first)[2].activate();
    equal(button._rows.has(first), false, 'Hide removes the row');
    equal(button._rowActions.items.length, 0, 'and its panel with it');
    // The fourth button at the bottom of the menu stays pressed in, and while it is, the hidden sensors of all
    // categories are in the menu, marked.
    equal(button._hiddenButton.accessible_name, 'Show hidden sensors', 'the button has its name for a screen reader');
    let pressHiddenButton = () => {
        button._hiddenButton.checked = !button._hiddenButton.checked;
        button._hiddenButton.emit('clicked', 0);
    };
    let hiddenInSystem = [...button._rows.keys()].find(sensor => sensors.catalog.system.sensors.includes(sensor));
    sensors.setSensorHidden(hiddenInSystem, true);
    pressHiddenButton();
    equal(button._rows.get(first)?.hidden, true, 'pressed in, it shows the hidden sensor, marked as hidden');
    equal(button._rows.get(hiddenInSystem)?.hidden, true, 'and the hidden sensor of another category');
    equal(button._rows.get(second).hidden, false, 'the others are not marked');
    pressHiddenButton();
    equal(button._rows.has(first) || button._rows.has(hiddenInSystem), false, 'released, the hidden sensors are out again');
    pressHiddenButton();
    sensors.setSensorHidden(hiddenInSystem, false);
    equal(actionsOf(first)[2].checked, true, 'in the panel of a hidden sensor, Hide has a check mark');
    actionsOf(first)[2].activate();
    equal(first.hidden, undefined, 'and brings the sensor back');
    equal(button._rows.get(first).hidden, false, 'its row is no longer marked');
    equal(button._rowActions.sensor, first, 'its panel stays open');
    pressHiddenButton();
    button._closeRowActions();
    button.menu.close();
    // A category that is dropped onto another one takes its place, and its rows go with it.
    let categoriesInMenu = () => button.menu._getMenuItems().filter(item => item instanceof PopupMenu.PopupSubMenuMenuItem);
    let orderBefore = categoriesInMenu();
    let lastCategory = orderBefore.at(-1), firstCategory = orderBefore[0];
    equal(firstCategory.handleDragOver(lastCategory) == firstCategory.handleDragOver(firstCategory), false,
        'a category takes the drop of another category, not of itself');
    equal(firstCategory.acceptDrop(lastCategory), true, 'the drop is taken');
    equal(categoriesInMenu().indexOf(lastCategory), 0, 'the dropped category is where the other one was');
    equal(categoriesInMenu().indexOf(firstCategory), 1, 'which moved on by one');
    let menuActors = button.menu.box.get_children();
    equal(menuActors.indexOf(lastCategory.menu.actor), menuActors.indexOf(lastCategory) + 1, 'its rows are right below it');
    equal(sensors.categories().filter(([, category]) => category.position === undefined).length, 0, 'every category has its position saved');
    orderBefore.at(-2).acceptDrop(lastCategory);
    equal(categoriesInMenu().map(category => category.label.text).join(', '), orderBefore.map(category => category.label.text).join(', '),
        'dropped onto the one that is last now, it is the last again and the order is as before');
    // In the alphabetical category order the categories are sorted by name and cannot be dragged; back in the manual
    // one they are as arranged. Both take effect at once: the categories are built again, with their rows.
    let rowCountBeforeRebuild = button._rows.size;
    let names = () => categoriesInMenu().map(category => category.label.text);
    firstCategory.acceptDrop(lastCategory);
    let arrangedNames = names().join(', ');
    settings.set_int('category-order', 0);
    equal(names().join(', '), [...names()].sort((a, b) => a.localeCompare(b)).join(', '), 'alphabetical: ' + names());
    equal(names().join(', ') == arrangedNames, false, 'which is not how they were arranged');
    equal(button._rows.size, rowCountBeforeRebuild, 'with all their rows');
    settings.set_int('category-order', 1);
    equal(names().join(', '), arrangedNames, 'manual again, they are as arranged');
    categoriesInMenu().at(-1).acceptDrop(categoriesInMenu()[0]);
    settings.reset('category-order');
    systemGroup = button._groups.system;
    // The made-up interfaces are not hardware. With the option on they have no rows; the totals keep theirs.
    let fixtureUpload = find('network', 'fixture0/tx');
    let networkTotal = find('network', 'device-rx');
    settings.set_boolean('network-hardware-only', true);
    equal(button._rows.has(fixtureUpload), false, 'the option removes the rows of interfaces that are not hardware');
    equal(button._rows.has(networkTotal), true, 'and leaves the other network rows');
    equal(button._groups.network.menu._getMenuItems().some(item => item instanceof PopupMenu.PopupSeparatorMenuItem), false,
        'the line goes with them');
    settings.set_boolean('network-hardware-only', false);
    equal(button._rows.has(fixtureUpload), true, 'switching it off brings the rows back');
    await sensors._rediscoverNetwork(new Map());
    settings.reset('network-hardware-only');
    print('PASS pin visibility, saved position, single-row updates, interface removal and no query on menu close');

    await Scripting.sleep(250);
    let source = button._panelItems.get(panelLink(sensors, first)).item;
    let target = button._panelItems.get(panelLink(sensors, second)).item;
    let [sourceX, sourceY] = source.get_transformed_position();
    let [targetX] = target.get_transformed_position();
    let pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    let move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    let y = sourceY + source.height / 2;
    // Leave the hot-corner barriers before moving onto the panel.
    move(sourceX + source.width / 2, 100);
    await Scripting.sleep(100);
    move(sourceX + source.width / 2, y);
    await Scripting.sleep(100);
    equal(global.get_pointer()[0], Math.trunc(sourceX + source.width / 2), 'pointer over sensor');
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await Scripting.sleep(100);
    move(sourceX + source.width / 2 + 30, y + 12);
    await waitFor(() => button._dragging, 'drag began');
    equal(button._refreshTimeoutId, timer, 'drag preserves shared timer');
    captures = reads;
    let firstLabel = button._panelItems.get(panelLink(sensors, first)).value;
    let previousText = firstLabel.text;
    // Every text the label shows from here on.
    let textsShown = [];
    // The value is a number and a unit; either can change.
    for (let part of firstLabel.get_children())
        part.connectObject('notify::text', () => textsShown.push(firstLabel.text), firstLabel);
    a = 50;
    await button._querySensors();
    equal(reads > captures, true, 'collection goes on during a drag');
    equal(first.value, a, 'the reading is current');
    equal(firstLabel.text, previousText, 'the display holds still during a drag');
    move(targetX + target.width - 2, y);
    await Scripting.sleep(100);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await waitFor(() => !button._dragging, 'drag ended');
    equal(button._refreshTimeoutId, timer, 'drop preserves shared timer');
    equal(savedPanel(), 'temperature ' + second.key + ', temperature ' + first.key, 'drop changed saved order');
    equal(firstLabel.text, '50°C', 'the drop shows the current reading at once, without waiting for a tick');
    for (let part of firstLabel.get_children())
        part.disconnectObject(firstLabel);
    equal(textsShown.at(-1), '50°C', 'the label ends with the current value');
    equal(textsShown.includes('…'), false, 'the values never give way to "…"');
    pointer.run_dispose();
    print('PASS actual panel drag: display held still, readings current at the drop');

    // The menu opens with its middle under the pointer when the pointer is on the Vitals item, and under the
    // middle of the item otherwise.
    let mouse = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    let [itemX, itemY] = button.get_transformed_position();
    let menuMiddle = () => {
        let menuBox = button.menu.box;
        return menuBox.get_transformed_position()[0] + menuBox.width / 2;
    };
    // The item's width changes with its values, so its middle is taken when it is needed.
    let itemMiddle = () => button.get_transformed_position()[0] + button.width / 2;
    let pointerX = Math.round(itemX + button.width / 4);
    mouse.notify_absolute_motion(GLib.get_monotonic_time(), pointerX, 100);
    await Scripting.sleep(100);
    mouse.notify_absolute_motion(GLib.get_monotonic_time(), pointerX, itemY + button.height / 2);
    await Scripting.sleep(100);
    equal(global.get_pointer()[0], pointerX, 'pointer on the item, left of its middle');
    button.menu.open();
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - pointerX) <= 1, true, 'the menu\'s middle is under the pointer: ' + menuMiddle() + ' / ' + pointerX);
    // The item gets wider with a long value; the open menu stays where it is.
    let itemWidth = button.width;
    a = 1e15;
    await button._querySensors();
    await Scripting.sleep(300);
    equal(button.width > itemWidth, true, 'the item got wider');
    equal(Math.abs(menuMiddle() - pointerX) <= 1, true, 'the open menu did not move: ' + menuMiddle() + ' / ' + pointerX);
    a = 50;
    await button._querySensors();
    button.menu.close();
    await Scripting.sleep(400);
    settings.set_boolean('menu-centered', true);
    button.menu.open();
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - itemMiddle()) <= 1, true, 'with the option, under the middle of the item');
    button.menu.close();
    await Scripting.sleep(400);
    settings.reset('menu-centered');
    mouse.notify_absolute_motion(GLib.get_monotonic_time(), pointerX, 300);
    await Scripting.sleep(100);
    button.menu.open();
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - itemMiddle()) <= 1, true, 'with the pointer elsewhere, under the middle of the item');
    button.menu.close();
    await Scripting.sleep(400);
    mouse.run_dispose();
    print('PASS menu placement under the pointer');

    // The "emphasize values" option: lighter, smaller icons and units, or everything as strong as the numbers.
    let look = () => {
        let {item, value} = button._panelItems.get(panelLink(sensors, first));
        let [number, unit] = value.get_children();
        return {
            iconOpacity: item.get_first_child().opacity, iconSize: item.get_first_child().get_theme_node().get_length('icon-size'),
            unitOpacity: unit.opacity, unitSize: unit.get_theme_node().get_font().get_size(),
            numberSize: number.get_theme_node().get_font().get_size(), text: value.text
        };
    };
    await Scripting.sleep(100);
    let emphasized = look();
    equal(emphasized.iconOpacity < 255 && emphasized.unitOpacity < 255, true, 'by default, icons and units are lighter');
    equal(emphasized.unitSize < emphasized.numberSize, true, 'and the unit is smaller than the number');
    settings.set_boolean('emphasize-values', false);
    await Scripting.sleep(100);
    let plain = look();
    equal(plain.iconOpacity == 255 && plain.unitOpacity == 255, true, 'with the option off, icons and units are full strength');
    equal(plain.unitSize, plain.numberSize, 'the unit is as large as the number');
    equal(plain.iconSize > emphasized.iconSize, true, 'and the icon has the size of the Shell\'s status icons');
    equal(plain.text, emphasized.text, 'the text is the same either way');
    settings.reset('emphasize-values');
    await Scripting.sleep(100);
    print('PASS emphasize values option');

    await checkPanelVisibility(button, fixtures);

    await button._extensionObject.openPreferences();
    await waitFor(() => global.get_window_actors().some(actor =>
        actor.meta_window.get_title()?.includes('Vitals')), 'preferences window');
    let preferences = global.get_window_actors().find(actor => actor.meta_window.get_title()?.includes('Vitals'));
    preferences.meta_window.delete(global.get_current_time());
    print('PASS preferences opened in nested Shell');

    // Back to the real machine, with one sensor in the panel that has a reading.
    sensors.discover = realDiscover;
    sensors.catalog.panel.sensors.length = 0;
    await button._discoverSensors();
    let memoryUsage = find('memory', 'usage');
    sensors.setPanelSensorVisible('memory', memoryUsage, true);
    button._syncCatalog();
    await button._querySensors();
    equal(memoryUsage.status, 'ready', 'memory usage read before the extension stops');

    Main.extensionManager.disableExtension('Vitals@CoreCoding.com');
    await waitFor(() => !Main.panel.statusArea.vitalsMenu, 'extension disabled');
    equal(sensors.destroyed, true, 'collector destroyed');
    equal(sensors.activeSources.size, 0, 'disable stops sources');
    equal(button._refreshTimeoutId, null, 'disable removes timer');
    equal(readCatalog(settings).memory.sensors.find(sensor => sensor.key == 'usage').value, memoryUsage.value,
        'the readings are saved when the extension stops');
    Main.extensionManager.enableExtension('Vitals@CoreCoding.com');
    await waitFor(() => Main.panel.statusArea.vitalsMenu, 'extension re-enabled');
    let restarted = Main.panel.statusArea.vitalsMenu;
    let restoredLink = restarted._sensors.catalog.panel.sensors[0];
    equal(restoredLink.sensor.value, memoryUsage.value, 'the saved reading is there at once after the start');
    // The next tick is a minute away; the first reading must not wait for it.
    await waitFor(() => restoredLink.sensor.status == 'ready', 'a first reading right after the start');
    equal(restarted._panelItems.get(restoredLink).value.text.endsWith('%'), true, 'and the top bar shows it');
    print('PASS extension disable cleanup, saved readings and re-enable');
    settings.reset('animate-categories');
    print('Vitals Shell checks passed');
}
