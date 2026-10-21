/* The sensor catalog as it is saved in the `catalog` setting. Shared by shell and preferences. */
import GLib from 'gi://GLib';

// GSettings has no type for "any plain data", so every level is wrapped: a record as a{sv}, a list as av. The fields
// named in `omitted` are left out of every record.
export function toVariant(plain, omitted = []) {
    if (Array.isArray(plain))
        return new GLib.Variant('av', plain.map(element => toVariant(element, omitted)));
    switch (typeof plain) {
        case 'object':
            return new GLib.Variant('a{sv}', Object.fromEntries(Object.entries(plain)
                .filter(([field, fieldValue]) => fieldValue !== undefined && !omitted.includes(field))
                .map(([field, fieldValue]) => [field, toVariant(fieldValue, omitted)])));
        case 'string':
            return GLib.Variant.new_string(plain);
        case 'boolean':
            return GLib.Variant.new_boolean(plain);
        default:
            return GLib.Variant.new_double(plain);
    }
}


// Whether the sensor was found by the last discovery run that completed its category. Both values are the
// timestamps of discovery runs; a sensor that no run has found has none.
export function sensorPresent(category, sensor) {
    return sensor.discovered !== undefined && sensor.discovered >= (category.discovered ?? 0);
}
