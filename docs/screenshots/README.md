# Screenshots

[Documentation index](../../README.md) · [Using Vitals](../../README.md#using-vitals) · [Updating screenshots](../development.md#screenshots)

[Top bar](#top-bar) · [Menu](#menu) · [Preferences](#preferences)

## Top bar

By default, the top bar shows memory usage, system load and download speed. These screenshots add upload speed, average temperature and fan speed; captions identify examples with other pins. Battery and GPU monitoring are enabled, and the public IP address is hidden. Readings come from the machine used for capture.

| Setting | Result |
|---|---|
| Default appearance, including **Crop icons**. Cropping removes transparent borders while preserving each icon's proportions. | <img src="top-bar.png" alt="Default top bar with cropped icons, dark style" width="471"><br><img src="top-bar-light.png" alt="Default top bar with cropped icons, light style" width="477"> |
| Top Bar › **Emphasize values** disabled. When enabled, icons and units are drawn lighter and smaller than the numbers. | <img src="top-bar-plain.png" alt="Top bar, dark style" width="521"><br><img src="top-bar-plain-light.png" alt="Top bar, light style" width="513"> |
| Top Bar › **Crop icons** disabled. GNOME's stock square icon allocation leaves transparent space around narrow artwork. Menu icons always use stock sizing. | <img src="top-bar-stock-icons.png" alt="Top bar with stock icon sizing, dark style" width="477"><br><img src="top-bar-stock-icons-light.png" alt="Top bar with stock icon sizing, light style" width="473"> |
| General › **Icon style** set to Adwaita. | <img src="top-bar-gnome-icons.png" alt="Top bar, dark style" width="463"><br><img src="top-bar-gnome-icons-light.png" alt="Top bar, light style" width="459"> |
| Top Bar › **Hide icons** enabled. The icons in the menu stay. | <img src="top-bar-no-icons.png" alt="Top bar, dark style" width="369"><br><img src="top-bar-no-icons-light.png" alt="Top bar, light style" width="365"> |
| General › **Use higher precision** enabled. Values have one more decimal place, and uptimes include seconds. Shown: battery charge, battery power rate, processor frequency and uptime. | <img src="top-bar-precision.png" alt="Top bar, dark style" width="437"><br><img src="top-bar-precision-light.png" alt="Top bar, light style" width="457"> |
| Temperature › **Unit** set to °F and Network › **Measure in** set to Bits. Shown: download and upload speed, downloaded and uploaded since boot, and the processor's temperature. | <img src="top-bar-fahrenheit-bits.png" alt="Top bar, dark style" width="455"><br><img src="top-bar-fahrenheit-bits-light.png" alt="Top bar, light style" width="441"> |
| **Threshold Colors** defined on the Temperature and Memory pages. A color applies from its threshold value up to the next one. | <img src="top-bar-colors.png" alt="Top bar, dark style" width="482"><br><img src="top-bar-colors-light.png" alt="Top bar, light style" width="481"> |
| Default appearance with other pins: WiFi signal with its bars, battery charge, screen redraws and free storage. | <img src="top-bar-many.png" alt="Additional readings, dark style" width="326"><br><img src="top-bar-many-light.png" alt="Additional readings, light style" width="326"> |

## Menu

Each category header shows its selected reading. One category can be open at a time. Selecting a sensor opens its row menu with actions to pin, rename or hide it. The rest of the menu is dimmed while the row menu is open. See [Using Vitals](../../README.md#using-vitals) for the actions and category ordering.

The network category is shown with Network › **Only show hardware interfaces** enabled, which is the default. It hides bridges, container, VPN and loopback interfaces.

### Categories closed

<img src="menu.png" alt="Sensor categories, dark style" width="487">

<details>
<summary>Light style</summary>

<img src="menu-light.png" alt="Sensor categories, light style" width="477">

</details>

### Network category open

<img src="menu-network.png" alt="Network category expanded, dark style" width="487">

<details>
<summary>Light style</summary>

<img src="menu-network-light.png" alt="Network category expanded, light style" width="477">

</details>

### Sensor actions

<img src="menu-actions.png" alt="Upload speed row menu, dark style" width="487">

<details>
<summary>Light style</summary>

<img src="menu-actions-light.png" alt="Upload speed row menu, light style" width="477">

</details>

## Preferences

The preferences window, showing the General page.

<img src="preferences.png" alt="Preferences, General page" width="854">
