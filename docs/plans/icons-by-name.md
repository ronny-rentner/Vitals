# Themeable icons that follow sensor readings

[Documentation index](../../README.md#historical-plans) · [Current icon rules](../design.md#icons) · [Development](../development.md#code-conventions)

**Historical plan.** The notes below describe the proposal and its implementation at the time. The public-IP providers, font and verification notes are outdated; they are not current setup instructions or approval for additional icon variants. Follow the current icon rules linked above.

## Original context

When we proposed this change, discovery fixed each sensor's icon. The field supplied its name (`{icon: 'read'}`), discovery stored it as `sensor.icon`, and the renderer loaded that file directly from `icons/`. Loading by path prevented icon themes from overriding it. The icon also could not change with the reading, as WiFi signal bars should. We had removed public-IP flags because their colours did not fit the monochrome icons.

## 1. Icons by name

- Give each icon a name, such as `vitals-temperature-symbolic`. The `-symbolic` suffix makes it monochrome, coloured by the theme.
- Put the extension's `icons/` folder last in the icon theme's search path. An icon with the same name in the user's theme or in `~/.local/share/icons` then takes precedence over the extension's fallback.
- First check how an extension adds a folder to the Shell's icon theme search path in GNOME 50.

## 2. The icon follows the reading

- A field may compute its icon from the reading, just as it computes its value. Each reading updates `sensor.icon` alongside `sensor.value`. The collector chooses the icon and stores it in the catalog.
- When a sensor's reading changes, the renderer checks its icon and replaces it only if the name has changed.
- WiFi signal: use GNOME's `network-wireless-signal-{none,weak,ok,good,excellent}-symbolic` icons and the thresholds from GNOME Shell's network indicator. Cite that indicator in the comment.
- Battery charge: GNOME's own battery level icons, if their steps fit.

## 3. The country of the public IP

- Use the country code from the provider's response to show an icon next to the address. Build its name from the lowercase code: `vitals-country-<code>-symbolic`, such as `vitals-country-de-symbolic`. This needs no list of countries in the code.
- Supply one fallback icon per country code: two small, monochrome letters matching the size and line weight of the other icons. Draw the letters as paths, since SVG text would depend on the fonts installed on the machine. A script in the repo generates the set from one font, so it can be reproduced.
- A theme can replace any of them, for example with a coloured flag.

## Implementation notes at the time

- The extension uses its own `St.IconTheme`, which follows the user's theme. It appends the selected icon style's folder and `icons/countries/` to the search path. Each name is looked up once and cached until the theme or style changes.
- Country codes, as read by upstream: ipv4.corecoding.com returns `countryCode`; api.myip.com returns `cc` ("XX" when unknown); ipify returns none.
- Each icon has an outlined rounded rectangle and filled letters in Adwaita Sans Bold. The set contains 249 codes from Debian's iso-codes and takes 354 kB. Cutting the letters out of a filled rectangle damaged their shapes because the font builds letters from overlapping parts.
- The same mechanism could support thermometers that fill and fan blades that turn with the speed: a field would choose an icon for each range of values.

## Verification recorded at the time

- `make test`: the tests checked that a WiFi sensor's icon changed with its signal and that the public-IP icon used each service's country code, with none for ipify.
- `make screenshots`: we inspected the captures but did not keep them. They showed WiFi bars in the menu and both icon styles in the top bar and preferences.
