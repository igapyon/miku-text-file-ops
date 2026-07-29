import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  validateCreateRequest,
  validateDeleteRequest,
  validateReadRequest,
  validateSearchRequest,
  validateUpdateRequest,
} from "../../src/index.js";

test("all marked specification request examples pass current validators", () => {
  const specification = readFileSync(
    resolve("docs/specification.md"),
    "utf8",
  );
  const pattern =
    /<!-- request-example: (search|read|create|update|delete) -->\s*```json\n([\s\S]*?)\n```/gu;
  const examples = [...specification.matchAll(pattern)];
  assert.ok(examples.length > 0);

  for (const match of examples) {
    const operation = match[1] as
      | "search"
      | "read"
      | "create"
      | "update"
      | "delete";
    const request = JSON.parse(match[2] as string);
    switch (operation) {
      case "search":
        validateSearchRequest(request);
        break;
      case "read":
        validateReadRequest(request);
        break;
      case "create":
        validateCreateRequest(request);
        break;
      case "update":
        validateUpdateRequest(request);
        break;
      case "delete":
        validateDeleteRequest(request);
        break;
    }
  }
});
