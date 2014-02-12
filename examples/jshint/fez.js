var fez = require("../../src/main"),
    jshint = require("fez-jshint");

exports.lint = function(spec) {
  spec.with("src/*.js").all(function(files) {
    spec.rule(files, jshint({ curly: true, indent: 2 }));
  });
};

exports.default = exports.lint;

fez(module);
