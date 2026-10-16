/* Sensor categories shared by shell and preferences. */
// `name` is what a category is called wherever it is shown: in the menu, and in the sidebar and on the page of the
// preferences. It is in English here and translated where it is shown.
export const sensorCategories = {
    'temperature' : { 'name': 'Temperature', 'icon': 'temperature-symbolic.svg' },
        'voltage' : { 'name': 'Voltage', 'icon': 'voltage-symbolic.svg' },
            'fan' : { 'name': 'Fan', 'icon': 'fan-symbolic.svg' },
         'memory' : { 'name': 'Memory', 'icon': 'memory-symbolic.svg' },
      'processor' : { 'name': 'Processor', 'icon': 'cpu-symbolic.svg',
                   'icon-frequency': 'cpu-frequency-symbolic.svg',
                   'icon-power': 'cpu-power-symbolic.svg'
        },
         'system' : { 'name': 'System', 'icon': 'system-symbolic.svg' },
        'network' : { 'name': 'Network', 'icon': 'network-symbolic.svg',
                   'icon-rx': 'network-download-symbolic.svg',
                   'icon-tx': 'network-upload-symbolic.svg'
        },
        'storage' : { 'name': 'Storage', 'icon': 'storage-symbolic.svg',
                   'icon-read': 'storage-read-symbolic.svg',
                   'icon-write': 'storage-write-symbolic.svg'
        },
        'battery' : { 'name': 'Battery', 'icon': 'battery-symbolic.svg' },
            'gpu' : { 'name': 'GPU', 'icon': 'gpu-symbolic.svg' }
        };

// The value of the `category-order` setting for the order the user gave the categories; 0 is alphabetical.
export const MANUAL_CATEGORY_ORDER = 1;

// The names of the categories in the order the menu and the preferences list them. With `arranged`, which is the
// manual category order, that is the order the user gave them (`position` in the catalog); without it, and for
// categories the user has not placed, it is the alphabetical order of the names they are shown under.
// `catalog` is the catalog as it is used or as it is saved; `shownName` gives the name a category is shown under.
export function categoriesInOrder(catalog, shownName, arranged) {
    let byName = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
    let position = name => arranged ? catalog[name].position ?? Infinity : Infinity;
    // Two categories without a position give no number here, and their names decide.
    return Object.keys(sensorCategories).sort((a, b) => position(a) - position(b) || byName.compare(shownName(a), shownName(b)));
}

// The settings that hold the colour scales, one per category.
export function colorSettingsKeys() {
    return Object.keys(sensorCategories).map(categoryName => `${categoryName}-colors`);
}
