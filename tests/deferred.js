var test = require("tape"),
    Deferred = require("../src/deferred.js");

test('deferreds', function(t) {
  t.plan(5);

  var deferred = new Deferred();

  t.ok(deferred.then(function() {}) instanceof Deferred);

  var mark = false;
  deferred.then(function(val) {
    mark = true;
    t.equal(val, 42);
    return "Hello, world!";
  }).then(function(val) {
    t.equal(val, "Hello, world!");
    return new Deferred().unpause(function(resolve) {
      resolve([]);
    });
  }).then(function(arr) {
    t.ok(Array.isArray(arr));
  });

  t.equal(mark, false);

  deferred.unpause(function(resolve) {
    resolve(42);
  });
});
