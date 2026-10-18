import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {devices, filesystems} from './fixtures/machine.js';

// The functions Machine stands behind, as they are before it is installed.
const real = {
    newForPath: Gio.File.new_for_path,
    newForUri: Gio.File.new_for_uri,
    volumeMonitor: Gio.VolumeMonitor.get,
    monotonicTime: GLib.get_monotonic_time,
    timeoutAdd: GLib.timeout_add,
    sourceRemove: GLib.Source.remove
};

function notFound(path) {
    return new Gio.IOErrorEnum({code: Gio.IOErrorEnum.NOT_FOUND, message: path});
}

// The test double for the system that Sensors monitors: its /sys and /proc, the space of its filesystems, the mounts
// of Gio.VolumeMonitor, the answers of the public IP services and the monotonic clock. It starts as the fixture's
// `system`; the test changes it by plugging device groups of the fixture in and out, setting and removing files, and
// failing or holding reads. Every other path goes to the real Gio.
export class Machine {
    constructor() {
        // The device groups of the fixture that are plugged in, in the order they were plugged.
        this._plugged = ['system'];
        // The content the test set for a path, undefined where it removed the file.
        this._setContents = new Map();
        this._readErrors = new Map();
        this._listErrors = new Map();
        this._heldReads = new Map();
        this._skippedMicroseconds = 0;
        // The timers that are set and not yet due, by their id: when each is due on the machine's clock, and what it calls.
        this._timers = new Map();
        this._lastTimer = 0;
        this._builtMicroseconds = real.monotonicTime();
        // Every file read so far, in order.
        this.reads = [];
        // Every path that was asked for the space of its filesystem so far, in order.
        this.asked = [];
        // The paths of the mounts that `Gio.VolumeMonitor` reports. A mount that has no path is null.
        this.volumes = [];
    }

    // Puts the machine in place of the system, for every caller in this interpreter. Only a test that runs in an
    // interpreter of its own may do that: in the Shell's, the Shell itself would read the machine.
    install() {
        Gio.File.new_for_path = path => this._answers(path) ? this._file(path) : real.newForPath(path);
        // The machine answers every web address itself, so that no test reaches the internet. An address without an
        // answer in the fixture fails like a missing file.
        Gio.File.new_for_uri = uri => uri.startsWith('https://') ? this._file(uri) : real.newForUri(uri);
        Gio.VolumeMonitor.get = () => ({get_mounts: () => this.volumes.map(path =>
            ({get_root: () => ({get_path: () => path})}))});
        GLib.get_monotonic_time = () => real.monotonicTime() + this._skippedMicroseconds;
        // Timers run on the machine's clock: they fire when a test skips time past them.
        GLib.timeout_add = (priority, milliseconds, callback) => {
            this._timers.set(++this._lastTimer, {due: GLib.get_monotonic_time() + milliseconds * 1000, callback});
            return this._lastTimer;
        };
        GLib.Source.remove = id => this._timers.delete(id);
    }

    uninstall() {
        Gio.File.new_for_path = real.newForPath;
        Gio.File.new_for_uri = real.newForUri;
        Gio.VolumeMonitor.get = real.volumeMonitor;
        GLib.get_monotonic_time = real.monotonicTime;
        GLib.timeout_add = real.timeoutAdd;
        GLib.Source.remove = real.sourceRemove;
    }

    plug(name) {
        this._plugged.push(name);
    }

    unplug(name) {
        this._plugged = this._plugged.filter(plugged => plugged != name);
    }

    // Lets so many seconds pass at once, as a suspend does, so that a test of an interval does not wait it out. The
    // timers that fall due meanwhile fire, the earliest first.
    skip(seconds) {
        this._skippedMicroseconds += seconds * 1000000;
        let nextDue = () => [...this._timers].filter(([, timer]) => timer.due <= GLib.get_monotonic_time())
            .sort(([, first], [, second]) => first.due - second.due)[0];
        for (let due = nextDue(); due; due = nextDue()) {
            this._timers.delete(due[0]);
            due[1].callback();
        }
    }

    // The file's content as it is now, undefined when there is no such file.
    content(path) {
        if (this._setContents.has(path))
            return this._setContents.get(path);
        let seconds = (GLib.get_monotonic_time() - this._builtMicroseconds) / 1000000;
        let parts = this._plugged.map(name => devices[name][path]).filter(part => part !== undefined)
            .map(part => typeof part == 'function' ? part(seconds) : part);
        return parts.length ? parts.join('') : undefined;
    }

    setContent(path, content) {
        this._setContents.set(path, content);
    }

    remove(path) {
        this._setContents.set(path, undefined);
    }

    // Gives a file that the test set or removed its content from the device groups again.
    restore(path) {
        this._setContents.delete(path);
    }

    failReads(path, error) {
        this._readErrors.set(path, error);
    }

    failLists(directoryPath, error) {
        this._listErrors.set(directoryPath, error);
    }

    // Keeps the next read of the file, or the next question for the space at the path, open until the test calls
    // `finish` on what this returns. `cancellable` is the one the reader passed, once the read has started.
    holdNextRead(path) {
        let heldRead = {finish: null, cancellable: null};
        this._heldReads.set(path, heldRead);
        return heldRead;
    }

    // Vitals' paths: /sys, /proc and the mount points whose space is asked.
    _answers(path) {
        return path.startsWith('/sys/') || path.startsWith('/proc/') || filesystems[path] !== undefined;
    }

    _childNames(directoryPath) {
        if (this._listErrors.has(directoryPath))
            throw this._listErrors.get(directoryPath);
        let prefix = directoryPath.endsWith('/') ? directoryPath : directoryPath + '/';
        let paths = new Set([...this._plugged.flatMap(name => Object.keys(devices[name])), ...this._setContents.keys()]);
        let names = new Set([...paths].filter(path => path.startsWith(prefix) && this.content(path) !== undefined)
            .map(path => path.slice(prefix.length).split('/')[0]));
        if (!names.size)
            throw notFound(directoryPath);
        return [...names];
    }

    // Answers at once, unless the test holds the next read of this path.
    _answer(path, cancellable, answer) {
        let heldRead = this._heldReads.get(path);
        if (!heldRead) {
            answer();
            return;
        }
        this._heldReads.delete(path);
        heldRead.cancellable = cancellable;
        heldRead.finish = answer;
        // A web request ends as soon as it is cancelled. A read of a file or a question for the space waits for the
        // kernel, cancelled or not.
        if (path.startsWith('https://'))
            cancellable.connect(() => answer(new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: path})));
    }

    // Only the Gio.File calls that Sensors makes. Callbacks run at once, except for a held read; the outcome is
    // decided in *_finish.
    _file(path) {
        let machine = this;
        return {
            load_contents_async(cancellable, callback) {
                machine._answer(path, cancellable, error => callback(this, error));
            },
            // The result is the error that ended the read, if one did.
            load_contents_finish(error) {
                machine.reads.push(path);
                if (error)
                    throw error;
                if (machine._readErrors.has(path))
                    throw machine._readErrors.get(path);
                let content = machine.content(path);
                if (content === undefined)
                    throw notFound(path);
                return [true, new TextEncoder().encode(content), null];
            },
            enumerate_children_async(attributes, flags, priority, cancellable, callback) {
                callback(this, null);
            },
            enumerate_children_finish() {
                let remainingNames = machine._childNames(path);
                return {
                    next_files_async(count, priority, enumeratorCancellable, callback) {
                        callback(this, null);
                    },
                    next_files_finish() {
                        return remainingNames.splice(0).map(name => ({get_name: () => name}));
                    },
                    close_async(priority, enumeratorCancellable, callback) {
                        callback(this, null);
                    },
                    close_finish() {}
                };
            },
            query_filesystem_info_async(attributes, priority, cancellable, callback) {
                machine.asked.push(path);
                machine._answer(path, cancellable, () => callback(this, null));
            },
            query_filesystem_info_finish() {
                let filesystem = filesystems[path];
                if (filesystem === undefined)
                    throw notFound(path);
                return {get_attribute_uint64: attribute => filesystem[attribute]};
            }
        };
    }
}
