import {categoriesInOrder, sensorCategories} from '../helpers/categories.js';
import {test, equal, runTests} from './harness.js';

test('categories are listed by the names they are shown under until the user arranges them', () => {
    const shownName = name => sensorCategories[name].name;
    const catalog = Object.fromEntries(Object.keys(sensorCategories).map(name => [name, {}]));
    const alphabetical = categoriesInOrder(catalog, shownName, true);
    equal(alphabetical.join(', '), [...alphabetical].sort((a, b) => shownName(a).localeCompare(shownName(b))).join(', '), 'by shown name');
    equal(alphabetical.indexOf('fan') < alphabetical.indexOf('gpu') && alphabetical.indexOf('gpu') < alphabetical.indexOf('memory'), true,
        'under the name it is shown by, not its key');
    // The user put the voltages first; the others keep their order behind them.
    const arranged = ['voltage', ...alphabetical.filter(name => name !== 'voltage')];
    for (const [position, name] of arranged.entries())
        catalog[name].position = position;
    equal(categoriesInOrder(catalog, shownName, true).join(', '), arranged.join(', '), 'as arranged');
    equal(categoriesInOrder(catalog, shownName, false).join(', '), alphabetical.join(', '),
        'in the alphabetical order they are sorted by name again, and the arrangement is kept');
});

await runTests();
