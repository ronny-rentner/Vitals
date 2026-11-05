# Screenshots

[Documentation index](../README.md) · [Updating screenshots](../development.md#screenshots)

[Top bar](#top-bar) · [Menu](#menu) · [Preferences](#preferences)

Captures use UI scale 2 and are displayed smaller here. Click an image to see it at full resolution. The top-bar examples show the button highlighted under the pointer.

## Top bar

Default appearance. Top-bar icons have transparent borders removed while preserving each icon's proportions.

<img width="50%" src="top-bar.png" alt="Default top bar with cropped icons, dark style"><br><img width="50%" src="top-bar-light.png" alt="Default top bar with cropped icons, light style">

**Top Bar** › **Emphasize values** disabled. When enabled, icons and units are drawn lighter and smaller than the numbers.

<img width="50%" src="top-bar-plain.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-plain-light.png" alt="Top bar, light style">

**General** › **Icon style** set to Adwaita.

<img width="50%" src="top-bar-gnome-icons.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-gnome-icons-light.png" alt="Top bar, light style">

**Top Bar** › **Hide icons** enabled. Menu icons remain visible.

<img width="50%" src="top-bar-no-icons.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-no-icons-light.png" alt="Top bar, light style">

**General** › **Use higher precision** enabled. Battery charge, battery power rate and processor frequency gain a decimal place; uptime includes seconds.

<img width="50%" src="top-bar-precision.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-precision-light.png" alt="Top bar, light style">

**Temperature** › **Unit** set to °F and **Network** › **Measure in** set to **Bits**. The pinned sensors show download and upload speed, total data downloaded and uploaded since boot, and the processor's temperature.

<img width="50%" src="top-bar-fahrenheit-bits.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-fahrenheit-bits-light.png" alt="Top bar, light style">

**Threshold Colors** defined on the temperature and memory pages. A color applies from its threshold value up to the next one.

<img width="50%" src="top-bar-colors.png" alt="Top bar, dark style"><br><img width="50%" src="top-bar-colors-light.png" alt="Top bar, light style">

Default appearance with other pins: WiFi signal with its bars, battery charge, screen redraws and free storage.

<img width="50%" src="top-bar-many.png" alt="Additional readings, dark style"><br><img width="50%" src="top-bar-many-light.png" alt="Additional readings, light style">

### Dynamic icons

Memory and WiFi icons change with their readings. These examples show memory used and WiFi link quality, with simulated readings for 32 GiB of RAM.

<img height="32" src="top-bar-dynamic-low.png" alt="4 GiB memory used and 8% WiFi link quality, with empty bars"><br>
<img height="32" src="top-bar-dynamic-medium.png" alt="16 GiB memory used and 66% WiFi link quality, with partially filled bars"><br>
<img height="32" src="top-bar-dynamic-high.png" alt="28 GiB memory used and 94% WiFi link quality, with full bars">

## Menu

Each category header shows its selected reading. One category can be open at a time. Selecting a sensor opens its row menu with actions to pin, rename or hide it. The rest of the menu is dimmed while the row menu is open.

The network category is shown with **Network** › **Only show hardware interfaces** enabled, which is the default. It hides bridges, container, VPN and loopback interfaces.

### Categories closed

<img width="50%" src="menu.png" alt="Sensor categories, dark style">

<details>
<summary>Light style</summary>

<img width="50%" src="menu-light.png" alt="Sensor categories, light style">

</details>

### Network category open

<img width="50%" src="menu-network.png" alt="Network category expanded, dark style">

<details>
<summary>Light style</summary>

<img width="50%" src="menu-network-light.png" alt="Network category expanded, light style">

</details>

### Sensor actions

<img width="50%" src="menu-actions.png" alt="Upload speed row menu, dark style">

<details>
<summary>Light style</summary>

<img width="50%" src="menu-actions-light.png" alt="Upload speed row menu, light style">

</details>

## Preferences

The preferences window, showing the general page.

<img width="100%" src="preferences.png" alt="Preferences, general page">
