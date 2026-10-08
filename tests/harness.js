import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readCatalog, writeCatalog} from '../helpers/storedCatalog.js';

let tests = [];

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

export function equal(actual, expected, message) {
    if (actual !== expected)
        throw new Error((message ? message + ': ' : '') + 'expected ' + expected + ', got ' + actual);
}

export function mean(values) {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

export async function runTests() {
    for (let [name, run] of tests) {
        await run();
        print('PASS ' + name);
    }
    print(tests.length + ' tests passed');
}
