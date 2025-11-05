import Joi from "joi";

export const comment = Joi.object({
  label: Joi.string().required(),
  helpText: Joi.string().required(),
  mandatory: Joi.boolean().required(),
}).label("Comment");
