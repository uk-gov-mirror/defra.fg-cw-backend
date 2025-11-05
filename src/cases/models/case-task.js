import Boom from "@hapi/boom";
import Joi from "joi";
import { requiredRolesSchema } from "../schemas/requiredRoles.schema.js";
import { Code } from "../schemas/task.schema.js";
import { UrlSafeId } from "../schemas/url-safe-id.schema.js";

export const TaskStatus = Joi.string().valid("complete", "pending");

export class CaseTask {
  static validationSchema = Joi.object({
    code: Code.required(),
    status: TaskStatus.required(),
    updatedAt: Joi.string().isoDate().optional().allow(null),
    updatedBy: Joi.string().allow(null),
    commentRef: UrlSafeId.optional().allow(null, "").label("commentRef"),
    requiredRoles: requiredRolesSchema.optional(),
  });

  constructor(props) {
    const { error, value } = CaseTask.validationSchema.validate(props, {
      stripUnknown: true,
      abortEarly: false,
    });

    if (error) {
      throw Boom.badRequest(
        `Invalid Task: ${error.details.map((d) => d.message).join(", ")}`,
      );
    }

    this.code = value.code;
    this.status = value.status;
    this.commentRef = value.commentRef;
    this.updatedAt = value.updatedAt;
    this.updatedBy = value.updatedBy;
    this.requiredRoles = value.requiredRoles;
  }

  updateStatus(status, updatedBy) {
    const { error, value } = TaskStatus.validate(status, {
      stripUnknown: true,
      abortEarly: false,
    });

    if (error) {
      throw Boom.badRequest(
        `Invalid Task Status: ${error.details.map((d) => d.message).join(", ")}`,
      );
    }

    this.status = value;
    this.updatedBy = updatedBy;
    this.updatedAt = new Date().toISOString();
  }

  updateCommentRef(commentRef) {
    this.commentRef = commentRef;
  }

  getUserIds() {
    return this.updatedBy ? [this.updatedBy] : [];
  }
}
