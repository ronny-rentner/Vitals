# The session every Shell target of the Makefile runs in, on a session bus of its own; $1 is the target's own command.
# With the runtime directory of its own, it reaches neither the desktop's session bus nor the services of the desktop's
# runtime directory. The window of `preview` gets the Shell's picture through pipewire, so the session has a pipewire
# of its own, which looks for no hardware (the profile `policy`).
set -e

mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/$UUID" "$XDG_CONFIG_HOME/systemd/user" "$XDG_RUNTIME_DIR/keyring" \
	"$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"

chmod 700 "$XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR/keyring"

# wireplumber's script that mutes on unplugging removes four hooks at its start that it never registered, with an
# error for each. The session has no audio devices, so the script is left out.
echo 'wireplumber.profiles = { policy = { hooks.device.routes.automute-alsa = disabled } }' \
	> "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/no-automute.conf"

cp -r $EXTENSION_FILES "$XDG_DATA_HOME/gnome-shell/extensions/$UUID/"

#eval $(gnome-keyring-daemon --daemonize --components=secrets)

gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.desktop.search-providers disabled \
	"['org.gnome.Characters.desktop', 'org.gnome.font-viewer.desktop', 'org.gnome.Software.desktop', 'org.gnome.clocks.desktop']"
gsettings set org.gnome.desktop.interface scaling-factor $SCALE
gsettings set org.gnome.desktop.interface text-scaling-factor $TEXT_SCALE

# pipewire does not end with the session bus, so it is stopped with the session.
trap 'kill $(jobs -p)' EXIT
pipewire --properties '{ module.rt = false }' &
wireplumber --profile policy &

eval "$1"
