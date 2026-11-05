// Runs inside a headless Shell against real hardware, using virtual input and settings.
// Sensor readings are tested separately in tests/sensors.test.js.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {equal} from './harness.js';
import {sensorCategories} from '../helpers/categories.js';
import {run as testCroppedIcon} from './croppedIcon.test.js';

const UUID = 'Vitals@CoreCoding.com';

// The extension's button in the top bar, its settings, and the virtual pointer and keyboard.
let button, settings, pointer, keyboard;
const steps = [];

function step(name, act) {
    steps.push([name, act]);
}

async function waitFor(predicate, message) {
    const deadline = GLib.get_monotonic_time() + 10000000;
    while (!await predicate()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(`Timed out: ${message}`);
        await Scripting.sleep(50);
    }
}

// Includes actors outside the scroll viewport.
function visibleActors(root, test) {
    const found = [];
    const visit = actor => {
        if (!actor.visible)
            return;
        if (test(actor))
            found.push(actor);
        actor.get_children().forEach(visit);
    };
    visit(root);
    return found;
}

function labels(root) {
    return visibleActors(root, actor => actor instanceof St.Label);
}

// The label under `root` that shows this text.
function labelled(root, text) {
    const label = labels(root).find(candidate => candidate.text === text);
    if (!label)
        throw new Error(`Not on screen: ${text}`);
    return label;
}

function roundButton(name) {
    return visibleActors(button.menu.box, actor => actor instanceof St.Button && actor.accessible_name === name)[0];
}

async function pointAt(x, y) {
    // A move straight into the top bar can be stopped by the hot corner's barriers; one from below is not.
    if (y < Main.panel.height) {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, Main.panel.height + 100);
        await Scripting.sleep(50);
    }
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    await Scripting.sleep(50);
}

function middle(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return [x + width / 2, y + height / 2];
}

async function pressButton(state, mouseButton = Clutter.BUTTON_PRIMARY) {
    pointer.notify_button(GLib.get_monotonic_time(), mouseButton, state);
    await Scripting.sleep(50);
}

// Turns the mouse wheel over the scrolled box that holds the actor, such as a long category, until the actor is in
// view, as a user does before clicking it.
async function scrollIntoView(actor) {
    let view = actor.get_parent();
    while (view && !(view instanceof St.ScrollView))
        view = view.get_parent();
    if (!view)
        return;
    const [, viewTop] = view.get_transformed_position();
    const viewBottom = viewTop + view.get_transformed_size()[1];
    const top = () => actor.get_transformed_position()[1];
    const bottom = () => top() + actor.get_transformed_size()[1];
    for (let turn = 0; top() < viewTop || bottom() > viewBottom; turn++) {
        if (turn === 50)
            throw new Error('Not scrolled into view');
        await pointAt(...middle(view));
        pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
            top() < viewTop ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
        await Scripting.sleep(50);
    }
}

async function click(actor, mouseButton = Clutter.BUTTON_PRIMARY) {
    await scrollIntoView(actor);
    await pointAt(...middle(actor));
    await pressButton(Clutter.ButtonState.PRESSED, mouseButton);
    await pressButton(Clutter.ButtonState.RELEASED, mouseButton);
    await Scripting.sleep(100);
}

// Presses an actor, moves the pointer to the given place in steps, as a hand does, and lets go.
async function drag(actor, x, y) {
    const [startX, startY] = middle(actor);
    await pointAt(startX, startY);
    await pressButton(Clutter.ButtonState.PRESSED);
    for (let part = 1; part <= 10; part++)
        await pointAt(startX + (x - startX) * part / 10, startY + (y - startY) * part / 10);
    await Scripting.sleep(100);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(300);
}

async function pressKey(keyval) {
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    await Scripting.sleep(20);
}

// The texts of the values in the top bar, from left to right.
function topBarTexts() {
    return topBarItems().map(item => labels(item).map(label => label.text).join(''));
}

// The items in the top bar, each an icon and its value.
function topBarItems() {
    return visibleActors(button, actor => actor instanceof St.BoxLayout && actor.has_style_class_name('vitals-panel-item') && labels(actor).length > 0);
}

async function openMenu() {
    if (!button.menu.isOpen)
        await click(button);
    await waitFor(() => button.menu.isOpen, 'the menu is open');
}

async function closeMenu() {
    await pressKey(Clutter.KEY_Escape);
    // The Shell lets the menu fade out.
    await Scripting.sleep(400);
}

// The names of the categories in the menu, from top to bottom.
function categoryNames() {
    return button.menu.box.get_children().filter(actor => actor instanceof PopupMenu.PopupSubMenuMenuItem && actor.visible)
        .map(item => item.label.text);
}

// A category of the menu by the name it shows: the item that a click opens and closes it with, the label of the
// value in its category header, and the box of its rows.
function category(name) {
    const item = labelled(button.menu.box, name).get_parent();
    const actors = button.menu.box.get_children();
    const header = item.get_children().find(actor => actor instanceof St.Label && actor !== item.label);
    return {item, header, rows: actors[actors.indexOf(item) + 1]};
}

async function openCategory(name) {
    const {item, rows} = category(name);
    if (!rows.visible)
        await click(item);
    // Its rows have their places once it has slid open.
    await waitFor(() => rows.visible && rows.get_transition('height') === null, `${name} is open`);
}

// The height of an actor in every frame while `act` runs and for a moment after.
async function heightsWhile(actor, act) {
    const heights = [];
    const painted = global.stage.connect('after-paint', () =>
        heights.push(actor.visible ? actor.get_allocation_box().get_height() : 0));
    await act();
    await Scripting.sleep(600);
    global.stage.disconnect(painted);
    return heights;
}

step('the top bar shows the sensors a new user starts with, and their values once they are read', async () => {
    await waitFor(() => topBarTexts().length === 3 && !topBarTexts().includes('…'), 'three values');
    equal(topBarTexts()[0].endsWith('%'), true, `the memory usage first: ${topBarTexts()}`);
});

step('closing the popup during renaming saves the name and leaves the menu usable', async () => {
    await openMenu();
    await openCategory('Memory');
    const memory = category('Memory');
    const row = visibleActors(memory.rows, actor => actor instanceof PopupMenu.PopupBaseMenuItem && actor.reactive)[0];
    const original = labels(row)[0].text;
    const renamed = 'Renamed sensor';
    await click(row);
    await click(labelled(memory.rows, 'Rename'));
    const entry = visibleActors(memory.rows, actor => actor instanceof St.Entry)[0];
    for (const character of renamed)
        await pressKey(character.codePointAt(0));
    equal(entry.text, renamed, 'the new name was typed');

    // Shell can dismiss the popup without sending Escape to the rename entry.
    button.menu.close();
    await waitFor(() => !button.menu.actor.mapped, 'the popup finished closing');
    await openMenu();
    await openCategory('Memory');
    await waitFor(() => labels(memory.rows).some(label => label.text === renamed), 'the saved name is shown');

    settings.set_boolean('use-higher-precision', true);
    await Scripting.sleep(100);
    await click(labelled(memory.rows, 'Rename'));
    visibleActors(memory.rows, actor => actor instanceof St.Entry)[0].text = original;
    await pressKey(Clutter.KEY_Return);
    await waitFor(() => labels(memory.rows).some(label => label.text === original), 'the original name is restored');
    settings.reset('use-higher-precision');
    await click(memory.item);
    await click(memory.item);
    await waitFor(() => !memory.rows.visible, 'the category is closed');
    await closeMenu();
});

step('switching steady widths off and on forgets old widths without changing emphasis', async () => {
    settings.set_boolean('remember-widths', false);
    settings.set_boolean('use-higher-precision', true);
    await Scripting.sleep(100);
    const wide = topBarItems()[0].width;
    settings.set_boolean('use-higher-precision', false);
    await Scripting.sleep(100);
    equal(topBarItems()[0].width, wide, 'steady widths retain room for the extra decimal');
    settings.set_boolean('fixed-widths', false);
    await Scripting.sleep(100);
    const naturalWidth = topBarItems()[0].width;
    equal(naturalWidth < wide, true, 'without steady widths the value uses its natural width');
    settings.set_boolean('fixed-widths', true);
    await Scripting.sleep(100);
    equal(topBarItems()[0].width, naturalWidth, 'steady widths restart from the current text');
    settings.reset('remember-widths');
    settings.reset('use-higher-precision');
    settings.reset('fixed-widths');
});

step('missing category icons do not prevent changing panel settings or opening the menu', async () => {
    const directory = Main.extensionManager.lookup(UUID).dir;
    const icons = directory.get_child('icons');
    const unavailable = directory.get_child('icons-unavailable');
    // Only the isolated Shell's installed copy is changed; the source artwork stays in place.
    icons.move(unavailable, Gio.FileCopyFlags.NONE, null, null);
    try {
        settings.set_int('icon-style', 1 - settings.get_int('icon-style'));
        settings.set_boolean('hide-icons', true);
        await Scripting.sleep(100);
        equal(visibleActors(button, actor => actor instanceof St.Icon).length, 0, 'icons can still be switched off');
        settings.set_boolean('hide-icons', false);
        await Scripting.sleep(100);
        equal(topBarItems().length, 3, 'all panel values survive the missing icons');
        await openMenu();
        equal(categoryNames().includes('Memory'), true, 'the menu remains usable');
        await closeMenu();
    } finally {
        unavailable.move(icons, Gio.FileCopyFlags.NONE, null, null);
        settings.reset('icon-style');
        settings.reset('hide-icons');
    }
});

step('cropped icons preserve their rectangular viewport and GNOME recolouring through reloads', async () => {
    const {CroppedIcon} = await import(`${Main.extensionManager.lookup(UUID).dir.get_uri()}/croppedIcon.js`);
    await testCroppedIcon(CroppedIcon, waitFor);
});

step('a click on the top bar opens the menu, with the categories in alphabetical order and a value in each category header', async () => {
    await openMenu();
    const catalogSettings = settings.get_value('catalog-settings').recursiveUnpack();
    const switchedOn = Object.keys(sensorCategories).filter(name => catalogSettings[name]?.enabled ?? sensorCategories[name].enabled)
        .map(name => sensorCategories[name].name).sort();
    equal(categoryNames().join(', '), switchedOn.join(', '), 'the categories that are switched on');
    for (const name of ['Memory', 'Processor', 'System'])
        await waitFor(() => category(name).header.visible && category(name).header.text !== '…', `${name} header`);
});

step('a click on a category slides it open, and opening another slides the first one shut', async () => {
    const memory = category('Memory'), system = category('System');
    const opening = await heightsWhile(memory.rows, () => click(memory.item));
    equal(new Set(opening).size > 3, true, `it slides open: ${opening.length} frames`);
    equal(memory.rows.visible, true);
    const closing = await heightsWhile(memory.rows, () => click(system.item));
    equal(new Set(closing).size > 3, true, 'the first one slides shut');
    equal(memory.rows.visible, false, 'and is hidden at the end');
    equal(system.rows.visible, true, 'the other one is open');
    await click(system.item);
    await Scripting.sleep(400);
    equal(system.rows.visible, false, 'a click closes it');
});

step('without the option for sliding, a category opens and closes at once', async () => {
    settings.set_boolean('animate-categories', false);
    const memory = category('Memory');
    await click(memory.item);
    equal(memory.rows.visible && memory.rows.get_transition('height') === null, true, 'open at once');
    await click(memory.item);
    equal(memory.rows.visible, false, 'shut at once');
    settings.reset('animate-categories');
});

step('the open category is still open when the menu is opened again', async () => {
    await openCategory('Memory');
    await closeMenu();
    await openMenu();
    equal(category('Memory').rows.visible, true);
});

step('memory sections separate the additive breakdown from details and swap, and detail sensors can be pinned', async () => {
    await openCategory('Memory');
    const memory = category('Memory');
    const dividers = () => visibleActors(memory.rows, actor => actor instanceof PopupMenu.PopupSeparatorMenuItem).length;
    equal(dividers(), 1, 'details are off by default; breakdown and swap remain');
    settings.set_boolean('memory-show-details', true);
    // Newly inserted rows need a layout before pointer coordinates can target them.
    await Scripting.sleep(100);
    const sections = [[]];
    for (const item of visibleActors(memory.rows, actor => actor instanceof PopupMenu.PopupBaseMenuItem)) {
        if (item instanceof PopupMenu.PopupSeparatorMenuItem)
            sections.push([]);
        else
            sections.at(-1).push(item);
    }
    equal(sections.length, 3, 'dividers separate the breakdown, details and swap');
    equal(visibleActors(memory.rows, actor => actor instanceof PopupMenu.PopupSubMenuMenuItem).length, 0, 'no nested sensor submenus');
    const amounts = rows => rows.flatMap(row => labels(row)).filter(label => /^-?\d+\.\d+ (?:[kMGTPEZY]i?)?B$/.test(label.text));
    await waitFor(() => amounts(sections[0]).length === 5 && amounts(sections[2]).length === 3, 'memory and swap readings');
    const [used, reclaimable, free, available, total] = amounts(sections[0]).map(label => Math.round(Number.parseFloat(label.text) * 10));
    equal(used + available, total, 'displayed used + available = total');
    equal(free + reclaimable, available, 'displayed free + reclaimable = available');
    const [swapUsed, swapFree, swapTotal] = amounts(sections[2]).map(label => Math.round(Number.parseFloat(label.text) * 10));
    equal(swapUsed + swapFree, swapTotal, 'displayed swap used + free = total');
    const before = topBarItems().length;
    await waitFor(() => amounts(sections[1]).length > 0, 'detail readings are visible');
    const detail = amounts(sections[1])[0].get_parent();
    const detailName = labels(detail)[0].text;
    await click(detail);
    await click(labelled(memory.rows, 'Pin to top bar'));
    await waitFor(() => topBarItems().length === before + 1, 'the detail is pinned');
    settings.set_boolean('memory-show-details', false);
    await Scripting.sleep(100);
    equal(dividers(), 1, 'switching details off removes the section and its divider');
    equal(labels(memory.rows).some(label => label.text === detailName), false, 'the detail row is absent');
    equal(topBarItems().length, before + 1, 'the pinned detail stays in the top bar');
    settings.set_boolean('memory-show-details', true);
    await Scripting.sleep(100);
    await click(labelled(memory.rows, detailName).get_parent());
    await click(labelled(memory.rows, 'Pin to top bar'));
    await waitFor(() => topBarItems().length === before, 'the detail is unpinned again');
    // A click outside the actions closes them without closing the category.
    await click(memory.item);
    settings.reset('memory-show-details');
});

step('either mouse button on a row-menu header closes only the row menu, without highlighting the header', async () => {
    await openMenu();
    await openCategory('Memory');
    const memory = category('Memory');
    const row = visibleActors(memory.rows, actor => actor instanceof PopupMenu.PopupBaseMenuItem && actor.reactive)[0];
    const name = labels(row)[0].text;
    for (const mouseButton of [Clutter.BUTTON_PRIMARY, Clutter.BUTTON_SECONDARY]) {
        await click(row);
        const header = labels(memory.rows).findLast(label => label.text === name).get_parent();
        equal(header !== row, true, 'the row menu is open');
        const background = header.get_theme_node().get_background_color();
        await pointAt(...middle(header));
        equal(header.get_theme_node().get_background_color().equal(background), true, 'hover does not highlight the header');
        await click(header, mouseButton);
        await waitFor(() => labels(memory.rows).filter(label => label.text === name).length === 1, 'the row menu closed');
        equal(button.menu.isOpen && memory.rows.visible, true, 'the menu and category stay open');
    }
});

step('a category dropped onto another takes its place, and the alphabetical order sorts them again', async () => {
    await click(category('Memory').item);
    await waitFor(() => !category('Memory').rows.visible, 'Memory slid shut');
    const names = categoryNames();
    const [first, last] = [names[0], names.at(-1)];
    await drag(category(last).item, ...middle(category(first).item));
    equal(categoryNames().join(', '), [last, ...names.slice(0, -1)].join(', '), 'the dropped one is first');
    settings.set_int('category-order', 0);
    equal(categoryNames().join(', '), names.join(', '), 'alphabetical again');
    settings.reset('category-order');
    equal(categoryNames()[0], last, 'and as the user arranged them in the manual order');
    // The categories are built again, and have their places on screen after the next layout.
    await Scripting.sleep(100);
    await drag(category(last).item, ...middle(category(names.at(-2)).item));
    equal(categoryNames().join(', '), names.join(', '), 'dropped onto the one that is last now, it is last again');
});

step('a top-bar item takes the place it is dropped at', async () => {
    await closeMenu();
    const items = topBarItems();
    const [lastX, lastY] = middle(items.at(-1));
    await drag(items[0], lastX + items.at(-1).width / 2 - 2, lastY);
    equal(topBarItems().map(item => items.indexOf(item)).join(','), '1,2,0');
    // Dropped onto the left half of the first item, it is first again.
    const [firstX, firstY] = topBarItems()[0].get_transformed_position();
    await drag(items[0], firstX + 2, firstY + items[0].height / 2);
    equal(topBarItems().map(item => items.indexOf(item)).join(','), '0,1,2');
});

step('the menu opens under the pointer, or under the middle of the top bar\'s sensors when the user wants that', async () => {
    const menuMiddle = () => middle(button.menu.box)[0];
    const [x, y] = button.get_transformed_position();
    const left = Math.round(x + button.width / 4);
    await pointAt(left, y + button.height / 2);
    await pressButton(Clutter.ButtonState.PRESSED);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - left) <= 1, true, `by default under the pointer: ${menuMiddle()} / ${left}`);
    await closeMenu();
    settings.set_boolean('menu-centered', true);
    await pressButton(Clutter.ButtonState.PRESSED);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - middle(button)[0]) <= 1, true,
        `with the option under the middle of the item: ${menuMiddle()} / ${middle(button)[0]}`);
    await closeMenu();
    settings.reset('menu-centered');
});

step('with emphasized values the icons are lighter and the units are set off; without, everything is as strong', async () => {
    const look = () => {
        // The memory usage, whose value has a unit.
        const item = topBarItems().find(candidate => labels(candidate).some(label => label.text.endsWith('%')));
        const icon = item.get_first_child();
        const runs = labels(item).flatMap(label => {
            const layout = label.clutter_text.get_layout();
            const iterator = layout.get_iter();
            const attributes = layout.get_attributes()?.get_iterator();
            const segments = [];
            do {
                const glyphs = iterator.get_run_readonly();
                if (!glyphs)
                    continue;
                while (attributes && attributes.range()[1] <= glyphs.item.offset)
                    attributes.next();
                segments.push({
                    baseline: label.clutter_text.get_transformed_position()[1] + iterator.get_run_baseline() / Pango.SCALE / label.clutter_text.get_resource_scale(),
                    font: glyphs.item.analysis.font.describe(),
                    opacity: label.clutter_text.get_paint_opacity() / 255 * (attributes?.get(Pango.AttrType.FOREGROUND_ALPHA)?.as_int().value ?? 65535) / 65535,
                });
            } while (iterator.next_run());
            return segments;
        });
        const number = runs[0], unit = runs.at(-1);
        equal(Math.abs(number.baseline - unit.baseline) <= 1, true, 'value and unit share a baseline');
        return {
            iconOpacity: icon.opacity, iconSize: icon.get_theme_node().get_length('icon-size'),
            unitOpacity: unit.opacity,
            numberFont: number.font, unitFont: unit.font,
        };
    };
    const emphasized = look();
    equal(emphasized.iconOpacity < 255 && emphasized.unitOpacity < 1, true, 'icons and units are lighter by default');
    equal(emphasized.unitFont.get_size() < emphasized.numberFont.get_size(), true, 'the unit is smaller');
    equal(emphasized.unitFont.get_weight() < emphasized.numberFont.get_weight(), true, 'the unit is thinner');
    settings.set_boolean('emphasize-values', false);
    await Scripting.sleep(100);
    const plain = look();
    equal(plain.iconOpacity === 255 && plain.unitOpacity === 1, true, 'with the option off');
    equal(plain.unitFont.get_size(), plain.numberFont.get_size(), 'the same font size');
    equal(plain.unitFont.get_weight(), plain.numberFont.get_weight(), 'the same font weight');
    equal(plain.iconSize > emphasized.iconSize, true, 'and the icon has the size of the Shell\'s status icons');
    settings.reset('emphasize-values');
});

step('the Preferences button opens the preferences', async () => {
    await openMenu();
    await click(roundButton('Preferences'));
    const findPreferencesWindow = () => global.get_window_actors().map(actor => actor.meta_window).find(window => window.get_title()?.includes('Vitals'));
    await waitFor(findPreferencesWindow, 'the preferences window');
    findPreferencesWindow().delete(global.display.get_current_time_roundtrip());
    await waitFor(() => !findPreferencesWindow(), 'the preferences window closed');
});

export async function run() {
    // The Shell's helper process for automation scripts leaves by itself after half a minute, which is before this
    // test is done. Without this, the Shell tries to stop it at the end and ends with a failure.
    await Scripting.disableHelperAutoExit();
    await waitFor(() => Main.panel.statusArea.vitalsMenu, 'the extension is on');
    button = Main.panel.statusArea.vitalsMenu;
    settings = Main.extensionManager.lookup(UUID).stateObj.getSettings();
    // Keep public-IP lookups out of the Shell tests.
    settings.set_boolean('include-public-ip', false);
    const seat = global.stage.context.get_backend().get_default_seat();
    pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 'the overview is hidden');
    for (const [name, act] of steps) {
        await act();
        print(`PASS ${name}`);
    }
    print(`${steps.length} Shell checks passed`);
}
