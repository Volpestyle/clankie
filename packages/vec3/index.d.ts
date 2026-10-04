export interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export class Vec3 implements Coordinates {
  constructor(x?: number, y?: number, z?: number);
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
  update(other: Coordinates): this;
  clone(): Vec3;
  translate(x: number, y: number, z: number): this;
  add(other: Coordinates): this;
  subtract(other: Coordinates): this;
  scale(factor: number): this;
  offset(x: number, y: number, z: number): Vec3;
  plus(other: Coordinates): Vec3;
  minus(other: Coordinates): Vec3;
  scaled(factor: number): Vec3;
  floored(): Vec3;
  modulus(other: Coordinates): Vec3;
  distanceSquared(other: Coordinates): number;
  norm(): number;
  normalize(): this;
  dot(other: Coordinates): number;
  distanceTo(other: Coordinates): number;
  equals(other: Coordinates): boolean;
  toString(): string;
}
