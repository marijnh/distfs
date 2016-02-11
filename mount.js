"use strict"

var fuse = require("fuse-bindings")
var fs = require("fs-promise")

var dummy = {detach: function() {}}

function CachedDir(path, stats, options) {
  this.path = path
  this.stats = stats
  this.options = options
  this.upToDate = false
  this.cache = Object.create(null)
  this.updating = null
  this.watching = null
}

CachedDir.prototype.listen = function() {
  this.upToDate = false
  this.watching.close()
  this.watching = null
}

CachedDir.prototype.detach = function() {
  if (this.watching) this.watching.close()
  for (var name in this.cache) this.cache[name].detach()
}

CachedDir.prototype.content = function() {
  if (this.upToDate) return Promise.resolve(this.cache)
  if (this.updating) return this.updating
  return this.read()
}

CachedDir.prototype.read = function() {
  var self = this
  return this.updating = fs.readdir(this.path).then(function(files) {
    self.updating = null
    self.upToDate = true
    for (var file in self.cache) if (files.indexOf(file) == -1) {
      self.cache[file].detach()
      delete self.cache[file]
    }
    for (var i = 0; i < files.length; i++) {
      var file = files[i]
      if (!(file in self.cache)) self.cache[file] = dummy
    }
    if (self.watching) self.watching.close()
    self.watching = fs.watch(self.path, self.listen.bind(self))
    return self.cache
  })
}

CachedDir.prototype.getFile = function(name) {
  if (this.upToDate) return this.resolveEntry(name)
  var self = this
  return this.content().then(function() { return self.resolveEntry(name) })
}

CachedDir.prototype.resolveEntry = function(name) {
  var value = this.cache[name], self = this
  if (!value) return Promise.resolve(null)
  if (value == dummy) {
    var fullName = this.path + "/" + name
    return fs.stat(fullName).then(function(stats) {
      if (stats.isDirectory())
        return self.cache[name] = new CachedDir(fullName, stats, self.options)
      if (stats.isFile())
        return self.cache[name] = new CachedFile(fullName, stats, self.options)
      delete self.cache[name]
      return null
    }).catch(function(err) {
      if (err.errno) delete self.cache[name]
      throw err
    })
  }
  return Promise.resolve(self.cache[name])
}

CachedDir.prototype.resolve = function(path) {
  return this.getFile(path[0]).then(function(sub) {
    if (!sub) throw {errno: fuse.ENOENT}
    if (path.length == 1) return sub
    if (sub instanceof CachedFile) throw {errno: fuse.ENOTDIR}
    return sub.resolve(path.slice(1))
  })
}

function CachedFile(path, stats, options) {
  this.path = path
  this.stats = stats
  this.options = options
  this.data = null
  this.updating = null
  this.watching = null
  this.mtime = null
}

CachedFile.prototype.listen = function() {
  this.data = null
  this.watching.close()
  this.watching = null
  // When a file changed, we 'unlink' it (a no-op in this file system)
  // to trigger an inotify.
  fs.unlink(this.options.mountDir + this.path.slice(this.options.sourceDir.length))
}

CachedFile.prototype.detach = function() {
  if (this.watching) this.watching.close()
}

CachedFile.prototype.content = function() {
  if (this.data != null) return Promise.resolve(this.data)
  if (this.updating) return this.updating
  return this.read()
}

CachedFile.prototype.read = function() {
  var self = this
  return this.updating = fs.readFile(this.path).then(function(content) {
    self.updating = null
    self.data = self.options.filter ? self.options.filter(self.path, content) : content
    self.mtime = new Date
    self.watching = fs.watch(self.path, self.listen.bind(self))
    return self.data
  })
}

var Mount = module.exports = function(options) {
  this.options = options
  this.fds = []
  for (var i = 0; i < 10; i++) this.fds.push(null)

  this.top = new CachedDir(options.sourceDir, fs.statSync(options.sourceDir), options)
}

Mount.prototype.mount = function() {
  fuse.mount(this.options.mountDir, this.buildHandlers(), function (err) { if (err) throw err })
}

Mount.prototype.unmount = function(cb) {
  fuse.unmount(this.options.mountDir, cb)
}

Mount.prototype.openFD = function(file) {
  for (var fd = 10; fd < this.fds.length; fd++) if (!this.fds[fd]) {
    this.fds[fd] = file
    return fd
  }
  return this.fds.push(file) - 1
}

Mount.prototype.closeFD = function(fd) {
  if (fd < this.fds.length) this.fds[fd] = null
}

Mount.prototype.resolve = function(path) {
  if (path == "/") return Promise.resolve(this.top)
  return this.top.resolve(path.slice(1).split("/"))
}

Mount.prototype.buildHandlers = function() {
  var localHandlers = {options: this.options.mountOptions}
  for (var prop in handlers) localHandlers[prop] = handlers[prop].bind(this)
  return localHandlers
}

var uid = process.getuid(), gid = process.getgid()
function stats(obj, size, mode) {
  return {
    mtime: obj.mtime || obj.stats.mtime,
    atime: obj.stats.atime,
    ctime: obj.stats.ctime,
    size: size, mode: mode, uid: uid, gid: gid
  }
}

function wrapPromise(f) {
  return function() {
    var cb = arguments[arguments.length - 1]
    f.apply(this, arguments).then(function(value) {
      cb(value && value.errno || 0, value && value.value)
    }).catch(function(err) {
      if (err.errno == null) console.error(err.stack)
      cb(err.errno || fuse.ENOENT)
    })
  }
}

var dirMode = parseInt("40555", 8), fileMode = parseInt("100444", 8)

var handlers = {
  readdir: wrapPromise(function(path) {
    return this.resolve(path).then(function(dir) {
      if (dir instanceof CachedDir)
        return dir.content().then(function(files) {
          return {value: Object.keys(files)}
        })
      else
        return {errno: fuse.ENOTDIR}
    })
  }),

  getattr: wrapPromise(function(path) {
    return this.resolve(path).then(function(obj) {
      if (obj instanceof CachedDir)
        return {value: stats(obj, 4096, dirMode)}
      else
        return obj.content().then(function(content) {
          return {value: stats(obj, content.length, fileMode)}
        })
    })
  }),

  open: wrapPromise(function(path, flags) {
    if ((flags & 3) == 1)
      return Promise.reject({errno: fuse.EPERM})
    var self = this
    return this.resolve(path).then(function(obj) {
      if (obj instanceof CachedFile)
        return {value: self.openFD(obj)}
      else
        throw {errno: fuse.EISDIR}
    })
  }),

  release: function(_path, fd, cb) {
    this.closeFD(fd)
    cb(0)
  },

  read: wrapPromise(function(_path, fd, buf, len, pos) {
    var found = this.fds[fd]
    if (!found)
      return Promise.reject({errno: fuse.EBADF})
    return found.content().then(function(content) {
      var size = Math.max(0, Math.min(len, content.length - pos))
      if (size) content.copy(buf, 0, pos, pos + size)
      return {errno: size}
    })
  }),

  // Unlink always pretend to have worked, so that inotify fires
  unlink: function(_path, cb) { cb(0) },

  write: function(_path, _fd, _buffer, _length, _position, cb) { cb(fuse.EPERM) },
  truncate: function(_path, _size, cb) { cb(fuse.EPERM) },
  ftruncate: function(_path, _fd, _size, cb) { cb(fuse.EPERM) },
  chown: function(_path, _uid, _gid, cb) { cb(fuse.EPERM) },
  chmod: function(_path, _mode, cb) { cb(fuse.EPERM) },
  mknod: function(_path, _mode, _dev, cb) { cb(fuse.EPERM) },
  create: function(_path, _mode, cb) { cb(fuse.EPERM) },
  rename: function(_src, _dest, cb) { cb(fuse.EPERM) },
  link: function(_src, _dest, cb) { cb(fuse.EPERM) },
  symlink: function(_src, _dest, cb) { cb(fuse.EPERM) },
  mkdir: function(_path, _mode, cb) { cb(fuse.EPERM) },
  rmdir: function(_path, cb) { cb(fuse.EPERM) }
}
