// Takes the screenshots of docs/screenshots inside a headless GNOME Shell. Run with `make screenshots`.
// WiFi and memory state examples use simulated readings; the other values come from the machine running the capture.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {toVariant} from '../../helpers/storedCatalog.js';
import {devices} from '../../tests/fixtures/machine.js';

// Room around what a screenshot shows, in pixels.
const MARGIN = 12;
// Menu examples share this width before applying the UI scale; top-bar examples are cropped to their contents.
const CAPTURE_WIDTH = 560;
// Colour rules for the pictures of threshold colours, as a user would set them: green, then yellow from the second
// number on, then red.
const GREEN = '38 162 105', YELLOW = '229 165 10', RED = '224 27 36';
const COLOR_RULES = {
    'temperature-colors': [`0 ${GREEN}`, `70 ${YELLOW}`, `85 ${RED}`].map(breakpoint => `${breakpoint} kind:temp`),
    'memory-colors': [`0 ${GREEN}`, `70 ${YELLOW}`, `90 ${RED}`].map(breakpoint => `${breakpoint} kind:percent`),
};
// How many pictures are saved so far, and their size together.
let savedPictures = 0, savedBytes = 0;

async function capture(name, width, ...actors) {
    let left = Infinity, top = Infinity, right = 0, bottom = 0;
    for (const actor of actors) {
        const [x, y] = actor.get_transformed_position();
        const [actorWidth, actorHeight] = actor.get_transformed_size();
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + actorWidth);
        bottom = Math.max(bottom, y + actorHeight);
    }
    // Outside padding would include a strip of desktop beneath top-bar examples.
    const margin = actors.length === 1 && actors[0] === Main.panel.statusArea.vitalsMenu ? 0 : MARGIN;
    left = Math.max(0, Math.floor(left) - margin);
    top = Math.max(0, Math.floor(top) - margin);
    right = Math.min(global.stage.width, Math.ceil(right) + margin);
    bottom = Math.min(global.stage.height, Math.ceil(bottom) + margin);
    if (width) {
        if (right - left > width || width > global.stage.width)
            throw new Error(`${name}: contents exceed the shared screenshot width`);
        // Extend into the empty panel space on the left, keeping neighbouring status icons out of the picture.
        left = Math.max(0, right - width);
        right = left + width;
    }
    const picture = Gio.File.new_for_path(`${GLib.getenv('SCREENSHOT_DIR')}/${name}.png`);
    const stream = picture.replace(null, false, Gio.FileCreateFlags.NONE, null);
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
    const bytes = picture.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    savedPictures++;
    savedBytes += bytes;
    print(`${name}.png (${right - left}x${bottom - top} px, ${(bytes / 1000).toFixed(1)} kB)`);
}

export async function run() {
    const start = GLib.get_monotonic_time();
    // The Shell's helper process for automation scripts leaves by itself after half a minute, which is before this
    // script is done. Without this, the Shell tries to stop it at the end and ends with a failure.
    await Scripting.disableHelperAutoExit();
    while (!Main.panel.statusArea.vitalsMenu)
        await Scripting.sleep(50);
    // Startup opens the overview; wait for it before returning to the desktop.
    while (Main.layoutManager._startingUp)
        await Scripting.sleep(50);
    const button = Main.panel.statusArea.vitalsMenu;
    const sensors = button._sensors;
    const settings = button._settings;
    // Keep the initial readings fresh while the gallery changes which sensors are visible.
    settings.set_int('update-time', 3600);
    const captureWidth = CAPTURE_WIDTH * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    // Move the virtual pointer out of the hot corner before closing the overview.
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), global.stage.width / 2, global.stage.height / 2);
    await Scripting.sleep(50);
    Main.overview.hide();
    while (Main.overview.visible)
        await Scripting.sleep(50);

    const set = options => {
        for (const [key, optionValue] of Object.entries(options)) {
            if (Array.isArray(optionValue))
                settings.set_strv(key, optionValue);
            else if (typeof optionValue == 'boolean')
                settings.set_boolean(key, optionValue);
            else
                settings.set_int(key, optionValue);
        }
    };
    const reset = options => {
        for (const key of Object.keys(options))
            settings.reset(key);
    };
    const find = (categoryName, key) => sensors.catalog[categoryName].sensors.find(sensor => sensor.key === key);
    const pin = async (pinned, visible) => {
        for (const [, sensor] of pinned) {
            // A machine without sensors of a category has no category pin there.
            if (sensor)
                sensors.pinToPanel(sensor, visible);
        }
        button._syncMenuRows();
        // Allow layout to settle before positioning the menu under the changed top-bar items.
        await Scripting.sleep(300);
    };

    // The top-bar item with the given options set.
    const topBar = async (name, options = {}, pictureWidth = null) => {
        set(options);
        // Each picture shows its values in the room they need, not in the room the picture before left reserved.
        for (const sensor of sensors.panelSensors())
            sensor.reservedWidth = -1;
        button._redrawPanelItems();
        await Scripting.sleep(300);
        // The normal hover highlight distinguishes the panel button from a dark documentation page.
        const [x, y] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height + 100);
        await Scripting.sleep(50);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height / 2);
        await Scripting.sleep(300);
        await capture(name, pictureWidth, button);
        reset(options);
    };
    // The menu with all categories closed, or with one of them open, or with the actions of one of its rows open.
    const menu = async (name, categoryName = null, actionsOf = null) => {
        // Changing the pinned sensors moves the button's centre, where the menu should open for the capture.
        const [x, y] = button.get_transformed_position();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + button.width / 2, y + button.height / 2);
        await Scripting.sleep(50);
        button.menu.open();
        if (categoryName)
            button._categoryMenus[categoryName].menu.open();
        await Scripting.sleep(400);
        if (actionsOf) {
            button._rows.get(actionsOf).activate();
            await Scripting.sleep(300);
        }
        await capture(name, captureWidth, button, button.menu.actor);
        if (actionsOf)
            button._rows.get(actionsOf).activate();
        // A category stays open while the menu is closed, and the next picture may want all of them closed.
        if (categoryName)
            button._categoryMenus[categoryName].menu.close(true);
        button.menu.close();
    };

    // The pictures are published, so the machine's public IP address stays out of them.
    settings.set_boolean('include-public-ip', false);
    // The battery and the graphics card are switched off for a new user; switched on as the preferences do, their
    // sensors can be pinned.
    settings.set_value('catalog-settings', toVariant({battery: {enabled: true}, gpu: {enabled: true}}));
    await button._discoverSensors();

    // The top bar: the sensors a new user has, which end with the download speed, and three more.
    const download = ['network', find('network', 'device-rx')], upload = ['network', find('network', 'device-tx')];
    const temperature = ['temperature', sensors.categoryPin('temperature')];
    const usual = [['memory', find('memory', 'usage')], ['system', find('system', 'load-1m')], download, upload, temperature,
        ['fan', sensors.categoryPin('fan')]];
    const sensorExamples = [['processor', find('processor', 'usage')], ['memory', find('memory', 'usage')], temperature,
        ['fan', sensors.categoryPin('fan')], download, ['power', sensors.categoryPin('power')]];
    // A few pictures show other sensors, to show what else can be pinned.
    const battery = field => ['battery', sensors.catalog.battery.sensors.find(sensor => sensor.field === field)];
    const precise = [battery('percentage'), battery('power-rate'), ['processor', find('processor', 'frequency')],
        ['system', find('system', 'uptime')]];
    const traffic = [download, upload, ['network', find('network', 'boot-rx')], ['network', find('network', 'boot-tx')],
        ['temperature', find('temperature', 'coretemp/temp1') ?? sensors.categoryPin('temperature')]];
    const more = [['network', find('network', 'wifi-link-quality')], battery('percentage'), ['gpu', find('gpu', 'refresh-rate')],
        ['storage', find('storage', '//free')]];
    // Read all gallery pins, category headers and network rows before the first capture.
    const galleryPins = [...usual, ...sensorExamples, ...precise, ...traffic, ...more];
    await pin(galleryPins, true);
    button.menu.open();
    button._categoryMenus.network.menu.open();
    // Rates need two readings after discovery, with time between them.
    await button._discoverSensors();
    await button._readSensors();
    await Scripting.sleep(1100);
    await button._readSensors();
    await Scripting.sleep(400);
    button._categoryMenus.network.menu.close(false);
    button.menu.close();
    await pin(galleryPins, false);
    await pin(usual, true);

    const topBarWith = async (pinned, name, options, width = null) => {
        await pin(usual, false);
        await pin(pinned, true);
        await topBar(name, options, width);
        await pin(pinned, false);
        await pin(usual, true);
    };
    // Gallery examples in both Shell styles; light-style filenames end in "-light".
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    // Keep the shared capture's extra space free of wallpaper details.
    new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).set_string('picture-options', 'none');
    print(`Taking the pictures in ${GLib.getenv('SCREENSHOT_DIR')}`);
    print(`Screen ${global.stage.width}x${global.stage.height} px, scale ${St.ThemeContext.get_for_stage(global.stage).scale_factor
    }, text scale ${desktop.get_double('text-scaling-factor')}`);
    for (const style of ['', '-light']) {
        desktop.set_string('color-scheme', style ? 'prefer-light' : 'prefer-dark');
        await Scripting.sleep(500);
        await topBar(`top-bar${style}`);
        if (!style)
            await topBarWith(sensorExamples, 'top-bar-sensors', {}, null);
        await topBar(`top-bar-plain${style}`, {'emphasize-values': false});
        await topBar(`top-bar-gnome-icons${style}`, {'icon-style': 1});
        await topBar(`top-bar-no-icons${style}`, {'hide-icons': true});
        await topBarWith(precise, `top-bar-precision${style}`, {'use-higher-precision': true});
        await topBarWith(traffic, `top-bar-fahrenheit-bits${style}`, {'unit': 1, 'network-speed-format': 1});
        await topBar(`top-bar-colors${style}`, COLOR_RULES);
        await topBarWith(more, `top-bar-many${style}`);

        await menu(`menu${style}`);
        await menu(`menu-network${style}`, 'network');
        await menu(`menu-actions${style}`, 'network', find('network', 'device-tx'));
    }

    const dynamic = [['memory', find('memory', 'allocated')], ['network', find('network', 'wifi-link-quality')]];
    await pin(usual, false);
    await pin(dynamic, true);
    const sampleFiles = {
        '/proc/net/wireless': `${GLib.getenv('XDG_RUNTIME_DIR')}/vitals-wifi-screenshot`,
        '/proc/meminfo': `${GLib.getenv('XDG_RUNTIME_DIR')}/vitals-memory-screenshot`,
    };
    const newForPath = Gio.File.new_for_path;
    // Substitute these files inside the isolated Shell; the collector and renderer still process each reading.
    Gio.File.new_for_path = path => newForPath(sampleFiles[path] ?? path);
    try {
        const headings = devices.system['/proc/net/wireless'].split('\n').slice(0, 2).join('\n');
        desktop.set_string('color-scheme', 'prefer-dark');
        await Scripting.sleep(500);
        for (const [name, usedGiB, dbm] of [['low', 4, -96], ['medium', 16, -67], ['high', 28, -53]]) {
            const available = (32 - usedGiB) * 1024 * 1024;
            GLib.file_set_contents(sampleFiles['/proc/meminfo'], `MemTotal: 33554432 kB\nMemAvailable: ${available} kB\nMemFree: ${available} kB\n` +
                'Cached: 0 kB\nShmem: 0 kB\nBuffers: 0 kB\nSReclaimable: 0 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n');
            GLib.file_set_contents(sampleFiles['/proc/net/wireless'], `${headings}\nwlan0: 0000 ${dbm + 110}. ${dbm}. -256 0 0 0 0 0 0\n`);
            await button._readSensors();
            await topBar(`top-bar-dynamic-${name}`, {'memory-measurement': 0});
        }
    } finally {
        Gio.File.new_for_path = newForPath;
        for (const path of Object.values(sampleFiles))
            GLib.unlink(path);
    }
    await pin(dynamic, false);
    await pin(usual, true);
    desktop.reset('color-scheme');
    settings.reset('update-time');

    // The preferences window, as it opens.
    await button._extensionObject.openPreferences();
    const preferences = () => global.get_window_actors().find(actor => actor.meta_window.get_title()?.includes('Vitals'));
    while (!preferences())
        await Scripting.sleep(50);
    await Scripting.sleep(1500);
    await capture('preferences', null, preferences());
    print(`${savedPictures} pictures saved (${(savedBytes / 1000).toFixed(1)} kB, ${Math.round((GLib.get_monotonic_time() - start) / 1000000)} s)`);
}
