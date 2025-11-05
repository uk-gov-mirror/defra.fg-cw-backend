import { TransitionDocument } from "./transition-document.js";

export class StatusDocument {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.description = props.description;
    this.transitions = props.transitions.map((t) => new TransitionDocument(t));
  }
}
