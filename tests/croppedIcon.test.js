import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {equal} from './harness.js';

async function picture(actor, extraWidth = 0) {
    let [x, y] = actor.get_transformed_position();
    let [width, height] = actor.get_transformed_size();
    let stream = Gio.MemoryOutputStream.new_resizable();
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot_area(Math.round(x), Math.round(y), Math.round(width + extraWidth), Math.round(height), stream, (screenshot, result) => {
            try {
                screenshot.screenshot_area_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
    stream.close(null);
    return GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes()), null);
}

function solidColour(image, channel) {
    let pixels = image.read_pixel_bytes().get_data();
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            let offset = y * image.rowstride + x * image.n_channels;
            for (let colour = 0; colour < 3; colour++)
                if (Math.abs(pixels[offset + colour] - (colour == channel ? 255 : 0)) > 1) return false;
        }
    }
    return true;
}

// Run in the same Shell as shell.test.js, using the installed module so its GType is registered only once.
export async function run(CroppedIcon, waitFor) {
    let fixture = name => Gio.icon_new_for_string(Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fixtures/' + name + '-symbolic.svg').get_path());
    let box = new St.BoxLayout({x: 100, y: 100, style: 'background-color: #000000; spacing: 40px;'});
    let cropped = new CroppedIcon({gicon: fixture('wide'), icon_size: 32, y_align: Clutter.ActorAlign.CENTER, style: 'color: #ff0000;'});
    let stock = new St.Icon({gicon: fixture('wide'), icon_size: 32, y_align: Clutter.ActorAlign.CENTER, style: 'color: #ff0000;'});
    box.add_child(cropped);
    box.add_child(stock);
    Main.uiGroup.add_child(box);
    try {
        await waitFor(() => cropped.width > 0 && stock.width > 0, 'the rectangular icon loads');
        equal(cropped.width, stock.width * 20 / 32, 'transparent horizontal borders take no space');
        equal(cropped.height, stock.height * 8 / 32, 'transparent vertical borders take no space');
        equal(stock.width, stock.height, 'the same image in St.Icon keeps GNOME sizing');
        equal(cropped.is_symbolic, true, 'GNOME still recognises the symbolic image');
        equal(solidColour(await picture(cropped), 0), true, 'the crop fills its viewport in the theme colour');

        cropped.style = 'color: #0000ff;';
        await waitFor(async () => cropped.width > 0 && solidColour(await picture(cropped), 2), 'the theme recolours the cropped image');
        equal(cropped.is_symbolic, true, 'recolouring preserves the symbolic status');

        cropped.gicon = fixture('tall');
        await waitFor(() => cropped.width == stock.width * 8 / 32, 'a replacement image changes the viewport');
        equal(cropped.height, stock.height * 20 / 32, 'the replacement keeps its tall ratio');
        equal(solidColour(await picture(cropped), 2), true, 'the replacement fills its viewport');

        cropped.style = 'color: #0000ff; icon-shadow: 8px 0 0 #00ff00;';
        await waitFor(async () => {
            if (cropped.width == 0) return false;
            let image = await picture(cropped, cropped.width);
            return solidColour(image.new_subpixbuf(image.width / 2, 0, image.width / 2, image.height), 1);
        }, 'GNOME draws the shadow next to the cropped viewport');
        cropped.style = 'color: #0000ff;';

        // Whole-pixel fixture edges keep antialiasing from adding a partially covered border row.
        cropped.icon_size = 64;
        await waitFor(() => cropped.width == stock.width * 8 / 32 * 2, 'the icon size changes');
        equal(cropped.height, stock.height * 20 / 32 * 2, 'resizing preserves the ratio');

        cropped.gicon = fixture('empty');
        await waitFor(() => cropped.width == 0 && cropped.height == 0, 'a transparent image takes no space');
        cropped.gicon = fixture('wide');
        await waitFor(() => cropped.width == stock.width * 20 / 32 * 2, 'an image replaces the empty viewport');

        let cached = new CroppedIcon({gicon: fixture('wide'), icon_size: 32, y_align: Clutter.ActorAlign.CENTER, style: 'color: #ff0000;'});
        box.add_child(cached);
        await waitFor(() => cached.width > 0, 'another icon loads the cached image');
        equal(cached.width, stock.width * 20 / 32, 'the cached image has the same crop');
        equal(solidColour(await picture(cached), 0), true, 'the shared image keeps its colour');
        equal(stock.width, stock.height, 'stock sizing survives all cropped reloads');
        cropped.gicon = fixture('tall');
    } finally {
        box.destroy();
    }
}
