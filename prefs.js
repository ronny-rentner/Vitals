import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Formatter} from './formatter.js';
import {sensorCategories, categoriesInOrder, MANUAL_CATEGORY_ORDER} from './helpers/categories.js';
import {compareColorEntries, DEFAULT_THRESHOLD_RGBA, formatColorEntry, sanitizeAndSortColorEntries} from './helpers/colors.js';
import {parseMountTable, parseTypesWithoutDevice, isRemoteMount} from './helpers/sensorMath.js';
import {readCatalog, writeCategoryEnabled, sensorPresent} from './helpers/storedCatalog.js';

// The preferences window, written in the order in which it shows its pages, groups and rows. A row is one call of
// a helper below, which creates it and connects it to its setting.
export default class VitalsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._applyIconStyle();
        this._settings.connect('changed::icon-style', () => this._applyIconStyle());

        // The pages, with a sidebar that lists them.
        this._pages = new Adw.ViewStack();
        let pageArea = new Adw.NavigationPage({ title: _('General'), child: this._underHeaderBar(this._pages, { show_start_title_buttons: false }) });
        this._pages.connect('notify::visible-child', () => pageArea.set_title(this._pages.get_page(this._pages.visible_child).title));
        window.set_content(new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({
                title: _('Vitals'),
                child: this._underHeaderBar(new Adw.ViewSwitcherSidebar({ stack: this._pages }), { show_end_title_buttons: false }),
            }),
            content: pageArea,
        }));
        // GNOME Shell only accepts a preferences window that was given a page its own way. Its own page list is a bar
        // at the bottom that shortens the names when there are thirteen, so the window gets a page that is not seen.
        window.add(new Adw.PreferencesPage());
        // High enough for the sidebar to show all its entries.
        window.set_default_size(780, 700);

        this._page('general', _('General'), 'preferences-system-symbolic',
            this._group('',
                this._updateRow(),
                this._switchRow('use-higher-precision', _('Use higher precision'), _('One more decimal place, and seconds in uptimes.')),
                this._toggleRow('icon-style', _('Icon style'), '', [_('Original'), _('GNOME')])),
            new Adw.PreferencesGroup({
                title: _('About'),
                description: _('Feature requests or bugs? Please visit <a href="https://github.com/corecoding/Vitals/issues">GitHub</a>. No warranty, expressed or implied. <a href="https://corecoding.com/donate.php">Donate</a> if you found this useful.'),
            }));

        this._page('top-bar', _('Top Bar'), 'focus-top-bar-symbolic',
            this._group(_('Placement'),
                this._comboRow('position-in-panel', _('Position'), _('Far left and far right are the outer ends of the bar.'),
                    [_('Left'), _('Center'), _('Right'), _('Far left'), _('Far right')]),
                this._switchRow('allow-panel-dragging', _('Reorder sensors by drag and drop'))),
            this._group(_('Appearance'),
                this._switchRow('fixed-widths', _('Steady widths'),
                    _('Keep room for a value’s widest text, so its neighbours do not jump. The room is given back after a minute.')),
                this._switchRow('emphasize-values', _('Emphasize values'), _('Draw icons and units lighter and smaller than the numbers.')),
                this._switchRow('hide-icons', _('Hide icons'), _('The icons in the menu stay.'))));

        this._page('menu', _('Menu'), 'open-menu-symbolic',
            this._group('',
                this._switchRow('menu-centered', _('Open centered under the sensors'), _('Otherwise the menu opens centered under the pointer.')),
                this._textRow('monitor-cmd', _('System monitor command'),
                    _('The program that the System Monitor button at the bottom of the menu starts.'), 'gnome-system-monitor')),
            this._group(_('Categories'),
                this._toggleRow('category-order', _('Order'), _('Manual is the order given by dragging categories in the menu.'),
                    [_('Alphabetical'), _('Manual')]),
                this._usableWhile('category-order', order => order == MANUAL_CATEGORY_ORDER,
                    this._switchRow('allow-category-dragging', _('Reorder by drag and drop'), _('Only in the manual order.'))),
                this._switchRow('animate-categories', _('Slide open and shut'))),
            this._group(_('Sensors'),
                this._switchRow('include-aggregates', _('Show average, minimum and maximum'),
                    _('In the temperature and fan categories, below the sensors.'))));

        this._categoryPage('temperature', _('Monitor temperature'), '', [
            this._toggleRow('unit', _('Unit'), '', [_('°C'), _('°F')]),
            this._switchRow('hide-zeros', _('Skip sensors that read zero'),
                _('A sensor that reads zero when it is found is left out. One that reads zero later stays.'))]);

        this._categoryPage('voltage', _('Monitor voltage'));

        this._categoryPage('fan', _('Monitor fan'));

        this._categoryPage('memory', _('Monitor memory'), '', [
            this._toggleRow('memory-measurement', _('Units'), _('Binary is KiB, MiB, GiB. Decimal is kB, MB, GB.'), [_('Binary'), _('Decimal')])]);

        this._categoryPage('processor', _('Monitor processor'), '', [
            this._switchRow('include-static-info', _('Include static information'), _('Values that never change, such as vendor and cache size.'))]);

        this._categoryPage('system', _('Monitor system'));

        this._categoryPage('network', _('Monitor network'), '', [
            this._switchRow('network-hardware-only', _('Only show hardware interfaces'), _('Hide bridges, container, VPN and loopback interfaces.'))],
            this._group(_('Speeds'),
                this._toggleRow('network-speed-format', _('Measure in'), '', [_('Bytes'), _('Bits')]),
                this._comboRow('network-speed-unit', _('Unit'), '', [_('Automatic'), _('kB/s or kbit/s'), _('MB/s or Mbit/s')])),
            this._group(_('Public IP Address'),
                this._switchRow('include-public-ip', _('Show public IP address'), _('Looked up over the internet from the provider below.')),
                this._toggleRow('network-public-ip-provider', _('Provider'), '', [_('Core Coding'), _('MyIP.com'), _('ipify')]),
                this._numberRow('network-public-ip-interval', _('Minutes between lookups'), 15, 1440),
                // ipify is the third provider, and it gives no country.
                this._usableWhile('network-public-ip-provider', provider => provider != 2,
                    this._switchRow('network-public-ip-show-flag', _('Show country flag'), _('Not available with ipify.')))));

        this._categoryPage('storage', _('Monitor storage'), '', [
            this._toggleRow('storage-measurement', _('Units'), _('Binary is KiB, MiB, GiB. Decimal is kB, MB, GB.'), [_('Binary'), _('Decimal')])],
            this._storageLocations(),
            this._group(_('Network Storage Locations'),
                this._numberRow('storage-network-interval', _('Minutes between updates'), 1, 1440)));

        this._categoryPage('battery', _('Monitor battery'));

        this._categoryPage('gpu', _('Monitor GPU'), _('NVIDIA cards are read with the nvidia-smi tool.'), [
            this._switchRow('include-static-gpu-info', _('Include static information'),
                _('Values that never change, such as driver version and power limit.'))]);

        this._orderCategoryPages();
        this._settings.connect('changed::catalog', () => this._orderCategoryPages());
        this._settings.connect('changed::category-order', () => this._orderCategoryPages());
    }

    // The icons of the categories are the extension's own, in the style the user chose.
    _applyIconStyle() {
        let iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        let ownIcons = `${this.path}/icons/`;
        let style = ['original', 'gnome'][this._settings.get_int('icon-style')];
        iconTheme.set_search_path([ownIcons + style, ...iconTheme.get_search_path().filter(directory => !directory.startsWith(ownIcons))]);
    }

    _underHeaderBar(content, headerBarProperties) {
        let view = new Adw.ToolbarView({ content });
        view.add_top_bar(new Adw.HeaderBar(headerBarProperties));
        return view;
    }

    _page(name, title, iconName, ...groups) {
        let page = new Adw.PreferencesPage();
        for (let group of groups)
            page.add(group);
        this._pages.add_titled_with_icon(page, name, title, iconName);
        return page;
    }

    _group(title, ...rows) {
        let group = new Adw.PreferencesGroup({ title });
        for (let row of rows)
            group.add(row);
        return group;
    }

    // The page of a category: the switch that turns the category on, and what can only be set while it is on,
    // `rows` next to the switch and `groups` below.
    _categoryPage(name, switchTitle, switchSubtitle = '', rows = [], ...groups) {
        // Whether a category is switched on is part of the saved catalog.
        let categorySwitch = new Adw.SwitchRow({ title: switchTitle, subtitle: switchSubtitle, active: readCatalog(this._settings)[name].enabled });
        categorySwitch.connect('notify::active', () => writeCategoryEnabled(this._settings, name, categorySwitch.active));
        for (let dependent of [...rows, ...groups])
            categorySwitch.bind_property('active', dependent, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        // A category has one name and one icon, those of the menu.
        let page = this._page(name, _(sensorCategories[name].name), sensorCategories[name].icon.replace('.svg', ''),
            this._group('', categorySwitch, ...rows), ...groups);
        this._colorScales(name, page, categorySwitch);
    }

    // The colour scales of a category, below the settings on its page. A scale is a list of breakpoints: from this
    // value on, or up to it for a sensor whose low values are the bad ones, the value is shown in this colour.
    _colorScales(name, page, categorySwitch) {
        let key = name + '-colors';
        // The breakpoints of all scales, as they are saved. A change is made here and saved; adding or removing
        // something draws the scales again from here.
        let breakpoints = sanitizeAndSortColorEntries(this._settings.get_strv(key));
        let save = () => this._settings.set_strv(key, breakpoints.sort(compareColorEntries).map(formatColorEntry));
        let restructure = change => {
            change();
            save();
            draw();
        };
        let groups = [];
        let draw = () => {
            for (let group of groups)
                page.remove(group);
            let targets = this._colorTargets(name);
            let withScale = new Set(breakpoints.map(breakpoint => breakpoint.target));
            // The scales stand in the order in which they are offered, then those of sensors that are gone.
            let scaleTargets = [...[...targets.keys()].filter(target => withScale.has(target)), ...[...withScale].filter(target => !targets.has(target)).sort()];
            groups = scaleTargets.map(target => {
                let scale = breakpoints.filter(breakpoint => breakpoint.target == target);
                let {label, unit, decimals, lowIsBad} = targets.get(target) ??
                    {label: _('%s (unavailable)').format(target.slice(target.indexOf(':') + 1)), unit: '', decimals: 1};
                let group = this._group(label, ...scale.map(breakpoint => {
                    let threshold = this._numberField(-1000000, 1000000, decimals);
                    threshold.value = breakpoint.threshold;
                    threshold.connect('value-changed', () => {
                        breakpoint.threshold = threshold.value;
                        save();
                    });
                    let color = new Gtk.ColorDialogButton({
                        valign: Gtk.Align.CENTER,
                        dialog: new Gtk.ColorDialog({ with_alpha: false }),
                        // A colour component is saved as a share of 1 or, by hand, as a number up to 255.
                        rgba: new Gdk.RGBA({ ...Object.fromEntries(['red', 'green', 'blue'].map(component =>
                            [component, breakpoint[component] > 1 ? breakpoint[component] / 255 : breakpoint[component]])), alpha: 1 }),
                    });
                    color.connect('notify::rgba', () => {
                        ({ red: breakpoint.red, green: breakpoint.green, blue: breakpoint.blue } = color.rgba);
                        save();
                    });
                    let row = new Adw.ActionRow({ title: lowIsBad ? _('Up to') : _('From'), activatable_widget: threshold });
                    row.add_suffix(threshold);
                    row.add_suffix(new Gtk.Label({ label: unit }));
                    row.add_suffix(color);
                    row.add_suffix(this._iconButton('edit-delete-symbolic', _('Remove breakpoint'),
                        () => restructure(() => breakpoints.splice(breakpoints.indexOf(breakpoint), 1))));
                    return row;
                }));
                let addBreakpoint = new Adw.ButtonRow({ title: _('Add breakpoint'), start_icon_name: 'list-add-symbolic' });
                // The new breakpoint is the highest of its scale.
                addBreakpoint.connect('activated', () => restructure(() => breakpoints.push(
                    { ...DEFAULT_THRESHOLD_RGBA, target, threshold: Math.max(...scale.map(breakpoint => breakpoint.threshold)) + 10 ** (1 - decimals) })));
                group.add(addBreakpoint);
                group.set_header_suffix(this._iconButton('user-trash-symbolic', _('Remove color scale'),
                    () => restructure(() => breakpoints = breakpoints.filter(breakpoint => breakpoint.target != target))));
                return group;
            });
            let withoutScale = [...targets.keys()].filter(target => !withScale.has(target));
            if (withoutScale.length > 0) {
                let targetChoice = new Gtk.DropDown({
                    valign: Gtk.Align.CENTER,
                    model: Gtk.StringList.new(withoutScale.map(target => targets.get(target).label)),
                });
                let add = new Gtk.Button({ valign: Gtk.Align.CENTER, label: _('Add') });
                add.connect('clicked', () => restructure(() => breakpoints.push(
                    { ...DEFAULT_THRESHOLD_RGBA, target: withoutScale[targetChoice.selected], threshold: 0 })));
                let addScale = new Adw.ActionRow({ title: _('Add color scale') });
                addScale.add_suffix(targetChoice);
                addScale.add_suffix(add);
                groups.push(this._group(groups.length > 0 ? '' : _('Threshold Colors'), addScale));
            }
            for (let group of groups) {
                page.add(group);
                categorySwitch.bind_property('active', group, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            }
        };
        // The scales are drawn each time the page comes into view, so they are in order again after a value was
        // changed, and a page that is never looked at creates none. They are drawn again when another setting
        // changes while they are in view: a unit they show, or the sensors of the machine.
        page.connect('map', draw);
        this._settings.connect('changed', (settings, changedKey) => {
            if (changedKey != key && page.get_mapped())
                draw();
        });
    }

    // Whose colour scale the page of a category offers, by what a breakpoint calls it (see helpers/colors.js), in
    // the order of the list: first all sensors of one kind of value, then each sensor, in the alphabetical order of
    // the labels the menu shows, with numbers in them counted ("Core 2" before "Core 10"). Each has the label of
    // its scale, the unit and the decimals of its breakpoints, and whether its low values are the bad ones.
    _colorTargets(name) {
        let category = readCatalog(this._settings)[name];
        let formatter = new Formatter(this._settings);
        let byLabel = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        // A category has no sensors before the extension has looked for hardware once. A sensor whose value is
        // text cannot be coloured.
        let sensors = (category.sensors ?? [])
            .filter(sensor => sensorPresent(category, sensor) && formatter.colorScale(sensor.format))
            .map(sensor => ({ ...sensor, label: sensor.customLabel ?? sensor.label }))
            .sort((sensor, other) => byLabel.compare(sensor.label, other.label));
        let targets = new Map();
        for (let format of new Set(sensors.map(sensor => sensor.format))) {
            let alike = sensors.filter(sensor => sensor.format == format);
            // One scale for all sensors of a kind is offered when there are several and their bad end is the same.
            if (alike.length < 2 || alike.some(sensor => sensor.lowIsBad != alike[0].lowIsBad))
                continue;
            let [, unit, decimals] = formatter.colorScale(format);
            targets.set('kind:' + format, { label: unit ? _('All values in %s').format(unit) : _('All values without a unit'), unit, decimals, lowIsBad: alike[0].lowIsBad });
        }
        for (let sensor of sensors) {
            let [, unit, decimals] = formatter.colorScale(sensor.format);
            targets.set(`sensor:${name}/${sensor.key}`, { label: sensor.label, unit, decimals, lowIsBad: sensor.lowIsBad });
        }
        return targets;
    }

    // The storage locations the user added, each with a button that removes it, then the mount points that can be
    // added, then the switch for what Files lists as mounted.
    _storageLocations() {
        let group = this._group(_('Storage Locations'));
        let volumesSwitch = this._switchRow('storage-monitor-volumes', _('Monitor what is mounted in Files'),
            _('Drives and shares that Files lists as mounted, for as long as they are mounted. A share that was opened inside Files is not among them.'));
        let rows = [];
        let textOf = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        let draw = () => {
            for (let row of rows)
                group.remove(row);
            let added = this._settings.get_strv('storage-locations');
            let save = locations => this._settings.set_strv('storage-locations', locations);
            let mounts = parseMountTable(textOf('/proc/self/mountinfo'));
            // Which mount points are offered first is libgtop's rule for a disk and df's rule for a share, both as
            // they are. Every other mount point can be added as well.
            let typesWithoutDevice = parseTypesWithoutDevice(textOf('/proc/filesystems'));
            // The file exists once something was mounted with an option that is not the kernel's.
            let userOptions = GLib.file_test('/run/mount/utab', GLib.FileTest.EXISTS) ? textOf('/run/mount/utab') : '';
            let hiddenMountPoints = userOptions.split('\n').filter(line => line.includes('x-gdu.hide'))
                .map(line => line.split(' ').find(field => field.startsWith('TARGET=')).slice(7));
            let offeredFirst = (location, mount) => isRemoteMount(mount) ||
                (!typesWithoutDevice.has(mount.type) || mount.type == 'zfs') && !hiddenMountPoints.includes(location);
            let offered = new Adw.ExpanderRow({ title: _('Add a storage location') });
            let otherMountPoints = new Adw.ExpanderRow({ title: _('Other mount points') });
            for (let location of [...mounts.keys()].filter(location => !added.includes(location)).sort()) {
                let row = new Adw.ActionRow({ title: location, subtitle: mounts.get(location).source, use_markup: false });
                row.add_suffix(this._iconButton('list-add-symbolic', _('Add storage location'), () => save([...added, location])));
                (offeredFirst(location, mounts.get(location)) ? offered : otherMountPoints).add_row(row);
            }
            offered.add_row(otherMountPoints);
            rows = [...added.map(location => {
                let row = new Adw.ActionRow({ title: location, subtitle: mounts.get(location)?.source ?? _('Not mounted'), use_markup: false });
                row.add_suffix(this._iconButton('edit-delete-symbolic', _('Remove storage location'),
                    () => save(added.filter(other => other != location))));
                return row;
            }), offered, volumesSwitch];
            for (let row of rows)
                group.add(row);
        };
        // The list is made each time the page comes into view, since disks and shares come and go.
        group.connect('map', draw);
        this._settings.connect('changed::storage-locations', () => {
            if (group.get_mapped())
                draw();
        });
        return group;
    }

    _iconButton(iconName, tooltip, clicked) {
        let button = new Gtk.Button({ icon_name: iconName, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        button.connect('clicked', clicked);
        return button;
    }

    // The categories are listed in the order of the menu, also when the user rearranges it there while this window
    // is open. A stack cannot move a page, so the pages are taken out and added again.
    _orderCategoryPages() {
        let shown = this._pages.visible_child_name;
        let names = categoriesInOrder(readCatalog(this._settings), name => _(sensorCategories[name].name),
            this._settings.get_int('category-order') == MANUAL_CATEGORY_ORDER);
        for (let name of names) {
            let page = this._pages.get_child_by_name(name);
            let {title, icon_name} = this._pages.get_page(page);
            this._pages.remove(page);
            let entry = this._pages.add_titled_with_icon(page, name, title, icon_name);
            // The categories are a section of the sidebar, headed by the first of them.
            entry.starts_section = name == names[0];
            entry.section_title = name == names[0] ? _('Sensors') : '';
        }
        this._pages.visible_child_name = shown;
    }

    _bound(key, widget, property) {
        this._settings.bind(key, widget, property, Gio.SettingsBindFlags.DEFAULT);
        return widget;
    }

    _switchRow(key, title, subtitle = '') {
        return this._bound(key, new Adw.SwitchRow({ title, subtitle }), 'active');
    }

    // A list to choose from. The setting holds the position of the chosen entry.
    _comboRow(key, title, subtitle, entries) {
        return this._bound(key, new Adw.ComboRow({ title, subtitle, model: Gtk.StringList.new(entries) }), 'selected');
    }

    // A number, in a field that takes digits only. Adw.SpinRow is not used: it shows the number without a field.
    _numberField(lowest, highest, decimals) {
        return new Gtk.SpinButton({
            valign: Gtk.Align.CENTER,
            numeric: true,
            digits: decimals,
            adjustment: new Gtk.Adjustment({ lower: lowest, upper: highest, step_increment: 10 ** -decimals }),
        });
    }

    _numberRow(key, title, lowest, highest) {
        let field = this._bound(key, this._numberField(lowest, highest, 0), 'value');
        let row = new Adw.ActionRow({ title, activatable_widget: field });
        row.add_suffix(field);
        return row;
    }

    // A choice with all its entries in view. The setting holds the position of the chosen entry.
    _toggleRow(key, title, subtitle, entries) {
        let toggles = new Adw.ToggleGroup({ valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false });
        for (let label of entries)
            toggles.add(new Adw.Toggle({ label }));
        let row = new Adw.ActionRow({ title, subtitle });
        row.add_suffix(this._bound(key, toggles, 'active'));
        return row;
    }

    // A text. An emptied field saves `emptyText`, which it then shows in grey.
    _textRow(key, title, subtitle, emptyText) {
        let field = new Gtk.Entry({ valign: Gtk.Align.CENTER, width_chars: 24, placeholder_text: emptyText, text: this._settings.get_string(key) });
        field.connect('changed', () => this._settings.set_string(key, field.text || emptyText));
        let row = new Adw.ActionRow({ title, subtitle, activatable_widget: field });
        row.add_suffix(field);
        return row;
    }

    // The update interval is a number of seconds, chosen from these.
    _updateRow() {
        let choices = [[1, _('1 second')], [2, _('2 seconds')], [3, _('3 seconds')], [5, _('5 seconds')], [10, _('10 seconds')],
            [15, _('15 seconds')], [30, _('30 seconds')], [60, _('60 seconds')]];
        let row = new Adw.ComboRow({
            title: _('Update every'),
            subtitle: _('Only sensors on screen are read: those in the top bar and in the open menu.'),
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
            // An interval that was set another way and is not offered here shows no choice.
            selected: choices.findIndex(([seconds]) => seconds == this._settings.get_int('update-time')) >>> 0,
        });
        row.connect('notify::selected', () => this._settings.set_int('update-time', choices[row.selected][0]));
        return row;
    }

    // `row` can only be used while the setting `key` has a value that `usable` accepts.
    _usableWhile(key, usable, row) {
        let sync = () => row.set_sensitive(usable(this._settings.get_int(key)));
        this._settings.connect('changed::' + key, sync);
        sync();
        return row;
    }
}
