import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing-library's automatic cleanup is disabled when `globals: true`
// doesn't inject an `afterEach`, so do it explicitly here.
afterEach(() => {
  cleanup();
});
