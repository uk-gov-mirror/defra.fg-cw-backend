import Joi from "joi";
import { assignedUserSchema } from "../cases/assigned-user.schema.js";
import { statusSchema } from "../cases/stages/tasks/status.schema.js";
import { requiredRolesSchema } from "../requiredRoles.schema.js";
import { Code, StatusOption } from "../task.schema.js";
import { UrlSafeId } from "../url-safe-id.schema.js";

export const CaseStage = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  description: Joi.string().allow(null).required(),
  taskGroups: Joi.array()
    .items(
      Joi.object({
        code: Code.required(),
        name: Joi.string().optional(),
        description: Joi.string().allow(null).required(),
        tasks: Joi.array()
          .items(
            Joi.object({
              code: Code.required(),
              name: Joi.string().required(),
              description: Joi.array().required(),
              statusOptions: Joi.array().items(StatusOption).required(),
              status: statusSchema.required(),
              commentRef: UrlSafeId.allow(null).optional(),
              requiredRoles: requiredRolesSchema.optional(),
            }),
          )
          .min(1)
          .required(),
      }),
    )
    .required(),
  outcome: Joi.object({
    actionCode: UrlSafeId.required(),
    comment: Joi.string().optional(),
    commentRef: Joi.string().optional(),
  })
    .optional()
    .allow(null),
}).label("CaseStage");

export const CasePhase = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  stages: Joi.array().items(CaseStage).min(1).required(),
}).label("Phase");

export const agreementSchema = Joi.object({
  agreementRef: Joi.string().pattern(/^[a-zA-Z0-9-]+$/),
  agreementStatus: Joi.string().pattern(/^[A-Z_]+$/),
  createdAt: Joi.date().iso(),
}).label("Agreement");

export const findCaseResponseSchema = Joi.object({
  _id: Joi.string().hex().length(24).required(),
  workflowCode: Joi.string().required(),
  caseRef: Joi.string().required(),
  currentPhase: Code.required(),
  currentStage: Code.required(),
  currentStatus: Code.required(),
  dateReceived: Joi.date().iso().required(),
  payload: Joi.object().required(),
  phases: Joi.array().items(CasePhase).min(1).required(),
  assignedUser: assignedUserSchema.allow(null),
  requiredRoles: requiredRolesSchema.required(),
  supplementaryData: Joi.object(),
})
  .options({
    presence: "required",
    stripUnknown: true,
  })
  .label("FindCaseResponse");
