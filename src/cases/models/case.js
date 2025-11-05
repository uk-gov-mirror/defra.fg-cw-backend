import Boom from "@hapi/boom";
import { ObjectId } from "mongodb";
import { CasePhase } from "./case-phase.js";
import { CaseStage } from "./case-stage.js";
import { CaseTaskGroup } from "./case-task-group.js";
import { CaseTask } from "./case-task.js";
import { assertIsComment, toComments } from "./comment.js";
import { EventEnums } from "./event-enums.js";
import {
  assertIsTimelineEvent,
  TimelineEvent,
  toTimelineEvents,
} from "./timeline-event.js";

export class Case {
  constructor(props) {
    const comments = toComments(props.comments);
    const timeline = toTimelineEvents(props.timeline, comments);

    this._id = props._id || new ObjectId().toHexString();
    this.caseRef = props.caseRef;
    this.workflowCode = props.workflowCode;
    this.dateReceived = props.dateReceived;
    this.currentPhase = props.currentPhase;
    this.currentStage = props.currentStage;
    this.currentStatus = props.currentStatus;
    this.assignedUser = props.assignedUser || null;
    this.payload = props.payload;
    this.phases = props.phases;
    this.comments = comments;
    this.timeline = timeline;
    this.supplementaryData = props.supplementaryData || {};
  }

  get objectId() {
    return ObjectId.createFromHexString(this._id);
  }

  unassignUser({ text, createdBy }) {
    this.assignUser({
      assignedUserId: null,
      text,
      createdBy,
    });
  }

  findPhase(phaseCode) {
    const phase = this.phases.find((p) => p.code === phaseCode);

    if (!phase) {
      throw Boom.notFound(
        `Case with caseRef ${this.caseRef} and workflowCode ${this.workflowCode} does not have a phase with code ${phaseCode}`,
      );
    }

    return phase;
  }

  findComment(commentRef) {
    return this.comments.find((c) => c.ref === commentRef);
  }

  setTaskStatus({
    phaseCode,
    stageCode,
    taskGroupCode,
    taskCode,
    status,
    comment,
    updatedBy,
  }) {
    const task = this.findPhase(phaseCode)
      .findStage(stageCode)
      .findTaskGroup(taskGroupCode)
      .findTask(taskCode);

    task.updateStatus(status, updatedBy);

    if (status === "complete") {
      const timelineEvent = TimelineEvent.createTaskCompleted({
        createdBy: updatedBy,
        text: comment,
        data: {
          caseId: this._id,
          phaseCode,
          stageCode,
          taskGroupCode,
          taskCode,
        },
      });

      this.#addTimelineEvent(timelineEvent);
      task.updateCommentRef(timelineEvent.comment?.ref);
    }
  }

  assignUser({ assignedUserId, createdBy, text }) {
    const eventType = assignedUserId
      ? EventEnums.eventTypes.CASE_ASSIGNED
      : EventEnums.eventTypes.CASE_UNASSIGNED;

    const timelineEvent = TimelineEvent.createAssignUser({
      eventType,
      text,
      data: {
        assignedTo: assignedUserId,
        previouslyAssignedTo: this.assignedUser?.id,
      },
      createdBy,
    });

    this.#setAssignedUser(assignedUserId);
    this.#addTimelineEvent(timelineEvent);
  }

  addNote({ text, createdBy }) {
    if (!text?.trim()) {
      throw Boom.badRequest(`Note text is required and cannot be empty.`);
    }

    const timelineEvent = TimelineEvent.createNoteAdded({
      text,
      createdBy,
    });
    this.#addTimelineEvent(timelineEvent);
    return timelineEvent.comment;
  }

  addSupplementaryData(key, data) {
    this.supplementaryData[key] = data;
  }

  updateStageOutcome({ actionCode, comment, createdBy }) {
    const timelineEvent = TimelineEvent.createStageCompleted({
      data: {
        actionCode,
        phaseCode: this.currentPhase,
        stageCode: this.currentStage,
      },
      text: comment,
      createdBy,
    });

    const currentStage = this.#getCurrentStage();

    currentStage.outcome = {
      actionCode,
      createdBy,
      createdAt: new Date().toISOString(),
    };

    if (timelineEvent.comment) {
      currentStage.outcome.commentRef = timelineEvent.comment.ref;
    }

    this.#addTimelineEvent(timelineEvent);

    if (actionCode === "approve") {
      this.#moveToNextStage();
    }
  }

  updateStatus(status, createdBy) {
    this.currentStatus = status;

    if (status === "APPROVED") {
      const timelineEvent = TimelineEvent.createCaseApproved({
        data: {
          status,
        },
        createdBy,
      });

      this.#addTimelineEvent(timelineEvent);
    }
  }

  getUserIds() {
    const caseUserIds = this.assignedUser ? [this.assignedUser.id] : [];

    const timelineUserIds = this.timeline.flatMap((event) =>
      event.getUserIds(),
    );

    const commentUserIds = this.comments.flatMap((comment) =>
      comment.getUserIds(),
    );

    const taskUserIds = this.phases.flatMap((phase) => phase.getUserIds());

    const allUserIds = [
      ...caseUserIds,
      ...timelineUserIds,
      ...commentUserIds,
      ...taskUserIds,
    ];

    return [...new Set(allUserIds)];
  }

  #setAssignedUser(userId) {
    this.assignedUserId = userId;
    this.assignedUser = userId ? { id: userId } : null;
  }

  #addTimelineEvent(timelineEvent) {
    assertIsTimelineEvent(timelineEvent);
    this.timeline.unshift(timelineEvent);

    if (timelineEvent.comment) {
      this.#addComment(timelineEvent.comment);
    }

    return timelineEvent;
  }

  #addComment(comment) {
    assertIsComment(comment);
    this.comments.unshift(comment);
    return comment;
  }

  #getCurrentStage() {
    const currentStageIndex = this.#getCurrentStageIndex();
    return this.phases[0].stages[currentStageIndex];
  }

  #moveToNextStage() {
    const nextStage = this.#getNextStage();
    this.currentStage = nextStage.code;
    return nextStage;
  }

  #getNextStage() {
    const currentStageIndex = this.#getCurrentStageIndex();
    const currentStage = this.#getCurrentStage();

    if (currentStageIndex === this.phases[0].stages.length - 1) {
      throw Boom.notFound(
        `Cannot progress case ${this._id} from stage ${this.currentStage}, no more stages to progress to`,
      );
    }

    const allTasksComplete = currentStage.taskGroups
      .flatMap((group) => group.tasks)
      .every((task) => task.status === "complete");

    if (!allTasksComplete) {
      throw Boom.badRequest(
        `Cannot progress case ${this._id} from stage ${this.currentStage} - some tasks are not complete.`,
      );
    }

    return this.phases[0].stages[currentStageIndex + 1];
  }

  #getCurrentStageIndex() {
    const currentStageIndex = this.phases[0].stages.findIndex(
      (stage) => stage.code === this.currentStage,
    );

    if (currentStageIndex === -1) {
      throw Boom.notFound(
        `Cannot find current stage index for ${this.currentStage}, case ${this._id}`,
      );
    }

    return currentStageIndex;
  }

  static new({
    caseRef,
    workflowCode,
    currentPhase,
    currentStage,
    currentStatus,
    payload,
    phases,
  }) {
    return new Case({
      caseRef,
      workflowCode,
      currentPhase,
      currentStage,
      currentStatus,
      dateReceived: new Date().toISOString(),
      payload,
      supplementaryData: {},
      timeline: [
        new TimelineEvent({
          eventType: EventEnums.eventTypes.CASE_CREATED,
          createdBy: "System",
          data: {
            caseRef,
          },
        }),
      ],
      phases,
    });
  }

  static createMock(props) {
    return new Case({
      caseRef: "case-ref",
      workflowCode: "workflow-code",
      currentPhase: "phase-1",
      currentStage: "stage-1",
      currentStatus: "NEW",
      dateReceived: "2025-01-01T00:00:00.000Z",
      payload: {},
      supplementaryData: {},
      phases: [
        new CasePhase({
          code: "phase-1",
          stages: [
            new CaseStage({
              code: "stage-1",
              taskGroups: [
                new CaseTaskGroup({
                  code: "task-group-1",
                  tasks: [
                    new CaseTask({
                      code: "task-1",
                      status: "pending",
                      // this should be refactored to use null
                      commentRef: undefined,
                      updatedAt: undefined,
                      updatedBy: undefined,
                    }),
                  ],
                }),
              ],
            }),
            new CaseStage({
              code: "stage-2",
              taskGroups: [],
            }),
          ],
        }),
      ],
      timeline: [
        new TimelineEvent({
          eventType: EventEnums.eventTypes.CASE_CREATED,
          createdAt: "2025-01-01T00:00:00.000Z",
          description: "Case received",
          // 'createdBy' is hydrated on find-case-by-id
          createdBy: "System", // To specify that the case was created by an external system
          data: {
            caseRef: "case-ref",
          },
        }),
      ],
      comments: [],
      assignedUser: {
        id: "64c88faac1f56f71e1b89a33",
      },
      ...props,
    });
  }
}
