import { config } from "../../common/config.js";
import { withTransaction } from "../../common/with-transaction.js";
import { CaseStatusUpdatedEvent } from "../events/case-status-updated.event.js";
import { CasePhase } from "../models/case-phase.js";
import { CaseStage } from "../models/case-stage.js";
import { CaseTaskGroup } from "../models/case-task-group.js";
import { CaseTask } from "../models/case-task.js";
import { Case } from "../models/case.js";
import { Outbox } from "../models/outbox.js";
import { save } from "../repositories/case.repository.js";
import { insertMany } from "../repositories/outbox.repository.js";
import { findWorkflowByCodeUseCase } from "./find-workflow-by-code.use-case.js";

const caseStatus = {
  NEW: "NEW",
  IN_PROGRESS: "IN_PROGRESS",
};

const createCaseTask = (task) =>
  new CaseTask({
    code: task.code,
    status: "pending",
    commentRef: null,
    updatedAt: null,
    updatedBy: null,
  });

const createCaseTaskGroup = (taskGroup) =>
  new CaseTaskGroup({
    code: taskGroup.code,
    tasks: taskGroup.tasks.map(createCaseTask),
  });

const createCaseStage = (stage) =>
  new CaseStage({
    code: stage.code,
    taskGroups: stage.taskGroups.map(createCaseTaskGroup),
  });

const createCasePhase = (phase) =>
  new CasePhase({
    code: phase.code,
    stages: phase.stages.map(createCaseStage),
  });

export const createCaseUseCase = async (message) => {
  return await withTransaction(async (session) => {
    const {
      event: { data },
    } = message;
    const { caseRef, workflowCode, payload } = data;

    const workflow = await findWorkflowByCodeUseCase(workflowCode);

    const initialPosition = workflow.getInitialPosition();

    const kase = Case.new({
      caseRef,
      workflowCode,
      currentPhase: initialPosition.phaseCode,
      currentStage: initialPosition.stageCode,
      currentStatus: initialPosition.statusCode,
      payload,
      phases: workflow.phases.map(createCasePhase),
    });

    await save(kase, session);

    // FGP-659 - send event back to GAS to update the status to IN_PROGRESS
    // This can be removed when we have state transitions in CW-BE
    const caseStatusEvent = new CaseStatusUpdatedEvent({
      caseRef,
      workflowCode,
      previousStatus: caseStatus.NEW,
      currentStatus: caseStatus.IN_PROGRESS,
    });

    await insertMany(
      [
        new Outbox({
          event: caseStatusEvent,
          target: config.get("aws.sns.caseStatusUpdatedTopicArn"),
        }),
      ],
      session,
    );
  });
};
