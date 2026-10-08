/* Sensor categories shared by shell and preferences. */
export const sensorCategories = {
    'temperature' : { 'icon': 'temperature-symbolic.svg', colorFormats: ['temp'] },
        'voltage' : { 'icon': 'voltage-symbolic.svg' },
            'fan' : { 'icon': 'fan-symbolic.svg', colorFormats: ['fan'] },
         'memory' : { 'icon': 'memory-symbolic.svg', colorFormats: ['percent'] },
      'processor' : { 'icon': 'cpu-symbolic.svg', colorFormats: ['percent'] },
         'system' : { 'icon': 'system-symbolic.svg', colorFormats: ['load'] },
        'network' : { 'icon': 'network-symbolic.svg',
                   'icon-rx': 'network-download-symbolic.svg',
                   'icon-tx': 'network-upload-symbolic.svg'
        },
        'storage' : { 'icon': 'storage-symbolic.svg' },
        'battery' : { 'icon': 'battery-symbolic.svg', colorFormats: ['percent'] },
            'gpu' : { 'icon': 'gpu-symbolic.svg', colorFormats: ['percent'] }
        };

export function colorSettingsKeys() {
    return Object.keys(sensorCategories)
        .filter(group => sensorCategories[group].colorFormats)
        .map(group => `${group}-colors`);
}

// GSettings key for threshold colors for a live sensor (shared by the formatter and prefs).
export function colorsKeyForSensor(categoryName, format) {
    // All temperatures share the temperature threshold UI, including GPU rows.
    if (format === 'temp')
        return 'temperature-colors';

    const formats = sensorCategories[categoryName].colorFormats;
    if (formats && formats.includes(format))
        return `${categoryName}-colors`;

    return null;
}

export function colorPageForSensor(categoryName, format) {
    let key = colorsKeyForSensor(categoryName, format);
    return key ? key.slice(0, -'-colors'.length) : null;
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
