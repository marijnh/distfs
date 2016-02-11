# DistFS

Pull-based virtual filesystem to expose directory trees of ES6 code as
Babel-compiled code.

Uses [FUSE](https://github.com/mafintosh/fuse-bindings) to mount a
user-space filesystem that exposes the same directory structure but,
when you read the actual files, gives you the compiled scripts instead
of the original content. Will block accesses to the file until the
compilation is done, so that you're always sure that you have the
up-to-date code.

Changes to source files will automatically show up in the virtual
files.

To an extent, should should be able to use
[`fs.watch`](https://nodejs.org/api/fs.html#fs_fs_watch_filename_options_listener)
on files in the virtual file system to notice when they are updated.

Usage:

    distfs src dist

Where `src` is your source dir and `dist` is a directory (may be
empty, doesn't have to be) to be used as mount point. After doing
this, you'll have the compiled version of `src/foo/bar.js` available
as `dist/foo/bar.js`.

## Caveats

Only tested on Linux. Might work on OS X, likely not on Windows.

DistFS will cache all content in entirely memory. This is usually
good, since it means you can access precompiled code quickly, but it
also means that if you accidentally access a giant file through this,
it'll waste a lot of memory. To be safe, mount directories containing
only source code.
