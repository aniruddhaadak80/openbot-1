import { describe, expect, it } from "vitest";
import { findChatSearchMatches } from "./chat-search";

/** The search root holds the messages; each message carries the attribute the search looks for. */
function conversation(inner: string): HTMLElement {
  const root = document.createElement("div");
  const message = document.createElement("div");
  message.setAttribute("data-chat-search-message", "message");
  message.innerHTML = inner;
  root.append(message);
  document.body.append(root);
  return root;
}

/** The words the highlight covers, read from the text nodes it starts and ends in. */
function highlighted(root: HTMLElement, query: string): { start: string; end: string }[] {
  return findChatSearchMatches(root, query).map((match) => ({
    start: match.range.startContainer.textContent?.slice(match.range.startOffset) ?? "",
    end: match.range.endContainer.textContent?.slice(0, match.range.endOffset) ?? "",
  }));
}

describe("findChatSearchMatches", () => {
  it("finds a phrase that a line break splits", () => {
    const root = conversation("First line says hello<br>world and more");
    expect(highlighted(root, "hello world")).toEqual([{ start: "hello", end: "world" }]);
  });

  it("finds a phrase that a block boundary splits", () => {
    const root = conversation("<p>First line says hello</p><p>world and more</p>");
    expect(highlighted(root, "hello world")).toEqual([{ start: "hello", end: "world" }]);
  });

  it("finds a phrase in one text run", () => {
    const root = conversation("The client signs off on Fridays");
    expect(highlighted(root, "client signs")).toEqual([
      { start: "client signs off on Fridays", end: "The client signs" },
    ]);
  });

  it("ignores the case of the query", () => {
    const root = conversation("The client signs off on Fridays");
    expect(highlighted(root, "CLIENT SIGNS")).toEqual([
      { start: "client signs off on Fridays", end: "The client signs" },
    ]);
  });

  it("does not match two words that only a line break separates", () => {
    const root = conversation("First line says hello<br>world and more");
    expect(highlighted(root, "helloworld")).toEqual([]);
  });

  it("treats a query character as text, not as a pattern", () => {
    const root = conversation("The client signs off on Fridays");
    expect(highlighted(root, "client (signs")).toEqual([]);
  });

  it("returns nothing for a query that is only whitespace", () => {
    const root = conversation("The client signs off on Fridays");
    expect(highlighted(root, "   ")).toEqual([]);
  });
});
