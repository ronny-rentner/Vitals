UUID := Vitals@CoreCoding.com
EXTENSION_FILES := extension.js metadata.json prefs.js stylesheet.css sensors.js formatter.js menuItem.js croppedIcon.js helpers icons locale schemas
ZIP := vitals.zip

# UI scale (a whole number) and text scale, independent of the display resolution.
SCALE ?= 2
TEXT_SCALE ?= 1.25
# Headless display size in pixels; the interactive preview follows its devkit window size.
RESOLUTION ?= 3840x2160

# What shell-session.sh needs from here.
export SCALE TEXT_SCALE

.ONESHELL:
.SHELLFLAGS := -ec

.PHONY: preview test-shell screenshots compile translations zip install lint test tests clean clean-env country-icons
.DEFAULT_GOAL := preview

compile:
	@echo ":: Compiling the settings schema..."
	glib-compile-schemas --strict schemas

# Settings are under build/preview and are kept between runs.
preview: zip
	@bash shell-session.sh "$(ZIP)" "$(CURDIR)/build/$@"

test-shell: zip
	@echo ":: Running tests/shell.test.js in a Shell without a screen..."
	bash shell-session.sh "$(ZIP)" "$(CURDIR)/build/$@" --reset-settings \
		--wayland --headless --virtual-monitor $(RESOLUTION) \
			--automation-script tests/shell.test.js

screenshots: zip
	@echo ":: Taking the pictures in docs/screenshots again..."
	export SCREENSHOT_DIR=$(CURDIR)/docs/screenshots
	bash shell-session.sh "$(ZIP)" "$(CURDIR)/build/$@" --reset-settings \
		--wayland --headless --virtual-monitor $(RESOLUTION) \
			--automation-script docs/screenshots/screenshots.js

translations:
	@echo ":: Compiling translations..."
	for po in locale/*/LC_MESSAGES/vitals.po; do
		msgfmt "$$po" -o "$${po%.po}.mo"
	done

zip: compile translations
	@echo ":: Creating extension bundle..."
	zip -qr -FS $(ZIP) $(EXTENSION_FILES) -x 'locale/*.po' 'locale/vitals.pot'
	echo ":: Extension bundle ready: $(abspath $(ZIP))"

install: zip
	@echo ":: Installing extension..."
	gnome-extensions install --force "$(ZIP)"
	echo ":: Installed $(UUID). Log out and back in to load it."

clean:
	rm -f $(ZIP)

country-icons:
	@echo ":: Drawing the country icons..."
	gjs -m country-icons.js

clean-env:
	rm -rf build/preview build/test-shell build/screenshots

lint:
	@echo ":: Checking JavaScript with ESLint..."
	./tools/node_modules/.bin/eslint --config tools/eslint.config.mjs .

tests: test

test: compile
	@echo ":: Running the unit tests..."
	gjs -m tests/sensorMath.test.js
	gjs -m tests/formatter.test.js
	gjs -m tests/colors.test.js
	gjs -m tests/categories.test.js
	gjs -m tests/sensors.test.js
