import { Permissions } from "../models/permissions.js";
import { WorkflowActionComment } from "../models/workflow-action-comment.js";
import { WorkflowAction } from "../models/workflow-action.js";
import { WorkflowPhase } from "../models/workflow-phase.js";
import { WorkflowStageStatus } from "../models/workflow-stage-status.js";
import { WorkflowStage } from "../models/workflow-stage.js";
import { WorkflowTaskGroup } from "../models/workflow-task-group.js";
import { WorkflowTaskStatusOption } from "../models/workflow-task-status-option.js";
import { WorkflowTask } from "../models/workflow-task.js";
import { WorkflowTransition } from "../models/workflow-transition.js";
import { Workflow } from "../models/workflow.js";
import { save } from "../repositories/workflow.repository.js";

const createWorkflowTaskStatusOption = (statusOption) =>
  new WorkflowTaskStatusOption({
    code: statusOption.code,
    name: statusOption.name,
    completes: statusOption.completes,
  });

const createWorkflowTask = (task) =>
  new WorkflowTask({
    code: task.code,
    name: task.name,
    description: task.description,
    requiredRoles: task.requiredRoles
      ? new Permissions({
          allOf: task.requiredRoles.allOf,
          anyOf: task.requiredRoles.anyOf,
        })
      : null,
    statusOptions: task.statusOptions.map(createWorkflowTaskStatusOption),
  });

const createWorkflowTaskGroup = (taskGroup) =>
  new WorkflowTaskGroup({
    code: taskGroup.code,
    name: taskGroup.name,
    description: taskGroup.description,
    tasks: taskGroup.tasks.map(createWorkflowTask),
  });

const createWorkflowAction = (action) =>
  new WorkflowAction({
    code: action.code,
    name: action.name,
    checkTasks: action.checkTasks,
    comment: action.comment
      ? new WorkflowActionComment({
          label: action.comment.label,
          helpText: action.comment.helpText,
          mandatory: action.comment.mandatory,
        })
      : null,
  });

const createWorkflowTransition = (transition) =>
  new WorkflowTransition({
    targetPosition: transition.targetPosition,
    action: transition.action ? createWorkflowAction(transition.action) : null,
  });

const createWorkflowStageStatus = (stage) =>
  new WorkflowStageStatus({
    code: stage.code,
    name: stage.name,
    description: stage.description,
    transitions: stage.transitions.map(createWorkflowTransition),
  });

const createWorkflowStage = (stage) =>
  new WorkflowStage({
    code: stage.code,
    name: stage.name,
    description: stage.description,
    statuses: stage.statuses.map(createWorkflowStageStatus),
    taskGroups: stage.taskGroups.map(createWorkflowTaskGroup),
  });

const createWorkflowPhase = (phase) =>
  new WorkflowPhase({
    code: phase.code,
    name: phase.name,
    stages: phase.stages.map(createWorkflowStage),
  });

export const createWorkflowUseCase = async (createWorkflowCommand) => {
  const workflow = new Workflow({
    code: createWorkflowCommand.code,
    pages: createWorkflowCommand.pages,
    phases: createWorkflowCommand.phases.map(createWorkflowPhase),
    requiredRoles: new Permissions({
      allOf: createWorkflowCommand.requiredRoles.allOf,
      anyOf: createWorkflowCommand.requiredRoles.anyOf,
    }),
    definitions: createWorkflowCommand.definitions,
    externalActions: createWorkflowCommand.externalActions,
  });

  await save(workflow);

  return workflow;
};
