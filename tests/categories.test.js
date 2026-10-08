import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import {iconInsets} from '../helpers/categories.js';
import {test, equal, runTests} from './harness.js';

// The share of an icon's width that is empty to the left and to the right of its drawing.
function measuredInsets(iconFile) {
    let size = 160;
    let image = GdkPixbuf.Pixbuf.new_from_file_at_size(iconFile, size, size);
    let pixels = image.get_pixels();
    let columnIsEmpty = column => {
        for (let row = 0; row < size; row++) {
            // The last of a pixel's four bytes is its opacity.
            if (pixels[row * image.get_rowstride() + column * 4 + 3] > 0) return false;
        }
        return true;
    };
    let emptyLeft = 0, emptyRight = 0;
    while (columnIsEmpty(emptyLeft)) emptyLeft++;
    while (columnIsEmpty(size - 1 - emptyRight)) emptyRight++;
    return [emptyLeft / size, emptyRight / size];
}

test('the recorded empty room beside each icon is what the icon file has', () => {
    let checked = 0;
    for (let [iconStyle, insetsByFile] of Object.entries(iconInsets)) {
        let directory = GLib.get_current_dir() + '/icons/' + iconStyle + '/';
        let files = [];
        let enumeration = GLib.Dir.open(directory, 0);
        for (let name = enumeration.read_name(); name !== null; name = enumeration.read_name())
            files.push(name);
        equal(Object.keys(insetsByFile).sort().join(', '), files.sort().join(', '), iconStyle + ': every icon file is recorded');
        for (let [file, [recordedLeft, recordedRight]] of Object.entries(insetsByFile)) {
            let [left, right] = measuredInsets(directory + file);
            // A hundredth of the width is a sixth of a pixel in the top bar.
            equal(Math.abs(left - recordedLeft) <= 0.01, true, iconStyle + '/' + file + ' left: ' + left + ' / ' + recordedLeft);
            equal(Math.abs(right - recordedRight) <= 0.01, true, iconStyle + '/' + file + ' right: ' + right + ' / ' + recordedRight);
            checked++;
        }
    }
    equal(checked, 24, 'twelve icons in each of the two styles');
});

await runTests();
