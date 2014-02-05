var assert = require("assert");

function Deferred() {
  this.paused = true;
  this.resolved = false;
  this.value = undefined;
  this.chained = [];
}

Deferred.prototype._resolve = function(val) {
  assert(!this.paused);
  this.resolved = true;
  this.value = val;
  this.chained.forEach(function(pair) {
    var fn = pair.fn, deferred = pair.deferred;
    this._callThen(fn, deferred);
  }.bind(this));
};

Deferred.prototype._callThen = function(fn, deferred) {
  assert(this.resolved);
  assert(deferred.paused);

  setImmediate(function() {
    var res = fn(this.value);
    //TODO: allow A+ promises to be used
    if(res instanceof Deferred) {
      deferred._merge(res);
    } else {
      deferred.unpause(function(resolve) { resolve(res); });
    }
  }.bind(this));
};

Deferred.prototype._merge = function(deferred) {
  /* Should we do something special for unpause when the deferred has been
   * merged, or can we assume _merge will only happen in certain cases */

  assert(this.paused);
  deferred.then(function(val) {
    this.unpause(function(resolve) {
      resolve(val);
    });
  }.bind(this));
};

Deferred.prototype.unpause = function(fn) {
  if(!this.paused) throw new Error("Deferred has already been unpaused");
  this.paused = false;
  fn(function(val) {
    this._resolve(val);
  }.bind(this));

  return this;
};

Deferred.prototype.then = function(fn) {
  var deferred = new Deferred();
  if(this.resolved) {
    this._callThen(fn, deferred);
    return deferred;
  } else {
    this.chained.push({fn: fn, deferred: deferred});
    return deferred;
  }
};

module.exports = Deferred;
