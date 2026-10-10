/* Colour scales, shared by the preferences and the formatter. */

// The colour of a new breakpoint (Adwaita's red).
export const DEFAULT_THRESHOLD_RGBA = {
    red: 224 / 255,
    green: 27 / 255,
    blue: 36 / 255,
};

// A breakpoint as it is saved in the `<category>-colors` setting: "threshold r g b target". The target says whose
// scale the breakpoint belongs to: one sensor, "sensor:<category>/<key>", or all sensors of the category that show
// one kind of value, "kind:<format>". A target may contain spaces, as device names do.
export function parseColorEntry(colorEntry) {
    let [threshold, red, green, blue, ...target] = colorEntry.split(' ');
    return {threshold: Number(threshold), red: Number(red), green: Number(green), blue: Number(blue), target: target.join(' ')};
}

export function formatColorEntry({threshold, red, green, blue, target}) {
    return `${threshold} ${red} ${green} ${blue} ${target}`;
}

export function compareColorEntries(a, b) {
    return a.threshold - b.threshold || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
}

// The breakpoints of a setting, lowest first. A setting can be written by hand, and one saved before 2026-10-10
// has breakpoints "for all sensors" that name no target; an entry that is not a breakpoint with a target is left out.
export function sanitizeAndSortColorEntries(colorsArray) {
    return colorsArray.map(parseColorEntry)
        .filter(({threshold, red, green, blue, target}) =>
            [threshold, red, green, blue].every(Number.isFinite) && /^(sensor|kind):./.test(target))
        .sort(compareColorEntries);
}

// The style that colours `number`, from the saved breakpoints of its category: the sensor's own scale when it has
// one, otherwise the scale for its kind of value. A value has the colour of the highest breakpoint it has reached;
// for a sensor whose low values are the bad ones, that of the lowest breakpoint it is still under. '' when no
// breakpoint applies.
export function colorStyle(number, colorsArray, sensorTarget, kindTarget, lowIsBad) {
    let breakpoints = sanitizeAndSortColorEntries(colorsArray);
    let scale = breakpoints.filter(breakpoint => breakpoint.target == sensorTarget);
    if (scale.length == 0)
        scale = breakpoints.filter(breakpoint => breakpoint.target == kindTarget);
    let breakpoint = lowIsBad ? scale.find(({threshold}) => number <= threshold) : scale.findLast(({threshold}) => number >= threshold);
    if (!breakpoint)
        return '';
    // A colour component is saved as a share of 1 or, by hand, as a number up to 255.
    let [red, green, blue] = [breakpoint.red, breakpoint.green, breakpoint.blue].map(component =>
        Math.min(255, Math.round(component > 1 ? component : component * 255)));
    return `color: rgb(${red}, ${green}, ${blue});`;
}
