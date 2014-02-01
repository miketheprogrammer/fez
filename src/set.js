//A very simple set. Fix this pretty quickly, as it will be a performance hit.
function Set(id) {
  if(id === undefined)
    id = function(el) {
      return el.id;
    };

  this._id = id;
  this._array = [];
}

Set.prototype.insert = function(el) {
  if(!this.exists(el)) {
    this._array.push(el);
    return true;
  }

  return false;
};

Set.prototype.remove = function(el) {
  if(this.exists(el)) {
    this._array.splice(this._array.indexOf(el), 1);
    return true;
  }

  return false;
};

Set.prototype.exists = function(el) {
  for(var i = 0; i < this._array.length; i++)
    if(this._id(el) === this._id(this._array[i]))
      return true;

  return false;
};

Set.prototype.array = function() {
  return this._array;
};

Set.prototype.clone = function() {
  var other = new Set(this._id);
  other._array = this._array.slice();
  return other;
};

module.exports = Set;
