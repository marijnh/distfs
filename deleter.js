var fs = require("fs")
process.on("message", function(file) { fs.unlink(file, function() {}) })
