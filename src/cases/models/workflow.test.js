import { describe, expect, it } from "vitest";
import { WorkflowActionComment } from "./workflow-action-comment.js";
import { WorkflowAction } from "./workflow-action.js";
import { WorkflowPhase } from "./workflow-phase.js";
import { WorkflowStage } from "./workflow-stage.js";
import { WorkflowTaskGroup } from "./workflow-task-group.js";
import { WorkflowTask } from "./workflow-task.js";
import { Workflow } from "./workflow.js";

describe("Workflow", () => {
  const createMockWorkflow = () => {
    return new Workflow({
      _id: "workflow-id",
      code: "test-workflow",
      phases: [
        new WorkflowPhase({
          code: "phase-1",
          stages: [
            new WorkflowStage({
              code: "stage-1",
              name: "Initial Review",
              taskGroups: [
                new WorkflowTaskGroup({
                  code: "task-group-1",
                  name: "Task Group 1",
                  description: "Task group description",
                  tasks: [
                    new WorkflowTask({
                      code: "task-1",
                      name: "Review application",
                    }),
                  ],
                }),
              ],
              actions: [
                new WorkflowAction({
                  code: "approve",
                  name: "Approve",
                  comment: new WorkflowActionComment({
                    label: "Approval reason",
                    helpText: "Help text",
                    mandatory: false,
                  }),
                }),
                new WorkflowAction({
                  code: "reject",
                  name: "Reject",
                  comment: new WorkflowActionComment({
                    label: "Rejection reason",
                    helpText: "Help reject text",
                    mandatory: true,
                  }),
                }),
                new WorkflowAction({
                  code: "on-hold",
                  name: "Put on hold",
                  comment: new WorkflowActionComment({
                    label: "Note (optional)",
                    helpText: "Help optional text",
                    mandatory: false,
                  }),
                }),
                new WorkflowAction({
                  code: "no-comment-action",
                  name: "Action without comment",
                }),
              ],
            }),
            new WorkflowStage({
              code: "stage-2",
              name: "Final Decision",
              taskGroups: [],
              actions: [
                new WorkflowAction({
                  code: "final-approve",
                  label: "Final Approval",
                }),
              ],
            }),
          ],
        }),
      ],
      externalActions: [
        {
          code: "RERUN_RULES",
          name: "Rerun Rules",
          description: "Rerun the business rules validation",
          endpoint: "landGrantsRulesRerun",
          target: {
            position: "PRE_AWARD:REVIEW_APPLICATION:IN_PROGRESS",
            node: "landGrantsRulesRun",
            nodeType: "array",
            place: "append",
          },
        },
      ],
    });
  };

  describe("findAction", () => {
    it("finds action by id in stage", () => {
      const workflow = createMockWorkflow();
      const stage = workflow.findPhase("phase-1").findStage("stage-1");

      const action = workflow.findAction(stage, "approve");

      expect(action).toBeDefined();
      expect(action.code).toBe("approve");
      expect(action.name).toBe("Approve");
    });

    it("finds different actions in same stage", () => {
      const workflow = createMockWorkflow();
      const stage = workflow.findPhase("phase-1").findStage("stage-1");

      const rejectAction = workflow.findAction(stage, "reject");
      const holdAction = workflow.findAction(stage, "on-hold");

      expect(rejectAction.code).toBe("reject");
      expect(holdAction.code).toBe("on-hold");
    });

    it("finds action in different stage", () => {
      const workflow = createMockWorkflow();
      const stage2 = workflow.findPhase("phase-1").findStage("stage-2");

      const action = workflow.findAction(stage2, "final-approve");

      expect(action).toBeDefined();
      expect(action.code).toBe("final-approve");
    });

    it("throws error when action not found", () => {
      const workflow = createMockWorkflow();
      const stage = workflow.findPhase("phase-1").findStage("stage-1");

      expect(() => workflow.findAction(stage, "non-existent")).toThrowError(
        'Stage "stage-1" does not contain action with code "non-existent"',
      );
    });

    it("throws error for null action id", () => {
      const workflow = createMockWorkflow();
      const stage = workflow.findPhase("phase-1").findStage("stage-1");

      expect(() => workflow.findAction(stage, null)).toThrowError(
        'Stage "stage-1" does not contain action with code "null"',
      );
    });
  });

  describe("isMissingRequiredComment", () => {
    it("returns true when required comment is missing", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      const result = workflow.isMissingRequiredComment(action, null);

      expect(result).toBe(true);
    });

    it("returns true when required comment is empty string", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      const result = workflow.isMissingRequiredComment(action, "");

      expect(result).toBe(true);
    });

    it("returns true when required comment is whitespace only", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      const result = workflow.isMissingRequiredComment(action, "   \t\n   ");

      expect(result).toBe(true);
    });

    it("returns false when required comment is provided", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      const result = workflow.isMissingRequiredComment(action, "Valid comment");

      expect(result).toBe(false);
    });

    it("returns false when comment is optional and not provided", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "OPTIONAL" } };

      const result = workflow.isMissingRequiredComment(action, null);

      expect(result).toBe(false);
    });

    it("returns false when comment is optional and provided", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "OPTIONAL" } };

      const result = workflow.isMissingRequiredComment(
        action,
        "Optional comment",
      );

      expect(result).toBe(false);
    });

    it("returns false when action has no comment configuration", () => {
      const workflow = createMockWorkflow();
      const action = { id: "no-comment" };

      const result = workflow.isMissingRequiredComment(action, null);

      expect(result).toBeFalsy();
    });

    it("returns false when action comment is null", () => {
      const workflow = createMockWorkflow();
      const action = { comment: null };

      const result = workflow.isMissingRequiredComment(action, null);

      expect(result).toBeFalsy();
    });
  });

  describe("validateComment", () => {
    it("passes validation when required comment is provided", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      expect(() => {
        workflow.validateComment({
          stageCode: "stage-1",
          actionCode: "approve",
          action,
          comment: "Valid comment",
        });
      }).not.toThrow();
    });

    it("passes validation when optional comment is not provided", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "OPTIONAL" } };

      expect(() => {
        workflow.validateComment({
          stageCode: "stage-1",
          actionCode: "on-hold",
          action,
          comment: null,
        });
      }).not.toThrow();
    });

    it("passes validation when action has no comment configuration", () => {
      const workflow = createMockWorkflow();
      const action = { id: "no-comment" };

      expect(() => {
        workflow.validateComment({
          stageCode: "stage-1",
          actionCode: "no-comment",
          action,
          comment: null,
        });
      }).not.toThrow();
    });

    it("throws error when required comment is missing", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      expect(() => {
        workflow.validateComment({
          stageCode: "stage-1",
          actionCode: "approve",
          action,
          comment: null,
        });
      }).toThrowError('Stage "stage-1", Action "approve" requires a comment');
    });

    it("throws error when required comment is empty", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      expect(() => {
        workflow.validateComment({
          stageCode: "stage-1",
          actionCode: "approve",
          action,
          comment: "",
        });
      }).toThrowError('Stage "stage-1", Action "approve" requires a comment');
    });

    it("throws error when required comment is whitespace only", () => {
      const workflow = createMockWorkflow();
      const action = { comment: { type: "REQUIRED" } };

      expect(() => {
        workflow.validateComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "approve",
          action,
          comment: "   \t   ",
        });
      }).toThrowError('Stage "stage-1", Action "approve" requires a comment');
    });
  });

  describe("validateStageActionComment", () => {
    it("validates successfully with valid stage, action, and comment", () => {
      const workflow = createMockWorkflow();

      const result = workflow.validateStageActionComment({
        phaseCode: "phase-1",
        stageCode: "stage-1",
        actionCode: "approve",
        comment: "Valid approval comment",
      });

      expect(result).toBe(true);
    });

    it("validates successfully with optional comment action", () => {
      const workflow = createMockWorkflow();

      const result = workflow.validateStageActionComment({
        phaseCode: "phase-1",
        stageCode: "stage-1",
        actionCode: "on-hold",
        comment: null,
      });

      expect(result).toBe(true);
    });

    it("validates successfully with action that has no comment requirement", () => {
      const workflow = createMockWorkflow();

      const result = workflow.validateStageActionComment({
        phaseCode: "phase-1",
        stageCode: "stage-1",
        actionCode: "no-comment-action",
        comment: null,
      });

      expect(result).toBe(true);
    });

    it("throws error when stage is not found", () => {
      const workflow = createMockWorkflow();

      expect(() => {
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "non-existent-stage",
          actionCode: "approve",
          comment: "Comment",
        });
      }).toThrowError('Stage with code "non-existent-stage" not found');
    });

    it("throws error when action is not found", () => {
      const workflow = createMockWorkflow();

      expect(() => {
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "non-existent-action",
          comment: "Comment",
        });
      }).toThrowError(
        'Stage "stage-1" does not contain action with code "non-existent-action"',
      );
    });

    it("throws error when required comment is missing", () => {
      const workflow = createMockWorkflow();

      expect(() => {
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "approve",
          comment: null,
        });
      }).toThrowError('Stage "stage-1", Action "approve" requires a comment');
    });

    it("validates multiple different scenarios", () => {
      const workflow = createMockWorkflow();

      // Required comment provided
      expect(
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "approve",
          comment: "Approved because criteria met",
        }),
      ).toBe(true);

      // Optional comment not provided
      expect(
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "on-hold",
          comment: null,
        }),
      ).toBe(true);

      // Optional comment provided
      expect(
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "on-hold",
          comment: "Waiting for more information",
        }),
      ).toBe(true);

      // No comment requirement
      expect(
        workflow.validateStageActionComment({
          phaseCode: "phase-1",
          stageCode: "stage-1",
          actionCode: "no-comment-action",
          comment: null,
        }),
      ).toBe(true);
    });
  });

  describe("integration with findTask method", () => {
    it("uses findStage method in findTask", () => {
      const workflow = createMockWorkflow();

      const task = workflow.findTask({
        phaseCode: "phase-1",
        stageCode: "stage-1",
        taskGroupCode: "task-group-1",
        taskCode: "task-1",
      });

      expect(task).toBeDefined();
      expect(task.code).toBe("task-1");
    });

    it("throws error from findPhase when phase not found", () => {
      const workflow = createMockWorkflow();

      expect(() => {
        workflow.findTask({
          phaseCode: "non-existent-phase",
          stageCode: "stage-1",
          taskGroupCode: "task-group-1",
          taskCode: "task-1",
        });
      }).toThrowError('Phase with code "non-existent-phase" not found');
    });

    it("throws error from findStage when stage not found in findTask", () => {
      const workflow = createMockWorkflow();

      expect(() => {
        workflow.findTask({
          phaseCode: "phase-1",
          stageCode: "non-existent-stage",
          taskGroupCode: "task-group-1",
          taskCode: "task-1",
        });
      }).toThrowError('Stage with code "non-existent-stage" not found');
    });
  });
});
