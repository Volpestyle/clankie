// Independently implemented from installed consumer call sites; see README.md.
class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  update(other) {
    return this.set(other.x, other.y, other.z);
  }

  clone() {
    return new Vec3(this.x, this.y, this.z);
  }

  translate(x, y, z) {
    return this.set(this.x + x, this.y + y, this.z + z);
  }

  add(other) {
    return this.translate(other.x, other.y, other.z);
  }

  subtract(other) {
    return this.translate(-other.x, -other.y, -other.z);
  }

  scale(factor) {
    return this.set(this.x * factor, this.y * factor, this.z * factor);
  }

  offset(x, y, z) {
    return new Vec3(this.x + x, this.y + y, this.z + z);
  }

  plus(other) {
    return this.offset(other.x, other.y, other.z);
  }

  minus(other) {
    return this.offset(-other.x, -other.y, -other.z);
  }

  scaled(factor) {
    return new Vec3(this.x * factor, this.y * factor, this.z * factor);
  }

  floored() {
    return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  modulus(other) {
    const wrap = (value, divisor) => ((value % divisor) + divisor) % divisor;
    return new Vec3(wrap(this.x, other.x), wrap(this.y, other.y), wrap(this.z, other.z));
  }

  distanceSquared(other) {
    return (this.x - other.x) ** 2 + (this.y - other.y) ** 2 + (this.z - other.z) ** 2;
  }

  norm() {
    return Math.hypot(this.x, this.y, this.z);
  }

  normalize() {
    const length = this.norm();
    return length === 0 ? this : this.scale(1 / length);
  }

  dot(other) {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  equals(other) {
    return this.x === other.x && this.y === other.y && this.z === other.z;
  }

  toString() {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

// The Bedrock chunk consumer constructs the default CommonJS export directly.
function vector(x, y, z) {
  return new Vec3(x, y, z);
}
module.exports = vector;
module.exports.Vec3 = Vec3;
