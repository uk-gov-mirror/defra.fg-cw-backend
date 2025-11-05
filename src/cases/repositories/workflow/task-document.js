import { RequiredRolesDocument } from "./required-roles-document.js";
import { StatusOptionDocument } from "./status-option-document.js";

export class TaskDocument {
  constructor(props) {
    this.code = props.code;
    this.name = props.name;
    this.description = props.description;
    this.statusOptions = props.statusOptions.map(
      (option) => new StatusOptionDocument(option),
    );
    this.requiredRoles = props.requiredRoles
      ? new RequiredRolesDocument(props.requiredRoles)
      : null;
  }
}
