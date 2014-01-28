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
    Set = require("./set.js"),
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

  spec.rule = function(primaryInput, secondaryInputs, output, fn) {
    if(arguments.length === 3) {
      fn = output;
      output = secondaryInputs;
      secondaryInputs = [];
    }

    if(arguments.length === 3 && Array.isArray(primaryInput)) {
      secondaryInputs = primaryInput;
      primaryInput = undefined;
    }

    currentStage.rules.push({ primaryInput: primaryInput, secondaryInputs: secondaryInputs, output: output, fn: fn, stage: currentStage });
  };

  spec.with = function(glob) {
    return {
      each: function(fn) {
        var magic = new MagicFile(),
            stage = currentStage = { inputs: toArray(glob), rules: [], magic: magic };
        stages.push(stage);
        fn(magic);
      },
      all: function(fn) {
        var magic = new MagicFileList(),
            stage = currentStage = { inputs: toArray(glob), rules: [], multi: true, magic: magic };
        stages.push(stage);
        fn(magic);
      }
    };
  };

  target(spec);

  var nodes = new Set();

  stages.forEach(function(stage) {
    var inputs;
    if(Array.isArray(stage.input)) {
      inputs = [];
      stage.input.forEach(function(g) {
        inputs = inputs.concat(glob.sync(g));
      });
    } else {
      inputs = flatten(stage.inputs.map(function(input) {
        return glob.sync(input);
      }));
    }

    inputs.forEach(function(filename) {
      nodeForFile(nodes, filename);
    });
  });

  work(nodes, stages).then(printGraph);
};

function printGraph(nodes) {
  process.stdout.write("digraph{");
  nodes.array().forEach(function(node) {
    if(node.file) {
      process.stdout.write(node.id + " [shape=box,label=\"" + node.file + "\"];");
    } else {
      var name = node.rule.fn.name;

      if(name === "")
        name = "?";

      process.stdout.write(node.id + " [label=\"" + name + "\"];");
    }
  });

  nodes.array().forEach(function(node) {
    if(node.output)
      process.stdout.write(node.id + "->" + node.output.id + ";");
    else if(node.outputs)
      node.outputs.forEach(function(output) {
        process.stdout.write(node.id + "->" + output.id + ";");
      });
  });
  process.stdout.write("}");
}

//Takes a list of nodes and a set of rules and returns a list of nodes when it reaches a fixed point
function work(nodes, stages) {
  nodes = nodes.clone();
  return new Promise(function(resolve, reject) {
    var change = false;

    nodes.array().forEach(function(node) {
      change = change || processNode(nodes, stages, node);
    });

    resolve(change);
  }).then(function(change) {
    if(change) return work(nodes, stages);
    else return nodes;
  });
}

function processNode(nodes, stages, node) {
  if(node.complete) return false;
  if(node.file) return checkFile(nodes, stages, node);
  else return evaluateOperation(nodes, stages, node);
}

function checkFile(nodes, stages, node) {
  return any(stages.map(function(stage) {
    return matchAgainstStage(nodes, node, stage);
  }));
}

function evaluateOperation(nodes, stages, node) {
  if(!node.unresolvedPrimaryInput) {
    if(!node.rule.stage.multi)
      node.rule.stage.magic.setFile(node.stageInputs[0].lazy);
    node.unresolvedPrimaryInput = node.rule.primaryInput();
    return true;
  }

  if(node.unresolvedPrimaryInput.isResolved() && !node.isPrimaryInputResolved) {
    node.resolvedPrimaryInput = node.unresolvedPrimaryInput.inspect().value();
    node.isPrimaryInputResolved = true;

    var out;
    if(node.resolvedPrimaryInput) out = nodeForFile(nodes, node.rule.output(node.resolvedPrimaryInput));
    else out = nodeForFile(nodes, node.rule.output());

    node.outputs.push(out);
    out.inputs.push(node);

    return true;
  }

  return false;
}

fez.none = function() {
  return function() {
    return Promise.resolve();
  };
};

function matchAgainstStage(nodes, node, stage) {
  assert(node.file);
  if(isStageInOutputs(node.outputs, stage)) return false;
  var anyMatch = any(stage.inputs.map(minimatch.bind(this, node.file)));

  if(anyMatch) {
    var change = false;
    stage.rules.forEach(function(rule) {
      var operation = getOperationForRule(rule);
      node.outputs.push(operation);
      operation.stageInputs.push(node);
      if(nodes.insert(operation)) change = true;
    });

    return change;
  }

  return false;
}

function getOperationForRule(rule) {
  if(rule.stage.multi) {
    if(!rule.operation)
      rule.operation = { id: id++, stageInputs: [], resolvedSecondaryInputs: [], outputs: [], rule: rule };
    return rule.operation;
  } else {
    return { id: id++, stageInputs: [], resolvedSecondaryInputs: [], outputs: [], rule: rule };
  }
}

function isStageInOutputs(outputs, stage) {
  for(var i = 0; i < outputs.length; i++)
    if(outputs[i].rule.stage === stage) return true;
  return false;
}

function any(arr) {
  for(var i = 0; i < arr.length; i++)
    if(arr[i]) return true;
  return false;
}

function every(arr) {
  console.log(arr);
  for(var i = 0; i < arr.length; i++)
    if(!arr[i]) return false;
  return true;
}

function nodeForFile(nodes, file) {
  for(var i = 0; i < nodes.array().length; i++) 
    if(nodes.array()[i].file === file) return nodes.array()[i];

  var node = { id: id++, file: file, inputs: [], outputs: [], lazy: new LazyFile(file) };
  nodes.insert(node);
  return node;
}

function callfn(fn) {
  if(typeof fn === "function")
    return fn();
  return fn;
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
  this._lazies = [];
};

MagicFileList.prototype.pushFile = function(file) {
  this._lazies.push(file);
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


