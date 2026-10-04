import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Vec3 as Vector } from "../index.cjs";

const localRequire = createRequire(import.meta.url);
const { Vec3 } = localRequire("../index.cjs") as { Vec3: typeof Vector };

const coordinates = (v: Vector) => [v.x, v.y, v.z];

describe("Minecraft vector consumer contract", () => {
  it("exports a CommonJS constructor and a named class usable by pathfinder subclasses", () => {
    const require = createRequire(import.meta.url);
    const factory = require("../index.cjs");
    expect(coordinates(new factory(1, 2, 3))).toEqual([1, 2, 3]);
    expect(coordinates(factory(4, 5, 6))).toEqual([4, 5, 6]);
    expect(factory.Vec3).toBe(Vec3);
    class Move extends Vec3 {}
    expect(new Move(1, 2, 3)).toBeInstanceOf(Vec3);
    expect(coordinates(new Vec3())).toEqual([0, 0, 0]);
  });

  it("mutates positions in place for packet updates and fluid acceleration", () => {
    const position = new Vec3(1, 2, 3);
    expect(position.set(-4, 5, 6)).toBe(position);
    expect(position.update({ x: 1, y: 2, z: 3 })).toBe(position);
    expect(position.translate(2, -4, 1)).toBe(position);
    expect(coordinates(position)).toEqual([3, -2, 4]);
    expect(position.add({ x: 1, y: 3, z: -2 })).toBe(position);
    expect(position.subtract({ x: 2, y: 2, z: 3 })).toBe(position);
    expect(position.scale(2)).toBe(position);
    expect(coordinates(position)).toEqual([4, -2, -2]);
  });

  it("copies navigation vectors without changing the source or other operand", () => {
    const source = new Vec3(1.5, -0.1, -3.8);
    const other = new Vec3(2, 4, 6);
    expect(coordinates(source.clone())).toEqual(coordinates(source));
    expect(source.clone()).not.toBe(source);
    expect(coordinates(source.offset(1, 2, 3))).toEqual([2.5, 1.9, -0.7999999999999998]);
    expect(coordinates(source.plus(other))).toEqual([3.5, 3.9, 2.2]);
    expect(coordinates(source.minus(other))).toEqual([-0.5, -4.1, -9.8]);
    expect(coordinates(source.scaled(-2))).toEqual([-3, 0.2, 7.6]);
    expect(coordinates(source.floored())).toEqual([1, -1, -4]);
    const blocks = new Vec3(-1, -17, 16);
    expect(coordinates(blocks.modulus(new Vec3(16, 16, 16)))).toEqual([15, 15, 0]);
    expect(coordinates(blocks)).toEqual([-1, -17, 16]);
    expect(coordinates(source)).toEqual([1.5, -0.1, -3.8]);
    expect(coordinates(other)).toEqual([2, 4, 6]);
  });

  it("supports ray directions, dot projection and safe still-water normalization", () => {
    const vector = new Vec3(3, 0, 4);
    expect(vector.norm()).toBe(5);
    expect(vector.distanceSquared(new Vec3(3, 12, 4))).toBe(144);
    expect(vector.distanceTo(new Vec3(3, 12, 4))).toBe(12);
    expect(vector.dot(new Vec3(-2, 7, 3))).toBe(6);
    expect(vector.normalize()).toBe(vector);
    expect(vector.norm()).toBeCloseTo(1);
    const zero = new Vec3();
    expect(zero.normalize()).toBe(zero);
    expect(coordinates(zero)).toEqual([0, 0, 0]);
    expect(new Vec3(1, 2, 3).equals({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(new Vec3(1, 2, 3).equals({ x: 1, y: 2, z: 4 })).toBe(false);
    expect(new Vec3(-1, 2.5, 0).toString()).toBe("(-1, 2.5, 0)");
  });
});
