var fez = require("../../src/main.js");

fez(function(spec) {
  spec.with("*.c").each(function(file) {
    spec.rule(file, file.patsubst("%.c", "%.o"), fez.exec("gcc -Wall -c %i -o %o"));
  });

  spec.with("*.o").all(function(files) {
    spec.rule(files, "hello", fez.exec("gcc %i -o %o"));
  });
});
