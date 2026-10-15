// Takes the screenshots of docs/screenshots inside a headless GNOME Shell. Run with `make screenshots`.
// The values are those of the machine it runs on. docs/screenshots/README.md says what each picture shows.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

// Room around what a screenshot shows, in pixels.
const MARGIN = 12;
// Colour rules for the pictures of threshold colours: green, then yellow from the second number on, then red.
const GREEN = '38 162 105', YELLOW = '229 165 10', RED = '224 27 36';
const COLOR_RULES = {
    'temperature-colors': ['0 ' + GREEN, '50 ' + YELLOW, '60 ' + RED].map(breakpoint => breakpoint + ' kind:temp'),
    'memory-colors': ['0 ' + GREEN, '50 ' + YELLOW, '80 ' + RED].map(breakpoint => breakpoint + ' kind:percent'),
    'processor-colors': ['0 ' + GREEN, '25 ' + YELLOW, '75 ' + RED].map(breakpoint => breakpoint + ' kind:percent')
};
// How many pictures are saved so far, and their size together.
let savedPictures = 0, savedBytes = 0;

// Saves the part of the screen that holds the given actors, with some room around it.
async function capture(name, ...actors) {
    let left = Infinity, top = Infinity, right = 0, bottom = 0;
    for (let actor of actors) {
        let [x, y] = actor.get_transformed_position();
        let [width, height] = actor.get_transformed_size();
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + width);
        bottom = Math.max(bottom, y + height);
    }
    left = Math.max(0, Math.floor(left) - MARGIN);
    top = Math.max(0, Math.floor(top) - MARGIN);
    right = Math.min(global.stage.width, Math.ceil(right) + MARGIN);
    bottom = Math.min(global.stage.height, Math.ceil(bottom) + MARGIN);
    let picture = Gio.File.new_for_path(GLib.getenv('SCREENSHOT_DIR') + '/' + name + '.png');
    let stream = picture.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot_area(left, top, right - left, bottom - top, stream, (screenshot, result) => {
            try {
                screenshot.screenshot_area_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
    stream.close(null);
    let bytes = picture.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    savedPictures++;
    savedBytes += bytes;
    print(name + '.png (' + (right - left) + 'x' + (bottom - top) + ' px, ' + (bytes / 1000).toFixed(1) + ' kB)');
}

export async function run() {
    let start = GLib.get_monotonic_time();
    // The Shell's helper process for automation scripts leaves by itself after half a minute, which is before this
    // script is done. Without this, the Shell tries to stop it at the end and ends with a failure.
    await Scripting.disableHelperAutoExit();
    while (!Main.panel.statusArea.vitalsMenu)
        await Scripting.sleep(50);
    Main.overview.hide();
    let button = Main.panel.statusArea.vitalsMenu;
    let sensors = button._sensors;
    let settings = button._settings;

    // Reads until every value on screen is there. A speed needs two readings, some time apart, and nothing is
    // read while the extension looks for hardware, which it does after a setting changed and when the menu opens.
    let read = async () => {
        await button._discoverSensors();
        await button._querySensors();
        await Scripting.sleep(1100);
        await button._querySensors();
        await Scripting.sleep(400);
    };
    let set = options => {
        for (let [key, optionValue] of Object.entries(options)) {
            if (Array.isArray(optionValue))
                settings.set_strv(key, optionValue);
            else if (typeof optionValue == 'boolean')
                settings.set_boolean(key, optionValue);
            else
                settings.set_int(key, optionValue);
        }
    };
    let reset = options => {
        for (let key of Object.keys(options))
            settings.reset(key);
    };
    let find = (categoryName, key) => sensors.catalog[categoryName].sensors.find(sensor => sensor.key == key);
    let pin = async (pinned, visible) => {
        for (let [categoryName, sensor] of pinned) {
            // A machine without sensors of a category has no header there.
            if (sensor)
                sensors.setPanelSensorVisible(categoryName, sensor, visible);
        }
        button._syncCatalog();
        // The item has its new size from the next frame on, and the menu opens where the item is.
        await Scripting.sleep(300);
    };

    // The top-bar item with the given options set.
    let topBar = async (name, options = {}) => {
        set(options);
        // Each picture shows its values in the room they need, not in the room the picture before left reserved.
        button._widths.clear();
        button._redrawPanelItems();
        await read();
        await capture(name, button);
        reset(options);
    };
    // The menu with all categories closed, or with one of them open, or with the actions of one of its rows open.
    let menu = async (name, categoryName = null, actionsOf = null) => {
        button.menu.open();
        if (categoryName)
            button._groups[categoryName].menu.open();
        await read();
        if (actionsOf) {
            button._rows.get(actionsOf).activate();
            await Scripting.sleep(300);
        }
        await capture(name, button, button.menu.actor);
        if (actionsOf)
            button._rows.get(actionsOf).activate();
        // A category stays open while the menu is closed, and the next picture may want all of them closed.
        if (categoryName)
            button._groups[categoryName].menu.close(true);
        button.menu.close();
    };

    // The pictures are published, so the machine's public IP address stays out of them.
    settings.set_boolean('include-public-ip', false);
    await button._discoverSensors();

    // The top bar: the sensors a new user has, which end with the download speed, and three more.
    await pin([['network', find('network', 'device-tx')], ['temperature', sensors.catalog.temperature.header],
        ['fan', sensors.catalog.fan.header]], true);
    let more = [['processor', find('processor', 'usage')], ['storage', find('storage', '//free')],
        ['voltage', sensors.catalog.voltage.header], ['system', find('system', 'uptime')]];
    // Every picture once in the Shell's dark style and once in its light style, whose pictures end in "-light".
    // The Shell is dark unless the desktop asks for light.
    let desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    print('Taking the pictures in ' + GLib.getenv('SCREENSHOT_DIR'));
    print('Screen ' + global.stage.width + 'x' + global.stage.height + ' px, scale ' + St.ThemeContext.get_for_stage(global.stage).scale_factor +
        ', text scale ' + desktop.get_double('text-scaling-factor'));
    for (let style of ['', '-light']) {
        if (style)
            desktop.set_string('color-scheme', 'prefer-light');
        await Scripting.sleep(500);
        await topBar('top-bar' + style);
        await topBar('top-bar-plain' + style, {'emphasize-values': false});
        await topBar('top-bar-gnome-icons' + style, {'icon-style': 1});
        await topBar('top-bar-no-icons' + style, {'hide-icons': true});
        await topBar('top-bar-precision' + style, {'use-higher-precision': true});
        await topBar('top-bar-fahrenheit-bits' + style, {'unit': 1, 'network-speed-format': 1});
        await topBar('top-bar-colors' + style, COLOR_RULES);
        await pin(more, true);
        await topBar('top-bar-many' + style);
        await pin(more, false);

        await menu('menu' + style);
        await menu('menu-network' + style, 'network');
        await menu('menu-actions' + style, 'network', find('network', 'device-tx'));
    }
    desktop.reset('color-scheme');

    // The preferences window, as it opens.
    await button._extensionObject.openPreferences();
    let preferences = () => global.get_window_actors().find(actor => actor.meta_window.get_title()?.includes('Vitals'));
    while (!preferences())
        await Scripting.sleep(50);
    await Scripting.sleep(1500);
    await capture('preferences', preferences());
    print(savedPictures + ' pictures saved (' + (savedBytes / 1000).toFixed(1) + ' kB, ' + Math.round((GLib.get_monotonic_time() - start) / 1000000) + ' s)');
}
