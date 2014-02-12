var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css"),
    concat = require("fez-concat");

exports.less = function(spec) {
  spec.with("main.less").one(function(file) {
    spec.rule(file, less.imports(file), file.patsubst("%.less", "css/%.css"), less({}));
  });
};

exports.build = function(spec) {
  spec.use(exports.less);

  spec.with("dist/*.min.css").all(function(files) {
    spec.rule(files, "dist.min.css", concat());
  });

  spec.with("css/*.css").each(function(file) {
    spec.rule(file, file.patsubst("css/%.css", "dist/%.min.css"), clean());
  });

  spec.after("dist.min.css").do(function() {
    console.log("Success!");
  });
};

exports.default = exports.build;

fez(module);
