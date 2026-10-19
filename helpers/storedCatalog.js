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

export function readCatalogSettings(settings) {
    return settings.get_value('catalog-settings').recursiveUnpack();
}

// Switches one category on or off and leaves the other catalog settings as they are.
export function writeCategoryEnabled(settings, categoryName, enabled) {
    let catalogSettings = readCatalogSettings(settings);
    catalogSettings[categoryName].enabled = enabled;
    settings.set_value('catalog-settings', toVariant(catalogSettings));
}

// Whether the sensor was found by the last discovery run that completed its category. Both values are the
// timestamps of discovery runs; a sensor that no run has found has none.
export function sensorPresent(category, sensor) {
    return sensor.discovered !== undefined && sensor.discovered >= (category.discovered ?? 0);
}
