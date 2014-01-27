var util = require("util"),
    nopt = require("nopt"),
    ansi = require("ansi"),
    cursor = ansi(process.stdout),
    crypto = require("crypto"),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
    Promise = require("bluebird"),
    isPromise = require("is-promise"),
    fs = require("fs"),
    mkdirp = require("mkdirp"),
    assert = require("assert"),
    Writable = require("stream").Writable,
    exec = require("child_process").exec,
    xtend = require("xtend"),
    mxtend = require("xtend/mutable"),
    Input = require("./input.js"),
    fezUtil = require("./util.js");

function fez(module) {
  if(require.main === module) {
    processTarget(module.exports.default);
  }
}

var id = 0;

function processTarget(target) {
  var stages = [],
      currentStage = null;

  var spec = {};

  spec.rule = function(inputs, output, fn) {
    currentStage.rules.push({inputs: toArray(inputs), output: output, fn: fn});
  };

  spec.with = function(glob) {
    return {
      each: function(fn) {
        var magic = new MagicFile(),
            stage = currentStage = { input: glob, rules: [], magic: magic };
        stages.push(stage);
        fn(magic);
      },
      all: function(fn) {
        var magic = new MagicFileList(),
            stage = currentStage = { input: glob, rules: [], multi: true, magic: magic };
        stages.push(stage);
        fn(magic);
      }
    };
  };

  target(spec);

  var nodes = [],
      worklist = [],
      newWorklist = [],
      ready = [],
      change = true;

  stages.forEach(function(stage) {
    glob.sync(stage.input).forEach(function(filename) {
      var node = { id: id++, file: filename, inputs: [], outputs: [], lazy: new LazyFile(filename) };
      nodes.push(node);
      worklist.push(node);
    });
  });


  function work() {
    return new Promise(function(resolve, reject) {
      (function itr(change) {
        if(!change) {
          resolve();
          return;
        }

        change = false;
        
        while(worklist.length > 0) {
          var node = worklist.shift();

          if(node.file) {
            stages.forEach(function(stage) {
              var res = checkStage(stage, node);
              change = change || res.change;
              res.new.forEach(function(node) {
                nodes.push(node);
                newWorklist.unshift(node);
              });
            });
            newWorklist.push(node);

          } else {
            if(!node.multi) {
              if(!node.unresolvedInputs) {
                node.stage.magic.setFile(node.stageInputs[0].lazy);
                node.unresolvedInputs = node.rule.inputs.map(call);
                change = true;
              }

              if(node.unresolvedInputs.length > 0) {
                node.unresolvedInputs.forEach(function(input) {
                  if(input.isResolved()) {
                    node.unresolvedInputs.splice(node.unresolvedInputs.indexOf(input), 1);
                    var inputNode = nodeForFile(nodes, input.inspect().value());
                    if(!inputNode) {
                      inputNode = { id: id++, file: input.inspect().value(), inputs: [], outputs: [], lazy: new LazyFile(input.inspect().value()) };
                      nodes.push(inputNode);
                      newWorklist.unshift(inputNode);
                    }
                    inputNode.outputs.push(node);
                    node.resolvedInputs.push(inputNode);
                    change = true;
                  }
                });
                newWorklist.push(node);
              } else if(allComplete(node.resolvedInputs.concat(node.stageInputs))) {
                console.log("Do operation");
              } else {
                var out = node.rule.output(node.resolvedInputs.map(function(i) { return i.file; }));
                var outputNode = nodeForFile(nodes, out);
                if(!outputNode) {
                  outputNode = { id: id++, file: out, inputs: [], outputs: [], lazy: new LazyFile(out) };
                  nodes.push(outputNode);
                  newWorklist.unshift(outputNode);
                }
                outputNode.inputs.push(node);
                newWorklist.push(node);
              }
            }
          }
        }

        worklist = newWorklist;
        newWorklist = [];
        
        setImmediate(itr.bind(this, change));
      })(true);
    });
  }


  work().then(function() {
    console.log(nodes);
  });
};

function nodeForFile(nodes, file) {
  for(var i = 0; i < nodes.length; i++) {
    if(nodes[i].file === file) return nodes[i];
  }

  return undefined;
}

function call(fn) {
  return fn();
}

function checkStage(stage, node) {
  if(minimatch(node.file, stage.input)) {
    var newNodes = [];

    stage.rules.forEach(function(rule) {
      for(var i = 0; i < node.outputs.length; i++)
        if(node.outputs[i].rule === rule) return;

      var operation = { id: id++, stageInputs: [node], resolvedInputs: [], rule: rule, stage: stage };
      node.outputs.push(operation);

      newNodes.push(operation);
    });

    return { change: newNodes.length, new: newNodes };
  } else {
    return { change: false, new: [] };
  }
}

function allComplete(nodes) {
  for(var i = 0; i < nodes.length; i++)
    if(!nodes[i].complete) return false;
  return true;
}

function MagicFile() {

};

MagicFile.prototype.name = function() {
  return function() {
    return this._lazy.getFilename();
  }.bind(this);
};

MagicFile.prototype.setFile = function(lazy) {
  this._lazy = lazy;
};

function MagicFileList() {
  
};

MagicFileList.prototype.array = function() {
  return function() {
  };
};

function LazyFile(filename) {
  this._filename = Promise.defer();
  this._asBuffer = Promise.defer();

  if(filename) this._filename.resolve(filename);
};

LazyFile.prototype._setFilename = function(filename) {
  this._filename.resolve(filename);
};

LazyFile.prototype._loadFile = function(filename) {
  if(filename)
    this._setFilename(filename);

  this.getFilename().then(function(filename) {
    var file = new File(filename);
    return file.asBuffer().then(this._asBuffer.resolve);
  });
};

LazyFile.prototype.getFilename = function() {
  return this._filename.promise;
};

LazyFile.prototype.asBuffer = function() {
  return this._asBuffer.promise;
};

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}

function writep(file, data) {
  if(!data) data = new Buffer(0);
  return new Promise(function(resolve, reject) {
    mkdirp(path.dirname(file), function(err) {
      if(err) reject(err);
      fs.writeFile(file, data, function(err) {
        if(err) reject(err);
        else resolve(true);
      });
    });
  });
}

function needsUpdate(inputs, outputs, changelist, options) {
  var stat = fs.statSync(options.module.filename),
      mtime = stat.mtime.getTime();

  for(var i in inputs)
    if(changelist[inputs[i]])
      return true;
  
  var oldestOutput = Number.MAX_VALUE;
  outputs.forEach(function(out) {
    var dir = path.dirname(out);
    if(mkdirp.sync(dir)) {
      oldestOutput = 0;
    } else {
      try {
        var stat = fs.statSync(out),
            time = stat.mtime.getTime();

        if(time < oldestOutput)
          oldestOutput = time;
      } catch (e) {
        oldestOutput = 0;
      }
    }
  });

  var newestInput = 0;
  inputs.forEach(function(input) {
    try {
      var stat = fs.statSync(input),
          time = stat.mtime.getTime();

      if(time > newestInput)
        newestInput = time;
    } catch(e) {
      newestInput = 0;
    }
  });
  
  return (mtime > oldestOutput) || (newestInput > oldestOutput);
}

//(ibw) should switch to a real set data structure for maximum performance
function union(a, b) {
  var a2 = a.filter(function() { return true; });
  b.forEach(function(e) {
    if(a.indexOf(e) == -1)
      a2.push(e);
  });

  return a2;
}

function flatten(arrays) {
  if(!Array.isArray(arrays)) return [arrays];

  return arrays.reduce(function(prev, array) {
    if(Array.isArray(array)) return prev.concat(flatten(array));
    else return prev.concat(flatten(array));
  }, []);
}

function getAllMatchingInputs(rules) {
  return flatten(rules.map(getMatchingInputs));
}

function getMatchingInputs(rule) {
  //(ibw) so bad
  if(rule.each) {
    if(typeof rule.inputs[0] === "function") 
      return rule.inputs[0](glob.sync("**"));
    return glob.sync(rule.inputs[0]);
  }

  return flatten(rule.inputs.map(function(input) {
    if(typeof input === "function") 
      return input(glob.sync("**"));
    return glob.sync(input);
  }));
}

function toPromise(p) {
  if(isPromise(p)) return p;
  return Promise.resolve(p);
}

function resolveRuleInputs(rule) {
  var newRule = {};

  //Shallow clone
  for(var prop in rule) {
    newRule[prop] = rule[prop];
  }

  return Promise.all(toArray(newRule.inputs)).then(function(inputs) {
    newRule.inputs = flatten(inputs);
    return newRule;
  });
}

function resolveRuleInput(input) {
  return input;
}

module.exports = fez;


fez.exec = function(command) {
  function ex(inputs, outputs) {
    var ifiles = toArray(inputs).map(function(i) { return i.getFilename(); }).join(" "),
        ofiles = outputs.join(" "),
        pcommand = command.
          replace("%i", ifiles).
          replace("%o", ofiles);

    return new Promise(function(resolve, reject) {
      exec(pcommand, function(err) {
        if(err) reject(err);
        else resolve(true);
      });
    });
  };

  ex.value = command;
  return ex;
};

fez.mapFile = function(pattern) {
  return function(inputs) {
    var input = inputs[0];
    var f = (function() {
      var basename = path.basename(input);
      var hidden = false;
      if(basename.charAt(0) == ".") {
        hidden = true;
        basename = basename.slice(1);
      }

      var split = basename.split(".");
      if(split.length > 1) {
        if(hidden) return "." + split.slice(0, -1).join(".");
        else return split.slice(0, -1).join(".");
      } else {
        if(hidden) return "." + basename;
        else return basename;
      }
    })();

    return pattern.replace("%f", f).replace("%F", path.basename(input)).replace("%d", path.dirname(input)).replace("%e", path.extname(input)).replace("./", "");
  };
};


