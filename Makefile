UUID := Vitals@CoreCoding.com
EXTENSION_FILES := extension.js metadata.json prefs.js stylesheet.css sensors.js formatter.js menuItem.js helpers icons locale schemas
ZIP := vitals.zip

# The scale of the screen, a whole number, and of the text: `make test-shell SCALE=2 TEXT_SCALE=1.25`.
# The screen grows with its scale, so that it shows as much.
SCALE ?= 1
TEXT_SCALE ?= 1

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

# The session every Shell target runs in, on a session bus of its own; $$1 is the target's own command. With the runtime
# directory of its own, it reaches neither the desktop's session bus nor the services of the desktop's runtime directory.
# The window of `preview` gets the Shell's picture through pipewire, so the session has a pipewire of its own, which
# looks for no hardware (the profile `policy`).
define SESSION

mkdir -p "$$XDG_DATA_HOME/gnome-shell/extensions/$(UUID)" "$$XDG_CONFIG_HOME/systemd/user" "$$XDG_RUNTIME_DIR/keyring" \
	"$$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"

chmod 700 "$$XDG_RUNTIME_DIR" "$$XDG_RUNTIME_DIR/keyring"

# wireplumber's script that mutes on unplugging removes four hooks at its start that it never registered, with an
# error for each. The session has no audio devices, so the script is left out.
echo 'wireplumber.profiles = { policy = { hooks.device.routes.automute-alsa = disabled } }' \
	> "$$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/no-automute.conf"

cp -r $(EXTENSION_FILES) "$$XDG_DATA_HOME/gnome-shell/extensions/$(UUID)/"

#eval $$(gnome-keyring-daemon --daemonize --components=secrets)

gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell enabled-extensions "['$(UUID)']"
gsettings set org.gnome.desktop.search-providers disabled \
	"['org.gnome.Characters.desktop', 'org.gnome.font-viewer.desktop', 'org.gnome.Software.desktop', 'org.gnome.clocks.desktop']"
gsettings set org.gnome.desktop.interface scaling-factor $(SCALE)
gsettings set org.gnome.desktop.interface text-scaling-factor $(TEXT_SCALE)

# pipewire does not end with the session bus, so it is stopped with the session.
trap 'kill $$(jobs -p)' EXIT
pipewire --properties '{ module.rt = false }' &
wireplumber --profile policy &

eval "$$1"

endef
export SESSION

# A recipe is one shell script that stops at the first command that fails, so that an `export` holds for the
# commands after it. The `@` of its first line keeps make from printing the script.
.ONESHELL:
.SHELLFLAGS := -ec

.PHONY: preview test-shell screenshots compile zip test clean clean-env
# What `make` alone runs.
.DEFAULT_GOAL := preview

compile:
	@echo ":: Compiling the settings schema..."
	glib-compile-schemas --strict schemas

# A Shell in a window, with the extension. Its settings are under build/preview and are kept between runs.
preview: compile
	@echo "Running in persistent home: $(CURDIR)/build/preview"
	dbus-run-session -- bash -ec "$$SESSION" session 'gnome-shell --wayland --devkit'

# The checks inside a Shell without a screen. It starts from the schema defaults.
test-shell: compile
	@echo ":: Running tests/shell.test.js in a Shell without a screen..."
	dbus-run-session -- bash -ec "$$SESSION" session ' \
		gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals; \
		gnome-shell --wayland --headless --virtual-monitor $$((1280 * $(SCALE)))x$$((720 * $(SCALE))) \
			--automation-script tests/shell.test.js'

# The pictures in docs/screenshots, taken again. It starts from the schema defaults.
screenshots: compile
	@echo ":: Taking the pictures in docs/screenshots again..."
	export SCREENSHOT_DIR=$(CURDIR)/docs/screenshots
	dbus-run-session -- bash -ec "$$SESSION" session ' \
		gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals; \
		gnome-shell --wayland --headless --virtual-monitor $$((1920 * $(SCALE)))x$$((1080 * $(SCALE))) \
			--automation-script docs/screenshots/screenshots.js'

# The package of the extension, without the sources of the translations. An entry of an older package that is no
# longer a file is removed from it (-FS).
zip: compile
	@echo ":: Creating extension bundle..."
	zip -qr -FS $(ZIP) $(EXTENSION_FILES) -x 'locale/*.po' 'locale/vitals.pot'

clean:
	rm -f $(ZIP)

# What the three Shells keep: their settings and their copy of the extension.
clean-env:
	rm -rf build/preview build/test-shell build/screenshots

test: compile
	@echo ":: Running the unit tests..."
	gjs -m tests/sensors.collection.test.js
	gjs -m tests/sensorMath.test.js
	gjs -m tests/formatter.test.js
	gjs -m tests/colors.test.js
	gjs -m tests/categories.test.js
	gjs -m tests/sensors.test.js
