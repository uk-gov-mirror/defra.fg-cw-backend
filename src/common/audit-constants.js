export const auditEntities = {
  USER: "USER",
  ROLE: "ROLE",
  CASE: "CASE",
  WORKFLOW: "WORKFLOW",
  // One inbox/outbox row. Named for the thing acted on, as the others are.
  EVENT: "EVENT",
};

export const auditActions = {
  LOGIN: "LOGIN",
  CREATE_USER: "CREATE_USER",
  UPDATE_USER: "UPDATE_USER",
  CREATE_ROLE: "CREATE_ROLE",
  UPDATE_ROLE: "UPDATE_ROLE",
  VIEW_CASE_LIST: "VIEW_CASE_LIST",
  VIEW_CASE: "VIEW_CASE",
  VIEW_CASE_TAB: "VIEW_CASE_TAB",
  VIEW_LANDING_PAGE: "VIEW_LANDING_PAGE",
  VIEW_USER_LIST: "VIEW_USER_LIST",
  VIEW_USER_DETAILS: "VIEW_USER_DETAILS",
  CREATE_CASE: "CREATE_CASE",
  UPDATE_STAGE_OUTCOME: "UPDATE_STAGE_OUTCOME",
  UPDATE_TASK_STATUS: "UPDATE_TASK_STATUS",
  PERFORM_PAGE_ACTION: "PERFORM_PAGE_ACTION",
  ADD_NOTE_TO_CASE: "ADD_NOTE_TO_CASE",
  ASSIGN_USER_TO_CASE: "ASSIGN_USER_TO_CASE",
  CREATE_WORKFLOW: "CREATE_WORKFLOW",
  // Putting one DEAD_LETTER row back in front of the poller. Requested by the
  // grants admin surface through fg-gas-backend, carried out here.
  REDRIVE_EVENT: "REDRIVE_EVENT",
  // Setting one DEAD_LETTER row aside for good: it becomes PURGED and is
  // deleted after the retention period. Requested the same way a redrive is.
  PURGE_EVENT: "PURGE_EVENT",
};

export const auditStatus = {
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
};

// Defra Protective Monitoring event reference codes (BUJ QRG v2.2), dashes stripped.
const pmcCodesByAction = {
  [auditActions.LOGIN]: "0701", // session created
  [auditActions.CREATE_USER]: "1204", // user registration / service enrollment
  [auditActions.UPDATE_USER]: "0704", // user role change / privilege uplift
  [auditActions.CREATE_ROLE]: "0705", // account permission & privilege management
  [auditActions.UPDATE_ROLE]: "0705", // account permission & privilege management
  [auditActions.VIEW_CASE_LIST]: "0706", // any action an internal/external user or service can execute
  [auditActions.VIEW_CASE]: "0706", // any action an internal/external user or service can execute
  [auditActions.VIEW_CASE_TAB]: "0706", // any action an internal/external user or service can execute
  [auditActions.VIEW_LANDING_PAGE]: "0706", // any action an internal/external user or service can execute
  [auditActions.VIEW_USER_LIST]: "0706", // any action an internal/external user or service can execute
  [auditActions.VIEW_USER_DETAILS]: "0706", // any action an internal/external user or service can execute
  [auditActions.CREATE_CASE]: "0706", // any action an internal/external user or service can execute
  [auditActions.UPDATE_STAGE_OUTCOME]: "0706", // any action an internal/external user or service can execute
  [auditActions.UPDATE_TASK_STATUS]: "0706", // any action an internal/external user or service can execute
  [auditActions.PERFORM_PAGE_ACTION]: "0706", // any action an internal/external user or service can execute
  [auditActions.ADD_NOTE_TO_CASE]: "0706", // any action an internal/external user or service can execute
  [auditActions.ASSIGN_USER_TO_CASE]: "0706", // any action an internal/external user or service can execute
  [auditActions.CREATE_WORKFLOW]: "0706", // any action an internal/external user or service can execute
  [auditActions.REDRIVE_EVENT]: "0706", // any action an internal/external user or service can execute
  [auditActions.PURGE_EVENT]: "0706", // any action an internal/external user or service can execute
};

export const buildAuditSecurity = (action) => ({
  pmccode: pmcCodesByAction[action],
});
