var util = require("util"),
    nopt = require("nopt"),
    ansi = require("ansi"),
    cursor = ansi(process.stdout),
    crypto = require("crypto"),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
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
    Do = require("./do.js"),
    fezUtil = require("./util.js");

function fez(module) {
  if(require.main === module) {
    processTarget(module.exports.default);
  }
}

var id = 0;

function processTarget(target) {
  var stages = [],
      currentStage = null,
      spec = {},
      context = { nodes: new Set(), stages: stages, do: new Do() }; 

  spec.rule = function(primaryInput, secondaryInputs, output, fn) {
    if(arguments.length === 3 && Array.isArray(primaryInput)) {
      fn = output;
      output = secondaryInputs;
      primaryInput = function() { return context.do.value(undefined); };
      secondaryInputs = primaryInput;
    } else if(arguments.length === 3) {
      fn = output;
      output = secondaryInputs;
      secondaryInputs = function() { return context.do.value([]); };
    }

    if(typeof output === "string") {
      var out = output;
      output = function() {
        return context.do.value(out);
      };
    }

    //console.log(primaryInput, secondaryInputs, output, fn, currentStage);
    currentStage.rules.push({ primaryInput: primaryInput, secondaryInputs: secondaryInputs, output: output, fn: fn, stage: currentStage });
  };

  spec.with = function(glob) {
    return {
      each: function(fn) {
        var magic = new MagicFile(),
            stage = currentStage = { inputs: toArray(glob), rules: [], magic: magic };

        stages.push(stage);
        fn(magic);
        currentStage = null;
      },
      all: function(fn) {
        var magic = new MagicFileList(),
            stage = currentStage = { inputs: toArray(glob), rules: [], multi: true, magic: magic };

        stages.push(stage);
        fn(magic);
        currentStage = null;
      }
    };
  };

  target(spec);

  loadInitialNodes(context);

  context.do.on("fixed", function() {
    printGraph(context.nodes);
    context.nodes.array().forEach(function(node) {
      if(node.file && node.inputs.length === 0) {
        //console.log("marking " + node.file + " as done");
        node.do.unpause();
      }
    });
  });
};

function loadInitialNodes(context) {
  context.stages.forEach(function(stage) {
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
      processNode(context, nodeForFile(context, filename));
    });
  });
}

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

  process.stdout.write("}\n");
}

function processNode(context, node) {
  context.nodes.insert(node);
  if(node.file) {
    checkFile(context, node);
  } else {
    var promise = evaluateOperation(context, node);
  }

}

function checkFile(context, node) {
  return context.stages.map(function(stage) {
    return matchAgainstStage(context, node, stage);
  });
}

function evaluateOperation(context, node) {
  if(node.rule.stage.multi) node.rule.stage.magic._lazies = node.lazies;
  else node.rule.stage.magic.setFile(node.stageInputs[0].lazy);

  node.do = context.do.createNode(function nodeDo() {
    console.log(primaryInputDo._value, secondaryInputDo._value, outputDo._value);
  });

  var primaryInputDo;
  if(node.rule.primaryInput instanceof MagicFileList) primaryInputDo = context.do.value(undefined);
  else if(node.rule.primaryInput instanceof MagicFile) primaryInputDo = node.rule.primaryInput.name()();
  else primaryInputDo = node.rule.primaryInput();

  primaryInputDo.then(function primaryInput(filename){ 
    if(filename) {
      var input = nodeForFile(context, filename);
      input.outputs.push(node);
      node.primaryInput = input;
      node.do.connectFrom(input.do);
      processNode(context, input);
    }
  });

  var outputDo;
  if(typeof node.rule.output === "string") outputDo = context.do.value(node.rule.output);
  else outputDo = node.rule.output(primaryInputDo);

  outputDo.then(function outputFn (output) {
    var out = nodeForFile(context, output);
    node.outputs.push(out);
    out.inputs.push(node);
    out.do.connectFrom(node.do);
    processNode(context, out);
  });

  var secondaryInputDo;
  if(node.rule.primaryInput instanceof MagicFileList) secondaryInputDo = node.rule.primaryInput.names()();
  else secondaryInputDo = node.rule.secondaryInputs();

  secondaryInputDo.then(function secondaryInput(resolved) {
    node.secondaryInputs = [];
    resolved.forEach(function(file) {
      var input = nodeForFile(context, file);
      input.outputs.push(node);
      node.secondaryInputs.push(input);
      processNode(context, input);
    });
  });

  if(!node.rule.stage.multi) node.rule.stage.magic.setFile(undefined);
  else node.rule.stage.magic._lazies = undefined;

  node.do.connectFrom(primaryInputDo);
  node.do.connectFrom(secondaryInputDo);
  node.do.connectFrom(outputDo);
}

function sumTruthy(arr) {
  return arr.reduce(function(prev, cur) {
    if(cur) return prev + 1;
    return prev;
  }, 0);
};

function prop(p) {
  return function(el) {
    return el[p];
  };
}

var file = prop("file");

function matchAgainstStage(context, node, stage) {
  assert(node.file);
  if(isStageInOutputs(node.outputs, stage)) return false;
  var anyMatch = any(stage.inputs.map(minimatch.bind(this, node.file)));

  if(anyMatch) {
    var change = false;
    stage.rules.forEach(function(rule) {
      var operation = getOperationForRule(context, rule);
      node.outputs.push(operation);
      operation.stageInputs.push(node);
      processNode(context, operation);
    });

    return change;
  }

  return false;
}

function getOperationForRule(context, rule) {
  if(rule.stage.multi) {
    if(!rule.operation)
      rule.operation = { id: id++, stageInputs: [], outputs: [], rule: rule, lazies: new LazyFileList(context) };
    return rule.operation;
  } else {
    return { id: id++, stageInputs: [], outputs: [], rule: rule };
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
  for(var i = 0; i < arr.length; i++)
    if(!arr[i]) return false;
  return true;
}

function nodeForFile(context, file) {
  for(var i = 0; i < context.nodes.array().length; i++) 
    if(context.nodes.array()[i].file === file) return context.nodes.array()[i];

  var node = new FileNode(context, file);

  return node;
}

function FileNode(context, file) {
  this.id = id++;
  this.file = file;
  this.inputs = [];
  this.outputs = [];
  this.lazy = new LazyFile(context, file);
  this.do = context.do.defer(file);
}

FileNode.prototype.complete = function() {
  console.log("completing " + this.file);
  this._deferred.resolve();
  this.lazy._loadFile();
  this._complete = true;
};

FileNode.prototype.isComplete = function() {
  return !!this._complete;
};

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

MagicFile.prototype.inspect = function() {
  return this._lazy;
};

function MagicFileList() {
};

MagicFileList.prototype.names = function() {
  return function() {
    return this._lazies.getFilenames();
  }.bind(this);
};

function LazyFileList(context) {
  this._filenames = context.do.defer();
};

LazyFileList.prototype.getFilenames = function() {
  return this._filenames;
  //return this._files.map(function(i) { i.getFilename(); });
};

function LazyFile(context, filename) {
  this._filename = context.do.defer();
  this._asBuffer = context.do.defer();

  if(filename) this._filename.done(filename);
};

LazyFile.prototype._setFilename = function(filename) {
  console.log("filename");
  this._filename.resolve(filename);
};

LazyFile.prototype._loadFile = function(filename) {
  if(filename)
    this._setFilename(filename);

  this.getFilename().then(function(filename) {
    fs.readFile(filename, function(err, data) {
      if(err) this._asBuffer.reject(err);
      else this._asBuffer.resolve(data);
    }.bind(this));
  }.bind(this));
};

LazyFile.prototype.getFilename = function() {
  return this._filename;
};

LazyFile.prototype.asBuffer = function() {
  return this._asBuffer;
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

function needsUpdate(inputs, outputs, changelist) {
  var stat = fs.statSync("./fez.js"),
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

function allInputs(op) {
  if(op.secondaryInputs) return [op.primaryInput].concat(op.secondaryInputs);
  else return [op.primaryInput];
};

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
  return function(input) {
    return input.then(function mapFile(filename) {
      var f = (function() {
        var basename = path.basename(filename);
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

      this.done(pattern.replace("%f", f).replace("%F", path.basename(filename)).replace("%d", path.dirname(filename)).replace("%e", path.extname(filename)).replace("./", ""));
    });
  };
};


