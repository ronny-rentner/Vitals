# Runs a GNOME Shell with the extension, isolated under the directory given as the first argument: there it gets its
# own XDG directories and its own session bus, so it cannot touch the desktop's files or settings. The remaining
# arguments go to gnome-shell.
set -e

dir=$(realpath -m "${1:?Usage: shell-session.sh DIR [gnome-shell options]}")
shift

export XDG_CONFIG_HOME="$dir/config"
export XDG_DATA_HOME="$dir/data"
export XDG_CACHE_HOME="$dir/cache"
export XDG_STATE_HOME="$dir/state"
# The window appears on the desktop. The name of the desktop's Wayland socket is looked up in the runtime directory,
# so it becomes a full path before the runtime directory changes.
export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
export XDG_RUNTIME_DIR="$dir/runtime"
export GTK_A11Y=none
export NO_AT_SPI_BUS_DIRECT_NAV=1
export GTK_USE_PORTAL=0
export GDK_DEBUG=no-portals
export ADW_DISABLE_PORTAL=1
# pipewire's realtime module asks the system for a higher priority, which a preview does not need.
# wireplumber loads the module regardless, so there its messages are switched off.
export WIREPLUMBER_DEBUG=mod.rt:0

# Replace the staged extension so deleted source files cannot survive into the next run.
rm -rf "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/$UUID" "$XDG_CONFIG_HOME/systemd/user" "$XDG_RUNTIME_DIR/keyring" \
	"$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"

chmod 700 "$XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR/keyring"

# wireplumber's script that mutes on unplugging removes four hooks at its start that it never registered, with an
# error for each. The session has no audio devices, so the script is left out.
echo 'wireplumber.profiles = { policy = { hooks.device.routes.automute-alsa = disabled } }' \
	> "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/no-automute.conf"

cp -r $EXTENSION_FILES "$XDG_DATA_HOME/gnome-shell/extensions/$UUID/"

# Everything that talks to the session bus.
run_session() {
	#eval $(gnome-keyring-daemon --daemonize --components=secrets)

	gsettings set org.gnome.shell disable-extension-version-validation true
	gsettings set org.gnome.shell enabled-extensions "['$UUID']"
	gsettings set org.gnome.desktop.search-providers disabled \
		"['org.gnome.Characters.desktop', 'org.gnome.font-viewer.desktop', 'org.gnome.Software.desktop', 'org.gnome.clocks.desktop']"
	gsettings set org.gnome.desktop.interface scaling-factor $SCALE
	gsettings set org.gnome.desktop.interface text-scaling-factor $TEXT_SCALE

	# gwctl-preview finds this session's bus through this file.
	echo "$DBUS_SESSION_BUS_ADDRESS" > "$XDG_RUNTIME_DIR/bus-address"
	# pipewire does not end with the session bus, so it is stopped with the session.
	trap 'kill $(jobs -p)' EXIT
	pipewire --properties '{ module.rt = false }' &
	wireplumber --profile policy &

	if [ "$1" = --reset-settings ]; then
		gsettings --schemadir schemas reset-recursively org.gnome.shell.extensions.vitals
		shift
	fi

	gnome-shell "$@"
}

# The bus starts only now, after the XDG directories are set: the dconf service it starts for gsettings writes into the
# directories it inherits. The bash that dbus-run-session starts gets run_session through the environment.
export -f run_session
dbus-run-session -- bash -ec 'run_session "$@"' bash "$@"
