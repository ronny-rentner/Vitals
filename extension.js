import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St'

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

import * as Sensors from './sensors.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Formatter from './formatter.js';
import * as MenuItem from './menuItem.js';
import * as SensorCategories from './helpers/categories.js';
import {sensorPresent} from './helpers/storedCatalog.js';

let vitalsMenu;

// With fixed widths, a top-bar value keeps the room of its widest text until it has been shorter for this long.
// Values that keep changing length, such as a network speed, then do not push their neighbours around, and a
// value that stays shorter, such as free memory, gives the room back.
const WIDTH_MEMORY_SECONDS = 60;

// How long the panel with a sensor's actions takes to slide open or shut, and how strongly the rest of the menu is
// drawn while it is open. 255 is full strength.
const SENSOR_PANEL_MILLISECONDS = 150;
const SENSOR_PANEL_DIMMED_OPACITY = 90;

// How long a category takes to slide open or shut, as a submenu of GNOME Shell does.
const CATEGORY_SLIDE_MILLISECONDS = 250;

// The order of labels in the menu: natural order for numbers, so that "Core 2" comes before "Core 10".
// One collator for all comparisons; String.localeCompare with options builds a new one on every call.
const LABEL_ORDER = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

// The "emphasize values" option draws top-bar icons and units lighter and smaller than the numbers, which are
// what is read. The stylesheet makes the icons smaller and brings them closer (.vitals-panel-item-emphasized).
// How strongly a top-bar icon is drawn, with the option on and with it off. 255 is fully opaque.
const PANEL_ICON_OPACITY = {true: 165, false: 255};

var VitalsMenuButton = GObject.registerClass({
    GTypeName: 'VitalsMenuButton',
}, class VitalsMenuButton extends PanelMenu.Button {
    _init(extensionObject) {
        // 0.5: the menu's middle is under the point of this item that the menu is attached to (see _alignMenu).
        super._init(0.5);

        if (this._clickGesture)
            this._clickGesture.set_recognize_on_press(false);

        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();

        this._sensorIcons = SensorCategories.sensorCategories;

        // list with the prefixes for the according themes, the index of each
        // item must match the index on the combo box
        this._sensorsIconPathPrefix = ['/icons/original/', '/icons/gnome/'];

        // Category name to its submenu in the dropdown.
        this._groups = {};
        // What is on screen, held by the thing it shows: sensor to its menu row, panel link to its top-bar item
        // and value, and sensor to the width kept free for its top-bar text (for fixed widths, see _reservedWidth).
        this._clock = () => GLib.get_monotonic_time() / 1000000;
        this._rows = new Map();
        this._panelItems = new Map();
        this._widths = new Map();
        // Category name to the sensor whose value its header shows.
        this._headerSensors = new Map();
        // The panel with a sensor's actions that is open under the sensor's row, with what belongs to it: the
        // sensor, the actions, the panel's head, and what is dimmed while it is open.
        this._rowActions = {sensor: null, items: []};
        // The button at the bottom of the menu that puts the hidden sensors of all categories into the menu while
        // it is pressed in. This is not saved.
        this._hiddenButton = null;
        // Category name to the line above the rows that are set apart at its end, where there is one.
        this._separators = new Map();
        // The icon shown in the top bar while no sensor is.
        this._defaultItem = null;
        // The place on screen, as an x position, that the open menu is centred under.
        this._menuAnchorX = 0;
        this._dragging = false;

        this._sensors = new Sensors.Sensors(this._settings, _);
        this._formatter = new Formatter.Formatter(this._settings);
        this._menuLayout = new St.BoxLayout({
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            x_expand: true,
            style_class: 'vitals-panel-sensors'
        });
        this._menuLayout._delegate = this;

        this._syncPanelItems();
        this.add_child(this._menuLayout);
        this._refreshTimeoutId = null;

        this._connectSettingsSignals();

        this._initializeMenu();
        // Shows the saved catalog at once, before the hardware has been looked for.
        this._syncCatalog();

        this._sensors.onCatalogChanged = () => this._syncCatalog();
        this._sensors.onValuesChanged = recomputedSensors => this._render(recomputedSensors);
        // The collector reads what is on screen when the run ends; the timer's first tick is a whole update interval away.
        this._discoverSensors();

        // start monitoring sensors
        this._initializeTimer();
    }

    _connectSettingsSignals() {
        this._settings.connectObject(
            'changed::update-time', this._initializeTimer.bind(this),
            'changed::position-in-panel', this._positionInPanelChanged.bind(this),
            'changed::allow-panel-dragging', this._redrawPanelItems.bind(this),
            'changed::allow-category-dragging', this._rebuildCategories.bind(this),
            'changed::category-order', this._rebuildCategories.bind(this),
            'changed::emphasize-values', () => {
                // The texts get another width with another font.
                this._widths.clear();
                this._redrawPanelItems();
            },
            'changed::catalog', this._enabledCategoriesChanged.bind(this),
            'changed::network-hardware-only', this._syncCatalog.bind(this),
            'changed::include-aggregates', this._syncCatalog.bind(this),
            this);

        for (let setting of [
            'use-higher-precision', 'fixed-widths', 'hide-icons', 'unit', 'icon-style',
            'memory-measurement', 'network-public-ip-show-flag', 'network-speed-format', 'network-speed-unit',
            'storage-measurement'
        ])
            this._settings.connectObject('changed::' + setting, this._redrawMenu.bind(this), this);

        for (let setting of [
            'include-public-ip', 'network-public-ip-provider', 'include-static-info', 'include-static-gpu-info',
            'storage-locations', 'storage-monitor-volumes', 'hide-zeros'
        ])
            this._settings.connectObject('changed::' + setting, this._discoverSensors.bind(this), this);

        for (let setting of SensorCategories.colorSettingsKeys())
            this._settings.connectObject('changed::' + setting, () => this._render(), this);
    }

    _initializeMenu() {
        // The menu has a fixed width (stylesheet.css), so it does not change size with its values.
        this.menu.box.add_style_class_name('vitals-menu');

        // display sensor categories, in the alphabetical order of their names in the menu
        for (let name of this._categoriesInMenuOrder())
            this._initializeMenuGroup(name, this._sensors.catalog[name]);

        // add separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'vitals-menu-button-container'
        });

        let customButtonBox = new St.BoxLayout({
            style_class: 'vitals-button-box',
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            x_expand: true
        });

        // custom round refresh button
        let refreshButton = this._createRoundButton('view-refresh-symbolic', _('Refresh'));
        refreshButton.connect('clicked', (self) => {
            this._refresh();
        });
        customButtonBox.add_child(refreshButton);

        // custom round monitor button
        let monitorButton = this._createRoundButton('org.gnome.SystemMonitor-symbolic', _('System Monitor'));
        monitorButton.connect('clicked', (self) => {
            this.menu._getTopMenu().close();
            Util.spawn(this._settings.get_string('monitor-cmd').split(" "));
        });
        customButtonBox.add_child(monitorButton);

        // custom round preferences button
        let prefsButton = this._createRoundButton('preferences-system-symbolic', _('Preferences'));
        prefsButton.connect('clicked', (self) => {
            this.menu._getTopMenu().close();
            this._extensionObject.openPreferences();
        });
        customButtonBox.add_child(prefsButton);

        // A button that stays pressed in: while it is, the hidden sensors are in the menu, marked as hidden.
        this._hiddenButton = this._createRoundButton('view-conceal-symbolic', _('Show hidden sensors'));
        this._hiddenButton.toggle_mode = true;
        this._hiddenButton.connect('clicked', () => this._syncCatalog());
        customButtonBox.add_child(this._hiddenButton);

        // now add the buttons to the top bar
        item.actor.add_child(customButtonBox);

        // add buttons
        this.menu.addMenuItem(item);

        this.connectObject('notify::allocation', () => {
            if (this.menu.isOpen)
                this._anchorMenu();
        }, this);

        // Menu changes update demand without disturbing the shared polling schedule.
        this.menu.connectObject('open-state-changed', (menu, isMenuOpen) => {
            if (isMenuOpen)
                this._alignMenu();
            this._markShown();
            this._render();
            // A device plugged in since the last discovery is there when the menu opens.
            if (isMenuOpen)
                this._discoverSensors();
        }, this);
    }

    // Puts the menu's middle under the pointer when the pointer is on this item, as it is after a click, so the
    // menu appears where the user is looking. Opened from the keyboard, or with the "centered under panel sensors" option, its
    // middle is under the middle of the item. The Shell moves it back in when it would leave the screen.
    _alignMenu() {
        let [pointerX, pointerY] = global.get_pointer();
        let [itemX, itemY] = this.get_transformed_position();
        let pointerOnItem = pointerX >= itemX && pointerX <= itemX + this.width &&
            pointerY >= itemY && pointerY <= itemY + this.height;
        let underPointer = pointerOnItem && !this._settings.get_boolean('menu-centered');
        this._menuAnchorX = underPointer ? pointerX : itemX + this.width / 2;
        this._anchorMenu();
    }

    // Attaches the menu to the point of this item that is at the anchor. The Shell places a menu relative to its
    // item, and this item changes width with its values; attached to the same place on screen, the open menu
    // stays where it is.
    _anchorMenu() {
        // The Shell measures along the item's content, without its padding.
        let content = this.get_theme_node().get_content_box(this.get_allocation_box());
        let [itemX] = this.get_transformed_position();
        this.menu.setSourceAlignment((this._menuAnchorX - itemX - content.x1) / (content.x2 - content.x1));
    }

    // `position` is the category's place among the items of the menu; without one it is added at the end.
    _initializeMenuGroup(groupName, category, position) {
        this._groups[groupName] = new PopupMenu.PopupSubMenuMenuItem(_(SensorCategories.sensorCategories[groupName].name), true);
        this._groups[groupName].icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(groupName));

        // hide menu items that user has requested to not include
        if (!category.enabled)
            this._groups[groupName].actor.hide();

        this._groups[groupName]._statusLabel = this._defaultLabel();
        this._groups[groupName].actor.insert_child_at_index(this._groups[groupName]._statusLabel, 4);
        this._groups[groupName]._statusLabel.text = _('No Data');

        // GNOME Shell slides a submenu open and shut only when it needs no scrollbar, and shows one with a scrollbar
        // at once. So that every category behaves the same, the Shell's slide is never used: with the
        // "animate categories" option, every category slides the way described below, and without it none does.
        let submenu = this._groups[groupName].menu;
        let openSubmenu = submenu.open.bind(submenu);
        let closeSubmenu = submenu.close.bind(submenu);
        let slide = {duration: CATEGORY_SLIDE_MILLISECONDS, mode: Clutter.AnimationMode.EASE_OUT_EXPO};
        submenu.open = () => {
            // What the menu needs around its rows. It is measured while the menu is below its height limit, where
            // the menu asks for all it needs; at the limit it asks for less, so the largest value seen is kept.
            this._menuFrame = Math.max(this._menuFrame ?? 0,
                this.menu.actor.get_preferred_height(-1)[1] - this.menu.box.get_preferred_height(-1)[1]);
            // A category that is still sliding shut is closed for good now, so that only this one moves.
            for (let group of Object.values(this._groups))
                group.menu.actor.remove_all_transitions();
            // Inside this call the Shell closes the category that was open; see submenu.close.
            this._slideShutOnOpen = null;
            this._openingCategory = true;
            openSubmenu(false);
            this._openingCategory = false;
            // An empty submenu does not open.
            if (!submenu.isOpen || !this._settings.get_boolean('animate-categories')) return;
            // The slide ends at the height the submenu gets, not at the height of all its rows: what does not
            // fit under the menu's height limit is scrolled, and sliding past that would overshoot and jump back.
            // The menu asks for no more than its limit, so what its rows and frame need beyond that is the overflow.
            // The height an actor asks for includes its margins, and the height that is set on it does not.
            let [, heightOfAllRows] = submenu.actor.get_preferred_height(-1);
            let margins = submenu.actor.margin_top + submenu.actor.margin_bottom;
            let overflow = this.menu.box.get_preferred_height(-1)[1] + this._menuFrame - this.menu.actor.get_preferred_height(-1)[1];
            // The category that was open until now slides shut at the same time, as in a menu of GNOME Shell. It
            // starts only here, after the measuring above, which is of the menu without it.
            this._slideShutOnOpen?.();
            this._slideShutOnOpen = null;
            // A long category has its scrollbar from the start of the slide: the rows are narrower next to it, and
            // would jump sideways if it came at the end.
            submenu.actor.height = 0;
            submenu.actor.ease({height: heightOfAllRows - margins - overflow, ...slide,
                onStopped: () => submenu.actor.set_height(-1)});
        };
        submenu.close = animation => {
            // The open category is still open when the menu is opened again. GNOME Shell closes the submenus after
            // the menu has closed, and that is the one close it asks for without any animation; it is left out.
            if (!submenu.isOpen || animation === BoxPointer.PopupAnimation.NONE) return;
            let openHeight = submenu.actor.height;
            // Closing without the Shell's slide hides the submenu at once.
            closeSubmenu(false);
            if (!this._settings.get_boolean('animate-categories')) return;
            let slideShut = () => {
                submenu.actor.show();
                // As above: the height an actor reports includes its margins, and the height that is set on it does not.
                submenu.actor.height = openHeight - submenu.actor.margin_top - submenu.actor.margin_bottom;
                submenu.actor.ease({height: 0, ...slide, onStopped: () => {
                    submenu.actor.hide();
                    submenu.actor.set_height(-1);
                }});
            };
            // The user's own close asks for the full animation: a click on the category or the Left key. A category
            // that the Shell closes in the middle of another one's opening slides when that one has measured.
            // Any other close is at once.
            if (animation === BoxPointer.PopupAnimation.FULL)
                slideShut();
            else if (this._openingCategory)
                this._slideShutOnOpen = slideShut;
        };

        this._groups[groupName].menu.connectObject('open-state-changed', () => {
            if (!this.menu.isOpen) return;
            this._markShown();
            this._render();
        }, this);

        // A category is dragged onto another one to take that one's place. The Shell's drag and drop asks the
        // dragged actor's delegate, which for a menu item is the item itself, for what is dragged, and the item
        // under the pointer whether it takes the drop.
        let group = this._groups[groupName];
        group.getDragActor = () => new Clutter.Clone({source: group, width: group.width, height: group.height});
        group.getDragActorSource = () => group;
        let draggedCategory = source => Object.keys(this._groups).find(name => this._groups[name] == source);
        group.handleDragOver = source => draggedCategory(source) && source != group
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
        group.acceptDrop = source => {
            let draggedName = draggedCategory(source);
            if (!draggedName || source == group) return false;
            this._moveCategory(draggedName, groupName);
            return true;
        };
        // Dragging arranges the manual order, so there is none in the alphabetical one.
        if (this._settings.get_boolean('allow-category-dragging') &&
            this._settings.get_int('category-order') == SensorCategories.MANUAL_CATEGORY_ORDER)
            DND.makeDraggable(group);

        this.menu.addMenuItem(group, position);
    }

    // Builds the categories again, with their rows, in the order that holds now. This is how the two options for the
    // categories take effect while the menu exists: one changes their order, and the other whether they can be
    // dragged, which cannot be taken back from an actor.
    _rebuildCategories() {
        this._closeRowActions();
        for (let row of this._rows.values())
            row.destroy();
        this._rows.clear();
        for (let categoryName of [...this._separators.keys()])
            this._removeSeparator(categoryName);
        for (let group of Object.values(this._groups)) {
            // An open category closes when it is destroyed, and says so; by then other categories are gone.
            group.menu.disconnectObject(this);
            group.destroy();
        }
        this._groups = {};
        this._headerSensors.clear();
        for (let [position, name] of this._categoriesInMenuOrder().entries())
            this._initializeMenuGroup(name, this._sensors.catalog[name], position);
        this._syncCatalog();
    }

    // The names of the categories from the top of the menu to its end.
    _categoriesInMenuOrder() {
        return SensorCategories.categoriesInOrder(this._sensors.catalog, name => _(SensorCategories.sensorCategories[name].name),
            this._settings.get_int('category-order') == SensorCategories.MANUAL_CATEGORY_ORDER);
    }

    // Puts a category into the place of another one, which with those between moves one place on, and saves the order.
    _moveCategory(movedName, targetName) {
        let names = this._categoriesInMenuOrder();
        let targetPosition = names.indexOf(targetName);
        names.splice(names.indexOf(movedName), 1);
        names.splice(targetPosition, 0, movedName);
        this._sensors.setCategoryOrder(names);
        for (let [position, name] of names.entries()) {
            this.menu.moveMenuItem(this._groups[name], position);
            // The Shell moves a category without its rows, which are an actor of their own after it.
            this.menu.box.set_child_above_sibling(this._groups[name].menu.actor, this._groups[name]);
        }
    }

    // `name` is what a screen reader says for the button, which shows an icon only.
    _createRoundButton(iconName, name) {
        let button = new St.Button({
            style_class: 'message-list-clear-button button vitals-button-action',
            accessible_name: name
        });

        button.child = new St.Icon({
            icon_name: iconName
        });

        return button;
    }

    _initializeTimer() {
        this._destroyTimer();

        // used to query sensors and update display
        let update_time = this._settings.get_int('update-time');
        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            update_time,
            (self) => {
                this._querySensors();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _createDefaultItem() {
        this._defaultItem = new St.BoxLayout({
            style_class: 'vitals-panel-item',
            reactive: true,
        });
        this._menuLayout.add_child(this._defaultItem);
        this._defaultItem.add_child(new St.Icon({
            style_class: 'system-status-icon',
            reactive: true,
            gicon: Gio.icon_new_for_string(this._sensorIconPath('system'))
        }));
    }

    _removeDefaultItem() {
        if (this._defaultItem) {
            this._defaultItem.destroy();
            this._defaultItem = null;
        }
    }

    _createPanelItem(link, gicon) {
        let sensor = link.sensor;
        let emphasizeValues = this._settings.get_boolean('emphasize-values');
        let item = new St.BoxLayout({
            style_class: 'vitals-panel-item' + (emphasizeValues ? ' vitals-panel-item-emphasized' : ''),
            reactive: true,
        });
        this._menuLayout.add_child(item);

        if (!this._settings.get_boolean('hide-icons')) {
            item.add_child(new St.Icon({
                style_class: 'system-status-icon',
                opacity: PANEL_ICON_OPACITY[emphasizeValues],
                reactive: true,
                gicon: gicon || Gio.icon_new_for_string(this._sensorIconPath(link.category, this._iconName(sensor)))
            }));
        }

        if (this._settings.get_boolean('allow-panel-dragging')) {
            item._delegate = {
                link,
                vitalsMenu: this,
                getDragActor: () => {
                    let clone = new Clutter.Clone({ source: item });
                    item.connectObject('destroy', () => clone.destroy(), clone);
                    return clone;
                },
                getDragActorSource: () => item
            };
            let draggable = DND.makeDraggable(item);
            draggable.connect('drag-begin', () => {
                // While this is set, _render and _syncCatalog do nothing, so the items hold still under the pointer.
                this._dragging = true;
                this.menu.close();
            });
            draggable.connect('drag-end', () => {
                if (!this._dragging) return;
                this._dragging = false;
                this._syncCatalog();
            });
        }

        // The item starts with the value its sensor has, so a pin does not flash "…" or uncoloured text.
        let formatted = this._formatted(link.category, sensor);
        let value = new St.Label({ y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        // A value is never shortened with "…" (0 is the text engine's "do not shorten"): it gets the width it needs.
        value.clutter_text.ellipsize = 0;
        value.style = formatted.style || null;
        this._panelItems.set(link, {item, value});
        // The value is in the item before it gets its text: a text is measured in the font the item gives it.
        item.add_child(value);
        this._setPanelText(value, formatted);

        this._reserveWidth(sensor, value);
    }

    // Writes a top-bar value. With the "emphasize values" option the unit is smaller, thinner and lighter than the
    // number. It is marked inside the one text, so the text engine keeps both on one line of writing.
    _setPanelText(value, {text, unit}) {
        let escaped = part => GLib.markup_escape_text(part, -1);
        let markup = unit && this._settings.get_boolean('emphasize-values')
            ? escaped(text.slice(0, -unit.length)) + '<span size="85%" weight="normal" alpha="67%">' + escaped(unit) + '</span>'
            : escaped(text);
        // Set twice: after the first time, the Shell's text actor reports the width of the new text with the marks
        // of the text before it, and keeps doing so until the text is set again (seen in GNOME Shell 50.5).
        value.clutter_text.set_markup(markup);
        value.clutter_text.set_markup(markup);
    }

    // support for fixed widths #55: gives a top-bar value the width kept free for it.
    _reserveWidth(sensor, value) {
        // With the option off no width is remembered, so a width is kept from the moment the option is switched on.
        if (!this._settings.get_boolean('fixed-widths')) {
            this._widths.delete(sensor);
            return;
        }
        // A value has the font of the theme, and so its real width, only while it is on the stage. Items are
        // also built before the extension's button is in the top bar.
        if (!value.get_stage()) return;
        // The width the text needs, whatever width is set on the value. It has the theme's font once it is styled.
        value.ensure_style();
        let reservedWidth = this._reservedWidth(sensor, value.clutter_text.get_preferred_width(-1)[1]);
        if (value.width != reservedWidth)
            value.set_width(reservedWidth);
    }

    // Notes how wide a sensor's top-bar text is now and returns the width to keep free for it: the width it has
    // kept so far, unless the text needs more, or has needed less for WIDTH_MEMORY_SECONDS.
    _reservedWidth(sensor, textWidth) {
        let now = this._clock();
        let reserved = this._widths.get(sensor);
        if (!reserved || textWidth >= reserved.width || now - reserved.lastFilled >= WIDTH_MEMORY_SECONDS) {
            reserved = {width: textWidth, lastFilled: now};
            this._widths.set(sensor, reserved);
        }
        return reserved.width;
    }

    _removePanelItem(link) {
        this._panelItems.get(link).item.destroy();
        this._panelItems.delete(link);
    }

    handleDragOver(source) {
        if (!source || source.vitalsMenu != this)
            return DND.DragMotionResult.CONTINUE;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x) {
        if (!source || source.vitalsMenu != this)
            return false;

        let rtl = this._menuLayout.get_text_direction() == Clutter.TextDirection.RTL;
        let target = this._menuLayout.get_children().filter(item => item._delegate?.link).find(item =>
            rtl ? x > item.x + item.width / 2 : x < item.x + item.width / 2);
        if (target && target._delegate.link == source.link)
            return true;

        this._sensors.movePanelLink(source.link, target ? target._delegate.link : null);

        for (let link of this._sensors.catalog.panel.sensors) {
            if (this._panelItems.has(link))
                this._menuLayout.set_child_above_sibling(this._panelItems.get(link).item, null);
        }
        return true;
    }

    // The preferences window switched a category on or off in the saved catalog.
    _enabledCategoriesChanged() {
        if (!this._sensors.reloadEnabled()) return;
        for (let [name, category] of this._sensors.categories())
            this._groups[name].visible = category.enabled;
        if (this._dragging) return;
        this._syncPanelItems();
        this._markShown();
        this._render();
        this._sensors.discover();
    }

    // Brings the top bar in line with the panel links to show: removes the items whose link is no longer among
    // them and creates the ones that are missing, in the order of the links. Every other item stays as it is.
    _syncPanelItems() {
        let shownLinks = this._sensors.catalog.panel.sensors.filter(link => this._sensors.linkShown(link));
        for (let link of [...this._panelItems.keys()]) {
            if (!shownLinks.includes(link))
                this._removePanelItem(link);
        }
        if (shownLinks.length == 0) {
            if (!this._defaultItem) this._createDefaultItem();
            return;
        }

        for (let link of shownLinks) {
            // A public IP's row may show a country flag; its top-bar item starts with the same icon.
            if (!this._panelItems.has(link))
                this._createPanelItem(link, this._rows.get(link.sensor)?.gicon);
            this._menuLayout.set_child_above_sibling(this._panelItems.get(link).item, null);
        }
    }

    _positionInPanelChanged() {
        this.container.get_parent().remove_child(this.container);
        let position = this._positionInPanel();

        // allows easily addressable boxes
        let boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox
        };

        // update position when changed from preferences
        boxes[position[0]].insert_child_at_index(this.container, position[1]);
    }

    _redrawPanelItems() {
        if (this._dragging) return;
        for (let link of [...this._panelItems.keys()])
            this._removePanelItem(link);
        this._removeDefaultItem();
        this._syncPanelItems();
        this._markShown();
        this._render();
    }

    _redrawMenu() {
        for (let row of this._rows.values())
            row.destroy();
        this._rows.clear();
        for (let categoryName of [...this._separators.keys()])
            this._removeSeparator(categoryName);
        for (let groupName in this._groups)
            this._groups[groupName].icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(groupName));
        this._syncCatalog();
        this._redrawPanelItems();
    }

    _destroyTimer() {
        if (this._refreshTimeoutId != null) {
            GLib.Source.remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
    }

    // Brings the menu in line with the catalog: a sensor that is on the machine and has no row gets one, a row
    // whose sensor is gone is removed, and a row whose sensor got another label or place is relabelled or moved.
    // Every other row stays as it is.
    _syncCatalog() {
        if (this._dragging || this._sensors.destroyed) return;
        // Rows are placed by counting them, and the panel with a sensor's actions is not a row. So it is taken out
        // here and put back at the end, under its row where that is now.
        let actionsOpenFor = this._rowActions.sensor;
        this._closeRowActions();
        let hardwareOnly = this._settings.get_boolean('network-hardware-only');
        let aggregates = this._settings.get_boolean('include-aggregates');
        let pinnedSensors = new Set(this._sensors.catalog.panel.sensors.filter(link => link.visible).map(link => link.sensor));
        for (let [name, category] of this._sensors.categories()) {
            let rowsChanged = false;
            for (let sensor of category.sensors) {
                let row = this._rows.get(sensor);
                // A sensor the user hid has a row only while the button for hidden sensors is pressed in. Two
                // options leave rows out as well: the interfaces that are not hardware, and the average, minimum
                // and maximum.
                let wanted = sensorPresent(category, sensor) && (!sensor.hidden || this._hiddenButton.checked) &&
                    !(hardwareOnly && this._isVirtualInterface(sensor)) && !(sensor.aggregate && !aggregates);
                if (!row == !wanted) continue;
                // Rows are placed by counting rows, so the line between them is taken out while they change.
                if (!rowsChanged)
                    this._removeSeparator(name);
                rowsChanged = true;
                if (row) {
                    row.destroy();
                    this._rows.delete(sensor);
                } else {
                    this._addRow(name, category, sensor);
                }
            }
            // A sensor that has a row can get another label or section: the user renames it, or discovery does,
            // for example when a saved catalog from an earlier version is shown first.
            let rowsInOrder = this._sensorsInRowOrder(category).map(sensor => {
                let row = this._rows.get(sensor);
                if (row.label != this._label(sensor))
                    row.label = this._label(sensor);
                row.pinned = pinnedSensors.has(sensor);
                // The star marks the sensor whose value the category's header shows, whoever chose it.
                row.categoryDefault = sensor == category.header;
                row.hidden = Boolean(sensor.hidden);
                return row;
            });
            let menu = this._groups[name].menu;
            let rowsInMenu = menu._getMenuItems().filter(item => item instanceof MenuItem.MenuItem);
            if (rowsInOrder.some((row, position) => rowsInMenu[position] != row)) {
                this._removeSeparator(name);
                rowsChanged = true;
                for (let [position, row] of rowsInOrder.entries())
                    menu.moveMenuItem(row, position);
            }
            if (rowsChanged)
                this._placeSeparator(name, category);
        }
        this._syncPanelItems();
        // After the top bar, since the first action says whether the sensor is pinned there.
        if (this._rows.has(actionsOpenFor))
            this._toggleRowActions(this._rows.get(actionsOpenFor).categoryName, actionsOpenFor, false);
        this._markShown();
        this._render();
    }

    // What a sensor is called in the menu: the name the user gave it, or its own label.
    _label(sensor) {
        return sensor.customLabel ?? _(sensor.label);
    }

    // Closes the panel with a sensor's actions and brings the rest of the menu back to full strength. `animate`
    // lets the panel slide shut first, as when the user closes it.
    _closeRowActions(animate = false) {
        let {panel, dimmed = []} = this._rowActions;
        this._rowActions = {sensor: null, items: []};
        if (!panel) return;
        for (let actor of dimmed)
            actor.ease({opacity: 255, duration: animate ? SENSOR_PANEL_MILLISECONDS : 0});
        // A panel that slides shut is still there for a moment, and no longer takes part in anything.
        panel.actor.reactive = false;
        panel.actor.ease({height: 0, duration: animate ? SENSOR_PANEL_MILLISECONDS : 0, onStopped: () => panel.destroy()});
    }

    // Opens the panel with a sensor's actions under the sensor's row, or closes it when it is open there. A click on
    // the row does this. The panel is built like the menus in GNOME Shell's quick settings, such as the one for the
    // power mode: a card with the sensor's icon and name as its head, in the place where it belongs, and the rest
    // of the menu dimmed while it is open. `animate` lets it slide open.
    _toggleRowActions(categoryName, sensor, animate = true) {
        let openFor = this._rowActions.sensor;
        this._closeRowActions(animate);
        if (openFor == sensor) return;
        let row = this._rows.get(sensor);
        let pinned = [...this._panelItems.keys()].some(link => link.sensor == sensor);
        let header = new MenuItem.SensorHeader(row.gicon, this._label(sensor), this.menu.actor);
        let actions = [
            [_('Pin to top bar'), () => {
                this._sensors.setPanelSensorVisible(categoryName, sensor, !pinned);
                // Brings the top bar in line and puts the panel back, where this action then has its check mark or not.
                this._syncCatalog();
            }, pinned],
            // The action has its mark only for a sensor the user pinned there. A sensor the extension chose for the
            // header has the star in the list too, but here the action is still to be taken, and a click shows it.
            [_('Pin to category'), () => this._sensors.setCategoryDefault(categoryName, sensor.categoryDefault ? null : sensor),
                Boolean(sensor.categoryDefault), MenuItem.CATEGORY_PIN_ICON],
            [_('Rename'), () => header.editLabel(customLabel =>
                // The sensor's own label, typed in again, is no name of the user's.
                this._sensors.renameSensor(sensor, customLabel == _(sensor.label) ? '' : customLabel))],
            [_('Hide'), () => this._sensors.setSensorHidden(sensor, !sensor.hidden), Boolean(sensor.hidden)]
        ];
        let menu = this._groups[categoryName].menu;
        // The Shell's style class for such a menu gives the panel its colours in every theme; its sizes, which are
        // made for the large quick settings, are replaced in the stylesheet by those of this menu's rows.
        let panel = new PopupMenu.PopupMenuSection();
        panel.actor.add_style_class_name('quick-toggle-menu');
        panel.actor.add_style_class_name('vitals-sensor-panel');
        panel.actor.reactive = true;
        panel.addMenuItem(header);
        let items = actions.map(([label, act, checked, markIconName]) => {
            let action = new MenuItem.MenuAction(label, checked, markIconName);
            // The panel stays open after an action was used. Hiding ends it with the row.
            action.connect('chosen', act);
            panel.addMenuItem(action);
            return action;
        });
        menu.addMenuItem(panel, menu._getMenuItems().indexOf(row) + 1);

        // Everything but the panel is dimmed: the other parts of the menu, and the rows of the panel's own category.
        let dimmed = [...this.menu.box.get_children().filter(actor => actor != menu.actor),
            ...menu._getMenuItems().filter(item => item != panel).map(item => item.actor)];
        for (let actor of dimmed)
            actor.ease({opacity: SENSOR_PANEL_DIMMED_OPACITY, duration: animate ? SENSOR_PANEL_MILLISECONDS : 0});
        this._rowActions = {sensor, items, panel, header, dimmed};

        // The height an actor asks for includes its margins, and the height that is set on it does not.
        let openHeight = panel.actor.get_preferred_height(-1)[1] - panel.actor.margin_top - panel.actor.margin_bottom;
        panel.actor.height = 0;
        panel.actor.ease({height: openHeight, duration: animate ? SENSOR_PANEL_MILLISECONDS : 0,
            onStopped: () => panel.actor.set_height(-1)});

        // While the panel is open, a click anywhere else and the Escape key close it and do nothing else. The Shell
        // sends every event to the open menu only, so that is where they are seen. While the sensor's name is
        // typed, both belong to the field for it.
        this.menu.actor.connectObject('captured-event', (menuActor, event) => {
            if (header.editing) return Clutter.EVENT_PROPAGATE;
            let escape = event.type() == Clutter.EventType.KEY_PRESS && event.get_key_symbol() == Clutter.KEY_Escape;
            let press = event.type() == Clutter.EventType.BUTTON_PRESS || event.type() == Clutter.EventType.TOUCH_BEGIN;
            if (press) {
                let [x, y] = event.get_coords();
                let [left, top] = panel.actor.get_transformed_position();
                let [width, height] = panel.actor.get_transformed_size();
                press = x < left || x >= left + width || y < top || y >= top + height;
            }
            if (!escape && !press) return Clutter.EVENT_PROPAGATE;
            this._closeRowActions(true);
            return Clutter.EVENT_STOP;
        }, panel.actor);

        // Under a row at the lower edge of a long category, the panel opens outside of what is on screen, and a
        // renamed row moves to its new place with its panel. The category scrolls just far enough to show the
        // whole panel, also while the panel slides open. The panel's head says which sensor it is for, so the
        // row above it need not be on screen.
        let scrolling = menu.actor.vadjustment;
        let reveal = () => {
            let {y1: start, y2: end} = panel.actor.get_allocation_box();
            if (end > scrolling.value + scrolling.page_size)
                scrolling.value = end - scrolling.page_size;
            if (start < scrolling.value)
                scrolling.value = start;
        };
        // The panel gets its place and the category gets its new length in the same layout, in an order that is
        // the Shell's; the panel is on screen once both have happened.
        panel.actor.connect('notify::allocation', reveal);
        scrolling.connectObject('notify::upper', reveal, panel.actor);
    }

    _isVirtualInterface(sensor) {
        return sensor.interface !== undefined && !sensor.hardware;
    }

    // The sensors of a category that have a row, in the order of their rows: by section where the sensors name
    // one, and inside a section by label.
    _sensorsInRowOrder(category) {
        // Each label is translated once, not once per comparison.
        return category.sensors.filter(sensor => this._rows.has(sensor))
            .map(sensor => ({sensor, section: sensor.section ?? 0, label: this._label(sensor)}))
            .sort((a, b) => a.section - b.section || LABEL_ORDER.compare(a.label, b.label))
            .map(({sensor}) => sensor);
    }

    _removeSeparator(categoryName) {
        if (this._separators.has(categoryName)) {
            this._separators.get(categoryName).destroy();
            this._separators.delete(categoryName);
        }
    }

    // Draws a line above the rows that are set apart from the sensors of the machine, at the end of a category:
    // the virtual network interfaces, and the average, minimum and maximum.
    _placeSeparator(categoryName, category) {
        let firstRowSetApart = this._sensorsInRowOrder(category)
            .findIndex(sensor => this._isVirtualInterface(sensor) || sensor.aggregate);
        if (firstRowSetApart <= 0) return;
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separators.set(categoryName, separator);
        this._groups[categoryName].menu.addMenuItem(separator, firstRowSetApart);
    }

    // Marks in the catalog what is on screen: the header of every category in the open menu, the rows of every
    // open category, and the sensors in the top bar. The collector reads what is marked.
    _markShown() {
        let marksChanged = false;
        let mark = (sensorOrCategory, shown) => {
            if (sensorOrCategory.shown !== shown) {
                sensorOrCategory.shown = shown;
                marksChanged = true;
            }
        };
        let sensorsInPanel = new Set(this._sensors.catalog.panel.sensors
            .filter(link => this._sensors.linkShown(link)).map(link => link.sensor));
        for (let [name, category] of this._sensors.categories()) {
            mark(category, this.menu.isOpen && category.enabled);
            let rowsOnScreen = category.shown && this._groups[name].menu.isOpen;
            for (let sensor of category.sensors)
                mark(sensor, sensorsInPanel.has(sensor) || (rowsOnScreen && this._rows.has(sensor)));
        }
        // This runs on every tick; the collector is told only when what is on screen changed.
        if (marksChanged)
            this._sensors.shownChanged();
    }

    _formatted(categoryName, sensor) {
        // A colour scale for one sensor names it by its category and key.
        return sensor.status == 'ready' || sensor.status == 'saved'
            ? this._formatter.format(sensor.value, sensor.format, categoryName, categoryName + '/' + sensor.key, sensor.lowIsBad)
            : {text: '…', style: ''};
    }

    // The icon of the sensor's category, or the arrow for a download or upload value.
    _iconName(sensor) {
        return sensor.direction ? 'icon-' + sensor.direction : 'icon';
    }

    // Writes the readings of the given sensors to what shows them, or of every sensor on screen when called without any.
    _render(changedSensors = null) {
        if (this._dragging || this._sensors.destroyed) return;
        let changed = sensor => !changedSensors || changedSensors.has(sensor);
        let showFlag = this._settings.get_boolean('network-public-ip-show-flag');
        let flagIcon = sensor => {
            let country = showFlag ? sensor.country : '';
            let icon = country && /^[a-z]{2}$/.test(country) && country != 'xx' ? 'icon-' + country : 'icon';
            return Gio.icon_new_for_string(this._sensorIconPath('network', icon));
        };
        for (let [name, category] of this._sensors.categories()) {
            let headerLabel = this._groups[name]._statusLabel;
            let header = category.header;

            if (!header || !sensorPresent(category, header)) {
                headerLabel.hide();
                this._headerSensors.delete(name);
            // A header is written when its sensor has a new reading, and when it shows another sensor than before.
            } else if (category.shown && (changed(header) || this._headerSensors.get(name) != header)) {
                this._headerSensors.set(name, header);
                let formatted = this._formatted(name, header);
                headerLabel.visible = header.status != 'unavailable';
                if (headerLabel.text != formatted.text) headerLabel.text = formatted.text;
                if (headerLabel.style != formatted.style) headerLabel.style = formatted.style;
            }
        }
        // This runs once for every source that was read, so it only touches the rows of the sensors that changed.
        for (let sensor of changedSensors ?? this._rows.keys()) {
            let row = this._rows.get(sensor);
            if (!row || !sensor.shown) continue;
            let formatted = this._formatted(row.categoryName, sensor);
            row.visible = sensor.status != 'unavailable';
            if (row.value != formatted.text) row.value = formatted.text;
            if (row.valueStyle != formatted.style) row.valueStyle = formatted.style;
            if (sensor.country !== undefined && !row.gicon.equal(flagIcon(sensor)))
                row.gicon = flagIcon(sensor);
        }
        for (let [link, {item, value}] of this._panelItems) {
            let sensor = link.sensor;
            if (!changed(sensor)) continue;
            let formatted = this._formatted(link.category, sensor);
            item.visible = sensor.status != 'unavailable';
            if (value.text != formatted.text) this._setPanelText(value, formatted);
            if (value.style != formatted.style) value.style = formatted.style;
            this._reserveWidth(sensor, value);
            let icon = item.get_first_child();
            if (sensor.country !== undefined && icon instanceof St.Icon && !icon.gicon.equal(flagIcon(sensor)))
                icon.gicon = flagIcon(sensor);
        }
        let visible = [...this._panelItems.values()].some(({item}) => item.visible);
        if (!visible && !this._defaultItem)
            this._createDefaultItem();
        else if (visible)
            this._removeDefaultItem();
    }

    _addRow(categoryName, category, sensor) {
        let gicon = Gio.icon_new_for_string(this._sensorIconPath(categoryName, this._iconName(sensor)));
        let row = new MenuItem.MenuItem(gicon, categoryName, this._label(sensor), '…');
        row.connect('clicked', () => this._toggleRowActions(categoryName, sensor));
        this._rows.set(sensor, row);
        this._groups[categoryName].menu.addMenuItem(row, this._sensorsInRowOrder(category).indexOf(sensor));
    }

    _defaultLabel() {
        return new St.Label({
               y_expand: true,
                y_align: Clutter.ActorAlign.CENTER
        });
    }

    _sensorIconPath(sensor, icon = 'icon') {
        // allows country flags to show
        const icons = this._sensorIcons[sensor];
        if (sensor === 'network' && icon.startsWith('icon-') && !(icons && icons[icon])) {
            let cc = icon.slice('icon-'.length);
            if (/^[a-z]{2}$/.test(cc))
                return this._extensionObject.path + '/icons/flags/1x1/' + cc + '.svg';
        }

        const iconPathPrefixIndex = this._settings.get_int('icon-style');
        return this._extensionObject.path + this._sensorsIconPathPrefix[iconPathPrefixIndex] + icons[icon];
    }

    _positionInPanel() {
        let alignment = '';
        let gravity = 0;

        switch (this._settings.get_int('position-in-panel')) {
            case 0: // left
                alignment = 'left';
                gravity = -1;
                break;
            case 1: // center
                alignment = 'center';
                gravity = -1;
                break;
            case 2: // right
                alignment = 'right';
                gravity = 0;
                break;
            case 3: // far left
                alignment = 'left';
                gravity = 0;
                break;
            case 4: // far right
                alignment = 'right';
                gravity = -1;
                break;
        }

        return [alignment, gravity];
    }

    async _discoverSensors() {
        await this._sensors.discover();
        if (this._sensors.destroyed || this._dragging) return;
        this._markShown();
    }

    _querySensors(force = false) {
        this._markShown();
        return this._sensors.poll(force);
    }

    // What the Refresh button does: look for sensors again, then read every shown value now, ignoring source intervals.
    async _refresh() {
        await this._discoverSensors();
        if (this._sensors.destroyed) return;
        await this._querySensors(true);
    }

    destroy() {
        this._dragging = false;
        this._destroyTimer();
        this._sensors.destroy();

        this._settings.disconnectObject(this);
        this.menu.disconnectObject(this);

        this._rows.clear();
        this._hiddenButton = null;
        this._rowActions = {sensor: null, items: []};
        this._panelItems.clear();
        this._widths.clear();
        this._headerSensors.clear();
        this._separators.clear();
        this._defaultItem = null;

        super.destroy();
    }
});

export default class VitalsExtension extends Extension {
    enable() {
        vitalsMenu = new VitalsMenuButton(this);
        let position = vitalsMenu._positionInPanel();
        Main.panel.addToStatusArea('vitalsMenu', vitalsMenu, position[1], position[0]);
    }

    disable() {
        vitalsMenu.destroy();
        vitalsMenu = null;
    }
}
