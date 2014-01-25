var nopt = require("nopt"),
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
    Input = require("./input"),
    generateBuildGraph = require("./graph2"),
    fezUtil = require("./util"),
    xtend = require("xtend"),
    util = require("util"),
    mxtend = require("xtend/mutable");

function fez(module) {
  if(require.main === module) {
    var options = xtend({ output: true }, getOptions()),
        target = getTarget(options);
    process.chdir(path.dirname(module.filename));
    options.module = module;
    processTarget(module.exports[target], false, options);
  }
}

function getOptions() {
  return nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean,
    "dot": Boolean,
    "no-output": Boolean
  }, {
    "v": "--verbose",
    "q": "--quiet",
    "c": "--clean",
    "n": "--no-output"
  });
}

function getTarget(options) {
  return options.argv.remain.length ? options.argv.remain[0] : 'default';
}

function createRuleFns(rules) {
  function defineRule(inputs, output, operation, options) {
    if((arguments.length === 2) || (arguments.length === 3 && typeof operation === "object")) {
      if(typeof operation === "object") options = operation;
      operation = output;
      output = undefined;
    }

    options = options || {};

    rules.push({ inputs: toArray(inputs), output: output, op: operation, always: options.always });
  }

  defineRule.each = function(input, output, operation, options) {
    if((arguments.length === 2) || (arguments.length === 3 && typeof operation === "object")) {
      if(typeof operation === "object") options = operation;
      operation = output;
      output = undefined;
    }

    options = options || {};

    if(Array.isArray(input)) throw new Error("Input must be a string or function");

    rules.push({ inputs: [input], output: output, op: operation, each: true, always: options.always });
  };


  return defineRule;
}

function createStage() {
  return { rules: [], stages: [], edges: [] };
}

function processTarget(target, isChild, options) {
  var currentStage = new Stage(),
      each = false,
      spec = {},
      requires = [];

  spec.rule = function(input, output, operation, options) {
    if(arguments.length === 2) {
      operation = output;
      output = undefined;
    } else if(arguments.length === 3 && typeof operation === "object") {
      operation = output;
      options = operation;
      output = undefined;
    }

    currentStage.nodes.push(new Rule(input, output, operation));
  };

  spec.stage = function(fn) {
    runStage(fn);
  };

  spec.withEach = function(glob, fn) {
    each = new MagicFile(glob);

    var stage = runStage(fn.bind(null, each));

    //Flag the stage as a withEach so that we can handle it properly down the line
    stage.withEach = true;

    //Make sure the stage is marked as depending on everything with this glob
    stage.inputs.push(glob);

    each = false;
  };

  spec.with = function(file, fn) {
    var magic = new MagicFile(file);
    var stage = runStage(fn.bind(null, magic));
  };

  function runStage(stageFunction) {
    var stage = new Stage(),
        prevStage = currentStage;

    currentStage.nodes.push(stage);
    currentStage = stage;
    stageFunction();
    currentStage = prevStage;

    return stage;
  };

  target(spec);

  resolveRequires(currentStage, requires, isChild, options);
}

function Rule(inputs, outputs, operation) {
  this.inputs = toArray(inputs);
  this.outputs = toArray(outputs);
  this.operation = operation;
}

function Stage() {
  this.inputs = [];
  this.outputs = [];
  this.nodes = [];
}

//A time-traveling file container
function MagicFile() {

}

MagicFile.prototype.getFilename = function() {
  return function() {
    return this._file.getFilename();
  }.bind(this);
};

MagicFile.prototype._setFile = function(file) {
  this._file = file;
};

function resolveRequires(stage, requires, isChild, options) {
  var anyWorkDone = false;
  return (function nextRequire() {
    if(requires.length > 0) {
      return processTarget(requires.shift(), true, options).then(function(workDone) {
        anyWorkDone = anyWorkDone || workDone;
        return nextRequire();
      });
    } else {
      return work(stage, options, isChild, anyWorkDone);
    }
  })();
}

function work(stage, options, isChild, prevWorkDone) {
  var nodes = generateBuildGraph(glob.sync("**"), stage);
  return;

  if(options.verbose)
    console.log(nodes);

  if(options.dot) {
    process.stdout.write("digraph{");
    var id = 0;
    nodes.forEach(function(node) {
      node._id = id++;
      if(node.isFile()) {
        process.stdout.write(node._id + " [shape=box,label=\"" + node.file + "\"];");
      } else {
        var name = node.fn.name;

        if(name === "")
          name = "?";

        process.stdout.write(node._id + " [label=\"" + name + "\"];");
      }
    });

    nodes.forEach(function(node) {
      if(node.output)
        process.stdout.write(node._id + "->" + node.output._id + ";");
      else if(node.outputs)
        node.outputs.forEach(function(output) {
          process.stdout.write(node._id + "->" + output._id + ";");
        });
    });
    process.stdout.write("}");
    return Promise.resolve(true);
  } else if(options.clean) {
    var cleaned = clean(nodes, options);
    if(!cleaned && !isChild && !options.quiet && !prevWorkDone && lastStage)
      console.log("Nothing to clean.");
    
    return Promise.resolve(cleaned || prevWorkDone);
  } else {
    return build(nodes, isChild, prevWorkDone, stages.length === 0, options);
  }
  //});
};

function clean(nodes, options) {
  var files = glob.sync(".fez.*"),
      complete = 0,
      any = false;


  nodes.forEach(function(node) {
    if(node.isFile() && node.inputs.length > 0) files.push(node.file);
  });

  files.forEach(function(file) {
    try {
      fs.unlinkSync(file);
      any = true;
      
      if(!options.quiet) {
        process.stdout.write("Removing ");
        cursor.red();
        console.log(file);
        cursor.reset();
      }
    } catch(e) {}
  });

  return any;
}

function build(nodes, isChild, prevWorkDone, lastStage, options) {
  var working = [];

  nodes.forEach(function(node) {
    if(node.isFile() && node.inputs.length === 0) working.push(node);
  });

  return digest(nodes, working, {}, options).then(done.bind(this, options, isChild, prevWorkDone, lastStage));
}

function digest(nodes, working, changelist, options) {
  if(working.length === 0) return Promise.resolve(false);

  var newWorking = [];
  var promises = [];
  working.forEach(function(node) {
    if(node.isFile()) {
      node.outputs.forEach(function(out) {
        out.inComplete++;
        if(newWorking.indexOf(out) === -1)
          newWorking.push(out);
      });
    } else {//It's an operation
      //Is it ready to go?
      if(node.inComplete === node.inputs.length) {
        //Yes, do the operation and put the output on the working list
        promises.push(performOperation(options, changelist, node));
        if(node.output) newWorking.push(node.output);
      } else {
        //No, put it back on the working list
        newWorking.push(node);
      }
    }
  });

  return Promise.settle(promises).then(function(results) {
    var anyRejected = false,
        anyWorkDone = false;

    results.forEach(function(i) {
      if(i.isRejected()) {
        anyRejected = anyWorkDone = true;
        if(options.verbose) console.log("Rejected:", i.error().stack);
      } else {
        anyWorkDone = anyWorkDone || i.value();
      }
    });

    if(anyRejected) {
      if(!options.quiet)
        console.log("An operation has failed. Aborting.");
      return anyWorkDone;
    } else {
      return digest(nodes, newWorking, changelist, options).then(function(workDone) {
        return workDone || anyWorkDone;
      });
    }
  });
}

function done(options, isChild, prevWorkDone, lastStage, anyWorkDone) {
  if(!anyWorkDone && !options.quiet) {
    if(!isChild && !prevWorkDone && lastStage)
      console.log("Nothing to be done.");

    return false || prevWorkDone;
  } else {
    if(!isChild && Math.random() < 0.0001 && !options.quiet) console.log("We’re all stories, in the end.");
    return true;
  }
}

function performOperation(options, changelist, op) {
  if(options.verbose) {
    if(op.output)
      console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "->", op.output.file);
    else
      console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "-/");
  }

  var inputs = op.inputs.map(function(i) { return i.file; }),
      output = op.output ? op.output.file : null,
      out;

  if(output) {
    if(needsUpdate(inputs, [output], changelist, options)) {
      if(options.output) {
        out = op.fn(buildInputs(inputs), [output]);
        return processOutput(out, output, inputs, options);
      } else {
        changelist[output] = true;
        printCreating(output);
        return true;
      }
    } else {
      return false;
    }
  } else { //It's a task
    out = op.fn(buildInputs(inputs));

    if(isPromise(out)) return out.then(function() { return true; });
    else return true;
  }
}

function processOutput(out, output, inputs, options) {
  if(isPromise(out)) {
    return out.then(function(out) {
      return processOutput(out, output, inputs, options);
    });
  } else if(out instanceof Writable) {
    if(!options.quiet) 
      printCreating(output);

    return new Promise(function(resolve, reject) {
      out.pipe(fs.createWriteStream(output));
      out.on("end", function() {
        resolve();
      });
    });
  } else if(out instanceof Buffer || typeof out === "string") {
    if(!options.quiet) 
      printCreating(output);
    return writep(output, out);
  } else if(!out) {
    return writep(output, new Buffer(0));
  } else if(out === true) {
    if(!options.quiet) 
      printCreating(output);
  } else if(typeof out === "function") {
    throw new Error("Output can't be a function. Did you forget to call the operation in your rule (e.g op())?");
  } else {
    throw new Error("Invalid operation output (" + Object.getPrototypeOf(out).constructor.name + '):' + out);
  }

  return true;
}

function printCreating(output) {
  process.stdout.write("Creating ");
  cursor.green();
  process.stdout.write(output + "\n"); 
  cursor.reset();
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

mxtend(fez, fezUtil);

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

