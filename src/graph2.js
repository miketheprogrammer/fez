var util = require("util");

module.exports = function(inputs, stage) {
  console.log(util.inspect(stage, { depth: null }));
};

function Graph() {

}

function File(file) {
  this.from = [];
  this.to = [];
  this.file = file;
}

function Operation(fn) {
  this.from = [];
  this.to = [];
  this.fn = fn;
};
