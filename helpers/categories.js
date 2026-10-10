/* Sensor categories shared by shell and preferences. */
// `name` is what a category is called wherever it is shown: in the menu, and in the sidebar and on the page of the
// preferences. It is in English here and translated where it is shown.
export const sensorCategories = {
    'temperature' : { 'name': 'Temperature', 'icon': 'temperature-symbolic.svg' },
        'voltage' : { 'name': 'Voltage', 'icon': 'voltage-symbolic.svg' },
            'fan' : { 'name': 'Fan', 'icon': 'fan-symbolic.svg' },
         'memory' : { 'name': 'Memory', 'icon': 'memory-symbolic.svg' },
      'processor' : { 'name': 'Processor', 'icon': 'cpu-symbolic.svg' },
         'system' : { 'name': 'System', 'icon': 'system-symbolic.svg' },
        'network' : { 'name': 'Network', 'icon': 'network-symbolic.svg',
                   'icon-rx': 'network-download-symbolic.svg',
                   'icon-tx': 'network-upload-symbolic.svg'
        },
        'storage' : { 'name': 'Storage', 'icon': 'storage-symbolic.svg' },
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

// How much of an icon's width is empty to the left and to the right of its drawing, as a share of the width, by
// icon style and file. The files differ a lot in this, so the top bar takes it into account to get the same
// distance between every icon and its neighbours. tests/categories.test.js checks these numbers against the files.
export const iconInsets = {
    original: {
        'battery-symbolic.svg': [0.12, 0.12],
        'cpu-symbolic.svg': [0.04, 0.04],
        'fan-symbolic.svg': [0.00, 0.00],
        'gpu-symbolic.svg': [0.10, 0.06],
        'memory-symbolic.svg': [0.04, 0.04],
        'network-download-symbolic.svg': [0.00, 0.00],
        'network-symbolic.svg': [0.00, 0.00],
        'network-upload-symbolic.svg': [0.00, 0.00],
        'storage-symbolic.svg': [0.12, 0.12],
        'system-symbolic.svg': [0.00, 0.00],
        'temperature-symbolic.svg': [0.21, 0.22],
        'voltage-symbolic.svg': [0.12, 0.19]
    },
    gnome: {
        'battery-symbolic.svg': [0.12, 0.12],
        'cpu-symbolic.svg': [0.00, 0.00],
        'fan-symbolic.svg': [0.00, 0.00],
        'gpu-symbolic.svg': [0.00, 0.00],
        'memory-symbolic.svg': [0.00, 0.00],
        'network-download-symbolic.svg': [0.06, 0.06],
        'network-symbolic.svg': [0.06, 0.06],
        'network-upload-symbolic.svg': [0.06, 0.06],
        'storage-symbolic.svg': [0.06, 0.06],
        'system-symbolic.svg': [0.00, 0.00],
        'temperature-symbolic.svg': [0.25, 0.25],
        'voltage-symbolic.svg': [0.06, 0.00]
    }
};
