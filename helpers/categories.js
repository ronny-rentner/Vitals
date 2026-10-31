/* Sensor categories shared by shell and preferences. */
// `name` is what a category is called wherever it is shown: in the menu, and in the sidebar and on the page of the
// preferences. It is in English here and translated where it is shown. `icon` is the name of the category's icon in
// the icon theme, which a sensor has unless it names one of its own. `enabled` is whether the category is switched
// on while the user has not switched it.
export const sensorCategories = {
    'temperature' : { 'name': 'Temperature', 'icon': 'vitals-temperature-symbolic', 'enabled': true },
        'voltage' : { 'name': 'Voltage', 'icon': 'vitals-voltage-symbolic', 'enabled': true },
            'fan' : { 'name': 'Fan', 'icon': 'vitals-fan-symbolic', 'enabled': true },
          'power' : { 'name': 'Power', 'icon': 'vitals-power-symbolic', 'enabled': true },
         'memory' : { 'name': 'Memory', 'icon': 'vitals-memory-symbolic', 'enabled': true },
      'processor' : { 'name': 'Processor', 'icon': 'vitals-cpu-symbolic', 'enabled': true },
         'system' : { 'name': 'System', 'icon': 'vitals-system-symbolic', 'enabled': true },
        'network' : { 'name': 'Network', 'icon': 'vitals-network-symbolic', 'enabled': true },
        'storage' : { 'name': 'Storage', 'icon': 'vitals-storage-symbolic', 'enabled': true },
        'battery' : { 'name': 'Battery', 'icon': 'vitals-battery-symbolic', 'enabled': false },
            'gpu' : { 'name': 'GPU', 'icon': 'vitals-gpu-symbolic', 'enabled': false }
        };

// The value of the `category-order` setting for the order the user gave the categories; 0 is alphabetical.
export const MANUAL_CATEGORY_ORDER = 1;

// The names of the categories in the order the menu and the preferences list them. With `arranged`, which is the
// manual category order, that is the order the user gave them (`position` in the catalog); without it, and for
// categories the user has not placed, it is the alphabetical order of the names they are shown under.
// `catalog` is the catalog as it is used or as it is saved; `shownName` gives the name a category is shown under.
export function categoriesInOrder(catalog, shownName, arranged) {
    let byName = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
    let position = name => arranged ? catalog[name]?.position ?? Infinity : Infinity;
    // Two categories without a position give no number here, and their names decide.
    return Object.keys(sensorCategories).sort((a, b) => position(a) - position(b) || byName.compare(shownName(a), shownName(b)));
}

// The settings that hold the colour scales, one per category.
export function colorSettingsKeys() {
    return Object.keys(sensorCategories).map(categoryName => `${categoryName}-colors`);
}
