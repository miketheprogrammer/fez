var test = require("tape"), 
    exec = require("child_process").exec,
    fs = require("fs");

test('less project', function(t) {
  setup();

  function setup() {
    var child = exec("cd tests/less/; node fez.js");
    child.on("exit", function(code) {
      t.equal(code, 0);
      stat();
    });
  }

  function stat() {
    t.ok(fs.existsSync('tests/less/css/main.css'));
    t.ok(fs.existsSync('tests/less/css/mobile.css'));
    t.ok(fs.existsSync('tests/less/dist/reset.min.css'));
    t.ok(fs.existsSync('tests/less/dist/main.min.css'));
    t.ok(fs.existsSync('tests/less/dist/mobile.min.css'));
    t.ok(fs.existsSync('tests/less/dist.min.css'));

    teardown();
  }

  function teardown() {
    exec("cd tests/less/; node fez.js -c", function(err) {
      if(err) t.fail(err.message);
      else t.end();
    });
  }
});
