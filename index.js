"use strict"

var path = require("path")
var module_ = require("module")
var Mount = require("./mount")

if (process.argv.length < 4) {
  console.error("Usage: distfs sourceDir mountDir")
  process.exit(1)
}

var sourceDir = path.resolve(process.argv[2])
var mountDir = path.resolve(process.argv[3])

// Load babel-core in the context of the source dir
var resolved = module_._resolveFilename("babel-core", {
  id: path,
  paths: module_._nodeModulePaths(sourceDir).concat(module_.globalPaths)
})
var babel = require(resolved)

var mount = new Mount({
  sourceDir: sourceDir,
  mountDir: mountDir,
  filter: function(path, buffer) {
    if (!/\.js$/.test(path)) return buffer
    try {
      return new Buffer(babel.transform(buffer.toString(), {
        filename: path,
        sourceMaps: "inline",
      }).code)
    } catch(e) {
      return new Buffer("console.error(" + JSON.stringify(e + "") + ")")
    }
  },
  mountOptions: ["nonempty"]
})

process.on("SIGINT", function () {
  mount.unmount(function () { process.exit() })
})

mount.mount()
