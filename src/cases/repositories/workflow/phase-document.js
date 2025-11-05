import { ActionDocument } from "./action-document.js";
import { CommentDocument } from "./comment-document.js";
import { RequiredRolesDocument } from "./required-roles-document.js";
import { StageDocument } from "./stage-document.js";
import { StatusDocument } from "./status-document.js";
import { StatusOptionDocument } from "./status-option-document.js";
import { TaskDocument } from "./task-document.js";
import { TaskGroupDocument } from "./task-group-document.js";
import { TransitionDocument } from "./transition-document.js";

export class PhaseDocument {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.stages = props.stages.map((stage) => new StageDocument(stage));
  }

  static createMock() {
    return new PhaseDocument({
      code: "phase-1",
      name: "Phase 1",
      stages: [
        new StageDocument({
          code: "stage-1",
          name: "Stage 1",
          description: "Stage 1 description",
          statuses: [
            new StatusDocument({
              code: "stage-status-1",
              name: "Stage status 1",
              description: "Stage status 1 description",
              transitions: [
                new TransitionDocument({
                  targetPosition: "::stage-status-2",
                  action: new ActionDocument({
                    code: "action-1",
                    name: "Action 1",
                    comment: new CommentDocument({
                      label: "Action label 1",
                      helpText: "Action help text",
                      mandatory: true,
                    }),
                  }),
                }),
              ],
            }),
            new StatusDocument({
              code: "stage-status-2",
              name: "Stage status 2",
              description: "Stage status 2 description",
              transitions: [],
            }),
          ],
          taskGroups: [
            new TaskGroupDocument({
              code: "task-group-1",
              name: "Task group 1",
              description: "Task group description",
              tasks: [
                new TaskDocument({
                  code: "task-1",
                  name: "Task 1",
                  description: "Task 1 description",
                  statusOptions: [
                    new StatusOptionDocument({
                      code: "status-option-1",
                      name: "Status option 1",
                      completes: false,
                    }),
                  ],
                  requiredRoles: new RequiredRolesDocument({
                    allOf: ["ROLE_1"],
                    anyOf: ["ROLE_2"],
                  }),
                }),
              ],
            }),
          ],
        }),
        new StageDocument({
          code: "stage-2",
          name: "Stage 2",
          description: "Stage 2 description",
          statuses: [],
          taskGroups: [],
        }),
        new StageDocument({
          code: "stage-3",
          name: "Stage 3",
          description: "Stage 3 description",
          statuses: [],
          taskGroups: [],
        }),
      ],
    });
  }
}
