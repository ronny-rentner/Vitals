import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// The room of one menu icon, left empty. A sensor's row starts with it, so that the row's icon stands under the
// name of its category; the head and the actions of a sensor's panel start with it for the same reason.
function indent() {
    // An icon without a picture takes no room, so this one has a picture that is not drawn: the check mark that
    // a row shows there while its sensor is pinned.
    return new St.Icon({ style_class: 'popup-menu-icon', icon_name: 'ornament-check-symbolic', opacity: 0 });
}

// The mark of the sensor whose value its category's header shows: after its name in the list, and in front of the
// action that pins a sensor there, so that the action shows what the mark in the list means.
export const CATEGORY_PIN_ICON = 'starred-symbolic';

// How strongly the row of a hidden sensor is drawn. 255 is full strength.
const HIDDEN_ROW_OPACITY = 120;

export const MenuItem = GObject.registerClass({

    Signals: {
        // A click on the row with either mouse button, or Enter or Space on it. It asks for the row's actions.
        'clicked': {},
    },

}, class MenuItem extends PopupMenu.PopupBaseMenuItem {

    _init(icon, categoryName, label, value) {
        super._init({ reactive: true });

        this._categoryName = categoryName;
        this._gIcon = icon;

        // The room in front of the row's icon holds a check mark while the sensor is pinned to the top bar.
        this._pinActor = indent();
        this.add_child(this._pinActor);

        // add icon
        this._iconActor = new St.Icon({ style_class: 'popup-menu-icon', gicon : this._gIcon });
        this.add_child(this._iconActor);

        // add label
        this._labelActor = new St.Label({ text: label });
        this.add_child(this._labelActor);

        // After the name: a star while the header of the sensor's category shows this sensor's value, and a
        // struck-out eye while the sensor is hidden.
        this._defaultActor = new St.Icon({ style_class: 'vitals-row-mark', icon_name: CATEGORY_PIN_ICON, visible: false });
        this.add_child(this._defaultActor);
        this._hiddenActor = new St.Icon({ style_class: 'vitals-row-mark', icon_name: 'view-conceal-symbolic', visible: false });
        this.add_child(this._hiddenActor);

        // add value
        this._valueLabel = new St.Label({ text: value });
        // In a row that is too narrow for both, the label is shortened and the value is shown in full.
        this._valueLabel.get_clutter_text().ellipsize = 0;
        this._valueLabel.set_x_align(Clutter.ActorAlign.END);
        this._valueLabel.set_x_expand(true);
        this._valueLabel.set_y_expand(true);
        this.add_child(this._valueLabel);

        this.actor._delegate = this;
    }

    // Whether the row shows that its sensor is pinned to the top bar.
    get pinned() {
        return this._pinActor.opacity == 255;
    }

    set pinned(pinned) {
        this._pinActor.opacity = pinned ? 255 : 0;
    }

    // Whether the row shows that the header of its category shows this sensor's value.
    get categoryDefault() {
        return this._defaultActor.visible;
    }

    set categoryDefault(categoryDefault) {
        this._defaultActor.visible = categoryDefault;
    }

    // Whether the row shows that its sensor is hidden: such a row is only in the menu while the user looks at the
    // hidden sensors, and is drawn lighter than the others.
    get hidden() {
        return this._hiddenActor.visible;
    }

    set hidden(hidden) {
        this._hiddenActor.visible = hidden;
        // The row itself is dimmed and brought back by the panel of a sensor, so its parts are dimmed here.
        for (let part of [this._iconActor, this._labelActor, this._valueLabel, this._hiddenActor])
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
        if (this._iconActor)
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

// One of the actions in a sensor's panel. Choosing it does not close the menu.
export const MenuAction = GObject.registerClass({

    Signals: {
        'chosen': {},
    },

}, class MenuAction extends PopupMenu.PopupBaseMenuItem {

    // `checked` puts a mark in front of the label: a check mark, or the icon named by `markIconName`, for an action
    // whose state the rows show with a mark of its own. Without a mark that room stays empty, so the labels of all
    // actions start at the same place. The action is set in like a sensor's row, so that the mark stands under the
    // row's icon and the label under the row's name.
    _init(label, checked = false, markIconName = 'ornament-check-symbolic') {
        super._init({ reactive: true });
        this._checked = checked;
        this.add_child(indent());
        // An icon without a picture takes no room, so the mark is always there and only not drawn.
        this.add_child(new St.Icon({ style_class: 'popup-menu-icon', icon_name: markIconName, opacity: checked ? 255 : 0 }));
        this._labelActor = new St.Label({ text: label });
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
        let click = this._clickGesture;
        if (!click?.pressed) {
            this.emit('chosen');
            return;
        }
        let clickEnded = click.connect('notify::pressed', () => {
            click.disconnect(clickEnded);
            this.emit('chosen');
        });
    }
});

// The head of the panel that holds a sensor's actions: the sensor's icon and its name, laid out exactly like the
// sensor's row, so that both stand under the row's. The name is where the sensor is renamed.
export const SensorHeader = GObject.registerClass({
}, class SensorHeader extends PopupMenu.PopupBaseMenuItem {

    // `menuActor` is the actor of the menu the panel is in; see editLabel.
    _init(gicon, label, menuActor) {
        super._init({ activate: false, hover: false, can_focus: false });
        this._menuActor = menuActor;
        this.add_child(indent());
        this.add_child(new St.Icon({ style_class: 'popup-menu-icon', gicon }));
        this._labelActor = new St.Label({ style_class: 'vitals-sensor-name', text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this._labelActor);
    }

    get label() {
        return this._labelActor.text;
    }

    // Whether the name is being typed at the moment.
    get editing() {
        return Boolean(this._labelEntry);
    }

    // Lets the user type another name where the label is, in a field with two buttons after it: one to confirm
    // and one that gives the sensor its own name back. `rename` gets the text when the user confirms, with the
    // button or with Enter, clicks anywhere else, or closes the menu; it gets an empty text for the sensor's own
    // name. Escape leaves the name as it is.
    editLabel(rename) {
        if (this._labelEntry) return;
        let entry = new St.Entry({ style_class: 'vitals-rename-entry', text: this._labelActor.text, can_focus: true, x_expand: true });
        let iconButton = iconName => new St.Button({
            style_class: 'vitals-rename-button', can_focus: false, child: new St.Icon({ icon_name: iconName })
        });
        this._renameConfirm = iconButton('object-select-symbolic');
        this._renameRestore = iconButton('edit-undo-symbolic');
        // The field and its buttons stand in the row itself, in the label's place. Inside a box of their own, the
        // field would be given the height of the buttons.
        let editing = [entry, this._renameConfirm, this._renameRestore];
        this._labelEntry = entry;
        let finish = renamed => {
            // Destroying the field takes its focus away, which must not count as a second answer.
            if (this._labelEntry != entry) return;
            this._labelEntry = null;
            let text = entry.text.trim();
            for (let actor of editing)
                actor.destroy();
            this._labelActor.show();
            if (renamed) rename(text);
        };
        let finishByButton = text => {
            entry.text = text;
            finish(true);
        };
        entry.clutter_text.connect('activate', () => finish(true));
        this._renameConfirm.connect('clicked', () => finishByButton(entry.text));
        this._renameRestore.connect('clicked', () => finishByButton(''));
        // While the menu is open, the Shell sends every event to the menu only, so that is where a click anywhere
        // but in the field and its buttons is seen. It ends the renaming with what was typed and does nothing
        // else, like the click that closes the panel.
        this._menuActor.connectObject('captured-event', (menuActor, event) => {
            if (event.type() != Clutter.EventType.BUTTON_PRESS && event.type() != Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            let [x, y] = event.get_coords();
            let [left, top] = entry.get_transformed_position();
            let right = this._renameRestore.get_transformed_position()[0] + this._renameRestore.get_transformed_size()[0];
            if (x >= left && x < right && y >= top && y < top + entry.get_transformed_size()[1])
                return Clutter.EVENT_PROPAGATE;
            finish(true);
            return Clutter.EVENT_STOP;
        }, entry);
        // Every row of a menu takes the keyboard when the pointer comes over it. The field takes the keyboard back
        // for as long as it is on screen.
        global.stage.connectObject('notify::key-focus', () => {
            if (this._labelEntry != entry || global.stage.key_focus == entry.clutter_text) return;
            if (this.mapped)
                entry.grab_key_focus();
            else
                finish(true);
        }, entry);
        entry.clutter_text.connect('key-press-event', (text, event) => {
            if (event.get_key_symbol() != Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
            finish(false);
            // Otherwise the key goes on to the menu, which it closes.
            return Clutter.EVENT_STOP;
        });
        this._labelActor.hide();
        for (let actor of [...editing].reverse())
            this.insert_child_above(actor, this._labelActor);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }
});
