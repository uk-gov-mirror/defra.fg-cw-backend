import Boom from "@hapi/boom";

export class WorkflowStage {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.description = props.description;
    this.statuses = props.statuses;
    this.taskGroups = props.taskGroups;
  }

  findTaskGroup(taskGroupCode) {
    const taskGroup = this.taskGroups.find((s) => s.code === taskGroupCode);

    if (!taskGroup) {
      throw Boom.notFound(`TaskGroup with code "${taskGroupCode}" not found`);
    }

    return taskGroup;
  }
}
