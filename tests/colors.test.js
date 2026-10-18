import {parseColorEntry, formatColorEntry, sanitizeAndSortColorEntries, colorStyle} from '../helpers/colors.js';
import {test, equal, runTests} from './harness.js';

const RED = {red: 1, green: 0, blue: 0};
const GREEN = {red: 0, green: 1, blue: 0};
const RED_STYLE = 'color: rgb(255, 0, 0);';
const GREEN_STYLE = 'color: rgb(0, 255, 0);';

test('a breakpoint names its sensor by category and key, and the name may contain spaces', () => {
    let target = 'sensor:gpu/NVIDIA GeForce RTX 3080/utilization.gpu';
    let entry = formatColorEntry({threshold: 80, ...RED, target});
    equal(parseColorEntry(entry).target, target);
    equal(parseColorEntry(entry).threshold, 80);
});

test('an entry that is not a breakpoint with a target is left out', () => {
    let entries = ['80 1 0 0', 'eighty 1 0 0 kind:temp', '70 1 0 0 kind:temp', '60 1 0 0 someone:else'];
    equal(sanitizeAndSortColorEntries(entries).map(formatColorEntry).join('|'), '70 1 0 0 kind:temp');
});

test('a sensor uses its own colour scale when it has one, and the scale for its kind of value otherwise', () => {
    let colors = [
        formatColorEntry({threshold: 50, ...RED, target: 'kind:temp'}),
        formatColorEntry({threshold: 70, ...GREEN, target: 'sensor:temperature/thinkpad/temp1'})
    ];
    equal(colorStyle(60, colors, 'sensor:temperature/thinkpad/temp1', 'kind:temp'), '', 'below its own breakpoint');
    equal(colorStyle(75, colors, 'sensor:temperature/thinkpad/temp1', 'kind:temp'), GREEN_STYLE, 'its own scale');
    equal(colorStyle(60, colors, 'sensor:temperature/acpitz/temp1', 'kind:temp'), RED_STYLE, 'the scale for its kind');
    equal(colorStyle(60, colors, 'sensor:temperature/acpitz/fan1', 'kind:fan'), '', 'another kind of value has no scale');
});

test('a value has the colour of the highest breakpoint it has reached, or of the lowest it is still under', () => {
    let colors = [
        formatColorEntry({threshold: 20, ...RED, target: 'kind:percent'}),
        formatColorEntry({threshold: 40, ...GREEN, target: 'kind:percent'})
    ];
    equal(colorStyle(10, colors, 'sensor:memory/usage', 'kind:percent'), '', 'upward, below the lowest');
    equal(colorStyle(20, colors, 'sensor:memory/usage', 'kind:percent'), RED_STYLE, 'upward, at the lower');
    equal(colorStyle(90, colors, 'sensor:memory/usage', 'kind:percent'), GREEN_STYLE, 'upward, above the higher');
    equal(colorStyle(10, colors, 'sensor:battery/BAT0/percentage', 'kind:percent', true), RED_STYLE, 'downward, under the lower');
    equal(colorStyle(40, colors, 'sensor:battery/BAT0/percentage', 'kind:percent', true), GREEN_STYLE, 'downward, at the higher');
    equal(colorStyle(90, colors, 'sensor:battery/BAT0/percentage', 'kind:percent', true), '', 'downward, above the highest');
});

test('a colour component is a share of 1, or a number up to 255', () => {
    equal(colorStyle(1, ['0 38 162 105 kind:temp'], 'sensor:temperature/a', 'kind:temp'), 'color: rgb(38, 162, 105);');
    equal(colorStyle(1, ['0 1 0.5 0 kind:temp'], 'sensor:temperature/a', 'kind:temp'), 'color: rgb(255, 128, 0);');
});

await runTests();
