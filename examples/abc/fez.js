var fez = require("../../src/main.js"),
    Promise = require("bluebird");

function nop() {}

exports.build = function(spec) {
  spec.with("a").each(function(file) {
    spec.rule(file, "b", function nop1() {});
  });

  spec.with("b").each(function(file) {
    spec.rule(file, "c", function nop2() {});
  });

  /*
  spec.with(["a", "b", "c"]).all(function(files) {
    spec.rule(files, "d", function nop3() {});
  });
  */
};

exports.default = exports.build;

fez(module);
