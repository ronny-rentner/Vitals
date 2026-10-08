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
import * as PanelValue from './panelValue.js';
import * as SensorCategories from './helpers/categories.js';
import {sensorPresent} from './helpers/storedCatalog.js';

let vitalsMenu;

// With fixed widths, a top-bar value keeps the room of its widest text until it has been shorter for this long.
// Values that keep changing length, such as a network speed, then do not push their neighbours around, and a
// value that stays shorter, such as free memory, gives the room back.
const WIDTH_MEMORY_SECONDS = 60;

// The "emphasize values" option draws top-bar icons and units lighter and smaller than the numbers, which are
// what is read. Each pair below is the value with the option on and with it off.
// The size of a top-bar icon, in em: a step smaller than the Shell's own status icons, or their size.
const PANEL_ICON_EM = {true: 1, false: 1.091};
// How strongly a top-bar icon is drawn. 255 is fully opaque.
const PANEL_ICON_OPACITY = {true: 165, false: 255};
// The distances in the top bar, as shares of the icon size.
// From the end of one top-bar item to the drawing of the next item's icon.
const PANEL_ITEM_GAP = 0.75;
// From the drawing of an icon to its value.
const PANEL_ICON_TEXT_GAP = 0.35;

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
            style_class: 'vitals-panel-menu'
        });
        this._menuLayout._delegate = this;

        this._syncPanelItems();
        this.add_child(this._menuLayout);
        this._refreshTimeoutId = null;

        this._connectSettingsSignals();

        this._initializeMenu();
        // The saved catalog is shown at once, with its last readings, until discovery and the first tick replace them.
        this._syncCatalog();

        this._sensors.onCatalogChanged = () => this._syncCatalog();
        this._sensors.onValuesChanged = recomputedSensors => this._render(recomputedSensors);
        this._discoverSensors();

        // start monitoring sensors
        this._initializeTimer();
    }

    _connectSettingsSignals() {
        this._settings.connectObject(
            'changed::update-time', this._initializeTimer.bind(this),
            'changed::position-in-panel', this._positionInPanelChanged.bind(this),
            'changed::allow-panel-dragging', this._redrawPanelItems.bind(this),
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
            'battery-slot', 'storage-path', 'hide-zeros'
        ])
            this._settings.connectObject('changed::' + setting, this._discoverSensors.bind(this), this);

        for (let setting of SensorCategories.colorSettingsKeys())
            this._settings.connectObject('changed::' + setting, () => this._render(), this);
    }

    _initializeMenu() {
        // The menu has a fixed width (stylesheet.css), so it does not change size with its values.
        this.menu.box.add_style_class_name('vitals-menu');

        // display sensor categories, in the alphabetical order of their names in the menu
        let menuName = name => _(this._ucFirst(name));
        for (let [name, category] of this._sensors.categories().sort(([a], [b]) => menuName(a).localeCompare(menuName(b))))
            this._initializeMenuGroup(name, category);

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

    _initializeMenuGroup(groupName, category) {
        this._groups[groupName] = new PopupMenu.PopupSubMenuMenuItem(_(this._ucFirst(groupName)), true);
        this._groups[groupName].icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(groupName));

        // hide menu items that user has requested to not include
        if (!category.enabled)
            this._groups[groupName].actor.hide();

        this._groups[groupName]._statusLabel = this._defaultLabel();
        this._groups[groupName].actor.insert_child_at_index(this._groups[groupName]._statusLabel, 4);
        this._groups[groupName]._statusLabel.text = _('No Data');

        // GNOME Shell slides a submenu open and shut only when it needs no scrollbar, and shows one with a scrollbar
        // at once. So that every category behaves the same, none is animated.
        let submenu = this._groups[groupName].menu;
        let openSubmenu = submenu.open.bind(submenu);
        let closeSubmenu = submenu.close.bind(submenu);
        submenu.open = () => openSubmenu(false);
        // The open category is still open when the menu is opened again. GNOME Shell closes the submenus after
        // the menu has closed, and that is the one close it asks for without any animation; it is left out.
        submenu.close = animation => {
            if (animation !== BoxPointer.PopupAnimation.NONE)
                closeSubmenu(false);
        };

        this._groups[groupName].menu.connectObject('open-state-changed', () => {
            if (!this.menu.isOpen) return;
            this._markShown();
            this._render();
        }, this);

        this.menu.addMenuItem(this._groups[groupName]);
    }

    _createRoundButton(iconName) {
        let button = new St.Button({
            style_class: 'message-list-clear-button button vitals-button-action'
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
            style_class: 'system-status-icon vitals-panel-icon-default',
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
        let item = new St.BoxLayout({
            style_class: 'vitals-panel-item',
            reactive: true,
        });
        this._menuLayout.add_child(item);

        let emphasizeValues = this._settings.get_boolean('emphasize-values');
        let iconEm = PANEL_ICON_EM[emphasizeValues];
        // The icon files have different amounts of empty room beside their drawings. The margins make up for
        // it, so that every drawing is the same distance from the item before it and from its own value.
        let [emptyLeft, emptyRight] = [0, 0];
        if (!this._settings.get_boolean('hide-icons')) {
            let iconStyle = ['original', 'gnome'][this._settings.get_int('icon-style')];
            [emptyLeft, emptyRight] = SensorCategories.iconInsets[iconStyle][this._sensorIcons[link.category][this._iconName(sensor)]];
            item.add_child(new St.Icon({
                style_class: 'system-status-icon vitals-panel-icon',
                style: 'icon-size: ' + iconEm + 'em; ' +
                    'margin-right: ' + ((PANEL_ICON_TEXT_GAP - emptyRight) * iconEm).toFixed(3) + 'em;',
                opacity: PANEL_ICON_OPACITY[emphasizeValues],
                reactive: true,
                gicon: gicon || Gio.icon_new_for_string(this._sensorIconPath(link.category, this._iconName(sensor)))
            }));
        }
        item.style = 'margin-left: ' + ((PANEL_ITEM_GAP - emptyLeft) * iconEm).toFixed(3) + 'em;';

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
                // A drag only holds the display still. Collection goes on, so the readings are current at the drop.
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
        let value = new PanelValue.PanelValue(emphasizeValues);
        value.style = formatted.style || null;
        value.setText(formatted.text, formatted.unit);
        this._panelItems.set(link, {item, value});
        // prevent "called on the widget"  "which is not in the stage" errors by adding before width below
        item.add_child(value);

        this._reserveWidth(sensor, value);
    }

    // support for fixed widths #55: gives a top-bar value the width kept free for it.
    _reserveWidth(sensor, value) {
        // A value has the font of the theme, and so its real width, only while it is on the stage. Items are
        // also built before the extension's button is in the top bar.
        if (!value.get_stage()) return;
        let reservedWidth = this._reservedWidth(sensor, value.textWidth);
        if (this._settings.get_boolean('fixed-widths') && value.width != reservedWidth)
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
        let hardwareOnly = this._settings.get_boolean('network-hardware-only');
        let aggregates = this._settings.get_boolean('include-aggregates');
        for (let [name, category] of this._sensors.categories()) {
            let rowsChanged = false;
            for (let sensor of category.sensors) {
                let row = this._rows.get(sensor);
                // Two options leave rows out: the interfaces that are not hardware, and the average, minimum and maximum.
                let wanted = sensorPresent(category, sensor) && !(hardwareOnly && this._isVirtualInterface(sensor)) &&
                    !(sensor.aggregate && !aggregates);
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
            // Discovery can give a sensor that has a row another label or section, for example when a saved
            // catalog from an earlier version is shown first.
            let rowsInOrder = this._sensorsInRowOrder(category).map(sensor => {
                let row = this._rows.get(sensor);
                if (row.label != _(sensor.label))
                    row.label = _(sensor.label);
                return row;
            });
            let menu = this._groups[name].menu;
            let rowsInMenu = menu._getMenuItems().filter(item => item != this._separators.get(name));
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
        this._markShown();
        this._render();
    }

    _isVirtualInterface(sensor) {
        return sensor.interface !== undefined && !sensor.hardware;
    }

    // The sensors of a category that have a row, in the order of their rows: by section where the sensors name
    // one, and inside a section by label.
    _sensorsInRowOrder(category) {
        return category.sensors.filter(sensor => this._rows.has(sensor)).sort((a, b) =>
            (a.section ?? 0) - (b.section ?? 0) ||
            // use natural sort order for system load, etc
            _(a.label).localeCompare(_(b.label), undefined, { numeric: true, sensitivity: 'base' }));
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
        for (let [name, category] of this._sensors.categories()) {
            category.shown = this.menu.isOpen && category.enabled;
            let rowsOnScreen = category.shown && this._groups[name].menu.isOpen;
            for (let sensor of category.sensors)
                sensor.shown = rowsOnScreen && this._rows.has(sensor);
        }
        for (let link of this._sensors.catalog.panel.sensors) {
            if (this._sensors.linkShown(link))
                link.sensor.shown = true;
        }
        this._sensors.shownChanged();
    }

    _formatted(categoryName, sensor) {
        // Threshold colours for one sensor name it by its category and key.
        return sensor.status == 'ready' || sensor.status == 'saved'
            ? this._formatter.format(sensor.value, sensor.format, categoryName, categoryName + '/' + sensor.key)
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
        let pinnedSensors = new Set([...this._panelItems.keys()].map(link => link.sensor));
        for (let [name, category] of this._sensors.categories()) {
            // Which sensor a header shows can change without that sensor's reading changing, so headers are always written.
            let headerLabel = this._groups[name]._statusLabel;
            let header = category.header;
            if (!header || !sensorPresent(category, header)) {
                headerLabel.hide();
            } else if (category.shown) {
                let formatted = this._formatted(name, header);
                headerLabel.visible = header.status != 'unavailable';
                if (headerLabel.text != formatted.text) headerLabel.text = formatted.text;
                if (headerLabel.style != formatted.style) headerLabel.style = formatted.style;
            }

            for (let sensor of category.sensors) {
                let row = this._rows.get(sensor);
                if (!row || !sensor.shown || !changed(sensor)) continue;
                let formatted = this._formatted(name, sensor);
                row.visible = sensor.status != 'unavailable';
                row.checked = pinnedSensors.has(sensor);
                if (row.value != formatted.text) row.value = formatted.text;
                if (row.valueStyle != formatted.style) row.valueStyle = formatted.style;
                if (sensor.country !== undefined && !row.gicon.equal(flagIcon(sensor)))
                    row.gicon = flagIcon(sensor);
            }
        }
        for (let [link, {item, value}] of this._panelItems) {
            let sensor = link.sensor;
            if (!changed(sensor)) continue;
            let formatted = this._formatted(link.category, sensor);
            item.visible = sensor.status != 'unavailable';
            if (value.text != formatted.text) value.setText(formatted.text, formatted.unit);
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
        let pinned = [...this._panelItems.keys()].some(link => link.sensor == sensor);
        let row = new MenuItem.MenuItem(gicon, sensor.key, _(sensor.label), '…', pinned);
        row.connect('toggle', () => {
            this._sensors.setPanelSensorVisible(categoryName, sensor, row.checked);
            if (this._dragging) return;
            this._syncPanelItems();
            this._markShown();
            this._render();
        });
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

    _ucFirst(string) {
        if (string == 'gpu') return 'Graphics';
        return string.charAt(0).toUpperCase() + string.slice(1);
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
        this._panelItems.clear();
        this._widths.clear();
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
