import Gio from 'gi://Gio';

function notFound(path) {
    return new Gio.IOErrorEnum({code: Gio.IOErrorEnum.NOT_FOUND, message: path});
}

// The /sys and /proc of one test, and its mounted filesystems. It starts with a fixture's files; the test then
// drives it by writing and removing files. `file` stands in for Gio.File.new_for_path, so the code under test
// reads it unchanged.
export class Machine {
    constructor(files, filesystems) {
        this._contents = new Map(Object.entries(files));
        this._filesystems = filesystems;
        this._readErrors = new Map();
        this._listErrors = new Map();
        this._heldReads = new Map();
        // Every file read so far, in order.
        this.reads = [];
        // Every path that was asked for the space of its filesystem so far, in order.
        this.asked = [];
        // The paths of the mounts that GNOME's volume monitor reports. A mount that has no path is null.
        this.volumes = [];
    }

    content(path) {
        return this._contents.get(path);
    }

    write(path, content) {
        this._contents.set(path, content);
    }

    remove(path) {
        this._contents.delete(path);
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

    _childNames(directoryPath) {
        if (this._listErrors.has(directoryPath))
            throw this._listErrors.get(directoryPath);
        let prefix = directoryPath.endsWith('/') ? directoryPath : directoryPath + '/';
        let names = new Set();
        for (let path of this._contents.keys()) {
            if (path.startsWith(prefix))
                names.add(path.slice(prefix.length).split('/')[0]);
        }
        if (!names.size)
            throw notFound(directoryPath);
        return [...names];
    }

    // The filesystem mounted closest above the path, as statfs resolves it.
    _filesystemHolding(path) {
        let mountPoint = Object.keys(this._filesystems).filter(candidate => path.startsWith(candidate))
            .sort((a, b) => b.length - a.length)[0];
        if (mountPoint === undefined)
            throw notFound(path);
        return this._filesystems[mountPoint];
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
    }

    // Stands in for Gio.VolumeMonitor.get, with the one call that Sensors makes.
    volumeMonitor() {
        return {get_mounts: () => this.volumes.map(path => ({get_root: () => ({get_path: () => path})}))};
    }

    // Only the Gio.File calls that Sensors makes. Callbacks run at once, except for a held read; the outcome is decided in *_finish.
    file(path) {
        let machine = this;
        return {
            load_contents_async(cancellable, callback) {
                machine._answer(path, cancellable, () => callback(this, null));
            },
            load_contents_finish() {
                machine.reads.push(path);
                if (machine._readErrors.has(path))
                    throw machine._readErrors.get(path);
                if (!machine._contents.has(path))
                    throw notFound(path);
                return [true, new TextEncoder().encode(machine._contents.get(path)), null];
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
                let filesystem = machine._filesystemHolding(path);
                return {get_attribute_uint64: attribute => filesystem[attribute]};
            }
        };
    }
}
