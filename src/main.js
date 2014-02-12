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
    Promise = require("bluebird"),
    xtend = require("xtend"),
    mxtend = require("xtend/mutable"),
    Input = require("./input.js"),
    Set = require("./set.js");

var id = 0;

function fez(module) {
  if(require.main === module) {
    var options = xtend({ output: true }, getOptions()),
        target = getTarget(options);

    options.module = module;
    processTarget(module.exports[target], options).then(function(work) {
      if(options.clean && !work) console.log("Nothing to clean.");
      else if(!options.clean && !work) console.log("Nothing to be done.");
    });
  }
}

function getOptions() {
  var options = nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean,
    "dot": Boolean
  }, {
    "v": "--verbose",
    "q": "--quiet",
    "c": "--clean"
  });

  if(options.dot) options.quiet = true;

  return options;
}

function getTarget(options) {
  return options.argv.remain.length ? options.argv.remain[0] : 'default';
}

function processTarget(target, options, shared) {
  if(!shared) {
    shared = { top: target, work: false, deleted: [] };
  }

  var stages = [],
      currentStage = null,
      spec = {},
      context = { nodes: new Set(), stages: stages, worklist: [], options: options, shared: shared },
      requires = [];

  spec.rule = function(primaryInput, secondaryInputs, output, fn) {
    if(arguments.length === 2) {
      fn = secondaryInputs;
      output = undefined;
      secondaryInputs = function() { return []; };
    } else if(arguments.length === 3) {
      fn = output;
      output = secondaryInputs;
      secondaryInputs = function() { return Promise.resolve([]); };
    }

    currentStage.rules.push({ primaryInput: primaryInput, secondaryInputs: secondaryInputs, output: output, fn: fn, stage: currentStage });
  };

  spec.with = function(globs) {
    return new Match(function(file) {
      return any(toArray(globs).map(function(glob) {
        return minimatch(file, glob);
      }));
    }, function(stage) {
      stages.push(stage);
      currentStage = stage;
    }, function () {
      currentStage = undefined;
    });
  };

  spec.use = function(target) {
    requires.push(target);
  };

  target(spec);

  return (function nextRequire() {
    if(requires.length > 0) {
      return processTarget(requires.shift(), options, shared).then(function() {
        return nextRequire();
      });
    } else {
      return loadInitialNodes(context);
    }
  })();
};

function Match(fn, setStage, resetStage) {
  this.fn = fn;
  this.setStage = setStage;
  this.resetStage = resetStage;
};

Match.prototype.not = function(globs) {
  var fn = this.fn;

  return new Match(function(file) {
    return fn(file) && !any(toArray(globs).map(function(glob) {
      minimatch(file, glob);
    }));
  }, this.setStage, this.resetStage);
};

Match.prototype.each = function(fn) {
  var proxy = new ProxyFile();
  this.setStage({ input: this.fn, rules: [], proxy: proxy });
  fn(proxy);
  this.resetStage();
};

Match.prototype.one = function(fn) {
  var proxy = new ProxyFile();
  this.setStage({ input: this.fn, rules: [], proxy: proxy, one: true, matched: false });
  fn(proxy);
  this.resetStage();
};

Match.prototype.all = function(fn) {
  var proxy = new ProxyFileList();
  this.setStage({ input: this.fn, rules: [], multi: true, proxy: proxy });
  fn(proxy);
  this.resetStage();
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
      inputs = glob.sync("**").filter(stage.input).concat(context.shared.deleted.filter(stage.input));
    }

    inputs.forEach(function(filename) {
      nodeForFile(context, filename);
    });
  });

  return work(context);
}

function work(context) {
  var worklist = context.worklist, changed = false;
  context.worklist = [];
  worklist.forEach(function(node) {
    changed = checkFile(context, node) || changed;
  });

  if(changed || context.worklist.length > 0) {
    return new Promise(function(resolve, reject) {
      setImmediate(function() {
        resolve(work(context));
      });
    });
  } else {
    if(context.options.clean) {
      var anything = false;
      context.nodes.array().filter(isFile).filter(not(isSource)).forEach(function(node) {
        try {
          fs.unlinkSync(node.file);
          anything = true;
          
          if(!context.options.quiet) {
            context.shared.deleted.push(node.file);
            anything = true;
            process.stdout.write("Removing ");
            cursor.red();
            console.log(node.file);
            cursor.reset();
          }
        } catch(e) {}
      });

      return Promise.resolve(anything);
    } else {
      context.nodes.array().filter(isMulti).forEach(function(node) {
        node.lazies._setFilenames(node.stageInputs.map(file));
      });

      context.nodes.array().filter(isSource).forEach(function(node) {
        node.complete();
      });

      return Promise.all(context.nodes.array().filter(isOperation).map(promise)).then(function(work) {
        if(context.options.dot) printGraph(context.nodes);
        return any(work);
      });
    }
  }
}

function isFile(node) {
  return node.file !== undefined;
}

function isOperation(node) {
  return !isFile(node);
}

function isMulti(node) {
  return isOperation(node) && node.rule.stage.multi;
}

function isSource(node) {
  return isFile(node) && node.inputs.length === 0;
}

function not(fn) {
  return function(val) {
    return !fn(val);
  };
};

function printGraph(nodes) {
  process.stdout.write("digraph{");
  nodes.array().forEach(function(node) {
    if(node.file) {
      var name = node.file;
      //if(node.promise.isResolved())
      //name += "+";
      process.stdout.write(node.id + " [shape=box,label=\"" + name + "\"];");
    } else {
      name = node.rule.fn.name;

      if(name === "")
        name = "?";

      //if(node.promise.isResolved())
      //name += "+";

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

function checkFile(context, node) {
  return context.stages.map(function(stage) {
    return matchAgainstStage(context, node, stage);
  });
}

function evaluateOperation(context, node) {
  if(node.evaluated) return false;
  node.evaluated = true;
  if(node.rule.stage.multi) node.rule.stage.proxy._lazies = node.lazies;
  else node.rule.stage.proxy._setFile(node.stageInputs[0].lazy);

  var primaryInputPromise;
  if(node.rule.primaryInput instanceof ProxyFileList) primaryInputPromise = node.rule.primaryInput.names();
  else if(node.rule.primaryInput instanceof ProxyFile) primaryInputPromise = Promise.resolve(node.rule.primaryInput._inspect().getFilename());
  else primaryInputPromise = node.rule.primaryInput();

  primaryInputPromise = toPromise(primaryInputPromise).then(function(resolved) {
    var primaryInputs = [];

    toArray(resolved).forEach(function(file) {
      var input = nodeForFile(context, file);
      input.outputs.push(node);
      primaryInputs.push(input);
    });

    return primaryInputs;
  });

  var output;
  if(typeof node.rule.output === "string") {
    output = node.rule.output;
    createOutNode();
  } else if(node.rule.output) { 
    output = node.rule.output();
    createOutNode();
  }

  var outNode;
  function createOutNode() {
    outNode = nodeForFile(context, output);
    node.outputs.push(outNode);
    outNode.inputs.push(node);
    node.output = outNode;
  }

  var secondaryInputPromise;
  secondaryInputPromise = node.rule.secondaryInputs();

  secondaryInputPromise = toPromise(secondaryInputPromise).then(function(resolved) {
    var secondaryInputs = resolved.map(function(file) {
      var input = nodeForFile(context, file);
      input.complete();
      input.outputs.push(node);

      return input;
    });

    if(!output) {
      var hash = crypto.createHash("sha256");
      
      var inputs = (node.primaryInput ? [node.primaryInput.file] : []).concat(secondaryInputs.map(function(n) { return n.file; }));
      inputs.forEach(function(input) {
        hash.update(input);
      });

      var filename = ".fez/" + (node.rule.fn.name === "" ? "" : node.rule.fn.name + ".") + hash.digest("base64").replace("+", "").replace("/", "").substr(0, 6) + "~",
          file = nodeForFile(context, filename);
      file.inputs.push(node);
      node.outputs.push(file);

      output = file;

      createOutNode();
    }

    return secondaryInputs;
  });

  if(!node.rule.stage.multi) node.rule.stage.proxy._setFile(undefined);
  else node.rule.stage.proxy._lazies = undefined;

  node.promise = Promise.all([primaryInputPromise, secondaryInputPromise]).spread(function(primaryInputs, secondaryInputs) {
    node.primaryInputs = primaryInputs;
    node.secondaryInputs = secondaryInputs;

    return Promise.all(flatten([node.primaryInputs.map(promise), secondaryInputs.map(promise)])).then(function() {
      return performOperation(node, context).then(function(val) {
        outNode.complete();
        return val;
      });
    });
  });

  return true;
}

function file(node) {
  return node.file;
}

function performOperation(node, context) {
  if(node.complete) return Promise.resolve(false);

  var inputs = node.primaryInputs.map(file).concat(node.secondaryInputs.map(file)),
      output = node.output.file;

  if(context.options.verbose)
    console.log(inputs.join(" "), "->", output);

  node.complete = true;

  if(needsUpdate(inputs, [output], context)) {
    var out = node.rule.fn(buildInputs(node.primaryInputs.map(file)), [output]);
    return processOutput(out, output, inputs, context);
  } else {
    return Promise.resolve(false);
  }
}

function buildInputs(files) {
  var inputs = [];
  files.forEach(function(file) {
    inputs.push(new Input(file));
  });

  inputs.asBuffers = function() {
    return this.map(function(i) { return i.asBuffer(); });
  };

  return inputs;
}

function processOutput(out, output, inputs, context) {
  if(isPromise(out)) {
    return out.then(function(out) {
      return processOutput(out, output, inputs);
    });
  } else if(out instanceof Writable) {
    printCreating(output);

    return new Promise(function(resolve, reject) {
      out.pipe(fs.createWriteStream(output));
      out.on("end", function() {
        resolve();
      });
    });
  } else if(out instanceof Buffer || typeof out === "string") {
    printCreating(output);
    return writep(output, out);
  } else if(!out) {
    return writep(output, new Buffer(0));
  } else if(out === true) {
    printCreating(output);
  } else if(typeof out === "function") {
    throw new Error("Output can't be a function. Did you forget to call the operation in your rule (e.g op())?");
  } else {
    throw new Error("Invalid operation output (" + Object.getPrototypeOf(out).constructor.name + '):' + out);
  }

  return Promise.resolve(true);
}

function printCreating(output) {
  process.stdout.write("Creating ");
  cursor.green();
  process.stdout.write(output + "\n"); 
  cursor.reset();
}

function promise(e) {
  return e.promise;
};

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

function matchAgainstStage(context, node, stage) {
  assert(isFile(node));
  var anyMatch = stage.input(node.file);

  if(anyMatch) {
    if(stage.one && stage.matched) {
      //TODO: say which stage/glob is matching
      console.log("Warning: a with(...).one(...) matches multiple files. Only using first match.");
      return false;
    } else if (stage.one) {
      stage.matched = true;
    }
    var change = false;

    stage.rules.forEach(function(rule) {
      var operation = getOperationForRule(context, rule);
      node.outputs.push(operation);
      operation.stageInputs.push(node);
      evaluateOperation(context, operation);
      change = true;
    });

    return change;
  }

  return false;
}

function getOperationForRule(context, rule) {
  if(rule.stage.multi) {
    if(!rule.operation)
      rule.operation = { id: id++, stageInputs: [], outputs: [], rule: rule, lazies: new LazyFileList(context) };
    context.nodes.insert(rule.operation);
    return rule.operation;
  } else {
    var node = { id: id++, stageInputs: [], outputs: [], rule: rule };
    context.nodes.insert(node);
    return node;
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
  context.nodes.insert(node);
  context.worklist.push(node);

  return node;
}

function FileNode(context, file) {
  this.id = id++;
  this.file = file;
  this.inputs = [];
  this.outputs = [];
  this.lazy = new LazyFile(context, file);
  this._deferred = Promise.defer();
  this.promise = this._deferred.promise;
}

FileNode.prototype.complete = function() {
  if(!this._complete) {
    this.lazy._loadFile();
    this._deferred.resolve();
    this._complete = true;
  }
};

FileNode.prototype.isComplete = function() {
  return !!this._complete;
};


function callfn(fn) {
  if(typeof fn === "function")
    return fn();
  return fn;
}

function ProxyFile() {
};

ProxyFile.prototype._setFile = function(lazy) {
  this._lazy = lazy;
};

ProxyFile.prototype._inspect = function() {
  if(this._lazy === undefined) throw new Error("Can't call inspect_() outside of a lazy function");
  return this._lazy;
};

ProxyFile.prototype.map = function(fn) {
  return function() {
    return fn(this._inspect());
  }.bind(this);
};

ProxyFile.prototype.mapName = function(fn) {
  return function() {
    return fn(this._inspect().getFilename());
  }.bind(this);
};

ProxyFile.prototype.patsubst = function(pattern, replacement) {
  return this.mapName(patsubst.bind(this, pattern, replacement));
};

function ProxyFileList() { };

ProxyFileList.prototype.names = function() {
  return this._lazies.getFilenames();
};

function LazyFileList(context) {
  this._filenames = Promise.defer();
};

LazyFileList.prototype.getFilenames = function() {
  return this._filenames.promise;
};

LazyFileList.prototype._setFilenames = function(filenames) {
  this._filenames.resolve(filenames);
};

function LazyFile(context, filename) {
  this._filename = filename;
  this._asBuffer = Promise.defer();
};

LazyFile.prototype._loadFile = function(filename) {
  if(filename)
    this._setFilename(filename);

  fs.readFile(this.getFilename(), function(err, data) {
    if(err) this._asBuffer.reject(err);
    else this._asBuffer.resolve(data);
  }.bind(this));
};

LazyFile.prototype.getFilename = function() {
  return this._filename;
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

function needsUpdate(inputs, outputs, context) {
  var stat = fs.statSync(context.options.module.filename),
      mtime = stat.mtime.getTime();

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

function toPromise(p) {
  return Promise.cast(p);
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

fez.allInputs = function(primary, secondary) {
  return (primary ? [primary] : []).concat(secondary);
};

fez.exec = function(command) {
  function ex(inputs, output) {
    var ifiles = inputs.map(function(i) { return i.getFilename(); }).join(" "),
        ofiles = output.join(" "),
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

function patsubst(pattern, replacement, string) {
  var regex = new RegExp(pattern.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1").replace("%", "(.+)")),
      result = regex.exec(string),
      sub = result[1],
      out = replacement.replace("%", sub);

  return out;
};
