// Tests of how Sensors collects: which sources it reads, when, and which sensors it writes.
// They use made-up sources and sensors, so nothing here depends on a machine.
import {Sensors} from '../sensors.js';
import {counterRate, PENDING} from '../helpers/sensorMath.js';
import {test, equal, mean, settings, runTests} from './harness.js';

// Builds what one test works on: a Sensors instance with a clock the test advances
// and cancellations whose state the test can read.
function setup() {
    let time = 1;
    let errors = [];
    let sensors = new Sensors(settings(), text => text);
    sensors.clock = () => time;
    sensors.createCancellation = () => ({cancelled: false, cancel() { this.cancelled = true; }});
    // What the collector has scheduled for later. The test lets the time pass and runs it.
    let scheduled = [];
    sensors.schedule = (seconds, callback) => {
        let entry = {seconds, callback, due: time + seconds};
        scheduled.push(entry);
        return entry;
    };
    sensors.unschedule = entry => {
        if (!scheduled.includes(entry))
            throw new Error('Called off what is not scheduled');
        scheduled.splice(scheduled.indexOf(entry), 1);
    };
    sensors.onError = (id, error) => errors.push([id, error]);
    // The made-up sensors live in the fan category, which has an average over its sensors. How the value of each
    // follows from its source's reading is made up as well, so the real rules for that are replaced.
    let category = sensors.catalog.fan;
    category.discovered = 1;
    let values = new Map();
    sensors._value = (categoryName, sensor, reading) => values.get(sensor)(reading);
    return {
        sensors, errors, scheduled,
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
        // Lets the time pass and runs what was scheduled for a moment that has come.
        advance(seconds) {
            time += seconds;
            for (let entry of scheduled.filter(candidate => candidate.due <= time)) {
                scheduled.splice(scheduled.indexOf(entry), 1);
                entry.callback();
            }
        }
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

test('what comes on screen is read at once, without a tick, and nothing else is read with it', async () => {
    let {sensors, add, show, advance} = setup();
    let interval = 60;
    let reads = {first: 0, second: 0, slow: 0};
    sensors.addSource('first', {read: async () => ++reads.first});
    sensors.addSource('second', {read: async () => ++reads.second});
    sensors.addSource('slow', {interval, read: async () => ++reads.slow});
    let firstValue = add('first-value', 'first', s => s.value);
    let secondValue = add('second-value', 'second', s => s.value);
    let slowValue = add('slow-value', 'slow', s => s.value);
    let readsFinished = () => new Promise(resolve => setTimeout(resolve, 0));

    show(firstValue, slowValue);
    await readsFinished();
    equal(firstValue.status, 'ready', 'a sensor that comes on screen has its value before any tick');
    equal(slowValue.status, 'ready');
    equal(reads.second, 0, 'a source nobody shows is not read');

    show(firstValue, slowValue, secondValue);
    await readsFinished();
    equal(secondValue.status, 'ready');
    equal(reads.first, 1, 'a source that was on screen already is not read again');

    show(firstValue, secondValue);
    advance(interval / 2);
    show(firstValue, secondValue, slowValue);
    await readsFinished();
    equal(reads.slow, 1, 'a source that comes back inside its interval is not asked');
    equal(slowValue.status, 'ready', 'and shows the reading it has');

    show(firstValue, secondValue);
    advance(interval);
    show(firstValue, secondValue, slowValue);
    await readsFinished();
    equal(reads.slow, 2, 'one that comes back after its interval is asked at once');
});

test('a rate that comes on screen has its value a second later, without a tick', async () => {
    let {sensors, add, show, advance, scheduled} = setup();
    let counter = 1000, counterReads = 0, plainReads = 0;
    let counted = 300;
    sensors.addSource('counter', {read: async () => { counterReads++; return counter; }});
    sensors.addSource('plain', {read: async () => { plainReads++; return 7; }});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    let plainValue = add('plain-value', 'plain', s => s.value);
    let readsFinished = () => new Promise(resolve => setTimeout(resolve, 0));

    show(rate, plainValue);
    await readsFinished();
    equal(rate.status, 'pending', 'one reading gives no rate');
    equal(scheduled.length, 1, 'a second reading is scheduled for the rate, none for the value that has its reading');
    let secondsUntilSecondReading = scheduled[0].seconds;
    counter += counted;
    advance(secondsUntilSecondReading);
    await readsFinished();
    equal(rate.value, counted / secondsUntilSecondReading, 'the second reading gives the rate over the time since the first');
    equal(plainReads, 1, 'the other source is not read again');
    equal(scheduled.length, 0, 'and nothing further is scheduled');

    show(plainValue);
    show(rate, plainValue);
    await readsFinished();
    equal(scheduled.length, 1, 'back on screen, the rate starts over');
    show(plainValue);
    equal(scheduled.length, 0, 'a second reading is called off when its source leaves the screen');
    equal(counterReads, 3);
});

test('a tick that is first to give the rate calls the second reading off', async () => {
    let {sensors, add, show, advance, scheduled} = setup();
    let counter = 0, reads = 0;
    let counted = 70, momentAfterShowing = 0.1, secondsToTick = 0.6;
    sensors.addSource('counter', {read: async () => { reads++; return counter; }});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    show(rate);
    await new Promise(resolve => setTimeout(resolve, 0));
    advance(momentAfterShowing);
    await sensors.poll();
    equal(rate.status, 'pending');
    equal(scheduled.length, 1, 'a tick that gives no rate yet schedules no further reading');
    advance(secondsToTick);
    counter += counted;
    await sensors.poll();
    equal(rate.status, 'ready', 'this tick gives the rate');
    equal(scheduled.length, 0, 'so the second reading is called off');
});

test('a sensor that stays without a value gets one second reading, not one after the other', async () => {
    let {sensors, add, show, advance, scheduled} = setup();
    let reads = 0;
    sensors.addSource('empty', {read: async () => ++reads});
    let neverMeasured = add('never-measured', 'empty', () => PENDING);
    let readsFinished = () => new Promise(resolve => setTimeout(resolve, 0));
    show(neverMeasured);
    await readsFinished();
    let secondsUntilSecondReading = scheduled[0].seconds;
    advance(secondsUntilSecondReading);
    await readsFinished();
    equal(reads, 2);
    equal(scheduled.length, 0, 'the second reading schedules no third');
});

test('a rate that still shows a saved value gets its second reading too', async () => {
    let {sensors, add, show, scheduled} = setup();
    sensors.addSource('counter', {read: async () => 0});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    rate.status = 'saved';
    show(rate);
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(rate.status, 'saved', 'the saved value stays until there is a rate');
    equal(scheduled.length, 1);
});

test('a reading that follows the last one within a moment gives the rate against the reading before it', async () => {
    let {sensors, add, show, advance, scheduled} = setup();
    let counter = 0;
    let updateSeconds = 5, moment = 0.004, countedInInterval = 500, countedInMoment = 1;
    sensors.addSource('counter', {read: async () => counter});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    show(rate);
    await new Promise(resolve => setTimeout(resolve, 0));
    advance(scheduled[0].seconds);
    await new Promise(resolve => setTimeout(resolve, 0));
    advance(updateSeconds);
    counter += countedInInterval;
    await sensors.poll();
    equal(rate.value, countedInInterval / updateSeconds);
    advance(moment);
    counter += countedInMoment;
    await sensors.poll(true);
    equal(rate.value, (countedInInterval + countedInMoment) / (updateSeconds + moment), 'not the rate over the moment');
});

test('what comes on screen during a discovery run is not read, and a second reading waits for the end of a run', async () => {
    let {sensors, add, show, advance, scheduled} = setup();
    let reads = 0;
    sensors.addSource('counter', {read: async () => ++reads});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    let readsFinished = () => new Promise(resolve => setTimeout(resolve, 0));
    // A run in progress, and its end, as discover() sets and clears it.
    let run = deferred();
    sensors._discovery = run.promise;
    show(rate);
    await readsFinished();
    equal(reads, 0, 'nothing is read during the run');
    sensors._discovery = null;
    sensors._readNewlyShown();
    await readsFinished();
    equal(reads, 1, 'it is read when the run has ended');

    sensors._discovery = run.promise;
    advance(scheduled[0].seconds);
    await readsFinished();
    equal(reads, 1, 'the second reading does not fall into a run');
    sensors._discovery = null;
    run.resolve();
    await readsFinished();
    equal(reads, 2, 'it follows when the run has ended');
    equal(rate.status, 'ready');
});

test('a rate is not computed over the moment between coming on screen and the next tick', async () => {
    let {sensors, add, show, advance} = setup();
    let counter = 1000, reads = 0;
    let momentBeforeTick = 0.004, updateSeconds = 5, counted = 300;
    sensors.addSource('counter', {read: async () => { reads++; return counter; }});
    let rate = add('rate', 'counter', s => counterRate(s, value => value));
    show(rate);
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(reads, 1, 'the counter is read when the rate comes on screen');
    advance(momentBeforeTick);
    counter += 1;
    await sensors.poll();
    equal(reads, 2, 'the tick that follows at once reads it too');
    equal(rate.status, 'pending', 'and gives no rate over that moment');
    advance(updateSeconds);
    counter += counted;
    await sensors.poll();
    equal(rate.value, counted / updateSeconds, 'the next tick gives the rate over a whole interval');
});

test('a sensor that becomes the header of a category on screen is read at once', async () => {
    let {sensors, add} = setup();
    let reading = 5;
    sensors.addSource('source', {read: async () => reading});
    let value = add('value', 'source', s => s.value);
    sensors.catalog.fan.shown = true;
    sensors.shownChanged();
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(value.status, 'pending', 'a sensor that is neither shown nor the header is not read');
    sensors.setCategoryDefault('fan', value);
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(value.value, reading, 'as the header it has its value without a tick');
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
