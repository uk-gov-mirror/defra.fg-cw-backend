import Joi from "joi";
import { comment } from "./comment.schema.js";
import { requiredRolesSchema } from "./requiredRoles.schema.js";

export const Code = Joi.string()
  .pattern(/^[A-Z0-9_]+$/)
  .label("Code");

const Action = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  comment: comment.allow(null).required(),
  checkTasks: Joi.boolean().required(),
}).label("Action");

const Transition = Joi.object({
  targetPosition: Joi.string()
    .pattern(/[A-Z0-9_:]/)
    .required(),
  action: Action.allow(null).required(),
}).label("Transition");

export const Status = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  description: Joi.string().allow(null).required(),
  transitions: Joi.array().items(Transition).required(),
}).label("Status");

export const StatusOption = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  completes: Joi.boolean().required(),
}).label("StatusOption");

export const Task = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  description: Joi.alternatives()
    .try(Joi.string(), Joi.array(), Joi.valid(null))
    .required(),
  statusOptions: Joi.array().items(StatusOption).required(),
  comment: comment.optional(),
  requiredRoles: requiredRolesSchema.allow(null),
}).label("Task");

const TaskGroup = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  description: Joi.string().allow(null).required(),
  tasks: Joi.array().items(Task).min(1).required(),
}).label("TaskGroup");

export const Stage = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  description: Joi.string().allow(null).required(),
  taskGroups: Joi.array().items(TaskGroup).required(),
  actionsTitle: Joi.string().optional(),
  statuses: Joi.array().items(Status).required(),
  agreements: Joi.array().optional().allow(null),
}).label("Stage");

export const Phase = Joi.object({
  code: Code.required(),
  name: Joi.string().required(),
  stages: Joi.array().items(Stage).min(1).required(),
}).label("Phase");
