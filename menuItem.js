import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// The room of one menu icon, left empty. A sensor's row starts with it, so that the row's icon stands under the
// name of its category; the row menu's header and actions start with it for the same reason.
function indent() {
    // An icon without a picture takes no room, so this one has a picture that is not drawn: the check mark that
    // a row shows there while its sensor is pinned.
    return new St.Icon({style_class: 'popup-menu-icon', icon_name: 'ornament-check-symbolic', opacity: 0});
}

// The mark of the category pin: after its name in the list, and in front of the
// action that pins a sensor there, so that the action shows what the mark in the list means.
export const CATEGORY_PIN_ICON = 'non-starred-symbolic';

// How strongly the row of a hidden sensor is drawn. 255 is full strength.
const HIDDEN_ROW_OPACITY = 120;

export const MenuItem = GObject.registerClass({
    GTypeName: 'VitalsMenuItem',

    Signals: {
        'clicked': {},
    },

// eslint-disable-next-line no-shadow -- Keep the class name in GObject diagnostics and stack traces.
}, class MenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(icon, categoryName, label, value) {
        super._init({reactive: true, style_class: 'vitals-sensor-row'});

        this._categoryName = categoryName;
        this._gIcon = icon;

        // The room in front of the row's icon holds a check mark while the sensor is pinned to the top bar.
        this._pinActor = indent();
        this.add_child(this._pinActor);

        this._iconActor = new St.Icon({style_class: 'popup-menu-icon', gicon: this._gIcon});
        this.add_child(this._iconActor);

        this._labelActor = new St.Label({style_class: 'vitals-sensor-label', text: label});
        this.add_child(this._labelActor);

        // After the name: a star while the sensor is its category's category pin, and a struck-out eye while the
        // sensor is hidden.
        this._categoryPinActor = new St.Icon({style_class: 'vitals-row-mark', icon_name: CATEGORY_PIN_ICON, visible: false});
        this.add_child(this._categoryPinActor);
        this._hiddenActor = new St.Icon({style_class: 'vitals-row-mark', icon_name: 'view-conceal-symbolic', visible: false});
        this.add_child(this._hiddenActor);

        this._valueLabel = new St.Label({style_class: 'vitals-sensor-value', text: value});
        this._valueLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._valueLabel.set_x_align(Clutter.ActorAlign.END);
        this._valueLabel.set_x_expand(true);
        this._valueLabel.set_y_expand(true);
        this.add_child(this._valueLabel);

        this.actor._delegate = this;
    }

    // Whether the row shows that its sensor is pinned to the top bar.
    get pinned() {
        return this._pinActor.opacity === 255;
    }

    set pinned(pinned) {
        this._pinActor.opacity = pinned ? 255 : 0;
    }

    // Whether the row shows that its sensor is its category's category pin.
    get categoryPin() {
        return this._categoryPinActor.visible;
    }

    set categoryPin(categoryPin) {
        this._categoryPinActor.visible = categoryPin;
    }

    // Whether the row shows that its sensor is hidden: such a row is only in the menu while the user looks at the
    // hidden sensors, and is drawn lighter than the others.
    get hidden() {
        return this._hiddenActor.visible;
    }

    set hidden(hidden) {
        this._hiddenActor.visible = hidden;
        // Opening a row menu changes the row's opacity, so hidden-sensor dimming belongs on its contents.
        for (const part of [this._iconActor, this._labelActor, this._valueLabel, this._hiddenActor])
            part.opacity = hidden ? HIDDEN_ROW_OPACITY : 255;
    }

    // The name of the category the row's sensor belongs to.
    get categoryName() {
        return this._categoryName;
    }

    get gicon() {
        return this._gIcon;
    }

    set gicon(icon) {
        this._gIcon = icon;
        this._iconActor.gicon = icon;
    }

    set value(value) {
        this._valueLabel.text = value;
    }

    get value() {
        return this._valueLabel.text;
    }

    set valueStyle(style) {
        this._valueLabel.style = style || null;
    }

    get valueStyle() {
        return this._valueLabel.style;
    }

    // Not the Shell's 'activate' signal, which closes the menu.
    activate() {
        this.emit('clicked');
    }

    get label() {
        return this._labelActor.text;
    }

    set label(label) {
        this._labelActor.text = label;
    }
});

// Row-menu actions leave the main menu open.
export const MenuAction = GObject.registerClass({
    GTypeName: 'VitalsMenuAction',

    Signals: {
        'chosen': {},
    },

// eslint-disable-next-line no-shadow -- Keep the class name in GObject diagnostics and stack traces.
}, class MenuAction extends PopupMenu.PopupBaseMenuItem {
    // `checked` puts a mark in front of the label: a check mark, or the icon named by `markIconName`, for an action
    // whose state the rows show with a mark of its own. Without a mark that room stays empty, so the labels of all
    // actions start at the same place. The action is set in like a sensor's row, so that the mark stands under the
    // row's icon and the label under the row's name.
    _init(label, checked = false, markIconName = 'ornament-check-symbolic') {
        super._init({reactive: true, style_class: 'vitals-row-menu-action'});
        this._checked = checked;
        this.add_child(indent());
        // An icon without a picture takes no room, so the mark is always there and only not drawn.
        this.add_child(new St.Icon({style_class: 'popup-menu-icon', icon_name: markIconName, opacity: checked ? 255 : 0}));
        this._labelActor = new St.Label({text: label});
        this.add_child(this._labelActor);
    }

    get checked() {
        return this._checked;
    }

    get label() {
        return this._labelActor.text;
    }

    // Not the Shell's 'activate' signal, which closes the menu. What is chosen may remove this row, and the Shell
    // still uses the row until the click that chose it is over. So a click is answered when it has ended.
    activate() {
        const click = this._clickGesture;
        if (!click.pressed) {
            this.emit('chosen');
            return;
        }
        const clickEnded = click.connect('notify::pressed', () => {
            click.disconnect(clickEnded);
            this.emit('chosen');
        });
    }
});

// Align the row menu's icon and sensor name with the row above.
export const SensorHeader = GObject.registerClass({
    GTypeName: 'VitalsSensorHeader',
// eslint-disable-next-line no-shadow -- Keep the class name in GObject diagnostics and stack traces.
}, class SensorHeader extends PopupMenu.PopupBaseMenuItem {
    // `menuActor` is the main menu actor, where editLabel captures clicks outside the rename entry.
    _init(gicon, label, menuActor) {
        super._init({activate: false, hover: false, can_focus: false, style_class: 'vitals-row-menu-header'});
        // hover: false stops menu selection; St's separate :hover tracking must also be disabled.
        this.track_hover = false;
        this._menuActor = menuActor;
        this.add_child(indent());
        this.add_child(new St.Icon({style_class: 'popup-menu-icon', gicon}));
        this._labelActor = new St.Label({style_class: 'vitals-sensor-name', text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._labelActor);
    }

    get label() {
        return this._labelActor.text;
    }

    // Whether the name is being typed at the moment.
    get editing() {
        return Boolean(this._labelEntry);
    }

    // An empty string passed to `rename` restores the original sensor label; Escape cancels editing.
    editLabel(rename) {
        if (this._labelEntry)
            return;
        const entry = new St.Entry({style_class: 'vitals-rename-entry', text: this._labelActor.text, can_focus: true, x_expand: true});
        let finishIdleId = 0;
        entry.connect('destroy', () => {
            if (finishIdleId)
                GLib.Source.remove(finishIdleId);
        });
        const iconButton = iconName => new St.Button({
            style_class: 'vitals-rename-button', can_focus: false, child: new St.Icon({icon_name: iconName}),
        });
        this._renameConfirm = iconButton('object-select-symbolic');
        this._renameConfirm.add_style_class_name('vitals-rename-confirm');
        this._renameRestore = iconButton('edit-undo-symbolic');
        this._renameRestore.add_style_class_name('vitals-rename-restore');
        const editing = [entry, this._renameConfirm, this._renameRestore];
        this._labelEntry = entry;
        const finish = renamed => {
            // Destroying the field takes its focus away, which must not count as a second answer.
            if (this._labelEntry !== entry)
                return;
            this._labelEntry = null;
            const text = entry.text.trim();
            for (const actor of editing)
                actor.destroy();
            this._labelActor.show();
            if (renamed)
                rename(text);
        };
        const finishByButton = text => {
            entry.text = text;
            finish(true);
        };
        entry.clutter_text.connect('activate', () => finish(true));
        this._renameConfirm.connect('clicked', () => finishByButton(entry.text));
        this._renameRestore.connect('clicked', () => finishByButton(''));
        // An outside click confirms the rename without activating another menu item.
        this._menuActor.connectObject('captured-event', (menuActor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS && event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const [left, top] = entry.get_transformed_position();
            const right = this._renameRestore.get_transformed_position()[0] + this._renameRestore.get_transformed_size()[0];
            if (x >= left && x < right && y >= top && y < top + entry.get_transformed_size()[1])
                return Clutter.EVENT_PROPAGATE;
            finish(true);
            return Clutter.EVENT_STOP;
        }, entry);
        // Keep keyboard focus in the rename entry while its row remains mapped.
        global.stage.connectObject('notify::key-focus', () => {
            if (this._labelEntry !== entry || global.stage.key_focus === entry.clutter_text)
                return;
            if (this.mapped) {
                entry.grab_key_focus();
            } else if (!finishIdleId) {
                // Clutter must finish unmapping before the editor or row menu is destroyed.
                finishIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    finishIdleId = 0;
                    finish(true);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, entry);
        entry.clutter_text.connect('key-press-event', (text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            // Otherwise the key goes on to the menu, which it closes.
            return Clutter.EVENT_STOP;
        });
        this._labelActor.hide();
        for (const actor of [...editing].reverse())
            this.insert_child_above(actor, this._labelActor);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }
});
