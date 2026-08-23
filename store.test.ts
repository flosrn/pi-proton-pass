import { describe, expect, it } from "vitest";
import { parsePassReadRef, parsePassUri } from "./store.js";

const SHARE =
  "SynShareId000000000000000000000000000000000000000000000000000000000000000==";
const ITEM =
  "SynItemId0000000000000000000000000000000000000000000000000000000000000000==";

describe("parsePassUri", () => {
  it("parses a native SHARE/ITEM/field URI", () => {
    expect(parsePassUri(`pass://${SHARE}/${ITEM}/password`)).toEqual({
      kind: "id",
      shareId: SHARE,
      itemId: ITEM,
      field: "password",
    });
  });

  it("does not treat a vault name as an id", () => {
    expect(parsePassUri("pass://Personal/GitHub Token/password")).toEqual({
      kind: "name",
      vault: "Personal",
      title: "GitHub Token",
      field: "password",
    });
  });

  it("keeps slashes inside an item title", () => {
    expect(parsePassUri("pass://Personal/org/repo token/password")).toEqual({
      kind: "name",
      vault: "Personal",
      title: "org/repo token",
      field: "password",
    });
  });

  it("rejects incomplete refs", () => {
    expect(parsePassUri("pass://Personal/only-title")).toBeNull();
    expect(parsePassUri("op://Vault/Item/field")).toBeNull();
  });
});

describe("parsePassReadRef", () => {
  it("strips the bang prefix and quotes", () => {
    expect(parsePassReadRef("!pass read 'pass://Personal/X/password'")).toBe(
      "pass://Personal/X/password",
    );
  });
});
