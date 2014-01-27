var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css"),
    concat = require("fez-concat");

exports.build = function(spec) {
    spec.with("dist/*.min.css").all(function(files) {
      spec.rule(files.array(), "dist.min.css", concat());
    });

  spec.with("css/*.css").each(function(file) {
    spec.rule(file.name(), fez.mapFile("dist/%f.min.css"), clean());
  });

  spec.with("*.less").each(function(file) {
    spec.rule(file.name(), fez.mapFile("css/%f.css"), less());
  });
};

exports.default = exports.build;

fez(module);
