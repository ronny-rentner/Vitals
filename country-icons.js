// Draws icons/countries/, one icon per ISO 3166-1 code, and preview.png of some of them: `make country-icons`.
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Gsk from 'gi://Gsk?version=4.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Rsvg from 'gi://Rsvg?version=2.0';

const iconFile = code => `icons/countries/vitals-country-${code.toLowerCase()}-symbolic.svg`;

const fontMap = PangoCairo.FontMap.new();
fontMap.add_font_file('icons/countries/DejaVuSansMono-Bold.ttf');
const context = fontMap.create_context();
const countries = GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, 'iso-codes/json/iso_3166-1.json']))
    .find(path => GLib.file_test(path, GLib.FileTest.EXISTS));
for (let {alpha_2: code} of JSON.parse(new TextDecoder().decode(GLib.file_get_contents(countries)[1]))['3166-1']) {
    let layout = Pango.Layout.new(context);
    layout.set_font_description(Pango.FontDescription.from_string('DejaVu Sans Mono Bold 11px'));
    layout.set_text(code, -1);
    let builder = new Gsk.PathBuilder();
    builder.add_layout(layout);
    // The letters, moved so that what they draw is in the middle of the icon, are holes in the rounded rectangle.
    let [x, y, width, height] = ['x', 'y', 'width', 'height'].map(field => layout.get_extents()[0][field] / Pango.SCALE);
    let holes = builder.to_path().to_string().replace(/(-?[\d.]+) (-?[\d.]+)/g,
        (_, left, top) => `${+(8 - x - width / 2 + +left).toFixed(2)} ${+(8 - y - height / 2 + +top).toFixed(2)}`);
    GLib.file_set_contents(iconFile(code), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#bebebe" fill-rule="evenodd" ' +
        `d="M2.5 2h11a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-11a2.5 2.5 0 0 1-2.5-2.5v-7a2.5 2.5 0 0 1 2.5-2.5z ${holes}"/></svg>\n`);
}

// The preview: a few codes, MW the widest among them, at 3 times their size, white on dark and dark grey on light.
const CODES = ['DE', 'US', 'GB', 'MW', 'IL', 'JP'], SIZE = 48, CELL = 64;
const preview = new Cairo.ImageSurface(Cairo.Format.ARGB32, CODES.length * CELL, 2 * CELL);
const cr = new Cairo.Context(preview);
[[[0.1, 0.1, 0.1], [1, 1, 1]], [[0.98, 0.98, 0.98], [0.2, 0.2, 0.2]]].forEach(([background, color], row) => {
    cr.setSourceRGB(...background);
    cr.rectangle(0, row * CELL, CODES.length * CELL, CELL);
    cr.fill();
    cr.setSourceRGB(...color);
    CODES.forEach((code, i) => {
        // The icon is a stencil, painted in the colour of its row.
        let stencil = new Cairo.ImageSurface(Cairo.Format.ARGB32, SIZE, SIZE);
        Rsvg.Handle.new_from_file(iconFile(code)).render_document(new Cairo.Context(stencil), new Rsvg.Rectangle({x: 0, y: 0, width: SIZE, height: SIZE}));
        cr.maskSurface(stencil, i * CELL + (CELL - SIZE) / 2, row * CELL + (CELL - SIZE) / 2);
    });
});
preview.writeToPNG('icons/countries/preview.png');
