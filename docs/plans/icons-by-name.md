# Icons by name, from the reading, overridable by a theme

## Context
A sensor's icon is fixed at discovery: its field names it (`{icon: 'read'}`), discovery writes `sensor.icon` into the catalog, and the renderer loads the file of that name from the extension's `icons/` folder by path. A path cannot be overridden by an icon theme, and an icon cannot follow the value, such as the bars of a WiFi signal. The flags of the public IP were removed: colourful, they did not fit the monochrome icons.

## 1. Icons by name
- Every icon has a name of its own, such as `vitals-temperature-symbolic`; `-symbolic` makes it monochrome, coloured by the theme.
- The extension's `icons/` folder is the last place the icon theme looks, so its icons are the fallback, and an icon of the same name in the user's theme or in `~/.local/share/icons` wins.
- To check first: how an extension adds a folder to the search path of the Shell's icon theme in GNOME 50.

## 2. The icon follows the reading
- A field may compute its icon from the reading, as it computes its value. Each reading writes `sensor.icon` with `sensor.value`; the collector stays the one that decides it, and the icon stays in the catalog.
- The renderer compares the icon of a sensor whose reading changed, and swaps it only when it differs.
- WiFi signal: GNOME's own `network-wireless-signal-{none,weak,ok,good,excellent}-symbolic`, at the thresholds of GNOME Shell's network indicator, named in the comment.
- Battery charge: GNOME's own battery level icons, if their steps fit.

## 3. The country of the public IP
- The country code comes from the provider's answer and is shown as an icon next to the address. The icon's name is built from the code, in lowercase: `vitals-country-<code>-symbolic`, such as `vitals-country-de-symbolic`. No list of countries is in the code.
- Fallback: one icon per country code, the two letters drawn small and monochrome, in the size and line weight of the other icons. The letters are paths, not SVG text, which would take whatever font the machine has. A script in the repo draws them from one font, so the set can be made again.
- A theme can replace any of them, for example with a coloured flag.

## Done
- The Shell's icon theme is an `St.IconTheme` of the extension's own: it follows the user's theme, and the folder of the style and `icons/countries/` are appended to its search path. A name is looked up once and kept until the theme or the style changes.
- Country codes: ipv4.corecoding.com answers `countryCode`, api.myip.com `cc` ("XX" when unknown), ipify none, as upstream reads them.
- The icons: an outlined rounded rectangle with the letters filled in Adwaita Sans Bold, 249 codes from Debian's iso-codes, 354 kB. Cut out of a filled rectangle, the letters broke, because a letter of the font is made of parts that overlap.
- Thermometers that fill and fan blades that turn with the speed fit the same mechanism: a field names its icon by the step of its value.

## Verification
- `make test`: a WiFi sensor's icon changes with its signal; the public IP's icon names the country of each service, and none for ipify.
- `make screenshots`, looked at and not kept: the menu shows the WiFi bars, the top bar and the preferences both icon styles.
