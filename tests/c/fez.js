var fez = require("../../src/main.js");

exports.build = function(spec) {
  /*
   * Note that these don't need to be in different stages. This is just for testing purposes.
   */
  spec.with("*.c").each(function(file) {
    spec.rule(file, file.simpleMap("%f.o"), fez.exec("gcc -Wall -c %i -o %o"));
  });

  spec.with("*.o").all(function(files) {
    spec.rule(files, "hello", fez.exec("gcc %i -o %o"));
  });
};

exports.default = exports.build;

fez(module);
