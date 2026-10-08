.PHONY: preview test test-shell

preview test-shell: export XDG_CONFIG_HOME = $(CURDIR)/build/$@/config
preview test-shell: export XDG_DATA_HOME = $(CURDIR)/build/$@/data
preview test-shell: export XDG_CACHE_HOME = $(CURDIR)/build/$@/cache
preview test-shell: export GSETTINGS_BACKEND := keyfile
preview: SHELL_ARGS := --devkit
test-shell: SHELL_ARGS := --headless --virtual-monitor 1280x720 --automation-script tests/shell.test.js
# The shell test starts from the schema defaults; the preview keeps what was set in it.
test-shell: RESET_SETTINGS := gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals

preview test-shell:
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
