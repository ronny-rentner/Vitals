.PHONY: preview test test-shell screenshots

preview test-shell screenshots: export XDG_CONFIG_HOME = $(CURDIR)/build/$@/config
preview test-shell screenshots: export XDG_DATA_HOME = $(CURDIR)/build/$@/data
preview test-shell screenshots: export XDG_CACHE_HOME = $(CURDIR)/build/$@/cache
preview test-shell screenshots: export GSETTINGS_BACKEND := keyfile
preview: SHELL_ARGS := --devkit
test-shell: SHELL_ARGS := --headless --virtual-monitor 1280x720 --automation-script tests/shell.test.js
screenshots: SHELL_ARGS := --headless --virtual-monitor 1920x1080 --automation-script docs/screenshots/screenshots.js
screenshots: export SCREENSHOT_DIR = $(CURDIR)/docs/screenshots
# The shell test and the screenshots start from the schema defaults; the preview keeps what was set in it.
test-shell screenshots: RESET_SETTINGS := gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals

preview test-shell screenshots:
	glib-compile-schemas --strict schemas
	$(RESET_SETTINGS)
	mkdir -p "$(XDG_DATA_HOME)/gnome-shell/extensions/Vitals@CoreCoding.com"
	cp -r extension.js metadata.json prefs.js prefs.ui stylesheet.css sensors.js formatter.js menuItem.js panelValue.js helpers icons locale schemas "$(XDG_DATA_HOME)/gnome-shell/extensions/Vitals@CoreCoding.com/"
	gsettings set org.gnome.shell enabled-extensions "['Vitals@CoreCoding.com']"
	GDK_DEBUG=no-portals ADW_DISABLE_PORTAL=1 dbus-run-session -- gnome-shell --wayland $(SHELL_ARGS)

test:
	glib-compile-schemas --strict schemas
	gjs -m tests/sensors.collection.test.js
	gjs -m tests/sensorMath.test.js
	gjs -m tests/formatter.test.js
	gjs -m tests/colors.test.js
	gjs -m tests/categories.test.js
	gjs -m tests/sensors.test.js
