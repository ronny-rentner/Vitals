# What this version changes against upstream Vitals

Compared: upstream `corecoding/Vitals` at `main` (`7108c2a`, metadata version 84) and the branch `catalog-rewrite`, on 2026-10-08.

The size of the change: 23 runtime files changed, about 2,500 lines added and 2,350 removed. `sensors.js` and `extension.js` are rewritten, `values.js` is replaced by `formatter.js`, and the three helper files for files, subprocesses and bytes are gone. The runtime code is the same size as before (about 3,700 lines).

## What is better

Ranked by what upstream's users ask for: the open issues of `corecoding/Vitals` that a point answers, and how many people reacted to or commented on them (in brackets, counted on 2026-10-08). Points without an issue follow, by how many users they reach.

1. **The top bar can be reordered by drag and drop.** Answers #93 "Reorder indicators" (46), the most supported open request, open since 2019. Upstream shows pinned sensors in the order they were pinned; people in that issue edit the setting by hand. An unpinned sensor keeps its place for when it is pinned again.
2. **`nvidia-smi` runs only while a GPU value is on screen.** Answers #275 "Check if dGPU is awake before polling" (11) and #442 "Option Monitor GPU prevents NVIDIA from going to sleep" (6). Upstream starts `nvidia-smi` as soon as GPU monitoring is switched on and keeps it running. Here it runs while a GPU value is pinned or the menu is open, and is stopped otherwise. Tested with a stand-in for `nvidia-smi`; that a real card then goes to sleep is not tested.
3. **Less than half the CPU in the default setup.** With the menu closed and the three default sensors in the top bar, the Shell uses 7.0 ms of CPU per second with this version and 16.3 ms with upstream, at a one-second interval; without either it uses 2.7 ms. Upstream's tracker has several reports of CPU load, lag and battery drain (#533, #260, #250, #150). With more sensors pinned or the menu open this version is not faster; see "Speed and memory, measured".
4. **Sensors can be renamed, hidden and chosen for the category header.** Answers #83 "Customize labels" (14) and #222 "Hide unwanted sensors" (8). A click on a row opens a panel with its actions, built like the second-level menus of GNOME's quick settings: pin to the top bar, pin to the category's header, rename, hide. The name is typed in the panel's head. A hidden sensor is also left out of the average, minimum and maximum, so a sensor that reads nonsense no longer spoils them. Upstream has neither.
5. **The network numbers are right, and the list stays clean.** Answers five open issues. The totals count the hardware interfaces only, so traffic through a bridge, a container or a VPN is not counted two or three times: #377 "Boot RX is not correct" (7), #319 "combines both Ethernet interface and the Bridge that contains it". An interface that is gone loses its rows: #360 "Network Interfaces are not removed", #557 "remembers every single network adapter, including ephemeral ones". There is a sensor for download plus upload: #198 "Combine net up/down in panel" (2). Only the hardware interfaces are listed; an option brings back the bridges, container and VPN interfaces.
6. **Tests.** Upstream has none, and its tracker has at least six reports of freezes, crashes and CPU spikes (#533, #286, #260, #250, and the open #542 and #582). This version has 67 unit tests that run the collector unchanged against a recorded `/sys` and `/proc`, and a test inside a headless GNOME Shell that checks the menu, the top bar, a real drag and the preferences window (about 1,400 checks).
7. **No extra package.** Upstream reads storage space through `libgtop`, shows none without it, and its README tells users which package to install on each distribution (#421 is about those instructions being wrong for Arch). This version asks GLib, which is always there, and does so in the background instead of on the Shell's main thread.
8. **Even spacing in the top bar.** Answers #505 "Custom spacing" and #398 on the item's position; the closed #41 "Please add indicator spacing" (12) and #141 (14) were about the same. Every icon is the same distance from its value and from its neighbour; upstream's gaps range from 0 to 6 pixels, because the icon files differ and are corrected by hand per category.
9. **Values are not stale.** A sensor that cannot be read is hidden until it can be read again; upstream ignores a failed read (26 empty `catch` blocks in `sensors.js`) and the row keeps its last value. One unreadable temperature no longer empties the average, minimum and maximum.
10. **Voltages are not mixed.** Relates to #381 "PSU Voltage contaminating Voltage monitoring". Upstream shows an average, minimum and maximum over all voltages, which puts a 17 V battery, a 1.2 V rail and a 5 V USB supply into one number. Those three rows are gone, and the header shows the battery's voltage, then the system's, and a USB supply's only when there is nothing else.
11. **Every battery is shown.** Answers #263 "Display two batteries at the same time" (6). Upstream shows one battery, which the user picks from a list of eight names. Here every battery that powers the machine is found by the type the kernel gives it, under any name, each with its own values, and with several the header shows their power rates together. The setting is gone. Tested with made-up batteries; this machine has one.
12. **The top bar is made for reading.** Icons and units are lighter and smaller than the numbers, and one option switches that off. Every unit stands three pixels from its number; upstream writes "80%" without a gap and "3 KB/s" with a full space. Digits have one width. The room a value keeps free is given back after a minute; upstream keeps the widest width a value ever had until the extension restarts.
13. **The menu holds still.** It has one width; upstream's is as wide as its widest row. It opens centered under the pointer and stays where it opened. Upstream starts the menu's left edge under the middle of the panel item, which moves as the item's values change width, and pushes it back in at the screen edge; where it appears follows no rule a user can see. The option to center it under the item is kept. The open category is remembered while the menu is closed. Short and long categories open the same way.
14. **Rows have a fixed order.** Sensors are always in alphabetical order. Upstream's option to switch sorting off does not show them in a meaningful order: a row is then inserted at a position computed from the number of properties of the row object (`extension.js`, `_appendMenuItem`). The option is gone.
15. **The network category can be read.** It is in sections with plain labels: the machine's speeds, the hardware interfaces ("WiFi (wlp0s20f3) download speed"), the volumes, and, when the option for them is on, the virtual interfaces below a line. Upstream lists "wlp0s20f3 rx", "Device rx", "Boot rx" and "Session rx" in one alphabetical run. In the temperature and fan categories, the average, minimum and maximum stand below a line and can be switched off.
16. **Pins and colours survive a renamed label.** Sensor keys are built from what the kernel provides. Upstream builds them from the label that is shown, so renaming or translating a label drops the user's pin and colour rule for it.
17. **Units are written the standard way.** `kB`, `kHz` and `kbit/s`, with a lowercase k for a thousand and a slash for every rate. Upstream writes `KB`, `KHz` and, for bits, `Kbps`, next to `KB/s` for bytes.
18. **More sensors.** The thermal zones of `/sys/class/thermal`, without those that hwmon already covers; the processor's power limit; the ThinkPad lap mode. Two devices with the same name, such as two NVMe drives, each get their own sensor. New hardware is looked for each time the menu opens; upstream looks when the extension is switched on.
19. **Preferences.** The update interval is a list of eight values; upstream's slider from 1 to 60 makes it hard to hit one second or two, and shows its value in small grey text. The descriptions say what the names do not. The preferences window no longer runs its own hardware discovery.
20. **`metadata.json` carries no `version`.** extensions.gnome.org sets it on upload; upstream's file has a hand-set 84.
21. **One catalog.** Everything known about the sensors is plain data in one place, with room for further fields per sensor.
22. **Screenshots that can be made again.** `make screenshots` takes the pictures of `docs/screenshots/`: the top bar with each appearance setting and the menu, in the dark and the light style. Upstream's README shows one recorded animation.

## What upstream's users ask for most and this does not do

- #143 "Multiple Storage Locations" (40), with #455 and #503.
- #451 "Order Menu Components" (25). Categories are in alphabetical order here; they cannot be arranged.
- #269 "CPU Frequency Reported Incorrectly" (23). The frequency is read the same way as upstream.
- #314 "Make indicator configuration more discoverable" (17).
- #426 and #366, icons per temperature sensor (17 together).
- #540 "Power Rate is always positive even when discharging" (4). The same calculation is used here.

## What is different, without being better or worse

- **Hide-zeros applies to temperatures only.** Upstream also leaves out a voltage that reads zero when it is found.
- **At start, a reading saved less than a minute ago is shown** until the first reading, which follows at once. That covers a screen that was locked for a moment. Otherwise "…" is shown, as upstream does.
- **No "+" in front of voltages.**
- **A sensor key means less.** Upstream's key, such as `_temperature_thinkpad_temp1_`, is a sensor's address everywhere: for its menu row, its top-bar item, and in the settings. Here a key such as `thinkpad/temp1` only tells a sensor apart from the others in its category, and is used for one thing: to recognise a saved sensor again when the hardware is looked for. Everything else holds the sensor itself.
- **Category switches and the panel are saved in the catalog,** not in ten `show-*` settings and `hot-sensors`.
- **A failed read is written to the journal only with debug output on.**

## What is lost or worse

1. **Settings are not carried over.** Pinned sensors, the category switches, and colour rules for single sensors are saved in a new form and are not converted. After the update a user has the default panel and the default categories, and per-sensor colour rules no longer match. Colour rules for a whole category and all other settings are kept.
2. **Translations.** The new and changed texts exist in English only: the network labels, the new options, the rewritten descriptions. The 22 language files are untouched, so those texts fall back to English.
3. **Several graphics cards share one menu section.** Upstream gives every card a section ("Graphics 1", "Graphics 2"). Here all cards are in "Graphics", with labels such as "GPU 2 Utilization", and the header shows the first card. With one card nothing changes. Not tested on a machine with two cards.

## Speed and memory, measured

Measured on 2026-10-08 on one ThinkPad, in a headless GNOME Shell 50 with a 1280×720 screen and a one-second update interval. The numbers are the CPU time of the whole Shell process per second, averaged over two runs of 30 seconds each, taken back to back, and its memory after start. Single runs differ by about 2 ms.

| | No extension | Upstream | This version |
|---|---|---|---|
| Menu closed, default panel (3 sensors) | 2.7 ms | 16.3 ms | 7.0 ms |
| Menu closed, 8 sensors pinned, among them the temperature and fan averages | | 21.8 ms | 24.0 ms |
| Menu open, all categories closed | | 25.2 ms | 26.7 ms |
| Menu open, temperature category open | | 26.0 ms | 30.5 ms |
| Memory (resident) | 216 MB | 244 to 261 MB | 249 to 263 MB |

- In the default setup this version uses less than half of upstream's CPU time.
- With the temperature average on screen, this version is 2 to 4 ms per second slower. The cause is the six thermal zones it reads and upstream does not ("More sensors" above): five of them ask the firmware on every read, which costs about 0.7 ms of CPU each in the kernel. With the thermal zones left out, the same measurement with 8 sensors pinned gives 22.0 ms for this version and 25.4 ms for upstream.
- What a read costs depends on the file, measured with 300 reads each: a `/proc` file or a `coretemp` temperature about 0.05 ms, an NVMe or ThinkPad temperature 0.25 to 0.5 ms, a thermal zone that asks the firmware 0.7 to 0.8 ms, a ThinkPad fan 0.8 to 1.1 ms. With 8 sensors pinned, the reads are about 18 of the 24 ms, and drawing the values about 3.
- Not measured: other machines, other intervals, a real desktop session with a graphics card.

## What is not known

- **Other machines.** Desktop boards with many hwmon chips, AMD and NVIDIA graphics, several batteries, machines without a battery: none were run. The NVIDIA path is tested with a stand-in for `nvidia-smi`, not with a card.
- **Other Shell versions.** Run on GNOME Shell 50 only; `metadata.json` lists 45 to 51.
- **Other themes and right-to-left languages.** The top-bar spacing and the menu placement were looked at with the default theme, left to right.
- **Upstream issues.** Which open issues of the upstream project this fixes or does not fix was not checked.

## Assessment for a pull request

As it stands this is hard to accept as one pull request: it replaces most of the code, and it resets what users have set up. One change would remove point 1 of the list above:

- **Convert the old settings once.** Read `hot-sensors`, the ten `show-*` settings and the sensor keys in the colour rules, and write them into the catalog.

What is left after that is one gap that needs other people (translations, point 2) and one that needs other hardware (several graphics cards, point 3).

Things worth offering upstream on their own, because each is small and useful without the rest: the network totals over hardware interfaces only, the removal of the GTop dependency, the even icon spacing, and the tests.
