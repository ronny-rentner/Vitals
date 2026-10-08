// Tests of how Sensors collects: which sources it reads, when, and what it recomputes.
// They use made-up sources and sensors, so nothing here depends on a machine.
import {Sensors} from '../sensors.js';
import {average, sum, counterRate} from '../helpers/sensorMath.js';
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
    // The made-up sensors live in one category. Where the value of each comes from is made up as well, so the
    // real rules for that are replaced.
    let category = sensors.catalog.system;
    category.discovered = 1;
    let definitions = new Map();
    sensors._definition = (categoryName, sensor) => definitions.get(sensor);
    return {
        sensors, errors,
        // Adds a sensor that is on the machine. Its inputs are source ids or other sensors.
        add(key, inputs, compute) {
            let sensor = {key, status: 'pending', discovered: category.discovered};
            category.sensors.push(sensor);
            definitions.set(sensor, {inputs, compute});
            return sensor;
        },
        redefine(sensor, inputs, compute) {
            definitions.set(sensor, {inputs, compute});
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

test('nothing shown performs no reads; shared and transitive inputs are read once', async () => {
    let {sensors, add, show} = setup();
    let shared = {a: 2, b: 4};
    let reads = 0, unused = 0;
    sensors.addSource('shared', {read: async () => { reads++; return shared; }});
    sensors.addSource('unused', {read: async () => { unused++; return 100; }});
    let a = add('a', ['shared'], ([s]) => s.value.a);
    let b = add('b', ['shared'], ([s]) => s.value.b);
    let averageOfBoth = add('average', [a, b], average);
    let twice = add('twice', [averageOfBoth], ([s]) => s.value * 2);
    add('unused-value', ['unused'], ([s]) => s.value);
    await sensors.poll();
    equal(reads, 0);
    show(a, twice);
    await sensors.poll();
    equal(reads, 1);
    equal(unused, 0);
    equal(twice.value, mean([shared.a, shared.b]) * 2);
    show();
    await sensors.poll();
    equal(reads, 1);
    equal(a.value, shared.a);
});

test('raw changes update aggregates even when displayed strings stay equal', async () => {
    let {sensors, add, show, advance} = setup();
    let temperature = 45.1, other = 55;
    sensors.addSource('temperature', {read: async () => temperature});
    let measured = add('temperature-value', ['temperature'], ([s]) => s.value);
    let constant = add('other', [], () => other);
    let averageOfBoth = add('average', [measured, constant], average);
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
    let {add, show} = setup();
    let zero = 0, other = 10;
    let averageOfBoth = add('average', [add('zero', [], () => zero), add('other', [], () => other)], average);
    show(averageOfBoth);
    equal(averageOfBoth.value, mean([zero, other]));
});

test('first capture, reactivation and decreasing counters share the baseline path', async () => {
    let {sensors, add, show, advance} = setup();
    let counter = 0;
    let increase = 100, seconds = 2;
    sensors.addSource('counter', {read: async () => counter});
    let rate = add('rate', ['counter'], ([s]) => counterRate(s, value => value));
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
    let value = add('value', ['source'], ([s]) => s.value);
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
    show(add('value', ['source'], ([s]) => s.value));
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
    let value = add('value', ['source'], ([s]) => s.value);
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

test('independent sources publish without waiting for unrelated slow reads', async () => {
    let {sensors, add, show} = setup();
    let slow = deferred();
    let fastReading = 1, slowReading = 2;
    sensors.addSource('fast', {read: async () => fastReading});
    sensors.addSource('slow', {read: () => slow.promise});
    let fastValue = add('fast-value', ['fast'], ([s]) => s.value);
    let slowValue = add('slow-value', ['slow'], ([s]) => s.value);
    let both = add('sum', [fastValue, slowValue], sum);
    show(fastValue, both);
    let done = sensors.poll();
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(fastValue.value, fastReading);
    slow.resolve(slowReading);
    await done;
    equal(both.value, fastReading + slowReading);
});

test('a finished source recomputes and publishes only the sensors that depend on it', async () => {
    let {sensors, add, show} = setup();
    let slow = deferred();
    let fastReading = 1, slowReading = 2;
    let computations = {fast: 0, slow: 0, both: 0};
    let published = [];
    sensors.addSource('fast', {read: async () => fastReading});
    sensors.addSource('slow', {read: () => slow.promise});
    let fastValue = add('fast-value', ['fast'], ([s]) => { computations.fast++; return s.value; });
    let slowValue = add('slow-value', ['slow'], ([s]) => { computations.slow++; return s.value; });
    let both = add('both', [fastValue, slowValue], samples => { computations.both++; return sum(samples); });
    show(fastValue, slowValue, both);
    sensors.onValuesChanged = recomputed => published.push([...recomputed].map(sensor => sensor.key).join(','));
    let done = sensors.poll();
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(computations.fast, 1, 'fast value computed when its source finished');
    equal(computations.slow + computations.both, 0, 'values behind the slow source wait for it');
    equal(published.join(' | '), 'fast-value', 'only the fast value published');
    slow.resolve(slowReading);
    await done;
    equal(computations.fast, 1, 'fast value not recomputed for the slow source');
    equal(computations.slow, 1);
    equal(computations.both, 1, 'value with both inputs computed once, when the last one arrived');
    equal(published.join(' | '), 'fast-value | slow-value,both', 'then only the values behind the slow source');
    equal(both.value, fastReading + slowReading);
});

test('source intervals and explicit refresh preserve history', async () => {
    let {sensors, add, show, advance} = setup(), reads = 0;
    let interval = 60;
    sensors.addSource('source', {interval, read: async () => ++reads});
    show(add('value', ['source'], ([s]) => s.value));
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
    let value = add('value', ['source'], ([s]) => s.value);
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
    let rate = add('rate', ['source'], ([s]) => counterRate(s, value => value.counter));
    show(rate);
    await sensors.poll();
    advance(100);
    capture = second;
    await sensors.poll();
    equal(rate.value, (second.counter - first.counter) / (second.time - first.time));
});

test('the sensors behind a total can change during a read without resetting the ones that stay', async () => {
    let {sensors, add, redefine, retire, show} = setup();
    let first = {a: 1, b: 2}, second = {b: 4};
    let value = first;
    let parts = {
        a: add('a', ['source'], ([s]) => s.value.a),
        b: add('b', ['source'], ([s]) => s.value.b)
    };
    let total = add('sum', ['source', parts.a, parts.b], samples => sum(samples.slice(1)));
    // Like /proc/net/dev: the read finds out which parts exist and changes the catalog before it returns.
    sensors.addSource('source', {read: async () => {
        for (let [name, part] of Object.entries(parts)) {
            if (!(name in value))
                retire(part);
        }
        redefine(total, ['source', ...Object.keys(value).map(name => parts[name])], samples => sum(samples.slice(1)));
        sensors.catalogChanged();
        return value;
    }});
    show(total);
    await sensors.poll();
    equal(total.value, first.a + first.b);
    value = second;
    await sensors.poll();
    equal(sensors.active.has(parts.a), false, 'a sensor that is gone is no longer computed');
    equal(parts.b.value, second.b, 'the one that stays was read again');
    equal(total.value, second.b);
});

await runTests();
