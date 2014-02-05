var fez = require("../../src/main"),
    jshint = require("fez-jshint");

exports.lint = function(spec) {
  /* 
   * Define a rule foro each JavaSript file in the src/ directory. We will run
   * JSHINT once for each source file, and we will not create a hidden output
   * file, which means that it will run every time, regardless of whether inputs
   * have changed. Run this script with --harmony.
   */
  spec.with("src/*.js").all(function(files) {
    spec.rule(files, jshint({
      curly: true,
      indent: 2
    }));
  });
};

exports.default = exports.lint;

fez(module);
