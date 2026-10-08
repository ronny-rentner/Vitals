import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St'

// How strongly a unit is drawn when it is set off from its number. 255 is fully opaque.
const UNIT_OPACITY = 170;
// The empty room that is seen between a number and its unit, in pixels of an unscaled display.
const UNIT_GAP = 3;

// A sensor's value in the top bar: the number and its unit. With `emphasizeNumber`, the unit is smaller, thinner
// and lighter than the number; otherwise both look the same.
// They are two labels so that the stylesheet can style the unit (.vitals-panel-unit-light).
export const PanelValue = GObject.registerClass({
    GTypeName: 'VitalsPanelValue',
}, class PanelValue extends St.BoxLayout {

    _init(emphasizeNumber) {
        super._init({
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        // Both start at the top of the value; vfunc_allocate then moves the unit down onto the number's baseline.
        this._number = new St.Label({
            style_class: 'vitals-panel-label',
            y_align: Clutter.ActorAlign.START
        });
        this._unit = new St.Label({
            style_class: 'vitals-panel-label' + (emphasizeNumber ? ' vitals-panel-unit-light' : ''),
            opacity: emphasizeNumber ? UNIT_OPACITY : 255,
            y_align: Clutter.ActorAlign.START
        });
        // attempt to prevent ellipsizes
        this._number.get_clutter_text().ellipsize = 0;
        this._unit.get_clutter_text().ellipsize = 0;
        this.add_child(this._number);
        this.add_child(this._unit);
        // The text as it was given, with the space between number and unit.
        this._text = '';
    }

    get text() {
        return this._text;
    }

    // `unit` is what the text ends with, or '' when it has no unit.
    setText(text, unit = '') {
        this._text = text;
        this._number.text = unit ? text.slice(0, -unit.length) : text;
        // Without the space some units are written with: the distance to the number is the same for all (_unitOffset).
        this._unit.text = unit.trim();
    }

    // How far the unit's label is moved away from the number's, so that UNIT_GAP whole pixels are empty between what
    // is drawn of the two, whatever the unit and the number's last digit are. Glyphs bring different amounts of empty
    // room at their sides: "%" more than "B", and "1" more than "0".
    _unitOffset() {
        if (!this._unit.text) return 0;
        // Where the drawing of a label's text starts and ends, and how wide the text is with its empty room.
        let drawing = label => {
            let text = label.get_clutter_text();
            let [drawn, whole] = text.get_layout().get_extents();
            // From the layout's units to the units actors are placed in, as for the baseline in vfunc_allocate.
            let toActorUnits = text.height / whole.height;
            return {start: drawn.x * toActorUnits, end: (drawn.x + drawn.width) * toActorUnits, width: whole.width * toActorUnits};
        };
        let number = drawing(this._number);
        let gap = UNIT_GAP * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The number's drawing ends inside a pixel and the unit's starts inside one; both of those pixels are not empty.
        return Math.ceil(number.end) + gap - Math.floor(drawing(this._unit).start) - Math.ceil(number.width);
    }

    vfunc_get_preferred_width(forHeight) {
        let offset = this._unitOffset();
        return super.vfunc_get_preferred_width(forHeight).map(width => width + offset);
    }

    // The width the text needs, whatever width is set on this value. Only for a value that is on the stage.
    get textWidth() {
        // A label has the font of the theme only once it is styled.
        this._number.ensure_style();
        this._unit.ensure_style();
        return this._number.get_preferred_width(-1)[1] + this._unit.get_preferred_width(-1)[1] + this._unitOffset();
    }

    // A box lines its children up by their edges, and the unit's font is smaller than the number's. So that the
    // unit stands on the same line as the number, it is moved down by the difference of their baselines.
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        // The text layout is measured in the pixels of the screen, which on a scaled display are not the units
        // actors are placed in. So the baseline is taken as a share of the layout's height, of the text's height.
        let baseline = label => {
            let text = label.get_clutter_text();
            let layout = text.get_layout();
            return layout.get_baseline() / layout.get_extents()[1].height * text.height;
        };
        this._unit.translation_y = baseline(this._number) - baseline(this._unit);
        this._unit.translation_x = this._unitOffset();
    }
});
