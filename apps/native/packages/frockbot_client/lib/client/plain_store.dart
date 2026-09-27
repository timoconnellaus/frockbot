/// The store the app runs on, which differs by where the app runs: the phone
/// keeps a plain document beside the platform keystore, the browser keeps
/// everything in `localStorage` and holds no secret at all.
library;

export 'plain_store_io.dart'
    if (dart.library.js_interop) 'plain_store_web.dart';
