// The test of what a user sees and does, in a Shell without a screen. It runs inside the Shell's own interpreter,
// so it replaces nothing: Vitals reads the machine the test runs on. It acts through a virtual pointer and keyboard,
// and the settings, and checks only what is on screen. The values themselves are tested in tests/sensors.test.js.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {equal} from './harness.js';

const UUID = 'Vitals@CoreCoding.com';

// The extension's button in the top bar, its settings, and the virtual pointer and keyboard.
let button, settings, pointer, keyboard;
let steps = [];

function step(name, run) {
    steps.push([name, run]);
}

async function waitFor(predicate, message) {
    let deadline = GLib.get_monotonic_time() + 10000000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error('Timed out: ' + message);
        await Scripting.sleep(50);
    }
}

// Every actor under `root` that is on screen and passes `test`, in the order they are drawn.
function onScreen(root, test) {
    let found = [];
    let visit = actor => {
        if (!actor.visible) return;
        if (test(actor)) found.push(actor);
        actor.get_children().forEach(visit);
    };
    visit(root);
    return found;
}

function labels(root) {
    return onScreen(root, actor => actor instanceof St.Label);
}

// The label under `root` that shows this text.
function labelled(root, text) {
    let label = labels(root).find(candidate => candidate.text == text);
    if (!label) throw new Error('Not on screen: ' + text);
    return label;
}

function roundButton(name) {
    return onScreen(button.menu.box, actor => actor instanceof St.Button && actor.accessible_name == name)[0];
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
    let [x, y] = actor.get_transformed_position();
    let [width, height] = actor.get_transformed_size();
    return [x + width / 2, y + height / 2];
}

async function pressButton(state) {
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, state);
    await Scripting.sleep(50);
}

// Turns the mouse wheel over the scrolled box that holds the actor, such as a long category, until the actor is in
// view, as a user does before clicking it.
async function scrollIntoView(actor) {
    let view = actor.get_parent();
    while (view && !(view instanceof St.ScrollView))
        view = view.get_parent();
    if (!view) return;
    let [, viewTop] = view.get_transformed_position();
    let viewBottom = viewTop + view.get_transformed_size()[1];
    let top = () => actor.get_transformed_position()[1];
    let bottom = () => top() + actor.get_transformed_size()[1];
    for (let turn = 0; top() < viewTop || bottom() > viewBottom; turn++) {
        if (turn == 50) throw new Error('Not scrolled into view');
        await pointAt(...middle(view));
        pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
            top() < viewTop ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
        await Scripting.sleep(50);
    }
}

async function click(actor) {
    await scrollIntoView(actor);
    await pointAt(...middle(actor));
    await pressButton(Clutter.ButtonState.PRESSED);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(100);
}

// Presses an actor, moves the pointer to the given place in steps, as a hand does, and lets go.
async function drag(actor, x, y) {
    let [startX, startY] = middle(actor);
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
    return labels(button).map(label => label.text);
}

// The items in the top bar, each an icon and its value.
function topBarItems() {
    return labels(button).map(label => label.get_parent());
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
// value in its header, and the box of its rows.
function category(name) {
    let item = labelled(button.menu.box, name).get_parent();
    let actors = button.menu.box.get_children();
    let header = item.get_children().find(actor => actor instanceof St.Label && actor != item.label);
    return {item, header, rows: actors[actors.indexOf(item) + 1]};
}

async function openCategory(name) {
    let {item, rows} = category(name);
    if (!rows.visible)
        await click(item);
    // Its rows have their places once it has slid open.
    await waitFor(() => rows.visible && rows.get_transition('height') === null, name + ' is open');
}

// The height of an actor in every frame while `act` runs and for a moment after.
async function heightsWhile(actor, act) {
    let heights = [];
    let painted = global.stage.connect('after-paint', () =>
        heights.push(actor.visible ? actor.get_allocation_box().get_height() : 0));
    await act();
    await Scripting.sleep(600);
    global.stage.disconnect(painted);
    return heights;
}

step('the top bar shows the sensors a new user starts with, and their values once they are read', async () => {
    await waitFor(() => topBarTexts().length == 3 && !topBarTexts().includes('…'), 'three values');
    equal(topBarTexts()[0].endsWith('%'), true, 'the memory usage first: ' + topBarTexts());
});

step('a click on the top bar opens the menu, with the categories in alphabetical order and a value in each header', async () => {
    await openMenu();
    equal(categoryNames().join(', '), 'Fan, Memory, Network, Processor, Storage, System, Temperature, Voltage',
        'the categories that are switched on');
    for (let name of ['Memory', 'Processor', 'System'])
        await waitFor(() => category(name).header.visible && category(name).header.text != '…', name + ' header');
});

step('a click on a category slides it open, and opening another slides the first one shut', async () => {
    let memory = category('Memory'), system = category('System');
    let opening = await heightsWhile(memory.rows, () => click(memory.item));
    equal(new Set(opening).size > 3, true, 'it slides open: ' + opening.length + ' frames');
    equal(memory.rows.visible, true);
    let closing = await heightsWhile(memory.rows, () => click(system.item));
    equal(new Set(closing).size > 3, true, 'the first one slides shut');
    equal(memory.rows.visible, false, 'and is hidden at the end');
    equal(system.rows.visible, true, 'the other one is open');
    await click(system.item);
    await Scripting.sleep(400);
    equal(system.rows.visible, false, 'a click closes it');
});

step('without the option for sliding, a category opens and closes at once', async () => {
    settings.set_boolean('animate-categories', false);
    let memory = category('Memory');
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

step('a category dropped onto another takes its place, and the alphabetical order sorts them again', async () => {
    await click(category('Memory').item);
    await waitFor(() => !category('Memory').rows.visible, 'Memory slid shut');
    let names = categoryNames();
    let [first, last] = [names[0], names.at(-1)];
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
    let items = topBarItems();
    let [lastX, lastY] = middle(items.at(-1));
    await drag(items[0], lastX + items.at(-1).width / 2 - 2, lastY);
    equal(topBarItems().map(item => items.indexOf(item)).join(','), '1,2,0');
    // Dropped onto the left half of the first item, it is first again.
    let [firstX, firstY] = topBarItems()[0].get_transformed_position();
    await drag(items[0], firstX + 2, firstY + items[0].height / 2);
    equal(topBarItems().map(item => items.indexOf(item)).join(','), '0,1,2');
});

step('the menu opens under the pointer, or under the middle of the top bar\'s sensors when the user wants that', async () => {
    let menuMiddle = () => middle(button.menu.box)[0];
    let [x, y] = button.get_transformed_position();
    let left = Math.round(x + button.width / 4);
    await pointAt(left, y + button.height / 2);
    await pressButton(Clutter.ButtonState.PRESSED);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - left) <= 1, true, 'by default under the pointer: ' + menuMiddle() + ' / ' + left);
    await closeMenu();
    settings.set_boolean('menu-centered', true);
    await pressButton(Clutter.ButtonState.PRESSED);
    await pressButton(Clutter.ButtonState.RELEASED);
    await Scripting.sleep(400);
    equal(Math.abs(menuMiddle() - middle(button)[0]) <= 1, true,
        'with the option under the middle of the item: ' + menuMiddle() + ' / ' + middle(button)[0]);
    await closeMenu();
    settings.reset('menu-centered');
});

step('with emphasized values the icons are lighter and the units are set off; without, everything is as strong', async () => {
    let look = () => {
        // The memory usage, whose value has a unit.
        let item = topBarItems().find(candidate => labels(candidate)[0].text.endsWith('%'));
        let icon = item.get_first_child();
        return {
            iconOpacity: icon.opacity, iconSize: icon.get_theme_node().get_length('icon-size'),
            unitMarked: /weight/.test(labels(item)[0].clutter_text.get_layout().get_attributes().to_string())
        };
    };
    let emphasized = look();
    equal(emphasized.iconOpacity < 255 && emphasized.unitMarked, true, 'by default');
    settings.set_boolean('emphasize-values', false);
    await Scripting.sleep(100);
    let plain = look();
    equal(plain.iconOpacity == 255 && !plain.unitMarked, true, 'with the option off');
    equal(plain.iconSize > emphasized.iconSize, true, 'and the icon has the size of the Shell\'s status icons');
    settings.reset('emphasize-values');
});

step('the Preferences button opens the preferences', async () => {
    await openMenu();
    await click(roundButton('Preferences'));
    let window = () => global.get_window_actors().map(actor => actor.meta_window).find(window => window.get_title()?.includes('Vitals'));
    await waitFor(window, 'the preferences window');
    window().delete(global.display.get_current_time_roundtrip());
    await waitFor(() => !window(), 'the preferences window closed');
});

export async function run() {
    // The Shell's helper process for automation scripts leaves by itself after half a minute, which is before this
    // test is done. Without this, the Shell tries to stop it at the end and ends with a failure.
    await Scripting.disableHelperAutoExit();
    await waitFor(() => Main.panel.statusArea.vitalsMenu, 'the extension is on');
    button = Main.panel.statusArea.vitalsMenu;
    settings = Main.extensionManager.lookup(UUID).stateObj.getSettings();
    // A test asks no service on the internet.
    settings.set_boolean('include-public-ip', false);
    let seat = global.stage.context.get_backend().get_default_seat();
    pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 'the overview is hidden');
    for (let [name, act] of steps) {
        await act();
        print('PASS ' + name);
    }
    print(steps.length + ' Shell checks passed');
}
