import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
// A row menu slides open and shut in half of it, as a menu of the quick settings does.
import {POPUP_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Sensors from './sensors.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Formatter from './formatter.js';
import * as MenuItem from './menuItem.js';
import {CroppedIcon} from './croppedIcon.js';
import * as SensorCategories from './helpers/categories.js';
import {sensorPresent} from './helpers/storedCatalog.js';

let vitalsMenu;

// With fixed widths, a top-bar value keeps the room of its widest text until it has been shorter for this long.
// Values that keep changing length, such as a network speed, then do not push their neighbours around, and a
// value that stays shorter, such as free memory, gives the room back.
const WIDTH_MEMORY_SECONDS = 60;

// How strongly the rest of the menu is drawn while a row menu is open. 255 is full strength.
const ROW_MENU_DIMMED_OPACITY = 90;

// The folders under icons/ of the icon styles, in the order of the `icon-style` setting.
const ICON_STYLE_DIRECTORIES = ['original', 'gnome'];

// How long a category takes to slide open, as a submenu of GNOME Shell does.
const CATEGORY_OPEN_MILLISECONDS = 250;
// How long a category takes to slide shut when no other one opens.
const CATEGORY_CLOSE_MILLISECONDS = 200;

// The order of labels in the menu: natural order for numbers, so that "Core 2" comes before "Core 10".
const LABEL_ORDER = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

// Icon opacity with "Emphasize values" on or off; 255 is opaque.
const PANEL_ICON_OPACITY = {true: 165, false: 255};

// Where Vitals sits in the top bar for each value of the enum `position-in-panel`, far left to far right: a box of
// the top bar and the index in it, 0 for the box's start and -1 for its end.
const PANEL_POSITIONS = [['left', 0], ['left', -1], ['center', -1], ['right', 0], ['right', -1]];

var VitalsMenuButton = GObject.registerClass({GTypeName: 'VitalsMenuButton'},
    // eslint-disable-next-line no-shadow -- Keep the class name in GObject diagnostics and stack traces.
    class VitalsMenuButton extends PanelMenu.Button {
        _init(extensionObject) {
        // 0.5: the menu's middle is under the point of this item that the menu is attached to (see _alignMenu).
            super._init(0.5);

            this._clickGesture.set_recognize_on_press(false);

            this._extensionObject = extensionObject;
            this._settings = extensionObject.getSettings();

            // Icons are found by name in the user's icon theme, so that a theme can replace any of ours. The folder of
            // the chosen icon style is searched last and has all of ours. Each name is looked up once, until the user
            // switches the icon theme or the style.
            this._iconTheme = new St.IconTheme();
            this._icons = new Map();
            this._applyIconStyle();
            this._iconTheme.connectObject('changed', () => {
                this._icons.clear();
                this._redrawMenu();
            }, this);

            // Category name to its submenu in the dropdown.
            this._categoryMenus = {};
            this._clock = () => GLib.get_monotonic_time() / 1000000;
            // Sensor objects identify their menu rows and top-bar items, including rows in collapsed categories.
            this._rows = new Map();
            this._panelItems = new Map();
            // Category name to the category pin whose value its category header shows.
            this._shownCategoryPins = new Map();
            // The row menu that is open under a sensor's row, with what belongs to it: the sensor, the actions, the
            // menu's head, and what is dimmed while it is open.
            this._rowMenu = {sensor: null, items: []};
            // The button at the bottom of the menu that puts the hidden sensors of all categories into the menu while
            // it is pressed in. This is not saved.
            this._hiddenButton = null;
            // Category name to the line above the rows that are set apart at its end, where there is one.
            this._separators = new Map();
            // The icon shown in the top bar while no sensor is.
            this._placeholderIcon = null;
            // The place on screen, as an x position, that the open menu is centred under.
            this._menuAnchorX = 0;
            this._dragging = false;

            this._sensors = new Sensors.Sensors(this._settings, _);
            // The session starts: a top-bar value keeps its room of the last session for a minute from now, or, without
            // remembered widths, starts without room (-1 is the text's own width).
            for (const sensor of this._sensors.panelSensors()) {
                sensor.runtime.reservedWidthLastFilled = this._clock();
                if (!this._settings.get_boolean('remember-widths'))
                    sensor.reservedWidth = -1;
            }
            this._formatter = new Formatter.Formatter(this._settings);
            this._menuLayout = new St.BoxLayout({
                clip_to_allocation: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                x_expand: true,
                style_class: 'vitals-panel-sensors',
            });
            this._menuLayout._delegate = this;

            this._syncPanelItems();
            this.add_child(this._menuLayout);
            this._refreshTimeoutId = null;

            this._connectSettingsSignals();
            // Saves the reserved widths of the top-bar values for the next start. GNOME Shell destroys the button also
            // when it exits, without switching the extension off.
            this.connect('destroy', () => {
                this._sensors.save();
                this._destroyTimer();
                this._sensors.destroy();
            });

            this._initializeMenu();
            // Shows the saved catalog at once, before the hardware has been looked for.
            this._syncMenuRows();

            this._sensors.onCatalogChanged = () => this._syncMenuRows();
            this._sensors.onValuesChanged = recomputedSensors => this._render(recomputedSensors);
            // Discovery starts the initial readings; the timer's first tick is a whole update interval away.
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
                'changed::catalog-settings', this._enabledCategoriesChanged.bind(this),
                'changed::network-hardware-only', this._syncMenuRows.bind(this),
                'changed::memory-show-details', this._syncMenuRows.bind(this),
                'changed::include-aggregates', this._syncMenuRows.bind(this),
                this);

            for (const setting of ['emphasize-values', 'fixed-widths']) {
                this._settings.connectObject(`changed::${setting}`, () => {
                // Old widths no longer apply after a font change or restarting steady widths.
                    for (const sensor of this._sensors.panelSensors())
                        sensor.reservedWidth = -1;
                    this._redrawPanelItems();
                }, this);
            }

            for (const setting of [
                'use-higher-precision', 'hide-icons', 'unit',
                'memory-measurement', 'network-speed-format', 'network-speed-unit',
                'storage-measurement',
            ])
                this._settings.connectObject(`changed::${setting}`, this._redrawMenu.bind(this), this);
            this._settings.connectObject('changed::icon-style', () => {
                this._applyIconStyle();
                this._redrawMenu();
            }, this);

            for (const setting of [
                'include-public-ip', 'include-static-info', 'include-static-gpu-info', 'use-processor-cpufreq',
                'include-processor-cores', 'include-core-temperatures', 'use-powercap',
                'storage-locations', 'storage-monitor-volumes', 'hide-zeros',
            ])
                this._settings.connectObject(`changed::${setting}`, this._discoverSensors.bind(this), this);

            for (const setting of SensorCategories.colorSettingsKeys())
                this._settings.connectObject(`changed::${setting}`, () => this._render(), this);
        }

        _initializeMenu() {
        // The menu has a fixed width (stylesheet.css), so it does not change size with its values.
            this.menu.box.add_style_class_name('vitals-menu');

            for (const name of this._categoriesInMenuOrder())
                this._initializeMenuGroup(name, this._sensors.catalog[name]);

            // add separator
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                style_class: 'vitals-menu-button-container',
            });

            const customButtonBox = new St.BoxLayout({
                style_class: 'vitals-button-box',
                clip_to_allocation: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                x_expand: true,
            });

            // custom round refresh button
            const refreshButton = this._createRoundButton('view-refresh-symbolic', _('Refresh'));
            refreshButton.add_style_class_name('vitals-button-refresh');
            refreshButton.connect('clicked', () => {
                this._refresh();
            });
            customButtonBox.add_child(refreshButton);

            // custom round monitor button
            const monitorButton = this._createRoundButton('org.gnome.SystemMonitor-symbolic', _('System Monitor'));
            monitorButton.add_style_class_name('vitals-button-monitor');
            monitorButton.connect('clicked', () => {
                this.menu._getTopMenu().close();
                Util.spawn(this._settings.get_string('monitor-cmd').split(' '));
            });
            customButtonBox.add_child(monitorButton);

            // custom round preferences button
            const prefsButton = this._createRoundButton('preferences-system-symbolic', _('Preferences'));
            prefsButton.add_style_class_name('vitals-button-preferences');
            prefsButton.connect('clicked', () => {
                this.menu._getTopMenu().close();
                this._extensionObject.openPreferences();
            });
            customButtonBox.add_child(prefsButton);

            // A button that stays pressed in: while it is, the hidden sensors are in the menu, marked as hidden. As in
            // GNOME's password fields, its icon and name say what a click does.
            this._hiddenButton = this._createRoundButton('view-reveal-symbolic', _('Show hidden sensors'));
            this._hiddenButton.add_style_class_name('vitals-button-hidden-sensors');
            this._hiddenButton.toggle_mode = true;
            this._hiddenButton.connect('clicked', () => {
                const shown = this._hiddenButton.checked;
                this._hiddenButton.child.icon_name = shown ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
                this._hiddenButton.accessible_name = shown ? _('Leave out hidden sensors') : _('Show hidden sensors');
                this._syncMenuRows();
            });
            customButtonBox.add_child(this._hiddenButton);

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
                // Look for devices connected since the last discovery.
                if (isMenuOpen)
                    this._discoverSensors();
            }, this);
        }

        // Puts the menu's middle under the pointer when the pointer is on this item, as it is after a click, so the
        // menu appears where the user is looking. Opened from the keyboard, or with the "centered under panel sensors" option, its
        // middle is under the middle of the item. The Shell moves it back in when it would leave the screen.
        _alignMenu() {
            const [pointerX, pointerY] = global.get_pointer();
            const [itemX, itemY] = this.get_transformed_position();
            const pointerOnItem = pointerX >= itemX && pointerX <= itemX + this.width &&
            pointerY >= itemY && pointerY <= itemY + this.height;
            const underPointer = pointerOnItem && !this._settings.get_boolean('menu-centered');
            this._menuAnchorX = underPointer ? pointerX : itemX + this.width / 2;
            this._anchorMenu();
        }

        // Attaches the menu to the point of this item that is at the anchor. The Shell places a menu relative to its
        // item, and this item changes width with its values; attached to the same place on screen, the open menu
        // stays where it is.
        _anchorMenu() {
        // The Shell measures along the item's content, without its padding.
            const content = this.get_theme_node().get_content_box(this.get_allocation_box());
            const [itemX] = this.get_transformed_position();
            this.menu.setSourceAlignment((this._menuAnchorX - itemX - content.x1) / (content.x2 - content.x1));
        }

        // `position` is the category's place among the items of the menu; without one it is added at the end.
        _initializeMenuGroup(groupName, category, position) {
            const group = new PopupMenu.PopupSubMenuMenuItem(_(SensorCategories.sensorCategories[groupName].name), true);
            this._categoryMenus[groupName] = group;
            group.add_style_class_name('vitals-category-header');
            group.label.add_style_class_name('vitals-category-name');
            group.icon.gicon = this._gicon(groupName);

            // hide menu items that user has requested to not include
            if (!category.runtime.enabled)
                group.actor.hide();

            group._statusLabel = this._defaultLabel();
            group._statusLabel.add_style_class_name('vitals-category-value');
            group.actor.insert_child_at_index(group._statusLabel, 4);

            // GNOME Shell slides a submenu open and shut only when it needs no scrollbar, and shows one with a scrollbar
            // at once. So that every category behaves the same, the Shell's slide is never used: with the
            // "animate categories" option, every category slides the way described below, and without it none does.
            const submenu = group.menu;
            const openSubmenu = submenu.open.bind(submenu);
            const closeSubmenu = submenu.close.bind(submenu);
            submenu.open = () => {
            // What the menu needs around its rows. It is measured while the menu is below its height limit, where
            // the menu asks for all it needs; at the limit it asks for less, so the largest value seen is kept.
                this._menuFrame = Math.max(this._menuFrame ?? 0,
                    this.menu.actor.get_preferred_height(-1)[1] - this.menu.box.get_preferred_height(-1)[1]);
                // A category that is still sliding shut is closed for good now, so that only this one moves.
                for (const categoryHeader of Object.values(this._categoryMenus))
                    categoryHeader.menu.actor.remove_all_transitions();
                // Inside this call the Shell closes the category that was open; see submenu.close.
                this._slideShutOnOpen = null;
                this._openingCategory = true;
                openSubmenu(false);
                this._openingCategory = false;
                // GNOME Shell lets a submenu have a scrollbar only when the menu was at its height limit as it opened, so
                // a row menu would sometimes give the category a scrollbar and sometimes make the menu taller than the
                // screen. Every category may have one, whatever the menu's height was.
                submenu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
                // An empty submenu does not open.
                if (!submenu.isOpen || !this._settings.get_boolean('animate-categories'))
                    return;
                // The slide ends at the height the submenu gets, not at the height of all its rows: what does not
                // fit under the menu's height limit is scrolled, and sliding past that would overshoot and jump back.
                // The menu asks for no more than its limit, so what its rows and frame need beyond that is the overflow.
                // The height an actor asks for includes its margins, and the height that is set on it does not.
                const [, heightOfAllRows] = submenu.actor.get_preferred_height(-1);
                const margins = submenu.actor.margin_top + submenu.actor.margin_bottom;
                const overflow = this.menu.box.get_preferred_height(-1)[1] + this._menuFrame - this.menu.actor.get_preferred_height(-1)[1];
                // The category that was open until now slides shut at the same time, as in a menu of GNOME Shell. It
                // starts only here, after the measuring above, which is of the menu without it.
                this._slideShutOnOpen?.(group.actor);
                this._slideShutOnOpen = null;
                // A long category has its scrollbar from the start of the slide: the rows are narrower next to it, and
                // would jump sideways if it came at the end. One that fits has none while it slides, though its rows do
                // not fit the growing height yet; afterwards a row menu can still make it long enough for one.
                if (overflow <= 0)
                    submenu.actor.vscrollbar_policy = St.PolicyType.NEVER;
                // The theme's margin under the submenu grows with it, or it would take its room at once.
                const marginBottom = submenu.actor.margin_bottom;
                submenu.actor.margin_bottom = 0;
                submenu.actor.height = 0;
                submenu.actor.ease({
                    height: heightOfAllRows - margins - overflow, margin_bottom: marginBottom, duration: CATEGORY_OPEN_MILLISECONDS,
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO, onStopped: () => {
                        submenu.actor.set_height(-1);
                        submenu.actor.margin_bottom = marginBottom;
                        submenu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
                    },
                });
            };
            submenu.close = animation => {
            // The open category is still open when the menu is opened again. GNOME Shell closes the submenus after
            // the menu has closed, and that is the one close it asks for without any animation; it is left out.
                if (!submenu.isOpen || animation === BoxPointer.PopupAnimation.NONE)
                    return;
                const openHeight = submenu.actor.height;
                // Closing without the Shell's slide hides the submenu at once.
                closeSubmenu(false);
                if (!this._settings.get_boolean('animate-categories'))
                    return;
                // `openingHeader` is the header of the category that opens while this one shuts, if one does.
                const slideShut = openingHeader => {
                    submenu.actor.show();
                    // As above: the height an actor reports includes its margins, and the height that is set on it does not.
                    submenu.actor.height = openHeight - submenu.actor.margin_top - submenu.actor.margin_bottom;
                    // While another category opens, both slide at the same speed, so that the rows between and below them
                    // move in step.
                    const duration = openingHeader ? CATEGORY_OPEN_MILLISECONDS : CATEGORY_CLOSE_MILLISECONDS;
                    // The theme's margin under the submenu shrinks with it, or it would give its room back only at the end.
                    const marginBottom = submenu.actor.margin_bottom;
                    submenu.actor.ease({
                        height: 0, margin_bottom: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_EXPO, onStopped: () => {
                            submenu.actor.hide();
                            submenu.actor.set_height(-1);
                            submenu.actor.margin_bottom = marginBottom;
                        },
                    });
                };
                // The user's own close asks for the full animation: a click on the category or the Left key. A category
                // that the Shell closes in the middle of another one's opening slides when that one has measured.
                // Any other close is at once.
                if (animation === BoxPointer.PopupAnimation.FULL)
                    slideShut();
                else if (this._openingCategory)
                    this._slideShutOnOpen = slideShut;
            };

            submenu.connectObject('open-state-changed', () => {
                if (!this.menu.isOpen)
                    return;
                this._markShown();
                this._render();
            }, this);

            // A category is dragged onto another one to take that one's place. The Shell's drag and drop asks the
            // dragged actor's delegate, which for a menu item is the item itself, for what is dragged, and the item
            // under the pointer whether it takes the drop.
            group.getDragActor = () => new Clutter.Clone({source: group, width: group.width, height: group.height});
            group.getDragActorSource = () => group;
            const draggedCategory = source => Object.keys(this._categoryMenus).find(name => this._categoryMenus[name] === source);
            group.handleDragOver = source => draggedCategory(source) && source !== group
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
            group.acceptDrop = source => {
                const draggedName = draggedCategory(source);
                if (!draggedName || source === group)
                    return false;
                this._moveCategory(draggedName, groupName);
                return true;
            };
            // Dragging arranges the manual order, so there is none in the alphabetical one.
            if (this._settings.get_boolean('allow-category-dragging') &&
            this._settings.get_int('category-order') === SensorCategories.MANUAL_CATEGORY_ORDER)
                DND.makeDraggable(group);

            this.menu.addMenuItem(group, position);
        }

        // Builds the categories again, with their rows, in the order that holds now. This is how the two options for the
        // categories take effect while the menu exists: one changes their order, and the other whether they can be
        // dragged, which cannot be taken back from an actor.
        _rebuildCategories() {
            this._closeRowMenu();
            for (const row of this._rows.values())
                row.destroy();
            this._rows.clear();
            for (const categoryName of [...this._separators.keys()])
                this._removeSeparators(categoryName);
            for (const group of Object.values(this._categoryMenus)) {
            // An open category closes when it is destroyed, and says so; by then other categories are gone.
                group.menu.disconnectObject(this);
                group.destroy();
            }
            this._categoryMenus = {};
            this._shownCategoryPins.clear();
            for (const [position, name] of this._categoriesInMenuOrder().entries())
                this._initializeMenuGroup(name, this._sensors.catalog[name], position);
            this._syncMenuRows();
        }

        // The names of the categories from the top of the menu to its end.
        _categoriesInMenuOrder() {
            return SensorCategories.categoriesInOrder(this._sensors.catalog, name => _(SensorCategories.sensorCategories[name].name),
                this._settings.get_int('category-order') === SensorCategories.MANUAL_CATEGORY_ORDER);
        }

        // Puts a category into the place of another one, which with those between moves one place on, and saves the order.
        _moveCategory(movedName, targetName) {
            const names = this._categoriesInMenuOrder();
            const targetPosition = names.indexOf(targetName);
            names.splice(names.indexOf(movedName), 1);
            names.splice(targetPosition, 0, movedName);
            this._sensors.setCategoryOrder(names);
            for (const [position, name] of names.entries()) {
                this.menu.moveMenuItem(this._categoryMenus[name], position);
                // The Shell moves a category without its rows, which are an actor of their own after it.
                this.menu.box.set_child_above_sibling(this._categoryMenus[name].menu.actor, this._categoryMenus[name]);
            }
        }

        // `name` is what a screen reader says for the button, which shows an icon only.
        _createRoundButton(iconName, name) {
            const button = new St.Button({
                style_class: 'button vitals-button-action',
                accessible_name: name,
            });

            button.child = new St.Icon({
                icon_name: iconName,
            });

            return button;
        }

        _initializeTimer() {
            this._destroyTimer();

            this._refreshTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._settings.get_int('update-time'),
                () => {
                    this._readSensors();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _createPlaceholderIcon() {
            this._placeholderIcon = new St.BoxLayout({
                style_class: 'vitals-panel-item',
                reactive: true,
            });
            this._menuLayout.add_child(this._placeholderIcon);
            this._placeholderIcon.add_child(new CroppedIcon({
                style_class: 'system-status-icon',
                reactive: true,
                gicon: this._gicon('system'),
            }));
        }

        _removePlaceholderIcon() {
            if (this._placeholderIcon) {
                this._placeholderIcon.destroy();
                this._placeholderIcon = null;
            }
        }

        _createPanelItem(sensor) {
            const emphasizeValues = this._settings.get_boolean('emphasize-values');
            const item = new St.BoxLayout({
                style_class: `vitals-panel-item${emphasizeValues ? ' vitals-panel-item-emphasized' : ''}`,
                reactive: true,
            });
            this._menuLayout.add_child(item);

            let icon = null;
            if (!this._settings.get_boolean('hide-icons')) {
                icon = new CroppedIcon({
                    style_class: 'system-status-icon',
                    opacity: PANEL_ICON_OPACITY[emphasizeValues],
                    reactive: true,
                    gicon: this._gicon(sensor.category, sensor),
                });
                item.add_child(icon);
            }

            if (this._settings.get_boolean('allow-panel-dragging')) {
                item._delegate = {
                    sensor,
                    vitalsMenu: this,
                    getDragActor: () => {
                        const clone = new Clutter.Clone({source: item});
                        item.connectObject('destroy', () => clone.destroy(), clone);
                        return clone;
                    },
                    getDragActorSource: () => item,
                };
                const draggable = DND.makeDraggable(item);
                draggable.connect('drag-begin', () => {
                // While this is set, _render and _syncMenuRows do nothing, so the items hold still under the pointer.
                    this._dragging = true;
                    this.menu.close();
                });
                draggable.connect('drag-end', () => {
                    if (!this._dragging)
                        return;
                    this._dragging = false;
                    this._syncMenuRows();
                });
            }

            // The item starts with the value its sensor has, so a pin does not flash "…" or uncoloured text.
            const formatted = this._formatted(sensor.category, sensor);
            const value = new St.BoxLayout({style_class: 'vitals-panel-value', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const numberLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            const unitLabel = new St.Label({
                style_class: 'vitals-panel-unit',
                opacity: emphasizeValues ? Math.round(255 * 0.67) : 255,
                y_align: Clutter.ActorAlign.CENTER,
            });
            numberLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            unitLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            value.add_child(numberLabel);
            value.add_child(unitLabel);
            const baseline = label => label.y + label.clutter_text.y +
                label.clutter_text.get_layout().get_baseline() / Pango.SCALE / label.clutter_text.get_resource_scale();
            unitLabel.clutter_text.connect('notify::allocation', () => {
                // Translation aligns the text baselines without requesting another layout.
                unitLabel.translation_y = baseline(numberLabel) - baseline(unitLabel);
            });
            value.style = formatted.style || null;
            const panelItem = {item, icon, value, numberLabel, unitLabel};
            this._panelItems.set(sensor, panelItem);
            // The value is in the item before it gets its text: a text is measured in the font the item gives it.
            item.add_child(value);
            this._setPanelText(panelItem, formatted);

            this._updateSteadyWidth(sensor, panelItem);
        }

        _setPanelText({numberLabel, unitLabel}, {text, unit = ''}) {
            const numberText = unit ? text.slice(0, -unit.length) : text;
            const unitText = unit.trimStart();
            if (numberLabel.text !== numberText)
                numberLabel.text = numberText;
            if (unitLabel.text !== unitText)
                unitLabel.text = unitText;
            unitLabel.visible = Boolean(unitText);
        }

        // Measures the text of a top-bar value and, with steady widths, widens the value to its widest text so far, and
        // narrows it to the text once the text has been narrower for WIDTH_MEMORY_SECONDS.
        _updateSteadyWidth(sensor, {value, numberLabel, unitLabel}) {
            if (!this._settings.get_boolean('fixed-widths'))
                return;
            // A value has the font of the theme, and so its real width, only while it is on the stage. Items are also
            // built before the extension's button is in the top bar.
            if (value.get_stage()) {
            // The width the text needs, whatever width is set on the value. It has the theme's font once it is styled.
                value.ensure_style();
                const textWidth = numberLabel.get_preferred_width(-1)[1] +
                    (unitLabel.visible ? unitLabel.get_preferred_width(-1)[1] + value.get_theme_node().get_length('spacing') : 0);
                const now = this._clock();
                // The text has not filled the room for a minute.
                const reservedWidthIsUnused = now - sensor.runtime.reservedWidthLastFilled >= WIDTH_MEMORY_SECONDS;
                // A text that fills the room, or needs more, gets it; unused room is given back.
                if (textWidth >= sensor.reservedWidth || reservedWidthIsUnused) {
                    sensor.reservedWidth = textWidth;
                    sensor.runtime.reservedWidthLastFilled = now;
                }
            }
            value.set_width(sensor.reservedWidth);
        }

        _removePanelItem(sensor) {
            this._panelItems.get(sensor).item.destroy();
            this._panelItems.delete(sensor);
        }

        handleDragOver(source) {
            if (!source || source.vitalsMenu !== this)
                return DND.DragMotionResult.CONTINUE;

            return DND.DragMotionResult.MOVE_DROP;
        }

        acceptDrop(source, actor, x) {
            if (!source || source.vitalsMenu !== this)
                return false;

            const rtl = this._menuLayout.get_text_direction() === Clutter.TextDirection.RTL;
            const target = this._menuLayout.get_children().find(item => item._delegate?.sensor &&
                (rtl ? x > item.x + item.width / 2 : x < item.x + item.width / 2));
            if (target && target._delegate.sensor === source.sensor)
                return true;

            this._sensors.movePanelSensor(source.sensor, target ? target._delegate.sensor : null);

            for (const sensor of this._sensors.panelSensors()) {
                const panelItem = this._panelItems.get(sensor);
                if (panelItem)
                    this._menuLayout.set_child_above_sibling(panelItem.item, null);
            }
            return true;
        }

        // The preferences window changed a switch in catalog-settings.
        _enabledCategoriesChanged() {
            if (!this._sensors.reloadEnabled())
                return;
            for (const [name, category] of this._sensors.categories())
                this._categoryMenus[name].visible = category.runtime.enabled;
            if (this._dragging)
                return;
            this._syncPanelItems();
            this._markShown();
            this._render();
            this._sensors.discover();
        }

        // Brings the top bar in line with the sensors to show there: removes the items whose sensor is no longer among
        // them and creates the ones that are missing, in the panel's order. Every other item stays as it is.
        _syncPanelItems() {
            const shownPanelSensors = this._sensors.panelSensors().filter(sensor => this._sensors.hasPanelItem(sensor));
            for (const sensor of [...this._panelItems.keys()]) {
                if (!shownPanelSensors.includes(sensor))
                    this._removePanelItem(sensor);
            }
            if (shownPanelSensors.length === 0) {
                if (!this._placeholderIcon)
                    this._createPlaceholderIcon();
                return;
            }

            for (const sensor of shownPanelSensors) {
                if (!this._panelItems.has(sensor))
                    this._createPanelItem(sensor);
                this._menuLayout.set_child_above_sibling(this._panelItems.get(sensor).item, null);
            }
        }

        _positionInPanelChanged() {
            this.container.get_parent().remove_child(this.container);
            const position = this._positionInPanel();

            // allows easily addressable boxes
            const boxes = {
                left: Main.panel._leftBox,
                center: Main.panel._centerBox,
                right: Main.panel._rightBox,
            };

            // update position when changed from preferences
            boxes[position[0]].insert_child_at_index(this.container, position[1]);
        }

        _redrawPanelItems() {
            if (this._dragging)
                return;
            for (const sensor of [...this._panelItems.keys()])
                this._removePanelItem(sensor);
            this._removePlaceholderIcon();
            this._syncPanelItems();
            this._markShown();
            this._render();
        }

        _redrawMenu() {
            const rowMenuOpenFor = this._rowMenu.sensor;
            this._closeRowMenu();
            for (const row of this._rows.values())
                row.destroy();
            this._rows.clear();
            for (const categoryName of [...this._separators.keys()])
                this._removeSeparators(categoryName);
            for (const groupName in this._categoryMenus)
                this._categoryMenus[groupName].icon.gicon = this._gicon(groupName);
            this._syncMenuRows();
            const row = this._rows.get(rowMenuOpenFor);
            if (row)
                this._toggleRowMenu(row.categoryName, rowMenuOpenFor, false);
            this._redrawPanelItems();
        }

        _destroyTimer() {
            if (this._refreshTimeoutId != null) {
                GLib.Source.remove(this._refreshTimeoutId);
                this._refreshTimeoutId = null;
            }
        }

        // Retain existing row actors when sensors still pass the menu's display filters.
        _syncMenuRows() {
            if (this._dragging || this._sensors.destroyed)
                return;
            // Rows are placed by counting them, and a row menu is not a row. So it is taken out here and put back at
            // the end, under its row where that is now.
            const rowMenuOpenFor = this._rowMenu.sensor;
            this._closeRowMenu();
            const hardwareOnly = this._settings.get_boolean('network-hardware-only');
            const aggregates = this._settings.get_boolean('include-aggregates');
            const memoryDetails = this._settings.get_boolean('memory-show-details');
            for (const [name, category] of this._sensors.categories()) {
                const categoryPin = this._sensors.categoryPin(name);
                let rowsChanged = false;
                for (const sensor of category.sensors) {
                    const row = this._rows.get(sensor);
                    // The hidden-sensors button reveals individually hidden rows; category display filters still apply.
                    const wanted = sensorPresent(category, sensor) && (!sensor.hidden || this._hiddenButton.checked) &&
                    !(hardwareOnly && this._isVirtualInterface(sensor)) && !(sensor.aggregate && !aggregates) &&
                    !(name === 'memory' && sensor.section === 1 && !memoryDetails);
                    if (Boolean(row) === wanted)
                        continue;
                    // Rows are placed by counting rows, so the line between them is taken out while they change.
                    if (!rowsChanged)
                        this._removeSeparators(name);
                    rowsChanged = true;
                    if (row) {
                        row.destroy();
                        this._rows.delete(sensor);
                    } else {
                        this._addRow(name, category, sensor);
                    }
                }
                // A sensor that has a row can get another label, icon or section: the user renames it, or discovery does,
                // for example when a saved catalog from an earlier version is shown first.
                const rowsInOrder = this._sensorsInRowOrder(category).map(sensor => {
                    const row = this._rows.get(sensor);
                    const label = this._label(sensor);
                    if (row.label !== label)
                        row.label = label;
                    const gicon = this._gicon(name, sensor);
                    if (!row.gicon.equal(gicon))
                        row.gicon = gicon;
                    row.pinned = sensor.panelPosition !== undefined;
                    // The star marks the category pin, whoever chose it.
                    row.categoryPin = sensor === categoryPin;
                    row.hidden = Boolean(sensor.hidden);
                    return row;
                });
                const menu = this._categoryMenus[name].menu;
                const rowsInMenu = menu._getMenuItems().filter(item => item instanceof MenuItem.MenuItem);
                if (rowsInOrder.some((row, position) => rowsInMenu[position] !== row)) {
                    this._removeSeparators(name);
                    rowsChanged = true;
                    for (const [position, row] of rowsInOrder.entries())
                        menu.moveMenuItem(row, position);
                }
                if (rowsChanged)
                    this._placeSeparators(name, category);
            }
            this._syncPanelItems();
            // After the top bar, since the first action says whether the sensor is pinned there.
            const row = this._rows.get(rowMenuOpenFor);
            if (row)
                this._toggleRowMenu(row.categoryName, rowMenuOpenFor, false);
            this._markShown();
            this._render();
        }

        // What a sensor is called in the menu: the name the user gave it, or its own label.
        _label(sensor) {
            return sensor.customLabel ?? _(sensor.label);
        }

        // Closes the row menu and brings the rest of the menu back to full strength. `animate` lets the row menu slide
        // shut first, as when the user closes it.
        _closeRowMenu(animate = false) {
            const {rowMenu, menu, dimmed = []} = this._rowMenu;
            this._rowMenu = {sensor: null, items: []};
            if (!rowMenu)
                return;
            for (const actor of dimmed)
                actor.ease({opacity: 255, duration: animate ? POPUP_ANIMATION_TIME / 2 : 0});
            // While the row menu slides shut, the category keeps the scrollbar it has, or keeps having none. Left to GNOME
            // Shell, the scrollbar shows and hides from frame to frame, also when the rows fit.
            if (animate)
                menu.actor.vscrollbar_policy = menu.actor.vscrollbar_visible ? St.PolicyType.ALWAYS : St.PolicyType.NEVER;
            rowMenu.actor.reactive = false;
            rowMenu.actor.ease({
                height: 0, duration: animate ? POPUP_ANIMATION_TIME / 2 : 0, onStopped: () => {
                    if (animate)
                        menu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
                    rowMenu.destroy();
                },
            });
        }

        // Opens the row menu under the sensor's row, or closes it when it is open there. A click on the row does this.
        // The row menu is built like the menus in GNOME Shell's quick settings, such as the one for the power mode: a
        // card with the sensor's icon and name as its head, in the place where it belongs, and the rest of the menu
        // dimmed while it is open. `animate` lets it slide open.
        _toggleRowMenu(categoryName, sensor, animate = true) {
            const openFor = this._rowMenu.sensor;
            this._closeRowMenu(animate);
            if (openFor === sensor)
                return;
            const row = this._rows.get(sensor);
            const pinned = sensor.panelPosition !== undefined;
            const header = new MenuItem.SensorHeader(row.gicon, this._label(sensor), this.menu.actor);
            header.connect('button-press-event', (actor, event) => {
                if (header.editing || ![Clutter.BUTTON_PRIMARY, Clutter.BUTTON_SECONDARY].includes(event.get_button()))
                    return Clutter.EVENT_PROPAGATE;
                this._closeRowMenu(true);
                return Clutter.EVENT_STOP;
            });
            const actions = [
                ['vitals-action-pin-top-bar', _('Pin to top bar'), () => {
                    this._sensors.pinToPanel(sensor, !pinned);
                    // Brings the top bar in line and puts the row menu back, where this action then has its check mark or not.
                    this._syncMenuRows();
                }, pinned],
                // The action has its mark only for a sensor the user pinned there. The default pin has the star in the
                // list too, but here the action is still to be taken, and a click shows it.
                ['vitals-action-pin-category', _('Pin to category'), () => this._sensors.pinToCategory(categoryName, sensor.pinnedToCategory ? null : sensor),
                    Boolean(sensor.pinnedToCategory), MenuItem.CATEGORY_PIN_ICON],
                ['vitals-action-rename', _('Rename'), () => header.editLabel(customLabel =>
                // The sensor's own label, typed in again, is no name of the user's.
                    this._sensors.renameSensor(sensor, customLabel === _(sensor.label) ? '' : customLabel))],
                ['vitals-action-hide', _('Hide'), () => this._sensors.setSensorHidden(sensor, !sensor.hidden), Boolean(sensor.hidden)],
            ];
            const menu = this._categoryMenus[categoryName].menu;
            // The Shell's style class for such a menu gives the row menu its colours in every theme; its sizes, which are
            // made for the large quick settings, are replaced in the stylesheet by those of this menu's rows.
            const rowMenu = new PopupMenu.PopupMenuSection();
            rowMenu.actor.add_style_class_name('quick-toggle-menu');
            rowMenu.actor.add_style_class_name('vitals-row-menu');
            rowMenu.actor.reactive = true;
            // While it slides, the row menu shows only what fits in its height, as a submenu of GNOME Shell does.
            rowMenu.actor.clip_to_allocation = true;
            rowMenu.addMenuItem(header);
            const items = actions.map(([styleClass, label, act, checked, markIconName]) => {
                const action = new MenuItem.MenuAction(label, checked, markIconName);
                action.add_style_class_name(styleClass);
                // The row menu stays open after an action was used. Hiding ends it with the row.
                action.connect('chosen', act);
                rowMenu.addMenuItem(action);
                return action;
            });
            menu.addMenuItem(rowMenu, menu._getMenuItems().indexOf(row) + 1);

            // Everything but the row menu is dimmed: the other parts of the menu, and the rows of its own category.
            const dimmed = [...this.menu.box.get_children().filter(actor => actor !== menu.actor),
                ...menu._getMenuItems().filter(item => item !== rowMenu).map(item => item.actor)];
            for (const actor of dimmed)
                actor.ease({opacity: ROW_MENU_DIMMED_OPACITY, duration: animate ? POPUP_ANIMATION_TIME / 2 : 0});
            this._rowMenu = {sensor, items, rowMenu, menu, header, dimmed};

            // The height an actor asks for includes its margins, and the height that is set on it does not.
            const openHeight = rowMenu.actor.get_preferred_height(-1)[1] - rowMenu.actor.margin_top - rowMenu.actor.margin_bottom;
            // While the row menu slides open, the category has the scrollbar it needs with the row menu open, as measured
            // here before the slide. Left to GNOME Shell, the scrollbar shows and hides from frame to frame, also when the
            // rows fit. What the menu's rows and frame need beyond the menu's height limit is scrolled in the category.
            const overflow = this.menu.box.get_preferred_height(-1)[1] + this._menuFrame - this.menu.actor.get_preferred_height(-1)[1];
            if (animate)
                menu.actor.vscrollbar_policy = overflow > 0 ? St.PolicyType.ALWAYS : St.PolicyType.NEVER;
            rowMenu.actor.height = 0;
            rowMenu.actor.ease({
                height: openHeight, duration: animate ? POPUP_ANIMATION_TIME / 2 : 0,
                onStopped: () => {
                    rowMenu.actor.set_height(-1);
                    if (animate)
                        menu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
                },
            });

            // Consume outside clicks after closing the row menu, so they cannot activate another item.
            // During renaming, the entry handles those clicks instead.
            this.menu.actor.connectObject('captured-event', (menuActor, event) => {
                if (header.editing)
                    return Clutter.EVENT_PROPAGATE;
                if (event.type() !== Clutter.EventType.BUTTON_PRESS && event.type() !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                const [x, y] = event.get_coords();
                const [left, top] = rowMenu.actor.get_transformed_position();
                const [width, height] = rowMenu.actor.get_transformed_size();
                if (x >= left && x < left + width && y >= top && y < top + height)
                    return Clutter.EVENT_PROPAGATE;
                this._closeRowMenu(true);
                return Clutter.EVENT_STOP;
            }, rowMenu.actor);

            // Under a row at the lower edge of a long category, the row menu opens outside of what is on screen, and a
            // renamed row moves to its new place with its row menu. The category scrolls just far enough to show the
            // whole row menu, also while it slides open. The row menu's head says which sensor it is for, so the row
            // above it need not be on screen.
            const scrolling = menu.actor.vadjustment;
            const reveal = () => {
                const {y1: start, y2: end} = rowMenu.actor.get_allocation_box();
                if (end > scrolling.value + scrolling.page_size)
                    scrolling.value = end - scrolling.page_size;
                if (start < scrolling.value)
                    scrolling.value = start;
            };
            // The row menu gets its place and the category gets its new length in the same layout, in an order that is
            // the Shell's; the row menu is on screen once both have happened.
            rowMenu.actor.connect('notify::allocation', reveal);
            scrolling.connectObject('notify::upper', reveal, rowMenu.actor);
        }

        _isVirtualInterface(sensor) {
            return sensor.interface !== undefined && !sensor.hardware;
        }

        // The sensors of a category that have a row, in the order of their rows: by section where the sensors name
        // one, inside a section by heading, an explicit order where given, and then by label.
        _sensorsInRowOrder(category) {
        // Each label is translated once, not once per comparison.
            return category.sensors.filter(sensor => this._rows.has(sensor))
            .map(sensor => ({sensor, section: sensor.section ?? 0, heading: sensor.heading ?? '', order: sensor.order ?? 0, label: this._label(sensor)}))
            .sort((a, b) => a.section - b.section || LABEL_ORDER.compare(a.heading, b.heading) || a.order - b.order || LABEL_ORDER.compare(a.label, b.label))
            .map(({sensor}) => sensor);
        }

        _removeSeparators(categoryName) {
            for (const separator of this._separators.get(categoryName) ?? [])
                separator.destroy();
            this._separators.delete(categoryName);
        }

        // Draws a line above the rows set apart at the end of a category: the virtual network interfaces, and the
        // aggregates. Where the rows fall into several groups by heading, rows without one being a group too, each
        // heading names its rows.
        _placeSeparators(categoryName, category) {
            const sensors = this._sensorsInRowOrder(category);
            const setApart = sensor => this._isVirtualInterface(sensor) || sensor.aggregate;
            const headings = new Set(sensors.map(sensor => sensor.heading ?? ''));
            const separators = [];
            // From the last row up, so that the positions of the rows above stay as they are.
            for (let position = sensors.length - 1; position >= 0; position--) {
                const [sensor, above] = [sensors[position], sensors[position - 1]];
                // A group by heading begins with its heading; rows without one after a heading's rows begin with a line.
                const newGroup = headings.size > 1 && (sensor.heading ?? '') !== (above?.heading ?? '');
                if (!newGroup && !(above && setApart(sensor) && !setApart(above)))
                    continue;
                const separator = new PopupMenu.PopupSeparatorMenuItem(newGroup && sensor.heading ? _(sensor.heading) : '');
                separators.push(separator);
                this._categoryMenus[categoryName].menu.addMenuItem(separator, position);
            }
            this._separators.set(categoryName, separators);
        }

        // Open categories need readings even for rows outside the scroll viewport or awaiting recovery.
        _markShown() {
            let marksChanged = false;
            const mark = (sensorOrCategory, shown) => {
                if (sensorOrCategory.runtime.shown !== shown) {
                    sensorOrCategory.runtime.shown = shown;
                    marksChanged = true;
                }
            };
            for (const [name, category] of this._sensors.categories()) {
                mark(category, this.menu.isOpen && category.runtime.enabled);
                const categoryRowsShown = category.runtime.shown && this._categoryMenus[name].menu.isOpen;
                for (const sensor of category.sensors)
                    mark(sensor, this._sensors.hasPanelItem(sensor) || (categoryRowsShown && this._rows.has(sensor)));
            }
            // Avoid recalculating active sources on ticks that leave the marks unchanged.
            if (marksChanged)
                this._sensors.shownChanged();
        }

        _formatted(categoryName, sensor) {
        // A colour scale for one sensor names it by its category and key.
            return sensor.status === 'ready'
                ? this._formatter.format(sensor.value, sensor.format, categoryName, `${categoryName}/${sensor.key}`, sensor.lowIsBad, sensor.runtime.rounding)
                : {text: '…', style: ''};
        }

        _render(changedSensors = null) {
            if (this._dragging || this._sensors.destroyed)
                return;
            const changed = sensor => !changedSensors || changedSensors.has(sensor);
            for (const [name, category] of this._sensors.categories()) {
                const headerLabel = this._categoryMenus[name]._statusLabel;
                const categoryPin = this._sensors.categoryPin(name);

                if (!categoryPin) {
                    headerLabel.hide();
                    this._shownCategoryPins.delete(name);
                    // A category header is written when its category pin has a new reading, and when the pin is another sensor than before.
                } else if (category.runtime.shown && (changed(categoryPin) || this._shownCategoryPins.get(name) !== categoryPin)) {
                    this._shownCategoryPins.set(name, categoryPin);
                    const formatted = this._formatted(name, categoryPin);
                    headerLabel.visible = categoryPin.status !== 'unavailable';
                    if (headerLabel.text !== formatted.text)
                        headerLabel.text = formatted.text;
                    if (headerLabel.style !== formatted.style)
                        headerLabel.style = formatted.style;
                }
            }
            // Read callbacks supply changed sensors; display-setting changes can request all rows.
            for (const sensor of changedSensors ?? this._rows.keys()) {
                const row = this._rows.get(sensor);
                if (!row || !sensor.runtime.shown)
                    continue;
                const formatted = this._formatted(row.categoryName, sensor);
                row.visible = sensor.status !== 'unavailable';
                if (row.value !== formatted.text)
                    row.value = formatted.text;
                if (row.valueStyle !== formatted.style)
                    row.valueStyle = formatted.style;
                // A reading can change a sensor's icon, such as the bars of a WiFi signal.
                const gicon = this._gicon(row.categoryName, sensor);
                if (row.gicon !== gicon)
                    row.gicon = gicon;
            }
            for (const [sensor, panelItem] of this._panelItems) {
                if (!changed(sensor))
                    continue;
                const {item, icon, value} = panelItem;
                const formatted = this._formatted(sensor.category, sensor);
                const gicon = this._gicon(sensor.category, sensor);
                if (icon && icon.gicon !== gicon)
                    icon.gicon = gicon;
                item.visible = sensor.status !== 'unavailable';
                this._setPanelText(panelItem, formatted);
                if (value.style !== formatted.style)
                    value.style = formatted.style;
                this._updateSteadyWidth(sensor, panelItem);
            }
            const visible = [...this._panelItems.values()].some(({item}) => item.visible);
            if (!visible && !this._placeholderIcon)
                this._createPlaceholderIcon();
            else if (visible)
                this._removePlaceholderIcon();
        }

        _addRow(categoryName, category, sensor) {
            const gicon = this._gicon(categoryName, sensor);
            const row = new MenuItem.MenuItem(gicon, categoryName, this._label(sensor), '…');
            row.connect('clicked', () => this._toggleRowMenu(categoryName, sensor));
            this._rows.set(sensor, row);
            this._categoryMenus[categoryName].menu.addMenuItem(row, this._sensorsInRowOrder(category).indexOf(sensor));
        }

        _defaultLabel() {
            return new St.Label({
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }

        // Puts the folder of the chosen icon style last into the icon theme's search path, in place of another style's,
        // with the country icons, which are the same in every style.
        _applyIconStyle() {
            const ownIcons = `${this._extensionObject.path}/icons/`;
            const style = ICON_STYLE_DIRECTORIES[this._settings.get_int('icon-style')];
            this._iconTheme.set_search_path([...this._iconTheme.get_search_path().filter(directory => !directory.startsWith(ownIcons)),
                ownIcons + style, `${ownIcons}countries`]);
            this._icons.clear();
        }

        // The icon a sensor names, or its category's icon when it names none or no theme has an icon of that name, such
        // as a country without one.
        _gicon(categoryName, sensor = null) {
            const name = sensor?.icon ?? SensorCategories.sensorCategories[categoryName].icon;
            if (!this._icons.has(name)) {
            // The theme gives a file; a themed icon would be looked up again in the Shell's theme, which lacks ours.
                const found = this._iconTheme.lookup_icon(name, 16, 0);
                this._icons.set(name, found ? Gio.icon_new_for_string(found.get_filename()) : null);
            }
            // A missing category icon goes to GNOME's missing-icon handling, not back into this lookup.
            return this._icons.get(name) ?? (sensor ? this._gicon(categoryName) : new Gio.ThemedIcon({name}));
        }

        _positionInPanel() {
            return PANEL_POSITIONS[this._settings.get_enum('position-in-panel')];
        }

        async _discoverSensors() {
            await this._sensors.discover();
            if (this._sensors.destroyed || this._dragging)
                return;
            this._markShown();
        }

        _readSensors(force = false) {
            this._markShown();
            return this._sensors.poll(force);
        }

        // What the Refresh button does: look for sensors again, then read every shown value now, ignoring source intervals.
        async _refresh() {
            await this._discoverSensors();
            if (this._sensors.destroyed)
                return;
            await this._readSensors(true);
        }

        destroy() {
            this._dragging = false;

            this._settings.disconnectObject(this);
            this.menu.disconnectObject(this);

            this._rows.clear();
            this._hiddenButton = null;
            this._rowMenu = {sensor: null, items: []};
            this._panelItems.clear();
            this._shownCategoryPins.clear();
            this._separators.clear();
            this._placeholderIcon = null;

            super.destroy();
        }
    });

export default class VitalsExtension extends Extension {
    enable() {
        vitalsMenu = new VitalsMenuButton(this);
        const position = vitalsMenu._positionInPanel();
        Main.panel.addToStatusArea('vitalsMenu', vitalsMenu, position[1], position[0]);
    }

    disable() {
        vitalsMenu.destroy();
        vitalsMenu = null;
    }
}
