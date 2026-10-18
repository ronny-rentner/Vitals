/* The sensor catalog as it is saved in the `catalog` setting. Shared by shell and preferences. */
import GLib from 'gi://GLib';

// GSettings has no type for "any plain data", so every level is wrapped: a record as a{sv}, a list as av.
function toVariant(plain) {
    if (Array.isArray(plain))
        return new GLib.Variant('av', plain.map(toVariant));
    switch (typeof plain) {
        case 'object':
            return new GLib.Variant('a{sv}', Object.fromEntries(Object.entries(plain)
                .filter(([, fieldValue]) => fieldValue !== undefined)
                .map(([field, fieldValue]) => [field, toVariant(fieldValue)])));
        case 'string':
            return GLib.Variant.new_string(plain);
        case 'boolean':
            return GLib.Variant.new_boolean(plain);
        default:
            return GLib.Variant.new_double(plain);
    }
}

export function readCatalog(settings) {
    return settings.get_value('catalog').recursiveUnpack();
}

export function writeCatalog(settings, catalog) {
    settings.set_value('catalog', toVariant(catalog));
}

// Switches one category on or off on disk and leaves everything else in the saved catalog as it is.
export function writeCategoryEnabled(settings, categoryName, enabled) {
    let catalog = readCatalog(settings);
    catalog[categoryName].enabled = enabled;
    writeCatalog(settings, catalog);
}

// Whether the sensor was found by the last discovery run that completed its category. Both values are the
// timestamps of discovery runs; a sensor that no run has found has none.
export function sensorPresent(category, sensor) {
    return sensor.discovered !== undefined && sensor.discovered >= (category.discovered ?? 0);
}
