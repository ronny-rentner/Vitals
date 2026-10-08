// Tests of how Sensors collects: which sources it reads, when, and which sensors it writes.
// They use made-up sources and sensors, so nothing here depends on a machine.
import {Sensors} from '../sensors.js';
import {counterRate} from '../helpers/sensorMath.js';
import {test, equal, mean, settings, runTests} from './harness.js';

// Builds what one test works on: a Sensors instance with a clock the test advances
// and cancellations whose state the test can read.
function setup() {
    let time = 1;
    let errors = [];
    let sensors = new Sensors(settings(), text => text);
    sensors.clock = () => time;
    sensors.createCancellation = () => ({cancelled: false, cancel() { this.cancelled = true; }});
    sensors.onError = (id, error) => errors.push([id, error]);
    // The made-up sensors live in the fan category, which has an average over its sensors. How the value of each
    // follows from its source's reading is made up as well, so the real rules for that are replaced.
    let category = sensors.catalog.fan;
    category.discovered = 1;
    let values = new Map();
    sensors._value = (categoryName, sensor, reading) => values.get(sensor)(reading);
    return {
        sensors, errors,
        // Adds a sensor that is on the machine and is read from the made-up source with this id.
        add(key, source, value) {
            let sensor = {key, file: source, status: 'pending', discovered: category.discovered};
            category.sensors.push(sensor);
            values.set(sensor, value);
            return sensor;
        },
        // Adds the average over the sensors of the category, as discovery does when there are two or more.
        addAverage() {
            let sensor = {key: 'average', aggregate: true, status: 'pending', discovered: category.discovered};
            category.sensors.push(sensor);
            return sensor;
        },
        // Takes a sensor off the machine, as a discovery run that does not find it does.
        retire(sensor) {
            sensor.discovered = category.discovered - 1;
        },
        // Marks the given sensors as on screen and every other one as not, as the renderer does.
        show(...shown) {
            for (let sensor of category.sensors)
                sensor.shown = shown.includes(sensor);
            sensors.shownChanged();
        },
        advance(seconds) { time += seconds; }
    };
}

function deferred() {
    let resolve, reject;
    let promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

test('nothing shown performs no reads; a source that two sensors come from is read once', async () => {
    let {sensors, add, show} = setup();
    let shared = {a: 2, b: 4};
    let reads = 0, unused = 0;
    sensors.addSource('shared', {read: async () => { reads++; return shared; }});
    sensors.addSource('unused', {read: async () => { unused++; return 100; }});
    let a = add('a', 'shared', s => s.value.a);
    let b = add('b', 'shared', s => s.value.b);
    add('unused-value', 'unused', s => s.value);
    await sensors.poll();
    equal(reads, 0);
    show(a, b);
    await sensors.poll();
    equal(reads, 1);
    equal(unused, 0);
    equal(a.value, shared.a);
    equal(b.value, shared.b);
    show();
    await sensors.poll();
    equal(reads, 1);
});

test('a shown average has every sensor of its category read, also those that are not shown', async () => {
    let {sensors, add, addAverage, show, advance} = setup();
    let temperature = 45.1, other = 55;
    sensors.addSource('temperature', {read: async () => temperature});
    sensors.addSource('other', {read: async () => other});
    let measured = add('temperature-value', 'temperature', s => s.value);
    add('other-value', 'other', s => s.value);
    let averageOfBoth = addAverage();
    show(averageOfBoth);
    await sensors.poll();
    equal(averageOfBoth.value, mean([temperature, other]));
    temperature = 45.9;
    advance(1);
    await sensors.poll();
    equal(measured.value, temperature);
    equal(averageOfBoth.value, mean([temperature, other]));
});

test('zero readings remain in calculations', async () => {
    let {sensors, add, addAverage, show} = setup();
    let zero = 0, other = 10;
    sensors.addSource('zero', {read: async () => zero});
    sensors.addSource('other', {read: async () => other});
    add('zero-value', 'zero', s => s.value);
    add('other-value', 'other', s => s.value);
    let averageOfBoth = addAverage();
    show(averageOfBoth);
    await sensors.poll();
    equal(averageOfBoth.value, mean([zero, other]));
});

test('first capture, reactivation and decreasing counters share the baseline path', async () => {
    let {sensors, add, show, advance} = setup();
    let counter = 0;
    let increase = 100, seconds = 2;
    sensors.addSource('counter', {read: async () => counter});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    show(rate);
    await sensors.poll();
    equal(rate.status, 'pending');
    counter += increase;
    advance(seconds);
    await sensors.poll();
    equal(rate.value, increase / seconds);
    show();
    equal(sensors.reading('counter').value, counter);
    // Reactivation discards the old baseline, however much the counter moved meanwhile.
    counter = 10000;
    advance(100);
    show(rate);
    await sensors.poll();
    equal(rate.status, 'pending');
    counter += increase;
    advance(seconds);
    await sensors.poll();
    equal(rate.value, increase / seconds);
    // A counter that went backwards starts a new baseline.
    counter = 5;
    advance(seconds);
    await sensors.poll();
    equal(rate.status, 'pending');
    counter += increase;
    advance(seconds);
    await sensors.poll();
    equal(rate.value, increase / seconds);
});

test('overlapping polls share in-flight reads', async () => {
    let {sensors, add, show} = setup();
    let result = deferred(), reads = 0;
    let reading = 12;
    sensors.addSource('source', {read: () => { reads++; return result.promise; }});
    let value = add('value', 'source', s => s.value);
    show(value);
    let first = sensors.poll(), second = sensors.poll();
    await Promise.resolve();
    equal(reads, 1);
    result.resolve(reading);
    await Promise.all([first, second]);
    equal(value.value, reading);
});

test('destroy prevents queued reads and stops owned sources', async () => {
    let {sensors, add, show} = setup();
    let reads = 0, starts = 0, stops = 0;
    sensors.addSource('source', {
        start: () => starts++, stop: () => stops++, read: async () => { reads++; return 1; }
    });
    show(add('value', 'source', s => s.value));
    let poll = sensors.poll();
    sensors.destroy();
    await poll;
    equal(starts, 1);
    equal(stops, 1);
    equal(reads, 0);
    equal(sensors.activeSources.size, 0);
});

test('source failure preserves measurements and marks dependent results unavailable', async () => {
    let {sensors, errors, add, show} = setup();
    let measurement = 9;
    let fail = false;
    sensors.addSource('source', {read: async () => {
        if (fail) throw new Error('read failed');
        return measurement;
    }});
    let value = add('value', 'source', s => s.value);
    show(value);
    await sensors.poll();
    fail = true;
    await sensors.poll();
    equal(value.status, 'unavailable');
    equal(value.value, measurement);
    equal(errors.length, 0, 'a failed read is not reported as an error');
    fail = false;
    await sensors.poll();
    equal(value.status, 'ready');
});

test('a finished source writes and publishes its own sensors, and the average follows when the last source is in', async () => {
    let {sensors, add, addAverage, show} = setup();
    let slow = deferred();
    let fastReading = 1, slowReading = 2;
    let computations = {fast: 0, slow: 0};
    let published = [];
    sensors.addSource('fast', {read: async () => fastReading});
    sensors.addSource('slow', {read: () => slow.promise});
    let fastValue = add('fast-value', 'fast', s => { computations.fast++; return s.value; });
    let slowValue = add('slow-value', 'slow', s => { computations.slow++; return s.value; });
    let averageOfBoth = addAverage();
    show(fastValue, slowValue, averageOfBoth);
    sensors.onValuesChanged = written => published.push([...written].map(sensor => sensor.key).join(','));
    computations.fast = computations.slow = 0;
    let done = sensors.poll();
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(fastValue.value, fastReading, 'the fast value does not wait for the slow source');
    equal(computations.fast, 1);
    equal(computations.slow, 0);
    equal(published.join(' | '), 'fast-value', 'only the fast value published');
    slow.resolve(slowReading);
    await done;
    equal(computations.fast, 1, 'the fast value is not computed again for the slow source');
    equal(computations.slow, 1);
    equal(published.join(' | '), 'fast-value | slow-value | average', 'then the slow value, then the average, once');
    equal(averageOfBoth.value, mean([fastReading, slowReading]));
});

test('source intervals and explicit refresh preserve history', async () => {
    let {sensors, add, show, advance} = setup(), reads = 0;
    let interval = 60;
    sensors.addSource('source', {interval, read: async () => ++reads});
    show(add('value', 'source', s => s.value));
    await sensors.poll();
    let firstReading = sensors.reading('source').value;
    advance(interval - 1);
    await sensors.poll();
    equal(reads, 1);
    await sensors.poll(true);
    equal(reads, 2);
    equal(sensors.reading('source').previous.value, firstReading);
});

test('a source is read once per interval, across reactivation and failure', async () => {
    let {sensors, add, show, advance} = setup();
    let interval = 60;
    let reads = 0, fail = false;
    sensors.addSource('source', {interval, read: async () => {
        reads++;
        if (fail) throw new Error('read failed');
        return reads;
    }});
    let value = add('value', 'source', s => s.value);
    show(value);
    await sensors.poll();
    equal(reads, 1);
    show();
    advance(interval / 2);
    show(value);
    equal(value.status, 'ready', 'reading kept across reactivation within the interval');
    await sensors.poll();
    equal(reads, 1, 'no read within the interval after reactivation');
    fail = true;
    advance(interval);
    await sensors.poll();
    equal(reads, 2, 'read again once the interval has passed');
    equal(value.status, 'unavailable');
    advance(interval / 2);
    await sensors.poll();
    equal(reads, 2, 'a failed read is not retried within the interval');
    fail = false;
    advance(interval);
    await sensors.poll();
    equal(reads, 3);
    equal(value.status, 'ready');
});

test('capture timestamps are independent of later publication', async () => {
    let {sensors, add, show, advance} = setup();
    let first = {time: 1, counter: 10}, second = {time: 3, counter: 30};
    let capture = first;
    sensors.addSource('source', {read: async () => capture, sampleTime: value => value.time});
    let rate = add('rate', 'source', s => counterRate(s, value => value.counter));
    show(rate);
    await sensors.poll();
    advance(100);
    capture = second;
    await sensors.poll();
    equal(rate.value, (second.counter - first.counter) / (second.time - first.time));
});

test('the sensors of a source can change during its read: one that is gone is not written, the others are', async () => {
    let {sensors, add, addAverage, retire, show} = setup();
    let first = {a: 1, b: 2}, second = {b: 4};
    let value = first;
    let parts = {
        a: add('a', 'source', s => s.value.a),
        b: add('b', 'source', s => s.value.b)
    };
    let averageOfParts = addAverage();
    // Like /proc/net/dev: the read finds out which parts exist and changes the catalog before it returns.
    sensors.addSource('source', {read: async () => {
        for (let [name, part] of Object.entries(parts)) {
            if (!(name in value))
                retire(part);
        }
        sensors.catalogChanged();
        return value;
    }});
    show(averageOfParts);
    await sensors.poll();
    equal(averageOfParts.value, mean([first.a, first.b]));
    value = second;
    await sensors.poll();
    equal(parts.a.value, first.a, 'a sensor that is gone is no longer written');
    equal(parts.b.value, second.b, 'the one that stays was read again');
    equal(averageOfParts.value, second.b);
});

await runTests();
