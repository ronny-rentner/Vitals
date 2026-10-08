import {parseColorEntry, formatColorEntry, getUsageColor} from '../helpers/colors.js';
import {test, equal, runTests} from './harness.js';

const RED = {red: 1, green: 0, blue: 0};
const GREEN = {red: 0, green: 1, blue: 0};
const RED_STYLE = 'color: rgb(255, 0, 0);';
const GREEN_STYLE = 'color: rgb(0, 255, 0);';

test('a colour entry names its sensor by category and key, and the name may contain spaces', () => {
    let target = 'gpu/NVIDIA GeForce RTX 3080/utilization.gpu';
    let entry = formatColorEntry({threshold: 80, ...RED, sensorKey: target});
    equal(parseColorEntry(entry).sensorKey, target);
    equal(parseColorEntry(entry).threshold, 80);
    equal(parseColorEntry(formatColorEntry({threshold: 80, ...RED})).sensorKey, null, 'an entry for all sensors names none');
});

test('a sensor uses its own colour scale when it has one, and the scale for all sensors otherwise', () => {
    let colors = [
        formatColorEntry({threshold: 50, ...RED}),
        formatColorEntry({threshold: 70, ...GREEN, sensorKey: 'temperature/thinkpad/temp1'})
    ];
    equal(getUsageColor(60, colors, 'temperature/thinkpad/temp1'), '', 'below its own threshold');
    equal(getUsageColor(75, colors, 'temperature/thinkpad/temp1'), GREEN_STYLE, 'its own scale');
    equal(getUsageColor(60, colors, 'temperature/acpitz/temp1'), RED_STYLE, 'the scale for all sensors');
    equal(getUsageColor(60, colors, 'fan/thinkpad/temp1'), RED_STYLE, 'the same key in another category is another sensor');
});

await runTests();
