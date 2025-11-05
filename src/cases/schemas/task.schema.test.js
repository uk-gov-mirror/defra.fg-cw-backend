import { describe, expect, it } from "vitest";
import { Task } from "./task.schema.js";

describe("Task Schema", () => {
  it("should allow missing optional comment", () => {
    const task = {
      code: "abcd-0987-hjyg-8765-6542",
      name: "Test task",
      description: null,
      statusOptions: [],
      requiredRoles: {
        allOf: ["ROLE_1", "ROLE_2"],
        anyOf: ["ROLE_3"],
      },
    };

    const { error } = Task.validate(task);

    expect(error).toBeUndefined();
  });

  it("should have label if comment is provided", () => {
    const task = {
      code: "abcd-0987-hjyg-8765-6542",
      name: "Test task",
      description: null,
      statusOptions: [],
      comment: {
        type: "CONDITIONAL",
        helpText: "Please provide a note",
      },
    };

    const { error } = Task.validate(task);

    expect(error.details[0].message).toBe('"comment.label" is required');
  });

  it("should have helpText if comment is provided", () => {
    const task = {
      code: "abcd-0987-hjyg-8765-6542",
      name: "Test task",
      description: null,
      statusOptions: [],
      comment: {
        type: "CONDITIONAL",
        label: "Note",
      },
    };

    const { error } = Task.validate(task);

    expect(error.details[0].message).toBe('"comment.helpText" is required');
  });

  it("should validate allowed types", () => {
    const types = ["CONDITIONAL", "REQUIRED", "OPTIONAL"];
    const task = {
      code: "abcd-0987-hjyg-8765-6542",
      name: "Test task",
      description: null,
      statusOptions: [],
      comment: {
        type: "CONDITIONAL",
        label: "Note",
        helpText: "Please provide a note",
      },
      requiredRoles: {
        allOf: ["ROLE_1", "ROLE_2"],
        anyOf: ["ROLE_3"],
      },
    };

    types.forEach((type) => {
      task.comment.type = type;
      const { error } = Task.validate(task);
      expect(error).toBeUndefined();
    });
  });

  it("should error with unknown comment type", () => {
    const task = {
      code: "abcd-0987-hjyg-8765-6542",
      name: "Test task",
      description: null,
      statusOptions: [],
      comment: {
        type: "NOT_ALLOWED_TYPE",
        label: "Note",
        helpText: "Please provide a note",
      },
    };

    const { error } = Task.validate(task);
    expect(error.details[0].message).toBe(
      '"comment.type" must be one of [CONDITIONAL, REQUIRED, OPTIONAL]',
    );
  });
});
