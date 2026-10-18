import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readCatalog, writeCatalog} from '../helpers/storedCatalog.js';

let tests = [];
// The faults that were logged (console.error and console.warn) and that no test took with `takeFaults`.
let faults = [];

// Vitals settings in a store of their own, so no value outlives the test that set it.
export function settings() {
    let schema = Gio.SettingsSchemaSource.new_from_directory(
        GLib.get_current_dir() + '/schemas', Gio.SettingsSchemaSource.get_default(), false)
        .lookup('org.gnome.shell.extensions.vitals', false);
    let configuration = new Gio.Settings({settings_schema: schema, backend: Gio.memory_settings_backend_new()});
    configuration.set_boolean('include-static-info', false);
    configuration.set_boolean('include-public-ip', false);
    configuration.set_int('update-time', 1);
    // The saved catalog every test starts from: the schema's categories, no sensors yet, and an empty panel.
    let catalog = readCatalog(configuration);
    catalog.panel.sensors = [];
    writeCatalog(configuration, catalog);
    return configuration;
}

export function test(name, run) {
    tests.push([name, run]);
}

// What ends what the running test set up for itself, such as an installed machine. It runs when the test ends,
// also when it fails.
let endings = [];

export function atEnd(ending) {
    endings.push(ending);
}

export function equal(actual, expected, message) {
    if (actual !== expected)
        throw new Error((message ? message + ': ' : '') + 'expected ' + expected + ', got ' + actual);
}

// For numbers that are computed in different orders and can differ in their last digits.
export function near(actual, expected, message) {
    if (!(Math.abs(actual - expected) <= 1e-9 * Math.abs(expected)))
        throw new Error((message ? message + ': ' : '') + 'expected about ' + expected + ', got ' + actual);
}

export function between(actual, low, high, message) {
    if (!(actual >= low && actual <= high))
        throw new Error((message ? message + ': ' : '') + 'expected between ' + low + ' and ' + high + ', got ' + actual);
}

export function mean(values) {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

// The faults logged since the last call. A test that expects a fault takes it; any other fails the test.
export function takeFaults() {
    return faults.splice(0);
}

// Lets the main loop run once, so that what is under way and answered at once is done.
export function settle() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export function wait(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Runs the tests of a GJS test file, which has the interpreter to itself. The log of that interpreter is collected
// for faults, and every message but debug and info messages is printed.
export async function runTests() {
    GLib.log_set_writer_func((level, fields) => {
        let message = new TextDecoder().decode(fields.MESSAGE);
        if (level <= GLib.LogLevelFlags.LEVEL_WARNING) {
            faults.push(message);
            printerr(message);
        } else if (level == GLib.LogLevelFlags.LEVEL_MESSAGE) {
            print(message);
        }
        return GLib.LogWriterOutput.HANDLED;
    });
    for (let [name, run] of tests) {
        try {
            await run();
        } finally {
            for (let ending of endings.splice(0))
                ending();
        }
        let unexpected = takeFaults();
        if (unexpected.length)
            throw new Error(name + ': faults logged:\n' + unexpected.join('\n'));
        print('PASS ' + name);
    }
    print(tests.length + ' tests passed');
}
