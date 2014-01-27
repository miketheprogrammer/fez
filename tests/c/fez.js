var fez = require("../../src/main.js");

exports.build = function(spec) {
  /*
   * Note that these don't need to be in different stages. This is just for testing purposes.
   */
  spec.with("*.c").each(function(file) {
    spec.rule(file.name(), fez.mapFile("%f.o"), fez.exec("gcc -Wall -c %i -o %o"));
  });

  spec.with("*.o").all(function(files) {
    spec.rule(files.array(), "hello", fez.exec("gcc %i -o %o"));
  });
};

exports.default = exports.build;

fez(module);
