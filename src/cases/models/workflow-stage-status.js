export class WorkflowStageStatus {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.description = props.description;
    this.transitions = props.transitions;
  }
}
