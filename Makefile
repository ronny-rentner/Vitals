.PHONY: preview test test-shell screenshots zip

# What an installed extension consists of.
EXTENSION_FILES := extension.js metadata.json prefs.js stylesheet.css sensors.js formatter.js menuItem.js helpers icons locale schemas

# The scale of the screen, a whole number, and of the text, for example `make test-shell SCALE=2 TEXT_SCALE=1.25`.
# The screen grows with its scale, so that it shows as much.
SCALE ?= 1
TEXT_SCALE ?= 1

preview test-shell screenshots: export XDG_CONFIG_HOME = $(CURDIR)/build/$@/config
preview test-shell screenshots: export XDG_DATA_HOME = $(CURDIR)/build/$@/data
preview test-shell screenshots: export XDG_CACHE_HOME = $(CURDIR)/build/$@/cache
preview test-shell screenshots: export GSETTINGS_BACKEND := keyfile
preview: SHELL_ARGS := --devkit
test-shell: SHELL_ARGS = --headless --virtual-monitor $$((1280 * $(SCALE)))x$$((720 * $(SCALE))) --automation-script tests/shell.test.js
screenshots: SHELL_ARGS = --headless --virtual-monitor $$((1920 * $(SCALE)))x$$((1080 * $(SCALE))) --automation-script docs/screenshots/screenshots.js
screenshots: export SCREENSHOT_DIR = $(CURDIR)/docs/screenshots
# The shell test and the screenshots start from the schema defaults; the preview keeps what was set in it.
test-shell screenshots: RESET_SETTINGS := gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals

preview test-shell screenshots:
	glib-compile-schemas --strict schemas
	$(RESET_SETTINGS)
	mkdir -p "$(XDG_DATA_HOME)/gnome-shell/extensions/Vitals@CoreCoding.com"
	cp -r $(EXTENSION_FILES) "$(XDG_DATA_HOME)/gnome-shell/extensions/Vitals@CoreCoding.com/"
	gsettings set org.gnome.shell enabled-extensions "['Vitals@CoreCoding.com']"
	gsettings set org.gnome.desktop.interface scaling-factor $(SCALE)
	gsettings set org.gnome.desktop.interface text-scaling-factor $(TEXT_SCALE)
	GDK_DEBUG=no-portals ADW_DISABLE_PORTAL=1 dbus-run-session -- gnome-shell --wayland $(SHELL_ARGS)

# The package of the extension, without the sources of the translations. An entry of an older package that is no
# longer a file is removed from it (-FS).
zip:
	glib-compile-schemas --strict schemas
	zip -qr -FS vitals.zip $(EXTENSION_FILES) -x 'locale/*.po' 'locale/vitals.pot'

test:
	glib-compile-schemas --strict schemas
	gjs -m tests/sensors.collection.test.js
	gjs -m tests/sensorMath.test.js
	gjs -m tests/formatter.test.js
	gjs -m tests/colors.test.js
	gjs -m tests/categories.test.js
	gjs -m tests/sensors.test.js
