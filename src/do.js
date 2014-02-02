var assert = require("assert"),
    EventEmitter = require("events").EventEmitter;

function Do() {
  EventEmitter.call(this);
  this._nodes = [];
  this._workingCount = 0;
  this._paused = false;
  this._queue = [];

  (function unspool() {
    setImmediate(function() {
      var queue = this._queue.slice(); this._queue = [];
      while(queue.length > 0) queue.pop()();
      if(this._queue.length > 0) unspool.call(this);
      else {
        if(this._workingCount === 0) this.emit("fixed");
      }
    }.bind(this));
  }).call(this);
};

Do.prototype = new EventEmitter();

Do.prototype.queue = function(fn) {
  this._queue.push(fn);
};

Do.prototype.createNode = function(fn, parent) {
  var node = new Node(this, fn, parent);
  this._nodes.push(node);
  return node;
};

Do.prototype.all = function(nodes, fn) {
  return this.createNode(fn, nodes);
};

Do.prototype.defer = function(str) {
  var node = this.createNode(function() {
    console.log("do", str);
  });

  node.pause();

  return node;
};

Do.prototype._addWorking = function() {
  this._workingCount += 1;
};

Do.prototype._doneWorking = function() {
  this._workingCount -= 1;
};

Do.prototype.value = function(val) {
  var node = this.createNode(function() {});
  node.done(val);
  return node;
};

function Node(graph, fn, parent) {
  assert(typeof fn === "function");
  this._fn = fn;
  this._graph = graph;
  this._to = [];
  this._done = false;
  this._value = undefined;
  this._working = false;
  if(Array.isArray(parent)) this._from = parent;
  else if (parent instanceof Node) this._from = [parent];
  else if (parent === undefined) this._from = [];
  else throw new TypeError("Invalid parent type " + (typeof parent));
};

Node.prototype.connectFrom = function(node) {
  assert(!this._done);
  node._to.push(this);
  this._from.push(node);
  if(node._done)
    this._graph.queue(function() {
      this._checkDo();
    }.bind(this));
};

Node.prototype.pause = function() {
  this._paused = true;
};

Node.prototype.unpause = function() {
  if(!this._pause) {
    this._paused = false;
    this._checkDo();
  }
};

Node.prototype.working = function() {
  return this._working;
};

Node.prototype.then = function(fn) {
  var node = this._graph.createNode(fn, this);
  assert(!node._done);
  this._to.push(node);
  if(this._done) node._checkDo();
  return node;
};

function any(arr) {
  return arr.reduce(function(p, c) {
    return p || c;
  }, false);
};

Node.prototype.work = function() {
  assert(!this._working);
  this._working = true;
  this._graph._addWorking();
};

Node.prototype.done = function(value) {
  assert(!this._done);
  this._done = true;
  if(this._working) this._graph._doneWorking();
  this._working = false;
  this._value = value;
  this._to.forEach(function(to) {
    to._checkDo();
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
  if(this._done) throw new Error("Already done");
  this._graph.queue(function() {
    if(this._done) {
      throw new Error("Uh oh");
    }
    assert(!this._done);
    if(!this._paused && this._from.reduce(done, true)) {
      this.do();
    }
  }.bind(this));
};

Node.prototype.do = function() {
  assert(!this._done);
  var ret = this._fn.apply(this, values(this._from));
  if(!this.working()) this.done(ret);
};

module.exports = Do;
