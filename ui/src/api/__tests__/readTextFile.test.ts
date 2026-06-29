import { describe, it, expect } from "vitest";
import { readTextFile } from "../readTextFile";

describe("readTextFile", () => {
  it("reads a File's contents as text", async () => {
    const file = new File(["hello: world\n"], "x.yaml", { type: "application/yaml" });
    expect(await readTextFile(file)).toBe("hello: world\n");
  });

  it("reads multi-line content verbatim", async () => {
    const yaml = "version: 1\nname: Demo\nsteps: []\n";
    const file = new File([yaml], "demo.yaml");
    expect(await readTextFile(file)).toBe(yaml);
  });
});
