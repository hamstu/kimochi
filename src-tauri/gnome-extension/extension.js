import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Stable entry point: GNOME caches this module for the entire login. Implementations
// use immutable filenames, so disable/enable imports genuinely new code each time.
export default class KimochiLoader extends Extension {
    async _load(pointer) {
        const [, bytes] = this.dir.get_child(pointer).load_contents(null);
        const revision = new TextDecoder().decode(bytes).trim();
        if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid Kimochi implementation revision');
        const moduleFile = this.dir.get_child(`revisions/${revision}.js`);
        if (!moduleFile.query_exists(null)) throw new Error('Missing Kimochi implementation');
        const {default: Implementation} = await import(moduleFile.get_uri());
        this._implementation = new Implementation({...this.metadata, dir: this.dir, path: this.path, revision});
        try { await this._implementation.enable(); }
        catch (error) { this.disable(); throw error; }
    }

    async enable() {
        try { await this._load('revision'); }
        catch (error) {
            console.error(`Kimochi update failed; restoring previous implementation: ${error}`);
            // Do not leave GNOME in ERROR: it refuses subsequent enable calls there.
            // The updater checks Status.revision and restores the pointer too.
            await this._load('previous-revision');
        }
    }

    disable() {
        this._implementation?.disable();
        this._implementation = null;
    }
}
