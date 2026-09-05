import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Setup for the jsdom project: React Testing Library only. The editor shell
 * never touches the database, Redis or the sandbox, so none of the node
 * project's fakes are loaded here.
 */
afterEach(() => {
  cleanup();
});
