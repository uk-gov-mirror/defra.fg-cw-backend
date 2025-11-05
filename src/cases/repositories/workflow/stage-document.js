import { StatusDocument } from "./status-document.js";
import { TaskGroupDocument } from "./task-group-document.js";

export class StageDocument {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.description = props.description;
    this.statuses = props.statuses.map((status) => new StatusDocument(status));
    this.taskGroups = props.taskGroups.map(
      (taskGroup) => new TaskGroupDocument(taskGroup),
    );
  }
}
