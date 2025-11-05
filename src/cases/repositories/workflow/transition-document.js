import { ActionDocument } from "./action-document.js";

export class TransitionDocument {
  constructor(props) {
    this.targetPosition = props.targetPosition;
    this.action = props.action ? new ActionDocument(props.action) : null;
  }
}
