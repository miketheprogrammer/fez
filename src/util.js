var path = require("path"),
    Promise = require("bluebird"),
    exec = require("child_process").exec,
    minimatch = require("minimatch");

var fez = module.exports = {};

fez.patsubst = function(pattern, replacement, string) {
  if(Array.isArray(string))
    return string.map(fez.patsubst.bind(null, pattern, replacement));

  var regex = new RegExp(pattern.replace(".", "\\.").replace("%", "(.+)")),
      result = regex.exec(string),
      sub = result[1],
      out = replacement.replace("%", sub);

  return out;
};

fez.chain = function(operations) {
  return function(inputs, output) {
    return toPromise(operations[0](inputs, output)).then(function(out) {
      operations.shift();
      return itr(out, output);
    });
  };

  function itr(out, output) {
    if(operations.length > 0) {
      var op = operations.shift();
      if(typeof out === "string") out = new Buffer(out);
      return itr(op([new Input(out)], output));
    } else {
      return out;
    }
  }
};

fez.glob = function(pattern) {
  return PatternMatch(function(files) {
    //(ibw) We can do better than this. Fork isaacs' glob and make it work with a virtual file system
    return files.filter(function(f) {
      return minimatch(f, pattern) && !minimatch(f, "node_modules/**");
    });
  });
};

function PatternMatch(fn) {
  fn.filterOut = function(pattern) {
    var fn = this;
    return PatternMatch(function(files) {
      return fn(files).filter(function(f) {
        return !minimatch(f, pattern);
      });
    });
  };

  fn.with = function(files) {
    var fn = this;
    return PatternMatch(function(files) {
      return fn(files).concat(toArray(files));
    });
  };
  return fn;
}

function toPromise(p) {
  if(isPromise(p)) return p;
  return Promise.resolve(p);
}

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}
