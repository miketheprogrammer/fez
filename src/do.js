var assert = require("assert"),
    Promise = require("blurbird");

function Node(fn, parent) {
  assert(typeof fn === "function");
  this._fn = fn;
  this._children = [];
  this._deferred = Promise.defer();
  this._done = false;
  this._value = undefined;
  if(Array.isArray(parent)) this._parents = parent;
  else if (parent instanceof Node) this._parents = [parent];
  else throw new TypeError("Invalid parent type " + (typeof parent));
};

Node.prototype.then = function(fn) {
  var node = new Node(fn, this);
  this._children.push(node);
  return node;
};

function any(arr) {
  return arr.reduce(function(p, c) {
    return p || c;
  }, false);
};

Node.prototype.promise = function() {
  return this._deferred.promise;
};

Node.prototype.done = function(value) {
  assert(!this._done);
  this._done = true;
  this._value = value;
  this._deferred.resolve(value);
  this._children.forEach(function(child) {
    child._checkDo();
  });
};

function done(p, c) {
  return p && c._done;
}

function values(nodes) {
  return nodes.map(function(n) {
    return n._value;
  });
}

Node.prototype._checkDo = function() {
  if(this._childrenreduce(done, true)) this.do();
};

Node.prototype.do = function() {
  assert(!this._done);
  this._fn.apply(this, values(this._parents));
};

Node.all = function(nodes, fn) {
  return new Node(fn, nodes);
};
