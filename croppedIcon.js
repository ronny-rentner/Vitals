import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

// St shares loaded content between icons; each decoded version needs its bounds scanned only once.
const crops = new WeakMap();

async function cropImage(content) {
    let texture = content.get_texture();
    let stream = Gio.MemoryOutputStream.new_resizable();
    // Cogl.Texture.get_data() cannot return its pixel buffer through GJS. Shell's texture export can.
    let image = await new Promise((resolve, reject) => {
        Shell.Screenshot.composite_to_stream(texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream, (_source, result) => {
            try {
                resolve(Shell.Screenshot.composite_to_stream_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    stream.close(null);
    let pixels = image.read_pixel_bytes().get_data();
    let width = image.width, height = image.height, stride = image.rowstride, channels = image.n_channels;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (image.has_alpha && pixels[y * stride + x * channels + channels - 1] == 0) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    // A transparent image has no viewport and takes no space.
    if (right < left) return null;
    return {
        texture: Cogl.SubTexture.new(global.stage.context.get_backend().get_cogl_context(), texture, left, top, right - left + 1, bottom - top + 1),
        width: (right - left + 1) / Math.max(width, height),
        height: (bottom - top + 1) / Math.max(width, height)
    };
}

// Keep the native content attached: St.Icon uses it to recognise symbolic icons and manage their shadows.
const IconCropEffect = GObject.registerClass({GTypeName: 'VitalsIconCropEffect'}, class IconCropEffect extends Clutter.Effect {
    vfunc_paint(node) {
        node.add_child(this.get_actor().create_texture_paint_node(this.texture));
    }
});

export const CroppedIcon = GObject.registerClass({GTypeName: 'VitalsCroppedIcon'}, class CroppedIcon extends St.Icon {
    _init(params) {
        super._init(params);
        // St replaces its child on reload; the first asynchronous load can attach content after the child.
        this.connect('child-added', (_icon, actor) => this._watchTexture(actor));
        this.get_children().forEach(actor => this._watchTexture(actor));
    }

    _watchTexture(actor) {
        // The allocated width is still zero when an uncached image starts loading.
        let size = actor.natural_width;
        let currentContent;
        let effect = new IconCropEffect();
        actor.add_effect(effect);
        let update = async () => {
            actor.hide();
            let content = currentContent = actor.content;
            if (!content) return;
            try {
                if (!crops.has(content)) crops.set(content, cropImage(content));
                let crop = await crops.get(content);
                // A replacement or destruction can finish before the texture export does.
                if (content !== currentContent || !crop) return;
                effect.texture = crop.texture;
                actor.content_gravity = Clutter.ContentGravity.RESIZE_FILL;
                actor.set_size(size * crop.width, size * crop.height);
                actor.show();
            } catch (error) {
                console.error('Could not crop icon', error);
            }
        };
        actor.connect('notify::content', update);
        actor.connect('destroy', () => currentContent = null);
        update();
    }
});
