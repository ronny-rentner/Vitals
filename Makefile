UUID := Vitals@CoreCoding.com
EXTENSION_FILES := extension.js metadata.json prefs.js stylesheet.css sensors.js formatter.js menuItem.js croppedIcon.js helpers icons locale schemas
ZIP := vitals.zip

# UI scale (a whole number) and text scale, independent of the display resolution.
SCALE ?= 1
TEXT_SCALE ?= 1.25
# Headless display size in pixels; the interactive preview follows its devkit window size.
RESOLUTION ?= 1280x720

# A target that runs a Shell keeps its settings and its copy of the extension under build/<target>, away from the
# desktop's own.
export XDG_CONFIG_HOME = $(CURDIR)/build/$@/config
export XDG_DATA_HOME = $(CURDIR)/build/$@/data
export XDG_CACHE_HOME = $(CURDIR)/build/$@/cache
export XDG_STATE_HOME = $(CURDIR)/build/$@/state
# The window of `preview` appears on the desktop. The name of the desktop's Wayland socket is looked up in the
# runtime directory, so it becomes a full path before the runtime directory changes.
export WAYLAND_DISPLAY := $(XDG_RUNTIME_DIR)/$(WAYLAND_DISPLAY)
export XDG_RUNTIME_DIR = $(CURDIR)/build/$@/runtime
export GTK_A11Y := none
export NO_AT_SPI_BUS_DIRECT_NAV := 1
export GTK_USE_PORTAL := 0
export GDK_DEBUG := no-portals
export ADW_DISABLE_PORTAL := 1
# pipewire's realtime module asks the system for a higher priority, which a preview and a test do not need.
# wireplumber loads the module regardless, so there its messages are switched off.
export WIREPLUMBER_DEBUG := mod.rt:0
# What shell-session.sh needs from here.
export UUID EXTENSION_FILES SCALE TEXT_SCALE

# A recipe is one shell script that stops at the first command that fails, so that an `export` holds for the
# commands after it. The `@` of its first line keeps make from printing the script.
.ONESHELL:
.SHELLFLAGS := -ec

.PHONY: preview test-shell screenshots compile translations zip test clean clean-env country-icons
# What `make` alone runs.
.DEFAULT_GOAL := preview

compile:
	@echo ":: Compiling the settings schema..."
	glib-compile-schemas --strict schemas

# A Shell in a window, with the extension. Its settings are under build/preview and are kept between runs.
preview: compile
	@echo "Running in persistent home: $(CURDIR)/build/preview"
	dbus-run-session -- bash shell-session.sh --wayland --devkit

# The checks inside a Shell without a screen. It starts from the schema defaults.
test-shell: compile
	@echo ":: Running tests/shell.test.js in a Shell without a screen..."
	dbus-run-session -- bash shell-session.sh --reset-settings \
		--wayland --headless --virtual-monitor $(RESOLUTION) \
			--automation-script tests/shell.test.js

# Capture at twice the display size so documentation images stay sharp on high-density screens.
screenshots: SCALE = 2
screenshots: TEXT_SCALE = 1
screenshots: RESOLUTION = 3840x2160
screenshots: compile
	@echo ":: Taking the pictures in docs/screenshots again..."
	export SCREENSHOT_DIR=$(CURDIR)/docs/screenshots
	dbus-run-session -- bash shell-session.sh --reset-settings \
		--wayland --headless --virtual-monitor $(RESOLUTION) \
			--automation-script docs/screenshots/screenshots.js

translations:
	@echo ":: Compiling translations..."
	for po in locale/*/LC_MESSAGES/vitals.po; do
		msgfmt "$$po" -o "$${po%.po}.mo"
	done

# The package of the extension, without the sources of the translations. An entry of an older package that is no
# longer a file is removed from it (-FS).
zip: compile translations
	@echo ":: Creating extension bundle..."
	zip -qr -FS $(ZIP) $(EXTENSION_FILES) -x 'locale/*.po' 'locale/vitals.pot'

clean:
	rm -f $(ZIP)

country-icons:
	@echo ":: Drawing the country icons..."
	gjs -m country-icons.js

# What the three Shells keep: their settings and their copy of the extension.
clean-env:
	rm -rf build/preview build/test-shell build/screenshots

test: compile
	@echo ":: Running the unit tests..."
	gjs -m tests/sensorMath.test.js
	gjs -m tests/formatter.test.js
	gjs -m tests/colors.test.js
	gjs -m tests/categories.test.js
	gjs -m tests/sensors.test.js
